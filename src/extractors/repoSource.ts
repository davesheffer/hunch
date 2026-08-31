import { execFileSync } from "node:child_process";
import { createHash } from "node:crypto";
import { lstatSync, readdirSync } from "node:fs";
import { join } from "node:path";
import { TextDecoder } from "node:util";
import { MAX_REPO_SOURCE_FILE_BYTES, createRepoFileBufferReader } from "../core/safeRepoFile.js";
import { compareCodeUnits } from "../core/canonicalOrder.js";
import { foreignRepoEnv, gitNullDevice } from "./git.js";
import { languageFor } from "./languages.js";

const SKIP_DIRS = new Set(["node_modules", ".git", "dist", "build", ".hunch", "coverage", ".next", "out"]);
const ORDINARY_BLOB_MODES = new Set(["100644", "100755"]);
const GIT_MAX_LISTING_BYTES = 64 * 1024 * 1024;
const GIT_MAX_BLOB_BATCH_BYTES = 64 * 1024 * 1024;
const GIT_MAX_BLOB_BATCH_ITEMS = 128;

export type RepoScanSource =
  | { kind: "checkout" }
  | { kind: "staged" }
  | { kind: "working" }
  | { kind: "commit"; ref: string }
  | { kind: "base" };

export type RepoScanSourceKind = RepoScanSource["kind"];

export interface RepoScanSourceIdentity {
  kind: RepoScanSourceKind;
  /** Canonical commit object used by commit/base scans. */
  revision?: string;
}

export type RepoSourceIssueCode =
  | "conflicted"
  | "unsafe_path"
  | "unsafe_mode"
  | "symlink"
  | "non_regular"
  | "oversized"
  | "invalid_encoding"
  | "read_failed"
  | "parse_failed";

export interface RepoSourceIssue {
  path: string;
  code: RepoSourceIssueCode;
  detail: string;
}

export interface RepoSourceRead {
  source: string | null;
  mode: string;
  /** Hash of the exact bytes supplied by Git/filesystem, before UTF-8 decode. */
  contentHash?: string;
  /** Missing tracked working files are intentional deletions, not scan failures. */
  absent?: boolean;
  issue?: RepoSourceIssue;
}

function rawContentHash(bytes: Buffer): string {
  return `sha1:${createHash("sha1").update(bytes).digest("hex")}`;
}

function decodedSource(path: string, mode: string, bytes: Buffer): RepoSourceRead {
  const contentHash = rawContentHash(bytes);
  try {
    return { source: UTF8_DECODER.decode(bytes), mode, contentHash };
  } catch {
    return {
      source: null,
      mode,
      contentHash,
      issue: { path, code: "invalid_encoding", detail: `${path} is not valid UTF-8 and cannot be parsed losslessly` },
    };
  }
}

export interface RepoSourceEntry {
  path: string;
  mode: string;
  read(): RepoSourceRead;
}

export interface RepoSourceInventory {
  identity: RepoScanSourceIdentity;
  entries: RepoSourceEntry[];
}

function gitEnv(preserveInvocationIndex = false): NodeJS.ProcessEnv {
  const env: NodeJS.ProcessEnv = {
    ...foreignRepoEnv(process.env),
    GIT_CONFIG_NOSYSTEM: "1",
    GIT_CONFIG_GLOBAL: gitNullDevice(),
    GIT_NO_REPLACE_OBJECTS: "1",
  };
  // A partial/pre-commit workflow can intentionally select an alternate index.
  // `foreignRepoEnv` must clear it for commit/replay work in another checkout,
  // but staged/working source selection in the invocation repo has to use the
  // same index as changed-file enumeration or the gate can inspect two worlds.
  if (preserveInvocationIndex && process.env.GIT_INDEX_FILE) {
    env.GIT_INDEX_FILE = process.env.GIT_INDEX_FILE;
  }
  return env;
}

function gitBuffer(root: string, args: string[], maxBuffer = GIT_MAX_LISTING_BYTES, preserveInvocationIndex = false): Buffer {
  return execFileSync("git", ["-C", root, ...args], {
    encoding: "buffer",
    env: gitEnv(preserveInvocationIndex),
    maxBuffer,
    stdio: ["ignore", "pipe", "ignore"],
    timeout: 15_000,
  });
}

