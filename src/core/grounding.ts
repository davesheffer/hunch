/**
 * Decision-grounding: read-time injection (DESIGN §3).
 *
 * When an agent is about to act on a file anchored to a recorded decision, Hunch
 * injects the CURRENT decision for that topic over whatever a (possibly stale) doc
 * says — "the graph overrides the doc." This is the "supply correct reads" half of
 * the hook, distinct from the blocking Veto ("block bad writes").
 *
 * Two safety guards from §3 live here, not in prose:
 *  - Fail-safe on ambiguity: a topic with no single current decision (none, or an
 *    unresolved >1-live collision) injects NOTHING — never a coin-flip authority.
 *  - Freshness downgrade: `confidence` is set once and never decays, so age (not
 *    confidence) decides authority. A decision not affirmed within the staleness
 *    window is injected as ADVISORY ("confirm before relying"), not hard authority —
 *    the guard against weaponizing a rotted decision against a correcting doc.
 */
import type { Decision } from "./types.js";
import { currentForTopic } from "./topics.js";
import { toPosixTarget } from "./paths.js";

/** Days since last affirmation beyond which a decision is injected as advisory, not
 *  authoritative. Half a year: long enough not to nag fresh decisions, short enough
 *  that a decision nobody has touched in two release cycles stops being hard truth. */
export const GROUNDING_STALE_DAYS = 180;

export interface Grounding {
  topic: string;
  decision: Decision;
  /** Days since `last_affirmed_at`, or null when the decision has no freshness clock. */
  ageDays: number | null;
  authority: "authoritative" | "advisory";
}

/** Whole days between an ISO instant and `nowMs`; null if absent, unparseable, or in
 *  the FUTURE. A negative age (affirmed in the future) is an anomalous freshness clock
 *  — clock skew across machines in a git-shared graph, a merge carrying a future-dated
 *  winner, or hand-edited JSON — and must NOT be clamped to 0 (which would read as the
 *  freshest possible and upgrade a rotted decision to hard authority). null → advisory. */
function ageDaysOf(last: string | undefined, nowMs: number): number | null {
  if (!last) return null;
  const t = Date.parse(last);
  if (Number.isNaN(t)) return null;
  const age = Math.floor((nowMs - t) / 86_400_000);
  return age < 0 ? null : age;
}

/** Does the decision explicitly govern this file? Posix-normalized exact match against
 *  its related_files — grounding only injects a topic's current decision over a file
 *  the current decision actually claims (not one a superseded predecessor listed but the
 *  successor dropped). Mirrors the drift detector's carried-forward guard. */
function relatesToFile(d: Decision, target: string): boolean {
  const t = toPosixTarget(target);
  return (d.related_files ?? []).some((f) => toPosixTarget(f) === t);
}

/** For every topic among the file-scoped decisions, resolve the CURRENT decision for
 *  that topic (across the whole graph, so a superseded local reference is grounded to
 *  its successor) and grade its authority by freshness. Un-anchored decisions and
 *  ambiguous topics are skipped (nothing injected — fail-safe). */
export function groundDecisions(
  fileDecisions: readonly Decision[],
  allDecisions: readonly Decision[],
  nowMs: number,
  target?: string,
): Grounding[] {
  const topics = new Set<string>();
  for (const d of fileDecisions) if (d.topic) topics.add(d.topic);
  const out: Grounding[] = [];
  for (const topic of topics) {
    const cur = currentForTopic(allDecisions, topic);
    if (!cur) continue; // none or unresolved collision → inject nothing
    // Scope guard: when grounding for a specific edit target, only inject the current
    // decision over a file it actually governs. A superseded predecessor may have
    // anchored this file while the successor narrowed scope and dropped it — grounding
    // must not assert authority over a file the current decision no longer claims.
    if (target && !relatesToFile(cur, target)) continue;
    const ageDays = ageDaysOf(cur.last_affirmed_at, nowMs);
    // Conservative: an unknown age (no clock, or a future/anomalous one) is NOT proof of
    // freshness, so it grades advisory, never hard authority. Only a decision affirmed
    // within the window is injected as graph-over-doc truth.
    const authority = ageDays === null || ageDays > GROUNDING_STALE_DAYS ? "advisory" : "authoritative";
    out.push({ topic, decision: cur, ageDays, authority });
  }
  return out;
}

/** Render the grounding block injected at edit/read time. States graph-over-doc for
 *  fresh decisions; downgrades aged ones to advisory instead of hard authority. */
export function renderGrounding(groundings: readonly Grounding[]): string {
  if (!groundings.length) return "";
  const lines = groundings.map((g) => {
    const body = g.decision.decision || g.decision.title;
    const age = g.ageDays === null ? "" : ` (last affirmed ${g.ageDays}d ago)`;
    if (g.authority === "advisory") {
      return `• "${g.topic}"${age} — ADVISORY (aged; confirm it still holds before relying): ${body} [${g.decision.id}]`;
    }
    return `• "${g.topic}"${age} — CURRENT decision; the graph overrides any doc that says otherwise: ${body} [${g.decision.id}]`;
  });
  return `🧭 Hunch grounding — this file is anchored to recorded decisions. Follow the graph, not a stale doc:\n${lines.join("\n")}`;
}
