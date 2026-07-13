/**
 * Self-repair (Phase 5 slice 1): heal memory bindings after a rename/move, with
 * ZERO guessing. Git's own rename detection (`commitChanges`, -M) is the only
 * source of old→new pairs, and only EXACT path matches are rewritten — a glob, a
 * prefix, or anything ambiguous is left alone. Deleted paths stay the drift
 * detector's job (dead refs); this module never touches them.
 *
 * Per §59.5: safe repairs auto-apply in the background and land as a revertable
 * `repair` move on the memory timeline; anything this planner cannot prove safe
 * simply isn't in the plan. Pure — no store, no git, no IO — so it is fully
 * unit-testable; the sync path and `hunch repair` share it.
 */
import type { Decision, Constraint } from "./types.js";

export interface RenamePair {
  before: string;
  after: string;
}

export interface BindingRewrite {
  kind: "decisions" | "constraints";
  id: string;
  /** which binding field was healed (for the receipt / commit message). */
  field: "related_files" | "tripwire.scope" | "scope";
  from: string;
  to: string;
}

export interface RepairPlan {
  rewrites: BindingRewrite[];
  /** record ids touched, deduped — the mutation surface. */
  records: string[];
}

/** A scope entry is exact (rewritable) only when it contains no glob syntax. */
function isExactPath(entry: string): boolean {
  return !/[*?[\]{}]/.test(entry);
}

/** Extract the rename pairs from a commit's change records (already 1:1 by git -M). */
export function renamesOf(changes: ReadonlyArray<{ status: string; before: string | null; after: string | null }>): RenamePair[] {
  return changes
    .filter((c) => c.status === "renamed" && c.before && c.after && c.before !== c.after)
    .map((c) => ({ before: c.before!, after: c.after! }));
}

/** Plan every safe rewrite. Only exact matches against a git-confirmed rename move;
 *  live records only (a superseded/retired record's history stays as written). */
export function planRepair(
  renames: readonly RenamePair[],
  decisions: readonly Decision[],
  constraints: readonly Constraint[],
): RepairPlan {
  const map = new Map(renames.map((r) => [r.before, r.after]));
  const rewrites: BindingRewrite[] = [];
  if (!map.size) return { rewrites, records: [] };

  for (const d of decisions) {
    if (d.status === "superseded" || d.status === "rejected") continue;
    for (const f of d.related_files ?? []) {
      const to = map.get(f);
      if (to) rewrites.push({ kind: "decisions", id: d.id, field: "related_files", from: f, to });
    }
    for (const tw of d.rejected_tripwires ?? []) {
      for (const s of tw.scope ?? []) {
        const to = isExactPath(s) ? map.get(s) : undefined;
        if (to) rewrites.push({ kind: "decisions", id: d.id, field: "tripwire.scope", from: s, to });
      }
    }
  }
  for (const c of constraints) {
    if (c.status && c.status !== "active") continue;
    for (const s of c.scope ?? []) {
      const to = isExactPath(s) ? map.get(s) : undefined;
      if (to) rewrites.push({ kind: "constraints", id: c.id, field: "scope", from: s, to });
    }
  }
  return { rewrites, records: [...new Set(rewrites.map((r) => `${r.kind}:${r.id}`))] };
}

/** Apply a plan's rewrites to one decision (pure — returns the healed copy, or the
 *  original reference when nothing in the plan touches it). */
export function repairDecision(d: Decision, plan: RepairPlan): Decision {
  const mine = plan.rewrites.filter((r) => r.kind === "decisions" && r.id === d.id);
  if (!mine.length) return d;
  const sub = (field: BindingRewrite["field"], value: string): string =>
    mine.find((r) => r.field === field && r.from === value)?.to ?? value;
  return {
    ...d,
    related_files: (d.related_files ?? []).map((f) => sub("related_files", f)),
    rejected_tripwires: (d.rejected_tripwires ?? []).map((tw) => ({
      ...tw,
      scope: (tw.scope ?? []).map((s) => sub("tripwire.scope", s)),
    })),
  };
}

/** Apply a plan's rewrites to one constraint (pure). */
export function repairConstraint(c: Constraint, plan: RepairPlan): Constraint {
  const mine = plan.rewrites.filter((r) => r.kind === "constraints" && r.id === c.id);
  if (!mine.length) return c;
  return {
    ...c,
    scope: (c.scope ?? []).map((s) => mine.find((r) => r.field === "scope" && r.from === s)?.to ?? s),
  };
}
