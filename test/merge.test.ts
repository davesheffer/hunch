import { test } from "node:test";
import assert from "node:assert/strict";
import { mergeHunchJson, mergeRecordsById, pickWinner, canon } from "../src/store/merge.js";

type Rec = Record<string, unknown>;
const prov = (source: string, confidence: number, last_verified?: string) => ({ source, confidence, evidence: [], ...(last_verified ? { last_verified } : {}) });
const rec = (id: string, over: Rec = {}): Rec => ({ id, provenance: prov("llm_draft", 0.5), ...over });

test("additions on both sides are unioned", () => {
  const out = mergeRecordsById([], [rec("a")], [rec("b")]);
  assert.deepEqual(out.map((r) => r.id).sort(), ["a", "b"]);
});

test("a one-sided modification beats the unchanged side", () => {
  const base = [rec("a", { v: 1 })];
  const ours = [rec("a", { v: 1 })]; // unchanged
  const theirs = [rec("a", { v: 2 })]; // changed
  assert.equal(mergeRecordsById(base, ours, theirs)[0]!.v, 2);
  // symmetric
  assert.equal(mergeRecordsById(base, theirs, ours)[0]!.v, 2);
});

test("reordered keys are NOT a change (canon equality), so no false conflict", () => {
  const base = [{ id: "a", x: 1, provenance: prov("llm_draft", 0.5) }];
  const ours = [{ provenance: prov("llm_draft", 0.5), id: "a", x: 1 }]; // same, keys reordered
  const theirs = [{ id: "a", x: 9, provenance: prov("llm_draft", 0.5) }];
  assert.equal(mergeRecordsById(base, ours, theirs)[0]!.x, 9, "theirs (the only real change) wins");
});

test("delete vs unchanged honors the delete; delete vs modify keeps the modification", () => {
  const base = [rec("a", { v: 1 })];
  // theirs deleted (absent), ours unchanged → dropped
  assert.equal(mergeRecordsById(base, [rec("a", { v: 1 })], []).length, 0);
  // theirs deleted, ours MODIFIED → keep ours (a modification beats a delete)
  const kept = mergeRecordsById(base, [rec("a", { v: 5 })], []);
  assert.equal(kept.length, 1);
  assert.equal(kept[0]!.v, 5);
});

test("both-sides change: human_confirmed beats higher-confidence auto", () => {
  const ours = rec("a", { provenance: prov("llm_draft", 0.9), v: "auto" });
  const theirs = rec("a", { provenance: prov("llm_draft+human_confirmed", 0.5), v: "human" });
  assert.equal(pickWinner(ours, theirs).v, "human");
  assert.equal(pickWinner(theirs, ours).v, "human", "order-independent");
});

test("both-sides change: then higher confidence, then recency", () => {
  assert.equal(pickWinner(rec("a", { provenance: prov("llm_draft", 0.8), v: "hi" }), rec("a", { provenance: prov("llm_draft", 0.4), v: "lo" })).v, "hi");
  // equal confidence → newer last_verified wins
  const newer = rec("a", { provenance: prov("llm_draft", 0.5, "2026-06-01T00:00:00Z"), v: "new" });
  const older = rec("a", { provenance: prov("llm_draft", 0.5, "2026-01-01T00:00:00Z"), v: "old" });
  assert.equal(pickWinner(newer, older).v, "new");
  assert.equal(pickWinner(older, newer).v, "new", "recency is order-independent");
});

test("mergeHunchJson: index ARRAY in → merged array out, sorted by id", () => {
  const base = JSON.stringify([rec("a", { v: 1 })]);
  const ours = JSON.stringify([rec("a", { v: 1 }), rec("c")]);
  const theirs = JSON.stringify([rec("a", { v: 2 }), rec("b")]);
  const res = mergeHunchJson(base, ours, theirs);
  assert.equal(res.conflict, false);
  const arr = JSON.parse(res.text) as Rec[];
  assert.deepEqual(arr.map((r) => r.id), ["a", "b", "c"]);
  assert.equal(arr.find((r) => r.id === "a")!.v, 2);
});

test("mergeHunchJson: single OBJECT in (per-record file) → single object out", () => {
  const base = JSON.stringify(rec("dec_1", { title: "base" }));
  const ours = JSON.stringify(rec("dec_1", { title: "base" })); // unchanged
  const theirs = JSON.stringify(rec("dec_1", { title: "theirs" }));
  const res = mergeHunchJson(base, ours, theirs);
  assert.equal(res.conflict, false);
  const obj = JSON.parse(res.text) as Rec;
  assert.equal(Array.isArray(obj), false);
  assert.equal(obj.title, "theirs");
});

