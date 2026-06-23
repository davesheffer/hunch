import { test } from "node:test";
import assert from "node:assert/strict";
import { STRICT_MIN_CONFIDENCE } from "../src/core/strictgate.js";
import {
  applyVerdict, verdictFromText, verifyDecisionSafe,
  type DecisionDraft, type VerifyVerdict, type CommitInput, type SynthProvider, type BugDraft,
} from "../src/synthesis/provider.js";

const DRAFT = (over: Partial<DecisionDraft> = {}): DecisionDraft => ({
  title: "t", context: "c", decision: "introduce an LRU cache",
  consequences: ["faster reads", "more memory use"],
  alternatives_rejected: ["use Redis instead", "no cache at all"],
  confidence: 0.65, source: "llm_draft", ...over,
});
const INPUT: CommitInput = { subject: "s", body: "b", files: ["a.ts"], diff: "diff" };

test("applyVerdict: prunes unsupported alternatives so they never scaffold tripwires", () => {
  const v: VerifyVerdict = { grounded: 1, unsupported_alternatives: ["use Redis instead"], unsupported_claims: [] };
  const out = applyVerdict(DRAFT(), v);
  assert.deepEqual(out.alternatives_rejected, ["no cache at all"]);
  assert.match(out.source, /verified/);
  assert.equal(out.pruned, 1, "the prune count is recorded for review telemetry");
});

test("applyVerdict: prunes unsupported consequences", () => {
  const v: VerifyVerdict = { grounded: 1, unsupported_alternatives: [], unsupported_claims: ["more memory use"] };
  const out = applyVerdict(DRAFT(), v);
  assert.deepEqual(out.consequences, ["faster reads"]);
  assert.equal(out.pruned, 1);
});

test("applyVerdict: grounded=1 keeps confidence; weak grounding LOWERS it; never raises (R2)", () => {
  const full = applyVerdict(DRAFT({ confidence: 0.7 }), { grounded: 1, unsupported_alternatives: [], unsupported_claims: [] });
  assert.equal(full.confidence, 0.7);
  assert.equal(full.grounded, 1);

  const weak = applyVerdict(DRAFT({ confidence: 0.7 }), { grounded: 0.2, unsupported_alternatives: [], unsupported_claims: [] });
  assert.ok(weak.confidence < 0.7, "weak grounding lowers confidence");
  assert.ok(weak.confidence < STRICT_MIN_CONFIDENCE, "stays advisory");

  // Even a perfect verdict on an already-capped ensemble draft can't push it up.
  const capped = applyVerdict(DRAFT({ confidence: 0.78 }), { grounded: 1, unsupported_alternatives: [], unsupported_claims: [] });
  assert.ok(capped.confidence <= 0.78);
});

test("applyVerdict: alternative matching is normalized + whitespace/case tolerant", () => {
  const v: VerifyVerdict = { grounded: 0.9, unsupported_alternatives: ["  USE   redis INSTEAD "], unsupported_claims: [] };
  const out = applyVerdict(DRAFT(), v);
  assert.ok(!out.alternatives_rejected.includes("use Redis instead"), "reworded/cased flag still prunes");
  assert.deepEqual(out.alternatives_rejected, ["no cache at all"]);
});

test("applyVerdict: clamps an out-of-range grounded score", () => {
  const out = applyVerdict(DRAFT({ confidence: 0.6 }), { grounded: 5, unsupported_alternatives: [], unsupported_claims: [] });
  assert.equal(out.grounded, 1, "clamped to [0,1]");
  assert.equal(out.confidence, 0.6);
});

test("verdictFromText: parses a verdict, coerces arrays, returns null on junk", () => {
  const v = verdictFromText('{"grounded":0.8,"unsupported_alternatives":["x"],"unsupported_claims":[]}');
  assert.ok(v);
  assert.equal(v!.grounded, 0.8);
  assert.deepEqual(v!.unsupported_alternatives, ["x"]);
  assert.equal(verdictFromText("no json here at all"), null);
});

test("verdictFromText: missing grounded defaults to 1 when lists are present", () => {
  const v = verdictFromText('{"unsupported_alternatives":["x"]}');
  assert.ok(v);
  assert.equal(v!.grounded, 1);
});

test("verifyDecisionSafe: degrades visibly (not silently) on absence/inability/failure", async () => {
  const draft = DRAFT();
  // no verifier available (no CLI installed) → marked 'unavailable', draft untouched
  const none = await verifyDecisionSafe(null, INPUT, draft);
  assert.equal(none.source, "llm_draft");
  assert.equal(none.verifyOutcome, "unavailable");

  // a provider that can't verify (deterministic-like — no verifyDecision method)
  const noVerify: SynthProvider = { name: "det", available: async () => true, draftDecision: async () => draft, draftBug: async () => ({} as BugDraft) };
  assert.equal((await verifyDecisionSafe(noVerify, INPUT, draft)).verifyOutcome, "unavailable");

  // a verifier that always throws → retried, then marked 'failed' (never loses the draft)
  let calls = 0;
  const boom: SynthProvider = { ...noVerify, verifyDecision: async () => { calls++; throw new Error("x"); } };
  const out = await verifyDecisionSafe(boom, INPUT, draft);
  assert.equal(out.source, "llm_draft");
  assert.equal(out.verifyOutcome, "failed");
  assert.equal(out.alternatives_rejected.length, 2, "draft untouched on failure");
  assert.equal(calls, 2, "the Critic call is retried once before giving up");
});

test("verifyDecisionSafe: a transient failure is recovered by the single retry", async () => {
  let calls = 0;
  const flaky: SynthProvider = {
    name: "v", available: async () => true,
    draftDecision: async () => DRAFT(),
    draftBug: async () => ({} as BugDraft),
    verifyDecision: async () => {
      if (++calls === 1) throw new Error("transient");
      return { grounded: 1, unsupported_alternatives: [], unsupported_claims: [] };
    },
  };
  const out = await verifyDecisionSafe(flaky, INPUT, DRAFT());
  assert.equal(calls, 2, "first attempt failed, retry succeeded");
  assert.equal(out.verifyOutcome, "applied");
  assert.match(out.source, /verified/);
});

test("verifyDecisionSafe: applies a successful verdict end-to-end", async () => {
  const ok: SynthProvider = {
    name: "v", available: async () => true,
    draftDecision: async () => DRAFT(),
    draftBug: async () => ({} as BugDraft),
    verifyDecision: async () => ({ grounded: 1, unsupported_alternatives: ["no cache at all"], unsupported_claims: [] }),
  };
  const out = await verifyDecisionSafe(ok, INPUT, DRAFT());
  assert.deepEqual(out.alternatives_rejected, ["use Redis instead"]);
  assert.match(out.source, /verified/);
  assert.equal(out.verifyOutcome, "applied");
});
