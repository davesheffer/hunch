import { shortHash } from "../core/ids.js";
import { canonicalHash } from "./canonical.js";
import { policyProofHash } from "./composition.js";
import {
  HistoryDispositionClassificationSchema,
  HistoryDispositionSchema,
  type HistoryDisposition,
  type HistoryDispositionClassification,
  type PolicyProof,
  type PolicySpec,
  type ReplayReceipt,
} from "./schema.js";

export function historyDispositionContentHash(disposition: HistoryDisposition): string {
  const { id: _id, content_hash: _contentHash, ...body } = disposition;
  return canonicalHash(body);
}

export function historyDispositionJudgmentHash(disposition: HistoryDisposition): string {
  const { id: _id, content_hash: _contentHash, created_at: _createdAt, ...judgment } = disposition;
  return canonicalHash(judgment);
}

export function compileHistoryDisposition(
  policy: PolicySpec,
  proof: PolicyProof,
  receipt: ReplayReceipt,
  classification: HistoryDispositionClassification,
  actor: string,
  reason: string,
  opts: { now?: string; supersedes?: string | null; composition?: PolicySpec[] } = {},
): HistoryDisposition {
  const parsedClassification = HistoryDispositionClassificationSchema.parse(classification);
  const policyHash = policyProofHash(policy, opts.composition ?? []);
  if (policy.proof !== proof.id) throw new Error(`policy ${policy.id} does not link proof ${proof.id}`);
  if (proof.policy_hash !== policyHash) throw new Error(`proof ${proof.id} does not match current policy semantics`);
  if (proof.data_class !== policy.data_class) throw new Error(`proof ${proof.id} does not match policy ${policy.id} data class`);
  if (receipt.leg !== "accepted_history" || receipt.result !== "violated") {
    throw new Error("history dispositions apply only to violated accepted-history replay receipts");
  }
  if (receipt.policy_hash !== proof.policy_hash) throw new Error(`receipt ${receipt.deterministic_hash} does not match proof policy semantics`);
  if (!proof.replay_receipts.some((candidate) => candidate.leg === receipt.leg && candidate.commit === receipt.commit && candidate.result === receipt.result && candidate.deterministic_hash === receipt.deterministic_hash)) {
    throw new Error(`receipt ${receipt.deterministic_hash} is not embedded in proof ${proof.id}`);
  }
  const createdAt = opts.now ?? new Date().toISOString();
  const body = {
    policy_id: policy.id,
    proof_id: proof.id,
    policy_hash: proof.policy_hash,
    plan_hash: proof.plan_hash,
    commit: receipt.commit,
    receipt_hash: receipt.deterministic_hash,
    classification: parsedClassification,
    actor,
    reason: reason.trim(),
    supersedes: opts.supersedes ?? null,
    data_class: policy.data_class,
    created_at: createdAt,
  };
  const contentHash = canonicalHash(body);
  return HistoryDispositionSchema.parse({
    id: `disp_${shortHash(contentHash)}`,
    content_hash: contentHash,
    ...body,
  });
}

/** Resolve the append-only supersession chain without trusting timestamps.
 * Missing parents, cross-hit links, branches, and cycles fail visibly. */
export function currentHistoryDispositions(records: HistoryDisposition[]): HistoryDisposition[] {
  const byId = new Map(records.map((record) => [record.id, record]));
  if (byId.size !== records.length) throw new Error("duplicate history disposition id");
  const childCount = new Map<string, number>();
  for (const record of records) {
    if (!record.supersedes) continue;
    const parent = byId.get(record.supersedes);
    if (!parent) throw new Error(`history disposition ${record.id} supersedes missing ${record.supersedes}`);
    if (parent.policy_id !== record.policy_id || parent.proof_id !== record.proof_id || parent.commit !== record.commit) {
      throw new Error(`history disposition ${record.id} supersedes a different policy/proof/commit hit`);
    }
    childCount.set(parent.id, (childCount.get(parent.id) ?? 0) + 1);
    if (childCount.get(parent.id)! > 1) throw new Error(`history disposition ${parent.id} has a branched supersession chain`);
  }
  for (const record of records) {
    const visited = new Set<string>();
    let cursor: HistoryDisposition | undefined = record;
    while (cursor?.supersedes) {
      if (visited.has(cursor.id)) throw new Error(`history disposition chain contains a cycle at ${cursor.id}`);
      visited.add(cursor.id);
      cursor = byId.get(cursor.supersedes);
    }
  }
  const current = records
    .filter((record) => !childCount.has(record.id))
    .sort((left, right) => left.policy_id.localeCompare(right.policy_id) || left.proof_id.localeCompare(right.proof_id) || left.commit.localeCompare(right.commit));
  const currentByHit = new Set<string>();
  for (const record of current) {
    const key = `${record.policy_id}:${record.proof_id}:${record.commit}`;
    if (currentByHit.has(key)) throw new Error(`history hit ${record.commit} has multiple current dispositions`);
    currentByHit.add(key);
  }
  return current;
}

export interface HistoryDispositionAssessment {
  current: HistoryDisposition[];
  bound: HistoryDisposition[];
  missing_commits: string[];
  unresolved_count: number;
  counts: Record<HistoryDispositionClassification, number>;
  blocking_error: string | null;
}

export function assessHistoryDispositions(proof: PolicyProof, records: HistoryDisposition[]): HistoryDispositionAssessment {
  const current = currentHistoryDispositions(records).filter((record) => record.proof_id === proof.id);
  const violations = proof.replay_receipts.filter((receipt) => receipt.leg === "accepted_history" && receipt.result === "violated");
  const counts: Record<HistoryDispositionClassification, number> = {
    true_positive_actionable: 0,
    true_positive_accepted_exception: 0,
    false_positive_selector: 0,
    false_positive_semantics: 0,
    false_positive_stale: 0,
    unknown_insufficient_parser: 0,
  };
  if (violations.length !== proof.accepted_history.violated) {
    return {
      current,
      bound: [],
      missing_commits: violations.map((receipt) => receipt.commit),
      unresolved_count: proof.accepted_history.violated,
      counts,
      blocking_error: "blocking proof accepted-history violation summary does not match its replay receipts",
    };
  }
  const bound: HistoryDisposition[] = [];
  const missing: string[] = [];
  for (const receipt of violations) {
    const candidates = current.filter((record) => record.commit === receipt.commit);
    const disposition = candidates.find((record) => record.receipt_hash === receipt.deterministic_hash && record.policy_hash === proof.policy_hash && record.plan_hash === proof.plan_hash);
    if (!disposition) {
      missing.push(receipt.commit);
      continue;
    }
    bound.push(disposition);
    counts[disposition.classification] += 1;
  }
  let blockingError: string | null = null;
  if (missing.length) blockingError = "blocking proof has unclassified accepted-history violation hits";
  else if (counts.false_positive_selector + counts.false_positive_semantics + counts.false_positive_stale > 0) {
    blockingError = "blocking proof has a human-classified accepted-history false positive; repair and re-prove the policy first";
  } else if (counts.unknown_insufficient_parser > 0) {
    blockingError = "blocking proof has an accepted-history hit classified unknown for insufficient parser support";
  } else if (counts.true_positive_accepted_exception > 0) {
    blockingError = "blocking proof has an accepted exception that requires separately proved parent/exception composition";
  }
  return { current, bound, missing_commits: missing, unresolved_count: missing.length, counts, blocking_error: blockingError };
}
