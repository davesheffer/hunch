// PILOT5 hidden validator for davesheffer/hunch#394 (self-contained card).
// Derived from the fix's regression test ("card keeps a failed command visible
// until that exact command succeeds") and adapted to accept any correct fix:
// it uses only APIs present at the starting commit, does not require the fix's
// exact "Failures ..." wording, and reruns with the same argv AND label, so a
// fix keyed by either identity passes.
import { test } from "node:test";
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { mkdtempSync, mkdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { readTaskReport, startReportTask } from "../src/core/taskReport.js";
import { reportSourceSnapshot, runReportCheck } from "../src/core/taskReportEvidence.js";
import { renderTaskReport } from "../src/core/taskReportRender.js";

function fixture(t: { after: (f: () => void) => void }): string {
  const root = mkdtempSync(join(tmpdir(), "pilot5-394-"));
  t.after(() => rmSync(root, { recursive: true, force: true, maxRetries: 10, retryDelay: 200 }));
  execFileSync("git", ["init", "-q", root]);
  mkdirSync(join(root, "src"));
  writeFileSync(join(root, ".gitignore"), ".hunch/\n.hunch-cache/\n");
  writeFileSync(join(root, "src", "config.js"), "export const preserve = true;\n");
  return root;
}
const showsFailure = (card: string) => /\bfail(?:ed|ure|ures|ing)?\b|\bunresolved\b/i.test(card);
// Outstanding = a positive failure count, or a line saying "failed" that is not
// marked superseded. "0 failed" and "failed (superseded)" are not outstanding.
const showsOutstandingFailure = (card: string) =>
  /\b[1-9]\d*\s+(?:unresolved|failed|failures?)\b/i.test(card) ||
  card.split(/\r?\n/).some(line => /\bfailed\b/i.test(line.replace(/\b0\s+failed\b/gi, "")) && !/\bsuperseded\b/i.test(line));

test("#394: a later unrelated passing check does not hide an unresolved failure on the card", async t => {
  const root = fixture(t), task = startReportTask(root, "Independent checks");
  const failing = [process.execPath, "-e", "process.exit(require('node:fs').existsSync('.hunch-cache/pass') ? 0 : 7)"];
  await runReportCheck(root, task.task_id, failing, "Integration tests");
  await runReportCheck(root, task.task_id, [process.execPath, "-e", "process.exit(0)"], "Lint");
  const card = () => renderTaskReport(readTaskReport(root, task.task_id, reportSourceSnapshot(root).hash));
  assert.ok(showsFailure(card()), `fail-A/pass-B: the card must still show the unresolved failure:\n${card()}`);
  writeFileSync(join(root, "src/config.js"), "changed source\n");
  assert.ok(showsFailure(card()), `stale source: a source edit is not a successful rerun:\n${card()}`);
  mkdirSync(join(root, ".hunch-cache"), { recursive: true });
  writeFileSync(join(root, ".hunch-cache/pass"), "pass");
  await runReportCheck(root, task.task_id, failing, "Integration tests");
  assert.ok(!showsOutstandingFailure(card()), `fail-A/pass-A: a successful rerun of the same check clears it:\n${card()}`);
  assert.equal(readTaskReport(root, task.task_id).checks.length, 3, "the evidence view retains the original failure");
});
