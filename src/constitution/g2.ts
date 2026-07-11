import { existsSync, mkdirSync, readFileSync, readdirSync } from "node:fs";
import { join } from "node:path";
import { z } from "zod";
import type { Runbook } from "../core/types.js";
import { writeFileAtomic } from "../core/io.js";
import { shortHash } from "../core/ids.js";
import type { HunchStore } from "../store/hunchStore.js";
import { canonicalHash } from "./canonical.js";

const HASH = /^sha1:[a-f0-9]{40}$/;
const HUMAN_ACTOR = /^(human|github|git):[^\s]+$/i;
const encode = (value: unknown): string => `${JSON.stringify(value, null, 2)}\n`;

export const G2_RUNBOOK_CATEGORIES = [
  "evaluator_error",
  "false_positive",
  "private_leak",
  "stale_policy",
  "provider_outage",
  "corrupt_graph",
  "adapter_break",
] as const;
export type G2RunbookCategory = (typeof G2_RUNBOOK_CATEGORIES)[number];

const G2RunbookSelectionSchema = z.object(Object.fromEntries(
  G2_RUNBOOK_CATEGORIES.map((category) => [category, z.string().regex(/^rb_[A-Za-z0-9_-]+$/)]),
) as Record<G2RunbookCategory, z.ZodString>).strict();

export const G2PlanSchema = z.object({
  id: z.string().regex(/^g2plan_[a-f0-9]{10}$/),
  content_hash: z.string().regex(HASH),
  gate: z.literal("G2"),
  policy_ids: z.array(z.string().regex(/^pol_[a-f0-9]{10}$/)).min(10, "G2 requires at least 10 selected policies"),
  runbooks: G2RunbookSelectionSchema,
  min_shadow_applicable: z.number().int().min(1).max(10000),
  actor: z.string().regex(HUMAN_ACTOR, "G2 plan requires an explicit human actor (human:, github:, or git:)"),
  reason: z.string().trim().min(1).max(2000),
  supersedes: z.string().regex(/^g2plan_[a-f0-9]{10}$/).nullable(),
  data_class: z.literal("private"),
  authority: z.literal("none"),
  created_at: z.string().datetime({ offset: true }),
}).strict().superRefine((plan, ctx) => {
  if (new Set(plan.policy_ids).size !== plan.policy_ids.length) {
    ctx.addIssue({ code: "custom", path: ["policy_ids"], message: "G2 policy ids must be unique" });
  }
  const runbookIds = Object.values(plan.runbooks);
  if (new Set(runbookIds).size !== runbookIds.length) {
    ctx.addIssue({ code: "custom", path: ["runbooks"], message: "G2 requires a unique runbook for every operational category" });
  }
});
export type G2Plan = z.infer<typeof G2PlanSchema>;

export interface CompileG2PlanInput {
  policy_ids: string[];
  runbooks: Record<G2RunbookCategory, string>;
  min_shadow_applicable?: number;
  actor: string;
  reason: string;
  supersedes?: string | null;
}

export function g2PlanContentHash(plan: G2Plan): string {
  const { id: _id, content_hash: _contentHash, ...body } = plan;
  return canonicalHash(body);
}

export function compileG2Plan(input: CompileG2PlanInput, opts: { now?: string } = {}): G2Plan {
  const body = {
    gate: "G2" as const,
    policy_ids: [...input.policy_ids].sort(),
    runbooks: Object.fromEntries(G2_RUNBOOK_CATEGORIES.map((category) => [category, input.runbooks[category]])),
    min_shadow_applicable: input.min_shadow_applicable ?? 20,
    actor: input.actor,
    reason: input.reason.trim(),
    supersedes: input.supersedes ?? null,
    data_class: "private" as const,
    authority: "none" as const,
    created_at: opts.now ?? new Date().toISOString(),
  };
  const contentHash = canonicalHash(body);
  return G2PlanSchema.parse({ id: `g2plan_${shortHash(contentHash)}`, content_hash: contentHash, ...body });
}

