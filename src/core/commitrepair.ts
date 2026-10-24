/**
 * Deterministic repair of a decision's commit provenance after a squash-merge.
 *
 * A squash-merge lands ONE new commit on the target branch; the original
 * per-commit SHAs are never its ancestors, so a decision citing one of them
 * becomes orphaned. This module matches each orphaned decision to exactly one
 * newly merged commit: the candidate
 * with the same patch-id, or failing that the ONE whose changed files are a
 * superset of the decision's related_files. Zero or multiple qualifying
 * candidates means "don't guess" — same discipline as repair.ts's
 * rename-repair.
 */
import { createHash } from "node:crypto";
import type { Decision } from "./types.js";
import type { CommitCandidate, CommitRepairStatus } from "../extractors/git.js";
import { replaceExact } from "./refrepair.js";

/** One proposed provenance fix: decision `id` cites `from`, which should cite `to`. */
export interface CommitRewrite {
  id: string;
  from: string;
  to: string;
}

/** Bind review to the ordered queue and which targets are currently resolvable.
 * Queue order matters: duplicate decision ids use first-match selection. */
export function commitRepairReviewHash(queued: readonly CommitRewrite[], withheld: ReadonlySet<CommitRewrite> = new Set()): string {
  const snapshot = queued.map((r) => ({ id: r.id, from: r.from, to: r.to, withheld: withheld.has(r) }));
  return `sha256:${createHash("sha256").update(JSON.stringify(snapshot)).digest("hex")}`;
}

/**
 * Tombstone for a rewrite a human explicitly rejected with `--drop`. The key is
 * the full `{id, from, to}` triple, not just `{id, from}`: a later merge that
 * proposes a DIFFERENT `to` for the same `{id, from}` is a new proposal and
 * must surface normally.
 */
export interface DroppedRewrite {
  id: string;
  from: string;
  to: string;
}

export interface CommitRepairPlan {
  rewrites: CommitRewrite[];
  /** Distinct decision ids the rewrites touch. */
  records: string[];
}

/** True when a scope entry can serve as an exact match key (non-empty, no glob metacharacters). */
function isExactScope(entry: string): boolean {
  return entry.length > 0 && !/[*?[\]{}]/.test(entry);
}

/** Live decisions whose cited commit is orphaned (unresolvable/unknown/current are excluded). */
export function orphanedCommitDecisions(
  decisions: readonly Decision[],
  status: (sha: string) => CommitRepairStatus,
): Decision[] {
  return decisions.filter((d) =>
    d.status !== "superseded" && d.status !== "rejected" && !!d.commit && status(d.commit) === "orphaned");
}

/** Match each orphaned decision to exactly one candidate. A candidate with the
 *  same `git patch-id --stable` as the orphaned commit (a rebase- or
 *  single-commit squash-merge of it) is the strong match and wins. Only when
 *  no candidate shares the patch-id does it fall back to the one candidate
 *  whose changed files are a superset of the decision's related_files
 *  (non-empty, no globs) -- needed for a squash of several commits, whose
 *  patch-id never equals any one of them, but weak: shared files like
 *  CHANGELOG.md often have one wrong superset (#450). */
export function planCommitRepair(
  orphaned: readonly Decision[],
  candidates: readonly CommitCandidate[],
  patchIdOf: (sha: string) => string | null = () => null,
): CommitRepairPlan {
  const rewrites: CommitRewrite[] = [];
  for (const d of orphaned) {
    const patchId = patchIdOf(d.commit!);
    if (patchId) {
      const same = candidates.filter((c) => patchIdOf(c.sha) === patchId);
      if (same.length === 1) {
        rewrites.push({ id: d.id, from: d.commit!, to: same[0]!.sha });
        continue;
      }
      if (same.length > 1) continue; // ambiguous: never guess
    }
    const scope = (d.related_files ?? []).filter(isExactScope);
    if (scope.length === 0) continue;
    const supersets = candidates.filter((c) => scope.every((f) => c.files.includes(f)));
    if (supersets.length === 1) rewrites.push({ id: d.id, from: d.commit!, to: supersets[0]!.sha });
  }
  return { rewrites, records: [...new Set(rewrites.map((r) => r.id))] };
}

/** Queued entries that are still answerable: the decision exists, still cites `from`, and is live. */
export function liveRewrites(queued: readonly CommitRewrite[], decisions: readonly Decision[]): CommitRewrite[] {
  const byId = new Map(decisions.map((d) => [d.id, d] as const));
  return queued.filter((r) => {
    const d = byId.get(r.id);
    return !!d && d.commit === r.from && d.status !== "superseded" && d.status !== "rejected";
  });
}

