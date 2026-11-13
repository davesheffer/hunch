/**
 * The single funnel for auto-committing memory after a capture, so memory never has to be
 * committed by hand — in EVERY mode (auto-commit is ON by default; `--no-auto-commit` opts out).
 * A private record commits + two-way-syncs (merge remote, then push) its dedicated overlay repo.
 * A public record commits the repo-tracked .hunch/ WITHOUT pushing — an automatic pull/push on
 * the user's CODE repo would merge the remote into their working branch and publish unpushed
 * commits (bug_overlay_clobber); the memory commit rides their next push instead.
 * Which branches a public commit may land on is the team's `auto_commit` setting in the
 * committed .hunch/config.json (publicCommitHold): absent or true holds only on the default
 * branch (per-machine opt-in there), false never commits, `{ "branches": [...] }` commits
 * only on those exact branches, and an unreadable setting holds (fail closed). Overlay
 * commits and state-contract writes are outside this policy.
 * Used by every CLI/MCP path that writes a record.
 */
import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import type { HunchStore } from "../store/hunchStore.js";
import type { EntityKind } from "../core/types.js";
import { readAutoCommitPolicy } from "../core/config.js";
import { checkedOutBranch, commitAndPushHunch, hunchDirHasChanges, onDefaultBranch, type HunchRemoteContract, type GitMemoryObserver } from "../extractors/git.js";
import { refreshCommittableGrounding } from "./providers.js";
import { pinSharedRemote, sharedRemoteFor } from "./sharedRoute.js";

export { pinSharedRemote, sharedRemoteFor };

export type MemoryHome = "public" | "private";

/** Flush one exact artifact home. Constitution repositories can explicitly
 * choose public even in unified mode, so this must not infer routing through
 * captureHome(isPrivate). The caller supplies the repository's actual home. */
export function flushMemoryHome(
  store: HunchStore,
  publicHunchDir: string,
  home: MemoryHome,
  message: string,
  remoteOverride?: HunchRemoteContract,
): "pushed" | "committed" | "held" | null {
  if (home === "private") {
    if (!store.privateAutoCommit || !store.privateDir) return null;
    return commitAndPushHunch(store.privateDir, message, {
      push: true,
      protectedRepoRoot: store.publicRoot,
      remote: remoteOverride ?? sharedRemoteFor(store),
    });
  }
  if (!store.autoCommit) return null;
  // Same hold as flushCapture: the public commit stages all of .hunch/, so it would
  // otherwise sweep a capture that was just reported as held onto a branch the policy holds.
  if (holdsOnDefaultBranch(publicHunchDir)) return heldOrNothing(publicHunchDir);
  const grounding = refreshCommittableGrounding(dirname(publicHunchDir), store);
  return commitAndPushHunch(publicHunchDir, message, { push: false, alsoStage: grounding });
}

/** One completion flush per touched home. A mixed ingest/bootstrap can write
 * both homes; unchanged homes are cheap no-ops after the memory-only stage
 * check, while each real home becomes durable exactly once. */
export function flushMemoryHomes(
  store: HunchStore,
  publicHunchDir: string,
  homes: Iterable<MemoryHome>,
  message: string,
  remoteOverride?: HunchRemoteContract,
): Partial<Record<MemoryHome, "pushed" | "committed" | "held" | null>> {
  const results: Partial<Record<MemoryHome, "pushed" | "committed" | "held" | null>> = {};
  for (const home of new Set(homes)) {
    results[home] = flushMemoryHome(store, publicHunchDir, home, message, remoteOverride);
  }
  return results;
}

/** Auto-commit + push the overlay after a private write, when auto-commit is on. No-op
 *  otherwise (manual `hunch private --sync` still works). Never throws. */
export function flushPrivate(store: HunchStore, message: string): void {
  if (store.privateAutoCommit && store.privateDir) {
    commitAndPushHunch(store.privateDir, message, {
      push: true,
      protectedRepoRoot: store.publicRoot,
      remote: sharedRemoteFor(store),
    });
  }
}

/** Auto-commit the store a capture landed in. Returns what ACTUALLY happened so callers
 *  never report a commit that was skipped: "pushed" (overlay committed + pushed),
 *  "committed" (commit created but not pushed — public .hunch/ rides the next push; an
 *  overlay commit whose merge/push failed retries on the next flush), or null (auto-commit
 *  off, no overlay for a private record, or the commit was skipped — lock held, safety
 *  backstop, nothing staged; the record stays on disk and the next flush sweeps it up),
 *  or "held" (a public capture left uncommitted by the auto-commit policy — see
 *  publicCommitHold; callers say why with heldNotice). */
export function flushCapture(
  store: HunchStore,
  publicHunchDir: string,
  isPrivate: boolean,
  message: string,
  /** Long-lived callers can pin the route snapshot that admitted the write. */
  remoteOverride?: HunchRemoteContract,
  observe?: GitMemoryObserver,
  /** The kind just written: a memory policy can home kinds differently. */
  kind?: EntityKind,
): "pushed" | "committed" | "held" | null {
  return flushStore(store, publicHunchDir, isPrivate, message, remoteOverride, observe, true, kind);
}

/** Auto-commit a state-contract write (`nuryel_write`, `hunch serve`). A state root is a
 *  dedicated data repository whose writes commit on whatever branch it serves, so the
 *  capture auto-commit policy (default-branch hold, `auto_commit`) never applies;
 *  outcomes as flushCapture otherwise. */
export function flushStateWrite(
  store: HunchStore,
  publicHunchDir: string,
  isPrivate: boolean,
  message: string,
  remoteOverride?: HunchRemoteContract,
): "pushed" | "committed" | null {
  return flushStore(store, publicHunchDir, isPrivate, message, remoteOverride, undefined, false) as "pushed" | "committed" | null;
}

