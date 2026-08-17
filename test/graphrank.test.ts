import { test } from "node:test";
import assert from "node:assert/strict";
import { tempStore, prov } from "./helpers.js";

/** Minimal symbol record (mirrors the indexer's shape) for graph-stream tests. */
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

test("graph stream: a 1-hop dependency neighbor surfaces via hybridSearch though pure FTS misses it (roadmap #1)", async (t) => {
  const { store, cleanup } = tempStore();
  t.after(cleanup);
  // Disjoint names so a keyword query for one can't lexically match the other.
  store.json.put("symbols", SYM("sym_alpha", "alphazoomwidget", "src/a.ts") as never);
  store.json.put("symbols", SYM("sym_beta", "betaquuxhandler", "src/b.ts") as never);
  store.json.put("edges", EDGE("sym_alpha", "sym_beta") as never); // alpha → beta dependency
  store.reindex();

  // precondition: keyword search reaches the seed, never the neighbor.
  const fts = store.search("alphazoomwidget", 12).map((h) => h.ref);
  assert.ok(fts.includes("sym_alpha"), "fts finds the queried symbol");
  assert.ok(!fts.includes("sym_beta"), "fts cannot reach the neighbor lexically");

  // the graph stream expands 1 hop and surfaces the neighbor — no embeddings needed.
  const hits = (await store.hybridSearch("alphazoomwidget", 12)).map((h) => h.ref);
  assert.ok(hits.includes("sym_alpha"), "seed still present after fusion");
  assert.ok(hits.includes("sym_beta"), "1-hop neighbor surfaced via the graph stream");
});

test("graph stream: a hop also walks BACKWARD (a caller of the seed surfaces)", async (t) => {
  const { store, cleanup } = tempStore();
  t.after(cleanup);
  store.json.put("symbols", SYM("sym_caller", "outerzappframe", "src/c.ts") as never);
  store.json.put("symbols", SYM("sym_target", "innerblorptask", "src/d.ts") as never);
  store.json.put("edges", EDGE("sym_caller", "sym_target") as never); // caller → target
  store.reindex();

  const hits = (await store.hybridSearch("innerblorptask", 12)).map((h) => h.ref);
  assert.ok(hits.includes("sym_caller"), "the seed's caller surfaced via a backward 1-hop");
});

test("graph stream: bounded traversal reaches a relevant 2-hop symbol that a 1-hop baseline misses", async (t) => {
  const { store, cleanup } = tempStore();
  t.after(cleanup);
  store.json.put("symbols", SYM("sym_alpha", "alphazoomwidget", "src/a.ts") as never);
  store.json.put("symbols", SYM("sym_beta", "betaquuxhandler", "src/b.ts") as never);
  store.json.put("symbols", SYM("sym_gamma", "gammaneedleworker", "src/c.ts") as never);
  store.json.put("edges", EDGE("sym_alpha", "sym_beta") as never);
  store.json.put("edges", EDGE("sym_beta", "sym_gamma") as never);
  store.reindex();

  const oneHop = (await store.hybridSearch("alphazoomwidget", 12, { graphDepth: 1 })).map((h) => h.ref);
  const bounded = (await store.hybridSearch("alphazoomwidget", 12)).map((h) => h.ref);
  assert.ok(!oneHop.includes("sym_gamma"), "the 1-hop baseline cannot reach gamma");
  assert.ok(bounded.includes("sym_gamma"), "the shipped bounded traversal reaches gamma at depth 2");
});

test("graph stream: depth decays support while multiple paths strengthen a 2-hop result", async (t) => {
  const { store, cleanup } = tempStore();
  t.after(cleanup);
  for (const [id, name] of [
    ["sym_seed", "pathrankseed"],
    ["sym_direct_a", "directanode"],
    ["sym_direct_b", "directbnode"],
    ["sym_shared", "sharedtwopathnode"],
    ["sym_single", "singlepathnode"],
  ]) store.json.put("symbols", SYM(id, name, `src/${id}.ts`) as never);
  store.json.put("edges", EDGE("sym_seed", "sym_direct_a") as never);
  store.json.put("edges", EDGE("sym_seed", "sym_direct_b") as never);
  store.json.put("edges", EDGE("sym_direct_a", "sym_shared") as never);
  store.json.put("edges", EDGE("sym_direct_b", "sym_shared") as never);
  store.json.put("edges", EDGE("sym_direct_a", "sym_single") as never);
  store.reindex();

  const refs = (await store.hybridSearch("pathrankseed", 12)).map((h) => h.ref);
  assert.ok(refs.indexOf("sym_direct_a") < refs.indexOf("sym_shared"), "one hop outranks a deeper result");
  assert.ok(refs.indexOf("sym_shared") < refs.indexOf("sym_single"), "two supporting paths outrank one at equal depth");
});

