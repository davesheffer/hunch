import test from "node:test";
import assert from "node:assert/strict";
import {
  orphanedCommitDecisions, planCommitRepair, repairDecisionCommit, pickRewrite, mergeRewrites, firstFor,
  liveRewrites, deadRewrites, resolvedRewriteIds, withoutDropped, addDropped, withheldForUnresolvableTo,
} from "../src/core/commitrepair.js";
import type { Decision } from "../src/core/types.js";
import type { CommitCandidate, CommitRepairStatus } from "../src/extractors/git.js";

function D(p: Partial<Decision> & { id: string }): Decision {
  return {
    title: `title ${p.id}`,
    decision: "do the thing",
    status: "accepted",
    related_files: [],
    rejected_tripwires: [],
    alternatives_rejected: [],
    commit: null,
    provenance: { source: "human_confirmed", confidence: 0.9, evidence: p.commit ? [`commit:${p.commit}`] : [] },
    ...p,
  } as unknown as Decision;
}

test("orphanedCommitDecisions keeps only live, orphaned decisions", () => {
  const decisions = [
    D({ id: "dec_current", commit: "sha_current" }),
    D({ id: "dec_orphan", commit: "sha_orphan" }),
    D({ id: "dec_nocommit" }),
    D({ id: "dec_super", commit: "sha_super", status: "superseded" }),
    D({ id: "dec_rej", commit: "sha_rej", status: "rejected" }),
  ];
  const map: Record<string, CommitRepairStatus> = { sha_current: "current", sha_orphan: "orphaned", sha_super: "orphaned", sha_rej: "orphaned" };
  const out = orphanedCommitDecisions(decisions, (sha) => map[sha] ?? "unresolvable");
  assert.deepEqual(out.map((d) => d.id), ["dec_orphan"]);
});

test("orphanedCommitDecisions excludes unresolvable and unknown statuses", () => {
  const decisions = [D({ id: "a", commit: "sa" }), D({ id: "b", commit: "sb" }), D({ id: "c", commit: "sc" })];
  const map: Record<string, CommitRepairStatus> = { sa: "orphaned", sb: "unresolvable", sc: "unknown" };
  assert.deepEqual(orphanedCommitDecisions(decisions, (s) => map[s]!).map((d) => d.id), ["a"]);
});

test("planCommitRepair rewrites a unique match by files", () => {
  const orphaned = [D({ id: "dec_1", commit: "sha_old", related_files: ["src/feature.ts"] })];
  const candidates: CommitCandidate[] = [{ sha: "sha_new", files: ["src/feature.ts", "README.md"] }, { sha: "sha_other", files: ["x.ts"] }];
  const plan = planCommitRepair(orphaned, candidates);
  assert.deepEqual(plan.rewrites, [{ id: "dec_1", from: "sha_old", to: "sha_new" }]);
  assert.deepEqual(plan.records, ["dec_1"]);
});

test("planCommitRepair: two superset candidates are ambiguous", () => {
  const orphaned = [D({ id: "dec_1", commit: "sha_old", related_files: ["src/a.ts"] })];
  const candidates: CommitCandidate[] = [{ sha: "s1", files: ["src/a.ts"] }, { sha: "s2", files: ["src/a.ts", "b.ts"] }];
  assert.deepEqual(planCommitRepair(orphaned, candidates), { rewrites: [], records: [] });
});

test("planCommitRepair: no candidate covers every related file", () => {
  const orphaned = [D({ id: "dec_1", commit: "sha_old", related_files: ["src/a.ts", "src/b.ts"] })];
  assert.deepEqual(planCommitRepair(orphaned, [{ sha: "s1", files: ["src/a.ts"] }]), { rewrites: [], records: [] });
});

test("planCommitRepair: empty or glob-only related files never match", () => {
  const candidates: CommitCandidate[] = [{ sha: "s1", files: ["src/a.ts"] }];
  assert.deepEqual(planCommitRepair([D({ id: "d1", commit: "o", related_files: [] })], candidates), { rewrites: [], records: [] });
  assert.deepEqual(planCommitRepair([D({ id: "d2", commit: "o", related_files: ["src/**"] })], candidates), { rewrites: [], records: [] });
});

test("planCommitRepair: a same-patch-id candidate beats the unique file-superset candidate (#450)", () => {
  // The release commit is the ONLY superset of related_files; the true
  // replacement carries the identical change but not every related file.
  const orphaned = [D({ id: "dec_1", commit: "sha_old", related_files: ["CHANGELOG.md", "src/a.ts"] })];
  const candidates: CommitCandidate[] = [
    { sha: "sha_release", files: ["CHANGELOG.md", "src/a.ts", "package.json"] },
    { sha: "sha_true", files: ["CHANGELOG.md", "scripts/x.sh"] },
  ];
  const patch = new Map([["sha_old", "p1"], ["sha_true", "p1"], ["sha_release", "p2"]]);
  const patchIdOf = (sha: string) => patch.get(sha) ?? null;
  assert.deepEqual(planCommitRepair(orphaned, candidates).rewrites, [{ id: "dec_1", from: "sha_old", to: "sha_release" }], "file matching alone picks the wrong commit");
  assert.deepEqual(planCommitRepair(orphaned, candidates, patchIdOf).rewrites, [{ id: "dec_1", from: "sha_old", to: "sha_true" }]);
});

