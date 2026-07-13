/**
 * Review-queue shaping for `hunch review` (the capture → REVIEW → enforce funnel).
 *
 * Pure, deterministic, no I/O — so it's unit-testable away from the store. Reads the
 * `synth:` telemetry line that syncCommit parks in `provenance.evidence` and splits the
 * drafts into two groups so a reviewer can blast through the easy confirmations and then
 * scrutinize the rest:
 *   - READY      — the Critic AUDITED the draft and found it well-grounded
 *                  (source includes "verified" AND grounded >= threshold). Best first.
 *   - SCRUTINY   — everything else (unverified, low-grounded, verify failed/unavailable).
 *                  Lowest-confidence first, i.e. worst-first triage (unchanged behavior).
 */
import type { Decision } from "./types.js";

/** Parsed view of the `synth:` telemetry line (or {} when absent). */
export interface SynthInfo {
  provider?: string;
  grounded?: number;
  samples?: number;
  agreement?: number;
  pruned?: number;
  /** "unavailable" | "failed" — present only when verification was requested but didn't apply. */
  verify?: string;
  /** the raw telemetry body (the line minus the "synth:" prefix), for display. */
  raw?: string;
}

/** Extract the `synth:` line out of a decision's evidence and parse its `k=v` fields. */
export function parseSynth(evidence: string[] | undefined): SynthInfo {
  const line = (evidence ?? []).find((e) => e.startsWith("synth:"));
  if (!line) return {};
  const body = line.slice("synth:".length).trim();
  const num = (k: string): number | undefined => {
    const m = new RegExp(`\\b${k}=(-?[0-9]*\\.?[0-9]+)`).exec(body);
    return m ? Number(m[1]) : undefined;
  };
  const str = (k: string): string | undefined => {
    const m = new RegExp(`\\b${k}=([A-Za-z0-9_.\\-]+)`).exec(body);
    return m ? m[1] : undefined;
  };
  return {
    raw: body,
    provider: str("provider"),
    grounded: num("grounded"),
    samples: num("samples"),
    agreement: num("agreement"),
    pruned: num("pruned"),
    verify: str("verify"),
  };
}

/** Grounded-ness at/above which a Critic-verified draft is a "quick yes". */
export const READY_MIN_GROUNDED = 0.7;

/** Whether a decision is an un-vouched draft still awaiting a human — the ONLY thing
 *  the review path surfaces under the auto-trust model.
 *
 *  Low confidence NO LONGER makes a draft: captured memory is trusted-advisory the
 *  moment it lands (status `accepted`, source `llm_draft`), so it grounds and ranks
 *  but never nags. Only a DELIBERATE, not-yet-human-vouched `proposed` record — an
 *  explicit roadmap/intent entry a human hasn't confirmed — counts as a review draft.
 *  (Enforcement authority is granted INLINE, not by draining a background queue.) */
export function isReviewDraft(d: Decision): boolean {
  return d.status === "proposed" && !d.provenance.source.includes("human_confirmed");
}

export interface ReviewItem {
  d: Decision;
  synth: SynthInfo;
  verified: boolean;
}

export interface ReviewQueue {
  ready: ReviewItem[];
  scrutiny: ReviewItem[];
}

/** A draft is "ready to confirm" only when the Critic actually audited it (source
 *  includes "verified") AND judged it well-grounded. A high confidence number alone
 *  is NOT enough — an un-audited draft always needs human eyes. */
export function isReady(d: Decision, synth: SynthInfo, minGrounded: number = READY_MIN_GROUNDED): boolean {
  return d.provenance.source.includes("verified") && (synth.grounded ?? 0) >= minGrounded;
}

/** Split review drafts into ready-to-confirm (best-grounded first) and needs-scrutiny
 *  (lowest-confidence first). A draft is never in both groups. */
export function partitionReview(drafts: Decision[], minGrounded: number = READY_MIN_GROUNDED): ReviewQueue {
  const items: ReviewItem[] = drafts.map((d) => ({
    d,
    synth: parseSynth(d.provenance.evidence),
    verified: d.provenance.source.includes("verified"),
  }));
  const ready = items
    .filter((it) => isReady(it.d, it.synth, minGrounded))
    .sort((a, b) => (b.synth.grounded ?? 0) - (a.synth.grounded ?? 0));
  const scrutiny = items
    .filter((it) => !isReady(it.d, it.synth, minGrounded))
    .sort((a, b) => a.d.provenance.confidence - b.d.provenance.confidence);
  return { ready, scrutiny };
}
