/**
 * Deterministic delivery envelope for agent-facing memory.
 *
 * Retrieval answers "what may be relevant". This layer answers the separate,
 * observable question "what was actually safe and small enough to deliver".
 * Keeping that boundary explicit makes delivery receipts truthful: callers
 * receipt only `delivered`, never every record returned by retrieval.
 */
import { spawnSync } from "node:child_process";
import { existsSync } from "node:fs";
import { isAbsolute, join } from "node:path";
import type { AssembledContext } from "../store/hunchStore.js";
import type { Component, Decision, Symbol } from "./types.js";
import type { ExecutionObligation } from "./pipeline.js";
import { pathMatchesGlob, pathsRelated } from "./glob.js";
import { toPosixTarget } from "./paths.js";
import { renderGrounding } from "./topics.js";
import {
  LANDSCAPE_FRAGMENT_SCHEMA_VERSION,
  assertLandscapeDeliveryFragment,
  createLandscapeDeliveryFragment,
  landscapeFragmentHash,
  type DeliveredLandscapeRelationship,
  type DeliveredLandscapeResource,
  type LandscapeDeliveryFragment,
  type SelectedLandscapeRelationship,
  type SelectedLandscapeResource,
} from "./landscapeDelivery.js";

export const DELIVERY_ENVELOPE_SCHEMA_VERSION = "hunch.delivery-envelope/1" as const;
export const DELIVERY_PROFILE_POLICY_VERSION = "hunch.delivery-profile/1" as const;
export const DELIVERY_PROFILES = ["builder", "reviewer", "architect"] as const;
export type DeliveryProfile = (typeof DELIVERY_PROFILES)[number];

export type DeliveryKind = "constraints" | "decisions" | "bugs" | "findings" | "resources" | "relationships";
export type CommitReachability = "reachable" | "unreachable" | "unknown";

export interface DeliveryRef {
  kind: DeliveryKind;
  record_id: string;
}

export type DeliveryReason = "ranked" | "blocking-reserved";
export type DeliveryProvenanceStatus = "current" | "unverified" | "stale";

export interface DeliveredItem extends DeliveryRef {
  /** One-based position in the eligible memory ranking. */
  rank: number;
  delivery_reason: DeliveryReason;
  provenance_status: DeliveryProvenanceStatus;
  /** Deterministic approximation: four Unicode code points per token. */
  token_cost: number;
}

export interface DeliverySupplement {
  id: string;
  kind: string;
  text: string;
  /** Higher values are attempted first after ranked memory. */
  priority?: number;
}

export interface DeliveredSupplement {
  id: string;
  kind: string;
  delivered: boolean;
  reason: "supplemental" | "budget" | "empty" | "abstained";
  rank: number;
  token_cost: number;
}

export interface DeliveryOmission extends DeliveryRef {
  reason: "budget" | "stale-provenance" | "retired" | "actionability-cap"
    | "endpoint-not-delivered" | "landscape-cap" | "profile-cap" | DeliveryAbstentionReason;
  detail: string;
}

export type DeliveryAbstentionReason = "low-confidence" | "insufficient-context" | "low-relevance";

export interface DeliveryAbstention {
  /** True when Hunch found prescriptive memory but deliberately withheld it. */
  active: boolean;
  withheld: number;
  reasons: Record<DeliveryAbstentionReason, number>;
  /** A concrete recovery path instead of a silent empty result. */
  retry_hint: string | null;
}

/** A bounded, falsifiable interpretation of one delivered decision. The packet
 * is derived only from stored record/query fields; it never invents a fix. */
export interface DeliveryHypothesis {
  kind: "decision";
  record_id: string;
  /** Rank of the corresponding delivered record in this envelope. */
  rank: number;
  why: string;
  where: string[];
  historical_pattern: string;
  verify: string;
  disprove: string;
  /** Observable controller checks derived from immutable record evidence. */
  obligations: ExecutionObligation[];
}

export interface DeliveryEnvelope {
  schema_version: typeof DELIVERY_ENVELOPE_SCHEMA_VERSION;
  /** Role-specific ordering only; never enforcement or authority. */
  profile: DeliveryProfile;
  ranking_policy: typeof DELIVERY_PROFILE_POLICY_VERSION;
  /** Content-addressed identity for exactly what this envelope returned. */
  receipt_id: string;
  text: string;
  delivered: DeliveredItem[];
  hypotheses: DeliveryHypothesis[];
  obligations: ExecutionObligation[];
  supplements: DeliveredSupplement[];
  omitted: DeliveryOmission[];
  /** Reviewed graph records delivered through this same budget and receipt. */
  landscape: LandscapeDeliveryFragment | null;
  budget_tokens: number;
  used_chars: number;
  /** Conservative text + structured landscape payload accounting. */
  accounted_chars: number;
  /** True only when the requested budget is mathematically too small to name
   * every active blocking invariant. Safety wins, and the overflow is explicit. */
  blocking_overflow: boolean;
  abstention: DeliveryAbstention;
}

export interface DeliveryOptions {
  /** Defaults to builder for day-to-day coding work. */
  profile?: DeliveryProfile;
  root?: string;
  symbols?: readonly Pick<Symbol, "id" | "name" | "file">[];
  components?: readonly Pick<Component, "id" | "status" | "paths">[];
  /** Full decision corpus lets the envelope explain only decisions it actually delivered. */
  decisionCorpus?: readonly Decision[];
  /** Caller-specific grounding that must share the same hard output budget. */
  supplements?: readonly DeliverySupplement[];
  /** Time-travel contexts intentionally include records that are retired at HEAD. */
  historical?: boolean;
  /** Injectable for deterministic tests. Omit to use the local Git graph. */
  commitReachability?: (commit: string) => CommitReachability;
}

type ProvenanceState = DeliveryProvenanceStatus;

interface Candidate {
  ref?: DeliveryRef;
  mandatory: boolean;
  score: number;
  line: string;
  provenance: ProvenanceState;
  staleDetail?: string;
  retiredDetail?: string;
  abstainReason?: DeliveryAbstentionReason;
  abstainDetail?: string;
  hypothesis?: Omit<DeliveryHypothesis, "rank">;
  relevanceTerms?: string[];
  landscapeResource?: SelectedLandscapeResource;
  landscapeRelationship?: SelectedLandscapeRelationship;
  /** Conservative charge for text plus the structured graph record. */
  accountedChars?: number;
}

