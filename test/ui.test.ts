/**
 * `hunch ui` — the local memory control surface. The model test pins how records become one
 * scannable memory list with explicit connections; the server tests pin the three guards
 * (loopback Host, per-launch bearer key, static data-free shell) and the read-only API.
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import { request } from "node:http";
import type { AddressInfo } from "node:net";
import { BugSchema, ComponentSchema, DecisionSchema, FindingSchema } from "../src/core/types.js";
import { countMemory, filterMemory, memoryDetail, memoryItems, type MemorySource } from "../src/ui/model.js";
import { createUiServer, githubWebUrl, type UiProbes } from "../src/ui/server.js";
import { mkConstraint, prov, tempStore, tsxLoaderUrl } from "./helpers.js";
import { cleanupDir, isolatedCliEnv, tempDir } from "./fixtures.js";
import { hunchCliArgs } from "./cli-invocation.js";
import { execFileSync, spawn } from "node:child_process";
import { join } from "node:path";

const now = "2026-11-04T00:00:00Z";
const auth = ComponentSchema.parse({ id: "cmp_auth", kind: "module", name: "Auth", paths: ["src/auth/**"], provenance: prov(), created_at: now, updated_at: now });
const billing = ComponentSchema.parse({ id: "cmp_bill", kind: "module", name: "Billing", paths: ["src/billing/**"], provenance: prov(), created_at: now, updated_at: now });

function source(): MemorySource {
  return {
    components: [auth, billing],
    decisions: [
      DecisionSchema.parse({ id: "dec_live", title: "Sessions use signed cookies", topic: "auth-session", status: "accepted", decision: "Signed cookies", context: "Stateless", alternatives_rejected: ["JWT in localStorage"], related_components: ["cmp_bill"], related_files: ["src/auth/session.ts"], commit: "abc1234def", supersedes: "dec_old", provenance: { source: "human_confirmed", confidence: 0.9, evidence: [] }, date: "2026-10-01", valid_from: "2026-10-01T00:00:00Z" }),
      DecisionSchema.parse({ id: "dec_old", title: "Sessions in Redis", status: "superseded", superseded_by: "dec_live", valid_to: "2026-10-01T00:00:00Z", provenance: prov(), date: "2026-01-01" }),
      DecisionSchema.parse({ id: "dec_loose", title: "Prefer small PRs", status: "accepted", provenance: prov(), date: "2026-09-01" }),
    ],
    constraints: [
      mkConstraint({ id: "con_block", statement: "Never log tokens", scope: ["src/auth/**"], severity: "blocking" }),
      mkConstraint({ id: "con_gone", statement: "Old rule", status: "retired", valid_to: now }),
    ],
    bugs: [BugSchema.parse({ id: "bug_1", title: "Double charge", root_cause: "retry without idempotency key", affected_files: ["src/billing/charge.ts"], lineage: { fixed_commit: "fff0001" }, provenance: prov() })],
    findings: [FindingSchema.parse({ id: "fnd_1", title: "Unscoped queries", observation: "3 queries skip tenant", triage: "resolved", observed_at: "2026-08-01T00:00:00Z", provenance: prov() })],
  };
}

test("memory list: every kind, active state, recorded vs by-path components, unconnected", () => {
  const items = memoryItems(source());
  const by = Object.fromEntries(items.map((m) => [m.id, m]));
  assert.deepEqual(items.map((m) => m.id).sort(), ["bug_1", "con_block", "con_gone", "dec_live", "dec_loose", "dec_old", "fnd_1"]);
  assert.equal(by.dec_live!.kind, "decision");
  assert.equal(by.dec_live!.feature, "auth-session");
  assert.deepEqual(by.dec_live!.components, [{ id: "cmp_bill", name: "Billing", source: "recorded" }, { id: "cmp_auth", name: "Auth", source: "by-path" }]);
  assert.deepEqual(by.dec_live!.commits, ["abc1234def"]);
  assert.equal(by.dec_old!.active, false);
  assert.equal(by.con_block!.kind, "rule");
  assert.equal(by.con_block!.delivery, "block");
  assert.equal(by.con_gone!.active, false);
  assert.equal(by.fnd_1!.active, false, "resolved finding is no longer delivered");
  assert.deepEqual(by.bug_1!.components.map((c) => c.name), ["Billing"]);
  assert.equal(by.dec_loose!.unconnected, true);
  assert.equal(by.dec_old!.unconnected, false, "inactive records are not flagged as needing a connection");
  assert.ok(items.findIndex((m) => !m.active) > items.findLastIndex((m) => m.active), "active memories sort first");
});

test("memory filters: kind, view and search, with per-view counts", () => {
  const items = memoryItems(source());
  assert.deepEqual(filterMemory(items, { view: "unconnected" }).map((m) => m.id), ["dec_loose"]);
  assert.deepEqual(filterMemory(items, { kind: "rule", view: "all" }).map((m) => m.id).sort(), ["con_block", "con_gone"]);
  assert.deepEqual(filterMemory(items, { q: "COOKIES" }).map((m) => m.id), ["dec_live"]);
  assert.deepEqual(filterMemory(items, { q: "auth-session" }).map((m) => m.id), ["dec_live"], "search covers the feature");
  assert.deepEqual(countMemory(items, { kind: "decision" }), { active: 2, unconnected: 1, all: 3 });
});

test("memory detail: sections, history links, provenance; unknown id is null", () => {
  const d = memoryDetail(source(), "dec_live")!;
  assert.equal(d.replaces, "dec_old");
  assert.equal(d.source, "human_confirmed");
  assert.deepEqual(d.sections.find((s) => s.label === "Rejected")?.items, ["JWT in localStorage"]);
  assert.equal(memoryDetail(source(), "dec_old")!.replacedBy, "dec_live");
  assert.equal(memoryDetail(source(), "con_block")!.sections[0]!.text, "Never log tokens");
  assert.equal(memoryDetail(source(), "nope"), null);
});

test("githubWebUrl: ssh and https remotes map to the web URL; other hosts do not", () => {
  assert.equal(githubWebUrl("git@github.com:o/r.git"), "https://github.com/o/r");
  assert.equal(githubWebUrl("https://github.com/o/r"), "https://github.com/o/r");
  assert.equal(githubWebUrl("https://gitlab.com/o/r.git"), null);
  assert.equal(githubWebUrl(null), null);
});

const fakeProbes: UiProbes = {
  repo: async () => ({ root: "/r/demo", branch: "main", remote: "git@github.com:o/demo.git", webUrl: "https://github.com/o/demo" }),
  github: async () => ({ installed: true, authenticated: true, user: "octo", repo: "o/demo" }),
  assistants: async () => [{ name: "claude", label: "Claude Code", subscription: "Claude subscription", available: true }],
};

type Get = (path: string, headers?: Record<string, string>, method?: string) => Promise<{ status: number; headers: Record<string, unknown>; body: string }>;

async function withServer(fn: (get: Get) => Promise<void>): Promise<void> {
  const { store, root, cleanup } = tempStore();
  const s = source();
  for (const c of s.components) store.json.put("components", c);
  for (const d of s.decisions) store.json.put("decisions", d);
  for (const c of s.constraints) store.json.put("constraints", c);
  const token = "k".repeat(32);
  const server = createUiServer({ root, token, version: "test", probes: fakeProbes });
  await new Promise<void>((r) => server.listen(0, "127.0.0.1", () => r()));
  const port = (server.address() as AddressInfo).port;
  const get: Get = (path, headers = { authorization: `Bearer ${token}` }, method = "GET") => new Promise((resolve, reject) => {
    const req = request({ host: "127.0.0.1", port, path, headers, method }, (res) => {
      let body = ""; res.setEncoding("utf8"); res.on("data", (c) => { body += c; });
      res.on("end", () => resolve({ status: res.statusCode!, headers: res.headers, body }));
    });
    req.on("error", reject); req.end();
  });
  try { await fn(get); }
  finally { await new Promise<void>((r) => server.close(() => r())); server.closeStore(); cleanup(); }
}

test("ui server: static shell is public, data-free and CSP-locked", async () => {
  await withServer(async (get) => {
    const page = await get("/", {});
    assert.equal(page.status, 200);
    assert.match(String(page.headers["content-security-policy"]), /default-src 'none'/);
    assert.doesNotMatch(page.body, /Sessions use signed cookies/);
    assert.equal((await get("/ui.js", {})).status, 200);
  });
});

test("ui server: /api needs the launch key and a loopback Host", async () => {
  await withServer(async (get) => {
    assert.equal((await get("/api/memory", {})).status, 401);
    assert.equal((await get("/api/memory", { authorization: `Bearer ${"x".repeat(32)}` })).status, 401);
    assert.equal((await get("/api/memory", { authorization: `Bearer ${"k".repeat(32)}`, host: "evil.example:80" })).status, 421, "DNS-rebound Host is refused");
  });
});

test("ui server: memory list, detail, repo and connections", async () => {
  await withServer(async (get) => {
    const list = JSON.parse((await get("/api/memory?view=all&kind=decision")).body);
    assert.deepEqual(list.items.map((m: { id: string }) => m.id).sort(), ["dec_live", "dec_loose", "dec_old"]);
    assert.deepEqual(list.counts, { active: 2, unconnected: 1, all: 3 });
    assert.equal(list.total, 3);
    const detail = JSON.parse((await get("/api/memory/dec_live")).body);
    assert.equal(detail.feature, "auth-session");
    assert.equal((await get("/api/memory/dec_missing")).status, 404);
    assert.deepEqual(JSON.parse((await get("/api/repo")).body), { name: "demo", branch: "main", webUrl: "https://github.com/o/demo" });
    const conn = JSON.parse((await get("/api/connections")).body);
    assert.equal(conn.github.user, "octo");
    assert.equal(conn.assistants[0].available, true);
  });
});

test("ui server: refuses a short key and non-GET methods", async () => {
  assert.throws(() => createUiServer({ root: ".", token: "short", version: "t", probes: fakeProbes }), /at least 16/);
  await withServer(async (get) => {
    const res = await get("/api/memory", undefined, "POST");
    assert.equal(res.status, 405);
    assert.equal(res.headers.allow, "GET");
  });
});

/** One process (tsx as a loader, not tsx's CLI wrapper), so kill() stops the server itself. */
function directCliArgs(...args: string[]): string[] {
  if (process.env.HUNCH_TEST_COMPILED_CLI === "1") return hunchCliArgs(...args);
  return ["--import", tsxLoaderUrl(), join(process.cwd(), "src/cli/index.ts"), ...args];
}

