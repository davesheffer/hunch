/**
 * Targeted replication of the schema-namespace merge observed in capacity
 * stress v4. Each trajectory contains exactly one case and five sequential
 * rewrites starting from the frozen, pre-merge round-25 memory.
 *
 *   npx tsx bench/external/run-schema-collision-replication.ts --dry-run --trajectory-index 1
 *   npx tsx bench/external/run-schema-collision-replication.ts --trajectory-index 1
 */
import { spawnSync } from "node:child_process";
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import {
  STRESS_TARGET_WORDS,
  STRESS_WORD_CAP,
  buildStressCases,
  parseStressStructuredResult,
  stressNormalizeExact,
  stressSha256,
  stressWordCount,
  validateStressMemoryText,
} from "./run-consolidation-memory-stress.js";

export const COLLISION_TRAJECTORIES = 18;
export const COLLISION_REWRITES = 5;
export const COLLISION_CONDITIONS = ["baseline", "additive", "rewritten", "rescue"] as const;
export type CollisionCondition = typeof COLLISION_CONDITIONS[number];

export interface CollisionFixture {
  case_id: string;
  case_name: string;
  source_snapshot: string;
  updates: string[];
  production_schema_namespace: string;
  prototype_schema_namespace: string;
}

export interface CollisionAnswer {
  production_schema_namespace: string;
  prototype_schema_namespace: string;
}

export interface CollisionConditionScore {
  condition: CollisionCondition;
  production_expected: string;
  production_observed: string;
  production_correct: boolean;
  prototype_expected: string;
  prototype_observed: string;
  prototype_correct: boolean;
  semantic_merge_signature: boolean;
}

export interface CollisionPairedScore {
  harm: boolean;
  win: boolean;
  rescued_harm: boolean;
  semantic_merge_harm: boolean;
}

interface CollisionClaudeCall {
  role: "replacement_update" | "downstream_qa";
  duration_ms: number;
  prompt_sha256: string;
  raw_stdout: string;
  raw_stderr: string;
  envelope: Record<string, unknown>;
  parsed: unknown;
}

interface CollisionCheckpoint {
  step: number;
  source_round: number;
  observation: string;
  memory_text: string;
  words: number;
  contains_production_literal: boolean;
  contains_prototype_literal: boolean;
  call: CollisionClaudeCall;
}

interface CollisionResult {
  schema_version: 1;
  protocol_version: 5;
  experiment: "hunch-schema-collision-targeted-replication";
  status: "running" | "complete" | "infrastructure_failure";
  trajectory_index: number;
  case_id: string;
  case_name: string;
  case_replicate: number;
  started_at: string;
  completed_at?: string;
  model: string;
  claude_cli_version: string;
  git_head: string;
  runner_sha256: string;
  fixture_source_sha256: string;
  fixture_sha256: string;
  system_prompt_sha256: string;
  condition_order: CollisionCondition[];
  checkpoints: CollisionCheckpoint[];
  qa_calls: Partial<Record<CollisionCondition, CollisionClaudeCall>>;
  condition_scores?: Record<CollisionCondition, CollisionConditionScore>;
  paired_score?: CollisionPairedScore;
  failure?: { message: string; stack?: string };
}

const THIS_FILE = fileURLToPath(import.meta.url);
const BENCH_DIR = import.meta.dirname;
const RESULTS_DIR = join(BENCH_DIR, "results");
const SOURCE_RESULT_PATH = join(RESULTS_DIR, "2026-08-27-hunch-direct-memory-capacity-stress-v4-repeat-3.json");
export const SOURCE_RESULT_SHA256 = "7a1c098f913993fba2c3732110c487edfc4a9b0c6b52348b58b69f31750e9244";
const DEFAULT_MODEL = "claude-sonnet-5";
const SYSTEM_PROMPT = [
  "You are executing a controlled textual-memory replication.",
  "Use only the supplied memory and observation, follow the transformation or extraction request exactly,",
  "and return only data matching the provided JSON schema. Never use tools or outside knowledge.",
].join(" ");

const UPDATE_SCHEMA = {
  type: "object",
  properties: { memory_text: { type: "string" } },
  required: ["memory_text"],
  additionalProperties: false,
} as const;

const QA_SCHEMA = {
  type: "object",
  properties: {
    production_schema_namespace: { type: "string" },
    prototype_schema_namespace: { type: "string" },
  },
  required: ["production_schema_namespace", "prototype_schema_namespace"],
  additionalProperties: false,
} as const;

