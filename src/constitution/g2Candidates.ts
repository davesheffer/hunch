import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { shortHash } from "../core/ids.js";
import { hunchPathsForDir } from "../core/paths.js";
import type { Decision } from "../core/types.js";
import { commitMeta, fixCommits } from "../extractors/git.js";
import { indexRepo } from "../extractors/indexer.js";
import { HunchStore } from "../store/hunchStore.js";
import { canonicalHash } from "./canonical.js";
import { extractStructuralDelta } from "./delta.js";
import type { PolicyAssertion, PolicyScope } from "./schema.js";
import { enumerateStructuralCandidates } from "./structural.js";

export type G2CandidateAttestationStatus =
  | "human_grounded_exact"
  | "human_grounded_needs_selection"
  | "unattested_structural_coincidence";

export type G2CandidateHumanDisposition = "selected" | "rejected";

export interface G2CandidateReviewResolution {
  id: string;
  candidate_id: string;
  candidate_hash: string;
  review_hash: string;
  disposition: G2CandidateHumanDisposition;
  actor: string;
  reason: string;
  created_at: string;
}

export interface G2CandidateReviewItem {
  id: string;
  candidate_id: string;
  commit: string;
  commit_subject: string;
  commit_date: string;
  changed_files: string[];
  sibling_candidates: number;
  basis: "added-call" | "removed-call" | "added-symbol" | "removed-import" | "added-relative-import" | "removed-relative-import";
  reason: string;
  assertion: PolicyAssertion;
  scope: PolicyScope;
  proposed_corpus: {
    known_bad: { ref: string; expected: "violated" };
    known_good: { ref: string; expected: "satisfied" };
    observed: false;
  };
  attestation: {
    status: G2CandidateAttestationStatus;
    decision_ids: string[];
  };
  human_review: G2CandidateReviewResolution | null;
}

export interface G2CandidateReviewReport {
  id: string;
  content_hash: string;
  since: string;
  max_commits: number;
  limit: number;
  scanned_fix_commits: number;
  candidate_commits: number;
  total_candidates: number;
  human_grounded_exact: number;
  human_grounded_needs_selection: number;
  unattested_structural_coincidence: number;
  selected_candidates: number;
  rejected_candidates: number;
  unreviewed_candidates: number;
  extraction_failures: Array<{ commit: string; error: string }>;
  items: G2CandidateReviewItem[];
  has_more: boolean;
  data_class: "private";
  authority: "none";
  writes: "none";
  proof_status: "not_run";
}

export interface G2CandidateReviewOptions {
  since?: string;
  maxCommits?: number;
  limit?: number;
}

export function g2CandidateItemHash(item: G2CandidateReviewItem): string {
  const { human_review: _humanReview, ...body } = item;
  return canonicalHash(body);
}

export function g2CandidateReviewContentHash(report: G2CandidateReviewReport): string {
  const { id: _id, content_hash: _contentHash, ...body } = report;
  return canonicalHash(body);
}

interface Grounding {
  decision_id: string;
  candidate_ids: Set<string>;
  exact: boolean;
}

const attestationRank: Record<G2CandidateAttestationStatus, number> = {
  human_grounded_exact: 0,
  human_grounded_needs_selection: 1,
  unattested_structural_coincidence: 2,
};

const basisRank: Record<G2CandidateReviewItem["basis"], number> = {
  "added-call": 0,
  "removed-call": 0,
  "removed-import": 1,
  "added-relative-import": 1,
  "removed-relative-import": 1,
  "added-symbol": 2,
};

export function positiveBound(value: number, label: string, max: number): number {
  if (!Number.isInteger(value) || value < 1) throw new Error(`${label} must be a positive integer`);
  if (value > max) throw new Error(`${label} cannot exceed ${max}`);
  return value;
}

function privateGrounding(decisionStore: HunchStore, graphStore: HunchStore, root: string): Map<string, Grounding[]> {
  const byCommit = new Map<string, Grounding[]>();
  if (!decisionStore.hasPrivate) return byCommit;
  const decisions = decisionStore.recsInHome("decisions", "private")
    .filter((decision): decision is Decision => decision.status === "accepted"
      && !decision.superseded_by
      && !decision.valid_to
      && !!decision.commit
      && decision.provenance.source.includes("human_confirmed"));
  for (const decision of decisions) {
    const meta = commitMeta(decision.commit!, root);
    if (!meta) continue;
    try {
      const delta = extractStructuralDelta(root, meta.sha);
      const inspection = enumerateStructuralCandidates(graphStore, delta, { publicOnly: true, judgment: decision });
      const list = byCommit.get(meta.sha) ?? [];
      list.push({
        decision_id: decision.id,
        candidate_ids: new Set(inspection.candidates.map((candidate) => candidate.id)),
        exact: inspection.candidates.length === 1,
      });
      byCommit.set(meta.sha, list);
    } catch {
      // A human decision can be real while still lacking a supported structural
      // binding. It contributes no candidate attestation rather than being
      // stretched over a coincidental fact from the same commit.
    }
  }
  return byCommit;
}

/** Read-only review packet. Structural facts propose corpus pairs but cannot
 * become policy evidence until an exact human judgment selects their semantics. */
