import { test } from "node:test";
import assert from "node:assert/strict";
import { STRICT_MIN_CONFIDENCE } from "../src/core/strictgate.js";
import {
  EnsembleProvider, mergeDecisionDrafts,
  type SynthProvider, type DecisionDraft, type CommitInput, type BugDraft, type FailureInput,
} from "../src/synthesis/provider.js";

const DRAFT = (over: Partial<DecisionDraft> = {}): DecisionDraft => ({
  title: "Add caching layer", context: "ctx", decision: "introduce an LRU cache in the data layer",
  consequences: ["faster reads"], alternatives_rejected: ["no cache"], confidence: 0.6, source: "llm_draft", ...over,
});

class MockWorker implements SynthProvider {
  constructor(readonly name: string, private readonly draft: DecisionDraft | Error) {}
  async available(): Promise<boolean> { return true; }
  async draftDecision(_i: CommitInput): Promise<DecisionDraft> {
    if (this.draft instanceof Error) throw this.draft;
    return this.draft;
  }
  async draftBug(_i: FailureInput): Promise<BugDraft> { throw new Error("not used"); }
}
const INPUT: CommitInput = { subject: "s", body: "b", files: ["a.ts"], diff: "" };

test("mergeDecisionDrafts: confidence is agreement-weighted and ALWAYS below the strict gate", () => {
  const agree = mergeDecisionDrafts([DRAFT(), DRAFT()]); // identical → max agreement
  assert.ok(agree.confidence < STRICT_MIN_CONFIDENCE, "must stay below the strict gate (never arms enforcement)");
  assert.ok(agree.confidence <= 0.78 && agree.confidence > 0.7);
  const disagree = mergeDecisionDrafts([
    DRAFT({ title: "X", decision: "alpha beta gamma" }),
    DRAFT({ title: "Y", decision: "delta epsilon zeta" }),
  ]); // disjoint → min agreement
  assert.ok(disagree.confidence < agree.confidence, "less agreement → lower confidence");
  assert.ok(disagree.confidence >= 0.55);
  assert.match(agree.source, /ensemble/);
});

test("mergeDecisionDrafts: unions consequences + alternatives (deduped)", () => {
  const m = mergeDecisionDrafts([
    DRAFT({ consequences: ["a", "b"], alternatives_rejected: ["x"] }),
    DRAFT({ consequences: ["b", "c"], alternatives_rejected: ["x", "y"] }),
  ]);
  assert.deepEqual([...m.consequences].sort(), ["a", "b", "c"]);
  assert.deepEqual([...m.alternatives_rejected].sort(), ["x", "y"]);
});

test("EnsembleProvider: >=2 workers merge (capped); 1 worker passes through; failures dropped", async () => {
  const merged = await new EnsembleProvider([new MockWorker("a", DRAFT()), new MockWorker("b", DRAFT())]).draftDecision(INPUT);
  assert.match(merged.source, /ensemble/);
  assert.ok(merged.confidence < STRICT_MIN_CONFIDENCE);

  const single = await new EnsembleProvider([new MockWorker("a", DRAFT({ confidence: 0.7 }))]).draftDecision(INPUT);
  assert.equal(single.source, "llm_draft"); // passthrough, not merged
  assert.equal(single.confidence, 0.7);

  const survived = await new EnsembleProvider([
    new MockWorker("a", new Error("boom")),
    new MockWorker("b", DRAFT({ title: "kept" })),
  ]).draftDecision(INPUT);
  assert.equal(survived.title, "kept"); // the failed worker is dropped
});

test("EnsembleProvider: all workers fail → throws; available() reflects the pool", async () => {
  const e = new EnsembleProvider([new MockWorker("a", new Error("x"))]);
  await assert.rejects(() => e.draftDecision(INPUT), /all workers failed/);
  assert.equal(await e.available(), true);
  assert.equal(await new EnsembleProvider([]).available(), false);
});

// A worker that counts how many times it's sampled (self-consistency depth).
const counting = (): { p: SynthProvider; calls: () => number } => {
  let n = 0;
  const p: SynthProvider = {
    name: "solo",
    available: async () => true,
    draftDecision: async () => { n++; return DRAFT({ decision: `take path ${n}` }); },
    draftBug: async (): Promise<BugDraft> => { throw new Error("not used"); },
  };
  return { p, calls: () => n };
};

test("EnsembleProvider: a single CLI is sampled `samples` times and reconciled (self-consistency)", async () => {
  const { p, calls } = counting();
  const out = await new EnsembleProvider([p], { samples: 3 }).draftDecision(INPUT);
  assert.equal(calls(), 3, "the lone CLI is sampled `samples` times");
  assert.equal(out.samples, 3, "telemetry records the reconciliation breadth");
  assert.match(out.source, /ensemble/);
  assert.ok(out.confidence < STRICT_MIN_CONFIDENCE, "self-consistency stays advisory");
});

test("EnsembleProvider: samples default is 1 (passthrough) for direct construction", async () => {
  const { p, calls } = counting();
  const out = await new EnsembleProvider([p]).draftDecision(INPUT);
  assert.equal(calls(), 1, "no extra sampling unless asked");
  assert.equal(out.source, "llm_draft", "single draft passes through un-merged");
});

test("EnsembleProvider: samples is clamped to a sane 1..5 band", async () => {
  const { p, calls } = counting();
  await new EnsembleProvider([p], { samples: 99 }).draftDecision(INPUT);
  assert.equal(calls(), 5, "runaway sample counts are capped");
});

test("EnsembleProvider: a NaN/garbage samples value falls back to 1 (never 0 tasks → throw)", async () => {
  // A typo'd --samples reaches here as NaN; without a finite guard the clamp yields
  // NaN → Array.from({length:NaN}) is empty → 'all workers failed' → --deep silently
  // collapses to the deterministic draft. Must degrade to a real sample instead.
  const { p, calls } = counting();
  const out = await new EnsembleProvider([p], { samples: NaN }).draftDecision(INPUT);
  assert.ok(calls() >= 1, "the lone CLI is still sampled at least once");
  assert.equal(out.source, "llm_draft", "single sample passes through (not an error fallback)");
});
