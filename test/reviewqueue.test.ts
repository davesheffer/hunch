import { test } from "node:test";
import assert from "node:assert/strict";
import { parseSynth, partitionReview, isReady, isReviewDraft, READY_MIN_GROUNDED } from "../src/core/reviewqueue.js";
import type { Decision } from "../src/core/types.js";

const D = (over: { id?: string; source?: string; confidence?: number; evidence?: string[] }): Decision => ({
  id: over.id ?? "dec_x", title: "t", decision: "did the thing",
  provenance: { source: over.source ?? "llm_draft", confidence: over.confidence ?? 0.5, evidence: over.evidence ?? [] },
} as Decision);

test("parseSynth: extracts provider/grounded/samples/agreement/pruned", () => {
  const s = parseSynth(["commit:abc", "synth:provider=claude-cli grounded=0.72 samples=2 agreement=0.33 pruned=3", "src/x.ts"]);
  assert.equal(s.provider, "claude-cli");
  assert.equal(s.grounded, 0.72);
  assert.equal(s.samples, 2);
  assert.equal(s.agreement, 0.33);
  assert.equal(s.pruned, 3);
  assert.equal(s.verify, undefined);
});

test("parseSynth: captures a verify=failed marker; absent/empty → {}", () => {
  assert.equal(parseSynth(["synth:provider=ensemble verify=failed"]).verify, "failed");
  assert.deepEqual(parseSynth(["commit:abc"]), {});
  assert.deepEqual(parseSynth(undefined), {});
});

test("isReviewDraft: only an un-vouched proposed record counts; low confidence alone does NOT", () => {
  // The auto-trust core: captured memory lands `accepted` and is trusted advisory —
  // even at low confidence it is NEVER a review draft. Only a deliberate, un-vouched
  // `proposed` entry awaits a human.
  assert.equal(isReviewDraft({ ...D({ confidence: 0.1 }), status: "accepted" } as Decision), false, "low-confidence accepted memory is not a draft");
  assert.equal(isReviewDraft({ ...D({ confidence: 0.5, source: "llm_draft" }), status: "proposed" } as Decision), true, "un-vouched proposed → review draft");
  assert.equal(isReviewDraft({ ...D({ source: "llm_draft+human_confirmed" }), status: "proposed" } as Decision), false, "a human-vouched proposed record is roadmap intent, not a draft");
  assert.equal(isReviewDraft({ ...D({}), status: "superseded" } as Decision), false, "superseded is not a draft");
});

test("isReady: only a Critic-verified AND well-grounded draft is ready", () => {
  assert.equal(isReady(D({ source: "llm_draft+verified" }), { grounded: 0.8 }), true);
  assert.equal(isReady(D({ source: "llm_draft+verified" }), { grounded: 0.5 }), false, "low grounding → not ready");
  assert.equal(isReady(D({ source: "llm_draft" }), { grounded: 0.9 }), false, "unverified → not ready even at high grounding");
  assert.equal(isReady(D({ source: "llm_draft+ensemble+verified" }), {}), false, "verified but no grounded value → not ready");
});

test("partitionReview: ready sorted by grounded desc; scrutiny by confidence asc; disjoint", () => {
  const a = D({ id: "a", source: "llm_draft+verified", confidence: 0.43, evidence: ["synth:provider=x grounded=0.72"] });
  const b = D({ id: "b", source: "llm_draft+verified", confidence: 0.5, evidence: ["synth:provider=x grounded=0.9"] });
  const c = D({ id: "c", source: "llm_draft", confidence: 0.3, evidence: [] });                                        // unverified → scrutiny
  const e = D({ id: "e", source: "llm_draft+summary+verified", confidence: 0.5, evidence: ["synth:provider=x grounded=0.4"] }); // low-grounded → scrutiny
  const { ready, scrutiny } = partitionReview([a, b, c, e]);
  assert.deepEqual(ready.map((it) => it.d.id), ["b", "a"], "grounded 0.9 before 0.72");
  assert.deepEqual(scrutiny.map((it) => it.d.id), ["c", "e"], "confidence 0.3 before 0.5");
});

test("partitionReview: respects a custom minGrounded threshold", () => {
  const x = D({ id: "x", source: "llm_draft+verified", evidence: ["synth:grounded=0.6"] });
  assert.equal(partitionReview([x], 0.5).ready.length, 1, "0.6 grounded clears a 0.5 bar");
  assert.equal(partitionReview([x], 0.7).ready.length, 0, "0.6 grounded fails a 0.7 bar");
  assert.equal(READY_MIN_GROUNDED, 0.7);
});

test("agent testimony (agent_recorded proposed) is roadmap intent marked unconfirmed — never a draft adopt-drafts could accept", async () => {
  const { nowData, unconfirmedRoadmapMarker } = await import("../src/wiki/wiki.js");
  const P = (id: string, source: string): Decision => ({ ...D({ id, source }), status: "proposed", date: "2026-09-17", context: "why" } as Decision);
  const testimony = P("dec_testimony", "agent_recorded");
  assert.equal(isReviewDraft(testimony), false, "kept out of the draft queue (adopt-drafts / auto-review)");
  const { roadmap, pendingReview } = nowData([testimony, P("dec_human", "human_confirmed"), P("dec_draft", "llm_draft")]);
  assert.deepEqual(roadmap.map((r) => r.id).sort(), ["dec_human", "dec_testimony"], "testimony shows; the machine draft does not");
  assert.equal(pendingReview, 1, "only the machine draft counts as a legacy un-vouched draft");
  const t = roadmap.find((r) => r.id === "dec_testimony")!;
  assert.equal(t.unconfirmed, true);
  assert.equal(roadmap.find((r) => r.id === "dec_human")!.unconfirmed, undefined);
  assert.match(unconfirmedRoadmapMarker(t), /unconfirmed.*hunch review --confirm dec_testimony$/);
  assert.match(unconfirmedRoadmapMarker(t, { private: true }), /hunch review --confirm dec_testimony --private$/);
});
