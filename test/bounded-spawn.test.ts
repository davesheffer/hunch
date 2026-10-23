import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, readFileSync, existsSync, rmSync, openSync, closeSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { spawn } from "node:child_process";
import { pathToFileURL } from "node:url";
import { boundedSpawn, boundedExecFileSync, __setPsFileForTests, type BoundedExecError } from "../src/core/boundedSpawn.js";

// Issues #489 / #498: a timed-out child must take its whole tree with it.

const IS_WIN = process.platform === "win32";
const projectRoot = join(import.meta.dirname, "..");
const moduleUrl = pathToFileURL(join(projectRoot, "src/core/boundedSpawn.ts")).href;

const alive = (pid: number): boolean => { try { process.kill(pid, 0); return true; } catch { return false; } };
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

/** A parent that spawns a long-sleeping grandchild (recording its pid) and then
 *  hangs itself — the shape of cmd.exe -> claude, or git -> git-remote-https. */
function treeScript(pidFile: string): string {
  return `
const { spawn } = require("node:child_process");
const fs = require("node:fs");
const g = spawn(process.execPath, ["-e", "setTimeout(() => {}, 60000)"], { stdio: "ignore" });
fs.writeFileSync(${JSON.stringify(pidFile)}, String(g.pid));
process.stdout.write("started\\n");
setTimeout(() => {}, 60000);
`;
}

async function waitForPid(pidFile: string): Promise<number> {
  const deadline = Date.now() + 5_000;
  while (!existsSync(pidFile) && Date.now() < deadline) await sleep(25);
  const pid = Number(readFileSync(pidFile, "utf8"));
  assert.ok(pid > 0, "grandchild pid recorded");
  return pid;
}

async function assertDead(pid: number): Promise<void> {
  const deadline = Date.now() + 5_000;
  while (alive(pid) && Date.now() < deadline) await sleep(50);
  const survived = alive(pid);
  if (survived) { try { process.kill(pid, "SIGKILL"); } catch { /* gone */ } }
  assert.equal(survived, false, "the grandchild survived the timeout");
}

function tempDir(t: { after: (fn: () => void) => void }): string {
  const dir = mkdtempSync(join(tmpdir(), "hunch-bounded-spawn-"));
  t.after(() => rmSync(dir, { recursive: true, force: true }));
  return dir;
}

const activeTimeouts = (): number => process.getActiveResourcesInfo().filter((r) => r === "Timeout").length;

test("boundedSpawn: normal exit returns output and clears its timer", async () => {
  const before = activeTimeouts();
  const started = Date.now();
  const r = await boundedSpawn(process.execPath, ["-e", "process.stdin.pipe(process.stdout)"], { input: "hello", timeoutMs: 60_000 });
  assert.equal(r.status, 0);
  assert.equal(r.stdout, "hello");
  assert.equal(r.timedOut, false);
  assert.ok(Date.now() - started < 30_000);
  assert.equal(activeTimeouts(), before, "the supervisor timer was cleared");
});

test("boundedSpawn: non-zero exit reports status and stderr", async () => {
  const r = await boundedSpawn(process.execPath, ["-e", "process.stderr.write('boom'); process.exit(3)"], { timeoutMs: 30_000 });
  assert.equal(r.status, 3);
  assert.equal(r.stderr, "boom");
  assert.equal(r.timedOut, false);
});

test("boundedSpawn: timeout kills the whole tree and resolves as timed out", { timeout: 30_000 }, async (t) => {
  const pidFile = join(tempDir(t), "grandchild.pid");
  const before = activeTimeouts();
  const started = Date.now();
  const r = await boundedSpawn(process.execPath, ["-e", treeScript(pidFile)], { timeoutMs: 1_000 });
  assert.equal(r.timedOut, true);
  assert.equal(r.status, null);
  if (!IS_WIN) assert.equal(r.signal, "SIGTERM", "a tree that honours SIGTERM is never SIGKILLed");
  assert.ok(Date.now() - started < 15_000, "resolved promptly after the deadline");
  assert.equal(activeTimeouts(), before, "no supervisor timer left behind");
  await assertDead(await waitForPid(pidFile));
});

