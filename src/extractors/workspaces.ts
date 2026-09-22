/**
 * Workspace snapshot — THIS machine's worktrees and local branches, read from git with a
 * fixed set of commands (docs/workspace-ledger.md). Deterministic, no LLM, no network
 * unless `fetch` is explicitly requested.
 *
 * Every git invocation here uses execFileSync with a literal argv (never a shell), passes
 * refs after `--end-of-options` / `--`, runs under `foreignRepoEnv` (so a hook's GIT_DIR
 * cannot redirect a per-worktree query), and has a timeout. Paths come from
 * `git worktree list` on this machine only — never from a stored record.
 */
import { execFileSync, spawnSync } from "node:child_process";
import { existsSync, realpathSync, statSync } from "node:fs";
import { join } from "node:path";
import { foreignRepoEnv, gitCommonDir, mainWorktreeRoot, stableRepositoryName } from "./git.js";
import { extracted } from "../core/types.js";
import {
  CONTROL_CHARS, MAX_BRANCHES, MAX_WORKTREES, WORKSPACE_SCHEMA_VERSION, WorkspaceSchema, isSafeBranchName, workspaceId, worktreeId,
  type MergedVerdict, type Workspace, type WorkspaceBranch, type WorkspaceWorktree,
} from "../core/workspace.js";
import type { MachineIdentity } from "../core/machine.js";

const SHA = /^(?:[0-9a-f]{40}|[0-9a-f]{64})$/;
const MAX_OUTPUT = 64 * 1024 * 1024;
/** How far back in the default branch a squash-merge is searched for. */
export const DEFAULT_SQUASH_SEARCH_COMMITS = 2000;

export interface SnapshotOptions {
  machine: MachineIdentity;
  publish: "full" | "branches";
  /** Run `git fetch --prune` first. Off by default: hooks must stay offline-safe. */
  fetch?: boolean;
  now?: Date;
  squashSearchCommits?: number;
  /** Record bound override (tests). Never above the schema's MAX_BRANCHES. */
  maxBranches?: number;
}

function env(): NodeJS.ProcessEnv {
  // GIT_OPTIONAL_LOCKS=0: a read-only snapshot (it runs from hooks, in the background) must
  // never take the index lock `git status` would otherwise grab to refresh stat data.
  return { ...foreignRepoEnv(process.env), GIT_OPTIONAL_LOCKS: "0" };
}

function run(cwd: string, args: string[], timeout = 10_000): string | null {
  try {
    return execFileSync("git", args, { cwd, encoding: "utf8", maxBuffer: MAX_OUTPUT, env: env(), timeout, stdio: ["ignore", "pipe", "ignore"] });
  } catch {
    return null;
  }
}

/** Exit status of a git predicate: 0 → true, 1 → false, anything else (git missing,
 *  timeout, fatal) → null. Never collapse "no" and "error" (the CommitRepairStatus rule). */
function predicate(cwd: string, args: string[]): boolean | null {
  const r = spawnSync("git", args, { cwd, env: env(), timeout: 10_000, stdio: "ignore" });
  if (r.error || r.status === null) return null;
  if (r.status === 0) return true;
  return r.status === 1 ? false : null;
}

function sha(value: string | null): string | null {
  const v = value?.trim() ?? "";
  return SHA.test(v) ? v : null;
}

function iso(value: string | null): string | null {
  const v = value?.trim() ?? "";
  if (!v || !Number.isFinite(Date.parse(v))) return null;
  return new Date(v).toISOString();
}

interface DefaultBranch { name: string; ref: string; head: string }

/** origin/HEAD → origin/main|master → local main|master. Null when none resolves: every
 *  verdict is then `unknown`, never `unmerged`. */
