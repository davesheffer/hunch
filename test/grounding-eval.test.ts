/**
 * Grounding delivery accuracy as a tracked metric (private #43). Precision: the
 * share of delivered records that are eligible for the task. Recall: the share of
 * eligible records that were delivered. "Delivered" is what file grounding keeps
 * for a task: selectForTask's qualifying set, the same call the prompt hook makes.
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import { DecisionSchema, type Decision } from "../src/core/types.js";
import { aggregateGrounding, evaluateGroundingSelection, loadGroundingCases, scoreGroundingCase } from "../src/eval/grounding.js";

test("a case scores delivered against eligible: tp, fp, fn, precision, recall", () => {
  const s = scoreGroundingCase(["dec_a", "dec_b", "dec_x"], { name: "c", prompt: "p", eligible: ["dec_a", "dec_b", "dec_c"] });
  assert.deepEqual([s.tp, s.fp, s.fn], [2, 1, 1]);
  assert.equal(s.precision, 2 / 3);
  assert.equal(s.recall, 2 / 3);
  assert.deepEqual(s.false_positives, ["dec_x"]);
  assert.deepEqual(s.missed, ["dec_c"]);
});

test("allowed records are not false positives, and are not required for recall", () => {
  const s = scoreGroundingCase(["dec_a", "dec_ok"], { name: "c", prompt: "p", eligible: ["dec_a"], allowed: ["dec_ok"] });
  assert.equal(s.precision, 1);
  assert.equal(s.recall, 1);
});

test("silence is never imprecise; an open-world case is not judged on precision; no eligible means no recall", () => {
  assert.equal(scoreGroundingCase([], { name: "c", prompt: "p", eligible: ["dec_a"] }).precision, 1);
  assert.equal(scoreGroundingCase(["dec_z"], { name: "c", prompt: "p", eligible: ["dec_a"], allowed: "any" }).precision, null);
  assert.equal(scoreGroundingCase(["dec_z"], { name: "c", prompt: "p", eligible: [] }).recall, null);
});

test("aggregate micro precision/recall pools counts over the judged cases", () => {
  const a = scoreGroundingCase(["dec_a", "dec_x"], { name: "a", prompt: "p", eligible: ["dec_a"] });
  const b = scoreGroundingCase(["dec_b"], { name: "b", prompt: "p", eligible: ["dec_b", "dec_c", "dec_d"] });
  const open = scoreGroundingCase(["dec_q", "dec_r"], { name: "o", prompt: "p", eligible: ["dec_q"], allowed: "any" });
  const agg = aggregateGrounding([a, b, open]);
  assert.equal(agg.precision, 2 / 3, "open-world deliveries are left out of precision");
  assert.equal(agg.recall, 3 / 5);
  assert.equal(agg.precision_cases, 2);
  assert.equal(agg.recall_cases, 3);
  assert.equal(agg.cases, 3);
});

test("the golden-file loader validates shape and refuses duplicate names", () => {
  const ok = loadGroundingCases(JSON.stringify([{ name: "a", prompt: "fix x", eligible: ["dec_a"] }]));
  assert.equal(ok.length, 1);
  assert.throws(() => loadGroundingCases(JSON.stringify([{ name: "a", eligible: [] }])), /prompt/);
  assert.throws(() => loadGroundingCases(JSON.stringify([{ name: "a", prompt: "x", eligible: [] }, { name: "a", prompt: "y", eligible: [] }])), /duplicate/i);
});

const dec = (id: string, title: string, files: string[] = []): Decision =>
  DecisionSchema.parse({ id, title, status: "accepted", decision: title, related_files: files, provenance: { source: "human_confirmed", confidence: 0.9, evidence: [] }, date: "2026-09-01" });

test("selection replay: delivered is what selectForTask qualifies for the prompt", () => {
  const records = {
    decisions: [
      dec("dec_lease", "Renew the serve write lease before half its window", ["src/serve/lease.ts"]),
      dec("dec_other", "Paint the homepage hero green"),
    ],
    bugs: [], constraints: [], findings: [],
  };
  const r = evaluateGroundingSelection(records, [
    { name: "path", prompt: "fix the race in src/serve/lease.ts", eligible: ["dec_lease"] },
    { name: "silent", prompt: "bump the version", eligible: [] },
  ]);
  assert.deepEqual(r.cases[0]!.delivered, ["dec_lease"]);
  assert.equal(r.cases[0]!.precision, 1);
  assert.equal(r.cases[0]!.recall, 1);
  assert.deepEqual(r.cases[1]!.delivered, [], "no qualifying record → silence");
  assert.equal(r.aggregate.precision, 1);
  assert.equal(r.aggregate.recall, 1);
});
