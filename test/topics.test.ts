import { test } from "node:test";
import assert from "node:assert/strict";
import type { Decision } from "../src/core/types.js";
import { isLive, liveForTopic, currentForTopic, historyForTopic, rejectedForTopic, topicCollisions, captureConflicts } from "../src/core/topics.js";

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
  assert.equal(isLive(dec({ status: "proposed" })), false, "proposed is not live");
  assert.equal(isLive(dec({ status: "superseded" })), false);
  assert.equal(isLive(dec({ superseded_by: "dec_new" })), false, "superseded_by closes it");
  assert.equal(isLive(dec({ valid_to: "2025-06-01T00:00:00Z" })), false, "valid_to closes the window");
});

test("currentForTopic returns the single live decision, or null when none", () => {
  const decs = [
    dec({ id: "dec_1", topic: "auth-transport", decision: "Use GraphQL" }),
    dec({ id: "dec_2", topic: "logging", decision: "Use pino" }),
  ];
  assert.equal(currentForTopic(decs, "auth-transport")?.id, "dec_1");
  assert.equal(currentForTopic(decs, "never-captured"), null);
});

test("currentForTopic FAILS SAFE on an unresolved collision (>1 live → null)", () => {
  // two live accepted decisions for one topic — the invariant is violated (e.g. a
  // git merge landed both). grounding must inject nothing rather than pick one.
  const decs = [
    dec({ id: "dec_a", topic: "api-format", decision: "REST" }),
    dec({ id: "dec_b", topic: "api-format", decision: "GraphQL" }),
  ];
  assert.equal(liveForTopic(decs, "api-format").length, 2, "collision is visible to the guard");
  assert.equal(currentForTopic(decs, "api-format"), null, "ambiguous → not injected as authority");
});

test("a superseded decision is not current; its successor is", () => {
  const decs = [
    dec({ id: "dec_old", topic: "api-format", decision: "REST", status: "superseded", superseded_by: "dec_new", valid_to: "2025-06-01T00:00:00Z" }),
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

test("topicCollisions finds only topics with >1 live decision, sorted by id", () => {
  const decs = [
    dec({ id: "dec_a", topic: "api-format" }),           // collision with dec_b
    dec({ id: "dec_b", topic: "api-format" }),
    dec({ id: "dec_solo", topic: "logging" }),           // single — not a collision
    dec({ id: "dec_old", topic: "auth", status: "superseded", superseded_by: "dec_new", valid_to: "2025-06-01T00:00:00Z" }),
    dec({ id: "dec_new", topic: "auth" }),               // only one LIVE on 'auth' — not a collision
    dec({ id: "dec_null", topic: null }),                // un-anchored — ignored
  ];
  const cols = topicCollisions(decs);
  assert.deepEqual([...cols.keys()], ["api-format"], "only the topic with 2 live decisions");
  assert.deepEqual(cols.get("api-format")!.map((d) => d.id), ["dec_a", "dec_b"], "sorted by id");
});

test("topicCollisions is empty on a healthy graph", () => {
  const decs = [dec({ id: "dec_1", topic: "a" }), dec({ id: "dec_2", topic: "b" })];
  assert.equal(topicCollisions(decs).size, 0);
});

test("captureConflicts: the capture guard's decision — excludes self and the incumbent it will close", () => {
  const decs = [dec({ id: "dec_live", topic: "auth" })];
  // a new accepted decision on 'auth' superseding nothing → conflicts with the live one
  assert.deepEqual(captureConflicts(decs, "auth", "dec_new", null).map((d) => d.id), ["dec_live"]);
  // superseding the incumbent (same store, willClose set) → no conflict, the write is allowed
  assert.deepEqual(captureConflicts(decs, "auth", "dec_new", "dec_live"), []);
  // re-recording the same id → excluded as self → no conflict (idempotent upgrade)
  assert.deepEqual(captureConflicts(decs, "auth", "dec_live", null), []);
  // CROSS-STORE (M1): a supersede that can't be closed here is passed as willClose=null,
  // so the incumbent stays counted and the write is refused — never two live decisions.
  assert.deepEqual(captureConflicts(decs, "auth", "dec_new", null).map((d) => d.id), ["dec_live"]);
});

test("rejectedForTopic returns the current decision's rejected alternatives; empty on collision", () => {
  const ok = [dec({ id: "dec_1", topic: "api-format", alternatives_rejected: ["REST", "gRPC"] })];
  assert.deepEqual(rejectedForTopic(ok, "api-format"), ["REST", "gRPC"]);
  const collision = [
    dec({ id: "dec_a", topic: "api-format", alternatives_rejected: ["REST"] }),
    dec({ id: "dec_b", topic: "api-format", alternatives_rejected: ["gRPC"] }),
  ];
  assert.deepEqual(rejectedForTopic(collision, "api-format"), [], "no unambiguous current → nothing to enforce");
});
