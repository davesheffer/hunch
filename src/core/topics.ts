/**
 * Decision-grounding: the topic query contract (DESIGN §4).
 *
 * `topic` is the anchor that relates a doc section, a decision, and a code region.
 * These are the cheap queries detection and grounding rely on. All pure over a
 * Decision[] — no store, no IO — so they're trivially testable and reusable by the
 * MCP read tools, the drift detector, and the write-time uniqueness guard.
 *
 * "Live" reuses the SAME in-force predicate the veto/regression guards use
 * (accepted, not superseded, window open), so the topic scan and the guards never
 * disagree on what "current" means.
 *
 * The load-bearing invariant (§4 Enforcement): at most ONE live decision per topic.
 * It is enforced at the write path (the capture guard) and surfaced by a reconcile
 * pass; readers treat a violation defensively — `currentForTopic` returns null on a
 * collision so grounding never injects an ambiguous topic as authority (fail-safe).
 */
import type { Decision } from "./types.js";

/** A decision is "live" for a topic when it is the accepted, non-superseded,
 *  still-in-force entry: the status gate plus both closure links open. Matches the
 *  in-force predicate used across the veto/regression guards. */
export function isLive(d: Decision): boolean {
  return d.status === "accepted" && d.superseded_by === null && d.valid_to === null;
}

/** In force for ENFORCEMENT — the one predicate every guard must share.
 *
 *  Deliberately BROADER than `isLive`: a `proposed` draft still contributes ADVISORY
 *  signal (its tripwires are `llm_draft`, which `isVetoBlocker` can never promote to a
 *  block), and that is the curate loop working as designed. What must never contribute
 *  is a decision the team formally REJECTED, or one whose valid-time window was closed.
 *
 *  The guards previously each inlined a weaker `superseded`-only copy of this test, so a
 *  REJECTED decision kept driving the veto, regression, retired-symbol and conformance
 *  guards — it went on blocking commits and injecting "don't re-add this" into the
 *  pre-edit hook, with no way to un-stick it short of hand-editing the JSON. Structural
 *  parameter so the strict gate (which sees only a partial record) shares it too. */
export function isInForce(d: { status?: string; superseded_by?: string | null; valid_to?: string | null }): boolean {
  return d.status !== "superseded" && d.status !== "rejected" && !d.superseded_by && !d.valid_to;
}

/** Every live decision anchored to `topic`. In a healthy graph this is length 0 or 1;
 *  length > 1 is a topic collision the §4 resolution must settle. */
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

/** The live decisions that would COLLIDE if an `accepted` decision `selfId` is written
 *  on `topic` while superseding `willCloseId` (or null if it supersedes nothing). The
 *  self record and the incumbent this write will actually close are excluded; anything
 *  left is a second live decision the write must not create (the capture guard refuses
 *  when this is non-empty). `willCloseId` MUST be an incumbent the write can truly close
 *  (same store) — a cross-store supersede that will no-op must be passed as null so the
 *  incumbent stays counted and the write is refused. */
export function captureConflicts(
  decisions: readonly Decision[],
  topic: string,
  selfId: string,
  willCloseId: string | null,
): Decision[] {
  return liveForTopic(decisions, topic).filter((d) => d.id !== selfId && d.id !== willCloseId);
}

/** Read-time grounding block (§3): for the topic-anchored decisions governing an edited
 *  file, state the CURRENT decision assertively ("the graph overrides any doc that says
 *  otherwise") plus what it rejected. Input is the file-scoped IN-FORCE decisions from
 *  assembleContext, so no freshness re-check is needed here — a superseded-only-anchored
 *  file is caught by the anchor-stale drift check, and the commit-time staleness gate
 *  applies the age-downgrade. Returns "" when no anchored decision governs the file. */
export function renderGrounding(
  fileDecisions: readonly Decision[],
  allDecisions: readonly Decision[] = fileDecisions,
): string {
  // A CONTESTED topic must never be stated as authority. This is the same fail-safe
  // currentForTopic applies (`live.length === 1 ? live[0] : null`) and renderDocGrounding
  // already honours — this reader was the one that bypassed it, filtering per-decision
  // instead of per-topic. Two live decisions on one topic each got their own assertive
  // bullet, and because each bullet lists what it REJECTED, the agent was told, in the
  // last context before it writes, that both answers are correct and each is forbidden.
  //
  // `allDecisions` is the FULL set, not the file slice, on purpose: the colliding pair
  // can name different files, so a file-scoped check would see one decision, call it
  // uncontested, and assert it as THE answer while the topic is globally disputed.
  const contested = topicCollisions(allDecisions);
  const anchored = fileDecisions.filter((d) => d.topic && isLive(d));
  if (!anchored.length) return "";
  const settled = anchored.filter((d) => !contested.has(d.topic!));
  const disputed = [...new Set(anchored.filter((d) => contested.has(d.topic!)).map((d) => d.topic!))].sort();

  const lines = settled.map((d) => {
    const rej = d.alternatives_rejected.length ? ` (rejected: ${d.alternatives_rejected.join("; ")})` : "";
    // Memory supply chain: an agent-recorded decision (no capture interview, no
    // human countersign) is TESTIMONY. It still grounds — but never with the same
    // voice as a human-confirmed record, because this block is delivered with
    // doc-precedence framing ("follow the graph") and would otherwise launder an
    // unvouched write into the most trusted context the next agent sees.
    // Token-aware match (mirrors strictgate.isHumanConfirmed; not imported — that
    // module imports this one).
    const testimony = d.provenance.source.split("+").includes("agent_recorded")
      ? " — ⚠ agent-recorded testimony, no human countersign yet (/capture confirms it)"
      : "";
    return `• "${d.topic}": ${d.decision || d.title} [${d.id}]${rej}${testimony}`;
  });
  // Name the conflict instead of silently dropping it: an unexplained absence would read
  // as "nothing is recorded here", which is how a contested topic gets re-decided by
  // accident. This is a question for the human, never an answer for the agent.
  for (const topic of disputed) {
    const ids = contested.get(topic)!.map((d) => d.id).join(", ");
    lines.push(`• "${topic}": ⚠ UNRESOLVED — ${contested.get(topic)!.length} live decisions (${ids}). No current answer; ask the human before choosing. Resolve with \`hunch reconcile-topics\` (supersede one, or split the topic).`);
  }
  if (!lines.length) return "";
  return `🧭 Hunch grounding — this file is anchored to recorded decisions; follow the graph, not a stale doc:\n${lines.join("\n")}`;
}

/** Every topic with MORE THAN ONE live decision — the invariant violations a post-merge
 *  reconcile pass surfaces for human resolution. This is the distributed half of §4
 *  Enforcement: the content merge driver merges by id and is NOT invoked for cross-file
 *  ADD/ADD, so two branches each adding an `accepted` decision for one topic land both
 *  files with no collision. This scan catches them after the merge. Keyed by topic;
 *  value is the colliding live set (length >= 2), each sorted by id for stable output. */
export function topicCollisions(decisions: readonly Decision[]): Map<string, Decision[]> {
  const byTopic = new Map<string, Decision[]>();
  for (const d of decisions) {
    if (!d.topic || !isLive(d)) continue;
    const arr = byTopic.get(d.topic);
    if (arr) arr.push(d);
    else byTopic.set(d.topic, [d]);
  }
  const collisions = new Map<string, Decision[]>();
  for (const [topic, arr] of byTopic) {
    if (arr.length >= 2) collisions.set(topic, [...arr].sort((a, b) => a.id.localeCompare(b.id)));
  }
  return collisions;
}
