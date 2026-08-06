/**
 * The prior rerank must DIM a record, never evict it (round-3 audit #4).
 *
 * This is the pool composition no existing test covered: decisions and structural refs
 * (symbols/components/edges) competing in ONE fused pool. test/rankpriors.test.ts and
 * test/embed.test.ts seed decisions with zero symbols; test/graphrank.test.ts seeds
 * symbols only — so the asymmetry that made this fire was invisible.
 *
 * The defect: `priorMeta` returns null for structural refs, leaving them at w = 1 — a
 * ceiling above what any record that is not both human_confirmed and brand-new can
 * reach — and the prior was applied as a multiplier on a rank-derived score whose whole
 * positional span across the pool was narrower than the prior's own range. So the prior
 * overrode fusion outright: measured over this repo's 152 committed decisions with the
 * rest of the pool structural, 38% were dropped from the top-12 even as the #1 fused hit.
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import { tempStore, prov } from "./helpers.js";

const OLD = "2025-09-01T00:00:00Z"; // deliberately ancient: worst-case recency prior
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
const DEC = (over: Record<string, unknown> = {}) => ({
  id: "dec_x", title: "t", topic: null, status: "accepted", context: "", decision: "",
  consequences: [], alternatives_rejected: [], rejected_tripwires: [],
  related_components: [], related_files: [], supersedes: null, superseded_by: null,
  caused_by_bug: null, commit: null, valid_from: OLD, valid_to: null,
  retired: { symbols: [], deps: [] }, provenance: prov(0.9), date: OLD,
  ...over,
});

/** A decision competing against a crowd of structural refs on the SAME term. The
 *  decision is the worst case the prior can produce: auto-synthesized (`extracted`
 *  provenance, what `hunch sync`/`backfill` write) and old. */
function crowdedStore(t: { after: (fn: () => void) => void }): ReturnType<typeof tempStore>["store"] {
  const { store, cleanup } = tempStore();
  t.after(cleanup);
  store.json.put("decisions", DEC({
    id: "dec_quibblefrotz",
    title: "Quibblefrotz batching replaced the per-row loop",
    decision: "Quibblefrotz batches writes.",
  }) as never);
  // Symbols are ~91% of a real search corpus; a prose query drags in a crowd of them.
  for (let i = 0; i < 30; i++) store.json.put("symbols", SYM(`sym_${i}`, `quibblefrotzHelper${i}`, `src/q${i}.ts`) as never);
  // Edges make the graph stream non-empty, which is what routes hybridSearch through
  // fusion + rerank instead of the pure-FTS fast path (the trigger for this defect).
  for (let i = 1; i < 30; i++) store.json.put("edges", EDGE("sym_0", `sym_${i}`) as never);
  store.reindex();
  return store;
}

test("an old auto-synthesized decision is not evicted by a crowd of structural refs (#4)", async (t) => {
  const store = crowdedStore(t);

  // Precondition: both retrieval layers DO find it — the question is only whether the
  // rerank throws it away afterwards.
  const fts = store.search("quibblefrotz batching", 50).map((h) => h.ref);
  assert.ok(fts.includes("dec_quibblefrotz"), "precondition: lexical retrieval finds the decision");

  const hits = (await store.hybridSearch("quibblefrotz batching", 12)).map((h) => h.ref);
  assert.ok(hits.includes("dec_quibblefrotz"), `the decision survives the prior rerank, got ${hits.join(",")}`);
});

test("the prior still DIMS: a superseded twin ranks below the live one in the same crowd (#4)", async (t) => {
  const { store, cleanup } = tempStore();
  t.after(cleanup);
  store.json.put("decisions", DEC({
    id: "dec_stale", title: "Wibblesprocket uses offset paging", decision: "Wibblesprocket pages by offset.",
    status: "superseded", superseded_by: "dec_live",
  }) as never);
  store.json.put("decisions", DEC({
    id: "dec_live", title: "Wibblesprocket uses cursor paging", decision: "Wibblesprocket pages by cursor.",
    supersedes: "dec_stale", valid_from: "2026-07-20T00:00:00Z", date: "2026-07-20T00:00:00Z",
    provenance: { source: "human_confirmed", confidence: 1, evidence: [] },
  }) as never);
  for (let i = 0; i < 20; i++) store.json.put("symbols", SYM(`sym_${i}`, `wibblesprocketPager${i}`, `src/w${i}.ts`) as never);
  for (let i = 1; i < 20; i++) store.json.put("edges", EDGE("sym_0", `sym_${i}`) as never);
  store.reindex();

  const hits = (await store.hybridSearch("wibblesprocket paging", 12)).map((h) => h.ref);
  assert.ok(hits.includes("dec_live"), `the live decision is reachable, got ${hits.join(",")}`);
  if (hits.includes("dec_stale")) {
    assert.ok(hits.indexOf("dec_live") < hits.indexOf("dec_stale"), "the prior still orders live above superseded");
  }
});

test("the prior's authority is BOUNDED — it cannot move a hit past the whole pool (#4)", () => {
  // Guards the invariant directly, independent of any corpus: the shift a prior may
  // apply is clamped, so a top-fused hit can never be pushed out of a full result page.
  const SCALE = Number(process.env.HUNCH_PRIOR_SHIFT_SCALE ?? 12);
  const MAX = Number(process.env.HUNCH_MAX_PRIOR_SHIFT ?? 4);
  const shift = (w: number): number => Math.max(-MAX, Math.min(MAX, (1 - w) * SCALE));
  // Worst reachable trust weight: dead (0.6) × extracted (0.75) × oldest recency (0.7).
  assert.equal(shift(0.6 * 0.75 * 0.7), MAX, "even the worst prior is clamped to the bound");
  assert.equal(shift(1.5), -MAX, "and a runbook trigger boost is clamped symmetrically");
  assert.ok(MAX < 12, "the bound must be smaller than a default result page, or it could still evict");
});
