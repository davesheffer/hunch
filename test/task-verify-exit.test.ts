import { cleanupDir } from "./fixtures.js";
import { test } from "node:test";
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { mkdtempSync, mkdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { startReportTask } from "../src/core/taskReport.js";
import { runReportCheck } from "../src/core/taskReportEvidence.js";

function fixture(t: { after: (f: () => void) => void }): string {
  const root = mkdtempSync(join(tmpdir(), "hunch-task-verify-exit-"));
  t.after(() => cleanupDir(root));
  execFileSync("git", ["init", "-q", root]);
  mkdirSync(join(root, "src"));
  writeFileSync(join(root, ".gitignore"), ".hunch/\n.hunch-cache/\n");
  writeFileSync(join(root, "src", "config.js"), "export const preserve = true;\n");
  return root;
}

// A command that starts a helper inheriting stdout and then exits is the whole of
// #304: `close` only fires once the helper releases the pipes.
const linger = (exitCode: number) =>
  "const c=require('node:child_process').spawn(process.execPath,['-e','setTimeout(()=>{}, 8000)'],{stdio:['ignore','inherit','inherit'],detached:true});c.unref();"
  + `process.stdout.write('helper-pid '+c.pid+'\\n');process.stdout.write('tests passed\\n');process.exit(${exitCode});`;

function reapHelpers(t: { after: (f: () => void) => void }, pids: number[]) {
  t.after(() => { for (const pid of pids) { try { process.kill(pid, "SIGKILL"); } catch { /* already gone */ } } });
}

test("a passing command that leaves a helper holding stdout settles on its own exit, not on the pipes closing", async t => {
  const root = fixture(t), task = startReportTask(root, "Command that leaves a helper");
  const pids: number[] = [];
  reapHelpers(t, pids);
  let out = "";
  const start = Date.now();
  const result = await runReportCheck(root, task.task_id, [process.execPath, "-e", linger(0)], "Lingering helper", 6_000, {
    onStdout: chunk => { out += chunk.toString("utf8"); const m = /helper-pid (\d+)/.exec(out); if (m) pids[0] = Number(m[1]); },
  });
  assert.equal(result.exit_code, 0, "a command that exited 0 is a pass, whatever its helper still holds");
  assert.equal(result.timed_out, false);
  assert.ok(Date.now() - start < 3_000, `settled in ${Date.now() - start}ms; must not wait for the helper's pipes`);
  assert.match(out, /tests passed/, "output written right before exit is still delivered");
});

test("a non-zero exit with a lingering helper records that exit code, never null", async t => {
  const root = fixture(t), task = startReportTask(root, "Failing command with a helper");
  const pids: number[] = [];
  reapHelpers(t, pids);
  let out = "";
  const result = await runReportCheck(root, task.task_id, [process.execPath, "-e", linger(3)], "Lingering helper fails", 6_000, {
    onStdout: chunk => { out += chunk.toString("utf8"); const m = /helper-pid (\d+)/.exec(out); if (m) pids[0] = Number(m[1]); },
  });
  assert.equal(result.exit_code, 3);
  assert.equal(result.timed_out, false);
});

test("output written right before exit is fully hashed, identically across runs", async t => {
  const root = fixture(t), task = startReportTask(root, "Hash output written at exit");
  const script = "process.stdout.write('x'.repeat(100_000)+'\\n');process.exit(0)";
  const command = [process.execPath, "-e", script];
  const first = await runReportCheck(root, task.task_id, command, "Bulk output A", 10_000);
  const second = await runReportCheck(root, task.task_id, command, "Bulk output B", 10_000);
  assert.equal(first.exit_code, 0);
  assert.equal(second.exit_code, 0);
  assert.equal(first.output_hash, second.output_hash, "the exit path must not truncate buffered output");
});

test("a command that outlives its budget is still recorded as a timeout with no exit code", async t => {
  const root = fixture(t), task = startReportTask(root, "Timed-out command");
  const start = Date.now();
  const result = await runReportCheck(root, task.task_id, [process.execPath, "-e", "setTimeout(()=>{}, 10_000)"], "Sleeper", 500);
  assert.equal(result.exit_code, null);
  assert.equal(result.timed_out, true);
  assert.ok(Date.now() - start < 5_000, "the timeout path must still bound settlement");
});
