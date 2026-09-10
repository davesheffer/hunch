import { test } from "node:test";
import assert from "node:assert/strict";
import { orphanedCommitDecisions, planCommitRepair, repairDecisionCommit, pickRewrite, mergeRewrites, firstFor, liveRewrites, deadRewrites, resolvedRewriteIds, withoutDropped, addDropped, withheldForUnresolvableTo } from "../src/core/commitrepair.js";
import type { Decision } from "../src/core/types.js";
import type { CommitCandidate, CommitRepairStatus } from "../src/extractors/git.js";

const D = (over: Partial<Decision> & { id: string }): Decision => ({
  id: over.id, title: `t ${over.id}`, decision: "d", status: over.status ?? "accepted",
  related_files: over.related_files ?? [], rejected_tripwires: [],
  alternatives_rejected: [],
  commit: over.commit ?? null,
  provenance: { source: "human_confirmed", confidence: 0.9, evidence: over.commit ? [`commit:${over.commit}`] : [] },
  ...over,
} as unknown as Decision);

test("orphanedCommitDecisions: only live decisions with a non-ancestor commit are orphaned", () => {
  const statuses = new Map<string, CommitRepairStatus>([["sha_ancestor", "current"], ["sha_gone", "orphaned"]]);
  const status = (sha: string): CommitRepairStatus => statuses.get(sha) ?? "unresolvable";
  const decisions = [
    D({ id: "dec_ancestor", commit: "sha_ancestor" }),
    D({ id: "dec_orphaned", commit: "sha_gone" }),
    D({ id: "dec_no_commit", commit: null }),
    D({ id: "dec_superseded", commit: "sha_gone", status: "superseded" }),
    D({ id: "dec_rejected", commit: "sha_gone", status: "rejected" }),
  ];
  assert.deepEqual(orphanedCommitDecisions(decisions, status).map((d) => d.id), ["dec_orphaned"]);
});

test("orphanedCommitDecisions: unresolvable and unknown commits are never repair-eligible", () => {
  const statuses = new Map<string, CommitRepairStatus>([
    ["sha_orphaned", "orphaned"],
    ["sha_missing", "unresolvable"],
    ["sha_git_failed", "unknown"],
  ]);
  const status = (sha: string): CommitRepairStatus => statuses.get(sha)!;
  const decisions = [
    D({ id: "dec_orphaned", commit: "sha_orphaned" }),
    D({ id: "dec_foreign", commit: "sha_missing" }),
    D({ id: "dec_git_failed", commit: "sha_git_failed" }),
  ];
  assert.deepEqual(orphanedCommitDecisions(decisions, status).map((d) => d.id), ["dec_orphaned"]);
});

test("planCommitRepair: a unique related_files-subset match is rewritten", () => {
  const orphaned = [D({ id: "dec_1", commit: "sha_old", related_files: ["src/feature.ts"] })];
  const candidates: CommitCandidate[] = [{ sha: "sha_squash", files: ["src/feature.ts", "src/unrelated.ts"] }];
  const plan = planCommitRepair(orphaned, candidates);
  assert.deepEqual(plan.rewrites, [{ id: "dec_1", from: "sha_old", to: "sha_squash" }]);
  assert.deepEqual(plan.records, ["dec_1"]);
});

test("planCommitRepair: two candidates both match — ambiguous, skipped", () => {
  const orphaned = [D({ id: "dec_1", commit: "sha_old", related_files: ["src/feature.ts"] })];
  const candidates: CommitCandidate[] = [
    { sha: "sha_a", files: ["src/feature.ts"] },
    { sha: "sha_b", files: ["src/feature.ts", "src/other.ts"] },
  ];
  assert.deepEqual(planCommitRepair(orphaned, candidates), { rewrites: [], records: [] });
});

