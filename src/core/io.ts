/** Durable file writes for the Hunch. */
import { closeSync, fchmodSync, fsyncSync, linkSync, lstatSync, openSync, renameSync, rmSync, writeFileSync } from "node:fs";
import { dirname, relative, resolve, isAbsolute } from "node:path";

let counter = 0;

/** Process-global log of files the atomic writers published (or noteFileWrite named), as
 *  absolute paths. A capture hold reads it (takeCaptureWrites) to record exactly which public
 *  .hunch files it left uncommitted, so a later state write can leave those out of its commit.
 *  State writers run inside withoutCaptureLog, so their files never enter it. */
const captureLog = new Set<string>();
let captureLogSuppressed = 0;

/** Past this many entries the log is cleared rather than grown, so a long-lived process whose
 *  writes no hold or commit drains stays bounded. Losing attribution only means a later state
 *  write sweeps those files: the base behavior. */
const CAPTURE_LOG_LIMIT = 10000;

/** Log a change to `file` (a write, or a removal made outside the atomic writers). */
export function noteFileWrite(file: string): void {
  if (captureLogSuppressed !== 0) return;
  if (captureLog.size >= CAPTURE_LOG_LIMIT) captureLog.clear();
  captureLog.add(resolve(file));
}

/** Run `fn` with the capture-write log suppressed: nothing it writes is logged, even when it
 *  throws midway. Synchronous only: an async `fn` would resume outside the suppression. */
export function withoutCaptureLog<T>(fn: () => T): T {
  captureLogSuppressed++;
  try { return fn(); } finally { captureLogSuppressed--; }
}

/** Remove and return the logged writes inside `underDir`, relative to it with forward slashes.
 *  Entries outside it stay logged. */
export function takeCaptureWrites(underDir: string): string[] {
  const base = resolve(underDir);
  const taken: string[] = [];
  for (const path of captureLog) {
    const rel = relative(base, path);
    if (rel === "" || rel.startsWith("..") || isAbsolute(rel)) continue;
    captureLog.delete(path);
    taken.push(rel.replace(/\\/g, "/"));
  }
  return taken;
}
const renameRetryDelaysMs = [10, 20, 40, 80] as const;
const renameRetryWaiter = new Int32Array(new SharedArrayBuffer(Int32Array.BYTES_PER_ELEMENT));

/**
 * Write `data` to `file` via a temp file + rename, so an interrupted write can't
 * leave the target truncated (the symbols/edges index is the worst to half-write).
 *
 * Durability (issue #34): the temp file is fsync'd BEFORE the rename, and the
 * parent directory best-effort after it. A process kill was always safe (page
 * cache preserves ordering), but on power loss / OS crash the rename's metadata
 * could reach disk before the temp file's data blocks — leaving the target
 * present but truncated or garbage, the exact state the atomic-write invariant
 * (con_902759b3dc) exists to prevent.
 *
 * Windows caveat: renameSync can't REPLACE a file another process holds open (even
 * for read) — it throws EPERM/EBUSY/EACCES, exactly when the MCP server is reading
 * while a CLI writes. Retry that atomic replacement with bounded backoff. If the
 * contention persists, fail with the old target untouched; never trade availability
 * for a direct write that an interruption could truncate. Failed writes clean up the
 * temporary file.
 */
export function writeFileAtomic(file: string, data: string | Uint8Array): void {
  const tmp = `${file}.tmp${process.pid}.${counter++}`;
  let mode: number | undefined;
  try {
    const existing = lstatSync(file);
    if (existing.isFile()) mode = existing.mode & 0o777;
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
  }
  writeFileAtomicTmp(tmp, data, mode);
  try {
    renameWithContentionRetry(tmp, file);
  } catch (e) {
    cleanupTmp(tmp);
    throw e;
  }
  noteFileWrite(file);
  fsyncDirBestEffort(dirname(file));
}

/** Persist the rename itself (the directory entry). POSIX semantics; Windows
 *  cannot open directories for fsync, so this is a silent no-op there — NTFS
 *  journals the metadata on its own schedule. */
