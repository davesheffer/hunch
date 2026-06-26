/**
 * Content-matched constraints (parsed-import precise). A constraint can forbid a dep
 * (matched against the PARSED import set — comments/strings naming it can't trip it; a
 * submodule import is caught), a symbol, or a regex pattern (lint-grade). A content match
 * is verified per commit, so it is immune to file-change "staleness" and keeps its teeth
 * across the file's whole life. The same matcher backs the Veto Guard.
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import { tempStore } from "./helpers.js";
import { verdict } from "../src/core/checkreport.js";
import { blockingInScope } from "../src/core/hookpolicy.js";
import { deriveForbids } from "../src/core/constraintmatch.js";
import { buildCorrectionConstraint } from "../src/core/correction.js";
import type { HunchStore } from "../src/store/hunchStore.js";

// A unified diff that ADDS the given lines to src/cart.ts.
const diffAdding = (...lines: string[]) =>
  `diff --git a/src/cart.ts b/src/cart.ts\n--- a/src/cart.ts\n+++ b/src/cart.ts\n@@ -1,1 +1,${lines.length + 1} @@\n export const total = 0;\n${lines.map((l) => `+${l}`).join("\n")}\n`;

const VERIFIED = "2020-01-01T00:00:00.000Z";
const STALE = () => "2030-01-01T00:00:00.000Z"; // file "changed" long after the rule → stale

function seed(store: HunchStore, extra: Record<string, unknown>) {
  store.json.put("constraints", {
    id: "con_x", statement: "never import lodash — use src/utils", scope: ["src/**"],
    severity: "blocking", rationale: "bundle size",
    provenance: { source: "human_confirmed", confidence: 1, evidence: [], last_verified: VERIFIED },
    ...extra,
  } as never);
  store.reindex();
}
const report = (store: HunchStore, diff: string) =>
  store.buildCheckReport(["src/cart.ts"], diff, { strict: true, lastChange: STALE });

// ── dep tier (the precise, recommended path) ──────────────────────────────
test("dep tier BLOCKS a real import even when the file is stale", () => {
  const { store, cleanup } = tempStore();
  try {
    seed(store, { forbids: { deps: ["lodash"], symbols: [], patterns: [] } });
    const r = report(store, diffAdding('import _ from "lodash";'));
    assert.equal(r.strictBlockers, 1, "real import is a hard blocker despite staleness");
    assert.equal(verdict(r), "block");
    assert.equal(r.direct[0]?.downgrade, undefined, "not downgraded — content verified, staleness N/A");
  } finally { cleanup(); }
});

test("dep tier catches a SUBMODULE import (lodash/groupBy via 'lodash')", () => {
  const { store, cleanup } = tempStore();
  try {
    seed(store, { forbids: { deps: ["lodash"], symbols: [], patterns: [] } });
    assert.equal(report(store, diffAdding('import groupBy from "lodash/groupBy";')).strictBlockers, 1);
  } finally { cleanup(); }
});

test("dep tier does NOT fire on a COMMENT, a STRING, or a block-comment body that names the dep", () => {
  const { store, cleanup } = tempStore();
  try {
    seed(store, { forbids: { deps: ["lodash"], symbols: [], patterns: [] } });
    assert.equal(report(store, diffAdding('// we deliberately avoid lodash here')).direct.length, 0, "line comment");
    assert.equal(report(store, diffAdding('const note = "lodash is banned";')).direct.length, 0, "string literal");
    assert.equal(report(store, diffAdding("/*", " we avoid lodash entirely", "*/")).direct.length, 0, "block-comment body");
    // …but the real import (also a string specifier) still blocks:
    assert.equal(report(store, diffAdding('import _ from "lodash";')).strictBlockers, 1, "real import still caught");
  } finally { cleanup(); }
});

test("dep tier stays SILENT on a compliant edit to the guarded file (no false positive)", () => {
  const { store, cleanup } = tempStore();
  try {
    seed(store, { forbids: { deps: ["lodash"], symbols: [], patterns: [] } });
    assert.equal(verdict(report(store, diffAdding("export const avg = 1;"))), "pass");
  } finally { cleanup(); }
});

// ── symbol + pattern tiers ────────────────────────────────────────────────
test("symbol tier blocks an added identifier but not one inside a comment", () => {
  const { store, cleanup } = tempStore();
  try {
    seed(store, { statement: "no eval", forbids: { deps: [], symbols: ["evil"], patterns: [] } });
    assert.equal(report(store, diffAdding("const x = evil(payload);")).strictBlockers, 1, "real call blocks");
    assert.equal(report(store, diffAdding("// evil is forbidden")).direct.length, 0, "comment does not");
  } finally { cleanup(); }
});