test("planCommitRepair: no candidate is a superset — no match, skipped", () => {
  const orphaned = [D({ id: "dec_1", commit: "sha_old", related_files: ["src/feature.ts", "src/other.ts"] })];
  const candidates: CommitCandidate[] = [{ sha: "sha_a", files: ["src/feature.ts"] }];
  assert.deepEqual(planCommitRepair(orphaned, candidates), { rewrites: [], records: [] });
});

test("planCommitRepair: empty or all-glob related_files never matches", () => {
  const orphaned = [
    D({ id: "dec_empty", commit: "sha_old", related_files: [] }),
    D({ id: "dec_glob", commit: "sha_old2", related_files: ["src/**"] }),
  ];
  const candidates: CommitCandidate[] = [{ sha: "sha_a", files: ["src/feature.ts"] }];
  assert.deepEqual(planCommitRepair(orphaned, candidates), { rewrites: [], records: [] });
});

test("repairDecisionCommit: rewrites commit and the matching evidence entry together", () => {
  const d = D({
    id: "dec_1",
    commit: "sha_old",
    related_files: ["src/feature.ts"],
    provenance: { source: "human_confirmed", confidence: 0.9, evidence: ["commit:sha_old", "src/feature.ts"] },
  });
  const plan = { rewrites: [{ id: "dec_1", from: "sha_old", to: "sha_new" }], records: ["dec_1"] };
  const healed = repairDecisionCommit(d, plan);
  assert.equal(healed.commit, "sha_new");
  assert.deepEqual(healed.provenance.evidence, ["commit:sha_new", "src/feature.ts"]);
});

test("repairDecisionCommit: dedupes evidence if the destination is already cited", () => {
  const d = D({
    id: "dec_1",
    commit: "sha_old",
    provenance: { source: "human_confirmed", confidence: 0.9, evidence: ["commit:sha_old", "commit:sha_new"] },
  });
  const plan = { rewrites: [{ id: "dec_1", from: "sha_old", to: "sha_new" }], records: ["dec_1"] };
  const healed = repairDecisionCommit(d, plan);
  assert.deepEqual(healed.provenance.evidence, ["commit:sha_new"]);
});

test("repairDecisionCommit: returns the same reference when the plan doesn't touch this decision", () => {
  const d = D({ id: "dec_untouched", commit: "sha_old" });
  const plan = { rewrites: [{ id: "dec_other", from: "sha_a", to: "sha_b" }], records: ["dec_other"] };
  assert.equal(repairDecisionCommit(d, plan), d);
});

test("repairDecisionCommit: bails atomically when the record's commit moved on since the plan was built", () => {
  const d = D({
    id: "dec_1",
    commit: "sha_moved",
    provenance: { source: "human_confirmed", confidence: 0.9, evidence: ["commit:sha_old"] },
  });
  const plan = { rewrites: [{ id: "dec_1", from: "sha_old", to: "sha_new" }], records: ["dec_1"] };
  assert.equal(repairDecisionCommit(d, plan), d);
});

test("firstFor: returns the first entry for an id, by object identity, when duplicates share it", () => {
  const first = { id: "dec_1", from: "sha_old", to: "sha_new" };
  const second = { id: "dec_1", from: "sha_old", to: "sha_other" };
  assert.equal(firstFor([first, second], "dec_1"), first);
  assert.notEqual(firstFor([first, second], "dec_1"), second);
});

test("firstFor: returns undefined when no entry matches the id", () => {
  assert.equal(firstFor([{ id: "dec_other", from: "sha_a", to: "sha_b" }], "dec_1"), undefined);
});

test("pickRewrite: returns the first entry for a decision id, matching repairDecisionCommit's own pick when a plan carries same-id duplicates", () => {
  const first = { id: "dec_1", from: "sha_old", to: "sha_new" };
  const second = { id: "dec_1", from: "sha_old", to: "sha_other" };
  const plan = { rewrites: [first, second], records: ["dec_1"] };
  assert.equal(pickRewrite(plan, "dec_1"), first, "first match wins, by object identity");
  assert.notEqual(pickRewrite(plan, "dec_1"), second);
});

