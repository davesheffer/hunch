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
import { pathMatchesGlob, pathsRelated } from "./glob.js";
import { toPosixTarget } from "./paths.js";
import { renderGrounding } from "./topics.js";

export type DeliveryKind = "constraints" | "decisions" | "bugs" | "findings";
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
  reason: "supplemental" | "budget" | "empty";
  rank: number;
  token_cost: number;
}

export interface DeliveryOmission extends DeliveryRef {
  reason: "budget" | "stale-provenance" | "retired";
  detail: string;
}

export interface DeliveryEnvelope {
  text: string;
  delivered: DeliveredItem[];
  supplements: DeliveredSupplement[];
  omitted: DeliveryOmission[];
  budget_tokens: number;
  used_chars: number;
  /** True only when the requested budget is mathematically too small to name
   * every active blocking invariant. Safety wins, and the overflow is explicit. */
  blocking_overflow: boolean;
}

export interface DeliveryOptions {
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
}

const SEVERITY = { advisory: 1, warning: 2, blocking: 3, low: 1, medium: 2, high: 3, critical: 4 } as const;

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

/** Build the one envelope used by CLI, MCP, and the edit hook. */
export function buildDeliveryEnvelope(ctx: AssembledContext, options: DeliveryOptions = {}): DeliveryEnvelope {
  const budget = Number.isFinite(ctx.budget_tokens) ? Math.max(0, Math.floor(ctx.budget_tokens)) : 1500;
  const cap = budget * 4;
  const reachability = options.commitReachability
    ?? (options.root ? localCommitReachability(options.root) : (() => "unknown" as const));
  const canValidateAnchors = options.root !== undefined || options.symbols !== undefined || options.components !== undefined;
  const candidates: Candidate[] = [];

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
      score: 900 + SEVERITY[constraint.severity] * 10 + (constraint.provenance.confidence ?? 0),
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
    candidates.push({
      ref: { kind: "decisions", record_id: decision.id },
      mandatory: false,
      score: 700 + (decision.status === "accepted" ? 20 : 0) + (decision.provenance.confidence ?? 0),
      provenance: validation.state,
      staleDetail: validation.detail,
      retiredDetail: retired ? `decision is ${decision.status} at HEAD` : undefined,
      line: `${decision.id} | decision/${decision.status} | ${clipHeadline(`${decision.title}: ${decision.decision}`, 220)} | scope ${clipHeadline(decision.related_files.join(", ") || decision.related_components.join(", ") || "unanchored", 100)} | ${sourceTier(decision.provenance.source)}/${validation.state} | hunch_why("${decision.id}")`,
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
      score: 800 + SEVERITY[bug.severity] * 10 + (bug.status === "open" || bug.status === "regressed" ? 10 : 0),
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
      score: 600 + SEVERITY[finding.severity] * 10,
      provenance: validation.state,
      staleDetail: validation.detail,
      line: `${finding.id} | finding/${finding.triage}/${finding.severity} | ${clipHeadline(`${finding.title} — ${finding.observation}${evidence}`, 240)} | ${sourceTier(finding.provenance.source)}/${validation.state} | hunch_why("${finding.id}")`,
    });
  }

  for (const dependent of ctx.blast_radius) {
    candidates.push({ mandatory: false, score: 400 - dependent.depth, provenance: "current", line: `graph | blast/d${dependent.depth} | ${clipHeadline(dependent.via, 220)}` });
  }
  if (ctx.components.length) {
    candidates.push({ mandatory: false, score: 300, provenance: "current", line: `graph | components | ${clipHeadline(ctx.components.map((component) => component.name).join(", "), 240)}` });
  }

  const hasAnything = candidates.length > 0 || (options.supplements?.length ?? 0) > 0;
  if (!hasAnything) {
    const empty = `# Hunch context for "${ctx.target}"\n\n(No recorded constraints/decisions/bugs for this target yet — Hunch is still learning it.)\n`;
    const text = fitText(empty, cap);
    return { text, delivered: [], supplements: [], omitted: [], budget_tokens: budget, used_chars: charCount(text), blocking_overflow: false };
  }

  const omitted: DeliveryOmission[] = [];
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
    eligible.push(candidate);
  }
  eligible.sort((left, right) => Number(right.mandatory) - Number(left.mandatory) || right.score - left.score || (left.ref?.record_id ?? left.line).localeCompare(right.ref?.record_id ?? right.line));

  const recordCandidates = eligible.filter((candidate) => candidate.ref);
  const structuralCandidates = eligible.filter((candidate) => !candidate.ref);
  const lines = [
    `# Hunch context for "${ctx.target}"`,
    "",
    "## 🧠 Ranked memory (Invariants · Decisions · Bugs · Known findings)",
  ];
  let text = `${lines.join("\n")}\n`;
  const delivered: DeliveredItem[] = [];
  const supplements: DeliveredSupplement[] = [];
  let blockingOverflow = false;
  for (const [index, candidate] of recordCandidates.entries()) {
    const next = `- ${candidate.line}\n`;
    if (charCount(text) + charCount(next) <= cap || candidate.mandatory) {
      text += next;
      delivered.push({
        ...candidate.ref!,
        rank: index + 1,
        delivery_reason: candidate.mandatory ? "blocking-reserved" : "ranked",
        provenance_status: candidate.provenance,
        token_cost: estimatedTokens(next),
      });
      if (charCount(text) > cap && candidate.mandatory) blockingOverflow = true;
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
    if (charCount(text) + charCount(next) <= cap) {
      text += next;
      supplements.push({ id: supplement.id, kind: supplement.kind, delivered: true, reason: "supplemental", rank: index + 1, token_cost: tokenCost });
    } else {
      supplements.push({ id: supplement.id, kind: supplement.kind, delivered: false, reason: "budget", rank: index + 1, token_cost: tokenCost });
    }
  }

  for (const candidate of structuralCandidates) {
    const next = `- ${candidate.line}\n`;
    if (charCount(text) + charCount(next) <= cap) text += next;
  }

  const staleCount = omitted.filter((item) => item.reason === "stale-provenance" || item.reason === "retired").length;
  const budgetCount = omitted.filter((item) => item.reason === "budget").length;
  const notes = [
    staleCount ? `${staleCount} stale/retired record(s) withheld; run hunch drift or hunch_why(id) to inspect.` : "",
    budgetCount ? `${budgetCount} lower-ranked record(s) omitted by budget; use hunch_why(id) to drill down.` : "",
  ].filter(Boolean);
  if (notes.length) {
    const footer = `… ${notes.join(" ")}\n`;
    if (charCount(text) + charCount(footer) <= cap) text += footer;
  }
  if (!text.endsWith("\n") && charCount(text) < cap) text += "\n";
  if (!blockingOverflow) text = fitText(text, cap);
  omitted.sort((left, right) => left.record_id.localeCompare(right.record_id) || left.reason.localeCompare(right.reason));
  return {
    text,
    delivered,
    supplements,
    omitted,
    budget_tokens: budget,
    used_chars: charCount(text),
    blocking_overflow: blockingOverflow,
  };
}