function gitBufferInput(root: string, args: string[], input: string, maxBuffer: number): Buffer {
  return execFileSync("git", ["-C", root, ...args], {
    encoding: "buffer",
    env: gitEnv(),
    input: Buffer.from(input, "ascii"),
    maxBuffer,
    stdio: ["pipe", "pipe", "ignore"],
    timeout: 15_000,
  });
}

function gitText(root: string, args: string[]): string {
  return gitBuffer(root, args, 1024 * 1024).toString("utf8").trim();
}

function isGitRepository(root: string): boolean {
  try {
    return gitText(root, ["rev-parse", "--is-inside-work-tree"]) === "true";
  } catch {
    return false;
  }
}

function isSafeRelativePath(path: string): boolean {
  const segments = path.split("/");
  return !!path
    && !path.startsWith("/")
    && !path.includes("\\")
    && !/^[A-Za-z]:/.test(path)
    && segments.every((segment) => !!segment && segment !== "." && segment !== ".." && segment.toLowerCase() !== ".git");
}

function isSkippedPath(path: string): boolean {
  return path.split("/").some((segment) => SKIP_DIRS.has(segment));
}

export function isIndexedCodePath(path: string): boolean {
  return languageFor(path) !== null && !isSkippedPath(path);
}

interface DecodedGitPath {
  path: string;
  invalidUtf8: boolean;
  indexedCode: boolean;
}

const UTF8_DECODER = new TextDecoder("utf-8", { fatal: true });

function nulRecords(bytes: Buffer): Buffer[] {
  const records: Buffer[] = [];
  let start = 0;
  for (let end = bytes.indexOf(0, start); end !== -1; end = bytes.indexOf(0, start)) {
    if (end > start) records.push(bytes.subarray(start, end));
    start = end + 1;
  }
  if (start < bytes.length) records.push(bytes.subarray(start));
  return records;
}

function decodeGitPath(bytes: Buffer): DecodedGitPath {
  try {
    const path = UTF8_DECODER.decode(bytes);
    return { path, invalidUtf8: false, indexedCode: isIndexedCodePath(path) };
  } catch {
    // Git pathnames are arbitrary bytes on POSIX. Never collapse distinct byte
    // sequences through U+FFFD: bind the raw bytes to a stable opaque label and
    // make the semantic scan incomplete/fail-closed.
    const fingerprint = createHash("sha256").update(bytes).digest("hex");
    return { path: `<non-utf8-git-path:sha256:${fingerprint}>`, invalidUtf8: true, indexedCode: true };
  }
}

function issueEntry(path: string, mode: string, code: RepoSourceIssueCode, detail: string): RepoSourceEntry {
  const issue = { path, code, detail };
  return { path, mode, read: () => ({ source: null, mode, issue }) };
}

function filesystemEntry(root: string, path: string, allowMissing: boolean): RepoSourceEntry {
  const readFile = createRepoFileBufferReader(root);
  return {
    path,
    mode: "filesystem",
    read: () => {
      const absolute = join(root, path);
      let stat;
      try {
        stat = lstatSync(absolute);
      } catch (error) {
        if (allowMissing && (error as NodeJS.ErrnoException).code === "ENOENT") {
          return { source: null, mode: "absent", absent: true };
        }
        return {
          source: null,
          mode: "filesystem",
          issue: { path, code: "read_failed", detail: `${path} disappeared or could not be inspected` },
        };
      }
      if (stat.isSymbolicLink()) {
        return { source: null, mode: "120000", issue: { path, code: "symlink", detail: `${path} is a symlink` } };
      }
      if (!stat.isFile()) {
        return { source: null, mode: "non-regular", issue: { path, code: "non_regular", detail: `${path} is not a regular file` } };
      }
      const mode = stat.mode & 0o111 ? "100755" : "100644";
      if (stat.size > MAX_REPO_SOURCE_FILE_BYTES) {
        return { source: null, mode, issue: { path, code: "oversized", detail: `${path} exceeds the ${MAX_REPO_SOURCE_FILE_BYTES}-byte source limit` } };
      }
      const bytes = readFile(absolute);
      return bytes === null
        ? { source: null, mode, issue: { path, code: "read_failed", detail: `${path} changed identity or could not be read safely` } }
        : decodedSource(path, mode, bytes);
    },
  };
}

