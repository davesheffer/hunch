/** Recent finished tasks as delivered context.
 *
 * Task records (`.hunch/tasks/`) say what earlier agent work did around a file:
 * which lessons it received, what it applied, saved and checked, and whether a
 * rule was violated. Delivering the newest few next to the invariants lets the
 * next agent build on verified work instead of rediscovering it. Supplements
 * share the brief's budget and are advisory: a task line is history, never a
 * rule, and never an instruction to repeat or skip anything. */
import type { DeliverySupplement } from "./delivery.js";
import type { SlotName, TaskSelection } from "./taskRanking.js";
import type { TaskRecord } from "./types.js";

export const TASK_SUPPLEMENT_LIMIT = 3;

function clip(text: string, max: number): string {
  return text.length <= max ? text : `${text.slice(0, max - 1).trimEnd()}…`;
}

/** One bounded line for a task: identity, when, what reached it, what it did. */
export function describeTaskRecord(t: TaskRecord): string {
  const when = t.finished_at.slice(0, 10);
  const lessons = t.lessons.length
    ? `${t.lessons.length} lesson(s): ${t.lessons.slice(0, 3).map((l) => l.record_id).join(", ")}${t.lessons.length > 3 ? "…" : ""}`
    : "no memory delivered";
  const applied = t.applied.length
    ? `applied ${t.applied.length} (${t.applied.some((a) => a.supported_by) ? "rule-supported" : "agent-reported"})`
    : null;
  const saved = t.saved.length ? `saved ${t.saved.slice(0, 3).map((s) => s.record_id).join(", ")}${t.saved.length > 3 ? "…" : ""}` : null;
  const last = t.checks.at(-1);
  const check = last ? `check "${clip(last.label, 40)}" ${last.state}` : "no check recorded";
  const violated = t.conformance.some((c) => c.outcome === "violated") ? "RULE VIOLATED" : null;
  const denied = t.refusals ? `${t.refusals} edit(s) denied` : null;
  const files = t.files.length ? `files ${t.files.slice(0, 4).join(", ")}${t.files.length > 4 ? "…" : ""}` : null;
  return `${t.id} · ${when} · ${t.state} · "${clip(t.title, 80)}" — ${[lessons, applied, saved, check, violated, denied, files].filter(Boolean).join(" · ")}`;
}

function summarizeRecord(t: TaskRecord): string {
  const lessons = t.lessons.length ? `${t.lessons.length} lesson(s)` : "no memory delivered";
  const applied = t.applied.length ? `applied ${t.applied.length}` : null;
  const saved = t.saved.length ? `saved ${t.saved.length}` : null;
  const last = t.checks.at(-1);
  const check = last ? `check ${last.state}` : null;
  return [lessons, applied, saved, check].filter(Boolean).join(", ");
}

const SLOT_LABEL: Record<SlotName, string> = { latest: "latest  ", violation: "problem ", relevant: "relevant" };

/** Render a ranked, slotted selection (dec_66925aa0ee): one line per pick with
 * its slot and the two strongest factual reasons. Empty selection → nothing. */
export function taskSelectionSupplements(selection: TaskSelection, target: string): DeliverySupplement[] {
  if (!selection.picks.length) return [];
  const counts: Record<SlotName, number> = { latest: 0, violation: 0, relevant: 0 };
  for (const p of selection.picks) counts[p.slot]++;
  const parts = selection.mode === "latest"
    ? `latest ${counts.latest} (ranking off: it lost its evaluation; hunch task rank-eval)`
    : [counts.latest ? "latest" : null, counts.violation ? "problem" : null, counts.relevant ? `relevant ${counts.relevant}` : null].filter(Boolean).join(" · ");
  // `hash_text`: the IDENTITY of the records this selection picked, for the
  // pre-edit hook's injection dedup. Every presentation field here is volatile
  // between two back-to-back calls with no record change — the slot label and
  // counts move with ranking warmth, and the reason text flips ("today" →
  // "delivered today", or to a different top reason) because serving the block
  // writes delivery receipts the next call's ranking reads back. Hashing the
  // rendered line therefore made the block self-invalidating and re-sent the
  // full 3-4KB grounding.
  //
  // What the identity KEEPS, because each is a property of the records, the
  // repo or the evaluation state and never of a receipt:
  //  - header: the target, the picked set of record ids (sorted, so order is
  //    not a change), `selection.mode` (ranker vs the "latest" fallback the
  //    kill rule imposes — resolved from .hunch/local.json or the rank-eval
  //    report), and `selection.more` (gated candidates minus picks; the gates
  //    read superseded ids, anchor liveness and file/rule structure — scores
  //    only order them, so the count does not move with warmth);
  //  - per task: its id, its own content hash, and whether its file anchors
  //    are still all alive (`anchorsAlive < 1` — the fact behind the "files
  //    since changed" reason), so a picked task whose anchors die mid-session
  //    re-sends the full block instead of leaving a silently stale line.
  return [
    {
      id: "recent-tasks", kind: "recent-tasks", priority: 415,
      text: `RECENT TASKS on ${target} — ${parts} — earlier agent work here, from graph memory (advisory history, not rules): build on what was verified instead of redoing it blind.${selection.more > 0 ? ` ${selection.more} more: hunch task list ${target}.` : ""}`,
      hash_text: `recent-tasks ${target} ${[...selection.picks.map((p) => p.ranked.record.id)].sort().join(",")} mode=${selection.mode ?? "ranked"} more=${selection.more}`,
    },
    ...selection.picks.map((p, i) => {
      const t = p.ranked.record;
      const reasons = p.ranked.reasons.slice(0, 2).join(" · ");
      return {
        id: t.id, kind: "recent-task", priority: 414 - i,
        text: `${SLOT_LABEL[p.slot]} ${t.id} · ${t.finished_at.slice(0, 10)} · "${clip(t.title, 80)}" — ${reasons} · ${summarizeRecord(t)}`,
        hash_text: `${t.id}@${t.report_hash}${p.ranked.anchorsAlive < 1 ? "!stale" : ""}`,
      };
    }),
  ];
}

/** Newest first, bounded. Empty input yields no supplement at all (no header noise). */
export function taskSupplements(tasks: readonly TaskRecord[], target: string, limit = TASK_SUPPLEMENT_LIMIT): DeliverySupplement[] {
  const recent = [...tasks]
    .sort((a, b) => b.finished_at.localeCompare(a.finished_at) || a.id.localeCompare(b.id))
    .slice(0, Math.max(1, limit));
  if (!recent.length) return [];
  const older = tasks.length - recent.length;
  return [
    {
      id: "recent-tasks", kind: "recent-tasks", priority: 415,
      text: `RECENT TASKS on ${target} — earlier agent work here, from graph memory (advisory history, not rules): build on what was verified instead of redoing it blind.${older > 0 ? ` ${older} older task(s) not shown; hunch task list.` : ""}`,
    },
    ...recent.map((t, i) => ({ id: t.id, kind: "recent-task", priority: 414 - i, text: describeTaskRecord(t) })),
  ];
}
