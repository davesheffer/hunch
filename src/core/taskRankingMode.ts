/** Automatic evaluation and the automatic kill rule for task-record ranking
 * (dec_66925aa0ee). Nobody has to run anything:
 *
 *  - every time a task record is written, the leave-one-out evaluation is
 *    recomputed over the graph's task records (pure, a few hundred records)
 *    and cached under .hunch-cache — derived state, safe to delete;
 *  - delivery reads the cache to pick its mode: `ranked` until the
 *    pre-registered rule says otherwise, `latest` (three most recent on the
 *    file) once the ranked selection has LOST to the baseline with a
 *    confidence interval excluding zero over at least KILL_MIN_TASKS records;
 *  - `hunch now` prints the current line; a verdict change becomes a finding.
 *
 * `.hunch/local.json` `taskRanking: "ranked" | "latest"` overrides the automatic
 * choice for a repository that wants to pin it. */
import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { flushCapture } from "../integrations/sync.js";
import type { HunchStore } from "../store/hunchStore.js";
import { writeFileAtomic } from "./io.js";
import { hunchPaths } from "./paths.js";
import { evaluateTaskRanking, type RankEvalReport } from "./taskRankEval.js";
import { reportHash } from "./taskReport.js";
import { FindingSchema, type Finding } from "./types.js";

export const RANK_EVAL_CACHE_SCHEMA = "hunch.task-rank-eval-cache/1" as const;
/** The decision's threshold: the kill rule needs at least this many task records. */
export const KILL_MIN_TASKS = 200;

export type TaskRankingMode = "ranked" | "latest";

export interface RankEvalCache {
  schema: typeof RANK_EVAL_CACHE_SCHEMA;
  computed_at: string;
  /** Task-record count the report was computed over; a different count triggers a recompute. */
  records: number;
  /** Content hash of the record ids + report hashes, so an edit without a count change also refreshes. */
  corpus_hash: string;
  report: RankEvalReport;
}

function cachePath(root: string): string {
  return join(root, ".hunch-cache", "task-rank-eval.json");
}

export function readRankEvalCache(root: string): RankEvalCache | null {
  try {
    const parsed = JSON.parse(readFileSync(cachePath(root), "utf8")) as RankEvalCache;
    return parsed && parsed.schema === RANK_EVAL_CACHE_SCHEMA && parsed.report ? parsed : null;
  } catch { return null; }
}

function corpusHash(store: HunchStore): { hash: string; count: number } {
  const records = store.recs("tasks");
  const ids = records.map((r) => `${r.id}:${r.report_hash}`).sort();
  return { hash: reportHash(ids), count: records.length };
}

/** Recompute when the corpus changed; otherwise return the cached report. Never throws. */
export function refreshRankEval(root: string, store: HunchStore, options: { force?: boolean; now?: () => string } = {}): RankEvalCache | null {
  try {
    const { hash, count } = corpusHash(store);
    const cached = readRankEvalCache(root);
    if (!options.force && cached && cached.corpus_hash === hash) return cached;
    const report = evaluateTaskRanking(store.recs("tasks"));
    const next: RankEvalCache = { schema: RANK_EVAL_CACHE_SCHEMA, computed_at: (options.now ?? (() => new Date().toISOString()))(), records: count, corpus_hash: hash, report };
    try {
      const dir = join(root, ".hunch-cache");
      if (!existsSync(dir)) return next; // no cache dir: still return the fresh report, just do not persist
      writeFileAtomic(cachePath(root), JSON.stringify(next, null, 2));
    } catch { /* cache is a convenience */ }
    if (cached && cached.report.verdict !== report.verdict) noteVerdictChange(root, store, cached, next);
    return next;
  } catch { return readRankEvalCache(root); }
}

/** The rule from the decision, applied to a report. */
export function modeFromReport(report: RankEvalReport | null | undefined): { mode: TaskRankingMode; reason: string } {
  if (!report) return { mode: "ranked", reason: "no evaluation yet" };
  if (report.verdict === "baseline-better" && report.tasks >= KILL_MIN_TASKS) {
    return { mode: "latest", reason: `ranked selection lost to latest3 on ${report.split.evaluated} cases (Hit@5 ${pct(report.rankers[0]?.hit5)} vs ${pct(report.rankers[1]?.hit5)}, CI [${pts(report.delta_hit5.ci95[0])}, ${pts(report.delta_hit5.ci95[1])}])` };
  }
  return { mode: "ranked", reason: report.verdict === "ranked-better" ? "ranked selection beats latest3" : report.verdict === "baseline-better" ? `latest3 ahead but only ${report.tasks} of ${KILL_MIN_TASKS} task records; not yet decisive` : `evaluation ${report.verdict} (${report.split.evaluated} cases)` };
}

