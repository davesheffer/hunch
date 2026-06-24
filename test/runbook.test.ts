import { test } from "node:test";
import assert from "node:assert/strict";
import { tempStore, prov } from "./helpers.js";
import { runbookId } from "../src/core/ids.js";
import { evaluateRetrieval } from "../src/eval/harness.js";

const RB = (task: string, over: Record<string, unknown> = {}) => ({
  id: runbookId(task), task, trigger: [task], steps: [], files: [], gotchas: [], outcome: "",
  source_range: null, valid_from: "2026-01-01T00:00:00Z", valid_to: null,
  provenance: prov(0.5), date: "2026-01-01T00:00:00Z", ...over,
});

test("runbook: stored, recs round-trips, reindex counts it", (t) => {
  const { store, cleanup } = tempStore();
  t.after(cleanup);
  store.json.put("runbooks", RB("add an MCP tool", { steps: ["edit server.ts", "add schema"], files: ["src/mcp/server.ts"] }) as never);
  assert.equal(store.recs("runbooks").length, 1);
  assert.equal(store.recs("runbooks")[0]!.task, "add an MCP tool");
  assert.equal(store.reindex().counts.runbooks, 1);
});

test("runbook: retrievable via FTS + hybridSearch (rides the unified index), tagged kind=runbooks", async (t) => {
  const { store, cleanup } = tempStore();
  t.after(cleanup);
  const id = runbookId("cut a release");
  store.json.put("runbooks", RB("cut a release", { steps: ["bump version", "gh release create"], outcome: "npm publishes" }) as never);
  store.reindex();
  assert.ok(store.search("release version", 12).some((h) => h.ref === id), "FTS finds the runbook");
  assert.ok((await store.hybridSearch("release version", 12)).some((h) => h.ref === id), "hybridSearch surfaces it");
  assert.equal(store.search("release", 12).find((h) => h.ref === id)?.kind, "runbooks");
});

test("runbook: id is idempotent per task (re-capture overwrites, never duplicates)", (t) => {
  const { store, cleanup } = tempStore();
  t.after(cleanup);
  store.json.put("runbooks", RB("Add A Guard") as never);
  store.json.put("runbooks", RB("add a guard") as never); // case/space variant of the same task
  assert.equal(store.recs("runbooks").length, 1);
});

test("runbook eval gate: a task query retrieves the answering runbook (Recall@k)", async (t) => {
  const { store, cleanup } = tempStore();
  t.after(cleanup);
  const id = runbookId("how to add a redundancy guard");
  store.json.put("runbooks", RB("how to add a redundancy guard", {
    steps: ["add CheckRedundant", "wire into checkreport"], files: ["src/core/checkreport.ts"],
    trigger: ["redundancy guard", "sprawl detection"],
  }) as never);
  store.reindex();
  const m = await evaluateRetrieval(store, [{ query: "redundancy guard sprawl", expected: [id] }], { k: 10 });
  assert.equal(m.recallAtK, 1, "the eval harness can score runbook retrieval — the measurement gate is wired");
});
