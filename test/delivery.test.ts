import { test } from "node:test";
import assert from "node:assert/strict";
import { buildDeliveryEnvelope } from "../src/core/delivery.js";
import type { AssembledContext } from "../src/store/hunchStore.js";

const provenance = { source: "human_confirmed", confidence: 1, evidence: [] };

function fixtureDecision(
  id: string,
  file: string,
  claim = "keep the current architecture",
  decisionProvenance = provenance,
) {
  return {
    id,
    title: `Decision ${id}`,
    topic: null,
    status: "accepted",
    context: "",
    decision: claim,
    consequences: [],
    alternatives_rejected: [],
    rejected_tripwires: [],
    related_components: [],
    related_files: [file],
    supersedes: null,
    superseded_by: null,
    caused_by_bug: null,
    commit: null,
    valid_to: null,
    retired: { symbols: [], deps: [] },
    provenance: decisionProvenance,
    date: "2026-01-01T00:00:00Z",
  } as const;
}

const modelProvenance = (confidence: number) => ({ source: "llm_draft", confidence, evidence: [] });

function context(overrides: Partial<AssembledContext> = {}): AssembledContext {
  return {
    target: "src/x.ts",
    constraints: [],
    decisions: [],
    bugs: [],
    blast_radius: [],
    components: [],
    findings: [],
    budget_tokens: 1500,
    ...overrides,
  } as AssembledContext;
}

test("delivery envelope: budget receipts only records whose headline was rendered", () => {
  const ctx = context({
    budget_tokens: 105,
    decisions: [
      fixtureDecision("dec_a", "src/x.ts", "A".repeat(180)),
      fixtureDecision("dec_b", "src/x.ts", "B".repeat(180)),
    ] as never,
  });
  const envelope = buildDeliveryEnvelope(ctx, {
    symbols: [{ id: "sym_x", name: "x", file: "src/x.ts" }],
    commitReachability: () => "reachable",
  });

  assert.deepEqual(envelope.delivered.map((item) => item.record_id), ["dec_a"]);
  assert.deepEqual(envelope.delivered[0], {
    kind: "decisions",
    record_id: "dec_a",
    rank: 1,
    delivery_reason: "ranked",
    provenance_status: "unverified",
    token_cost: envelope.delivered[0]?.token_cost,
  });
  assert.ok((envelope.delivered[0]?.token_cost ?? 0) > 0);
  assert.ok(envelope.text.includes("dec_a"));
  assert.ok(!envelope.text.includes("dec_b"));
  assert.equal(envelope.omitted.find((item) => item.record_id === "dec_b")?.reason, "budget");
  assert.ok(envelope.used_chars <= ctx.budget_tokens * 4);
});

test("delivery envelope: supplemental grounding shares the hard budget instead of overflowing afterward", () => {
  const ctx = context({ budget_tokens: 75 });
  const envelope = buildDeliveryEnvelope(ctx, {
    supplements: [
      { id: "retired", kind: "retired-code", text: "Do not reintroduce retiredFunction (dec_retired).", priority: 2 },
      { id: "doc", kind: "doc-grounding", text: "D".repeat(800), priority: 1 },
    ],
  });

  assert.ok(envelope.used_chars <= ctx.budget_tokens * 4);
  assert.ok(envelope.text.includes("retiredFunction"));
  assert.deepEqual(envelope.supplements.map((item) => [item.id, item.delivered, item.reason]), [
    ["retired", true, "supplemental"],
    ["doc", false, "budget"],
  ]);
});

test("delivery envelope: stale anchors and unreachable commits are withheld", () => {
  const missing = fixtureDecision("dec_missing", "src/deleted.ts");
  const unreachable = { ...fixtureDecision("dec_branch", "src/x.ts"), commit: "abcdef1" };
  const envelope = buildDeliveryEnvelope(context({ decisions: [missing, unreachable] as never }), {
    symbols: [{ id: "sym_x", name: "x", file: "src/x.ts" }],
    commitReachability: () => "unreachable",
  });

  assert.deepEqual(envelope.delivered, []);
  assert.deepEqual(envelope.omitted.map((item) => [item.record_id, item.reason]), [
    ["dec_branch", "stale-provenance"],
    ["dec_missing", "stale-provenance"],
  ]);
});

