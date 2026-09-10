/**
 * The single funnel for auto-committing memory after a capture, so memory never has to be
 * committed by hand — in EVERY mode (auto-commit is ON by default; `--no-auto-commit` opts out).
 * A private record commits + two-way-syncs (merge remote, then push) its dedicated overlay repo.
 * A public record commits the repo-tracked .hunch/ WITHOUT pushing — an automatic pull/push on
 * the user's CODE repo would merge the remote into their working branch and publish unpushed
 * commits (bug_overlay_clobber); the memory commit rides their next push instead.
 * Used by every CLI/MCP path that writes a record.
 */
import { dirname } from "node:path";
import type { HunchStore } from "../store/hunchStore.js";
import { commitAndPushHunch, type HunchRemoteContract } from "../extractors/git.js";
import { refreshCommittableGrounding } from "./providers.js";
import { advertisedTeamRemoteContract } from "./team.js";

const pinnedSharedRoutes = new WeakMap<HunchStore, HunchRemoteContract>();

/** Bind one command/server Store instance to the graph epoch that admitted it.
 * Every later flush from that instance reuses the same verifying contract. */
export function pinSharedRemote(store: HunchStore, remote: HunchRemoteContract): void {
  pinnedSharedRoutes.set(store, remote);
}

/** Return the route admitted for this Store instance. Command paths that flush
 * directly (rather than through flushCapture) must use this accessor too, or a
 * coherent team.json/origin rewrite could switch graphs mid-command. */
export function sharedRemoteFor(store: HunchStore): HunchRemoteContract | undefined {
  if (store.mode !== "shared" || !store.privateDir) return undefined;
  return pinnedSharedRoutes.get(store)
    ?? advertisedTeamRemoteContract(store.publicRoot, dirname(store.privateDir));
}

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
): "pushed" | "committed" | null {
  if (home === "private") {
    if (!store.privateAutoCommit || !store.privateDir) return null;
    return commitAndPushHunch(store.privateDir, message, {
      push: true,
      protectedRepoRoot: store.publicRoot,
      remote: remoteOverride ?? sharedRemoteFor(store),
    });
  }
  if (!store.autoCommit) return null;
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
): Partial<Record<MemoryHome, "pushed" | "committed" | null>> {
  const results: Partial<Record<MemoryHome, "pushed" | "committed" | null>> = {};
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
 *  backstop, nothing staged; the record stays on disk and the next flush sweeps it up). */
export function flushCapture(
  store: HunchStore,
  publicHunchDir: string,
  isPrivate: boolean,
  message: string,
  /** Long-lived callers can pin the route snapshot that admitted the write. */
  remoteOverride?: HunchRemoteContract,
): "pushed" | "committed" | null {
  // Follow the same routing as HunchStore.captureHome: unified ("shared") mode homes
  // EVERY capture in the overlay, so the flush must go there too — one source of truth.
  if (store.captureHome(isPrivate) === "private") {
    if (store.privateAutoCommit && store.privateDir) {
      return commitAndPushHunch(store.privateDir, message, {
        push: true,
        protectedRepoRoot: store.publicRoot,
        remote: remoteOverride ?? sharedRemoteFor(store),
      });
    }
    return null;
  }
  if (!store.autoCommit) return null;
  // A public capture changes record counts, so refresh git-clean grounding docs and fold
  // them into the SAME memory commit — otherwise every capture re-stales the committed
  // counts and the release gate's clean-tree check fails on the next CI index.
  const grounding = refreshCommittableGrounding(dirname(publicHunchDir), store);
  return commitAndPushHunch(publicHunchDir, message, { push: false, alsoStage: grounding });
}