test("graph stream: same-layer neighbors do not give each other order-dependent deeper support", async (t) => {
  const { store, cleanup } = tempStore();
  t.after(cleanup);
  for (const [id, name] of [
    ["sym_seed", "layerorderseed"],
    ["sym_alpha", "layeralphanode"],
    ["sym_beta", "layerbetanode"],
  ]) store.json.put("symbols", SYM(id, name, `src/${id}.ts`) as never);
  store.json.put("edges", EDGE("sym_seed", "sym_alpha") as never);
  store.json.put("edges", EDGE("sym_seed", "sym_beta") as never);
  store.json.put("edges", EDGE("sym_alpha", "sym_beta") as never);
  store.reindex();

  const refs = (await store.hybridSearch("layerorderseed", 12)).map((h) => h.ref);
  assert.ok(
    refs.indexOf("sym_alpha") < refs.indexOf("sym_beta"),
    "equal-support same-layer nodes retain the stable ref tie-break instead of crediting traversal order",
  );
});

test("graph stream: node and token caps are hard limits on added context", async (t) => {
  const { store, cleanup } = tempStore();
  t.after(cleanup);
  store.json.put("symbols", SYM("sym_seed", "uniqueseedtoken", "src/seed.ts") as never);
  for (const id of ["a", "b", "c"]) {
    store.json.put("symbols", SYM(`sym_${id}`, `neighbor${id}name`, `src/${id}.ts`) as never);
    store.json.put("edges", EDGE("sym_seed", `sym_${id}`) as never);
  }
  store.reindex();

  const nodeCapped = await store.hybridSearch("uniqueseedtoken", 12, { graphNodeCap: 1 });
  assert.equal(nodeCapped.filter((h) => h.ref !== "sym_seed").length, 1, "only one graph node crosses the node cap");

  const tokenCapped = await store.hybridSearch("uniqueseedtoken", 12, { graphTokenCap: 1 });
  assert.deepEqual(tokenCapped.map((h) => h.ref), ["sym_seed"], "a graph hit larger than the token budget is excluded");
});

test("graph stream: external package hubs are never surfaced or traversed", async (t) => {
  const { store, cleanup } = tempStore();
  t.after(cleanup);
  store.json.put("symbols", SYM("sym_alpha", "alphahubcaller", "src/a.ts") as never);
  store.json.put("symbols", SYM("sym_unrelated", "unrelatedhubcaller", "src/u.ts") as never);
  store.json.put("edges", EDGE("sym_alpha", "ext_shared") as never);
  store.json.put("edges", EDGE("sym_unrelated", "ext_shared") as never);
  store.reindex();

  const hits = (await store.hybridSearch("alphahubcaller", 12)).map((h) => h.ref);
  assert.ok(!hits.includes("ext_shared"), "an unindexed external package is not context");
  assert.ok(!hits.includes("sym_unrelated"), "the traversal cannot fan out through a shared package hub");
});

test("graph stream: no edges ⇒ hybridSearch equals pure FTS (no spurious neighbors)", async (t) => {
  const { store, cleanup } = tempStore();
  t.after(cleanup);
  store.json.put("symbols", SYM("sym_lonely", "solofuncname", "src/e.ts") as never);
  store.reindex();

  const fts = store.search("solofuncname", 12).map((h) => h.ref);
  const hits = (await store.hybridSearch("solofuncname", 12)).map((h) => h.ref);
  assert.deepEqual(hits, fts, "with no graph signal the fast path returns pure FTS");
});