// Without a working ps (busybox, no procps) Linux walks /proc/*/stat instead;
// anywhere else the root is still killed and the call still resolves.
test("boundedSpawn: a missing ps falls back to /proc on Linux, else still kills the root", { skip: IS_WIN && "taskkill walks the tree", timeout: 30_000 }, async (t) => {
  const pidFile = join(tempDir(t), "grandchild.pid");
  const started = Date.now();
  __setPsFileForTests("/nonexistent/hunch-no-ps");
  t.after(() => __setPsFileForTests(null));
  const r = await boundedSpawn(process.execPath, ["-e", treeScript(pidFile)], { timeoutMs: 1_000, killGraceMs: 300 });
  assert.equal(r.timedOut, true);
  assert.equal(r.status, null);
  assert.ok(Date.now() - started < 15_000, "resolved promptly after the deadline");
  const grandchild = await waitForPid(pidFile);
  if (process.platform === "linux") await assertDead(grandchild);
  else try { process.kill(grandchild, "SIGKILL"); } catch { /* gone */ }
});

// A survivor whose parent died on SIGTERM is reparented (to pid 1 or a
// subreaper); the SIGKILL re-walk must still reach what it spawned in the grace.
test("boundedSpawn: the SIGKILL re-walk reaches children of a reparented survivor", { skip: IS_WIN && "taskkill walks the tree", timeout: 30_000 }, async (t) => {
  const qFile = join(tempDir(t), "q.pid");
  // P ignores SIGTERM and, on SIGTERM, spawns Q; the middle process exits on SIGTERM.
  const p = `const { spawn } = require("node:child_process"); const fs = require("node:fs");
process.on("SIGTERM", () => { const q = spawn(process.execPath, ["-e", "setTimeout(() => {}, 60000)"], { stdio: "ignore" }); fs.writeFileSync(${JSON.stringify(qFile)}, String(q.pid)); });
setInterval(() => {}, 1000);`;
  const middle = `const { spawn } = require("node:child_process");
spawn(process.execPath, ["-e", ${JSON.stringify(p)}], { stdio: "ignore" });
setInterval(() => {}, 1000);`;
  const r = await boundedSpawn(process.execPath, ["-e", middle], { timeoutMs: 1_500, killGraceMs: 800 });
  assert.equal(r.timedOut, true);
  assert.equal(r.signal, "SIGKILL", "P ignored SIGTERM, so the tree was SIGKILLed");
  await assertDead(await waitForPid(qFile));
});

test("boundedSpawn: spawn failure resolves with an error, not a throw", async () => {
  const r = await boundedSpawn("hunch-definitely-not-a-real-binary", [], { timeoutMs: 5_000 });
  assert.ok(r.error);
  assert.equal(r.timedOut, false);
});

test("boundedExecFileSync: normal exit returns stdout", () => {
  const out = boundedExecFileSync(process.execPath, ["-e", "process.stdout.write('ok')"], { timeout: 30_000 });
  assert.equal(out, "ok");
});

test("boundedExecFileSync: non-zero exit throws with status and stderr", () => {
  assert.throws(
    () => boundedExecFileSync(process.execPath, ["-e", "process.stderr.write('bad'); process.exit(2)"], { timeout: 30_000 }),
    (e: BoundedExecError) => e.status === 2 && e.stderr === "bad" && e.code === undefined,
  );
});

test("boundedExecFileSync: timeout kills the whole tree and throws ETIMEDOUT", { timeout: 30_000 }, async (t) => {
  const pidFile = join(tempDir(t), "grandchild.pid");
  const started = Date.now();
  assert.throws(
    () => boundedExecFileSync(process.execPath, ["-e", treeScript(pidFile)], { timeout: 1_000 }),
    (e: BoundedExecError) => e.code === "ETIMEDOUT" && e.stdout === "started\n",
  );
  assert.ok(Date.now() - started < 15_000, "returned promptly after the deadline");
  await assertDead(await waitForPid(pidFile));
});

test("boundedExecFileSync: stdout can go straight to a file descriptor", (t) => {
  const file = join(tempDir(t), "out.txt");
  const fd = openSync(file, "w+");
  try {
    const out = boundedExecFileSync(process.execPath, ["-e", "process.stdout.write('to-file')"], { timeout: 30_000, stdout: fd });
    assert.equal(out, "");
  } finally { closeSync(fd); }
  assert.equal(readFileSync(file, "utf8"), "to-file");
});