function defaultBranch(root: string): DefaultBranch | null {
  const candidates: Array<{ name: string; ref: string; full: string }> = [];
  const symbolic = run(root, ["symbolic-ref", "-q", "refs/remotes/origin/HEAD"])?.trim();
  if (symbolic?.startsWith("refs/remotes/origin/")) {
    const name = symbolic.slice("refs/remotes/origin/".length);
    candidates.push({ name, ref: `origin/${name}`, full: symbolic });
  }
  for (const name of ["main", "master"]) {
    candidates.push({ name, ref: `origin/${name}`, full: `refs/remotes/origin/${name}` });
  }
  for (const name of ["main", "master"]) candidates.push({ name, ref: name, full: `refs/heads/${name}` });
  for (const c of candidates) {
    if (!isSafeBranchName(c.name)) continue;
    const head = sha(run(root, ["rev-parse", "--verify", "-q", "--end-of-options", `${c.full}^{commit}`]));
    if (head) return { name: c.name, ref: c.ref, head };
  }
  return null;
}

interface RawWorktree { path: string; head: string; branch: string | null; locked: boolean; prunable: boolean; bare: boolean }

function listWorktrees(root: string): RawWorktree[] {
  const out = run(root, ["worktree", "list", "--porcelain"]) ?? "";
  const items: RawWorktree[] = [];
  let cur: Partial<RawWorktree> | null = null;
  const flush = () => {
    if (cur?.path && cur.head) items.push({ path: cur.path, head: cur.head, branch: cur.branch ?? null, locked: !!cur.locked, prunable: !!cur.prunable, bare: !!cur.bare });
    cur = null;
  };
  for (const line of out.split("\n")) {
    if (!line.trim()) { flush(); continue; }
    if (line.startsWith("worktree ")) { flush(); cur = { path: line.slice(9) }; continue; }
    if (!cur) continue;
    if (line.startsWith("HEAD ")) cur.head = sha(line.slice(5)) ?? undefined;
    else if (line.startsWith("branch refs/heads/")) { const b = line.slice("branch refs/heads/".length); cur.branch = isSafeBranchName(b) ? b : null; }
    else if (line === "detached") cur.branch = null;
    else if (line === "locked" || line.startsWith("locked ")) cur.locked = true;
    else if (line === "prunable" || line.startsWith("prunable ")) cur.prunable = true;
    else if (line === "bare") cur.bare = true;
  }
  flush();
  return items.filter((w) => !w.bare);
}

/** `git status --porcelain` is non-empty → uncommitted or untracked work that
 *  `git worktree remove` would refuse to discard. null when the path is gone.
 *  `--untracked-files=all` is explicit: `status.showUntrackedFiles=no` in the user's config
 *  would otherwise hide an untracked source file and report the worktree clean. */
function isDirty(path: string): boolean | null {
  if (!existsSync(path)) return null;
  const out = run(path, ["status", "--porcelain", "--untracked-files=all"]);
  return out === null ? null : out.trim().length > 0;
}

/** Bound on the ignored paths NAMED in a prune plan; the total is always reported. */
export const MAX_IGNORED_SHOWN = 10;

/** Ignored files and directories in a worktree — what `git worktree remove` (without
 *  `--force`) deletes silently. Not a refusal (every Node worktree has node_modules/), but a
 *  prune plan and its confirmation name them. An ignored directory is one entry. Read live
 *  for this machine's plan only; never stored in a record. null when git cannot tell. */
export function ignoredPaths(path: string, maxShown = MAX_IGNORED_SHOWN): { shown: string[]; total: number } | null {
  if (!existsSync(path)) return null;
  // `--untracked-files=normal` is explicit: `--ignored=matching` refuses the `no` a user's
  // status.showUntrackedFiles would otherwise supply.
  const out = run(path, ["status", "--porcelain", "-z", "--ignored=matching", "--untracked-files=normal"]);
  if (out === null) return null;
  const fields = out.split("\0");
  const entries: string[] = [];
  for (let i = 0; i < fields.length; i++) {
    const field = fields[i]!;
    if (field.startsWith("!! ")) entries.push(field.slice(3));
    else if (/^(?:[RC].|.[RC]) /.test(field)) i++; // a rename/copy carries its source path as the next field
  }
  entries.sort();
  return { shown: entries.slice(0, maxShown), total: entries.length };
}