function gitBlobEntry(root: string, path: string, mode: string, oid: string): RepoSourceEntry {
  return {
    path,
    mode,
    read: () => {
      try {
        const type = gitText(root, ["cat-file", "-t", oid]);
        const size = Number(gitText(root, ["cat-file", "-s", oid]));
        if (type !== "blob" || !Number.isSafeInteger(size) || size < 0) {
          return { source: null, mode, issue: { path, code: "read_failed", detail: `${path} does not resolve to an ordinary blob` } };
        }
        if (size > MAX_REPO_SOURCE_FILE_BYTES) {
          return { source: null, mode, issue: { path, code: "oversized", detail: `${path} exceeds the ${MAX_REPO_SOURCE_FILE_BYTES}-byte source limit` } };
        }
        const bytes = gitBuffer(root, ["cat-file", "blob", oid], MAX_REPO_SOURCE_FILE_BYTES + 1);
        if (bytes.length !== size) {
          return { source: null, mode, issue: { path, code: "read_failed", detail: `${path} blob length changed while scanning` } };
        }
        return decodedSource(path, mode, bytes);
      } catch {
        return { source: null, mode, issue: { path, code: "read_failed", detail: `${path} blob could not be read` } };
      }
    },
  };
}

interface GitBlobCandidate {
  path: string;
  mode: string;
  oid: string;
}

interface CheckedGitBlob extends GitBlobCandidate {
  size: number;
}

/** Resolve blob type/size for a complete immutable tree in one Git process.
 * Oversized blobs are rejected before hydration, preserving the source byte
 * limit without paying one `cat-file -t` and `cat-file -s` spawn per path. */
function checkedGitBlobs(
  root: string,
  candidates: GitBlobCandidate[],
): { readable: CheckedGitBlob[]; rejected: RepoSourceEntry[] } {
  if (candidates.length === 0) return { readable: [], rejected: [] };
  const raw = gitBufferInput(
    root,
    ["cat-file", "--batch-check=%(objectname) %(objecttype) %(objectsize)"],
    `${candidates.map((candidate) => candidate.oid).join("\n")}\n`,
    GIT_MAX_LISTING_BYTES,
  ).toString("ascii");
  const lines = raw.endsWith("\n") ? raw.slice(0, -1).split("\n") : raw.split("\n");
  if (lines.length !== candidates.length) throw new Error("Git blob batch check returned an incomplete result");

  const readable: CheckedGitBlob[] = [];
  const rejected: RepoSourceEntry[] = [];
  for (const [index, candidate] of candidates.entries()) {
    const line = lines[index] ?? "";
    const match = line.match(/^([0-9a-f]{40,64}) ([a-z]+) ([0-9]+)$/i);
    const size = match ? Number(match[3]) : Number.NaN;
    if (!match || match[1]!.toLowerCase() !== candidate.oid || match[2] !== "blob"
      || !Number.isSafeInteger(size) || size < 0) {
      rejected.push(issueEntry(
        candidate.path,
        candidate.mode,
        "read_failed",
        `${candidate.path} does not resolve to an ordinary blob`,
      ));
    } else if (size > MAX_REPO_SOURCE_FILE_BYTES) {
      rejected.push(issueEntry(
        candidate.path,
        candidate.mode,
        "oversized",
        `${candidate.path} exceeds the ${MAX_REPO_SOURCE_FILE_BYTES}-byte source limit`,
      ));
    } else {
      readable.push({ ...candidate, size });
    }
  }
  return { readable, rejected };
}

