import { cleanupDir } from "./fixtures.js";
import { test } from "node:test";
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { buildDeliveryEnvelope } from "../src/core/delivery.js";
import { taskSelectionSupplements } from "../src/core/taskDelivery.js";
import { buildTaskRankingQuery } from "../src/core/taskQuery.js";
import { persistTaskRecord } from "../src/core/taskRecord.js";
import { KILL_MIN_TASKS, modeFromReport, rankingStatusLine, readRankEvalCache, refreshRankEval, resolveTaskRankingMode, type RankEvalCache } from "../src/core/taskRankingMode.js";
import { DEFAULT_WEIGHTS } from "../src/core/taskRanking.js";
import type { RankEvalReport } from "../src/core/taskRankEval.js";
import { finishReportTask, recordTaskDelivery, reportHash, startReportTask } from "../src/core/taskReport.js";
import { HunchStore, type AssembledContext } from "../src/store/hunchStore.js";
import { hunchPaths } from "../src/core/paths.js";

function report(over: Partial<RankEvalReport> & { verdict: RankEvalReport["verdict"] }): RankEvalReport {
  return {
    schema: "hunch.task-rank-eval/1", tasks: 250, evaluable: 100, split: { fraction: 0.3, evaluated: 30, note: null },
    rankers: [{ name: "ranked", hit5: 0.4, mrr: 0.3 }, { name: "latest3", hit5: 0.6, mrr: 0.5 }],
    delta_hit5: { mean: -0.2, ci95: [-0.3, -0.1], resamples: 1000 }, weights: { ...DEFAULT_WEIGHTS }, ...over,
  };
}

test("the kill rule: latest only after a CI-backed loss over at least the decision's record count; ranked otherwise", () => {
  assert.equal(modeFromReport(null).mode, "ranked");
  assert.equal(modeFromReport(report({ verdict: "insufficient-data", tasks: 4 })).mode, "ranked");
  assert.equal(modeFromReport(report({ verdict: "inconclusive" })).mode, "ranked");
  assert.equal(modeFromReport(report({ verdict: "ranked-better" })).mode, "ranked");
  const early = modeFromReport(report({ verdict: "baseline-better", tasks: KILL_MIN_TASKS - 1 }));
  assert.equal(early.mode, "ranked");
  assert.match(early.reason, /not yet decisive/);
  const killed = modeFromReport(report({ verdict: "baseline-better", tasks: KILL_MIN_TASKS }));
  assert.equal(killed.mode, "latest");
  assert.match(killed.reason, /lost to latest3/);
});

function fixture(t: { after: (f: () => void) => void }): { root: string; store: HunchStore } {
  const root = mkdtempSync(join(tmpdir(), "hunch-rank-mode-"));
  execFileSync("git", ["init", "-q", root]);
  mkdirSync(join(root, "src")); mkdirSync(join(root, ".hunch-cache")); mkdirSync(join(root, ".hunch"));
  writeFileSync(join(root, ".gitignore"), ".hunch-cache/\n");
  writeFileSync(join(root, ".hunch", "local.json"), JSON.stringify({ autoCommit: false }));
  writeFileSync(join(root, "src", "config.js"), "export const preserve = true;\n");
  const store = new HunchStore(hunchPaths(root));
  store.json.ensureDirs();
  t.after(() => { store.close(); cleanupDir(root); });
  return { root, store };
}
const ctxFor = (target: string) => ({ target, constraints: [{ id: "con_preserve", type: "architecture", statement: "Preserve existing settings", scope: [target], severity: "blocking", enforcement: "advisory_v1", match: null, forbids: null, rationale: "", source_decision: null, violations: [], status: "active", valid_from: "2026-09-11T00:00:00.000Z", valid_to: null, provenance: { source: "human_confirmed", confidence: 1, evidence: [] } }], decisions: [], bugs: [], blast_radius: [], components: [], findings: [], budget_tokens: 1500 } as unknown as AssembledContext);
const record = { record_id: "con_preserve", kind: "constraints", title: "Preserve existing settings", lesson: "Merge settings.", content_hash: reportHash("rev"), recorded_at: "2026-09-11T00:00:00.000Z" };

