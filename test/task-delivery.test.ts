import { test } from "node:test";
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { buildDeliveryEnvelope } from "../src/core/delivery.js";
import { describeTaskRecord, taskSupplements } from "../src/core/taskDelivery.js";
import { finishReportTask, recordTaskDelivery, reportHash, startReportTask } from "../src/core/taskReport.js";
import { persistTaskRecord } from "../src/core/taskRecord.js";
import { TaskRecordSchema, type TaskRecord } from "../src/core/types.js";
import { HunchStore, type AssembledContext } from "../src/store/hunchStore.js";
import { hunchPaths } from "../src/core/paths.js";
import { mkSymbol } from "./helpers.js";

function taskRecord(over: Partial<TaskRecord> & { id: string; finished_at: string }): TaskRecord {
  return TaskRecordSchema.parse({
    title: `Task ${over.id}`, state: "completed", started_at: over.finished_at, coverage: "delivered",
    lessons: [{ kind: "constraints", record_id: "con_preserve", content_hash: reportHash("rev"), title: "Preserve existing settings" }],
    checks: [{ label: "npm test", state: "passed", exit_code: 0 }],
    files: ["src/config.js"], report_hash: reportHash(over.id),
    provenance: { source: "task_report", confidence: 1, evidence: [] },
    ...over,
  });
}

test("recent-task supplements: newest first, bounded, one line per task, nothing when empty", () => {
  assert.deepEqual(taskSupplements([], "src/config.js"), []);
  const tasks = [
    taskRecord({ id: "htask_000000000000000000000001", finished_at: "2026-09-10T00:00:00.000Z" }),
    taskRecord({ id: "htask_000000000000000000000002", finished_at: "2026-09-14T00:00:00.000Z", applied: [{ record_id: "con_preserve", content_hash: reportHash("rev"), action: "kept the merge", supported_by: "hev_000000000000000000000001" }], conformance: [{ kind: "constraints", record_id: "con_preserve", content_hash: reportHash("rev"), outcome: "violated" }] }),
    taskRecord({ id: "htask_000000000000000000000003", finished_at: "2026-09-12T00:00:00.000Z", saved: [{ kind: "decisions", record_id: "dec_x", content_hash: reportHash("d"), home: "public", operation: "created", durability: "committed" }] }),
    taskRecord({ id: "htask_000000000000000000000004", finished_at: "2026-09-11T00:00:00.000Z" }),
  ];
  const sup = taskSupplements(tasks, "src/config.js");
  assert.equal(sup.length, 4, "one header plus three tasks");
  assert.equal(sup[0]!.kind, "recent-tasks");
  assert.match(sup[0]!.text, /1 older task\(s\) not shown/);
  assert.deepEqual(sup.slice(1).map(s => s.id), ["htask_000000000000000000000002", "htask_000000000000000000000003", "htask_000000000000000000000004"]);
  assert.ok(sup[1]!.priority! > sup[2]!.priority! && sup[2]!.priority! > sup[3]!.priority!, "priorities keep the order");
  const line = describeTaskRecord(tasks[1]!);
  assert.match(line, /applied 1 \(rule-supported\)/);
  assert.match(line, /RULE VIOLATED/);
  assert.match(line, /check "npm test" passed/);
  assert.match(describeTaskRecord(tasks[2]!), /saved dec_x/);
  assert.doesNotMatch(line, /\n/, "single line");
});

test("recent tasks reach the delivered brief as supplements next to the invariants", () => {
  const ctx = { target: "src/config.js", constraints: [], decisions: [], bugs: [], blast_radius: [], components: [], findings: [], budget_tokens: 1500 } as unknown as AssembledContext;
  ctx.constraints.push({ id: "con_preserve", type: "architecture", statement: "Preserve existing settings", scope: ["src/config.js"], severity: "blocking", enforcement: "advisory_v1", match: null, forbids: null, rationale: "", source_decision: null, violations: [], status: "active", valid_from: "2026-09-11T00:00:00.000Z", valid_to: null, provenance: { source: "human_confirmed", confidence: 1, evidence: [] } });
  const sup = taskSupplements([taskRecord({ id: "htask_000000000000000000000009", finished_at: "2026-09-14T00:00:00.000Z" })], "src/config.js");
  const envelope = buildDeliveryEnvelope(ctx, { supplements: sup });
  assert.match(envelope.text, /supplemental\/recent-tasks \| RECENT TASKS on src\/config\.js/);
  assert.match(envelope.text, /supplemental\/recent-task \| htask_000000000000000000000009/);
  assert.ok(envelope.supplements.filter(s => s.kind.startsWith("recent-task")).every(s => s.delivered), "delivered within budget");
  assert.equal(envelope.delivered.some(d => d.kind === ("tasks" as string)), false, "tasks are supplements, never ranked memory records");
});

