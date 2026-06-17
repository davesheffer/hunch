import { test } from "node:test";
import assert from "node:assert/strict";
import { tempStore } from "./helpers.js";
import type { Decision, Constraint } from "../src/core/types.js";

function mkDecision(over: Partial<Decision> & { id: string }): Decision {
  return {
    title: "t", status: "accepted", context: "", decision: "removed it on purpose", consequences: [],
    alternatives_rejected: [], related_components: [], related_files: ["src/auth/session.ts"],
    supersedes: null, superseded_by: null, caused_by_bug: null, commit: null,
    valid_from: "2026-01-01T00:00:00Z", valid_to: null, retired: { symbols: [], deps: [] },
    provenance: { source: "human_confirmed", confidence: 1, evidence: [] }, date: "2026-01-01T00:00:00Z",
    ...over,
  };
}

function mkConstraint(over: Partial<Constraint> & { id: string }): Constraint {
  return {
    type: "correctness", statement: "x", scope: ["src/auth/**"], severity: "warning",
    enforcement: "advisory_v1", rationale: "", source_decision: null, violations: [],
    status: "active", valid_from: undefined, valid_to: null,
    provenance: { source: "human_confirmed", confidence: 1, evidence: [] },
    ...over,
  };
}

test("regressionHits flags re-adding a symbol an in-force decision retired", () => {
  const { store, cleanup } = tempStore();
  try {
    store.json.put("decisions", mkDecision({
      id: "dec_redis", title: "Redis sessions, drop stateless login",
      related_files: ["src/auth/session.ts"], retired: { symbols: ["login"], deps: ["jsonwebtoken"] },
    }));
    const hits = store.regressionHits({ symbols: ["login", "verifySession"], deps: [] }, ["src/auth/session.ts"]);
    assert.equal(hits.length, 1, "only the retired symbol is a hit");
    assert.equal(hits[0]!.name, "login");
    assert.equal(hits[0]!.kind, "symbol");
    assert.equal(hits[0]!.decision, "dec_redis");
    assert.equal(hits[0]!.blocking, false, "no blocking constraint links this decision → advisory");
  } finally {
    cleanup();
  }
});

test("regressionHits flags a re-added dependency too", () => {
  const { store, cleanup } = tempStore();
  try {
    store.json.put("decisions", mkDecision({ id: "dec_x", retired: { symbols: [], deps: ["jsonwebtoken"] } }));
    const hits = store.regressionHits({ symbols: [], deps: ["jsonwebtoken", "redis"] }, ["src/auth/session.ts"]);
    assert.deepEqual(hits.map((h) => `${h.kind}:${h.name}`), ["dep:jsonwebtoken"]);
  } finally {
    cleanup();
  }
});

test("regressionHits marks a hit BLOCKING when a blocking constraint links the decision", () => {
  const { store, cleanup } = tempStore();
  try {
    store.json.put("decisions", mkDecision({ id: "dec_sec", retired: { symbols: ["login"], deps: [] } }));
    store.json.put("constraints", mkConstraint({
      id: "con_sec", severity: "blocking", source_decision: "dec_sec",
      statement: "Never trust JWT expiry alone for logout",
    }));
    const hits = store.regressionHits({ symbols: ["login"], deps: [] }, ["src/auth/session.ts"]);
    assert.equal(hits.length, 1);
    assert.equal(hits[0]!.blocking, true, "blocking-linked → the strict guard would fail the commit");
  } finally {
    cleanup();
  }
});

test("regressionHits ignores a SUPERSEDED decision's retired set (not current design)", () => {
  const { store, cleanup } = tempStore();
  try {
    store.json.put("decisions", mkDecision({
      id: "dec_old", status: "superseded", superseded_by: "dec_new", valid_to: "2026-03-01T00:00:00Z",
      retired: { symbols: ["login"], deps: [] },
    }));
    const hits = store.regressionHits({ symbols: ["login"], deps: [] }, ["src/auth/session.ts"]);
    assert.equal(hits.length, 0, "re-adding what an outdated decision removed is not a regression");
  } finally {
    cleanup();
  }
});

test("regressionHits is scoped: a retired symbol in an unrelated file does not match", () => {
  const { store, cleanup } = tempStore();
  try {
    store.json.put("decisions", mkDecision({
      id: "dec_billing", related_files: ["src/billing/charge.ts"], retired: { symbols: ["login"], deps: [] },
    }));
    const hits = store.regressionHits({ symbols: ["login"], deps: [] }, ["src/auth/session.ts"]);
    assert.equal(hits.length, 0, "different file → no false positive");
  } finally {
    cleanup();
  }
});

test("regressionHits returns nothing when the diff adds nothing retired", () => {
  const { store, cleanup } = tempStore();
  try {
    store.json.put("decisions", mkDecision({ id: "dec_x", retired: { symbols: ["login"], deps: [] } }));
    assert.deepEqual(store.regressionHits({ symbols: [], deps: [] }, ["src/auth/session.ts"]), []);
    assert.deepEqual(store.regressionHits({ symbols: ["other"], deps: [] }, ["src/auth/session.ts"]), []);
  } finally {
    cleanup();
  }
});

test("regressionHits file-matches on path segments, not bare suffix (no `re.ts`↔`store.ts`)", () => {
  const { store, cleanup } = tempStore();
  try {
    store.json.put("decisions", mkDecision({
      id: "dec_store", related_files: ["src/store.ts"], retired: { symbols: ["login"], deps: [] },
    }));
    // editing src/core.ts must NOT match dec_store just because "core.ts"/"store.ts"
    // share a bare-endsWith tail — only a true path-segment suffix counts.
    const hits = store.regressionHits({ symbols: ["login"], deps: [] }, ["src/core.ts"]);
    assert.equal(hits.length, 0, "segment-boundary match avoids the bare-endsWith false positive");
  } finally {
    cleanup();
  }
});

test("regressionHits dedups a symbol retired by two decisions, keeping the blocking attribution", () => {
  const { store, cleanup } = tempStore();
  try {
    store.json.put("decisions", mkDecision({ id: "dec_plain", retired: { symbols: ["login"], deps: [] } }));
    store.json.put("decisions", mkDecision({ id: "dec_block", retired: { symbols: ["login"], deps: [] } }));
    store.json.put("constraints", mkConstraint({ id: "con_b", severity: "blocking", source_decision: "dec_block" }));
    const hits = store.regressionHits({ symbols: ["login"], deps: [] }, ["src/auth/session.ts"]);
    assert.equal(hits.length, 1, "one hit per resurrected item");
    assert.equal(hits[0]!.blocking, true, "deduped hit keeps the blocking-linked decision");
    assert.equal(hits[0]!.decision, "dec_block");
  } finally {
    cleanup();
  }
});

test("retiredForFile surfaces in-force retirements for agent-hook grounding", () => {
  const { store, cleanup } = tempStore();
  try {
    store.json.put("decisions", mkDecision({ id: "dec_in", retired: { symbols: ["login"], deps: ["jsonwebtoken"] } }));
    store.json.put("decisions", mkDecision({
      id: "dec_sup", status: "superseded", superseded_by: "dec_in", retired: { symbols: ["zzz"], deps: [] },
    }));
    const notes = store.retiredForFile("src/auth/session.ts");
    assert.equal(notes.length, 1, "superseded decision excluded");
    assert.equal(notes[0]!.decision, "dec_in");
    assert.deepEqual(notes[0]!.symbols, ["login"]);
  } finally {
    cleanup();
  }
});
