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

/** Machine-generated paths that carry no design "why" — lockfiles, build output,
 *  vendored deps, snapshots, source maps. Excluded from synthesis diffs via git
 *  pathspec BEFORE git assembles/orders the patch: a huge lockfile sorts ahead of
 *  src/ alphabetically and would otherwise eat the byte budget and truncate the
 *  real code change away. Exclude-only pathspecs are valid; `**` (glob magic)
 *  matches across directories AND at the repo root. (`*.lock` covers yarn / cargo
 *  / poetry / composer / Gemfile lockfiles.) */
const DIFF_NOISE = [
  ":(exclude,glob)**/package-lock.json",
  ":(exclude,glob)**/npm-shrinkwrap.json",
  ":(exclude,glob)**/pnpm-lock.yaml",
  ":(exclude,glob)**/go.sum",
  ":(exclude,glob)**/*.lock",
  ":(exclude,glob)**/dist/**",
  ":(exclude,glob)**/build/**",
  ":(exclude,glob)**/out/**",
  ":(exclude,glob)**/coverage/**",
  ":(exclude,glob)**/.next/**",
  ":(exclude,glob)**/node_modules/**",
  ":(exclude,glob)**/vendor/**",
  // the Hunch's OWN machine-generated records — re-synthesizing a commit that
  // wrote them would be circular noise, and they're large (JSON per record).
  ":(exclude,glob)**/.hunch/**",
  ":(exclude,glob)**/*.min.js",
  ":(exclude,glob)**/*.map",
  ":(exclude,glob)**/*.snap",
  ":(exclude,glob)**/__snapshots__/**",
  ":(exclude,glob)**/*.generated.*",
];

/** The unified diff for a commit, truncated to keep synthesis prompts bounded.
 *  Machine-generated noise (see DIFF_NOISE) is excluded so the model spends its
 *  budget on code that encodes intent, not on regenerated lockfiles/build output. */
export function commitDiff(sha: string, cwd: string, maxBytes = 60_000): string {
  const out = gitSafe(["show", sha, "--no-color", "--format=", "--unified=2", "--", ...DIFF_NOISE], cwd);
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

/** ISO author-date of the most recent commit touching a file ("" if none). */
export function lastChangeDate(file: string, cwd: string): string {
  return gitSafe(["log", "-1", "--format=%aI", "--", file], cwd);
}

/** Files staged for commit (for `hunch check` pre-commit enforcement). */
export function stagedFiles(cwd: string): string[] {
  const out = gitSafe(["diff", "--cached", "--name-only", "--diff-filter=ACMR"], cwd);
  return out ? out.split("\n").filter(Boolean) : [];
}

/** Unified diff of the staged changes (for the Regression Guard's structural
 *  analysis). Excludes machine-generated noise and truncates at the SAME budget as
 *  commitDiff, so the staged and `--commit` guard paths can't diverge on big diffs. */
export function stagedDiff(cwd: string, maxBytes = 60_000): string {
  const out = gitSafe(["diff", "--cached", "--no-color", "--unified=2", "--", ...DIFF_NOISE], cwd);
  return out.length > maxBytes ? out.slice(0, maxBytes) + "\n…(diff truncated)…" : out;
}

/** Resolve a time-travel ref (commit / tag / branch / HEAD~n) to the ISO author-
 *  date of that commit — the instant valid-time windows are filtered against.
 *  Undefined if it can't be resolved (not a git repo, or an unknown ref). Single
 *  source for the CLI and MCP as-of paths so they can't drift. */
export function asOfDate(ref: string, cwd: string): string | undefined {
  if (!isGitRepo(cwd)) return undefined;
  return commitMeta(revParse(ref, cwd), cwd)?.date || undefined;
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
