/**
 * Multi-candidate verdict (roadmap addendum, "evaluate 5 solutions"). Given several
 * candidate refs (branches/commits — e.g. N agent-generated solutions to one task),
 * replay each one's diff against the graph via the SAME deterministic merge-verdict
 * (buildCheckReport + verdict) and RANK them: the candidate that fits the architecture
 * best is the one that trips the fewest in-force invariants, reverses no decisions, and
 * adds the least sprawl. No model in the ranking — it's set-intersection over the graph.
 */
import type { HunchStore } from "../store/hunchStore.js";
import { verdict } from "./checkreport.js";
import { revExists, rangeFiles, rangeGateDiff } from "../extractors/git.js";

export interface CandidateResult {
  ref: string;
  verdict: "block" | "warn" | "pass";
  blocking: number; // strictBlockers + regBlocking + vetoBlocking — the fail-the-merge count
  direct: number;
  near: number;
  vetoes: number;
  redundant: number;
  files: number;
  error?: string; // ref missing / empty diff
}

/** A lower fit score is better. Verdict dominates (pass < warn < block), then the
 *  blocking count, then total advisory hits. Errored candidates sort last. */
function fitKey(c: CandidateResult): [number, number, number] {
  const tier = c.error ? 9 : c.verdict === "pass" ? 0 : c.verdict === "warn" ? 1 : 2;
  return [tier, c.blocking, c.direct + c.near + c.vetoes + c.redundant];
}

export function compareCandidates(store: HunchStore, root: string, base: string, candidates: string[]): CandidateResult[] {
  const results = candidates.map((ref): CandidateResult => {
    const zero = { ref, verdict: "block" as const, blocking: 0, direct: 0, near: 0, vetoes: 0, redundant: 0, files: 0 };
    if (!revExists(ref, root)) return { ...zero, error: `ref "${ref}" not found` };
    const files = rangeFiles(base, root, ref);
    if (!files.length) return { ...zero, verdict: "pass", error: `no changes vs ${base}` };
    const gate = rangeGateDiff(base, root, ref);
    const r = store.buildCheckReport(files, gate.diff, { strict: true, diffStatus: gate });
    return {
      ref,
      verdict: verdict(r),
      blocking: r.strictBlockers + r.regBlocking + r.vetoBlocking,
      direct: r.direct.length,
      near: r.near.length,
      vetoes: r.vetoes.length,
      redundant: r.redundant.length,
      files: files.length,
    };
  });
  return results.sort((a, b) => {
    const [at, ab, ah] = fitKey(a);
    const [bt, bb, bh] = fitKey(b);
    return at - bt || ab - bb || ah - bh;
  });
}
