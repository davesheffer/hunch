import { test } from "node:test";
import assert from "node:assert/strict";
import { execFileSync, spawn } from "node:child_process";
import { existsSync, mkdtempSync, mkdirSync, readFileSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { buildDeliveryEnvelope } from "../src/core/delivery.js";
import type { AssembledContext } from "../src/store/hunchStore.js";
import { finishReportTask, listReportTasks, pruneReportHistory, readTaskReport, readLessonHistory, recordReportClaim, recordTaskDelivery, reportHash, startReportTask } from "../src/core/taskReport.js";
import { reportSourceSnapshot, runReportCheck, snapshotDeliveredRecords } from "../src/core/taskReportEvidence.js";
import { renderTaskReport, renderTaskReportHtml, writeTaskReportHtml } from "../src/core/taskReportRender.js";
import { recordServed, servedSummary, withServedDatabase } from "../src/core/served.js";
import { publicTaskReport, renderPublicTaskReportHtml } from "../src/core/taskReportPublic.js";
import { HunchStore } from "../src/store/hunchStore.js";
import { hunchPaths } from "../src/core/paths.js";
import { mkConstraint } from "./helpers.js";
import { writeCodexConfig } from "../src/integrations/providers.js";

function fixture(t: { after: (f: () => void) => void }): string {
  const root = mkdtempSync(join(tmpdir(), "hunch-task-report-"));
  t.after(() => rmSync(root, { recursive: true, force: true }));
  execFileSync("git", ["init", "-q", root]);
  mkdirSync(join(root, "src"));
  writeFileSync(join(root, ".gitignore"), ".hunch/\n.hunch-cache/\n");
  writeFileSync(join(root, "src", "config.js"), "export const preserve = true;\n");
  return root;
}
function envelope(empty = false) {
  const ctx = { target: "src/config.js", constraints: [], decisions: [], bugs: [], blast_radius: [], components: [], findings: [], budget_tokens: 1500 } as unknown as AssembledContext;
  if (!empty) ctx.constraints.push({ id: "con_preserve", type: "architecture", statement: "Preserve existing settings", scope: ["src/config.js"], severity: "blocking", enforcement: "advisory_v1", match: null, forbids: null, rationale: "", source_decision: null, violations: [], status: "active", valid_from: "2026-09-11T00:00:00.000Z", valid_to: null, provenance: { source: "human_confirmed", confidence: 1, evidence: [] } });
  return buildDeliveryEnvelope(ctx);
}
const record = { record_id: "con_preserve", kind: "constraints", title: "Preserve existing settings", lesson: "Merge settings; preserve values outside the update.", content_hash: reportHash("fixture record revision"), recorded_at: "2026-09-11T00:00:00.000Z" };

test("lesson history connects exact revisions across tasks without conflating titles or repeated receipts", async t => {
  const api = await import("../src/core/taskReport.js");
  const history = readLessonHistory;
  assert.equal(typeof history, "function", "retained lessons must be inspectable across tasks");
  const root = fixture(t), other = fixture(t);
  const a = startReportTask(root, "First task"), b = startReportTask(root, "Fresh agent");
  const first = recordTaskDelivery(root, a.task_id, envelope(), [record]);
  recordTaskDelivery(root, a.task_id, envelope(), [record], first);
  finishReportTask(root, a.task_id);
  recordTaskDelivery(root, b.task_id, envelope(), [record]);
  recordTaskDelivery(root, b.task_id, envelope(), [{ ...record, content_hash: reportHash("new revision") }]);
  const found = history(root, { kind: record.kind, record_id: record.record_id, content_hash: record.content_hash });
  assert.equal(found.entries.length, 2);
  assert.equal(found.index_complete, true);
  assert.deepEqual(new Set(found.entries.map(e => e.task.task_id)), new Set([a.task_id, b.task_id]));
  assert.equal(history(root, { kind: "decisions", record_id: record.record_id }).entries.length, 0);
  assert.equal(history(other, { kind: record.kind, record_id: record.record_id }).entries.length, 0);
  assert.equal(history(root, { kind: record.kind, record_id: record.record_id }).entries.length, 3);
  const evidence = readFileSync(writeTaskReportHtml(root, b.task_id), "utf8");
  assert.match(evidence, /First task/);
  assert.match(evidence, /Where this lesson appeared/);
  api.forgetReportTask(root, a.task_id);
  assert.equal(history(root, { kind: record.kind, record_id: record.record_id, content_hash: record.content_hash }).entries.length, 1);
  withServedDatabase(root, db => db.prepare("UPDATE report_events SET body = '{}' WHERE task_id = ? AND kind = 'delivery'").run(b.task_id));
  assert.throws(() => history(root, { kind: record.kind, record_id: record.record_id }), /hash mismatch/);
});

test("historical delivery lookup backfills in bounded batches, paginates, and resumes after expiry", t => {
  const root = fixture(t), task = startReportTask(root, "Historical task");
  for (let i = 0; i < 70; i++) recordTaskDelivery(root, task.task_id, envelope(), [record]);
  // A pre-history ledger contains authoritative events and no derived lookup.
  withServedDatabase(root, db => db.exec("DROP TABLE report_record_links; DROP TABLE report_history_progress;"));
  const ref = { kind: record.kind, record_id: record.record_id, content_hash: record.content_hash };
  const partial = readLessonHistory(root, ref, { limit: 30 });
  assert.equal(partial.index_complete, false);
  assert.equal(partial.next_before, null, "partial indexing must not issue a cursor that skips newly indexed history");
  const complete = readLessonHistory(root, ref, { limit: 30 });
  assert.equal(complete.index_complete, true);
  assert.equal(complete.truncated, true);
  assert.ok(complete.next_before);
  const next = readLessonHistory(root, ref, { limit: 30, before: complete.next_before });
  assert.equal(new Set([...complete.entries, ...next.entries].map(e => e.event_id)).size, 60);
  const last = readLessonHistory(root, ref, { limit: 30, before: next.next_before! });
  assert.equal(last.entries.length, 10);
  assert.equal(last.next_before, null);
  finishReportTask(root, task.task_id);
  // Deleting the tail allows SQLite to reuse rowids; new observations must
  // remain visible rather than disappearing behind a stale backfill cursor.
  withServedDatabase(root, db => db.prepare("UPDATE report_tasks SET body=json_set(body,'$.finished_at','2000-01-01T00:00:00.000Z')").run());
  assert.equal(pruneReportHistory(root), 1);
  const fresh = startReportTask(root, "Fresh after expiry");
  recordTaskDelivery(root, fresh.task_id, envelope(), [record]);
  assert.deepEqual(readLessonHistory(root, ref).entries.map(e => e.task.task_id), [fresh.task_id]);
});

test("task reports preserve exact delivery occurrences, empty responses and historical uncertainty", t => {
  const root = fixture(t);
  recordServed(root, [{ event: "served", kind: "constraints", record_id: record.record_id, target: "src/config.js" }]);
  const a = startReportTask(root, "Preserve settings");
  assert.equal(startReportTask(root, a.title, a.task_id).task_id, a.task_id);
  assert.throws(() => startReportTask(root, "different", a.task_id), /different title/);
  const delivery = envelope();
  const first = recordTaskDelivery(root, a.task_id, delivery, [record]);
  assert.equal(recordTaskDelivery(root, a.task_id, delivery, [record], first), first);
  const second = recordTaskDelivery(root, a.task_id, delivery, [record]);
  const report = readTaskReport(root, a.task_id);
  assert.notEqual(first, second);
  assert.equal(report.deliveries.length, 2);
  assert.equal(report.deliveries[0]!.receipt_id, report.deliveries[1]!.receipt_id);
  assert.deepEqual(report.deliveries[0]!.envelope, delivery);
  assert.match(renderTaskReport(report), /contribution unverified/);
  assert.equal(servedSummary(root).total, 1, "old ledger remains unchanged and readable");
  const b = startReportTask(root, "Unrelated task");
  recordTaskDelivery(root, b.task_id, envelope(true), []);
  assert.equal(readTaskReport(root, b.task_id).coverage, "no-relevant-memory");
  const c = startReportTask(root, "Missing telemetry");
  assert.equal(readTaskReport(root, c.task_id).coverage, "no-delivery-observed");
  assert.equal(listReportTasks(root).length, 3);
});

test("claims cannot cross tasks, record revisions, worktrees, or mutated envelopes", t => {
  const root = fixture(t), other = fixture(t);
  const a = startReportTask(root, "Task A"), b = startReportTask(root, "Task B");
  const env = envelope();
  const occurrence = recordTaskDelivery(root, a.task_id, env, [record]);
  const claim = { occurrence_id: occurrence, record_id: record.record_id, content_hash: record.content_hash, action: "Used a merge" };
  assert.throws(() => recordReportClaim(root, b.task_id, claim), /delivery in this task/);
  assert.throws(() => recordReportClaim(root, a.task_id, { ...claim, content_hash: reportHash("wrong") }), /revision was not delivered/);
  assert.throws(() => readTaskReport(other, a.task_id), /task not found/);
  assert.throws(() => recordTaskDelivery(root, a.task_id, { ...env, text: "forged" }, [record]), /receipt|budget|hash|invalid/i);
  assert.throws(() => recordTaskDelivery(root, b.task_id, env, [record], occurrence), /conflicts/);
  assert.throws(() => recordTaskDelivery(root, a.task_id, env, [{ ...record, record_id: "not-delivered" }]), /not delivered/);
  const id = recordReportClaim(root, a.task_id, claim);
  assert.equal(recordReportClaim(root, a.task_id, claim), id);
  finishReportTask(root, a.task_id);
  assert.equal(finishReportTask(root, a.task_id).state, "completed");
  assert.throws(() => finishReportTask(root, a.task_id, "interrupted"), /different outcome/);
  assert.throws(() => recordTaskDelivery(root, a.task_id, env, [record]), /already closed/);
  assert.equal(readTaskReport(root, a.task_id).claims[0]!.attribution, "agent-reported");
});

test("verification records actual failures and invalidates a pass after a source edit", async t => {
  const root = fixture(t), task = startReportTask(root, "Verify preservation");
  const before = reportSourceSnapshot(root).hash;
  assert.ok(before);
  await runReportCheck(root, task.task_id, [process.execPath, "-e", "process.exit(0)"], "Fixture pass");
  const passed = readTaskReport(root, task.task_id, reportSourceSnapshot(root).hash);
  assert.equal(passed.checks[0]!.exit_code, 0);
  assert.equal(passed.checks[0]!.current, true);
  writeFileSync(join(root, "src", "config.js"), "export const preserve = false;\n");
  assert.equal(readTaskReport(root, task.task_id, reportSourceSnapshot(root).hash).checks[0]!.current, false);
  await runReportCheck(root, task.task_id, [process.execPath, "-e", "process.exit(7)"], "Fixture failure");
  assert.equal(readTaskReport(root, task.task_id).checks[1]!.exit_code, 7);
  assert.match(renderTaskReport(readTaskReport(root, task.task_id)), /failed/);
});

test("checks changing source are not presented as verification of a stable snapshot", async t => {
  const root = fixture(t), task = startReportTask(root, "Mutating check");
  await runReportCheck(root, task.task_id, [process.execPath, "-e", "require('node:fs').writeFileSync('src/config.js', 'changed')"], "Mutates source");
  const report = readTaskReport(root, task.task_id, reportSourceSnapshot(root).hash);
  assert.equal(report.checks[0]!.exit_code, 0);
  assert.equal(report.checks[0]!.current, false);
  assert.match(renderTaskReport(report), /current source unverified/);
});

test("saved HTML describes generation-time evidence rather than a live source check", async t => {
  const root = fixture(t), task = startReportTask(root, "Saved evidence freshness");
  await runReportCheck(root, task.task_id, [process.execPath, "-e", "process.exit(0)"], "Pass before later edit");
  const report = readTaskReport(root, task.task_id, reportSourceSnapshot(root).hash);
  const html = renderTaskReportHtml(report, "2026-09-11T00:00:00.000Z");
  writeFileSync(join(root, "src", "config.js"), "export const preserve = false;\n");
  assert.equal(readTaskReport(root, task.task_id, reportSourceSnapshot(root).hash).checks[0]!.current, false);
  assert.match(html, /Generated 2026-09-11T00:00:00.000Z/);
  assert.match(html, /saved snapshot, not a live source check/);
  assert.match(html, /When this report was generated/);
  assert.doesNotMatch(html, /Source snapshot still matches/);
  assert.match(html, new RegExp(`hunch report ${task.task_id} --html`));
});

test("verification timeout bounds descendant processes inheriting output pipes", async t => {
  const root = fixture(t), task = startReportTask(root, "Timeout a command tree");
  const start = Date.now();
  const script = "require('node:child_process').spawn(process.execPath,['-e','setTimeout(()=>{},10000)'],{stdio:'inherit'});setTimeout(()=>{},10000)";
  const result = await runReportCheck(root, task.task_id, [process.execPath, "-e", script], "Command tree", 100);
  assert.equal(result.timed_out, true);
  assert.notEqual(result.exit_code, 0);
  assert.ok(Date.now() - start < 5_000, "timeout cannot wait for descendant pipes to close");
});

test("verification timeout is caller-bounded so a long suite can be retained, within a hard ceiling", async t => {
  const root = fixture(t), task = startReportTask(root, "Long check budget");
  const { MAX_CHECK_TIMEOUT_MS } = await import("../src/core/taskReportEvidence.js");
  await assert.rejects(runReportCheck(root, task.task_id, [process.execPath, "-e", "process.exit(0)"], "Over ceiling", MAX_CHECK_TIMEOUT_MS + 1), /verification timeout/);
  // A 30-minute budget was refused before fnd_70dd5c4034; it must be accepted now.
  const result = await runReportCheck(root, task.task_id, [process.execPath, "-e", "process.exit(0)"], "Half-hour budget", 30 * 60_000);
  assert.equal(result.exit_code, 0);
  assert.equal(result.timed_out, false);
  const cli = resolve("src/cli/index.ts"), tsx = resolve("node_modules/tsx/dist/loader.mjs");
  const env = { ...process.env, HUNCH_PIPELINE: "0" };
  delete env.HUNCH_PRIVATE_DIR;
  mkdirSync(join(root, ".hunch"));
  const run = (...args: string[]) => execFileSync(process.execPath, ["--import", tsx, cli, ...args], { cwd: root, env, encoding: "utf8", timeout: 60_000, stdio: ["ignore", "pipe", "pipe"] });
  assert.throws(() => run("task", "verify", task.task_id, "--timeout", "0", "--", process.execPath, "-e", "process.exit(0)"), /--timeout must be/);
  assert.throws(() => run("task", "verify", task.task_id, "--json", "--timeout", "1", "--", process.execPath, "-e", "setTimeout(()=>{},5000)"), (error: { status: number }) => error.status === 1);
  const quick = JSON.parse(run("task", "verify", task.task_id, "--json", "--timeout", "30", "--", process.execPath, "-e", "process.exit(0)"));
  assert.equal(quick.exit_code, 0);
  const report = readTaskReport(root, task.task_id);
  assert.deepEqual(report.checks.map(c => c.timed_out), [false, true, false]);
});

test("completion cannot discard an in-flight command result", async t => {
  const root = fixture(t), task = startReportTask(root, "Concurrent completion");
  const running = runReportCheck(root, task.task_id, [process.execPath, "-e", "setTimeout(()=>{},200)"], "Running check");
  assert.throws(() => finishReportTask(root, task.task_id), /verification is still running/);
  assert.match(readTaskReport(root, task.task_id).unknowns.join(" "), /still running/);
  await running;
  finishReportTask(root, task.task_id);
  assert.equal(readTaskReport(root, task.task_id).checks.length, 1);
});

test("verification streams diagnostics without retaining raw output", async t => {
  const root = fixture(t), task = startReportTask(root, "Useful failure output");
  let stdout = "", stderr = "";
  await runReportCheck(root, task.task_id, [process.execPath, "-e", "console.log('OUTPUT_SENTINEL'); console.error('ERROR_SENTINEL'); process.exit(7)"], "Expected failure", 5_000, {
    onStdout: chunk => { stdout += chunk; }, onStderr: chunk => { stderr += chunk; },
  });
  assert.match(stdout, /OUTPUT_SENTINEL/);
  assert.match(stderr, /ERROR_SENTINEL/);
  const report = readTaskReport(root, task.task_id);
  assert.equal(report.checks[0]!.exit_code, 7);
  // Command argv is retained; only the command's output streams are hash-only.
  const { command: _command, ...check } = report.checks[0]!;
  assert.doesNotMatch(JSON.stringify(check), /OUTPUT_SENTINEL|ERROR_SENTINEL/);
});

test("SIGTERM to the verification CLI stops its command and retains cancellation", { skip: process.platform === "win32", timeout: 20_000 }, async t => {
  const root = fixture(t), task = startReportTask(root, "Cancel verification");
  mkdirSync(join(root, ".hunch"));
  const script = "console.log('CHILD_PID='+process.pid);setInterval(()=>{},1000)";
  const runner = spawn(process.execPath, ["--import", resolve("node_modules/tsx/dist/loader.mjs"), resolve("src/cli/index.ts"), "task", "verify", task.task_id, "--", process.execPath, "-e", script], { cwd: root, stdio: ["ignore", "pipe", "pipe"] });
  let childPid: number | undefined;
  t.after(() => {
    runner.kill("SIGKILL");
    if (childPid) { try { process.kill(-childPid, "SIGKILL"); } catch {} }
  });
  let output = "", errors = "";
  const closed = new Promise<number | null>((resolveExit, reject) => { runner.once("error", reject); runner.once("close", resolveExit); });
  runner.stderr.on("data", chunk => { errors += chunk; });
  await new Promise<void>((ready, reject) => {
    const timer = setTimeout(() => reject(new Error(`No child startup: ${errors}`)), 10_000);
    runner.stdout.on("data", chunk => {
      output += chunk;
      const match = /CHILD_PID=(\d+)/.exec(output);
      if (match) { childPid = Number(match[1]); clearTimeout(timer); ready(); }
    });
  });
  runner.kill("SIGTERM");
  assert.equal(await closed, 143, errors);
  assert.ok(childPid);
  assert.throws(() => process.kill(childPid!, 0), /ESRCH/);
  const report = readTaskReport(root, task.task_id);
  assert.equal(report.checks[0]!.cancelled, true);
  assert.match(renderTaskReport(report), /cancelled/);
  assert.doesNotMatch(report.unknowns.join(" "), /still running/);
});

test("local report export refuses a symlinked output directory", t => {
  const root = fixture(t), other = fixture(t), task = startReportTask(root, "Private lesson");
  symlinkSync(other, join(root, ".hunch-cache", "reports"), process.platform === "win32" ? "junction" : "dir");
  assert.throws(() => writeTaskReportHtml(root, task.task_id), /symlinks/);
});

test("corrupt report evidence fails visibly rather than becoming an empty or green report", t => {
  const root = fixture(t), task = startReportTask(root, "Corrupt evidence");
  recordTaskDelivery(root, task.task_id, envelope(), [record]);
  withServedDatabase(root, db => db.prepare("UPDATE report_events SET body = ?").run('{}'));
  assert.throws(() => readTaskReport(root, task.task_id), /hash mismatch/);
});

test("local HTML renders untrusted lesson text inertly and has no external assets", t => {
  const root = fixture(t), task = startReportTask(root, "Review <script>alert(1)</script>");
  recordTaskDelivery(root, task.task_id, envelope(), [{ ...record, lesson: '<img src="https://example.invalid/x" onerror="alert(1)">' }]);
  const html = renderTaskReportHtml(readTaskReport(root, task.task_id));
  assert.ok(html.includes("&lt;script&gt;"));
  assert.ok(html.includes("&lt;img"));
  assert.doesNotMatch(html, /<script|<img|<link|<iframe/);
  assert.match(html, /default-src 'none'/);
  assert.match(html, /Contribution is unverified/);
});

test("public export reconstructs public records and omits private task, action and envelope prose", t => {
  const root = fixture(t), store = new HunchStore(hunchPaths(root));
  t.after(() => store.close());
  store.json.ensureDirs();
  store.json.put("constraints", mkConstraint({ id: "con_preserve", statement: "Preserve existing settings", scope: ["src/config.js"], severity: "blocking" }));
  const delivered = envelope();
  const snapshots = snapshotDeliveredRecords(store, delivered);
  const task = startReportTask(root, "PRIVATE_TASK_SENTINEL");
  const occurrence = recordTaskDelivery(root, task.task_id, delivered, snapshots.map(r => ({ ...r, title: "PRIVATE_SNAPSHOT_SENTINEL", lesson: "PRIVATE_SNAPSHOT_SENTINEL" })));
  recordReportClaim(root, task.task_id, { occurrence_id: occurrence, record_id: snapshots[0]!.record_id, content_hash: snapshots[0]!.content_hash, action: "PRIVATE_ACTION_SENTINEL" });
  const exported = publicTaskReport(root, task.task_id);
  const output = JSON.stringify(exported) + renderPublicTaskReportHtml(exported);
  assert.doesNotMatch(output, /PRIVATE_.*_SENTINEL/);
  assert.match(output, /Preserve existing settings/);
  assert.equal(exported.records.length, 1);
  store.json.put("constraints", mkConstraint({ id: "con_preserve", statement: "Changed public record", scope: ["src/config.js"], severity: "blocking" }));
  assert.equal(publicTaskReport(root, task.task_id).records.length, 0, "a changed public revision cannot authorize old snapshot prose");
});

test("CLI start, verify, finish and HTML share the persisted task report", t => {
  const root = fixture(t);
  mkdirSync(join(root, ".hunch"));
  const cli = resolve("src/cli/index.ts"), tsx = resolve("node_modules/tsx/dist/loader.mjs");
  const env = { ...process.env, HUNCH_PIPELINE: "0", HUNCH_SYNTH_PROVIDER: "deterministic" };
  delete env.HUNCH_PRIVATE_DIR;
  const run = (...args: string[]) => execFileSync(process.execPath, ["--import", tsx, cli, ...args], { cwd: root, env, encoding: "utf8", timeout: 30_000 });
  const task = JSON.parse(run("task", "start", "CLI smoke test"));
  const check = JSON.parse(run("task", "verify", task.task_id, "--", process.execPath, "-e", "process.exit(0)"));
  assert.equal(check.exit_code, 0);
  assert.deepEqual(JSON.parse(run("task", "conform", task.task_id)), [], "no delivered lesson means nothing to evaluate");
  assert.match(run("task", "finish", task.task_id), /completed/);
  const report = JSON.parse(run("report", task.task_id, "--json"));
  assert.equal(report.checks.length, 1);
  assert.equal(report.coverage, "no-delivery-observed");
  const file = run("report", task.task_id, "--html").trim();
  assert.match(readFileSync(file, "utf8"), /CLI smoke test/);
  const lesson = JSON.parse(run("report", "--lesson", "con_absent", "--kind", "constraints"));
  assert.equal(lesson.schema, "hunch.lesson-history/1");
  assert.deepEqual(lesson.entries, []);
});

test("retention expires abandoned open reports and closed history, preserving memory and recent tasks", t => {
  const root = fixture(t), store = new HunchStore(hunchPaths(root));
  t.after(() => store.close());
  store.json.ensureDirs();
  store.json.put("constraints", mkConstraint({ id: "con_retained" }));
  const expired = startReportTask(root, "Expired report"), open = startReportTask(root, "Open report"), recent = startReportTask(root, "Recent report");
  const active = startReportTask(root, "Active report");
  finishReportTask(root, expired.task_id); finishReportTask(root, recent.task_id);
  const artifact = writeTaskReportHtml(root, expired.task_id);
  withServedDatabase(root, db => {
    db.prepare("UPDATE report_tasks SET body = json_set(body, '$.finished_at', ?) WHERE task_id = ?").run("2000-01-01T00:00:00.000Z", expired.task_id);
    db.prepare("UPDATE report_tasks SET body = json_set(body, '$.started_at', ?) WHERE task_id = ?").run("2000-01-01T00:00:00.000Z", open.task_id);
  });
  assert.equal(pruneReportHistory(root), 2);
  assert.equal(existsSync(artifact), false);
  assert.throws(() => readTaskReport(root, open.task_id), /not found/);
  assert.equal(readTaskReport(root, active.task_id).task.state, "open");
  assert.equal(readTaskReport(root, recent.task_id).task.state, "completed");
  assert.equal(store.recs("constraints").length, 1);
  assert.throws(() => readTaskReport(root, expired.task_id), /not found/);
});

test("upgrade repair refreshes existing instructions and preserves user settings and prose", t => {
  const root = fixture(t);
  mkdirSync(join(root, ".hunch"));
  mkdirSync(join(root, ".codex"));
  writeFileSync(join(root, ".codex", "config.toml"), '# Custom user preference\n[features]\ncustom_flag = true\n');
  const version = JSON.parse(readFileSync(resolve("package.json"), "utf8")).version;
  writeCodexConfig(root, { command: "npx", args: ["-y", `--package=hunch-exact@npm:@davesheffer/hunch@${version}`, "hunch"] });
  const file = join(root, "AGENTS.md");
  writeFileSync(file, "# User instructions\nKeep this paragraph.\n\n<!-- HUNCH:START — auto-generated, do not edit by hand -->\nOld Hunch instructions\n<!-- HUNCH:END -->\n\nKeep the ending.\n");
  writeFileSync(join(root, ".hunch", "local.json"), JSON.stringify({ customKey: "preserve", reportPresentation: true }));
  const cli = resolve("src/cli/index.ts"), tsx = resolve("node_modules/tsx/dist/loader.mjs");
  const run = (...args: string[]) => execFileSync(process.execPath, ["--import", tsx, cli, ...args], { cwd: root, encoding: "utf8", timeout: 30_000 });
  run("integrations", "repair-pins");
  const upgraded = readFileSync(file, "utf8");
  assert.match(upgraded, /hunch_task/);
  assert.match(upgraded, /Keep this paragraph/); assert.match(upgraded, /Keep the ending/);
  assert.doesNotMatch(upgraded, /Old Hunch instructions/);
  run("integrations", "repair-pins");
  assert.equal(readFileSync(file, "utf8"), upgraded);
  assert.match(readFileSync(join(root, ".codex", "config.toml"), "utf8"), /custom_flag = true/);
  assert.equal(existsSync(join(root, "CLAUDE.md")), false, "repair does not install an unconfigured host");
  run("task", "presentation", "off");
  assert.deepEqual(JSON.parse(readFileSync(join(root, ".hunch", "local.json"), "utf8")), { customKey: "preserve", reportPresentation: false });
  writeFileSync(join(root, ".hunch", "local.json"), "broken-json");
  assert.throws(() => run("task", "presentation", "on"));
  assert.equal(readFileSync(join(root, ".hunch", "local.json"), "utf8"), "broken-json");
});

function commitBaseline(root: string): void {
  execFileSync("git", ["-C", root, "add", "-A"]);
  execFileSync("git", ["-C", root, "-c", "user.name=t", "-c", "user.email=t@example.com", "commit", "-qm", "baseline"]);
}

test("rule evaluation supports an application only when Hunch's own matcher holds on the changed scoped files", async t => {
  const { runReportConformance } = await import("../src/core/taskReportEvidence.js");
  const root = fixture(t), store = new HunchStore(hunchPaths(root));
  t.after(() => store.close());
  store.json.ensureDirs();
  commitBaseline(root);
  const preserve = mkConstraint({ id: "con_preserve", statement: "Preserve existing settings", scope: ["src/config.js"], severity: "blocking", forbids: { deps: ["lodash"], symbols: ["overwriteAll"], patterns: [] } });
  const scopeOnly = mkConstraint({ id: "con_scope_only", statement: "Scope-only rule", scope: ["src/config.js"] });
  const elsewhere = mkConstraint({ id: "con_elsewhere", statement: "Elsewhere", scope: ["src/other/**"], forbids: { deps: ["axios"], symbols: [], patterns: [] } });
  for (const c of [preserve, scopeOnly, elsewhere]) store.json.put("constraints", c);
  const ctx = { target: "src/config.js", constraints: [preserve, scopeOnly, elsewhere], decisions: [], bugs: [], blast_radius: [], components: [], findings: [], budget_tokens: 1500 } as unknown as AssembledContext;
  const delivered = buildDeliveryEnvelope(ctx);
  const snapshots = snapshotDeliveredRecords(store, delivered);
  assert.equal(snapshots.length, 3);
  const task = startReportTask(root, "Preserve settings");
  const occurrence = recordTaskDelivery(root, task.task_id, delivered, snapshots);
  const outcomeOf = (results: ReturnType<typeof runReportConformance>, id: string) => results.find(r => r.record_id === id)!.outcome;

  // Nothing changed: file overlap is absent, and a scope-only rule is never "satisfied".
  const untouched = runReportConformance(root, store, task.task_id);
  assert.equal(outcomeOf(untouched, "con_preserve"), "not-exercised");
  assert.equal(outcomeOf(untouched, "con_elsewhere"), "not-exercised");
  assert.equal(outcomeOf(untouched, "con_scope_only"), "unavailable");
  assert.equal(readTaskReport(root, task.task_id, reportSourceSnapshot(root).hash).conformance.length, 3);

  // A clean edit in scope: the forbids matcher holds and the current source is bound.
  writeFileSync(join(root, "src", "config.js"), "export const preserve = true;\nexport const merge = (a, b) => ({ ...a, ...b });\n");
  const held = runReportConformance(root, store, task.task_id);
  assert.equal(outcomeOf(held, "con_preserve"), "satisfied");
  assert.deepEqual(held.find(r => r.record_id === "con_preserve")!.files, ["src/config.js"]);
  assert.equal(outcomeOf(held, "con_elsewhere"), "not-exercised");
  const snapshot = snapshots.find(s => s.record_id === "con_preserve")!;
  recordReportClaim(root, task.task_id, { occurrence_id: occurrence, record_id: "con_preserve", content_hash: snapshot.content_hash, action: "Used a merge" });
  const plain = snapshots.find(s => s.record_id === "con_scope_only")!;
  recordReportClaim(root, task.task_id, { occurrence_id: occurrence, record_id: "con_scope_only", content_hash: plain.content_hash, action: "Followed the scope-only rule" });
  let report = readTaskReport(root, task.task_id, reportSourceSnapshot(root).hash);
  const supported = report.claims.find(c => c.record_id === "con_preserve")!;
  assert.ok(supported.supported_by, "a current satisfied rule supports the claim");
  assert.equal(supported.attribution, "agent-reported", "support never rewrites the attribution");
  assert.equal(report.claims.find(c => c.record_id === "con_scope_only")!.supported_by, null);
  assert.match(renderTaskReport(report), /Used a merge · rule-supported/);
  assert.doesNotMatch(report.unknowns.join(" "), /contribution to the result is unverified/);
  const html = renderTaskReportHtml(report);
  assert.match(html, /RULE-SUPPORTED · AGENT-REPORTED/);
  assert.match(html, /RULE HELD/);
  assert.match(html, /NO CHECKABLE RULE/);

  // A later edit without re-evaluation invalidates the support; a rule is never current by default.
  writeFileSync(join(root, "src", "config.js"), "export const preserve = true;\nexport const merge = (a, b) => ({ ...a, ...b, later: true });\n");
  report = readTaskReport(root, task.task_id, reportSourceSnapshot(root).hash);
  assert.equal(report.claims.find(c => c.record_id === "con_preserve")!.supported_by, null);
  assert.match(report.unknowns.join(" "), /source has changed since/);
  assert.match(renderTaskReport(report), /Used a merge · agent-reported/);

  // Tripping the matcher is negative evidence, shown on the card and never "supported".
  writeFileSync(join(root, "src", "config.js"), "import _ from \"lodash\";\nexport const preserve = true;\n");
  const broken = runReportConformance(root, store, task.task_id);
  assert.equal(outcomeOf(broken, "con_preserve"), "violated");
  assert.match(broken.find(r => r.record_id === "con_preserve")!.detail, /lodash/);
  report = readTaskReport(root, task.task_id, reportSourceSnapshot(root).hash);
  assert.equal(report.claims.find(c => c.record_id === "con_preserve")!.supported_by, null);
  assert.match(renderTaskReport(report), /^Violated  Preserve existing settings · rule broken/m);
  assert.match(report.unknowns.join(" "), /violate a delivered lesson/);

  // A changed stored revision is not the delivered revision; its rule is not borrowed.
  store.json.put("constraints", { ...preserve, statement: "Changed after delivery" });
  assert.equal(outcomeOf(runReportConformance(root, store, task.task_id), "con_preserve"), "unavailable");
  const remembered = readTaskReport(root, task.task_id, reportSourceSnapshot(root).hash);
  assert.equal(remembered.conformance.length, 12);
  assert.match(renderTaskReport(remembered), /agent-reported/);
  assert.doesNotMatch(renderTaskReport(remembered), /Violated/);
  finishReportTask(root, task.task_id);
  assert.throws(() => runReportConformance(root, store, task.task_id), /closed task/);
  const exported = JSON.stringify(publicTaskReport(root, task.task_id));
  assert.doesNotMatch(exported, /local-rule-check|Used a merge/);
});

test("decision predicates are evaluated only when a subject is defined in a changed file", async t => {
  const { runReportConformance } = await import("../src/core/taskReportEvidence.js");
  const root = fixture(t), store = new HunchStore(hunchPaths(root));
  t.after(() => store.close());
  store.json.ensureDirs();
  writeFileSync(join(root, "src", "pay.js"), "import { verifySession } from './session.js';\nexport function pay(order) {\n  verifySession(order.session);\n  return order.total;\n}\n");
  writeFileSync(join(root, "src", "session.js"), "export function verifySession(session) {\n  return Boolean(session);\n}\n");
  commitBaseline(root);
  const decision = { id: "dec_pay", title: "Payments verify the session", topic: null, status: "accepted", context: "", decision: "pay must call verifySession before charging.", consequences: [], alternatives_rejected: [], rejected_tripwires: [], related_components: [], related_files: ["src/pay.js"], supersedes: null, superseded_by: null, caused_by_bug: null, commit: null, valid_from: "2026-09-11T00:00:00.000Z", valid_to: null, retired: { symbols: [], deps: [] }, conformance: [{ assert: "calls", subject: "pay", object: "verifySession", transitive: false }], provenance: { source: "human_confirmed", confidence: 1, evidence: [] }, date: "2026-09-11" };
  store.json.put("decisions", decision as never);
  const bare = { ...decision, id: "dec_bare", title: "No predicate", conformance: undefined };
  store.json.put("decisions", bare as never);
  const ctx = { target: "src/pay.js", constraints: [], decisions: store.recs("decisions"), bugs: [], blast_radius: [], components: [], findings: [], budget_tokens: 1500 } as unknown as AssembledContext;
  const delivered = buildDeliveryEnvelope(ctx);
  const snapshots = snapshotDeliveredRecords(store, delivered);
  assert.equal(snapshots.length, 2);
  const task = startReportTask(root, "Change payment flow");
  recordTaskDelivery(root, task.task_id, delivered, snapshots);
  const outcomeOf = (results: ReturnType<typeof runReportConformance>, id: string) => results.find(r => r.record_id === id)!;

  writeFileSync(join(root, "src", "config.js"), "export const preserve = false;\n");
  const unrelated = runReportConformance(root, store, task.task_id);
  assert.equal(outcomeOf(unrelated, "dec_pay").outcome, "not-exercised");
  assert.equal(outcomeOf(unrelated, "dec_bare").outcome, "unavailable");

  writeFileSync(join(root, "src", "pay.js"), "import { verifySession } from './session.js';\nexport function pay(order) {\n  verifySession(order.session);\n  return order.total + order.tax;\n}\n");
  const kept = outcomeOf(runReportConformance(root, store, task.task_id), "dec_pay");
  assert.equal(kept.outcome, "satisfied", kept.detail);
  assert.deepEqual(kept.files, ["src/pay.js"]);
  assert.ok(kept.snapshot);
  assert.match(renderTaskReport(readTaskReport(root, task.task_id, reportSourceSnapshot(root).hash)), /^Conformed Payments verify the session · rule held on 1 changed file/m);

  writeFileSync(join(root, "src", "pay.js"), "export function pay(order) {\n  return order.total + order.tax;\n}\n");
  const drifted = outcomeOf(runReportConformance(root, store, task.task_id), "dec_pay");
  assert.equal(drifted.outcome, "violated", drifted.detail);
  assert.match(renderTaskReport(readTaskReport(root, task.task_id, reportSourceSnapshot(root).hash)), /Violated  Payments verify the session/);
});
