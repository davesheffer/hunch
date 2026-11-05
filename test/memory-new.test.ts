import { test } from "node:test";
import assert from "node:assert/strict";
import { execFileSync, spawn, spawnSync } from "node:child_process";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { hunchPaths } from "../src/core/paths.js";
import type { Component, Constraint, Decision, Finding } from "../src/core/types.js";
import { JsonStore } from "../src/store/jsonStore.js";
import { constraintId, decisionId, findingId } from "../src/core/ids.js";
import { newRecord, type NewContext } from "../src/core/memoryNew.js";
import { hunchCliArgs } from "./cli-invocation.js";
import { cleanupDir } from "./helpers.js";
import { isolatedCliEnv } from "./fixtures.js";

const NOW = "2026-06-01T00:00:00.000Z";
const prov = { source: "agent_recorded", confidence: 0.8, evidence: [] as string[] };

function decision(id: string, over: Partial<Decision> = {}): Decision {
  return {
    id, title: "Use SQLite", topic: null, status: "accepted", context: "ctx", decision: "use sqlite",
    consequences: [], alternatives_rejected: [], rejected_tripwires: [], related_components: [], related_files: ["src/a.ts"],
    supersedes: null, superseded_by: null, caused_by_bug: null, commit: null,
    valid_from: "2026-01-01T00:00:00.000Z", valid_to: null, retired: { symbols: [], deps: [] },
    provenance: { ...prov }, date: "2026-01-01T00:00:00.000Z", ...over,
  };
}
function component(id: string): Component {
  return { id, kind: "module", name: id, responsibility: "", paths: [], status: "active", owners: [], fragility: 0, provenance: { ...prov }, created_at: NOW, updated_at: NOW } as Component;
}
function ctx(over: Partial<NewContext> = {}): NewContext {
  return { now: NOW, root: "/repo", knownComponents: new Set(["cmp_core"]), decisions: [], home: "public", existing: () => undefined, unreadable: () => false, ...over };
}
function must<T extends { ok: boolean }>(r: T): Extract<T, { ok: true }> {
  assert.equal(r.ok, true, JSON.stringify(r));
  return r as Extract<T, { ok: true }>;
}
function reason(r: { ok: boolean; reason?: string }): string {
  assert.equal(r.ok, false);
  return r.reason!;
}

test("newRecord: a decision takes the MCP manual id, lands unsigned, links files, components and feature", () => {
  const r = must(newRecord("decision", {
    title: " Use Postgres ", text: "use postgres", context: "scale", rejected: ["sqlite", " "],
    feature: "storage", files: ["src\\db.ts"], components: ["cmp_core"],
  }, ctx()));
  const d = r.record as Decision;
  assert.equal(d.id, decisionId("manual:Use Postgres"));
  assert.equal(d.title, "Use Postgres");
  assert.equal(d.status, "accepted");
  assert.equal(d.decision, "use postgres");
  assert.equal(d.context, "scale");
  assert.deepEqual(d.alternatives_rejected, ["sqlite"]);
  assert.equal(d.topic, "storage");
  assert.deepEqual(d.related_files, ["src/db.ts"]);
  assert.deepEqual(d.related_components, ["cmp_core"]);
  assert.equal(d.provenance.source, "agent_recorded");
  assert.equal(d.provenance.confidence, 0.75);
  assert.deepEqual(d.provenance.evidence, ["src/db.ts"]);
  assert.equal(d.valid_from, NOW);
  assert.equal(must(newRecord("decision", { title: "Draft", text: "maybe", status: "proposed" }, ctx())).record.status, "proposed");
});

