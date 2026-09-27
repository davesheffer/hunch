// Cutoff-bounded memory snapshot for the `current-hunch` arm of `hunch task benchmark`.
// Design: bench/pilot5/GATE-A-HARNESS.md, section "Memory snapshot".
import { spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import { existsSync, lstatSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, readlinkSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { writeFileAtomic } from "../core/io.js";

/** One file removed from a snapshot, with the reason logged in snapshot.json. */
export interface SnapshotDrop {
  path: string;
  reason: string;
}

export interface MemorySnapshotPart {
  revision: string;
  sha256: string;
  files: number;
  dropped: SnapshotDrop[];
}

export interface MemorySnapshot {
  cutoff_at: string;
  public: MemorySnapshotPart;
  private: MemorySnapshotPart | null;
}

const MAX_GIT_OUTPUT = 1024 * 1024 * 1024;

/** The environment every benchmark Git (and audited CLI) child runs under: the
 *  parent's minus every GIT_* variable except GIT_EDITOR and every HUNCH_*
 *  variable, so an inherited GIT_DIR / GIT_INDEX_FILE / overlay pointer can never
 *  redirect a harness command. `extra` is applied after stripping. */
export function benchmarkChildEnv(base: NodeJS.ProcessEnv = process.env, extra: Record<string, string> = {}): Record<string, string> {
  const env: Record<string, string> = {};
  for (const [key, value] of Object.entries(base)) {
    if (value === undefined) continue;
    const upper = key.toUpperCase();
    if (upper.startsWith("GIT_") && upper !== "GIT_EDITOR") continue;
    if (upper.startsWith("HUNCH_")) continue;
    env[key] = value;
  }
  return { ...env, ...extra };
}

export interface GitRun {
  status: number | null;
  stdout: Buffer;
  stderr: string;
}

/** Leading `-c` pairs of every benchmark git call: CRLF conversion off, and no
 *  background maintenance that could hold files while a scratch repo is removed. */
export const BENCHMARK_GIT_CONFIG: readonly string[] = ["-c", "core.autocrlf=false", "-c", "gc.auto=0", "-c", "maintenance.auto=false"];

/** Run git with an argument array (no shell) under BENCHMARK_GIT_CONFIG and the
 *  stripped environment; throws on a non-zero exit unless `allowFailure`. */
export function benchmarkGit(args: string[], opts: { cwd?: string; extraEnv?: Record<string, string>; allowFailure?: boolean } = {}): GitRun {
  const run = spawnSync("git", [...BENCHMARK_GIT_CONFIG, ...args], {
    cwd: opts.cwd,
    env: benchmarkChildEnv(process.env, opts.extraEnv),
    maxBuffer: MAX_GIT_OUTPUT,
    shell: false,
    windowsHide: true,
  });
  if (run.error) throw run.error;
  const result = { status: run.status, stdout: run.stdout, stderr: run.stderr.toString("utf8") };
  if (!opts.allowFailure && run.status !== 0) {
    throw new Error(`git ${args.join(" ")} failed (exit ${run.status}): ${result.stderr.trim()}`);
  }
  return result;
}

/** Trimmed UTF-8 stdout of a git command that must succeed. */
export function benchmarkGitText(args: string[], opts: { cwd?: string; extraEnv?: Record<string, string> } = {}): string {
  return benchmarkGit(args, opts).stdout.toString("utf8").trim();
}

/** The last commit on `ref` whose committer date is at or before the cutoff
 *  (first-parent by default), or null when there is none. */
export function memoryRevisionAt(repo: string, ref: string, cutoffIso: string, firstParent = true): string | null {
  const args = ["-C", repo, "rev-list", "-1", ...(firstParent ? ["--first-parent"] : []), `--before=${cutoffIso}`, ref];
  const rev = benchmarkGitText(args);
  return rev === "" ? null : rev;
}

/** Write the `.hunch/` subtree of `rev` into `dest` (dest holds the .hunch
 *  contents) through a throwaway index, never touching the repository's own index
 *  or worktree. A revision without `.hunch/` yields an empty dest. Returns the
 *  number of files written. */
export function extractHunchTree(repo: string, rev: string, dest: string): number {
  mkdirSync(dest, { recursive: true });
  const probe = benchmarkGit(["-C", repo, "cat-file", "-t", `${rev}:.hunch`], { allowFailure: true });
  if (probe.status !== 0 || probe.stdout.toString("utf8").trim() !== "tree") return 0;
  const session = mkdtempSync(join(tmpdir(), "hunch-bench-index-"));
  const extraEnv = { GIT_INDEX_FILE: join(session, "index") };
  try {
    benchmarkGit(["-C", repo, "read-tree", `${rev}:.hunch`], { extraEnv });
    const prefix = `${resolve(dest).replace(/\\/g, "/").replace(/\/+$/, "")}/`;
    benchmarkGit(["-C", repo, "checkout-index", "-a", "-f", `--prefix=${prefix}`], { extraEnv });
    const listed = benchmarkGit(["-C", repo, "ls-files", "-z"], { extraEnv }).stdout.toString("utf8");
    return listed.split("\0").filter((p) => p !== "").length;
  } finally {
    rmSync(session, { recursive: true, force: true, maxRetries: 10, retryDelay: 100 });
  }
}

const CAPTURE_FIELDS = ["created_at", "createdAt", "captured_at", "recorded_at", "started_at", "timestamp", "valid_from"] as const;
const STORE_POINTERS = ["team.json", "local.json"] as const;

/** Relative (forward-slash) paths of every file under `dir`, recursively. */
function listFiles(dir: string, prefix = ""): string[] {
  if (!existsSync(dir)) return [];
  const out: string[] = [];
  for (const entry of readdirSync(dir, { withFileTypes: true })) {
    const rel = prefix ? `${prefix}/${entry.name}` : entry.name;
    if (entry.isDirectory()) out.push(...listFiles(join(dir, entry.name), rel));
    else out.push(rel);
  }
  return out;
}

/** Secondary cutoff guard: drop the store pointers (they would point the store
 *  outside the snapshot) and every JSON record whose own earliest capture
 *  timestamp is at or after the cutoff. Files without such a field are kept.
 *  Returns every drop with its reason. */
export function applyCutoffGuard(dir: string, cutoffIso: string): SnapshotDrop[] {
  const cutoff = Date.parse(cutoffIso);
  if (Number.isNaN(cutoff)) throw new Error(`invalid cutoff timestamp: ${cutoffIso}`);
  const dropped: SnapshotDrop[] = [];
  for (const name of STORE_POINTERS) {
    const file = join(dir, name);
    if (!existsSync(file)) continue;
    rmSync(file, { force: true });
    dropped.push({ path: name, reason: "store pointer would point outside the snapshot" });
  }
  for (const rel of listFiles(dir).filter((p) => p.endsWith(".json")).sort()) {
    let value: unknown;
    try {
      value = JSON.parse(readFileSync(join(dir, rel), "utf8"));
    } catch {
      continue;
    }
    if (!value || typeof value !== "object" || Array.isArray(value)) continue;
    const record = value as Record<string, unknown>;
    let earliest: { field: string; value: string; at: number } | null = null;
    for (const field of CAPTURE_FIELDS) {
      const raw = record[field];
      if (typeof raw !== "string") continue;
      const at = Date.parse(raw);
      if (Number.isNaN(at)) continue;
      if (!earliest || at < earliest.at) earliest = { field, value: raw, at };
    }
    if (!earliest || earliest.at < cutoff) continue;
    rmSync(join(dir, rel), { force: true });
    dropped.push({ path: rel, reason: `capture ${earliest.field}=${earliest.value} >= cutoff` });
  }
  return dropped;
}

function sha256(data: string | Buffer): string {
  return createHash("sha256").update(data).digest("hex");
}

/** sha256 over sorted `relpath \0 sha256(bytes) \n` lines for the given files
 *  (relative to `root`, forward slashes). A symlink hashes as its target text. */
export function hashFileList(root: string, relpaths: string[]): { sha256: string; files: number } {
  const lines = relpaths.map((rel) => {
    const file = join(root, rel);
    const bytes = lstatSync(file).isSymbolicLink() ? Buffer.from(readlinkSync(file), "utf8") : readFileSync(file);
    return `${rel}\0${sha256(bytes)}\n`;
  });
  lines.sort();
  return { sha256: sha256(lines.join("")), files: lines.length };
}

/** Content hash of every file under `dir` (see hashFileList). A missing dir is empty. */
export function hashTree(dir: string): { sha256: string; files: number } {
  return hashFileList(dir, listFiles(dir));
}

function buildPart(repo: string, ref: string, cutoffIso: string, dest: string, label: string): MemorySnapshotPart {
  const revision = memoryRevisionAt(repo, ref, cutoffIso, true);
  if (!revision) throw new Error(`no ${label} memory revision: ${ref} in ${repo} has no first-parent commit at or before ${cutoffIso}`);
  extractHunchTree(repo, revision, dest);
  const dropped = applyCutoffGuard(dest, cutoffIso);
  const { sha256: hash, files } = hashTree(dest);
  return { revision, sha256: hash, files, dropped };
}

/** An existing snapshot is reused only when its record still describes the
 *  trees on disk and the revisions the cutoff selects today; a frozen snapshot is
 *  never rebuilt in place. */
function reuseSnapshot(opts: { sourceRepo: string; sourceRef: string; privateRepo: string | null; privateRef?: string; cutoffIso: string; dest: string }): MemorySnapshot | null {
  const record = join(opts.dest, "snapshot.json");
  const partial = ["public", "private"].some((part) => listFiles(join(opts.dest, part)).length > 0);
  if (!existsSync(record)) {
    if (partial) throw new Error(`refusing to rebuild the memory snapshot into non-empty ${opts.dest} without snapshot.json; remove it first`);
    return null;
  }
  const stored = JSON.parse(readFileSync(record, "utf8")) as MemorySnapshot;
  const matches = (part: MemorySnapshotPart | null, repo: string | null, ref: string, dir: string): boolean => {
    if (!repo) return part === null;
    return !!part
      && part.revision === memoryRevisionAt(repo, ref, opts.cutoffIso, true)
      && part.sha256 === hashTree(dir).sha256;
  };
  if (stored.cutoff_at === opts.cutoffIso
    && matches(stored.public, opts.sourceRepo, opts.sourceRef, join(opts.dest, "public"))
    && matches(stored.private, opts.privateRepo, opts.privateRef ?? "HEAD", join(opts.dest, "private"))) {
    return stored;
  }
  throw new Error(`memory snapshot at ${opts.dest} no longer matches its snapshot.json; remove it to rebuild`);
}

/** Freeze the cutoff-bounded public (and optional private overlay) memory into
 *  `<dest>/public` and `<dest>/private`, hashed, with every guard drop logged in
 *  `<dest>/snapshot.json`. */
export function buildMemorySnapshot(opts: {
  sourceRepo: string;
  sourceRef: string;
  privateRepo: string | null;
  privateRef?: string;
  cutoffIso: string;
  dest: string;
}): MemorySnapshot {
  const reused = reuseSnapshot(opts);
  if (reused) return reused;
  const snapshot: MemorySnapshot = {
    cutoff_at: opts.cutoffIso,
    public: buildPart(opts.sourceRepo, opts.sourceRef, opts.cutoffIso, join(opts.dest, "public"), "public"),
    private: opts.privateRepo
      ? buildPart(opts.privateRepo, opts.privateRef ?? "HEAD", opts.cutoffIso, join(opts.dest, "private"), "private")
      : null,
  };
  mkdirSync(opts.dest, { recursive: true });
  writeFileAtomic(join(opts.dest, "snapshot.json"), JSON.stringify(snapshot, null, 2) + "\n");
  return snapshot;
}
