/**
 * Direct causal benchmark for repeated textual-memory replacement.
 *
 * This is deliberately not a coding-agent benchmark. It isolates the memory
 * operation studied by Zhang et al. (arXiv:2605.12978): a useful seed memory is
 * repeatedly replaced by an LLM-authored consolidation while non-conflicting
 * observations accumulate. Fresh QA calls then consume one of four memory
 * packets: clean seed, immutable additive log, repeatedly rewritten memory, or
 * rewritten memory rescued by the authoritative original seed.
 *
 * No LLM judge is used. All answers are exact-scored against nonce values.
 *
 *   npx tsx bench/external/run-consolidation-memory.ts --dry-run --repeat-index 1
 *   npx tsx bench/external/run-consolidation-memory.ts --repeat-index 1
 */
import { spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

export const PROTECTED_KEYS = ["queue", "retry_cap", "idempotency_header", "forbidden_fallback"] as const;
export const NEW_FACT_KEYS = ["current_owner", "rollout_window"] as const;
export const CONDITIONS = ["clean", "additive", "rewritten", "rescue"] as const;

export type ProtectedKey = typeof PROTECTED_KEYS[number];
export type NewFactKey = typeof NEW_FACT_KEYS[number];
export type QuestionKey = ProtectedKey | NewFactKey;
export type Condition = typeof CONDITIONS[number];

export interface MemoryCase {
  id: string;
  name: string;
  seed: string;
  protected: Record<ProtectedKey, string>;
  new_facts: Record<NewFactKey, string>;
  updates: string[];
}

export interface CaseBank {
  schema_version: number;
  cases: MemoryCase[];
}

export interface AnswerRow {
  case_id: string;
  values: Record<QuestionKey, string>;
}

export interface ConditionAnswer {
  answers: AnswerRow[];
}

export interface UnitScore {
  unit_id: string;
  case_id: string;
  key: QuestionKey;
  expected: string;
  observed: string;
  correct: boolean;
}

export interface ConditionScore {
  condition: Condition;
  protected: { correct: number; total: number; accuracy: number };
  new_facts: { correct: number; total: number; accuracy: number };
  units: UnitScore[];
}

export interface PairedScore {
  harms: string[];
  wins: string[];
  rescued_harms: string[];
  harm_count: number;
  win_count: number;
  rescued_harm_count: number;
  rescue_rate: number | null;
}

interface ClaudeCall {
  role: "replacement_update" | "downstream_qa";
  duration_ms: number;
  prompt_sha256: string;
  raw_stdout: string;
  raw_stderr: string;
  envelope: Record<string, unknown>;
  parsed: unknown;
}

interface UpdateCheckpoint {
  round: number;
  observation_by_case: Record<string, string>;
  memories: Array<{
    case_id: string;
    memory_text: string;
    chars: number;
    words: number;
    protected_exact_retention: Record<ProtectedKey, boolean>;
  }>;
  call: ClaudeCall;
}

interface BenchmarkResult {
  schema_version: 1;
  protocol_version: 2;
  experiment: "hunch-direct-memory-degradation";
  status: "running" | "complete" | "infrastructure_failure";
  repeat_index: number;
  started_at: string;
  completed_at?: string;
  model: string;
  claude_cli_version: string;
  git_head: string;
  runner_sha256: string;
  case_bank_sha256: string;
  system_prompt_sha256: string;
  case_count: number;
  protected_units: number;
  update_rounds: number;
  condition_order: Condition[];
  checkpoints: UpdateCheckpoint[];
  qa_calls: Partial<Record<Condition, ClaudeCall>>;
  condition_scores?: Record<Condition, ConditionScore>;
  paired_score?: PairedScore;
  failure?: { message: string; stack?: string };
}

const THIS_FILE = fileURLToPath(import.meta.url);
const BENCH_DIR = import.meta.dirname;
const DEFAULT_CASE_BANK_PATH = join(BENCH_DIR, "consolidation-memory-cases.json");
const DEFAULT_RESULTS_DIR = join(BENCH_DIR, "results");
const DEFAULT_MODEL = "claude-sonnet-5";
const UNKNOWN = "UNKNOWN";
const SYSTEM_PROMPT = [
  "You are executing a controlled textual-memory experiment.",
  "Use only the supplied records, follow the requested transformation or extraction protocol exactly,",
  "and return only data matching the provided JSON schema. Never use tools or outside knowledge.",
].join(" ");

const UPDATE_SCHEMA = {
  type: "object",
  properties: {
    memories: {
      type: "array",
      minItems: 8,
      maxItems: 8,
      items: {
        type: "object",
        properties: {
          case_id: { type: "string" },
          memory_text: { type: "string" },
        },
        required: ["case_id", "memory_text"],
        additionalProperties: false,
      },
    },
  },
  required: ["memories"],
  additionalProperties: false,
} as const;

const QA_SCHEMA = {
  type: "object",
  properties: {
    answers: {
      type: "array",
      minItems: 8,
      maxItems: 8,
      items: {
        type: "object",
        properties: {
          case_id: { type: "string" },
          values: {
            type: "object",
            properties: Object.fromEntries([...PROTECTED_KEYS, ...NEW_FACT_KEYS].map((key) => [key, { type: "string" }])),
            required: [...PROTECTED_KEYS, ...NEW_FACT_KEYS],
            additionalProperties: false,
          },
        },
        required: ["case_id", "values"],
        additionalProperties: false,
      },
    },
  },
  required: ["answers"],
  additionalProperties: false,
} as const;

export function sha256(value: string | Buffer): string {
  return createHash("sha256").update(value).digest("hex");
}

export function normalizeExact(value: unknown): string {
  return String(value ?? "").normalize("NFKC").trim().toLowerCase().replace(/\s+/g, " ");
}

export function loadCaseBank(path = DEFAULT_CASE_BANK_PATH): CaseBank {
  const bank = JSON.parse(readFileSync(path, "utf8")) as CaseBank;
  validateCaseBank(bank);
  return bank;
}

export function validateCaseBank(bank: CaseBank): void {
  if (bank.schema_version !== 1) throw new Error(`unsupported case-bank schema: ${bank.schema_version}`);
  if (!Array.isArray(bank.cases) || bank.cases.length !== 8) throw new Error("case bank must contain exactly 8 cases");
  const ids = new Set<string>();
  const protectedValues = new Set<string>();
  const newValues = new Set<string>();
  for (const item of bank.cases) {
    if (!/^[a-z0-9]+(?:-[a-z0-9]+)*$/.test(item.id)) throw new Error(`invalid case id: ${item.id}`);
    if (ids.has(item.id)) throw new Error(`duplicate case id: ${item.id}`);
    ids.add(item.id);
    if (!item.name.trim() || !item.seed.trim()) throw new Error(`${item.id}: name and seed are required`);
    if (!Array.isArray(item.updates) || item.updates.length !== 12) throw new Error(`${item.id}: exactly 12 updates are required`);

    for (const key of PROTECTED_KEYS) {
      const value = item.protected?.[key];
      if (!value || !normalizeExact(item.seed).includes(normalizeExact(value))) {
        throw new Error(`${item.id}: seed does not contain protected ${key}`);
      }
      const unique = normalizeExact(value);
      if (protectedValues.has(unique)) throw new Error(`${item.id}: protected value is not globally unique: ${value}`);
      protectedValues.add(unique);
      // Numeric retry caps are allowed to occur incidentally; all nonce text
      // values must never be re-exposed by an update.
      if (key !== "retry_cap" && item.updates.some((update) => normalizeExact(update).includes(unique))) {
        throw new Error(`${item.id}: update re-exposes protected ${key}: ${value}`);
      }
    }

    for (const key of NEW_FACT_KEYS) {
      const value = item.new_facts?.[key];
      if (!value) throw new Error(`${item.id}: missing new fact ${key}`);
      const unique = normalizeExact(value);
      if (newValues.has(unique)) throw new Error(`${item.id}: new-fact value is not globally unique: ${value}`);
      newValues.add(unique);
      const occurrences = item.updates.filter((update) => normalizeExact(update).includes(unique)).length;
      if (occurrences !== 1) throw new Error(`${item.id}: ${key} must appear in exactly one update, found ${occurrences}`);
    }
    if (!normalizeExact(item.updates[3]).includes(normalizeExact(item.new_facts.current_owner))) {
      throw new Error(`${item.id}: current_owner must be introduced in update 4`);
    }
    if (!normalizeExact(item.updates[8]).includes(normalizeExact(item.new_facts.rollout_window))) {
      throw new Error(`${item.id}: rollout_window must be introduced in update 9`);
    }
  }
}

function rotate<T>(values: readonly T[], offset: number): T[] {
  const at = ((offset % values.length) + values.length) % values.length;
  return [...values.slice(at), ...values.slice(0, at)];
}

export function conditionOrder(repeatIndex: number): Condition[] {
  return rotate(CONDITIONS, repeatIndex - 1);
}

export function buildConditionPackets(cases: MemoryCase[], finalRewritten: Record<string, string>): Record<Condition, Record<string, string>> {
  const packets = Object.fromEntries(CONDITIONS.map((condition) => [condition, {}])) as Record<Condition, Record<string, string>>;
  for (const item of cases) {
    const rewritten = finalRewritten[item.id];
    if (typeof rewritten !== "string" || !rewritten.trim()) throw new Error(`${item.id}: missing final rewritten memory`);
    packets.clean[item.id] = `AUTHORITATIVE MEMORY\n${item.seed}`;
    packets.additive[item.id] = [
      "IMMUTABLE MEMORY LOG — later records add facts; they do not replace earlier records.",
      `ORIGINAL RECORD\n${item.seed}`,
      ...item.updates.map((update, index) => `UPDATE RECORD ${index + 1}\n${update}`),
    ].join("\n\n");
    packets.rewritten[item.id] = `CONSOLIDATED MEMORY\n${rewritten}`;
    packets.rescue[item.id] = [
      `CONSOLIDATED MEMORY\n${rewritten}`,
      "AUTHORITATIVE ORIGINAL RECORD — use this record to recover any omitted or conflicting original fact.",
      item.seed,
    ].join("\n\n");
  }
  return packets;
}

export function buildUpdatePrompt(cases: MemoryCase[], prior: Record<string, string>, round: number, repeatIndex: number): string {
  if (!Number.isSafeInteger(round) || round < 1 || round > 12) throw new Error(`invalid update round: ${round}`);
  const ordered = rotate(cases, repeatIndex + round - 2);
  const blocks = ordered.map((item) => {
    const memory = prior[item.id];
    if (!memory) throw new Error(`${item.id}: missing prior memory at round ${round}`);
    return [
      `CASE ${item.id}`,
      "EXISTING MEMORY:",
      memory,
      "NEW NON-CONFLICTING OBSERVATION:",
      item.updates[round - 1],
    ].join("\n");
  });
  return [
    "For every case below, replace the existing memory with one self-contained consolidated memory.",
    "Preserve every existing fact unless the new observation explicitly supersedes it; these observations are non-conflicting.",
    "Incorporate the new observation. Do not mix facts between cases. Use at most 120 words per memory.",
    "Return exactly one memories entry per case with the unchanged case_id.",
    "",
    ...blocks.flatMap((block) => [block, ""]),
  ].join("\n");
}

function questionText(item: MemoryCase): string[] {
  return [
    `queue: What queue does ${item.name} send jobs through?`,
    `retry_cap: What is ${item.name}'s retry cap? Return only the number as a string.`,
    `idempotency_header: What idempotency header must ${item.name} use?`,
    `forbidden_fallback: What fallback is forbidden for ${item.name}?`,
    `current_owner: Who is the current owner of ${item.name}?`,
    `rollout_window: What is the rollout window for ${item.name}?`,
  ];
}

export function buildQaPrompt(cases: MemoryCase[], packets: Record<string, string>, repeatIndex: number, condition: Condition): string {
  const conditionOffset = CONDITIONS.indexOf(condition);
  const ordered = rotate(cases, repeatIndex + conditionOffset - 1);
  const blocks = ordered.map((item) => [
    `CASE ${item.id}`,
    "MEMORY:",
    packets[item.id],
    "QUESTIONS:",
    ...questionText(item),
  ].join("\n"));
  return [
    "Answer every question using only that case's MEMORY block.",
    `If a value is absent, return exactly ${UNKNOWN}. Copy present values exactly; do not explain or infer.`,
    "Return exactly one answers entry per case with the unchanged case_id and all six value keys.",
    "",
    ...blocks.flatMap((block) => [block, ""]),
  ].join("\n");
}

function assertAnswerShape(cases: MemoryCase[], value: unknown): asserts value is ConditionAnswer {
  const answers = (value as { answers?: unknown })?.answers;
  if (!Array.isArray(answers) || answers.length !== cases.length) throw new Error(`QA response must contain ${cases.length} answers`);
  const expected = new Set(cases.map((item) => item.id));
  const seen = new Set<string>();
  for (const row of answers as AnswerRow[]) {
    if (!row || typeof row.case_id !== "string" || !expected.has(row.case_id)) throw new Error(`QA response has unknown case_id: ${String(row?.case_id)}`);
    if (seen.has(row.case_id)) throw new Error(`QA response duplicates case_id: ${row.case_id}`);
    seen.add(row.case_id);
    if (!row.values || typeof row.values !== "object") throw new Error(`${row.case_id}: QA response has no values object`);
    for (const key of [...PROTECTED_KEYS, ...NEW_FACT_KEYS]) {
      if (typeof row.values[key] !== "string") throw new Error(`${row.case_id}: QA response has no string ${key}`);
    }
  }
}

export function scoreCondition(cases: MemoryCase[], condition: Condition, answer: ConditionAnswer): ConditionScore {
  assertAnswerShape(cases, answer);
  const byId = new Map(answer.answers.map((row) => [row.case_id, row]));
  const units: UnitScore[] = [];
  for (const item of cases) {
    const observed = byId.get(item.id)!;
    for (const key of PROTECTED_KEYS) {
      const expected = item.protected[key];
      const actual = observed.values[key];
      units.push({
        unit_id: `${item.id}:${key}`,
        case_id: item.id,
        key,
        expected,
        observed: actual,
        correct: normalizeExact(actual) === normalizeExact(expected),
      });
    }
    for (const key of NEW_FACT_KEYS) {
      const expected = condition === "clean" ? UNKNOWN : item.new_facts[key];
      const actual = observed.values[key];
      units.push({
        unit_id: `${item.id}:${key}`,
        case_id: item.id,
        key,
        expected,
        observed: actual,
        correct: normalizeExact(actual) === normalizeExact(expected),
      });
    }
  }
  const protectedUnits = units.filter((unit) => (PROTECTED_KEYS as readonly string[]).includes(unit.key));
  const newUnits = units.filter((unit) => (NEW_FACT_KEYS as readonly string[]).includes(unit.key));
  const aggregate = (selected: UnitScore[]) => {
    const correct = selected.filter((unit) => unit.correct).length;
    return { correct, total: selected.length, accuracy: correct / selected.length };
  };
  return { condition, protected: aggregate(protectedUnits), new_facts: aggregate(newUnits), units };
}

export function pairedScore(scores: Record<Condition, ConditionScore>): PairedScore {
  const protectedMap = (condition: Condition) => new Map(
    scores[condition].units
      .filter((unit) => (PROTECTED_KEYS as readonly string[]).includes(unit.key))
      .map((unit) => [unit.unit_id, unit.correct]),
  );
  const additive = protectedMap("additive");
  const rewritten = protectedMap("rewritten");
  const rescue = protectedMap("rescue");
  const harms: string[] = [];
  const wins: string[] = [];
  const rescuedHarms: string[] = [];
  for (const [unitId, additiveCorrect] of additive) {
    const rewrittenCorrect = rewritten.get(unitId) ?? false;
    if (additiveCorrect && !rewrittenCorrect) {
      harms.push(unitId);
      if (rescue.get(unitId)) rescuedHarms.push(unitId);
    }
    if (!additiveCorrect && rewrittenCorrect) wins.push(unitId);
  }
  return {
    harms,
    wins,
    rescued_harms: rescuedHarms,
    harm_count: harms.length,
    win_count: wins.length,
    rescued_harm_count: rescuedHarms.length,
    rescue_rate: harms.length ? rescuedHarms.length / harms.length : null,
  };
}

function strippedSubscriptionEnv(): NodeJS.ProcessEnv {
  const env = { ...process.env, CI: "1", NO_COLOR: "1", FORCE_COLOR: "0", CLAUDE_CODE_SAFE_MODE: "1" };
  for (const key of [
    "ANTHROPIC_API_KEY",
    "ANTHROPIC_AUTH_TOKEN",
    "ANTHROPIC_BASE_URL",
    "CLAUDE_CODE_USE_BEDROCK",
    "CLAUDE_CODE_USE_VERTEX",
    "ANTHROPIC_BEDROCK_BASE_URL",
    "ANTHROPIC_VERTEX_BASE_URL",
    "ANTHROPIC_VERTEX_PROJECT_ID",
    "CLOUD_ML_REGION",
  ]) delete env[key];
  return env;
}

export function parseStructuredResult(stdout: string): { envelope: Record<string, unknown>; parsed: unknown } {
  let envelope: Record<string, unknown>;
  try {
    envelope = JSON.parse(stdout) as Record<string, unknown>;
  } catch {
    throw new Error("claude returned a non-JSON outer envelope");
  }
  if (envelope.is_error === true || (typeof envelope.subtype === "string" && envelope.subtype !== "success")) {
    throw new Error(`claude reported an error${envelope.subtype ? `: ${envelope.subtype}` : ""}`);
  }
  // Current Claude Code emits schema-constrained data separately from the
  // human-readable result. Keep the result fallback for older CLI builds.
  if (envelope.structured_output && typeof envelope.structured_output === "object") {
    return { envelope, parsed: envelope.structured_output };
  }
  const result = envelope.result;
  if (result && typeof result === "object") return { envelope, parsed: result };
  if (typeof result !== "string") throw new Error("claude success envelope contains no structured result");
  let candidate = result.trim();
  if (candidate.startsWith("```")) candidate = candidate.replace(/^```(?:json)?\s*/i, "").replace(/\s*```$/, "");
  try {
    return { envelope, parsed: JSON.parse(candidate) };
  } catch {
    const start = candidate.indexOf("{");
    const end = candidate.lastIndexOf("}");
    if (start >= 0 && end > start) return { envelope, parsed: JSON.parse(candidate.slice(start, end + 1)) };
    throw new Error("claude result does not contain a JSON object");
  }
}

function runClaude(prompt: string, schema: object, model: string, role: ClaudeCall["role"]): ClaudeCall {
  const started = Date.now();
  const args = [
    "-p",
    "--safe-mode",
    "--disable-slash-commands",
    "--no-session-persistence",
    "--prompt-suggestions",
    "false",
    "--tools",
    "",
    "--output-format",
    "json",
    "--json-schema",
    JSON.stringify(schema),
    "--system-prompt",
    SYSTEM_PROMPT,
    "--model",
    model,
    "--max-turns",
    // Schema-constrained output is delivered through Claude Code's
    // StructuredOutput protocol. One generation turn emits the tool call and
    // the second lets the CLI finalize it into `structured_output`.
    "2",
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
  const { envelope, parsed } = parseStructuredResult(rawStdout);
  return {
    role,
    duration_ms: Date.now() - started,
    prompt_sha256: sha256(prompt),
    raw_stdout: rawStdout,
    raw_stderr: rawStderr,
    envelope,
    parsed,
  };
}

function updateMemories(cases: MemoryCase[], parsed: unknown): Record<string, string> {
  const memories = (parsed as { memories?: unknown })?.memories;
  if (!Array.isArray(memories) || memories.length !== cases.length) throw new Error(`update response must contain ${cases.length} memories`);
  const expected = new Set(cases.map((item) => item.id));
  const result: Record<string, string> = {};
  for (const row of memories as Array<{ case_id?: unknown; memory_text?: unknown }>) {
    if (typeof row.case_id !== "string" || !expected.has(row.case_id)) throw new Error(`update response has unknown case_id: ${String(row.case_id)}`);
    if (result[row.case_id]) throw new Error(`update response duplicates case_id: ${row.case_id}`);
    if (typeof row.memory_text !== "string" || !row.memory_text.trim()) throw new Error(`${row.case_id}: update response has empty memory_text`);
    result[row.case_id] = row.memory_text.trim();
  }
  return result;
}

function commandVersion(command: string, args: string[]): string {
  const run = spawnSync(command, args, { cwd: BENCH_DIR, encoding: "utf8", timeout: 8_000, shell: false });
  if (run.error || run.status !== 0) throw new Error(`${command} is unavailable`);
  return (run.stdout || run.stderr).trim().split(/\r?\n/)[0]?.trim() ?? "unknown";
}

function persistResult(path: string, result: BenchmarkResult): void {
  writeFileSync(path, `${JSON.stringify(result, null, 2)}\n`, { encoding: "utf8", flag: "wx" });
}

function parseArgs(argv: string[]): { repeatIndex: number; dryRun: boolean; model: string; caseBankPath: string; resultsDir: string } {
  const value = (name: string, fallback: string): string => {
    const at = argv.indexOf(`--${name}`);
    return at >= 0 && argv[at + 1] ? argv[at + 1]! : fallback;
  };
  const repeatIndex = Number(value("repeat-index", "1"));
  if (!Number.isSafeInteger(repeatIndex) || repeatIndex < 1 || repeatIndex > 3) {
    throw new Error(`--repeat-index must be 1, 2, or 3; got ${repeatIndex}`);
  }
  return {
    repeatIndex,
    dryRun: argv.includes("--dry-run"),
    model: value("model", DEFAULT_MODEL),
    caseBankPath: resolve(value("case-bank", DEFAULT_CASE_BANK_PATH)),
    resultsDir: resolve(value("results-dir", DEFAULT_RESULTS_DIR)),
  };
}

export function dryRunSummary(bank: CaseBank, repeatIndex: number, model = DEFAULT_MODEL): Record<string, unknown> {
  const initial = Object.fromEntries(bank.cases.map((item) => [item.id, item.seed]));
  const firstUpdate = buildUpdatePrompt(bank.cases, initial, 1, repeatIndex);
  const placeholder = Object.fromEntries(bank.cases.map((item) => [item.id, `[MODEL-GENERATED MEMORY FOR ${item.id}]`]));
  const packets = buildConditionPackets(bank.cases, placeholder);
  const qaPromptHashes = Object.fromEntries(CONDITIONS.map((condition) => [
    condition,
    sha256(buildQaPrompt(bank.cases, packets[condition], repeatIndex, condition)),
  ]));
  return {
    valid: true,
    no_model_calls_made: true,
    protocol_version: 2,
    repeat_index: repeatIndex,
    model,
    case_count: bank.cases.length,
    update_rounds: bank.cases[0]!.updates.length,
    protected_units: bank.cases.length * PROTECTED_KEYS.length,
    new_fact_units: bank.cases.length * NEW_FACT_KEYS.length,
    planned_model_calls: 12 + CONDITIONS.length,
    max_cli_turns_per_call: 2,
    condition_order: conditionOrder(repeatIndex),
    case_bank_sha256: sha256(readFileSync(DEFAULT_CASE_BANK_PATH)),
    runner_sha256: sha256(readFileSync(THIS_FILE)),
    system_prompt_sha256: sha256(SYSTEM_PROMPT),
    update_schema_sha256: sha256(JSON.stringify(UPDATE_SCHEMA)),
    qa_schema_sha256: sha256(JSON.stringify(QA_SCHEMA)),
    first_update_prompt_sha256: sha256(firstUpdate),
    qa_placeholder_prompt_sha256: qaPromptHashes,
  };
}

async function main(): Promise<void> {
  const options = parseArgs(process.argv.slice(2));
  const bank = loadCaseBank(options.caseBankPath);
  if (options.dryRun) {
    process.stdout.write(`${JSON.stringify(dryRunSummary(bank, options.repeatIndex, options.model), null, 2)}\n`);
    return;
  }

  mkdirSync(options.resultsDir, { recursive: true });
  const outputPath = join(options.resultsDir, `2026-08-27-hunch-direct-memory-degradation-v2-repeat-${options.repeatIndex}.json`);
  if (existsSync(outputPath)) throw new Error(`refusing to overwrite frozen evidence: ${outputPath}`);
  const result: BenchmarkResult = {
    schema_version: 1,
    protocol_version: 2,
    experiment: "hunch-direct-memory-degradation",
    status: "running",
    repeat_index: options.repeatIndex,
    started_at: new Date().toISOString(),
    model: options.model,
    claude_cli_version: commandVersion("claude", ["--version"]),
    git_head: commandVersion("git", ["rev-parse", "HEAD"]),
    runner_sha256: sha256(readFileSync(THIS_FILE)),
    case_bank_sha256: sha256(readFileSync(options.caseBankPath)),
    system_prompt_sha256: sha256(SYSTEM_PROMPT),
    case_count: bank.cases.length,
    protected_units: bank.cases.length * PROTECTED_KEYS.length,
    update_rounds: bank.cases[0]!.updates.length,
    condition_order: conditionOrder(options.repeatIndex),
    checkpoints: [],
    qa_calls: {},
  };

  try {
    let rewritten = Object.fromEntries(bank.cases.map((item) => [item.id, item.seed]));
    for (let round = 1; round <= 12; round += 1) {
      const prompt = buildUpdatePrompt(bank.cases, rewritten, round, options.repeatIndex);
      const call = runClaude(prompt, UPDATE_SCHEMA, options.model, "replacement_update");
      rewritten = updateMemories(bank.cases, call.parsed);
      result.checkpoints.push({
        round,
        observation_by_case: Object.fromEntries(bank.cases.map((item) => [item.id, item.updates[round - 1]!])),
        memories: bank.cases.map((item) => {
          const memoryText = rewritten[item.id]!;
          return {
            case_id: item.id,
            memory_text: memoryText,
            chars: memoryText.length,
            words: memoryText.trim().split(/\s+/).length,
            protected_exact_retention: Object.fromEntries(PROTECTED_KEYS.map((key) => [
              key,
              normalizeExact(memoryText).includes(normalizeExact(item.protected[key])),
            ])) as Record<ProtectedKey, boolean>,
          };
        }),
        call,
      });
      process.stderr.write(`repeat ${options.repeatIndex}: replacement round ${round}/12 complete\n`);
    }

    const packets = buildConditionPackets(bank.cases, rewritten);
    const scores = {} as Record<Condition, ConditionScore>;
    for (const condition of result.condition_order) {
      const prompt = buildQaPrompt(bank.cases, packets[condition], options.repeatIndex, condition);
      const call = runClaude(prompt, QA_SCHEMA, options.model, "downstream_qa");
      assertAnswerShape(bank.cases, call.parsed);
      result.qa_calls[condition] = call;
      scores[condition] = scoreCondition(bank.cases, condition, call.parsed);
      process.stderr.write(`repeat ${options.repeatIndex}: ${condition} QA complete\n`);
    }
    result.condition_scores = scores;
    result.paired_score = pairedScore(scores);
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
  persistResult(outputPath, result);
  process.stdout.write(`${outputPath}\n`);
  if (result.status !== "complete") process.exitCode = 1;
}

if (process.argv[1] && resolve(process.argv[1]) === resolve(THIS_FILE)) {
  await main();
}