/**
 * Queued entries whose decision IS visible but moved on (different or null
 * commit) or was superseded/rejected. An id absent from `decisions` is never
 * dead: absence comes from the reader's view (a branch checkout, an unmounted
 * private overlay) and the CLI deletes whatever this returns. Caveat: a decision
 * that differs between branches could still read as "moved on".
 */
export function deadRewrites(queued: readonly CommitRewrite[], decisions: readonly Decision[]): CommitRewrite[] {
  const byId = new Map(decisions.map((d) => [d.id, d] as const));
  return queued.filter((r) => {
    const d = byId.get(r.id);
    if (!d) return false;
    return d.commit !== r.from || d.status === "superseded" || d.status === "rejected";
  });
}

/** Ids of `toApply` whose decision is visible, whether or not the rewrite changed it. */
export function resolvedRewriteIds(toApply: readonly CommitRewrite[], decisions: readonly Decision[]): Set<string> {
  const visible = new Set(decisions.map((d) => d.id));
  return new Set(toApply.filter((r) => visible.has(r.id)).map((r) => r.id));
}

const tripleKey = (r: { id: string; from: string; to: string }): string => JSON.stringify([r.id, r.from, r.to]);

/** Drop rewrites whose exact {id, from, to} triple is tombstoned. A plain filter: survivors keep identity. */
export function withoutDropped<T extends CommitRewrite>(rewrites: readonly T[], dropped: readonly DroppedRewrite[]): T[] {
  if (dropped.length === 0) return [...rewrites];
  const keys = new Set(dropped.map(tripleKey));
  return rewrites.filter((r) => !keys.has(tripleKey(r)));
}

/** `existing` followed by the entries of `newly` whose exact triple is not already tombstoned. */
export function addDropped(newly: readonly DroppedRewrite[], existing: readonly DroppedRewrite[]): DroppedRewrite[] {
  const keys = new Set(existing.map(tripleKey));
  const out = [...existing];
  for (const n of newly) {
    const k = tripleKey(n);
    if (keys.has(k)) continue;
    keys.add(k);
    out.push(n);
  }
  return out;
}

/**
 * Fresh detections first, then the queued entries they did not override. A fresh
 * entry overrides only the FIRST queued entry with its id (see `firstFor`);
 * later duplicate-id siblings survive untouched.
 */
export function mergeRewrites(fresh: readonly CommitRewrite[], queued: readonly CommitRewrite[]): CommitRewrite[] {
  const overridden = new Set<CommitRewrite>();
  for (const f of fresh) {
    const hit = firstFor(queued, f.id);
    if (hit) overridden.add(hit);
  }
  return [...fresh, ...queued.filter((q) => !overridden.has(q))];
}

/**
 * Split entries by whether their proposed `to` resolves here. `existing === null`
 * means the check could not run, so it fails open (everything applicable).
 * Order and object references are preserved.
 */
export function withheldForUnresolvableTo(
  toApply: readonly CommitRewrite[],
  existing: ReadonlySet<string> | null,
): { applicable: CommitRewrite[]; withheld: CommitRewrite[] } {
  if (existing === null) return { applicable: [...toApply], withheld: [] };
  const applicable: CommitRewrite[] = [];
  const withheld: CommitRewrite[] = [];
  for (const r of toApply) (existing.has(r.to) ? applicable : withheld).push(r);
  return { applicable, withheld };
}

/** The single first-match rule for duplicate decision ids. */
export function firstFor<T extends { id: string }>(entries: readonly T[], id: string): T | undefined {
  return entries.find((e) => e.id === id);
}

/** The plan's rewrite for `id` (first match). */
export function pickRewrite(plan: CommitRepairPlan, id: string): CommitRewrite | undefined {
  return firstFor(plan.rewrites, id);
}

/**
 * Pure: apply the plan's rewrite to a decision. Returns the same reference when
 * there is no entry or the record moved on (`commit` no longer equals `from`);
 * otherwise a copy with `commit` and the `commit:<from>` evidence moved to `to`
 * (deduped if `to` was already cited).
 */
export function repairDecisionCommit(d: Decision, plan: CommitRepairPlan): Decision {
  const entry = pickRewrite(plan, d.id);
  if (!entry || d.commit !== entry.from) return d;
  return {
    ...d,
    commit: entry.to,
    provenance: {
      ...d.provenance,
      evidence: replaceExact(d.provenance.evidence, `commit:${entry.from}`, `commit:${entry.to}`).values,
    },
  };
}
