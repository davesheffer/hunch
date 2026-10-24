import { cleanupDir, isolatedCliEnv, tempDir } from "./fixtures.js";
/**
 * Every MCP tool PARAMETER over a real stdio connection (`hunch mcp`, HUNCH_MCP_TOOLS=all).
 *
 * EXPECTED_PARAMS is the parameter contract discovered from tools/list. A parameter
 * added to src/mcp fails this suite until it is listed here AND classified in EFFECT
 * (optional) — so no parameter ships that was never sent end-to-end. Per parameter:
 * a wrong-type value is refused cleanly; each enum value is accepted (or refused by
 * the domain, never by the protocol); an omitted required parameter is refused; an
 * optional parameter changes the observable result, or carries a written reason why
 * it cannot here (NO-EFFECT entries are review candidates, printed as diagnostics).
 *
 * The seeded-repo harness mirrors test/mcp-surface.test.ts (nothing there is exported).
 */
import { test, before, after } from "node:test";
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { copyFileSync, existsSync, mkdirSync, readFileSync, readdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StdioClientTransport } from "@modelcontextprotocol/sdk/client/stdio.js";
import { HunchStore } from "../src/store/hunchStore.js";
import { hunchPaths } from "../src/core/paths.js";
import { MCP_TOOL_GROUPS } from "../src/mcp/toolset.js";
import { listReportTasks } from "../src/core/taskReport.js";

const PROJECT_ROOT = process.cwd();
const TSX = join(PROJECT_ROOT, "node_modules/tsx/dist/cli.mjs");
const CLI = join(PROJECT_ROOT, "src/cli/index.ts");

