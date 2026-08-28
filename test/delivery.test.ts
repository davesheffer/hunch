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
      { ...modelProvenance(0.65), evidence: ["test/union.test.ts: empty-union parse case"] },
    ),
    title: "Empty union options must parse without throwing",
    commit: "abcdef1",
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
  assert.deepEqual(envelope.hypotheses, [{
    kind: "decision",
    record_id: "dec_empty_union",
    rank: 1,
    why: "Matches task evidence (union, parse, throw, empty, option) and is anchored to src/union.ts.",
    where: ["src/union.ts"],
    historical_pattern: "Commit abcdef1: Handle empty options during parse so construction does not throw.",
    verify: "Inspect the recorded change before editing: git show --stat --oneline abcdef1 -- src/union.ts; then git show abcdef1 -- src/union.ts. Compare that diff with the current code, then reproduce: union parse throws for empty options.",
    disprove: "Reject this hypothesis if the reproduction does not execute src/union.ts, or if checking the recorded pattern leaves the observed failure unchanged.",
    obligations: [
      {
        id: "dec_empty_union:inspect:abcdef1",
        origin: "memory",
        category: "evidence",
        phase: "session",
        description: "Inspect recorded commit abcdef1 and compare it with the current code.",
        command_alternatives: [["git", "show", "abcdef1"]],
        expected: { success: true, output_includes: ["abcdef1"] },
      },
      {
        id: "dec_empty_union:proof:test_union.test.ts",
        origin: "memory",
        category: "behavior",
        phase: "after-edit",
        description: "Re-run the recorded proof test/union.test.ts after the latest product edit.",
        command_alternatives: [
          ["vitest", "test/union.test.ts"],
          ["jest", "test/union.test.ts"],
          ["pytest", "test/union.test.ts"],
          ["tsx", "--test", "test/union.test.ts"],
          ["node", "--test", "test/union.test.ts"],
          ["npm", "test", "test/union.test.ts"],
        ],
        expected: { success: true },
      },
    ],
  }]);
  assert.deepEqual(envelope.obligations, envelope.hypotheses[0]?.obligations);
  assert.match(envelope.text, /historical pattern: Commit abcdef1/);
  assert.match(envelope.text, /controller: dec_empty_union:inspect:abcdef1/);
  assert.match(envelope.text, /disprove: Reject this hypothesis/);
  assert.match(envelope.text, /Diagnostic loop: before editing, call hunch_context again/);
});

test("delivery envelope: task retrieval exposes at most two testable decision hypotheses", () => {
  const decisions = ["a", "b", "c"].map((suffix) => ({
    ...fixtureDecision(
      `dec_${suffix}`,
      `src/union-${suffix}.ts`,
      `Handle empty union parse failures with recorded pattern ${suffix}.`,
      provenance,
    ),
    title: `Empty union parse failure ${suffix}`,
  }));
  const envelope = buildDeliveryEnvelope(context({
    target: "empty union parse throws",
    decisions: decisions as never,
  }), { commitReachability: () => "reachable" });

  assert.deepEqual(envelope.delivered.map((item) => item.record_id), ["dec_a", "dec_b"]);
  assert.deepEqual(envelope.hypotheses.map((item) => [item.record_id, item.rank]), [["dec_a", 1], ["dec_b", 2]]);
  assert.deepEqual(
    envelope.omitted.filter((item) => item.reason === "actionability-cap").map((item) => item.record_id),
    ["dec_c"],
  );
  assert.equal(envelope.abstention.active, false, "bounded actionability is not misreported as unsafe retrieval");
  assert.doesNotMatch(envelope.text, /dec_c/);
  assert.match(envelope.text, /additional decision hypothesis/);
});

