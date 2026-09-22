/**
 * Move a repo's PUBLIC engineering memory into its PRIVATE overlay, for
 * `hunch private --migrate` (turn a public-by-default repo into a code-only public
 * repo whose memory lives in a separate private store).
 *
 * The merge is a UNION BY ID: every public record is absorbed into the private
 * store, and a record that already exists on both sides (e.g. a decision present
 * in both) is resolved by the same precedence the merge driver uses (human-confirmed
 * › higher confidence › more recent › deterministic tiebreak). Private-only records
 * are preserved untouched. This NEVER deletes from the public store — the CLI empties
 * it separately (JsonStore.dropAll) only after this returns, so an interrupted move
 * can't lose records.
 */
import { ENTITY_KINDS, type EntityKind, type EntityFor } from "../core/types.js";
import type { JsonStore } from "./jsonStore.js";
import { mergeRecordsById } from "./merge.js";

export interface MoveResult {
  /** Per-kind count of public records absorbed into the overlay. */
  moved: Partial<Record<EntityKind, number>>;
  /** Total public records absorbed. */
  total: number;
}

/** Union every public record into `priv` (by id). Returns what was absorbed.
 *  Idempotent: re-running with the same input rewrites identical content. */
export function movePublicMemoryToPrivate(pub: JsonStore, priv: JsonStore): MoveResult {
  priv.ensureDirs();
  const moved: Partial<Record<EntityKind, number>> = {};
  let total = 0;
  for (const kind of ENTITY_KINDS) {
    const pubRecs = pub.loadAll(kind) as Array<Record<string, unknown>>;
    // The validating loader SKIPS corrupt/invalid/future-schema records with a
    // warning — but the CLI empties the public store right after this returns,
    // which would silently DELETE exactly those skipped records (and then
    // untrack + gitignore their only git history). Refuse instead: prove every
    // on-disk record actually loaded before anything becomes deletable
    // (issue #29). A kind whose only records are invalid also stops here, so
    // the "0 loaded → skip merge" path below can never precede a wipe.
    const rawCount = pub.rawRecordCount(kind);
    if (rawCount !== pubRecs.length) {
      throw new Error(
        `refusing to migrate ${kind}: ${rawCount - pubRecs.length} on-disk record(s) failed to load (see the warnings above) `
        + `and would be deleted without ever reaching the overlay. Fix or remove them, then re-run \`hunch private --migrate\`.`,
      );
    }
    if (pubRecs.length === 0) continue;
    const privRecs = priv.loadAll(kind) as Array<Record<string, unknown>>;
    // Same proof for the OVERLAY side: replaceAll below deletes every overlay
    // file whose id is not in the merged set, and a record the loader skipped
    // is never in it — so an unloadable overlay record (corrupt, or written by
    // a newer Hunch) would be deleted as "stale" and the deletion pushed to the
    // shared remote (issue #289).
    const privRawCount = priv.rawRecordCount(kind);
    if (privRawCount !== privRecs.length) {
      throw new Error(
        `refusing to migrate ${kind}: ${privRawCount - privRecs.length} overlay record(s) failed to load (see the warnings above) `
        + `and would be deleted from the overlay by the merge. Fix or remove them (or update Hunch if they come from a newer version), then re-run \`hunch private --migrate\`.`,
      );
    }
    // base=[] so both sides' records are treated as additions; collisions resolved
    // by pickWinner. Public is "theirs", private "ours" — order is irrelevant since
    // pickWinner is symmetric for equal-provenance records.
    const merged = mergeRecordsById([], privRecs, pubRecs);
    // replaceAll re-validates each record against its schema (records loaded here
    // are already current-schema), and writes atomically per file (con_902759b3dc).
    priv.replaceAll(kind, merged as unknown as EntityFor[EntityKind][]);
    moved[kind] = pubRecs.length;
    total += pubRecs.length;
  }
  return { moved, total };
}