const SEVERITY = { advisory: 1, warning: 2, blocking: 3, low: 1, medium: 2, high: 3, critical: 4 } as const;
const MIN_ADVISORY_CONFIDENCE = 0.5;
const MIN_UNCONDITIONED_CONFIDENCE = 0.7;
const MAX_ACTIONABLE_HYPOTHESES = 2;
const MAX_PROFILE_HEADLINES = 8;
const PROFILE_BASE_SCORE: Record<DeliveryProfile, Record<DeliveryKind, number>> = {
  builder: {
    constraints: 900,
    decisions: 800,
    bugs: 750,
    findings: 650,
    resources: 550,
    relationships: 525,
  },
  reviewer: {
    constraints: 800,
    decisions: 750,
    bugs: 900,
    findings: 850,
    resources: 550,
    relationships: 525,
  },
  architect: {
    constraints: 800,
    decisions: 900,
    bugs: 650,
    findings: 600,
    resources: 850,
    relationships: 825,
  },
};
const TASK_STOP_WORDS = new Set([
  "a", "an", "and", "are", "as", "at", "be", "been", "but", "by", "can", "does", "for", "from",
  "has", "have", "in", "into", "is", "it", "its", "of", "on", "or", "that", "the", "this", "to",
  "use", "uses", "using", "was", "when", "where", "which", "while", "with", "without",
  "bug", "fix", "issue", "problem",
]);

function clipHeadline(value: string, max: number): string {
  const flat = value.replace(/\s+/g, " ").trim();
  if (flat.length <= max) return flat;
  return `${flat.slice(0, Math.max(0, max - 1)).trimEnd()}…`;
}

function sourceTier(source: string | undefined): string {
  const parts = (source ?? "").split("+");
  if (parts.includes("human_confirmed")) return "human";
  if (parts.includes("agent_recorded")) return "agent";
  if (parts.includes("llm_draft")) return "model";
  return source || "unknown";
}

function stemToken(token: string): string {
  if (!/^[a-z0-9]+$/.test(token)) return token;
  if (token.endsWith("ies") && token.length > 5) return `${token.slice(0, -3)}y`;
  for (const suffix of ["ing", "ed"]) {
    if (token.endsWith(suffix) && token.length - suffix.length >= 4) {
      const base = token.slice(0, -suffix.length);
      if (base.endsWith("s") && !base.endsWith("ss")) return `${base}e`;
      return base;
    }
  }
  if (/(?:sses|xes|zes|ches|shes)$/.test(token) && token.length > 5) return token.slice(0, -2);
  if (token.endsWith("s") && !token.endsWith("ss") && token.length > 4) return token.slice(0, -1);
  return token;
}

function lexicalTokens(value: string): Set<string> {
  const expanded = value.replace(/([a-z0-9])([A-Z])/g, "$1 $2").replace(/[_-]+/g, " ").toLowerCase();
  const words = expanded.match(/[\p{L}\p{N}]+/gu) ?? [];
  return new Set(words.map(stemToken).filter((token) => token.length >= 3 && !TASK_STOP_WORDS.has(token)));
}

