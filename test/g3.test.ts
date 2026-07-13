import { test } from "node:test";
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StdioClientTransport } from "@modelcontextprotocol/sdk/client/stdio.js";
import { HunchStore } from "../src/store/hunchStore.js";
import { hunchPaths } from "../src/core/paths.js";
import type { G2ReadinessReport } from "../src/constitution/g2.js";
import {
  G3EvidenceRepository,
  compileAdapterConformanceReceipt,
  compileExperimentPreregistration,
  compileG3Plan,
  compileProofReviewMeasurement,
  currentExperimentPreregistrations,
  currentG3Plans,
  currentProofReviewMeasurements,
  scoreG3Readiness,
  type CompileExperimentPreregistrationInput,
  type G3PolicyEvidence,
} from "../src/constitution/g3.js";
import { executeG3AdapterConformance } from "../src/constitution/g3Conformance.js";

const NOW = "2026-07-11T12:00:00.000Z";
const H = (character: string): string => `sha1:${character.repeat(40)}`;
const POLICIES = ["pol_0000000001", "pol_0000000002", "pol_0000000003"];

function experiment(experiment: "EXP-01" | "EXP-03", supersedes: string | null = null, revision = 1): CompileExperimentPreregistrationInput {
  const unit = experiment === "EXP-01" ? "task" as const : "policy_candidate" as const;
  return {
    experiment,
    revision,
    hypothesis: `${experiment} changes the preregistered primary outcome.`,
    primary_metric: experiment === "EXP-01" ? "policy violation rate among valid task completions" : "accepted precise policies per reviewer hour",
    secondary_metrics: ["task success", "review duration"],
    unit,
    arms: [
      { id: "A", description: "Control workflow." },
      { id: "B", description: "Treatment workflow." },
    ],
    assignment: { method: "blocked_randomized", unit, seed: `${experiment}-seed-v1` },
    strata: ["scenario", "repository"],
    inclusion: ["case meets the documented supported boundary"],
    exclusion: ["environment cannot execute the deterministic evaluator"],
    sample_plan: { minimum_per_arm: 30, target_per_arm: 30, maximum_total: 60, rationale: "Pilot floor from the Constitution experiment protocol." },
    analysis_plan: {
      primary_estimator: "raw outcome by arm",
      effect_size: "absolute risk difference or rate difference",
      uncertainty: "Wilson or bootstrap 95% interval as appropriate",
      missing_data: "report raw missing denominator and do not silently exclude",
      multiple_metrics: "one primary metric; secondary metrics descriptive",
    },
    stopping_rule: "Stop at the fixed sample cap or immediately for a privacy or data-loss guardrail.",
    guardrails: ["zero confirmed private leaks", "no data loss", "unknown/error remains visible"],
    actor: "human:experiment-owner",
    reason: "Preregister before assigning or running samples.",
    supersedes,
  };
}

function eligibleG2(): G2ReadinessReport {
  return {
    id: "g2readiness_0000000000",
    content_hash: H("a"),
    gate: "G2",
    manifest: null,
    policy_evidence: [],
    runbook_evidence: [],
    active_blocking_policy_ids: [],
    blockers: [],
    recommendation: "eligible_for_human_g2_signoff",
    authority: "none",
    g2_passed: false,
  };
}

function fixture() {
  const root = mkdtempSync(join(tmpdir(), "hunch-g3-"));
  const privateRoot = join(root, "private", ".hunch");
  mkdirSync(join(root, ".hunch"), { recursive: true });
  writeFileSync(join(root, ".hunch/local.json"), JSON.stringify({ privateDir: privateRoot, autoCommit: false, mode: "private" }));
  const store = new HunchStore(hunchPaths(root));
  store.json.ensureDirs();
  const repository = new G3EvidenceRepository(store);
  return { root, privateRoot, store, repository, cleanup: () => { store.close(); rmSync(root, { recursive: true, force: true }); } };
}