test("planCommitRepair: two same-patch-id candidates are ambiguous; no patch-id match falls back to files (#450)", () => {
  const orphaned = [D({ id: "dec_1", commit: "sha_old", related_files: ["src/a.ts"] })];
  const candidates: CommitCandidate[] = [{ sha: "sha_x", files: ["src/a.ts"] }, { sha: "sha_y", files: ["src/b.ts"] }];
  const twice = new Map([["sha_old", "p1"], ["sha_x", "p1"], ["sha_y", "p1"]]);
  assert.deepEqual(planCommitRepair(orphaned, candidates, (s) => twice.get(s) ?? null).rewrites, [], "never guess between identical changes");
  const none = new Map([["sha_old", "p1"], ["sha_x", "p2"]]);
  assert.deepEqual(planCommitRepair(orphaned, candidates, (s) => none.get(s) ?? null).rewrites, [{ id: "dec_1", from: "sha_old", to: "sha_x" }], "a multi-commit squash never matches by patch-id; files still decide");
});

test("repairDecisionCommit rewrites commit and matching evidence together, preserving other evidence", () => {
  const d = D({ id: "dec_1", commit: "old", provenance: { source: "human_confirmed", confidence: 1, evidence: ["src/a.ts", "commit:old"] } as Decision["provenance"] });
  const out = repairDecisionCommit(d, { rewrites: [{ id: "dec_1", from: "old", to: "new" }], records: ["dec_1"] });
  assert.equal(out.commit, "new");
  assert.deepEqual(out.provenance.evidence, ["src/a.ts", "commit:new"]);
});

test("repairDecisionCommit dedupes evidence when the new commit was already cited", () => {
  const d = D({ id: "dec_1", commit: "old", provenance: { source: "human_confirmed", confidence: 1, evidence: ["commit:old", "commit:new"] } as Decision["provenance"] });
  const out = repairDecisionCommit(d, { rewrites: [{ id: "dec_1", from: "old", to: "new" }], records: ["dec_1"] });
  assert.deepEqual(out.provenance.evidence, ["commit:new"]);
});

test("repairDecisionCommit returns the same reference when nothing applies", () => {
  const d = D({ id: "dec_1", commit: "old" });
  assert.equal(repairDecisionCommit(d, { rewrites: [{ id: "other", from: "old", to: "new" }], records: ["other"] }), d);
  assert.equal(repairDecisionCommit(d, { rewrites: [{ id: "dec_1", from: "older", to: "new" }], records: ["dec_1"] }), d);
});

test("firstFor returns the first same-id entry by identity, or undefined", () => {
  const a = { id: "x", from: "1", to: "2" };
  const b = { id: "x", from: "1", to: "3" };
  assert.equal(firstFor([a, b], "x"), a);
  assert.notEqual(firstFor([a, b], "x"), b);
  assert.equal(firstFor([a, b], "nope"), undefined);
});

test("pickRewrite returns the first duplicate-id rewrite, or undefined", () => {
  const a = { id: "x", from: "1", to: "2" };
  const b = { id: "x", from: "1", to: "3" };
  const plan = { rewrites: [a, b], records: ["x"] };
  assert.equal(pickRewrite(plan, "x"), a);
  assert.notEqual(pickRewrite(plan, "x"), b);
  assert.equal(pickRewrite(plan, "y"), undefined);
});

test("mergeRewrites: a fresh entry overrides the queued entry with the same id", () => {
  const fresh = { id: "x", from: "1", to: "new" };
  assert.deepEqual(mergeRewrites([fresh], [{ id: "x", from: "1", to: "stale" }]), [fresh]);
});

test("mergeRewrites passes through entries unique to either side; empties give empty", () => {
  const f = { id: "f", from: "1", to: "2" };
  const q = { id: "q", from: "1", to: "2" };
  const out = mergeRewrites([f], [q]);
  assert.equal(out.length, 2);
  assert.ok(out.includes(f) && out.includes(q));
  assert.deepEqual(mergeRewrites([], []), []);
});

test("mergeRewrites replaces only the first duplicate-id sibling", () => {
  const first = { id: "x", from: "1", to: "a" };
  const second = { id: "x", from: "1", to: "b" };
  const fresh = { id: "x", from: "1", to: "c" };
  assert.deepEqual(mergeRewrites([fresh], [first, second]), [fresh, second]);
});

test("liveRewrites keeps only entries whose decision exists and still cites `from`", () => {
  const decisions = [D({ id: "a", commit: "old" }), D({ id: "b", commit: "moved" })];
  const ra = { id: "a", from: "old", to: "n" };
  const rb = { id: "b", from: "old", to: "n" };
  const rc = { id: "c", from: "old", to: "n" };
  assert.deepEqual(liveRewrites([ra, rb, rc], decisions), [ra]);
});

