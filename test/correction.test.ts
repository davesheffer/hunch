import { cleanupDir } from "./fixtures.js";
import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { looksLikeCorrection, buildCorrectionConstraint, CORRECTION_NUDGE } from "../src/core/correction.js";
import { hunchPaths } from "../src/core/paths.js";
import { HunchStore } from "../src/store/hunchStore.js";
import { blockingInScope } from "../src/core/hookpolicy.js";

const NOW = "2026-06-20T00:00:00.000Z";

test("looksLikeCorrection fires on real corrections", () => {
  for (const p of [
    "No, never call the pay-per-token API here.",
    "that's wrong — use the subscription path",
    "Never add an API key to the spawned env",
    "I told you to keep writes atomic",
    "undo that change",
    "stop doing that, not like that",
    "you must always strip the token",
  ]) assert.ok(looksLikeCorrection(p), `should detect: ${p}`);
});

test("looksLikeCorrection ignores ordinary negation / non-corrections", () => {
  for (const p of [
    "no problem, go ahead",
    "I have no idea why this fails",
    "add a feature to the parser",
    "can you explain how the indexer works?",
    "there's no test for this yet, please add one",
    // stateful conversational negation — must NOT fire (review finding: cue-precision)
    "no tests pass right now",
    "no test exists for this path",
    "no way to fix this cleanly",
    "no chance of a regression here",
    "no context available for that symbol",
    "no other changes needed",
    "",
  ]) assert.ok(!looksLikeCorrection(p), `should NOT detect: ${p}`);
});

test("looksLikeCorrection catches bare 'don't do that' rebukes (no 'again' needed)", () => {
  for (const p of ["don't do that", "do not call that", "dont add it"]) {
    assert.ok(looksLikeCorrection(p), `should detect: ${p}`);
  }
});

test("looksLikeCorrection is null-safe", () => {
  assert.equal(looksLikeCorrection(undefined), false);
  assert.equal(looksLikeCorrection(null), false);
});

test("CORRECTION_NUDGE points at the write tool and is client-agnostic", () => {
  assert.match(CORRECTION_NUDGE, /hunch_record_correction/);
  assert.doesNotMatch(CORRECTION_NUDGE, /\bClaude\b/i); // must not be Claude-only
});

test("buildCorrectionConstraint scopes to the hinted file by default (conservative)", () => {
  const c = buildCorrectionConstraint({ rule: "never call the API here", scope_hint_file: "src/synthesis/provider.ts", severity: "blocking" }, NOW);
  assert.deepEqual(c.scope, ["src/synthesis/provider.ts"]);
  assert.equal(c.severity, "blocking");
  assert.equal(c.status, "active");
  assert.equal(c.provenance.source, "human_confirmed");
  assert.equal(c.provenance.confidence, 1);
  assert.equal(c.valid_from, NOW);
  assert.equal(c.valid_to, null);
});

test("buildCorrectionConstraint normalizes a Windows-style scope hint to POSIX", () => {
  const c = buildCorrectionConstraint({ rule: "keep writes atomic", scope_hint_file: "src\\store\\jsonStore.ts" }, NOW);
  assert.deepEqual(c.scope, ["src/store/jsonStore.ts"]);
});

test("buildCorrectionConstraint allows blocking + ** ONLY when applies_to_all is explicit", () => {
  const all = buildCorrectionConstraint({ rule: "no console.log in shipped code", severity: "blocking", applies_to_all: true }, NOW);
  assert.deepEqual(all.scope, ["**"]);
  assert.equal(all.severity, "blocking");
});

test("buildCorrectionConstraint DOWNGRADES a repo-wide blocking rule that wasn't opted in (scope footgun guard)", () => {
  // no scope_hint_file and no applies_to_all => scope is ** ; blocking would mute every edit under strict, so down-rank.
  const c = buildCorrectionConstraint({ rule: "always prefer composition", severity: "blocking" }, NOW);
  assert.deepEqual(c.scope, ["**"]);
  assert.equal(c.severity, "warning");
});

test("buildCorrectionConstraint id is deterministic from the rule text (idempotent re-capture)", () => {
  const a = buildCorrectionConstraint({ rule: "  never touch the lockfile by hand  " }, NOW);
  const b = buildCorrectionConstraint({ rule: "never touch the lockfile by hand" }, "2026-07-01T00:00:00.000Z");
  assert.equal(a.id, b.id);
  assert.equal(a.statement, "never touch the lockfile by hand");
});

test("buildCorrectionConstraint carries optional fields through (type/rationale/source_decision)", () => {
  const c = buildCorrectionConstraint(
    { rule: "validate all inputs", scope_hint_file: "src/api.ts", type: "security", rationale: "prevent injection", source_decision: "dec_123" },
    NOW,
  );
  assert.equal(c.type, "security");
  assert.equal(c.rationale, "prevent injection");
  assert.equal(c.source_decision, "dec_123");
});

test("buildCorrectionConstraint defaults severity to warning", () => {
  const c = buildCorrectionConstraint({ rule: "prefer async iterators", scope_hint_file: "src/x.ts" }, NOW);
  assert.equal(c.severity, "warning");
});

test("buildCorrectionConstraint rejects an empty rule", () => {
  assert.throws(() => buildCorrectionConstraint({ rule: "   " }, NOW), /rule must not be empty/);
});

test("buildCorrectionConstraint ignores a blank/'.' scope hint (falls back to ** )", () => {
  assert.deepEqual(buildCorrectionConstraint({ rule: "r1", scope_hint_file: "" }, NOW).scope, ["**"]);
  assert.deepEqual(buildCorrectionConstraint({ rule: "r2", scope_hint_file: "." }, NOW).scope, ["**"]);
});

// End-to-end: a correction constraint actually BLOCKS an edit via the hook gate.
test("a recorded correction enforces: blockingInScope flags a direct edit to its scope", () => {
  const root = mkdtempSync(join(tmpdir(), "hunch-correction-"));
  const store = new HunchStore(hunchPaths(root));
  try {
    mkdirSync(join(root, "src"), { recursive: true });
    writeFileSync(join(root, "src/danger.ts"), "export const x = 1;\n");
    store.json.ensureDirs();
    // Mint exactly what hunch_record_correction would, then persist + index.
    const rec = buildCorrectionConstraint(
      { rule: "never call the pay-per-token API in this file", scope_hint_file: "src/danger.ts", severity: "blocking" },
      NOW,
    );
    store.json.put("constraints", rec);
    store.reindex();
    const hit = blockingInScope(store, "src/danger.ts");
    assert.ok(hit, "a blocking correction must flag a direct edit to its scope");
    assert.match(hit!.reason, /never call the pay-per-token API/);
    assert.match(hit!.reason, new RegExp(rec.id));
  } finally {
    store.close();
    cleanupDir(root);
  }
});
