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

export type EscalationKind = "topic-conflict";

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
