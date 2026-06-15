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
