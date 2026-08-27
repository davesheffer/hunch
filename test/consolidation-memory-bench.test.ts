import assert from "node:assert/strict";
import test from "node:test";
import {
  CONDITIONS,
  NEW_FACT_KEYS,
  PROTECTED_KEYS,
  buildConditionPackets,
  conditionOrder,
  dryRunSummary,
  loadCaseBank,
  normalizeExact,
  pairedScore,
  parseStructuredResult,
  scoreCondition,
  validateCaseBank,
  type AnswerRow,
  type CaseBank,
  type Condition,
  type ConditionAnswer,
  type MemoryCase,
} from "../bench/external/run-consolidation-memory.js";

function cloneBank(bank: CaseBank): CaseBank {
  return JSON.parse(JSON.stringify(bank)) as CaseBank;
}

function correctAnswer(cases: MemoryCase[], condition: Condition): ConditionAnswer {
  return {
    answers: cases.map((item) => ({
      case_id: item.id,
      values: {
        ...item.protected,
        current_owner: condition === "clean" ? "UNKNOWN" : item.new_facts.current_owner,
        rollout_window: condition === "clean" ? "UNKNOWN" : item.new_facts.rollout_window,
      },
    })),
  };
}

function row(answer: ConditionAnswer, caseId: string): AnswerRow {
  return answer.answers.find((item) => item.case_id === caseId)!;
}

test("direct-memory case bank is valid and does not re-expose protected nonce facts", () => {
  const bank = loadCaseBank();
  assert.equal(bank.cases.length, 8);
  assert.ok(bank.cases.every((item) => item.updates.length === 12));
  assert.doesNotThrow(() => validateCaseBank(bank));

  const invalid = cloneBank(bank);
  invalid.cases[0]!.updates[0] += ` Use ${invalid.cases[0]!.protected.queue}.`;
  assert.throws(() => validateCaseBank(invalid), /re-exposes protected queue/);
});

test("condition packets isolate clean, immutable, rewritten, and rescued memory", () => {
  const { cases } = loadCaseBank();
  const rewritten = Object.fromEntries(cases.map((item) => [item.id, `rewritten-only-${item.id}`]));
  const packets = buildConditionPackets(cases, rewritten);
  const first = cases[0]!;

  assert.ok(packets.clean[first.id]!.includes(first.seed));
  assert.ok(!packets.clean[first.id]!.includes(first.updates[0]!));
  assert.ok(packets.additive[first.id]!.includes(first.seed));
  assert.ok(first.updates.every((update) => packets.additive[first.id]!.includes(update)));
  assert.equal(packets.rewritten[first.id], `CONSOLIDATED MEMORY\nrewritten-only-${first.id}`);
  assert.ok(packets.rescue[first.id]!.includes(`rewritten-only-${first.id}`));
  assert.ok(packets.rescue[first.id]!.endsWith(first.seed));
});

test("exact scorer normalizes presentation only and calibrates absent clean facts", () => {
  const { cases } = loadCaseBank();
  const answer = correctAnswer(cases, "clean");
  row(answer, cases[0]!.id).values.queue = `  ${cases[0]!.protected.queue.toUpperCase()}  `;
  row(answer, cases[0]!.id).values.retry_cap = "four";
  const score = scoreCondition(cases, "clean", answer);

  assert.equal(normalizeExact("  X\tY  "), "x y");
  assert.equal(score.protected.total, cases.length * PROTECTED_KEYS.length);
  assert.equal(score.protected.correct, score.protected.total - 1);
  assert.equal(score.new_facts.total, cases.length * NEW_FACT_KEYS.length);
  assert.equal(score.new_facts.correct, score.new_facts.total);
});

test("paired scorer counts replacement harms, inverse wins, and seed rescue", () => {
  const { cases } = loadCaseBank();
  const answers = Object.fromEntries(CONDITIONS.map((condition) => [condition, correctAnswer(cases, condition)])) as Record<Condition, ConditionAnswer>;
  row(answers.rewritten, cases[0]!.id).values.queue = "wrong";
  row(answers.additive, cases[1]!.id).values.retry_cap = "wrong";
  const scores = Object.fromEntries(CONDITIONS.map((condition) => [
    condition,
    scoreCondition(cases, condition, answers[condition]),
  ])) as ReturnType<typeof scoreCondition> extends infer Score ? Record<Condition, Score> : never;
  const paired = pairedScore(scores);

  assert.deepEqual(paired.harms, [`${cases[0]!.id}:queue`]);
  assert.deepEqual(paired.wins, [`${cases[1]!.id}:retry_cap`]);
  assert.deepEqual(paired.rescued_harms, [`${cases[0]!.id}:queue`]);
  assert.equal(paired.rescue_rate, 1);
});

test("dry run freezes a three-repeat, sixteen-call-per-repeat design without model calls", () => {
  const bank = loadCaseBank();
  assert.deepEqual(conditionOrder(1), ["clean", "additive", "rewritten", "rescue"]);
  assert.deepEqual(conditionOrder(2), ["additive", "rewritten", "rescue", "clean"]);
  assert.deepEqual(conditionOrder(3), ["rewritten", "rescue", "clean", "additive"]);
  const summary = dryRunSummary(bank, 2);
  assert.equal(summary.valid, true);
  assert.equal(summary.no_model_calls_made, true);
  assert.equal(summary.protocol_version, 2);
  assert.equal(summary.planned_model_calls, 16);
  assert.equal(summary.max_cli_turns_per_call, 2);
  assert.equal(summary.protected_units, 32);
});

test("Claude CLI structured-output envelope is parsed without relying on prose", () => {
  const structured = { answers: [] };
  const parsed = parseStructuredResult(JSON.stringify({
    type: "result",
    subtype: "success",
    is_error: false,
    result: "human-readable fallback",
    structured_output: structured,
  }));
  assert.deepEqual(parsed.parsed, structured);
});