/** `tool.param type [enum|values] [required]` — enum includes array-item enums. */
const EXPECTED_PARAMS = [
  "hunch_query.query string required",
  "hunch_task.action string start|finish required",
  "hunch_task.task_id string",
  "hunch_task.title string",
  "hunch_task.outcome string completed|interrupted",
  "hunch_task.applications array",
  "hunch_task.cwd string",
  "hunch_report.task_id string",
  "hunch_report.lesson object",
  "hunch_report.before integer",
  "hunch_report.html boolean",
  "hunch_report.cwd string",
  "hunch_runbook.task string required",
  "hunch_why.target string required",
  "hunch_why.as_of string",
  "hunch_bug_lineage.symptom_or_symbol string required",
  "hunch_check_constraints.scope string required",
  "hunch_get_dependents.symbol string required",
  "hunch_blast_radius.target string required",
  "hunch_change_identity.base_ref string required",
  "hunch_change_identity.head_ref string",
  "hunch_change_identity.cwd string",
  "hunch_change_proof.base_ref string required",
  "hunch_change_proof.result_ref string",
  "hunch_change_proof.public_only boolean",
  "hunch_change_proof.cwd string",
  "hunch_project_dna.ref string",
  "hunch_project_dna.cwd string",
  "hunch_project_match.kind string commit|pull_request|issue|message required",
  "hunch_project_match.title string required",
  "hunch_project_match.body string",
  "hunch_project_match.ref string",
  "hunch_project_match.cwd string",
  "hunch_project_dna_delta.from_ref string required",
  "hunch_project_dna_delta.to_ref string required",
  "hunch_project_dna_delta.cwd string",
  "hunch_context.target string required",
  "hunch_context.budget_tokens number",
  "hunch_context.profile string builder|reviewer|architect",
  "hunch_context.as_of string",
  "hunch_context.task_id string",
  "hunch_context.include array recent_tasks|project_dna",
  "hunch_context.cwd string",
  "hunch_shortlist.issue string required",
  "hunch_shortlist.limit integer",
  "hunch_shortlist.evidence object",
  "hunch_shortlist.cwd string",
  "hunch_evidence_map.version number required",
  "hunch_evidence_map.claim string required",
  "hunch_evidence_map.probe object required",
  "hunch_evidence_map.execution array",
  "hunch_evidence_map.interventions array",
  "hunch_now.recent_limit number",
  "hunch_now.roadmap_limit number",
  "hunch_workspaces.view string inventory|branches",
  "hunch_workspaces.machine string",
  "hunch_workspaces.branch string",
  "hunch_workspaces.merged_only boolean",
  "hunch_review_imported_adr.decision_id string required",
  "hunch_review_imported_adr.expected_source_hash string required",
  "hunch_review_imported_adr.expected_review_hash string required",
  "hunch_review_imported_adr.disposition string approve|decline required",
  "hunch_review_imported_adr.reviewed_by string",
  "hunch_review_imported_adr.cwd string",
  "hunch_timeline.target string required",
  "hunch_capture_decision.topic string",
  "hunch_capture_decision.seed string",
  "hunch_capture_decision.deciding boolean",
  "hunch_current_decision.topic string required",
  "hunch_record_decision.decision object required",
  "hunch_record_decision.capture_token string",
  "hunch_record_decision.task_id string",
  "hunch_record_decision.cwd string",
  "hunch_record_correction.rule string required",
  "hunch_record_correction.scope_hint_file string",
  "hunch_record_correction.severity string advisory|warning|blocking",
  "hunch_record_correction.applies_to_all boolean",
  "hunch_record_correction.type string security|performance|correctness|architecture|compliance",
  "hunch_record_correction.rationale string",
  "hunch_record_correction.source_decision string",
  "hunch_record_correction.private boolean",
  "hunch_record_correction.capture_token string",
  "hunch_record_correction.task_id string",
  "hunch_record_correction.cwd string",
  "hunch_record_finding.finding object required",
  "hunch_record_finding.task_id string",
  "hunch_record_finding.cwd string",
  "nuryel_read.principal object required",
  "nuryel_read.scope object required",
  "nuryel_read.scopes array",
  "nuryel_read.subject string",
  "nuryel_read.task string",
  "nuryel_read.profile string builder|reviewer|architect",
  "nuryel_read.budget_tokens integer",
  "nuryel_read.facets array decisions|constraints|bugs|findings|receipts|commitments|derived|entities|relationships|conventions",
  "nuryel_read.observed_page object",
  "nuryel_write.principal object required",
  "nuryel_write.scope object required",
  "nuryel_write.facet string decisions|constraints|bugs|findings|receipts|commitments|derived|entities|relationships|conventions required",
  "nuryel_write.record object required",
  "nuryel_write.idempotency_key string required",
  "nuryel_write.expected_version anyOf",
  "nuryel_write.supersedes string",
  "nuryel_write.cause object",
  "nuryel_write.cwd string",
  "nuryel_capture.visibility object",
  "nuryel_capture.principal object required",
  "nuryel_capture.scope object required",
  "nuryel_capture.subject string required",
  "nuryel_capture.statement string required",
  "nuryel_capture.relevance object required",
  "nuryel_capture.evidence array required",
  "nuryel_capture.cwd string",
  "nuryel_capture_batch.principal object required",
  "nuryel_capture_batch.scope object required",
  "nuryel_capture_batch.sources array required",
  "nuryel_capture_batch.observations array required",
  "nuryel_capture_batch.reviews array",
  "nuryel_capture_batch.cwd string",
  "nuryel_subscribe.principal object required",
  "nuryel_subscribe.scope object required",
  "nuryel_subscribe.after_seq integer required",
  "nuryel_subscribe.subjects array",
  "nuryel_subscribe.facets array decisions|constraints|bugs|findings|receipts|commitments|derived|entities|relationships|conventions",
  "nuryel_records.principal object required",
  "nuryel_records.scope object required",
  "nuryel_records.ids array required",
  "hunch_findings.scope string",
  "hunch_findings.all boolean",
  "hunch_findings.id string",
  "hunch_findings.limit integer",
  "hunch_policy_upgrade_correction.constraint_id string required",
  "hunch_policy_upgrade_correction.public_only boolean",
  "hunch_policy_upgrade_correction.private_only boolean",
  "hunch_policy_upgrade_correction.include_artifacts boolean",
  "hunch_policy_upgrade_correction.cwd string",
  "hunch_merge_verdict.base string",
  "hunch_merge_verdict.commit string",
  "hunch_merge_verdict.working boolean",
  "hunch_structure.target string",
  "hunch_pr_impact.base string",
  "hunch_pr_impact.commit string",
  "hunch_pr_impact.working boolean",
  "hunch_path.from string required",
  "hunch_path.to string required",
  "hunch_path.max_depth number",
  "hunch_compare.candidates array required",
  "hunch_compare.base string",
  "hunch_policy_candidates.public_only boolean",
  "hunch_policy_plan.policy_id string required",
  "hunch_policy_plan.public_only boolean",
  "hunch_policy_plan.cwd string",
  "hunch_policy_card.policy_id string required",
  "hunch_policy_card.public_only boolean",
  "hunch_policy_shadow.policy_id string required",
  "hunch_policy_shadow.public_only boolean",
  "hunch_policy_proof.policy_id string required",
  "hunch_policy_proof.public_only boolean",
  "hunch_policy_evaluate.policy_id string",
  "hunch_policy_evaluate.active_only boolean",
  "hunch_policy_evaluate.public_only boolean",
  "hunch_policy_evaluate.workspace string staged|working",
  "hunch_policy_evaluate.commit string",
  "hunch_constitution_g2_shadow_queue.limit integer",
  "hunch_constitution_g2_operational_drill.category string evaluator_error|false_positive|private_leak|stale_policy|provider_outage|corrupt_graph|adapter_break required",
  "hunch_constitution_g2_candidates.since string",
  "hunch_constitution_g2_candidates.max_commits integer",
  "hunch_constitution_g2_candidates.limit integer",
  "hunch_constitution_g2_behavior_candidates.decision_id string",
  "hunch_constitution_g2_behavior_candidates.since string",
  "hunch_constitution_g2_behavior_candidates.max_commits integer",
  "hunch_constitution_g2_behavior_candidates.limit integer",
  "hunch_constitution_g2_behavior_replay.candidate_id string required",
  "hunch_constitution_g2_behavior_replay.review_hash string required",
  "hunch_constitution_g2_behavior_replay.decision_id string",
  "hunch_constitution_g2_behavior_replay.since string",
  "hunch_constitution_g2_behavior_replay.max_commits integer",
  "hunch_constitution_g2_behavior_replay.limit integer",
  "hunch_constitution_g2_behavior_replay.timeout_ms integer",
  "hunch_constitution_g2_behavior_materialization.decision_id string",
  "hunch_constitution_g2_behavior_materialization.since string",
  "hunch_constitution_g2_behavior_materialization.max_commits integer",
  "hunch_constitution_g2_behavior_materialization.limit integer",
  "hunch_constitution_g2_behavior_policy_materialize.decision_id string",
  "hunch_constitution_g2_behavior_policy_materialize.since string",
  "hunch_constitution_g2_behavior_policy_materialize.max_commits integer",
  "hunch_constitution_g2_behavior_policy_materialize.limit integer",
  "hunch_constitution_g2_behavior_policy_materialize.allow_install_scripts array",
  "hunch_constitution_g2_behavior_policy_materialize.dependency_timeout_ms integer",
  "hunch_constitution_g2_behavior_policy_materialize.cwd string",
];

type ToolResult = { content?: unknown; isError?: boolean; structuredContent?: unknown };
type Args = Record<string, unknown>;
type Prop = { type?: string; enum?: string[]; anyOf?: unknown[]; items?: { enum?: string[] } };
type Schema = { properties?: Record<string, Prop>; required?: string[] };
type Ctx = {
  root: string; other: string; taskId: string; decisionId: string; constraintId: string; findingId: string; policyId: string;
  repo: { kind: string; id: string }; principal: Record<string, unknown>; receiptId: string;
};
type Maybe<T> = T | Promise<T>;
/** Optional-parameter effect: by default `without` omits the param from BASE (or BASE as-is when
 *  BASE lacks it) and `with` is BASE plus `v`. `none` = no observable effect here, with the reason. */
type Effect = { v?: (c: Ctx) => Maybe<unknown>; without?: (c: Ctx) => Maybe<Args>; with?: (c: Ctx) => Maybe<Args>; none?: string };

const text = (r: ToolResult): string =>
  ((r.content as { type: string; text?: string }[] | undefined) ?? []).filter((c) => c.type === "text").map((c) => c.text ?? "").join("\n");
const git = (cwd: string, ...args: string[]): string =>
  execFileSync("git", args, { cwd, encoding: "utf8", env: { ...process.env, GIT_CONFIG_NOSYSTEM: "1" }, stdio: ["ignore", "pipe", "pipe"] }).trim();
