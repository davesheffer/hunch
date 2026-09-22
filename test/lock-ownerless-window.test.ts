import { cleanupDir } from "./fixtures.js";
import assert from "node:assert/strict";
import { execFileSync, spawn } from "node:child_process";
import { chmodSync, existsSync, mkdirSync, mkdtempSync, readdirSync, rmSync, utimesSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { commitAndPushHunch } from "../src/extractors/git.js";

const g = (cwd: string, ...a: string[]): void => { execFileSync("git", a, { cwd, stdio: ["ignore", "ignore", "ignore"] }); };

/** A plain repo whose .hunch/ is committed in place (push:false), matching the
 *  public-capture path used by the other commit-lock tests. */
function tempRepo(): { root: string; hunchDir: string; lock: string; cleanup: () => void } {
  const root = mkdtempSync(join(tmpdir(), "hunch-ownerless-"));
  g(root, "init", "-q");
  g(root, "config", "user.email", "t@example.com");
  g(root, "config", "user.name", "T");
  g(root, "checkout", "-q", "-b", "main");
  writeFileSync(join(root, "f.txt"), "x");
  g(root, "add", "-A");
  g(root, "commit", "-q", "-m", "init");
  const hunchDir = join(root, ".hunch");
  mkdirSync(join(hunchDir, "decisions"), { recursive: true });
  return {
    root,
    hunchDir,
    lock: join(hunchDir, ".hunch-commit.lock"),
    cleanup: () => cleanupDir(root),
  };
}

function writeDec(hunchDir: string, id: string): void {
  writeFileSync(join(hunchDir, "decisions", `${id}.json`), `${JSON.stringify({ id, title: id })}\n`);
}

async function waitFor(predicate: () => boolean, timeoutMs: number): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (!predicate()) {
    if (Date.now() >= deadline) throw new Error("timed out waiting for the ownerless-lock fixture");
    await new Promise((resolve) => setTimeout(resolve, 10));
  }
}

/** Spawn a helper that holds the lock directory. It waits for `go` before
 *  starting its own timer, so the timed window begins when the parent is about
 *  to call commitAndPushHunch — never before, which would let the parent find
 *  the lock already released and pass the test vacuously. */
function spawnLockHolder(source: string): ReturnType<typeof spawn> {
  return spawn(process.execPath, ["-e", source], { stdio: "ignore" });
}

const HOLDER_PRELUDE = [
  'const fs = require("node:fs");',
  'const path = require("node:path");',
  "const sleep = (ms) => { const wait = new Int32Array(new SharedArrayBuffer(4)); Atomics.wait(wait, 0, 0, ms); };",
  "const waitForMarker = (marker) => { const deadline = Date.now() + 30_000; while (!fs.existsSync(marker)) { if (Date.now() >= deadline) process.exit(91); sleep(5); } };",
].join("\n");

test("a FRESH ownerless lock another process is about to release is waited out, not treated as busy", { timeout: 60_000 }, async () => {
  const { root, hunchDir, lock, cleanup } = tempRepo();
  const ready = join(root, "holder-ready");
  const go = join(root, "parent-about-to-flush");
  let holder: ReturnType<typeof spawn> | null = null;
  try {
    // Another process holds an OWNERLESS lock directory — exactly what a
    // contender sees inside createOwnedCommitLock's two-mkdir window — and
    // releases it ~300 ms after the parent signals it is about to flush. The
    // wait is synchronous (Atomics.wait), so the release must come from a
    // separate process.
    holder = spawnLockHolder([
      HOLDER_PRELUDE,
      `fs.mkdirSync(${JSON.stringify(lock)}, { recursive: true });`,
      `fs.writeFileSync(${JSON.stringify(ready)}, "ready\\n");`,
      `waitForMarker(${JSON.stringify(go)});`,
      // Restart the entry window from the moment the parent is about to flush,
      // so a slow runner cannot age the directory past it before the first stat.
      `fs.utimesSync(${JSON.stringify(lock)}, new Date(), new Date());`,
      "sleep(300);",
      `fs.rmSync(${JSON.stringify(lock)}, { recursive: true, force: true });`,
      "process.exit(0);",
    ].join("\n"));
    await waitFor(() => existsSync(ready), 5_000);

    writeDec(hunchDir, "dec_after_ownerless_window");
    writeFileSync(go, "go\n");
    const startedAt = Date.now();
    const result = commitAndPushHunch(hunchDir, "hunch: wait out the ownerless window", { push: false });
    const elapsed = Date.now() - startedAt;

    assert.equal(result, "committed",
      "a transient ownerless lock must not make the capture's auto-commit silently no-op");
    assert.ok(elapsed >= 150,
      `the lock was genuinely still held when the flush began, so the wait was real (took ${elapsed} ms)`);
    assert.ok(elapsed < 30_000, `the handoff resolved promptly (took ${elapsed} ms)`);
    assert.equal(existsSync(lock), false, "the successor releases the lock it acquired");
    assert.match(execFileSync("git", ["-C", root, "ls-tree", "-r", "--name-only", "HEAD"], { encoding: "utf8" }),
      /\.hunch\/decisions\/dec_after_ownerless_window\.json/);
  } finally {
    if (holder && holder.exitCode === null && holder.signalCode === null) holder.kill("SIGKILL");
    cleanup();
  }
});