function codeSyntaxTokens(value: string): Set<string> {
  const out = new Set<string>();
  for (const fragment of value.split(/\s+/)) {
    // Code-shaped spans identify the API/file nouns without treating every symbol
    // name anywhere in a large repository as a noun. The latter erased ordinary
    // evidence words such as "empty" and "throws" in real task phrases.
    if (!/[.$()[\]`/\\_:<>]/.test(fragment)) continue;
    for (const token of lexicalTokens(fragment)) out.add(token);
  }
  return out;
}

interface QueryProfile {
  taskPhrase: boolean;
  evidenceTerms: Set<string>;
  allTerms: Set<string>;
}

/** Separate task evidence (symptoms/expected behavior) from code nouns. A file,
 * symbol, or API noun proves scope, not that a prescriptive decision answers the
 * current problem. Low-authority memory must match the evidence terms too. */
function queryProfile(target: string, options: DeliveryOptions): QueryProfile {
  const normalized = toPosixTarget(target.trim());
  const exactSymbol = (options.symbols ?? []).some((symbol) =>
    symbol.id === normalized || symbol.name === normalized || symbol.file === normalized || pathsRelated(symbol.file, normalized)
  );
  const exactComponent = (options.components ?? []).some((component) => component.id === normalized);
  const hasWhitespace = /\s/.test(normalized);
  const pathLike = !hasWhitespace && (normalized.includes("/") || /\.[a-z0-9]{1,8}$/i.test(normalized));
  const taskPhrase = !exactSymbol && !exactComponent && !pathLike && hasWhitespace;
  const allTerms = lexicalTokens(normalized);
  if (!taskPhrase) return { taskPhrase, evidenceTerms: new Set(), allTerms };

  const codeTerms = codeSyntaxTokens(normalized);
  const evidenceTerms = new Set([...allTerms].filter((token) => !codeTerms.has(token)));
  return { taskPhrase, evidenceTerms, allTerms };
}

function decisionRecordTerms(decision: Decision): Set<string> {
  return lexicalTokens([
    decision.title,
    decision.context,
    decision.decision,
    ...decision.consequences,
    ...decision.alternatives_rejected,
    ...decision.related_files,
    ...decision.related_components,
  ].join(" "));
}

/** Ranking uses only the record's claim, not consequences or path metadata.
 * Otherwise prose such as "the test moved away from tuple" can falsely make an
 * unrelated lazy-schema decision look tuple-specific. */
function decisionPrimaryTerms(decision: Decision): Set<string> {
  return lexicalTokens([decision.title, decision.context, decision.decision].join(" "));
}

function decisionEvidenceMatches(decision: Decision, query: QueryProfile): string[] {
  const recordTerms = decisionPrimaryTerms(decision);
  return [...query.evidenceTerms].filter((term) => recordTerms.has(term));
}

function decisionHypothesis(decision: Decision, matches: string[], target: string): Omit<DeliveryHypothesis, "rank"> {
  const files = decision.related_files.filter(isSafeDeliveryAnchor).slice(0, 3);
  const components = decision.related_components.slice(0, Math.max(0, 3 - files.length)).map((id) => `component:${id}`);
  const where = [...files, ...components];
  const location = where.length ? where.join(", ") : "an unanchored record";
  const why = matches.length
    ? `Matches task evidence (${matches.join(", ")}) and is anchored to ${location}.`
    : `No symptom-term overlap was found; it is included because its authority/confidence passed delivery and its recorded scope is ${location}. Treat it as a hypothesis, not proof.`;
  const consequences = decision.consequences.slice(0, 2).join("; ");
  const pattern = clipHeadline(
    `${decision.decision || decision.title}${consequences ? ` Expected outcomes: ${consequences}` : ""}`,
    420,
  );
  const historicalPattern = decision.commit
    ? `Commit ${decision.commit}: ${pattern}`
    : `Recorded decision (no fix commit attached): ${pattern}`;
  const evidence = decision.provenance.evidence.map((item) => clipHeadline(item, 120)).filter(Boolean).slice(0, 2);
  const conformance = decision.conformance?.[0];
  const premise = decision.premises?.[0];
  const reproduction = clipHeadline(target, 180);
  let verify: string;
  const safeCommit = decision.commit && /^[0-9a-f]{7,64}$/i.test(decision.commit) ? decision.commit : null;
  const diffPaths = files.filter((file) => /^[a-zA-Z0-9._/-]+$/.test(file)).slice(0, 2);
  if (safeCommit) {
    const scoped = diffPaths.length ? ` -- ${diffPaths.join(" ")}` : "";
    verify = `Inspect the recorded change before editing: git show --stat --oneline ${safeCommit}${scoped}; then git show ${safeCommit}${scoped}. Compare that diff with the current code, then reproduce: ${reproduction}.`;
  } else if (evidence.length) {
    verify = `Check recorded evidence (${evidence.join("; ")}), then reproduce: ${reproduction}.`;
  } else if (conformance) {
    verify = `Check whether ${conformance.subject} ${conformance.assert}${conformance.object ? ` ${conformance.object}` : ""}${conformance.transitive ? " transitively" : ""}, then reproduce: ${reproduction}.`;
  } else if (premise) {
    verify = `Check the recorded premise (${clipHeadline(premise.claim, 150)}), then reproduce: ${reproduction}.`;
  } else {
    verify = `Reproduce: ${reproduction}. Inspect ${location} and run the narrowest existing test that exercises that path before changing code.`;
  }
  const disprove = where.length
    ? `Reject this hypothesis if the reproduction does not execute ${location}, or if checking the recorded pattern leaves the observed failure unchanged.`
    : "Reject this hypothesis if the smallest reproduction contradicts the recorded pattern or passes without it.";
  const obligations: ExecutionObligation[] = [];
  if (safeCommit) {
    obligations.push({
      id: `${decision.id}:inspect:${safeCommit.slice(0, 12)}`,
      origin: "memory",
      category: "evidence",
      phase: "session",
      description: `Inspect recorded commit ${safeCommit.slice(0, 12)} and compare it with the current code.`,
      command_alternatives: [["git", "show", safeCommit.slice(0, 7)]],
      expected: { success: true, output_includes: [safeCommit.slice(0, 7)] },
    });
  }
  const testPath = decision.provenance.evidence
    .flatMap((item) => item.match(/[A-Za-z0-9_.\/-]+\.(?:test|spec)\.[cm]?[jt]sx?/gi) ?? [])
    .find((item) => isSafeDeliveryAnchor(item));
  if (testPath) {
    obligations.push({
      id: `${decision.id}:proof:${testPath.replace(/[^A-Za-z0-9._-]/g, "_").slice(-60)}`,
      origin: "memory",
      category: "behavior",
      phase: "after-edit",
      description: `Re-run the recorded proof ${testPath} after the latest product edit.`,
      command_alternatives: [
        ["vitest", testPath],
        ["jest", testPath],
        ["pytest", testPath],
        ["tsx", "--test", testPath],
        ["node", "--test", testPath],
        ["npm", "test", testPath],
      ],
      expected: { success: true },
    });
  }
  return {
    kind: "decision",
    record_id: decision.id,
    why,
    where,
    historical_pattern: historicalPattern,
    verify,
    disprove,
    obligations,
  };
}

function renderHypothesis(hypothesis: Omit<DeliveryHypothesis, "rank">, provenance: ProvenanceState, source: string | undefined): string {
  const lines = [
    `${hypothesis.record_id} | hypothesis/decision | ${sourceTier(source)}/${provenance} | hunch_why("${hypothesis.record_id}")`,
    `  why: ${hypothesis.why}`,
    `  where: ${hypothesis.where.join(", ") || "unanchored"}`,
    `  historical pattern: ${hypothesis.historical_pattern}`,
    `  verify: ${hypothesis.verify}`,
    `  disprove: ${hypothesis.disprove}`,
  ];
  if (hypothesis.obligations.length) {
    lines.push(`  controller: ${hypothesis.obligations.map((item) => `${item.id} [${item.category}/${item.phase}] ${item.description}`).join("; ")}`);
  }
  return lines.join("\n  ");
}

function decisionAbstention(
  decision: Decision,
  query: QueryProfile,
): { reason: DeliveryAbstentionReason; detail: string } | null {
  const source = decision.provenance.source ?? "";
  if (source.split("+").includes("human_confirmed")) return null;
  const confidence = decision.provenance.confidence ?? 0;
  if (confidence < MIN_ADVISORY_CONFIDENCE) {
    return {
      reason: "low-confidence",
      detail: `non-human decision confidence ${confidence.toFixed(2)} is below the ${MIN_ADVISORY_CONFIDENCE.toFixed(2)} delivery floor`,
    };
  }
  if (confidence >= MIN_UNCONDITIONED_CONFIDENCE) return null;
  if (!query.taskPhrase || !query.evidenceTerms.size) {
    return {
      reason: "insufficient-context",
      detail: "low-authority prescriptive memory needs a task phrase with symptoms or expected behavior, not only a file/symbol/API target",
    };
  }

  const recordTerms = decisionRecordTerms(decision);
  const evidenceOverlap = [...query.evidenceTerms].filter((term) => recordTerms.has(term)).length;
  const allOverlap = [...query.allTerms].filter((term) => recordTerms.has(term)).length;
  const requiredEvidence = Math.max(1, Math.ceil(query.evidenceTerms.size * 0.4));
  if (evidenceOverlap < requiredEvidence || allOverlap / Math.max(1, query.allTerms.size) < 0.2) {
    return {
      reason: "low-relevance",
      detail: `weak task-evidence match (${evidenceOverlap}/${query.evidenceTerms.size} symptom terms; ${allOverlap}/${query.allTerms.size} total terms) for confidence ${confidence.toFixed(2)}`,
    };
  }
  return null;
}

function emptyAbstention(): DeliveryAbstention {
  return {
    active: false,
    withheld: 0,
    reasons: { "low-confidence": 0, "insufficient-context": 0, "low-relevance": 0 },
    retry_hint: null,
  };
}

function isSafeDeliveryAnchor(value: string): boolean {
  const path = toPosixTarget(value);
  const segments = path.split("/");
  return !!path
    && !isAbsolute(path)
    && !/^[a-zA-Z]:/.test(path)
    && segments.every((segment) => !!segment && segment !== "." && segment !== ".." && segment.toLowerCase() !== ".git");
}

function anchorResolves(anchor: string, target: string, options: DeliveryOptions): boolean {
  const normalized = toPosixTarget(anchor);
  if (!isSafeDeliveryAnchor(normalized)) return false;
  const hasGlob = /[*?]/.test(normalized);
  if (!hasGlob && options.root && existsSync(join(options.root, normalized))) return true;
  if (hasGlob && options.root && existsSync(join(options.root, toPosixTarget(target))) && pathMatchesGlob(target, normalized)) return true;
  if (!hasGlob && pathsRelated(normalized, target) && options.root && existsSync(join(options.root, toPosixTarget(target)))) return true;
  return (options.symbols ?? []).some((symbol) =>
    pathMatchesGlob(symbol.file, normalized) || (!hasGlob && pathsRelated(symbol.file, normalized))
  );
}

function symbolResolves(anchor: string, target: string, options: DeliveryOptions): boolean {
  return anchor === target || (options.symbols ?? []).some((symbol) => symbol.id === anchor || symbol.name === anchor);
}

function componentResolves(id: string, target: string, options: DeliveryOptions): boolean {
  const component = (options.components ?? []).find((candidate) => candidate.id === id && candidate.status === "active");
  return !!component && component.paths.some((path) => anchorResolves(path, target, options));
}

function gitProbe(root: string, args: string[]): { available: boolean; status: number | null; stdout: string } {
  const result = spawnSync("git", ["-C", root, ...args], {
    encoding: "utf8",
    env: { ...process.env, GIT_NO_REPLACE_OBJECTS: "1" },
    stdio: ["ignore", "pipe", "ignore"],
    timeout: 2_000,
    windowsHide: true,
  });
  return { available: !result.error, status: result.status, stdout: result.stdout?.trim() ?? "" };
}

function defaultBranchRef(root: string): string | null {
  const remote = gitProbe(root, ["symbolic-ref", "--quiet", "refs/remotes/origin/HEAD"]);
  if (!remote.available) return null;
  if (remote.status === 0 && remote.stdout) return remote.stdout;
  for (const ref of ["refs/heads/main", "refs/heads/master", "HEAD"]) {
    const probe = gitProbe(root, ["rev-parse", "--verify", "--quiet", `${ref}^{commit}`]);
    if (!probe.available) return null;
    if (probe.status === 0) return ref;
  }
  return null;
}

function localCommitReachability(root: string): (commit: string) => CommitReachability {
  let initialized = false;
  let branch: string | null = null;
  return (commit: string): CommitReachability => {
    if (!initialized) {
      branch = defaultBranchRef(root);
      initialized = true;
    }
    if (!branch) return "unknown";
    if (!/^[0-9a-f]{7,64}$/i.test(commit)) return "unreachable";
    const exact = gitProbe(root, ["rev-parse", "--verify", "--quiet", `${commit}^{commit}`]);
    if (!exact.available) return "unknown";
    if (exact.status !== 0) return "unreachable";
    const ancestry = gitProbe(root, ["merge-base", "--is-ancestor", exact.stdout, branch]);
    if (!ancestry.available) return "unknown";
    if (ancestry.status === 0) return "reachable";
    if (ancestry.status === 1) return "unreachable";
    return "unknown";
  };
}

function validationState(
  anchors: readonly string[],
  anchorsResolve: (anchor: string) => boolean,
  commit: string | null | undefined,
  reachability: (commit: string) => CommitReachability,
  requireCommit = false,
  canValidateAnchors = true,
): { state: ProvenanceState; detail: string } {
  if (anchors.length && canValidateAnchors && !anchors.some(anchorsResolve)) {
    return { state: "stale", detail: "no recorded file/symbol/component anchor resolves in the current workspace/index" };
  }
  if (requireCommit && commit) {
    const reachable = reachability(commit);
    if (reachable === "unreachable") return { state: "stale", detail: `capture commit ${commit} is not reachable from the default branch` };
    if (reachable === "unknown") return { state: "unverified", detail: `capture commit ${commit} could not be checked` };
  }
  if (!anchors.length || !canValidateAnchors || (requireCommit && (commit === null || commit === undefined))) {
    return { state: "unverified", detail: requireCommit
      ? "record has no complete file/symbol + commit provenance pair"
      : "record has no resolvable file/symbol provenance anchor" };
  }
  return { state: "current", detail: requireCommit ? "anchors resolve and capture commit is reachable" : "anchors resolve" };
}

function fitText(text: string, cap: number): string {
  if (cap <= 0) return "";
  const chars = [...text];
  if (chars.length <= cap) return text;
  return chars.slice(0, cap).join("");
}

function charCount(text: string): number {
  return [...text].length;
}

function estimatedTokens(text: string): number {
  return Math.max(1, Math.ceil(charCount(text) / 4));
}

type UnsignedDeliveryEnvelope = Omit<DeliveryEnvelope, "receipt_id">;

function finalizeDeliveryEnvelope(unsigned: UnsignedDeliveryEnvelope): DeliveryEnvelope {
  const digest = landscapeFragmentHash(unsigned);
  const envelope = {
    ...unsigned,
    receipt_id: `hdr_${digest.slice("sha256:".length, "sha256:".length + 24)}`,
  };
  assertDeliveryEnvelope(envelope);
  return envelope;
}

/** Validate the public receipt without trusting a caller-supplied identity. */
export function assertDeliveryEnvelope(envelope: DeliveryEnvelope): void {
  if (envelope.schema_version !== DELIVERY_ENVELOPE_SCHEMA_VERSION) {
    throw new Error("delivery envelope schema is unsupported");
  }
  if (!/^hdr_[a-f0-9]{24}$/.test(envelope.receipt_id)) throw new Error("delivery envelope receipt id is invalid");
  if (!DELIVERY_PROFILES.includes(envelope.profile)
    || envelope.ranking_policy !== DELIVERY_PROFILE_POLICY_VERSION) {
    throw new Error("delivery envelope profile policy is unsupported");
  }
  if (!Number.isSafeInteger(envelope.budget_tokens) || envelope.budget_tokens < 0
    || !Number.isSafeInteger(envelope.used_chars) || envelope.used_chars !== charCount(envelope.text)
    || !Number.isSafeInteger(envelope.accounted_chars) || envelope.accounted_chars < envelope.used_chars) {
    throw new Error("delivery envelope budget accounting is invalid");
  }
  if (!envelope.blocking_overflow && envelope.accounted_chars > envelope.budget_tokens * 4) {
    throw new Error("delivery envelope exceeds its hard caller budget");
  }
  if (envelope.landscape) assertLandscapeDeliveryFragment(envelope.landscape);
  const landscapeReceipts = new Map((envelope.landscape
    ? [...envelope.landscape.resources, ...envelope.landscape.relationships]
    : []).map((item) => [`${item.record.schema === "hunch.resource/1" ? "resources" : "relationships"}:${item.record.id}`, item]));
  const deliveredLandscape = envelope.delivered.filter((item) => item.kind === "resources" || item.kind === "relationships");
  if (deliveredLandscape.length !== landscapeReceipts.size) {
    throw new Error("delivery envelope landscape receipts do not match delivered records");
  }
  const deliveredLandscapeKeys = new Set<string>();
  for (const receipt of deliveredLandscape) {
    const key = `${receipt.kind}:${receipt.record_id}`;
    const nested = landscapeReceipts.get(key);
    if (!nested || deliveredLandscapeKeys.has(key)
      || nested.rank !== receipt.rank || nested.tokenCost !== receipt.token_cost
      || nested.deliveryReason !== receipt.delivery_reason
      || nested.provenanceStatus !== receipt.provenance_status) {
      throw new Error("delivery envelope landscape receipt is inconsistent");
    }
    deliveredLandscapeKeys.add(key);
  }
  if (deliveredLandscapeKeys.size !== landscapeReceipts.size) {
    throw new Error("delivery envelope landscape receipts are not one-to-one");
  }
  const deliveredRecordChars = envelope.landscape
    ? [...envelope.landscape.resources, ...envelope.landscape.relationships]
      .reduce((sum, item) => sum + charCount(JSON.stringify(item.record)), 0)
    : 0;
  if (envelope.accounted_chars < envelope.used_chars + deliveredRecordChars) {
    throw new Error("delivery envelope undercounts its structured landscape records");
  }
  const { receipt_id: _receiptId, ...unsigned } = envelope;
  const expected = landscapeFragmentHash(unsigned);
  if (envelope.receipt_id !== `hdr_${expected.slice("sha256:".length, "sha256:".length + 24)}`) {
    throw new Error("delivery envelope receipt does not match its content");
  }
}

/** Build the one envelope used by CLI, MCP, and the edit hook. */
export function buildDeliveryEnvelope(ctx: AssembledContext, options: DeliveryOptions = {}): DeliveryEnvelope {
  const profile = options.profile ?? "builder";
  const budget = Number.isFinite(ctx.budget_tokens) ? Math.max(0, Math.floor(ctx.budget_tokens)) : 1500;
  const cap = budget * 4;
  const reachability = options.commitReachability
    ?? (options.root ? localCommitReachability(options.root) : (() => "unknown" as const));
  const canValidateAnchors = options.root !== undefined || options.symbols !== undefined || options.components !== undefined;
  const candidates: Candidate[] = [];
  const query = queryProfile(ctx.target, options);

  for (const constraint of ctx.constraints) {
    const retired = !options.historical && (constraint.status === "retired" || constraint.valid_to != null);
    const validation = validationState(
      constraint.scope,
      (anchor) => anchorResolves(anchor, ctx.target, options),
      undefined,
      reachability,
      false,
      canValidateAnchors,
    );
    candidates.push({
      ref: { kind: "constraints", record_id: constraint.id },
      mandatory: !retired && constraint.severity === "blocking",
      score: PROFILE_BASE_SCORE[profile].constraints + SEVERITY[constraint.severity] * 10 + (constraint.provenance.confidence ?? 0),
      provenance: validation.state,
      staleDetail: validation.detail,
      retiredDetail: retired ? "constraint is retired at HEAD" : undefined,
      line: `${constraint.id} | constraint/${constraint.severity} | ${clipHeadline(constraint.statement, 180)} | scope ${clipHeadline(constraint.scope.join(", ") || "repo", 100)} | ${sourceTier(constraint.provenance.source)}/${validation.state} | hunch_why("${constraint.id}")`,
    });
  }

  for (const decision of ctx.decisions) {
    const retired = !options.historical && (decision.status === "rejected" || decision.status === "superseded" || !!decision.superseded_by || decision.valid_to != null);
    const fileAnchors = decision.related_files;
    const componentAnchors = decision.related_components;
    const validation = validationState(
      [...fileAnchors, ...componentAnchors],
      (anchor) => fileAnchors.includes(anchor)
        ? anchorResolves(anchor, ctx.target, options)
        : componentResolves(anchor, ctx.target, options),
      decision.commit,
      reachability,
      true,
      canValidateAnchors,
    );
    const abstention = decisionAbstention(decision, query);
    const relevanceTerms = query.taskPhrase ? decisionEvidenceMatches(decision, query) : undefined;
    const hypothesis = query.taskPhrase ? decisionHypothesis(decision, relevanceTerms ?? [], ctx.target) : undefined;
    candidates.push({
      ref: { kind: "decisions", record_id: decision.id },
      mandatory: false,
      score: PROFILE_BASE_SCORE[profile].decisions + (decision.status === "accepted" ? 20 : 0) + (decision.provenance.confidence ?? 0),
      provenance: validation.state,
      staleDetail: validation.detail,
      retiredDetail: retired ? `decision is ${decision.status} at HEAD` : undefined,
      abstainReason: abstention?.reason,
      abstainDetail: abstention?.detail,
      hypothesis,
      relevanceTerms,
      line: hypothesis
        ? renderHypothesis(hypothesis, validation.state, decision.provenance.source)
        : `${decision.id} | decision/${decision.status} | ${clipHeadline(`${decision.title}: ${decision.decision}`, 220)} | scope ${clipHeadline(decision.related_files.join(", ") || decision.related_components.join(", ") || "unanchored", 100)} | ${sourceTier(decision.provenance.source)}/${validation.state} | hunch_why("${decision.id}")`,
    });
  }

  for (const bug of ctx.bugs) {
    const anchors = [...bug.affected_files, ...bug.affected_symbols];
    const validation = validationState(
      anchors,
      (anchor) => bug.affected_files.includes(anchor)
        ? anchorResolves(anchor, ctx.target, options)
        : symbolResolves(anchor, ctx.target, options),
      undefined,
      reachability,
      false,
      canValidateAnchors,
    );
    candidates.push({
      ref: { kind: "bugs", record_id: bug.id },
      mandatory: false,
      score: PROFILE_BASE_SCORE[profile].bugs + SEVERITY[bug.severity] * 10 + (bug.status === "open" || bug.status === "regressed" ? 10 : 0),
      provenance: validation.state,
      staleDetail: validation.detail,
      line: `${bug.id} | bug/${bug.status}/${bug.severity} | ${clipHeadline(`${bug.title} — root cause: ${bug.root_cause}`, 220)} | ${sourceTier(bug.provenance.source)}/${validation.state} | hunch_why("${bug.id}")`,
    });
  }

  for (const finding of ctx.findings) {
    const anchors = [...finding.affected_files, ...finding.affected_symbols];
    const validation = validationState(
      anchors,
      (anchor) => finding.affected_files.includes(anchor)
        ? anchorResolves(anchor, ctx.target, options)
        : symbolResolves(anchor, ctx.target, options),
      undefined,
      reachability,
      false,
      canValidateAnchors,
    );
    const evidence = `${finding.violates_constraint ? `; violates ${finding.violates_constraint}` : ""}${finding.method ? `; re-verify via ${finding.method}` : ""}`;
    candidates.push({
      ref: { kind: "findings", record_id: finding.id },
      mandatory: false,
      score: PROFILE_BASE_SCORE[profile].findings + SEVERITY[finding.severity] * 10,
      provenance: validation.state,
      staleDetail: validation.detail,
      line: `${finding.id} | finding/${finding.triage}/${finding.severity} | ${clipHeadline(`${finding.title} — ${finding.observation}${evidence}`, 240)} | ${sourceTier(finding.provenance.source)}/${validation.state} | hunch_why("${finding.id}")`,
    });
  }

  for (const item of ctx.landscape?.resources ?? []) {
    const record = item.record;
    const reviewId = String(record.metadata.landscape_review_id);
    const revision = record.currentness.source_revision ?? "unknown";
    const line = `${record.id} | resource/${record.kind}/${record.lifecycle} | ${clipHeadline(record.name, 160)} | ${item.selectionReason} | current@${revision} | review ${reviewId}`;
    candidates.push({
      ref: { kind: "resources", record_id: record.id },
      mandatory: false,
      score: PROFILE_BASE_SCORE[profile].resources - item.selectionRank,
      provenance: "current",
      line,
      landscapeResource: item,
      // The structured record is part of what an MCP caller receives. Charge
      // it conservatively instead of pretending only the duplicate headline
      // consumes the caller's context budget.
      accountedChars: charCount(line) + charCount(JSON.stringify(record)) + 240,
    });
  }
  for (const item of ctx.landscape?.relationships ?? []) {
    const record = item.record;
    const reviewId = String(record.metadata.landscape_review_id);
    const revision = record.currentness?.source_revision ?? "unknown";
    const line = `${record.id} | relationship/${record.type} | ${record.from} -> ${record.to} | graph-connection | current@${revision} | review ${reviewId}`;
    candidates.push({
      ref: { kind: "relationships", record_id: record.id },
      mandatory: false,
      score: PROFILE_BASE_SCORE[profile].relationships - item.selectionRank,
      provenance: "current",
      line,
      landscapeRelationship: item,
      accountedChars: charCount(line) + charCount(JSON.stringify(record)) + 240,
    });
  }

  for (const dependent of ctx.blast_radius) {
    candidates.push({ mandatory: false, score: 400 - dependent.depth, provenance: "current", line: `graph | blast/d${dependent.depth} | ${clipHeadline(dependent.via, 220)}` });
  }
  if (ctx.components.length) {
    candidates.push({ mandatory: false, score: 300, provenance: "current", line: `graph | components | ${clipHeadline(ctx.components.map((component) => component.name).join(", "), 240)}` });
  }

  const hasAnything = candidates.length > 0
    || (ctx.landscape?.omitted.length ?? 0) > 0
    || (options.supplements?.length ?? 0) > 0;
  if (!hasAnything) {
    const empty = `# Hunch context for "${ctx.target}"\n\n(No recorded constraints/decisions/bugs for this target yet — Hunch is still learning it.)\n`;
    const text = fitText(empty, cap);
    return finalizeDeliveryEnvelope({
      schema_version: DELIVERY_ENVELOPE_SCHEMA_VERSION,
      profile,
      ranking_policy: DELIVERY_PROFILE_POLICY_VERSION,
      text,
      delivered: [],
      hypotheses: [],
      obligations: [],
      supplements: [],
      omitted: [],
      landscape: null,
      budget_tokens: budget,
      used_chars: charCount(text),
      accounted_chars: charCount(text),
      blocking_overflow: false,
      abstention: emptyAbstention(),
    });
  }

  const omitted: DeliveryOmission[] = (ctx.landscape?.omitted ?? []).map((item) => ({
    kind: item.kind,
    record_id: item.recordId,
    reason: item.reason,
    detail: item.detail,
  }));
  const eligible: Candidate[] = [];
  for (const candidate of candidates) {
    if (candidate.retiredDetail && candidate.ref) {
      omitted.push({ ...candidate.ref, reason: "retired", detail: candidate.retiredDetail });
      continue;
    }
    if (candidate.provenance === "stale" && !candidate.mandatory && candidate.ref) {
      omitted.push({ ...candidate.ref, reason: "stale-provenance", detail: candidate.staleDetail ?? "provenance is stale" });
      continue;
    }
    if (candidate.abstainReason && !candidate.mandatory && candidate.ref) {
      omitted.push({ ...candidate.ref, reason: candidate.abstainReason, detail: candidate.abstainDetail ?? "delivery confidence gate abstained" });
      continue;
    }
    eligible.push(candidate);
  }
  const hypothesisCandidates = eligible.filter((candidate) => candidate.hypothesis);
  const documentFrequency = new Map<string, number>();
  for (const candidate of hypothesisCandidates) {
    for (const term of new Set(candidate.relevanceTerms ?? [])) {
      documentFrequency.set(term, (documentFrequency.get(term) ?? 0) + 1);
    }
  }
  for (const candidate of hypothesisCandidates) {
    const rarity = (candidate.relevanceTerms ?? []).reduce((sum, term) => {
      const frequency = documentFrequency.get(term) ?? hypothesisCandidates.length;
      return sum + Math.log2((hypothesisCandidates.length + 1) / (frequency + 1)) + 1;
    }, 0);
    // Rank specific task evidence (rare across the retrieved candidate set)
    // above generic verbs such as "parse", "value", and "property".
    candidate.score += rarity * 10;
  }
  eligible.sort((left, right) => Number(right.mandatory) - Number(left.mandatory) || right.score - left.score || (left.ref?.record_id ?? left.line).localeCompare(right.ref?.record_id ?? right.line));

  const boundedEligible: Candidate[] = [];
  let actionableHypotheses = 0;
  for (const candidate of eligible) {
    if (candidate.hypothesis && candidate.ref) {
      if (actionableHypotheses >= MAX_ACTIONABLE_HYPOTHESES) {
        omitted.push({
          ...candidate.ref,
          reason: "actionability-cap",
          detail: `only the top ${MAX_ACTIONABLE_HYPOTHESES} decision hypotheses are delivered; refine the task evidence or inspect this record with hunch_why`,
        });
        continue;
      }
      actionableHypotheses++;
    }
    boundedEligible.push(candidate);
  }

  const profileBoundedEligible: Candidate[] = [];
  let nonBlockingHeadlines = 0;
  for (const candidate of boundedEligible) {
    if (candidate.ref && !candidate.mandatory) {
      if (nonBlockingHeadlines >= MAX_PROFILE_HEADLINES) {
        omitted.push({
          ...candidate.ref,
          reason: "profile-cap",
          detail: `${profile} delivery is capped at ${MAX_PROFILE_HEADLINES} non-blocking headlines; use hunch_why or a narrower task to expand this record`,
        });
        continue;
      }
      nonBlockingHeadlines++;
    }
    profileBoundedEligible.push(candidate);
  }

  const recordCandidates = profileBoundedEligible.filter((candidate) => candidate.ref);
  const structuralCandidates = profileBoundedEligible.filter((candidate) => !candidate.ref);
  const lines = [
    `# Hunch context for "${ctx.target}"`,
    "",
    query.taskPhrase
      ? `## 🧠 ${profile === "builder" ? "Bounded" : `${profile[0]!.toUpperCase()}${profile.slice(1)}-bounded`} memory (Invariants · max ${MAX_ACTIONABLE_HYPOTHESES} decision hypotheses · Bugs · Known findings)`
      : `## 🧠 ${profile === "builder" ? "Ranked" : `${profile[0]!.toUpperCase()}${profile.slice(1)}-ranked`} memory (Invariants · Decisions · Bugs · Known findings)`,
  ];
  if (candidates.some((candidate) => candidate.abstainReason)) {
    lines.push("Evidence rule: explicit task, repro, and test evidence outranks advisory memory; weak unverified matches are withheld.");
  }
  if (query.taskPhrase) {
    lines.push("Diagnostic loop: before editing, call hunch_context again with the first concrete failing assertion, stack frame, expected behavior, and API/code path you observe.");
  }
  if ((ctx.landscape?.resources.length ?? 0) + (ctx.landscape?.relationships.length ?? 0) > 0) {
    lines.push(`Landscape: only current human-reviewed ${LANDSCAPE_FRAGMENT_SCHEMA_VERSION} records may share this envelope and budget.`);
  }
  let text = fitText(`${lines.join("\n")}\n`, cap);
  let accountedChars = charCount(text);
  const delivered: DeliveredItem[] = [];
  const hypotheses: DeliveryHypothesis[] = [];
  const obligations: ExecutionObligation[] = [];
  const supplements: DeliveredSupplement[] = [];
  let blockingOverflow = false;
  const deliveredLandscapeResourceIds = new Set<string>();
  for (const [index, candidate] of recordCandidates.entries()) {
    const next = `- ${candidate.line}\n`;
    if (candidate.landscapeRelationship) {
      const relationship = candidate.landscapeRelationship.record;
      if (!deliveredLandscapeResourceIds.has(relationship.from) || !deliveredLandscapeResourceIds.has(relationship.to)) {
        omitted.push({
          ...candidate.ref!,
          reason: "endpoint-not-delivered",
          detail: "reviewed relationship was withheld because both endpoint resources were not delivered in this budget",
        });
        continue;
      }
    }
    const chargedChars = candidate.accountedChars ?? charCount(next);
    if (accountedChars + chargedChars <= cap || candidate.mandatory) {
      text += next;
      accountedChars += chargedChars;
      delivered.push({
        ...candidate.ref!,
        rank: index + 1,
        delivery_reason: candidate.mandatory ? "blocking-reserved" : "ranked",
        provenance_status: candidate.provenance,
        token_cost: Math.max(1, Math.ceil(chargedChars / 4)),
      });
      if (candidate.landscapeResource) deliveredLandscapeResourceIds.add(candidate.landscapeResource.record.id);
      if (candidate.hypothesis) {
        hypotheses.push({ ...candidate.hypothesis, rank: index + 1 });
        obligations.push(...candidate.hypothesis.obligations);
      }
      if (accountedChars > cap && candidate.mandatory) blockingOverflow = true;
    } else if (candidate.ref) {
      omitted.push({ ...candidate.ref, reason: "budget", detail: `ranked headline did not fit the ${budget}-token budget` });
    }
  }

  const deliveredDecisionIds = new Set(
    delivered.filter((item) => item.kind === "decisions").map((item) => item.record_id),
  );
  const deliveredDecisions = ctx.decisions.filter((decision) => deliveredDecisionIds.has(decision.id));
  const decisionGrounding = options.decisionCorpus?.length && deliveredDecisions.length
    ? renderGrounding(deliveredDecisions, [...options.decisionCorpus])
    : "";
  const supplementalCandidates: DeliverySupplement[] = [
    ...(decisionGrounding ? [{ id: "decision-grounding", kind: "decision-grounding", text: decisionGrounding, priority: 1_000 }] : []),
    ...(options.supplements ?? []),
  ].sort((left, right) => (right.priority ?? 0) - (left.priority ?? 0) || left.id.localeCompare(right.id));

  for (const [index, supplement] of supplementalCandidates.entries()) {
    const content = clipHeadline(supplement.text, 700);
    if (!content) {
      supplements.push({ id: supplement.id, kind: supplement.kind, delivered: false, reason: "empty", rank: index + 1, token_cost: 0 });
      continue;
    }
    const next = `- supplemental/${supplement.kind} | ${content}\n`;
    const tokenCost = estimatedTokens(next);
    const abstainedMemory = omitted.some((item) => item.reason === "low-confidence" || item.reason === "insufficient-context" || item.reason === "low-relevance");
    if (abstainedMemory && delivered.length === 0 && supplement.kind.startsWith("search-")) {
      supplements.push({ id: supplement.id, kind: supplement.kind, delivered: false, reason: "abstained", rank: index + 1, token_cost: tokenCost });
    } else if (accountedChars + charCount(next) <= cap) {
      text += next;
      accountedChars += charCount(next);
      supplements.push({ id: supplement.id, kind: supplement.kind, delivered: true, reason: "supplemental", rank: index + 1, token_cost: tokenCost });
    } else {
      supplements.push({ id: supplement.id, kind: supplement.kind, delivered: false, reason: "budget", rank: index + 1, token_cost: tokenCost });
    }
  }

  for (const candidate of structuralCandidates) {
    const next = `- ${candidate.line}\n`;
    if (accountedChars + charCount(next) <= cap) {
      text += next;
      accountedChars += charCount(next);
    }
  }

  const staleCount = omitted.filter((item) => item.reason === "stale-provenance" || item.reason === "retired").length;
  const budgetCount = omitted.filter((item) => item.reason === "budget").length;
  const actionabilityCount = omitted.filter((item) => item.reason === "actionability-cap").length;
  const profileCapCount = omitted.filter((item) => item.reason === "profile-cap").length;
  const abstention = emptyAbstention();
  for (const item of omitted) {
    if (item.reason === "low-confidence" || item.reason === "insufficient-context" || item.reason === "low-relevance") {
      abstention.active = true;
      abstention.withheld++;
      abstention.reasons[item.reason]++;
    }
  }
  if (abstention.active) {
    abstention.retry_hint = "Retry hunch_context with the concrete symptom, expected behavior, failing API, and repro evidence; do not let advisory memory override the task or tests.";
  }
  const notes = [
    staleCount ? `${staleCount} stale/retired record(s) withheld; run hunch drift or hunch_why(id) to inspect.` : "",
    budgetCount ? `${budgetCount} lower-ranked record(s) omitted by budget; use hunch_why(id) to drill down.` : "",
    actionabilityCount ? `${actionabilityCount} additional decision hypothesis/hypotheses withheld by the actionability cap; refine the task evidence or use hunch_why(id).` : "",
    profileCapCount ? `${profileCapCount} non-blocking record(s) withheld by the ${profile} profile cap; use hunch_why(id) or narrow the task.` : "",
    abstention.active ? `${abstention.withheld} weak prescriptive record(s) withheld by confidence/relevance abstention. ${abstention.retry_hint}` : "",
  ].filter(Boolean);
  if (notes.length) {
    const footer = `… ${notes.join(" ")}\n`;
    if (accountedChars + charCount(footer) <= cap) {
      text += footer;
      accountedChars += charCount(footer);
    }
  }
  if (!text.endsWith("\n") && accountedChars < cap) {
    text += "\n";
    accountedChars += 1;
  }
  if (!blockingOverflow) text = fitText(text, cap);
  omitted.sort((left, right) => left.record_id.localeCompare(right.record_id) || left.reason.localeCompare(right.reason));
  const deliveredById = new Map(delivered.map((item) => [`${item.kind}:${item.record_id}`, item]));
  const landscapeResources: DeliveredLandscapeResource[] = (ctx.landscape?.resources ?? [])
    .flatMap((selection) => {
      const receipt = deliveredById.get(`resources:${selection.record.id}`);
      if (!receipt) return [];
      return [{
        ...selection,
        rank: receipt.rank,
        deliveryReason: "ranked" as const,
        required: false as const,
        blocking: false as const,
        provenanceStatus: "current" as const,
        tokenCost: receipt.token_cost,
      }];
    });
  const landscapeRelationships: DeliveredLandscapeRelationship[] = (ctx.landscape?.relationships ?? [])
    .flatMap((selection) => {
      const receipt = deliveredById.get(`relationships:${selection.record.id}`);
      if (!receipt) return [];
      return [{
        ...selection,
        rank: receipt.rank,
        deliveryReason: "ranked" as const,
        required: false as const,
        blocking: false as const,
        provenanceStatus: "current" as const,
        tokenCost: receipt.token_cost,
      }];
    });
  const landscapeOmissions = omitted
    .filter((item) => item.kind === "resources" || item.kind === "relationships")
    .flatMap((item) => {
      if (!["budget", "stale-provenance", "endpoint-not-delivered", "landscape-cap", "profile-cap"].includes(item.reason)) return [];
      return [{
        kind: item.kind as "resources" | "relationships",
        recordId: item.record_id,
        reason: (item.reason === "profile-cap" ? "landscape-cap" : item.reason) as "budget" | "stale-provenance" | "endpoint-not-delivered" | "landscape-cap",
        detail: item.detail,
      }];
    });
  const landscape = ctx.landscape && (
    landscapeResources.length > 0
    || landscapeRelationships.length > 0
    || landscapeOmissions.length > 0
  )
    ? createLandscapeDeliveryFragment({
      selection: ctx.landscape,
      resources: landscapeResources,
      relationships: landscapeRelationships,
      omitted: landscapeOmissions,
    })
    : null;
  return finalizeDeliveryEnvelope({
    schema_version: DELIVERY_ENVELOPE_SCHEMA_VERSION,
    profile,
    ranking_policy: DELIVERY_PROFILE_POLICY_VERSION,
    text,
    delivered,
    hypotheses,
    obligations,
    supplements,
    omitted,
    landscape,
    budget_tokens: budget,
    used_chars: charCount(text),
    accounted_chars: accountedChars,
    blocking_overflow: blockingOverflow,
    abstention,
  });
}
