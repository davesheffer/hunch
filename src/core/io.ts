/** Durable file writes for the Hunch. */
import { closeSync, fchmodSync, fsyncSync, linkSync, lstatSync, openSync, renameSync, rmSync, writeFileSync } from "node:fs";
import { dirname } from "node:path";

let counter = 0;
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