function readGitBlobBatch(root: string, batch: CheckedGitBlob[]): RepoSourceRead[] {
  try {
    const expectedBytes = batch.reduce((total, candidate) => total + candidate.size + 160, 0);
    const raw = gitBufferInput(
      root,
      ["cat-file", "--batch"],
      `${batch.map((candidate) => candidate.oid).join("\n")}\n`,
      Math.max(1024 * 1024, expectedBytes),
    );
    const results: RepoSourceRead[] = [];
    let cursor = 0;
    for (const candidate of batch) {
      const headerEnd = raw.indexOf(0x0a, cursor);
      if (headerEnd < 0) throw new Error("Git blob batch omitted an object header");
      const header = raw.subarray(cursor, headerEnd).toString("ascii");
      const match = header.match(/^([0-9a-f]{40,64}) blob ([0-9]+)$/i);
      const size = match ? Number(match[2]) : Number.NaN;
      if (!match || match[1]!.toLowerCase() !== candidate.oid || size !== candidate.size) {
        throw new Error("Git blob batch returned a different object than requested");
      }
      const contentStart = headerEnd + 1;
      const contentEnd = contentStart + size;
      if (contentEnd >= raw.length || raw[contentEnd] !== 0x0a) {
        throw new Error("Git blob batch returned a truncated object");
      }
      results.push(decodedSource(candidate.path, candidate.mode, raw.subarray(contentStart, contentEnd)));
      cursor = contentEnd + 1;
    }
    if (cursor !== raw.length) throw new Error("Git blob batch returned trailing bytes");
    return results;
  } catch {
    return batch.map((candidate) => ({
      source: null,
      mode: candidate.mode,
      issue: {
        path: candidate.path,
        code: "read_failed",
        detail: `${candidate.path} blob could not be read`,
      },
    }));
  }
}

/** Hydrate exact-tree blobs through bounded `git cat-file --batch` groups.
 * Normal scan consumers read each entry once; a repeated read retains the old
 * entry contract by falling back to the single-blob path. Completed batches
 * release their decoded payloads so a large repo never accumulates every source
 * body in memory at once. */
function batchedGitBlobEntries(root: string, candidates: CheckedGitBlob[]): RepoSourceEntry[] {
  const groups: CheckedGitBlob[][] = [];
  let group: CheckedGitBlob[] = [];
  let groupBytes = 0;
  for (const candidate of candidates) {
    if (group.length > 0 && (group.length >= GIT_MAX_BLOB_BATCH_ITEMS
      || groupBytes + candidate.size > GIT_MAX_BLOB_BATCH_BYTES)) {
      groups.push(group);
      group = [];
      groupBytes = 0;
    }
    group.push(candidate);
    groupBytes += candidate.size;
  }
  if (group.length > 0) groups.push(group);

  return groups.flatMap((batch) => {
    let loaded: Array<RepoSourceRead | undefined> | null = null;
    let unread = batch.length;
    return batch.map((candidate, index) => {
      let firstRead = true;
      return {
        path: candidate.path,
        mode: candidate.mode,
        read: () => {
          if (!firstRead) return gitBlobEntry(root, candidate.path, candidate.mode, candidate.oid).read();
          firstRead = false;
          loaded ??= readGitBlobBatch(root, batch);
          const result = loaded[index];
          if (!result) throw new Error(`Git blob batch lost ${candidate.path}`);
          loaded[index] = undefined;
          unread--;
          if (unread === 0) loaded = null;
          return result;
        },
      };
    });
  });
}

interface IndexRow {
  path: string;
  mode: string;
  oid: string;
  stage: number;
  invalidUtf8: boolean;
  indexedCode: boolean;
}

function indexRows(root: string, preserveInvocationIndex = false): IndexRow[] {
  const raw = gitBuffer(root, ["ls-files", "--cached", "--stage", "-z"], GIT_MAX_LISTING_BYTES, preserveInvocationIndex);
  const rows: IndexRow[] = [];
  for (const record of nulRecords(raw)) {
    const tab = record.indexOf(0x09);
    if (tab < 0) throw new Error("could not parse the Git index while selecting semantic source");
    const match = record.subarray(0, tab).toString("ascii").match(/^([0-7]{6}) ([0-9a-f]{40,64}) ([0-3])$/i);
    if (!match) throw new Error("could not parse the Git index while selecting semantic source");
    const decoded = decodeGitPath(record.subarray(tab + 1));
    rows.push({
      mode: match[1]!,
      oid: match[2]!.toLowerCase(),
      stage: Number(match[3]),
      path: decoded.path,
      invalidUtf8: decoded.invalidUtf8,
      indexedCode: decoded.indexedCode,
    });
  }
  return rows;
}

function normalizeCandidate(path: string, mode: string): RepoSourceEntry | "skip" | null {
  if (!isIndexedCodePath(path)) return "skip";
  if (!isSafeRelativePath(path)) return issueEntry(path, mode, "unsafe_path", `${path} is not a safe repository-relative source path`);
  return null;
}

