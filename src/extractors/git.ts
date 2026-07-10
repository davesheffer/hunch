/** Deterministic git introspection for the extractor + learning loop.
 *  No LLM here — just parsing what git already knows. */
import { execFileSync } from "node:child_process";
import { isAbsolute, resolve, join, basename, dirname } from "node:path";
import { mkdirSync, rmSync, statSync, realpathSync, readFileSync } from "node:fs";

export interface CommitMeta {
  sha: string;
  shortSha: string;
  subject: string;
  body: string;
  author: string;
  date: string;
  files: string[];
}

function git(args: string[], cwd: string, maxBuffer = 64 * 1024 * 1024): string {
  // stdio: capture stdout, silence stderr (so "no commits yet" etc. don't leak).
  return execFileSync("git", args, {
    cwd, encoding: "utf8", maxBuffer,
    stdio: ["ignore", "pipe", "ignore"],
  }).trim();
}

function gitSafe(args: string[], cwd: string, maxBuffer?: number): string {
  try {
    return git(args, cwd, maxBuffer);
  } catch {
    return "";
  }
}

function gitRawSafe(args: string[], cwd: string, maxBuffer = 64 * 1024 * 1024): string | null {
  try {
    return execFileSync("git", args, {
      cwd, encoding: "utf8", maxBuffer,
      stdio: ["ignore", "pipe", "ignore"],
    });
  } catch {
    return null;
  }
}

export function isGitRepo(cwd: string): boolean {
  return gitSafe(["rev-parse", "--is-inside-work-tree"], cwd) === "true";
}

/** The MAIN worktree's root — the stable anchor for an overlay store. A linked worktree
 *  can be `git worktree remove`d, so anything anchored inside it (an overlay clone, an
 *  absolute pointer target) silently dies for every OTHER worktree; the main checkout
 *  can't be removed. Falls back to `root` when the layout isn't the standard `.git` dir
 *  (or not a git repo), preserving today's behavior. */
export function mainWorktreeRoot(root: string): string {
  const common = gitCommonDir(root);
  if (!common) return root;
  const abs = resolve(root, common);
  return basename(abs) === ".git" ? dirname(abs) : root;
}

/** Best-effort: stage ONLY the hunch dir, commit, and push the repo it lives in. Shared by
 *  the post-commit auto-commit (CLI sync --commit), MCP private writes, and `hunch private
 *  --sync`. HUNCH_SYNC=1 stops the created commit from re-triggering the post-commit hook
 *  (no recursion). Stages with a pathspec scoped to `hunchDir`, so it never sweeps unrelated
 *  working-tree changes. Never throws — a non-repo dir / offline push just no-ops.
 *  `push: false` commits WITHOUT merging or pushing — required when hunchDir is the PUBLIC
 *  .hunch/ inside the user's code repo: an automatic pull/push there would merge the remote
 *  into their working branch and publish their unpushed code commits. The memory commit
 *  simply rides the user's next push.
 *  Returns what ACTUALLY happened, so callers never report a commit that was skipped:
 *  "pushed" (commit created and pushed), "committed" (commit created; push not requested,
 *  or the merge/push failed — retry rides the next flush), null (nothing committed: lock
 *  held, backstop refusal, nothing staged, or not a repo). */
