/**
 * `hunch log --for <commit|branch>` (memory lane Phase 1, hunch-private#62): which
 * memory led to which feature commit.
 *
 * While public memory rides the code branch, a memory commit's position on that
 * branch's first-parent line IS the capture-time link: memory committed while HEAD
 * was C1 sits between C1 and the next code commit C2, and belongs to C2. Position
 * survives a rebase of the branch (a copied `Hunch-Code-Head` trailer would name the
 * pre-rebase commit), so it is the rule here; the trailers carry the link once memory
 * moves off the branch (Phase 2). Landing on the default branch reuses the workspace
 * ledger's merged verdict: a merge commit, a squash commit or a rebased copy by
 * patch-id. Everything git cannot answer is reported as unknown, never guessed.
 */
import { execFileSync, spawnSync } from "node:child_process";
import { attributeLine, LINE_FORMAT, parseLine, type FeatureGroup, type LineCommit } from "../core/memorylog.js";
import { isSafeBranchName, type MergedVerdict } from "../core/workspace.js";
import { foreignRepoEnv } from "./git.js";
import { branchLanding, resolveDefaultBranch } from "./workspaces.js";

export interface MemoryFor {
  /** what the user asked for, verbatim. */
  query: string;
  kind: "branch" | "commit";
  /** the commit the query resolved to (the branch tip for a branch). */
  sha: string;
  branch: string | null;
  /** how a non-default branch reached the default branch; null for a commit or the
   *  default branch itself. */
  merged: MergedVerdict | null;
  /** newest first. A merged branch's groups follow its merge commit's own group. */
  groups: FeatureGroup[];
  /** truncation and the cases attribution could not cover, in plain words. */
  notes: string[];
}

/** First-parent commits read per side branch of a merge. */
const SIDE_LINE_CAP = 500;
const SHA = /^(?:[0-9a-f]{40}|[0-9a-f]{64})$/;
const MAX_OUTPUT = 64 * 1024 * 1024;

function env(): NodeJS.ProcessEnv {
  return { ...foreignRepoEnv(process.env), GIT_OPTIONAL_LOCKS: "0" };
}

function git(root: string, args: string[], timeout = 60_000): string | null {
  try {
    return execFileSync("git", ["-c", "core.quotePath=false", "-c", "log.showSignature=false", ...args], {
      cwd: root, encoding: "utf8", env: env(), maxBuffer: MAX_OUTPUT, timeout, stdio: ["ignore", "pipe", "ignore"],
    });
  } catch { return null; }
}

/** 0 → true, 1 → false, anything else → null (never collapse "no" and "error"). */
function isAncestor(root: string, a: string, b: string): boolean | null {
  const r = spawnSync("git", ["merge-base", "--is-ancestor", a, b], { cwd: root, env: env(), timeout: 10_000, stdio: "ignore" });
  if (r.error || r.status === null) return null;
  return r.status === 0 ? true : r.status === 1 ? false : null;
}

function commitOf(root: string, rev: string): string | null {
  const v = git(root, ["rev-parse", "--verify", "-q", "--end-of-options", `${rev}^{commit}`], 10_000)?.trim() ?? "";
  return SHA.test(v) ? v : null;
}

interface Paths { prefix: string; memoryDir: string; shallow: boolean }

/** A first-parent line, newest first, capped at `cap` commits. `-m` gives a merge its
 *  diff against the first parent on every git version. Revisions are shas we
 *  resolved, never user text. */
