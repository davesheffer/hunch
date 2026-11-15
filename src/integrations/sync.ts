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
 * commits and state-contract writes are outside this policy: a state write commits on any
 * branch. It still must not sweep a capture the policy held, so a hold records what it left
 * behind: every public .hunch file a capture wrote in this process (the capture-write log in
 * core/io.ts; state writers never enter it) that is still dirty goes on the clone-local held
 * list (.hunch-cache/held-captures.json, never committed) with the sha256 of its bytes; a
 * capture batch that also edited a tracked file is never listed. A state write under an
 * active hold stages exactly as before, and the decision is made under the commit lock from
 * what git ACTUALLY staged (commitAndPushHunch's holdBack): it leaves out only a held file
 * still staged as NEW vs HEAD whose bytes still match the recorded hash, and only when no
 * other staged file names any held record id (a supersede, a link, a change-ledger entry):
 * one reference commits everything. A staged manifest.json, an unborn HEAD, or git failing
 * to answer also commits everything. After the commit a `git grep` of HEAD backstops the
 * window between decision and commit: if HEAD names a held-back id (or the grep fails), the
 * held files and the refreshed grounding docs are folded into that same commit (a
 * compare-and-swap rewrite of the unpushed commit; a follow-up commit if HEAD moved, the
 * commit was published, or a git step failed). Any doubt is the 1.55.1 sweep-everything behavior,
 * and a cross-process lost update on the list only means that behavior.
 * Used by every CLI/MCP path that writes a record.
 */
import { createHash } from "node:crypto";
import { mkdirSync, readFileSync, rmSync } from "node:fs";
import { dirname, join } from "node:path";
import type { HunchStore } from "../store/hunchStore.js";
import type { EntityKind } from "../core/types.js";
import { readAutoCommitPolicy } from "../core/config.js";
import { checkedOutBranch, commitAndPushHunch, hunchDirChangedPaths, hunchDirHasChanges, lazyMemoryRepoProbe, onDefaultBranch, type FlushGitFacts, type HunchRemoteContract, type GitMemoryObserver } from "../extractors/git.js";
import { takeCaptureWrites, writeFileAtomic } from "../core/io.js";
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
  // Not held: whatever captures wrote is swept into this commit, so nothing is left to record.
  takeCaptureWrites(publicHunchDir);
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
  /** Answers the caller already has for this flush (FlushGitFacts). */
  facts?: FlushGitFacts,
): "pushed" | "committed" | "held" | null {
  return flushStore(store, publicHunchDir, isPrivate, message, remoteOverride, observe, true, kind, facts);
}

/** Auto-commit a state-contract write (`nuryel_write`, `hunch serve`). A state root is a
 *  dedicated data repository whose writes commit on whatever branch it serves, so the
 *  capture auto-commit policy (default-branch hold, `auto_commit`) never decides WHETHER it
 *  commits; outcomes as flushCapture otherwise. It decides only what stays out: a public
 *  write under an active hold hands the held list to commitAndPushHunch, which under the
 *  commit lock leaves out only still-new, hash-matching held files that no committed file
 *  names (see the header), commits everything else, and rewrites the list to what it left
 *  out. The grounding refresh runs only when nothing ends up held back (held records must
 *  not be counted in committed docs, as on the hold path). No held list, no active hold, or a private home:
 *  exactly flushStore. */
export function flushStateWrite(
  store: HunchStore,
  publicHunchDir: string,
  isPrivate: boolean,
  message: string,
  remoteOverride?: HunchRemoteContract,
): "pushed" | "committed" | null {
  const base = () => flushStore(store, publicHunchDir, isPrivate, message, remoteOverride, undefined, false) as "pushed" | "committed" | null;
  if (store.captureHome(isPrivate, null) !== "public" || !store.autoCommit) return base();
  const held = readHeldCaptures(publicHunchDir);
  if (Object.keys(held).length === 0) return base();
  if (publicCommitHold(publicHunchDir) === null) return base();
  // Capture writes nobody held are swept into this commit, as base would sweep them.
  takeCaptureWrites(publicHunchDir);
  return commitAndPushHunch(publicHunchDir, message, {
    push: false,
    holdBack: {
      entries: held,
      groundingIfNoneHeld: () => refreshCommittableGrounding(dirname(publicHunchDir), store),
      onResult: (still) => writeHeldCaptures(publicHunchDir, Object.fromEntries(still.filter((path) => path in held).map((path) => [path, held[path]!]))),
    },
  });
}

/** Clone-local (gitignored, never committed) list of the public .hunch files a capture hold
 *  left uncommitted: relative path -> sha256 of the held bytes, or "deleted". */
function heldCapturesFile(publicHunchDir: string): string {
  return join(dirname(publicHunchDir), ".hunch-cache", "held-captures.json");
}