interface RawBranch { name: string; head: string; upstream: string | null; track: string; date: string | null; worktreePath: string | null }

function listBranches(root: string): { branches: RawBranch[]; skipped: number } {
  const format = ["%(refname)", "%(objectname)", "%(upstream)", "%(upstream:track,nobracket)", "%(committerdate:iso-strict)", "%(worktreepath)"].join("%00");
  const out = run(root, ["for-each-ref", `--format=${format}`, "refs/heads/"]) ?? "";
  const items: RawBranch[] = [];
  let skipped = 0;
  for (const line of out.split("\n")) {
    if (!line) continue;
    const [refname = "", objectname = "", upstream = "", track = "", date = "", worktreePath = ""] = line.split("\0");
    if (!refname.startsWith("refs/heads/")) continue;
    const name = refname.slice("refs/heads/".length);
    const head = sha(objectname);
    if (!head) continue;
    // git will create `refs/heads/-x` through update-ref even though check-ref-format
    // --branch refuses it; such a name is never recorded, and the omission is stated.
    if (!isSafeBranchName(name)) { skipped++; continue; }
    const up = upstream.startsWith("refs/remotes/") ? upstream.slice("refs/remotes/".length) : null;
    items.push({ name, head, upstream: up, track, date: iso(date), worktreePath: worktreePath || null });
  }
  return { branches: items, skipped };
}

/** Newest first (by commit date, then name), so a truncated record keeps the branches
 *  someone is most likely to ask about. */
function newestFirst<T extends { date?: string | null; last_commit_at?: string | null; name?: string; path?: string }>(items: T[]): T[] {
  const stamp = (x: T) => x.date ?? x.last_commit_at ?? "";
  const key = (x: T) => x.name ?? x.path ?? "";
  return [...items].sort((a, b) => stamp(b).localeCompare(stamp(a)) || key(a).localeCompare(key(b)));
}

function parseTrack(track: string): { gone: boolean; ahead: number | null; behind: number | null } {
  if (track.trim() === "gone") return { gone: true, ahead: null, behind: null };
  const ahead = /ahead (\d+)/.exec(track);
  const behind = /behind (\d+)/.exec(track);
  return { gone: false, ahead: ahead ? Number(ahead[1]) : 0, behind: behind ? Number(behind[1]) : 0 };
}

/** patch-id of the whole diff between two commits: what a squash-merge lands as one commit. */
function combinedPatchId(root: string, base: string, head: string): string | null {
  let diff: Buffer;
  try {
    diff = execFileSync("git", ["diff", "--binary", "--full-index", "--no-renames", "--no-ext-diff", "--no-textconv", base, head, "--"],
      { cwd: root, env: env(), maxBuffer: MAX_OUTPUT, timeout: 15_000, stdio: ["ignore", "pipe", "ignore"] });
  } catch { return null; }
  if (!diff.byteLength) return null;
  const r = spawnSync("git", ["patch-id", "--stable"], { cwd: root, env: env(), input: diff, encoding: "utf8", maxBuffer: MAX_OUTPUT, timeout: 15_000 });
  if (r.error || r.status !== 0) return null;
  const id = r.stdout.trim().split(/\s+/)[0] ?? "";
  return SHA.test(id) ? id : null;
}

/** patch-id → commit for a range, via one `git log -p | git patch-id` pipeline. `ok: false`
 *  means the pipeline failed or overflowed — the caller says so instead of pretending the
 *  search happened. */