function lineOf(root: string, revs: string[], cap: number, paths: Paths): { line: LineCommit[]; truncated: boolean; boundary: string | null } | null {
  const raw = git(root, ["log", "--first-parent", "-m", "--no-color", "--name-status", `--format=${LINE_FORMAT}`, `--max-count=${cap + 1}`, ...revs, "--"]);
  if (raw === null) return null;
  let line = parseLine(raw, paths.prefix, paths.memoryDir);
  // A shallow clone's boundary commit has no parents and `--name-status` lists its whole
  // tree, so it would read as a code commit owning every memory file. Cut the line there:
  // what is below it is simply not available.
  let boundary: string | null = null;
  if (paths.shallow) {
    const at = line.findIndex((c) => c.parents.length === 0);
    if (at !== -1) { boundary = line[at]!.shortSha; line = line.slice(0, at); }
  }
  return { line: line.slice(0, cap), truncated: line.length > cap, boundary };
}

/** Say so when a read stopped at a shallow clone's boundary. */
function noteShallow(read: { boundary: string | null }, notes: string[]): void {
  if (read.boundary) notes.push(`shallow clone: history before ${read.boundary} is not available; memory below it is not attributed`);
}

const landedAt = (groups: FeatureGroup[], landed: (g: FeatureGroup) => string | null): FeatureGroup[] =>
  groups.map((g) => ({ ...g, landed: landed(g) }));

type Owns = (c: LineCommit) => boolean;

/** Merges nested deeper than this (a branch merged into a branch merged into ...) are not expanded. */
const MAX_NESTING = 4;

/** Which merges own memory. A merge on the default branch's first-parent line (local or
 *  origin's: a merge not yet pushed is still main's) landed a branch, and so did a merge
 *  that brings in a side NOT on that line (a feature merged into a feature). A merge whose
 *  every side is on it (main merged into a branch) is a sync merge: transparent. With no
 *  default branch to tell them apart, every merge owns, and the notes say so. The line is
 *  read once, on the first merge asked about. */
function ownership(root: string, notes: string[]): Owns {
  let line: Set<string> | null | undefined;
  return (c) => {
    if (c.parents.length < 2) return false;
    if (line === undefined) {
      line = defaultLines(root);
      if (!line) notes.push("no default branch resolved (or its history could not be read): every merge is read as landing a branch, so memory a merge of main brought in may be attributed to it");
    }
    return !line || line.has(c.sha) || c.parents.slice(1).some((p) => !line!.has(p));
  };
}

/** The default branch's first-parent line, origin's and the local branch's together. */
function defaultLines(root: string): Set<string> | null {
  const def = resolveDefaultBranch(root);
  if (!def) return null;
  const local = commitOf(root, `refs/heads/${def.name}`);
  const fp = firstParentLine(root, [def.head, ...(local && local !== def.head ? [local] : [])]);
  return fp && new Set(fp);
}

/** Attribute `line`, then splice in the memory each owning merge on it brought from its
 *  side branch (`X^2` not reachable from `X^1`), landed at that merge; nested owning
 *  merges on a side are expanded the same way and land with it. */
function withMergedSides(root: string, line: LineCommit[], paths: Paths, notes: string[], owns: Owns, depth = 0): FeatureGroup[] {
  const own = attributeLine(line, owns);
  const out: FeatureGroup[] = own.filter((g) => g.commit === null);
  for (const c of line) {
    const mine = own.find((g) => g.commit?.sha === c.sha);
    if (mine) out.push(mine);
    if (c.memoryOnly || c.parents.length < 2 || !owns(c)) continue;
    if (depth >= MAX_NESTING) { notes.push(`${c.shortSha}: merges nested more than ${MAX_NESTING} deep were not expanded`); continue; }
    // An octopus merge has several sides; side k excludes the first parent and the sides before it.
    for (let k = 1; k < c.parents.length; k++) {
      const side = lineOf(root, [c.parents[k]!, `^${c.parents[0]!}`, ...c.parents.slice(1, k).map((p) => `^${p}`)], SIDE_LINE_CAP, paths);
      if (!side) { notes.push(`${c.shortSha}: the merged side could not be read`); continue; }
      if (side.truncated) notes.push(`${c.shortSha}: only the newest ${SIDE_LINE_CAP} commits of the merged side were searched`);
      noteShallow(side, notes);
      out.push(...landedAt(withMergedSides(root, side.line, paths, notes, owns, depth + 1), () => c.sha));
    }
  }
  return out;
}