/** Tolerant: a missing or unreadable list is empty. */
function readHeldCaptures(publicHunchDir: string): Record<string, string> {
  try {
    const parsed = JSON.parse(readFileSync(heldCapturesFile(publicHunchDir), "utf8")) as { version?: unknown; entries?: unknown } | null;
    const entries = parsed?.entries;
    if (parsed?.version !== 1 || !entries || typeof entries !== "object" || Array.isArray(entries)) return {};
    return Object.fromEntries(Object.entries(entries).filter((entry): entry is [string, string] => typeof entry[1] === "string"));
  } catch { return {}; }
}

/** Best effort, never throws: a lost list only means a later state write takes base behavior. */
function writeHeldCaptures(publicHunchDir: string, entries: Record<string, string>): void {
  const file = heldCapturesFile(publicHunchDir);
  try {
    if (Object.keys(entries).length === 0) { rmSync(file, { force: true }); return; }
    mkdirSync(dirname(file), { recursive: true });
    const sorted = Object.fromEntries(Object.entries(entries).sort(([a], [b]) => a.localeCompare(b)));
    writeFileAtomic(file, JSON.stringify({ version: 1, entries: sorted }, null, 2) + "\n");
  } catch { /* best effort */ }
}

/** sha256 of the file's current bytes, or "deleted" when it is gone. */
function heldHashOf(publicHunchDir: string, relPath: string): string {
  try { return createHash("sha256").update(readFileSync(join(publicHunchDir, relPath))).digest("hex"); }
  catch { return "deleted"; }
}

/** Put on the held list every public .hunch file a capture wrote in this process (since the
 *  last commit or hold took the log) that is still untracked, with the hash of its current
 *  bytes; prune entries no longer untracked. manifest.json is never held (a dirty manifest
 *  sends a state write to base anyway). Called wherever a
 *  public capture commit is held. Returns the dirty set it read, or null when it read none
 *  (nothing logged, or a failure). Never throws. */
export function recordHeldCaptures(publicHunchDir: string): Set<string> | null {
  let dirty: Set<string> | null = null;
  try {
    const writes = takeCaptureWrites(publicHunchDir).filter((path) => path !== "manifest.json");
    if (writes.length === 0) return null;
    const changed = hunchDirChangedPaths(publicHunchDir);
    if (changed === null) return null;
    dirty = new Set(changed.all);
    // Only new (untracked) files can ever stay out of a state commit, so only they are listed.
    // A batch is atomic: one that also edits or deletes a tracked file (a supersede, a retire)
    // lists none of its files, so its new records are swept with the edit, as base.
    const entries: Record<string, string> = {};
    for (const [path, hash] of Object.entries(readHeldCaptures(publicHunchDir))) if (changed.untracked.has(path)) entries[path] = hash;
    const touchesTracked = writes.some((path) => dirty!.has(path) && !changed.untracked.has(path));
    if (!touchesTracked) for (const path of writes) if (changed.untracked.has(path)) entries[path] = heldHashOf(publicHunchDir, path);
    writeHeldCaptures(publicHunchDir, entries);
  } catch { /* best effort: an unrecorded hold only means a later state write sweeps it */ }
  return dirty;
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
  facts?: FlushGitFacts,
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
  // One rev-parse answers the commit's layout questions (MemoryRepoProbe), taken on first use.
  const probe = facts?.probe ?? lazyMemoryRepoProbe(publicHunchDir);
  // A capture commits only where the auto-commit policy allows (by default never onto the
  // default branch: task and capture commits landed on main between the user's own). The
  // record stays on disk; the user's next commit carries it, or the next capture on an
  // allowed branch sweeps it up. Held before
  // the grounding refresh, so an automatic capture (hook sync, MCP) leaves tracked docs at
  // HEAD instead of counting a record that `git commit -a` would leave behind; by-hand CLI
  // commands refresh them on disk themselves (publicFlushCommitsGrounding in the CLI).
  if (holdOnDefaultBranch && holdsOnDefaultBranch(publicHunchDir)) return heldOrNothing(publicHunchDir);
  // Not held: whatever captures wrote is swept into this commit, so nothing is left to record.
  takeCaptureWrites(publicHunchDir);
  // A public capture changes record counts, so refresh git-clean grounding docs and fold
  // them into the SAME memory commit — otherwise every capture re-stales the committed
  // counts and the release gate's clean-tree check fails on the next CI index.
  const grounding = refreshCommittableGrounding(dirname(publicHunchDir), store);
  return commitAndPushHunch(publicHunchDir, message, { push: false, alsoStage: grounding, observe, facts: { ...facts, probe } });
}

/** What a caller prints for a "held" flush, so a solo user on main is never left
 *  wondering why the capture commit stopped appearing. */
export const HELD_ON_DEFAULT_BRANCH = "not auto-committed: the default branch is checked out — your next commit that adds .hunch/ carries it (to restore auto-commit there, set \"autoCommitDefaultBranch\": true in .hunch/local.json)";

/** A hold reports "held" only when there is something left for the next commit; a clean
 *  .hunch/ is null, as an unheld flush with nothing staged would be. */
function heldOrNothing(publicHunchDir: string): "held" | null {
  const dirty = recordHeldCaptures(publicHunchDir);
  return (dirty ? dirty.size > 0 : hunchDirHasChanges(publicHunchDir)) ? "held" : null;
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
