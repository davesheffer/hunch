import { cleanupDir } from "./fixtures.js";
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import { mkdtempSync, mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { benchmarkIntegrityPass, snapshotFiles, snapshotsEqual } from "../bench/external/file-integrity.js";
import {
  auditExecutableProbeContractAxes,
  compileContractAxisProbeClosure,
  compileExecutableProbes,
  normalizeExecutableProbes,
  normalizeExecutionObligations,
  type ExecutableProbe,
  type ExecutionObligation,
} from "../src/core/pipeline.js";

test("external benchmark detects hidden-test edits before scoring overwrites them", (t) => {
  const root = mkdtempSync(join(tmpdir(), "hunch-bench-integrity-"));
  t.after(() => cleanupDir(root));
  mkdirSync(join(root, "test"));
  writeFileSync(join(root, "test/existing.test.ts"), "original\n");

  const baseline = snapshotFiles(["test/existing.test.ts", "test/future.test.ts"], root);
  assert.equal(snapshotsEqual(baseline, root), true);

  writeFileSync(join(root, "test/existing.test.ts"), "agent edit\n");
  assert.equal(snapshotsEqual(baseline, root), false);

  writeFileSync(join(root, "test/existing.test.ts"), "original\n");
  writeFileSync(join(root, "test/future.test.ts"), "agent-created hidden path\n");
  assert.equal(snapshotsEqual(baseline, root), false);
});

test("issue-only scoring permits ordinary test edits but never probe edits", () => {
  assert.equal(benchmarkIntegrityPass(false, false, true), false, "exposed future tests must remain immutable");
  assert.equal(benchmarkIntegrityPass(true, false, true), true, "pre-fix tests are normal editable evidence");
  assert.equal(benchmarkIntegrityPass(true, true, false), false, "benchmark-owned probes are always immutable");
});

test("execution episodes are bounded, structured, and contain no held-out fix commit", () => {
  const root = join(import.meta.dirname, "..");
  const suite = JSON.parse(readFileSync(join(root, "bench/external/zod-tasks.json"), "utf8")) as {
    cutoff: string;
    tasks: Array<{ id: string; fixSha: string; testFiles: string[] }>;
  };
  const fixture = JSON.parse(readFileSync(join(root, "bench/external/zod-execution-episodes.json"), "utf8")) as {
    cutoff: string;
    episodes: Record<string, { id: string; commits: string[]; text: string; obligations?: ExecutionObligation[] }>;
  };

  assert.equal(fixture.cutoff, suite.cutoff);
  assert.deepEqual(Object.keys(fixture.episodes).sort(), ["zod-5625", "zod-5917", "zod-5937"]);
  for (const [taskId, episode] of Object.entries(fixture.episodes)) {
    const task = suite.tasks.find((candidate) => candidate.id === taskId);
    assert.ok(task, `missing benchmark task ${taskId}`);
    assert.match(episode.id, /^episode-[a-z0-9-]+$/);
    assert.ok(episode.text.length >= 500 && episode.text.length <= 5_000, `${taskId} episode must stay bounded`);
    assert.match(episode.text, /GOAL/);
    assert.match(episode.text, /OBSERVED MECHANISM/);
    assert.match(episode.text, /PROVING EVIDENCE/);
    assert.match(episode.text, /APPLICABILITY BOUNDARY/);
    assert.ok(episode.commits.length >= 1 && episode.commits.length <= 6);
    assert.equal(new Set(episode.commits).size, episode.commits.length);
    for (const commit of episode.commits) assert.match(commit, /^[0-9a-f]{40}$/);
    assert.ok(!episode.commits.includes(task!.fixSha), `${taskId} episode leaked its held-out fix`);
    assert.ok(!episode.text.includes(task!.fixSha), `${taskId} episode text leaked its held-out fix`);
    assert.ok((episode.obligations?.length ?? 0) >= 4 && (episode.obligations?.length ?? 0) <= 10, `${taskId} needs a bounded controller plan`);
    assert.deepEqual(normalizeExecutionObligations(episode.obligations), episode.obligations);
    for (const obligation of episode.obligations ?? []) {
      assert.equal(obligation.origin, "episode");
      assert.ok(!JSON.stringify(obligation).includes(task!.fixSha), `${taskId} obligation leaked its held-out fix`);
    }
  }
});

test("rolling execution episodes remain task-relative and exclude their target fixes", () => {
  const root = join(import.meta.dirname, "..");
  const suite = JSON.parse(readFileSync(join(root, "bench/external/zod-tasks.json"), "utf8")) as {
    tasks: Array<{ id: string; fixSha: string; testFiles: string[] }>;
  };
  const fixture = JSON.parse(readFileSync(join(root, "bench/external/zod-execution-episodes-rolling.json"), "utf8")) as {
    cutoff: string;
    mode: string;
    episodes: Record<string, {
      id: string;
      commits: string[];
      text: string;
      obligations: ExecutionObligation[];
      compact_regression: ExecutionObligation;
      pre_fix_validation_compatible: boolean;
      contrastive_probe: ExecutableProbe;
      contract_axis_probes?: ExecutableProbe[];
      tournament: {
        decision_path: string;
        artifact: { path: string; content: string };
        obligation: ExecutionObligation;
      };
      probes: ExecutableProbe[];
    }>;
  };

  assert.equal(fixture.mode, "task-relative");
  assert.equal(fixture.cutoff, "per-task-pre-fix-ancestry");
  assert.deepEqual(Object.keys(fixture.episodes).sort(), ["zod-5625", "zod-5917", "zod-5937"]);
  assert.equal(fixture.episodes["zod-5625"]!.pre_fix_validation_compatible, true);
  assert.equal(fixture.episodes["zod-5917"]!.pre_fix_validation_compatible, true);
  assert.equal(fixture.episodes["zod-5937"]!.pre_fix_validation_compatible, false);
  for (const [taskId, episode] of Object.entries(fixture.episodes)) {
    const task = suite.tasks.find((candidate) => candidate.id === taskId);
    assert.ok(task, `missing benchmark task ${taskId}`);
    const issueContract = readFileSync(join(root, `bench/external/contracts/${taskId}.issue-contract.test.ts`), "utf8");
    assert.match(issueContract, /from "zod\/v4"/);
    assert.ok(issueContract.length >= 1_000 && issueContract.length <= 5_000, `${taskId} issue contract must stay bounded`);
    assert.ok(!issueContract.includes(task!.fixSha), `${taskId} issue contract leaked its held-out fix`);
    for (const hiddenTest of task!.testFiles) {
      assert.ok(!issueContract.includes(hiddenTest), `${taskId} issue contract copied an upstream hidden-test path`);
    }
    assert.ok(episode.text.length >= 500 && episode.text.length <= 5_000, `${taskId} rolling episode must stay bounded`);
    assert.match(episode.text, /GOAL/);
    assert.match(episode.text, /PROVING EVIDENCE/);
    assert.match(episode.text, /APPLICABILITY BOUNDARY/);
    for (const commit of episode.commits) assert.match(commit, /^[0-9a-f]{40}$/);
    assert.ok(!episode.commits.includes(task!.fixSha), `${taskId} rolling episode leaked its held-out fix`);
    assert.ok(!episode.text.includes(task!.fixSha), `${taskId} rolling episode text leaked its held-out fix`);
    assert.ok(episode.obligations.length >= 4 && episode.obligations.length <= 10, `${taskId} needs a bounded controller plan`);
    assert.deepEqual(normalizeExecutionObligations(episode.obligations), episode.obligations, `${taskId} obligations must satisfy the runtime contract`);
    assert.equal(new Set(episode.obligations.map((item) => item.id)).size, episode.obligations.length);
    for (const obligation of episode.obligations) {
      assert.equal(obligation.origin, "episode");
      assert.ok(!JSON.stringify(obligation).includes(task!.fixSha), `${taskId} obligation leaked its held-out fix`);
    }
    assert.deepEqual(normalizeExecutionObligations([episode.compact_regression]), [episode.compact_regression], `${taskId} compact regression must satisfy the runtime contract`);
    assert.equal(episode.compact_regression.origin, "episode");
    assert.equal(episode.compact_regression.phase, "after-edit");
    assert.equal(episode.compact_regression.expected.success, true);
    assert.ok(episode.compact_regression.expected.output_includes?.includes("passed"));
    assert.ok(episode.compact_regression.expected.output_excludes?.includes("failed"));
    assert.equal(episode.compact_regression.command_alternatives.length, 1, `${taskId} Q-lite must expose exactly one regression command`);
    assert.deepEqual(episode.compact_regression.command_alternatives[0]?.slice(0, 3), ["npx", "vitest", "run"]);
    assert.ok(!JSON.stringify(episode.compact_regression).includes(task!.fixSha), `${taskId} compact regression leaked its held-out fix`);
    assert.deepEqual(normalizeExecutableProbes([episode.contrastive_probe]), [episode.contrastive_probe], `${taskId} contrastive probe must satisfy the runtime contract`);
    assert.deepEqual(compileExecutableProbes([episode.contrastive_probe]).map((item) => item.phase), ["before-edit", "after-edit"]);
    assert.ok(episode.contrastive_probe.expected_before.output_includes?.includes("state=red"));
    assert.ok(episode.contrastive_probe.expected_after.output_includes?.includes("state=green"));
    assert.match(episode.contrastive_probe.artifact?.path ?? "", /^\.hunch-probes\/[A-Za-z0-9._-]+\.ts$/);
    assert.match(episode.contrastive_probe.artifact?.content ?? "", /HUNCH_CONTRAST/);
    assert.ok(!JSON.stringify(episode.contrastive_probe).includes(task!.fixSha), `${taskId} contrastive probe leaked its held-out fix`);
    const axisAudit = auditExecutableProbeContractAxes(episode.contrastive_probe, episode.obligations);
    assert.deepEqual(
      axisAudit.required,
      taskId === "zod-5625" ? ["runtime", "static", "compatibility"] : ["runtime", "static", "serialization", "compatibility"],
    );
    assert.deepEqual(axisAudit.missing,
      taskId === "zod-5917" ? ["static", "serialization"]
        : taskId === "zod-5625" ? ["static", "compatibility"]
          : ["static"],
      `${taskId} automatic closure must select only axes absent from the executable contrast`);
    const axisClosure = compileContractAxisProbeClosure(
      episode.contrastive_probe,
      episode.obligations,
      episode.contract_axis_probes ?? [],
    );
    if (taskId === "zod-5917" || taskId === "zod-5625") {
      assert.deepEqual(normalizeExecutableProbes(episode.contract_axis_probes), episode.contract_axis_probes);
      assert.deepEqual(
        axisClosure.probes.map((probe) => probe.category),
        taskId === "zod-5917" ? ["types", "serialization"]
          : ["types", "compatibility"],
      );
      const expectedAxes = [true, true];
      assert.deepEqual(axisClosure.probes.map((probe) => probe.expected_before.output_includes?.includes("state=red")), expectedAxes);
      assert.deepEqual(axisClosure.probes.map((probe) => probe.expected_after.output_includes?.includes("state=green")), expectedAxes);
    } else {
      assert.equal(episode.contract_axis_probes, undefined);
      assert.deepEqual(axisClosure.probes, []);
    }
    assert.ok(!JSON.stringify(episode.contract_axis_probes ?? []).includes(task!.fixSha), `${taskId} axis probes leaked the held-out fix`);
    assert.equal(episode.tournament.decision_path, ".hunch/tournament-decision.json");
    assert.match(episode.tournament.artifact.path, /^\.hunch-probes\/[A-Za-z0-9._-]+\.mjs$/);
    assert.match(episode.tournament.artifact.content, /HUNCH_TOURNAMENT/);
    assert.ok(episode.tournament.artifact.content.length <= 4_000);
    assert.deepEqual(normalizeExecutionObligations([episode.tournament.obligation]), [episode.tournament.obligation]);
    assert.equal(episode.tournament.obligation.phase, "before-edit");
    assert.ok(episode.tournament.obligation.expected.output_includes?.includes("HUNCH_TOURNAMENT state=ready"));
    assert.ok(episode.tournament.obligation.expected.output_includes?.includes("discriminator=true closure=true"));
    assert.ok(!JSON.stringify(episode.tournament).includes(task!.fixSha), `${taskId} tournament leaked its held-out fix`);
    const tournamentRoot = mkdtempSync(join(tmpdir(), `hunch-tournament-${taskId}-`));
    try {
      mkdirSync(join(tournamentRoot, ".hunch-probes"));
      mkdirSync(join(tournamentRoot, ".hunch"));
      writeFileSync(join(tournamentRoot, episode.tournament.artifact.path), episode.tournament.artifact.content);
      writeFileSync(join(tournamentRoot, episode.tournament.decision_path), JSON.stringify({
        candidates: [
          { id: "A", mechanism: "Generic wrapper metadata owns the missing input contract.", surfaces: ["packages/zod/src/v4/core/generic-wrapper.ts"], falsifier: "A specialized wrapper preserves the control while this generic edit does not." },
          { id: "B", mechanism: "A specialized composition wrapper owns only this directional contract.", surfaces: ["packages/zod/src/v4/classic/specialized-wrapper.ts"], falsifier: "The generic wrapper must also change for the target behavior to become correct." },
        ],
        chosen: "B",
        discriminator: {
          command: "node .hunch-probes/contrastive-check.mjs",
          result: "The generic control remained required while the target wrapper differed.",
          why_it_separates: "The observed control assigns the contract to the specialized wrapper rather than the generic path.",
        },
        evidence: "The constructor and metadata flow use different source surfaces for the two candidates.",
        rejected_reason: "The generic candidate would change a negative control that the issue does not authorize changing.",
        contract_audit: {
          analogue: {
            surface: "packages/zod/src/v4/core/analogous-specialization.ts",
            similarity: "Both wrappers specialize a generic composition while preserving its structural contract.",
            difference: "The target changes directional metadata but keeps the generic composition control unchanged.",
          },
          contracts: [
            { kind: "runtime", surface: "packages/zod/src/v4/core/runtime-wrapper.ts", invariant: "The reported absent-input behavior changes without weakening the generic control.", check: "Run the contrastive runtime probe before and after the implementation." },
            { kind: "static", surface: "packages/zod/src/v4/core/wrapper-types.ts", invariant: "Directional input and output metadata remain visible in the public static type.", check: "Compile an assignability fixture covering specialized and generic wrappers." },
            { kind: "public-api", surface: "packages/zod/src/v4/classic/public-api.ts", invariant: "Any repository-standard specialized identity remains exported and structurally compatible.", check: "Inspect the nearest analogue and compile imports through the public entry point." },
            { kind: "downstream", surface: "packages/zod/src/v4/core/serialization.ts", invariant: "Serialization and reflection continue to recognize the transform boundary correctly.", check: "Run focused input-side serialization coverage after the final edit." },
          ],
          nonlocal_risk: "A narrowly green runtime result could leave static metadata, exports, or serialization inconsistent.",
        },
      }));
      const validTournament = spawnSync(process.execPath, [episode.tournament.artifact.path], { cwd: tournamentRoot, encoding: "utf8" });
      assert.equal(validTournament.status, 0, validTournament.stderr);
      assert.match(validTournament.stdout, /HUNCH_TOURNAMENT state=ready/);
      assert.match(validTournament.stdout, /closure=true/);
    } finally {
      cleanupDir(tournamentRoot);
    }
    assert.equal(episode.probes.length, 1, `${taskId} pilot must expose exactly one bounded falsification probe`);
    assert.deepEqual(normalizeExecutableProbes(episode.probes), episode.probes, `${taskId} probe must satisfy the runtime contract`);
    const compiled = compileExecutableProbes(episode.probes);
    assert.deepEqual(compiled.map((item) => item.phase), ["before-edit", "after-edit"]);
    assert.equal(episode.probes[0]!.expected_before.success, true, `${taskId} sandbox-safe baseline command must execute successfully`);
    assert.equal(episode.probes[0]!.expected_after.success, true, `${taskId} validation must be green`);
    assert.ok(episode.probes[0]!.expected_before.output_includes?.includes("state=red"), `${taskId} baseline must report red`);
    assert.ok(episode.probes[0]!.expected_after.output_includes?.includes("state=green"), `${taskId} validation must report green`);
    assert.match(episode.probes[0]!.command, /^node .*--import tsx\/esm \.hunch-probes\/[A-Za-z0-9._-]+\.ts$/);
    assert.ok(episode.probes[0]!.artifact, `${taskId} probe must have a materialized immutable artifact`);
    assert.match(episode.probes[0]!.artifact!.path, /^\.hunch-probes\/[A-Za-z0-9._-]+\.ts$/);
    assert.match(episode.probes[0]!.artifact!.content, /HUNCH_PROBE/);
    assert.ok(!JSON.stringify(episode.probes).includes(task!.fixSha), `${taskId} probe leaked its held-out fix`);
    for (const testFile of task!.testFiles) {
      assert.ok(!JSON.stringify(episode.probes[0]).includes(testFile), `${taskId} probe leaked hidden test path ${testFile}`);
      assert.ok(!JSON.stringify(episode.contrastive_probe).includes(testFile), `${taskId} contrastive probe leaked hidden test path ${testFile}`);
      assert.ok(!JSON.stringify(episode.contract_axis_probes ?? []).includes(testFile), `${taskId} axis probe leaked hidden test path ${testFile}`);
      assert.ok(!JSON.stringify(episode.tournament).includes(testFile), `${taskId} tournament leaked hidden test path ${testFile}`);
    }
  }
});

test("held-out static-parity episode has one independently biting compatibility closure", () => {
  const root = join(import.meta.dirname, "..");
  const suite = JSON.parse(readFileSync(join(root, "bench/external/zod-tasks.json"), "utf8")) as {
    tasks: Array<{ id: string; fixSha: string; testFiles: string[] }>;
  };
  const fixture = JSON.parse(readFileSync(
    join(root, "bench/external/zod-execution-episode-zod-5775.json"),
    "utf8",
  )) as {
    cutoff: string;
    mode: string;
    episodes: Record<string, {
      id: string;
      commits: string[];
      text: string;
      obligations: ExecutionObligation[];
      contrastive_probe: ExecutableProbe;
      contract_axis_probes: ExecutableProbe[];
    }>;
  };
  const task = suite.tasks.find((candidate) => candidate.id === "zod-5775")!;
  const episode = fixture.episodes[task.id]!;
  const issueContract = readFileSync(join(root, "bench/external/contracts/zod-5775.issue-contract.test.ts"), "utf8");

  assert.equal(fixture.mode, "task-relative");
  assert.equal(fixture.cutoff, "per-task-pre-fix-ancestry");
  assert.deepEqual(Object.keys(fixture.episodes), ["zod-5775"]);
  assert.match(issueContract, /HUNCH_ISSUE_CONTRACT_TYPECHECK/);
  assert.match(issueContract, /@ts-expect-error[\s\S]*z\.discriminatedUnion/);
  assert.match(issueContract, /@ts-expect-error[\s\S]*mini\.discriminatedUnion/);
  assert.ok(issueContract.length >= 1_000 && issueContract.length <= 5_000);
  assert.ok(episode.text.length >= 500 && episode.text.length <= 5_000);
  assert.match(episode.text, /GOAL/);
  assert.match(episode.text, /PROVING EVIDENCE/);
  assert.match(episode.text, /APPLICABILITY BOUNDARY/);
  assert.ok(!JSON.stringify(episode).includes(task.fixSha));
  assert.ok(!issueContract.includes(task.fixSha));
  for (const commit of episode.commits) assert.match(commit, /^[0-9a-f]{40}$/);
  assert.deepEqual(normalizeExecutionObligations(episode.obligations), episode.obligations);
  assert.deepEqual(normalizeExecutableProbes([episode.contrastive_probe]), [episode.contrastive_probe]);
  assert.deepEqual(normalizeExecutableProbes(episode.contract_axis_probes), episode.contract_axis_probes);

  const audit = auditExecutableProbeContractAxes(episode.contrastive_probe, episode.obligations);
  assert.deepEqual(audit.required, ["static", "compatibility"]);
  assert.deepEqual(audit.covered, ["runtime", "static"]);
  assert.deepEqual(audit.missing, ["compatibility"]);
  const closure = compileContractAxisProbeClosure(
    episode.contrastive_probe,
    episode.obligations,
    episode.contract_axis_probes,
  );
  assert.deepEqual(closure.probes.map((probe) => probe.category), ["compatibility"]);
  assert.equal(closure.probes[0]?.expected_before.output_includes?.includes("state=red"), true);
  assert.equal(closure.probes[0]?.expected_after.output_includes?.includes("state=green"), true);
  for (const hiddenTest of task.testFiles) {
    assert.ok(!JSON.stringify(episode).includes(hiddenTest), `held-out episode leaked hidden test path ${hiddenTest}`);
    assert.ok(!issueContract.includes(hiddenTest), `held-out contract leaked hidden test path ${hiddenTest}`);
  }
});

test("held-out empty-composite episode isolates Mini as one deferred compatibility consumer", () => {
  const root = join(import.meta.dirname, "..");
  const suite = JSON.parse(readFileSync(join(root, "bench/external/zod-tasks.json"), "utf8")) as {
    tasks: Array<{ id: string; fixSha: string; testFiles: string[] }>;
  };
  const fixture = JSON.parse(readFileSync(
    join(root, "bench/external/zod-execution-episode-zod-5868.json"),
    "utf8",
  )) as {
    cutoff: string;
    mode: string;
    episodes: Record<string, {
      commits: string[];
      text: string;
      obligations: ExecutionObligation[];
      contrastive_probe: ExecutableProbe;
      contract_axis_probes: ExecutableProbe[];
    }>;
  };
  const task = suite.tasks.find((candidate) => candidate.id === "zod-5868")!;
  const episode = fixture.episodes[task.id]!;
  const issueContract = readFileSync(join(root, "bench/external/contracts/zod-5868.issue-contract.test.ts"), "utf8");

  assert.equal(fixture.mode, "task-relative");
  assert.deepEqual(Object.keys(fixture.episodes), ["zod-5868"]);
  assert.ok(issueContract.length >= 1_000 && issueContract.length <= 5_000);
  assert.match(issueContract, /from "zod\/v4"/);
  assert.match(issueContract, /from "zod\/mini"/);
  assert.ok(episode.text.length >= 500 && episode.text.length <= 5_000);
  assert.match(episode.text, /GOAL/);
  assert.match(episode.text, /PROVING EVIDENCE/);
  assert.match(episode.text, /APPLICABILITY BOUNDARY/);
  assert.ok(!JSON.stringify(episode).includes(task.fixSha));
  assert.ok(!issueContract.includes(task.fixSha));
  assert.deepEqual(normalizeExecutionObligations(episode.obligations), episode.obligations);
  assert.deepEqual(normalizeExecutableProbes([episode.contrastive_probe]), [episode.contrastive_probe]);
  assert.deepEqual(normalizeExecutableProbes(episode.contract_axis_probes), episode.contract_axis_probes);

  const audit = auditExecutableProbeContractAxes(episode.contrastive_probe, episode.obligations);
  assert.deepEqual(audit.required, ["runtime", "compatibility"]);
  assert.deepEqual(audit.covered, ["runtime"]);
  assert.deepEqual(audit.missing, ["compatibility"]);
  const closure = compileContractAxisProbeClosure(
    episode.contrastive_probe,
    episode.obligations,
    episode.contract_axis_probes,
  );
  assert.deepEqual(closure.probes.map((probe) => probe.category), ["compatibility"]);
  assert.equal(closure.probes[0]?.expected_before.output_includes?.includes("state=red"), true);
  assert.equal(closure.probes[0]?.expected_after.output_includes?.includes("state=green"), true);
  for (const hiddenTest of task.testFiles) {
    assert.ok(!JSON.stringify(episode).includes(hiddenTest), `empty-composite episode leaked hidden test path ${hiddenTest}`);
    assert.ok(!issueContract.includes(hiddenTest), `empty-composite contract leaked hidden test path ${hiddenTest}`);
  }
});

test("runtime owner holdout preserves its pre-label predictions and authenticates scored probes", () => {
  const root = join(import.meta.dirname, "..");
  const base = join(root, "bench/external/results/2026-08-25-zod-runtime-owner-holdout-v3");
  const frozen = JSON.parse(readFileSync(`${base}.predictions.json`, "utf8")) as {
    prediction_hash: string;
    predictions: Array<{
      id: string;
      authenticated: boolean;
      observed: { pre_target: boolean | null; pre_control: boolean | null; post_target: boolean | null };
      top: Array<{ owner: string }>;
    }>;
  };
  const result = JSON.parse(readFileSync(`${base}.json`, "utf8")) as {
    prediction_hash: string;
    rows: Array<{ id: string; authenticated: boolean; top: Array<{ owner: string }> }>;
    summary: { tasks: number; authenticated_tasks: number; exact_symbol_correct: number };
  };

  assert.equal(createHash("sha256").update(JSON.stringify(frozen.predictions)).digest("hex"), frozen.prediction_hash);
  assert.equal(result.prediction_hash, frozen.prediction_hash);
  assert.equal(result.summary.tasks, frozen.predictions.length);
  assert.equal(result.summary.authenticated_tasks, frozen.predictions.filter((row) => row.authenticated).length);
  assert.equal(result.summary.exact_symbol_correct, 0, "the failed transfer result must not be silently promoted");
  assert.deepEqual(
    result.rows.map((row) => ({ id: row.id, authenticated: row.authenticated, top: row.top })),
    frozen.predictions.map((row) => ({ id: row.id, authenticated: row.authenticated, top: row.top })),
  );
  for (const row of frozen.predictions) {
    assert.equal(
      row.authenticated,
      row.observed.pre_target === false && row.observed.pre_control === true && row.observed.post_target === true,
      `${row.id} authentication must be derived from red/control/green evidence`,
    );
  }
});

test("correction-stage holdout preserves blind predictions and keeps exact-owner output disabled", () => {
  const root = join(import.meta.dirname, "..");
  const base = join(root, "bench/external/results/2026-08-25-zod-correction-stage-holdout-v1");
  const frozen = JSON.parse(readFileSync(`${base}.predictions.json`, "utf8")) as {
    prediction_hash: string;
    predictions: Array<{ id: string; top: Array<{ owner: string }> }>;
  };
  const result = JSON.parse(readFileSync(`${base}.json`, "utf8")) as {
    prediction_hash: string;
    rows: Array<{ id: string; top: Array<{ owner: string }> }>;
    summary: {
      tasks: number;
      top5_symbol_hits: number;
      correct_file: number;
      decision: string;
      exact_owner_policy: string;
    };
  };

  assert.equal(createHash("sha256").update(JSON.stringify(frozen.predictions)).digest("hex"), frozen.prediction_hash);
  assert.equal(result.prediction_hash, frozen.prediction_hash);
  assert.equal(result.summary.tasks, 11);
  assert.equal(result.summary.top5_symbol_hits, 8);
  assert.equal(result.summary.correct_file, 9);
  assert.equal(result.summary.decision, "retain-diagnostic-stage-shortlist");
  assert.equal(result.summary.exact_owner_policy, "disabled");
  assert.deepEqual(
    result.rows.map((row) => ({ id: row.id, top: row.top })),
    frozen.predictions.map((row) => ({ id: row.id, top: row.top })),
  );
});

test("cross-repository stage transfer preserves frozen inputs and the failed no-tuning verdict", () => {
  const root = join(import.meta.dirname, "..");
  const base = join(root, "bench/external/results/2026-08-25-cross-repo-correction-stage-transfer-v2");
  const tasks = JSON.parse(readFileSync(`${base}.tasks.json`, "utf8")) as {
    task_hash: string;
    tasks: unknown[];
  };
  const frozen = JSON.parse(readFileSync(`${base}.predictions.json`, "utf8")) as {
    task_hash: string;
    prediction_hash: string;
    predictions: Array<{ id: string; top: Array<{ owner: string }> }>;
  };
  const result = JSON.parse(readFileSync(`${base}.json`, "utf8")) as {
    task_hash: string;
    prediction_hash: string;
    rows: Array<{ id: string; top: Array<{ owner: string }> }>;
    summary: {
      tasks: number;
      scorable_tasks: number;
      top5_symbol_hits: number;
      correct_file: number;
      abstentions: number;
      decision: string;
      exact_owner_policy: string;
    };
  };

  assert.equal(createHash("sha256").update(JSON.stringify(tasks.tasks)).digest("hex"), tasks.task_hash);
  assert.equal(createHash("sha256").update(JSON.stringify(frozen.predictions)).digest("hex"), frozen.prediction_hash);
  assert.equal(frozen.task_hash, tasks.task_hash);
  assert.equal(result.task_hash, tasks.task_hash);
  assert.equal(result.prediction_hash, frozen.prediction_hash);
  assert.deepEqual(result.summary, {
    ...result.summary,
    tasks: 16,
    scorable_tasks: 16,
    top5_symbol_hits: 0,
    correct_file: 0,
    abstentions: 9,
    decision: "reject-cross-repository-transfer",
    exact_owner_policy: "disabled",
  });
  assert.deepEqual(
    result.rows.map((row) => ({ id: row.id, top: row.top })),
    frozen.predictions.map((prediction) => ({ id: prediction.id, top: prediction.top })),
  );
});

test("adaptive stage transfer preserves its locked algorithm, predictions, and diagnostic-only promotion", () => {
  const root = join(import.meta.dirname, "..");
  const base = join(root, "bench/external/results/2026-08-25-adaptive-stage-transfer-v1");
  const algorithm = readFileSync(join(root, "bench/external/adaptive-stage-ranker.ts"));
  const tasks = JSON.parse(readFileSync(`${base}.tasks.json`, "utf8")) as { algorithm_hash: string; task_hash: string; tasks: unknown[] };
  const frozen = JSON.parse(readFileSync(`${base}.predictions.json`, "utf8")) as { algorithm_hash: string; task_hash: string; prediction_hash: string; predictions: Array<{ id: string; top: Array<{ owner: string }> }> };
  const result = JSON.parse(readFileSync(`${base}.json`, "utf8")) as {
    algorithm_hash: string;
    task_hash: string;
    prediction_hash: string;
    rows: Array<{ id: string; top: Array<{ owner: string }> }>;
    summary: { tasks: number; scorable_tasks: number; exact_symbol_correct: number; top5_symbol_hits: number; correct_file: number; decision: string; exact_owner_policy: string };
  };
  const algorithmHash = createHash("sha256").update(algorithm).digest("hex");
  assert.equal(algorithmHash, "40ceb9b4e0baf826793705dfd377fee2fe11f0c5401d9bd64085dba960be996f");
  assert.equal(tasks.algorithm_hash, algorithmHash);
  assert.equal(frozen.algorithm_hash, algorithmHash);
  assert.equal(result.algorithm_hash, algorithmHash);
  assert.equal(createHash("sha256").update(JSON.stringify(tasks.tasks)).digest("hex"), tasks.task_hash);
  assert.equal(createHash("sha256").update(JSON.stringify(frozen.predictions)).digest("hex"), frozen.prediction_hash);
  assert.equal(frozen.task_hash, tasks.task_hash);
  assert.equal(result.task_hash, tasks.task_hash);
  assert.equal(result.prediction_hash, frozen.prediction_hash);
  assert.equal(result.summary.tasks, 12);
  assert.equal(result.summary.scorable_tasks, 11);
  assert.equal(result.summary.exact_symbol_correct, 7);
  assert.equal(result.summary.top5_symbol_hits, 9);
  assert.equal(result.summary.correct_file, 8);
  assert.equal(result.summary.decision, "promote-adaptive-diagnostic");
  assert.equal(result.summary.exact_owner_policy, "disabled");
  assert.deepEqual(result.rows.map((row) => ({ id: row.id, top: row.top })), frozen.predictions.map((prediction) => ({ id: prediction.id, top: prediction.top })));
});

test("score-gap confidence transfer preserves its frozen rejection", () => {
  const root = join(import.meta.dirname, "..");
  const base = join(root, "bench/external/results/2026-08-25-adaptive-stage-confidence-transfer-v2");
  const policyHash = createHash("sha256").update(readFileSync(join(root, "bench/external/adaptive-stage-confidence.ts"))).digest("hex");
  const tasks = JSON.parse(readFileSync(`${base}.tasks.json`, "utf8")) as { confidence_hash: string; task_hash: string; tasks: unknown[] };
  const frozen = JSON.parse(readFileSync(`${base}.predictions.json`, "utf8")) as { confidence_hash: string; task_hash: string; prediction_hash: string; predictions: Array<{ id: string; top: unknown[] }> };
  const result = JSON.parse(readFileSync(`${base}.json`, "utf8")) as {
    confidence_hash: string; task_hash: string; prediction_hash: string;
    rows: Array<{ id: string; top: unknown[] }>;
    summary: { scorable_tasks: number; supported_tasks: number; supported_top5_hits: number; decision: string; likely_file_confidence: string; exact_owner_policy: string };
  };
  assert.equal(policyHash, "f79dd7c5bae1f2028cd74a223a23422c38ef009737d4fb9ffd9ca3625169e514");
  assert.equal(tasks.confidence_hash, policyHash); assert.equal(frozen.confidence_hash, policyHash); assert.equal(result.confidence_hash, policyHash);
  assert.equal(createHash("sha256").update(JSON.stringify(tasks.tasks)).digest("hex"), tasks.task_hash);
  assert.equal(createHash("sha256").update(JSON.stringify(frozen.predictions)).digest("hex"), frozen.prediction_hash);
  assert.equal(frozen.task_hash, tasks.task_hash); assert.equal(result.task_hash, tasks.task_hash); assert.equal(result.prediction_hash, frozen.prediction_hash);
  assert.deepEqual({ ...result.summary }, { ...result.summary, scorable_tasks: 13, supported_tasks: 10, supported_top5_hits: 8, decision: "reject-shortlist-evidence", likely_file_confidence: "disabled", exact_owner_policy: "disabled" });
  assert.deepEqual(result.rows.map((row) => ({ id: row.id, top: row.top })), frozen.predictions.map((prediction) => ({ id: prediction.id, top: prediction.top })));
});

test("cross-view confidence transfer preserves its frozen rejection", () => {
  const root = join(import.meta.dirname, "..");
  const base = join(root, "bench/external/results/2026-08-25-adaptive-stage-view-consensus-transfer-v1");
  const policyHash = createHash("sha256").update(readFileSync(join(root, "bench/external/adaptive-stage-view-consensus.ts"))).digest("hex");
  const tasks = JSON.parse(readFileSync(`${base}.tasks.json`, "utf8")) as { policy_hash: string; task_hash: string; tasks: unknown[] };
  const frozen = JSON.parse(readFileSync(`${base}.predictions.json`, "utf8")) as { policy_hash: string; task_hash: string; prediction_hash: string; predictions: Array<{ id: string; views: { full: unknown[] } }> };
  const result = JSON.parse(readFileSync(`${base}.json`, "utf8")) as {
    policy_hash: string; task_hash: string; prediction_hash: string;
    rows: Array<{ id: string; top: unknown[] }>;
    summary: { scorable_tasks: number; baseline_top5_hits: number; supported_tasks: number; supported_top5_hits: number; decision: string; likely_file_confidence: string; exact_owner_policy: string };
  };
  assert.equal(policyHash, "69cacc6fe39682562a9d5fc2d5075a01524549ba23ee237f80891bb81f15ebd5");
  assert.equal(tasks.policy_hash, policyHash); assert.equal(frozen.policy_hash, policyHash); assert.equal(result.policy_hash, policyHash);
  assert.equal(createHash("sha256").update(JSON.stringify(tasks.tasks)).digest("hex"), tasks.task_hash);
  assert.equal(createHash("sha256").update(JSON.stringify(frozen.predictions)).digest("hex"), frozen.prediction_hash);
  assert.equal(frozen.task_hash, tasks.task_hash); assert.equal(result.task_hash, tasks.task_hash); assert.equal(result.prediction_hash, frozen.prediction_hash);
  assert.deepEqual({ ...result.summary }, { ...result.summary, scorable_tasks: 11, baseline_top5_hits: 5, supported_tasks: 9, supported_top5_hits: 4, decision: "reject-cross-view-evidence", likely_file_confidence: "disabled", exact_owner_policy: "disabled" });
  assert.deepEqual(result.rows.map((row) => ({ id: row.id, top: row.top })), frozen.predictions.map((prediction) => ({ id: prediction.id, top: prediction.views.full })));
});

test("causal-slot transfer preserves its frozen no-rescue rejection", () => {
  const root = join(import.meta.dirname, "..");
  const base = join(root, "bench/external/results/2026-08-25-adaptive-stage-causal-hybrid-transfer-v1");
  const causalHash = createHash("sha256").update(readFileSync(join(root, "bench/external/adaptive-stage-causal-ranker.ts"))).digest("hex");
  const tasks = JSON.parse(readFileSync(`${base}.tasks.json`, "utf8")) as { causal_hash: string; task_hash: string; tasks: unknown[] };
  const frozen = JSON.parse(readFileSync(`${base}.predictions.json`, "utf8")) as { causal_hash: string; task_hash: string; prediction_hash: string; predictions: Array<{ id: string; adaptive: unknown[]; hybrid: unknown[] }> };
  const result = JSON.parse(readFileSync(`${base}.json`, "utf8")) as {
    causal_hash: string; task_hash: string; prediction_hash: string;
    rows: Array<{ id: string; adaptive: unknown[]; hybrid: unknown[] }>;
    summary: { scorable_tasks: number; adaptive_top5_hits: number; hybrid_top5_hits: number; rescues: number; losses: number; decision: string; exact_owner_policy: string };
  };
  assert.equal(causalHash, "3c9afa460042b109c6505c9368ef70fabce528a155e921898a475d1e7a55e42b");
  assert.equal(tasks.causal_hash, causalHash); assert.equal(frozen.causal_hash, causalHash); assert.equal(result.causal_hash, causalHash);
  assert.equal(createHash("sha256").update(JSON.stringify(tasks.tasks)).digest("hex"), tasks.task_hash);
  assert.equal(createHash("sha256").update(JSON.stringify(frozen.predictions)).digest("hex"), frozen.prediction_hash);
  assert.equal(frozen.task_hash, tasks.task_hash); assert.equal(result.task_hash, tasks.task_hash); assert.equal(result.prediction_hash, frozen.prediction_hash);
  assert.deepEqual({ ...result.summary }, { ...result.summary, scorable_tasks: 9, adaptive_top5_hits: 6, hybrid_top5_hits: 6, rescues: 0, losses: 0, decision: "reject-causal-slot", exact_owner_policy: "disabled" });
  assert.deepEqual(result.rows.map((row) => ({ id: row.id, adaptive: row.adaptive, hybrid: row.hybrid })), frozen.predictions.map((prediction) => ({ id: prediction.id, adaptive: prediction.adaptive, hybrid: prediction.hybrid })));
});

test("causal-intervention transfer preserves its frozen precision failure", () => {
  const root = join(import.meta.dirname, "..");
  const base = join(root, "bench/external/results/2026-08-25-zod-causal-intervention-transfer-v1");
  const mechanismHash = createHash("sha256").update(readFileSync(join(root, "bench/external/causal-intervention.ts"))).digest("hex");
  const taskHash = createHash("sha256").update(readFileSync(`${base}.tasks.json`)).digest("hex");
  const frozen = JSON.parse(readFileSync(`${base}.predictions.json`, "utf8")) as {
    task_hash: string;
    prediction_hash: string;
    predictions: Array<{
      id: string;
      authenticated: boolean;
      observed: { pre_target: boolean | null; pre_control: boolean | null; post_target: boolean | null };
      predicted_owner: string | null;
      adjudication: unknown;
    }>;
  };
  const result = JSON.parse(readFileSync(`${base}.json`, "utf8")) as {
    hashes: { tasks: string; intervention: string; predictions: string };
    rows: Array<{ id: string; predicted_owner: string | null; adjudication: unknown }>;
    summary: {
      tasks: number;
      authenticated_tasks: number;
      scorable_tasks: number;
      predictions: number;
      exact: number;
      exact_precision: number;
      file_correct: number;
      incorrect_files: number;
      decision: string;
    };
  };
  assert.equal(mechanismHash, "e25ed0f4171c65bdab27a92b9c77debbc43af4ff23b0aba21c2d510341495cf4");
  assert.equal(taskHash, "eec7e8ac50c7759892ba442685d0cf3e355385806ec4a8ef957536bae84173cc");
  assert.equal(frozen.task_hash, taskHash);
  assert.equal(result.hashes.tasks, taskHash);
  assert.equal(result.hashes.intervention, mechanismHash);
  assert.equal(createHash("sha256").update(JSON.stringify(frozen.predictions)).digest("hex"), frozen.prediction_hash);
  assert.equal(frozen.prediction_hash, "e23d5c6eb614df3d4de368add18ad78ff310e6ad2f8de02d688dd608bffe4d3f");
  assert.equal(result.hashes.predictions, frozen.prediction_hash);
  assert.deepEqual(result.summary, {
    ...result.summary,
    tasks: 9,
    authenticated_tasks: 8,
    scorable_tasks: 8,
    predictions: 2,
    exact: 1,
    exact_precision: 0.5,
    file_correct: 2,
    incorrect_files: 0,
    decision: "reject-causal-intervention-owner",
  });
  assert.deepEqual(
    result.rows.map((row) => ({ id: row.id, predicted_owner: row.predicted_owner, adjudication: row.adjudication })),
    frozen.predictions.map((row) => ({ id: row.id, predicted_owner: row.predicted_owner, adjudication: row.adjudication })),
  );
  for (const row of frozen.predictions) {
    assert.equal(row.authenticated, row.observed.pre_target === false && row.observed.pre_control === true && row.observed.post_target === true);
  }
});

test("evidence-optimization transfers preserve blind predictions, receipts, and honest verdicts", () => {
  const root = join(import.meta.dirname, "..");
  const cases = [
    {
      name: "2026-08-25-evidence-guided-optimization-transfer-v1",
      scorable: 6, baseline: 4, optimized: 4, decision: "reject-evidence-guided-shortlist-v1",
    },
    {
      name: "2026-08-25-evidence-file-reserve-transfer-v2",
      scorable: 6, baseline: 4, optimized: 3, decision: "reject-evidence-file-reserve-v2",
    },
    {
      name: "2026-08-25-guarded-evidence-bridge-transfer-v3",
      scorable: 5, baseline: 1, optimized: 1, decision: "reject-guarded-evidence-bridge-v3",
    },
  ];
  for (const entry of cases) {
    const base = join(root, "bench/external/results", entry.name);
    const taskHash = createHash("sha256").update(readFileSync(`${base}.tasks.json`)).digest("hex");
    const frozen = JSON.parse(readFileSync(`${base}.predictions.json`, "utf8")) as {
      hashes: { tasks: string; predictions: string; optimization_receipts: string };
      predictions: Array<{ optimization_receipt: { receipt_id: string; exact_owner_enabled: boolean } }>;
    };
    const result = JSON.parse(readFileSync(`${base}.json`, "utf8")) as {
      hashes: { tasks: string; predictions: string; optimization_receipts: string };
      rows: Array<{ optimization_receipt: { receipt_id: string; exact_owner_enabled: boolean } }>;
      summary: { scorable_tasks: number; baseline_top5_hits: number; optimized_top5_hits: number; losses: number; optimization_receipts_complete: boolean; decision: string; exact_owner_policy: string };
    };
    const predictionHash = createHash("sha256").update(JSON.stringify(frozen.predictions)).digest("hex");
    const receiptHash = createHash("sha256").update(JSON.stringify(frozen.predictions.map((row) => row.optimization_receipt))).digest("hex");
    assert.equal(frozen.hashes.tasks, taskHash, `${entry.name} task hash`);
    assert.equal(result.hashes.tasks, taskHash, `${entry.name} result task hash`);
    assert.equal(frozen.hashes.predictions, predictionHash, `${entry.name} prediction hash`);
    assert.equal(result.hashes.predictions, predictionHash, `${entry.name} result prediction hash`);
    assert.equal(frozen.hashes.optimization_receipts, receiptHash, `${entry.name} receipt hash`);
    assert.equal(result.hashes.optimization_receipts, receiptHash, `${entry.name} result receipt hash`);
    assert.deepEqual(result.rows.map((row) => row.optimization_receipt), frozen.predictions.map((row) => row.optimization_receipt));
    assert.deepEqual(result.summary, {
      ...result.summary,
      scorable_tasks: entry.scorable,
      baseline_top5_hits: entry.baseline,
      optimized_top5_hits: entry.optimized,
      losses: entry.name.includes("transfer-v2") ? 1 : 0,
      optimization_receipts_complete: true,
      decision: entry.decision,
      exact_owner_policy: "disabled",
    });
    for (const row of frozen.predictions) {
      assert.match(row.optimization_receipt.receipt_id, /^[a-f0-9]{24}$/);
      assert.equal(row.optimization_receipt.exact_owner_enabled, false);
    }
  }
});

test("file-cluster transfer preserves blind predictions, receipts, and its supplemental promotion", () => {
  const root = join(import.meta.dirname, "..");
  const base = join(root, "bench/external/results/2026-08-25-flat-file-anchored-clusters-transfer-v3");
  const taskHash = createHash("sha256").update(readFileSync(`${base}.tasks.json`)).digest("hex");
  const frozen = JSON.parse(readFileSync(`${base}.predictions.json`, "utf8")) as {
    hashes: { tasks: string; predictions: string; receipts: string };
    predictions: Array<{
      id: string;
      baseline_top5: string[];
      file_first_declaration_clusters: {
        files: unknown[];
        receipt: {
          version: number;
          rule: string;
          file_limit: number;
          cluster_limit_per_file: number;
          member_limit_per_cluster: number;
          file_selection_strategy: string;
          flat_shortlist_preserved: boolean;
          exact_owner_enabled: boolean;
          receipt_id: string;
        };
      };
    }>;
  };
  const result = JSON.parse(readFileSync(`${base}.json`, "utf8")) as {
    hashes: { tasks: string; predictions: string; receipts: string };
    rows: Array<{
      id: string;
      baseline_top5: string[];
      file_first_declaration_clusters: { files: unknown[]; receipt: unknown };
    }>;
    summary: {
      tasks: number;
      scorable_tasks: number;
      baseline_top5_hits: number;
      baseline_top5_rate: number;
      cluster_hits: number;
      cluster_rate: number;
      combined_hits: number;
      combined_rate: number;
      combined_improvement_points: number;
      cluster_rescues: number;
      cluster_losses: number;
      baseline_file_hits: number;
      cluster_file_hits: number;
      cluster_file_rate: number;
      average_inspected_declarations: number;
      max_inspected_declarations: number;
      receipts_complete: boolean;
      flat_shortlist_preserved: boolean;
      decision: string;
      exact_owner_policy: string;
    };
  };
  const predictionHash = createHash("sha256").update(JSON.stringify(frozen.predictions)).digest("hex");
  const receiptHash = createHash("sha256")
    .update(JSON.stringify(frozen.predictions.map((row) => row.file_first_declaration_clusters.receipt)))
    .digest("hex");

  assert.equal(taskHash, "da08d983f81298f66f762e277b0f07aae38a8ed0c27ccb4139b7c3d8938df7dd");
  assert.equal(frozen.hashes.tasks, taskHash);
  assert.equal(result.hashes.tasks, taskHash);
  assert.equal(predictionHash, "85549f691d56ea3f3048212ba5d947f6522a1828cbca5c3bad4abf9c9f05fa80");
  assert.equal(frozen.hashes.predictions, predictionHash);
  assert.equal(result.hashes.predictions, predictionHash);
  assert.equal(receiptHash, "1397f285864e90d3fb1850667fa600cd7c275c587307de376aac3a25547c0fdf");
  assert.equal(frozen.hashes.receipts, receiptHash);
  assert.equal(result.hashes.receipts, receiptHash);
  assert.deepEqual(
    result.rows.map((row) => ({
      id: row.id,
      baseline_top5: row.baseline_top5,
      file_first_declaration_clusters: row.file_first_declaration_clusters,
    })),
    frozen.predictions.map((row) => ({
      id: row.id,
      baseline_top5: row.baseline_top5,
      file_first_declaration_clusters: row.file_first_declaration_clusters,
    })),
  );
  assert.deepEqual(result.summary, {
    ...result.summary,
    tasks: 12,
    scorable_tasks: 12,
    baseline_top5_hits: 3,
    baseline_top5_rate: 0.25,
    cluster_hits: 5,
    cluster_rate: 5 / 12,
    combined_hits: 6,
    combined_rate: 0.5,
    combined_improvement_points: 0.25,
    cluster_rescues: 3,
    cluster_losses: 1,
    baseline_file_hits: 8,
    cluster_file_hits: 10,
    cluster_file_rate: 10 / 12,
    average_inspected_declarations: 18.833333333333332,
    max_inspected_declarations: 24,
    receipts_complete: true,
    flat_shortlist_preserved: true,
    decision: "promote-flat-file-anchored-clusters-v3",
    exact_owner_policy: "disabled",
  });
  for (const row of frozen.predictions) {
    const receipt = row.file_first_declaration_clusters.receipt;
    assert.equal(receipt.version, 3);
    assert.equal(receipt.rule, "flat-file-anchored-semantic-clusters-v3");
    assert.equal(receipt.file_limit, 5);
    assert.equal(receipt.cluster_limit_per_file, 2);
    assert.equal(receipt.member_limit_per_cluster, 3);
    assert.equal(receipt.file_selection_strategy, "flat-shortlist-file-anchor");
    assert.equal(receipt.flat_shortlist_preserved, true);
    assert.equal(receipt.exact_owner_enabled, false);
    assert.match(receipt.receipt_id, /^[a-f0-9]{24}$/);
  }
});

test("progressive inspection transfer preserves its blind efficiency receipt and negative accuracy verdict", () => {
  const root = join(import.meta.dirname, "..");
  const base = join(root, "bench/external/results/2026-08-25-progressive-inspection-transfer-v4");
  const taskHash = createHash("sha256").update(readFileSync(`${base}.tasks.json`)).digest("hex");
  const frozen = JSON.parse(readFileSync(`${base}.predictions.json`, "utf8")) as {
    hashes: { tasks: string; predictions: string; receipts: string };
    predictions: Array<{
      id: string;
      baseline_top5: string[];
      file_first_declaration_clusters: unknown;
      progressive_inspection: { receipt: { receipt_id: string; exact_owner_enabled: boolean } };
    }>;
  };
  const result = JSON.parse(readFileSync(`${base}.json`, "utf8")) as {
    hashes: { tasks: string; predictions: string; receipts: string };
    rows: typeof frozen.predictions;
    summary: Record<string, unknown>;
  };
  const predictionHash = createHash("sha256").update(JSON.stringify(frozen.predictions)).digest("hex");
  const receiptHash = createHash("sha256")
    .update(JSON.stringify(frozen.predictions.map((row) => row.progressive_inspection.receipt)))
    .digest("hex");

  assert.equal(taskHash, "f040c672ff8ef41be16218212ea28e94bf19fe9041ff696a06cf355e19a31250");
  assert.equal(frozen.hashes.tasks, taskHash);
  assert.equal(result.hashes.tasks, taskHash);
  assert.equal(predictionHash, "d361129e05cbe45caabf407d8fd445a673cb24ef1e4adb87ef79b5d64f8237d0");
  assert.equal(frozen.hashes.predictions, predictionHash);
  assert.equal(result.hashes.predictions, predictionHash);
  assert.equal(receiptHash, "44e905aca46393c7602b10bdb365bcf4bb817256b6ad312e6a410fe069e396d8");
  assert.equal(frozen.hashes.receipts, receiptHash);
  assert.equal(result.hashes.receipts, receiptHash);
  assert.deepEqual(result.rows.map((row) => ({
    id: row.id,
    baseline_top5: row.baseline_top5,
    file_first_declaration_clusters: row.file_first_declaration_clusters,
    progressive_inspection: row.progressive_inspection,
  })), frozen.predictions.map((row) => ({
    id: row.id,
    baseline_top5: row.baseline_top5,
    file_first_declaration_clusters: row.file_first_declaration_clusters,
    progressive_inspection: row.progressive_inspection,
  })));
  assert.deepEqual(result.summary, {
    tasks: 12,
    scorable_tasks: 12,
    baseline_top5_hits: 5,
    through_ten_hits: 5,
    progressive_hits: 5,
    full_cluster_union_hits: 5,
    progressive_rescues: 0,
    losses_against_full_union: 0,
    baseline_file_hits: 7,
    cluster_file_hits: 7,
    average_inspected_declarations: 11,
    max_inspected_declarations: 11,
    average_full_cluster_declarations: 18.916666666666668,
    inspection_reduction: 0.41850220264317184,
    baseline_preserved: true,
    receipts_complete: true,
    decision: "reject-progressive-inspection-v4",
    exact_owner_policy: "disabled",
  });
  for (const row of frozen.predictions) {
    assert.match(row.progressive_inspection.receipt.receipt_id, /^[a-f0-9]{24}$/);
    assert.equal(row.progressive_inspection.receipt.exact_owner_enabled, false);
  }
});

test("additive frontier transfer preserves blind receipts and cannot enter production after zero rescues", () => {
  const root = join(import.meta.dirname, "..");
  const base = join(root, "bench/external/results/2026-08-25-additive-frontier-transfer-v5");
  const taskHash = createHash("sha256").update(readFileSync(`${base}.tasks.json`)).digest("hex");
  const frozen = JSON.parse(readFileSync(`${base}.predictions.json`, "utf8")) as {
    hashes: { tasks: string; predictions: string; receipts: string };
    predictions: Array<{
      id: string;
      baseline_top5: string[];
      clusters: unknown;
      promoted_plan: unknown;
      additive_plan: { added_frontier_slots: number; owners: string[]; receipt_id: string };
    }>;
  };
  const result = JSON.parse(readFileSync(`${base}.json`, "utf8")) as {
    hashes: { tasks: string; predictions: string; receipts: string };
    rows: typeof frozen.predictions;
    summary: Record<string, unknown>;
  };
  const predictionHash = createHash("sha256").update(JSON.stringify(frozen.predictions)).digest("hex");
  const receiptHash = createHash("sha256")
    .update(JSON.stringify(frozen.predictions.map((row) => row.additive_plan.receipt_id)))
    .digest("hex");

  assert.equal(taskHash, "18d5bceeb0290dc56cbaac281103f677c0e1ed51970048ed78bebdee02807b5f");
  assert.equal(frozen.hashes.tasks, taskHash);
  assert.equal(result.hashes.tasks, taskHash);
  assert.equal(predictionHash, "d56383476c016a136d4d6aba360d8a853c03f900e2e1b6eea56b5faffb91fb14");
  assert.equal(frozen.hashes.predictions, predictionHash);
  assert.equal(result.hashes.predictions, predictionHash);
  assert.equal(receiptHash, "58d5317fad93ad0322f542ac8f64b22696ec74c10c253e17cecbbef4dac869fc");
  assert.equal(frozen.hashes.receipts, receiptHash);
  assert.equal(result.hashes.receipts, receiptHash);
  assert.deepEqual(result.rows.map((row) => ({
    id: row.id,
    baseline_top5: row.baseline_top5,
    clusters: row.clusters,
    promoted_plan: row.promoted_plan,
    additive_plan: row.additive_plan,
  })), frozen.predictions.map((row) => ({
    id: row.id,
    baseline_top5: row.baseline_top5,
    clusters: row.clusters,
    promoted_plan: row.promoted_plan,
    additive_plan: row.additive_plan,
  })));
  assert.deepEqual(result.summary, {
    tasks: 12,
    scorable_tasks: 12,
    baseline_top5_hits: 0,
    promoted_plan_hits: 3,
    additive_plan_hits: 3,
    additive_rescues: 0,
    losses_against_promoted: 0,
    average_inspected_declarations: 12.833333333333334,
    max_inspected_declarations: 13,
    average_full_cluster_declarations: 19.666666666666668,
    inspection_reduction: 0.34745762711864403,
    baseline_and_promoted_preserved: true,
    appended_same_file_only: true,
    receipts_complete: true,
    decision: "reject-additive-frontier-v5",
    exact_owner_policy: "disabled",
  });
  for (const row of frozen.predictions) {
    assert.equal(row.additive_plan.added_frontier_slots, 2);
    assert.ok(row.additive_plan.owners.length <= 13);
    assert.match(row.additive_plan.receipt_id, /^[a-f0-9]{24}$/);
  }
});
