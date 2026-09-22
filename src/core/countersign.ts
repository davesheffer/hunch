/** Human countersign: turn agent testimony into a human-confirmed record.
 *
 *  A capture token proves an interview protocol was issued, not that a human answered
 *  (see capturetoken.ts), so agent-written decisions and corrections land as
 *  `agent_recorded` testimony. This is the pure record transform behind the human act
 *  that upgrades them — `hunch review --confirm <id>` (and, for a correction, the
 *  severity the human grants). It never changes a record's content or status: confirming
 *  a proposed decision is not shipping it. Pure (caller passes `now`) so it is testable. */
import type { Constraint, Decision } from "./types.js";
import { TESTIMONY_CORRECTION_RATIONALE, VOUCHED_CORRECTION_RATIONALE } from "./correction.js";

/** Is this record agent testimony awaiting a human countersign? Token-aware ("+"-joined
 *  sources), and a record carrying a human signature is never testimony. */
export function isAgentTestimony(source: string | undefined): boolean {
  const tokens = (source ?? "").split("+");
  return tokens.includes("agent_recorded") && !tokens.includes("human_confirmed");
}

/** The exact command a HUMAN runs to countersign agent testimony (outside the agent
 *  channel). `private` targets the overlay home; `severity` grants a correction's authority. */
export function confirmCommand(id: string, opts: { private?: boolean; severity?: string } = {}): string {
  return `hunch review --confirm ${id}${opts.severity ? ` --severity ${opts.severity}` : ""}${opts.private ? " --private" : ""}`;
}

/** Replace the agent testimony tier with the human signature, keeping every other
 *  "+"-joined source token ("llm_draft+agent_recorded" → "llm_draft+human_confirmed"). */
export function withHumanSignature(source: string): string {
  const tokens = source.split("+").filter((t) => t && t !== "agent_recorded");
  if (!tokens.includes("human_confirmed")) tokens.push("human_confirmed");
  return tokens.join("+");
}

/** Countersign a decision. Same tier + confidence the capture path grants a human-confirmed
 *  write; status, content, and tripwires are untouched (`hunch review --accept` is the path
 *  that ships a draft and arms its tripwires). */
export function countersignDecision(d: Decision, now: string): Decision {
  return {
    ...d,
    provenance: {
      ...d.provenance,
      source: withHumanSignature(d.provenance.source),
      confidence: Math.max(d.provenance.confidence ?? 0, 0.95),
      last_verified: now,
    },
  };
}

/** Countersign a correction. `severity`, when given, is the authority the human grants
 *  (an unconfirmed "blocking" request was capped to "warning"); otherwise it is kept. */
export function countersignConstraint(c: Constraint, now: string, severity?: Constraint["severity"]): Constraint {
  return {
    ...c,
    severity: severity ?? c.severity,
    rationale: c.rationale === TESTIMONY_CORRECTION_RATIONALE ? VOUCHED_CORRECTION_RATIONALE : c.rationale,
    provenance: {
      ...c.provenance,
      source: withHumanSignature(c.provenance.source),
      confidence: 1,
      last_verified: now,
    },
  };
}