export function loadCollisionFixtures(path = SOURCE_RESULT_PATH): CollisionFixture[] {
  const sourceBytes = readFileSync(path);
  const actualHash = stressSha256(sourceBytes);
  if (actualHash !== SOURCE_RESULT_SHA256) throw new Error(`frozen v4 source hash mismatch: ${actualHash}`);
  const source = JSON.parse(sourceBytes.toString("utf8")) as {
    status?: string;
    repeat_index?: number;
    checkpoints?: Array<{
      round: number;
      observation_by_case: Record<string, string>;
      memories: Array<{ case_id: string; memory_text: string }>;
    }>;
  };
  if (source.status !== "complete" || source.repeat_index !== 3 || source.checkpoints?.length !== 30) {
    throw new Error("frozen v4 source is not the complete repeat-3 record");
  }
  const round25 = source.checkpoints.find((checkpoint) => checkpoint.round === 25);
  if (!round25) throw new Error("frozen v4 source has no round-25 checkpoint");
  const later = [26, 27, 28, 29, 30].map((round) => {
    const checkpoint = source.checkpoints!.find((candidate) => candidate.round === round);
    if (!checkpoint) throw new Error(`frozen v4 source has no round-${round} checkpoint`);
    return checkpoint;
  });
  const stressCases = buildStressCases();
  const fixtures = stressCases.map((item) => {
    const snapshot = round25.memories.find((memory) => memory.case_id === item.id)?.memory_text;
    if (!snapshot) throw new Error(`${item.id}: missing round-25 snapshot`);
    const stem = item.id.split("-")[0]!;
    const production = item.protected.schema_namespace;
    const prototype = `${stem}.prototype`;
    if (!snapshot.includes(`schema_namespace=${production}`) || !snapshot.includes(`prototype_schema_namespace=${prototype}`)) {
      throw new Error(`${item.id}: source snapshot does not preserve separate namespace fields`);
    }
    return {
      case_id: item.id,
      case_name: item.name,
      source_snapshot: snapshot,
      updates: later.map((checkpoint) => checkpoint.observation_by_case[item.id]!),
      production_schema_namespace: production,
      prototype_schema_namespace: prototype,
    };
  });
  validateCollisionFixtures(fixtures);
  return fixtures;
}

export function validateCollisionFixtures(fixtures: CollisionFixture[]): void {
  if (fixtures.length !== 6) throw new Error("collision replication requires exactly 6 case fixtures");
  const ids = new Set<string>();
  for (const fixture of fixtures) {
    if (ids.has(fixture.case_id)) throw new Error(`duplicate collision fixture: ${fixture.case_id}`);
    ids.add(fixture.case_id);
    if (fixture.updates.length !== COLLISION_REWRITES || fixture.updates.some((update) => !update?.trim())) {
      throw new Error(`${fixture.case_id}: exactly ${COLLISION_REWRITES} non-empty updates required`);
    }
    if (stressWordCount(fixture.source_snapshot) > STRESS_WORD_CAP) throw new Error(`${fixture.case_id}: source snapshot exceeds word cap`);
    if (fixture.production_schema_namespace === fixture.prototype_schema_namespace) throw new Error(`${fixture.case_id}: namespace controls must differ`);
    const normalized = stressNormalizeExact(fixture.source_snapshot);
    if (!normalized.includes(stressNormalizeExact(fixture.production_schema_namespace))) throw new Error(`${fixture.case_id}: production namespace absent`);
    if (!normalized.includes(stressNormalizeExact(fixture.prototype_schema_namespace))) throw new Error(`${fixture.case_id}: prototype namespace absent`);
  }
}

export function collisionAssignment(trajectoryIndex: number, fixtures = loadCollisionFixtures()): { fixture: CollisionFixture; caseReplicate: number } {
  if (!Number.isSafeInteger(trajectoryIndex) || trajectoryIndex < 1 || trajectoryIndex > COLLISION_TRAJECTORIES) {
    throw new Error(`trajectory index must be 1..${COLLISION_TRAJECTORIES}`);
  }
  return {
    fixture: fixtures[(trajectoryIndex - 1) % fixtures.length]!,
    caseReplicate: Math.floor((trajectoryIndex - 1) / fixtures.length) + 1,
  };
}

function rotate<T>(values: readonly T[], offset: number): T[] {
  const at = ((offset % values.length) + values.length) % values.length;
  return [...values.slice(at), ...values.slice(0, at)];
}