test("a persisted task is found for its file and delivered on the next context request", t => {
  const root = mkdtempSync(join(tmpdir(), "hunch-task-delivery-"));
  execFileSync("git", ["init", "-q", root]);
  mkdirSync(join(root, "src"));
  writeFileSync(join(root, ".gitignore"), ".hunch-cache/\n");
  writeFileSync(join(root, "src", "config.js"), "export const preserve = true;\n");
  const store = new HunchStore(hunchPaths(root));
  store.json.ensureDirs();
  t.after(() => { store.close(); rmSync(root, { recursive: true, force: true, maxRetries: 5, retryDelay: 50 }); });
  const ctx = { target: "src/config.js", constraints: [], decisions: [], bugs: [], blast_radius: [], components: [], findings: [], budget_tokens: 1500 } as unknown as AssembledContext;
  ctx.constraints.push({ id: "con_preserve", type: "architecture", statement: "Preserve existing settings", scope: ["src/config.js"], severity: "blocking", enforcement: "advisory_v1", match: null, forbids: null, rationale: "", source_decision: null, violations: [], status: "active", valid_from: "2026-09-11T00:00:00.000Z", valid_to: null, provenance: { source: "human_confirmed", confidence: 1, evidence: [] } });
  const record = { record_id: "con_preserve", kind: "constraints", title: "Preserve existing settings", lesson: "Merge settings.", content_hash: reportHash("fixture record revision"), recorded_at: "2026-09-11T00:00:00.000Z" };
  const task = startReportTask(root, "Earlier settings work");
  recordTaskDelivery(root, task.task_id, buildDeliveryEnvelope(ctx), [record], undefined, "src/config.js");
  finishReportTask(root, task.task_id);
  assert.ok(persistTaskRecord(root, store, task.task_id, { flush: false }));
  const found = store.tasksFor("src/config.js", 3);
  assert.deepEqual(found.map(r => r.id), [task.task_id]);
  const next = buildDeliveryEnvelope(ctx, { supplements: taskSupplements(found, "src/config.js") });
  assert.match(next.text, new RegExp(`${task.task_id} · \\d{4}-\\d{2}-\\d{2} · completed · "Earlier settings work"`));
  assert.equal(store.tasksFor("src/other.js").length, 0, "unrelated files see nothing");
});

test("tasksFor rewrites an absolute target to repo-relative and never suffix-leaks an unrelated same-basename file (issue #299)", () => {
  const root = mkdtempSync(join(tmpdir(), "hunch-task-delivery-"));
  const store = new HunchStore(hunchPaths(root));
  store.json.ensureDirs();
  try {
    // A real indexed symbol at the target file — the same "is this path known to
    // the index" question tasksFor now answers the same way why() does.
    store.json.put("symbols", mkSymbol("sym_auth", "src/auth/session.ts", "verifySession") as never);
    store.json.put("tasks", taskRecord({ id: "htask_000000000000000000000010", finished_at: "2026-09-15T00:00:00.000Z", files: ["session.ts"] }));
    store.json.put("tasks", taskRecord({ id: "htask_000000000000000000000011", finished_at: "2026-09-16T00:00:00.000Z", files: ["src/auth/session.ts"] }));
    const abs = join(root, "src", "auth", "session.ts");
    assert.deepEqual(
      store.tasksFor(abs).map((r) => r.id),
      ["htask_000000000000000000000011"],
      "must resolve the absolute target's own task, never the unrelated root-level same-basename file",
    );
  } finally {
    store.close();
    rmSync(root, { recursive: true, force: true, maxRetries: 5, retryDelay: 50 });
  }
});

test("tasksFor: a REAL working-tree file the index cannot see must not suffix-leak a nested same-basename file's tasks (issue #334)", () => {
  const root = mkdtempSync(join(tmpdir(), "hunch-task-delivery-real-"));
  const store = new HunchStore(hunchPaths(root));
  store.json.ensureDirs();
  try {
    // A comment-only root file: zero tree-sitter symbols and no covering component,
    // so graph data alone calls it unreal and the suffix tier would serve
    // a/empty.ts's task. The working tree is the last-resort answer.
    mkdirSync(join(root, "a"), { recursive: true });
    writeFileSync(join(root, "empty.ts"), "// only a comment — no symbols at all\n");
    writeFileSync(join(root, "a", "empty.ts"), "export function nestedEmpty(){ return 1; }\n");
    store.json.put("tasks", taskRecord({ id: "htask_000000000000000000000012", finished_at: "2026-09-16T00:00:00.000Z", files: ["a/empty.ts"] }));
    assert.deepEqual(store.tasksFor("empty.ts").map((r) => r.id), [], "the real root file inherits nothing");
    assert.deepEqual(store.tasksFor("a/empty.ts").map((r) => r.id), ["htask_000000000000000000000012"], "the nested file still answers for itself");
  } finally {
    store.close();
    rmSync(root, { recursive: true, force: true, maxRetries: 5, retryDelay: 50 });
  }
});