test("the evaluation refreshes itself when a task record is written, is cached, and delivery resolves its mode without any command", t => {
  const { root, store } = fixture(t);
  assert.equal(readRankEvalCache(root), null);
  const first = refreshRankEval(root, store, { now: () => "2026-09-15T10:00:00.000Z" });
  assert.ok(first && first.report.tasks === 0);
  assert.ok(existsSync(join(root, ".hunch-cache", "task-rank-eval.json")), "cached under .hunch-cache");
  const again = refreshRankEval(root, store, { now: () => "2026-09-15T11:00:00.000Z" });
  assert.equal(again!.computed_at, "2026-09-15T10:00:00.000Z", "unchanged corpus → cached report, not recomputed");

  // Writing a task record recomputes the evaluation as a side effect of persisting.
  const task = startReportTask(root, "Fix settings merge");
  recordTaskDelivery(root, task.task_id, buildDeliveryEnvelope(ctxFor("src/config.js")), [record], undefined, "src/config.js");
  finishReportTask(root, task.task_id);
  assert.ok(persistTaskRecord(root, store, task.task_id));
  const after = readRankEvalCache(root)!;
  assert.equal(after.records, 1);
  assert.notEqual(after.corpus_hash, first!.corpus_hash);
  assert.equal(after.report.verdict, "insufficient-data");

  const resolved = resolveTaskRankingMode(root, store);
  assert.equal(resolved.mode, "ranked");
  assert.equal(resolved.source, "auto");
  assert.match(rankingStatusLine(resolved), /task ranking: ranked .*insufficient-data .*kill rule armed at 200 records/);

  // A pinned repository overrides the automatic choice.
  writeFileSync(join(root, ".hunch", "local.json"), JSON.stringify({ autoCommit: false, taskRanking: "latest" }));
  const pinned = resolveTaskRankingMode(root, store);
  assert.equal(pinned.mode, "latest");
  assert.equal(pinned.source, "override");
  const sel = store.selectTasksAuto("src/config.js", buildTaskRankingQuery(root, null, "src/config.js"));
  assert.equal(sel.mode, "latest");
  assert.deepEqual(sel.picks.map((p) => p.slot), ["latest"]);
  assert.match(taskSelectionSupplements(sel, "src/config.js")[0]!.text, /ranking off: it lost its evaluation/);
});

test("a verdict change is recorded once as a finding through the normal capture path", t => {
  const { root, store } = fixture(t);
  // Seed a cache whose verdict differs from what the (empty) corpus produces.
  const seeded: RankEvalCache = { schema: "hunch.task-rank-eval-cache/1", computed_at: "2026-09-14T00:00:00.000Z", records: 999, corpus_hash: "sha256:stale", report: report({ verdict: "ranked-better" }) };
  writeFileSync(join(root, ".hunch-cache", "task-rank-eval.json"), JSON.stringify(seeded));
  const next = refreshRankEval(root, store, { now: () => "2026-09-15T12:00:00.000Z" })!;
  assert.equal(next.report.verdict, "insufficient-data");
  const findings = store.recs("findings");
  assert.equal(findings.length, 1);
  assert.match(findings[0]!.title, /verdict changed: ranked-better → insufficient-data/);
  assert.equal(findings[0]!.provenance.source, "task_rank_eval");
  // Same corpus again: cached, no second finding.
  refreshRankEval(root, store);
  assert.equal(store.recs("findings").length, 1);
  assert.equal(JSON.parse(readFileSync(join(root, ".hunch-cache", "task-rank-eval.json"), "utf8")).report.verdict, "insufficient-data");
});
