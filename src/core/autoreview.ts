/**
 * Auto-review planner — the pure decision core behind `hunch auto-review`.
 *
 * It takes the draft set + a per-draft harness RelevanceVerdict (the "delegate to
 * the harness" judgment) and folds in the two DETERMINISTIC signals the store
 * already produces — near-duplicate detection (dupdetect) and grounding/Critic
 * verification (reviewqueue) — into four disjoint buckets:
 *
 *   accept          — confirm to human_confirmed. GATED: only Critic-verified,
 *                     well-grounded drafts the harness judged relevant + non-dup.
 *                     This is the dec_a466655539 line — a machine never confirms an
 *                     UN-audited draft; the harness verdict can only ADD a veto, not
 *                     substitute for the Critic's grounding.
 *   rejectDuplicate — delete: a near-duplicate of an accepted record (deterministic
 *                     dupdetect, OR the harness named an existing decision it restates).
 *   rejectIrrelevant— delete: the harness judged it not worth keeping, confidently.
 *   keep            — everything else stays for a human (the safe default).
 *
 * No I/O, no LLM calls here — verdicts are passed in — so it's fully unit-testable
 * and deterministic given its inputs.
 */
import type { Decision } from "./types.js";
import type { RelevanceVerdict } from "../synthesis/provider.js";
import { draftDuplicateOf } from "./dupdetect.js";
import { parseSynth, isReady, READY_MIN_GROUNDED } from "./reviewqueue.js";

export type AutoReviewAction = "accept" | "rejectDuplicate" | "rejectIrrelevant" | "keep";

export interface AutoReviewEntry {
  d: Decision;
  action: AutoReviewAction;
  /** human-readable justification for the action (shown in the plan). */
  reason: string;
  /** the harness verdict for this draft, when one was obtained. */
  verdict?: RelevanceVerdict;
  /** grounded-ness parsed from synth telemetry, when present. */
  grounded?: number;
}

export interface AutoReviewPlan {
  accept: AutoReviewEntry[];
  rejectDuplicate: AutoReviewEntry[];
  rejectIrrelevant: AutoReviewEntry[];
  keep: AutoReviewEntry[];
}

export interface AutoReviewConfig {
  /** grounded-ness threshold for the accept gate. */
  minGrounded?: number;
  /** minimum harness confidence to act on an "irrelevant" verdict (delete). Below
   *  this the draft is kept for a human — we never delete on a shaky judgment. */
  minRejectConfidence?: number;
}

const DEFAULT_MIN_REJECT_CONFIDENCE = 0.7;

/** Build the plan. `verdicts` maps draft id → harness verdict (absent → the draft
 *  was not judged, e.g. no CLI available; it can still be dup-rejected or kept). */
export function planAutoReview(
  drafts: Decision[],
  allDecisions: Decision[],
  verdicts: Map<string, RelevanceVerdict>,
  cfg: AutoReviewConfig = {},
): AutoReviewPlan {
  const minGrounded = cfg.minGrounded ?? READY_MIN_GROUNDED;
  const minReject = cfg.minRejectConfidence ?? DEFAULT_MIN_REJECT_CONFIDENCE;
  const plan: AutoReviewPlan = { accept: [], rejectDuplicate: [], rejectIrrelevant: [], keep: [] };

  for (const d of drafts) {
    const verdict = verdicts.get(d.id);
    const synth = parseSynth(d.provenance?.evidence);
    const grounded = synth.grounded;
    const base = { d, verdict, grounded };

    // 1) Duplicate — deterministic match against accepted records, or the harness
    //    naming an existing decision. Deterministic wins first (cheapest, surest).
    const detDup = draftDuplicateOf(d, allDecisions);
    if (detDup) {
      plan.rejectDuplicate.push({ ...base, action: "rejectDuplicate", reason: `near-duplicate of ${detDup.of.id} "${detDup.of.title}" (${Math.round(detDup.score * 100)}%)` });
      continue;
    }
    if (verdict?.duplicate_of && verdict.duplicate_of !== d.id && allDecisions.some((x) => x.id === verdict.duplicate_of)) {
      plan.rejectDuplicate.push({ ...base, action: "rejectDuplicate", reason: `harness: restates ${verdict.duplicate_of} — ${verdict.reason}` });
      continue;
    }

    // 2) Confidently-irrelevant — delete only on a strong harness "no".
    if (verdict && !verdict.relevant && verdict.confidence >= minReject) {
      plan.rejectIrrelevant.push({ ...base, action: "rejectIrrelevant", reason: `harness: not relevant (conf ${verdict.confidence}) — ${verdict.reason}` });
      continue;
    }

    // 3) Accept — ONLY when the Critic verified + grounded it (isReady) AND the
    //    harness judged it relevant. The harness can VETO an accept, never create
    //    one on its own (dec_a466655539: the human vouch / Critic gate is the floor).
    const ready = isReady(d, synth, minGrounded);
    if (ready && verdict?.relevant) {
      plan.accept.push({ ...base, action: "accept", reason: `verified + grounded ${grounded ?? "?"} ≥ ${minGrounded}, harness-relevant — ${verdict.reason}` });
      continue;
    }

    // 4) Keep for a human — the safe default (unverified, ungrounded, unjudged, or
    //    a low-confidence irrelevant call).
    const why = !verdict ? "not judged (no harness)"
      : !ready ? (verdict.relevant ? "relevant but not Critic-verified/grounded — needs human confirm" : `irrelevant but low confidence (${verdict.confidence})`)
      : "kept";
    plan.keep.push({ ...base, action: "keep", reason: why });
  }
  return plan;
}

/** Total drafts the plan would mutate (accept + both delete buckets). */
export function planMutations(plan: AutoReviewPlan): number {
  return plan.accept.length + plan.rejectDuplicate.length + plan.rejectIrrelevant.length;
}