export const RunbookRehearsalSchema = z.object({
  id: z.string().regex(/^rehearsal_[a-f0-9]{10}$/),
  content_hash: z.string().regex(HASH),
  runbook_id: z.string().regex(/^rb_[A-Za-z0-9_-]+$/),
  runbook_hash: z.string().regex(HASH),
  result: z.enum(["passed", "failed"]),
  actor: z.string().regex(HUMAN_ACTOR, "runbook rehearsal requires an explicit human actor (human:, github:, or git:)"),
  evidence_hashes: z.array(z.string().regex(HASH)).min(1),
  notes: z.string().trim().min(1).max(4000),
  supersedes: z.string().regex(/^rehearsal_[a-f0-9]{10}$/).nullable(),
  data_class: z.literal("private"),
  authority: z.literal("none"),
  created_at: z.string().datetime({ offset: true }),
}).strict().superRefine((receipt, ctx) => {
  if (new Set(receipt.evidence_hashes).size !== receipt.evidence_hashes.length) {
    ctx.addIssue({ code: "custom", path: ["evidence_hashes"], message: "rehearsal evidence hashes must be unique" });
  }
});
export type RunbookRehearsal = z.infer<typeof RunbookRehearsalSchema>;

export interface CompileRunbookRehearsalInput {
  runbook_id: string;
  runbook_hash: string;
  result: "passed" | "failed";
  actor: string;
  evidence_hashes: string[];
  notes: string;
  supersedes?: string | null;
}

export function runbookRehearsalContentHash(receipt: RunbookRehearsal): string {
  const { id: _id, content_hash: _contentHash, ...body } = receipt;
  return canonicalHash(body);
}

export function compileRunbookRehearsal(input: CompileRunbookRehearsalInput, opts: { now?: string } = {}): RunbookRehearsal {
  const body = {
    runbook_id: input.runbook_id,
    runbook_hash: input.runbook_hash,
    result: input.result,
    actor: input.actor,
    evidence_hashes: [...new Set(input.evidence_hashes)].sort(),
    notes: input.notes.trim(),
    supersedes: input.supersedes ?? null,
    data_class: "private" as const,
    authority: "none" as const,
    created_at: opts.now ?? new Date().toISOString(),
  };
  const contentHash = canonicalHash(body);
  return RunbookRehearsalSchema.parse({ id: `rehearsal_${shortHash(contentHash)}`, content_hash: contentHash, ...body });
}

export function currentAppendOnly<T extends { id: string; supersedes: string | null }>(
  records: T[],
  label: string,
  identity: (record: T) => string,
  singleCurrent = false,
): T[] {
  const byId = new Map(records.map((record) => [record.id, record]));
  if (byId.size !== records.length) throw new Error(`duplicate ${label} id`);
  const childCount = new Map<string, number>();
  for (const record of records) {
    if (!record.supersedes) continue;
    const parent = byId.get(record.supersedes);
    if (!parent) throw new Error(`${label} ${record.id} supersedes missing ${record.supersedes}`);
    if (identity(parent) !== identity(record)) throw new Error(`${label} ${record.id} supersedes a different evidence target`);
    childCount.set(parent.id, (childCount.get(parent.id) ?? 0) + 1);
    if (childCount.get(parent.id)! > 1) throw new Error(`${label} ${parent.id} has a branched supersession chain`);
  }
  for (const record of records) {
    const visited = new Set<string>();
    let cursor: T | undefined = record;
    while (cursor?.supersedes) {
      if (visited.has(cursor.id)) throw new Error(`${label} chain contains a cycle at ${cursor.id}`);
      visited.add(cursor.id);
      cursor = byId.get(cursor.supersedes);
    }
  }
  const current = records.filter((record) => !childCount.has(record.id)).sort((a, b) => a.id.localeCompare(b.id));
  const identities = new Set<string>();
  for (const record of current) {
    const key = identity(record);
    if (identities.has(key)) throw new Error(`${label} target ${key} has multiple current records`);
    identities.add(key);
  }
  if (singleCurrent && current.length > 1) throw new Error(`${label} has multiple current records`);
  return current;
}

