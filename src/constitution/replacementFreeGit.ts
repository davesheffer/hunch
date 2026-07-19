import { execFileSync, spawnSync } from "node:child_process";
import { foreignRepoEnv, type CommitMeta } from "../extractors/git.js";

/** Constitution proof identity is the repository's real object graph, never a
 * clone-local `refs/replace/*` or legacy graft view. Keep this environment
 * private to proof planning so every traversal and ancestry check agrees with
 * replay, which uses the same Git invariant. */
export function replacementFreeGitEnvironment(source: NodeJS.ProcessEnv = process.env): NodeJS.ProcessEnv {
  return {
    ...foreignRepoEnv(source),
    GIT_NO_REPLACE_OBJECTS: "1",
  };
}

function gitText(root: string, args: string[], maxBuffer = 64 * 1024 * 1024): string {
  return execFileSync("git", ["-C", root, ...args], {
    encoding: "utf8",
    env: replacementFreeGitEnvironment(),
    maxBuffer,
    stdio: ["ignore", "pipe", "ignore"],
  }).trim();
}

function gitTextSafe(root: string, args: string[], maxBuffer?: number): string {
  try {
    return gitText(root, args, maxBuffer);
  } catch {
    return "";
  }
}

/** Resolve one commit-ish through the real object graph. */
export function replacementFreeExactCommit(root: string, ref: string): string | null {
  const oid = gitTextSafe(root, ["rev-parse", "--verify", "--quiet", `${ref}^{commit}`]).toLowerCase();
  return /^[0-9a-f]{40,64}$/.test(oid) ? oid : null;
}

/** Files changed by an exact commit, ignoring local replacement objects. */
export function replacementFreeCommitFiles(root: string, commit: string): string[] {
  const out = gitTextSafe(root, ["diff-tree", "--no-commit-id", "--name-only", "-r", "--root", commit]);
  return out ? out.split("\n").filter(Boolean) : [];
}

export function replacementFreeCommitMeta(root: string, commit: string): CommitMeta | null {
  const raw = gitTextSafe(root, ["show", "-s", "--format=%H%x1f%h%x1f%s%x1f%b%x1f%an%x1f%aI", commit]);
  if (!raw) return null;
  const [sha = "", shortSha = "", subject = "", body = "", author = "", date = ""] = raw.split("\x1f");
  if (!/^[0-9a-f]{40,64}$/i.test(sha)) return null;
  return { sha, shortSha, subject, body, author, date, files: replacementFreeCommitFiles(root, sha) };
}

/** Exact introducing commit for a Git-native policy record. */
export function replacementFreeFirstCommitForFile(root: string, file: string): string {
  const added = gitTextSafe(root, ["log", "--diff-filter=A", "--format=%H", "--", file])
    .split("\n")
    .find(Boolean);
  if (added) return added;
  return gitTextSafe(root, ["log", "--reverse", "--format=%H", "--", file])
    .split("\n")
    .find(Boolean) ?? "";
}

export function replacementFreeIsAncestorOrSame(root: string, ancestor: string, descendant: string): boolean {
  if (ancestor === descendant) return true;
  return spawnSync("git", ["-C", root, "merge-base", "--is-ancestor", ancestor, descendant], {
    env: replacementFreeGitEnvironment(),
    stdio: "ignore",
  }).status === 0;
}
