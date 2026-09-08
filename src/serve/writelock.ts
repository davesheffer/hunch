/**
 * Cross-process write lock, one per partition root — folded in from Hunch Memory
 * (src/service/writelock.ts there), where it held the one-live-decision-per-topic
 * guarantee across the HTTP process and a stdio MCP process sharing a store.
 *
 * The state binding reads the ledger and the incumbent records, then writes; two
 * processes can both complete the read before either writes. An in-process mutex
 * does not span processes, so the lock is a file created with `open(path, "wx")` —
 * atomic on POSIX and Windows. A holder that dies leaves the file behind; a lock is
 * stealable once its owner is provably gone (pid dead on the same host) or older
 * than any plausible write.
 */
import { hostname } from "node:os";
import { randomBytes } from "node:crypto";
import { closeSync, openSync, readFileSync, rmSync, statSync, writeSync } from "node:fs";
import { join } from "node:path";

/** Longest a write may hold the lock before another process may steal it: a put plus a
 *  git commit and push — seconds, not minutes. */
export const STALE_AFTER_MS = 60_000;
/** Longest a writer waits before giving up and telling the caller. */
export const ACQUIRE_TIMEOUT_MS = 10_000;
const POLL_MS = 25;

export interface LockOwner { pid: number; host: string; nonce: string; at: string }

export class WriteLockTimeout extends Error {
  constructor(readonly path: string, readonly heldBy: LockOwner | undefined, readonly waitedMs: number) {
    super(heldBy
      ? `write lock on ${path} held by pid ${heldBy.pid} on ${heldBy.host} since ${heldBy.at}; waited ${waitedMs}ms`
      : `write lock on ${path} not acquired within ${waitedMs}ms`);
    this.name = "WriteLockTimeout";
  }
}

export function writeLockPath(hunchDir: string): string {
  return join(hunchDir, "write.lock");
}

function readOwner(path: string): LockOwner | undefined {
  try {
    const parsed = JSON.parse(readFileSync(path, "utf8")) as Partial<LockOwner>;
    if (typeof parsed.pid !== "number" || typeof parsed.nonce !== "string") return undefined;
    return { pid: parsed.pid, host: typeof parsed.host === "string" ? parsed.host : "", nonce: parsed.nonce, at: typeof parsed.at === "string" ? parsed.at : "" };
  } catch {
    return undefined; // released between our open and this read, or truncated by a crash — age decides
  }
}

function pidAlive(pid: number): boolean {
  try { process.kill(pid, 0); return true; } catch (error) {
    return (error as NodeJS.ErrnoException).code === "EPERM"; // exists, another user — alive for our purposes
  }
}

function stealable(path: string, owner: LockOwner | undefined, now: number): boolean {
  let ageMs: number;
  try { ageMs = now - statSync(path).mtimeMs; } catch { return false; }
  if (owner && owner.host === hostname() && !pidAlive(owner.pid)) return true;
  return ageMs > STALE_AFTER_MS;
}

const sleep = (ms: number): Promise<void> => new Promise((r) => setTimeout(r, ms));

/** Hold the partition's lock across `fn` (sync or async); released even if it throws. */
export async function withWriteLock<T>(hunchDir: string, fn: () => T | Promise<T>, opts: { timeoutMs?: number } = {}): Promise<T> {
  const path = writeLockPath(hunchDir);
  const timeoutMs = opts.timeoutMs ?? ACQUIRE_TIMEOUT_MS;
  const nonce = randomBytes(8).toString("hex");
  const started = Date.now();
  let fd: number | undefined;
  let lastOwner: LockOwner | undefined;
  for (;;) {
    try { fd = openSync(path, "wx"); break; } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "EEXIST") throw error;
      lastOwner = readOwner(path);
      if (stealable(path, lastOwner, Date.now())) { rmSync(path, { force: true }); continue; }
      if (Date.now() - started >= timeoutMs) throw new WriteLockTimeout(path, lastOwner, Date.now() - started);
      await sleep(POLL_MS);
    }
  }
  const owner: LockOwner = { pid: process.pid, host: hostname(), nonce, at: new Date().toISOString() };
  try { writeSync(fd, JSON.stringify(owner)); } catch { /* held by existence; identity is a courtesy */ }
  closeSync(fd);
  try {
    return await fn();
  } finally {
    // Only remove a lock that is still ours: if we overran STALE_AFTER_MS and were stolen
    // from, the file now protects another writer.
    const current = readOwner(path);
    if (!current || current.nonce === nonce) rmSync(path, { force: true });
  }
}