function patchIdsOf(root: string, range: string[], limit: number | null, timeout: number): { map: Map<string, string>; ok: boolean } {
  const map = new Map<string, string>();
  let log: Buffer;
  try {
    log = execFileSync("git", ["log", "--format=%H", "-p", "--no-merges", "--binary", "--full-index", "--no-renames", "--no-ext-diff", "--no-textconv", ...(limit ? [`-n${limit}`] : []), ...range, "--"],
      { cwd: root, env: env(), maxBuffer: MAX_OUTPUT, timeout, stdio: ["ignore", "pipe", "ignore"] });
  } catch { return { map, ok: false }; }
  if (!log.byteLength) return { map, ok: true };
  const r = spawnSync("git", ["patch-id", "--stable"], { cwd: root, env: env(), input: log, encoding: "utf8", maxBuffer: MAX_OUTPUT, timeout });
  if (r.error || r.status !== 0) return { map, ok: false };
  for (const line of r.stdout.split("\n")) {
    const [patchId = "", commit = ""] = line.trim().split(/\s+/);
    if (SHA.test(patchId) && SHA.test(commit) && !map.has(patchId)) map.set(patchId, commit);
  }
  return { map, ok: true };
}

type DefaultPatchIds = () => { map: Map<string, string>; ok: boolean };

/** The pull request a MERGE COMMIT names for this branch, from the local commit subject
 *  GitHub/GitLab write ("Merge pull request #N from owner/branch"). Bounded scan, JS-side
 *  matching (no branch name reaches git), never a forge request. */
function prFromMergeCommits(root: string, branch: string, range: string): number | undefined {
  const out = run(root, ["log", "--merges", "--format=%s", "-n500", range, "--"]) ?? "";
  for (const subject of out.split("\n")) {
    const m = /^Merge pull request #(\d{1,9}) from [^/\s]+\/(\S+)$/.exec(subject.trim());
    if (m && m[2] === branch) return Number(m[1]);
  }
  return undefined;
}

