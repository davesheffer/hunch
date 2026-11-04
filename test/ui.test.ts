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
import { actionArgs, cliError, undoFor, type MoveResult } from "../src/ui/actions.js";
import { JsonStore } from "../src/store/jsonStore.js";
import { hunchPaths } from "../src/core/paths.js";
import { writeFileSync } from "node:fs";
import { mkConstraint, prov, tempStore, tsxLoaderUrl } from "./helpers.js";
import { cleanupDir, isolatedCliEnv, tempDir } from "./fixtures.js";
import { hunchCliArgs } from "./cli-invocation.js";
import { execFileSync, spawn } from "node:child_process";
import { join } from "node:path";
import { Script } from "node:vm";
import { uiJs } from "../src/ui/page.js";

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

test("memory detail: actions offer only the moves the CLI takes for that record", () => {
  const actions = (id: string) => memoryDetail(source(), id)!.actions;
  const live = actions("dec_live");
  assert.deepEqual(live.fields.map((f) => [f.name, f.value]), [["title", "Sessions use signed cookies"], ["text", "Signed cookies"], ["context", "Stateless"]]);
  assert.deepEqual([live.signed, live.textLocked, live.takesFeature, live.takesComponents, live.removable, live.restorable], [true, null, true, true, true, false]);
  assert.deepEqual([actions("dec_old").removable, actions("dec_old").restorable], [false, false], "a replaced decision can't be restored: it would fork history");
  const rule = actions("con_block");
  assert.deepEqual(rule.fields.map((f) => f.name), ["text", "rationale"]);
  assert.deepEqual([rule.takesFeature, rule.takesComponents, rule.removable, rule.restorable], [false, false, true, false]);
  assert.deepEqual([actions("con_gone").removable, actions("con_gone").restorable], [false, true]);
  assert.deepEqual(actions("bug_1").fields.map((f) => f.name), ["title", "text"]);
  assert.deepEqual([actions("bug_1").removable, actions("bug_1").restorable], [false, false], "a bug can't be removed");
  assert.deepEqual([actions("fnd_1").removable, actions("fnd_1").restorable], [false, true]);

  const src = source();
  const imported = DecisionSchema.parse({ id: "dec_adr", title: "Use Postgres", status: "accepted", provenance: { source: "imported:madr", confidence: 0.8, evidence: [] }, date: "2026-01-01" });
  const adr = memoryDetail({ ...src, decisions: [...src.decisions, imported] }, "dec_adr")!.actions;
  assert.match(adr.textLocked ?? "", /ADR/, "imported ADR words are changed in the ADR file");
  assert.equal(adr.removable, true);
});

test("page script parses", () => {
  assert.doesNotThrow(() => new Script(uiJs));
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
    assert.equal(res.headers.allow, "GET, POST");
    assert.equal((await get("/api/memory/dec_live/edit", undefined, "PUT")).status, 405);
    assert.equal((await get("/api/memory/dec_live/edit", undefined, "OPTIONS")).status, 405, "no CORS preflight is ever answered");
  });
});

test("ui server: /api/components lists active components by name", async () => {
  await withServer(async (get) => {
    assert.deepEqual(JSON.parse((await get("/api/components")).body).items, [{ id: "cmp_auth", name: "Auth" }, { id: "cmp_bill", name: "Billing" }]);
  });
});

// ---- writes ------------------------------------------------------------------

