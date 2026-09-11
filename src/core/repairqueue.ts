/**
 * Local-only queue of commit-provenance repairs detected opportunistically
 * (typically by the post-merge hook, src/integrations/hooks.ts) but not yet
 * applied. `.hunch/pending-commit-repairs.json` is gitignored the same way
 * `.hunch/local.json` is — never committed, never pushed. It exists because
 * the opportunistic detection window is narrow: `ORIG_HEAD` gets overwritten
 * by the next merge, and the matched-away commit can eventually be gc'd —
 * queuing the exact {id, from, to} triple here lets a human confirm the match
 * later (`hunch repair-provenance --apply`) without losing it.
 *
 * `.hunch/dropped-commit-repairs.json` is the sibling tombstone file: a human
 * rejecting a queued match via `--drop` records the exact {id, from, to}
 * triple here, durably, so detection re-deriving the identical match on a
 * later merge doesn't re-queue what was already rejected — a genuinely
 * different replacement (`to`) for the same still-orphaned commit is a new
 * proposal and still surfaces (see commitrepair.ts's withoutDropped). Same
 * local-only, gitignored discipline as the queue.
 */
import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { writeFileAtomic } from "./io.js";
import { withoutDropped, withheldForUnresolvableTo, type CommitRewrite, type DroppedRewrite } from "./commitrepair.js";
import { commitsExist } from "../extractors/git.js";

function queuePath(root: string): string {
  return join(root, ".hunch", "pending-commit-repairs.json");
}

function droppedPath(root: string): string {
  return join(root, ".hunch", "dropped-commit-repairs.json");
}

function isCommitRewrite(value: unknown): value is CommitRewrite {
  if (!value || typeof value !== "object") return false;
  const { id, from, to } = value as CommitRewrite;
  // Non-empty, and to !== from — an empty target is never a useful rewrite,
  // and a no-op entry would apply "successfully" while accomplishing nothing.
  // Deliberately NOT a hex-shape check: from/to are opaque strings elsewhere
  // in this codebase's test fixtures, and repairDecisionCommit's own
  // `d.commit === mine.from` guard already makes a garbage `from` inert (it
  // can never match a real decision). A garbage `to` is caught elsewhere,
  // not here: `hunch repair-provenance --apply` runs commitsExist against
  // every `to` it's actually about to act on (the whole queue, or just the
  // one entry `--only <id>` targets) before repairDecisionCommit ever sees
  // it, and leaves a non-resolving entry queued rather than applying it
  // (withheldForUnresolvableTo, src/core/commitrepair.ts) — with the caveat
  // that commitsExist itself fails OPEN if the check can't run at all (not a
  // git repo, git missing, timeout), same as drift.ts's own use of it. This
  // filter stays shape-only on purpose — the existence check needs a
  // repository to run against, which this read-only queue loader doesn't
  // have.
  return typeof id === "string" && !!id
    && typeof from === "string" && !!from
    && typeof to === "string" && !!to
    && to !== from;
}

function isDroppedRewrite(value: unknown): value is DroppedRewrite {
  if (!value || typeof value !== "object") return false;
  const { id, from, to } = value as DroppedRewrite;
  return typeof id === "string" && !!id
    && typeof from === "string" && !!from
    && typeof to === "string" && !!to;
}

/** Tolerant read: a missing or corrupt queue file is treated as empty — this
 *  is local scratch state, never a source of truth worth failing loudly over. */
export function readPendingRepairs(root: string): CommitRewrite[] {
  const path = queuePath(root);
  if (!existsSync(path)) return [];
  try {
    const parsed: unknown = JSON.parse(readFileSync(path, "utf8"));
    return Array.isArray(parsed) ? parsed.filter(isCommitRewrite) : [];
  } catch {
    return [];
  }
}

export function writePendingRepairs(root: string, rewrites: readonly CommitRewrite[]): void {
  writeFileAtomic(queuePath(root), JSON.stringify(rewrites, null, 2) + "\n");
}

/** Tolerant read, same discipline as readPendingRepairs. */
export function readDroppedRepairs(root: string): DroppedRewrite[] {
  const path = droppedPath(root);
  if (!existsSync(path)) return [];
  try {
    const parsed: unknown = JSON.parse(readFileSync(path, "utf8"));
    return Array.isArray(parsed) ? parsed.filter(isDroppedRewrite) : [];
  } catch {
    return [];
  }
}

export function writeDroppedRepairs(root: string, dropped: readonly DroppedRewrite[]): void {
  writeFileAtomic(droppedPath(root), JSON.stringify(dropped, null, 2) + "\n");
}

/** The queue as every READ-ONLY consumer should see it: raw entries minus
 *  anything a human already rejected via `--drop`, regardless of how a
 *  tombstoned entry ended up back in the raw queue file (e.g. the post-merge
 *  hook's backgrounded detection racing a `--drop`). A read-time filter, not
 *  a mutation — the raw queue file is untouched.
 *
 *  `repair-provenance`'s own action is the one exception: it needs the RAW
 *  read (via readPendingRepairs) because it diffs raw-vs-swept to report what
 *  it cleaned up, and it persists the sweep back to disk. Every other
 *  reader — `hunch escalations`, SessionStart orientation, the `hunch_now`
 *  and `hunch_escalations` MCP tools — must call this instead, or a
 *  tombstoned entry that hasn't yet been swept by a `repair-provenance` run
 *  re-surfaces as if the human never answered it. */
export function readActivePendingRepairs(root: string): CommitRewrite[] {
  return withoutDropped(readPendingRepairs(root), readDroppedRepairs(root));
}

/** The `queued` entries whose proposed `to` doesn't resolve to a real commit
 *  in this repository — the same withheldForUnresolvableTo gate
 *  `repair-provenance --apply` itself runs before writing, surfaced here so
 *  a READ-ONLY consumer (hunch escalations, hunch_now/hunch_escalations,
 *  SessionStart orientation) can tell a permanently-stuck entry apart from
 *  one `--apply` can still resolve, instead of advertising a
 *  `--apply --only <id>` that's guaranteed to no-op forever. `null` from
 *  commitsExist (the check itself failed to run) is treated as fail-open —
 *  same discipline as the apply path — so nothing is misreported as
 *  withheld just because the check couldn't run.
 *
 *  Returns the OBJECTS, not their ids, and every caller must pass the exact
 *  same `queued` array into both this function and whatever it hands the
 *  result to (commitRepairEscalations) — an id-keyed set would collapse a
 *  corrupted queue's two same-id entries (one resolvable, one not) into one
 *  unit, exactly the identity confusion withheldForUnresolvableTo's own
 *  docstring warns about. */
export function withheldRewrites(root: string, queued: readonly CommitRewrite[]): Set<CommitRewrite> {
  const existing = commitsExist(queued.map((r) => r.to), root);
  return new Set(withheldForUnresolvableTo(queued, existing).withheld);
}