export function currentG2Plans(records: G2Plan[]): G2Plan[] {
  const parsed = records.map((record) => G2PlanSchema.parse(record));
  return currentAppendOnly(parsed, "G2 plan", () => "G2", true);
}

export function currentRunbookRehearsals(records: RunbookRehearsal[]): RunbookRehearsal[] {
  const parsed = records.map((record) => RunbookRehearsalSchema.parse(record));
  return currentAppendOnly(parsed, "runbook rehearsal", (record) => `${record.runbook_id}:${record.runbook_hash}`);
}

export interface G2PolicyEvidence {
  policy_id: string;
  complete: boolean;
  proof_id: string | null;
  corpus_id: string | null;
  shadow_applicable: number;
  shadow_violations: number;
  shadow_unclassified: number;
  confirmed_precision: number | null;
  reasons: string[];
}

export interface G2RunbookEvidence {
  category: G2RunbookCategory;
  runbook_id: string;
  runbook_hash: string | null;
  rehearsal_id: string | null;
  passed: boolean;
  reasons: string[];
}

export interface G2Inventory {
  private_policies: number;
  public_policies: number;
  private_proofs: number;
  private_corpora: number;
  private_shadow_evaluations: number;
  private_shadow_dispositions: number;
  private_runbooks: number;
  public_runbooks: number;
  private_plans: number;
  private_rehearsals: number;
}

export interface G2ReadinessReport {
  id: string;
  content_hash: string;
  gate: "G2";
  manifest: G2Plan | null;
  policy_evidence: G2PolicyEvidence[];
  runbook_evidence: G2RunbookEvidence[];
  active_blocking_policy_ids: string[];
  blockers: string[];
  inventory?: G2Inventory;
  recommendation: "not_ready" | "eligible_for_human_g2_signoff";
  authority: "none";
  g2_passed: false;
}

export interface G2ShadowSweepReport {
  id: string;
  content_hash: string;
  plan_id: string | null;
  selected: number;
  recorded: string[];
  existing: string[];
  failures: Array<{ policy_id: string; error: string }>;
  skipped_reason: string | null;
  authority: "none";
  effects: "shadow_only";
}

export interface G2ShadowBackfillReport {
  id: string;
  content_hash: string;
  plan_id: string | null;
  max_commits: number;
  commits: string[];
  selected: number;
  attempted: number;
  recorded: string[];
  existing: string[];
  ineligible: Array<{ policy_id: string; commit: string; reason: string }>;
  preflight_failures: Array<{ policy_id: string; commit: string; error: string }>;
  skipped_reason: string | null;
  authority: "none";
  effects: "shadow_only";
  writes: "atomic_after_preflight" | "none";
}

export interface G2ShadowQueueItem {
  policy_id: string;
  shadow_id: string;
  proof_id: string;
  policy_hash: string;
  evaluation_hash: string;
  observed_at: string;
  result: "violated";
  explanation: string;
  matches: Array<{
    file: string;
    line?: number;
    symbol?: string;
    relation_path?: string[];
  }>;
}

export interface G2ShadowQueue {
  id: string;
  content_hash: string;
  plan_id: string | null;
  total_unclassified: number;
  unresolved_unknown_error: number;
  limit: number;
  items: G2ShadowQueueItem[];
  has_more: boolean;
  authority: "none";
}

export interface ScoreG2ReadinessInput {
  manifest: G2Plan | null;
  policy_evidence: G2PolicyEvidence[];
  runbook_evidence: G2RunbookEvidence[];
  active_blocking_policy_ids: string[];
  inventory?: G2Inventory;
}