test("a STRANDED ownerless lock (aged past the fresh window) still no-ops fast, not after the full handoff", { timeout: 60_000 }, () => {
  const { hunchDir, lock, cleanup } = tempRepo();
  try {
    mkdirSync(lock, { recursive: true });
    // Older than the ownerless-fresh window, far younger than the legacy TTL,
    // so the lock is neither waited for nor reclaimed.
    const aged = new Date(Date.now() - 30_000);
    utimesSync(lock, aged, aged);

    writeDec(hunchDir, "dec_stranded_ownerless");
    const startedAt = Date.now();
    const result = commitAndPushHunch(hunchDir, "hunch: stranded ownerless lock", { push: false });
    const elapsed = Date.now() - startedAt;

    assert.equal(result, null, "a stranded ownerless lock stays a quiet no-op");
    assert.ok(elapsed < 1_500, `and returns immediately rather than blocking the capture (took ${elapsed} ms)`);
    assert.equal(existsSync(lock), true, "the lock directory is left untouched for its TTL");
    assert.deepEqual(readdirSync(lock), [], "no reclaim claim is staged inside it");
  } finally {
    cleanup();
  }
});

test("a fresh ownerless lock that never resolves gives up after the ownerless window, not the full handoff", { timeout: 60_000 }, () => {
  const { hunchDir, lock, cleanup } = tempRepo();
  try {
    mkdirSync(lock, { recursive: true });

    writeDec(hunchDir, "dec_never_resolves");
    const startedAt = Date.now();
    const result = commitAndPushHunch(hunchDir, "hunch: ownerless lock that never resolves", { push: false });
    const elapsed = Date.now() - startedAt;

    assert.equal(result, null, "an ownerless lock that never gains an owner or goes away is a no-op");
    assert.ok(elapsed > 1_500, `after waiting out the continuously-ownerless window (took ${elapsed} ms)`);
    assert.ok(elapsed < 10_000, `and nowhere near the full handoff timeout (took ${elapsed} ms)`);
    assert.equal(existsSync(lock), true, "the lock directory is left for its owner");
  } finally {
    cleanup();
  }
});

test("a live owner appearing during the ownerless window resets the wait and the handoff still completes", { timeout: 60_000 }, async () => {
  const { root, hunchDir, lock, cleanup } = tempRepo();
  const ready = join(root, "holder-ready");
  const go = join(root, "parent-about-to-flush");
  let holder: ReturnType<typeof spawn> | null = null;
  try {
    // Ownerless first, then a LIVE owner (the holder's own pid) for ~3 s —
    // longer than the ownerless window — then release. The contender must not
    // give up at 2 s: a live sighting restarts the continuously-ownerless timer.
    holder = spawnLockHolder([
      HOLDER_PRELUDE,
      `const lock = ${JSON.stringify(lock)};`,
      "fs.mkdirSync(lock, { recursive: true });",
      `fs.writeFileSync(${JSON.stringify(ready)}, "ready\\n");`,
      `waitForMarker(${JSON.stringify(go)});`,
      // Restart the entry window from the moment the parent is about to flush,
      // so a slow runner cannot age the directory past it before the first stat.
      "fs.utimesSync(lock, new Date(), new Date());",
      "sleep(200);",
      "fs.mkdirSync(path.join(lock, `owner-${process.pid}`), { recursive: true });",
      "sleep(3000);",
      "fs.rmSync(lock, { recursive: true, force: true });",
      "process.exit(0);",
    ].join("\n"));
    await waitFor(() => existsSync(ready), 5_000);

    writeDec(hunchDir, "dec_live_owner_resets_window");
    writeFileSync(go, "go\n");
    const startedAt = Date.now();
    const result = commitAndPushHunch(hunchDir, "hunch: live owner resets the ownerless window", { push: false });
    const elapsed = Date.now() - startedAt;

    assert.equal(result, "committed",
      "an owner claiming the lock mid-window is a real handoff, not a stranded lock");
    assert.ok(elapsed > 2_500,
      `the wait outlasted the ownerless window because a live owner reset it (took ${elapsed} ms)`);
    assert.ok(elapsed < 30_000, `and still finished well inside the handoff budget (took ${elapsed} ms)`);
    assert.match(execFileSync("git", ["-C", root, "ls-tree", "-r", "--name-only", "HEAD"], { encoding: "utf8" }),
      /\.hunch\/decisions\/dec_live_owner_resets_window\.json/);
  } finally {
    if (holder && holder.exitCode === null && holder.signalCode === null) holder.kill("SIGKILL");
    cleanup();
  }
});

