import { test } from "node:test";
import assert from "node:assert/strict";
import type { Decision } from "../src/core/types.js";
import { isLive, liveForTopic, currentForTopic, historyForTopic, rejectedForTopic, captureConflicts, topicCollisions, renderGrounding } from "../src/core/topics.js";

/** Minimal valid Decision with sane defaults; override per test. */
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

test("isLive gates on status + both closure links open", () => {
  assert.equal(isLive(dec({ status: "accepted", superseded_by: null, valid_to: null })), true);
  assert.equal(isLive(dec({ status: "proposed" })), false);
  assert.equal(isLive(dec({ status: "superseded" })), false);
  assert.equal(isLive(dec({ superseded_by: "dec_new" })), false);
  assert.equal(isLive(dec({ valid_to: "2025-06-01T00:00:00Z" })), false);
});

test("currentForTopic returns the single live decision, or null when none", () => {
  const decs = [dec({ id: "dec_1", topic: "auth-transport", decision: "Use GraphQL" }), dec({ id: "dec_2", topic: "logging" })];
  assert.equal(currentForTopic(decs, "auth-transport")?.id, "dec_1");
  assert.equal(currentForTopic(decs, "never-captured"), null);
});

test("currentForTopic FAILS SAFE on an unresolved collision (>1 live → null)", () => {
  const decs = [dec({ id: "dec_a", topic: "api-format", decision: "REST" }), dec({ id: "dec_b", topic: "api-format", decision: "GraphQL" })];
  assert.equal(liveForTopic(decs, "api-format").length, 2);
  assert.equal(currentForTopic(decs, "api-format"), null);
});

test("a superseded decision is not current; its successor is", () => {
  const decs = [
    dec({ id: "dec_old", topic: "api-format", status: "superseded", superseded_by: "dec_new", valid_to: "2025-06-01T00:00:00Z" }),
    dec({ id: "dec_new", topic: "api-format", decision: "GraphQL", valid_from: "2025-06-01T00:00:00Z" }),
  ];
  assert.equal(currentForTopic(decs, "api-format")?.id, "dec_new");
});

test("historyForTopic returns the full chain newest-first", () => {
  const decs = [
    dec({ id: "dec_old", topic: "api-format", valid_from: "2024-01-01T00:00:00Z", status: "superseded", superseded_by: "dec_new", valid_to: "2025-06-01T00:00:00Z" }),
    dec({ id: "dec_new", topic: "api-format", valid_from: "2025-06-01T00:00:00Z" }),
    dec({ id: "dec_other", topic: "logging", valid_from: "2025-01-01T00:00:00Z" }),
  ];
  assert.deepEqual(historyForTopic(decs, "api-format").map((d) => d.id), ["dec_new", "dec_old"]);
});

test("rejectedForTopic returns the current decision's rejected alternatives; empty on collision", () => {
  const ok = [dec({ id: "dec_1", topic: "api-format", alternatives_rejected: ["REST", "gRPC"] })];
  assert.deepEqual(rejectedForTopic(ok, "api-format"), ["REST", "gRPC"]);
  const collision = [dec({ id: "dec_a", topic: "api-format", alternatives_rejected: ["REST"] }), dec({ id: "dec_b", topic: "api-format", alternatives_rejected: ["gRPC"] })];
  assert.deepEqual(rejectedForTopic(collision, "api-format"), []);
});

test("captureConflicts: the guard's decision — excludes self and the incumbent it will close", () => {
  const decs = [dec({ id: "dec_live", topic: "auth" })];
  assert.deepEqual(captureConflicts(decs, "auth", "dec_new", null).map((d) => d.id), ["dec_live"]);
  assert.deepEqual(captureConflicts(decs, "auth", "dec_new", "dec_live"), []);
  assert.deepEqual(captureConflicts(decs, "auth", "dec_live", null), []);
  // cross-store: willClose passed null (can't close cross-store) → incumbent stays flagged
  assert.deepEqual(captureConflicts(decs, "auth", "dec_new", null).map((d) => d.id), ["dec_live"]);
});

test("topicCollisions finds only topics with >1 live decision, sorted by id", () => {
  const decs = [
    dec({ id: "dec_a", topic: "api-format" }), dec({ id: "dec_b", topic: "api-format" }),
    dec({ id: "dec_solo", topic: "logging" }),
    dec({ id: "dec_old", topic: "auth", status: "superseded", superseded_by: "dec_new", valid_to: "2025-06-01T00:00:00Z" }),
    dec({ id: "dec_new", topic: "auth" }),
    dec({ id: "dec_null", topic: null }),
  ];
  const cols = topicCollisions(decs);
  assert.deepEqual([...cols.keys()], ["api-format"]);
  assert.deepEqual(cols.get("api-format")!.map((d) => d.id), ["dec_a", "dec_b"]);
});

test("renderGrounding surfaces in-force topic-anchored decisions; skips un-anchored/superseded", () => {
  const anchored = dec({ id: "dec_1", topic: "auth-transport", decision: "Use GraphQL", alternatives_rejected: ["REST"] });
  const g = renderGrounding([anchored]);
  assert.match(g, /auth-transport/);
  assert.match(g, /Use GraphQL \[dec_1\]/);
  assert.match(g, /rejected: REST/);
  assert.match(g, /graph, not a stale doc/);
  assert.equal(renderGrounding([dec({ id: "d", topic: null, decision: "x" })]), "", "un-anchored → nothing");
  assert.equal(renderGrounding([dec({ id: "d", topic: "t", status: "superseded", superseded_by: "d2" })]), "", "superseded → nothing");
});