function fsyncDirBestEffort(dir: string): void {
  try {
    const fd = openSync(dir, "r");
    try { fsyncSync(fd); } finally { closeSync(fd); }
  } catch { /* platform without directory fsync — best effort by contract */ }
}

function renameWithContentionRetry(from: string, to: string): void {
  for (let attempt = 0; ; attempt++) {
    try {
      renameSync(from, to);
      return;
    } catch (error) {
      const delayMs = renameRetryDelaysMs[attempt];
      if (delayMs === undefined || !isRenameContention(error)) throw error;
      Atomics.wait(renameRetryWaiter, 0, 0, delayMs);
    }
  }
}

function isRenameContention(error: unknown): boolean {
  const code = (error as NodeJS.ErrnoException).code;
  return code === "EPERM" || code === "EBUSY" || code === "EACCES";
}

/** Atomically create a complete file only when no target exists. A same-dir
 * hard link publishes the fully written temp inode with create-if-absent
 * semantics, so concurrent lifecycle writers can never be overwritten. */
export function writeFileAtomicIfAbsent(file: string, data: string): boolean {
  const tmp = `${file}.tmp${process.pid}.${counter++}`;
  // An occupied temp path is an error, not evidence that the target exists.
  // Only enter the publication/cleanup block once we own the temporary file.
  writeFileAtomicTmp(tmp, data);
  try {
    linkSync(tmp, file);
    noteFileWrite(file);
    return true;
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "EEXIST") return false;
    throw error;
  } finally {
    // Not silently best-effort (issue #38): after linkSync succeeds the target
    // shares the temp inode, so a swallowed unlink failure (a Windows AV scanner
    // or indexer briefly holding tmp) leaves the published file with nlink=2 —
    // which validateExistingFile rejects as hard-linked — plus a stray .tmp.
    cleanupTmp(tmp);
  }
}

/** Write + fsync a fresh temp file (shared by both atomic writers). */
function writeFileAtomicTmp(tmp: string, data: string | Uint8Array, mode?: number): void {
  // Exclusive creation rejects stale files and links without truncating their
  // contents. If open fails, the path belongs to somebody else: never unlink it.
  const fd = openSync(tmp, "wx", mode ?? 0o666);
  try {
    try {
      writeFileSync(fd, data);
      // The replacement inode must retain an existing file's permissions,
      // including private config files that contain credentials.
      if (mode !== undefined) fchmodSync(fd, mode);
      fsyncSync(fd);
    } finally {
      closeSync(fd);
    }
  } catch (error) {
    cleanupTmp(tmp);
    throw error;
  }
}

/** Remove a temp file, riding out a transient external hold (AV/indexer) with one
 *  short retry; a persistent failure is REPORTED, never swallowed — a leaked tmp
 *  beside a hard-link-published target keeps that target at nlink=2. */
function cleanupTmp(p: string): void {
  try {
    rmSync(p, { force: true });
    return;
  } catch { /* transient hold — retry once below */ }
  Atomics.wait(renameRetryWaiter, 0, 0, 50);
  try {
    rmSync(p, { force: true });
  } catch (e) {
    console.warn(`[hunch] temp file left behind (its published target keeps nlink=2 until it is removed): ${p} (${(e as Error).message})`);
  }
}

/** A rewrite with the same bytes changes nothing anyone reads when the doc is a plain
 *  file with one link the process owns: the atomic write would only swap the inode.
 *  A symlink, a hard link, or a foreign owner is rewritten as before (the write
 *  replaces it with a regular file of this process). */
export function sameBytesRewriteIsNoop(file: string): boolean {
  try {
    const stat = lstatSync(file);
    if (!stat.isFile() || stat.nlink !== 1) return false;
    if (typeof process.getuid === "function" && (stat.uid !== process.getuid() || stat.gid !== process.getgid?.())) return false;
    return true;
  } catch {
    return false;
  }
}
