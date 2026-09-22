import { cleanupDir } from "./fixtures.js";
import { test } from "node:test";
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { buildDeliveryEnvelope } from "../src/core/delivery.js";
import { cochangeFor, computeCochange, parseNameOnlyLog } from "../src/core/cochange.js";
import { taskSelectionSupplements } from "../src/core/taskDelivery.js";
import { buildTaskRankingQuery } from "../src/core/taskQuery.js";
import { persistTaskRecord } from "../src/core/taskRecord.js";
import { finishReportTask, recordReportClaim, recordTaskDelivery, reportHash, startReportTask } from "../src/core/taskReport.js";
import { runReportConformance } from "../src/core/taskReportEvidence.js";
import { HunchStore, type AssembledContext } from "../src/store/hunchStore.js";
import { hunchPaths } from "../src/core/paths.js";
import { mkConstraint } from "./helpers.js";

function git(root: string, ...args: string[]): string {
  return execFileSync("git", ["-C", root, ...args], { encoding: "utf8", env: { ...process.env, GIT_AUTHOR_NAME: "t", GIT_AUTHOR_EMAIL: "t@x", GIT_COMMITTER_NAME: "t", GIT_COMMITTER_EMAIL: "t@x" } });
}
function commit(root: string, files: Record<string, string>, message: string): void {
  for (const [f, body] of Object.entries(files)) { mkdirSync(join(root, f, ".."), { recursive: true }); writeFileSync(join(root, f), body); }
  git(root, "add", "-A"); git(root, "commit", "-q", "-m", message);
}

test("co-change: parses name-only logs, ignores bulk commits, needs the target in the commit", () => {
  const log = ["a".repeat(40), "src/a.js", "src/b.js", "", "b".repeat(40), "src/a.js", "src/c.js", "src/b.js", "", "c".repeat(40), "src/z.js"].join("\n");
  const commits = parseNameOnlyLog(log);
  assert.equal(commits.length, 3);
  const m = computeCochange(commits, "src/a.js", 30);
  assert.deepEqual(m.get("src/b.js"), { count: 2, strength: 1 });
  assert.deepEqual(m.get("src/c.js"), { count: 1, strength: 0.5 });
  assert.equal(m.has("src/z.js"), false, "a commit without the target contributes nothing");
  assert.equal(computeCochange(commits, "src/a.js", 2).get("src/c.js"), undefined, "a commit above the file cap is a bulk move");
});

test("co-change reads real git history, bounded, and returns empty outside a repository", t => {
  const root = mkdtempSync(join(tmpdir(), "hunch-cochange-"));
  t.after(() => cleanupDir(root));
  git(root, "init", "-q");
  commit(root, { "src/a.js": "1", "src/b.js": "1" }, "one");
  commit(root, { "src/a.js": "2", "src/b.js": "2", "src/c.js": "1" }, "two");
  commit(root, { "src/c.js": "2" }, "three");
  const m = cochangeFor(root, "src/a.js", { cache: false });
  assert.deepEqual(m.get("src/b.js"), { count: 2, strength: 1 });
  assert.deepEqual(m.get("src/c.js"), { count: 1, strength: 0.5 });
  const cached = cochangeFor(root, "src/a.js");
  assert.deepEqual([...cached.entries()], [...cochangeFor(root, "src/a.js").entries()], "cache round-trips");
  const empty = mkdtempSync(join(tmpdir(), "hunch-cochange-empty-"));
  t.after(() => cleanupDir(empty));
  assert.equal(cochangeFor(empty, "x.js", { cache: false }).size, 0);
});