test("pickRewrite: returns undefined when no entry matches the id", () => {
  const plan = { rewrites: [{ id: "dec_other", from: "sha_a", to: "sha_b" }], records: ["dec_other"] };
  assert.equal(pickRewrite(plan, "dec_1"), undefined);
});

test("mergeRewrites: a fresh match overrides a queued match for the same decision", () => {
  const fresh = [{ id: "dec_1", from: "sha_old", to: "sha_fresh" }];
  const queued = [{ id: "dec_1", from: "sha_old", to: "sha_stale" }];
  assert.deepEqual(mergeRewrites(fresh, queued), [{ id: "dec_1", from: "sha_old", to: "sha_fresh" }]);
});

test("mergeRewrites: queued-only and fresh-only entries both pass through", () => {
  const fresh = [{ id: "dec_fresh", from: "a", to: "b" }];
  const queued = [{ id: "dec_queued", from: "c", to: "d" }];
  const merged = mergeRewrites(fresh, queued);
  assert.equal(merged.length, 2);
  assert.deepEqual(merged.find((r) => r.id === "dec_fresh"), fresh[0]);
  assert.deepEqual(merged.find((r) => r.id === "dec_queued"), queued[0]);
});

test("mergeRewrites: empty inputs produce an empty result", () => {
  assert.deepEqual(mergeRewrites([], []), []);
});

test("mergeRewrites: a fresh match on a duplicate-id queue overrides only the entry pickRewrite would pick, leaving the untargeted sibling queued (#56)", () => {
  const fresh = [{ id: "dec_1", from: "sha_old", to: "sha_fresh" }];
  const first = { id: "dec_1", from: "sha_old", to: "sha_stale_1" };
  const second = { id: "dec_1", from: "sha_old", to: "sha_stale_2" };
  const queued = [first, second];
  assert.deepEqual(mergeRewrites(fresh, queued), [fresh[0], second], "only the first-match sibling is overridden; the second survives untouched");
});

test("liveRewrites: drops an entry whose decision no longer exists or whose commit already moved on", () => {
  const decisions = [
    D({ id: "dec_current", commit: "sha_old" }),
    D({ id: "dec_moved_on", commit: "sha_moved" }),
  ];
  const queued = [
    { id: "dec_current", from: "sha_old", to: "sha_new" },
    { id: "dec_moved_on", from: "sha_old", to: "sha_new" }, // stale — commit no longer matches
    { id: "dec_gone", from: "sha_old", to: "sha_new" }, // no such decision
  ];
  assert.deepEqual(liveRewrites(queued, decisions), [{ id: "dec_current", from: "sha_old", to: "sha_new" }]);
});

test("liveRewrites: excludes superseded/rejected decisions, same exclusion as orphanedCommitDecisions", () => {
  const decisions = [
    D({ id: "dec_superseded", commit: "sha_old", status: "superseded" }),
    D({ id: "dec_rejected", commit: "sha_old", status: "rejected" }),
  ];
  const queued = [
    { id: "dec_superseded", from: "sha_old", to: "sha_new" },
    { id: "dec_rejected", from: "sha_old", to: "sha_new" },
  ];
  assert.deepEqual(liveRewrites(queued, decisions), []);
});

test("deadRewrites: an entry whose decision isn't in the list at all is NOT dead — absence is the reader's problem, not proof the match is stale", () => {
  const decisions = [D({ id: "dec_present", commit: "sha_old" })];
  const queued = [
    { id: "dec_present", from: "sha_old", to: "sha_new" },
    { id: "dec_invisible", from: "sha_old", to: "sha_new" }, // e.g. a branch checkout that predates it
  ];
  assert.deepEqual(deadRewrites(queued, decisions), [], "neither entry is provably dead — dec_present still matches, dec_invisible is merely unresolved");
});

