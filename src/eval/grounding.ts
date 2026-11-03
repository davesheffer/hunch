/**
 * Grounding delivery accuracy (private #43). Precision: the share of delivered
 * records that are eligible for the task. Recall: the share of eligible records
 * that were delivered. "Delivered" is what file grounding keeps for a task —
 * selectForTask's qualifying set, the same call the prompt hook makes — so a
 * replay over a golden set measures the live selector, not a model of it.
 *
 * Pure: records and cases are passed in. The tracked synthetic baseline lives in
 * bench/grounding-selection-v1.json; `hunch eval --grounding` runs a golden set
 * against a real store.
 */
import { z } from "zod";
import { selectForTask, type TaskSelectionRecords } from "../core/taskSelection.js";

export interface GroundingCase {
  name: string;
  prompt: string;
  /** Records the task needs: recall counts these. */
  eligible: readonly string[];
  /** Records that may also arrive without being a false positive; "any" leaves
   *  precision unjudged for a case whose full relevant set is unknown. */
  allowed?: readonly string[] | "any";
}

export interface GroundingCaseScore {
  name: string;
  delivered: string[];
  tp: number;
  /** null when the case does not judge precision (allowed: "any"). */
  fp: number | null;
  fn: number;
  /** Silence is never imprecise: nothing delivered scores 1. */
  precision: number | null;
  /** null when the case names no eligible record. */
  recall: number | null;
  false_positives: string[];
  missed: string[];
}

export interface GroundingAggregate {
  cases: number;
  precision_cases: number;
  recall_cases: number;
  /** Micro: pooled over the judged cases' deliveries. */
  precision: number;
  /** Micro: pooled over the judged cases' eligible records. */
  recall: number;
}

export function scoreGroundingCase(delivered: readonly string[], c: GroundingCase): GroundingCaseScore {
  const out = [...new Set(delivered)];
  const eligible = new Set(c.eligible);
  const tp = out.filter((id) => eligible.has(id)).length;
  const missed = [...eligible].filter((id) => !out.includes(id));
  const judged = c.allowed !== "any";
  const accept = new Set([...eligible, ...(judged ? c.allowed ?? [] : [])]);
  const falsePositives = judged ? out.filter((id) => !accept.has(id)) : [];
  return {
    name: c.name,
    delivered: out,
    tp,
    fp: judged ? falsePositives.length : null,
    fn: missed.length,
    precision: judged ? (out.length ? (out.length - falsePositives.length) / out.length : 1) : null,
    recall: eligible.size ? tp / eligible.size : null,
    false_positives: falsePositives,
    missed,
  };
}

export function aggregateGrounding(scores: readonly GroundingCaseScore[]): GroundingAggregate {
  let delivered = 0, accepted = 0, eligible = 0, found = 0, precisionCases = 0, recallCases = 0;
  for (const s of scores) {
    if (s.fp !== null) {
      precisionCases++;
      delivered += s.delivered.length;
      accepted += s.delivered.length - s.fp;
    }
    if (s.recall !== null) {
      recallCases++;
      eligible += s.tp + s.fn;
      found += s.tp;
    }
  }
  return {
    cases: scores.length,
    precision_cases: precisionCases,
    recall_cases: recallCases,
    precision: delivered ? accepted / delivered : 1,
    recall: eligible ? found / eligible : 1,
  };
}

/** Replay each case's prompt through the live selector and score what it qualifies. */
export function evaluateGroundingSelection(
  records: TaskSelectionRecords,
  cases: readonly GroundingCase[],
  opts: { k?: number; root?: string; pathExists?: (path: string) => boolean } = {},
): { cases: GroundingCaseScore[]; aggregate: GroundingAggregate } {
  const scores = cases.map((c) => scoreGroundingCase(selectForTask(records, c.prompt, opts).qualifying, c));
  return { cases: scores, aggregate: aggregateGrounding(scores) };
}

const GroundingCaseSchema = z.object({
  name: z.string().min(1),
  prompt: z.string().min(1),
  eligible: z.array(z.string()),
  allowed: z.union([z.array(z.string()), z.literal("any")]).optional(),
}).strict();

/** Parse a golden set: [{ name, prompt, eligible, allowed? }]. Throws on a bad shape or a repeated name. */
export function loadGroundingCases(json: string): GroundingCase[] {
  const parsed = z.array(GroundingCaseSchema).safeParse(JSON.parse(json));
  if (!parsed.success) {
    const issue = parsed.error.issues[0]!;
    throw new Error(`invalid grounding case at ${issue.path.join(".") || "(root)"}: ${issue.message}`);
  }
  const seen = new Set<string>();
  for (const c of parsed.data) {
    if (seen.has(c.name)) throw new Error(`duplicate grounding case name "${c.name}"`);
    seen.add(c.name);
  }
  return parsed.data;
}
