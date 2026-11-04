import { test } from "node:test";
import assert from "node:assert/strict";
import { execFileSync, spawnSync } from "node:child_process";
import { existsSync, mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { hunchPaths } from "../src/core/paths.js";
import type { Bug, Component, Constraint, Decision, Finding } from "../src/core/types.js";
import { JsonStore } from "../src/store/jsonStore.js";
import { parseMemoryLog, MEMLOG_HEADER } from "../src/core/memorylog.js";
import { kindOfId, editRecord, linkRecord, removeRecord, restoreRecord } from "../src/core/memoryEdit.js";
import { TESTIMONY_CORRECTION_RATIONALE, VOUCHED_CORRECTION_RATIONALE } from "../src/core/correction.js";
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
function constraint(id: string, over: Partial<Constraint> = {}): Constraint {
  return {
    id, type: "architecture", statement: "no axios", scope: ["src/**"], severity: "warning", enforcement: "advisory_v1",
    match: null, forbids: null, rationale: "why", source_decision: null, violations: [], status: "active",
    valid_from: "2026-01-01T00:00:00.000Z", valid_to: null, provenance: { ...prov }, ...over,
  };
}
function bug(id: string, over: Partial<Bug> = {}): Bug {
  return {
    id, title: "Crash", symptom: "it crashes", root_cause: "", severity: "medium", status: "open", affected_files: ["src/a.ts"],
    affected_symbols: [], lineage: { introduced_commit: null, detected: null, fixed_commit: null, recurrence_of: null, spawned_decision: null, spawned_constraint: null },
    provenance: { ...prov }, ...over,
  };
}
function finding(id: string, over: Partial<Finding> = {}): Finding {
  return {
    id, title: "Unscoped query", observation: "saw it", evidence: [], method: null, severity: "medium", triage: "open",
    affected_files: ["src/a.ts"], affected_symbols: [], violates_constraint: null, spawned_decision: null,
    observed_at: "2026-01-01T00:00:00.000Z", resolved_commit: null, provenance: { ...prov }, ...over,
  };
}
function component(id: string): Component {
  return { id, kind: "module", name: id, responsibility: "", paths: [], status: "active", owners: [], fragility: 0, provenance: { ...prov }, created_at: NOW, updated_at: NOW } as Component;
}
function must<T extends { ok: boolean }>(r: T): Extract<T, { ok: true }> {
  assert.equal(r.ok, true, JSON.stringify(r));
  return r as Extract<T, { ok: true }>;
}
function reason(r: { ok: boolean; reason?: string }): string {
  assert.equal(r.ok, false);
  return r.reason!;
}

// ---- pure transforms --------------------------------------------------------

test("kindOfId maps the prefix and rejects anything else", () => {
  assert.equal(kindOfId("dec_1")?.kind, "decision");
  assert.equal(kindOfId("con_1")?.collection, "constraints");
  assert.equal(kindOfId("bug_1")?.kind, "bug");
  assert.equal(kindOfId("fnd_1")?.collection, "findings");
  assert.equal(kindOfId("rb_1"), null);
  assert.equal(kindOfId("dec_"), null);
  assert.equal(kindOfId("nonsense"), null);
});

test("editRecord: maps --text per kind, stamps last_verified, keeps provenance.source", () => {
  const d = must(editRecord("decision", decision("dec_1"), { title: "T", text: "X", context: "C" }, NOW));
  assert.deepEqual([(d.record as Decision).title, (d.record as Decision).decision, (d.record as Decision).context], ["T", "X", "C"]);
  assert.equal(d.record.provenance.last_verified, NOW);
  assert.equal(d.record.provenance.source, "agent_recorded");
  const c = must(editRecord("constraint", constraint("con_1"), { text: "S", rationale: "R" }, NOW));
  assert.equal((c.record as Constraint).statement, "S");
  assert.equal((c.record as Constraint).rationale, "R");
  assert.equal((must(editRecord("bug", bug("bug_1"), { title: "T", text: "S" }, NOW)).record as Bug).symptom, "S");
  const f = must(editRecord("finding", finding("fnd_1"), { title: "T", text: "O" }, NOW));
  assert.equal((f.record as Finding).observation, "O");
  assert.equal((f.record as Finding).title, "T");
});

test("editRecord: same value is a no-op; refusals name the problem", () => {
  const d = decision("dec_1");
  const same = must(editRecord("decision", d, { title: d.title }, NOW));
  assert.equal(same.changed, false);
  assert.equal(same.record, d);
  assert.match(reason(editRecord("decision", d, {}, NOW)), /nothing to edit/);
  assert.match(reason(editRecord("constraint", constraint("con_1"), { title: "x" }, NOW)), /no title/);
  assert.match(reason(editRecord("bug", bug("bug_1"), { context: "x" }, NOW)), /decisions only/);
  assert.match(reason(editRecord("decision", d, { rationale: "x" }, NOW)), /constraints only/);
  assert.match(reason(editRecord("decision", d, { title: "  " }, NOW)), /can't be empty/);
});

test("editRecord: a text edit drops the human signature of a decision or constraint; bugs and findings keep provenance", () => {
  const signed = { source: "llm_draft+human_confirmed", confidence: 0.95, evidence: [] as string[] };
  const d = must(editRecord("decision", decision("dec_1", { provenance: { ...signed } }), { text: "changed" }, NOW)).record;
  assert.equal(d.provenance.source, "llm_draft+agent_recorded");
  assert.equal(d.provenance.confidence, 0.75);
  const c = must(editRecord("constraint", constraint("con_1", { rationale: VOUCHED_CORRECTION_RATIONALE, provenance: { source: "human_confirmed", confidence: 1, evidence: [] } }), { text: "never axios" }, NOW)).record as Constraint;
  assert.deepEqual([c.provenance.source, c.provenance.confidence, c.rationale], ["agent_recorded", 0.75, TESTIMONY_CORRECTION_RATIONALE]);
  // an explicit rationale edit is the human's own words, kept as given
  const r = must(editRecord("constraint", constraint("con_1", { provenance: { ...signed } }), { rationale: VOUCHED_CORRECTION_RATIONALE }, NOW)).record as Constraint;
  assert.equal(r.rationale, VOUCHED_CORRECTION_RATIONALE);
  // a lower confidence is never raised
  assert.equal(must(editRecord("decision", decision("dec_1", { provenance: { ...signed, confidence: 0.5 } }), { title: "T" }, NOW)).record.provenance.confidence, 0.5);
  // testimony stays as it was
  assert.deepEqual(must(editRecord("decision", decision("dec_1"), { title: "T" }, NOW)).record.provenance.source, "agent_recorded");
  assert.equal(must(editRecord("finding", finding("fnd_1", { provenance: { ...signed } }), { text: "O" }, NOW)).record.provenance.source, signed.source);
  assert.equal(must(editRecord("bug", bug("bug_1", { provenance: { ...signed } }), { text: "S" }, NOW)).record.provenance.source, signed.source);
  // a no-op edit leaves the signature alone
  const same = decision("dec_1", { provenance: { ...signed } });
  assert.equal(must(editRecord("decision", same, { title: same.title }, NOW)).record.provenance.source, signed.source);
});

test("editRecord: refuses an imported ADR decision (its markdown owns the words); link still works", () => {
  const adr = decision("dec_adr", { provenance: { source: "imported:madr+human_confirmed", confidence: 0.9, evidence: [] } });
  assert.match(reason(editRecord("decision", adr, { text: "changed" }, NOW)), /edit the ADR markdown/);
  assert.equal(must(linkRecord("decision", adr, { addFiles: ["src/b.ts"] }, NOW)).record.provenance.source, "imported:madr+human_confirmed");
});

test("linkRecord: connection edits keep the human signature", () => {
  const signed = { source: "human_confirmed", confidence: 1, evidence: [] as string[] };
  const d = must(linkRecord("decision", decision("dec_1", { provenance: { ...signed } }), { addFiles: ["src/b.ts"], feature: "caching" }, NOW)).record;
  assert.deepEqual([d.provenance.source, d.provenance.confidence], ["human_confirmed", 1]);
  const c = must(linkRecord("constraint", constraint("con_1", { provenance: { ...signed } }), { addFiles: ["lib/**"] }, NOW)).record;
  assert.equal(c.provenance.source, "human_confirmed");
});

test("linkRecord: refuses absolute, drive-letter and escaping file links, and private: refs outside the private home", () => {
  const d = decision("dec_1");
  for (const bad of ["/etc/passwd", "C:\\Windows\\x.ts", "c:/x.ts", "../outside.ts", "src/../../x.ts", "..", "a\0b"]) {
    assert.match(reason(linkRecord("decision", d, { addFiles: [bad] }, NOW)), /relative to the repo root/, bad);
  }
  assert.match(reason(linkRecord("decision", d, { addFiles: ["private:docs/plan.md"] }, NOW)), /private reference/);
  assert.match(reason(linkRecord("decision", d, { addFiles: ["private:docs/plan.md"], home: "public" }, NOW)), /private reference/);
  assert.deepEqual((must(linkRecord("decision", d, { addFiles: ["private:docs\\plan.md"], home: "private" }, NOW)).record as Decision).related_files, ["src/a.ts", "private:docs/plan.md"]);
  assert.match(reason(linkRecord("decision", d, { addFiles: ["private:../x.md"], home: "private" }, NOW)), /relative to the overlay repo/);
  assert.match(reason(linkRecord("decision", d, { addFiles: ["private:/abs.md"], home: "private" }, NOW)), /relative to the overlay repo/);
  // removal stays lenient, so a bad link already stored can still be unlinked
  const stuck = decision("dec_2", { related_files: ["src/a.ts", "/abs/x.ts"] });
  assert.deepEqual((must(linkRecord("decision", stuck, { removeFiles: ["/abs/x.ts"] }, NOW)).record as Decision).related_files, ["src/a.ts"]);
});

test("linkRecord: refuses to leave a constraint with an empty scope", () => {
  assert.match(reason(linkRecord("constraint", constraint("con_1"), { removeFiles: ["src/**"] }, NOW)), /at least one file or glob.*remove the constraint instead/);
  // other kinds may drop to no files
  assert.deepEqual((must(linkRecord("finding", finding("fnd_1"), { removeFiles: ["src/a.ts"] }, NOW)).record as Finding).affected_files, []);
});

test("linkRecord: files per kind, posix-normalised, no duplicates, absent removal is a no-op", () => {
  const d = must(linkRecord("decision", decision("dec_1"), { addFiles: ["src\\b.ts", "src/a.ts", "./src/b.ts"] }, NOW));
  assert.deepEqual((d.record as Decision).related_files, ["src/a.ts", "src/b.ts"]);
  const c = must(linkRecord("constraint", constraint("con_1"), { addFiles: ["lib/**"], removeFiles: ["src/**"] }, NOW));
  assert.deepEqual((c.record as Constraint).scope, ["lib/**"]);
  assert.deepEqual((must(linkRecord("finding", finding("fnd_1"), { addFiles: ["x.ts"] }, NOW)).record as Finding).affected_files, ["src/a.ts", "x.ts"]);
  assert.deepEqual((must(linkRecord("bug", bug("bug_1"), { removeFiles: ["src/a.ts"] }, NOW)).record as Bug).affected_files, []);
  const noop = must(linkRecord("decision", decision("dec_1"), { addFiles: ["src/a.ts"], removeFiles: ["nope.ts"] }, NOW));
  assert.equal(noop.changed, false);
});

test("linkRecord: components are decisions-only and must exist", () => {
  const known = new Set(["cmp_a", "cmp_b"]);
  const d = must(linkRecord("decision", decision("dec_1"), { addComponents: ["cmp_a", "cmp_b"], knownComponents: known }, NOW));
  assert.deepEqual((d.record as Decision).related_components, ["cmp_a", "cmp_b"]);
  const back = must(linkRecord("decision", d.record, { removeComponents: ["cmp_a", "cmp_zzz"] }, NOW));
  assert.deepEqual((back.record as Decision).related_components, ["cmp_b"]);
  assert.match(reason(linkRecord("decision", decision("dec_1"), { addComponents: ["cmp_missing"], knownComponents: known }, NOW)), /component "cmp_missing" not found/);
  assert.match(reason(linkRecord("constraint", constraint("con_1"), { addComponents: ["cmp_a"], knownComponents: known }, NOW)), /decisions only/);
});

test("linkRecord: feature sets/clears the topic, refuses other kinds and conflicts with a live decision", () => {
  const other = decision("dec_other", { topic: "storage", title: "Other" });
  const d = decision("dec_1");
  assert.equal((must(linkRecord("decision", d, { feature: "caching", decisions: [other, d] }, NOW)).record as Decision).topic, "caching");
  assert.match(reason(linkRecord("decision", d, { feature: "storage", decisions: [other, d] }, NOW)), /dec_other/);
  // a non-live decision may share a topic: the guard is about LIVE decisions only
  const proposed = decision("dec_p", { status: "proposed" });
  assert.equal((must(linkRecord("decision", proposed, { feature: "storage", decisions: [other, proposed] }, NOW)).record as Decision).topic, "storage");
  const anchored = decision("dec_a", { topic: "caching" });
  assert.equal((must(linkRecord("decision", anchored, { clearFeature: true }, NOW)).record as Decision).topic, null);
  assert.equal(must(linkRecord("decision", anchored, { feature: "caching" }, NOW)).changed, false);
  assert.match(reason(linkRecord("decision", d, { feature: "a", clearFeature: true }, NOW)), /mutually exclusive/);
  assert.match(reason(linkRecord("decision", d, { feature: " " }, NOW)), /can't be empty/);
  assert.match(reason(linkRecord("constraint", constraint("con_1"), { feature: "a" }, NOW)), /decisions only/);
  assert.match(reason(linkRecord("decision", d, {}, NOW)), /nothing to link/);
});

test("removeRecord: proposed -> rejected, accepted -> superseded (superseded_by stays null), constraint -> retired, finding -> stale", () => {
  const p = must(removeRecord("decision", decision("dec_1", { status: "proposed" }), NOW)).record as Decision;
  assert.deepEqual([p.status, p.valid_to, p.superseded_by], ["rejected", NOW, null]);
  const a = must(removeRecord("decision", decision("dec_2"), NOW)).record as Decision;
  assert.deepEqual([a.status, a.valid_to, a.superseded_by], ["superseded", NOW, null]);
  assert.equal(a.provenance.last_verified, NOW);
  const c = must(removeRecord("constraint", constraint("con_1"), NOW)).record as Constraint;
  assert.deepEqual([c.status, c.valid_to], ["retired", NOW]);
  assert.equal((must(removeRecord("finding", finding("fnd_1"), NOW)).record as Finding).triage, "stale");
  assert.equal((must(removeRecord("finding", finding("fnd_2", { triage: "scheduled" }), NOW)).record as Finding).triage, "stale");
});

test("removeRecord: refuses a bug and anything already removed", () => {
  assert.match(reason(removeRecord("bug", bug("bug_1"), NOW)), /record of what broke; it can't be removed/);
  assert.match(reason(removeRecord("decision", decision("dec_1", { status: "rejected" }), NOW)), /already rejected/);
  assert.match(reason(removeRecord("decision", decision("dec_1", { status: "superseded" }), NOW)), /already superseded/);
  assert.match(reason(removeRecord("constraint", constraint("con_1", { status: "retired" }), NOW)), /already retired/);
  assert.match(reason(removeRecord("finding", finding("fnd_1", { triage: "stale" }), NOW)), /already stale/);
  assert.match(reason(removeRecord("finding", finding("fnd_1", { triage: "resolved" }), NOW)), /already resolved/);
});

test("removeRecord: refuses a record whose validity window already closed (restore would not round-trip)", () => {
  const closed = "2026-03-01T00:00:00.000Z";
  assert.match(reason(removeRecord("decision", decision("dec_1", { valid_to: closed }), NOW)), new RegExp(`already stopped applying on ${closed}`));
  assert.match(reason(removeRecord("decision", decision("dec_1", { status: "proposed", valid_to: closed }), NOW)), /already stopped applying/);
  assert.match(reason(removeRecord("constraint", constraint("con_1", { valid_to: closed }), NOW)), /already stopped applying/);
});

test("removeRecord then restoreRecord round-trips status and valid_to exactly", () => {
  for (const status of ["proposed", "accepted"] as const) {
    const orig = decision("dec_1", { status });
    const back = must(restoreRecord("decision", must(removeRecord("decision", orig, NOW)).record, {}, NOW)).record as Decision;
    assert.deepEqual([back.status, back.valid_to], [orig.status, orig.valid_to], status);
  }
  const con = constraint("con_1");
  const conBack = must(restoreRecord("constraint", must(removeRecord("constraint", con, NOW)).record, {}, NOW)).record as Constraint;
  assert.deepEqual([conBack.status, conBack.valid_to], [con.status, con.valid_to]);
});

test("restoreRecord: reopens decisions (default inverts remove), constraints and findings", () => {
  const rejected = decision("dec_1", { status: "rejected", valid_to: NOW });
  const draft = must(restoreRecord("decision", rejected, {}, NOW)).record as Decision;
  assert.deepEqual([draft.status, draft.valid_to], ["proposed", null], "a rejected draft returns as a draft, never silently shipped");
  assert.equal((must(restoreRecord("decision", rejected, { status: "accepted" }, NOW)).record as Decision).status, "accepted");
  const superseded = decision("dec_2", { status: "superseded", valid_to: NOW });
  assert.equal((must(restoreRecord("decision", superseded, {}, NOW)).record as Decision).status, "accepted");
  assert.equal((must(restoreRecord("decision", superseded, { status: "proposed" }, NOW)).record as Decision).status, "proposed");
  const c = must(restoreRecord("constraint", constraint("con_1", { status: "retired", valid_to: NOW }), {}, NOW)).record as Constraint;
  assert.deepEqual([c.status, c.valid_to], ["active", null]);
  assert.equal((must(restoreRecord("finding", finding("fnd_1", { triage: "stale" }), {}, NOW)).record as Finding).triage, "open");
  assert.equal((must(restoreRecord("finding", finding("fnd_1", { triage: "resolved" }), { status: "scheduled" }, NOW)).record as Finding).triage, "scheduled");
});

test("restoreRecord: refuses a replaced decision, bad statuses, a topic conflict, a bug and a record that was never removed", () => {
  assert.match(reason(restoreRecord("decision", decision("dec_1", { status: "superseded", superseded_by: "dec_9", valid_to: NOW }), {}, NOW)), /replaced by dec_9/);
  assert.match(reason(restoreRecord("decision", decision("dec_1", { status: "rejected", valid_to: NOW }), { status: "rejected" }, NOW)), /proposed or accepted/);
  const live = decision("dec_live", { topic: "storage" });
  const removed = decision("dec_old", { topic: "storage", status: "superseded", valid_to: NOW });
  assert.match(reason(restoreRecord("decision", removed, { decisions: [live, removed] }, NOW)), /dec_live/);
  assert.equal(must(restoreRecord("decision", removed, { status: "proposed", decisions: [live, removed] }, NOW)).changed, true);
  assert.match(reason(restoreRecord("decision", decision("dec_1"), {}, NOW)), /not removed/);
  assert.match(reason(restoreRecord("constraint", constraint("con_1"), {}, NOW)), /not removed/);
  assert.match(reason(restoreRecord("constraint", constraint("con_1", { status: "retired" }), { status: "open" }, NOW)), /doesn't apply/);
  assert.match(reason(restoreRecord("finding", finding("fnd_1"), {}, NOW)), /not removed/);
  assert.match(reason(restoreRecord("finding", finding("fnd_1", { triage: "stale" }), { status: "stale" }, NOW)), /must be one of/);
  assert.match(reason(restoreRecord("bug", bug("bug_1"), {}, NOW)), /nothing to restore/);
});

// ---- CLI black-box ----------------------------------------------------------

function git(root: string, ...args: string[]): string {
  return execFileSync("git", args, { cwd: root, encoding: "utf8" }).trim();
}
const cliEnv = (): NodeJS.ProcessEnv => isolatedCliEnv({ NO_COLOR: "1" });

/** A temp git repo with a .hunch store, committed, on a feature branch (public memory
 *  auto-commits are held on the default branch). */
function fixtureRepo(): string {
  const root = mkdtempSync(join(tmpdir(), "hunch-memory-edit-"));
  git(root, "init", "-q");
  git(root, "config", "user.email", "test@example.com");
  git(root, "config", "user.name", "Test Human");
  git(root, "config", "commit.gpgsign", "false");
  const json = new JsonStore(hunchPaths(root));
  json.ensureDirs();
  json.put("decisions", decision("dec_acc", { topic: "storage" }));
  json.put("decisions", decision("dec_prop", { status: "proposed", title: "Maybe cache" }));
  json.put("decisions", decision("dec_other", { title: "Second storage idea", status: "proposed" }));
  json.put("constraints", constraint("con_axios"));
  json.put("bugs", bug("bug_crash"));
  json.put("findings", finding("fnd_scan"));
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

test("cli:edit rewrites a decision's title, text and context, commits one move, and --json returns before/after", () => {
  const root = fixtureRepo();
  try {
    const head = git(root, "rev-parse", "HEAD");
    const run = spawnSync(process.execPath, hunchCliArgs("edit", "dec_acc", "--title", "New title", "--text", "new text", "--context", "new ctx", "--json"), { cwd: root, encoding: "utf8", env: cliEnv() });
    assert.equal(run.status, 0, `${run.stdout}${run.stderr}`);
    const out = parseJson(run.stdout);
    assert.equal(out.changed, true);
    assert.equal(out.kind, "decision");
    assert.equal(out.home, "public");
    assert.equal(out.before.title, "Use SQLite");
    assert.equal(out.before.decision, "use sqlite");
    assert.equal(out.after.title, "New title");
    assert.equal(out.after.context, "new ctx");
    assert.equal(out.flush, "committed");
    const onDisk = read<Decision>(root, "decisions", "dec_acc");
    assert.equal(onDisk.decision, "new text");
    assert.equal(onDisk.provenance.source, "agent_recorded");
    assert.ok(onDisk.provenance.last_verified);
    assert.notEqual(git(root, "rev-parse", "HEAD"), head);
    assert.equal(git(root, "log", "-1", "--format=%s"), "hunch: edit dec_acc");
    assert.equal(git(root, "rev-list", "--count", `${head}..HEAD`), "1");
  } finally { cleanupDir(root); }
});

test("cli:edit --rationale on a constraint; wrong-kind flags and unknown ids are refused with nothing written", () => {
  const root = fixtureRepo();
  try {
    const ok = spawnSync(process.execPath, hunchCliArgs("edit", "con_axios", "--rationale", "because"), { cwd: root, encoding: "utf8", env: cliEnv() });
    assert.equal(ok.status, 0, `${ok.stdout}${ok.stderr}`);
    assert.equal(read<Constraint>(root, "constraints", "con_axios").rationale, "because");
    const head = git(root, "rev-parse", "HEAD");
    const cases: Array<[string[], RegExp]> = [
      [["con_axios", "--title", "x"], /no title/],
      [["dec_acc", "--rationale", "x"], /constraints only/],
      [["con_axios", "--context", "x"], /decisions only/],
      [["bug_zzz", "--title", "x"], /not found/],
      [["rb_1", "--title", "x"], /not a memory id/],
      [["dec_acc"], /nothing to edit/],
    ];
    for (const [args, pattern] of cases) {
      const run = spawnSync(process.execPath, hunchCliArgs("edit", ...args), { cwd: root, encoding: "utf8", env: cliEnv() });
      assert.notEqual(run.status, 0, args.join(" "));
      assert.match(`${run.stdout}${run.stderr}`, pattern);
    }
    assert.equal(git(root, "rev-parse", "HEAD"), head);
    assert.equal(git(root, "status", "--porcelain"), "");
  } finally { cleanupDir(root); }
});

test("cli:edit with an unchanged value exits 0 without a write or commit (--json changed:false)", () => {
  const root = fixtureRepo();
  try {
    const head = git(root, "rev-parse", "HEAD");
    const run = spawnSync(process.execPath, hunchCliArgs("edit", "bug_crash", "--title", "Crash", "--json"), { cwd: root, encoding: "utf8", env: cliEnv() });
    assert.equal(run.status, 0, `${run.stdout}${run.stderr}`);
    const out = parseJson(run.stdout);
    assert.equal(out.changed, false);
    assert.deepEqual(out.before, out.after);
    assert.equal(git(root, "rev-parse", "HEAD"), head);
    const human = spawnSync(process.execPath, hunchCliArgs("edit", "bug_crash", "--text", "it crashes"), { cwd: root, encoding: "utf8", env: cliEnv() });
    assert.equal(human.status, 0);
    assert.match(human.stdout, /unchanged/);
  } finally { cleanupDir(root); }
});

test("cli:link adds and removes files and components (repeatable), sets and clears a feature", () => {
  const root = fixtureRepo();
  try {
    const add = spawnSync(process.execPath, hunchCliArgs("link", "dec_prop", "--add-file", "src\\b.ts", "--add-file", "src/c.ts", "--add-file", "src/a.ts", "--add-component", "cmp_core", "--feature", "caching", "--json"), { cwd: root, encoding: "utf8", env: cliEnv() });
    assert.equal(add.status, 0, `${add.stdout}${add.stderr}`);
    const out = parseJson(add.stdout);
    assert.equal(out.changed, true);
    assert.deepEqual(out.before.related_files, ["src/a.ts"]);
    assert.deepEqual(out.after.related_files, ["src/a.ts", "src/b.ts", "src/c.ts"]);
    assert.deepEqual(out.after.related_components, ["cmp_core"]);
    assert.equal(out.after.topic, "caching");
    assert.equal(git(root, "log", "-1", "--format=%s"), "hunch: link dec_prop");

    const rm = spawnSync(process.execPath, hunchCliArgs("link", "dec_prop", "--remove-file", "src/b.ts", "--remove-file", "never/there.ts", "--remove-component", "cmp_core", "--clear-feature", "--json"), { cwd: root, encoding: "utf8", env: cliEnv() });
    assert.equal(rm.status, 0, `${rm.stdout}${rm.stderr}`);
    const back = read<Decision>(root, "decisions", "dec_prop");
    assert.deepEqual(back.related_files, ["src/a.ts", "src/c.ts"]);
    assert.deepEqual(back.related_components, []);
    assert.equal(back.topic, null);

    const again = spawnSync(process.execPath, hunchCliArgs("link", "dec_prop", "--add-file", "src/a.ts", "--json"), { cwd: root, encoding: "utf8", env: cliEnv() });
    assert.equal(parseJson(again.stdout).changed, false);
    assert.equal(git(root, "log", "-1", "--format=%s"), "hunch: link dec_prop");

    const c = spawnSync(process.execPath, hunchCliArgs("link", "con_axios", "--add-file", "lib/**", "--remove-file", "src/**"), { cwd: root, encoding: "utf8", env: cliEnv() });
    assert.equal(c.status, 0, `${c.stdout}${c.stderr}`);
    assert.deepEqual(read<Constraint>(root, "constraints", "con_axios").scope, ["lib/**"]);
  } finally { cleanupDir(root); }
});

test("cli:link refuses an unknown component, a component on a constraint, and a second live decision on a topic", () => {
  const root = fixtureRepo();
  try {
    const head = git(root, "rev-parse", "HEAD");
    const cases: Array<[string[], RegExp]> = [
      [["dec_prop", "--add-component", "cmp_nope"], /component "cmp_nope" not found/],
      [["con_axios", "--add-component", "cmp_core"], /decisions only/],
      [["fnd_scan", "--feature", "x"], /decisions only/],
      [["dec_acc", "--feature", "x", "--clear-feature"], /mutually exclusive/],
      [["dec_prop", "--add-file", "/etc/passwd"], /relative to the repo root/],
      [["dec_prop", "--add-file", "../outside.ts"], /relative to the repo root/],
      [["dec_prop", "--add-file", "private:notes.md"], /private reference/],
      [["con_axios", "--remove-file", "src/**"], /remove the constraint instead/],
    ];
    for (const [args, pattern] of cases) {
      const run = spawnSync(process.execPath, hunchCliArgs("link", ...args), { cwd: root, encoding: "utf8", env: cliEnv() });
      assert.notEqual(run.status, 0, args.join(" "));
      assert.match(`${run.stdout}${run.stderr}`, pattern);
    }
    // dec_other (proposed) may take the topic; making it live must then be refused by restore, and a live one by link.
    const ok = spawnSync(process.execPath, hunchCliArgs("link", "dec_other", "--feature", "storage"), { cwd: root, encoding: "utf8", env: cliEnv() });
    assert.equal(ok.status, 0, `${ok.stdout}${ok.stderr}`);
    const accept = JSON.parse(readFileSync(join(root, ".hunch/decisions/dec_other.json"), "utf8")) as Decision;
    assert.equal(accept.topic, "storage");
    const live = decision("dec_live2", { title: "Live two" });
    new JsonStore(hunchPaths(root)).put("decisions", live);
    const conflict = spawnSync(process.execPath, hunchCliArgs("link", "dec_live2", "--feature", "storage"), { cwd: root, encoding: "utf8", env: cliEnv() });
    assert.notEqual(conflict.status, 0);
    assert.match(`${conflict.stdout}${conflict.stderr}`, /already has a live decision: dec_acc/);
    assert.equal(read<Decision>(root, "decisions", "dec_live2").topic, null);
    assert.notEqual(git(root, "rev-parse", "HEAD"), head, "only the successful dec_other link committed");
  } finally { cleanupDir(root); }
});

test("cli:remove then cli:restore round-trip a decision and a constraint; --reason lands in the body only", () => {
  const root = fixtureRepo();
  try {
    const decBefore = read<Decision>(root, "decisions", "dec_acc");
    const conBefore = read<Constraint>(root, "constraints", "con_axios");

    const rmDec = spawnSync(process.execPath, hunchCliArgs("remove", "dec_acc", "--reason", "SECRET_REASON superseded adopt", "--json"), { cwd: root, encoding: "utf8", env: cliEnv() });
    assert.equal(rmDec.status, 0, `${rmDec.stdout}${rmDec.stderr}`);
    const removed = parseJson(rmDec.stdout);
    assert.equal(removed.before.status, "accepted");
    assert.equal(removed.after.status, "superseded");
    assert.equal(removed.after.superseded_by, null);
    assert.ok(removed.after.valid_to);
    assert.equal(git(root, "log", "-1", "--format=%s"), "hunch: remove dec_acc");
    assert.match(git(root, "log", "-1", "--format=%b"), /SECRET_REASON/);
    assert.ok(existsSync(join(root, ".hunch/decisions/dec_acc.json")), "retired, never deleted");

    const again = spawnSync(process.execPath, hunchCliArgs("remove", "dec_acc"), { cwd: root, encoding: "utf8", env: cliEnv() });
    assert.notEqual(again.status, 0);
    assert.match(`${again.stdout}${again.stderr}`, /already superseded/);

    const restoreDec = spawnSync(process.execPath, hunchCliArgs("restore", "dec_acc", "--json"), { cwd: root, encoding: "utf8", env: cliEnv() });
    assert.equal(restoreDec.status, 0, `${restoreDec.stdout}${restoreDec.stderr}`);
    const restored = parseJson(restoreDec.stdout);
    assert.deepEqual(restored.before, removed.after);
    assert.equal(restored.after.status, "accepted");
    assert.equal(restored.after.valid_to, null);
    assert.equal(git(root, "log", "-1", "--format=%s"), "hunch: restore dec_acc");
    const decAfter = read<Decision>(root, "decisions", "dec_acc");
    assert.deepEqual({ ...decAfter, provenance: undefined }, { ...decBefore, provenance: undefined });

    const rmCon = spawnSync(process.execPath, hunchCliArgs("remove", "con_axios", "--json"), { cwd: root, encoding: "utf8", env: cliEnv() });
    assert.equal(rmCon.status, 0, `${rmCon.stdout}${rmCon.stderr}`);
    assert.equal(parseJson(rmCon.stdout).after.status, "retired");
    const restoreCon = spawnSync(process.execPath, hunchCliArgs("restore", "con_axios", "--json"), { cwd: root, encoding: "utf8", env: cliEnv() });
    assert.equal(restoreCon.status, 0, `${restoreCon.stdout}${restoreCon.stderr}`);
    const conAfter = read<Constraint>(root, "constraints", "con_axios");
    assert.deepEqual({ ...conAfter, provenance: undefined }, { ...conBefore, provenance: undefined });
    assert.equal(conAfter.provenance.source, conBefore.provenance.source);
  } finally { cleanupDir(root); }
});

test("cli:remove a proposed decision and a finding, cli:restore --status picks the reopened state", () => {
  const root = fixtureRepo();
  try {
    const rm = spawnSync(process.execPath, hunchCliArgs("remove", "dec_prop"), { cwd: root, encoding: "utf8", env: cliEnv() });
    assert.equal(rm.status, 0, `${rm.stdout}${rm.stderr}`);
    assert.equal(read<Decision>(root, "decisions", "dec_prop").status, "rejected");
    const re = spawnSync(process.execPath, hunchCliArgs("restore", "dec_prop"), { cwd: root, encoding: "utf8", env: cliEnv() });
    assert.equal(re.status, 0, `${re.stdout}${re.stderr}`);
    assert.equal(read<Decision>(root, "decisions", "dec_prop").status, "proposed", "restore without --status returns a draft as a draft");
    assert.equal(spawnSync(process.execPath, hunchCliArgs("remove", "dec_prop"), { cwd: root, encoding: "utf8", env: cliEnv() }).status, 0);
    const ship = spawnSync(process.execPath, hunchCliArgs("restore", "dec_prop", "--status", "accepted"), { cwd: root, encoding: "utf8", env: cliEnv() });
    assert.equal(ship.status, 0, `${ship.stdout}${ship.stderr}`);
    assert.equal(read<Decision>(root, "decisions", "dec_prop").status, "accepted");

    assert.equal(spawnSync(process.execPath, hunchCliArgs("remove", "fnd_scan"), { cwd: root, encoding: "utf8", env: cliEnv() }).status, 0);
    assert.equal(read<Finding>(root, "findings", "fnd_scan").triage, "stale");
    const bad = spawnSync(process.execPath, hunchCliArgs("restore", "fnd_scan", "--status", "resolved"), { cwd: root, encoding: "utf8", env: cliEnv() });
    assert.notEqual(bad.status, 0);
    assert.equal(spawnSync(process.execPath, hunchCliArgs("restore", "fnd_scan", "--status", "scheduled"), { cwd: root, encoding: "utf8", env: cliEnv() }).status, 0);
    assert.equal(read<Finding>(root, "findings", "fnd_scan").triage, "scheduled");
  } finally { cleanupDir(root); }
});

test("cli:remove and cli:restore refuse a bug, a record that was not removed, and a replaced decision", () => {
  const root = fixtureRepo();
  try {
    new JsonStore(hunchPaths(root)).put("decisions", decision("dec_replaced", { status: "superseded", superseded_by: "dec_acc", valid_to: NOW }));
    git(root, "add", "-A"); git(root, "commit", "-qm", "fixture: replaced decision");
    const head = git(root, "rev-parse", "HEAD");
    const cases: Array<[string, string[], RegExp]> = [
      ["remove", ["bug_crash"], /can't be removed/],
      ["restore", ["bug_crash"], /nothing to restore/],
      ["restore", ["con_axios"], /not removed/],
      ["restore", ["dec_replaced"], /replaced by dec_acc/],
      ["remove", ["con_nope"], /not found/],
      ["remove", ["zzz_1"], /not a memory id/],
    ];
    for (const [cmd, args, pattern] of cases) {
      const run = spawnSync(process.execPath, hunchCliArgs(cmd, ...args), { cwd: root, encoding: "utf8", env: cliEnv() });
      assert.notEqual(run.status, 0, `${cmd} ${args.join(" ")}`);
      assert.match(`${run.stdout}${run.stderr}`, pattern);
    }
    assert.equal(git(root, "rev-parse", "HEAD"), head);
    assert.equal(git(root, "status", "--porcelain"), "");
  } finally { cleanupDir(root); }
});

test("cli: the four verbs' commit subjects classify as plain edit moves in hunch log", () => {
  const root = fixtureRepo();
  try {
    const base = git(root, "rev-parse", "HEAD");
    spawnSync(process.execPath, hunchCliArgs("edit", "dec_prop", "--text", "changed"), { cwd: root, encoding: "utf8", env: cliEnv() });
    spawnSync(process.execPath, hunchCliArgs("link", "dec_prop", "--add-file", "x.ts"), { cwd: root, encoding: "utf8", env: cliEnv() });
    spawnSync(process.execPath, hunchCliArgs("remove", "dec_prop"), { cwd: root, encoding: "utf8", env: cliEnv() });
    spawnSync(process.execPath, hunchCliArgs("restore", "dec_prop"), { cwd: root, encoding: "utf8", env: cliEnv() });
    const shas = git(root, "rev-list", "--reverse", `${base}..HEAD`).split("\n").filter(Boolean);
    assert.equal(shas.length, 4);
    const kinds = shas.map((sha) => {
      const subject = git(root, "log", "-1", "--format=%s", sha);
      const raw = `${MEMLOG_HEADER}${sha}\tshort\t2026-01-02T00:00:00Z\t${subject}\n${git(root, "show", "--format=", "--name-status", sha)}`;
      return `${subject} => ${parseMemoryLog(raw)[0]?.kind}`;
    });
    assert.deepEqual(kinds, [
      "hunch: edit dec_prop => edit",
      "hunch: link dec_prop => edit",
      "hunch: remove dec_prop => edit",
      "hunch: restore dec_prop => edit",
    ]);
    assert.equal(read<Decision>(root, "decisions", "dec_prop").status, "proposed");
  } finally { cleanupDir(root); }
});

test("cli:edit of a human-confirmed decision drops the signature; cli:link keeps it", () => {
  const root = fixtureRepo();
  try {
    const signed = { source: "human_confirmed", confidence: 0.95, evidence: [] as string[] };
    new JsonStore(hunchPaths(root)).put("decisions", decision("dec_signed", { title: "Signed", provenance: signed }));
    git(root, "add", "-A"); git(root, "commit", "-qm", "fixture: signed decision");
    const link = spawnSync(process.execPath, hunchCliArgs("link", "dec_signed", "--add-file", "src/b.ts", "--json"), { cwd: root, encoding: "utf8", env: cliEnv() });
    assert.equal(link.status, 0, `${link.stdout}${link.stderr}`);
    assert.equal(parseJson(link.stdout).after.provenance.source, "human_confirmed");
    const edit = spawnSync(process.execPath, hunchCliArgs("edit", "dec_signed", "--text", "reworded", "--json"), { cwd: root, encoding: "utf8", env: cliEnv() });
    assert.equal(edit.status, 0, `${edit.stdout}${edit.stderr}`);
    const out = parseJson(edit.stdout);
    assert.equal(out.before.provenance.source, "human_confirmed");
    assert.equal(out.after.provenance.source, "agent_recorded");
    const onDisk = read<Decision>(root, "decisions", "dec_signed");
    assert.deepEqual([onDisk.provenance.source, onDisk.provenance.confidence], ["agent_recorded", 0.75]);
  } finally { cleanupDir(root); }
});