function stagedInventory(root: string): RepoSourceInventory {
  const grouped = new Map<string, IndexRow[]>();
  for (const row of indexRows(root, true)) {
    const rows = grouped.get(row.path) ?? [];
    rows.push(row);
    grouped.set(row.path, rows);
  }
  const entries: RepoSourceEntry[] = [];
  for (const path of [...grouped.keys()].sort(compareCodeUnits)) {
    const rows = grouped.get(path)!;
    if (rows.some((row) => row.invalidUtf8)) {
      if (rows.some((row) => row.indexedCode)) {
        entries.push(issueEntry(path, rows[0]?.mode ?? "index", "unsafe_path", `${path} is not valid UTF-8 and cannot be scanned losslessly`));
      }
      continue;
    }
    const preflight = normalizeCandidate(path, rows[0]?.mode ?? "index");
    if (preflight === "skip") continue;
    if (preflight) { entries.push(preflight); continue; }
    if (rows.some((row) => row.stage !== 0)) {
      entries.push(issueEntry(path, "conflicted", "conflicted", `${path} has unresolved Git index stages`));
      continue;
    }
    const row = rows.find((candidate) => candidate.stage === 0);
    if (!row) {
      entries.push(issueEntry(path, "conflicted", "conflicted", `${path} has no stage-0 Git index blob`));
    } else if (row.mode === "120000") {
      entries.push(issueEntry(path, row.mode, "symlink", `${path} is a Git-tracked symlink; its target is not read`));
    } else if (!ORDINARY_BLOB_MODES.has(row.mode)) {
      entries.push(issueEntry(path, row.mode, "unsafe_mode", `${path} uses unsupported Git mode ${row.mode}`));
    } else {
      entries.push(gitBlobEntry(root, path, row.mode, row.oid));
    }
  }
  return { identity: { kind: "staged" }, entries };
}

function exactCommit(root: string, ref: string): string {
  const revision = gitText(root, ["rev-parse", "--verify", `${ref}^{commit}`]).toLowerCase();
  if (!/^[0-9a-f]{40,64}$/.test(revision)) throw new Error(`semantic source ref ${JSON.stringify(ref)} is not an exact commit`);
  return revision;
}

function treeInventory(root: string, kind: "commit" | "base", ref: string): RepoSourceInventory {
  const revision = exactCommit(root, ref);
  const raw = gitBuffer(root, ["ls-tree", "--full-tree", "-r", "-z", revision]);
  const entries: RepoSourceEntry[] = [];
  const blobCandidates: GitBlobCandidate[] = [];
  for (const record of nulRecords(raw)) {
    const tab = record.indexOf(0x09);
    if (tab < 0) throw new Error(`could not parse exact ${kind} tree ${revision}`);
    const match = record.subarray(0, tab).toString("ascii").match(/^([0-7]{6}) (blob|tree|commit) ([0-9a-f]{40,64})$/i);
    if (!match) throw new Error(`could not parse exact ${kind} tree ${revision}`);
    const mode = match[1]!;
    const type = match[2]!;
    const oid = match[3]!.toLowerCase();
    const decoded = decodeGitPath(record.subarray(tab + 1));
    const path = decoded.path;
    if (decoded.invalidUtf8) {
      if (decoded.indexedCode) entries.push(issueEntry(path, mode, "unsafe_path", `${path} is not valid UTF-8 and cannot be scanned losslessly`));
      continue;
    }
    const preflight = normalizeCandidate(path, mode);
    if (preflight === "skip") continue;
    if (preflight) { entries.push(preflight); continue; }
    if (mode === "120000") {
      entries.push(issueEntry(path, mode, "symlink", `${path} is a Git-tracked symlink; its target is not read`));
    } else if (type !== "blob" || !ORDINARY_BLOB_MODES.has(mode)) {
      entries.push(issueEntry(path, mode, "unsafe_mode", `${path} uses unsupported Git ${type} mode ${mode}`));
    } else {
      blobCandidates.push({ path, mode, oid });
    }
  }
  const checked = checkedGitBlobs(root, blobCandidates);
  entries.push(...checked.rejected, ...batchedGitBlobEntries(root, checked.readable));
  entries.sort((left, right) => compareCodeUnits(left.path, right.path));
  return { identity: { kind, revision }, entries };
}

