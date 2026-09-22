import { cleanupDir } from "./fixtures.js";
/** The ledger is shared by hooks, MCP and verification runners at once. Reads
 * must not take the writer lock, and a verification result that took minutes to
 * produce must not be dropped because a writer held the ledger for a moment. */
import { test } from "node:test";
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { existsSync, mkdtempSync, mkdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createRequire } from "node:module";
import { Worker } from "node:worker_threads";
import { beginReportCheck, finishReportTask, readTaskReport, recordReportCheck, reportHash, resolveReportTask, startReportTask, type ReportCheck } from "../src/core/taskReport.js";

const { DatabaseSync } = createRequire(import.meta.url)("node:sqlite") as typeof import("node:sqlite");

function fixture(t: { after: (f: () => void) => void }): string {
  const root = mkdtempSync(join(tmpdir(), "hunch-report-lock-"));
  t.after(() => cleanupDir(root));
  execFileSync("git", ["init", "-q", root]);
  mkdirSync(join(root, "src"));
  writeFileSync(join(root, ".gitignore"), ".hunch/\n.hunch-cache/\n");
  return root;
}
const ledger = (root: string) => join(root, ".hunch-cache", "served.db");
function check(checkId: string): ReportCheck {
  return { check_id: checkId, label: "typecheck", command: ["node", "-e", "0"], exit_code: 0,
    output_hash: reportHash("output"), before_snapshot: reportHash("before"), after_snapshot: reportHash("after"),
    snapshot_limitations: [], timed_out: false, source: "local-command-runner" };
}

test("the ledger stays in rollback mode so reads leave no sibling files for watchers", t => {
  const root = fixture(t);
  const task = startReportTask(root, "Rollback task");
  readTaskReport(root, task.task_id);
  // A -wal/-shm appearing and vanishing on every open is a ledger change to any
  // watcher on `.hunch-cache/served.db*`, which reads then re-trigger.
  assert.equal(existsSync(`${ledger(root)}-wal`), false);
  assert.equal(existsSync(`${ledger(root)}-shm`), false);
  const db = new DatabaseSync(ledger(root));
  try {
    const { journal_mode: mode } = db.prepare("PRAGMA journal_mode").get() as { journal_mode: string };
    assert.equal(mode.toLowerCase(), "delete");
  } finally { db.close(); }
});

test("a pure read never waits on a writer holding the ledger", t => {
  const root = fixture(t);
  const task = startReportTask(root, "Reading task");
  const holder = new DatabaseSync(ledger(root));
  holder.exec("PRAGMA busy_timeout = 100");
  holder.exec("BEGIN IMMEDIATE");
  try {
    // BEGIN IMMEDIATE takes RESERVED, which still admits readers.
    assert.equal(resolveReportTask(root, task.task_id), task.task_id);
    assert.equal(readTaskReport(root, task.task_id).task.task_id, task.task_id);
  } finally {
    holder.exec("ROLLBACK");
    holder.close();
  }
});

/** A plain-JS holder: opens the ledger, takes the writer lock and holds it until
 * the main thread signals, then `holdAfterSignalMs` longer — so no fixed sleep can
 * expire early on a loaded CI box. No sleep binding, shell or signal (Windows-safe). */
const HOLDER = `
const { DatabaseSync } = require("node:sqlite");
const { workerData, parentPort } = require("node:worker_threads");
const db = new DatabaseSync(workerData.path);
db.exec("BEGIN IMMEDIATE");
parentPort.postMessage("locked");
Atomics.wait(workerData.flag, 0, 0, 30000);
Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, workerData.holdAfterSignalMs);
db.exec("COMMIT");
db.close();
parentPort.postMessage("released");
`;
/** Starts the holder and resolves once it actually owns the writer lock. */
async function holdLedger(root: string, holdAfterSignalMs: number) {
  const flag = new Int32Array(new SharedArrayBuffer(4));
  const worker = new Worker(HOLDER, { eval: true, workerData: { path: ledger(root), flag, holdAfterSignalMs } });
  const exited = new Promise<void>(resolve => worker.on("exit", () => resolve()));
  await new Promise<void>(resolve => worker.once("message", () => resolve()));
  return { exited, release: () => { Atomics.store(flag, 0, 1); Atomics.notify(flag, 0); } };
}

test("an explicit verification result waits out a competing writer; a passive close still fails fast", async t => {
  const root = fixture(t);
  const task = startReportTask(root, "Verified task");
  const passive = startReportTask(root, "Passive task");
  const checkId = beginReportCheck(root, task.task_id, "typecheck");
  const { exited, release } = await holdLedger(root, 800);
  try {
    const started = Date.now();
    assert.throws(() => finishReportTask(root, passive.task_id, "completed", { by: "host" }), /locked/i);
    // The lock is held until we signal, so a stalled main thread cannot let this
    // write succeed; the bound only says the passive path did not wait patiently.
    assert.ok(Date.now() - started < 2000, "a passive write must never cost a delivery the writer's hold");
    release();
    recordReportCheck(root, task.task_id, check(checkId));
  } finally { await exited; }
  const [recorded] = readTaskReport(root, task.task_id).checks;
  assert.equal(recorded?.check_id, checkId);
  assert.equal(recorded?.exit_code, 0);
});

test("a verification result outlasting one patient wait is retried, not lost", { timeout: 30_000 }, async t => {
  const root = fixture(t);
  const task = startReportTask(root, "Long-held task");
  const checkId = beginReportCheck(root, task.task_id, "typecheck");
  // Longer than one patient wait: attempt 1 must expire, so only a retry can write.
  const { exited, release } = await holdLedger(root, 5_600);
  try {
    release();
    const signalled = Date.now();
    const started = Date.now();
    recordReportCheck(root, task.task_id, check(checkId));
    const elapsed = Date.now() - started;
    // Only a prompt call proves the retry: a stall between signal and call would
    // let the hold expire on its own, making a single attempt enough.
    if (started - signalled < 500) assert.ok(elapsed >= 5_000, `the first attempt must expire before the retry writes (elapsed ${elapsed}ms)`);
  } finally { await exited; }
  const [recorded] = readTaskReport(root, task.task_id).checks;
  assert.equal(recorded?.check_id, checkId);
  assert.equal(recorded?.exit_code, 0);
});