const sha = (c: string): string => `sha256:${c.repeat(64)}`;
let nonce = 0;
/** A per-call unique marker (normalized away before comparison) so writes never collide. */
const nz = (): string => `nz${++nonce}`;
const records = (root: string, kind: string): Record<string, unknown>[] => {
  const dir = join(root, ".hunch", kind);
  if (!existsSync(dir)) return [];
  return readdirSync(dir).filter((f) => f.endsWith(".json")).map((f) => JSON.parse(readFileSync(join(dir, f), "utf8")) as Record<string, unknown>);
};

const src = (n: string) => ({ ref: { system: "crm", object_type: "note", object_key: `params-${n}`, observed_at: "2026-09-10T12:00:00Z" }, source_text: `Use the west entrance ${n}. Call Dana on Thursday.` });
const relevance = { use: "operational_fact", reason: "Choose the correct entrance for visits." };
const receipt = (c: Ctx, n: string) => ({
  schema: "nuryel.receipt/1", scope: c.repo, actor: "params@test", action_kind: "add_comment",
  target: { system: "crm", object_type: "event", object_key: `k${n}`, version: "2", observed_at: "2026-09-07T12:00:00Z" },
  request_fingerprint: sha("c"), state: "verified", occurred_at: "2026-09-07T08:55:22Z",
  provenance: { source: "imported:params", confidence: 0.9, evidence: ["row a1"] },
});

/** A valid call per tool (from mcp-surface VALID), made re-callable: writes carry a fresh nonce. */
const BASE: Record<string, (c: Ctx) => Args> = {
  hunch_query: () => ({ query: "orders" }),
  hunch_task: () => ({ action: "start", title: `params task ${nz()}` }),
  hunch_report: (c) => ({ task_id: c.taskId }),
  hunch_runbook: () => ({ task: "add an orders endpoint" }),
  hunch_why: () => ({ target: "src/orders.ts" }),
  hunch_bug_lineage: () => ({ symptom_or_symbol: "orders" }),
  hunch_check_constraints: () => ({ scope: "src/orders.ts" }),
  hunch_get_dependents: () => ({ symbol: "listOrders" }),
  hunch_blast_radius: () => ({ target: "src/orders.ts" }),
  hunch_change_identity: () => ({ base_ref: "HEAD~2" }),
  hunch_change_proof: () => ({ base_ref: "HEAD~2" }),
  hunch_project_dna: () => ({}),
  hunch_project_match: () => ({ kind: "issue", title: "orders list is empty" }),
  hunch_project_dna_delta: () => ({ from_ref: "HEAD~2", to_ref: "HEAD" }),
  hunch_context: () => ({ target: "src/orders.ts" }),
  hunch_shortlist: () => ({ issue: "orders list is empty" }),
  hunch_evidence_map: () => ({ version: 1, claim: "listOrders returns nothing", probe: { target_before: "red", control_before: "green" } }),
  hunch_now: () => ({}),
  hunch_workspaces: () => ({}),
  hunch_escalations: () => ({}),
  hunch_review_imported_adr: (c) => ({ decision_id: c.decisionId, expected_source_hash: sha("a"), expected_review_hash: sha("b"), disposition: "approve" }),
  hunch_wiki_status: () => ({}),
  hunch_timeline: () => ({ target: "src/orders.ts" }),
  hunch_capture_decision: () => ({ topic: "orders.paging", seed: "page orders by cursor" }),
  hunch_current_decision: () => ({ topic: "orders.listing" }),
  hunch_record_decision: () => { const n = nz(); return { decision: { title: `Params decision ${n}`, decision: `Use cursor paging ${n}`, topic: `params.${n}` } }; },
  hunch_record_correction: () => ({ rule: `never return unbounded order lists ${nz()}`, scope_hint_file: "src/orders.ts" }),
  hunch_record_finding: () => { const n = nz(); return { finding: { title: `Params finding ${n}`, observation: `observed ${n}`, evidence: ["src/orders.ts:1"] } }; },
  nuryel_capabilities: () => ({}),
  nuryel_read: (c) => ({ principal: c.principal, scope: c.repo }),
  nuryel_write: (c) => { const n = nz(); return { principal: c.principal, scope: c.repo, facet: "receipts", idempotency_key: `params-${n}`, record: receipt(c, n) }; },
  nuryel_capture: (c) => { const n = nz(); return { principal: c.principal, scope: c.repo, subject: "customer:params", statement: `Use the west entrance ${n}.`, relevance, evidence: [{ ...src(n), excerpt: `Use the west entrance ${n}.` }] }; },
  nuryel_capture_batch: (c) => { const n = nz(); return { principal: c.principal, scope: c.repo, sources: [src(n)], observations: [{ subject: "customer:params", statement: `Call Dana on Thursday ${n}.`, relevance, evidence: [{ source: 0, excerpt: "Call Dana on Thursday." }] }] }; },
  nuryel_subscribe: (c) => ({ principal: c.principal, scope: c.repo, after_seq: 0 }),
  nuryel_records: (c) => ({ principal: c.principal, scope: c.repo, ids: [c.receiptId] }),
  hunch_findings: () => ({ all: true }),
  hunch_policy_upgrade_correction: (c) => ({ constraint_id: c.constraintId }),
  hunch_merge_verdict: () => ({ base: "HEAD~2" }),
  hunch_structure: () => ({}),
  hunch_pr_impact: () => ({ base: "HEAD~2" }),
  hunch_path: () => ({ from: "src/api.ts", to: "src/orders.ts" }),
  hunch_compare: () => ({ candidates: ["cursor paging", "offset paging"] }),
  hunch_policy_candidates: () => ({}),
  hunch_policy_plan: (c) => ({ policy_id: c.policyId }),
  hunch_policy_card: (c) => ({ policy_id: c.policyId }),
  hunch_policy_shadow: (c) => ({ policy_id: c.policyId }),
  hunch_policy_proof: (c) => ({ policy_id: c.policyId }),
  hunch_policy_evaluate: () => ({}),
  hunch_constitution_g2_readiness: () => ({}),
  hunch_constitution_g3_readiness: () => ({}),
  hunch_constitution_g2_shadow_queue: () => ({ limit: 5 }),
  hunch_constitution_g2_operational_drill: () => ({ category: "evaluator_error" }),
  hunch_constitution_g2_candidates: () => ({ max_commits: 5, limit: 5 }),
  hunch_conformance: () => ({}),
  hunch_constitution_g2_behavior_candidates: () => ({ max_commits: 5, limit: 5 }),
  hunch_constitution_g2_behavior_replay: () => ({ candidate_id: "g2behavior_0000000000", review_hash: `sha1:${"0".repeat(40)}`, max_commits: 5 }),
  hunch_constitution_g2_behavior_materialization: () => ({ max_commits: 5, limit: 5 }),
  hunch_constitution_g2_behavior_policy_materialize: () => ({ max_commits: 5, limit: 5 }),
};