function nulPaths(root: string, args: string[], preserveInvocationIndex = false): DecodedGitPath[] {
  return nulRecords(gitBuffer(root, args, GIT_MAX_LISTING_BYTES, preserveInvocationIndex)).map(decodeGitPath);
}

function filesystemInventory(root: string, kind: "checkout" | "working"): RepoSourceInventory {
  if (!isGitRepository(root)) return walkedInventory(root, kind);
  const preserveInvocationIndex = kind === "working";
  const rows = indexRows(root, preserveInvocationIndex);
  const tracked = new Set(rows.filter((row) => !row.invalidUtf8).map((row) => row.path));
  const conflicted = new Set(rows.filter((row) => !row.invalidUtf8 && row.stage !== 0).map((row) => row.path));
  const untracked = kind === "working"
    ? nulPaths(root, ["ls-files", "--others", "--exclude-standard", "-z"], true)
    : [];
  // Preserve historical checkout-index behavior: when an unborn repository has
  // no tracked source, initialization scans the safe filesystem instead.
  if (kind === "checkout" && rows.length === 0) return walkedInventory(root, kind);
  const paths = [...new Set([...tracked, ...untracked.filter((item) => !item.invalidUtf8).map((item) => item.path)])].sort(compareCodeUnits);
  const entries: RepoSourceEntry[] = [];
  const invalid = new Map<string, string>();
  for (const row of rows) {
    if (row.invalidUtf8 && row.indexedCode) invalid.set(row.path, row.mode);
  }
  for (const item of untracked) {
    if (item.invalidUtf8 && item.indexedCode) invalid.set(item.path, "filesystem");
  }
  for (const [path, mode] of [...invalid].sort(([left], [right]) => compareCodeUnits(left, right))) {
    entries.push(issueEntry(path, mode, "unsafe_path", `${path} is not valid UTF-8 and cannot be scanned losslessly`));
  }
  for (const path of paths) {
    const preflight = normalizeCandidate(path, "filesystem");
    if (preflight === "skip") continue;
    if (preflight) { entries.push(preflight); continue; }
    if (conflicted.has(path)) {
      entries.push(issueEntry(path, "conflicted", "conflicted", `${path} has unresolved Git index stages`));
    } else {
      entries.push(filesystemEntry(root, path, tracked.has(path)));
    }
  }
  return { identity: { kind }, entries };
}

function walkedInventory(root: string, kind: "checkout" | "working"): RepoSourceInventory {
  const paths: string[] = [];
  const walk = (dir: string, prefix = "") => {
    for (const entry of readdirSync(dir, { withFileTypes: true })) {
      if (SKIP_DIRS.has(entry.name)) continue;
      const path = prefix ? `${prefix}/${entry.name}` : entry.name;
      if (entry.isDirectory()) walk(join(dir, entry.name), path);
      else if (languageFor(path)) paths.push(path);
    }
  };
  walk(root);
  return {
    identity: { kind },
    entries: paths.sort(compareCodeUnits).map((path) => filesystemEntry(root, path, false)),
  };
}

export function repoSourceInventory(root: string, source: RepoScanSource = { kind: "checkout" }): RepoSourceInventory {
  if (source.kind === "staged") {
    if (!isGitRepository(root)) throw new Error("staged semantic source requires a Git repository");
    return stagedInventory(root);
  }
  if (source.kind === "commit") {
    if (!isGitRepository(root)) throw new Error("commit semantic source requires a Git repository");
    return treeInventory(root, "commit", source.ref);
  }
  if (source.kind === "base") {
    if (!isGitRepository(root)) throw new Error("base semantic source requires a Git repository");
    return treeInventory(root, "base", "HEAD");
  }
  return filesystemInventory(root, source.kind);
}

function absentAuxiliarySource(): RepoSourceRead {
  return { source: null, mode: "absent", absent: true };
}

/** Read a known, safe auxiliary manifest from the exact same source selection as
 * the semantic code scan. This is intentionally path-specific rather than a
 * second inventory: manifests inform resolution but never become code files. */
