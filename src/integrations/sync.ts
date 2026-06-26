/**
 * The single funnel for keeping the PRIVATE overlay synced to its git remote on every write,
 * so memory never has to be pushed by hand. A no-op unless auto-commit is enabled
 * (`hunch private`); when enabled it commits + two-way-syncs (merge remote, then push) via
 * commitAndPushHunch. Used by every CLI/MCP path that writes a private record.
 */
import type { HunchStore } from "../store/hunchStore.js";
import { commitAndPushHunch } from "../extractors/git.js";

/** Auto-commit + push the overlay after a private write, when auto-commit is on. No-op
 *  otherwise (manual `hunch private --sync` still works). Never throws. */
export function flushPrivate(store: HunchStore, message: string): void {
  if (store.privateAutoCommit && store.privateDir) commitAndPushHunch(store.privateDir, message);
}
