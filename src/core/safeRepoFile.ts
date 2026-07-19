import {
  closeSync,
  constants,
  fstatSync,
  lstatSync,
  openSync,
  readSync,
  realpathSync,
} from "node:fs";
import { isAbsolute, relative, resolve, sep } from "node:path";

export type RepoFileReader = (file: string) => string | null;
export type RepoFileBufferReader = (file: string) => Buffer | null;

/** Automatic repository scans are a convenience boundary, not a license to
 * materialize arbitrarily large tracked blobs in memory. Eight MiB is well
 * above ordinary source-file sizes while keeping one malicious/generated file
 * from becoming an unbounded descriptor read. */
export const MAX_REPO_SOURCE_FILE_BYTES = 8 * 1024 * 1024;

export interface RepoFileReaderOptions {
  maxBytes?: number;
}

/** Build a no-follow reader for automatic repository scanners. A Git-tracked
 * symlink still appears in `git ls-files`; following it can copy host data into
 * generated memory or reports. This reader accepts only one unchanged regular
 * file beneath the canonical repository root and reads through the descriptor
 * whose identity was checked. */
export function createRepoFileBufferReader(root: string, options: RepoFileReaderOptions = {}): RepoFileBufferReader {
  const lexicalRoot = resolve(root);
  const canonicalRoot = realpathSync(lexicalRoot);
  const maxBytes = options.maxBytes ?? MAX_REPO_SOURCE_FILE_BYTES;
  if (!Number.isSafeInteger(maxBytes) || maxBytes < 0) {
    throw new RangeError("maxBytes must be a non-negative safe integer");
  }

  return (file: string): Buffer | null => {
    let descriptor: number | undefined;
    try {
      const target = isAbsolute(file) ? resolve(file) : resolve(lexicalRoot, file);
      const lexicalRelative = relative(lexicalRoot, target);
      if (!lexicalRelative || lexicalRelative === ".." || lexicalRelative.startsWith(`..${sep}`) || isAbsolute(lexicalRelative)) return null;

      const before = lstatSync(target);
      if (!before.isFile() || before.isSymbolicLink()) return null;
      const canonicalTarget = realpathSync(target);
      const canonicalRelative = relative(canonicalRoot, canonicalTarget);
      if (!canonicalRelative || canonicalRelative === ".." || canonicalRelative.startsWith(`..${sep}`) || isAbsolute(canonicalRelative)
        || canonicalTarget !== resolve(canonicalRoot, lexicalRelative)) {
        return null;
      }

      descriptor = openSync(target, constants.O_RDONLY | constants.O_NOFOLLOW);
      const opened = fstatSync(descriptor);
      const after = lstatSync(target);
      if (!opened.isFile() || !after.isFile() || after.isSymbolicLink()
        || opened.size > maxBytes
        || opened.dev !== before.dev || opened.ino !== before.ino
        || after.dev !== opened.dev || after.ino !== opened.ino
        || realpathSync(target) !== canonicalTarget) {
        return null;
      }
      // Read exactly the size that passed fstat. readFileSync(fd) reads to EOF,
      // so an in-place grow after the check could otherwise defeat the ceiling.
      const bytes = Buffer.allocUnsafe(opened.size);
      let offset = 0;
      while (offset < bytes.length) {
        const read = readSync(descriptor, bytes, offset, bytes.length - offset, offset);
        if (read === 0) break;
        offset += read;
      }
      return bytes.subarray(0, offset);
    } catch {
      return null;
    } finally {
      if (descriptor !== undefined) closeSync(descriptor);
    }
  };
}

/** Text facade for parsers and legacy callers. Security-sensitive identities
 * should hash the raw bytes returned by createRepoFileBufferReader first, since
 * distinct invalid UTF-8 sequences can decode to the same replacement text. */
export function createRepoFileReader(root: string, options: RepoFileReaderOptions = {}): RepoFileReader {
  const read = createRepoFileBufferReader(root, options);
  return (file) => read(file)?.toString("utf8") ?? null;
}
