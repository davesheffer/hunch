/**
 * Verification pipeline (the "enforcement spine"): hooks that guarantee the
 * operating loop — evidence → change → verify → attack → report — instead of
 * hoping the agent reads a skill. Measured motivation (2026-07-08 zod bench):
 * skills-as-files were read in 0/20 sessions; when the same content was
 * guaranteed-delivered, FAIL→PASS flipped on every discriminating cell.
 * Delivery, not content, was the bottleneck — so delivery is enforced here.
 *
 * Gates evaluate OBSERVABLE FACTS recorded from PostToolUse events (which
 * files were edited, which verify-shaped commands ran afterwards) — never the
 * agent's claims. The Stop gate refuses to end a turn with unverified product
 * edits, at most twice per turn: a broken gate degrades to advisory, never a
 * lockout.
 *
 * Firmness mapping (no new knob):
 *   off      → pipeline inert
 *   advisory → inject the loop at SessionStart + nag on unverified edits; no blocks
 *   firm     → + Stop gate (max 2 blocks per turn)
 *   strict   → same as firm (strict's extra bite lives in the pre-edit deny gate)
 *
 * State is per-session scratch in the OS tmpdir (NOT .hunch/ — it is derived,
 * disposable, and single-writer), mirroring hookcache.ts. Failure posture is
 * con_03a0b94b2e: any error → do nothing, exit clean. Kill switch: HUNCH_PIPELINE=0.
 */
