import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { tempStore } from "./helpers.js";
import { verdict, renderText, renderMarkdown } from "../src/core/checkreport.js";
import type { Decision, Bug, Constraint } from "../src/core/types.js";
import { HunchStore } from "../src/store/hunchStore.js";
import { hunchPaths } from "../src/core/paths.js";
import { indexRepo } from "../src/extractors/indexer.js";

const PROV = (c = 1) => ({ source: "human_confirmed" as const, confidence: c, evidence: [] });

/** Seed the causal chain: bug (root cause) → decision (the why) → constraint (the guard). */
function seed(store: HunchStore) {
  store.json.put("decisions", {
    id: "dec_atomic", title: "Atomic writes via temp+rename", status: "accepted", context: "",
    decision: "All .hunch writes go through temp-file + rename so an interrupted write can't truncate the index.",
    consequences: [], alternatives_rejected: [], related_components: [], related_files: ["src/store/jsonStore.ts"],
    supersedes: null, superseded_by: null, caused_by_bug: "bug_trunc", commit: null,
    valid_from: "2026-01-01T00:00:00Z", valid_to: null, retired: { symbols: [], deps: [] },
    provenance: PROV(), date: "2026-01-01T00:00:00Z",
  } as unknown as Decision);
  store.json.put("bugs", {
    id: "bug_trunc", title: "Index truncated on interrupted write", symptom: "half-written JSON on crash",
    root_cause: "non-atomic write left a truncated file", severity: "high", status: "fixed",
    affected_files: ["src/store/jsonStore.ts"], affected_symbols: [],
    lineage: { introduced_commit: null, detected: null, fixed_commit: null, recurrence_of: null, spawned_decision: "dec_atomic", spawned_constraint: "con_atomic" },
    provenance: PROV(),
  } as unknown as Bug);
  store.json.put("constraints", {
    id: "con_atomic", type: "correctness", statement: "All .hunch writes must be atomic (temp+rename)",
    scope: ["src/store/**"], severity: "blocking", enforcement: "advisory_v1",
    rationale: "a partial write corrupts the source of truth", source_decision: "dec_atomic",
    violations: [], status: "active", valid_from: "2026-01-01T00:00:00Z", valid_to: null, provenance: PROV(),
  } as unknown as Constraint);
  store.reindex();
}

const STRICT = { strict: true, lastChange: () => "2000-01-01T00:00:00Z" };

/** A real indexed repo with a 2-hop dependency chain jwt ← session ← charge. */
function indexedRepo() {
  const root = mkdtempSync(join(tmpdir(), "hunch-verdict-"));
  mkdirSync(join(root, "src/auth"), { recursive: true });
  mkdirSync(join(root, "src/billing"), { recursive: true });
  writeFileSync(join(root, "src/auth/session.ts"), `import { jwtDecode } from "./jwt.js";\nexport function verifySession(t){ return jwtDecode(t); }\n`);
  writeFileSync(join(root, "src/auth/jwt.ts"), `export function jwtDecode(t){ return t; }\n`);
  writeFileSync(join(root, "src/billing/charge.ts"), `import { verifySession } from "../auth/session.js";\nexport function charge(t){ return verifySession(t); }\n`);
  const store = new HunchStore(hunchPaths(root));
  store.json.ensureDirs();
  indexRepo(store, root, { churn: false });
  store.reindex();
  const fileOf = (name: string) => store.json.loadAll("symbols").find((s) => s.name === name)!.file;
  return { store, fileOf, cleanup: () => { store.close(); rmSync(root, { recursive: true, force: true }); } };
}

test("causalChain joins constraint → source decision → originating bug", () => {
  const { store, cleanup } = tempStore();
  try {
    seed(store);
    const w = store.causalChain("con_atomic");
    assert.equal(w.constraint_id, "con_atomic");
    assert.equal(w.decision?.id, "dec_atomic");
    assert.match(w.decision!.title, /Atomic writes/);
    assert.equal(w.bug?.id, "bug_trunc");
    assert.match(w.bug!.root_cause, /non-atomic/);
  } finally { cleanup(); }
});