const REFUSED_BASE = "base call is a domain refusal in this fixture (needs state it cannot seed), so the handler returns before reading this option";
const NO_OVERLAY = "the fixture has no private overlay, so the public-only view and the full view are the same records";
const PROOFLESS = "policy proof records live in the private overlay; the fixture has none, so the call refuses before the option is read";
const cwdEffect: Effect = { v: (c) => c.other };
let lastTask = "";
async function freshTask(): Promise<string> {
  const res = await call("hunch_task", { action: "start", title: `fresh ${nz()}` });
  const id = /htask_[a-f0-9]{24}/.exec(res instanceof Error ? "" : text(res))?.[0];
  assert.ok(id, "fresh task started");
  lastTask = id;
  return id;
}
async function captureToken(): Promise<string> {
  const res = await call("hunch_capture_decision", { topic: `params.capture.${nz()}` });
  const body = res instanceof Error ? "" : `${text(res)}\n${JSON.stringify(res.structuredContent ?? {})}`;
  const token = /"capture_token"\s*:\s*"([^"]+)"/.exec(body)?.[1] ?? /capture_token[^A-Za-z0-9]+([A-Za-z0-9_.:-]{12,})/.exec(body)?.[1];
  assert.ok(token, `capture token in: ${body.slice(0, 300)}`);
  return token;
}