export function commitAndPushHunch(hunchDir: string, message: string, opts: { push?: boolean } = {}): "pushed" | "committed" | null {
  // Serialize across worktrees: several worktrees auto-committing the SAME overlay repo
  // at once would race git's index.lock. An atomic-mkdir lock lets one proceed; the others
  // skip — safe because each record is already written to disk, so `git add .` here sweeps
  // up anything a skipped run left pending (eventually-consistent, never lost).
  const lock = join(hunchDir, ".hunch-commit.lock");
  if (!acquireCommitLock(lock)) return null;
  try {
    const env = { ...process.env, HUNCH_SYNC: "1" };
    const run = (args: string[]): void => {
      try {
        execFileSync("git", ["-C", hunchDir, ...args], { stdio: "ignore", env });
      } catch { /* best-effort: nothing staged / not a repo / offline */ }
    };
    run(["add", "--", "."]);
    // SAFETY BACKSTOP (critical — bug_overlay_clobber): a memory sync is PURELY ADDITIVE small
    // JSON. If the staged set contains a DELETION, rename, or any non-.json file, hunchDir is NOT
    // a clean overlay store — most dangerously, the overlay was never its own git repo so `git -C`
    // walked UP to the PROJECT repo. Committing/pushing there would overwrite/delete the user's
    // code (we shipped exactly this). Refuse hard: unstage and bail without committing or pushing.
    if (!stagedIsMemoryOnly(hunchDir, env)) {
      try { execFileSync("git", ["-C", hunchDir, "reset", "-q", "--", "."], { stdio: "ignore", env }); } catch { /* best-effort unstage */ }
      // Public-store commits (push:false) skip QUIETLY: a non-memory staged set there is
      // usually just the user's own staged work, not a misconfigured overlay — the record
      // stays on disk and the next flush's `git add .` sweeps it up. The overlay path
      // stays loud: there it signals the escaped-to-project-repo misconfiguration.
      if (opts.push !== false) {
        console.error(`hunch: refusing to auto-commit memory at "${hunchDir}" — the staged change includes deletions or non-memory files, so this is not a clean overlay repo. Nothing was committed or pushed. (Use \`hunch shared --repo <url>\` so the overlay is its OWN git repo.)`);
      }
      return null;
    }
    // Only sync+push when a memory commit was actually created — never run pull/push against the
    // enclosing repo on an empty stage. Two-way sync: MERGE the remote BEFORE pushing so a push
    // can't be rejected non-fast-forward; the .hunch merge driver resolves same-record conflicts
    // by id. On conflict/offline, mergeRemote aborts to a clean tree and we skip the push.
    let committed = false;
    try { execFileSync("git", ["-C", hunchDir, "commit", "-m", message], { stdio: "ignore", env }); committed = true; } catch { /* nothing staged / not a repo */ }
    if (!committed) return null;
    if (opts.push !== false && mergeRemote(hunchDir, env)) {
      // Push tracked (not via run): a no-upstream/offline/rejected push must report
      // "committed", not overclaim "pushed" — the next flush's merge+push retries.
      try { execFileSync("git", ["-C", hunchDir, "push"], { stdio: "ignore", env }); return "pushed"; } catch { /* offline / no upstream */ }
    }
    return "committed";
  } finally {
    try { rmSync(lock, { recursive: true, force: true }); } catch { /* released best-effort */ }
  }
}

/** Is the staged set a clean, MEMORY-ONLY change — only JSON record adds/updates, nothing else?
 *  The overlay store is entirely JSON (decisions/, bugs/, …, manifest.json). A real memory sync
 *  is purely additive; a DELETION, rename, or any non-.json staged path means hunchDir is NOT a
 *  clean overlay repo (e.g. it resolved to the project repo), so committing there would clobber
 *  code. Empty stage ⇒ false (nothing to commit). The transient mkdir lock is ignored. */
function stagedIsMemoryOnly(hunchDir: string, env: NodeJS.ProcessEnv): boolean {
  let out = "";
  try { out = execFileSync("git", ["-C", hunchDir, "diff", "--cached", "--name-status"], { encoding: "utf8", env }); }
  catch { return false; }
  const lines = out.split("\n").map((l) => l.trim()).filter(Boolean);
  if (!lines.length) return false;
  for (const line of lines) {
    const parts = line.split("\t");
    const status = (parts[0] ?? "").trim();
    const path = (parts[parts.length - 1] ?? "").trim();
    if (path.includes(".hunch-commit.lock")) continue; // transient lock dir, never a record
    if (!/^[AM]$/.test(status)) return false; // only Add / Modify — any D/R/C/T → not a memory sync
    if (!path.endsWith(".json")) return false; // the store is entirely JSON records
  }
  return true;
}

/** Merge the overlay's remote into the local branch (pull, no rebase), leaving a CLEAN tree
 *  whether it succeeds or not. Returns true when the branch is safe to push (merged, or there's
 *  no upstream to merge), false when a conflict was aborted (caller skips the push and retries
 *  on the next write). Never throws. */
function mergeRemote(hunchDir: string, env: NodeJS.ProcessEnv): boolean {
  const tryGit = (args: string[]): boolean => {
    try { execFileSync("git", ["-C", hunchDir, ...args], { stdio: "ignore", env }); return true; }
    catch { return false; }
  };
  if (!tryGit(["rev-parse", "--abbrev-ref", "@{upstream}"])) return true; // no remote/offline → push no-ops
  if (tryGit(["pull", "--no-edit", "--no-rebase", "--autostash"])) return true;
  tryGit(["merge", "--abort"]); // conflict the driver couldn't resolve → restore a clean tree
  return false;
}