test("cli:ui: hunch ui --port --no-open prints a keyed loopback link and serves the API with that key only", async () => {
  const root = tempDir("hunch-ui-cli-");
  const env = isolatedCliEnv({ HOME: root, USERPROFILE: root, HUNCH_PRIVATE_DIR: "", NO_COLOR: "1", CI: "1" });
  execFileSync("git", ["init", "-q"], { cwd: root, env });
  const child = spawn(process.execPath, directCliArgs("ui", "--port", "0", "--no-open"), { cwd: root, env, stdio: ["ignore", "pipe", "pipe"] });
  let log = "";
  child.stdout!.on("data", (d) => { log += d; });
  child.stderr!.on("data", (d) => { log += d; });
  try {
    const deadline = Date.now() + 60_000;
    let link: RegExpExecArray | null = null;
    while (!(link = /(http:\/\/127\.0\.0\.1:\d+)\/#t=([A-Za-z0-9_-]{16,})/.exec(log))) {
      assert.ok(child.exitCode === null, `hunch ui exited ${child.exitCode}:\n${log}`);
      assert.ok(Date.now() < deadline, `hunch ui never printed its link:\n${log}`);
      await new Promise((r) => setTimeout(r, 100));
    }
    const [, base, key] = link;
    assert.equal((await fetch(`${base}/api/memory`)).status, 401);
    const res = await fetch(`${base}/api/memory`, { headers: { authorization: `Bearer ${key}` } });
    assert.equal(res.status, 200);
    assert.deepEqual(((await res.json()) as { counts: unknown }).counts, { active: 0, unconnected: 0, all: 0 });
  } finally {
    child.kill();
    await new Promise((r) => child.exitCode !== null ? r(null) : child.once("exit", r));
    cleanupDir(root);
  }
});