export function buildG2CandidateReview(
  store: HunchStore,
  root: string,
  opts: G2CandidateReviewOptions = {},
  resolutions: G2CandidateReviewResolution[] = [],
): G2CandidateReviewReport {
  const scratchRoot = mkdtempSync(join(tmpdir(), "hunch-g2-candidates-"));
  const graphStore = new HunchStore(hunchPathsForDir(scratchRoot));
  try {
    graphStore.json.ensureDirs();
    indexRepo(graphStore, root, { churn: false });
    return buildFromIndexedGraph(store, graphStore, root, opts, resolutions);
  } finally {
    graphStore.close();
    rmSync(scratchRoot, { recursive: true, force: true });
  }
}

function buildFromIndexedGraph(
  decisionStore: HunchStore,
  graphStore: HunchStore,
  root: string,
  opts: G2CandidateReviewOptions,
  resolutions: G2CandidateReviewResolution[],
): G2CandidateReviewReport {
  const since = (opts.since ?? "180d").trim();
  if (!since || since.length > 100) throw new Error("G2 candidate since window must be a non-empty bounded string");
  const maxCommits = positiveBound(opts.maxCommits ?? 100, "G2 candidate maxCommits", 200);
  const limit = positiveBound(opts.limit ?? 30, "G2 candidate limit", 100);
  const commits = fixCommits(since, root, maxCommits);
  const grounding = privateGrounding(decisionStore, graphStore, root);
  const failures: Array<{ commit: string; error: string }> = [];
  const candidates: G2CandidateReviewItem[] = [];
  let candidateCommits = 0;

  for (const commit of commits) {
    try {
      const meta = commitMeta(commit, root);
      if (!meta) throw new Error("commit metadata is unavailable");
      const delta = extractStructuralDelta(root, commit);
      // The private overlay supplies human intent only. Symbols and edges are a
      // derived view of public source and may be stale in long-lived overlays,
      // so bindings must come from the freshly indexed public graph alone.
      const enumerated = enumerateStructuralCandidates(graphStore, delta, { publicOnly: true });
      if (enumerated.candidates.length) candidateCommits++;
      for (const candidate of enumerated.candidates) {
        const matches = (grounding.get(meta.sha) ?? []).filter((entry) => entry.candidate_ids.has(candidate.id));
        const status: G2CandidateAttestationStatus = matches.some((entry) => entry.exact)
          ? "human_grounded_exact"
          : matches.length
            ? "human_grounded_needs_selection"
            : "unattested_structural_coincidence";
        const seed = canonicalHash({ commit: meta.sha, candidate_id: candidate.id });
        candidates.push({
          id: `g2candidate_${shortHash(seed)}`,
          candidate_id: candidate.id,
          commit: meta.sha,
          commit_subject: meta.subject,
          commit_date: meta.date,
          changed_files: [...meta.files].sort(),
          sibling_candidates: enumerated.candidates.length,
          basis: candidate.basis,
          reason: candidate.reason,
          assertion: candidate.assertion,
          scope: candidate.scope,
          proposed_corpus: {
            known_bad: { ref: delta.before_commit, expected: "violated" },
            known_good: { ref: delta.after_commit, expected: "satisfied" },
            observed: false,
          },
          attestation: {
            status,
            decision_ids: [...new Set(matches.map((entry) => entry.decision_id))].sort(),
          },
          human_review: null,
        });
      }
    } catch (error) {
      failures.push({ commit, error: (error as Error).message });
    }
  }

  for (const candidate of candidates) {
    const candidateHash = g2CandidateItemHash(candidate);
    candidate.human_review = resolutions.find((resolution) => resolution.candidate_id === candidate.id && resolution.candidate_hash === candidateHash) ?? null;
  }

  candidates.sort((left, right) => {
    const attestation = attestationRank[left.attestation.status] - attestationRank[right.attestation.status];
    if (attestation) return attestation;
    const leftSource = left.scope.paths.some((path) => path.startsWith("src/")) ? 0 : 1;
    const rightSource = right.scope.paths.some((path) => path.startsWith("src/")) ? 0 : 1;
    if (leftSource !== rightSource) return leftSource - rightSource;
    const basis = basisRank[left.basis] - basisRank[right.basis];
    if (basis) return basis;
    return right.commit_date.localeCompare(left.commit_date)
      || left.commit.localeCompare(right.commit)
      || left.candidate_id.localeCompare(right.candidate_id);
  });
  const counts = {
    human_grounded_exact: candidates.filter((candidate) => candidate.attestation.status === "human_grounded_exact").length,
    human_grounded_needs_selection: candidates.filter((candidate) => candidate.attestation.status === "human_grounded_needs_selection").length,
    unattested_structural_coincidence: candidates.filter((candidate) => candidate.attestation.status === "unattested_structural_coincidence").length,
    selected_candidates: candidates.filter((candidate) => candidate.human_review?.disposition === "selected").length,
    rejected_candidates: candidates.filter((candidate) => candidate.human_review?.disposition === "rejected").length,
    unreviewed_candidates: candidates.filter((candidate) => candidate.human_review === null).length,
  };
  const items = candidates.slice(0, limit);
  const body = {
    since,
    max_commits: maxCommits,
    limit,
    scanned_fix_commits: commits.length,
    candidate_commits: candidateCommits,
    total_candidates: candidates.length,
    ...counts,
    extraction_failures: failures.sort((left, right) => left.commit.localeCompare(right.commit)),
    items,
    has_more: candidates.length > items.length,
    data_class: "private" as const,
    authority: "none" as const,
    writes: "none" as const,
    proof_status: "not_run" as const,
  };
  const contentHash = canonicalHash(body);
  return { id: `g2candidates_${shortHash(contentHash)}`, content_hash: contentHash, ...body };
}