test("actionArgs: allowlists each action's fields into --flag=value argv", () => {
  assert.deepEqual(actionArgs("edit", "dec_1", { title: "--json", text: "a\nb" }), { ok: true, args: ["edit", "dec_1", "--title=--json", "--text=a\nb", "--json"] });
  assert.deepEqual(actionArgs("link", "con_1", { addFiles: ["a.ts", "b.ts"], removeFiles: ["c.ts"] }), { ok: true, args: ["link", "con_1", "--add-file=a.ts", "--add-file=b.ts", "--remove-file=c.ts", "--json"] });
  assert.deepEqual(actionArgs("link", "dec_1", { clearFeature: true, addComponents: ["cmp_a"] }), { ok: true, args: ["link", "dec_1", "--add-component=cmp_a", "--clear-feature", "--json"] });
  assert.deepEqual(actionArgs("remove", "fnd_1", { reason: "dup" }), { ok: true, args: ["remove", "fnd_1", "--reason=dup", "--json"] });
  assert.deepEqual(actionArgs("restore", "dec_1", {}), { ok: true, args: ["restore", "dec_1", "--json"] });
  const refused: Array<[Parameters<typeof actionArgs>, RegExp]> = [
    [["edit", "dec_1", { title: "x", json: true }], /Unknown field for edit: json/],
    [["edit", "dec_1", { reason: "x" }], /Unknown field/],
    [["edit", "dec_1", { title: 5 }], /must be text/],
    [["edit", "dec_1", { title: "a\0b" }], /must be text/],
    [["edit", "dec_1", { title: "x".repeat(20_001) }], /must be text/],
    [["link", "dec_1", { addFiles: "a.ts" }], /must be a list/],
    [["link", "dec_1", { addFiles: [1] }], /must be a list/],
    [["link", "dec_1", { clearFeature: "yes" }], /must be true/],
    [["edit", "--json", {}], /not a memory id/],
    [["edit", "rb_1", {}], /not a memory id/],
    [["edit", "dec_1", null], /JSON object/],
    [["edit", "dec_1", ["x"]], /JSON object/],
    [["edit", "dec_1", { text: "x".repeat(16_000), context: "y".repeat(16_000) }], /too large to save at once/],
  ];
  for (const [args, pattern] of refused) {
    const r = actionArgs(...args);
    assert.equal(r.ok, false, JSON.stringify(args).slice(0, 80));
    assert.match((r as { error: string }).error, pattern);
  }
});

const move = (kind: MoveResult["kind"], before: Record<string, unknown>, after: Record<string, unknown>, id = "dec_1"): MoveResult =>
  ({ changed: true, id, kind, home: "public", before, after, flush: "committed" });

test("undoFor: each move's inverse, built from before/after", () => {
  assert.deepEqual(undoFor("edit", move("decision", { title: "A", decision: "x", context: "c" }, { title: "B", decision: "y", context: "c" })), { action: "edit", body: { title: "A", text: "x" } });
  assert.deepEqual(undoFor("edit", move("constraint", { statement: "s", rationale: "r" }, { statement: "t", rationale: "r" }, "con_1")), { action: "edit", body: { text: "s" } });
  const signed = undoFor("edit", move("decision", { title: "A", provenance: { source: "human_confirmed" } }, { title: "B", provenance: { source: "agent_recorded" } }));
  assert.match(signed!.note!, /not your confirmation.*hunch review --confirm dec_1/);
  assert.deepEqual(undoFor("link", move("decision",
    { related_files: ["a", "b"], related_components: ["cmp_x"], topic: null },
    { related_files: ["a", "c"], related_components: [], topic: "auth" })),
  { action: "link", body: { removeFiles: ["c"], addFiles: ["b"], addComponents: ["cmp_x"], clearFeature: true } });
  assert.deepEqual(undoFor("link", move("decision", { related_files: [], related_components: [], topic: "a" }, { related_files: [], related_components: [], topic: "b" })), { action: "link", body: { feature: "a" } });
  assert.deepEqual(undoFor("link", move("constraint", { scope: ["src/**"] }, { scope: ["lib/**"] }, "con_1")), { action: "link", body: { removeFiles: ["lib/**"], addFiles: ["src/**"] } });
  assert.deepEqual(undoFor("remove", move("decision", { status: "proposed" }, { status: "rejected" })), { action: "restore", body: { status: "proposed" } });
  assert.deepEqual(undoFor("remove", move("finding", { triage: "scheduled" }, { triage: "stale" }, "fnd_1")), { action: "restore", body: { status: "scheduled" } });
  assert.deepEqual(undoFor("remove", move("constraint", { status: "active" }, { status: "retired" }, "con_1")), { action: "restore", body: {} });
  assert.deepEqual(undoFor("restore", move("decision", { status: "rejected" }, { status: "proposed" })), { action: "remove", body: {} });
  assert.deepEqual(undoFor("restore", move("constraint", { status: "retired" }, { status: "active" }, "con_1")), { action: "remove", body: {} });
  // remove picks its closed state, so an Undo that can't land where restore started says so.
  assert.match(undoFor("restore", move("decision", { status: "rejected" }, { status: "accepted" }))!.note!, /marked superseded rather than rejected/);
  assert.match(undoFor("restore", move("finding", { triage: "resolved" }, { triage: "open" }, "fnd_1"))!.note!, /marked stale rather than resolved/);
  assert.equal(undoFor("edit", { ...move("decision", {}, {}), changed: false }), null);
});

