/**
 * Capacity-stress extension of the direct repeated-memory benchmark.
 *
 * Six cases begin with twelve protected nonce facts, then receive thirty
 * non-conflicting observations. The replacement arm must repeatedly compress
 * the full memory into at most 100 words; additive and seed-rescue controls are
 * exact. Fresh downstream calls answer eighteen exact-scored questions/case.
 *
 *   npx tsx bench/external/run-consolidation-memory-stress.ts --dry-run --repeat-index 1
 *   npx tsx bench/external/run-consolidation-memory-stress.ts --repeat-index 1
 */
import { spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

export const STRESS_PROTECTED_KEYS = [
  "queue",
  "retry_cap",
  "idempotency_header",
  "forbidden_fallback",
  "primary_region",
  "schema_namespace",
  "encryption_profile",
  "audit_topic",
  "health_path",
  "lease_seconds",
  "recovery_contact",
  "checksum_salt",
] as const;

export const STRESS_NEW_FACT_KEYS = [
  "current_owner",
  "docs_locale",
  "deployment_zone",
  "rollout_window",
  "compliance_tag",
  "escalation_room",
] as const;

export const STRESS_CONDITIONS = ["clean", "additive", "rewritten", "rescue"] as const;
export const STRESS_UPDATE_ROUNDS = 30;
export const STRESS_WORD_CAP = 100;
export const STRESS_TARGET_WORDS = 90;

export type StressProtectedKey = typeof STRESS_PROTECTED_KEYS[number];
export type StressNewFactKey = typeof STRESS_NEW_FACT_KEYS[number];
export type StressQuestionKey = StressProtectedKey | StressNewFactKey;
export type StressCondition = typeof STRESS_CONDITIONS[number];

export interface StressCase {
  id: string;
  name: string;
  seed: string;
  protected: Record<StressProtectedKey, string>;
  new_facts: Record<StressNewFactKey, string>;
  updates: string[];
}

interface CaseSpec {
  id: string;
  name: string;
  protected: Record<StressProtectedKey, string>;
  new_facts: Record<StressNewFactKey, string>;
}

export interface StressAnswerRow {
  case_id: string;
  values: Record<StressQuestionKey, string>;
}

export interface StressConditionAnswer {
  answers: StressAnswerRow[];
}

export interface StressUnitScore {
  unit_id: string;
  case_id: string;
  key: StressQuestionKey;
  expected: string;
  observed: string;
  correct: boolean;
}

export interface StressConditionScore {
  condition: StressCondition;
  protected: { correct: number; total: number; accuracy: number };
  new_facts: { correct: number; total: number; accuracy: number };
  units: StressUnitScore[];
}

export interface StressPairedScore {
  harms: string[];
  wins: string[];
  rescued_harms: string[];
  harm_count: number;
  win_count: number;
  rescued_harm_count: number;
  rescue_rate: number | null;
}

interface StressClaudeCall {
  role: "replacement_update" | "downstream_qa";
  duration_ms: number;
  prompt_sha256: string;
  raw_stdout: string;
  raw_stderr: string;
  envelope: Record<string, unknown>;
  parsed: unknown;
}

interface StressCheckpoint {
  round: number;
  observation_by_case: Record<string, string>;
  memories: Array<{
    case_id: string;
    memory_text: string;
    chars: number;
    words: number;
    protected_exact_retention: Record<StressProtectedKey, boolean>;
  }>;
  call: StressClaudeCall;
}

interface StressResult {
  schema_version: 1;
  protocol_version: 4;
  experiment: "hunch-direct-memory-capacity-stress";
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
  word_cap: number;
  target_words: number;
  condition_order: StressCondition[];
  checkpoints: StressCheckpoint[];
  qa_calls: Partial<Record<StressCondition, StressClaudeCall>>;
  condition_scores?: Record<StressCondition, StressConditionScore>;
  paired_score?: StressPairedScore;
  failure?: { message: string; stack?: string };
}

const CASE_SPECS: CaseSpec[] = [
  {
    id: "aster-relay",
    name: "Aster Relay",
    protected: {
      queue: "quartz-17",
      retry_cap: "4",
      idempotency_header: "X-Aster-Idem",
      forbidden_fallback: "local-disk",
      primary_region: "aurora-north",
      schema_namespace: "aster.violet",
      encryption_profile: "cipher-lark",
      audit_topic: "audit-aster-cedar",
      health_path: "/health/aster-pulse",
      lease_seconds: "47",
      recovery_contact: "rhea-aster",
      checksum_salt: "salt-aster-moon",
    },
    new_facts: {
      current_owner: "Mira Sol",
      docs_locale: "Finnish",
      deployment_zone: "cedar-zone",
      rollout_window: "Tuesday dawn",
      compliance_tag: "heliotrope",
      escalation_room: "room-aster-orbit",
    },
  },
  {
    id: "birch-ledger",
    name: "Birch Ledger",
    protected: {
      queue: "cobalt-29",
      retry_cap: "7",
      idempotency_header: "X-Birch-Token",
      forbidden_fallback: "in-memory-cache",
      primary_region: "boreal-east",
      schema_namespace: "birch.indigo",
      encryption_profile: "cipher-tern",
      audit_topic: "audit-birch-elm",
      health_path: "/health/birch-beat",
      lease_seconds: "53",
      recovery_contact: "theo-birch",
      checksum_salt: "salt-birch-star",
    },
    new_facts: {
      current_owner: "Tomas Venn",
      docs_locale: "Estonian",
      deployment_zone: "willow-zone",
      rollout_window: "Friday twilight",
      compliance_tag: "topaz",
      escalation_room: "room-birch-arc",
    },
  },
  {
    id: "cinder-index",
    name: "Cinder Index",
    protected: {
      queue: "amber-43",
      retry_cap: "3",
      idempotency_header: "X-Cinder-Key",
      forbidden_fallback: "direct-sql",
      primary_region: "caldera-west",
      schema_namespace: "cinder.saffron",
      encryption_profile: "cipher-wren",
      audit_topic: "audit-cinder-ash",
      health_path: "/health/cinder-spark",
      lease_seconds: "61",
      recovery_contact: "lena-cinder",
      checksum_salt: "salt-cinder-sun",
    },
    new_facts: {
      current_owner: "Leena Quill",
      docs_locale: "Maltese",
      deployment_zone: "maple-zone",
      rollout_window: "Sunday noon",
      compliance_tag: "carnelian",
      escalation_room: "room-cinder-ray",
    },
  },
  {
    id: "delta-beacon",
    name: "Delta Beacon",
    protected: {
      queue: "violet-61",
      retry_cap: "6",
      idempotency_header: "X-Delta-Nonce",
      forbidden_fallback: "stdout-buffer",
      primary_region: "delta-south",
      schema_namespace: "delta.cobalt",
      encryption_profile: "cipher-heron",
      audit_topic: "audit-delta-pine",
      health_path: "/health/delta-flare",
      lease_seconds: "67",
      recovery_contact: "oren-delta",
      checksum_salt: "salt-delta-tide",
    },
    new_facts: {
      current_owner: "Oren Vale",
      docs_locale: "Latvian",
      deployment_zone: "spruce-zone",
      rollout_window: "Monday dusk",
      compliance_tag: "amethyst",
      escalation_room: "room-delta-wave",
    },
  },
  {
    id: "ember-archive",
    name: "Ember Archive",
    protected: {
      queue: "silver-73",
      retry_cap: "5",
      idempotency_header: "X-Ember-Stamp",
      forbidden_fallback: "temp-file",
      primary_region: "ember-central",
      schema_namespace: "ember.coral",
      encryption_profile: "cipher-kite",
      audit_topic: "audit-ember-maple",
      health_path: "/health/ember-glow",
      lease_seconds: "71",
      recovery_contact: "priya-ember",
      checksum_salt: "salt-ember-dawn",
    },
    new_facts: {
      current_owner: "Priya Noll",
      docs_locale: "Slovene",
      deployment_zone: "aspen-zone",
      rollout_window: "Thursday sunrise",
      compliance_tag: "moonstone",
      escalation_room: "room-ember-halo",
    },
  },
  {
    id: "fable-router",
    name: "Fable Router",
    protected: {
      queue: "jade-89",
      retry_cap: "8",
      idempotency_header: "X-Fable-Route",
      forbidden_fallback: "global-map",
      primary_region: "fable-coast",
      schema_namespace: "fable.teal",
      encryption_profile: "cipher-finch",
      audit_topic: "audit-fable-oak",
      health_path: "/health/fable-turn",
      lease_seconds: "79",
      recovery_contact: "sana-fable",
      checksum_salt: "salt-fable-cloud",
    },
    new_facts: {
      current_owner: "Sana Pike",
      docs_locale: "Basque",
      deployment_zone: "alder-zone",
      rollout_window: "Wednesday midnight",
      compliance_tag: "aquamarine",
      escalation_room: "room-fable-knot",
    },
  },
];

const THIS_FILE = fileURLToPath(import.meta.url);
const BENCH_DIR = import.meta.dirname;
const DEFAULT_RESULTS_DIR = join(BENCH_DIR, "results");
const DEFAULT_MODEL = "claude-sonnet-5";
const UNKNOWN = "UNKNOWN";
const SYSTEM_PROMPT = [
  "You are executing a controlled textual-memory capacity experiment.",
  "Use only the supplied records, follow the requested transformation or extraction protocol exactly,",
  "and return only data matching the provided JSON schema. Never use tools or outside knowledge.",
].join(" ");

const UPDATE_SCHEMA = {
  type: "object",
  properties: {
    memories: {
      type: "array",
      minItems: 6,
      maxItems: 6,
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
      minItems: 6,
      maxItems: 6,
      items: {
        type: "object",
        properties: {
          case_id: { type: "string" },
          values: {
            type: "object",
            properties: Object.fromEntries([...STRESS_PROTECTED_KEYS, ...STRESS_NEW_FACT_KEYS].map((key) => [key, { type: "string" }])),
            required: [...STRESS_PROTECTED_KEYS, ...STRESS_NEW_FACT_KEYS],
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

export function stressSha256(value: string | Buffer): string {
  return createHash("sha256").update(value).digest("hex");
}

export function stressNormalizeExact(value: unknown): string {
  return String(value ?? "").normalize("NFKC").trim().toLowerCase().replace(/\s+/g, " ");
}

export function stressWordCount(value: string): number {
  const trimmed = value.trim();
  return trimmed ? trimmed.split(/\s+/).length : 0;
}

export function validateStressMemoryText(caseId: string, value: unknown): string {
  if (typeof value !== "string" || !value.trim()) throw new Error(`${caseId}: update response has empty memory_text`);
  const trimmed = value.trim();
  const words = stressWordCount(trimmed);
  if (words > STRESS_WORD_CAP) throw new Error(`${caseId}: replacement memory exceeds frozen ${STRESS_WORD_CAP}-word cap (${words})`);
  return trimmed;
}

function seedText(spec: CaseSpec): string {
  const p = spec.protected;
  return [
    `${spec.name} uses queue ${p.queue}.`,
    `Its retry cap is ${p.retry_cap}.`,
    `Its idempotency header is ${p.idempotency_header}.`,
    `Its forbidden fallback is ${p.forbidden_fallback}.`,
    `Its primary region is ${p.primary_region}.`,
    `Its schema namespace is ${p.schema_namespace}.`,
    `Its encryption profile is ${p.encryption_profile}.`,
    `Its audit topic is ${p.audit_topic}.`,
    `Its health path is ${p.health_path}.`,
    `Its lease duration in seconds is ${p.lease_seconds}.`,
    `Its recovery contact is ${p.recovery_contact}.`,
    `Its checksum salt is ${p.checksum_salt}.`,
  ].join(" ");
}

function updatesFor(spec: CaseSpec): string[] {
  const stem = spec.id.split("-")[0]!;
  const n = spec.new_facts;
  return [
    `The ${spec.name} administration panel accent is ${stem}-saffron.`,
    `${spec.name} telemetry is exported to sink ${stem}-northstar.`,
    `The current owner of ${spec.name} is ${n.current_owner}.`,
    `The separate ${stem} preview renderer uses retry policy ${stem}-eleven.`,
    `${spec.name} audit events are retained through ${stem}-equinox.`,
    `The unrelated ${stem} shadow importer uses queue ${stem}-pebble-lab.`,
    `${spec.name} dashboard tiles use cache ${stem}-linen.`,
    `${spec.name} operator documentation defaults to ${n.docs_locale}.`,
    `The ${stem} mobile demo sends header X-${stem}-Demo.`,
    `The ${stem} sandbox uses fallback ${stem}-scratch-pad.`,
    `${spec.name} reporting uses timezone ${stem}-meridian.`,
    `${spec.name} metrics use prefix ${stem}-compass.`,
    `${spec.name} is deployed in ${n.deployment_zone}.`,
    `The ${stem} thumbnail prototype stores files in ${stem}-canvas.`,
    `The ${stem} replay simulator cadence is ${stem}-solstice.`,
    `${spec.name} canaries use color ${stem}-plum.`,
    `${spec.name} support replies default to language ${stem}-common.`,
    `The rollout window for ${spec.name} is ${n.rollout_window}.`,
    `The ${stem} debug console uses port label ${stem}-harbor.`,
    `${spec.name} archive copies use tier ${stem}-glacier.`,
    `The ${stem} preview service runs in region ${stem}-preview-west.`,
    `The ${stem} prototype schema namespace is ${stem}.prototype.`,
    `${spec.name} carries compliance tag ${n.compliance_tag}.`,
    `${spec.name} notifications use channel ${stem}-signal.`,
    `The ${stem} backup demonstrator uses label ${stem}-vault.`,
    `The ${stem} demo client uses encryption profile ${stem}-toy-cipher.`,
    `The ${stem} staging probe health path is /health/${stem}-stage.`,
    `The escalation room for ${spec.name} is ${n.escalation_room}.`,
    `The ${stem} analytics sandbox audit topic is ${stem}-analytics-noise.`,
    `The ${stem} batch simulator lease mode is ${stem}-elastic.`,
  ];
}

export function buildStressCases(): StressCase[] {
  return CASE_SPECS.map((spec) => ({
    id: spec.id,
    name: spec.name,
    seed: seedText(spec),
    protected: { ...spec.protected },
    new_facts: { ...spec.new_facts },
    updates: updatesFor(spec),
  }));
}

const NEW_FACT_ROUNDS: Record<StressNewFactKey, number> = {
  current_owner: 3,
  docs_locale: 8,
  deployment_zone: 13,
  rollout_window: 18,
  compliance_tag: 23,
  escalation_room: 28,
};

export function validateStressCases(cases: StressCase[]): void {
  if (cases.length !== 6) throw new Error("stress bank must contain exactly 6 cases");
  const ids = new Set<string>();
  const protectedValues = new Set<string>();
  const newValues = new Set<string>();
  for (const item of cases) {
    if (!/^[a-z0-9]+(?:-[a-z0-9]+)*$/.test(item.id)) throw new Error(`invalid case id: ${item.id}`);
    if (ids.has(item.id)) throw new Error(`duplicate case id: ${item.id}`);
    ids.add(item.id);
    if (item.updates.length !== STRESS_UPDATE_ROUNDS) throw new Error(`${item.id}: exactly ${STRESS_UPDATE_ROUNDS} updates required`);
    for (const key of STRESS_PROTECTED_KEYS) {
      const value = item.protected[key];
      const normalized = stressNormalizeExact(value);
      if (!value || !stressNormalizeExact(item.seed).includes(normalized)) throw new Error(`${item.id}: seed omits protected ${key}`);
      if (protectedValues.has(normalized)) throw new Error(`${item.id}: protected value is not globally unique: ${value}`);
      protectedValues.add(normalized);
      if (key !== "retry_cap" && key !== "lease_seconds" && item.updates.some((update) => stressNormalizeExact(update).includes(normalized))) {
        throw new Error(`${item.id}: update re-exposes protected ${key}: ${value}`);
      }
    }
    for (const key of STRESS_NEW_FACT_KEYS) {
      const value = item.new_facts[key];
      const normalized = stressNormalizeExact(value);
      if (!value || newValues.has(normalized)) throw new Error(`${item.id}: missing or duplicate new fact ${key}: ${value}`);
      newValues.add(normalized);
      const matchingRounds = item.updates
        .map((update, index) => stressNormalizeExact(update).includes(normalized) ? index + 1 : null)
        .filter((round): round is number => round !== null);
      if (matchingRounds.length !== 1 || matchingRounds[0] !== NEW_FACT_ROUNDS[key]) {
        throw new Error(`${item.id}: ${key} must appear only at round ${NEW_FACT_ROUNDS[key]}, got ${matchingRounds.join(",") || "none"}`);
      }
    }
  }
}

function rotate<T>(values: readonly T[], offset: number): T[] {
  const at = ((offset % values.length) + values.length) % values.length;
  return [...values.slice(at), ...values.slice(0, at)];
}

export function stressConditionOrder(repeatIndex: number): StressCondition[] {
  return rotate(STRESS_CONDITIONS, repeatIndex - 1);
}

export function buildStressPackets(cases: StressCase[], finalRewritten: Record<string, string>): Record<StressCondition, Record<string, string>> {
  const packets = Object.fromEntries(STRESS_CONDITIONS.map((condition) => [condition, {}])) as Record<StressCondition, Record<string, string>>;
  for (const item of cases) {
    const rewritten = finalRewritten[item.id];
    if (!rewritten?.trim()) throw new Error(`${item.id}: missing final rewritten memory`);
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

export function buildStressUpdatePrompt(cases: StressCase[], prior: Record<string, string>, round: number, repeatIndex: number): string {
  if (!Number.isSafeInteger(round) || round < 1 || round > STRESS_UPDATE_ROUNDS) throw new Error(`invalid update round: ${round}`);
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
    "All observations are non-conflicting. Incorporate the new observation and preserve as many useful existing facts as fit.",
    `The ${STRESS_WORD_CAP}-word maximum is absolute and takes priority over completeness; target at most ${STRESS_TARGET_WORDS} words for headroom.`,
    "Use compact key=value clauses, omit lower-priority details when necessary, and never mix facts between cases.",
    "Return exactly one memories entry per case with the unchanged case_id.",
    "",
    ...blocks.flatMap((block) => [block, ""]),
  ].join("\n");
}

function stressQuestionText(item: StressCase): string[] {
  return [
    `queue: What queue does ${item.name} use?`,
    `retry_cap: What is ${item.name}'s retry cap? Return only the number as a string.`,
    `idempotency_header: What idempotency header must ${item.name} use?`,
    `forbidden_fallback: What fallback is forbidden for ${item.name}?`,
    `primary_region: What is ${item.name}'s primary region?`,
    `schema_namespace: What is ${item.name}'s schema namespace?`,
    `encryption_profile: What encryption profile does ${item.name} use?`,
    `audit_topic: What is ${item.name}'s audit topic?`,
    `health_path: What is ${item.name}'s health path?`,
    `lease_seconds: What is ${item.name}'s lease duration in seconds? Return only the number as a string.`,
    `recovery_contact: What is ${item.name}'s recovery contact?`,
    `checksum_salt: What is ${item.name}'s checksum salt?`,
    `current_owner: Who is the current owner of ${item.name}?`,
    `docs_locale: What is ${item.name}'s operator-documentation locale?`,
    `deployment_zone: What is ${item.name}'s deployment zone?`,
    `rollout_window: What is ${item.name}'s rollout window?`,
    `compliance_tag: What compliance tag does ${item.name} carry?`,
    `escalation_room: What is ${item.name}'s escalation room?`,
  ];
}

export function buildStressQaPrompt(cases: StressCase[], packets: Record<string, string>, repeatIndex: number, condition: StressCondition): string {
  const ordered = rotate(cases, repeatIndex + STRESS_CONDITIONS.indexOf(condition) - 1);
  const blocks = ordered.map((item) => [
    `CASE ${item.id}`,
    "MEMORY:",
    packets[item.id],
    "QUESTIONS:",
    ...stressQuestionText(item),
  ].join("\n"));
  return [
    "Answer every question using only that case's MEMORY block.",
    `If a value is absent, return exactly ${UNKNOWN}. Copy present values exactly; do not explain or infer.`,
    "Return exactly one answers entry per case with the unchanged case_id and all eighteen value keys.",
    "",
    ...blocks.flatMap((block) => [block, ""]),
  ].join("\n");
}

function assertStressAnswerShape(cases: StressCase[], value: unknown): asserts value is StressConditionAnswer {
  const answers = (value as { answers?: unknown })?.answers;
  if (!Array.isArray(answers) || answers.length !== cases.length) throw new Error(`QA response must contain ${cases.length} answers`);
  const expected = new Set(cases.map((item) => item.id));
  const seen = new Set<string>();
  for (const row of answers as StressAnswerRow[]) {
    if (!row || typeof row.case_id !== "string" || !expected.has(row.case_id)) throw new Error(`QA response has unknown case_id: ${String(row?.case_id)}`);
    if (seen.has(row.case_id)) throw new Error(`QA response duplicates case_id: ${row.case_id}`);
    seen.add(row.case_id);
    if (!row.values || typeof row.values !== "object") throw new Error(`${row.case_id}: QA response has no values object`);
    for (const key of [...STRESS_PROTECTED_KEYS, ...STRESS_NEW_FACT_KEYS]) {
      if (typeof row.values[key] !== "string") throw new Error(`${row.case_id}: QA response has no string ${key}`);
    }
  }
}

export function scoreStressCondition(cases: StressCase[], condition: StressCondition, answer: StressConditionAnswer): StressConditionScore {
  assertStressAnswerShape(cases, answer);
  const byId = new Map(answer.answers.map((row) => [row.case_id, row]));
  const units: StressUnitScore[] = [];
  for (const item of cases) {
    const observed = byId.get(item.id)!;
    for (const key of STRESS_PROTECTED_KEYS) {
      const expected = item.protected[key];
      const actual = observed.values[key];
      units.push({
        unit_id: `${item.id}:${key}`,
        case_id: item.id,
        key,
        expected,
        observed: actual,
        correct: stressNormalizeExact(actual) === stressNormalizeExact(expected),
      });
    }
    for (const key of STRESS_NEW_FACT_KEYS) {
      const expected = condition === "clean" ? UNKNOWN : item.new_facts[key];
      const actual = observed.values[key];
      units.push({
        unit_id: `${item.id}:${key}`,
        case_id: item.id,
        key,
        expected,
        observed: actual,
        correct: stressNormalizeExact(actual) === stressNormalizeExact(expected),
      });
    }
  }
  const protectedUnits = units.filter((unit) => (STRESS_PROTECTED_KEYS as readonly string[]).includes(unit.key));
  const newUnits = units.filter((unit) => (STRESS_NEW_FACT_KEYS as readonly string[]).includes(unit.key));
  const aggregate = (selected: StressUnitScore[]) => {
    const correct = selected.filter((unit) => unit.correct).length;
    return { correct, total: selected.length, accuracy: correct / selected.length };
  };
  return { condition, protected: aggregate(protectedUnits), new_facts: aggregate(newUnits), units };
}

export function pairedStressScore(scores: Record<StressCondition, StressConditionScore>): StressPairedScore {
  const protectedMap = (condition: StressCondition) => new Map(
    scores[condition].units
      .filter((unit) => (STRESS_PROTECTED_KEYS as readonly string[]).includes(unit.key))
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

export function parseStressStructuredResult(stdout: string): { envelope: Record<string, unknown>; parsed: unknown } {
  let envelope: Record<string, unknown>;
  try {
    envelope = JSON.parse(stdout) as Record<string, unknown>;
  } catch {
    throw new Error("claude returned a non-JSON outer envelope");
  }
  if (envelope.is_error === true || (typeof envelope.subtype === "string" && envelope.subtype !== "success")) {
    throw new Error(`claude reported an error${envelope.subtype ? `: ${envelope.subtype}` : ""}`);
  }
  if (envelope.structured_output && typeof envelope.structured_output === "object") return { envelope, parsed: envelope.structured_output };
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

function runStressClaude(prompt: string, schema: object, model: string, role: StressClaudeCall["role"]): StressClaudeCall {
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

function updateStressMemories(cases: StressCase[], parsed: unknown): Record<string, string> {
  const memories = (parsed as { memories?: unknown })?.memories;
  if (!Array.isArray(memories) || memories.length !== cases.length) throw new Error(`update response must contain ${cases.length} memories`);
  const expected = new Set(cases.map((item) => item.id));
  const result: Record<string, string> = {};
  for (const row of memories as Array<{ case_id?: unknown; memory_text?: unknown }>) {
    if (typeof row.case_id !== "string" || !expected.has(row.case_id)) throw new Error(`update response has unknown case_id: ${String(row.case_id)}`);
    if (result[row.case_id]) throw new Error(`update response duplicates case_id: ${row.case_id}`);
    result[row.case_id] = validateStressMemoryText(row.case_id, row.memory_text);
  }
  return result;
}

function commandVersion(command: string, args: string[]): string {
  const run = spawnSync(command, args, { cwd: BENCH_DIR, encoding: "utf8", timeout: 8_000, shell: false });
  if (run.error || run.status !== 0) throw new Error(`${command} is unavailable`);
  return (run.stdout || run.stderr).trim().split(/\r?\n/)[0]?.trim() ?? "unknown";
}

function parseArgs(argv: string[]): { repeatIndex: number; dryRun: boolean; model: string; resultsDir: string } {
  const value = (name: string, fallback: string): string => {
    const at = argv.indexOf(`--${name}`);
    return at >= 0 && argv[at + 1] ? argv[at + 1]! : fallback;
  };
  const repeatIndex = Number(value("repeat-index", "1"));
  if (!Number.isSafeInteger(repeatIndex) || repeatIndex < 1 || repeatIndex > 3) throw new Error(`--repeat-index must be 1, 2, or 3; got ${repeatIndex}`);
  return {
    repeatIndex,
    dryRun: argv.includes("--dry-run"),
    model: value("model", DEFAULT_MODEL),
    resultsDir: resolve(value("results-dir", DEFAULT_RESULTS_DIR)),
  };
}

export function stressDryRunSummary(cases: StressCase[], repeatIndex: number, model = DEFAULT_MODEL): Record<string, unknown> {
  validateStressCases(cases);
  const initial = Object.fromEntries(cases.map((item) => [item.id, item.seed]));
  const firstUpdate = buildStressUpdatePrompt(cases, initial, 1, repeatIndex);
  const placeholder = Object.fromEntries(cases.map((item) => [item.id, `[MODEL-GENERATED MEMORY FOR ${item.id}]`]));
  const packets = buildStressPackets(cases, placeholder);
  return {
    valid: true,
    no_model_calls_made: true,
    protocol_version: 4,
    repeat_index: repeatIndex,
    model,
    case_count: cases.length,
    update_rounds: STRESS_UPDATE_ROUNDS,
    word_cap: STRESS_WORD_CAP,
    target_words: STRESS_TARGET_WORDS,
    protected_units: cases.length * STRESS_PROTECTED_KEYS.length,
    new_fact_units: cases.length * STRESS_NEW_FACT_KEYS.length,
    planned_model_calls: STRESS_UPDATE_ROUNDS + STRESS_CONDITIONS.length,
    max_cli_turns_per_call: 2,
    condition_order: stressConditionOrder(repeatIndex),
    case_bank_sha256: stressSha256(JSON.stringify(cases)),
    runner_sha256: stressSha256(readFileSync(THIS_FILE)),
    system_prompt_sha256: stressSha256(SYSTEM_PROMPT),
    update_schema_sha256: stressSha256(JSON.stringify(UPDATE_SCHEMA)),
    qa_schema_sha256: stressSha256(JSON.stringify(QA_SCHEMA)),
    first_update_prompt_sha256: stressSha256(firstUpdate),
    qa_placeholder_prompt_sha256: Object.fromEntries(STRESS_CONDITIONS.map((condition) => [
      condition,
      stressSha256(buildStressQaPrompt(cases, packets[condition], repeatIndex, condition)),
    ])),
  };
}

async function main(): Promise<void> {
  const options = parseArgs(process.argv.slice(2));
  const cases = buildStressCases();
  validateStressCases(cases);
  if (options.dryRun) {
    process.stdout.write(`${JSON.stringify(stressDryRunSummary(cases, options.repeatIndex, options.model), null, 2)}\n`);
    return;
  }

  mkdirSync(options.resultsDir, { recursive: true });
  const outputPath = join(options.resultsDir, `2026-08-27-hunch-direct-memory-capacity-stress-v4-repeat-${options.repeatIndex}.json`);
  if (existsSync(outputPath)) throw new Error(`refusing to overwrite frozen evidence: ${outputPath}`);
  const result: StressResult = {
    schema_version: 1,
    protocol_version: 4,
    experiment: "hunch-direct-memory-capacity-stress",
    status: "running",
    repeat_index: options.repeatIndex,
    started_at: new Date().toISOString(),
    model: options.model,
    claude_cli_version: commandVersion("claude", ["--version"]),
    git_head: commandVersion("git", ["rev-parse", "HEAD"]),
    runner_sha256: stressSha256(readFileSync(THIS_FILE)),
    case_bank_sha256: stressSha256(JSON.stringify(cases)),
    system_prompt_sha256: stressSha256(SYSTEM_PROMPT),
    case_count: cases.length,
    protected_units: cases.length * STRESS_PROTECTED_KEYS.length,
    update_rounds: STRESS_UPDATE_ROUNDS,
    word_cap: STRESS_WORD_CAP,
    target_words: STRESS_TARGET_WORDS,
    condition_order: stressConditionOrder(options.repeatIndex),
    checkpoints: [],
    qa_calls: {},
  };

  try {
    let rewritten = Object.fromEntries(cases.map((item) => [item.id, item.seed]));
    for (let round = 1; round <= STRESS_UPDATE_ROUNDS; round += 1) {
      const prompt = buildStressUpdatePrompt(cases, rewritten, round, options.repeatIndex);
      const call = runStressClaude(prompt, UPDATE_SCHEMA, options.model, "replacement_update");
      rewritten = updateStressMemories(cases, call.parsed);
      result.checkpoints.push({
        round,
        observation_by_case: Object.fromEntries(cases.map((item) => [item.id, item.updates[round - 1]!])),
        memories: cases.map((item) => {
          const memoryText = rewritten[item.id]!;
          return {
            case_id: item.id,
            memory_text: memoryText,
            chars: memoryText.length,
            words: stressWordCount(memoryText),
            protected_exact_retention: Object.fromEntries(STRESS_PROTECTED_KEYS.map((key) => [
              key,
              stressNormalizeExact(memoryText).includes(stressNormalizeExact(item.protected[key])),
            ])) as Record<StressProtectedKey, boolean>,
          };
        }),
        call,
      });
      process.stderr.write(`stress repeat ${options.repeatIndex}: replacement round ${round}/${STRESS_UPDATE_ROUNDS} complete\n`);
    }

    const packets = buildStressPackets(cases, rewritten);
    const scores = {} as Record<StressCondition, StressConditionScore>;
    for (const condition of result.condition_order) {
      const prompt = buildStressQaPrompt(cases, packets[condition], options.repeatIndex, condition);
      const call = runStressClaude(prompt, QA_SCHEMA, options.model, "downstream_qa");
      assertStressAnswerShape(cases, call.parsed);
      result.qa_calls[condition] = call;
      scores[condition] = scoreStressCondition(cases, condition, call.parsed);
      process.stderr.write(`stress repeat ${options.repeatIndex}: ${condition} QA complete\n`);
    }
    result.condition_scores = scores;
    result.paired_score = pairedStressScore(scores);
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