test("delivery envelope: rare task evidence outranks generic lexical overlap", () => {
  const generic = (id: string) => ({
    ...fixtureDecision(id, `src/${id}.ts`, "Parse property values through the normal path.", provenance),
    title: "Parse property values safely",
    consequences: ["An unrelated tuple default test was replaced."],
  });
  const specific = {
    ...fixtureDecision(
      "dec_z_specific",
      "src/tuple.ts",
      "Preserve optional tuple defaults when input elements are absent.",
      provenance,
    ),
    title: "Tuple defaults remain optional",
  };
  const envelope = buildDeliveryEnvelope(context({
    target: "tuple default values optional properties parse",
    decisions: [generic("dec_a_generic"), generic("dec_b_generic"), specific] as never,
  }), { commitReachability: () => "reachable" });

  assert.equal(envelope.hypotheses[0]?.record_id, "dec_z_specific");
  assert.deepEqual(envelope.hypotheses[0]?.why, "Matches task evidence (tuple, default, optional) and is anchored to src/tuple.ts.");
  assert.doesNotMatch(envelope.hypotheses[1]?.why ?? "", /tuple|default/, "consequence prose is not ranking evidence");
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

test("delivery profiles reorder only non-blocking evidence and are receipt-bound", () => {
  const blocker = {
    id: "con_universal",
    type: "architecture",
    statement: "The universal invariant must remain first for every delivery role.",
    scope: ["src/x.ts"],
    severity: "blocking",
    enforcement: "advisory_v1",
    match: null,
    forbids: null,
    rationale: "Role-specific presentation cannot change authority.",
    source_decision: null,
    violations: [],
    status: "active",
    valid_to: null,
    provenance,
  } as const;
  const bug = {
    id: "bug_regression",
    title: "A prior regression",
    symptom: "review failure",
    root_cause: "missing boundary check",
    severity: "high",
    status: "open",
    affected_files: ["src/x.ts"],
    affected_symbols: [],
    lineage: {},
    provenance,
  } as const;
  const finding = {
    id: "fnd_gap",
    title: "Known verification gap",
    observation: "The boundary has not been exercised under failure.",
    evidence: ["test:x"],
    method: "run the failure fixture",
    severity: "high",
    triage: "open",
    affected_files: ["src/x.ts"],
    affected_symbols: [],
    violates_constraint: null,
    spawned_decision: null,
    observed_at: "2026-01-01T00:00:00Z",
    resolved_commit: null,
    provenance,
  } as const;
  const ctx = context({
    constraints: [blocker] as never,
    decisions: [fixtureDecision("dec_design", "src/x.ts")] as never,
    bugs: [bug] as never,
    findings: [finding] as never,
  });

  const builder = buildDeliveryEnvelope(ctx, { profile: "builder" });
  const reviewer = buildDeliveryEnvelope(ctx, { profile: "reviewer" });
  const architect = buildDeliveryEnvelope(ctx, { profile: "architect" });

  assert.deepEqual(builder.delivered.map((item) => item.record_id), ["con_universal", "dec_design", "bug_regression", "fnd_gap"]);
  assert.deepEqual(reviewer.delivered.map((item) => item.record_id), ["con_universal", "bug_regression", "fnd_gap", "dec_design"]);
  assert.deepEqual(architect.delivered.map((item) => item.record_id), ["con_universal", "dec_design", "bug_regression", "fnd_gap"]);
  assert.ok([builder, reviewer, architect].every((envelope) => envelope.delivered[0]?.delivery_reason === "blocking-reserved"));
  assert.equal(reviewer.ranking_policy, "hunch.delivery-profile/1");
  assert.notEqual(builder.receipt_id, reviewer.receipt_id, "the selected role is sealed into the receipt");
  assert.match(reviewer.text, /Reviewer-ranked memory/);
});

test("delivery profiles expose an honest eight-headline non-blocking cap", () => {
  const bugs = Array.from({ length: 10 }, (_, index) => ({
    id: `bug_${String(index).padStart(2, "0")}`,
    title: `Review risk ${index}`,
    symptom: "risk",
    root_cause: "fixture",
    severity: "medium",
    status: "open",
    affected_files: ["src/x.ts"],
    affected_symbols: [],
    lineage: {},
    provenance,
  }));
  const envelope = buildDeliveryEnvelope(context({ bugs: bugs as never, budget_tokens: 10_000 }), {
    profile: "reviewer",
  });

  assert.equal(envelope.delivered.length, 8);
  assert.equal(envelope.omitted.filter((item) => item.reason === "profile-cap").length, 2);
  assert.match(envelope.text, /2 non-blocking record\(s\) withheld by the reviewer profile cap/);
});