test("boundedExecFileSync: overflowing maxBuffer kills the child and throws ENOBUFS", () => {
  assert.throws(
    () => boundedExecFileSync(process.execPath, ["-e", "process.stdout.write('x'.repeat(100000)); setTimeout(() => {}, 60000)"], { timeout: 30_000, maxBuffer: 1_000 }),
    (e: BoundedExecError) => e.code === "ENOBUFS",
  );
});

test("boundedExecFileSync: a missing binary throws ENOENT", () => {
  assert.throws(
    () => boundedExecFileSync("hunch-definitely-not-a-real-binary", [], { timeout: 5_000 }),
    (e: BoundedExecError) => e.code === "ENOENT",
  );
});

/** A child that traps SIGTERM to clean up (like git removing its lock files). */
function trapScript(marker: string, ready: string, honour: boolean): string {
  return `
const fs = require("node:fs");
process.on("SIGTERM", () => { fs.writeFileSync(${JSON.stringify(marker)}, "term"); ${honour ? "process.exit(0);" : ""} });
fs.writeFileSync(${JSON.stringify(ready)}, "1");
setTimeout(() => {}, 60000);
`;
}

test("boundedSpawn: timeout sends SIGTERM first so the child can clean up", { skip: IS_WIN && "taskkill /F has no graceful step", timeout: 30_000 }, async (t) => {
  const dir = tempDir(t);
  const marker = join(dir, "term"), ready = join(dir, "ready");
  const r = await boundedSpawn(process.execPath, ["-e", trapScript(marker, ready, true)], { timeoutMs: 1_500 });
  assert.ok(existsSync(ready), "child installed its SIGTERM handler before the deadline");
  assert.equal(r.timedOut, true);
  assert.equal(r.signal, "SIGTERM");
  assert.equal(readFileSync(marker, "utf8"), "term", "the child saw SIGTERM and cleaned up");
});

test("boundedExecFileSync: a child that ignores SIGTERM gets it, then SIGKILL after the grace", { skip: IS_WIN && "taskkill /F has no graceful step", timeout: 30_000 }, (t) => {
  const dir = tempDir(t);
  const marker = join(dir, "term"), ready = join(dir, "ready");
  assert.throws(
    () => boundedExecFileSync(process.execPath, ["-e", trapScript(marker, ready, false)], { timeout: 1_500, killGraceMs: 300 }),
    (e: BoundedExecError) => e.code === "ETIMEDOUT" && e.signal === "SIGKILL",
  );
  assert.ok(existsSync(ready), "child installed its SIGTERM handler before the deadline");
  assert.equal(readFileSync(marker, "utf8"), "term", "SIGTERM was delivered before SIGKILL");
});

/** Ctrl-C reaches the whole foreground process group. A driver (standing in for
 *  hunch) runs the tree under the bounded helper with a long deadline; SIGINT to
 *  the driver's group must take the bounded child down with it. */
for (const mode of ["async", "sync"] as const) {
  test(`bounded ${mode}: Ctrl-C (SIGINT to the process group) still reaches the child`, { skip: IS_WIN && "no POSIX process groups", timeout: 30_000 }, async (t) => {
    const pidFile = join(tempDir(t), "grandchild.pid");
    const call = mode === "async"
      ? `await m.boundedSpawn(process.execPath, ["-e", ${JSON.stringify(treeScript(pidFile))}], { timeoutMs: 60000 });`
      : `m.boundedExecFileSync(process.execPath, ["-e", ${JSON.stringify(treeScript(pidFile))}], { timeout: 60000 });`;
    const driver = spawn(process.execPath, ["--import", "tsx", "--input-type=module", "--eval", `const m = await import(${JSON.stringify(moduleUrl)}); ${call}`], {
      cwd: projectRoot, stdio: "ignore", detached: true,
    });
    t.after(() => { try { process.kill(-driver.pid!, "SIGKILL"); } catch { /* gone */ } });
    const grandchild = await waitForPid(pidFile);
    process.kill(-driver.pid!, "SIGINT");
    await assertDead(grandchild);
  });
}
