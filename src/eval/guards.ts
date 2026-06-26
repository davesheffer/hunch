/**
 * Guard eval — turn "Hunch catches bad changes" into a MEASURED number.
 *
 * Mirrors the retrieval eval (harness.ts) but scores ENFORCEMENT: each case is a change
 * (changed files + optional diff) with an expected verdict, run through the SAME production
 * path the guards use — `store.buildCheckReport(...) → verdict()` — so the number reflects the
 * real gate, not a re-implementation. The ground-truth-able metrics:
 *   - CAUGHT:          of changes to guarded code, how many the gate surfaced (block OR warn) —
 *                      i.e. nothing slipped silently through. (Of those, how many HARD-block a
 *                      merge depends on firmness/freshness, reported separately.)
 *   - FALSE-POSITIVE:  of UNRELATED changes, how many the gate flagged — lower = safer to enable.
 */
import type { HunchStore } from "../store/hunchStore.js";
import { verdict } from "../core/checkreport.js";
import { pathMatchesGlob } from "../core/glob.js";

/** "catch" = should be surfaced (block OR warn); block/warn/pass = an exact expected verdict. */
export type Expect = "block" | "warn" | "pass" | "catch";

export interface GuardCase {
  name: string;
  files: string[];
  diff?: string; // optional unified diff — for regression/redundancy/veto CONTENT cases
  expect: Expect;
}

export interface GuardEvalResult {
  total: number;
  shouldSurface: number; // cases expecting to be caught (not "pass")
  surfaced: number; //   …of those, got block or warn
  hardBlocked: number; // …of those, got a hard "block" (merge-fail)
  shouldPass: number; //  cases expecting "pass"
  falsePositives: number; // …of those, got block or warn (over-flagged an unrelated change)
  accuracy: number; //    exact-verdict match rate ("catch" matches block|warn)
  perCase: Array<{ name: string; expect: Expect; got: Expect; ok: boolean }>;
}

const surfaced = (v: Expect): boolean => v === "block" || v === "warn";
const matches = (expect: Expect, got: Expect): boolean => (expect === "catch" ? surfaced(got) : got === expect);

/** Parse + validate a hand-authored golden set. */
export function loadGuardCases(json: string): GuardCase[] {
  const raw: unknown = JSON.parse(json);
  if (!Array.isArray(raw)) throw new Error("expected a JSON array of guard cases");
  return raw.map((c, i) => {
    const x = c as Partial<GuardCase>;
    if (!x || typeof x.name !== "string" || !Array.isArray(x.files) || !["block", "warn", "pass", "catch"].includes(x.expect as string)) {
      throw new Error(`case ${i}: need { name, files: [..], expect: "block"|"warn"|"pass"|"catch", diff? }`);
    }
    return { name: x.name, files: x.files as string[], diff: typeof x.diff === "string" ? x.diff : "", expect: x.expect as Expect };
  });
}

/** Score every case through the real guard pipeline. */
export function evalGuards(store: HunchStore, cases: GuardCase[]): GuardEvalResult {
  const now = new Date().toISOString();
  const perCase = cases.map((c) => {
    // Treat each changed file as just-edited (so staleness is decided by the record's own
    // last_verified, exactly as in a live `hunch check --strict`), via the SHARED report builder.
    const got = verdict(store.buildCheckReport(c.files, c.diff ?? "", { strict: true, lastChange: () => now })) as Expect;
    return { name: c.name, expect: c.expect, got, ok: matches(c.expect, got) };
  });
  const shouldSurface = cases.filter((c) => c.expect !== "pass").length;
  const shouldPass = cases.length - shouldSurface;
  return {
    total: cases.length,
    shouldSurface,
    surfaced: perCase.filter((p) => p.expect !== "pass" && surfaced(p.got)).length,
    hardBlocked: perCase.filter((p) => p.expect !== "pass" && p.got === "block").length,
    shouldPass,
    falsePositives: perCase.filter((p) => p.expect === "pass" && surfaced(p.got)).length,
    accuracy: perCase.length ? perCase.filter((p) => p.ok).length / perCase.length : 0,
    perCase,
  };
}

/** Scaffold a STARTER set from the live graph: every active, vouched blocking constraint →
 *  a CATCH case (a file in its scope — a change there must not slip silently past the gate);
 *  a few unrelated paths → PASS cases (the precision side — the gate must NOT over-flag). Both
 *  sides are true ground truth. Hand-add regressions / near-misses for fuller coverage. */
export function generateGuardCases(store: HunchStore): GuardCase[] {
  const cases: GuardCase[] = [];
  const blocking = store
    .recs("constraints")
    .filter((c) => c.status === "active" && c.severity === "blocking" && c.scope.length && isVouched(c.provenance?.source));
  for (const c of blocking) {
    cases.push({ name: `CATCH · ${c.statement.slice(0, 56)}`, files: [pathForGlob(c.scope[0]!)], expect: "catch" });
  }
  for (const p of ["docs/__eval__notes.md", "scripts/__eval__.txt", ".github/__eval__.yml"]) {
    if (!blocking.some((c) => c.scope.some((g) => pathMatchesGlob(p, g)))) {
      cases.push({ name: `PASS · unrelated ${p}`, files: [p], expect: "pass" });
    }
  }
  return cases;
}

const isVouched = (source?: string): boolean => !!source && (source.includes("human_confirmed") || source === "derived");

/** A concrete path that matches a scope glob, for a synthetic case. Exact-file scopes pass
 *  through; wildcard scopes get a representative file inside them. */
function pathForGlob(glob: string): string {
  if (!/[*]/.test(glob)) return glob;
  let p = glob.replace(/\*\*/g, "x").replace(/\*/g, "x").replace(/\/+/g, "/").replace(/\/$/, "");
  if (!/\.[a-z0-9]+$/i.test(p)) p += "/__eval__.ts";
  return p.replace(/^\.?\//, "");
}
