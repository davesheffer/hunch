import assert from "node:assert/strict";
import { test } from "node:test";
import { existsSync, mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { cleanupDir } from "./fixtures.js";
import {
  auditExecutableProbeContractAxes,
  armExecutionObligations,
  beforeEditProbeVerdict,
  classifyDomains,
  compileAdaptiveContractAxisProbeClosure,
  compileContractAxisProbeClosure,
  compileContractAxisRiskHint,
  inferContractAxisRiskHint,
  inferIssueImplementationOwner,
  rankIssueImplementationOwners,
  compileExecutableProbes,
  discoverExecutableProbeContractAxes,
  emptyState,
  environmentExecutableProbes,
  environmentExecutionObligations,
  executionObligationBrief,
  isProductPath,
  loadPipelineState,
  onCommand,
  onEdit,
  onPrompt,
  onSkill,
  normalizeExecutableProbes,
  pendingExecutionObligations,
  proofCheckpoint,
  savePipelineState,
  stopVerdict,
  type ExecutionObligation,
  unverifiedNag,
} from "../src/core/pipeline.js";

const controllerPlan = [
  {
    id: "episode:inspect:abcdef1",
    origin: "episode" as const,
    category: "evidence" as const,
    phase: "session" as const,
    description: "Inspect the proven historical change.",
    command_alternatives: [["git", "show", "abcdef1"]],
    expected: { success: true, output_includes: ["abcdef1"] },
  },
  {
    id: "episode:runtime:preprocess",
    origin: "episode" as const,
    category: "behavior" as const,
    phase: "after-edit" as const,
    description: "Exercise preprocess behavior after the latest edit.",
    command_alternatives: [["vitest", "preprocess.test.ts"]],
    expected: { success: true, output_includes: ["passed"], output_excludes: ["failed"] },
  },
];

const executableProbePlan = [{
  id: "episode:probe:optional-preprocess",
  origin: "episode" as const,
  category: "behavior" as const,
  claim: "An inner optional schema must make an absent object property acceptable through preprocess.",
  falsifier: "Reject the fix if the outer form passes but the inner optional form still fails.",
  command: "npx tsx --conditions @zod/source -e 'run HUNCH_PROBE optional-preprocess'",
  command_alternatives: [["tsx", "HUNCH_PROBE", "optional-preprocess"]],
  expected_before: { success: false, output_includes: ["inner=false"] },
  expected_after: { success: true, output_includes: ["inner=true"], output_excludes: ["inner=false"] },
}];

test("isProductPath: docs, .claude and .hunch are not gated", () => {
  assert.equal(isProductPath("README.md"), false);
  assert.equal(isProductPath("docs/notes.mdx"), false);
  assert.equal(isProductPath(".claude/skills/x/SKILL.md"), false);
  assert.equal(isProductPath(".hunch/decisions/d.json"), false);
  assert.equal(isProductPath("src/core/pipeline.ts"), true);
  assert.equal(isProductPath("packages\\zod\\src\\v4\\core\\util.ts"), true);
});

test("classifyDomains: paths activate the right profiles", () => {
  assert.ok(classifyDomains("src/store/db.ts").includes("backend"));
  assert.ok(classifyDomains("site/components/Nav.tsx").includes("frontend"));
  assert.ok(classifyDomains("test/check.test.ts").includes("tests"));
  assert.ok(classifyDomains(".github/workflows/ci.yml").includes("infra"));
});

test("edit marks unverified; matching command after edit re-verifies", () => {
  let st = onEdit(emptyState(), "src/core/topics.ts");
  assert.equal(st.verifyAfterEdit, false);
  assert.deepEqual(st.editedFiles, ["src/core/topics.ts"]);
  st = onCommand(st, "npx tsx --test test/topics.test.ts");
  assert.equal(st.verifyAfterEdit, true);
});

test("verify-shaped command BEFORE any edit does not pre-satisfy the gate", () => {
  let st = onCommand(emptyState(), "npm test");
  st = onEdit(st, "src/core/topics.ts");
  assert.equal(st.verifyAfterEdit, false);
});

test("non-verify command does not satisfy the gate", () => {
  let st = onEdit(emptyState(), "src/core/topics.ts");
  st = onCommand(st, "git status");
  assert.equal(st.verifyAfterEdit, false);
});

test("bespoke node -e / node --test checks count as verification", () => {
  let st = onEdit(emptyState(), "src/core/topics.ts");
  st = onCommand(st, 'node -e "assert(require(\'./x\'))"');
  assert.equal(st.verifyAfterEdit, true);
  let st2 = onEdit(emptyState(), "src/core/topics.ts");
  st2 = onCommand(st2, "node --test test/");
  assert.equal(st2.verifyAfterEdit, true);
});

test("a command naming an edited file counts as verification", () => {
  let st = onEdit(emptyState(), "site/changelog.html");
  st = onCommand(st, "htmlhint site/changelog.html");
  assert.equal(st.verifyAfterEdit, true);
  // ...but a command naming an unrelated file does not
  let st2 = onEdit(emptyState(), "site/changelog.html");
  st2 = onCommand(st2, "cat README.md");
  assert.equal(st2.verifyAfterEdit, false);
});

test("doc-only edits never arm the gate", () => {
  const st = onEdit(emptyState(), "README.md");
  assert.equal(st.verifyAfterEdit, true);
  assert.equal(st.editedFiles.length, 0);
});

test("review-class skill satisfies the gate", () => {
  let st = onEdit(emptyState(), "src/core/topics.ts");
  st = onSkill(st, "code-review");
  assert.equal(st.verifyAfterEdit, true);
});

test("specific controller obligations require their own evidence and after-edit proofs reset", () => {
  let st = armExecutionObligations(emptyState(), controllerPlan);
  assert.equal(pendingExecutionObligations(st).length, 2);
  assert.match(executionObligationBrief(st), /git \+ show \+ abcdef1/);
  assert.match(unverifiedNag(st), /completion evidence is still incomplete/i);
  assert.doesNotMatch(unverifiedNag(st), /earlier product edits/i);

  st = onCommand(st, "git show --stat abcdef1");
  assert.equal(pendingExecutionObligations(st).length, 2, "a matching command without an observed result is not proof");
  st = onCommand(st, "git show --stat abcdef1", { status: "success", output: "commit abcdef1" });
  assert.deepEqual(pendingExecutionObligations(st).map((item) => item.id), ["episode:runtime:preprocess"]);
  st = onEdit(st, "src/core/schemas.ts");
  st = onCommand(st, "npm test");
  assert.equal(st.verifyAfterEdit, true, "generic verification remains independently credited");
  assert.ok(stopVerdict(st, "firm").block, "generic verification cannot discharge a specific behavior obligation");

  st = onCommand(st, "npx vitest run src/preprocess.test.ts", { status: "failure", output: "1 failed" });
  assert.equal(pendingExecutionObligations(st).length, 1, "a failed matching test remains pending");
  assert.equal(st.obligations[1]?.last_attempt?.outcome, "failure");
  st = onCommand(st, "npx vitest run src/preprocess.test.ts", { status: "success", output: "no matching tests" });
  assert.equal(pendingExecutionObligations(st).length, 1, "success without the required output marker is not proof");
  assert.deepEqual(st.obligations[1]?.last_attempt?.missing_output, ["passed"]);
  st = onCommand(st, "npx vitest run src/preprocess.test.ts", { status: "success", output: "Test Files 1 passed" });
  assert.equal(pendingExecutionObligations(st).length, 0);
  assert.equal(stopVerdict(st, "firm").block, false);

  st = onEdit(st, "src/core/schemas.ts");
  assert.deepEqual(pendingExecutionObligations(st).map((item) => item.id), ["episode:runtime:preprocess"],
    "a later product edit invalidates only after-edit proof");
});

test("executable probes compile into strict before-edit and after-edit result receipts", () => {
  assert.deepEqual(normalizeExecutableProbes(executableProbePlan), executableProbePlan);
  const compiled = compileExecutableProbes(executableProbePlan);
  assert.deepEqual(compiled.map((item) => item.phase), ["before-edit", "after-edit"]);
  assert.deepEqual(compiled.map((item) => item.probe?.stage), ["baseline", "validation"]);

  let st = armExecutionObligations(emptyState(), compiled);
  const brief = executionObligationBrief(st);
  assert.match(brief, /BASELINE/);
  assert.match(brief, /run exactly before any product edit/i);
  assert.match(brief, /Reject the fix if the outer form passes/i);

  const command = executableProbePlan[0]!.command;
  st = onCommand(st, command, { status: "failure", output: "HUNCH_PROBE optional-preprocess inner=false" });
  assert.deepEqual(pendingExecutionObligations(st).map((item) => item.id), ["episode:probe:optional-preprocess:validation"]);
  st = onCommand(st, command, { status: "success", output: "runner infrastructure error" });
  assert.deepEqual(pendingExecutionObligations(st).map((item) => item.id), ["episode:probe:optional-preprocess:validation"],
    "a later runner mismatch must not erase an already observed baseline");
  st = onEdit(st, "src/core/schemas.ts");
  st = onCommand(st, command, { status: "success", output: "HUNCH_PROBE optional-preprocess inner=true" });
  assert.equal(pendingExecutionObligations(st).length, 0);
});

test("a skipped probe baseline cannot be retroactively satisfied after implementation starts", () => {
  const compiled = compileExecutableProbes(executableProbePlan);
  let st = armExecutionObligations(emptyState(), compiled);
  st = onEdit(st, "src/core/schemas.ts");
  st = onCommand(st, executableProbePlan[0]!.command, {
    status: "success",
    output: "HUNCH_PROBE optional-preprocess inner=true",
  });
  assert.deepEqual(pendingExecutionObligations(st).map((item) => item.id), ["episode:probe:optional-preprocess:baseline"]);
  assert.equal(st.obligations[0]?.last_attempt, undefined, "the post-edit result must not be relabeled as a baseline receipt");
});

test("the pre-edit probe gate is bounded and releases immediately after a real baseline receipt", () => {
  const compiled = compileExecutableProbes(executableProbePlan);
  let st = armExecutionObligations(emptyState(), compiled);
  let verdict = beforeEditProbeVerdict(st);
  assert.equal(verdict.block, true);
  assert.match(verdict.reason ?? "", /run exactly/i);
  st = verdict.state;
  verdict = beforeEditProbeVerdict(st);
  assert.equal(verdict.block, true);
  st = verdict.state;
  assert.equal(beforeEditProbeVerdict(st).block, false, "the third denial in one prompt must fail open");

  st = onPrompt(st);
  assert.equal(beforeEditProbeVerdict(st).block, true, "a new prompt gets a fresh bounded correction budget");
  st = onCommand(st, executableProbePlan[0]!.command, {
    status: "failure",
    output: "HUNCH_PROBE optional-preprocess inner=false",
  });
  assert.equal(beforeEditProbeVerdict(st).block, false, "a valid red receipt releases the edit gate");
});

test("a host without command outcomes keeps the pre-edit gate advisory; hosts with outcomes are unchanged (#484)", () => {
  let st = armExecutionObligations(emptyState(), compileExecutableProbes(executableProbePlan));
  // Windsurf's post_run_command carries no exit status: the probe ran, but its result is unknown.
  st = onCommand(st, executableProbePlan[0]!.command, { status: "unknown", output: "" });
  assert.ok(st.obligations.some((item) => item.phase === "before-edit" && item.status === "pending"), "an unknown result is still not a receipt");
  const advisory = beforeEditProbeVerdict(st, { commandOutcomes: false });
  assert.equal(advisory.block, false, "an unverifiable obligation must never deny");
  assert.equal(advisory.unverifiable, true);
  assert.match(advisory.reason ?? "", /advisory.*do not report command results/);
  assert.equal(advisory.state.probeBlocks, 0, "an advisory pass spends no correction budget");

  const withOutcomes = beforeEditProbeVerdict(st, { commandOutcomes: true });
  assert.equal(withOutcomes.block, true, "a host that reports outcomes still gets the deny");
  assert.equal(withOutcomes.unverifiable, undefined);
  assert.deepEqual(beforeEditProbeVerdict(st), withOutcomes, "the default is the unchanged behavior");
  const wrongReason = onCommand(st, executableProbePlan[0]!.command, { status: "failure", output: "HUNCH_PROBE optional-preprocess crashed" });
  assert.equal(beforeEditProbeVerdict(wrongReason, { commandOutcomes: true }).block, true, "a failure for the wrong reason still blocks");
  const receipt = onCommand(st, executableProbePlan[0]!.command, { status: "failure", output: "HUNCH_PROBE optional-preprocess inner=false" });
  assert.equal(beforeEditProbeVerdict(receipt, { commandOutcomes: true }).block, false, "a valid red receipt still releases the gate");
});

test("the pre-edit evidence gate requires both a probe baseline and a hypothesis discriminator", () => {
  const tournament: ExecutionObligation = {
    id: "episode:tournament",
    origin: "episode",
    category: "evidence",
    phase: "before-edit",
    description: "Validate two distinct hypotheses and choose with a discriminator.",
    command_alternatives: [["node", ".hunch-probes/tournament.mjs"]],
    expected: { success: true, output_includes: ["HUNCH_TOURNAMENT state=ready"] },
  };
  let st = armExecutionObligations(emptyState(), [
    ...compileExecutableProbes(executableProbePlan),
    tournament,
  ]);
  let verdict = beforeEditProbeVerdict(st);
  assert.equal(verdict.block, true);
  assert.match(verdict.reason ?? "", /pre-change result/i);
  assert.match(verdict.reason ?? "", /two distinct hypotheses/i);
  st = onCommand(verdict.state, executableProbePlan[0]!.command, {
    status: "failure",
    output: "HUNCH_PROBE optional-preprocess state=red outer=true inner=false",
  });
  verdict = beforeEditProbeVerdict(st);
  assert.equal(verdict.block, true, "the tournament remains a separate prerequisite");
  assert.doesNotMatch(verdict.reason ?? "", /pre-change result/i);
  st = onCommand(verdict.state, "node .hunch-probes/tournament.mjs", {
    status: "success",
    output: "HUNCH_TOURNAMENT state=ready",
  });
  assert.equal(beforeEditProbeVerdict(st).block, false);
});

test("proof scheduler drives a pending pre-edit tournament to convergence before implementation", () => {
  const tournament: ExecutionObligation = {
    id: "episode:tournament",
    origin: "episode",
    category: "evidence",
    phase: "before-edit",
    description: "Choose between two ownership hypotheses with an observed discriminator.",
    command_alternatives: [["node", ".hunch-probes/tournament.mjs"]],
    expected: { success: true, output_includes: ["HUNCH_TOURNAMENT state=ready"] },
  };
  let st = armExecutionObligations(emptyState(), [tournament]);
  let checkpoint: ReturnType<typeof proofCheckpoint> | undefined;
  for (let index = 0; index < 6; index++) {
    const command = `git show HEAD:src/core/schemas.ts # ${index}`;
    const before = st;
    st = onCommand(st, command, { status: "success", output: "source evidence" });
    checkpoint = proofCheckpoint(before, st, { kind: "command", command });
    st = checkpoint.state;
    if (index < 5) assert.equal(checkpoint.reminder, undefined);
  }
  assert.equal(checkpoint?.reason, "cadence");
  assert.match(checkpoint?.reminder ?? "", /pre-edit budget/i);
  assert.match(checkpoint?.reminder ?? "", /narrowest prerequisite/i);
  assert.match(checkpoint?.reminder ?? "", /node \.hunch-probes\/tournament\.mjs/i);

  const before = st;
  const command = "node .hunch-probes/tournament.mjs";
  st = onCommand(st, command, { status: "success", output: "HUNCH_TOURNAMENT state=ready" });
  checkpoint = proofCheckpoint(before, st, { kind: "command", command });
  assert.equal(checkpoint.reminder, undefined);
  assert.equal(pendingExecutionObligations(checkpoint.state).length, 0);
});

test("proof scheduler hands off immediately when the last pre-edit receipt closes", () => {
  const tournament: ExecutionObligation = {
    id: "episode:tournament",
    origin: "episode",
    category: "evidence",
    phase: "before-edit",
    description: "Choose between two ownership hypotheses with an observed discriminator.",
    command_alternatives: [["node", ".hunch-probes/tournament.mjs"]],
    expected: { success: true, output_includes: ["HUNCH_TOURNAMENT state=ready"] },
  };
  let st = armExecutionObligations(emptyState(), [
    ...compileExecutableProbes(executableProbePlan),
    tournament,
  ]);
  st = onCommand(st, executableProbePlan[0]!.command, {
    status: "failure",
    output: "HUNCH_PROBE optional-preprocess inner=false",
  });
  const before = st;
  const command = "node .hunch-probes/tournament.mjs";
  st = onCommand(st, command, { status: "success", output: "HUNCH_TOURNAMENT state=ready" });
  const checkpoint = proofCheckpoint(before, st, { kind: "command", command });

  assert.equal(checkpoint.reason, "evidence-handoff");
  assert.match(checkpoint.reminder ?? "", /pre-edit evidence is complete/i);
  assert.match(checkpoint.reminder ?? "", /stop expanding the diagnosis/i);
  assert.match(checkpoint.reminder ?? "", /smallest chosen product edit now/i);
  assert.match(checkpoint.reminder ?? "", /HUNCH_PROBE optional-preprocess/i, "the handoff reserves the exact after-edit proof command");
  assert.deepEqual(pendingExecutionObligations(checkpoint.state).map((item) => item.phase), ["after-edit"]);
});

test("proof scheduler pivots the hypothesis when a validation probe is partly green", () => {
  const probe = [{
    ...executableProbePlan[0]!,
    expected_before: {
      success: true,
      output_includes: ["HUNCH_PROBE optional-preprocess", "state=red", "target=false", "control=true"],
    },
    expected_after: {
      success: true,
      output_includes: ["HUNCH_PROBE optional-preprocess", "state=green", "target=true", "control=true"],
      output_excludes: ["state=red", "target=false", "control=false"],
    },
  }];
  let st = armExecutionObligations(emptyState(), compileExecutableProbes(probe));
  const command = probe[0]!.command;
  st = onCommand(st, command, {
    status: "success",
    output: "HUNCH_PROBE optional-preprocess state=red target=false control=true",
  });
  st = onEdit(st, "src/core/schemas.ts");
  const before = st;
  st = onCommand(st, command, {
    status: "success",
    output: "HUNCH_PROBE optional-preprocess state=red target=true control=false",
  });
  const checkpoint = proofCheckpoint(before, st, { kind: "command", command });

  assert.equal(checkpoint.reason, "falsifier-pivot");
  assert.match(checkpoint.reminder ?? "", /newly green \(target=true\)/i);
  assert.match(checkpoint.reminder ?? "", /still missing state=green/i);
  assert.match(checkpoint.reminder ?? "", /baseline control regressed \(control=true → control=false\)/i);
  assert.match(checkpoint.reminder ?? "", /preserve the newly green behavior/i);
  assert.match(checkpoint.reminder ?? "", /do not rerun unchanged, broaden the same fix, or revert to baseline/i);
  assert.match(checkpoint.reminder ?? "", /invariant or a stale expectation/i);
  assert.match(checkpoint.reminder ?? "", /pre-fix snapshot is not an automatic veto/i);
  assert.match(checkpoint.reminder ?? "", /Reject the fix if the outer form passes/i);
  assert.match(checkpoint.reminder ?? "", /HUNCH_PROBE optional-preprocess/i);
});

test("proof scheduler does not claim partial progress when all changed markers stay red", () => {
  const probe = [{
    ...executableProbePlan[0]!,
    expected_before: {
      success: true,
      output_includes: ["HUNCH_PROBE optional-preprocess", "state=red", "target=false", "control=true"],
    },
    expected_after: {
      success: true,
      output_includes: ["HUNCH_PROBE optional-preprocess", "state=green", "target=true", "control=true"],
      output_excludes: ["state=red", "target=false", "control=false"],
    },
  }];
  let st = armExecutionObligations(emptyState(), compileExecutableProbes(probe));
  const command = probe[0]!.command;
  st = onCommand(st, command, {
    status: "success",
    output: "HUNCH_PROBE optional-preprocess state=red target=false control=true",
  });
  st = onEdit(st, "src/core/schemas.ts");
  const before = st;
  st = onCommand(st, command, {
    status: "success",
    output: "HUNCH_PROBE optional-preprocess state=red target=false control=true",
  });
  const checkpoint = proofCheckpoint(before, st, { kind: "command", command });

  assert.equal(checkpoint.reason, "attempt-mismatch");
  assert.doesNotMatch(checkpoint.reminder ?? "", /newly green/i);
});

test("mid-flight proof scheduler reminds after implementation starts, on cadence, and after a mismatched attempt", () => {
  let st = armExecutionObligations(emptyState(), controllerPlan);
  let before = st;
  st = onEdit(st, "src/core/schemas.ts");
  let checkpoint = proofCheckpoint(before, st, { kind: "edit" });
  st = checkpoint.state;
  assert.equal(checkpoint.reason, "first-edit");
  assert.match(checkpoint.reminder ?? "", /reserve a verification block/i);
  assert.equal(st.proofReminders, 1);

  for (let index = 0; index < 5; index++) {
    before = st;
    st = onCommand(st, `git status --short # ${index}`, { status: "success", output: "" });
    checkpoint = proofCheckpoint(before, st, { kind: "command", command: `git status --short # ${index}` });
    st = checkpoint.state;
    assert.equal(checkpoint.reminder, undefined);
  }
  before = st;
  st = onCommand(st, "git status --short # cadence", { status: "success", output: "" });
  checkpoint = proofCheckpoint(before, st, { kind: "command", command: "git status --short # cadence" });
  st = checkpoint.state;
  assert.equal(checkpoint.reason, "cadence");
  assert.match(checkpoint.reminder ?? "", /run the narrowest pending proof now/i);

  const failedCommand = "npx vitest run src/preprocess.test.ts";
  before = st;
  st = onCommand(st, failedCommand, { status: "failure", output: "1 failed" });
  checkpoint = proofCheckpoint(before, st, { kind: "command", command: failedCommand });
  assert.equal(checkpoint.reason, "attempt-mismatch");
  assert.match(checkpoint.reminder ?? "", /observed failure/i);
  assert.match(checkpoint.reminder ?? "", /forbidden output present: failed/i);
});

test("mid-flight proof scheduler reports invalidated receipts and stays inert without a proof plan", () => {
  const inert = proofCheckpoint(emptyState(), onEdit(emptyState(), "src/a.ts"), { kind: "edit" });
  assert.equal(inert.reminder, undefined);
  assert.equal(inert.state.proofActivity, 0);

  let st = armExecutionObligations(emptyState(), controllerPlan);
  st = onEdit(st, "src/core/schemas.ts");
  st = onCommand(st, "npx vitest run src/preprocess.test.ts", { status: "success", output: "1 passed" });
  assert.equal(st.obligations[1]?.status, "satisfied");
  const before = st;
  st = onEdit(st, "src/core/schemas.ts");
  const checkpoint = proofCheckpoint(before, st, { kind: "edit" });
  assert.equal(checkpoint.reason, "proof-invalidated");
  assert.match(checkpoint.reminder ?? "", /invalidated 1 after-edit receipt/i);
});

test("arming a new memory context replaces stale memory obligations but preserves episode obligations", () => {
  const memory = [{ ...controllerPlan[0]!, id: "memory:old", origin: "memory" as const }];
  let st = armExecutionObligations(emptyState(), [...controllerPlan, ...memory]);
  st = armExecutionObligations(st, [{ ...memory[0]!, id: "memory:new" }], { replaceOrigin: "memory" });
  assert.deepEqual(st.obligations.map((item) => item.id), [
    "episode:inspect:abcdef1",
    "episode:runtime:preprocess",
    "memory:new",
  ]);
});

test("environment obligation parsing is bounded and fails open", () => {
  assert.deepEqual(environmentExecutionObligations("not json"), []);
  assert.deepEqual(environmentExecutionObligations(JSON.stringify(controllerPlan)), controllerPlan);
  assert.deepEqual(environmentExecutionObligations(JSON.stringify([{ ...controllerPlan[0], command_alternatives: [] }])), []);
  assert.deepEqual(environmentExecutionObligations(JSON.stringify([{ ...controllerPlan[0], expected: undefined }])), []);
  assert.deepEqual(environmentExecutableProbes("not json"), []);
  assert.deepEqual(environmentExecutableProbes(JSON.stringify(executableProbePlan)), executableProbePlan);
  assert.deepEqual(environmentExecutableProbes(JSON.stringify([{ ...executableProbePlan[0], command: "" }])), []);
  const sevenContractMarkers = ["probe", "state=green", "runtime=true", "jitless=true", "types=true", "json=true", "control=true"];
  const richProbe = normalizeExecutableProbes([{
    ...executableProbePlan[0],
    expected_after: { success: true, output_includes: sevenContractMarkers },
  }]);
  assert.deepEqual(richProbe[0]?.expected_after.output_includes, sevenContractMarkers,
    "a bounded contrast can close more than six contract dimensions without truncation");
});

test("contract-axis audit identifies uncovered consumers and rejects green-only substitutes", () => {
  const plan: ExecutionObligation[] = [
    { ...controllerPlan[1]! },
    {
      id: "episode:types:surface",
      origin: "episode",
      category: "types",
      phase: "after-edit",
      description: "Prove the static directional contract.",
      command_alternatives: [["tsc", "--noemit"]],
      expected: { success: true },
    },
    {
      id: "episode:serialization:surface",
      origin: "episode",
      category: "serialization",
      phase: "after-edit",
      description: "Prove the downstream schema contract.",
      command_alternatives: [["vitest", "json-schema.test.ts"]],
      expected: { success: true },
    },
    {
      id: "episode:compatibility:surface",
      origin: "episode",
      category: "compatibility",
      phase: "after-edit",
      description: "Preserve the adjacent wrapper contract.",
      command_alternatives: [["vitest", "optional.test.ts"]],
      expected: { success: true },
    },
  ];
  const probe = {
    ...executableProbePlan[0]!,
    artifact: {
      path: ".hunch-probes/contract.ts",
      content: "const result=schema.safeParse({}); const json=z.toJSONSchema(schema); console.log(result,json);",
    },
    expected_before: { success: true, output_includes: ["state=red", "target=false", "control=true"] },
    expected_after: { success: true, output_includes: ["state=green", "target=true", "control=true"] },
  };

  const audit = auditExecutableProbeContractAxes(probe, plan);
  assert.deepEqual(audit.required, ["runtime", "static", "serialization", "compatibility"]);
  assert.deepEqual(audit.covered, ["runtime", "serialization", "compatibility"]);
  assert.deepEqual(audit.missing, ["static"]);
  const weakGreenOnlyCheck = {
    ...executableProbePlan[0]!,
    id: "episode:axis:weak-static",
    category: "types" as const,
    expected_before: { success: true },
    expected_after: { success: true },
  };
  assert.deepEqual(compileContractAxisProbeClosure(probe, plan, [weakGreenOnlyCheck]).probes, [],
    "a category-labelled green-only check is not a falsifiable axis contract");
  const bitingStaticProbe = {
    ...weakGreenOnlyCheck,
    id: "episode:axis:biting-static",
    expected_before: { success: true, output_includes: ["HUNCH_AXIS static", "state=red"] },
    expected_after: { success: true, output_includes: ["HUNCH_AXIS static", "state=green"] },
  };
  assert.deepEqual(compileContractAxisProbeClosure(probe, plan, [bitingStaticProbe]).probes, [bitingStaticProbe]);
  const adaptive = compileAdaptiveContractAxisProbeClosure(probe, plan, [bitingStaticProbe]);
  assert.deepEqual(adaptive.probes, [bitingStaticProbe]);
  assert.equal(adaptive.probe?.expected_before.output_includes?.includes("stage=main"), true);
  assert.equal(adaptive.probe?.expected_after.output_includes?.includes("stage=closed"), true);
  assert.equal(adaptive.probe?.expected_after.output_includes?.includes("axes=1"), true);
  assert.deepEqual(adaptive.disclosures, [{
    category: bitingStaticProbe.category,
    claim: bitingStaticProbe.claim,
    falsifier: bitingStaticProbe.falsifier,
  }]);
  assert.equal("command" in adaptive.disclosures[0]!, false,
    "design-time disclosure must not leak the deferred executable command");
  assert.deepEqual(compileContractAxisRiskHint(adaptive, {
    probe_id: bitingStaticProbe.id,
    owner: "src/public/schema.ts::preprocess",
  }), {
    probe_id: bitingStaticProbe.id,
    category: bitingStaticProbe.category,
    owner: "src/public/schema.ts::preprocess",
  });
  assert.equal(compileContractAxisRiskHint(adaptive, {
    probe_id: bitingStaticProbe.id,
    owner: "../future-fix.ts::preprocess",
  }), null, "risk owners must stay repository-relative");
  assert.equal(compileContractAxisRiskHint(adaptive, {
    probe_id: "unqualified:consumer",
    owner: "src/public/schema.ts::preprocess",
  }), null, "a risk hint cannot promote an unqualified consumer");
  assert.deepEqual(inferContractAxisRiskHint(adaptive, [
    { path: "src/core/schema.ts", content: "export interface $CorePreprocess {}" },
    { path: "src/public/schema.ts", content: "export function preprocess(value: unknown) { return value; }" },
    { path: "src/public/tests/schema.test.ts", content: "export class PreprocessTestOnly {}" },
  ])?.hint, {
    probe_id: bitingStaticProbe.id,
    category: bitingStaticProbe.category,
    owner: "src/public/schema.ts::preprocess",
  });
  const miniCompatibilityProbe = {
    ...bitingStaticProbe,
    id: "fixture:axis:mini-codec-parity",
    category: "compatibility" as const,
    claim: "The Mini codec surface preserves codec inversion parity.",
    falsifier: "Reject a classic-only fix when the Mini codec consumer remains red.",
    artifact: {
      path: ".hunch-probes/mini-codec.mjs",
      content: 'import * as z from "../packages/zod/src/v4/mini/index.ts"; const value=null as z.ZodMiniType|null; z.codec(z.string(), z.string(), {});',
    },
  };
  assert.deepEqual(inferContractAxisRiskHint({
    ...adaptive,
    probes: [miniCompatibilityProbe],
  }, [{
    path: "packages/zod/src/v4/mini/schemas.ts",
    content: "interface _ZodMiniType {}\nexport interface ZodMiniType extends _ZodMiniType {}\nexport interface ZodMiniCodec extends _ZodMiniType {}\nexport const ZodMiniCodec = class {};",
  }])?.hint, {
    probe_id: miniCompatibilityProbe.id,
    category: miniCompatibilityProbe.category,
    owner: "packages/zod/src/v4/mini/schemas.ts::ZodMiniCodec",
  }, "public API anchors must outrank package-scope words and generic base types");
  const discriminatedCompatibilityProbe = {
    ...miniCompatibilityProbe,
    id: "fixture:axis:mini-discriminated-union",
    claim: "Mini discriminatedUnion must reject an option missing its discriminator.",
    falsifier: "Reject a classic-only fix or a Mini discriminated union that loses literal inference.",
    artifact: {
      path: ".hunch-probes/mini-discriminated.mjs",
      content: 'const path="packages/zod/src/v4/mini/tests/fixture.ts"; z.discriminatedUnion("kind", [z.object({kind:z.literal("ok")})]);',
    },
  };
  const fileFallback = inferContractAxisRiskHint({
    ...adaptive,
    probes: [discriminatedCompatibilityProbe],
  }, [
    {
      path: "packages/zod/src/v4/mini/schemas.ts",
      content: "export interface ZodMiniDiscriminatedUnion {}\nexport interface ZodMiniTemplateLiteral {}\nexport function discriminatedUnion() {}\nexport function literal() {}",
    },
    { path: "packages/zod/src/v4/core/schemas.ts", content: "export interface $ZodDiscriminatedUnion {}" },
  ]);
  assert.equal(fileFallback?.level, "file");
  assert.equal(fileFallback?.hint.owner, "packages/zod/src/v4/mini/schemas.ts");
  assert.match(adaptive.probe?.artifact?.content ?? "", /for\(const spec of specs\.slice\(1\)\)/);
  assert.match(adaptive.probe?.artifact?.content ?? "", /if\(!main\)/,
    "consumer probes must remain deferred until the main contrast is green");
});

test("static contract discovery requires executable typechecking, not type-looking source alone", () => {
  const probe = {
    ...executableProbePlan[0]!,
    artifact: {
      path: ".hunch-probes/types.ts",
      content: "type Input = z.input<typeof schema>; schema.safeParse({});",
    },
  };
  assert.deepEqual(discoverExecutableProbeContractAxes(probe), ["runtime"]);
  assert.deepEqual(discoverExecutableProbeContractAxes({
    ...probe,
    command: `${probe.command} && npx tsc --noEmit .hunch-probes/types.ts`,
  }), ["runtime", "static"]);
});

test("implementation-owner retrieval prefers a disclosed internal declaration over a public facade", () => {
  const sources = [
    {
      path: "packages/lib/src/core/public.ts",
      content: "export function toJSONSchema(value: unknown) { return catchProcessor(value); }\n",
    },
    {
      path: "packages/lib/src/core/json-schema-processors.ts",
      content: "export function catchProcessor(value: unknown) { return { catch: value }; }\n",
    },
  ];
  const issue = "Dynamic catch values crash in JSON Schema. The catchProcessor path must preserve the underlying schema.";
  const ranking = rankIssueImplementationOwners(issue, sources);
  assert.equal(ranking?.candidates[0]?.owner, "packages/lib/src/core/json-schema-processors.ts::catchProcessor");
  assert.equal(inferIssueImplementationOwner(issue, sources)?.owner, "packages/lib/src/core/json-schema-processors.ts::catchProcessor");
});

test("implementation-owner retrieval records path disclosure and abstains on an unresolved tie", () => {
  const sources = [
    { path: "packages/lib/src/a/special.ts", content: "export function resolveThing() { return 'a'; }\n" },
    { path: "packages/lib/src/b/other.ts", content: "export function resolveThing() { return 'b'; }\n" },
  ];
  const disclosed = rankIssueImplementationOwners("Failure in src/a/special.ts while resolving the thing", sources);
  assert.equal(disclosed?.candidates[0]?.owner, "packages/lib/src/a/special.ts::resolveThing");
  assert.equal(disclosed?.candidates[0]?.path_disclosed, true);
  assert.equal(inferIssueImplementationOwner("resolveThing fails", sources), null);
});

test("stopVerdict: blocks only at firm/strict, max twice, resets on prompt", () => {
  let st = onEdit(emptyState(), "src/core/topics.ts");
  assert.equal(stopVerdict(st, "advisory").block, false);
  assert.equal(stopVerdict(st, "off").block, false);

  const v1 = stopVerdict(st, "firm");
  assert.ok(v1.block);
  assert.match(v1.block ? v1.reason : "", /VERIFY unsatisfied/);
  st = v1.block ? v1.state : st;

  const v2 = stopVerdict(st, "strict");
  assert.ok(v2.block);
  st = v2.block ? v2.state : st;

  // third block refused — never a lockout
  assert.equal(stopVerdict(st, "firm").block, false);

  // new user prompt refills the budget
  st = onPrompt(st);
  assert.equal(st.blocks, 0);
  assert.ok(stopVerdict(st, "firm").block);
});

test("stopVerdict: verified state never blocks", () => {
  let st = onEdit(emptyState(), "src/core/topics.ts");
  st = onCommand(st, "npm run typecheck && tsc");
  assert.equal(stopVerdict(st, "strict").block, false);
});

test("state round-trip survives save/load; garbage session id yields fresh state", () => {
  const id = `pipeline-test-${process.pid}`;
  let st = onEdit(emptyState(), "src/core/topics.ts");
  st = onPrompt(st);
  savePipelineState(id, st);
  const back = loadPipelineState(id);
  assert.equal(back.turn, 1);
  assert.equal(back.verifyAfterEdit, false);
  assert.deepEqual(back.editedFiles, ["src/core/topics.ts"]);
  const fresh = loadPipelineState("no-such-session-ever");
  assert.equal(fresh.turn, 0);
  assert.equal(fresh.verifyAfterEdit, true);
});

test("pipeline state follows a TEMP/TMP/TMPDIR change made after import (a hook daemon's per-request env)", (t) => {
  const saved = { TEMP: process.env.TEMP, TMP: process.env.TMP, TMPDIR: process.env.TMPDIR };
  const dir = mkdtempSync(join(tmpdir(), "hunch-pipeline-env-"));
  t.after(() => {
    for (const [name, value] of Object.entries(saved)) if (value === undefined) delete process.env[name]; else process.env[name] = value;
    cleanupDir(dir);
  });
  process.env.TEMP = process.env.TMP = process.env.TMPDIR = dir;
  const id = `pipeline-env-${process.pid}`;
  savePipelineState(id, onPrompt(emptyState()));
  assert.ok(existsSync(join(dir, "hunch-pipeline", `${id}.json`)));
  assert.equal(loadPipelineState(id).turn, 1);
});