/** Best-effort READ-side sync: merge the overlay's remote into the local branch (e.g. on MCP
 *  server start) so this machine/session sees other machines' memory. Never throws; leaves a
 *  clean tree. Serialized with the commit lock so it can't race a concurrent flush. */
export function pullHunch(hunchDir: string): void {
  const lock = join(hunchDir, ".hunch-commit.lock");
  if (!acquireCommitLock(lock)) return;
  try {
    mergeRemote(hunchDir, { ...process.env, HUNCH_SYNC: "1" });
  } finally {
    try { rmSync(lock, { recursive: true, force: true }); } catch { /* released best-effort */ }
  }
}

/** Atomic mkdir lock; reclaims a stale lock (a crashed holder) older than 60s. Returns
 *  false when another live holder owns it — the caller skips rather than blocks. */
function acquireCommitLock(lock: string): boolean {
  try {
    mkdirSync(lock);
    return true;
  } catch {
    try {
      if (Date.now() - statSync(lock).mtimeMs > 60_000) {
        rmSync(lock, { recursive: true, force: true });
        mkdirSync(lock);
        return true;
      }
    } catch { /* lock vanished or races another reclaimer — treat as held */ }
    return false;
  }
}

export function headSha(cwd: string): string {
  return gitSafe(["rev-parse", "HEAD"], cwd);
}

/** Stop tracking `paths` in git (remove from the INDEX only — keep the working-tree
 *  files). Used by `hunch private --migrate` to un-publish the .hunch memory tree
 *  without deleting it locally. `--ignore-unmatch` makes an already-untracked path a
 *  no-op rather than an error; best-effort (a non-repo dir just no-ops). */
