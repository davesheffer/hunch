/**
 * Record compaction (bounds unbounded Hunch growth). Auto-captured drafts
 * accumulate forever; `hunch compact` prunes the LOW-VALUE ones — never an
 * accepted/human-confirmed decision, never an open bug, never a constraint
 * (invariants are sacred), and never a record another record still points to.
 *
 * planCompaction is PURE (takes `now`) so it is fully testable; the CLI supplies
 * Date.now(). Reference safety uses a greatest-fixpoint so records being pruned in
 * the same pass don't keep each other (or a cycle of dead drafts) alive.
 */
import type { Bug, Constraint, Decision, EntityKind } from "../core/types.js";

export interface CompactionCandidate {
  kind: EntityKind;
  id: string;
  title: string;
  reason: string;
}

export interface CompactionPlan {
  remove: CompactionCandidate[];
  /** how many records were considered (decisions + bugs). */
  considered: number;
}

export interface CompactionInput {
  decisions: Decision[];
  bugs: Bug[];
  constraints: Constraint[];
}

export interface CompactionOpts {
  now: number;
  maxAgeDays?: number;
  minConfidence?: number;
}

const DAY_MS = 86_400_000;

export function planCompaction(input: CompactionInput, opts: CompactionOpts): CompactionPlan {
  const maxAgeDays = opts.maxAgeDays ?? 180;
  const minConfidence = opts.minConfidence ?? 0.35;

  const ageDays = (iso: string): number => {
    const t = Date.parse(iso);
    return Number.isNaN(t) ? 0 : (opts.now - t) / DAY_MS; // unparseable date → treat as new (don't prune)
  };

  // Step 1: INTRINSIC low-value reason (ignoring cross-references). Curated records
  // (accepted / human-confirmed / open bugs / constraints) are never candidates.
  const decReason = (d: Decision): string | null => {
    if (d.status === "accepted" || d.provenance.source.includes("human_confirmed")) return null;
    const low = d.provenance.confidence < minConfidence;
    const old = ageDays(d.date) >= maxAgeDays;
    if (d.status === "rejected") return "rejected draft";
    if (d.status === "superseded" && old) return `superseded, ${Math.round(ageDays(d.date))}d old`;
    if (d.status === "proposed" && low && old) return `stale low-confidence draft (${d.provenance.confidence}, ${Math.round(ageDays(d.date))}d)`;
    return null;
  };
  const bugReason = (b: Bug): string | null => {
    if (b.provenance.source.includes("human_confirmed")) return null;
    // Only fixed, low-confidence bugs that did NOT anchor a lineage (spawned a
    // constraint OR a decision) are prunable; open/investigating/regressed are kept.
    if (b.status === "fixed" && b.provenance.confidence < minConfidence && !b.lineage.spawned_constraint && !b.lineage.spawned_decision) {
      return "resolved low-confidence bug";
    }
    return null;
  };

  const decReasons = new Map<string, string>();
  for (const d of input.decisions) { const r = decReason(d); if (r) decReasons.set(d.id, r); }
  const bugReasons = new Map<string, string>();
  for (const b of input.bugs) { const r = bugReason(b); if (r) bugReasons.set(b.id, r); }

  // Step 2: greatest-fixpoint reference safety. Start with ALL candidates, then
  // repeatedly drop any candidate that a SURVIVING record (one not currently slated
  // for removal) still points to. References from records that are themselves being
  // removed don't protect anything — so two dead drafts can't keep each other alive,
  // and reference cycles among removable records resolve correctly.
  const remDec = new Set(decReasons.keys());
  const remBug = new Set(bugReasons.keys());
  for (;;) {
    const refDec = new Set<string>();
    const refBug = new Set<string>();
    for (const d of input.decisions) {
      if (remDec.has(d.id)) continue; // d is being removed → its references don't count
      if (d.supersedes) refDec.add(d.supersedes);
      if (d.caused_by_bug) refBug.add(d.caused_by_bug);
    }
    for (const b of input.bugs) {
      if (remBug.has(b.id)) continue;
      if (b.lineage.recurrence_of) refBug.add(b.lineage.recurrence_of);
      if (b.lineage.spawned_decision) refDec.add(b.lineage.spawned_decision);
    }
    for (const c of input.constraints) {
      if (c.source_decision) refDec.add(c.source_decision); // constraints are never removed → always survivors
    }
    let changed = false;
    for (const id of [...remDec]) if (refDec.has(id)) { remDec.delete(id); changed = true; }
    for (const id of [...remBug]) if (refBug.has(id)) { remBug.delete(id); changed = true; }
    if (!changed) break;
  }

  const remove: CompactionCandidate[] = [];
  for (const d of input.decisions) if (remDec.has(d.id)) remove.push({ kind: "decisions", id: d.id, title: d.title, reason: decReasons.get(d.id)! });
  for (const b of input.bugs) if (remBug.has(b.id)) remove.push({ kind: "bugs", id: b.id, title: b.title, reason: bugReasons.get(b.id)! });

  // constraints are invariants — intentionally never auto-removed.
  return { remove, considered: input.decisions.length + input.bugs.length };
}