test("cliError: the CLI's error: lines, else its last lines", () => {
  assert.equal(cliError("noise\nerror: a bug can't be removed\n", ""), "a bug can't be removed");
  assert.equal(cliError("", "one\ntwo"), "one two");
  assert.equal(cliError("", ""), "The change was refused.");
});

type Post = (path: string, body: unknown, headers?: Record<string, string>) => Promise<{ status: number; body: any }>;

/** A committed git fixture on a feature branch, served with a real CLI behind the write routes. */
/** cli: the real CLI (true), none (false), or a stand-in command to probe how the server reads its result. */
async function withWriteServer(fn: (post: Post, get: Get, origin: string) => Promise<void>, cli: boolean | { file: string; args: string[] } = true): Promise<void> {
  const root = tempDir("hunch-ui-write-");
  const env = isolatedCliEnv({ HOME: root, USERPROFILE: root, HUNCH_PRIVATE_DIR: "", NO_COLOR: "1", CI: "1" });
  const git = (...args: string[]): void => { execFileSync("git", args, { cwd: root, env, stdio: "ignore" }); };
  git("init", "-q"); git("config", "user.email", "t@example.com"); git("config", "user.name", "Test"); git("config", "commit.gpgsign", "false");
  const json = new JsonStore(hunchPaths(root));
  json.ensureDirs();
  const s = source();
  for (const c of s.components) json.put("components", c);
  for (const d of s.decisions) json.put("decisions", d);
  for (const c of s.constraints) json.put("constraints", c);
  for (const b of s.bugs) json.put("bugs", b);
  writeFileSync(join(root, ".gitignore"), [".hunch/local.json", ".hunch/hunch.sqlite*", ".hunch-cache/", ""].join("\n"));
  git("add", "-A"); git("commit", "-qm", "fixture"); git("checkout", "-q", "-b", "feat/ui");
  const token = "w".repeat(32);
  const server = createUiServer({ root, token, version: "test", probes: fakeProbes,
    cli: cli === true ? { file: process.execPath, args: hunchCliArgs(), env } : cli === false ? undefined : { ...cli, env } });
  await new Promise<void>((r) => server.listen(0, "127.0.0.1", () => r()));
  const port = (server.address() as AddressInfo).port;
  const call = (method: string, path: string, body: string | null, headers: Record<string, string>) => new Promise<{ status: number; headers: Record<string, unknown>; body: string }>((resolve, reject) => {
    const req = request({ host: "127.0.0.1", port, path, method, headers }, (res) => {
      let text = ""; res.setEncoding("utf8"); res.on("data", (c) => { text += c; });
      res.on("end", () => resolve({ status: res.statusCode!, headers: res.headers, body: text }));
    });
    req.on("error", reject); if (body !== null) req.write(body); req.end();
  });
  const post: Post = async (path, body, headers = {}) => {
    const r = await call("POST", path, typeof body === "string" ? body : JSON.stringify(body), { authorization: `Bearer ${token}`, "content-type": "application/json", ...headers });
    return { status: r.status, body: JSON.parse(r.body || "{}") };
  };
  const get: Get = (path, headers = { authorization: `Bearer ${token}` }) => call("GET", path, null, headers);
  try { await fn(post, get, `http://127.0.0.1:${port}`); }
  finally { await new Promise<void>((r) => server.close(() => r())); server.closeStore(); cleanupDir(root); }
}