export function collisionConditionOrder(trajectoryIndex: number): CollisionCondition[] {
  return rotate(COLLISION_CONDITIONS, trajectoryIndex - 1);
}

export function buildCollisionUpdatePrompt(fixture: CollisionFixture, memory: string, step: number): string {
  if (!Number.isSafeInteger(step) || step < 1 || step > COLLISION_REWRITES) throw new Error(`invalid collision step: ${step}`);
  return [
    `Replace the existing memory for ${fixture.case_name} with one self-contained consolidated memory.`,
    "The new observation is non-conflicting. Incorporate it and preserve as many useful existing facts as fit.",
    `The ${STRESS_WORD_CAP}-word maximum is absolute and takes priority over completeness; target at most ${STRESS_TARGET_WORDS} words for headroom.`,
    "Use compact key=value clauses and omit lower-priority details when necessary.",
    "",
    "EXISTING MEMORY:",
    memory,
    "",
    "NEW OBSERVATION:",
    fixture.updates[step - 1],
  ].join("\n");
}

export function buildCollisionPackets(fixture: CollisionFixture, rewritten: string): Record<CollisionCondition, string> {
  return {
    baseline: `PRE-MERGE MEMORY\n${fixture.source_snapshot}`,
    additive: [
      "IMMUTABLE MEMORY LOG — records remain distinct and later records do not replace earlier records.",
      `PRE-MERGE RECORD\n${fixture.source_snapshot}`,
      ...fixture.updates.map((update, index) => `UPDATE RECORD ${index + 1}\n${update}`),
    ].join("\n\n"),
    rewritten: `CONSOLIDATED MEMORY\n${rewritten}`,
    rescue: [
      `CONSOLIDATED MEMORY\n${rewritten}`,
      "AUTHORITATIVE NAMESPACE RECORD — these are two distinct namespaces:",
      `production_schema_namespace=${fixture.production_schema_namespace}`,
      `prototype_schema_namespace=${fixture.prototype_schema_namespace}`,
    ].join("\n"),
  };
}

export function buildCollisionQaPrompt(fixture: CollisionFixture, packet: string): string {
  return [
    `Use only the MEMORY for ${fixture.case_name}. Copy present values exactly and do not combine them.`,
    "If a requested value is absent, return exactly UNKNOWN.",
    "Question 1: What is the production schema namespace?",
    "Question 2: What is the prototype schema namespace?",
    "",
    "MEMORY:",
    packet,
  ].join("\n");
}

function assertCollisionAnswer(value: unknown): asserts value is CollisionAnswer {
  const candidate = value as Partial<CollisionAnswer>;
  if (typeof candidate?.production_schema_namespace !== "string" || typeof candidate?.prototype_schema_namespace !== "string") {
    throw new Error("collision QA response must contain both namespace strings");
  }
}

export function scoreCollisionCondition(fixture: CollisionFixture, condition: CollisionCondition, answer: CollisionAnswer): CollisionConditionScore {
  const productionObserved = answer.production_schema_namespace;
  const prototypeObserved = answer.prototype_schema_namespace;
  const productionCorrect = stressNormalizeExact(productionObserved) === stressNormalizeExact(fixture.production_schema_namespace);
  const prototypeCorrect = stressNormalizeExact(prototypeObserved) === stressNormalizeExact(fixture.prototype_schema_namespace);
  const normalizedObserved = stressNormalizeExact(productionObserved);
  return {
    condition,
    production_expected: fixture.production_schema_namespace,
    production_observed: productionObserved,
    production_correct: productionCorrect,
    prototype_expected: fixture.prototype_schema_namespace,
    prototype_observed: prototypeObserved,
    prototype_correct: prototypeCorrect,
    semantic_merge_signature: !productionCorrect
      && normalizedObserved.includes(stressNormalizeExact(fixture.production_schema_namespace))
      && normalizedObserved.includes("prototype"),
  };
}

export function pairedCollisionScore(scores: Record<CollisionCondition, CollisionConditionScore>): CollisionPairedScore {
  const harm = scores.additive.production_correct && !scores.rewritten.production_correct;
  return {
    harm,
    win: !scores.additive.production_correct && scores.rewritten.production_correct,
    rescued_harm: harm && scores.rescue.production_correct,
    semantic_merge_harm: harm && scores.rewritten.semantic_merge_signature,
  };
}