/** Every optional parameter, keyed `tool.param`. */
const EFFECT: Record<string, Effect> = {
  "hunch_task.task_id": { without: () => ({ action: "finish" }), with: async () => ({ action: "finish", task_id: await freshTask() }) },
  "hunch_task.title": {},
  "hunch_task.outcome": { without: async () => ({ action: "finish", task_id: await freshTask() }), with: async () => ({ action: "finish", task_id: await freshTask(), outcome: "interrupted" }) },
  "hunch_task.applications": {
    without: async () => ({ action: "finish", task_id: await freshTask() }),
    with: async (c) => ({ action: "finish", task_id: await freshTask(), applications: [{ occurrence_id: `hocc_${"0".repeat(24)}`, record_id: c.decisionId, content_hash: sha("d"), action: "applied it" }] }),
  },
  "hunch_task.cwd": cwdEffect,
  "hunch_report.task_id": {},
  "hunch_report.lesson": { v: (c) => ({ kind: "decision", record_id: c.decisionId }) },
  "hunch_report.before": { none: "the fixture's decision has no lesson-history entries, so there is no older page for the cursor to select" },
  "hunch_report.html": { v: () => true },
  "hunch_report.cwd": cwdEffect,
  "hunch_why.as_of": { v: () => "2000-01-01T00:00:00Z" },
  "hunch_change_identity.head_ref": { v: () => "HEAD~1" },
  "hunch_change_identity.cwd": cwdEffect,
  "hunch_change_proof.result_ref": { v: () => "HEAD~1" },
  "hunch_change_proof.public_only": { v: () => true },
  "hunch_change_proof.cwd": cwdEffect,
  "hunch_project_dna.ref": { v: () => "HEAD~2" },
  "hunch_project_dna.cwd": cwdEffect,
  "hunch_project_match.body": { none: "the fixture repo yields no project-DNA checks, so the match is empty whatever the artifact text" },
  "hunch_project_match.ref": { none: "the fixture repo yields no project-DNA checks at either ref, so the match is empty" },
  "hunch_project_match.cwd": cwdEffect,
  "hunch_project_dna_delta.cwd": cwdEffect,
  "hunch_context.budget_tokens": { v: () => 40 },
  "hunch_context.profile": { v: () => "architect" },
  "hunch_context.as_of": { v: () => "2000-01-01T00:00:00Z" },
  "hunch_context.task_id": { v: (c) => c.taskId },
  "hunch_context.include": { none: "no finished task touched src/orders.ts and the repo yields no project-DNA signal, so both opt-in extras are empty" },
  "hunch_context.cwd": cwdEffect,
  "hunch_shortlist.limit": { v: () => 1 },
  "hunch_shortlist.evidence": { v: () => ({ version: 1, claim: "orders list is empty", probe: { target_before: "red", control_before: "green" } }) },
  "hunch_shortlist.cwd": cwdEffect,
  "hunch_evidence_map.execution": { v: () => [{ owner: "src/orders.ts", target_count: 1, control_count: 0 }] },
  "hunch_evidence_map.interventions": { v: () => [{ owner: "src/orders.ts", target_after: "green", control_after: "green" }] },
  "hunch_now.recent_limit": { v: () => 0 },
  "hunch_now.roadmap_limit": { none: "the fixture holds no proposed decisions, so the roadmap section is empty at any limit" },
  "hunch_workspaces.view": { v: () => "branches" },
  "hunch_workspaces.machine": { v: () => "no-such-machine" },
  "hunch_workspaces.branch": { without: () => ({ view: "branches" }), with: () => ({ view: "branches", branch: "no-such-branch" }) },
  "hunch_workspaces.merged_only": { without: () => ({ view: "branches" }), with: () => ({ view: "branches", merged_only: true }) },
  "hunch_review_imported_adr.reviewed_by": { none: REFUSED_BASE },
  "hunch_review_imported_adr.cwd": cwdEffect,
  "hunch_capture_decision.topic": {},
  "hunch_capture_decision.seed": {},
  "hunch_capture_decision.deciding": { v: () => true },
  "hunch_record_decision.capture_token": { v: () => captureToken() },
  "hunch_record_decision.task_id": { v: (c) => c.taskId },
  "hunch_record_decision.cwd": cwdEffect,
  "hunch_record_correction.scope_hint_file": {},
  "hunch_record_correction.severity": { v: () => "blocking" },
  "hunch_record_correction.applies_to_all": { v: () => true },
  "hunch_record_correction.type": { v: () => "security" },
  "hunch_record_correction.rationale": { v: () => "an unbounded list took the API down" },
  "hunch_record_correction.source_decision": { v: (c) => c.decisionId },
  "hunch_record_correction.private": { v: () => true },
  "hunch_record_correction.capture_token": { v: () => captureToken() },
  "hunch_record_correction.task_id": { v: (c) => c.taskId },
  "hunch_record_correction.cwd": cwdEffect,
  "hunch_record_finding.task_id": { v: (c) => c.taskId },
  "hunch_record_finding.cwd": cwdEffect,
  "nuryel_read.scopes": { v: (c) => [c.repo] },
  "nuryel_read.subject": { v: () => "customer:nobody" },
  "nuryel_read.task": { v: () => "plan a visit" },
  "nuryel_read.profile": { v: () => "architect" },
  "nuryel_read.budget_tokens": { v: () => 50 },
  "nuryel_read.facets": { without: (c) => ({ principal: c.principal, scope: c.repo, subject: "customer:params" }), with: (c) => ({ principal: c.principal, scope: c.repo, subject: "customer:params", facets: ["receipts"] }) },
  "nuryel_read.observed_page": { v: () => ({ cursor: { snapshot_hash: sha("e"), offset: 0 } }) },
  "nuryel_write.expected_version": { v: () => sha("e") },
  "nuryel_write.supersedes": { v: (c) => c.receiptId },
  "nuryel_write.cause": { none: "cause is stored on the ledger event (and gates derived current->stale); a receipt create echoes no cause in its answer" },
  "nuryel_write.cwd": cwdEffect,
  "nuryel_capture.visibility": { v: () => ({ owner: "params@test", readers: ["params@test"], writers: ["params@test"] }) },
  "nuryel_capture.cwd": cwdEffect,
  "nuryel_capture_batch.reviews": { v: () => [{ record_id: `nds_${"0".repeat(24)}`, expected_hash: sha("f"), reason: "re-reviewed", evidence: [{ source: 0, excerpt: "Call Dana on Thursday." }] }] },
  "nuryel_capture_batch.cwd": cwdEffect,
  "nuryel_subscribe.subjects": { v: () => ["customer:nobody"] },
  "nuryel_subscribe.facets": { v: () => ["decisions"] },
  "hunch_findings.scope": { v: () => "src/nothing-here.ts" },
  "hunch_findings.all": { none: "all also lists resolved/stale findings; the fixture has only open ones" },
  "hunch_findings.id": { v: (c) => c.findingId },
  "hunch_findings.limit": { v: () => 1 },
  "hunch_policy_upgrade_correction.public_only": { none: NO_OVERLAY },
  "hunch_policy_upgrade_correction.private_only": { v: () => true },
  "hunch_policy_upgrade_correction.include_artifacts": { v: () => true },
  "hunch_policy_upgrade_correction.cwd": cwdEffect,
  "hunch_merge_verdict.base": {},
  "hunch_merge_verdict.commit": { without: () => ({}), with: () => ({ commit: "HEAD~1" }) },
  "hunch_merge_verdict.working": { without: () => ({}), with: () => ({ working: true }) },
  "hunch_structure.target": { v: () => "src/orders.ts" },
  "hunch_pr_impact.base": {},
  "hunch_pr_impact.commit": { without: () => ({}), with: () => ({ commit: "HEAD~1" }) },
  "hunch_pr_impact.working": { without: () => ({}), with: () => ({ working: true }) },
  "hunch_path.max_depth": { v: () => 0 },
  "hunch_compare.base": { v: () => "HEAD~2" },
  "hunch_policy_candidates.public_only": { none: NO_OVERLAY },
  "hunch_policy_plan.public_only": { none: NO_OVERLAY },
  "hunch_policy_plan.cwd": cwdEffect,
  "hunch_policy_card.public_only": { none: PROOFLESS },
  "hunch_policy_shadow.public_only": { none: PROOFLESS },
  "hunch_policy_proof.public_only": { none: PROOFLESS },
  "hunch_policy_evaluate.policy_id": { none: "the fixture holds exactly one policy, so filtering to it returns the same evaluation" },
  "hunch_policy_evaluate.active_only": { none: "the fixture's single policy is active, so active-only selects the same set" },
  "hunch_policy_evaluate.public_only": { none: NO_OVERLAY },
  "hunch_policy_evaluate.workspace": { none: "the fixture's working tree and index are both clean, so staged and working evaluate the same tree" },
  "hunch_policy_evaluate.commit": { v: () => "HEAD~1" },
  "hunch_constitution_g2_shadow_queue.limit": {},
  "hunch_constitution_g2_candidates.since": { v: () => "2099-01-01" },
  "hunch_constitution_g2_candidates.max_commits": {},
  "hunch_constitution_g2_candidates.limit": {},
  "hunch_constitution_g2_behavior_candidates.decision_id": { v: (c) => c.decisionId },
  "hunch_constitution_g2_behavior_candidates.since": { v: () => "2099-01-01" },
  "hunch_constitution_g2_behavior_candidates.max_commits": {},
  "hunch_constitution_g2_behavior_candidates.limit": {},
  "hunch_constitution_g2_behavior_replay.decision_id": { none: REFUSED_BASE },
  "hunch_constitution_g2_behavior_replay.since": { none: REFUSED_BASE },
  "hunch_constitution_g2_behavior_replay.max_commits": { none: REFUSED_BASE },
  "hunch_constitution_g2_behavior_replay.limit": { none: REFUSED_BASE },
  "hunch_constitution_g2_behavior_replay.timeout_ms": { none: REFUSED_BASE },
  "hunch_constitution_g2_behavior_materialization.decision_id": { none: REFUSED_BASE },
  "hunch_constitution_g2_behavior_materialization.since": { none: REFUSED_BASE },
  "hunch_constitution_g2_behavior_materialization.max_commits": { none: REFUSED_BASE },
  "hunch_constitution_g2_behavior_materialization.limit": { none: REFUSED_BASE },
  "hunch_constitution_g2_behavior_policy_materialize.decision_id": { none: REFUSED_BASE },
  "hunch_constitution_g2_behavior_policy_materialize.since": { none: REFUSED_BASE },
  "hunch_constitution_g2_behavior_policy_materialize.max_commits": { none: REFUSED_BASE },
  "hunch_constitution_g2_behavior_policy_materialize.limit": { none: REFUSED_BASE },
  "hunch_constitution_g2_behavior_policy_materialize.allow_install_scripts": { none: REFUSED_BASE },
  "hunch_constitution_g2_behavior_policy_materialize.dependency_timeout_ms": { none: REFUSED_BASE },
  "hunch_constitution_g2_behavior_policy_materialize.cwd": { none: REFUSED_BASE },
};