test("a missing memory directory gives up quickly — an un-creatable lock is not a handoff", { timeout: 60_000 }, () => {
  const { root, cleanup } = tempRepo();
  try {
    const missing = join(root, "absent", ".hunch");
    const startedAt = Date.now();
    const result = commitAndPushHunch(missing, "hunch: missing memory directory", { push: false });
    const elapsed = Date.now() - startedAt;

    assert.equal(result, null, "there is nothing to commit and nothing to wait for");
    assert.ok(elapsed < 1_000,
      `mkdir failing for a reason other than contention is abandoned after a few polls, not waited out (took ${elapsed} ms)`);
  } finally {
    cleanup();
  }
});

test("a read-only memory directory gives up quickly — an un-creatable lock is not a handoff", { timeout: 60_000 }, (t) => {
  if (process.platform === "win32") return t.skip("POSIX directory permissions");
  if (typeof process.getuid === "function" && process.getuid() === 0) return t.skip("root ignores directory permissions");
  const { hunchDir, lock, cleanup } = tempRepo();
  try {
    writeDec(hunchDir, "dec_readonly_store");
    chmodSync(hunchDir, 0o555); // the lock mkdir now fails EACCES, not EEXIST
    const startedAt = Date.now();
    const result = commitAndPushHunch(hunchDir, "hunch: read-only memory directory", { push: false });
    const elapsed = Date.now() - startedAt;

    assert.equal(result, null, "a store that cannot be locked is a no-op");
    assert.ok(elapsed < 1_000,
      `and a permission failure is abandoned after a few polls, not spun for the full handoff (took ${elapsed} ms)`);
    assert.equal(existsSync(lock), false, "no lock directory was created");
  } finally {
    try { chmodSync(hunchDir, 0o755); } catch { /* restore for cleanup */ }
    cleanup();
  }
});

test("an owner that vanishes without releasing is given up on after the window, not waited out forever", { timeout: 60_000 }, async () => {
  const { root, hunchDir, lock, cleanup } = tempRepo();
  const ready = join(root, "holder-ready");
  const go = join(root, "parent-about-to-flush");
  let holder: ReturnType<typeof spawn> | null = null;
  try {
    // The first snapshot is held-LIVE (the holder owns the lock), then the owner
    // directory disappears while the holder stays alive and the outer lock dir
    // remains. A sticky "a live owner was seen once" flag would keep polling to
    // the full handoff deadline; the continuously-ownerless timer must not.
    holder = spawnLockHolder([
      HOLDER_PRELUDE,
      `const lock = ${JSON.stringify(lock)};`,
      "const owner = path.join(lock, `owner-${process.pid}`);",
      "fs.mkdirSync(owner, { recursive: true });",
      `fs.writeFileSync(${JSON.stringify(ready)}, "ready\\n");`,
      `waitForMarker(${JSON.stringify(go)});`,
      "sleep(300);",
      "fs.rmSync(owner, { recursive: true, force: true });",
      "sleep(30_000);", // stay alive: the pid keeps reading as live if re-read
      "process.exit(0);",
    ].join("\n"));
    await waitFor(() => existsSync(ready), 5_000);

    writeDec(hunchDir, "dec_owner_vanished");
    writeFileSync(go, "go\n");
    const startedAt = Date.now();
    const result = commitAndPushHunch(hunchDir, "hunch: owner vanished without releasing", { push: false });
    const elapsed = Date.now() - startedAt;

    assert.equal(result, null, "an abandoned lock is not a handoff in progress");
    assert.ok(elapsed > 1_500, `the ownerless window was actually waited out (took ${elapsed} ms)`);
    assert.ok(elapsed < 10_000,
      `and a live-owner sighting does not make the wait sticky to the full handoff (took ${elapsed} ms)`);
  } finally {
    if (holder && holder.exitCode === null && holder.signalCode === null) holder.kill("SIGKILL");
    cleanup();
  }
});