export function scoreG2Readiness(input: ScoreG2ReadinessInput): G2ReadinessReport {
  const blockers: string[] = [];
  if (!input.manifest) {
    blockers.push("No current private G2 evidence plan exists; a human must select the exact dogfood policies and operational runbooks.");
    if (input.inventory) {
      if (input.inventory.private_policies < 10) blockers.push(`Private dogfood policy inventory is ${input.inventory.private_policies}/10 minimum.`);
      if (input.inventory.private_proofs < 10) blockers.push(`Private proof inventory is ${input.inventory.private_proofs}/10 minimum; every selected policy needs an exact current P3+ proof.`);
      if (input.inventory.private_corpora < 10) blockers.push(`Private imported-corpus inventory is ${input.inventory.private_corpora}/10 minimum; every selected policy needs known-bad and known-good fixtures.`);
      if (input.inventory.private_shadow_evaluations < 200) blockers.push(`Private shadow inventory is ${input.inventory.private_shadow_evaluations}/200 baseline observations (default 20 across 10 policies); the human plan may set a stricter bound.`);
      if (input.inventory.private_runbooks < G2_RUNBOOK_CATEGORIES.length) blockers.push(`Private operational runbook inventory is ${input.inventory.private_runbooks}/${G2_RUNBOOK_CATEGORIES.length} minimum unique category mappings.`);
      if (input.inventory.private_rehearsals < G2_RUNBOOK_CATEGORIES.length) blockers.push(`Private runbook rehearsal inventory is ${input.inventory.private_rehearsals}/${G2_RUNBOOK_CATEGORIES.length} minimum exact-content receipts.`);
    }
  }
  if (input.manifest && input.policy_evidence.length !== input.manifest.policy_ids.length) {
    blockers.push(`Selected policy evidence is incomplete (${input.policy_evidence.length}/${input.manifest.policy_ids.length}).`);
  }
  for (const evidence of input.policy_evidence) {
    for (const reason of evidence.reasons) blockers.push(`${evidence.policy_id}: ${reason}`);
  }
  if (input.manifest && input.runbook_evidence.length !== G2_RUNBOOK_CATEGORIES.length) {
    blockers.push(`Operational runbook evidence is incomplete (${input.runbook_evidence.length}/${G2_RUNBOOK_CATEGORIES.length}).`);
  }
  for (const evidence of input.runbook_evidence) {
    for (const reason of evidence.reasons) blockers.push(`${evidence.category}/${evidence.runbook_id}: ${reason}`);
  }
  const activeBlocking = [...new Set(input.active_blocking_policy_ids)].sort();
  if (activeBlocking.length) blockers.push(`Blocking behavior must remain disabled for G2; active blocking policies: ${activeBlocking.join(", ")}.`);
  const uniqueBlockers = [...new Set(blockers)];
  const body = {
    gate: "G2" as const,
    manifest: input.manifest,
    policy_evidence: [...input.policy_evidence].sort((a, b) => a.policy_id.localeCompare(b.policy_id)),
    runbook_evidence: [...input.runbook_evidence].sort((a, b) => a.category.localeCompare(b.category)),
    active_blocking_policy_ids: activeBlocking,
    blockers: uniqueBlockers,
    ...(input.inventory ? { inventory: input.inventory } : {}),
    recommendation: uniqueBlockers.length ? "not_ready" as const : "eligible_for_human_g2_signoff" as const,
    authority: "none" as const,
    g2_passed: false as const,
  };
  const contentHash = canonicalHash(body);
  return { id: `g2readiness_${shortHash(contentHash)}`, content_hash: contentHash, ...body };
}

export function loadPrivateRecords<T>(dir: string | undefined, prefix: string, parse: (value: unknown) => T, label: string): T[] {
  if (!dir || !existsSync(dir)) return [];
  const records: T[] = [];
  for (const name of readdirSync(dir).filter((entry) => entry.startsWith(prefix) && entry.endsWith(".json")).sort()) {
    try {
      records.push(parse(JSON.parse(readFileSync(join(dir, name), "utf8"))));
    } catch (error) {
      throw new Error(`invalid ${label}/${name}: ${(error as Error).message}`);
    }
  }
  return records;
}

/** Private-only append-only storage for the human-selected G2 packet and runbook drills. */
export class G2EvidenceRepository {
  constructor(private readonly store: HunchStore) {}

