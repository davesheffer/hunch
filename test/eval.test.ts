import { test } from "node:test";
import assert from "node:assert/strict";
import { tempStore, prov } from "./helpers.js";
import { evaluateRetrieval, evaluateGraphLift, loadGoldenSet } from "../src/eval/harness.js";

const SYM = (id: string, name: string, file: string) => ({
  id, file, name, kind: "function", signature_hash: "sha1:test",
  calls: [], called_by: [],
  metrics: { loc: 1, churn_90d: 0, bug_count: 0, fan_in: 0, fan_out: 0 },
  last_changed: "commit:test",
});
const EDGE = (from: string, to: string) => ({
  id: `edge_${from}_${to}`, from, to, type: "calls",
  reason: `${from} calls ${to}`, strength: 0.8, provenance: prov(0.8),
});

/** alpha (lexically findable) → beta (reachable ONLY via the 1-hop graph). */
function graphStore() {
  const ctx = tempStore();
  ctx.store.json.put("symbols", SYM("sym_alpha", "alphazoomwidget", "src/a.ts") as never);
  ctx.store.json.put("symbols", SYM("sym_beta", "betaquuxhandler", "src/b.ts") as never);
  ctx.store.json.put("edges", EDGE("sym_alpha", "sym_beta") as never);
  ctx.store.reindex();
  return ctx;
}

test("eval harness: measures the graph-stream recall lift on a neighbor-only case", async (t) => {
  const { store, cleanup } = graphStore();
  t.after(cleanup);
  const cases = [{ query: "alphazoomwidget", expected: ["sym_beta"] }]; // beta only via the hop
  const off = await evaluateRetrieval(store, cases, { k: 10, graphWeight: 0 });
  const on = await evaluateRetrieval(store, cases, { k: 10 });
  assert.equal(off.recallAtK, 0, "graph OFF cannot reach the neighbor");
  assert.equal(on.recallAtK, 1, "graph ON surfaces the neighbor");
  assert.ok(on.mrr > off.mrr, "MRR improves with the graph stream");
});

test("eval harness: evaluateGraphLift reports a positive delta on a neighbor-only case", async (t) => {
  const { store, cleanup } = graphStore();
  t.after(cleanup);
  const lift = await evaluateGraphLift(store, [{ query: "alphazoomwidget", expected: ["sym_beta"] }], { k: 10 });
  assert.ok(lift.recallDelta > 0, "graph lift is positive");
  assert.equal(lift.on.n, 1);
});

test("eval harness: a self-retrieval case scores recall 1 regardless of the graph", async (t) => {
  const { store, cleanup } = graphStore();
  t.after(cleanup);
  const lift = await evaluateGraphLift(store, [{ query: "alphazoomwidget", expected: ["sym_alpha"] }], { k: 10 });
  assert.equal(lift.off.recallAtK, 1);
  assert.equal(lift.on.recallAtK, 1, "the graph stream never displaces a direct lexical hit");
});

test("loadGoldenSet: validates shape", () => {
  assert.throws(() => loadGoldenSet(JSON.stringify([{ query: "x" }])), /expected/);
  assert.throws(() => loadGoldenSet(JSON.stringify({ not: "array" })), /array/);
  const ok = loadGoldenSet(JSON.stringify([{ query: "q", expected: ["a", "b"], note: "n" }]));
  assert.equal(ok.length, 1);
  assert.deepEqual(ok[0]!.expected, ["a", "b"]);
});