test("legacy --match regex still works via the pattern tier and is staleness-immune", () => {
  const { store, cleanup } = tempStore();
  try {
    seed(store, { match: "TODO-HACK" });
    assert.equal(report(store, diffAdding("const y = 1; // TODO-HACK remove")).direct.length, 0, "matchableCode strips trailing // comment");
    assert.equal(report(store, diffAdding('const z = "TODO-HACK";')).strictBlockers, 1, "real code occurrence blocks despite stale");
  } finally { cleanup(); }
});

// ── scope-only contrast (the gap content-matching closes) ─────────────────
test("scope-only rule (no matcher) still downgrades to advisory when stale", () => {
  const { store, cleanup } = tempStore();
  try {
    seed(store, {});
    const r = report(store, diffAdding('import _ from "lodash";'));
    assert.equal(r.strictBlockers, 0, "scope-only fails open once stale");
    assert.equal(r.direct[0]?.downgrade, "stale");
  } finally { cleanup(); }
});

// ── edit-time hook ────────────────────────────────────────────────────────
test("blockingInScope denies the importing edit, allows comment / unrelated edits", () => {
  const { store, cleanup } = tempStore();
  try {
    seed(store, { forbids: { deps: ["lodash"], symbols: [], patterns: [] } });
    assert.ok(blockingInScope(store, "src/cart.ts", ['import _ from "lodash";']), "deny real import");
    assert.equal(blockingInScope(store, "src/cart.ts", ['// avoid lodash']), null, "allow comment");
    assert.equal(blockingInScope(store, "src/cart.ts", ["const ok = 1;"]), null, "allow unrelated edit");
  } finally { cleanup(); }
});

// ── seamless capture: a correction mints a PRECISE matcher ─────────────────
test("deriveForbids derives a dep ONLY from an unambiguous import verb (conservative — wrong > silent)", () => {
  assert.deepEqual(deriveForbids("never import lodash")?.deps, ["lodash"]);
  assert.deepEqual(deriveForbids("do not import axios; use fetch")?.deps, ["axios"]);
  assert.equal(deriveForbids("don't use react hooks"), null, "'use' is ambiguous (names hooks, not react) → not derived");
  assert.equal(deriveForbids("never use synchronous fs"), null, "'use' + non-dependency → not derived");
  assert.equal(deriveForbids("always import react"), null, "positive rule → not a forbid");
  assert.equal(deriveForbids("always validate the session"), null, "no import verb → nothing derived");
});

test("deriveForbids validates against the repo's real deps when supplied (no never-firing rules)", () => {
  assert.deepEqual(deriveForbids("never import lodash", ["lodash", "zod"])?.deps, ["lodash"], "real dep → derived");
  assert.equal(deriveForbids("never import lodash", ["zod", "commander"]), null, "not a dependency → not derived");
  assert.deepEqual(deriveForbids("never import lodash")?.deps, ["lodash"], "no list supplied → no validation (back-compat)");
  assert.deepEqual(deriveForbids("never import lodash", ["lodash/fp"])?.deps, ["lodash"], "submodule dep counts");
});

test("buildCorrectionConstraint auto-attaches the dep matcher (Never-Twice enforces precisely)", () => {
  const c = buildCorrectionConstraint({ rule: "never import lodash", scope_hint_file: "src/cart.ts", severity: "blocking" }, VERIFIED);
  assert.deepEqual(c.forbids?.deps, ["lodash"], "correction → precise, staleness-immune rule");
  const c2 = buildCorrectionConstraint({ rule: "never import lodash", scope_hint_file: "src/cart.ts", severity: "blocking", knownDeps: ["zod"] }, VERIFIED);
  assert.equal(c2.forbids, null, "correction naming a non-dependency → falls back to scope-only (no wrong rule)");
});

// ── migration ─────────────────────────────────────────────────────────────
test("a pre-0.36 constraint (no forbids/match field) loads and still enforces by scope", () => {
  const { store, cleanup } = tempStore();
  try {
    store.json.put("constraints", {
      id: "con_old", statement: "old rule", scope: ["src/**"], severity: "blocking", rationale: "",
      provenance: { source: "human_confirmed", confidence: 1, evidence: [], last_verified: VERIFIED },
    } as never);
    store.reindex();
    const got = store.checkConstraints("src/cart.ts").find((c) => c.id === "con_old");
    assert.ok(got, "old-format constraint loads");
    assert.equal(got!.forbids, null, "forbids defaults to null");
    assert.equal(got!.match, null, "match defaults to null");
  } finally { cleanup(); }
});