test("newRecord: a constraint is capped at warning, repo-wide without files, scoped with them; rationale is the person's or empty", () => {
  const wide = must(newRecord("constraint", { text: "Never log tokens" }, ctx())).record as Constraint;
  assert.equal(wide.id, constraintId("Never log tokens"));
  assert.deepEqual(wide.scope, ["**"]);
  assert.equal(wide.severity, "warning");
  assert.equal(wide.provenance.source, "agent_recorded");
  assert.equal(wide.rationale, "");
  const scoped = must(newRecord("constraint", { text: "No axios", files: ["src/**", "lib/x.ts"], rationale: "fetch only", severity: "advisory" }, ctx())).record as Constraint;
  assert.deepEqual(scoped.scope, ["src/**", "lib/x.ts"]);
  assert.equal(scoped.severity, "advisory");
  assert.equal(scoped.rationale, "fetch only");
  assert.deepEqual((must(newRecord("constraint", { text: "Whole repo", files: ["./**", "src/a.ts"] }, ctx())).record as Constraint).scope, ["**", "src/a.ts"], "./** is the whole repo, kept");
  const explicitWide = must(newRecord("constraint", { text: "Everywhere", files: ["**"] }, ctx())).record as Constraint;
  assert.deepEqual(explicitWide.scope, ["**"]);
});

test("newRecord: a finding is open, keeps its evidence, takes the finding id of its title", () => {
  const f = must(newRecord("finding", { title: "Slow query", text: "p95 3s", evidence: ["EXPLAIN …"], severity: "high", files: ["src/q.ts"] }, ctx())).record as Finding;
  assert.equal(f.id, findingId("Slow query"));
  assert.equal(f.triage, "open");
  assert.equal(f.severity, "high");
  assert.deepEqual(f.evidence, ["EXPLAIN …"]);
  assert.deepEqual(f.affected_files, ["src/q.ts"]);
  assert.equal(f.observed_at, NOW);
  assert.equal(f.provenance.source, "agent_recorded");
});