test("ui server writes: key, Origin, JSON body and a CLI are all required; malformed requests never reach the CLI", async () => {
  await withWriteServer(async (post, get) => {
    assert.equal((await post("/api/memory/dec_live/edit", { title: "x" }, { authorization: "" })).status, 401);
    assert.equal((await post("/api/memory/dec_live/edit", { title: "x" }, { origin: "null" })).status, 403);
    assert.equal((await post("/api/memory/dec_live/edit", { title: "x" }, { origin: "https://evil.example" })).status, 403);
    assert.equal((await post("/api/memory/dec_live/edit", { title: "x" }, { "content-type": "text/plain" })).status, 415, "a simple cross-site form POST is refused");
    assert.equal((await post("/api/memory/dec_live/edit", "{not json")).status, 400);
    assert.equal((await post("/api/memory/dec_live/edit", "x".repeat(70 * 1024))).status, 413);
    assert.equal((await post("/api/memory/dec_live/delete", {})).status, 404);
    assert.match((await post("/api/memory/dec_live/edit", { json: true })).body.error, /Unknown field/);
    assert.equal(JSON.parse((await get("/api/memory/dec_live")).body).title, "Sessions use signed cookies", "no refused request changed the record");
  });
  await withWriteServer(async (post) => {
    assert.equal((await post("/api/memory/dec_live/edit", { title: "x" })).status, 503);
  }, false);
});

test("ui server writes: a CLI that fails to start, refuses, or prints no result each get their own answer", async () => {
  const script = (code: string) => ({ file: process.execPath, args: ["-e", code] });
  await withWriteServer(async (post) => {
    const r = await post("/api/memory/dec_live/edit", { title: "x" });
    assert.deepEqual([r.status, r.body.error], [422, "nope"]);
  }, script("console.error('error: nope'); process.exit(3)"));
  await withWriteServer(async (post) => {
    assert.equal((await post("/api/memory/dec_live/edit", { title: "x" })).status, 500);
  }, script("console.log('not json')"));
  await withWriteServer(async (post) => {
    const r = await post("/api/memory/dec_live/edit", { title: "x" });
    assert.equal(r.status, 500);
    assert.match(r.body.error, /could not run/, "a CLI that never started is not reported as a refusal");
  }, { file: join(process.cwd(), "no-such-node-binary"), args: [] });
});

test("ui server writes: edit, link and remove run the CLI, the list reloads, and each Undo puts it back", async () => {
  await withWriteServer(async (post, get, origin) => {
    const detail = async (id: string) => JSON.parse((await get(`/api/memory/${id}`)).body);

    // As the page sends it: with this server's own Origin.
    const edit = await post("/api/memory/dec_loose/edit", { title: "Prefer small pull requests" }, { origin });
    assert.equal(edit.status, 200, JSON.stringify(edit.body));
    assert.equal(edit.body.changed, true);
    assert.equal(edit.body.flush, "committed");
    assert.deepEqual(edit.body.undo, { action: "edit", body: { title: "Prefer small PRs" } });
    assert.equal((await detail("dec_loose")).title, "Prefer small pull requests", "the server reopened its store after the write");
    const undoEdit = await post(`/api/memory/dec_loose/${edit.body.undo.action}`, edit.body.undo.body);
    assert.equal(undoEdit.status, 200, JSON.stringify(undoEdit.body));
    assert.equal((await detail("dec_loose")).title, "Prefer small PRs");

    const link = await post("/api/memory/dec_loose/link", { addFiles: ["src/billing/charge.ts"], feature: "review-size" });
    assert.equal(link.status, 200, JSON.stringify(link.body));
    const linked = await detail("dec_loose");
    assert.deepEqual([linked.feature, linked.files], ["review-size", ["src/billing/charge.ts"]]);
    const undoLink = await post(`/api/memory/dec_loose/${link.body.undo.action}`, link.body.undo.body);
    assert.equal(undoLink.status, 200, JSON.stringify(undoLink.body));
    const unlinked = await detail("dec_loose");
    assert.deepEqual([unlinked.feature, unlinked.files], [null, []]);

    const remove = await post("/api/memory/con_block/remove", { reason: "obsolete" });
    assert.equal(remove.status, 200, JSON.stringify(remove.body));
    assert.equal((await detail("con_block")).active, false);
    const undoRemove = await post(`/api/memory/con_block/${remove.body.undo.action}`, remove.body.undo.body);
    assert.equal(undoRemove.status, 200, JSON.stringify(undoRemove.body));
    assert.equal((await detail("con_block")).active, true);

    const refused = await post("/api/memory/bug_1/remove", {});
    assert.equal(refused.status, 422);
    assert.match(refused.body.error, /record of what broke/);
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
