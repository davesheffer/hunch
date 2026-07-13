/**
 * Inline escalations — the "ask the human IN THE PROMPT, not in a background queue"
 * half of the auto-trust model.
 *
 * Captured memory auto-trusts the moment it lands (status accepted, advisory), so
 * there is no draft queue to drain. The only things that still need a human are the
 * rare cases the graph genuinely CANNOT resolve on its own — and those are surfaced
 * as a short, question-framed list the assistant raises in conversation at the
 * moment, then normally EMPTY.
 *
 * Deterministic only. Today the sole kind is a topic conflict (>1 live decision for
 * one topic — a git merge can create these; see topics.topicCollisions). We do NOT
 * guess semantically which un-anchored decisions "contradict" each other — that
 * stays the assistant's judgment, asked in chat, never a machine verdict (same
 * explicit-anchors-only ethos as the drift detector).
 *
 * Pure over a Decision[] — no store, no IO — so the CLI, the MCP read tool, and the
 * session-start orientation all share one source of truth.
 */
import type { Decision } from "./types.js";
import { topicCollisions } from "./topics.js";

export type EscalationKind = "topic-conflict" | "policy-candidate" | "policy-proposal" | "policy-repaired";

export interface Escalation {
  kind: EscalationKind;
  /** the topic (or other key) the conflict is about. */
  topic: string;
  /** the decisions the human must choose between. */
  decisionIds: string[];
  /** a one-line, human-facing question the assistant should raise in the prompt. */
  question: string;
  /** the supporting detail (ids + titles) for the question. */
  detail: string;
  /** the concrete resolution the human's answer maps to. */
  resolution: string;
}

/** The decisions a human must make NOW, to be asked INLINE. Empty in a healthy graph. */
export function pendingEscalations(decisions: readonly Decision[]): Escalation[] {
  const out: Escalation[] = [];
  for (const [topic, decs] of topicCollisions(decisions)) {
    out.push({
      kind: "topic-conflict",
      topic,
      decisionIds: decs.map((d) => d.id),
      question: `Topic "${topic}" has ${decs.length} live decisions — which one is current?`,
      detail: decs.map((d) => `${d.id} — "${d.title}"`).join("  ·  "),
      resolution: `supersede the others: re-record the chosen one with supersedes:<other-id>, or split the topic.`,
    });
  }
  return out;
}

/** The minimal policy shape the escalation scan needs — a structural subset of
 *  constitution PolicySpec, so this module stays dependency-free of the
 *  Constitution schemas (core must not import constitution). */
export interface PolicyLite {
  id: string;
  state: string;
  statement: string;
  proof: string | null;
  authority: unknown;
  /** the policy's most recent audit action, when the caller has it — lets the
   *  scan surface auto-repaired policies that need a fresh proof. */
  last_action?: string | null;
}

/** The Constitution's genuine human moments (§59.5.3), framed as inline questions:
 *  a candidate awaiting review, and a proposed policy whose next step (prove, or
 *  accept/reject) is a human call. Machine conclusions never appear here as
 *  approvals — every entry is a QUESTION with its explicit resolution verb. */
export function policyEscalations(policies: readonly PolicyLite[]): Escalation[] {
  const out: Escalation[] = [];
  const clip = (s: string): string => (s.length > 90 ? s.slice(0, 89).trimEnd() + "…" : s);
  for (const p of policies) {
    // An auto-repaired policy asks FIRST (and only once): its bindings moved, so
    // its proof is stale by construction — the human moment is "re-prove it".
    if (p.last_action === "repaired" && (p.state === "proposed" || p.state === "active_advisory" || p.state === "active_blocking")) {
      out.push({
        kind: "policy-repaired",
        topic: p.id,
        decisionIds: [p.id],
        question: `Rule "${clip(p.statement)}" (${p.id}) was auto-repaired after a rename — its proof is stale; re-prove it?`,
        detail: `state ${p.state} · last action repaired · ${p.proof ? `proof ${p.proof} (stale)` : "no proof"}`,
        resolution: `hunch policy prove ${p.id} — blocking stays fail-safe until the fresh proof lands`,
      });
      continue;
    }
    if (p.state === "compiled" || p.state === "validating") {
      out.push({
        kind: "policy-candidate",
        topic: p.id,
        decisionIds: [p.id],
        question: `Candidate rule "${clip(p.statement)}" (${p.id}) awaits your review — keep it moving or reject it?`,
        detail: `state ${p.state} · authority none · not yet proved`,
        resolution: `hunch policy prove ${p.id} — then accept/reject; or hunch policy reject ${p.id} --reason "..."`,
      });
    } else if (p.state === "proposed") {
      out.push({
        kind: "policy-proposal",
        topic: p.id,
        decisionIds: [p.id],
        question: p.proof
          ? `Proposed rule "${clip(p.statement)}" (${p.id}) carries its proof — activate it (advisory/blocking) or reject it?`
          : `Proposed rule "${clip(p.statement)}" (${p.id}) has no current proof — prove it, then decide.`,
        detail: `state proposed · ${p.proof ? `proof ${p.proof}` : "no proof"} · authority none`,
        resolution: p.proof
          ? `inspect: hunch policy card ${p.id} — then hunch policy accept ${p.id} --advisory|--blocking --actor human:<you>, or reject`
          : `hunch policy prove ${p.id}`,
      });
    }
  }
  return out;
}
