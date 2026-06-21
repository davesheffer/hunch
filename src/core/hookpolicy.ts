/** Decision logic for the strict agent hook (`hunch hook`): does editing a file
 *  hit a BLOCKING invariant — directly (its scope matches) or via blast radius
 *  (a guarded dependency)? Extracted from the CLI so it is unit-testable against a
 *  real HunchStore, and so the model-facing refusal text lives in one audited
 *  place. Mirrors the `hunch check` direct/near logic, blocking-severity only. */
import type { HunchStore } from "../store/hunchStore.js";

export interface BlockingHit {
  /** Refusal text fed back to the model as the deny reason. Deliberately states
   *  ONLY the invariant — never how to disable the guard, so an autonomous agent
   *  cannot be coached into lowering enforcement to get its edit through. */
  reason: string;
}

/** Return a BlockingHit if editing `file` (repo-relative) hits a blocking
 *  invariant directly or through its blast radius, else null. */
export function blockingInScope(store: HunchStore, file: string): BlockingHit | null {
  for (const c of store.checkConstraints(file)) {
    if (c.severity === "blocking") {
      return {
        reason: `Hunch: editing ${file} would touch a BLOCKING invariant — "${c.statement}" (${c.id}). Do not proceed unless this change is meant to modify that invariant; otherwise preserve it.`,
      };
    }
  }
  for (const b of store.blastRadiusFiles(file)) {
    for (const c of store.checkConstraints(b.file)) {
      if (c.severity === "blocking") {
        return {
          reason: `Hunch: ${file} is in the blast radius of a BLOCKING invariant — "${c.statement}" (${c.id}; via ${b.file}, ${b.via} depth ${b.depth}). Verify the invariant still holds before editing.`,
        };
      }
    }
  }
  return null;
}

/** Return a BlockingHit if the proposed added lines for `file` re-introduce an
 *  approach an in-force decision deliberately REJECTED (a blocking veto), else null.
 *  The deny text states ONLY the decision + receipt (what was rejected, what was
 *  chosen) — never how to supersede or disable the guard, so an autonomous agent
 *  cannot be coached into reversing a decision to land its edit (dec_a466655539). */
/** Flatten the proposed-edit text from a PreToolUse `tool_input` across all three
 *  edit tools — Edit (`new_string`), Write (`content`), MultiEdit (`edits[].new_string`)
 *  — into candidate added lines for the Veto Guard. Empty input → []. */
export function proposedEditLines(
  toolInput: { new_string?: string; content?: string; edits?: Array<{ new_string?: string }> } | undefined,
): string[] {
  const parts = [toolInput?.new_string, toolInput?.content, ...(toolInput?.edits ?? []).map((e) => e?.new_string)]
    .filter((s): s is string => !!s);
  return parts.length ? parts.join("\n").split("\n") : [];
}

export function vetoInScope(store: HunchStore, file: string, proposedAddedLines: string[]): BlockingHit | null {
  const hit = store.vetoForFileEdit(file, proposedAddedLines).find((v) => v.blocks);
  if (!hit) return null;
  return {
    reason: `Hunch: editing ${file} would REVERSE decision ${hit.decision} — you rejected "${hit.alternative}" and chose "${hit.chosen}". Do not re-introduce the rejected approach; preserve the chosen design.`,
  };
}