function flushStore(
  store: HunchStore,
  publicHunchDir: string,
  isPrivate: boolean,
  message: string,
  remoteOverride: HunchRemoteContract | undefined,
  observe: GitMemoryObserver | undefined,
  holdOnDefaultBranch: boolean,
  kind?: EntityKind,
): "pushed" | "committed" | "held" | null {
  // Follow the same routing as HunchStore.captureHome: unified ("shared") mode homes
  // EVERY capture in the overlay, so the flush must go there too — one source of truth.
  if (store.captureHome(isPrivate, kind ?? null) === "private") {
    if (store.privateAutoCommit && store.privateDir) {
      return commitAndPushHunch(store.privateDir, message, {
        push: true,
        observe,
        protectedRepoRoot: store.publicRoot,
        remote: remoteOverride ?? sharedRemoteFor(store),
      });
    }
    return null;
  }
  if (!store.autoCommit) return null;
  // A capture commits only where the auto-commit policy allows (by default never onto the
  // default branch: task and capture commits landed on main between the user's own). The
  // record stays on disk; the user's next commit carries it, or the next capture on an
  // allowed branch sweeps it up. Held before
  // the grounding refresh, so an automatic capture (hook sync, MCP) leaves tracked docs at
  // HEAD instead of counting a record that `git commit -a` would leave behind; by-hand CLI
  // commands refresh them on disk themselves (publicFlushCommitsGrounding in the CLI).
  if (holdOnDefaultBranch && holdsOnDefaultBranch(publicHunchDir)) return heldOrNothing(publicHunchDir);
  // A public capture changes record counts, so refresh git-clean grounding docs and fold
  // them into the SAME memory commit — otherwise every capture re-stales the committed
  // counts and the release gate's clean-tree check fails on the next CI index.
  const grounding = refreshCommittableGrounding(dirname(publicHunchDir), store);
  return commitAndPushHunch(publicHunchDir, message, { push: false, alsoStage: grounding, observe });
}

/** What a caller prints for a "held" flush, so a solo user on main is never left
 *  wondering why the capture commit stopped appearing. */
export const HELD_ON_DEFAULT_BRANCH = "not auto-committed: the default branch is checked out — your next commit that adds .hunch/ carries it (to restore auto-commit there, set \"autoCommitDefaultBranch\": true in .hunch/local.json)";

/** A hold reports "held" only when there is something left for the next commit; a clean
 *  .hunch/ is null, as an unheld flush with nothing staged would be. */
function heldOrNothing(publicHunchDir: string): "held" | null {
  return hunchDirHasChanges(publicHunchDir) ? "held" : null;
}

/** Whether an automatic public memory commit must be held under the auto-commit policy
 *  (publicCommitHold). Shared by flushStore and `hunch sync`. */
export function holdsOnDefaultBranch(publicHunchDir: string): boolean {
  return publicCommitHold(publicHunchDir) !== null;
}

/** Why an automatic public memory commit in `publicHunchDir` is held, or null when it may
 *  commit. Follows the team's `auto_commit` in .hunch/config.json, read fresh each call:
 *  false holds everywhere; `{ "branches": [...] }` commits only on a listed branch (exact
 *  name; the per-machine default-branch opt-ins do not override the team list); an
 *  unreadable or malformed value holds (fail closed); absent or true keeps the default —
 *  hold on the default branch unless this machine opted back in. */
export function publicCommitHold(publicHunchDir: string): string | null {
  const policy = readAutoCommitPolicy(publicHunchDir);
  const stays = "the record stays in .hunch/ for you to commit";
  switch (policy.kind) {
    case "off":
      return `not auto-committed: .hunch/config.json sets "auto_commit": false — ${stays}`;
    case "invalid":
      return `not auto-committed: ${policy.problem} — ${stays}`;
    case "branches": {
      const branch = checkedOutBranch(dirname(publicHunchDir));
      if (branch && policy.branches.includes(branch)) return null;
      const listed = policy.branches.length ? policy.branches.join(", ") : "none";
      const where = branch ? `branch "${branch}" is not listed in` : "HEAD is detached, and commits follow only";
      return `not auto-committed: ${where} auto_commit.branches in .hunch/config.json (${listed}) — ${stays}`;
    }
    case "default":
      return !defaultBranchCommitsAllowed(publicHunchDir) && onDefaultBranch(dirname(publicHunchDir)) ? HELD_ON_DEFAULT_BRANCH : null;
  }
}

/** The notice a caller prints for a "held" public flush: the policy's actual reason. */
export function heldNotice(publicHunchDir: string): string {
  return publicCommitHold(publicHunchDir) ?? HELD_ON_DEFAULT_BRANCH;
}

/** Opt back in to capture commits on the default branch: `autoCommitDefaultBranch: true`
 *  in the per-machine .hunch/local.json, or HUNCH_AUTO_COMMIT_DEFAULT_BRANCH=1. Applies
 *  only when .hunch/config.json sets no `auto_commit` branch list. */
function defaultBranchCommitsAllowed(publicHunchDir: string): boolean {
  if (process.env.HUNCH_AUTO_COMMIT_DEFAULT_BRANCH === "1") return true;
  try {
    const raw = readFileSync(join(publicHunchDir, "local.json"), "utf8");
    const local: unknown = JSON.parse(raw.startsWith("\uFEFF") ? raw.slice(1) : raw);
    return !!local && typeof local === "object" && (local as { autoCommitDefaultBranch?: unknown }).autoCommitDefaultBranch === true;
  } catch {
    return false;
  }
}
