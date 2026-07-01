import { test } from "node:test";
import assert from "node:assert/strict";
import type { Decision } from "../src/core/types.js";
import { groundDecisions, renderGrounding, GROUNDING_STALE_DAYS } from "../src/core/grounding.js";
import { tempStore } from "./helpers.js";

function dec(over: Partial<Decision>): Decision {
  return {
    id: "dec_x", title: "t", topic: null, status: "accepted", context: "", decision: "",
    consequences: [], alternatives_rejected: [], rejected_tripwires: [], related_components: [],
    related_files: [], supersedes: null, superseded_by: null, caused_by_bug: null, commit: null,
    valid_from: "2025-01-01T00:00:00Z", valid_to: null, retired: { symbols: [], deps: [] },
    provenance: { source: "human_confirmed", confidence: 0.9, evidence: [] }, date: "2025-01-01T00:00:00Z",
    ...over,
  };
}

const NOW = Date.parse("2026-07-01T00:00:00Z");
const daysAgo = (n: number) => new Date(NOW - n * 86_400_000).toISOString();

test("grounds a fresh anchored decision as AUTHORITATIVE (graph over doc)", () => {
  const d = dec({ id: "dec_1", topic: "auth-transport", decision: "Use GraphQL", last_affirmed_at: daysAgo(30), related_files: ["api/schema.ts"] });
  const g = groundDecisions([d], [d], NOW);
  assert.equal(g.length, 1);
  assert.equal(g[0]!.authority, "authoritative");
  assert.equal(g[0]!.ageDays, 30);
  assert.match(renderGrounding(g), /graph overrides any doc/);
  assert.match(renderGrounding(g), /Use GraphQL \[dec_1\]/);
});

test("an aged decision (past the staleness window) downgrades to ADVISORY", () => {
  const d = dec({ id: "dec_1", topic: "auth-transport", decision: "Use GraphQL", last_affirmed_at: daysAgo(GROUNDING_STALE_DAYS + 5), related_files: ["api/schema.ts"] });
  const g = groundDecisions([d], [d], NOW);
  assert.equal(g[0]!.authority, "advisory", "aged past the window is advisory, not hard authority");
  assert.match(renderGrounding(g), /ADVISORY/);
  assert.doesNotMatch(renderGrounding(g), /graph overrides/);
});

test("un-anchored decisions inject nothing (topic null)", () => {
  const d = dec({ id: "dec_1", topic: null, decision: "whatever", related_files: ["a.ts"] });
  assert.deepEqual(groundDecisions([d], [d], NOW), []);
  assert.equal(renderGrounding(groundDecisions([d], [d], NOW)), "");
});

test("FAIL-SAFE: a topic in an unresolved collision injects nothing", () => {
  const a = dec({ id: "dec_a", topic: "api-format", decision: "REST", last_affirmed_at: daysAgo(1) });
  const b = dec({ id: "dec_b", topic: "api-format", decision: "GraphQL", last_affirmed_at: daysAgo(1) });
  // the file references dec_a; but the topic has two live decisions → ambiguous
  assert.deepEqual(groundDecisions([a], [a, b], NOW), [], "ambiguous topic → no injection");
});

test("a superseded local reference grounds to the CURRENT successor", () => {
  const old = dec({ id: "dec_old", topic: "api-format", decision: "REST", status: "superseded", superseded_by: "dec_new", valid_to: daysAgo(60) });
  const cur = dec({ id: "dec_new", topic: "api-format", decision: "GraphQL", last_affirmed_at: daysAgo(60), valid_from: daysAgo(60) });
  // the file still links the OLD (superseded) decision; grounding injects the successor
  const g = groundDecisions([old], [old, cur], NOW);
  assert.equal(g.length, 1);
  assert.equal(g[0]!.decision.id, "dec_new", "grounds to the current decision, not the stale one the file references");
});

test("no freshness clock → ADVISORY (can't prove fresh, so never hard authority)", () => {
  const d = dec({ id: "dec_1", topic: "auth", decision: "x", last_affirmed_at: undefined });
  const g = groundDecisions([d], [d], NOW);
  assert.equal(g[0]!.ageDays, null);
  assert.equal(g[0]!.authority, "advisory", "unknown freshness is never injected as hard authority");
});

test("a FUTURE last_affirmed_at (clock skew / corruption) is anomalous → advisory, not hard authority", () => {
  const d = dec({ id: "dec_1", topic: "auth", decision: "x", last_affirmed_at: new Date(NOW + 5 * 86_400_000).toISOString() });
  const g = groundDecisions([d], [d], NOW);
  assert.equal(g[0]!.ageDays, null, "a future age is not clamped to 0 (which would read as freshest)");
  assert.equal(g[0]!.authority, "advisory", "an impossible freshness clock must not upgrade a rotted decision to authority");
});

test("target scope: a topic's current decision only grounds a file it actually governs (M2)", () => {
  const old = dec({ id: "dec_old", topic: "cache", decision: "old", status: "superseded", superseded_by: "dec_new", valid_to: daysAgo(30), related_files: ["handler.ts", "job.ts"] });
  const cur = dec({ id: "dec_new", topic: "cache", decision: "new", last_affirmed_at: daysAgo(5), related_files: ["job.ts"] });
  assert.equal(groundDecisions([old], [old, cur], NOW, "job.ts").length, 1, "successor governs job.ts → grounded");
  assert.equal(groundDecisions([old], [old, cur], NOW, "handler.ts").length, 0, "successor dropped handler.ts → not grounded (no false authority)");
  assert.equal(groundDecisions([old], [old, cur], NOW).length, 1, "no target → topic-level grounding (backwards compatible)");
});

test("end-to-end: grounding surfaces the current decision for an edited anchored file (the atom)", (t) => {
  const { store, cleanup } = tempStore();
  t.after(cleanup);
  // Capture one decision anchored to a file, with a topic — the atom's step 1.
  store.json.put("decisions", dec({
    id: "dec_gql", topic: "auth-transport", title: "Public API transport",
    decision: "Use GraphQL for the public API", alternatives_rejected: ["REST"],
    related_files: ["api/schema.ts"], last_affirmed_at: new Date().toISOString(),
  }));
  // The hook's real read path: what Hunch knows about the file being edited.
  const ctx = store.assembleContext("api/schema.ts");
  assert.ok(ctx.decisions.some((d) => d.id === "dec_gql"), "the anchored decision is in scope of the file");
  // Grounding injects the CURRENT decision for the topic over whatever the file's doc says.
  const grounding = renderGrounding(groundDecisions(ctx.decisions, store.recs("decisions"), Date.now()));
  assert.match(grounding, /auth-transport/);
  assert.match(grounding, /Use GraphQL for the public API/);
  assert.match(grounding, /graph overrides any doc/);
});