test("G3 evidence is human-selected, immutable, content-addressed, and branch-protected", () => {
  const retrieval = compileExperimentPreregistration(experiment("EXP-01"), { now: NOW });
  const compiler = compileExperimentPreregistration(experiment("EXP-03"), { now: NOW });
  const plan = compileG3Plan({
    g2_readiness_hash: H("a"),
    policy_ids: POLICIES,
    clients: ["cli", "mcp", "ci"],
    experiments: { retrieval: retrieval.id, compiler: compiler.id },
    actor: "human:release-owner",
    reason: "Select exact private advisory evidence.",
  }, { now: NOW });
  assert.equal(plan.authority, "none");
  assert.equal(plan.data_class, "private");
  assert.deepEqual(currentG3Plans([plan]), [plan]);
  assert.throws(() => compileG3Plan({
    g2_readiness_hash: H("a"), policy_ids: POLICIES, clients: ["cli", "mcp"],
    experiments: plan.experiments, actor: "human:release-owner", reason: "Too few clients.",
  }, { now: NOW }), /at least 3/i);
  assert.throws(() => compileG3Plan({
    g2_readiness_hash: H("a"), policy_ids: POLICIES, clients: ["cli", "mcp", "ci"],
    experiments: plan.experiments, actor: "model:auto", reason: "Machine-selected.",
  }, { now: NOW }), /human actor/i);

  const correctedExperiment = compileExperimentPreregistration(experiment("EXP-01", retrieval.id, 2), { now: "2026-07-11T12:01:00.000Z" });
  assert.deepEqual(currentExperimentPreregistrations([retrieval, compiler, correctedExperiment]).map((item) => item.id).sort(), [compiler.id, correctedExperiment.id].sort());
  const branch = compileExperimentPreregistration({ ...experiment("EXP-01", retrieval.id, 2), reason: "Conflicting correction." }, { now: "2026-07-11T12:02:00.000Z" });
  assert.throws(() => currentExperimentPreregistrations([retrieval, correctedExperiment, branch]), /branched supersession/i);

  const review = compileProofReviewMeasurement({
    plan_id: plan.id,
    policy_id: POLICIES[0]!,
    policy_hash: H("b"),
    proof_id: "proof_example",
    proof_hash: H("c"),
    card_hash: H("d"),
    reviewer: "human:reviewer",
    duration_ms: 120_000,
    comprehension: { requirement: "correct", limitations: "correct", authority: "correct" },
    notes: "Reviewer identified the invariant, limitations, and lack of automatic authority.",
  }, { now: NOW });
  const retraction = compileProofReviewMeasurement({
    ...review,
    duration_ms: 180_000,
    comprehension: { requirement: "incorrect", limitations: "correct", authority: "correct" },
    notes: "Correction: requirement answer was scored incorrectly.",
    supersedes: review.id,
  }, { now: "2026-07-11T12:03:00.000Z" });
  assert.deepEqual(currentProofReviewMeasurements([review, retraction]), [retraction]);
});

