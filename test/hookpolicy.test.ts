import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { hunchPaths } from "../src/core/paths.js";
import { HunchStore } from "../src/store/hunchStore.js";
import { indexRepo } from "../src/extractors/indexer.js";
import { blockingInScope, vetoInScope, proposedEditLines } from "../src/core/hookpolicy.js";
import { prov } from "./helpers.js";

// jwt.ts ← session.ts ← charge.ts : a 2-hop dependency chain (mirrors check.test).
function indexed() {
  const root = mkdtempSync(join(tmpdir(), "hunch-hookpolicy-"));
  mkdirSync(join(root, "src/auth"), { recursive: true });
  mkdirSync(join(root, "src/billing"), { recursive: true });
  writeFileSync(join(root, "src/auth/session.ts"), `import { jwtDecode } from "./jwt.js";\nexport function verifySession(t){ return jwtDecode(t); }\n`);
  writeFileSync(join(root, "src/auth/jwt.ts"), `export function jwtDecode(t){ return t; }\n`);
  writeFileSync(join(root, "src/billing/charge.ts"), `import { verifySession } from "../auth/session.js";\nexport function charge(t){ return verifySession(t); }\n`);
  const store = new HunchStore(hunchPaths(root));
  store.json.ensureDirs();
  indexRepo(store, root, { churn: false });
  store.reindex();
  const syms = store.json.loadAll("symbols");
  const fileOf = (name: string) => syms.find((s) => s.name === name)!.file;
  return { store, root, fileOf, cleanup: () => { store.close(); rmSync(root, { recursive: true, force: true }); } };
}

function seedBlocking(store: HunchStore, scopeFile: string) {
  store.json.put("constraints", {
    id: "con_billing", statement: "billing rounds half-up", scope: [scopeFile],
    severity: "blocking", rationale: "money", provenance: prov(),
  } as never);
  store.reindex();
}

test("blockingInScope flags a DIRECT hit on the invariant's scope", () => {
  const { store, fileOf, cleanup } = indexed();
  try {
    const charge = fileOf("charge");
    seedBlocking(store, charge);
    const hit = blockingInScope(store, charge);
    assert.ok(hit, "direct edit of a blocking-invariant file is flagged");
    assert.match(hit!.reason, /billing rounds half-up/);
    assert.match(hit!.reason, /con_billing/);
  } finally { cleanup(); }
});

test("blockingInScope flags a NEAR hit reached via blast radius", () => {
  const { store, fileOf, cleanup } = indexed();
  try {
    const charge = fileOf("charge"), jwt = fileOf("jwtDecode");
    seedBlocking(store, charge);
    // Editing jwt.ts only INDIRECTLY reaches the billing invariant (jwt ← session ← charge).
    assert.equal(store.checkConstraints(jwt).length, 0, "no direct hit on jwt");
    const hit = blockingInScope(store, jwt);
    assert.ok(hit, "blast-radius hit is flagged");
    assert.match(hit!.reason, /blast radius/);
  } finally { cleanup(); }
});

test("blockingInScope returns null when the invariant is neither in scope nor downstream", () => {
  const { store, fileOf, cleanup } = indexed();
  try {
    // Constraint on the leaf jwt.ts. Editing charge.ts (the top of the chain) can't
    // affect jwt.ts — blast radius is DEPENDENTS, and nothing imports charge.ts.
    seedBlocking(store, fileOf("jwtDecode"));
    assert.equal(blockingInScope(store, fileOf("charge")), null);
  } finally { cleanup(); }
});

test("deny reason never coaches lowering enforcement (no bypass instructions)", () => {
  const { store, fileOf, cleanup } = indexed();
  try {
    const charge = fileOf("charge");
    seedBlocking(store, charge);
    const direct = blockingInScope(store, charge)!.reason;
    const near = blockingInScope(store, fileOf("jwtDecode"))!.reason;
    for (const reason of [direct, near]) {
      assert.doesNotMatch(reason, /firmness/i, "must not mention the firmness command");
      assert.doesNotMatch(reason, /lower|disable|bypass|--no-/i, "must not tell the agent how to get around the guard");
    }
  } finally { cleanup(); }
});

