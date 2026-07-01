/**
 * Decision-grounding: the topic query contract (DESIGN §4).
 *
 * `topic` is the anchor that relates a doc section, a decision, and a code region.
 * These are the cheap queries detection and grounding rely on. All pure over a
 * Decision[] — no store, no IO — so they're trivially testable and reusable by the
 * MCP read tools, the drift detector, and the write-time uniqueness guard.
 *
 * The load-bearing invariant (§4 Enforcement): at most ONE live decision per topic.
 * It is enforced at the write path (the capture guard) and at merge time; these
 * readers treat a violation defensively — `currentForTopic` returns null on a
 * collision so grounding never injects an ambiguous topic as authority (fail-safe).
 */
import type { Decision } from "./types.js";

/** A decision is "live" for a topic when it is the accepted, non-superseded,
 *  still-in-force entry: the status gate plus both closure links open. */
export function isLive(d: Decision): boolean {
  return d.status === "accepted" && d.superseded_by === null && d.valid_to === null;
}

/** Every live decision anchored to `topic`. In a healthy graph this is length 0 or 1;
 *  length > 1 is a topic collision the §4 resolution must settle. Used by the capture
 *  guard (to refuse a second) and by grounding (to fail safe on ambiguity). */
export function liveForTopic(decisions: readonly Decision[], topic: string): Decision[] {
  return decisions.filter((d) => d.topic === topic && isLive(d));
}

/** current(topic): the single live decision for a topic, or null. Null when there is
 *  none — AND when the topic is in an unresolved collision (>1 live), because an
 *  ambiguous current must never be injected as authoritative truth. */
export function currentForTopic(decisions: readonly Decision[], topic: string): Decision | null {
  const live = liveForTopic(decisions, topic);
  return live.length === 1 ? live[0]! : null;
}

/** history(topic): the full chain for a topic, newest first (by effect-time). */
export function historyForTopic(decisions: readonly Decision[], topic: string): Decision[] {
  return decisions
    .filter((d) => d.topic === topic)
    .sort((a, b) => (b.valid_from ?? b.date).localeCompare(a.valid_from ?? a.date));
}

/** rejected(topic): the alternatives the current decision ruled out — what Veto/drift
 *  check a derived view against. Empty when there is no unambiguous current decision. */
export function rejectedForTopic(decisions: readonly Decision[], topic: string): string[] {
  const cur = currentForTopic(decisions, topic);
  return cur ? [...cur.alternatives_rejected] : [];
}
