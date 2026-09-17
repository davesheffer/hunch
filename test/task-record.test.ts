import { test } from "node:test";
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { existsSync, mkdirSync, mkdtempSync, realpathSync, rmSync, utimesSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { buildDeliveryEnvelope } from "../src/core/delivery.js";
import type { AssembledContext } from "../src/store/hunchStore.js";
import { CONTINUATION_WINDOW_MS, continuationLinks, finishReportTask, forgetReportTask, listTaskSummaries, readTaskReport, recordReportSave, recordTaskDelivery, reportHash, startReportTask } from "../src/core/taskReport.js";
import { computeSupersedes, mergeDurableTaskSummaries, persistTaskRecord, targetLooksLikePath, taskRecordFromReport } from "../src/core/taskRecord.js";
import { gitTouchedFiles } from "../src/core/taskTouched.js";
import { TaskRecordSchema, type TaskRecord } from "../src/core/types.js";
import { canonicalReportRoot } from "../src/core/taskReportPaths.js";
import { promptTaskTitle } from "../src/core/taskReportHook.js";
import { withServedDatabase } from "../src/core/served.js";
import { HunchStore } from "../src/store/hunchStore.js";
import { hunchPaths } from "../src/core/paths.js";

type Ctx = { after: (f: () => void) => void };
const closers = new WeakMap<Ctx, Array<() => void>>();
/** Stores must close before their directory goes away (Windows holds sqlite
 * handles), so every fixture cleanup closes registered stores first. */
function fixture(t: Ctx): string {
  const root = mkdtempSync(join(tmpdir(), "hunch-task-record-"));
  if (!closers.has(t)) {
    closers.set(t, []);
    t.after(() => { for (const close of closers.get(t)!.splice(0)) { try { close(); } catch { /* already closed */ } } });
  }
  t.after(() => rmSync(root, { recursive: true, force: true, maxRetries: 5, retryDelay: 50 }));
  execFileSync("git", ["init", "-q", root]);
  mkdirSync(join(root, "src"));
  writeFileSync(join(root, ".gitignore"), ".hunch-cache/\n");
  writeFileSync(join(root, "src", "config.js"), "export const preserve = true;\n");
  return root;
}
function openStore(root: string, t: Ctx): HunchStore {
  const store = new HunchStore(hunchPaths(root));
  store.json.ensureDirs();
  closers.get(t)!.push(() => store.close());
  return store;
}
function envelope() {
  const ctx = { target: "src/config.js", constraints: [], decisions: [], bugs: [], blast_radius: [], components: [], findings: [], budget_tokens: 1500 } as unknown as AssembledContext;
  ctx.constraints.push({ id: "con_preserve", type: "architecture", statement: "Preserve existing settings", scope: ["src/config.js"], severity: "blocking", enforcement: "advisory_v1", match: null, forbids: null, rationale: "", source_decision: null, violations: [], status: "active", valid_from: "2026-09-11T00:00:00.000Z", valid_to: null, provenance: { source: "human_confirmed", confidence: 1, evidence: [] } });
  return buildDeliveryEnvelope(ctx);
}
const record = { record_id: "con_preserve", kind: "constraints", title: "Preserve existing settings", lesson: "Merge settings; preserve values outside the update.", content_hash: reportHash("fixture record revision"), recorded_at: "2026-09-11T00:00:00.000Z" };

test("an episode is one record: the head's id and start, the union of observations, the latest close; the window rule and the ledger view follow", t => {
  const root = fixture(t), store = openStore(root, t);
  const key = reportHash(["session"]);
  const head = startReportTask(root, "Assistant task", undefined, { session_key: key });
  recordTaskDelivery(root, head.task_id, envelope(), [record], undefined, "src/config.js");
  finishReportTask(root, head.task_id, "completed", { by: "host" });
  const first = persistTaskRecord(root, store, head.task_id, { flush: false });
  assert.ok(first);
  assert.equal(first.record.id, head.task_id);
  assert.equal(first.record.lessons.length, 1);

  const links = continuationLinks(readTaskReport(root, head.task_id).task);
  assert.deepEqual(links, { continues: head.task_id, episode: head.task_id });
  const next = startReportTask(root, "Fix settings merge", undefined, { session_key: key, ...links! });
  // A later revision of the same lesson: the episode keeps both exact revisions.
  recordTaskDelivery(root, next.task_id, envelope(), [{ ...record, content_hash: reportHash("second revision") }], undefined, "src/other.js");
  finishReportTask(root, next.task_id);
  const merged = persistTaskRecord(root, store, next.task_id, { flush: false });
  assert.ok(merged);
  assert.equal(merged.record.id, head.task_id, "the follow-up prompt refreshes the head's record instead of adding one");
  assert.equal(merged.changed, true);
  assert.equal(merged.record.title, "Fix settings merge", "the first non-generic title names the episode");
  assert.equal(merged.record.started_at, head.started_at);
  assert.equal(merged.record.finished_at, readTaskReport(root, next.task_id).task.finished_at);
  assert.equal(merged.record.lessons.length, 2, "both delivered revisions, across both prompts");
  assert.ok(merged.record.lessons.every(l => l.record_id === "con_preserve"));
  assert.deepEqual(merged.record.files, ["src/config.js", "src/other.js"]);
  assert.equal(store.recs("tasks").length, 1, "one record for the episode");
  assert.equal(existsSync(join(root, ".hunch", "tasks", `${next.task_id}.json`)), false);
  const again = persistTaskRecord(root, store, next.task_id, { flush: false });
  assert.equal(again?.changed, false, "idempotent on the episode's combined report hash");

  // The window: a task closed long ago is not the same work; one still open is
  // the session's current work however old (interrupted before its Stop, #263).
  const stale = { ...readTaskReport(root, head.task_id).task, finished_at: new Date(Date.now() - CONTINUATION_WINDOW_MS - 60_000).toISOString() };
  assert.equal(continuationLinks(stale), null);
  const openOld = { ...stale, state: "open" as const, finished_at: null, started_at: stale.finished_at! };
  assert.deepEqual(continuationLinks(openOld), { continues: head.task_id, episode: head.task_id });
  assert.equal(continuationLinks(null), null);

  // The ledger view shows the continued prompt as durable under its episode.
  const view = mergeDurableTaskSummaries(store, listTaskSummaries(root));
  assert.deepEqual(view.map(s => [s.task.task_id, s.durable?.home ?? null, s.task.episode ?? null]).sort(), [[head.task_id, "public", null], [next.task_id, "public", head.task_id]].sort());
});

test("git-side work while the task was open anchors the record: the user's commits and fresh working-tree edits, never memory paths, old files or deletions", t => {
  const root = fixture(t), store = openStore(root, t);
  const git = (...args: string[]) => execFileSync("git", ["-C", root, ...args], { encoding: "utf8", env: { ...process.env, GIT_AUTHOR_DATE: "2026-01-01T00:00:00Z", GIT_COMMITTER_DATE: "2026-01-01T00:00:00Z" } });
  git("config", "user.email", "dev@example.com");
  git("config", "user.name", "Dev");
  writeFileSync(join(root, "src", "old.js"), "old\n");
  writeFileSync(join(root, "src", "gone.js"), "gone\n");
  git("add", "-A");
  git("commit", "-q", "-m", "base");   // committed long before the task: not work of this task
  const old = new Date("2026-01-01T00:00:00Z");
  utimesSync(join(root, "src", "old.js"), old, old);

  const task = startReportTask(root, "Release chores from the shell");
  const started = Date.parse(task.started_at);
  // Work done while the task is open, none of it through an instrumented editor.
  writeFileSync(join(root, "src", "committed.js"), "export const a = 1;\n");
  execFileSync("git", ["-C", root, "add", "src/committed.js"]);
  execFileSync("git", ["-C", root, "commit", "-q", "-m", "feat: shell work"]);
  writeFileSync(join(root, "src", "fresh.js"), "untracked but fresh\n");
  writeFileSync(join(root, "src", "old.js"), "modified, then dated back\n");
  utimesSync(join(root, "src", "old.js"), old, old);
  rmSync(join(root, "src", "gone.js"));
  mkdirSync(join(root, ".hunch"), { recursive: true });
  writeFileSync(join(root, ".hunch", "scratch.txt"), "memory paths never count as work\n");
  // The base commit sits outside the window even for a very early start.
  const touched = gitTouchedFiles(root, new Date(started - 5_000).toISOString(), null);
  assert.deepEqual(touched, ["src/committed.js", "src/fresh.js"], "commit in the window + fresh untracked file; not the backdated file, the deletion, the old commit or the memory path");
  assert.deepEqual(gitTouchedFiles(root, "2030-01-01T00:00:00.000Z", "2030-01-02T00:00:00.000Z"), [], "an empty window yields nothing");
  assert.deepEqual(gitTouchedFiles(root, "not a date", null), []);

  recordTaskDelivery(root, task.task_id, envelope(), [record], undefined, "src/config.js");
  finishReportTask(root, task.task_id);
  const saved = persistTaskRecord(root, store, task.task_id, { flush: false });
  assert.ok(saved);
  assert.deepEqual(saved.record.files, ["src/config.js", "src/committed.js", "src/fresh.js"], "report-derived files first, then what git saw");
});

test("a finished task with observations becomes a graph record; an empty task stays ledger-only", t => {
  const root = fixture(t), store = openStore(root, t);
  const task = startReportTask(root, "Fix settings merge");
  recordTaskDelivery(root, task.task_id, envelope(), [record]);
  finishReportTask(root, task.task_id);

  const saved = persistTaskRecord(root, store, task.task_id, { flush: false });
  assert.ok(saved, "a task with a delivery must be persisted");
  assert.equal(saved.home, "public");
  assert.equal(saved.changed, true);
  assert.equal(saved.record.id, task.task_id);
  assert.equal(saved.record.state, "completed");
  assert.equal(saved.record.coverage, "delivered");
  assert.deepEqual(saved.record.lessons.map(l => l.record_id), ["con_preserve"]);
  assert.equal(saved.record.report_hash, readTaskReport(root, task.task_id).content_hash);
  assert.ok(existsSync(join(root, ".hunch", "tasks", `${task.task_id}.json`)), "record lives in .hunch/tasks/ like every other kind");
  assert.equal(store.recs("tasks").length, 1);

  // Idempotent on the report revision: no rewrite, no second flush.
  const again = persistTaskRecord(root, store, task.task_id, { flush: false });
  assert.ok(again);
  assert.equal(again.changed, false);

  // The graph knows about it: searchable, and the record is what Hunch reads back.
  store.reindex();
  assert.ok(store.search("settings merge", 10).some(h => h.kind === "tasks" && h.ref === task.task_id), "finished tasks are FTS-indexed");
  assert.equal(store.getRec("tasks", task.task_id)?.title, "Fix settings merge");

  // Nothing observed → nothing to remember; the ledger row alone keeps it countable.
  const empty = startReportTask(root, "Bare prompt");
  finishReportTask(root, empty.task_id);
  assert.equal(persistTaskRecord(root, store, empty.task_id, { flush: false }), null);
  assert.equal(taskRecordFromReport(readTaskReport(root, empty.task_id)), null);
  assert.ok(!existsSync(join(root, ".hunch", "tasks", `${empty.task_id}.json`)));

  // An open task is never persisted.
  const open = startReportTask(root, "Still working");
  recordTaskDelivery(root, open.task_id, envelope(), [record]);
  assert.equal(persistTaskRecord(root, store, open.task_id, { flush: false }), null);
});

test("task list merges graph records with the ledger and keeps graph-only tasks visible", t => {
  const root = fixture(t), store = openStore(root, t);
  const durable = startReportTask(root, "Durable task");
  recordTaskDelivery(root, durable.task_id, envelope(), [record]);
  finishReportTask(root, durable.task_id);
  persistTaskRecord(root, store, durable.task_id, { flush: false });
  const local = startReportTask(root, "Local only");
  finishReportTask(root, local.task_id);

  let merged = mergeDurableTaskSummaries(store, listTaskSummaries(root));
  assert.deepEqual(merged.find(s => s.task.task_id === durable.task_id)?.durable, { home: "public" });
  assert.equal(merged.find(s => s.task.task_id === local.task_id)?.durable, null);

  // The ledger forgets (prune / another machine); the graph still shows the task.
  forgetReportTask(root, durable.task_id);
  assert.equal(listTaskSummaries(root).some(s => s.task.task_id === durable.task_id), false);
  merged = mergeDurableTaskSummaries(store, listTaskSummaries(root));
  const fromGraph = merged.find(s => s.task.task_id === durable.task_id);
  assert.ok(fromGraph, "graph-only tasks join the list");
  assert.equal(fromGraph.lessons, 1);
  assert.equal(fromGraph.report_html, null);
  assert.equal(fromGraph.empty, false);
  assert.deepEqual(fromGraph.durable, { home: "public" });
  assert.equal(merged[0]?.task.task_id, local.task_id, "newest first across both sources");
});

test("a task that touched the private overlay is homed private, never named in the public store", t => {
  const root = fixture(t), overlay = mkdtempSync(join(tmpdir(), "hunch-task-record-overlay-"));
  t.after(() => rmSync(overlay, { recursive: true, force: true, maxRetries: 5, retryDelay: 50 }));
  mkdirSync(join(root, ".hunch"), { recursive: true });
  writeFileSync(join(root, ".hunch", "local.json"), JSON.stringify({ privateDir: join(overlay, ".hunch"), autoCommit: false }));
  const store = openStore(root, t);
  assert.equal(store.hasPrivate, true);
  assert.equal(store.captureHome(false), "public", "split routing: public stays the default home");

  const task = startReportTask(root, "Strategy note");
  recordTaskDelivery(root, task.task_id, envelope(), [record]);
  recordReportSave(root, task.task_id, { source: "store-write", record: { ...record, kind: "decisions", record_id: "dec_private" }, home: "private", operation: "created" });
  finishReportTask(root, task.task_id);

  const saved = persistTaskRecord(root, store, task.task_id, { flush: false });
  assert.ok(saved);
  assert.equal(saved.home, "private");
  assert.ok(existsSync(join(overlay, ".hunch", "tasks", `${task.task_id}.json`)));
  assert.ok(!existsSync(join(root, ".hunch", "tasks", `${task.task_id}.json`)));
  assert.deepEqual(mergeDurableTaskSummaries(store, listTaskSummaries(root)).find(s => s.task.task_id === task.task_id)?.durable, { home: "private" });
  // The home is fixed once written, even if a later revision looks public.
  assert.equal(persistTaskRecord(root, store, task.task_id, { flush: false })?.home, "private");
});

test("task scope survives drive-letter casing differences between the hook and MCP processes", t => {
  const root = fixture(t);
  const canonical = canonicalReportRoot(root);
  assert.equal(canonicalReportRoot(root.toLowerCase() === root ? root : root), canonical);
  const task = startReportTask(root, "Cased task");
  finishReportTask(root, task.task_id);
  if (process.platform === "win32" && /^[A-Za-z]:/.test(root)) {
    const swapped = (root[0] === root[0].toLowerCase() ? root[0].toUpperCase() : root[0].toLowerCase()) + root.slice(1);
    assert.notEqual(realpathSync(swapped), realpathSync(root), "the JS resolver preserves caller casing; that was the bug");
    assert.equal(canonicalReportRoot(swapped), canonical, "the native resolver gives one identity");
    // Written under one spelling, read under the other.
    assert.equal(readTaskReport(swapped, task.task_id).task.task_id, task.task_id);
    // A row an older release wrote under the caller-cased hash is still found.
    const legacyId = `htask_${reportHash("legacy").slice(7, 31)}`;
    withServedDatabase(root, db => db.prepare("INSERT INTO report_tasks VALUES (?, ?, ?)").run(legacyId, reportHash(realpathSync(swapped)), JSON.stringify({ task_id: legacyId, scope: reportHash(realpathSync(swapped)), title: "Legacy row", started_at: new Date().toISOString(), finished_at: null, state: "open" })));
    assert.equal(readTaskReport(root, legacyId).task.title, "Legacy row");
  } else {
    assert.equal(readTaskReport(root, task.task_id).task.task_id, task.task_id);
  }
});

test("delivery targets that name code become task files; task phrases never do", t => {
  const root = fixture(t), store = openStore(root, t);
  const task = startReportTask(root, "Read-only review");
  recordTaskDelivery(root, task.task_id, envelope(), [record], undefined, "src/config.js");
  recordTaskDelivery(root, task.task_id, envelope(), [record], undefined, "fix the login redirect");
  recordTaskDelivery(root, task.task_id, envelope(), [record]);
  finishReportTask(root, task.task_id);
  const report = readTaskReport(root, task.task_id);
  assert.deepEqual(report.deliveries.map(d => d.target), ["src/config.js", "fix the login redirect", null]);
  const saved = persistTaskRecord(root, store, task.task_id, { flush: false });
  assert.ok(saved);
  assert.deepEqual(saved.record.files, ["src/config.js"]);
  assert.deepEqual(store.tasksFor("src/config.js").map(r => r.id), [task.task_id], "hunch_why can now see a read-only task");
  assert.equal(targetLooksLikePath("src/auth/session.ts"), true);
  assert.equal(targetLooksLikePath("dbo.GetOrders"), true);
  assert.equal(targetLooksLikePath("fix the login redirect"), false);
  assert.equal(targetLooksLikePath("login"), false);
});

test("batch flush mode writes the record but leaves the commit to the next capture", t => {
  const root = fixture(t);
  mkdirSync(join(root, ".hunch"), { recursive: true });
  writeFileSync(join(root, ".hunch", "local.json"), JSON.stringify({ taskRecordsFlush: "batch" }));
  const store = openStore(root, t);
  const task = startReportTask(root, "Batched task");
  recordTaskDelivery(root, task.task_id, envelope(), [record]);
  finishReportTask(root, task.task_id);
  const saved = persistTaskRecord(root, store, task.task_id);
  assert.ok(saved);
  assert.equal(saved.flushed, null);
  assert.ok(existsSync(join(root, ".hunch", "tasks", `${task.task_id}.json`)));
  assert.throws(() => execFileSync("git", ["-C", root, "rev-parse", "--verify", "HEAD"], { stdio: "pipe" }), "no memory commit was made for the task alone");
});

test("native task titles come from the prompt's first line and never carry credentials", () => {
  assert.equal(promptTaskTitle(undefined), null);
  assert.equal(promptTaskTitle("   \n\n  "), null);
  assert.equal(promptTaskTitle("  Fix the   login\tredirect\nmore detail below"), "Fix the login redirect");
  const long = promptTaskTitle("please refactor the settings merge so that nested user overrides survive a partial update of the config file");
  assert.ok(long && long.endsWith("…") && long.length <= 73, long ?? "null");
  assert.ok(long && !long.includes("  "));
  assert.equal(promptTaskTitle("-----BEGIN PRIVATE KEY-----\nabc"), null);
  assert.equal(promptTaskTitle("check status\n-----BEGIN PRIVATE KEY-----\nabc"), null, "a credential anywhere in the prompt keeps the generic title");
});

test("supersession: a later task on the same file with a shared record and a passing check supersedes; violations and unchecked work never do", () => {
  const base = (id: string, over: Partial<TaskRecord>): TaskRecord => TaskRecordSchema.parse({
    id: `htask_${id.padEnd(24, "0").slice(0, 24)}`, title: id, state: "completed", started_at: "2026-09-01T00:00:00.000Z", finished_at: "2026-09-01T00:00:00.000Z", coverage: "delivered",
    lessons: [{ kind: "constraints", record_id: "con_a", content_hash: reportHash("a"), title: "A" }], applied: [], saved: [], checks: [], conformance: [], refusals: 0, files: ["src/config.js"],
    report_hash: reportHash(id), provenance: { source: "task_report", confidence: 1, evidence: [] }, ...over,
  });
  const older = base("older", {});
  const otherFile = base("otherfile", { files: ["src/other.js"] });
  const otherRule = base("otherrule", { lessons: [{ kind: "constraints", record_id: "con_b", content_hash: reportHash("b"), title: "B" }] });
  const newer = base("newer", { finished_at: "2026-09-02T00:00:00.000Z", checks: [{ label: "npm test", state: "passed", exit_code: 0 }] });
  assert.deepEqual(computeSupersedes(newer, [older, otherFile, otherRule, newer]), [older.id]);
  assert.deepEqual(computeSupersedes(base("nocheck", { finished_at: "2026-09-02T00:00:00.000Z" }), [older]), [], "unverified work supersedes nothing");
  assert.deepEqual(computeSupersedes(base("failed", { finished_at: "2026-09-02T00:00:00.000Z", checks: [{ label: "t", state: "failed", exit_code: 1 }] }), [older]), []);
  assert.deepEqual(computeSupersedes(base("violated", { finished_at: "2026-09-02T00:00:00.000Z", checks: [{ label: "t", state: "passed", exit_code: 0 }], conformance: [{ kind: "constraints", record_id: "con_a", content_hash: reportHash("a"), outcome: "violated" }] }), [older]), [], "a task that violated a rule supersedes nothing");
  assert.deepEqual(computeSupersedes(base("earlier", { finished_at: "2026-08-01T00:00:00.000Z", checks: [{ label: "t", state: "passed", exit_code: 0 }] }), [older]), [], "only older records can be superseded");
});

test("hunch's own commits and the grounding files it rewrites never count as task work; a shared checkout keeps only commits (#264, #265)", t => {
  const root = fixture(t), store = openStore(root, t);
  const dated = { ...process.env, GIT_AUTHOR_DATE: "2026-01-01T00:00:00Z", GIT_COMMITTER_DATE: "2026-01-01T00:00:00Z" };
  const git = (...args: string[]) => execFileSync("git", ["-C", root, ...args], { encoding: "utf8" });
  git("config", "user.email", "dev@example.com");
  git("config", "user.name", "Dev");
  git("add", "-A");
  execFileSync("git", ["-C", root, "commit", "-q", "-m", "base"], { env: dated });
  const task = startReportTask(root, "Shell work beside a capture", undefined, { session_key: reportHash("session one") });
  const from = new Date(Date.parse(task.started_at) - 5_000).toISOString();
  // A capture commit regenerates the grounding block; a real commit follows.
  writeFileSync(join(root, "CLAUDE.md"), "# grounding\n");
  mkdirSync(join(root, ".hunch", "decisions"), { recursive: true });
  writeFileSync(join(root, ".hunch", "decisions", "dec_x.json"), "{}\n");
  git("add", "-A");
  git("commit", "-q", "-m", "hunch: capture dec_x");
  writeFileSync(join(root, "src", "real.js"), "export const real = 1;\n");
  git("add", "-A");
  git("commit", "-q", "-m", "feat: real work");
  // Fresh in the working tree: a regenerated grounding file and a real edit.
  writeFileSync(join(root, "AGENTS.md"), "# regenerated by a capture\n");
  writeFileSync(join(root, "src", "fresh.js"), "fresh\n");
  assert.deepEqual(gitTouchedFiles(root, from, null), ["src/fresh.js", "src/real.js"], "neither the capture commit nor the regenerated grounding file");
  assert.deepEqual(gitTouchedFiles(root, from, null, { workingTree: false }), ["src/real.js"]);
  // Another session opens a task on the same checkout while this one is open.
  startReportTask(root, "Someone else's prompt", undefined, { session_key: reportHash("session two") });
  recordTaskDelivery(root, task.task_id, envelope(), [record], undefined, "src/config.js");
  finishReportTask(root, task.task_id);
  const saved = persistTaskRecord(root, store, task.task_id, { flush: false });
  assert.ok(saved);
  assert.deepEqual(saved.record.files, ["src/config.js", "src/real.js"], "a shared checkout: commits anchor the record, working-tree mtimes do not");
});