/** Parameter cases that expose a real bug today: kept, reported, not hidden. */
const TODO: Record<string, string> = {};

/** Frozen: shrink only. The TODO keys when this ratchet landed; a new known-bug todo cannot be added. */
const TODO_BASELINE = new Set<string>([]);

test("the TODO map only shrinks: no key outside TODO_BASELINE", () => {
  const added = Object.keys(TODO).filter((k) => !TODO_BASELINE.has(k));
  assert.deepEqual(added, [], `new TODO key(s): ${added.join(", ")}. The TODO set is frozen; fix the case instead of parking it.`);
});

const spawnEnv = (tools: string): Record<string, string> => Object.fromEntries(Object.entries(isolatedCliEnv({
  HUNCH_MCP_TOOLS: tools, HUNCH_PRIVATE_DIR: "", GIT_CONFIG_NOSYSTEM: "1", HUNCH_NO_UPDATE_CHECK: "1",
})).filter((e): e is [string, string] => typeof e[1] === "string"));

async function connect(cwd: string, tools: string): Promise<Client> {
  const transport = new StdioClientTransport({ command: process.execPath, args: [TSX, CLI, "mcp"], cwd, env: spawnEnv(tools), stderr: "ignore" });
  const client = new Client({ name: "mcp-params-test", version: "1.0.0" });
  await client.connect(transport);
  return client;
}

let mcp: Client;
let tools: { name: string; inputSchema: Schema }[] = [];
const ctx = {} as Ctx;
const dirs: string[] = [];

async function call(name: string, args: Args, client: Client = mcp): Promise<ToolResult | Error> {
  try { return (await client.callTool({ name, arguments: args }, undefined, { timeout: 120_000 })) as ToolResult; }
  catch (error) { return error as Error; }
}
const ok = (r: ToolResult | Error): r is ToolResult => !(r instanceof Error) && !r.isError;
const VALIDATION = /invalid|validation|expected|required|-32602/i;
/** A schema refusal: either a thrown -32602 or an isError result whose text is a validation message. */
const isValidationRefusal = (r: ToolResult | Error): boolean =>
  r instanceof Error ? VALIDATION.test(r.message) : r.isError === true && /input validation error|invalid arguments|-32602/i.test(text(r));

function signature(tool: string, name: string, p: Prop, required: boolean): string {
  const type = p.type ?? (p.anyOf ? "anyOf" : "?");
  const values = p.enum ?? p.items?.enum;
  return `${tool}.${name} ${type}${values ? ` ${values.join("|")}` : ""}${required ? " required" : ""}`;
}
function wrongValue(p: Prop): unknown {
  if (p.type === "string") return 12345;
  if (p.type === "number" || p.type === "integer" || p.type === "boolean" || p.type === "array" || p.type === "object") return "not-the-right-type";
  return { nope: true };
}
/** Strip per-call noise (ids, hashes, nonces, clocks, durations) so two equivalent answers compare equal. */
const normalize = (s: string): string => s
  .replace(/nz\d+/g, "NZ")
  .replace(/\b[a-z][a-z0-9]{1,9}_[A-Za-z0-9]{6,}\b/g, "ID")
  .replace(/[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}/g, "UUID")
  .replace(/sha(1|256)?:[a-f0-9]{8,}/g, "HASH")
  .replace(/\b[a-f0-9]{7,64}\b/g, "HEX")
  .replace(/\bHEX(-[0-9a-f]{4})+-HEX\b/g, "UUID")
  .replace(/\d{4}-\d{2}-\d{2}T[\d:.]+(Z|[+-]\d{2}:\d{2})?/g, "TS")
  .replace(/\d+(\.\d+)?\s?(ms|s|seconds?|minutes?)\b/g, "DUR")
  .replace(/"(seq|version|head|after_seq|next_seq|elapsed\w*)"\s*:\s*\d+/g, '"$1":N');
/** What a call observably did: its answer plus any record it wrote that carries this call's nonce. */
function observe(r: ToolResult | Error, args: Args): string {
  const answer = r instanceof Error ? `ERROR ${r.message}` : `${r.isError ? "ISERROR " : ""}${text(r)}\n${JSON.stringify(r.structuredContent ?? null)}`;
  const marker = /nz\d+/.exec(JSON.stringify(args))?.[0];
  const written = marker
    ? ["decisions", "constraints", "findings"].flatMap((k) => records(ctx.root, k)).filter((x) => JSON.stringify(x).includes(marker))
      .map((x) => { const { created_at, updated_at, valid_from, recorded_at, ...rest } = x; void created_at; void updated_at; void valid_from; void recorded_at; return JSON.stringify(rest); })
    : [];
  // Which repository answered (raw, before normalization) and what landed in the cwd-target repo:
  // that is how a `cwd` routing difference stays visible after ids are normalized away.
  const repoId = /"repository_id"\s*:\s*"([^"]+)"/.exec(answer)?.[1] ?? "";
  const otherFiles = existsSync(join(ctx.other, ".hunch")) ? readdirSync(join(ctx.other, ".hunch"), { recursive: true }).length : 0;
  // Task reports live in the served cache, not .hunch: count them so a routed hunch_task shows.
  const otherTasks = existsSync(join(ctx.other, ".hunch-cache", "served.db")) ? listReportTasks(ctx.other).length : 0;
  return `${normalize(`${answer}\n${written.join("\n")}`)}\nREPO ${repoId}\nOTHER ${otherFiles}\nOTHER TASKS ${otherTasks}`;
}

