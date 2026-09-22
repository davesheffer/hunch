/**
 * Cross-process write lock, one per partition root — folded in from Hunch Memory
 * (src/service/writelock.ts there), where it held the one-live-decision-per-topic
 * guarantee across the HTTP process and a stdio MCP process sharing a store.
 *
 * The state binding reads the ledger and the incumbent records, then writes; two
 * processes can both complete the read before either writes. An in-process mutex
 * does not span processes, so the lock is a file created with `open(path, "wx")` —
 * atomic on POSIX and Windows. A holder that dies leaves the file behind; a lock is
 * stealable once its owner is provably gone (pid dead — or RECYCLED — on the same
 * host) or older than any plausible write. "Recycled" is decided by comparing the
 * owner's recorded process-instance token with the current holder's, by string
 * equality and never by clock arithmetic (see core/procstart.ts). Removing a stale
 * lock is itself serialized behind an exclusive `.reclaim` claim directory, because
 * judging and removing are two steps and two contenders can otherwise both "win"
 * (see `takeOver`).
 */
import { hostname } from "node:os";
import { randomBytes } from "node:crypto";
import { closeSync, mkdirSync, openSync, readFileSync, rmSync, rmdirSync, statSync, writeSync } from "node:fs";
import { join } from "node:path";
import { heldLockNonces, judgeSameHostOwner, selfStartToken, startTokenOf } from "../core/procstart.js";

/** Longest a write may hold the lock before another process may steal it: a put plus a
 *  git commit and push — seconds, not minutes. */
export const STALE_AFTER_MS = 60_000;
/** Longest a writer waits before giving up and telling the caller. */
export const ACQUIRE_TIMEOUT_MS = 10_000;
/** Longest a takeover claim may sit before another contender may clear it. The
 *  claimed section is a few syscalls, so anything this old means its claimer
 *  crashed inside it. */
export const CLAIM_STALE_MS = 10_000;
const POLL_MS = 25;

export interface LockOwner { pid: number; host: string; nonce: string; at: string; start?: string }

/** Token seam: the caller's own process-instance token and a probe for another
 *  pid's, plus the platform the decision table should reason about (the own-pid
 *  fallback differs on linux, where pid namespaces exist). Injected by tests so
 *  the identity paths are exercised off linux. */
export interface StartTokenProbe { self: string | null; of: (pid: number) => string | null; platform?: NodeJS.Platform }

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
    return {
      pid: parsed.pid,
      host: typeof parsed.host === "string" ? parsed.host : "",
      nonce: parsed.nonce,
      at: typeof parsed.at === "string" ? parsed.at : "",
      ...(typeof parsed.start === "string" ? { start: parsed.start } : {}),
    };
  } catch {
    return undefined; // released between our open and this read, or truncated by a crash — age decides
  }
}

function pidAlive(pid: number): boolean {
  try { process.kill(pid, 0); return true; } catch (error) {
    return (error as NodeJS.ErrnoException).code === "EPERM"; // exists, another user — alive for our purposes
  }
}

function stealable(path: string, owner: LockOwner | undefined, now: number, token: StartTokenProbe): boolean {
  let ageMs: number;
  try { ageMs = now - statSync(path).mtimeMs; } catch { return false; }
  // A same-host live PID is authoritative even when a long-running write has
  // exceeded the stale-age heuristic. Age alone cannot distinguish a slow
  // writer from a dead one; stealing here would let two writers interleave
  // their record and ledger updates. The age fallback is only safe when the
  // owner is from another host (whose PID we cannot probe) or its metadata is
  // unreadable.
  //
  // The one exception is a PID that is alive but is no longer the OWNER: PIDs
  // are recycled, and a container restart routinely gives the new writer the
  // dead one's exact pid and hostname, so the orphaned lock names the contender
  // itself and is never taken over again (issue #287). The owner's recorded
  // process-instance token settles it by plain string equality — no clock is
  // read, because the lock's mtime and a start time come from different clocks
  // and any skew between them would "prove" a live owner recycled and steal its
  // lock. Anything the token cannot settle stays "not proven".
  //
  // The whole table lives in core/procstart.ts so this lock and jsonStore's
  // `.rmw-lock` can never drift apart; "age" means it proved nothing and the
  // fallback below governs, exactly as for a foreign host.
  if (owner && owner.host === hostname()) {
    const verdict = judgeSameHostOwner(owner, {
      alive: pidAlive,
      self: token.self,
      tokenOf: token.of,
      platform: token.platform ?? process.platform,
      selfPid: process.pid,
      heldNonces: heldLockNonces,
    });
    if (verdict !== "age") return verdict === "stale";
  }
  return ageMs > STALE_AFTER_MS;
}

const sleep = (ms: number): Promise<void> => new Promise((r) => setTimeout(r, ms));

/** The claim a contender must hold to REMOVE a stale lock. A sibling directory,
 *  created with the same exclusive `mkdir` the commit lock uses
 *  (src/extractors/git.ts `acquireCommitLock`) — a directory because an empty one
 *  is invisible to git and can never be staged. */
function claimPath(lockPath: string): string {
  return `${lockPath}.reclaim`;
}

