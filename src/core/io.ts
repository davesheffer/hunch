/** Durable file writes for the Hunch. */
import { linkSync, writeFileSync, renameSync, rmSync } from "node:fs";

let counter = 0;

/**
 * Write `data` to `file` via a temp file + rename, so an interrupted write can't
 * leave the target truncated (the symbols/edges index is the worst to half-write).
 *
 * Windows caveat: renameSync can't REPLACE a file another process holds open (even
 * for read) — it throws EPERM/EBUSY/EACCES, exactly when the MCP server is reading
 * while a CLI writes. Atomicity is crash-safety insurance, not worth FAILING a write
 * the old in-place writeFileSync would have completed — so we fall back to a direct
 * write there. The temp file is always cleaned up; a failed write never leaks it.
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
    renameSync(tmp, file);
  } catch (e) {
    safeRm(tmp);
    const code = (e as NodeJS.ErrnoException).code;
    if (code === "EPERM" || code === "EBUSY" || code === "EACCES") {
      writeFileSync(file, data); // non-atomic fallback (matches pre-hardening behavior)
      return;
    }
    throw e;
  }
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
