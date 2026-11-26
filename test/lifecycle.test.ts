import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, readFileSync, existsSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { hunchPaths } from "../src/core/paths.js";
import type { Constraint } from "../src/core/types.js";
import { JsonStore } from "../src/store/jsonStore.js";
import { HunchStore } from "../src/store/hunchStore.js";
import { displayState, challengeRule, clearChallenge, activateRule, replaceRule, ruleView, ruleDetail, appendRuleLog, currentRunContext } from "../src/core/lifecycle.js";
import { cleanupDir } from "./helpers.js";
import { restoreRecord } from "../src/core/memoryEdit.js";

function con(id: string, extra: Partial<Constraint> = {}): Constraint {
  return {
    id, type: "architecture", statement: `rule ${id}`, scope: ["src/**"], severity: "blocking", enforcement: "advisory_v1",
    match: null, forbids: null, rationale: "because", source_decision: null, violations: [], status: "active",
    valid_from: "2026-01-01T00:00:00.000Z", valid_to: null,
    provenance: { source: "human_confirmed", confidence: 1, evidence: [] }, ...extra,
  } as Constraint;
}

function setup() {
  const root = mkdtempSync(join(tmpdir(), "hunch-lifecycle-"));
  const json = new JsonStore(hunchPaths(root)); json.ensureDirs();
  json.put("constraints", con("con_a")); json.put("constraints", con("con_b", { status: "draft" }));
  json.put("decisions", { id: "dec_1", title: "Use X", status: "accepted", decision: "X is simple", context: "ctx", alternatives_rejected: ["Y"], date: "2026-01-01", provenance: { source: "human_confirmed", confidence: 1, evidence: [] } } as never);
  json.put("constraints", con("con_c", { source_decision: "dec_1" }));
  return { root, store: new HunchStore(hunchPaths(root)) };
}

test("challenge keeps enforcement, clear restores, retired refused", () => {
  const { root, store } = setup();
  try {
    assert.throws(() => challengeRule(store, "con_a", { reason: " ", by_session: null, by_run: null }));
    challengeRule(store, "con_a", { reason: "too broad", by_session: "s1", by_run: "r1" });
    const c = store.recs("constraints").find((r) => r.id === "con_a")!;
    assert.equal(displayState(c), "challenged");
    assert.equal(c.status, "active");
    assert.ok(store.checkConstraints("src/x.ts").some((r) => r.id === "con_a"));
    clearChallenge(store, "con_a", { reason: "fine" });
    const d = store.recs("constraints").find((r) => r.id === "con_a")!;
    assert.equal(displayState(d), "active");
    assert.match(d.rationale, /fine/);
    replaceRule(store, "con_a", "con_c", {});
    assert.throws(() => challengeRule(store, "con_a", { reason: "x" }));
  } finally { store.close(); cleanupDir(root); }
});

test("activate and replace", () => {
  const { root, store } = setup();
  try {
    assert.throws(() => activateRule(store, "con_a"));
    assert.throws(() => replaceRule(store, "con_a", "con_a", {}));
    assert.throws(() => replaceRule(store, "con_a", "con_nope", {}));
    replaceRule(store, "con_a", "con_b", { reason: "narrower" });
    const recs = store.recs("constraints");
    assert.equal(recs.find((r) => r.id === "con_b")!.status, "active");
    const v = ruleView(store, recs.find((r) => r.id === "con_a")!);
    assert.equal(v.status, "retired");
    assert.equal(v.superseded_by, "con_b");
    assert.ok(v.valid_to);
    assert.throws(() => activateRule(store, "con_b"));
  } finally { store.close(); cleanupDir(root); }
});

test("activateRule promotes a draft", () => {
  const { root, store } = setup();
  try {
    assert.equal(activateRule(store, "con_b").status, "active");
  } finally { store.close(); cleanupDir(root); }
});

test("ruleDetail includes the source decision", () => {
  const { root, store } = setup();
  try {
    const d = ruleDetail(store, "con_c");
    assert.deepEqual(d.why, { id: "dec_1", title: "Use X" });
    assert.equal(d.why_detail?.rationale, "X is simple\nctx");
    assert.deepEqual(d.why_detail?.rejected, [{ option: "Y", reason: "" }]);
    assert.equal(ruleDetail(store, "con_a").why_detail, null);
  } finally { store.close(); cleanupDir(root); }
});

test("appendRuleLog writes jsonl, is self-ignored and never throws; run context", () => {
  const root = mkdtempSync(join(tmpdir(), "hunch-rulelog-"));
  try {
    appendRuleLog(root, { a: 1 }); appendRuleLog(root, { a: 2 });
    const lines = readFileSync(join(root, ".hunch/local/rule-checks.jsonl"), "utf8").trim().split("\n");
    assert.deepEqual(lines.map((l) => JSON.parse(l).a), [1, 2]);
    assert.ok(existsSync(join(root, ".hunch/local/.gitignore")));
    assert.doesNotThrow(() => appendRuleLog(join(root, "nope", "\0bad"), { a: 3 }));
    process.env.HUNCH_RUN_ID = "run9";
    assert.deepEqual(currentRunContext("sess"), { session_id: "sess", run_id: "run9" });
    delete process.env.HUNCH_RUN_ID;
    const prevSession = process.env.CLAUDE_SESSION_ID;
    process.env.CLAUDE_SESSION_ID = "claude-sess";
    try { assert.deepEqual(currentRunContext(), { session_id: "claude-sess", run_id: null }); }
    finally { if (prevSession === undefined) delete process.env.CLAUDE_SESSION_ID; else process.env.CLAUDE_SESSION_ID = prevSession; }
  } finally { cleanupDir(root); }
});

test("grounding lists a draft rule (marked) and omits a retired one", async () => {
  const { root, store } = setup();
  try {
    new JsonStore(hunchPaths(root)).put("constraints", con("con_gone", { status: "retired", statement: "retired rule text" }));
    const { renderHunchSection } = await import("../src/integrations/claudemd.js");
    const out = renderHunchSection(store, root);
    assert.match(out, /\(draft\)[^\n]*rule con_b/);
    assert.match(out, /rule con_a/);
    assert.doesNotMatch(out, /retired rule text/);
  } finally { store.close(); cleanupDir(root); }
});

test("retireConstraint and replaceRule record retired_from; restore returns to it", () => {
  const { root, store } = setup();
  try {
    const retired = store.retireConstraint(store.recs("constraints").find((c) => c.id === "con_b")!);
    assert.equal(retired.status, "retired");
    assert.equal(retired.retired_from, "draft");
    const r1 = restoreRecord("constraint", retired, {}, new Date().toISOString());
    assert.ok(r1.ok);
    assert.equal((r1 as { record: Constraint }).record.status, "draft");
    const { old } = replaceRule(store, "con_a", "con_c", {});
    assert.equal(old.retired_from, "active");
    const r2 = restoreRecord("constraint", old, {}, new Date().toISOString());
    assert.equal((r2 as { record: Constraint }).record.status, "active");
  } finally { store.close(); cleanupDir(root); }
});