function strippedSubscriptionEnv(): NodeJS.ProcessEnv {
  const env = { ...process.env, CI: "1", NO_COLOR: "1", FORCE_COLOR: "0", CLAUDE_CODE_SAFE_MODE: "1" };
  for (const key of [
    "ANTHROPIC_API_KEY", "ANTHROPIC_AUTH_TOKEN", "ANTHROPIC_BASE_URL",
    "CLAUDE_CODE_USE_BEDROCK", "CLAUDE_CODE_USE_VERTEX",
    "ANTHROPIC_BEDROCK_BASE_URL", "ANTHROPIC_VERTEX_BASE_URL",
    "ANTHROPIC_VERTEX_PROJECT_ID", "CLOUD_ML_REGION",
  ]) delete env[key];
  return env;
}

function runClaude(prompt: string, schema: object, model: string, role: CollisionClaudeCall["role"]): CollisionClaudeCall {
  const started = Date.now();
  const args = [
    "-p", "--safe-mode", "--disable-slash-commands", "--no-session-persistence",
    "--prompt-suggestions", "false", "--tools", "", "--output-format", "json",
    "--json-schema", JSON.stringify(schema), "--system-prompt", SYSTEM_PROMPT,
    "--model", model, "--max-turns", "2",
  ];
  const run = spawnSync("claude", args, {
    cwd: tmpdir(),
    input: prompt,
    encoding: "utf8",
    env: strippedSubscriptionEnv(),
    timeout: 180_000,
    maxBuffer: 16 * 1024 * 1024,
    shell: false,
  });
  const rawStdout = run.stdout ?? "";
  const rawStderr = run.stderr ?? "";
  if (run.error) throw new Error(`claude execution failed: ${run.error.message}`);
  if (run.status !== 0) throw new Error(`claude exited ${run.status}: ${rawStderr.trim() || rawStdout.trim()}`);
  const { envelope, parsed } = parseStressStructuredResult(rawStdout);
  return {
    role,
    duration_ms: Date.now() - started,
    prompt_sha256: stressSha256(prompt),
    raw_stdout: rawStdout,
    raw_stderr: rawStderr,
    envelope,
    parsed,
  };
}

function commandVersion(command: string, args: string[]): string {
  const run = spawnSync(command, args, { cwd: BENCH_DIR, encoding: "utf8", timeout: 8_000, shell: false });
  if (run.error || run.status !== 0) throw new Error(`${command} is unavailable`);
  return (run.stdout || run.stderr).trim().split(/\r?\n/)[0]?.trim() ?? "unknown";
}

function parseArgs(argv: string[]): { trajectoryIndex: number; dryRun: boolean; model: string; resultsDir: string } {
  const value = (name: string, fallback: string): string => {
    const at = argv.indexOf(`--${name}`);
    return at >= 0 && argv[at + 1] ? argv[at + 1]! : fallback;
  };
  const trajectoryIndex = Number(value("trajectory-index", "1"));
  if (!Number.isSafeInteger(trajectoryIndex) || trajectoryIndex < 1 || trajectoryIndex > COLLISION_TRAJECTORIES) {
    throw new Error(`--trajectory-index must be 1..${COLLISION_TRAJECTORIES}`);
  }
  return {
    trajectoryIndex,
    dryRun: argv.includes("--dry-run"),
    model: value("model", DEFAULT_MODEL),
    resultsDir: resolve(value("results-dir", RESULTS_DIR)),
  };
}

export function collisionDryRunSummary(trajectoryIndex: number): Record<string, unknown> {
  const fixtures = loadCollisionFixtures();
  const { fixture, caseReplicate } = collisionAssignment(trajectoryIndex, fixtures);
  const firstPrompt = buildCollisionUpdatePrompt(fixture, fixture.source_snapshot, 1);
  const placeholderPackets = buildCollisionPackets(fixture, "[MODEL-GENERATED FINAL MEMORY]");
  return {
    valid: true,
    no_model_calls_made: true,
    protocol_version: 5,
    trajectory_index: trajectoryIndex,
    case_id: fixture.case_id,
    case_replicate: caseReplicate,
    independent_trajectories: COLLISION_TRAJECTORIES,
    rewrites_per_trajectory: COLLISION_REWRITES,
    planned_calls_per_trajectory: COLLISION_REWRITES + COLLISION_CONDITIONS.length,
    condition_order: collisionConditionOrder(trajectoryIndex),
    fixture_source_sha256: SOURCE_RESULT_SHA256,
    fixture_sha256: stressSha256(JSON.stringify(fixture)),
    runner_sha256: stressSha256(readFileSync(THIS_FILE)),
    system_prompt_sha256: stressSha256(SYSTEM_PROMPT),
    update_schema_sha256: stressSha256(JSON.stringify(UPDATE_SCHEMA)),
    qa_schema_sha256: stressSha256(JSON.stringify(QA_SCHEMA)),
    first_update_prompt_sha256: stressSha256(firstPrompt),
    qa_placeholder_prompt_sha256: Object.fromEntries(COLLISION_CONDITIONS.map((condition) => [
      condition,
      stressSha256(buildCollisionQaPrompt(fixture, placeholderPackets[condition])),
    ])),
  };
}

