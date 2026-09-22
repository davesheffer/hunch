/** The agent's own context as a ranking query.
 *
 * What a task has already done is the best statement of what it is doing:
 * the files context was delivered for, the rules and decisions it received,
 * applied or saved, and its title when the repository opted into prompt
 * titles. All of it is already in the local ledger; nothing new is stored and
 * no prompt text is read. Without a task id the query is the target alone. */
import { readTaskReport } from "./taskReport.js";
import { targetLooksLikePath } from "./taskRecord.js";
import { normalizePath, type RankingQuery } from "./taskRanking.js";

const GENERIC_TITLES: ReadonlySet<string> = new Set(["Assistant task", "Claude task"]);

export interface TaskQueryOptions {
  /** A phrase the caller has (hunch_context's target when it is not a path). */
  phrase?: string | null;
  /** Automatic hooks must not feed their own target delivery back into ranking. */
  excludeTargetDeliveries?: boolean;
  now?: number;
}

export function buildTaskRankingQuery(root: string, taskId: string | null | undefined, target: string, options: TaskQueryOptions = {}): RankingQuery {
  const now = options.now ?? Date.now();
  const files = new Set<string>();
  const recordIds = new Set<string>();
  let phrase: string | null = options.phrase && !targetLooksLikePath(options.phrase) ? options.phrase : null;
  if (targetLooksLikePath(target)) files.add(normalizePath(target));
  else if (!phrase) phrase = target;
  if (taskId) {
    try {
      const report = readTaskReport(root, taskId);
      for (const d of report.deliveries) {
        if (options.excludeTargetDeliveries && d.target && normalizePath(d.target) === normalizePath(target)) continue;
        if (d.target && targetLooksLikePath(d.target)) files.add(normalizePath(d.target));
        for (const r of d.records) recordIds.add(r.record_id);
      }
      for (const c of report.conformance) for (const f of c.files) files.add(normalizePath(f));
      for (const c of report.claims) recordIds.add(c.record_id);
      for (const s of report.saves) recordIds.add(s.record.record_id);
      if (!GENERIC_TITLES.has(report.task.title)) phrase = phrase ?? report.task.title;
    } catch { /* an unreadable ledger degrades to a target-only query */ }
  }
  return { target: normalizePath(target), files, recordIds, phrase, now };
}