test("resolvedRewriteIds: a targeted decision that IS visible is resolved, whether or not it actually changed", () => {
  const decisions = [D({ id: "dec_present", commit: "sha_old" })];
  const toApply = [{ id: "dec_present", from: "sha_old", to: "sha_new" }];
  assert.deepEqual(resolvedRewriteIds(toApply, decisions), new Set(["dec_present"]));
});

test("resolvedRewriteIds: a targeted decision NOT present this run is never resolved — it must stay queued", () => {
  const decisions: Decision[] = [];
  const toApply = [{ id: "dec_invisible", from: "sha_old", to: "sha_new" }];
  assert.deepEqual(resolvedRewriteIds(toApply, decisions), new Set());
});

test("resolvedRewriteIds: a mix resolves only the visible ones", () => {
  const decisions = [D({ id: "dec_visible", commit: "sha_old" })];
  const toApply = [
    { id: "dec_visible", from: "sha_old", to: "sha_new" },
    { id: "dec_invisible", from: "sha_old", to: "sha_new" },
  ];
  assert.deepEqual(resolvedRewriteIds(toApply, decisions), new Set(["dec_visible"]));
});

test("withoutDropped: removes a fresh match that exactly matches a tombstoned {id, from, to} triple", () => {
  const fresh = [
    { id: "dec_dropped", from: "sha_old", to: "sha_rejected" },
    { id: "dec_kept", from: "sha_old2", to: "sha_new2" },
  ];
  const dropped = [{ id: "dec_dropped", from: "sha_old", to: "sha_rejected" }];
  assert.deepEqual(withoutDropped(fresh, dropped), [{ id: "dec_kept", from: "sha_old2", to: "sha_new2" }]);
});

test("withoutDropped: a genuinely different `to` for the same {id, from} is a NEW proposal, not suppressed", () => {
  const fresh = [{ id: "dec_1", from: "sha_orphaned", to: "sha_different_candidate" }];
  const dropped = [{ id: "dec_1", from: "sha_orphaned", to: "sha_rejected_candidate" }];
  assert.deepEqual(withoutDropped(fresh, dropped), fresh);
});

test("withoutDropped: a tombstone for a different `from` on the same id doesn't suppress an unrelated match", () => {
  const fresh = [{ id: "dec_1", from: "sha_current", to: "sha_new" }];
  const dropped = [{ id: "dec_1", from: "sha_stale_other", to: "sha_new" }];
  assert.deepEqual(withoutDropped(fresh, dropped), fresh);
});

test("withoutDropped: empty tombstone list is a no-op", () => {
  const fresh = [{ id: "dec_1", from: "a", to: "b" }];
  assert.deepEqual(withoutDropped(fresh, []), fresh);
});

test("withoutDropped: preserves object identity for every surviving entry — repair-provenance's swept-vs-active diff relies on filtering by reference, not re-deriving the {id, from, to} key", () => {
  const survivor = { id: "dec_kept", from: "a", to: "b" };
  const rejected = { id: "dec_dropped", from: "c", to: "d" };
  const result = withoutDropped([survivor, rejected], [{ id: "dec_dropped", from: "c", to: "d" }]);
  assert.equal(result.length, 1);
  assert.equal(result[0], survivor, "the surviving entry must be the SAME object reference, not an equal-but-rebuilt copy");
});

test("addDropped: appends a newly-dropped {id, from, to} triple", () => {
  const existing = [{ id: "dec_old", from: "sha_a", to: "sha_a2" }];
  const newly = [{ id: "dec_new", from: "sha_b", to: "sha_b2" }];
  assert.deepEqual(addDropped(newly, existing), [
    { id: "dec_old", from: "sha_a", to: "sha_a2" },
    { id: "dec_new", from: "sha_b", to: "sha_b2" },
  ]);
});

