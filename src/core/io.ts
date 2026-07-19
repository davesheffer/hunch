/** Durable file writes for the Hunch. */
import { linkSync, writeFileSync, renameSync, rmSync } from "node:fs";

let counter = 0;
const renameRetryDelaysMs = [10, 20, 40, 80] as const;
const renameRetryWaiter = new Int32Array(new SharedArrayBuffer(Int32Array.BYTES_PER_ELEMENT));

/**
 * Write `data` to `file` via a temp file + rename, so an interrupted write can't
 * leave the target truncated (the symbols/edges index is the worst to half-write).
 *
 * Windows caveat: renameSync can't REPLACE a file another process holds open (even
 * for read) — it throws EPERM/EBUSY/EACCES, exactly when the MCP server is reading
 * while a CLI writes. Retry that atomic replacement with bounded backoff. If the
 * contention persists, fail with the old target untouched; never trade availability
 * for a direct write that an interruption could truncate. Failed writes clean up the
 * temporary file.
 */
export function writeFileAtomic(file: string, data: string): void {
  const tmp = `${file}.tmp${process.pid}.${counter++}`;
  try {
    writeFileSync(tmp, data);
  } catch (e) {
    safeRm(tmp);
    throw e;
  }
  try {
    renameWithContentionRetry(tmp, file);
  } catch (e) {
    safeRm(tmp);
    throw e;
  }
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
  try {
    writeFileSync(tmp, data);
    linkSync(tmp, file);
    return true;
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "EEXIST") return false;
    throw error;
  } finally {
    safeRm(tmp);
  }
}

function safeRm(p: string): void {
  try {
    rmSync(p, { force: true });
  } catch {
    /* best effort */
  }
}