test("G3 readiness is fail-closed, scorecard-bound, and never signs itself off", () => {
  const retrieval = compileExperimentPreregistration(experiment("EXP-01"), { now: NOW });
  const compiler = compileExperimentPreregistration(experiment("EXP-03"), { now: NOW });
  const plan = compileG3Plan({
    g2_readiness_hash: H("a"), policy_ids: POLICIES, clients: ["cli", "mcp", "ci"],
    experiments: { retrieval: retrieval.id, compiler: compiler.id }, actor: "human:release-owner", reason: "Exact G3 packet.",
  }, { now: NOW });
  const policyEvidence: G3PolicyEvidence[] = POLICIES.map((policy_id, index) => ({
    policy_id,
    state: "active_advisory",
    authority_kind: "human",
    proof_current: true,
    card_hash: H(String(index + 1)),
    review_id: `proofreview_${String(index + 1).padStart(10, "0")}`,
    review_duration_ms: 240_000,
    comprehension_correct: true,
    reasons: [],
  }));
  const conformance = compileAdapterConformanceReceipt({
    plan_id: plan.id,
    clients: plan.clients,
    test: { file: "test/behavior-workspace.test.ts", name: "adapter contract", source_hash: H("e") },
    runner: { name: "node-test-tsx", isolation_flag: "--test-isolation=none" },
    result: "passed",
    exit_code: 0,
    selected_event: "passed",
    verdict_agreement: 1,
    confirmed_private_leaks: 0,
    log_hash: H("f"),
    supersedes: null,
  }, { now: NOW });
  const experiments = [
    { experiment: "EXP-01" as const, id: retrieval.id, content_hash: retrieval.content_hash, current: true, reasons: [] },
    { experiment: "EXP-03" as const, id: compiler.id, content_hash: compiler.content_hash, current: true, reasons: [] },
  ];
  const ready = scoreG3Readiness({ manifest: plan, g2_readiness: eligibleG2(), policy_evidence: policyEvidence, experiments, conformance, active_blocking_policy_ids: [] });
  assert.equal(ready.recommendation, "eligible_for_human_g3_signoff");
  assert.equal(ready.scorecard.overall, "green");
  assert.equal(ready.authority, "none");
  assert.equal(ready.g3_passed, false);

  const retracted = scoreG3Readiness({
    manifest: plan,
    g2_readiness: eligibleG2(),
    policy_evidence: policyEvidence.map((item, index) => index ? item : { ...item, comprehension_correct: false }),
    experiments,
    conformance,
    active_blocking_policy_ids: [],
  });
  assert.equal(retracted.recommendation, "not_ready");
  assert.equal(retracted.scorecard.proof_comprehension.band, "red");
  assert.match(retracted.blockers.join("\n"), /comprehension/i);

  const blocked = scoreG3Readiness({ manifest: plan, g2_readiness: eligibleG2(), policy_evidence: policyEvidence, experiments, conformance, active_blocking_policy_ids: [POLICIES[0]!] });
  assert.equal(blocked.recommendation, "not_ready");
  assert.match(blocked.blockers.join("\n"), /blocking behavior/i);
});

test("G3 repository isolates private records and rejects tampering", () => {
  const { root, privateRoot, repository, cleanup } = fixture();
  try {
    const retrieval = repository.putExperiment(compileExperimentPreregistration(experiment("EXP-01"), { now: NOW }));
    const compiler = repository.putExperiment(compileExperimentPreregistration(experiment("EXP-03"), { now: NOW }));
    const plan = repository.putPlan(compileG3Plan({
      g2_readiness_hash: H("a"), policy_ids: POLICIES, clients: ["cli", "mcp", "ci"],
      experiments: { retrieval: retrieval.id, compiler: compiler.id }, actor: "human:release-owner", reason: "Private only.",
    }, { now: NOW }));
    assert.equal(repository.putPlan(plan).id, plan.id, "exact retry is idempotent");
    assert.equal(readFileSync(join(privateRoot, "gates", `${plan.id}.json`), "utf8").includes(plan.id), true);
    assert.throws(() => readFileSync(join(root, ".hunch/gates", `${plan.id}.json`), "utf8"));

    const file = join(privateRoot, "experiments", `${retrieval.id}.json`);
    const tampered = JSON.parse(readFileSync(file, "utf8"));
    tampered.hypothesis = "tampered";
    writeFileSync(file, JSON.stringify(tampered));
    assert.throws(() => repository.listExperiments(), /content hash mismatch/i);
  } finally {
    cleanup();
  }
});