import { mkdirSync, readFileSync, readdirSync, rmSync, statSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { compareCodeUnits } from "./canonicalOrder.js";

export type Firmness = "off" | "advisory" | "firm" | "strict";

export const EXECUTION_OBLIGATION_CATEGORIES = [
  "evidence",
  "behavior",
  "types",
  "serialization",
  "compatibility",
  "other",
] as const;
export type ExecutionObligationCategory = (typeof EXECUTION_OBLIGATION_CATEGORIES)[number];
export type ExecutionObligationPhase = "before-edit" | "session" | "after-edit";
export type ExecutionObligationOrigin = "memory" | "episode" | "manual";

export const CONTRACT_AXES = ["runtime", "static", "serialization", "compatibility"] as const;
export type ContractAxis = (typeof CONTRACT_AXES)[number];

export interface ExecutionExpectation {
  /** Whether the tool call itself must succeed or fail. */
  success: boolean;
  /** Case-insensitive output markers that must all be present/absent. */
  output_includes?: string[];
  output_excludes?: string[];
}

export interface ExecutableProbe {
  id: string;
  origin: ExecutionObligationOrigin;
  category: ExecutionObligationCategory;
  claim: string;
  falsifier: string;
  /** Exact bounded command shown to the agent; Hunch never executes it itself. */
  command: string;
  /** Optional orchestrator materialization; never written or executed by hooks. */
  artifact?: { path: string; content: string };
  /** OR-of-AND tokens used to recognize the observed command safely. */
  command_alternatives: string[][];
  expected_before: ExecutionExpectation;
  expected_after: ExecutionExpectation;
}

export interface ContractAxisAudit {
  /** Axes promised by the supplied after-edit proof plan. */
  required: ContractAxis[];
  /** Axes already exercised by the executable contrast. */
  covered: ContractAxis[];
  /** Required axes not closed by the contrast itself. */
  missing: ContractAxis[];
}

export interface ContractAxisProbeClosure extends ContractAxisAudit {
  /** Independently red→green probes selected for uncovered axes. */
  probes: ExecutableProbe[];
}

export interface ContractAxisDisclosure {
  category: ExecutionObligationCategory;
  claim: string;
  falsifier: string;
}

export interface ContractAxisRiskHint {
  probe_id: string;
  category: ExecutionObligationCategory;
  owner: string;
}

export interface ContractAxisOwnerSource {
  path: string;
  content: string;
}

interface OwnerDeclaration {
  kind: string;
  symbol: string;
  index: number;
}

function ownerSourcePath(path: string): boolean {
  return /^[A-Za-z0-9._/-]+\.(?:tsx?|php)$/.test(path)
    && !/(?:^|\/)(?:tests?|__tests__)(?:\/|$)|\.test\.(?:tsx?|php)$/.test(path);
}

/** Extract top-level declarations for the bounded correction diagnostic. PHP
 * declarations deliberately require column-zero PSR-style layout so methods or
 * nested conditional declarations cannot masquerade as repository owners. */
function ownerDeclarations(path: string, content: string): OwnerDeclaration[] {
  const declaration = path.endsWith(".php")
    ? /^(?:(?:#\[[^\r\n]*\])\r?\n)*(?:(abstract|final|readonly)\s+)*(class|interface|trait|enum|function)\s+&?\s*([A-Za-z_][A-Za-z0-9_]*)/gm
    : /(?:^|\n)\s*(?:export\s+)?(?:declare\s+)?(interface|class|function|const|type)\s+([$A-Za-z_][$\w]*)/g;
  return [...content.matchAll(declaration)].map((match) => path.endsWith(".php")
    ? { kind: match[2]!, symbol: match[3]!, index: match.index ?? 0 }
    : { kind: match[1]!, symbol: match[2]!, index: match.index ?? 0 });
}

export interface ContractAxisOwnerInference {
  hint: ContractAxisRiskHint;
  level: "symbol" | "file";
  anchor: string;
  score: number;
  runner_up_score: number | null;
}

export interface ContractAxisOwnerRanking {
  probe_id: string;
  category: ExecutionObligationCategory;
  candidates: Array<{ owner: string; anchor: string; score: number }>;
}

export interface ImplementationOwnerRanking {
  candidates: Array<{
    owner: string;
    score: number;
    lexical_score: number;
    symbol_disclosed: boolean;
    path_disclosed: boolean;
  }>;
}

export interface ImplementationOwnerInference {
  owner: string;
  score: number;
  runner_up_score: number | null;
  symbol_disclosed: boolean;
  path_disclosed: boolean;
}

export interface AdaptiveContractAxisProbeClosure extends ContractAxisProbeClosure {
  /** One staged probe: main contrast first, uncovered consumers only once main is green. */
  probe: ExecutableProbe | null;
  /** Design-time consumer contracts, deliberately excluding executable commands. */
  disclosures: ContractAxisDisclosure[];
}

export interface ExecutionProbeBinding {
  id: string;
  stage: "baseline" | "validation";
  claim: string;
  falsifier: string;
  command: string;
}

/** A bounded, observable proof obligation. `command_alternatives` is OR-of-AND:
 * one alternative selects a check when every token occurs in its command. The
 * separate `expected` predicate decides whether the observed result proves it.
 * Tokens are data, never executable regexes. */
export interface ExecutionObligation {
  id: string;
  origin: ExecutionObligationOrigin;
  category: ExecutionObligationCategory;
  phase: ExecutionObligationPhase;
  description: string;
  command_alternatives: string[][];
  expected: ExecutionExpectation;
  /** Present when this obligation was compiled from one red→green probe. */
  probe?: ExecutionProbeBinding;
}

export interface ExecutionAttempt {
  command: string;
  outcome: "success" | "failure" | "unknown";
  expectation_met: boolean;
  missing_output?: string[];
  forbidden_output?: string[];
}

export interface TrackedExecutionObligation extends ExecutionObligation {
  status: "pending" | "satisfied";
  satisfied_by?: string;
  satisfied_at_edit?: number;
  last_attempt?: ExecutionAttempt;
}

export interface PipelineState {
  turn: number;
  soulInjected: boolean;
  /** Stop blocks issued THIS turn (reset on every user prompt). */
  blocks: number;
  /** Pre-edit evidence denials THIS turn; bounded separately from Stop. */
  probeBlocks: number;
  /** Domains activated by edited paths, e.g. { backend: true }. */
  domains: Record<string, boolean>;
  editedFiles: string[];
  /** True until a product edit happens, then true only after a verify command. */
  verifyAfterEdit: boolean;
  /** Monotonic product-edit generation; after-edit proofs bind to this value. */
  editGeneration: number;
  /** Specific proofs supplied by memory, an episode, or an orchestrator. */
  obligations: TrackedExecutionObligation[];
  /** Relevant PostToolUse activity observed while a proof plan is armed. */
  proofActivity: number;
  /** Activity index and count for bounded mid-flight reminders. */
  proofReminderActivity: number;
  proofReminders: number;
  /** Sibling-fix lessons delivered this session (see core/siblingfix.ts). */
  lessons: PendingLesson[];
}

/** A delivered lesson the agent has not visibly acted on yet. `hash` is the
 *  target function's body at delivery; a different body later means the agent
 *  touched it, so the lesson is no longer pending. */
export interface PendingLesson {
  id: string;
  file: string;
  symbol: string;
  sibling: string;
  siblingFile: string;
  /** "<sha8> <subject>" of the change the sibling received. */
  change: string;
  callers: string[];
  hash: string | null;
  reminded: boolean;
}

export const emptyState = (): PipelineState => ({
  turn: 0,
  soulInjected: false,
  blocks: 0,
  probeBlocks: 0,
  domains: {},
  editedFiles: [],
  verifyAfterEdit: true,
  editGeneration: 0,
  obligations: [],
  proofActivity: 0,
  proofReminderActivity: 0,
  proofReminders: 0,
  lessons: [],
});

const MAX_OBLIGATIONS = 12;
const MAX_ALTERNATIVES = 6;
const MAX_TOKENS = 8;
const MAX_OUTPUT_MARKERS = 8;
const MAX_PROBES = 3;

function boundedText(value: unknown, max: number): string | null {
  if (typeof value !== "string") return null;
  const text = value.replace(/\s+/g, " ").trim();
  return text && text.length <= max ? text : null;
}

function normalizeAlternatives(value: unknown): string[][] {
  if (!Array.isArray(value)) return [];
  return value.slice(0, MAX_ALTERNATIVES)
    .filter(Array.isArray)
    .map((alternative) => alternative.slice(0, MAX_TOKENS).map((token) => boundedText(token, 120)).filter((token): token is string => !!token))
    .filter((alternative) => alternative.length > 0);
}

function normalizeExpectation(value: unknown): ExecutionExpectation | null {
  const raw = value && typeof value === "object" && !Array.isArray(value)
    ? value as Record<string, unknown>
    : null;
  if (!raw || typeof raw.success !== "boolean") return null;
  const normalizeMarkers = (markers: unknown): string[] | undefined => {
    if (markers === undefined) return undefined;
    if (!Array.isArray(markers)) return [];
    return markers.slice(0, MAX_OUTPUT_MARKERS)
      .map((marker) => boundedText(marker, 160))
      .filter((marker): marker is string => !!marker);
  };
  const outputIncludes = normalizeMarkers(raw.output_includes);
  const outputExcludes = normalizeMarkers(raw.output_excludes);
  if (outputIncludes?.length === 0 || outputExcludes?.length === 0) return null;
  return {
    success: raw.success,
    ...(outputIncludes ? { output_includes: outputIncludes } : {}),
    ...(outputExcludes ? { output_excludes: outputExcludes } : {}),
  };
}

/** Validate untrusted MCP/env episode data. Invalid entries are ignored so the
 * hook's fail-open safety posture remains intact. */
export function normalizeExecutionObligations(value: unknown): ExecutionObligation[] {
  if (!Array.isArray(value)) return [];
  const out: ExecutionObligation[] = [];
  const seen = new Set<string>();
  for (const raw of value.slice(0, MAX_OBLIGATIONS)) {
    if (!raw || typeof raw !== "object" || Array.isArray(raw)) continue;
    const item = raw as Record<string, unknown>;
    const id = boundedText(item.id, 100);
    const description = boundedText(item.description, 320);
    const origin = item.origin;
    const category = item.category;
    const phase = item.phase;
    if (!id || !/^[A-Za-z0-9._:-]+$/.test(id) || seen.has(id) || !description) continue;
    if (origin !== "memory" && origin !== "episode" && origin !== "manual") continue;
    if (!(EXECUTION_OBLIGATION_CATEGORIES as readonly unknown[]).includes(category)) continue;
    if (phase !== "before-edit" && phase !== "session" && phase !== "after-edit") continue;
    const alternatives = normalizeAlternatives(item.command_alternatives);
    if (!alternatives.length) continue;
    const expected = normalizeExpectation(item.expected);
    if (!expected) continue;
    const rawProbe = item.probe && typeof item.probe === "object" && !Array.isArray(item.probe)
      ? item.probe as Record<string, unknown>
      : null;
    const probeId = boundedText(rawProbe?.id, 100);
    const probeStage = rawProbe?.stage;
    const probeClaim = boundedText(rawProbe?.claim, 480);
    const probeFalsifier = boundedText(rawProbe?.falsifier, 480);
    const probeCommand = boundedText(rawProbe?.command, 1_600);
    const probe = probeId && /^[A-Za-z0-9._:-]+$/.test(probeId)
      && (probeStage === "baseline" || probeStage === "validation")
      && probeClaim && probeFalsifier && probeCommand
      ? { id: probeId, stage: probeStage, claim: probeClaim, falsifier: probeFalsifier, command: probeCommand } satisfies ExecutionProbeBinding
      : undefined;
    seen.add(id);
    out.push({
      id,
      origin,
      category: category as ExecutionObligationCategory,
      phase,
      description,
      command_alternatives: alternatives,
      expected,
      ...(probe ? { probe } : {}),
    });
  }
  return out;
}

/** Validate untrusted probe specs. Probes are declarative data; only the agent
 * sees the bounded command, and ordinary tool hooks observe its result. */
export function normalizeExecutableProbes(value: unknown): ExecutableProbe[] {
  if (!Array.isArray(value)) return [];
  const probes: ExecutableProbe[] = [];
  const seen = new Set<string>();
  for (const raw of value.slice(0, MAX_PROBES)) {
    if (!raw || typeof raw !== "object" || Array.isArray(raw)) continue;
    const item = raw as Record<string, unknown>;
    const id = boundedText(item.id, 100);
    const claim = boundedText(item.claim, 480);
    const falsifier = boundedText(item.falsifier, 480);
    const command = boundedText(item.command, 1_600);
    const origin = item.origin;
    const category = item.category;
    const alternatives = normalizeAlternatives(item.command_alternatives);
    const expectedBefore = normalizeExpectation(item.expected_before);
    const expectedAfter = normalizeExpectation(item.expected_after);
    const rawArtifact = item.artifact && typeof item.artifact === "object" && !Array.isArray(item.artifact)
      ? item.artifact as Record<string, unknown>
      : null;
    const artifactPath = boundedText(rawArtifact?.path, 200);
    const artifactContent = typeof rawArtifact?.content === "string" && rawArtifact.content.length > 0 && rawArtifact.content.length <= 4_000
      ? rawArtifact.content
      : null;
    const artifact = artifactPath && /^\.hunch-probes\/[A-Za-z0-9._/-]+$/.test(artifactPath)
      && !artifactPath.split("/").includes("..") && artifactContent
      ? { path: artifactPath, content: artifactContent }
      : undefined;
    if (rawArtifact && !artifact) continue;
    if (!id || !/^[A-Za-z0-9._:-]+$/.test(id) || seen.has(id) || !claim || !falsifier || !command) continue;
    if (origin !== "memory" && origin !== "episode" && origin !== "manual") continue;
    if (!(EXECUTION_OBLIGATION_CATEGORIES as readonly unknown[]).includes(category)) continue;
    if (!alternatives.length || !expectedBefore || !expectedAfter) continue;
    seen.add(id);
    probes.push({
      id,
      origin,
      category: category as ExecutionObligationCategory,
      claim,
      falsifier,
      command,
      ...(artifact ? { artifact } : {}),
      command_alternatives: alternatives,
      expected_before: expectedBefore,
      expected_after: expectedAfter,
    });
  }
  return probes;
}

const CONTRACT_AXIS_BY_CATEGORY: Partial<Record<ExecutionObligationCategory, ContractAxis>> = {
  behavior: "runtime",
  types: "static",
  serialization: "serialization",
  compatibility: "compatibility",
};

function markerAssignments(expectation: ExecutionExpectation): Map<string, string> {
  const assignments = new Map<string, string>();
  for (const marker of expectation.output_includes ?? []) {
    const match = marker.match(/^([^=\s]+)=([^\s]+)$/);
    if (match) assignments.set(match[1]!.toLowerCase(), match[2]!.toLowerCase());
  }
  return assignments;
}

/** Infer which contract consumers an immutable executable contrast actually
 * exercises. This is deliberately conservative: static coverage requires both
 * type-shaped source and a typechecking command, while compatibility requires
 * at least one key=value control that stays identical across red and green. */
export function discoverExecutableProbeContractAxes(value: unknown): ContractAxis[] {
  const probe = normalizeExecutableProbes([value])[0];
  if (!probe) return [];
  const source = probe.artifact?.content ?? "";
  const command = [probe.command, ...probe.command_alternatives.flat()].join(" ");
  const axes = new Set<ContractAxis>();
  if (probe.category === "behavior" || /\.(?:safeParse|parse|parseAsync)\s*\(/.test(source)) axes.add("runtime");
  if (/\b(?:tsc|typecheck)\b|--typecheck\b/i.test(command)
    && /expectTypeOf|\bz\.(?:input|output)\b|\[\s*["']_zod["']\s*\]|\b(?:Input|Output)\s*</.test(source)) {
    axes.add("static");
  }
  if (/toJSONSchema|jsonSchema|serialize|deserialize|openapi/i.test(source)) axes.add("serialization");
  const before = markerAssignments(probe.expected_before);
  const after = markerAssignments(probe.expected_after);
  const stableControls = [...before].filter(([key, result]) => key !== "state" && after.get(key) === result);
  if (probe.category === "compatibility" || stableControls.length > 0) axes.add("compatibility");
  return CONTRACT_AXES.filter((axis) => axes.has(axis));
}

/** Compare a contrast with its broader proof plan. This audit is diagnostic:
 * category-labelled regression tests are not proof that an axis is closed. */
export function auditExecutableProbeContractAxes(probeValue: unknown, obligationValue: unknown): ContractAxisAudit {
  const obligations = normalizeExecutionObligations(obligationValue);
  const requiredSet = new Set<ContractAxis>();
  for (const obligation of obligations) {
    if (obligation.phase !== "after-edit") continue;
    const axis = CONTRACT_AXIS_BY_CATEGORY[obligation.category];
    if (axis) requiredSet.add(axis);
  }
  const coveredSet = new Set(discoverExecutableProbeContractAxes(probeValue));
  const required = CONTRACT_AXES.filter((axis) => requiredSet.has(axis));
  const covered = CONTRACT_AXES.filter((axis) => coveredSet.has(axis));
  const missing = required.filter((axis) => !coveredSet.has(axis));
  return { required, covered, missing };
}

/** Promote only independently falsifiable red→green probes for uncovered axes.
 * A passing neighboring test is intentionally ineligible: the V experiment
 * showed that it can resolve every receipt while leaving the claimed static
 * contract wrong. */
export function compileContractAxisProbeClosure(
  contrastValue: unknown,
  obligationValue: unknown,
  candidateValue: unknown,
): ContractAxisProbeClosure {
  const audit = auditExecutableProbeContractAxes(contrastValue, obligationValue);
  const missing = new Set(audit.missing);
  const chosen = new Map<ContractAxis, ExecutableProbe>();
  for (const probe of normalizeExecutableProbes(candidateValue)) {
    const axis = CONTRACT_AXIS_BY_CATEGORY[probe.category];
    if (!axis || !missing.has(axis) || chosen.has(axis)) continue;
    const before = new Set((probe.expected_before.output_includes ?? []).map((marker) => marker.toLowerCase()));
    const after = new Set((probe.expected_after.output_includes ?? []).map((marker) => marker.toLowerCase()));
    if (!before.has("state=red") || !after.has("state=green")) continue;
    chosen.set(axis, probe);
  }
  return {
    ...audit,
    probes: CONTRACT_AXES.flatMap((axis) => {
      const probe = chosen.get(axis);
      return probe ? [probe] : [];
    }),
  };
}

/** Collapse a qualified axis closure into one staged red→green probe. The main
 * contrast runs first on both passes. While it is red, consumer probes are
 * skipped; once it turns green, only then are the independently qualified
 * static/serialization/compatibility commands executed. This keeps the biting
 * closure of W without forcing every baseline into the agent's pre-edit loop. */
export function compileAdaptiveContractAxisProbeClosure(
  contrastValue: unknown,
  obligationValue: unknown,
  candidateValue: unknown,
): AdaptiveContractAxisProbeClosure {
  const closure = compileContractAxisProbeClosure(contrastValue, obligationValue, candidateValue);
  const disclosures = closure.probes.map(({ category, claim, falsifier }) => ({ category, claim, falsifier }));
  const contrast = normalizeExecutableProbes([contrastValue])[0];
  if (!contrast || closure.probes.length === 0) return { ...closure, probe: null, disclosures };

  const slug = contrast.id.replace(/[^A-Za-z0-9._-]+/g, "-").slice(0, 80);
  const artifactPath = `.hunch-probes/${slug}-adaptive.mjs`;
  const specs = [contrast, ...closure.probes].map((probe, index) => ({
    label: index === 0 ? "main" : probe.category,
    command: probe.command,
    expected: probe.expected_after,
  }));
  const artifactContent = [
    `import { spawnSync } from "node:child_process";`,
    `const specs=${JSON.stringify(specs)};`,
    `const run=(spec)=>{const p=spawnSync(spec.command,{shell:true,encoding:"utf8",env:process.env});const output=String(p.stdout??"")+String(p.stderr??"");if(output)process.stdout.write(output.endsWith("\\n")?output:output+"\\n");const text=output.toLowerCase();const ok=((p.status===0)===spec.expected.success)&&(spec.expected.output_includes??[]).every(x=>text.includes(x.toLowerCase()))&&!(spec.expected.output_excludes??[]).some(x=>text.includes(x.toLowerCase()));return ok;};`,
    `const main=run(specs[0]);if(!main){console.log("HUNCH_ADAPTIVE state=red stage=main axes=skipped");}else{const failed=[];for(const spec of specs.slice(1)){if(!run(spec))failed.push(spec.label);}console.log("HUNCH_ADAPTIVE state="+(failed.length?"red":"green")+" stage="+(failed.length?"axes":"closed")+" axes="+(specs.length-1)+" failed="+(failed.join(",")||"none"));}`,
  ].join("\n");
  const probe: ExecutableProbe = {
    id: `${contrast.id}:adaptive`,
    origin: contrast.origin,
    category: contrast.category,
    claim: `Make the main contrast green, then close ${closure.probes.length} independently qualified missing consumer axis${closure.probes.length === 1 ? "" : "es"}.`,
    falsifier: "Reject the fix if the main behavior remains red or any qualified consumer contract stays red after the main behavior turns green.",
    command: `node ${artifactPath}`,
    artifact: { path: artifactPath, content: artifactContent },
    command_alternatives: [["node", artifactPath]],
    expected_before: {
      success: true,
      output_includes: ["HUNCH_ADAPTIVE", "state=red", "stage=main", "axes=skipped"],
    },
    expected_after: {
      success: true,
      output_includes: ["HUNCH_ADAPTIVE", "state=green", "stage=closed", `axes=${closure.probes.length}`, "failed=none"],
      output_excludes: ["state=red"],
    },
  };
  return { ...closure, probe: normalizeExecutableProbes([probe])[0] ?? null, disclosures };
}

/** Compile one author-ranked consumer risk into a bounded design hint. The
 * selected probe must already belong to the independently qualified closure.
 * Commands, claims, and falsifiers are deliberately excluded: this hint names
 * where to leave design room without turning the deferred consumer into work. */
export function compileContractAxisRiskHint(
  closure: ContractAxisProbeClosure,
  value: unknown,
): ContractAxisRiskHint | null {
  if (!value || typeof value !== "object" || Array.isArray(value)) return null;
  const raw = value as Record<string, unknown>;
  const probeId = boundedText(raw.probe_id, 100);
  const owner = boundedText(raw.owner, 240);
  if (!probeId || !owner || owner.startsWith("/") || owner.split("::")[0]!.split("/").includes("..")) return null;
  if (!/^[A-Za-z0-9._/-]+(?:::[A-Za-z0-9_$.-]+)?$/.test(owner)) return null;
  const selected = closure.probes.find((probe) => probe.id === probeId);
  return selected ? { probe_id: selected.id, category: selected.category, owner } : null;
}

const OWNER_ANCHOR_STOP_WORDS = new Set([
  "array", "classic", "core", "decode", "encode", "false", "input", "mini", "number", "object", "optional",
  "output", "parse", "required", "safeparse", "schema", "string", "tostring", "true",
  "type", "undefined", "unknown", "value",
]);

/** Infer one bounded risk owner using only qualified probes and pre-edit source
 * text supplied by the caller. Compatibility is ranked ahead of static and
 * serialization because it most often crosses a public-surface owner. Within
 * the chosen probe, public identifiers nominate existing declarations; an
 * explicit package surface in the probe breaks ties without reading future
 * changes. */
export function rankContractAxisRiskOwners(
  closure: ContractAxisProbeClosure,
  sourceValue: unknown,
): ContractAxisOwnerRanking | null {
  if (!Array.isArray(sourceValue) || closure.probes.length === 0) return null;
  const categoryRisk: Partial<Record<ExecutionObligationCategory, number>> = {
    compatibility: 30,
    types: 20,
    serialization: 10,
    behavior: 5,
  };
  const probe = closure.probes
    .map((candidate, index) => ({ candidate, index, risk: categoryRisk[candidate.category] ?? 0 }))
    .sort((a, b) => b.risk - a.risk || a.index - b.index)[0]?.candidate;
  if (!probe) return null;

  const artifact = probe.artifact?.content ?? "";
  const words = `${probe.id} ${probe.claim} ${probe.falsifier}`.match(/[A-Za-z_$][A-Za-z0-9_$-]{3,}/g) ?? [];
  const publicMembers = [...artifact.matchAll(/(?:\bz|\bvalue|\boriginal|\bcodec)\.([A-Za-z_$][A-Za-z0-9_$]*)/g)].map((match) => match[1]!);
  const calledMembers = [...artifact.matchAll(/(?:\bz|\bvalue|\boriginal|\bcodec)\.([A-Za-z_$][A-Za-z0-9_$]*)\s*\(/g)]
    .map((match) => match[1]!);
  const calledAnchors = new Set(calledMembers.map((member) => member.toLowerCase().replace(/[^a-z0-9]/g, "")));
  const candidates = new Map<string, number>();
  for (const [raw, weight] of [
    ...words.map((word) => [word, 1] as const),
    ...publicMembers.map((member) => [member, 4] as const),
    ...calledMembers.map((member) => [member, 12] as const),
  ]) {
    const token = raw.replace(/-/g, "").toLowerCase();
    if (token.length < 4 || OWNER_ANCHOR_STOP_WORDS.has(token)) continue;
    candidates.set(token, (candidates.get(token) ?? 0) + weight);
  }
  if (candidates.size === 0) return null;

  const scope = artifact.match(/packages\/[A-Za-z0-9._-]+\/src\/(?:v\d+\/)?(classic|mini|core)\//)?.[1] ?? null;
  const sources: ContractAxisOwnerSource[] = [];
  const seen = new Set<string>();
  for (const raw of sourceValue.slice(0, 4_000)) {
    if (!raw || typeof raw !== "object" || Array.isArray(raw)) continue;
    const item = raw as Record<string, unknown>;
    const path = boundedText(item.path, 240);
    const content = typeof item.content === "string" && item.content.length <= 1_000_000 ? item.content : null;
    if (!path || !content || seen.has(path) || path.startsWith("/") || path.split("/").includes("..")) continue;
    if (!ownerSourcePath(path)) continue;
    seen.add(path);
    sources.push({ path, content });
  }

  const ranked: Array<{ owner: string; anchor: string; score: number }> = [];
  for (const source of sources) {
    for (const { kind, symbol } of ownerDeclarations(source.path, source.content)) {
      const normalized = symbol.toLowerCase().replace(/[^a-z0-9]/g, "");
      for (const [anchor, evidenceWeight] of candidates) {
        if (!normalized.includes(anchor)) continue;
        let score = normalized === anchor
          ? probe.category === "compatibility" ? 120 : 130
          : 90;
        if (kind === "interface" || kind === "class") score += probe.category === "compatibility" ? 55 : 35;
        else score += 10;
        if (scope && source.path.includes(`/${scope}/`)) score += 50;
        if (source.path.endsWith("/schemas.ts") || source.path.endsWith("/schema.ts")) score += 20;
        if (probe.category === "compatibility" && scope && source.path.includes(`/${scope}/`)) score += 20;
        if (probe.category === "types" && /\/(?:classic|mini)\//.test(source.path)) score += 10;
        if (calledAnchors.has(anchor)) score += 45;
        score += Math.min(10, Math.floor(normalized.length / 4));
        score += Math.min(40, evidenceWeight * 5);
        ranked.push({ owner: `${source.path}::${symbol}`, anchor, score });
      }
    }
  }
  ranked.sort((a, b) => b.score - a.score || compareCodeUnits(a.owner, b.owner));
  const ownerScores = new Map<string, { owner: string; anchor: string; score: number }>();
  for (const item of ranked) {
    if (!ownerScores.has(item.owner)) ownerScores.set(item.owner, item);
  }
  const uniqueOwners = [...ownerScores.values()];
  return {
    probe_id: probe.id,
    category: probe.category,
    candidates: uniqueOwners.slice(0, 20),
  };
}

export function inferContractAxisRiskHint(
  closure: ContractAxisProbeClosure,
  sourceValue: unknown,
): ContractAxisOwnerInference | null {
  const ranking = rankContractAxisRiskOwners(closure, sourceValue);
  if (!ranking) return null;
  const uniqueOwners = ranking.candidates;
  const best = uniqueOwners[0];
  if (!best || best.score < 120) return null;
  const runnerUp = uniqueOwners[1];
  if (!runnerUp || best.score - runnerUp.score >= 5) {
    return {
      hint: { probe_id: ranking.probe_id, category: ranking.category, owner: best.owner },
      level: "symbol",
      anchor: best.anchor,
      score: best.score,
      runner_up_score: runnerUp?.score ?? null,
    };
  }

  const fileScores = new Map<string, { owner: string; anchor: string; score: number }>();
  for (const item of uniqueOwners) {
    const path = item.owner.split("::")[0]!;
    if (!fileScores.has(path)) fileScores.set(path, { ...item, owner: path });
  }
  const files = [...fileScores.values()];
  const bestFile = files[0];
  const runnerUpFile = files[1];
  if (!bestFile || (runnerUpFile && bestFile.score - runnerUpFile.score < 5)) return null;
  return {
    hint: { probe_id: ranking.probe_id, category: ranking.category, owner: bestFile.owner },
    level: "file",
    anchor: bestFile.anchor,
    score: bestFile.score,
    runner_up_score: runnerUpFile?.score ?? null,
  };
}

const IMPLEMENTATION_OWNER_STOP_WORDS = new Set([
  "about", "after", "again", "also", "because", "before", "being", "classic", "could", "does", "error", "expected",
  "from", "have", "input", "into", "issue", "json", "mini", "object", "output", "parse", "result", "safe", "schema",
  "should", "string", "that", "their", "there", "these", "this", "type", "typescript", "using", "value", "version", "when",
  "where", "which", "with", "would", "zod",
]);

function implementationOwnerTokens(value: string): string[] {
  const expanded = value.replace(/([a-z0-9])([A-Z])/g, "$1 $2").replace(/([A-Z])([A-Z][a-z])/g, "$1 $2");
  return (expanded.toLowerCase().match(/[a-z_$][a-z0-9_$-]{2,}/g) ?? [])
    .map((token) => token.replace(/^[$_-]+|[$_-]+$/g, ""))
    .filter((token) => token.length >= 3 && !IMPLEMENTATION_OWNER_STOP_WORDS.has(token));
}

/** Rank likely implementation declarations from issue/reproduction prose. This
 * is deliberately separate from contract-axis owner inference: a public API
 * can own a deferred consumer contract while an internal declaration owns the
 * smallest patch. The ranker is deterministic BM25 over bounded pre-edit
 * declaration text, with literal path/symbol disclosure recorded separately. */
export function rankIssueImplementationOwners(
  issueValue: unknown,
  sourceValue: unknown,
  candidateLimit = 20,
): ImplementationOwnerRanking | null {
  const issue = boundedText(issueValue, 100_000);
  if (!issue || !Array.isArray(sourceValue)) return null;
  const issueLower = issue.toLowerCase();
  const queryTokens = implementationOwnerTokens(issue);
  if (queryTokens.length === 0) return null;
  const queryCounts = new Map<string, number>();
  for (const token of queryTokens) queryCounts.set(token, (queryCounts.get(token) ?? 0) + 1);

  const sources: ContractAxisOwnerSource[] = [];
  const seen = new Set<string>();
  for (const raw of sourceValue.slice(0, 4_000)) {
    if (!raw || typeof raw !== "object" || Array.isArray(raw)) continue;
    const item = raw as Record<string, unknown>;
    const path = boundedText(item.path, 240);
    const content = typeof item.content === "string" && item.content.length <= 1_000_000 ? item.content : null;
    if (!path || !content || seen.has(path) || path.startsWith("/") || path.split("/").includes("..")) continue;
    if (!ownerSourcePath(path)) continue;
    seen.add(path);
    sources.push({ path, content });
  }

  const declarations: Array<{
    owner: string;
    path: string;
    symbol: string;
    tokens: string[];
    counts: Map<string, number>;
    length: number;
  }> = [];
  for (const source of sources) {
    const matches = ownerDeclarations(source.path, source.content);
    for (let index = 0; index < matches.length; index++) {
      const match = matches[index]!;
      const symbol = match.symbol;
      const start = match.index;
      const end = matches[index + 1]?.index ?? source.content.length;
      const text = `${symbol} ${symbol} ${source.content.slice(start, end)}`.slice(0, 80_000);
      const tokens = implementationOwnerTokens(text);
      const counts = new Map<string, number>();
      for (const token of tokens) counts.set(token, (counts.get(token) ?? 0) + 1);
      declarations.push({ owner: `${source.path}::${symbol}`, path: source.path, symbol, tokens, counts, length: Math.max(1, tokens.length) });
    }
  }
  if (declarations.length === 0) return null;

  const documentFrequency = new Map<string, number>();
  for (const item of declarations) {
    for (const token of new Set(item.tokens)) documentFrequency.set(token, (documentFrequency.get(token) ?? 0) + 1);
  }
  const averageLength = declarations.reduce((sum, item) => sum + item.length, 0) / declarations.length;
  const genericBasenames = new Set(["api.ts", "index.ts", "schemas.ts", "types.ts", "util.ts"]);
  const candidates = declarations.map((item) => {
    let lexicalScore = 0;
    for (const [token, queryFrequency] of queryCounts) {
      const frequency = item.counts.get(token) ?? 0;
      if (!frequency) continue;
      const documentsWithToken = documentFrequency.get(token) ?? 0;
      const inverseDocumentFrequency = Math.log(1 + (declarations.length - documentsWithToken + 0.5) / (documentsWithToken + 0.5));
      const saturation = (frequency * 2.2) / (frequency + 1.2 * (0.25 + 0.75 * (item.length / averageLength)));
      lexicalScore += inverseDocumentFrequency * saturation * Math.min(3, queryFrequency);
    }
    const normalizedSymbol = item.symbol.toLowerCase().replace(/^\$+/, "");
    const symbolPattern = new RegExp(`(^|[^a-z0-9_$])\\$?${normalizedSymbol.replace(/[$]/g, "\\$")}([^a-z0-9_$]|$)`, "i");
    const symbolDisclosed = normalizedSymbol.length >= 3 && symbolPattern.test(issue);
    const path = item.path.toLowerCase();
    const suffix = path.replace(/^packages\/[^/]+\//, "");
    const file = path.split("/").at(-1)!;
    const pathDisclosed = issueLower.includes(path) || issueLower.includes(suffix)
      || (!genericBasenames.has(file) && issueLower.includes(file));
    let score = lexicalScore;
    if (symbolDisclosed) score += 24;
    if (pathDisclosed) score += 32;
    if (new RegExp(`(?:\\.|\\b)${normalizedSymbol.replace(/[$]/g, "\\$")}\\s*\\(`, "i").test(issue)) score += 8;
    return {
      owner: item.owner,
      score: Math.round(score * 100) / 100,
      lexical_score: Math.round(lexicalScore * 100) / 100,
      symbol_disclosed: symbolDisclosed,
      path_disclosed: pathDisclosed,
    };
  }).sort((a, b) => b.score - a.score || compareCodeUnits(a.owner, b.owner));
  const limit = Number.isSafeInteger(candidateLimit) ? Math.max(1, Math.min(4_000, candidateLimit)) : 20;
  return { candidates: candidates.slice(0, limit) };
}

/** Conservative delivery gate for implementation-owner retrieval. Thresholds
 * are intentionally exposed in the result and require an absolute score plus
 * a stable lead; benchmark policy may impose stricter external promotion. */
export function inferIssueImplementationOwner(
  issueValue: unknown,
  sourceValue: unknown,
): ImplementationOwnerInference | null {
  const ranking = rankIssueImplementationOwners(issueValue, sourceValue);
  const best = ranking?.candidates[0];
  const runnerUp = ranking?.candidates[1];
  if (!best || best.score < 18 || (runnerUp && best.score - runnerUp.score < 3)) return null;
  return {
    owner: best.owner,
    score: best.score,
    runner_up_score: runnerUp?.score ?? null,
    symbol_disclosed: best.symbol_disclosed,
    path_disclosed: best.path_disclosed,
  };
}

/** Compile one probe into two independently observed receipts. The baseline is
 * eligible only before a product edit; validation is eligible only afterwards. */
export function compileExecutableProbes(value: unknown): ExecutionObligation[] {
  return normalizeExecutableProbes(value).flatMap((probe) => {
    const binding = (stage: ExecutionProbeBinding["stage"]): ExecutionProbeBinding => ({
      id: probe.id,
      stage,
      claim: probe.claim,
      falsifier: probe.falsifier,
      command: probe.command,
    });
    return [
      {
        id: `${probe.id}:baseline`,
        origin: probe.origin,
        category: probe.category,
        phase: "before-edit",
        description: `Establish the pre-change result for: ${probe.claim.slice(0, 260)}`,
        command_alternatives: probe.command_alternatives,
        expected: probe.expected_before,
        probe: binding("baseline"),
      },
      {
        id: `${probe.id}:validation`,
        origin: probe.origin,
        category: probe.category,
        phase: "after-edit",
        description: `Re-run the same falsification probe after the latest edit: ${probe.claim.slice(0, 230)}`,
        command_alternatives: probe.command_alternatives,
        expected: probe.expected_after,
        probe: binding("validation"),
      },
    ];
  });
}

function sameObligation(left: ExecutionObligation, right: ExecutionObligation): boolean {
  const shape = (item: ExecutionObligation): ExecutionObligation => ({
    id: item.id,
    origin: item.origin,
    category: item.category,
    phase: item.phase,
    description: item.description,
    command_alternatives: item.command_alternatives,
    expected: item.expected,
    ...(item.probe ? { probe: item.probe } : {}),
  });
  return JSON.stringify(shape(left)) === JSON.stringify(shape(right));
}

/** Add/refresh controller obligations. Replacing an origin lets a newer
 * hunch_context task discard stale memory obligations without disturbing a
 * benchmark episode or a manually supplied plan. */
export function armExecutionObligations(
  state: PipelineState,
  input: unknown,
  options: { replaceOrigin?: ExecutionObligationOrigin } = {},
): PipelineState {
  const specs = normalizeExecutionObligations(input);
  const existing = new Map(state.obligations.map((item) => [item.id, item]));
  const retained = options.replaceOrigin
    ? state.obligations.filter((item) => item.origin !== options.replaceOrigin)
    : [...state.obligations];
  const byId = new Map(retained.map((item) => [item.id, item]));
  for (const spec of specs) {
    const previous = existing.get(spec.id);
    const tracked: TrackedExecutionObligation = previous && sameObligation(previous, spec)
      ? previous
      : { ...spec, status: "pending" };
    byId.set(spec.id, tracked);
  }
  return { ...state, obligations: [...byId.values()].slice(0, MAX_OBLIGATIONS) };
}

export function pendingExecutionObligations(state: PipelineState): TrackedExecutionObligation[] {
  return state.obligations.filter((item) => item.status !== "satisfied");
}

export interface BeforeEditProbeVerdict {
  block: boolean;
  state: PipelineState;
  reason?: string;
}

/** Before-edit evidence is useful only before implementation. At firm/strict,
 * deny at most two product edits per prompt until all such receipts exist;
 * then fail open so a broken probe or discriminator cannot deadlock the agent. */
export function beforeEditProbeVerdict(state: PipelineState): BeforeEditProbeVerdict {
  const pending = state.obligations.filter((item) => item.phase === "before-edit" && item.status !== "satisfied");
  if (!pending.length || state.probeBlocks >= 2) return { block: false, state };
  const instructions = pending.slice(0, 3).map((item) => {
    const command = item.probe?.command ?? firstCommand(item);
    const markers = item.expected.output_includes?.length ? ` with output including ${item.expected.output_includes.join(" + ")}` : "";
    return `[${item.category}] ${item.description}: run exactly ${command}; expect ${item.expected.success ? "success" : "failure"}${markers}`;
  }).join(". ");
  return {
    block: true,
    state: { ...state, probeBlocks: state.probeBlocks + 1 },
    reason: `Hunch evidence gate — complete all pre-edit evidence before editing product code. ${instructions}. ` +
      `A failed command for the wrong reason does not count.`,
  };
}

export function executionObligationBrief(state: PipelineState): string {
  const pending = pendingExecutionObligations(state);
  if (!pending.length) return "";
  return [
    `Hunch Execution Controller — ${pending.length} observable obligation(s) must be evidenced before completion:`,
    ...pending.map((item, index) => {
      const expectation = `expected result: ${item.expected.success ? "success" : "failure"}` +
        `${item.expected.output_includes?.length ? `; output includes ${item.expected.output_includes.join(" + ")}` : ""}` +
        `${item.expected.output_excludes?.length ? `; output excludes ${item.expected.output_excludes.join(" + ")}` : ""}`;
      if (item.probe?.stage === "baseline") {
        return `${index + 1}. [probe/before-edit] BASELINE — ${item.probe.claim} ` +
          `(run exactly before any product edit: ${item.probe.command}; ${expectation}). ` +
          `Disproof condition: ${item.probe.falsifier}`;
      }
      if (item.probe?.stage === "validation") {
        return `${index + 1}. [probe/after-edit] VALIDATION — re-run probe ${item.probe.id} after the final product edit (${expectation}).`;
      }
      return `${index + 1}. [${item.category}/${item.phase}] ${item.description} ` +
        `(accepted command: ${item.command_alternatives.map((alternative) => alternative.join(" + ")).join(" OR ")}; ${expectation})`;
    }),
    "Before-edit probe baselines cannot be credited after implementation starts. After-edit obligations reset whenever product code changes again. Running a command is not enough: its observed result must satisfy the expectation.",
  ].join("\n");
}

/** Harness/orchestrator injection. Malformed input returns no obligations. */
export function environmentExecutionObligations(value = process.env.HUNCH_EXECUTION_OBLIGATIONS): ExecutionObligation[] {
  if (!value) return [];
  try {
    return normalizeExecutionObligations(JSON.parse(value));
  } catch {
    return [];
  }
}

/** Harness/orchestrator probe injection. Malformed input returns no probes. */
export function environmentExecutableProbes(value = process.env.HUNCH_EXECUTABLE_PROBES): ExecutableProbe[] {
  if (!value) return [];
  try {
    return normalizeExecutableProbes(JSON.parse(value));
  } catch {
    return [];
  }
}

// ------------------------------------------------------------------ profiles
/** What counts as verification, per domain. Paths activate a domain; verify
 *  patterns are matched against Bash/PowerShell commands run AFTER an edit. */
export interface DomainProfile {
  paths: RegExp;
  verify: RegExp;
}

export const DEFAULT_PROFILES: Record<string, DomainProfile> = {
  backend: {
    paths: /(^|\/)(src|lib|server|api|core|store|services?)\/|\.(ts|mts|cts|js|mjs|cjs|py|go|rs|java|rb|php)$/i,
    verify: /vitest|jest|pytest|go test|cargo test|tsx --test|npm (run )?test|pnpm (run )?test|tsc|typecheck/i,
  },
  frontend: {
    paths: /\.(tsx|jsx|css|scss|html|vue|svelte)$|(^|\/)(components|pages|site|app|ui)\//i,
    verify: /vite|next (build|dev)|npm run (build|dev)|pnpm (run )?(build|dev)|playwright|storybook|tsc/i,
  },
  tests: {
    paths: /(^|\/)(test|tests|__tests__|e2e|spec)\/|\.(test|spec)\./i,
    verify: /vitest|jest|pytest|tsx --test|npm (run )?test|pnpm (run )?test|playwright/i,
  },
  infra: {
    paths: /Dockerfile|docker-compose|\.tf$|\.tfvars$|(^|\/)(\.github|k8s|helm|terraform|infra|deploy)\/|\.ya?ml$/i,
    verify: /terraform (plan|validate)|docker (build|compose)|kubectl .*--dry-run|helm (lint|template)|actionlint|npm run build/i,
  },
};

/** Product code = behavior that ships. Docs, hunch's own graph, and .claude
 *  config are not gated — editing THIS machinery must never trip it. */
export function isProductPath(p: string): boolean {
  const norm = String(p).replace(/\\/g, "/");
  if (/\.(md|mdx|txt)$/i.test(norm)) return false;
  if (/(^|\/)\.(claude|hunch)(\/|$)/.test(norm)) return false;
  return true;
}

export function classifyDomains(path: string, profiles = DEFAULT_PROFILES): string[] {
  const norm = path.replace(/\\/g, "/");
  return Object.entries(profiles)
    .filter(([, d]) => d.paths.test(norm))
    .map(([name]) => name);
}

function verifyPattern(state: PipelineState, profiles = DEFAULT_PROFILES): RegExp {
  const active = Object.keys(state.domains).filter((d) => profiles[d]);
  const src = (active.length ? active : Object.keys(profiles)).map((d) => profiles[d]!.verify.source).join("|");
  return new RegExp(src, "i");
}

// ------------------------------------------------------- state transitions
/** New user prompt: fresh block budget. */
export function onPrompt(state: PipelineState): PipelineState {
  return { ...state, turn: state.turn + 1, blocks: 0, probeBlocks: 0 };
}

/** Edit/Write/MultiEdit landed on `path`. */
export function onEdit(state: PipelineState, path: string, profiles = DEFAULT_PROFILES): PipelineState {
  if (!path || !isProductPath(path)) return state;
  const domains = { ...state.domains };
  for (const d of classifyDomains(path, profiles)) domains[d] = true;
  const editGeneration = state.editGeneration + 1;
  return {
    ...state,
    domains,
    verifyAfterEdit: false,
    editGeneration,
    obligations: state.obligations.map((item) => item.phase === "after-edit"
      ? { ...item, status: "pending", satisfied_by: undefined, satisfied_at_edit: undefined, last_attempt: undefined }
      : item),
    editedFiles: state.editedFiles.includes(path) ? state.editedFiles : [...state.editedFiles, path],
  };
}

/** A shell command ran. After an edit, it counts as verification when it is
 *  verify-shaped for an active domain, a generic runner (`node --test`,
 *  `node -e` assertions), or names an edited file — a bespoke check on the
 *  thing you changed is verification, and uncredited real checks are how a
 *  gate gets disabled out of annoyance (first live false-negative: an HTML
 *  structure assertion via `node -e` was blocked on 2026-07-08). */
export function onCommand(
  state: PipelineState,
  command: string,
  outcome: { status: "success" | "failure" | "unknown"; output: string } = { status: "unknown", output: "" },
  profiles = DEFAULT_PROFILES,
): PipelineState {
  const normalizedCommand = command.replace(/\s+/g, " ").trim().toLowerCase();
  const obligations = state.obligations.map((item): TrackedExecutionObligation => {
    const eligible = item.phase === "session"
      || (item.phase === "before-edit" && state.editGeneration === 0)
      || (item.phase === "after-edit" && state.editedFiles.length > 0);
    const matched = eligible && item.command_alternatives.some((alternative) =>
      alternative.every((token) => normalizedCommand.includes(token.toLowerCase()))
    );
    if (!matched) return item;
    const normalizedOutput = outcome.output.toLowerCase();
    const missingOutput = (item.expected.output_includes ?? []).filter((marker) => !normalizedOutput.includes(marker.toLowerCase()));
    const forbiddenOutput = (item.expected.output_excludes ?? []).filter((marker) => normalizedOutput.includes(marker.toLowerCase()));
    const expectedOutcome = outcome.status !== "unknown" && (outcome.status === "success") === item.expected.success;
    const expectationMet = expectedOutcome && missingOutput.length === 0 && forbiddenOutput.length === 0;
    const lastAttempt: ExecutionAttempt = {
      command: command.slice(0, 500),
      outcome: outcome.status,
      expectation_met: expectationMet,
      ...(missingOutput.length ? { missing_output: missingOutput } : {}),
      ...(forbiddenOutput.length ? { forbidden_output: forbiddenOutput } : {}),
    };
    // A probe receipt is a phase-bound observation, not the status of the last
    // arbitrary runner experiment. Once red/green is observed, later command
    // wrappers or infrastructure failures cannot erase it; a later product edit
    // still resets validation through onEdit above.
    if (!expectationMet && item.status === "satisfied" && item.probe) return item;
    return expectationMet ? {
      ...item,
      status: "satisfied",
      satisfied_by: command.slice(0, 500),
      satisfied_at_edit: state.editGeneration,
      last_attempt: lastAttempt,
    } : {
      ...item,
      status: "pending",
      satisfied_by: undefined,
      satisfied_at_edit: undefined,
      last_attempt: lastAttempt,
    };
  });
  if (!state.editedFiles.length) return { ...state, obligations };
  const editedFileNamed = state.editedFiles.some((f) => {
    const base = f.replace(/\\/g, "/").split("/").pop();
    return !!base && command.includes(base);
  });
  const verifyShaped = verifyPattern(state, profiles).test(command) || /node (--test|-e\b)/.test(command);
  if ((verifyShaped || editedFileNamed) && outcome.status !== "failure") return { ...state, obligations, verifyAfterEdit: true };
  return { ...state, obligations };
}

/** A verification-class skill ran (/verify, /code-review) — counts as coverage. */
export function onSkill(state: PipelineState, skill: string): PipelineState {
  if (/code-review|verify|review/i.test(skill)) return { ...state, verifyAfterEdit: true };
  return state;
}

export type ProofActivity =
  | { kind: "edit" }
  | { kind: "command"; command: string }
  | { kind: "skill" };

export interface ProofCheckpoint {
  state: PipelineState;
  reminder?: string;
  reason?: "evidence-handoff" | "first-edit" | "proof-invalidated" | "falsifier-pivot" | "attempt-mismatch" | "cadence";
}

const PROOF_CHECKPOINT_INTERVAL = 6;
const MAX_PROOF_REMINDERS = 8;

function firstCommand(item: TrackedExecutionObligation): string {
  return item.probe?.command ?? item.command_alternatives[0]?.join(" ") ?? "the supplied proof command";
}

/** Schedule bounded proof reminders while work is still happening. Stop is too
 * late for clients that terminate at a hard turn budget, so the controller also
 * injects checkpoints at the evidence→implementation handoff, after the first
 * product edit, invalidated proof receipts, mismatched proof attempts, and a
 * small activity cadence. */
export function proofCheckpoint(before: PipelineState, after: PipelineState, activity: ProofActivity): ProofCheckpoint {
  if (!after.obligations.length) return { state: after };
  const proofActivity = Math.max(0, after.proofActivity) + 1;
  let state = { ...after, proofActivity };
  const pending = pendingExecutionObligations(state);
  if (!pending.length || state.proofReminders >= MAX_PROOF_REMINDERS) return { state };

  const attempted = activity.kind === "command"
    ? pending.find((item) => item.last_attempt?.command === activity.command.slice(0, 500) && !item.last_attempt.expectation_met)
    : undefined;
  const attemptedProbe = attempted?.probe;
  const attempt = attempted?.last_attempt;
  const baseline = attemptedProbe?.stage === "validation"
    ? after.obligations.find((item) => item.probe?.id === attemptedProbe.id && item.probe?.stage === "baseline")
    : undefined;
  const baselineMarkers = new Set((baseline?.expected.output_includes ?? []).map((marker) => marker.toLowerCase()));
  const changedMarkers = (attempted?.expected.output_includes ?? [])
    .filter((marker) => !baselineMarkers.has(marker.toLowerCase()));
  const missingMarkers = new Set((attempted?.last_attempt?.missing_output ?? []).map((marker) => marker.toLowerCase()));
  const observedChanges = changedMarkers.filter((marker) => !missingMarkers.has(marker.toLowerCase()));
  const survivingFailures = changedMarkers.filter((marker) => missingMarkers.has(marker.toLowerCase()));
  const markerKey = (marker: string): string | undefined => marker.match(/^([^=\s]+)=/)?.[1]?.toLowerCase();
  const forbiddenMarkers = attempt?.forbidden_output ?? [];
  const regressedControls = (attempt?.missing_output ?? []).flatMap((missing) => {
    if (!baselineMarkers.has(missing.toLowerCase())) return [];
    const key = markerKey(missing);
    const observed = key ? forbiddenMarkers.find((marker) => markerKey(marker) === key) : undefined;
    return observed ? [`${missing} → ${observed}`] : [];
  });
  const expectedOutcomeObserved = !!attempt && attempt.outcome !== "unknown"
    && (attempt.outcome === "success") === attempted?.expected.success;
  const falsifierPivot = attemptedProbe?.stage === "validation"
    && baseline?.status === "satisfied"
    && expectedOutcomeObserved
    && observedChanges.length > 0
    && survivingFailures.length > 0;
  const invalidated = activity.kind === "edit"
    ? before.obligations.filter((item) => item.phase === "after-edit" && item.status === "satisfied").length
    : 0;
  const firstEdit = activity.kind === "edit" && before.editGeneration === 0 && after.editGeneration > 0;
  const pendingBeforeEdit = after.editGeneration === 0 && pending.some((item) => item.phase === "before-edit");
  const evidenceHandoff = after.editGeneration === 0
    && before.obligations.some((item) => item.phase === "before-edit" && item.status === "pending")
    && !after.obligations.some((item) => item.phase === "before-edit" && item.status === "pending")
    && pending.some((item) => item.phase === "after-edit");
  const cadenceDue = (after.editGeneration > 0 || pendingBeforeEdit)
    && proofActivity - Math.max(0, after.proofReminderActivity) >= PROOF_CHECKPOINT_INTERVAL;

  const reason: ProofCheckpoint["reason"] = falsifierPivot
    ? "falsifier-pivot"
    : attempted
      ? "attempt-mismatch"
    : invalidated > 0
      ? "proof-invalidated"
      : firstEdit
        ? "first-edit"
        : evidenceHandoff
          ? "evidence-handoff"
        : cadenceDue
          ? "cadence"
          : undefined;
  if (!reason) return { state };

  const completed = state.obligations.length - pending.length;
  const ordered = [...pending].sort((left, right) => Number(right.phase === "after-edit") - Number(left.phase === "after-edit"));
  const next = ordered.slice(0, 3)
    .map((item) => `[${item.category}] ${item.description} — run: ${firstCommand(item)}`)
    .join("; ");
  let headline: string;
  if (falsifierPivot && attempted?.probe) {
    const regression = regressedControls.length
      ? ` A baseline control regressed (${regressedControls.join(" + ")}).`
      : "";
    headline = `Hunch falsifier pivot: this edit made part of the contrast newly green (${observedChanges.join(" + ")}), while the result is still missing ${survivingFailures.join(" + ")}.${regression} Preserve the newly green behavior and inspect the first mechanism or ownership boundary unique to the surviving control. Do not rerun unchanged, broaden the same fix, or revert to baseline unless you can name a replacement mechanism and test it in the next edit. If another check conflicts, classify it against the current task and provenance as an invariant or a stale expectation; a pre-fix snapshot is not an automatic veto. Make one targeted edit, then rerun the exact probe. Falsifier: ${attempted.probe.falsifier}`;
  } else if (attempted?.last_attempt) {
    const attempt = attempted.last_attempt;
    const mismatch = [
      `observed ${attempt.outcome}`,
      ...(attempt.missing_output?.length ? [`missing output: ${attempt.missing_output.join(" + ")}`] : []),
      ...(attempt.forbidden_output?.length ? [`forbidden output present: ${attempt.forbidden_output.join(" + ")}`] : []),
    ].join("; ");
    headline = `Hunch proof attempt did not satisfy [${attempted.category}] ${attempted.description} (${mismatch}).`;
  } else if (invalidated > 0) {
    headline = `Hunch proof checkpoint: the latest product edit invalidated ${invalidated} after-edit receipt(s).`;
  } else if (firstEdit) {
    headline = "Hunch proof checkpoint: product implementation has started; reserve a verification block before the turn ends.";
  } else if (evidenceHandoff) {
    headline = "Hunch phase handoff: pre-edit evidence is complete. Stop expanding the diagnosis; make the smallest chosen product edit now, then prove the pending contract.";
  } else if (pendingBeforeEdit) {
    headline = "Hunch evidence checkpoint: investigation is consuming the pre-edit budget; finish the narrowest prerequisite before changing product code.";
  } else {
    headline = "Hunch proof checkpoint: investigation is consuming the work budget; run the narrowest pending proof now.";
  }
  state = {
    ...state,
    proofReminderActivity: proofActivity,
    proofReminders: state.proofReminders + 1,
  };
  return {
    state,
    reason,
    reminder: `${headline} ${completed}/${state.obligations.length} expected result(s) proved. Pending: ${next}. ` +
      "A matching command alone does not count, and turn-budget exhaustion is unresolved—not completion.",
  };
}

// ------------------------------------------------------------------- gates
export const PIPELINE_LOOP = [
  "Hunch pipeline — operating loop (enforced on observable facts, not claims):",
  "1. SCOPE — restate the task; define done as something observable (a passing test, a rendered page, a number).",
  "2. EVIDENCE — observe current behavior before editing: run the failing thing, read the real code path, quote the real error.",
  "3. CHANGE — smallest edit that fixes the root cause, not the symptom.",
  "4. VERIFY — after the last edit, RUN the relevant check (test/build/typecheck/plan). A claim without an exit code is not a result.",
  "5. ATTACK — one honest paragraph: what would make this conclusion wrong?",
  "6. REPORT — what ran, what passed, what stays unverified. Failures verbatim.",
].join("\n");

export const UNVERIFIED_NAG =
  "Hunch pipeline: earlier product edits are still UNVERIFIED — run the relevant test/build/typecheck before claiming anything about them.";

export function unverifiedNag(state: PipelineState): string {
  const pending = pendingExecutionObligations(state);
  const generic = !state.verifyAfterEdit ? UNVERIFIED_NAG : "Hunch Execution Controller: completion evidence is still incomplete.";
  if (!pending.length) return generic;
  return `${generic} Controller obligations still pending: ${pending.slice(0, 4).map((item) => `[${item.category}] ${item.description}`).join("; ")}.`;
}

const MAX_LESSONS = 6;
/** Any profile's check shape: the reminder fires when the agent starts proving
 *  its work, whatever the domain. */
const CHECK_SHAPE = new RegExp([...Object.values(DEFAULT_PROFILES).map((p) => p.verify.source), "node (--test|-e\\b)"].join("|"), "i");

/** Record lessons the grounding just delivered (dedup by id; first delivery keeps its baseline). */
export function onLessonsDelivered(state: PipelineState, lessons: readonly Omit<PendingLesson, "reminded">[]): PipelineState {
  const known = new Set(state.lessons.map((l) => l.id));
  const added = lessons.filter((l) => !known.has(l.id)).map((l) => ({ ...l, reminded: false }));
  return added.length ? { ...state, lessons: [...state.lessons, ...added].slice(-MAX_LESSONS) } : state;
}

/** The one follow-up an advisory lesson gets. It fires when the agent runs a
 *  check (test/build/typecheck) while a delivered lesson's function is still
 *  untouched: the moment the agent thinks it is done, which is when an ignored
 *  lesson would otherwise ship. Once per lesson, never a block. `hashOf`
 *  returns the function's current body hash (null: cannot tell, stay silent). */
export function lessonReminder(
  state: PipelineState,
  command: string,
  hashOf: (lesson: PendingLesson) => string | null,
): { state: PipelineState; reminder: string } {
  if (!CHECK_SHAPE.test(command) || !state.lessons.some((l) => !l.reminded)) return { state, reminder: "" };
  const due: PendingLesson[] = [];
  const lessons = state.lessons.map((l) => {
    if (l.reminded) return l;
    const now = hashOf(l);
    if (now === null || l.hash === null) return l;
    if (now !== l.hash) return { ...l, reminded: true };
    due.push(l);
    return { ...l, reminded: true };
  });
  if (!due.length) return { state: { ...state, lessons }, reminder: "" };
  const lines = due.map((l) => {
    const via = l.callers.length ? ` ${l.callers.slice(0, 3).map((c) => `\`${c}\``).join(", ")} call${l.callers.length === 1 ? "s" : ""} it, so your change runs through the copy that lacks the fix.` : "";
    return `- \`${l.symbol}\` (${l.file}) is unchanged since Hunch showed you the change its same-shaped sibling \`${l.sibling}\` (${l.siblingFile}) received: ${l.change}.${via}`;
  });
  return {
    state: { ...state, lessons },
    reminder: [
      "Hunch — before you finish: a lesson delivered earlier is still open.",
      ...lines,
      "The checks you are running were written before this lesson; unless one feeds this function the input the sibling's change handles, they do not show it is covered. Carry the change with a test. It does not apply only if that input cannot reach the function or is already handled another way; then say which in your final answer. \"Pre-existing\" or \"outside this task\" does not count: your change runs through this copy, so leaving it ships the gap again inside your change.",
    ].join("\n"),
  };
}

/** Stop-gate verdict. Blocks only at firm/strict, only with unverified product
 *  edits, and at most twice per turn. */
export function stopVerdict(state: PipelineState, firmness: Firmness): { block: false } | { block: true; reason: string; state: PipelineState } {
  const gated = firmness === "firm" || firmness === "strict";
  const pending = pendingExecutionObligations(state);
  const genericPending = !state.verifyAfterEdit && state.editedFiles.length > 0;
  if (!gated || (!genericPending && !pending.length) || state.blocks >= 2) return { block: false };
  const domains = Object.keys(state.domains).join(", ") || "generic";
  const obligationReason = pending.length
    ? ` Specific obligations still pending: ${pending.slice(0, 6).map((item) => `[${item.category}/${item.phase}] ${item.description}`).join("; ")}. Run command evidence matching the supplied alternatives after the latest edit where required.`
    : "";
  return {
    block: true,
    state: { ...state, blocks: state.blocks + 1 },
    reason:
      `Hunch pipeline gate — VERIFY unsatisfied.${genericPending ? ` Product files were edited (${state.editedFiles.slice(-5).join(", ")}) but no verifying command ran afterwards (domain: ${domains}).` : ""}` +
      obligationReason.replace("Run command evidence matching the supplied alternatives", "Run a supplied command and obtain its expected result") + ` Do now, in order: ` +
      `(1) run the relevant test/build/typecheck for those files; ` +
      `(2) one honest paragraph attacking your own conclusion — what would make it wrong; ` +
      `(3) report what ran, what passed, what stays unverified. ` +
      `If verification is truly impossible here, say so explicitly and why.`,
  };
}

// ------------------------------------------------------------------ storage
const STATE_DIR = join(tmpdir(), "hunch-pipeline");
const SWEEP_AGE_MS = 48 * 3600 * 1000;

export function pipelineEnabled(): boolean {
  return process.env.HUNCH_PIPELINE !== "0";
}

/** Load session state; on ANY problem return a fresh state (never throw). */
export function loadPipelineState(sessionId: string): PipelineState {
  try {
    const raw = JSON.parse(readFileSync(stateFile(sessionId), "utf8")) as Partial<PipelineState>;
    const state = { ...emptyState(), ...raw };
    state.proofActivity = Number.isSafeInteger(raw.proofActivity) && raw.proofActivity! >= 0 ? raw.proofActivity! : 0;
    state.proofReminderActivity = Number.isSafeInteger(raw.proofReminderActivity) && raw.proofReminderActivity! >= 0 ? raw.proofReminderActivity! : 0;
    state.proofReminders = Number.isSafeInteger(raw.proofReminders) && raw.proofReminders! >= 0 ? raw.proofReminders! : 0;
    state.probeBlocks = Number.isSafeInteger(raw.probeBlocks) && raw.probeBlocks! >= 0 ? raw.probeBlocks! : 0;
    state.lessons = (Array.isArray(raw.lessons) ? raw.lessons : []).filter((l): l is PendingLesson => !!l && typeof l === "object"
      && typeof l.id === "string" && typeof l.file === "string" && typeof l.symbol === "string" && typeof l.sibling === "string"
      && typeof l.siblingFile === "string" && typeof l.change === "string" && Array.isArray(l.callers)
      && (l.hash === null || typeof l.hash === "string") && typeof l.reminded === "boolean").slice(-MAX_LESSONS);
    const specs = normalizeExecutionObligations(raw.obligations);
    const tracked = new Map((Array.isArray(raw.obligations) ? raw.obligations : []).map((item) => {
      const candidate = item as Partial<TrackedExecutionObligation>;
      return [candidate.id, candidate];
    }));
    state.obligations = specs.map((spec) => {
      const previous = tracked.get(spec.id);
      const rawAttempt = previous?.last_attempt && typeof previous.last_attempt === "object"
        ? previous.last_attempt as Partial<ExecutionAttempt>
        : null;
      const attempt: ExecutionAttempt | null = rawAttempt
        && typeof rawAttempt.command === "string"
        && (rawAttempt.outcome === "success" || rawAttempt.outcome === "failure" || rawAttempt.outcome === "unknown")
        && typeof rawAttempt.expectation_met === "boolean"
        ? {
          command: rawAttempt.command.slice(0, 500),
          outcome: rawAttempt.outcome,
          expectation_met: rawAttempt.expectation_met,
          ...(Array.isArray(rawAttempt.missing_output)
            ? { missing_output: rawAttempt.missing_output.filter((item): item is string => typeof item === "string").slice(0, MAX_OUTPUT_MARKERS) }
            : {}),
          ...(Array.isArray(rawAttempt.forbidden_output)
            ? { forbidden_output: rawAttempt.forbidden_output.filter((item): item is string => typeof item === "string").slice(0, MAX_OUTPUT_MARKERS) }
            : {}),
        }
        : null;
      return {
        ...spec,
        status: previous?.status === "satisfied" && attempt?.expectation_met ? "satisfied" : "pending",
        ...(previous?.status === "satisfied" && attempt?.expectation_met && typeof previous.satisfied_by === "string"
          ? { satisfied_by: previous.satisfied_by.slice(0, 500) }
          : {}),
        ...(previous?.status === "satisfied" && attempt?.expectation_met && Number.isSafeInteger(previous.satisfied_at_edit)
          ? { satisfied_at_edit: previous.satisfied_at_edit }
          : {}),
        ...(attempt ? { last_attempt: attempt } : {}),
      };
    });
    return state;
  } catch {
    return emptyState();
  }
}

/** Persist session state (best effort — scratch data, single writer). */
export function savePipelineState(sessionId: string, state: PipelineState): void {
  try {
    mkdirSync(STATE_DIR, { recursive: true });
    sweep();
    writeFileSync(stateFile(sessionId), JSON.stringify(state));
  } catch {
    /* losing scratch state beats breaking the hook */
  }
}

function stateFile(sessionId: string): string {
  return join(STATE_DIR, `${sessionId.replace(/[^A-Za-z0-9_-]/g, "_").slice(0, 80)}.json`);
}

function sweep(): void {
  try {
    for (const f of readdirSync(STATE_DIR)) {
      try {
        if (Date.now() - statSync(join(STATE_DIR, f)).mtimeMs > SWEEP_AGE_MS) rmSync(join(STATE_DIR, f), { force: true });
      } catch {
        /* raced — skip */
      }
    }
  } catch {
    /* dir unreadable — skip */
  }
}
