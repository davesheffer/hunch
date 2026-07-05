/**
 * Deterministic near-duplicate detection for auto-drafted decisions — hygiene,
 * not judgment (the human vouch stays untouchable; dec_a466655539 doctrine).
 *
 * The duplicate factory: a human records a decision via MCP (commit: null),
 * then commits the code — the post-commit hook synthesizes a SECOND record of
 * the same choice under a commit-keyed id. Review triage showed 7 of 14 queued
 * drafts were exactly this.
 *
 * Two layers, both model-free:
 *  - commitCoveredBy(): PRE-draft gate in syncCommit — a recent human-confirmed
 *    decision already claims this commit's files (+ subject terms) → skip the
 *    draft entirely (also saves the subscription call). Recency-windowed so an
 *    OLD decision on the same files can never suppress genuinely new work.
 *  - draftDuplicateOf(): review-time flag for drafts already in the store —
 *    full-text term overlap + file overlap against accepted records, so
 *    `hunch review` marks likely duplicates and can batch-reject them.
 */
import type { Decision } from "./types.js";
import { toPosixTarget } from "./paths.js";

/** Days a human-confirmed decision "covers" its files against auto-drafts.
 *  Wide enough for record-then-commit workflows (even across a weekend),
 *  narrow enough that revisiting the same files next month drafts normally. */
const COVER_WINDOW_DAYS = 14;

const STOP = new Set([
  "the", "a", "an", "and", "or", "not", "for", "with", "into", "onto", "over", "under", "this", "that",
  "when", "then", "than", "from", "are", "is", "was", "were", "will", "must", "never", "always", "via",
  "instead", "rather", "only", "every", "each", "its", "their", "our", "your", "has", "have", "had",
  "feat", "fix", "chore", "docs", "refactor", "test", "tests", "add", "adds", "added", "new", "now",
]);

/** Lowercased salient terms (≥4 chars, non-stopword) — deliberately simple and
 *  deterministic; shared by both layers so their notion of "similar" agrees. */
export function dupTerms(text: string): Set<string> {
  const out = new Set<string>();
  for (const m of text.toLowerCase().matchAll(/[a-z][a-z0-9_-]{3,}/g)) if (!STOP.has(m[0])) out.add(m[0]);
  return out;
}

function jaccard(a: Set<string>, b: Set<string>): number {
  if (!a.size || !b.size) return 0;
  let inter = 0;
  for (const x of a) if (b.has(x)) inter++;
  return inter / (a.size + b.size - inter);
}

function fileSet(files: readonly string[] | undefined): Set<string> {
  return new Set((files ?? []).map(toPosixTarget).filter((f) => f && !f.includes("*")));
}

export interface Coverage {
  id: string;
  title: string;
  hoursAgo: number;
  fileOverlapPct: number;
}

/** Does a RECENT human-confirmed live decision already claim this commit's
 *  files (and roughly its subject)? Deterministic pre-draft gate. */
export function commitCoveredBy(
  codeFiles: readonly string[],
  subject: string,
  existing: readonly Decision[],
  nowMs: number,
): Coverage | null {
  const commitFiles = fileSet(codeFiles);
  if (!commitFiles.size) return null;
  const subjectTerms = dupTerms(subject);
  let best: Coverage | null = null;
  for (const d of existing) {
    if (!d.provenance.source.includes("human_confirmed")) continue;
    if (d.status === "superseded" || d.status === "rejected" || d.superseded_by || d.valid_to) continue;
    const at = Date.parse(d.valid_from ?? d.date);
    if (!Number.isFinite(at)) continue;
    const ageDays = (nowMs - at) / 86400000;
    if (ageDays < 0 || ageDays > COVER_WINDOW_DAYS) continue;
    const decFiles = fileSet(d.related_files);
    if (!decFiles.size) continue;
    let overlap = 0;
    for (const f of commitFiles) if (decFiles.has(f)) overlap++;
    const overlapRatio = overlap / commitFiles.size; // how much of the COMMIT the decision claims
    const termSim = jaccard(subjectTerms, dupTerms(`${d.title} ${d.decision}`));
    // Strong file claim alone, or a moderate claim corroborated by the subject.
    const covered = overlapRatio >= 0.6 || (overlap >= 2 && overlapRatio >= 0.34 && termSim >= 0.15);
    if (!covered) continue;
    const cov: Coverage = { id: d.id, title: d.title, hoursAgo: Math.round((nowMs - at) / 3600000), fileOverlapPct: Math.round(overlapRatio * 100) };
    if (!best || cov.fileOverlapPct > best.fileOverlapPct) best = cov;
  }
  return best;
}

export interface DupMatch {
  of: Decision;
  /** 0..1 combined similarity (term Jaccard, file-overlap boosted). */
  score: number;
}

/** Is an existing DRAFT a near-duplicate of an accepted record? Review-time
 *  flag; threshold callers use 0.35 (batch-reject) — conservative on purpose. */
export function draftDuplicateOf(draft: Decision, existing: readonly Decision[]): DupMatch | null {
  const draftTerms = dupTerms(`${draft.title} ${draft.decision}`);
  const draftFiles = fileSet(draft.related_files);
  let best: DupMatch | null = null;
  for (const d of existing) {
    if (d.id === draft.id) continue;
    if (!d.provenance.source.includes("human_confirmed")) continue;
    if (d.status === "superseded" || d.status === "rejected" || d.superseded_by || d.valid_to) continue;
    const termSim = jaccard(draftTerms, dupTerms(`${d.title} ${d.decision}`));
    let fileBoost = 0;
    if (draftFiles.size) {
      const decFiles = fileSet(d.related_files);
      let overlap = 0;
      for (const f of draftFiles) if (decFiles.has(f)) overlap++;
      fileBoost = draftFiles.size ? (overlap / draftFiles.size) * 0.25 : 0;
    }
    const score = Math.min(1, termSim + fileBoost);
    if (score >= 0.35 && (!best || score > best.score)) best = { of: d, score };
  }
  return best;
}