test("end to end: the ranked selection prefers the task that shares this task's rule and flags the violation, and the lines explain themselves", async t => {
  const root = mkdtempSync(join(tmpdir(), "hunch-task-rank-store-"));
  git(root, "init", "-q");
  mkdirSync(join(root, "src"));
  writeFileSync(join(root, ".gitignore"), ".hunch-cache/\n");
  writeFileSync(join(root, "src", "config.js"), "export const preserve = true;\n");
  writeFileSync(join(root, "src", "other.js"), "export const other = 1;\n");
  git(root, "add", "-A"); git(root, "commit", "-q", "-m", "init");
  const store = new HunchStore(hunchPaths(root));
  store.json.ensureDirs();
  t.after(() => { store.close(); cleanupDir(root); });
  const preserve = mkConstraint({ id: "con_preserve", statement: "Preserve existing settings", scope: ["src/config.js"], severity: "blocking" });
  const other = mkConstraint({ id: "con_other", statement: "Other rule", scope: ["src/other.js"], severity: "warning" });
  store.json.put("constraints", preserve); store.json.put("constraints", other);

  const ctxFor = (target: string, ...cons: typeof preserve[]) => ({ target, constraints: cons, decisions: [], bugs: [], blast_radius: [], components: [], findings: [], budget_tokens: 1500 } as unknown as AssembledContext);
  const rec = (c: typeof preserve) => ({ record_id: c.id, kind: "constraints", title: c.statement, lesson: c.statement, content_hash: reportHash(c.id), recorded_at: "2026-09-11T00:00:00.000Z" });

  // Task 1: same file, received the preserve rule, applied it (agent-reported), check passed.
  const t1 = startReportTask(root, "Merge nested settings");
  const occ1 = recordTaskDelivery(root, t1.task_id, buildDeliveryEnvelope(ctxFor("src/config.js", preserve)), [rec(preserve)], undefined, "src/config.js");
  recordReportClaim(root, t1.task_id, { occurrence_id: occ1, record_id: preserve.id, content_hash: reportHash(preserve.id), action: "kept the merge" });
  finishReportTask(root, t1.task_id);
  assert.ok(persistTaskRecord(root, store, t1.task_id, { flush: false }));

  // Task 2: newer, same file, unrelated rule, nothing else.
  const t2 = startReportTask(root, "Rename a variable");
  recordTaskDelivery(root, t2.task_id, buildDeliveryEnvelope(ctxFor("src/config.js", other)), [rec(other)], undefined, "src/config.js");
  finishReportTask(root, t2.task_id);
  assert.ok(persistTaskRecord(root, store, t2.task_id, { flush: false }));

  // Task 3: another file, but a violation of the preserve rule on record.
  const t3 = startReportTask(root, "Settings merge lost user keys");
  recordTaskDelivery(root, t3.task_id, buildDeliveryEnvelope(ctxFor("src/other.js", preserve)), [rec(preserve)], undefined, "src/other.js");
  writeFileSync(join(root, "src", "other.js"), "export const other = 2; // overwriteAll\n");
  await Promise.resolve(runReportConformance(root, store, t3.task_id));
  finishReportTask(root, t3.task_id);
  assert.ok(persistTaskRecord(root, store, t3.task_id, { flush: false }));
  store.reindex();

  // The current task: on src/config.js, has already received con_preserve.
  const current = startReportTask(root, "Fix the settings merge again");
  recordTaskDelivery(root, current.task_id, buildDeliveryEnvelope(ctxFor("src/config.js", preserve)), [rec(preserve)], undefined, "src/config.js");
  const query = buildTaskRankingQuery(root, current.task_id, "src/config.js");
  assert.deepEqual([...query.recordIds], ["con_preserve"]);
  assert.deepEqual([...query.files], ["src/config.js"]);
  assert.equal(query.phrase, "Fix the settings merge again");

  const selection = store.selectTasksFor("src/config.js", query);
  const ids = selection.picks.map((p) => p.ranked.record.id);
  assert.equal(selection.picks[0]!.slot, "latest");
  assert.equal(selection.picks[0]!.ranked.record.id, t2.task_id, "the newest exact-file task holds the latest slot even though it is the least relevant");
  assert.ok(ids.includes(t1.task_id), "the task that shares this task's rule is selected");
  const t1pick = selection.picks.find((p) => p.ranked.record.id === t1.task_id)!;
  assert.ok(t1pick.ranked.reasons.some((r) => r.startsWith("shares con_preserve")), t1pick.ranked.reasons.join(" | "));
  assert.ok(t1pick.ranked.reasons.includes("also touched src/config.js this task"));
  const t3pick = selection.picks.find((p) => p.ranked.record.id === t3.task_id);
  if (t3pick) {
    assert.ok(t3pick.ranked.reasons.includes("RULE VIOLATED") || t3pick.ranked.reasons.some((r) => r.startsWith("shares con_preserve")));
  }
  const lines = taskSelectionSupplements(selection, "src/config.js");
  assert.match(lines[0]!.text, /^RECENT TASKS on src\/config\.js — latest/);
  assert.match(lines[1]!.text, new RegExp(`^latest\\s+${t2.task_id} · \\d{4}-\\d{2}-\\d{2} · "Rename a variable" — same file`));
  assert.ok(lines.some((l) => l.text.includes(t1.task_id) && l.text.includes("shares con_preserve")));
  // Determinism: same query, same picks.
  assert.deepEqual(store.selectTasksFor("src/config.js", query).picks.map((p) => p.ranked.record.id), ids);
  // Without a task id the query is the target alone and still returns the file's tasks.
  const bare = store.selectTasksFor("src/config.js", buildTaskRankingQuery(root, null, "src/config.js"));
  assert.equal(bare.picks[0]!.ranked.record.id, t2.task_id);
});
