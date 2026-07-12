import { test } from "node:test";
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { createHash } from "node:crypto";
import { chmodSync, existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { hunchPaths } from "../src/core/paths.js";
import { HunchStore } from "../src/store/hunchStore.js";
import { G3EvidenceRepository, compileExperimentPreregistration, type CompileExperimentPreregistrationInput } from "../src/constitution/g3.js";
import { ConstitutionService } from "../src/constitution/service.js";
import {
  ExperimentRepository,
  assignmentTreatment,
  buildExperimentReport,
  compileExperimentCaseBank,
  compileExperimentFollowup,
  compileExperimentOutcome,
  compileExperimentReviewStart,
  compileExperimentRun,
  compileExperimentStop,
  currentExperimentOutcomes,
  type CompileExperimentCaseBankInput,
  type ExperimentCaseBank,
  type ExperimentOutcome,
} from "../src/constitution/experiment.js";
import { executeExp01Assignment } from "../src/constitution/experimentRunner.js";

const REGISTERED = "2026-07-11T12:00:00.000Z";
const LOCKED = "2026-07-12T12:00:00.000Z";
const H = (c: string): string => `sha1:${c.repeat(40)}`;
const BASE = "a".repeat(40);

function prereg(experiment: "EXP-01" | "EXP-03", revision = 1): ReturnType<typeof compileExperimentPreregistration> {
  const unit = experiment === "EXP-01" ? "task" as const : "policy_candidate" as const;
  const input: CompileExperimentPreregistrationInput = {
    experiment,
    revision,
    hypothesis: "Fresh assigned treatment changes the locked primary outcome.",
    primary_metric: experiment === "EXP-01" ? "policy violation rate" : "accepted precise policies per reviewer hour",
    secondary_metrics: ["raw missing denominator"],
    unit,
    arms: [{ id: "A", description: "control" }, { id: "B", description: "partial" }, { id: "C", description: "full" }],
    assignment: { method: "blocked_randomized", unit, seed: `${experiment}-fresh-seed` },
    strata: experiment === "EXP-01" ? ["scenario", "model_version"] : ["reviewer", "evidence_family"],
    inclusion: ["created after preregistration"],
    exclusion: ["old benchmark cases"],
    sample_plan: { minimum_per_arm: 2, target_per_arm: 2, maximum_total: 6, rationale: "Small executable test fixture." },
    analysis_plan: {
      primary_estimator: "raw arm rate",
      effect_size: "risk or rate difference",
      uncertainty: "95 percent interval",
      missing_data: "retain all assignments",
      multiple_metrics: "one primary",
    },
    stopping_rule: "Stop only at fixed assignment cap or an independent guardrail.",
    guardrails: ["zero private leaks"],
    actor: "human:owner",
    reason: "Fresh fixture preregistration.",
    supersedes: null,
  };
  return compileExperimentPreregistration(input, { now: REGISTERED });
}

function exp01Input(registration = prereg("EXP-01")): CompileExperimentCaseBankInput {
  return {
    experiment: "EXP-01",
    preregistration_id: registration.id,
    preregistration_hash: registration.content_hash,
    repository_root: process.cwd(),
    base_commit: BASE,
    actor: "human:owner",
    reason: "Fresh hidden implementation cases.",
    cases: ["one", "two"].map((id) => ({
      id,
      block: "typescript-small-correctness",
      created_at: LOCKED,
      held_out: true as const,
      used_for_tuning: false as const,
      strata: { scenario: id, model_version: "model-v1" },
      prompt: `Implement task ${id}.`,
      context: {
        decision: `decision ${id}`,
        rationale: `rationale ${id}`,
        executable_policy: `policy ${id}`,
        causal_incident: `incident ${id}`,
      },
      setup: null,
      evaluator: {
        command: "node",
        args: ["/private/hidden-evaluator.mjs"],
        timeout_ms: 30_000,
        visibility: "hidden_external" as const,
        artifact: "/private/hidden-evaluator.mjs",
        artifact_hash: H("e"),
      },
    })),
  };
}

function exp03Input(registration = prereg("EXP-03"), requiredRelationship?: string): CompileExperimentCaseBankInput {
  return {
    experiment: "EXP-03",
    preregistration_id: registration.id,
    preregistration_hash: registration.content_hash,
    repository_root: process.cwd(),
    base_commit: BASE,
    actor: "human:owner",
    reason: "Fresh held-out evidence cases.",
    cases: Array.from({ length: 6 }, (_, index) => ({
      id: `case-${index + 1}`,
      block: "reviewer-family-block",
      created_at: LOCKED,
      held_out: true as const,
      used_for_tuning: false as const,
      strata: { reviewer: "reviewer", evidence_family: index % 2 ? "failure" : "correction" },
      evidence: `evidence ${index}`,
      ...(requiredRelationship ? { required_relationship: `${requiredRelationship} ${index}` } : {}),
      manual_brief: `manual ${index}`,
      compiler_candidate: `candidate ${index}`,
      proof_card: `proof ${index}`,
      editable_bindings: [`binding ${index}`],
      target_commitment_hash: H(String((index % 9) + 1)),
    })),
  };
}

function fixture() {
  const root = mkdtempSync(join(tmpdir(), "hunch-experiment-"));
  const privateRoot = join(root, "private", ".hunch");
  mkdirSync(join(root, ".hunch"), { recursive: true });
  writeFileSync(join(root, ".hunch/local.json"), JSON.stringify({ privateDir: privateRoot, autoCommit: false, mode: "private" }));
  const store = new HunchStore(hunchPaths(root));
  store.json.ensureDirs();
  return { root, privateRoot, store, repository: new ExperimentRepository(store), cleanup: () => { store.close(); rmSync(root, { recursive: true, force: true }); } };
}

test("fresh case banks fail closed on old, unstratified, mismatched, or mutable inputs", () => {
  const registration = prereg("EXP-01");
  const valid = exp01Input(registration);
  const bank = compileExperimentCaseBank(valid, registration, { now: LOCKED });
  assert.equal(bank.authority, "none");
  assert.equal(bank.data_class, "private");

  const old = structuredClone(valid);
  old.cases[0]!.created_at = "2026-07-10T12:00:00.000Z";
  assert.throws(() => compileExperimentCaseBank(old, registration, { now: LOCKED }), /predates preregistration/i);

  const missing = structuredClone(valid);
  delete missing.cases[0]!.strata.model_version;
  assert.throws(() => compileExperimentCaseBank(missing, registration, { now: LOCKED }), /missing preregistered strata/i);

  const wrongHash = structuredClone(valid);
  wrongHash.preregistration_hash = H("f");
  assert.throws(() => compileExperimentCaseBank(wrongHash, registration, { now: LOCKED }), /exact current preregistration/i);

  const exposed = structuredClone(valid);
  exposed.cases[0]!.used_for_tuning = true as false;
  assert.throws(() => compileExperimentCaseBank(exposed, registration, { now: LOCKED }), /expected false/i);
});

test("EXP-01 assignment is deterministic, crossed, balanced, and treatment-hash bound", () => {
  const registration = prereg("EXP-01");
  const bank = compileExperimentCaseBank(exp01Input(registration), registration, { now: LOCKED });
  const input = {
    sample_per_arm: 2,
    provider: "claude-cli" as const,
    provider_version: "2.1.186",
    model_version: "model-v1",
    max_turns: 20,
    actor: "human:owner",
    reason: "Locked pilot assignment.",
  };
  const first = compileExperimentRun(input, registration, bank, { now: LOCKED });
  const second = compileExperimentRun(input, registration, bank, { now: LOCKED });
  assert.deepEqual(first, second);
  assert.equal(first.assignments.length, 6);
  for (const arm of ["A", "B", "C"]) assert.equal(first.assignments.filter((item) => item.arm === arm).length, 2);
  for (const assignment of first.assignments) assignmentTreatment(bank, first, assignment);
  const armA = first.assignments.find((item) => item.case_id === "one" && item.arm === "A")!;
  const armB = first.assignments.find((item) => item.case_id === "one" && item.arm === "B")!;
  const armC = first.assignments.find((item) => item.case_id === "one" && item.arm === "C")!;
  assert.deepEqual(assignmentTreatment(bank, first, armA), { prompt: "Implement task one.", context: null });
  assert.deepEqual(assignmentTreatment(bank, first, armB), { prompt: "Implement task one.", context: { decision: "decision one", rationale: "rationale one" } });
  assert.match(JSON.stringify(assignmentTreatment(bank, first, armC)), /incident one/);

  assert.throws(() => compileExperimentRun({ ...input, sample_per_arm: 1 }, registration, bank, { now: LOCKED }), /full preregistered target/i);
  const tampered = structuredClone(first);
  tampered.assignments[0]!.treatment_hash = H("f");
  assert.throws(() => assignmentTreatment(bank, tampered, tampered.assignments[0]!), /treatment hash mismatch/i);
});

test("EXP-03 assignment is exclusive, exactly balanced, and reveals only the assigned arm", () => {
  const registration = prereg("EXP-03");
  const bank = compileExperimentCaseBank(exp03Input(registration), registration, { now: LOCKED });
  const run = compileExperimentRun({ sample_per_arm: 2, actor: "human:owner", reason: "Timed review pilot." }, registration, bank, { now: LOCKED });
  assert.equal(run.assignment_strategy, "exclusive_blocked");
  assert.equal(run.assignments.length, 6);
  for (const arm of ["A", "B", "C"]) assert.equal(run.assignments.filter((item) => item.arm === arm).length, 2);
  for (const assignment of run.assignments) {
    const visible = JSON.stringify(assignmentTreatment(bank, run, assignment));
    if (assignment.arm === "A") {
      assert.match(visible, /manual/);
      assert.doesNotMatch(visible, /candidate|proof/);
    } else if (assignment.arm === "B") {
      assert.match(visible, /candidate/);
      assert.doesNotMatch(visible, /proof/);
    } else {
      assert.match(visible, /candidate/);
      assert.match(visible, /proof/);
    }
  }
});

test("EXP-03 revision 2 requires a plain relationship and gives every arm one jargon-free review contract", () => {
  const registration = prereg("EXP-03", 2);
  assert.throws(
    () => compileExperimentCaseBank(exp03Input(registration), registration, { now: LOCKED }),
    /durable required relationship in plain language/i,
  );

  const bank = compileExperimentCaseBank(exp03Input(registration, "The payment action must verify the session before charging"), registration, { now: LOCKED });
  const run = compileExperimentRun({ sample_per_arm: 2, actor: "human:owner", reason: "Fresh plain-language review." }, registration, bank, { now: LOCKED });
  for (const assignment of run.assignments) {
    const treatment = assignmentTreatment(bank, run, assignment) as Record<string, unknown>;
    const review = treatment.review as { required_relationship: string; question: string; choices: Array<{ label: string }>; response_template: unknown };
    assert.match(review.required_relationship, /payment action must verify the session/i);
    assert.equal(review.question, "Does the proposed rule accurately preserve the required relationship described above?");
    assert.deepEqual(review.choices.map((choice) => choice.label), [
      "Yes — use it as written",
      "Yes — after I correct the rule",
      "No — the rule is wrong or unsupported",
      "Cannot decide from this evidence",
    ]);
    assert.ok(review.response_template);
    assert.doesNotMatch(JSON.stringify(review), /\b(?:policy|predicate|selector|binding|IR)\b/i);
  }
});

test("private execution repository is idempotent, tamper-evident, and rejects duplicate runs", () => {
  const { root, privateRoot, repository, cleanup } = fixture();
  try {
    const registration = prereg("EXP-01");
    const bank = repository.putCaseBank(compileExperimentCaseBank(exp01Input(registration), registration, { now: LOCKED }));
    const run = repository.putRun(compileExperimentRun({
      sample_per_arm: 2,
      provider: "claude-cli",
      provider_version: "2.1.186",
      model_version: "model-v1",
      max_turns: 20,
      actor: "human:owner",
      reason: "Locked pilot.",
    }, registration, bank, { now: LOCKED }));
    assert.equal(repository.putRun(run).id, run.id);
    assert.throws(() => readFileSync(join(root, ".hunch/experiment-runs", `${run.id}.json`), "utf8"));
    assert.match(readFileSync(join(privateRoot, "experiment-runs", `${run.id}.json`), "utf8"), new RegExp(run.id));

    const other = compileExperimentRun({
      sample_per_arm: 2,
      provider: "codex-cli",
      provider_version: "codex-cli 1",
      model_version: "model-v1",
      max_turns: 20,
      actor: "human:owner",
      reason: "Conflicting run.",
    }, registration, bank, { now: "2026-07-12T12:01:00.000Z" });
    assert.throws(() => repository.putRun(other), /already has immutable run/i);

    const file = join(privateRoot, "experiment-case-banks", `${bank.id}.json`);
    const raw = JSON.parse(readFileSync(file, "utf8"));
    raw.reason = "tampered";
    writeFileSync(file, JSON.stringify(raw));
    assert.throws(() => repository.listCaseBanks(), /content hash mismatch/i);
  } finally {
    cleanup();
  }
});

function completedExp01(run: ReturnType<typeof compileExperimentRun>, assignmentId: string, violation: boolean, now: string, supersedes: string | null = null): ExperimentOutcome {
  return compileExperimentOutcome({
    run_id: run.id,
    assignment_id: assignmentId,
    status: "completed",
    invocation_started: true,
    metrics: {
      valid_completion: true,
      policy_violation: violation,
      task_success: true,
      build_success: true,
      unknown_or_error: false,
      refusal: false,
      turns: 3,
      edits: 2,
      tokens: 100,
      latency_ms: 500,
    },
    output_hash: H("1"),
    diff_hash: H("2"),
    evaluator_hash: H("3"),
    error_code: null,
    incidents: { confirmed_private_leak: false, data_loss_or_corruption: false, unsafe_evaluator_behavior: false },
    recorder: "runner:test",
    reason: supersedes ? "Correct a misclassified locked evaluator result." : "Locked evaluator result.",
    supersedes,
  }, run, { now });
}

test("outcomes retain missing denominators and reject silent overwrite or branched correction", () => {
  const registration = prereg("EXP-01");
  const bank = compileExperimentCaseBank(exp01Input(registration), registration, { now: LOCKED });
  const run = compileExperimentRun({ sample_per_arm: 2, provider: "claude-cli", provider_version: "v", model_version: "m", max_turns: 2, actor: "human:o", reason: "run" }, registration, bank, { now: LOCKED });
  const original = completedExp01(run, run.assignments[0]!.id, true, "2026-07-12T13:00:00.000Z");
  const correction = completedExp01(run, run.assignments[0]!.id, false, "2026-07-12T14:00:00.000Z", original.id);
  assert.deepEqual(currentExperimentOutcomes([original, correction]), [correction]);
  const branch = completedExp01(run, run.assignments[0]!.id, true, "2026-07-12T15:00:00.000Z", original.id);
  assert.throws(() => currentExperimentOutcomes([original, correction, branch]), /branched supersession/i);
  const report = buildExperimentReport(run, bank, [original, correction], []);
  assert.equal(report.terminal, 1);
  assert.equal(report.unresolved.length, 5);
  assert.equal(report.claim_allowed, false);
  assert.match(report.deviations.join("\n"), /corrected outcome/i);
});

test("EXP-03 review clock and seven-day follow-up are bound to exact immutable records", () => {
  const registration = prereg("EXP-03");
  const bank = compileExperimentCaseBank(exp03Input(registration), registration, { now: LOCKED });
  const run = compileExperimentRun({ sample_per_arm: 2, actor: "human:owner", reason: "Timed review." }, registration, bank, { now: LOCKED });
  const assignment = run.assignments[0]!;
  const start = compileExperimentReviewStart(run, assignment, "human:reviewer", { now: "2026-07-12T13:00:00.000Z" });
  assert.equal(start.treatment_hash, assignment.treatment_hash);
  const outcome = compileExperimentOutcome({
    run_id: run.id,
    assignment_id: assignment.id,
    status: "completed",
    invocation_started: true,
    metrics: {
      decision: "accepted_precise",
      precise: true,
      proof_inspected: assignment.arm === "C",
      result_hash: H("9"),
      semantic_edit_distance: 0,
      silent_semantic_substitution: false,
      rejection_reason: null,
      duration_ms: 60_000,
    },
    output_hash: H("4"),
    diff_hash: null,
    evaluator_hash: start.treatment_hash,
    error_code: null,
    incidents: { confirmed_private_leak: false, data_loss_or_corruption: false, unsafe_evaluator_behavior: false },
    recorder: "human:reviewer",
    reason: "Exact assigned treatment reviewed.",
    supersedes: null,
  }, run, { now: "2026-07-12T13:01:00.000Z" });
  assert.throws(() => compileExperimentFollowup({ reviewer: "human:reviewer", reversed: false, missing_reason: null, notes: "Too early.", supersedes: null }, run, outcome, { now: "2026-07-18T13:01:00.000Z" }), /seven full days/i);
  const followup = compileExperimentFollowup({ reviewer: "human:reviewer", reversed: false, missing_reason: null, notes: "Policy remained accepted after seven days.", supersedes: null }, run, outcome, { now: "2026-07-19T13:01:00.000Z" });
  const report = buildExperimentReport(run, bank, [outcome], [followup]);
  assert.equal(report.arms.find((item) => item.arm === assignment.arm)!.reversals, 0);
  assert.equal(report.arms.find((item) => item.arm === assignment.arm)!.bootstrap_95?.length, 2);
  assert.equal(report.strata.some((cell) => cell.key === "reviewer" && cell.value === "reviewer"), true);
  assert.equal(report.status, "running");
  assert.equal(report.guardrails.silent_semantic_substitutions, 0);
});

test("EXP-03 service derives duration and proposal edit distance instead of trusting reviewer numbers", () => {
  const { root, store, repository, cleanup } = fixture();
  try {
    const registration = new G3EvidenceRepository(store).putExperiment(prereg("EXP-03"));
    const service = new ConstitutionService(store, root);
    const input = exp03Input(registration);
    const validated = service.validateExperimentCaseBank(input, { now: LOCKED });
    assert.equal(repository.listCaseBanks().length, 0, "read-only validation writes no case-bank record");
    const bank = service.lockExperimentCaseBank(input, { now: LOCKED });
    assert.equal(bank.id, validated.id);
    const run = repository.putRun(compileExperimentRun({ sample_per_arm: 2, actor: "human:owner", reason: "Timed review." }, registration, bank, { now: LOCKED }));
    const next = service.nextExperimentReview(run.id, "human:reviewer", { now: "2026-07-12T13:00:00.000Z" });
    const assignedCase = bank.cases.find((item) => item.id === next.assignment.case_id)!;
    assert.equal("compiler_candidate" in assignedCase, true);
    const result = "compiler_candidate" in assignedCase ? `${assignedCase.compiler_candidate} with a reviewed edit` : "";
    const outcome = service.submitExperimentReview(run.id, next.assignment.id, {
      reviewer: "human:reviewer",
      decision: "accepted_edited",
      precise: true,
      proof_inspected: next.assignment.arm === "C",
      result,
      silent_semantic_substitution: false,
      rejection_reason: null,
      confirmed_private_leak: false,
      data_loss_or_corruption: false,
      unsafe_evaluator_behavior: false,
      reason: "Reviewed the assigned treatment and accepted an exact edited result.",
    }, { now: "2026-07-12T13:01:00.000Z" });
    assert.equal(outcome.metrics && "decision" in outcome.metrics && outcome.metrics.duration_ms, 60_000);
    if (next.assignment.arm === "A") assert.equal(outcome.metrics && "decision" in outcome.metrics && outcome.metrics.semantic_edit_distance, null);
    else assert.equal(!!(outcome.metrics && "decision" in outcome.metrics && outcome.metrics.semantic_edit_distance && outcome.metrics.semantic_edit_distance > 0), true);
  } finally {
    cleanup();
  }
});

test("a recorded privacy, corruption, semantic, or evaluator incident independently stops the report", () => {
  const registration = prereg("EXP-01");
  const bank = compileExperimentCaseBank(exp01Input(registration), registration, { now: LOCKED });
  const run = compileExperimentRun({ sample_per_arm: 2, provider: "claude-cli", provider_version: "v", model_version: "m", max_turns: 2, actor: "human:o", reason: "run" }, registration, bank, { now: LOCKED });
  const assignment = run.assignments[0]!;
  const outcome = compileExperimentOutcome({
    run_id: run.id,
    assignment_id: assignment.id,
    status: "invalid_completion",
    invocation_started: true,
    metrics: null,
    output_hash: H("5"),
    diff_hash: H("6"),
    evaluator_hash: H("7"),
    error_code: "privacy-incident",
    incidents: { confirmed_private_leak: true, data_loss_or_corruption: false, unsafe_evaluator_behavior: false },
    recorder: "runner:test",
    reason: "Confirmed leak forces an independent stop.",
    supersedes: null,
  }, run, { now: LOCKED });
  const report = buildExperimentReport(run, bank, [outcome], []);
  assert.equal(report.status, "guardrail_stopped");
  assert.equal(report.guardrails.confirmed_private_leaks, 1);
  assert.equal(report.claim_allowed, false);
});

test("an independently evidenced provider-wide inability irreversibly stops a run without efficacy peeking", () => {
  const registration = prereg("EXP-01");
  const bank = compileExperimentCaseBank(exp01Input(registration), registration, { now: LOCKED });
  const run = compileExperimentRun({ sample_per_arm: 2, provider: "claude-cli", provider_version: "v", model_version: "m", max_turns: 2, actor: "human:o", reason: "run" }, registration, bank, { now: LOCKED });
  const stop = compileExperimentStop({
    category: "provider_wide_unavailability",
    actor: "human:owner",
    reason: "Provider is independently unavailable; no outcome was inspected.",
    evidence_hashes: [H("8")],
  }, run, { now: LOCKED });
  const report = buildExperimentReport(run, bank, [], [], [stop]);
  assert.equal(report.status, "guardrail_stopped");
  assert.deepEqual(report.stop_receipts, [stop]);
  assert.equal(report.terminal, 0);
});

test("non-completed assignments cannot fabricate primary metrics", () => {
  const registration = prereg("EXP-01");
  const bank: ExperimentCaseBank = compileExperimentCaseBank(exp01Input(registration), registration, { now: LOCKED });
  const run = compileExperimentRun({ sample_per_arm: 2, provider: "claude-cli", provider_version: "v", model_version: "m", max_turns: 2, actor: "human:o", reason: "run" }, registration, bank, { now: LOCKED });
  assert.throws(() => compileExperimentOutcome({
    run_id: run.id,
    assignment_id: run.assignments[0]!.id,
    status: "infrastructure_failure",
    invocation_started: false,
    metrics: {
      valid_completion: true,
      policy_violation: false,
      task_success: true,
      build_success: true,
      unknown_or_error: false,
      refusal: false,
      turns: 0,
      edits: 0,
      tokens: 0,
      latency_ms: 0,
    },
    output_hash: null,
    diff_hash: null,
    evaluator_hash: null,
    error_code: "setup-failed",
    incidents: { confirmed_private_leak: false, data_loss_or_corruption: false, unsafe_evaluator_behavior: false },
    recorder: "runner:test",
    reason: "Setup failed.",
    supersedes: null,
  }, run, { now: LOCKED }), /non-completed outcomes cannot claim primary metrics/i);
});

test("EXP-01 runner uses a fresh worktree, strips ambient instructions, and scores only with a hidden external evaluator", { skip: process.platform === "win32" }, () => {
  const session = mkdtempSync(join(tmpdir(), "hunch-exp01-runner-test-"));
  const source = join(session, "source");
  const bin = join(session, "bin");
  const setup = join(session, "setup.mjs");
  const evaluator = join(session, "hidden-evaluator.mjs");
  mkdirSync(source, { recursive: true });
  mkdirSync(bin, { recursive: true });
  writeFileSync(join(source, "README.md"), "fixture\n");
  writeFileSync(join(source, "AGENTS.md"), "AMBIENT HUNCH CONTEXT THAT MUST NOT REACH THE MODEL\n");
  execFileSync("git", ["init", "-q"], { cwd: source });
  execFileSync("git", ["config", "user.email", "test@example.com"], { cwd: source });
  execFileSync("git", ["config", "user.name", "Test"], { cwd: source });
  execFileSync("git", ["add", "."], { cwd: source });
  execFileSync("git", ["commit", "-qm", "fixture"], { cwd: source });
  const base = execFileSync("git", ["rev-parse", "HEAD"], { cwd: source, encoding: "utf8" }).trim();
  const fake = join(bin, "codex");
  writeFileSync(fake, `#!/usr/bin/env node
import { readFileSync, writeFileSync } from "node:fs";
const args = process.argv.slice(2);
if (args.includes("--version")) { console.log("codex-cli fake-v1"); process.exit(0); }
const prompt = readFileSync(0, "utf8");
if (prompt.includes("AMBIENT HUNCH CONTEXT")) process.exit(17);
writeFileSync("solution.txt", "done\\n");
console.log(JSON.stringify({type:"turn.completed", usage:{input_tokens:10,output_tokens:5}}));
`);
  chmodSync(fake, 0o755);
  const setupSource = "// deterministic external setup\n";
  writeFileSync(setup, setupSource);
  const successfulEvaluator = `import { existsSync } from "node:fs";
console.log(JSON.stringify({valid_completion:existsSync("solution.txt"),policy_violation:false,task_success:true,build_success:true,unknown_or_error:false,refusal:false,confirmed_private_leak:false,data_loss_or_corruption:false,unsafe_evaluator_behavior:false}));
`;
  writeFileSync(evaluator, successfulEvaluator);
  const oldPath = process.env.PATH;
  process.env.PATH = `${bin}:${oldPath ?? ""}`;
  const { repository, cleanup } = fixture();
  try {
    const registration = prereg("EXP-01");
    const input = exp01Input(registration);
    input.repository_root = source;
    input.base_commit = base;
    for (const item of input.cases) {
      if (!("evaluator" in item)) continue;
      item.setup = {
        command: process.execPath,
        args: [setup],
        timeout_ms: 30_000,
        artifact: setup,
        artifact_hash: `sha1:${createHash("sha1").update(readFileSync(setup)).digest("hex")}`,
      };
      item.evaluator = {
        command: process.execPath,
        args: [evaluator],
        timeout_ms: 30_000,
        visibility: "hidden_external",
        artifact: evaluator,
        artifact_hash: `sha1:${createHash("sha1").update(readFileSync(evaluator)).digest("hex")}`,
      };
    }
    const bank = repository.putCaseBank(compileExperimentCaseBank(input, registration, { now: LOCKED }));
    const run = repository.putRun(compileExperimentRun({
      sample_per_arm: 2,
      provider: "codex-cli",
      provider_version: "codex-cli fake-v1",
      model_version: "fake-model",
      max_turns: 4,
      actor: "human:owner",
      reason: "Executable isolated runner fixture.",
    }, registration, bank, { now: LOCKED }));
    const outcome = executeExp01Assignment(repository, run, bank, run.assignments[0]!, { now: "2026-07-12T13:00:00.000Z" });
    assert.equal(outcome.status, "completed");
    assert.equal(outcome.invocation_started, true);
    assert.equal(outcome.incidents.confirmed_private_leak, false);
    assert.equal(outcome.metrics && "valid_completion" in outcome.metrics && outcome.metrics.valid_completion, true);
    assert.equal(existsSync(join(source, "solution.txt")), false, "source repository remains untouched");

    writeFileSync(evaluator, `console.log(JSON.stringify({valid_completion:false,policy_violation:null,task_success:false,build_success:true,unknown_or_error:false,refusal:false,confirmed_private_leak:false,data_loss_or_corruption:false,unsafe_evaluator_behavior:false}));\n`);
    const invalidCase = bank.cases.find((item) => item.id === run.assignments[1]!.case_id)!;
    if (!("evaluator" in invalidCase)) throw new Error("expected EXP-01 case");
    invalidCase.evaluator.artifact_hash = `sha1:${createHash("sha1").update(readFileSync(evaluator)).digest("hex")}`;
    const invalid = executeExp01Assignment(repository, run, bank, run.assignments[1]!, { now: "2026-07-12T13:00:30.000Z" });
    assert.equal(invalid.status, "invalid_completion");
    assert.equal(invalid.error_code, "invalid-completion");
    assert.deepEqual(invalid.incidents, { confirmed_private_leak: false, data_loss_or_corruption: false, unsafe_evaluator_behavior: false });

    writeFileSync(evaluator, successfulEvaluator);
    invalidCase.evaluator.artifact_hash = `sha1:${createHash("sha1").update(readFileSync(evaluator)).digest("hex")}`;
    writeFileSync(setup, `${setupSource}// drift after lock\n`);
    const setupDrifted = executeExp01Assignment(repository, run, bank, run.assignments[2]!, { now: "2026-07-12T13:01:00.000Z" });
    assert.equal(setupDrifted.status, "infrastructure_failure");
    assert.equal(setupDrifted.invocation_started, false);
    assert.equal(setupDrifted.error_code, "setup-artifact-drift");
    writeFileSync(setup, setupSource);
    writeFileSync(evaluator, `${readFileSync(evaluator, "utf8")}\n// drift after lock\n`);
    const drifted = executeExp01Assignment(repository, run, bank, run.assignments[3]!, { now: "2026-07-12T13:02:00.000Z" });
    assert.equal(drifted.status, "infrastructure_failure");
    assert.equal(drifted.invocation_started, false);
    assert.equal(drifted.error_code, "evaluator-artifact-drift");
  } finally {
    process.env.PATH = oldPath;
    cleanup();
    rmSync(session, { recursive: true, force: true });
  }
});