/** The first-parent lines of `heads` (shas we resolved), newest first, or null when git cannot list them. */
function firstParentLine(root: string, heads: string[]): string[] | null {
  const out = git(root, ["rev-list", "--first-parent", ...heads]);
  return out === null ? null : out.split("\n").map((l) => l.trim()).filter((l) => SHA.test(l));
}

/** The oldest default-line commit that contains `tip`: the commit that merged it.
 *  Containment is monotone along the line, so a binary search keeps it to ~log2(n)
 *  git calls. null when git fails on the way. */
function landingMerge(root: string, defHead: string, tip: string): string | null {
  const fp = firstParentLine(root, [defHead]);
  if (!fp?.length) return null;
  let lo = 0, hi = fp.length - 1; // fp[lo] contains tip (the verdict said so)
  while (lo < hi) {
    const mid = Math.ceil((lo + hi) / 2);
    const has = isAncestor(root, tip, fp[mid]!);
    if (has === null) return null;
    if (has) lo = mid; else hi = mid - 1;
  }
  return isAncestor(root, tip, fp[lo]!) ? fp[lo]! : null;
}

function forBranch(root: string, query: string, branch: string, tip: string, limit: number, paths: Paths): MemoryFor {
  const notes: string[] = [];
  const owns = ownership(root, notes);
  const result = (merged: MergedVerdict | null, groups: FeatureGroup[]): MemoryFor =>
    ({ query, kind: "branch", sha: tip, branch, merged, groups, notes });
  if (resolveDefaultBranch(root)?.name === branch) {
    const read = lineOf(root, [tip], limit, paths);
    if (!read) throw new Error(`git could not read the history of ${branch}`);
    if (read.truncated) notes.push(`only the newest ${limit} commits of ${branch} were searched (--limit)`);
    noteShallow(read, notes);
    return result(null, withMergedSides(root, read.line, paths, notes, owns));
  }

  const landing = branchLanding(root, branch, tip);
  const def = landing.defaultBranch;
  const v = landing.verdict;
  if (v.status === "no-commits") {
    notes.push(`${branch} has no commits of its own on top of ${def?.ref ?? "the default branch"} (or was fast-forwarded into it); ask --for a commit instead`);
    return result(v, []);
  }
  let revs = [tip];
  let landed: (g: FeatureGroup) => string | null = () => null;
  if (v.status === "merged" && v.method === "ancestry" && def) {
    const merge = landingMerge(root, def.head, tip);
    const parents = merge ? (git(root, ["rev-list", "--parents", "-n1", merge])?.trim().split(/\s+/).slice(1) ?? []) : [];
    if (!merge || parents.length < 2 || isAncestor(root, tip, parents[0]!) !== false) {
      notes.push(`${branch} is in ${def.ref}, but the merge commit that brought it in was not found; nothing is attributed`);
      return result(v, []);
    }
    revs = [tip, `^${parents[0]!}`];
    landed = () => merge;
  } else if (def) {
    revs = [tip, `^${def.head}`];
    if (landing.squash) { const squash = landing.squash; landed = () => squash; }
    else if (landing.rebase) { const copies = landing.rebase; landed = (g) => (g.commit ? copies.get(g.commit.sha) ?? null : null); }
  } else {
    notes.push(`no default branch resolved, so the line runs back ${limit} commits (--limit) and may include history from before ${branch} forked`);
  }
  const cap = def ? SIDE_LINE_CAP : limit;
  const read = lineOf(root, revs, cap, paths);
  if (!read) throw new Error(`git could not read the history of ${branch}`);
  if (read.truncated) notes.push(`only the newest ${cap} commits of ${branch} were searched`);
  noteShallow(read, notes);
  // With no default branch the line is its own: a merge on it is where its side landed.
  const groups = withMergedSides(root, read.line, paths, notes, owns);
  return result(v, def ? landedAt(groups, landed) : groups);
}