/**
 * Remove a stale lock under an exclusive claim, and report whether the path may
 * now be free. "judge stale → rm → create" is NOT atomic: two contenders can
 * both judge the same corpse stale, the first removes it and creates its own,
 * and the second then removes that FRESH lock and creates a second holder
 * (issue #287). Serializing the removal behind one claim closes it.
 *
 * INVARIANT: a stale lock's path can only be vacated by a claim holder (its
 * owner is dead and will never release), and only one contender holds the claim
 * at a time — so between the re-judge below and the `rm` nothing can replace the
 * lock. A contender that judged stale a moment earlier re-judges under the
 * claim, sees the winner's fresh live lock, and removes nothing.
 *
 * Residuals accepted:
 *  (i) an AGE-judged lock (foreign host, unprobeable owner, or unreadable owner
 *      metadata) whose owner is actually alive and releases inside the
 *      re-judge→rm window — the same class as the already-accepted "stolen after
 *      STALE_AFTER_MS";
 *  (ii) two contenders racing to clear a STRANDED claim. A claim's staleness is
 *      judged by ITS MTIME against OUR clock — the one clock comparison left in
 *      the takeover path — and there is no claim-nonce file to fall back on. So
 *      with filesystem/host clock skew beyond CLAIM_STALE_MS every LIVE claim
 *      looks stranded, and with three or more simultaneous contenders exclusion
 *      degrades to the pre-fix race. Without such skew it needs a claim section
 *      that is stranded plus simultaneous removers — and "stranded" is NOT only a
 *      crash: a STALL longer than CLAIM_STALE_MS between the re-judge and the
 *      `rm` (SIGSTOP, a VM pause or live migration, a laptop sleep) does it too.
 *      One other contender is then enough: it clears the "stranded" claim, takes
 *      over and publishes a LIVE lock, and the resumed claimer's `rm` removes
 *      that live lock; the unconditional `rmdirSync(claim)` in the `finally` can
 *      likewise remove a SUCCESSOR's claim. Same probability class as the age
 *      steal we already accept — a process stalled past the stale window while
 *      another writes — which is why it is accepted here too;
 *  (iii) a stranded claim blocks any takeover for up to CLAIM_STALE_MS —
 *      bounded, needing the same crash OR over-CLAIM_STALE_MS stall; a filesystem
 *      clock AHEAD of this host extends that block by the amount of the skew;
 *  (iv) MIXED VERSIONS: a pre-fix `hunch` ignores `.reclaim` entirely, so the
 *      takeover race persists until every writer on the store is upgraded.
 */
function takeOver(path: string, token: StartTokenProbe): boolean {
  const claim = claimPath(path);
  try {
    mkdirSync(claim);
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "EEXIST") {
      // Someone else is mid-takeover — or crashed inside one. Clear only a
      // provably stranded claim; either way, do not take over this round (the
      // caller falls through to its deadline check and sleep, never a hot spin).
      try {
        if (Date.now() - statSync(claim).mtimeMs > CLAIM_STALE_MS) rmdirSync(claim);
      } catch { /* vanished, or another contender cleared it first */ }
    }
    return false;
  }
  try {
    // RE-JUDGE from scratch under the claim: the lock we judged stale may already
    // have been replaced by the winner's live one.
    const current = readOwner(path);
    if (!stealable(path, current, Date.now(), token)) return false;
    rmSync(path, { force: true });
    return true;
  } finally {
    try { rmdirSync(claim); } catch { /* best effort; a stranded claim is cleared by age */ }
  }
}

/** Hold the partition's lock across `fn` (sync or async); released even if it throws.
 *
 *  `opts.startToken` is an INTERNAL TEST SEAM, not API: it lets the test suite
 *  drive the process-identity rows of the decision table on a platform that has
 *  no such identity. Callers outside this repo must leave it unset — the real
 *  probe (`selfStartToken`/`startTokenOf`) is the only sound one. */
export async function withWriteLock<T>(
  hunchDir: string,
  fn: () => T | Promise<T>,
  opts: { timeoutMs?: number; startToken?: StartTokenProbe } = {},
): Promise<T> {
  const path = writeLockPath(hunchDir);
  const timeoutMs = opts.timeoutMs ?? ACQUIRE_TIMEOUT_MS;
  const token: StartTokenProbe = opts.startToken ?? { self: selfStartToken(), of: startTokenOf };
  const nonce = randomBytes(8).toString("hex");
  const started = Date.now();
  let fd: number | undefined;
  let lastOwner: LockOwner | undefined;
  for (;;) {
    try {
      fd = openSync(path, "wx");
      // Synchronously adjacent to the successful create, before any await: from
      // here on this nonce is one WE hold, so our own later calls do not mistake
      // it for a predecessor's (and adding it before the open would make a mere
      // waiter look like a holder).
      heldLockNonces.add(nonce);
      break;
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "EEXIST") throw error;
      lastOwner = readOwner(path);
      if (stealable(path, lastOwner, Date.now(), token) && takeOver(path, token)) continue;
      if (Date.now() - started >= timeoutMs) throw new WriteLockTimeout(path, lastOwner, Date.now() - started);
      await sleep(POLL_MS);
    }
  }
  const owner: LockOwner = {
    pid: process.pid,
    host: hostname(),
    nonce,
    at: new Date().toISOString(),
    ...(token.self !== null ? { start: token.self } : {}),
  };
  try { writeSync(fd, JSON.stringify(owner)); } catch { /* held by existence; identity is a courtesy */ }
  closeSync(fd);
  try {
    return await fn();
  } finally {
    // Only remove a lock that is still ours: if we overran STALE_AFTER_MS and were stolen
    // from, the file now protects another writer. The nonce is dropped in a
    // `finally` of its own, so a throw from the conditional remove can never
    // leave us vouching for a lock we no longer hold.
    try {
      const current = readOwner(path);
      if (!current || current.nonce === nonce) rmSync(path, { force: true });
    } finally {
      heldLockNonces.delete(nonce);
    }
  }
}
