/**
 * Deterministic retrieval eval (roadmap #2). Scores `hybridSearch` against a curated
 * golden set of "why" questions by EXACT ref match — Recall@k + MRR — with no LLM in
 * the scoring path, so it runs as a stable, reproducible CI signal. The `graphWeight`
 * knob lets ONE store be scored graph-OFF (0) vs graph-ON to measure the dependency-
 * graph stream's lift — the measurement gate for the graph-RRF decision.
 */
import type { HunchStore, SearchHit } from "../store/hunchStore.js";
import type { Embedder } from "../store/embedder.js";

export interface EvalCase {
  query: string;
  expected: string[]; // record refs (ids) that SHOULD surface in the top-k
  note?: string;
}

export interface CaseResult {
  query: string;
  expected: number;
  found: number; // expected refs present in the top-k
  recall: number; // found / expected
  rr: number; // reciprocal rank of the FIRST expected hit (0 if none)
}

export interface EvalMetrics {
  n: number; // number of cases scored
  k: number;
  recallAtK: number; // mean per-case recall
  mrr: number; // mean reciprocal rank
  hitRate: number; // fraction of cases with >= 1 expected hit
  perCase: CaseResult[];
}

export interface EvalOpts {
  k?: number;
  embedder?: Embedder | null; // omit -> deterministic FTS+graph (no semantic) for CI
  graphWeight?: number; // 0 disables the graph stream (A/B the lift)
}

/** Score a golden set: Recall@k, MRR, hit-rate. Deterministic when no embedder. */
export async function evaluateRetrieval(store: HunchStore, cases: EvalCase[], opts: EvalOpts = {}): Promise<EvalMetrics> {
  const k = opts.k ?? 10;
  const perCase: CaseResult[] = [];
  for (const c of cases) {
    const hits = await store.hybridSearch(c.query, k, { embedder: opts.embedder, graphWeight: opts.graphWeight });
    const top = hits.slice(0, k).map((h: SearchHit) => h.ref);
    const expected = new Set(c.expected);
    let found = 0;
    let rr = 0;
    top.forEach((ref, i) => {
      if (!expected.has(ref)) return;
      found++;
      if (rr === 0) rr = 1 / (i + 1); // first expected hit sets the reciprocal rank
    });
    perCase.push({
      query: c.query,
      expected: c.expected.length,
      found,
      recall: c.expected.length ? found / c.expected.length : 0,
      rr,
    });
  }
  const n = perCase.length || 1;
  return {
    n: perCase.length,
    k,
    recallAtK: perCase.reduce((s, r) => s + r.recall, 0) / n,
    mrr: perCase.reduce((s, r) => s + r.rr, 0) / n,
    hitRate: perCase.reduce((s, r) => s + (r.found > 0 ? 1 : 0), 0) / n,
    perCase,
  };
}

/** Compare graph-OFF vs graph-ON on the same golden set — the #1 lift measurement. */
export async function evaluateGraphLift(
  store: HunchStore,
  cases: EvalCase[],
  opts: EvalOpts = {},
): Promise<{ off: EvalMetrics; on: EvalMetrics; recallDelta: number; mrrDelta: number }> {
  const off = await evaluateRetrieval(store, cases, { ...opts, graphWeight: 0 });
  // graphWeight undefined -> hybridSearch uses the configured default; an explicit
  // value tunes it. Either way "on" is whatever ships, "off" is the baseline.
  const on = await evaluateRetrieval(store, cases, opts);
  return { off, on, recallDelta: on.recallAtK - off.recallAtK, mrrDelta: on.mrr - off.mrr };
}

/** Parse + validate a golden-set JSON string (array of {query, expected[]}). */
export function loadGoldenSet(raw: string): EvalCase[] {
  const data = JSON.parse(raw);
  if (!Array.isArray(data)) throw new Error("golden set must be a JSON array of { query, expected[] }");
  return data.map((c, i) => {
    if (!c || typeof c.query !== "string" || !Array.isArray(c.expected))
      throw new Error(`golden case ${i} must be { query: string, expected: string[] }`);
    return { query: c.query, expected: c.expected.map(String), note: typeof c.note === "string" ? c.note : undefined };
  });
}
