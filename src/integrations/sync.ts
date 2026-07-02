/**
 * The single funnel for auto-committing memory after a capture, so memory never has to be
 * committed by hand — in EVERY mode (auto-commit is ON by default; `--no-auto-commit` opts out).
 * A private record commits + two-way-syncs (merge remote, then push) its dedicated overlay repo.
 * A public record commits the repo-tracked .hunch/ WITHOUT pushing — an automatic pull/push on
 * the user's CODE repo would merge the remote into their working branch and publish unpushed
 * commits (bug_overlay_clobber); the memory commit rides their next push instead.
 * Used by every CLI/MCP path that writes a record.
 */
import type { HunchStore } from "../store/hunchStore.js";
import { commitAndPushHunch } from "../extractors/git.js";

/** Auto-commit + push the overlay after a private write, when auto-commit is on. No-op
 *  otherwise (manual `hunch private --sync` still works). Never throws. */
export function flushPrivate(store: HunchStore, message: string): void {
  if (store.privateAutoCommit && store.privateDir) commitAndPushHunch(store.privateDir, message);
}

/** Auto-commit the store a capture landed in. Returns what happened so callers can report it:
 *  "pushed" (private overlay, committed + pushed), "committed" (public .hunch/, commit only —
 *  rides the next push), or null (auto-commit off / no overlay for a private record). */
export function flushCapture(
  store: HunchStore,
  publicHunchDir: string,
  isPrivate: boolean,
  message: string,
): "pushed" | "committed" | null {
  // Follow the same routing as HunchStore.captureHome: unified ("shared") mode homes
  // EVERY capture in the overlay, so the flush must go there too — one source of truth.
  if (store.captureHome(isPrivate) === "private") {
    if (store.privateAutoCommit && store.privateDir) {
      commitAndPushHunch(store.privateDir, message);
      return "pushed";
    }
    return null;
  }
  if (!store.autoCommit) return null;
  commitAndPushHunch(publicHunchDir, message, { push: false });
  return "committed";
}