test("causalChain is empty for an unknown constraint", () => {
  const { store, cleanup } = tempStore();
  try {
    const w = store.causalChain("con_nope");
    assert.equal(w.constraint_id, "con_nope");
    assert.equal(w.decision, undefined);
    assert.equal(w.bug, undefined);
  } finally { cleanup(); }
});

test("buildCheckReport flags a direct blocking hit WITH a causal why → BLOCK verdict", () => {
  const { store, cleanup } = tempStore();
  try {
    seed(store);
    const report = store.buildCheckReport(["src/store/jsonStore.ts"], "", STRICT);
    assert.equal(report.direct.length, 1);
    const d = report.direct[0]!;
    assert.equal(d.id, "con_atomic");
    assert.equal(d.strictBlocks, true);
    assert.equal(d.why?.decision?.id, "dec_atomic");
    assert.equal(d.why?.bug?.id, "bug_trunc");
    assert.equal(verdict(report), "block");
  } finally { cleanup(); }
});

test("verdict is PASS when a diff touches no recorded memory", () => {
  const { store, cleanup } = tempStore();
  try {
    seed(store);
    const report = store.buildCheckReport(["src/unrelated/elsewhere.ts"], "", STRICT);
    assert.equal(report.direct.length, 0);
    assert.equal(verdict(report), "pass");
  } finally { cleanup(); }
});

test("renderText and renderMarkdown surface the causal WHY citation", () => {
  const { store, cleanup } = tempStore();
  try {
    seed(store);
    const report = store.buildCheckReport(["src/store/jsonStore.ts"], "", STRICT);
    const txt = renderText(report);
    assert.match(txt, /why:.*Atomic writes/);
    assert.match(txt, /guards against:.*non-atomic/);
    const md = renderMarkdown(report);
    assert.match(md, /_why:_/);
    assert.match(md, /dec_atomic/);
    assert.match(md, /bug_trunc/);
  } finally { cleanup(); }
});

test("near-hit (blast radius) → WARN, never BLOCK", () => {
  const { store, fileOf, cleanup } = indexedRepo();
  try {
    const charge = fileOf("charge"), jwt = fileOf("jwtDecode");
    store.json.put("constraints", {
      id: "con_bill", type: "correctness", statement: "billing rounds half-up", scope: [charge],
      severity: "blocking", enforcement: "advisory_v1", rationale: "money", source_decision: null,
      violations: [], status: "active", valid_from: "2026-01-01T00:00:00Z", valid_to: null, provenance: PROV(),
    } as unknown as Constraint);
    store.reindex();
    // Editing jwt.ts reaches the billing invariant ONLY via blast radius (jwt ← session ← charge).
    const report = store.buildCheckReport([jwt], "", STRICT);
    assert.equal(report.direct.length, 0, "no direct hit on jwt");
    const hit = report.near.find((n) => n.id === "con_bill");
    assert.ok(hit, "billing invariant surfaced via blast radius");
    assert.ok(hit!.via.length > 0, "the dependency path is recorded");
    assert.equal(report.strictBlockers, 0, "near-hits never contribute to strict blocking");
    assert.equal(verdict(report), "warn");
  } finally { cleanup(); }
});

const REG_DIFF = [
  "diff --git a/src/auth/session.ts b/src/auth/session.ts",
  "--- a/src/auth/session.ts",
  "+++ b/src/auth/session.ts",
  "@@ -1,1 +1,2 @@",
  " export const x = 1;",
  "+export function retiredFunc() { return 1; }",
].join("\n");