test("addDropped: never duplicates an already-tombstoned exact triple", () => {
  const existing = [{ id: "dec_1", from: "sha_a", to: "sha_a2" }];
  const newly = [{ id: "dec_1", from: "sha_a", to: "sha_a2" }];
  assert.deepEqual(addDropped(newly, existing), existing);
});

test("addDropped: a different `to` for the same {id, from} is recorded as its OWN tombstone, not deduped away", () => {
  const existing = [{ id: "dec_1", from: "sha_a", to: "sha_old_rejected" }];
  const newly = [{ id: "dec_1", from: "sha_a", to: "sha_new_rejected" }];
  assert.deepEqual(addDropped(newly, existing), [
    { id: "dec_1", from: "sha_a", to: "sha_old_rejected" },
    { id: "dec_1", from: "sha_a", to: "sha_new_rejected" },
  ]);
});

test("deadRewrites: an entry whose PRESENT decision moved on, or is superseded/rejected, is dead", () => {
  const decisions = [
    D({ id: "dec_moved_on", commit: "sha_moved" }),
    D({ id: "dec_superseded", commit: "sha_old", status: "superseded" }),
    D({ id: "dec_rejected", commit: "sha_old", status: "rejected" }),
  ];
  const queued = [
    { id: "dec_moved_on", from: "sha_old", to: "sha_new" },
    { id: "dec_superseded", from: "sha_old", to: "sha_new" },
    { id: "dec_rejected", from: "sha_old", to: "sha_new" },
  ];
  assert.deepEqual(deadRewrites(queued, decisions).map((r) => r.id).sort(), ["dec_moved_on", "dec_rejected", "dec_superseded"]);
});

test("withheldForUnresolvableTo: an entry whose `to` is in the existing set is applicable", () => {
  const toApply = [{ id: "dec_1", from: "a", to: "sha_real" }];
  const result = withheldForUnresolvableTo(toApply, new Set(["sha_real"]));
  assert.deepEqual(result.applicable, toApply);
  assert.deepEqual(result.withheld, []);
});

test("withheldForUnresolvableTo: an entry whose `to` does not resolve is withheld, not applicable — and never dropped from the caller's view", () => {
  const toApply = [{ id: "dec_1", from: "a", to: "sha_ghost" }];
  const result = withheldForUnresolvableTo(toApply, new Set());
  assert.deepEqual(result.applicable, []);
  assert.deepEqual(result.withheld, toApply);
});

test("withheldForUnresolvableTo: a mix partitions correctly", () => {
  const toApply = [
    { id: "dec_real", from: "a", to: "sha_real" },
    { id: "dec_ghost", from: "b", to: "sha_ghost" },
  ];
  const result = withheldForUnresolvableTo(toApply, new Set(["sha_real"]));
  assert.deepEqual(result.applicable.map((r) => r.id), ["dec_real"]);
  assert.deepEqual(result.withheld.map((r) => r.id), ["dec_ghost"]);
});

test("withheldForUnresolvableTo: existing === null (the check itself failed) is fail-open — nothing withheld", () => {
  const toApply = [{ id: "dec_1", from: "a", to: "sha_unknown" }];
  const result = withheldForUnresolvableTo(toApply, null);
  assert.deepEqual(result.applicable, toApply);
  assert.deepEqual(result.withheld, []);
});

test("withheldForUnresolvableTo: preserves object identity for applicable entries", () => {
  const entry = { id: "dec_1", from: "a", to: "sha_real" };
  const result = withheldForUnresolvableTo([entry], new Set(["sha_real"]));
  assert.equal(result.applicable[0], entry);
});

test("withheldForUnresolvableTo: preserves object identity for withheld entries too — the CLI's queue sweep keys a Set off these exact references to survive a duplicate-id corrupted queue", () => {
  const entry = { id: "dec_1", from: "a", to: "sha_ghost" };
  const result = withheldForUnresolvableTo([entry], new Set());
  assert.equal(result.withheld[0], entry, "must be the SAME object reference, not an equal-but-rebuilt copy");
});
