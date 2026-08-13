import { test } from "node:test";
import assert from "node:assert/strict";
import { buildDeliveryEnvelope } from "../src/core/delivery.js";
import type { AssembledContext } from "../src/store/hunchStore.js";

const provenance = { source: "human_confirmed", confidence: 1, evidence: [] };

function fixtureDecision(id: string, file: string, claim = "keep the current architecture") {
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
    provenance,
    date: "2026-01-01T00:00:00Z",
  } as const;
}

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
});