/** The pull request a SQUASH COMMIT names ("Title (#N)"). */
function prFromSquashCommit(root: string, commit: string): number | undefined {
  const subject = run(root, ["log", "-1", "--format=%s", "--end-of-options", commit, "--"])?.trim() ?? "";
  const m = /\(#(\d{1,9})\)$/.exec(subject);
  return m ? Number(m[1]) : undefined;
}

function withPr(verdict: MergedVerdict, pr: number | undefined): MergedVerdict {
  return pr === undefined ? verdict : { ...verdict, pr, evidence: [...verdict.evidence, `pull request #${pr} (from the local commit subject)`] };
}

/** The default branch's first-parent history: the commits made (or fast-forwarded) directly
 *  on it. null when git cannot list it. */
function firstParentsOf(root: string, head: string): Set<string> | null {
  const out = run(root, ["rev-list", "--first-parent", "--end-of-options", head, "--"], 60_000);
  if (out === null) return null;
  return new Set(out.split("\n").map((l) => l.trim()).filter((l) => SHA.test(l)));
}

type DefaultFirstParents = () => Set<string> | null;

function mergedVerdict(root: string, name: string, head: string, def: DefaultBranch | null, patchIds: DefaultPatchIds, firstParents: DefaultFirstParents, searched: number): MergedVerdict {
  if (!def) return { status: "unknown", method: null, evidence: ["no default branch resolved (origin/HEAD, origin/main, origin/master, main, master)"] };
  const ancestor = predicate(root, ["merge-base", "--is-ancestor", head, def.head]);
  if (ancestor === null) return { status: "unknown", method: null, evidence: ["git merge-base failed"] };
  if (ancestor) {
    // A head ON the default branch's first-parent line holds no commits of its own: a branch
    // created and never committed to (or fast-forwarded in). Ancestry would call it merged
    // and prune would delete it with its worktree; it is labeled and kept instead.
    const line = firstParents();
    if (line === null) return { status: "unknown", method: null, evidence: [`${head.slice(0, 12)} is an ancestor of ${def.ref}; its first-parent history could not be read`] };
    if (line.has(head)) {
      return { status: "no-commits", method: null, evidence: [`${head.slice(0, 12)} is on ${def.ref}@${def.head.slice(0, 12)} first-parent history: no commits of its own (or fast-forwarded)`] };
    }
    const verdict: MergedVerdict = { status: "merged", method: "ancestry", evidence: [`${head.slice(0, 12)} is an ancestor of ${def.ref}@${def.head.slice(0, 12)}`] };
    return withPr(verdict, prFromMergeCommits(root, name, `${head}..${def.head}`));
  }
  const base = sha(run(root, ["merge-base", head, def.head]));
  if (!base) return { status: "unknown", method: null, evidence: [`no merge base with ${def.ref}`] };
  const known = patchIds();
  if (!known.ok) {
    return { status: "unmerged", method: null, evidence: [`not an ancestor of ${def.ref}@${def.head.slice(0, 12)}; squash/rebase search unavailable (default-branch history too large or git failed)`] };
  }
  // Only default-branch commits AFTER the merge base can have landed this branch — the set
  // `git cherry` compares against. A matching commit already behind the base is the branch's
  // own history: a reland (revert of a revert) or a value flipped back matches the ORIGINAL
  // commit and is not merged. The map keeps the newest commit per patch-id, so when that one
  // is behind the base every older one is too. null → git failed (never "no").
  const landedAfterBase = (commit: string): boolean | null => {
    const behind = predicate(root, ["merge-base", "--is-ancestor", commit, base]);
    return behind === null ? null : !behind;
  };
  const combined = combinedPatchId(root, base, head);
  if (combined) {
    const commit = known.map.get(combined);
    if (commit) {
      const after = landedAfterBase(commit);
      if (after === null) return { status: "unknown", method: null, evidence: ["git merge-base failed"] };
      if (after) {
        const verdict: MergedVerdict = { status: "merged", method: "squash", evidence: [`patch-id of ${base.slice(0, 12)}..${head.slice(0, 12)} equals ${def.ref} commit ${commit.slice(0, 12)}`] };
        return withPr(verdict, prFromSquashCommit(root, commit));
      }
    }
  }
  // Rebase / cherry-pick: every commit of the branch has a patch-equivalent commit in the
  // default branch after the merge base. Uses the one-time map instead of `git cherry`, whose
  // cost grows with the default branch's history for EVERY branch checked.
  const own = patchIdsOf(root, [`${base}..${head}`], null, 30_000);
  if (own.ok && own.map.size) {
    let all = true;
    for (const id of own.map.keys()) {
      const commit = known.map.get(id);
      const after = commit ? landedAfterBase(commit) : false;
      if (after === null) return { status: "unknown", method: null, evidence: ["git merge-base failed"] };
      if (!after) { all = false; break; }
    }
    if (all) return { status: "merged", method: "rebase", evidence: [`all ${own.map.size} commit(s) have a patch-equivalent commit in ${def.ref} after the merge base (last ${searched} searched)`] };
  }
  return { status: "unmerged", method: null, evidence: [`not in ${def.ref}@${def.head.slice(0, 12)}; squash/rebase searched last ${searched} commits`] };
}

function realpath(path: string): string {
  try { return realpathSync(path); } catch { return path; }
}

function fetchedAt(root: string): string | null {
  const common = gitCommonDir(root);
  if (!common) return null;
  try { return statSync(join(common, "FETCH_HEAD")).mtime.toISOString(); } catch { return null; }
}

/** Snapshot this machine's workspace for the repository at `root`. Validated against the
 *  strict schema before it is returned, so the extractor can never emit a record the
 *  loader would refuse. */
export function snapshotWorkspace(root: string, opts: SnapshotOptions): Workspace {
  const now = opts.now ?? new Date();
  const main = mainWorktreeRoot(root);
  if (opts.fetch) run(main, ["fetch", "--prune", "--quiet"], 120_000);
  const def = defaultBranch(main);
  const searched = opts.squashSearchCommits ?? DEFAULT_SQUASH_SEARCH_COMMITS;
  let patchIds: ReturnType<typeof patchIdsOf> | null = null;
  const lazyPatchIds: DefaultPatchIds = () => (patchIds ??= def ? patchIdsOf(main, [def.head], searched, 60_000) : { map: new Map(), ok: true });
  let firstParents: Set<string> | null | undefined;
  const lazyFirstParents: DefaultFirstParents = () => (firstParents === undefined ? (firstParents = def ? firstParentsOf(main, def.head) : null) : firstParents);
  const notes: string[] = [];

  const allWorktrees = listWorktrees(main).map((w) => ({ ...w, date: iso(run(main, ["log", "-1", "--format=%cI", "--end-of-options", w.head, "--"])) }));
  const rawWorktrees = allWorktrees.length > MAX_WORKTREES ? newestFirst(allWorktrees).slice(0, MAX_WORKTREES) : allWorktrees;
  if (rawWorktrees.length < allWorktrees.length) notes.push(`truncated: ${allWorktrees.length - rawWorktrees.length} older worktree(s) omitted (record holds ${MAX_WORKTREES})`);
  const mainReal = realpath(main);
  const worktrees: WorkspaceWorktree[] = rawWorktrees.map((w) => ({
    id: worktreeId(w.path),
    // A path with a control character (newline, ESC) is never recorded or printed; without a
    // path `prune --apply` refuses the worktree instead of guessing.
    path: opts.publish === "full" && !CONTROL_CHARS.test(w.path) ? w.path : null,
    branch: w.branch,
    head: w.head,
    is_main: realpath(w.path) === mainReal,
    dirty: w.prunable ? null : isDirty(w.path),
    locked: w.locked,
    prunable: w.prunable,
    last_commit_at: w.date,
  }));
  const worktreeByPath = new Map(rawWorktrees.map((w) => [w.path, worktreeId(w.path)]));

  const listed = listBranches(main);
  if (listed.skipped) notes.push(`skipped: ${listed.skipped} branch name(s) git would refuse as a branch argument`);
  const maxBranches = Math.min(MAX_BRANCHES, Math.max(1, opts.maxBranches ?? MAX_BRANCHES));
  const rawBranches = listed.branches.length > maxBranches ? newestFirst(listed.branches).slice(0, maxBranches) : listed.branches;
  if (rawBranches.length < listed.branches.length) notes.push(`truncated: ${listed.branches.length - rawBranches.length} older branch(es) omitted (record holds ${maxBranches})`);
  const branches: WorkspaceBranch[] = rawBranches.map((b) => {
    const track = b.upstream ? parseTrack(b.track) : { gone: false, ahead: null, behind: null };
    return {
      name: b.name,
      head: b.head,
      is_default: def?.name === b.name,
      upstream: b.upstream,
      upstream_gone: track.gone,
      ahead: track.ahead,
      behind: track.behind,
      last_commit_at: b.date,
      worktree: (b.worktreePath && worktreeByPath.get(b.worktreePath)) || null,
      merged: def?.name === b.name
        ? { status: "unmerged", method: null, evidence: ["default branch"] }
        : mergedVerdict(main, b.name, b.head, def, lazyPatchIds, lazyFirstParents, searched),
    };
  });

  const record: Workspace = {
    schema: WORKSPACE_SCHEMA_VERSION,
    id: workspaceId(opts.machine.id),
    machine: { id: opts.machine.id, label: opts.machine.label, platform: process.platform },
    repository: stableRepositoryName(main),
    publish: opts.publish,
    observed_at: now.toISOString(),
    fetched_at: fetchedAt(main),
    default_branch: def,
    worktrees,
    branches,
    provenance: extracted(1, [
      "git worktree list --porcelain", "git for-each-ref refs/heads/", "git status --porcelain --untracked-files=all",
      "git merge-base --is-ancestor", "git rev-list --first-parent","git diff | git patch-id --stable", "git log -p | git patch-id --stable",
      ...notes,
    ]),
  };
  return WorkspaceSchema.parse(record);
}