before(async () => {
  const root = tempDir("hunch-mcp-params-");
  dirs.push(root);
  git(root, "init", "-q", "-b", "main");
  git(root, "config", "user.email", "params@test.invalid");
  git(root, "config", "user.name", "Params Test");
  git(root, "config", "commit.gpgsign", "false");
  mkdirSync(join(root, "src"), { recursive: true });
  writeFileSync(join(root, "src", "orders.ts"), "export const listOrders = () => [];\n");
  git(root, "add", "-A"); git(root, "commit", "-qm", "orders");
  writeFileSync(join(root, "src", "api.ts"), "import { listOrders } from \"./orders.js\";\nexport const handler = () => listOrders();\n");
  git(root, "add", "-A"); git(root, "commit", "-qm", "api");
  execFileSync(process.execPath, [TSX, CLI, "init", "--no-providers"], { cwd: root, env: spawnEnv("all"), stdio: "ignore", timeout: 120_000 });
  writeFileSync(join(root, ".hunch", "local.json"), JSON.stringify({ autoCommit: false }));
  const store = new HunchStore(hunchPaths(root));
  try {
    store.json.ensureDirs();
    store.json.put("bugs", {
      id: "bug_params01", title: "Orders list empty after deploy", symptom: "orders list is empty", root_cause: "missing tenant filter",
      severity: "medium", status: "open", affected_files: ["src/orders.ts"], affected_symbols: ["listOrders"],
      lineage: { introduced_commit: null, detected: null, fixed_commit: null, recurrence_of: null, spawned_decision: null, spawned_constraint: null },
      provenance: { source: "human_confirmed", confidence: 1, evidence: [] },
    } as never);
    store.reindex();
  } finally { store.close(); }
  const policyFile = readdirSync(join(PROJECT_ROOT, ".hunch", "policies")).filter((f) => f.endsWith(".json")).sort()[0]!;
  mkdirSync(join(root, ".hunch", "policies"), { recursive: true });
  copyFileSync(join(PROJECT_ROOT, ".hunch", "policies", policyFile), join(root, ".hunch", "policies", policyFile));
  ctx.policyId = policyFile.replace(/\.json$/, "");
  ctx.root = root;

  // A second repo, for `cwd`: routing a call there must change what it answers.
  ctx.other = tempDir("hunch-mcp-params-other-");
  dirs.push(ctx.other);
  git(ctx.other, "init", "-q", "-b", "main");
  git(ctx.other, "config", "user.email", "params@test.invalid");
  git(ctx.other, "config", "user.name", "Params Test");
  git(ctx.other, "config", "commit.gpgsign", "false");
  writeFileSync(join(ctx.other, "README.md"), "other\n");
  git(ctx.other, "add", "-A"); git(ctx.other, "commit", "-qm", "one");
  git(ctx.other, "commit", "-q", "--allow-empty", "-m", "two");
  git(ctx.other, "commit", "-q", "--allow-empty", "-m", "three");

  mcp = await connect(root, "all");
  const seeds: [string, Args][] = [
    ["hunch_record_decision", { decision: { title: "List orders newest first", decision: "listOrders sorts by created_at desc", topic: "orders.listing", related_files: ["src/orders.ts"] } }],
    ["hunch_record_correction", { rule: "orders must always be tenant-scoped", scope_hint_file: "src/orders.ts", severity: "blocking" }],
    ["hunch_record_finding", { finding: { title: "Seed finding", observation: "seeded observation", affected_files: ["src/orders.ts"] } }],
    ["hunch_record_finding", { finding: { title: "Second finding", observation: "second observation", affected_files: ["src/api.ts"] } }],
  ];
  for (const [name, args] of seeds) {
    const res = await call(name, args);
    assert.ok(ok(res), `${name} seed: ${res instanceof Error ? res.message : text(res)}`);
  }
  ctx.decisionId = String(records(root, "decisions").find((d) => d.topic === "orders.listing")?.id);
  ctx.constraintId = String(records(root, "constraints").find((c) => c.statement === "orders must always be tenant-scoped")?.id);
  ctx.findingId = String(records(root, "findings").find((f) => f.title === "Seed finding")?.id);
  git(root, "add", "-A"); git(root, "commit", "-qm", "seed memory");
  ctx.taskId = await freshTask();
  const caps = await call("nuryel_capabilities", {});
  assert.ok(ok(caps));
  ctx.repo = (caps.structuredContent as { repository: { kind: string; id: string } }).repository;
  ctx.principal = { id: "params@test", kind: "agent", grants: [ctx.repo] };
  const w = await call("nuryel_write", BASE.nuryel_write!(ctx));
  assert.ok(ok(w), `seed receipt: ${w instanceof Error ? w.message : text(w)}`);
  ctx.receiptId = String((w.structuredContent as { record_id?: string }).record_id);
  const cap = await call("nuryel_capture", BASE.nuryel_capture!(ctx));
  assert.ok(ok(cap), `seed observation: ${cap instanceof Error ? cap.message : text(cap)}`);
  tools = (await mcp.listTools()).tools as typeof tools;
});

after(async () => {
  await mcp?.close().catch(() => {});
  for (const d of dirs) cleanupDir(d);
});

const discovered = (): { tool: string; name: string; prop: Prop; required: boolean; sig: string }[] =>
  tools.flatMap((t) => Object.entries(t.inputSchema.properties ?? {}).map(([name, prop]) => {
    const required = (t.inputSchema.required ?? []).includes(name);
    return { tool: t.name, name, prop, required, sig: signature(t.name, name, prop, required) };
  }));

test("tools/list parameters equal the EXPECTED_PARAMS snapshot, and every optional one is classified", () => {
  assert.deepEqual(discovered().map((p) => p.sig).sort(), [...EXPECTED_PARAMS].sort(), "new/changed MCP parameter: update EXPECTED_PARAMS and classify it");
  assert.deepEqual(Object.keys(BASE).sort(), tools.map((t) => t.name).sort(), "every tool has a BASE call");
  const optional = discovered().filter((p) => !p.required).map((p) => `${p.tool}.${p.name}`).sort();
  assert.deepEqual(Object.keys(EFFECT).sort(), optional, "every optional parameter has an EFFECT entry");
});

test("a wrong-type value for every parameter is refused cleanly and the server stays alive", async (t) => {
  for (const p of discovered()) {
    await t.test(`${p.tool}.${p.name}`, { todo: TODO[`${p.tool}.${p.name}:type`] }, async () => {
      const args = { ...BASE[p.tool]!(ctx), [p.name]: wrongValue(p.prop) };
      const res = await call(p.tool, args);
      assert.ok(isValidationRefusal(res), `not a validation refusal: ${res instanceof Error ? res.message : text(res).slice(0, 300)}`);
    });
  }
  assert.ok(ok(await call("hunch_escalations", {})), "server alive after every wrong-type call");
});

test("an omitted required parameter is refused cleanly", async (t) => {
  for (const p of discovered().filter((x) => x.required)) {
    await t.test(`${p.tool}.${p.name}`, { todo: TODO[`${p.tool}.${p.name}:required`] }, async () => {
      const args = BASE[p.tool]!(ctx);
      delete args[p.name];
      const res = await call(p.tool, args);
      assert.ok(isValidationRefusal(res), `not a validation refusal: ${res instanceof Error ? res.message : text(res).slice(0, 300)}`);
    });
  }
  assert.ok(ok(await call("hunch_escalations", {})), "server alive");
});

