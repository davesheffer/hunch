/**
 * Content-matched constraints (dec_e0a36efbf5): a constraint carrying a `match` regex
 * is decided by whether an ADDED line actually trips it — verifiable per commit, so it
 * keeps its teeth across the file's whole life (immune to file-change "staleness") and
 * stays quiet on edits that don't break it. Contrast: a scope-only rule downgrades to
 * advisory the moment the guarded file is committed after it was last verified.
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import { tempStore } from "./helpers.js";
import { verdict } from "../src/core/checkreport.js";
import { blockingInScope } from "../src/core/hookpolicy.js";
import type { HunchStore } from "../src/store/hunchStore.js";

// A unified diff that ADDS one line to src/cart.ts.
const diffAdding = (line: string) =>
  `diff --git a/src/cart.ts b/src/cart.ts\n--- a/src/cart.ts\n+++ b/src/cart.ts\n@@ -1,1 +1,2 @@\n export const total = 0;\n+${line}\n`;

// last_verified far in the past; the guarded file "changed" far in the future → STALE.
const VERIFIED = "2020-01-01T00:00:00.000Z";
const STALE_LAST_CHANGE = () => "2030-01-01T00:00:00.000Z";

function seed(store: HunchStore, extra: Record<string, unknown>) {
  store.json.put("constraints", {
    id: "con_lodash", statement: "never import lodash — use src/utils", scope: ["src/**"],
    severity: "blocking", rationale: "bundle size",
    provenance: { source: "human_confirmed", confidence: 1, evidence: [], last_verified: VERIFIED },
    ...extra,
  } as never);
  store.reindex();
}

test("content-matched rule BLOCKS a violating diff even when the file is stale", () => {
  const { store, cleanup } = tempStore();
  try {
    seed(store, { match: "lodash" });
    const report = store.buildCheckReport(["src/cart.ts"], diffAdding('import _ from "lodash";'), {
      strict: true, lastChange: STALE_LAST_CHANGE,
    });
    assert.equal(report.strictBlockers, 1, "the content violation is a hard strict blocker");
    assert.equal(verdict(report), "block", "verdict blocks despite the file being stale");
    assert.equal(report.direct[0]?.downgrade, undefined, "not downgraded — staleness does not apply to a content match");
  } finally { cleanup(); }
});

test("content-matched rule stays SILENT on a compliant diff (no false positive)", () => {
  const { store, cleanup } = tempStore();
  try {
    seed(store, { match: "lodash" });
    const report = store.buildCheckReport(["src/cart.ts"], diffAdding("export const avg = 1;"), {
      strict: true, lastChange: STALE_LAST_CHANGE,
    });
    assert.equal(report.direct.length, 0, "an edit that touches scope but doesn't trip the matcher is not flagged");
    assert.equal(verdict(report), "pass");
  } finally { cleanup(); }
});

test("scope-only rule DOWNGRADES to advisory when stale (the gap content-matching closes)", () => {
  const { store, cleanup } = tempStore();
  try {
    seed(store, {}); // no `match` → scope-only, subject to file-change staleness
    const report = store.buildCheckReport(["src/cart.ts"], diffAdding('import _ from "lodash";'), {
      strict: true, lastChange: STALE_LAST_CHANGE,
    });
    assert.equal(report.strictBlockers, 0, "scope-only blocking rule fails open once the file is stale");
    assert.equal(report.direct[0]?.downgrade, "stale", "and reports WHY it was downgraded");
    assert.notEqual(verdict(report), "block");
  } finally { cleanup(); }
});

test("content-matched rule does NOT fire on a comment that merely names the term", () => {
  const { store, cleanup } = tempStore();
  try {
    seed(store, { match: "lodash" });
    // a deliberately-avoiding COMMENT is not a violation — must not block (the confirmed FP)
    const report = store.buildCheckReport(["src/cart.ts"], diffAdding("// we deliberately avoid lodash here"), {
      strict: true, lastChange: STALE_LAST_CHANGE,
    });
    assert.equal(report.direct.length, 0, "a comment mentioning the term is not flagged");
    // but the import specifier (a string) IS still caught — stripping comments must not strip strings
    const real = store.buildCheckReport(["src/cart.ts"], diffAdding('import _ from "lodash";'), {
      strict: true, lastChange: STALE_LAST_CHANGE,
    });
    assert.equal(real.strictBlockers, 1, "the real import (a string specifier) still blocks");
  } finally { cleanup(); }
});

test("blockingInScope (edit-time hook) denies ONLY the violating edit", () => {
  const { store, cleanup } = tempStore();
  try {
    seed(store, { match: "lodash" });
    const violating = blockingInScope(store, "src/cart.ts", ['import _ from "lodash";']);
    assert.ok(violating, "an edit that adds the forbidden content is denied");
    assert.match(violating!.reason, /never import lodash/);

    const compliant = blockingInScope(store, "src/cart.ts", ["const safe = useUtils();"]);
    assert.equal(compliant, null, "an edit to the same guarded file that doesn't trip the matcher is allowed");
  } finally { cleanup(); }
});