async function main(): Promise<void> {
  const options = parseArgs(process.argv.slice(2));
  const fixtures = loadCollisionFixtures();
  const { fixture, caseReplicate } = collisionAssignment(options.trajectoryIndex, fixtures);
  if (options.dryRun) {
    process.stdout.write(`${JSON.stringify(collisionDryRunSummary(options.trajectoryIndex), null, 2)}\n`);
    return;
  }

  mkdirSync(options.resultsDir, { recursive: true });
  const outputPath = join(options.resultsDir, `2026-08-27-hunch-schema-collision-replication-v5-trajectory-${String(options.trajectoryIndex).padStart(2, "0")}.json`);
  if (existsSync(outputPath)) throw new Error(`refusing to overwrite frozen evidence: ${outputPath}`);
  const result: CollisionResult = {
    schema_version: 1,
    protocol_version: 5,
    experiment: "hunch-schema-collision-targeted-replication",
    status: "running",
    trajectory_index: options.trajectoryIndex,
    case_id: fixture.case_id,
    case_name: fixture.case_name,
    case_replicate: caseReplicate,
    started_at: new Date().toISOString(),
    model: options.model,
    claude_cli_version: commandVersion("claude", ["--version"]),
    git_head: commandVersion("git", ["rev-parse", "HEAD"]),
    runner_sha256: stressSha256(readFileSync(THIS_FILE)),
    fixture_source_sha256: SOURCE_RESULT_SHA256,
    fixture_sha256: stressSha256(JSON.stringify(fixture)),
    system_prompt_sha256: stressSha256(SYSTEM_PROMPT),
    condition_order: collisionConditionOrder(options.trajectoryIndex),
    checkpoints: [],
    qa_calls: {},
  };

  try {
    let memory = fixture.source_snapshot;
    for (let step = 1; step <= COLLISION_REWRITES; step += 1) {
      const prompt = buildCollisionUpdatePrompt(fixture, memory, step);
      const call = runClaude(prompt, UPDATE_SCHEMA, options.model, "replacement_update");
      const memoryText = (call.parsed as { memory_text?: unknown })?.memory_text;
      memory = validateStressMemoryText(fixture.case_id, memoryText);
      result.checkpoints.push({
        step,
        source_round: 25 + step,
        observation: fixture.updates[step - 1]!,
        memory_text: memory,
        words: stressWordCount(memory),
        contains_production_literal: stressNormalizeExact(memory).includes(stressNormalizeExact(fixture.production_schema_namespace)),
        contains_prototype_literal: stressNormalizeExact(memory).includes(stressNormalizeExact(fixture.prototype_schema_namespace)),
        call,
      });
    }

    const packets = buildCollisionPackets(fixture, memory);
    const scores = {} as Record<CollisionCondition, CollisionConditionScore>;
    for (const condition of result.condition_order) {
      const prompt = buildCollisionQaPrompt(fixture, packets[condition]);
      const call = runClaude(prompt, QA_SCHEMA, options.model, "downstream_qa");
      assertCollisionAnswer(call.parsed);
      result.qa_calls[condition] = call;
      scores[condition] = scoreCollisionCondition(fixture, condition, call.parsed);
    }
    result.condition_scores = scores;
    result.paired_score = pairedCollisionScore(scores);
    result.status = "complete";
    result.completed_at = new Date().toISOString();
  } catch (error) {
    result.status = "infrastructure_failure";
    result.completed_at = new Date().toISOString();
    result.failure = {
      message: error instanceof Error ? error.message : String(error),
      ...(error instanceof Error && error.stack ? { stack: error.stack } : {}),
    };
  }
  writeFileSync(outputPath, `${JSON.stringify(result, null, 2)}\n`, { encoding: "utf8", flag: "wx" });
  process.stdout.write(`${outputPath}\n`);
  if (result.status !== "complete") process.exitCode = 1;
}

if (process.argv[1] && resolve(process.argv[1]) === resolve(THIS_FILE)) await main();
