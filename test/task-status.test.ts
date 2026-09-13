import { test } from "node:test";
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { mkdtempSync, mkdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { buildDeliveryEnvelope } from "../src/core/delivery.js";
import type { AssembledContext } from "../src/store/hunchStore.js";
import { isEmptyTaskReport, listTaskSummaries, readTaskReport, recordTaskDelivery, renderTaskStatusLine, reportHash, startReportTask, summarizeTaskReport } from "../src/core/taskReport.js";
import { promptTaskId } from "../src/core/taskReportHook.js";
import { reportSourceSnapshot } from "../src/core/taskReportEvidence.js";

const cli = resolve("src/cli/index.ts");
function fixture(t: { after: (f: () => void) => void }): string {
  const root = mkdtempSync(join(tmpdir(), "hunch-task-status-"));
  t.after(() => rmSync(root, { recursive: true, force: true }));
  execFileSync("git", ["init", "-q", root]);
  mkdirSync(join(root, ".hunch"));
  writeFileSync(join(root, ".gitignore"), ".hunch-cache/\n");
  return root;
}
function run(root: string, args: string[], input = ""): string {
  return execFileSync(process.execPath, ["--import", import.meta.resolve("tsx"), cli, ...args], { cwd: root, encoding: "utf8", input }).trim();
}
function deliver(root: string, taskId: string): void {
  const ctx = { target: "src/config.js", constraints: [{ id: "con_preserve", type: "architecture", statement: "Preserve existing settings", scope: ["src/config.js"], severity: "blocking", enforcement: "advisory_v1", match: null, forbids: null, rationale: "", source_decision: null, violations: [], status: "active", valid_to: null, provenance: { source: "human_confirmed", confidence: 1, evidence: [], last_verified: "2026-01-01T00:00:00.000Z" } }], decisions: [], bugs: [], blast_radius: [], components: [], findings: [], budget_tokens: 1500 } as unknown as AssembledContext;
  const record = { record_id: "con_preserve", kind: "constraints" as const, title: "Preserve existing settings", lesson: "Merge settings.", content_hash: reportHash("r"), recorded_at: null };
  recordTaskDelivery(root, taskId, buildDeliveryEnvelope(ctx), [record]);
}

test("an untouched task is empty, summarized as such, and renders no status line", t => {
  const root = fixture(t);
  const task = startReportTask(root, "Quiet prompt");
  assert.equal(isEmptyTaskReport(readTaskReport(root, task.task_id)), true);
  const summary = summarizeTaskReport(root, task.task_id);
  assert.equal(summary.empty, true);
  assert.equal(summary.check, null);
  assert.equal(renderTaskStatusLine(summary), "", "a bare prompt adds no Hunch noise to the status line");
  assert.equal(renderTaskStatusLine(null), "");
  assert.equal(run(root, ["task", "status"]), "", "CLI prints nothing for an empty task");
});

test("a delivery or a check makes the task non-empty and shows up in the status line, the list, and the JSON", t => {
  const root = fixture(t);
  const task = startReportTask(root, "Grounded prompt");
  deliver(root, task.task_id);
  run(root, ["task", "verify", task.task_id, "--json", "--", process.execPath, "-e", "process.exit(0)"]);
  assert.match(renderTaskStatusLine(summarizeTaskReport(root, task.task_id)), /passed \(source changed\)$/, "without a current snapshot the check's currency is unknown, and the line says so");
  const summary = summarizeTaskReport(root, task.task_id, reportSourceSnapshot(root).hash);
  assert.equal(summary.empty, false);
  assert.equal(summary.lessons, 1);
  assert.equal(summary.check?.state, "passed");
  const line = renderTaskStatusLine(summary);
  assert.match(line, /^Hunch · 1 lesson recalled · Verification command: passed$/);
  assert.equal(run(root, ["task", "status"]), line, "without host JSON the most recent task is used");
  const list = JSON.parse(run(root, ["task", "list", "--json"])) as Array<{ task: { task_id: string }; empty: boolean }>;
  assert.deepEqual(list.map(s => [s.task.task_id, s.empty]), [[task.task_id, false]]);
  assert.match(run(root, ["task", "list"]), new RegExp(`${task.task_id}.*1 lesson recalled`));
  assert.deepEqual(listTaskSummaries(root).map(s => s.task.task_id), [task.task_id]);
});

test("status line JSON from Claude Code names the exact prompt task, never the most recent one", t => {
  const root = fixture(t);
  const other = startReportTask(root, "Someone else's prompt");
  deliver(root, other.task_id);
  const mine = startReportTask(root, "Claude task", promptTaskId(root, "session-a", "prompt-a"));
  const host = JSON.stringify({ cwd: root, workspace: { current_dir: root }, session_id: "session-a", prompt_id: "prompt-a" });
  assert.equal(run(root, ["task", "status"], host), "", "my prompt has no observation yet, so nothing is shown even though another task has");
  deliver(root, mine.task_id);
  assert.match(run(root, ["task", "status"], host), /^Hunch · 1 lesson recalled · no check recorded$/);
  const json = JSON.parse(run(root, ["task", "status", "--json"], host)) as { task: { task_id: string } };
  assert.equal(json.task.task_id, mine.task_id);
  assert.equal(run(root, ["task", "status"], "{not json"), "Hunch · 1 lesson recalled · no check recorded", "a malformed host payload falls back to the most recent task");
  assert.equal(run(root, ["task", "status", "--json"], JSON.stringify({ session_id: "s", prompt_id: "never-started", cwd: root })), "null", "an unknown prompt task is null, not an error");
});