test("re-adding a retired symbol tied to a blocking constraint → BLOCK", () => {
  const { store, cleanup } = tempStore();
  try {
    store.json.put("decisions", {
      id: "dec_reg", title: "Removed retiredFunc deliberately", status: "accepted", context: "",
      decision: "retiredFunc was removed; do not re-add it.", consequences: [], alternatives_rejected: [],
      related_components: [], related_files: ["src/auth/session.ts"], supersedes: null, superseded_by: null,
      caused_by_bug: null, commit: null, valid_from: "2026-01-01T00:00:00Z", valid_to: null,
      retired: { symbols: ["retiredFunc"], deps: [] }, provenance: PROV(), date: "2026-01-01T00:00:00Z",
    } as unknown as Decision);
    store.json.put("constraints", {
      id: "con_reg", type: "correctness", statement: "do not re-add retiredFunc", scope: ["src/other/**"],
      severity: "blocking", enforcement: "advisory_v1", rationale: "", source_decision: "dec_reg",
      violations: [], status: "active", valid_from: "2026-01-01T00:00:00Z", valid_to: null, provenance: PROV(),
    } as unknown as Constraint);
    store.reindex();
    const report = store.buildCheckReport(["src/auth/session.ts"], REG_DIFF, STRICT);
    assert.equal(report.direct.length, 0, "constraint is scoped elsewhere — regression is the only signal");
    assert.equal(report.regressions.length, 1);
    assert.equal(report.regressions[0]!.name, "retiredFunc");
    assert.equal(report.regBlocking, 1);
    assert.equal(verdict(report), "block");
  } finally { cleanup(); }
});

test("causalChain falls back to decision.caused_by_bug when no bug spawned the constraint", () => {
  const { store, cleanup } = tempStore();
  try {
    store.json.put("bugs", {
      id: "bug_fb", title: "fallback bug", symptom: "", root_cause: "the original failure", severity: "high",
      status: "fixed", affected_files: [], affected_symbols: [],
      lineage: { introduced_commit: null, detected: null, fixed_commit: null, recurrence_of: null, spawned_decision: null, spawned_constraint: null },
      provenance: PROV(),
    } as unknown as Bug);
    store.json.put("decisions", {
      id: "dec_fb", title: "Guard added", status: "accepted", context: "", decision: "added a guard",
      consequences: [], alternatives_rejected: [], related_components: [], related_files: ["src/x.ts"],
      supersedes: null, superseded_by: null, caused_by_bug: "bug_fb", commit: null,
      valid_from: "2026-01-01T00:00:00Z", valid_to: null, retired: { symbols: [], deps: [] }, provenance: PROV(), date: "2026-01-01T00:00:00Z",
    } as unknown as Decision);
    store.json.put("constraints", {
      id: "con_fb", type: "correctness", statement: "guard", scope: ["src/x.ts"], severity: "blocking",
      enforcement: "advisory_v1", rationale: "", source_decision: "dec_fb", violations: [], status: "active",
      valid_from: "2026-01-01T00:00:00Z", valid_to: null, provenance: PROV(),
    } as unknown as Constraint);
    const w = store.causalChain("con_fb");
    assert.equal(w.decision?.id, "dec_fb");
    assert.equal(w.bug?.id, "bug_fb"); // resolved via decision.caused_by_bug, not lineage.spawned_constraint
  } finally { cleanup(); }
});

test("a warning (non-blocking) direct hit → WARN, not BLOCK", () => {
  const { store, cleanup } = tempStore();
  try {
    store.json.put("constraints", {
      id: "con_warn", type: "correctness", statement: "prefer composition", scope: ["src/x.ts"],
      severity: "warning", enforcement: "advisory_v1", rationale: "", source_decision: null,
      violations: [], status: "active", valid_from: "2026-01-01T00:00:00Z", valid_to: null, provenance: PROV(),
    } as unknown as Constraint);
    store.reindex();
    const report = store.buildCheckReport(["src/x.ts"], "", STRICT);
    assert.equal(report.direct.length, 1);
    assert.equal(report.direct[0]!.strictBlocks, false);
    assert.equal(report.strictBlockers, 0);
    assert.equal(verdict(report), "warn");
  } finally { cleanup(); }
});