  listPlans(): G2Plan[] {
    const records = loadPrivateRecords(this.store.privateDir ? join(this.store.privateDir, "gates") : undefined, "g2plan_", (raw) => {
      const parsed = G2PlanSchema.parse(raw);
      if (parsed.content_hash !== g2PlanContentHash(parsed) || parsed.id !== `g2plan_${shortHash(parsed.content_hash)}`) {
        throw new Error(`G2 plan ${parsed.id} content hash mismatch`);
      }
      return parsed;
    }, "gates");
    currentG2Plans(records);
    return records.sort((a, b) => a.id.localeCompare(b.id));
  }

  currentPlan(): G2Plan | null {
    return currentG2Plans(this.listPlans())[0] ?? null;
  }

  putPlan(plan: G2Plan): G2Plan {
    if (!this.store.privateDir) throw new Error("No private Hunch overlay is configured; refusing to write G2 evidence.");
    const parsed = G2PlanSchema.parse(plan);
    if (parsed.content_hash !== g2PlanContentHash(parsed) || parsed.id !== `g2plan_${shortHash(parsed.content_hash)}`) throw new Error(`G2 plan ${parsed.id} content hash mismatch`);
    const records = this.listPlans();
    const existing = records.find((record) => record.id === parsed.id);
    if (existing) return existing;
    const current = currentG2Plans(records)[0];
    if (current && parsed.supersedes !== current.id) throw new Error(`G2 plan ${current.id} is current; pass supersedes:${current.id} to append a correction`);
    if (!current && parsed.supersedes) throw new Error(`G2 plan ${parsed.id} supersedes no current plan`);
    currentG2Plans([...records, parsed]);
    const dir = join(this.store.privateDir, "gates");
    mkdirSync(dir, { recursive: true });
    writeFileAtomic(join(dir, `${parsed.id}.json`), encode(parsed));
    return parsed;
  }

  listRehearsals(): RunbookRehearsal[] {
    const records = loadPrivateRecords(this.store.privateDir ? join(this.store.privateDir, "rehearsals") : undefined, "rehearsal_", (raw) => {
      const parsed = RunbookRehearsalSchema.parse(raw);
      if (parsed.content_hash !== runbookRehearsalContentHash(parsed) || parsed.id !== `rehearsal_${shortHash(parsed.content_hash)}`) {
        throw new Error(`runbook rehearsal ${parsed.id} content hash mismatch`);
      }
      return parsed;
    }, "rehearsals");
    currentRunbookRehearsals(records);
    return records.sort((a, b) => a.id.localeCompare(b.id));
  }

  putRehearsal(receipt: RunbookRehearsal): RunbookRehearsal {
    if (!this.store.privateDir) throw new Error("No private Hunch overlay is configured; refusing to write runbook rehearsal evidence.");
    const parsed = RunbookRehearsalSchema.parse(receipt);
    if (parsed.content_hash !== runbookRehearsalContentHash(parsed) || parsed.id !== `rehearsal_${shortHash(parsed.content_hash)}`) throw new Error(`runbook rehearsal ${parsed.id} content hash mismatch`);
    const records = this.listRehearsals();
    const existing = records.find((record) => record.id === parsed.id);
    if (existing) return existing;
    const sameTarget = currentRunbookRehearsals(records).find((record) => record.runbook_id === parsed.runbook_id && record.runbook_hash === parsed.runbook_hash);
    if (sameTarget && parsed.supersedes !== sameTarget.id) {
      throw new Error(`runbook ${parsed.runbook_id} rehearsal ${sameTarget.id} is current for this exact content; pass supersedes:${sameTarget.id} to append a correction`);
    }
    if (!sameTarget && parsed.supersedes) throw new Error(`runbook rehearsal ${parsed.id} supersedes no current exact-content rehearsal`);
    currentRunbookRehearsals([...records, parsed]);
    const dir = join(this.store.privateDir, "rehearsals");
    mkdirSync(dir, { recursive: true });
    writeFileAtomic(join(dir, `${parsed.id}.json`), encode(parsed));
    return parsed;
  }
}

export function runbookContentHash(runbook: Runbook): string {
  return canonicalHash(runbook);
}