export function repoAuxiliarySource(
  root: string,
  source: RepoScanSource = { kind: "checkout" },
  path: string,
): RepoSourceRead {
  if (!isSafeRelativePath(path) || isSkippedPath(path)) {
    return { source: null, mode: "unsafe", issue: { path, code: "unsafe_path", detail: `${path} is not a safe auxiliary source path` } };
  }
  if (source.kind === "commit" || source.kind === "base") {
    if (!isGitRepository(root)) return absentAuxiliarySource();
    const revision = exactCommit(root, source.kind === "commit" ? source.ref : "HEAD");
    const raw = gitBuffer(root, ["ls-tree", "--full-tree", "-z", revision, "--", path], 1024 * 1024);
    const records = nulRecords(raw);
    if (records.length === 0) return absentAuxiliarySource();
    if (records.length !== 1) return { source: null, mode: "ambiguous", issue: { path, code: "read_failed", detail: `${path} did not resolve to one exact Git object` } };
    const tab = records[0]!.indexOf(0x09);
    const match = tab < 0 ? null : records[0]!.subarray(0, tab).toString("ascii").match(/^([0-7]{6}) blob ([0-9a-f]{40,64})$/i);
    if (!match || records[0]!.subarray(tab + 1).toString("utf8") !== path || !ORDINARY_BLOB_MODES.has(match[1]!)) {
      return { source: null, mode: match?.[1] ?? "invalid", issue: { path, code: "unsafe_mode", detail: `${path} is not an ordinary exact Git blob` } };
    }
    return gitBlobEntry(root, path, match[1]!, match[2]!).read();
  }
  if (source.kind === "staged") {
    if (!isGitRepository(root)) return absentAuxiliarySource();
    const rows = indexRows(root, true).filter((row) => !row.invalidUtf8 && row.path === path);
    if (rows.length === 0) return absentAuxiliarySource();
    const row = rows.find((candidate) => candidate.stage === 0);
    if (!row || rows.some((candidate) => candidate.stage !== 0)) {
      return { source: null, mode: "conflicted", issue: { path, code: "conflicted", detail: `${path} has unresolved Git index stages` } };
    }
    if (!ORDINARY_BLOB_MODES.has(row.mode)) {
      return { source: null, mode: row.mode, issue: { path, code: "unsafe_mode", detail: `${path} uses unsupported Git mode ${row.mode}` } };
    }
    return gitBlobEntry(root, path, row.mode, row.oid).read();
  }
  return filesystemEntry(root, path, true).read();
}

export function dirtyIndexedCodePaths(root: string): string[] {
  if (!isGitRepository(root)) return [];
  const paths = [
    ...nulPaths(root, ["diff", "--cached", "--no-ext-diff", "--no-textconv", "--name-only", "--no-renames", "--diff-filter=ACDMRTUXB", "-z", "--"], true),
    ...nulPaths(root, ["diff", "--no-ext-diff", "--no-textconv", "--name-only", "--no-renames", "--diff-filter=ACDMRTUXB", "-z", "--"], true),
    ...nulPaths(root, ["ls-files", "--others", "--exclude-standard", "-z"], true),
  ];
  return [...new Set(paths.filter((item) => item.indexedCode).map((item) => item.path))].sort(compareCodeUnits);
}

export function assertCleanIndexedCode(root: string): void {
  const dirty = dirtyIndexedCodePaths(root);
  if (!dirty.length) return;
  const sample = dirty.slice(0, 5).join(", ");
  const more = dirty.length > 5 ? ` (+${dirty.length - 5} more)` : "";
  throw new Error(`refusing to persist a derived graph from dirty indexed code: ${sample}${more}; commit or stash code changes, then retry`);
}

/** Auxiliary manifests can change graph resolution just like source code. A
 * durable checkout scan must therefore prove these selected paths are clean. */
export function assertCleanAuxiliarySources(root: string, paths: readonly string[]): void {
  if (!isGitRepository(root) || paths.length === 0) return;
  const selected = new Set(paths);
  const dirty = [
    ...nulPaths(root, ["diff", "--cached", "--no-ext-diff", "--name-only", "-z", "--", ...paths], true),
    ...nulPaths(root, ["diff", "--no-ext-diff", "--name-only", "-z", "--", ...paths], true),
    ...nulPaths(root, ["ls-files", "--others", "--exclude-standard", "-z", "--", ...paths], true),
  ].map((entry) => entry.path).filter((path) => selected.has(path));
  const unique = [...new Set(dirty)].sort(compareCodeUnits);
  if (unique.length) throw new Error(`refusing to persist a derived graph from dirty auxiliary source: ${unique.join(", ")}; commit or stash it, then retry`);
}
