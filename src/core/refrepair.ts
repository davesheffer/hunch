/**
 * Deterministic repair for a decision's file references.
 *
 * A path may appear both in `related_files` (the scope used by the guards) and in
 * provenance evidence (the audit trail). Updating only one leaves misleading
 * memory behind, so this small helper always changes both together and only on an
 * exact match — never a risky substring rewrite.
 */
import type { Decision } from "./types.js";

export interface DecisionReferenceRepair {
  decision: Decision;
  relatedFiles: number;
  evidence: number;
}

function replaceExact(values: string[], from: string, to: string): { values: string[]; changed: number } {
  let changed = 0;
  const replaced = values.map((value) => {
    if (value !== from) return value;
    changed++;
    return to;
  });
  // A decision may already cite the destination. Keep the reference list a set
  // after the repair so a correction cannot create duplicate scope/evidence.
  return { values: [...new Set(replaced)], changed };
}

/**
 * Return a corrected copy of a decision, or `null` when the source reference is
 * not present. The decision's semantic content and verification timestamp are
 * intentionally preserved: this repairs a locator, it does not re-approve intent.
 */
export function repairDecisionReference(
  decision: Decision,
  from: string,
  to: string,
): DecisionReferenceRepair | null {
  const files = replaceExact(decision.related_files, from, to);
  const evidence = replaceExact(decision.provenance.evidence, from, to);
  if (!files.changed && !evidence.changed) return null;

  return {
    decision: {
      ...decision,
      related_files: files.values,
      provenance: { ...decision.provenance, evidence: evidence.values },
    },
    relatedFiles: files.changed,
    evidence: evidence.changed,
  };
}
