/** Deterministic git introspection for the extractor + learning loop.
 *  No LLM here — just parsing what git already knows. */
import { execFileSync } from "node:child_process";

export interface CommitMeta {
  sha: string;
  shortSha: string;
  subject: string;
  body: string;
  author: string;
  date: string;
  files: string[];
}

function git(args: string[], cwd: string): string {
  // stdio: capture stdout, silence stderr (so "no commits yet" etc. don't leak).
  return execFileSync("git", args, {
    cwd, encoding: "utf8", maxBuffer: 64 * 1024 * 1024,
    stdio: ["ignore", "pipe", "ignore"],
  }).trim();
}

function gitSafe(args: string[], cwd: string): string {
  try {
    return git(args, cwd);
  } catch {
    return "";
  }
}

export function isGitRepo(cwd: string): boolean {
  return gitSafe(["rev-parse", "--is-inside-work-tree"], cwd) === "true";
}

export function headSha(cwd: string): string {
  return gitSafe(["rev-parse", "HEAD"], cwd);
}

/** Resolve any commit-ish (short sha / HEAD / branch) to a canonical full sha.
 *  Returns the input unchanged if it can't be resolved (e.g. not a git repo). */
export function revParse(ref: string, cwd: string): string {
  const r = ref.trim();
  return gitSafe(["rev-parse", "--verify", "--quiet", r], cwd) || r;
}

/** Path to the hooks dir (honors core.hooksPath / worktrees). */
export function hooksDir(cwd: string): string {
  const p = gitSafe(["rev-parse", "--git-path", "hooks"], cwd);
  return p || ".git/hooks";
}

export function gitDir(cwd: string): string {
  return gitSafe(["rev-parse", "--git-dir"], cwd) || ".git";
}

/** Files changed in a single commit. `--root` makes the initial commit (which
 *  has no parent) report its files as additions instead of returning nothing. */
export function commitFiles(sha: string, cwd: string): string[] {
  const out = gitSafe(["diff-tree", "--no-commit-id", "--name-only", "-r", "--root", sha], cwd);
  return out ? out.split("\n").filter(Boolean) : [];
}

/** Full metadata + changed files for a commit. */
export function commitMeta(sha: string, cwd: string): CommitMeta | null {
  const raw = gitSafe(["show", "-s", "--format=%H%x1f%h%x1f%s%x1f%b%x1f%an%x1f%aI", sha], cwd);
  if (!raw) return null;
  const [full = "", short = "", subject = "", body = "", author = "", date = ""] = raw.split("\x1f");
  return { sha: full, shortSha: short, subject, body, author, date, files: commitFiles(sha, cwd) };
}

/** The unified diff for a commit, truncated to keep synthesis prompts bounded. */
export function commitDiff(sha: string, cwd: string, maxBytes = 60_000): string {
  const out = gitSafe(["show", sha, "--no-color", "--format=", "--unified=2"], cwd);
  return out.length > maxBytes ? out.slice(0, maxBytes) + "\n…(diff truncated)…" : out;
}

/** Number of commits touching a file in the last `days` (churn). */
export function fileChurn(file: string, cwd: string, days = 90): number {
  const out = gitSafe(["log", `--since=${days}.days.ago`, "--oneline", "--", file], cwd);
  return out ? out.split("\n").filter(Boolean).length : 0;
}

/** The most recent commit short-sha that touched a file. */
export function lastCommitForFile(file: string, cwd: string): string {
  const sha = gitSafe(["log", "-1", "--format=%h", "--", file], cwd);
  return sha ? `commit:${sha}` : "";
}

/** Translate a backfill window spec into git-log window args.
 *   "90d" / bare "90" -> last 90 days   |   "40c" -> last 40 commits
 *   anything else      -> passed to --since as an approxidate/date string. */
function windowArgs(spec: string, max: number): string[] {
  if (/^\d+c$/i.test(spec)) return ["-n", spec.replace(/c$/i, "")];
  if (/^\d+d$/i.test(spec)) return [`--since=${spec.replace(/d$/i, "")} days ago`, "-n", String(max)];
  if (/^\d+$/.test(spec)) return [`--since=${spec} days ago`, "-n", String(max)];
  return [`--since=${spec}`, "-n", String(max)];
}

/** Recent commits (newest-first) for backfill. */
export function logSince(spec: string, cwd: string, max = 200): string[] {
  const out = gitSafe(["log", ...windowArgs(spec, max), "--format=%H"], cwd);
  return out ? out.split("\n").filter(Boolean) : [];
}

/** Commits that look like bug fixes (for backfill bug seeding). */
export function fixCommits(spec: string, cwd: string, max = 200): string[] {
  const out = gitSafe(
    ["log", ...windowArgs(spec, max), "--format=%H", "--grep=fix", "--grep=bug", "--grep=hotfix", "-i"],
    cwd,
  );
  return out ? out.split("\n").filter(Boolean) : [];
}

/** All tracked files matching the given extensions. */
export function trackedFiles(cwd: string, exts: string[]): string[] {
  const out = gitSafe(["ls-files"], cwd);
  const all = out ? out.split("\n").filter(Boolean) : [];
  return all.filter((f) => exts.some((e) => f.endsWith(e)));
}