export interface ResolvedRankingMode { mode: TaskRankingMode; reason: string; source: "override" | "auto"; cache: RankEvalCache | null }

/** What delivery should do right now for this repository. */
export function resolveTaskRankingMode(root: string, store: HunchStore): ResolvedRankingMode {
  let override: unknown;
  try { override = (JSON.parse(readFileSync(join(root, ".hunch", "local.json"), "utf8")) as Record<string, unknown>).taskRanking; } catch { /* none */ }
  const cache = refreshRankEval(root, store);
  if (override === "ranked" || override === "latest") return { mode: override, reason: `pinned by .hunch/local.json taskRanking`, source: "override", cache };
  const { mode, reason } = modeFromReport(cache?.report);
  return { mode, reason, source: "auto", cache };
}

function pct(x: number | undefined): string { return x === undefined ? "–" : `${Math.round(x * 100)}%`; }
function pts(x: number): string { return `${x >= 0 ? "+" : ""}${Math.round(x * 100)}`; }

/** One line for `hunch now` and the task stats. */
export function rankingStatusLine(resolved: ResolvedRankingMode): string {
  const r = resolved.cache?.report;
  if (!r) return `task ranking: ${resolved.mode} · no evaluation yet (no finished task records)`;
  const ranked = r.rankers.find((x) => x.name === "ranked"), base = r.rankers.find((x) => x.name === "latest3");
  return `task ranking: ${resolved.mode}${resolved.source === "override" ? " (pinned)" : ""} · Hit@5 ranked ${pct(ranked?.hit5)} vs latest3 ${pct(base?.hit5)}, CI [${pts(r.delta_hit5.ci95[0])}, ${pts(r.delta_hit5.ci95[1])}], n=${r.split.evaluated} of ${r.tasks} records · ${r.verdict}${r.tasks < KILL_MIN_TASKS ? ` · kill rule armed at ${KILL_MIN_TASKS} records` : ""}`;
}

/** A verdict change is memory: record it once, through the normal capture path. */
function noteVerdictChange(root: string, store: HunchStore, prev: RankEvalCache, next: RankEvalCache): void {
  try {
    const title = `Task ranking evaluation verdict changed: ${prev.report.verdict} → ${next.report.verdict} at ${next.records} task records`;
    const id = `fnd_${reportHash(title).slice(7, 17)}`;
    if (store.getRec("findings", id)) return;
    const r = next.report;
    const finding: Finding = FindingSchema.parse({
      id, title,
      observation: `Automatic leave-one-out evaluation of task-record ranking (dec_66925aa0ee) recomputed after a task record was written. Ranked Hit@5 ${pct(r.rankers[0]?.hit5)} vs latest3 ${pct(r.rankers[1]?.hit5)}, MRR ${r.rankers[0]?.mrr.toFixed(2)} vs ${r.rankers[1]?.mrr.toFixed(2)}, paired bootstrap CI on Hit@5 [${pts(r.delta_hit5.ci95[0])}, ${pts(r.delta_hit5.ci95[1])}] over ${r.split.evaluated} cases (${r.evaluable} evaluable of ${r.tasks}). Delivery mode now: ${modeFromReport(r).mode} — ${modeFromReport(r).reason}.`,
      evidence: [`hunch task rank-eval --json (computed ${next.computed_at})`, `.hunch-cache/task-rank-eval.json corpus ${next.corpus_hash}`],
      severity: next.report.verdict === "baseline-better" ? "high" : "low",
      triage: "open",
      affected_files: ["src/core/taskRanking.ts", "src/core/taskRankingMode.ts"],
      observed_at: next.computed_at,
      provenance: { source: "task_rank_eval", confidence: 0.9, evidence: ["hunch task rank-eval"], last_verified: next.computed_at },
    });
    store.putCapture("findings", finding, false);
    flushCapture(store, hunchPaths(root).hunch, false, `hunch: capture ${id}`, undefined, undefined, "findings");
  } catch { /* the cache still carries the verdict; memory of the change is best-effort */ }
}
