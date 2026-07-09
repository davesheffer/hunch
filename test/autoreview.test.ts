import { test } from "node:test";
import assert from "node:assert/strict";
import { planAutoReview, planMutations, resolveSelection } from "../src/core/autoreview.js";
import type { Decision } from "../src/core/types.js";
import type { RelevanceVerdict } from "../src/synthesis/provider.js";

const D = (over: Partial<Decision> & { id: string; source?: string; confidence?: number; evidence?: string[] }): Decision => ({
  id: over.id, title: over.title ?? `title ${over.id}`, decision: over.decision ?? "did a specific architectural thing",
  status: over.status ?? "proposed",
  related_files: over.related_files ?? [],
  alternatives_rejected: over.alternatives_rejected ?? [],
  provenance: { source: over.source ?? "llm_draft", confidence: over.confidence ?? 0.5, evidence: over.evidence ?? [] },
} as Decision);

const V = (over: Partial<RelevanceVerdict>): RelevanceVerdict => ({
  relevant: over.relevant ?? true, confidence: over.confidence ?? 0.9,
  duplicate_of: over.duplicate_of ?? null, reason: over.reason ?? "because",
});

test("accept: only a Critic-verified + grounded + harness-relevant draft is auto-accepted", () => {
  const d = D({ id: "dec_a", source: "llm_draft+verified", evidence: ["synth:grounded=0.8"] });
  const plan = planAutoReview([d], [d], new Map([["dec_a", V({ relevant: true })]]));
  assert.deepEqual(plan.accept.map((e) => e.d.id), ["dec_a"]);
});

test("dec_a466655539 gate: harness cannot accept an UN-verified draft (it can only veto)", () => {
  const d = D({ id: "dec_u", source: "llm_draft", evidence: ["synth:grounded=0.95"] }); // grounded but NOT verified
  const plan = planAutoReview([d], [d], new Map([["dec_u", V({ relevant: true, confidence: 1 })]]));
  assert.equal(plan.accept.length, 0, "no auto-accept without the Critic's verified tag");
  assert.deepEqual(plan.keep.map((e) => e.d.id), ["dec_u"], "kept for a human instead");
});

test("rejectDuplicate: deterministic dupdetect match against an accepted record", () => {
  const accepted = D({ id: "dec_acc", status: "accepted", source: "llm_draft+human_confirmed",
    title: "Vectors are a derived layer in sqlite", decision: "Semantic vectors derived layer sqlite reconcile content hash reindex",
    related_files: ["src/store/db.ts"] });
  const dupDraft = D({ id: "dec_dup", source: "llm_draft",
    title: "Vectors are a derived layer in sqlite", decision: "Semantic vectors derived layer sqlite reconcile content hash reindex",
    related_files: ["src/store/db.ts"] });
  const plan = planAutoReview([dupDraft], [accepted, dupDraft], new Map());
  assert.deepEqual(plan.rejectDuplicate.map((e) => e.d.id), ["dec_dup"]);
});

test("rejectDuplicate: harness names an existing decision the draft restates", () => {
  const existing = D({ id: "dec_real", status: "accepted", source: "llm_draft+human_confirmed", title: "unrelated words here", decision: "totally different content xyzzy" });
  const draft = D({ id: "dec_r", title: "some phrasing", decision: "other phrasing entirely" });
  const plan = planAutoReview([draft], [existing, draft], new Map([["dec_r", V({ duplicate_of: "dec_real" })]]));
  assert.deepEqual(plan.rejectDuplicate.map((e) => e.d.id), ["dec_r"]);
});

test("rejectIrrelevant: only a CONFIDENT 'not relevant' deletes; a shaky one is kept", () => {
  const bad = D({ id: "dec_bad" });
  const shaky = D({ id: "dec_shaky" });
  const plan = planAutoReview([bad, shaky], [bad, shaky], new Map([
    ["dec_bad", V({ relevant: false, confidence: 0.9 })],
    ["dec_shaky", V({ relevant: false, confidence: 0.4 })],
  ]));
  assert.deepEqual(plan.rejectIrrelevant.map((e) => e.d.id), ["dec_bad"]);
  assert.deepEqual(plan.keep.map((e) => e.d.id), ["dec_shaky"]);
});

test("keep: an unjudged draft (no harness verdict) is never deleted", () => {
  const d = D({ id: "dec_nj" });
  const plan = planAutoReview([d], [d], new Map());
  assert.deepEqual(plan.keep.map((e) => e.d.id), ["dec_nj"]);
  assert.equal(planMutations(plan), 0);
});

test("resolveSelection: partitions accept/delete ids against the live draft set", () => {
  const a = D({ id: "dec_a" }), b = D({ id: "dec_b" }), c = D({ id: "dec_c" });
  const sel = resolveSelection([a, b, c], ["dec_a"], ["dec_b"]);
  assert.deepEqual(sel.accept.map((d) => d.id), ["dec_a"]);
  assert.deepEqual(sel.delete.map((d) => d.id), ["dec_b"]);
  assert.deepEqual(sel.unknown, []);
});

test("resolveSelection: an id that isn't a current draft is refused (never mutated by a stale id)", () => {
  const a = D({ id: "dec_a" });
  const sel = resolveSelection([a], ["dec_a"], ["dec_gone"]);
  assert.deepEqual(sel.accept.map((d) => d.id), ["dec_a"]);
  assert.deepEqual(sel.delete, []);
  assert.deepEqual(sel.unknown, ["dec_gone"]);
});

test("resolveSelection: an id in BOTH lists resolves to accept (the non-destructive verb)", () => {
  const a = D({ id: "dec_a" });
  const sel = resolveSelection([a], ["dec_a"], ["dec_a"]);
  assert.deepEqual(sel.accept.map((d) => d.id), ["dec_a"]);
  assert.deepEqual(sel.delete, []);
  assert.deepEqual(sel.unknown, ["dec_a"]); // the delete claim is reported, not silently dropped
});

test("buckets are disjoint and cover every draft", () => {
  const drafts = [
    D({ id: "acc", source: "llm_draft+verified", evidence: ["synth:grounded=0.8"] }),
    D({ id: "irr" }),
    D({ id: "keep" }),
  ];
  const plan = planAutoReview(drafts, drafts, new Map([
    ["acc", V({ relevant: true })],
    ["irr", V({ relevant: false, confidence: 0.95 })],
    ["keep", V({ relevant: true })], // relevant but not verified → keep
  ]));
  const total = plan.accept.length + plan.rejectDuplicate.length + plan.rejectIrrelevant.length + plan.keep.length;
  assert.equal(total, drafts.length);
  assert.deepEqual(plan.accept.map((e) => e.d.id), ["acc"]);
  assert.deepEqual(plan.rejectIrrelevant.map((e) => e.d.id), ["irr"]);
  assert.deepEqual(plan.keep.map((e) => e.d.id), ["keep"]);
});
