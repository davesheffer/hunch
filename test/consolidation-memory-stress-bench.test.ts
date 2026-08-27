import assert from "node:assert/strict";
import test from "node:test";
import {
  STRESS_CONDITIONS,
  STRESS_NEW_FACT_KEYS,
  STRESS_PROTECTED_KEYS,
  STRESS_UPDATE_ROUNDS,
  STRESS_TARGET_WORDS,
  STRESS_WORD_CAP,
  buildStressCases,
  buildStressPackets,
  pairedStressScore,
  parseStressStructuredResult,
  scoreStressCondition,
  stressConditionOrder,
  stressDryRunSummary,
  validateStressMemoryText,
  validateStressCases,
  type StressAnswerRow,
  type StressCase,
  type StressCondition,
  type StressConditionAnswer,
} from "../bench/external/run-consolidation-memory-stress.js";

function cloneCases(cases: StressCase[]): StressCase[] {
  return JSON.parse(JSON.stringify(cases)) as StressCase[];
}

function correctAnswer(cases: StressCase[], condition: StressCondition): StressConditionAnswer {
  return {
    answers: cases.map((item) => ({
      case_id: item.id,
      values: {
        ...item.protected,
        ...Object.fromEntries(STRESS_NEW_FACT_KEYS.map((key) => [
          key,
          condition === "clean" ? "UNKNOWN" : item.new_facts[key],
        ])),
      },
    })) as StressAnswerRow[],
  };
}

function row(answer: StressConditionAnswer, caseId: string): StressAnswerRow {
  return answer.answers.find((item) => item.case_id === caseId)!;
}

test("stress case bank freezes six isolated cases, twelve seed facts, and thirty updates", () => {
  const cases = buildStressCases();
  assert.doesNotThrow(() => validateStressCases(cases));
  assert.equal(cases.length, 6);
  assert.ok(cases.every((item) => Object.keys(item.protected).length === 12));
  assert.ok(cases.every((item) => item.updates.length === STRESS_UPDATE_ROUNDS));
  assert.ok(cases.every((item) => item.seed.trim().split(/\s+/).length <= STRESS_WORD_CAP));

  const invalid = cloneCases(cases);
  invalid[0]!.updates[0] += ` Use ${invalid[0]!.protected.queue}.`;
  assert.throws(() => validateStressCases(invalid), /re-exposes protected queue/);
});

test("stress packets keep immutable and rescued evidence separate from replacement", () => {
  const cases = buildStressCases();
  const rewritten = Object.fromEntries(cases.map((item) => [item.id, `rewritten-only-${item.id}`]));
  const packets = buildStressPackets(cases, rewritten);
  const first = cases[0]!;
  assert.ok(packets.clean[first.id]!.includes(first.seed));
  assert.ok(!packets.clean[first.id]!.includes(first.updates[0]!));
  assert.ok(first.updates.every((update) => packets.additive[first.id]!.includes(update)));
  assert.equal(packets.rewritten[first.id], `CONSOLIDATED MEMORY\nrewritten-only-${first.id}`);
  assert.ok(packets.rescue[first.id]!.endsWith(first.seed));
});

test("stress exact scorer covers all protected and checkpoint facts", () => {
  const cases = buildStressCases();
  const answer = correctAnswer(cases, "clean");
  row(answer, cases[0]!.id).values.retry_cap = "four";
  const score = scoreStressCondition(cases, "clean", answer);
  assert.equal(score.protected.total, cases.length * STRESS_PROTECTED_KEYS.length);
  assert.equal(score.protected.correct, score.protected.total - 1);
  assert.equal(score.new_facts.total, cases.length * STRESS_NEW_FACT_KEYS.length);
  assert.equal(score.new_facts.correct, score.new_facts.total);
});

test("stress paired scorer identifies harm, inverse win, and authoritative rescue", () => {
  const cases = buildStressCases();
  const answers = Object.fromEntries(STRESS_CONDITIONS.map((condition) => [condition, correctAnswer(cases, condition)])) as Record<StressCondition, StressConditionAnswer>;
  row(answers.rewritten, cases[0]!.id).values.schema_namespace = "wrong";
  row(answers.additive, cases[1]!.id).values.audit_topic = "wrong";
  const scores = Object.fromEntries(STRESS_CONDITIONS.map((condition) => [
    condition,
    scoreStressCondition(cases, condition, answers[condition]),
  ])) as ReturnType<typeof scoreStressCondition> extends infer Score ? Record<StressCondition, Score> : never;
  const paired = pairedStressScore(scores);
  assert.deepEqual(paired.harms, [`${cases[0]!.id}:schema_namespace`]);
  assert.deepEqual(paired.wins, [`${cases[1]!.id}:audit_topic`]);
  assert.deepEqual(paired.rescued_harms, [`${cases[0]!.id}:schema_namespace`]);
  assert.equal(paired.rescue_rate, 1);
});

test("stress dry run freezes three rotated 34-call repeats without model calls", () => {
  const cases = buildStressCases();
  assert.deepEqual(stressConditionOrder(1), ["clean", "additive", "rewritten", "rescue"]);
  assert.deepEqual(stressConditionOrder(2), ["additive", "rewritten", "rescue", "clean"]);
  assert.deepEqual(stressConditionOrder(3), ["rewritten", "rescue", "clean", "additive"]);
  const summary = stressDryRunSummary(cases, 3);
  assert.equal(summary.protocol_version, 4);
  assert.equal(summary.no_model_calls_made, true);
  assert.equal(summary.planned_model_calls, 34);
  assert.equal(summary.protected_units, 72);
  assert.equal(summary.new_fact_units, 36);
  assert.equal(summary.word_cap, 100);
  assert.equal(summary.target_words, STRESS_TARGET_WORDS);
});

test("stress runner reads schema-constrained CLI output from structured_output", () => {
  const structured = { memories: [] };
  const parsed = parseStressStructuredResult(JSON.stringify({
    type: "result",
    subtype: "success",
    is_error: false,
    result: "fallback",
    structured_output: structured,
  }));
  assert.deepEqual(parsed.parsed, structured);
});

test("stress replacement output enforces the frozen word cap", () => {
  assert.equal(validateStressMemoryText("case", Array(100).fill("fact").join(" ")).split(/\s+/).length, 100);
  assert.throws(
    () => validateStressMemoryText("case", Array(101).fill("fact").join(" ")),
    /exceeds frozen 100-word cap/,
  );
});
