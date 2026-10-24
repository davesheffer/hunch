/**
 * Local-only queue of detected-but-not-yet-applied commit-provenance repairs.
 *
 * It is filled opportunistically, usually by the post-merge hook, and is
 * gitignored like `.hunch/local.json` -- never committed. It exists because the
 * detection window is narrow: `ORIG_HEAD` gets overwritten and the matched-away
 * commit can be garbage-collected. A human confirms later with
 * `hunch repair-provenance --apply`. A sibling tombstone file records the exact
 * `{id, from, to}` triples rejected with `--drop`, so re-detection does not
 * re-queue them.
 */
import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { writeFileAtomic } from "./io.js";
import { withoutDropped, withheldForUnresolvableTo } from "./commitrepair.js";
import type { CommitRewrite, DroppedRewrite } from "./commitrepair.js";
import { commitsExist } from "../extractors/git.js";

const queuePath = (root: string): string => join(root, ".hunch", "pending-commit-repairs.json");
const droppedPath = (root: string): string => join(root, ".hunch", "dropped-commit-repairs.json");

const nonEmpty = (v: unknown): v is string => typeof v === "string" && v.length > 0;

/**
 * Shape-only validation: non-empty string id/from/to, and `to !== from` (a no-op
 * is rejected). There is deliberately no hex check -- a bad `to` is caught later
 * by the apply-time existence check, so this loader stays shape-only.
 */
function isRewrite(v: unknown): v is CommitRewrite {
  if (typeof v !== "object" || v === null) return false;
  const r = v as Record<string, unknown>;
  return nonEmpty(r.id) && nonEmpty(r.from) && nonEmpty(r.to) && r.to !== r.from;
}

function isDropped(v: unknown): v is DroppedRewrite {
  if (typeof v !== "object" || v === null) return false;
  const r = v as Record<string, unknown>;
  return nonEmpty(r.id) && nonEmpty(r.from) && nonEmpty(r.to);
}

function readList<T>(file: string, guard: (v: unknown) => v is T): T[] {
  if (!existsSync(file)) return [];
  try {
    const parsed: unknown = JSON.parse(readFileSync(file, "utf8"));
    return Array.isArray(parsed) ? parsed.filter(guard) : [];
  } catch {
    return [];
  }
}

/** The raw queue. Missing, corrupt or non-array files read as `[]`; never throws. */
export function readPendingRepairs(root: string): CommitRewrite[] {
  return readList(queuePath(root), isRewrite);
}

/** Atomically replace the queue. Writing `[]` clears it. */
export function writePendingRepairs(root: string, rewrites: readonly CommitRewrite[]): void {
  writeFileAtomic(queuePath(root), JSON.stringify(rewrites, null, 2) + "\n");
}

/** The tombstones of rewrites rejected with `--drop`. Same tolerance as the queue. */
export function readDroppedRepairs(root: string): DroppedRewrite[] {
  return readList(droppedPath(root), isDropped);
}

/** Atomically replace the tombstone file. Writing `[]` clears it. */
export function writeDroppedRepairs(root: string, dropped: readonly DroppedRewrite[]): void {
  writeFileAtomic(droppedPath(root), JSON.stringify(dropped, null, 2) + "\n");
}

/**
 * The raw queue minus anything tombstoned. Read-only: it never changes either
 * file. Every read-only consumer uses this -- `hunch escalations`, SessionStart
 * orientation, and the `hunch_now` and `hunch_escalations` MCP tools. Only
 * `repair-provenance` itself reads the raw queue.
 */
export function readActivePendingRepairs(root: string): CommitRewrite[] {
  return withoutDropped(readPendingRepairs(root), readDroppedRepairs(root));
}

/**
 * The queued entries whose proposed `to` does not resolve in this repository.
 * Fails open (nothing withheld) when git cannot answer. The set holds the
 * caller's own objects, so callers must pass the same `queued` array here and to
 * whatever consumes the result.
 */
export function withheldRewrites(root: string, queued: readonly CommitRewrite[]): Set<CommitRewrite> {
  const existing = commitsExist(queued.map((r) => r.to), root);
  return new Set(withheldForUnresolvableTo(queued, existing).withheld);
}