test("mergeHunchJson falls back (conflict) on non-JSON or id-less records", () => {
  assert.equal(mergeHunchJson("[]", "not json{", "[]").conflict, true);
  assert.equal(mergeHunchJson("[]", JSON.stringify([{ noId: 1 }]), "[]").conflict, true);
});

test("a per-record file whose id diverges across sides → conflict, never a silent drop", () => {
  const r = mergeHunchJson(
    JSON.stringify(rec("dec_1", { title: "base" })),
    JSON.stringify(rec("dec_1", { title: "ours" })),
    JSON.stringify(rec("dec_2", { title: "theirs" })), // id rewritten
  );
  assert.equal(r.conflict, true, "two records from a single-object file must not collapse to one");
});

test("canon is key-order independent", () => {
  assert.equal(canon({ a: 1, b: 2 }), canon({ b: 2, a: 1 }));
  assert.notEqual(canon({ a: 1 }), canon({ a: 2 }));
});

// ---- #290: a both-sides change must not undo the other side's lifecycle move ----

const live = (over: Rec = {}): Rec => rec("dec_old", { status: "accepted", superseded_by: null, valid_to: null, ...over });
const superseded = (over: Rec = {}): Rec => live({ status: "superseded", superseded_by: "dec_new", valid_to: "2026-09-01", ...over });
const reviewed = { provenance: prov("human_confirmed", 0.95, "2026-09-10T00:00:00Z") };

test("supersede on one branch + review --accept on the other: the supersession survives, in both directions (#290)", () => {
  const base = [live()];
  const a = [superseded()]; // hunch supersede: lifecycle only, provenance untouched
  const b = [live(reviewed)]; // hunch review --accept: provenance only
  for (const out of [mergeRecordsById(base, a, b), mergeRecordsById(base, b, a)]) {
    assert.equal(out.length, 1);
    assert.equal(out[0]!.status, "superseded");
    assert.equal(out[0]!.superseded_by, "dec_new");
    assert.equal(out[0]!.valid_to, "2026-09-01");
    assert.equal((out[0]!.provenance as Rec).source, "human_confirmed", "the review is kept too — neither side's work is dropped");
  }
});

test("a genuine reopen still wins over a provenance-only change on the other side", () => {
  const fixed = rec("bug_1", { status: "fixed", lineage: { fixed_commit: "abc1234", spawned_decision: null, root_cause: "x" } });
  const reopened = rec("bug_1", { status: "open", lineage: { fixed_commit: null, spawned_decision: null, root_cause: "x" } });
  const verified = { ...fixed, ...reviewed };
  for (const out of [mergeRecordsById([fixed], [reopened], [verified]), mergeRecordsById([fixed], [verified], [reopened])]) {
    assert.equal(out[0]!.status, "open");
    assert.equal((out[0]!.lineage as Rec).fixed_commit, null);
    assert.equal((out[0]!.lineage as Rec).root_cause, "x", "non-lifecycle lineage fields come from the winner untouched");
    assert.equal((out[0]!.provenance as Rec).source, "human_confirmed");
  }
});

test("no merge base: nothing says which side moved, so the whole-record ranking stands unchanged", () => {
  // A live human-confirmed copy may be a genuine reopen (merge-closure.test.ts, #8) —
  // without a base the carry must not second-guess the provenance tiers.
  for (const out of [mergeRecordsById([], [superseded()], [live(reviewed)]), mergeRecordsById([], [live(reviewed)], [superseded()])]) {
    assert.equal(out[0]!.status, "accepted");
    assert.equal((out[0]!.provenance as Rec).source, "human_confirmed");
  }
});

test("both sides moved the lifecycle differently: the provenance winner's lifecycle stands whole, never a blend", () => {
  const base = [live()];
  const a = [superseded()];
  const b = [live({ ...reviewed, status: "rejected", valid_to: "2026-09-05" })];
  for (const out of [mergeRecordsById(base, a, b), mergeRecordsById(base, b, a)]) {
    assert.equal(out[0]!.status, "rejected");
    assert.equal(out[0]!.superseded_by, null);
    assert.equal(out[0]!.valid_to, "2026-09-05");
  }
});