test("delivery envelope: abstains from low-authority decisions when given only a file path", () => {
  const weak = fixtureDecision(
    "dec_file_only",
    "src/x.ts",
    "Centralize an adjacent helper used by this file.",
    modelProvenance(0.65),
  );
  const envelope = buildDeliveryEnvelope(context({ decisions: [weak] as never }), {
    symbols: [{ id: "sym_x", name: "x", file: "src/x.ts" }],
    commitReachability: () => "reachable",
  });

  assert.deepEqual(envelope.delivered, []);
  assert.equal(envelope.omitted[0]?.reason, "insufficient-context");
  assert.deepEqual(envelope.abstention.reasons, {
    "low-confidence": 0,
    "insufficient-context": 1,
    "low-relevance": 0,
  });
  assert.equal(envelope.abstention.active, true);
  assert.match(envelope.abstention.retry_hint ?? "", /concrete symptom/i);
  assert.doesNotMatch(envelope.text, /dec_file_only/);
});

test("delivery envelope: a low-authority decision is delivered when task evidence matches", () => {
  const relevant = {
    ...fixtureDecision(
      "dec_empty_union",
      "src/union.ts",
      "Handle empty options during parse so construction does not throw.",
      modelProvenance(0.65),
    ),
    title: "Empty union options must parse without throwing",
  };
  const ctx = context({
    target: "union parse throws for empty options",
    decisions: [relevant] as never,
  });
  const envelope = buildDeliveryEnvelope(ctx, {
    symbols: [
      { id: "sym_union", name: "union", file: "src/union.ts" },
      { id: "sym_parse", name: "parse", file: "src/union.ts" },
    ],
    commitReachability: () => "reachable",
  });

  assert.deepEqual(envelope.delivered.map((item) => item.record_id), ["dec_empty_union"]);
  assert.equal(envelope.abstention.active, false);
});

test("delivery envelope: entity overlap alone does not pass relevance abstention", () => {
  const adjacent = {
    ...fixtureDecision(
      "dec_xor_shape",
      "src/union.ts",
      "Implement xor as a union subclass for mutual exclusivity.",
      modelProvenance(0.65),
    ),
    title: "Use a union subclass for xor",
  };
  const ctx = context({
    target: "z.union throws internal error on parse, empty union xor never type",
    decisions: [adjacent] as never,
  });
  const envelope = buildDeliveryEnvelope(ctx, {
    symbols: [
      { id: "sym_union", name: "union", file: "src/union.ts" },
      { id: "sym_xor", name: "xor", file: "src/union.ts" },
      { id: "sym_parse", name: "parse", file: "src/union.ts" },
      { id: "sym_type", name: "type", file: "src/types.ts" },
      { id: "sym_error", name: "error", file: "src/errors.ts" },
    ],
    supplements: [{ id: "sym_bench_union", kind: "search-symbols", text: "union method in a benchmark" }],
    commitReachability: () => "reachable",
  });

  assert.deepEqual(envelope.delivered, []);
  assert.equal(envelope.omitted[0]?.reason, "low-relevance");
  assert.deepEqual(envelope.supplements.map((item) => [item.delivered, item.reason]), [[false, "abstained"]]);
  assert.doesNotMatch(envelope.text, /dec_xor_shape|sym_bench_union/);
});

test("delivery envelope: confidence floor wins even when lexical relevance is strong", () => {
  const draft = {
    ...fixtureDecision(
      "dec_guess",
      "src/union.ts",
      "Empty union parse should reject input without throwing.",
      modelProvenance(0.4),
    ),
    title: "Fix empty union parse throwing",
  };
  const envelope = buildDeliveryEnvelope(context({
    target: "empty union parse throws",
    decisions: [draft] as never,
  }), { commitReachability: () => "reachable" });

  assert.deepEqual(envelope.delivered, []);
  assert.equal(envelope.omitted[0]?.reason, "low-confidence");
  assert.equal(envelope.abstention.reasons["low-confidence"], 1);
});

test("delivery envelope: active blocking invariants are never silently dropped", () => {
  const constraint = {
    id: "con_block",
    type: "correctness",
    statement: "Never drop this invariant even when the caller requests an impossible budget.",
    scope: ["src/x.ts"],
    severity: "blocking",
    enforcement: "advisory_v1",
    match: null,
    forbids: null,
    rationale: "",
    source_decision: null,
    violations: [],
    status: "active",
    valid_to: null,
    provenance,
  } as const;
  const envelope = buildDeliveryEnvelope(context({ constraints: [constraint] as never, budget_tokens: 5 }), {
    symbols: [{ id: "sym_x", name: "x", file: "src/x.ts" }],
  });

  assert.deepEqual(envelope.delivered.map((item) => item.record_id), ["con_block"]);
  assert.equal(envelope.delivered[0]?.delivery_reason, "blocking-reserved");
  assert.ok(envelope.text.includes("con_block"));
  assert.equal(envelope.blocking_overflow, true, "impossible budgets are explicit instead of losing a blocker");
  assert.equal(envelope.abstention.active, false);
});
