/** Co-change (evolutionary coupling) for one file, from git history.
 *
 * Files that changed together with the target in past commits are a
 * deterministic proximity signal (Zimmermann et al. ROSE; Ying et al.): a
 * task that touched such a file is about the same place even when the paths
 * differ. Bounded on purpose: the last N commits touching the target, bulk
 * commits ignored, a hard time limit, and a per-HEAD cache under
 * .hunch-cache so the pre-edit hook never pays twice. Any failure yields an
 * empty map — the ranking term goes to zero, nothing throws. */
import { execFileSync } from "node:child_process";
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { createHash } from "node:crypto";
import { join } from "node:path";
import { headAndBlob, hookActive, knownHead } from "./hookMemo.js";
import type { CochangeStrength } from "./taskRanking.js";

export interface CochangeOptions {
  /** Commits touching the target to inspect (newest first). */
  maxCommits?: number;
  /** Commits touching more files than this are bulk moves, not coupling. */
  maxFilesPerCommit?: number;
  timeoutMs?: number;
  /** Set false to bypass the .hunch-cache read/write (tests). */
  cache?: boolean;
}

function gitEnv(): NodeJS.ProcessEnv {
  const env: NodeJS.ProcessEnv = {};
  for (const [k, v] of Object.entries(process.env)) if (!k.startsWith("GIT_")) env[k] = v;
  env.GIT_OPTIONAL_LOCKS = "0";
  env.GIT_TERMINAL_PROMPT = "0";
  return env;
}

function headSha(root: string, env: NodeJS.ProcessEnv, timeoutMs: number): string | null {
  try { return execFileSync("git", ["-C", root, "rev-parse", "HEAD"], { env, timeout: timeoutMs, encoding: "utf8", stdio: ["ignore", "pipe", "ignore"] }).trim() || null; }
  catch { return null; }
}

/** Parse `git log --format=%H --name-only` output into per-commit file lists. */
export function parseNameOnlyLog(output: string): string[][] {
  const commits: string[][] = [];
  let current: string[] | null = null;
  for (const raw of output.split("\n")) {
    const line = raw.trim();
    if (!line) continue;
    if (/^[0-9a-f]{40}$/.test(line)) { current = []; commits.push(current); continue; }
    current?.push(line.replace(/\\/g, "/"));
  }
  return commits;
}

/** Co-change strength for every file that changed with `file`. */
export function computeCochange(commits: readonly (readonly string[])[], file: string, maxFilesPerCommit: number): Map<string, CochangeStrength> {
  const target = file.replace(/\\/g, "/");
  const counts = new Map<string, number>();
  let touching = 0;
  for (const files of commits) {
    if (!files.includes(target) || files.length > maxFilesPerCommit) continue;
    touching++;
    for (const f of files) if (f !== target) counts.set(f, (counts.get(f) ?? 0) + 1);
  }
  const out = new Map<string, CochangeStrength>();
  if (!touching) return out;
  for (const [f, count] of counts) out.set(f, { count, strength: count / touching });
  return out;
}

export function cochangeFor(root: string, file: string, options: CochangeOptions = {}): Map<string, CochangeStrength> {
  const maxCommits = options.maxCommits ?? 500;
  const maxFiles = options.maxFilesPerCommit ?? 30;
  const timeoutMs = options.timeoutMs ?? 2_000;
  const target = file.replace(/\\/g, "/");
  const env = gitEnv();
  // Inside a hook invocation one git call answers HEAD for every lookup (and the
  // file's blob for the sibling-fix cache read that follows).
  const head = hookActive() ? (knownHead(root) ?? headAndBlob(root, target, env, timeoutMs).head) : headSha(root, env, timeoutMs);
  if (!head) return new Map();
  const cacheDir = join(root, ".hunch-cache", "cochange");
  const cacheFile = join(cacheDir, `${head.slice(0, 12)}-${createHash("sha256").update(`${target}\n${maxCommits}\n${maxFiles}`).digest("hex").slice(0, 16)}.json`);
  if (options.cache !== false && existsSync(cacheFile)) {
    try {
      const parsed = JSON.parse(readFileSync(cacheFile, "utf8")) as Record<string, CochangeStrength>;
      return new Map(Object.entries(parsed));
    } catch { /* recompute */ }
  }
  // `git log -- <file> --name-only` lists only files matching the pathspec, so
  // co-changed files would never appear. Two steps: the commits that touched the
  // target, then each commit's complete file list.
  let output: string;
  try {
    const shas = execFileSync("git", ["-C", root, "log", "--format=%H", "-n", String(maxCommits), "--", target], {
      env, timeout: timeoutMs, encoding: "utf8", maxBuffer: 4_000_000, stdio: ["ignore", "pipe", "ignore"],
    }).split(/\r?\n/).filter((line) => /^[0-9a-f]{40}$/.test(line));
    if (!shas.length) return new Map();
    output = execFileSync("git", ["-C", root, "show", "--format=%H", "--name-only", "--no-renames", ...shas], {
      env, timeout: timeoutMs, encoding: "utf8", maxBuffer: 16_000_000, stdio: ["ignore", "pipe", "ignore"],
    });
  } catch { return new Map(); }
  const result = computeCochange(parseNameOnlyLog(output), target, maxFiles);
  if (options.cache !== false) {
    try {
      mkdirSync(cacheDir, { recursive: true });
      writeFileSync(cacheFile, JSON.stringify(Object.fromEntries(result)));
    } catch { /* cache is a convenience */ }
  }
  return result;
}