export function gitUntrackCached(cwd: string, paths: string[]): void {
  if (paths.length === 0) return;
  try {
    execFileSync("git", ["-C", cwd, "rm", "-r", "--cached", "--quiet", "--ignore-unmatch", "--", ...paths], { stdio: "ignore" });
  } catch { /* best-effort: not a repo / nothing tracked */ }
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

/** The SHARED git dir for the repo — identical across ALL linked worktrees (unlike
 *  `gitDir`, which is per-worktree). Absolute, so callers can anchor worktree-shared
 *  state (the private-overlay pointer) at one stable place. "" when not a git repo. */
export function gitCommonDir(cwd: string): string {
  const p = gitSafe(["rev-parse", "--git-common-dir"], cwd);
  if (!p) return "";
  return isAbsolute(p) ? p : resolve(cwd, p);
}

/** True when `cwd` is inside a LINKED worktree (not the main checkout): its own git
 *  dir differs from the shared common dir. Used by `hunch doctor` and setup messaging. */
export function isLinkedWorktree(cwd: string): boolean {
  const common = gitCommonDir(cwd);
  const own = gitSafe(["rev-parse", "--absolute-git-dir"], cwd);
  if (!common || !own) return false;
  // realpath BOTH before comparing: `--absolute-git-dir` is symlink-resolved while
  // gitCommonDir is not, so on macOS the main checkout would otherwise mismatch on
  // /var vs /private/var and falsely read as "linked".
  const norm = (p: string): string => { try { return realpathSync(p); } catch { return resolve(p); } };
  return norm(own) !== norm(common);
}

/** Current branch name (e.g. "main", "feat/x"), or "" in detached HEAD / non-repo.
 *  Stamped onto auto-captured decisions so branch-scoped work stays filterable. */
export function currentBranch(cwd: string): string {
  const b = gitSafe(["rev-parse", "--abbrev-ref", "HEAD"], cwd);
  return b === "HEAD" ? "" : b; // detached HEAD reports "HEAD" — treat as no branch
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

export interface CommitFileChange {
  status: "added" | "modified" | "deleted" | "renamed" | "copied";
  before: string | null;
  after: string | null;
}

/** First-parent and exact blob seams for deterministic before/after analysis.
 * They never check out a ref or mutate the active worktree. */
export function firstParent(sha: string, cwd: string): string | null {
  const row = gitSafe(["rev-list", "--parents", "-n", "1", sha], cwd);
  const parts = row.split(/\s+/).filter(Boolean);
  return parts.length > 1 ? parts[1]! : null;
}

export function fileAtRef(ref: string, file: string, cwd: string): string | null {
  return gitRawSafe(["show", `${ref}:${file}`], cwd);
}

/** Name-status records for one commit, rename-aware and NUL-delimited so paths
 * with whitespace cannot corrupt the parser. */
export function commitChanges(sha: string, cwd: string): CommitFileChange[] {
  const raw = gitRawSafe(["diff-tree", "--root", "--no-commit-id", "--name-status", "-r", "-M", "-z", sha], cwd);
  if (raw == null) return [];
  const fields = raw.split("\0").filter((v) => v !== "");
  const out: CommitFileChange[] = [];
  for (let i = 0; i < fields.length;) {
    const code = fields[i++]!;
    const kind = code[0];
    if (kind === "R" || kind === "C") {
      const before = fields[i++] ?? null;
      const after = fields[i++] ?? null;
      if (before && after) out.push({ status: kind === "R" ? "renamed" : "copied", before, after });
      continue;
    }
    const file = fields[i++] ?? null;
    if (!file) continue;
    if (kind === "A") out.push({ status: "added", before: null, after: file });
    else if (kind === "D") out.push({ status: "deleted", before: file, after: null });
    else out.push({ status: "modified", before: file, after: file });
  }
  return out;
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

/** Full SHA of the commit that introduced a path. Unlike lastCommitForFile this
 * remains stable when lifecycle/proof updates later touch the same policy file. */
export function firstCommitForFile(file: string, cwd: string): string {
  // Deliberately do NOT use --follow: content-similar, immutable-ID JSON policy
  // files can be misclassified as renames of one another, moving valid_from to a
  // different policy's introduction commit.
  const added = gitSafe(["log", "--diff-filter=A", "--format=%H", "--", file], cwd)
    .split("\n").find(Boolean);
  if (added) return added;
  return gitSafe(["log", "--reverse", "--format=%H", "--", file], cwd).split("\n").find(Boolean) ?? "";
}

/** ISO author-date of the most recent commit touching a file ("" if none). */
export function lastChangeDate(file: string, cwd: string): string {
  return gitSafe(["log", "-1", "--format=%aI", "--", file], cwd);
}

/** Batched per-file git metrics for indexing: churn (commits touching the file in
 *  the last `days`; pass 0 to skip) and the most-recent commit (`commit:<sha>`).
 *
 *  Replaces the indexer's O(files) × 2 `git log` spawns — which dominate
 *  `hunch index` wall-time on a large repo, especially on Windows where process
 *  creation is costly — with ONE `git log` pass each. Only paths present in `want`
 *  are returned (every requested path gets an entry, defaulting to 0 / ""). */
export function fileGitMetrics(
  cwd: string,
  want: Iterable<string>,
  days = 90,
): Map<string, { churn: number; lastCommit: string }> {
  const out = new Map<string, { churn: number; lastCommit: string }>();
  for (const f of want) out.set(f, { churn: 0, lastCommit: "" });
  if (out.size === 0) return out;

  // churn — one windowed log; tally each wanted path's appearances (= commits).
  if (days > 0) {
    const raw = gitSafe(["log", `--since=${days}.days.ago`, "--name-only", "--format="], cwd);
    if (raw) {
      for (const line of raw.split("\n")) {
        const e = line && out.get(line);
        if (e) e.churn++;
      }
    }
  }

  // last commit — one newest-first log; the FIRST time a path appears is its most
  // recent commit. NUL-prefixed lines mark commit boundaries; the rest are paths.
  // 256MB buffer for the all-history name-only stream on large repos.
  const raw = gitSafe(["log", "--name-only", "--format=%x00%h"], cwd, 256 * 1024 * 1024);
  if (raw) {
    let remaining = out.size;
    let sha = "";
    for (const line of raw.split("\n")) {
      if (line.charCodeAt(0) === 0) { sha = line.slice(1); continue; }
      if (!line) continue;
      const e = out.get(line);
      if (e && !e.lastCommit && sha) {
        e.lastCommit = `commit:${sha}`;
        if (--remaining === 0) break; // every wanted path resolved — stop scanning
      }
    }
  }
  return out;
}

/** Files staged for commit (for `hunch check` pre-commit enforcement). */
export function stagedFiles(cwd: string): string[] {
  const out = gitSafe(["diff", "--cached", "--name-only", "--diff-filter=ACMR"], cwd);
  return out ? out.split("\n").filter(Boolean) : [];
}

/** Files changed anywhere in the working tree compared with HEAD: both staged
 * and unstaged tracked files, plus untracked files. This powers the local,
 * pre-commit Change Gate; it never mutates the index or asks an agent/model. */
export function workingFiles(cwd: string): string[] {
  const changed = gitSafe(["diff", "HEAD", "--name-only", "--diff-filter=ACMR"], cwd).split("\n").filter(Boolean);
  const untracked = gitSafe(["ls-files", "--others", "--exclude-standard"], cwd).split("\n").filter(Boolean);
  return [...new Set([...changed, ...untracked])].sort();
}

/** Does a ref resolve to a commit in this repo? Lets `--base` fail LOUDLY on an
 *  unfetched/typo'd ref instead of silently diffing against nothing (a vacuous
 *  CI pass), since the diff helpers below swallow git errors to "". */
export function revExists(ref: string, cwd: string): boolean {
  return gitSafe(["rev-parse", "--verify", "--quiet", `${ref}^{commit}`], cwd) !== "";
}

/** Files a PR/branch changes vs `base` (3-dot: changes on HEAD since the merge-base,
 *  i.e. exactly the PR's own commits — the CI Constraint Guard's surface). */
export function rangeFiles(base: string, cwd: string, head = "HEAD"): string[] {
  const out = gitSafe(["diff", "--name-only", "--diff-filter=ACMR", `${base}...${head}`], cwd);
  return out ? out.split("\n").filter(Boolean) : [];
}

/** Commit subjects on `head` since `base` (2-dot: commits added by the task),
 *  oldest-first, for distilling a runbook's ordered steps (roadmap #5). */
export function rangeSubjects(base: string, cwd: string, head = "HEAD", max = 50): string[] {
  const out = gitSafe(["log", "--reverse", `-n${max}`, "--format=%s", `${base}..${head}`], cwd);
  return out ? out.split("\n").filter(Boolean) : [];
}

/** The PR's unified diff vs `base` (3-dot), for the Regression Guard's structural
 *  analysis. Same noise-exclusion + truncation budget as commit/staged diffs. */
export function rangeDiff(base: string, cwd: string, head = "HEAD", maxBytes = 60_000): string {
  const out = gitSafe(["diff", "--no-color", "--unified=2", `${base}...${head}`, "--", ...DIFF_NOISE], cwd);
  return out.length > maxBytes ? out.slice(0, maxBytes) + "\n…(diff truncated)…" : out;
}

/** Unified diff of the staged changes (for the Regression Guard's structural
 *  analysis). Excludes machine-generated noise and truncates at the SAME budget as
 *  commitDiff, so the staged and `--commit` guard paths can't diverge on big diffs. */
export function stagedDiff(cwd: string, maxBytes = 60_000): string {
  const out = gitSafe(["diff", "--cached", "--no-color", "--unified=2", "--", ...DIFF_NOISE], cwd);
  return out.length > maxBytes ? out.slice(0, maxBytes) + "\n…(diff truncated)…" : out;
}

/** Unified diff of the complete local working tree vs HEAD. Git's normal diff
 * includes both staged and unstaged tracked edits; untracked text files are
 * appended as synthetic additions so guards can also see their added symbols.
 * Binary/unreadable files remain in workingFiles (scope checks still apply) but
 * intentionally contribute no synthetic content to regression analysis. */
export function workingDiff(cwd: string, maxBytes = 60_000): string {
  let out = gitSafe(["diff", "HEAD", "--no-color", "--unified=2", "--", ...DIFF_NOISE], cwd);
  const tracked = new Set(gitSafe(["diff", "HEAD", "--name-only", "--diff-filter=ACMR"], cwd).split("\n").filter(Boolean));
  const untracked = gitSafe(["ls-files", "--others", "--exclude-standard"], cwd).split("\n").filter((f) => f && !tracked.has(f));
  for (const file of untracked) {
    try {
      const text = readFileSync(join(cwd, file), "utf8");
      if (text.includes("\0")) continue;
      const lines = text.split("\n");
      const add = lines.map((line) => `+${line}`).join("\n");
      out += `${out ? "\n" : ""}diff --git a/${file} b/${file}\nnew file mode 100644\n--- /dev/null\n+++ b/${file}\n@@ -0,0 +1,${lines.length} @@\n${add}\n`;
    } catch { /* unreadable / directory / binary: scope-only is still safe */ }
  }
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
