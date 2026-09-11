import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { execFileSync } from "node:child_process";
import { createTaskReporter } from "../src/taskReports.js";

// No model or provider SDK is involved: the harness controls the lifecycle and
// receives display data even if its agent never calls Hunch.
test("generic harness owns reporting, separates retries/attempts, and shows missing evidence", async t => {
  const root = mkdtempSync(join(tmpdir(), "hunch-harness-report-"));
  t.after(() => rmSync(root, { recursive: true, force: true }));
  execFileSync("git", ["init", "-q", root]);
  writeFileSync(join(root, ".gitignore"), ".hunch-cache/\n");
  const host = createTaskReporter(root);
  const identity = { task: "caller-owned-task", attempt: "attempt-1" };
  const task = host.start("Check project", identity);
  assert.equal(host.start("Check project", identity).task_id, task.task_id);
  const retry = host.start("Check project", { ...identity, attempt: "attempt-2" });
  assert.notEqual(retry.task_id, task.task_id);
  await host.verify(task.task_id, [process.execPath, "-e", "process.exit(1)"], "Failing check");
  const finished = host.finish(task.task_id);
  assert.match(finished.contribution_card!, /No task-linked delivery observed/);
  assert.match(finished.contribution_card!, /failed/);
  assert.equal(finished.report.checks[0]!.exit_code, 1);
  const interrupted = host.finish(retry.task_id, "interrupted");
  assert.match(interrupted.contribution_card!, /interrupted/);
  assert.equal(host.history().length, 2);
  assert.equal(host.lesson({ kind: "constraints", record_id: "con_absent" }).entries.length, 0);
  assert.throws(() => host.start("Check", { task: "", attempt: "1" }));
  assert.match(host.html(task.task_id), /\.html$/);
});