test("every enum value is accepted by the protocol (a domain refusal is fine, a schema refusal is not)", async (t) => {
  for (const p of discovered()) {
    const values = p.prop.enum ?? p.prop.items?.enum;
    if (!values) continue;
    for (const value of values) {
      await t.test(`${p.tool}.${p.name}=${value}`, { todo: TODO[`${p.tool}.${p.name}=${value}`] }, async () => {
        const args = { ...BASE[p.tool]!(ctx), [p.name]: p.prop.items?.enum ? [value] : value };
        const res = await call(p.tool, args);
        assert.ok(!(res instanceof Error), `protocol error: ${res instanceof Error ? res.message : ""}`);
        assert.ok(!isValidationRefusal(res), `schema refused an allowed value: ${text(res).slice(0, 300)}`);
        assert.ok(text(res).trim().length > 0, "non-empty answer");
      });
    }
  }
});

/** Frozen: shrink only. Parameters classified `none` when this ratchet landed. */
const NONE_BASELINE = new Set([
  "hunch_report.before", "hunch_project_match.body", "hunch_project_match.ref", "hunch_context.include",
  "hunch_now.roadmap_limit", "hunch_review_imported_adr.reviewed_by",
  "nuryel_write.cause", "hunch_findings.all", "hunch_policy_upgrade_correction.public_only",
  "hunch_policy_candidates.public_only", "hunch_policy_plan.public_only", "hunch_policy_card.public_only",
  "hunch_policy_shadow.public_only", "hunch_policy_proof.public_only", "hunch_policy_evaluate.policy_id",
  "hunch_policy_evaluate.active_only", "hunch_policy_evaluate.public_only", "hunch_policy_evaluate.workspace",
  ...["decision_id", "since", "max_commits", "limit", "timeout_ms"].map((p) => `hunch_constitution_g2_behavior_replay.${p}`),
  ...["decision_id", "since", "max_commits", "limit"].map((p) => `hunch_constitution_g2_behavior_materialization.${p}`),
  ...["decision_id", "since", "max_commits", "limit", "allow_install_scripts", "dependency_timeout_ms", "cwd"].map((p) => `hunch_constitution_g2_behavior_policy_materialize.${p}`),
]);

test("every optional parameter observably changes the result (or is a reasoned no-effect)", async (t) => {
  const none: string[] = [];
  for (const p of discovered().filter((x) => !x.required)) {
    const key = `${p.tool}.${p.name}`;
    const e = EFFECT[key]!;
    if (e.none) { none.push(`${key}: ${e.none}`); continue; }
    await t.test(key, { todo: TODO[key] }, async () => {
      const base = (): Args => BASE[p.tool]!(ctx);
      const without = async (): Promise<Args> => e.without ? e.without(ctx) : (() => { const a = base(); delete a[p.name]; return a; })();
      const withArgs = async (): Promise<Args> => e.with ? e.with(ctx) : p.name in base() && !e.v ? base() : { ...base(), [p.name]: await e.v!(ctx) };
      // Observe right after each call: a side effect (a record in the cwd-target repo) must not
      // leak into the observation of a call that ran before it.
      const a1 = await without(); const r1 = await call(p.tool, a1); const o1 = observe(r1, a1);
      const a2 = await without(); const r2 = await call(p.tool, a2); const o2 = observe(r2, a2);
      const aw = await withArgs(); const rw = await call(p.tool, aw); const ow = observe(rw, aw);
      if ("cwd" in aw) assert.ok(ok(await call("hunch_context", { target: "src/orders.ts", cwd: ctx.root })), "re-home the server to the fixture root");
      assert.ok(!(rw instanceof Error), `protocol error with ${key}: ${rw instanceof Error ? rw.message : ""}`);
      assert.equal(o1, o2, `baseline without ${key} is not deterministic after normalization; give it a custom check`);
      assert.notEqual(ow, o1, `${key} made no observable difference:\n${ow.slice(0, 500)}`);
    });
  }
  const noneKeys = none.map((n) => n.slice(0, n.indexOf(": ")));
  const added = noneKeys.filter((k) => !NONE_BASELINE.has(k));
  assert.deepEqual(added, [], `new parameter(s) classified \`none\` (no observable effect): ${added.join(", ")}. The no-effect set is frozen; give the param a real EFFECT check instead of a reason.`);
  t.diagnostic(`NO-EFFECT (review candidates, ${none.length}):\n${none.join("\n")}`);
  void lastTask;
});

test("hidden tool groups: the default toolset hides specialist tools; config mcp_tools exposes exactly its groups", async () => {
  const all = tools.map((t) => t.name);
  const specialist = new Set<string>(Object.values(MCP_TOOL_GROUPS).flat());
  const core = all.filter((n) => !specialist.has(n));
  const bare = tempDir("hunch-mcp-params-bare-");
  dirs.push(bare);
  git(bare, "init", "-q", "-b", "main");
  const listed = async (spec: string | null): Promise<{ names: string[]; client: Client }> => {
    mkdirSync(join(bare, ".hunch"), { recursive: true });
    writeFileSync(join(bare, ".hunch", "config.json"), JSON.stringify(spec === null ? {} : { mcp_tools: spec }));
    const client = await connect(bare, "");
    return { names: (await client.listTools()).tools.map((t) => t.name).sort(), client };
  };
  const def = await listed(null);
  try {
    assert.deepEqual(def.names, [...core].sort(), "default toolset = core only (no state records, no policies)");
    const hidden = await call("hunch_project_dna", {}, def.client);
    assert.ok(hidden instanceof Error || hidden.isError === true, "a hidden tool is not callable");
    assert.ok(ok(await call("hunch_now", {}, def.client)), "a core tool is callable");
  } finally { await def.client.close(); }
  const cfg = await listed("core,analysis");
  try {
    assert.deepEqual(cfg.names, [...core, ...MCP_TOOL_GROUPS.analysis].sort(), "config mcp_tools=core,analysis exposes core + analysis only");
    assert.ok(ok(await call("hunch_wiki_status", {}, cfg.client)), "an analysis tool is callable once configured");
    const stillHidden = await call("nuryel_capabilities", {}, cfg.client);
    assert.ok(stillHidden instanceof Error || stillHidden.isError === true, "a group the config leaves out stays uncallable");
  } finally { await cfg.client.close(); }
});