function seedVeto(store: HunchStore, scopeGlob: string, source = "human_confirmed") {
  store.json.put("decisions", {
    id: "dec_ext", title: "Read-only visualization layer", status: "accepted", context: "",
    decision: "read directly from committed JSON, no backend dependency", consequences: [],
    alternatives_rejected: [],
    rejected_tripwires: [{
      alternative: "extension queries MCP/API server for data",
      scope: [scopeGlob], forbids: { deps: ["axios"], symbols: [], patterns: [] },
      provenance: { source, confidence: 0.9, evidence: [] },
    }],
    related_components: [], related_files: ["src/billing/charge.ts"],
    supersedes: null, superseded_by: null, caused_by_bug: null, commit: null,
    valid_from: "2026-01-01T00:00:00Z", valid_to: null, retired: { symbols: [], deps: [] },
    provenance: { source: "human_confirmed", confidence: 1, evidence: [] }, date: "2026-01-01T00:00:00Z",
  } as never);
}

test("vetoInScope denies a live edit that re-introduces a rejected dependency (confirmed tripwire)", () => {
  const { store, fileOf, cleanup } = indexed();
  try {
    seedVeto(store, "src/**");
    const hit = vetoInScope(store, fileOf("charge"), ['import axios from "axios";']);
    assert.ok(hit, "confirmed veto denies the edit before staging");
    assert.match(hit!.reason, /REVERSE decision dec_ext/);
    assert.match(hit!.reason, /extension queries MCP\/API server for data/);
  } finally { cleanup(); }
});

test("vetoInScope returns null for an llm_draft tripwire (advisory only — never blocks live)", () => {
  const { store, fileOf, cleanup } = indexed();
  try {
    seedVeto(store, "src/**", "llm_draft");
    assert.equal(vetoInScope(store, fileOf("charge"), ['import axios from "axios";']), null);
  } finally { cleanup(); }
});

test("vetoInScope deny text never coaches lowering enforcement (no supersede/bypass)", () => {
  const { store, fileOf, cleanup } = indexed();
  try {
    seedVeto(store, "src/**");
    const reason = vetoInScope(store, fileOf("charge"), ['import axios from "axios";'])!.reason;
    assert.doesNotMatch(reason, /supersede|firmness/i, "must not name the override path to the agent");
    assert.doesNotMatch(reason, /lower|disable|bypass|--no-/i, "must not tell the agent how to get around the guard");
  } finally { cleanup(); }
});

test("vetoInScope returns null when the proposed edit adds nothing forbidden", () => {
  const { store, fileOf, cleanup } = indexed();
  try {
    seedVeto(store, "src/**");
    assert.equal(vetoInScope(store, fileOf("charge"), ["const x = 1;"]), null);
    assert.equal(vetoInScope(store, fileOf("charge"), []), null);
  } finally { cleanup(); }
});

test("proposedEditLines extracts text from Edit, Write, and MultiEdit tool inputs", () => {
  assert.deepEqual(proposedEditLines({ new_string: "a\nb" }), ["a", "b"], "Edit");
  assert.deepEqual(proposedEditLines({ content: "x\ny" }), ["x", "y"], "Write");
  assert.deepEqual(
    proposedEditLines({ edits: [{ new_string: "p" }, { new_string: "q\nr" }] }),
    ["p", "q", "r"],
    "MultiEdit flattens every edit's new_string",
  );
  assert.deepEqual(proposedEditLines({}), [], "no edit text → empty");
  assert.deepEqual(proposedEditLines(undefined), [], "missing tool_input → empty");
});

test("vetoInScope denies a MultiEdit whose edits[] re-introduce a rejected dependency", () => {
  const { store, fileOf, cleanup } = indexed();
  try {
    seedVeto(store, "src/**");
    const lines = proposedEditLines({ edits: [{ new_string: "const a = 1;" }, { new_string: 'import axios from "axios";' }] });
    const hit = vetoInScope(store, fileOf("charge"), lines);
    assert.ok(hit, "the forbidden import in a later MultiEdit chunk is caught");
    assert.match(hit!.reason, /REVERSE decision dec_ext/);
  } finally { cleanup(); }
});