test("liveRewrites excludes superseded and rejected decisions", () => {
  const decisions = [D({ id: "a", commit: "old", status: "superseded" }), D({ id: "b", commit: "old", status: "rejected" })];
  assert.deepEqual(liveRewrites([{ id: "a", from: "old", to: "n" }, { id: "b", from: "old", to: "n" }], decisions), []);
});

test("deadRewrites never treats an absent decision as dead", () => {
  const decisions = [D({ id: "a", commit: "old" })];
  assert.deepEqual(deadRewrites([{ id: "a", from: "old", to: "n" }, { id: "gone", from: "old", to: "n" }], decisions), []);
});

test("deadRewrites flags moved-on, superseded and rejected decisions", () => {
  const decisions = [
    D({ id: "moved", commit: "other" }),
    D({ id: "sup", commit: "old", status: "superseded" }),
    D({ id: "rej", commit: "old", status: "rejected" }),
    D({ id: "ok", commit: "old" }),
  ];
  const queued = ["moved", "sup", "rej", "ok"].map((id) => ({ id, from: "old", to: "n" }));
  assert.deepEqual(deadRewrites(queued, decisions).map((r) => r.id).sort(), ["moved", "rej", "sup"]);
});

test("resolvedRewriteIds: visible ids resolve, absent ids do not", () => {
  const decisions = [D({ id: "a", commit: "old" })];
  const ra = { id: "a", from: "old", to: "n" };
  const rb = { id: "b", from: "old", to: "n" };
  assert.deepEqual(resolvedRewriteIds([ra], decisions), new Set(["a"]));
  assert.deepEqual(resolvedRewriteIds([rb], decisions), new Set());
  assert.deepEqual(resolvedRewriteIds([ra, rb], decisions), new Set(["a"]));
});

test("withoutDropped removes only an exact tombstoned triple", () => {
  const a = { id: "a", from: "o", to: "n" };
  const b = { id: "b", from: "o", to: "n" };
  assert.deepEqual(withoutDropped([a, b], [{ id: "a", from: "o", to: "n" }]), [b]);
  assert.deepEqual(withoutDropped([a, b], [{ id: "a", from: "o", to: "different" }]), [a, b]);
  assert.deepEqual(withoutDropped([a, b], [{ id: "a", from: "other", to: "n" }]), [a, b]);
  assert.deepEqual(withoutDropped([a, b], []), [a, b]);
});

test("withoutDropped preserves object identity of survivors", () => {
  const a = { id: "a", from: "o", to: "n" };
  const b = { id: "b", from: "o", to: "n" };
  const out = withoutDropped([a, b], [{ id: "a", from: "o", to: "n" }]);
  assert.equal(out.length, 1);
  assert.equal(out[0], b);
});

test("withoutDropped keys cannot collide across field boundaries", () => {
  const a = { id: "a b", from: "c", to: "d" };
  assert.deepEqual(withoutDropped([a], [{ id: "a", from: "b c", to: "d" }]), [a]);
});

test("addDropped appends new triples and never duplicates", () => {
  const t1 = { id: "a", from: "o", to: "n" };
  const t2 = { id: "b", from: "o", to: "n" };
  assert.deepEqual(addDropped([t2], [t1]), [t1, t2]);
  assert.deepEqual(addDropped([{ ...t1 }], [t1]), [t1]);
  const t3 = { id: "a", from: "o", to: "n2" };
  assert.deepEqual(addDropped([t3], [t1]), [t1, t3]);
});

test("withheldForUnresolvableTo partitions by whether `to` resolves", () => {
  const a = { id: "a", from: "o", to: "ok" };
  const b = { id: "b", from: "o", to: "bad" };
  const one = withheldForUnresolvableTo([a], new Set(["ok"]));
  assert.deepEqual(one.applicable, [a]);
  assert.deepEqual(one.withheld, []);
  const none = withheldForUnresolvableTo([b], new Set());
  assert.deepEqual(none.applicable, []);
  assert.deepEqual(none.withheld, [b]);
  const mix = withheldForUnresolvableTo([a, b], new Set(["ok"]));
  assert.deepEqual(mix.applicable.map((r) => r.id), ["a"]);
  assert.deepEqual(mix.withheld.map((r) => r.id), ["b"]);
});

test("withheldForUnresolvableTo fails open when the check could not run", () => {
  const a = { id: "a", from: "o", to: "x" };
  const out = withheldForUnresolvableTo([a], null);
  assert.deepEqual(out.applicable, [a]);
  assert.deepEqual(out.withheld, []);
});

test("withheldForUnresolvableTo preserves object identity", () => {
  const a = { id: "a", from: "o", to: "ok" };
  const b = { id: "b", from: "o", to: "bad" };
  const out = withheldForUnresolvableTo([a, b], new Set(["ok"]));
  assert.equal(out.applicable[0], a);
  assert.equal(out.withheld[0], b, "the CLI depends on reference identity");
});
