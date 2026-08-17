/** The hardened gate for `hunch check --strict` (and the strict pre-commit hook):
 *  which invariants may actually FAIL a commit. Extracted + pure so the rule lives
 *  in one audited, unit-tested place (mirrors hookpolicy.ts).
 *
 *  A commit is only ever blocked by a DIRECTLY-scoped, high-confidence, NON-STALE
 *  blocking invariant — never by a blast-radius ("near") guess, nor by a record the
 *  graph may have gone stale on, nor by a low-confidence auto-derived guess. Those
 *  weaker signals still print, as advisory. This makes strict mode safe to enable
 *  on a shared repo: a false positive downgrades to a warning instead of wrongly
 *  failing a teammate's commit. */
import { isInForce } from "./topics.js";

export const STRICT_MIN_CONFIDENCE = 0.8;

/** Is a provenance source HUMAN-CONFIRMED? Token-aware, so a composite source like
 *  "llm_draft+human_confirmed" counts, but a lookalike ("not_human_confirmed",
 *  "human_confirmed_pending") does not. The sources Hunch writes are "+"-joined. */
export function isHumanConfirmed(source: string | undefined): boolean {
  return (source ?? "").split("+").includes("human_confirmed");
}

export interface StrictConstraint {
  severity?: string;
  provenance?: { confidence?: number; source?: string };
}

/** May this invariant FAIL a commit under --strict? Requires blocking severity,
 *  a fresh (non-stale) record, and either high provenance confidence or a
 *  human-confirmed source (a person vouched for it). Near/blast-radius hits never
 *  reach here — the caller passes only directly-scoped invariants. */
export function isStrictBlocker(c: StrictConstraint, stale: boolean): boolean {
  if (c.severity !== "blocking") return false;
  if (stale) return false;
  const confidence = c.provenance?.confidence ?? 0;
  return confidence >= STRICT_MIN_CONFIDENCE || isHumanConfirmed(c.provenance?.source);
}

export type VetoTier = "dep" | "symbol" | "pattern" | "semantic";

/** May a VETO fail a commit? Sibling of isStrictBlocker, but keys on the TRIPWIRE's
 *  trust — not the rejecting decision's — and uses ONE rule for every tier: only a
 *  `human_confirmed` tripwire blocks. An llm_draft tripwire never blocks regardless
 *  of confidence (an LLM self-score is not a licence to fail a commit); it only
 *  warns. Semantic similarity never blocks. In-force + non-stale gates run first.
 *  This is what makes the "day-one is advisory" DX true (dec_a466655539). */
export function isVetoBlocker(
  d: { status?: string; superseded_by?: string | null; valid_to?: string | null },
  tw: { provenance?: { source?: string } },
  tier: VetoTier,
  stale: boolean,
): boolean {
  // Shared in-force predicate (core/topics.ts): superseded, REJECTED and
  // window-closed decisions all lose their teeth here, not just superseded ones.
  if (!isInForce(d)) return false;
  if (stale) return false; // freshness gate
  if (tier === "semantic") return false; // never block on similarity
  return isHumanConfirmed(tw.provenance?.source); // confirmed ⇒ blocks, any tier
}