test("CLI and read-only client-neutral MCP expose the identical fail-closed G3 receipt", async () => {
  const { root, cleanup } = fixture();
  const tsx = join(process.cwd(), "node_modules/tsx/dist/cli.mjs");
  const cli = join(process.cwd(), "src/cli/index.ts");
  const env = { ...process.env, HUNCH_SYNTH_PROVIDER: "deterministic", NO_COLOR: "1" };
  let client: Client | null = null;
  try {
    const cliRun = spawnSync(process.execPath, [tsx, cli, "constitution", "g3"], { cwd: root, env, encoding: "utf8" });
    assert.equal(cliRun.status, 0, cliRun.stderr);
    const cliReceipt = JSON.parse(cliRun.stdout) as { content_hash: string; recommendation: string; authority: string; g3_passed: boolean };
    assert.equal(cliReceipt.recommendation, "not_ready");
    assert.equal(cliReceipt.authority, "none");
    assert.equal(cliReceipt.g3_passed, false);

    const strictRun = spawnSync(process.execPath, [tsx, cli, "constitution", "g3", "--strict"], { cwd: root, env, encoding: "utf8" });
    assert.equal(strictRun.status, 1, "strict readiness fails closed without human-selected evidence");

    const transport = new StdioClientTransport({ command: process.execPath, args: [tsx, cli, "mcp"], cwd: root, env });
    client = new Client({ name: "g3-readiness-contract-test", version: "1.0.0" });
    await client.connect(transport);
    const call = await client.callTool({ name: "hunch_constitution_g3_readiness", arguments: {} });
    const mcpReceipt = JSON.parse((call.content[0] as { type: "text"; text: string }).text) as { content_hash: string };
    assert.equal(mcpReceipt.content_hash, cliReceipt.content_hash);
  } finally {
    if (client) await client.close();
    cleanup();
  }
});

test("G3 adapter conformance executes the real CLI/MCP/CI fixture and rejects unsupported client profiles", () => {
  const retrieval = compileExperimentPreregistration(experiment("EXP-01"), { now: NOW });
  const compiler = compileExperimentPreregistration(experiment("EXP-03"), { now: NOW });
  const plan = compileG3Plan({
    g2_readiness_hash: H("a"), policy_ids: POLICIES, clients: ["cli", "mcp", "ci"],
    experiments: { retrieval: retrieval.id, compiler: compiler.id }, actor: "human:release-owner", reason: "Execute the selected conformance profile.",
  }, { now: NOW });
  const receipt = executeG3AdapterConformance(process.cwd(), plan, { now: NOW });
  assert.equal(receipt.result, "passed");
  assert.equal(receipt.verdict_agreement, 1);
  assert.equal(receipt.confirmed_private_leaks, 0);
  assert.equal(receipt.authority, "none");

  const unsupported = compileG3Plan({
    ...plan,
    clients: ["cli", "mcp", "vscode"],
    actor: "human:release-owner",
    reason: "Select a profile with no executable certification yet.",
  }, { now: NOW });
  const unsupportedReceipt = executeG3AdapterConformance(process.cwd(), unsupported, { now: NOW });
  assert.equal(unsupportedReceipt.result, "error");
  assert.equal(unsupportedReceipt.error_code, "unsupported-client-profile");
  assert.equal(unsupportedReceipt.verdict_agreement, null);
  assert.equal(unsupportedReceipt.confirmed_private_leaks, null);

  // The four-client profile IS certified: its fixture executes the extension's
  // real spawn seam and asserts receipt equality across all four surfaces.
  const vscodeProfile = compileG3Plan({
    ...plan,
    clients: ["ci", "cli", "mcp", "vscode"],
    actor: "human:release-owner",
    reason: "Execute the four-client conformance profile including the VS Code seam.",
  }, { now: NOW });
  const vscodeReceipt = executeG3AdapterConformance(process.cwd(), vscodeProfile, { now: NOW });
  assert.equal(vscodeReceipt.result, "passed", vscodeReceipt.error_code ?? "");
  assert.equal(vscodeReceipt.verdict_agreement, 1);
  assert.equal(vscodeReceipt.confirmed_private_leaks, 0);
  assert.match(vscodeReceipt.test.name, /VS Code seam/);
  assert.equal(vscodeReceipt.authority, "none");
});