function forCommit(root: string, query: string, sha: string, limit: number, paths: Paths): MemoryFor {
  const notes: string[] = [];
  const read = lineOf(root, [sha], limit, paths);
  if (!read?.line.length) throw new Error(`git could not read the history of ${query}`);
  const [head, ...rest] = read.line;
  const result = (groups: FeatureGroup[]): MemoryFor => ({ query, kind: "commit", sha, branch: null, merged: null, groups, notes });
  if (head!.memoryOnly) {
    notes.push(`${head!.shortSha} is a memory commit, not a feature commit; ask --for the branch it was made on to see where it belongs`);
    return result([]);
  }
  noteShallow(read, notes);
  const owns = ownership(root, notes);
  const transparent = (c: LineCommit): boolean => c.parents.length >= 2 && !owns(c);
  if (transparent(head!)) {
    notes.push(`${head!.shortSha} merges the default branch into this line (a sync merge); its memory belongs to the next code commit`);
    return result([]);
  }
  // The commit itself, and the memory below it back to the previous code commit.
  const end = rest.findIndex((c) => !c.memoryOnly && !transparent(c));
  if (end === -1 && read.truncated) notes.push(`no earlier code commit within ${limit} commits (--limit); older memory was not searched`);
  const segment = [head!, ...(end === -1 ? rest : rest.slice(0, end))];
  // An owning merge landed a branch: include what it brought. Transparent merges in the
  // segment brought memory that belongs to the other line's commits, so they are not expanded.
  return result(withMergedSides(root, segment, paths, notes, owns));
}

/** Resolve `query` (a local or `origin/` branch name first, as git does, then any
 *  commit-ish) and attribute its memory. Throws when it resolves to neither. */
export function memoryFor(root: string, query: string, opts: { limit?: number } = {}): MemoryFor {
  const limit = opts.limit && opts.limit > 0 ? Math.floor(opts.limit) : 100;
  const prefix = git(root, ["rev-parse", "--show-prefix"], 10_000)?.trim() ?? "";
  const shallow = git(root, ["rev-parse", "--is-shallow-repository"], 10_000)?.trim() === "true";
  const paths: Paths = { prefix, memoryDir: `${prefix}.hunch/`, shallow };
  // HEAD and @ name the checked-out commit, not its branch; `origin/HEAD` is a pointer.
  const pointer = query === "HEAD" || query === "@" || query.endsWith("/HEAD");
  if (!query.startsWith("-") && query !== "HEAD" && query !== "@") {
    // Let git say what the name is, so `origin/feat/b` is branch `feat/b` and a sha is a commit.
    const full = (git(root, ["rev-parse", "--symbolic-full-name", "--end-of-options", query], 10_000) ?? "").split(/\s+/).filter((l) => l && l !== "--end-of-options"); // rev-parse echoes the marker
    const ref = full.length === 1 ? full[0]! : "";
    const name = ref.startsWith("refs/heads/") ? ref.slice("refs/heads/".length)
      : ref.startsWith("refs/remotes/origin/") ? ref.slice("refs/remotes/origin/".length) : "";
    const tip = name && name !== "HEAD" ? commitOf(root, ref) : null;
    if (tip) return forBranch(root, query, name, tip, limit, paths);
    if (!ref && !pointer && isSafeBranchName(query)) {
      const remote = commitOf(root, `refs/remotes/origin/${query}`);
      if (remote) return forBranch(root, query, query, remote, limit, paths);
    }
  }
  const sha = query.startsWith("-") ? null : commitOf(root, query);
  if (!sha) throw new Error(`${JSON.stringify(query)} is not a branch or commit in this repository`);
  return forCommit(root, query, sha, limit, paths);
}