test("newRecord: refuses an existing id, missing text or title, misplaced fields, bad values and bad links", () => {
  const taken = ctx({ existing: (_k, id) => (id === decisionId("manual:Use SQLite") ? { title: "Use SQLite" } : undefined) });
  assert.match(reason(newRecord("decision", { title: "Use SQLite", text: "x" }, taken)), /already exists \("Use SQLite"\).*edit it/);
  const removed = ctx({ existing: (_k, id) => (id === findingId("Gone") ? { title: "Gone", triage: "stale" } : undefined) });
  assert.match(reason(newRecord("finding", { title: "Gone", text: "x" }, removed)), new RegExp(`was removed.*hunch restore ${findingId("Gone")}`));
  const corrupt = ctx({ unreadable: (_k, id) => id === constraintId("x") });
  assert.match(reason(newRecord("constraint", { text: "x" }, corrupt)), /exists but can't be read/);
  assert.match(reason(newRecord("decision", { title: "T", text: "  " }, ctx())), /--text can't be empty/);
  assert.match(reason(newRecord("finding", { text: "x" }, ctx())), /needs a --title/);
  assert.match(reason(newRecord("constraint", { title: "T", text: "x" }, ctx())), /--title doesn't apply to a new constraint/);
  assert.match(reason(newRecord("finding", { title: "T", text: "x", feature: "f", components: ["cmp_core"] }, ctx())), /--feature, --component don't apply/);
  assert.match(reason(newRecord("decision", { title: "T", text: "x", status: "rejected" }, ctx())), /proposed or accepted/);
  assert.match(reason(newRecord("constraint", { text: "x", severity: "high" }, ctx())), /advisory or warning/);
  assert.match(reason(newRecord("constraint", { text: "x", severity: "blocking" }, ctx())), new RegExp(`can't block edits yet.*hunch review --confirm ${constraintId("x")} --severity blocking`));
  assert.match(reason(newRecord("finding", { title: "T", text: "x", severity: "blocking" }, ctx())), /low, medium, high or critical/);
  assert.match(reason(newRecord("decision", { title: "T", text: "x", files: ["/etc/passwd"] }, ctx())), /relative to the repo root/);
  assert.match(reason(newRecord("decision", { title: "T", text: "x", components: ["cmp_nope"] }, ctx())), /component "cmp_nope" not found/);
  assert.match(reason(newRecord("decision", { title: "T", text: "x", feature: " " }, ctx())), /--feature can't be empty/);
});

test("newRecord: one live decision per feature; a proposed one may share it", () => {
  const decisions = [decision("dec_live", { topic: "storage" })];
  assert.match(reason(newRecord("decision", { title: "Other", text: "x", feature: "storage" }, ctx({ decisions }))), /already has a live decision: dec_live/);
  assert.equal((must(newRecord("decision", { title: "Other", text: "x", feature: "storage", status: "proposed" }, ctx({ decisions }))).record as Decision).topic, "storage");
});

// ---- CLI black-box ----------------------------------------------------------

function git(root: string, ...args: string[]): string {
  return execFileSync("git", args, { cwd: root, encoding: "utf8" }).trim();
}
const cliEnv = (): NodeJS.ProcessEnv => isolatedCliEnv({ NO_COLOR: "1" });

function fixtureRepo(): string {
  const root = mkdtempSync(join(tmpdir(), "hunch-memory-new-"));
  git(root, "init", "-q");
  git(root, "config", "user.email", "test@example.com");
  git(root, "config", "user.name", "Test Human");
  git(root, "config", "commit.gpgsign", "false");
  const json = new JsonStore(hunchPaths(root));
  json.ensureDirs();
  json.put("decisions", decision("dec_acc", { topic: "storage" }));
  json.put("components", component("cmp_core"));
  writeFileSync(join(root, ".gitignore"), [".hunch/local.json", ".hunch/hunch.sqlite*", ".hunch-cache/", ""].join("\n"));
  git(root, "add", "-A");
  git(root, "commit", "-qm", "fixture baseline");
  git(root, "checkout", "-q", "-b", "feat/test");
  return root;
}
const read = <T>(root: string, dir: string, id: string): T => JSON.parse(readFileSync(join(root, ".hunch", dir, `${id}.json`), "utf8")) as T;
const parseJson = (stdout: string): Record<string, any> => {
  const lines = stdout.trim().split("\n");
  assert.equal(lines.length, 1, `--json prints exactly one line, got: ${stdout}`);
  return JSON.parse(lines[0]!);
};

test("cli:new decision writes one unsigned decision with its links, commits one capture, --json returns it", () => {
  const root = fixtureRepo();
  try {
    const head = git(root, "rev-parse", "HEAD");
    const run = spawnSync(process.execPath, hunchCliArgs("new", "decision", "--title", "Cache reads", "--text", "cache in memory", "--context", "slow",
      "--rejected", "redis", "--rejected", "none", "--feature", "caching", "--file", "src/cache.ts", "--component", "cmp_core", "--status", "proposed", "--json"),
    { cwd: root, encoding: "utf8", env: cliEnv() });
    assert.equal(run.status, 0, `${run.stdout}${run.stderr}`);
    const out = parseJson(run.stdout);
    const id = decisionId("manual:Cache reads");
    assert.equal(out.changed, true);
    assert.equal(out.id, id);
    assert.equal(out.kind, "decision");
    assert.equal(out.home, "public");
    assert.equal(out.before, null);
    assert.equal(out.flush, "committed");
    const d = read<Decision>(root, "decisions", id);
    assert.equal(d.status, "proposed");
    assert.equal(d.topic, "caching");
    assert.deepEqual(d.alternatives_rejected, ["redis", "none"]);
    assert.deepEqual(d.related_files, ["src/cache.ts"]);
    assert.deepEqual(d.related_components, ["cmp_core"]);
    assert.equal(d.provenance.source, "agent_recorded");
    assert.equal(git(root, "log", "-1", "--format=%s"), `hunch: capture ${id}`);
    assert.equal(git(root, "rev-list", "--count", `${head}..HEAD`), "1");
  } finally { cleanupDir(root); }
});

test("cli:new constraint and finding; the human text output names the confirm command", () => {
  const root = fixtureRepo();
  try {
    const con = spawnSync(process.execPath, hunchCliArgs("new", "constraint", "--text", "Never log tokens", "--rationale", "leaks", "--file", "src/**"),
      { cwd: root, encoding: "utf8", env: cliEnv() });
    assert.equal(con.status, 0, `${con.stdout}${con.stderr}`);
    const cid = constraintId("Never log tokens");
    assert.match(con.stdout, new RegExp(`added constraint ${cid} \\(unconfirmed\\).*hunch review --confirm ${cid}`));
    const c = read<Constraint>(root, "constraints", cid);
    assert.equal(c.severity, "warning");
    assert.deepEqual(c.scope, ["src/**"]);
    assert.equal(c.rationale, "leaks");
    const fnd = spawnSync(process.execPath, hunchCliArgs("new", "finding", "--title", "Slow", "--text", "p95 3s", "--evidence", "bench: 3.1s", "--severity", "high", "--json"),
      { cwd: root, encoding: "utf8", env: cliEnv() });
    assert.equal(fnd.status, 0, `${fnd.stdout}${fnd.stderr}`);
    const f = read<Finding>(root, "findings", parseJson(fnd.stdout).id);
    assert.deepEqual(f.evidence, ["bench: 3.1s"]);
    assert.equal(f.severity, "high");
  } finally { cleanupDir(root); }
});

test("cli:new refuses a taken id, a second live decision on a feature, an unknown kind and a missing --text, writing nothing", () => {
  const root = fixtureRepo();
  try {
    const head = git(root, "rev-parse", "HEAD");
    const cases: Array<[string[], RegExp]> = [
      [["decision", "--title", "Other storage", "--text", "x", "--feature", "storage"], /already has a live decision: dec_acc/],
      [["bug", "--title", "x", "--text", "x"], /can't be added/],
      [["finding", "--title", "x"], /--text is required/],
      [["decision", "--title", "x", "--text", "x", "--component", "cmp_nope"], /not found/],
    ];
    for (const [args, pattern] of cases) {
      const run = spawnSync(process.execPath, hunchCliArgs("new", ...args), { cwd: root, encoding: "utf8", env: cliEnv() });
      assert.notEqual(run.status, 0, args.join(" "));
      assert.match(`${run.stdout}${run.stderr}`, pattern);
    }
    assert.equal(git(root, "rev-parse", "HEAD"), head);
    assert.equal(git(root, "status", "--porcelain"), "");
    const first = spawnSync(process.execPath, hunchCliArgs("new", "finding", "--title", "Dup", "--text", "a"), { cwd: root, encoding: "utf8", env: cliEnv() });
    assert.equal(first.status, 0, `${first.stdout}${first.stderr}`);
    const again = spawnSync(process.execPath, hunchCliArgs("new", "finding", "--title", "dup ", "--text", "b"), { cwd: root, encoding: "utf8", env: cliEnv() });
    assert.notEqual(again.status, 0);
    assert.match(again.stderr, /already exists \("Dup"\)/);
    assert.equal(read<Finding>(root, "findings", findingId("Dup")).observation, "a");
  } finally { cleanupDir(root); }
});

test("JsonStore.create: a second writer of the same id gets null and the first record survives", () => {
  const root = fixtureRepo();
  try {
    const first = new JsonStore(hunchPaths(root));
    const second = new JsonStore(hunchPaths(root));
    const id = decisionId("manual:Race");
    assert.equal(second.get("decisions", id), undefined, "the loser has already looked and found nothing");
    assert.equal(first.create("decisions", decision(id, { decision: "first" }))?.decision, "first");
    assert.equal(second.create("decisions", decision(id, { decision: "second" })), null);
    assert.equal(read<Decision>(root, "decisions", id).decision, "first");
    assert.throws(() => first.create("symbols", {} as never), /per-record kinds/);
  } finally { cleanupDir(root); }
});

test("cli:new racing itself on one id: one run succeeds, the rest refuse, and the file holds the winner's text", async () => {
  const root = fixtureRepo();
  try {
    const run = (text: string) => new Promise<{ code: number | null; text: string; out: string }>((resolve) => {
      const child = spawn(process.execPath, hunchCliArgs("new", "finding", "--title", "Racy", "--text", text, "--json"), { cwd: root, env: cliEnv(), stdio: ["ignore", "pipe", "pipe"] });
      let out = "";
      child.stdout.on("data", (d) => { out += d; });
      child.stderr.on("data", (d) => { out += d; });
      child.on("close", (code) => resolve({ code, text, out }));
    });
    const runs = await Promise.all(["a", "b", "c", "d"].map(run));
    const won = runs.filter((r) => r.code === 0);
    assert.equal(won.length, 1, runs.map((r) => `${r.code}: ${r.out}`).join("\n"));
    for (const lost of runs.filter((r) => r.code !== 0)) assert.match(lost.out, /already exists|just added by another run|can't be read/);
    assert.equal(read<Finding>(root, "findings", findingId("Racy")).observation, won[0]!.text);
  } finally { cleanupDir(root); }
});

test("cli:new says so when the commit fails: the record stays, uncommitted", () => {
  const root = fixtureRepo();
  const lock = join(root, ".git", "index.lock");
  try {
    const clean = spawnSync(process.execPath, hunchCliArgs("new", "finding", "--title", "Committed", "--text", "a", "--json"), { cwd: root, encoding: "utf8", env: cliEnv() });
    assert.equal(clean.status, 0, `${clean.stdout}${clean.stderr}`);
    assert.equal(parseJson(clean.stdout).uncommitted, false);
    git(root, "add", "-A"); git(root, "commit", "-qm", "settle", "--allow-empty");
    writeFileSync(lock, "");
    const json = spawnSync(process.execPath, hunchCliArgs("new", "finding", "--title", "Locked", "--text", "b", "--json"), { cwd: root, encoding: "utf8", env: cliEnv() });
    assert.equal(json.status, 0, `${json.stdout}${json.stderr}`);
    const body = parseJson(json.stdout);
    assert.equal(body.flush, null);
    assert.equal(body.uncommitted, true);
    assert.equal(read<Finding>(root, "findings", findingId("Locked")).observation, "b");
    const text = spawnSync(process.execPath, hunchCliArgs("new", "finding", "--title", "Locked too", "--text", "c"), { cwd: root, encoding: "utf8", env: cliEnv() });
    assert.equal(text.status, 0, `${text.stdout}${text.stderr}`);
    assert.match(text.stdout, /the commit failed/);
  } finally { rmSync(lock, { force: true }); cleanupDir(root); }
});

test("cli:new never overwrites a record file the loader can't read", () => {
  const root = fixtureRepo();
  try {
    const file = join(root, ".hunch", "decisions", `${decisionId("manual:Cache reads")}.json`);
    writeFileSync(file, "{ this is not json");
    git(root, "add", "-A"); git(root, "commit", "-qm", "corrupt record");
    const head = git(root, "rev-parse", "HEAD");
    const run = spawnSync(process.execPath, hunchCliArgs("new", "decision", "--title", "Cache reads", "--text", "x", "--json"), { cwd: root, encoding: "utf8", env: cliEnv() });
    assert.notEqual(run.status, 0, `${run.stdout}${run.stderr}`);
    assert.match(run.stderr, /exists but can't be read/);
    assert.equal(readFileSync(file, "utf8"), "{ this is not json");
    assert.equal(git(root, "rev-parse", "HEAD"), head);
  } finally { cleanupDir(root); }
});
