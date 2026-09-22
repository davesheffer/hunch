import { cleanupDir } from "./fixtures.js";
/**
 * A contested topic must never be injected as authority (round-3 audit #5 and #6).
 *
 * #5 — src/core/topics.ts documents the fail-safe in its own header ("readers treat a
 * violation defensively — currentForTopic returns null on a collision so grounding never
 * injects an ambiguous topic as authority"). renderDocGrounding honours it. renderGrounding
 * — the one that feeds the PRE-EDIT hook, the last context an agent sees before it writes
 * code — did not: it filtered per-DECISION, so two live decisions on one topic each got
 * their own assertive bullet, and since each bullet lists what it REJECTED, the agent was
 * told both answers were correct and each was forbidden.
 *
 * #6 — hunch_escalations() is where such a collision is supposed to surface as a question
 * for the human. It read the PUBLIC store only, so in unified ("shared") mode — where the
 * public .hunch/ is just a routing shell — a real collision returned an empty list and the
 * agent was affirmatively told there was nothing to escalate.
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { renderGrounding } from "../src/core/topics.js";
import { pendingEscalations } from "../src/core/escalations.js";
import { hunchPaths } from "../src/core/paths.js";
import { HunchStore } from "../src/store/hunchStore.js";
import { prov } from "./helpers.js";

const NOW = "2026-08-06T00:00:00Z";
const DEC = (over: Record<string, unknown> = {}) => ({
  id: "dec_x", title: "t", topic: null, status: "accepted", context: "", decision: "",
  consequences: [], alternatives_rejected: [], rejected_tripwires: [],
  related_components: [], related_files: [], supersedes: null, superseded_by: null,
  caused_by_bug: null, commit: null, valid_from: NOW, valid_to: null,
  retired: { symbols: [], deps: [] }, provenance: prov(0.9), date: NOW,
  ...over,
});

const A = DEC({ id: "dec_graphql", topic: "api.transport", title: "Use GraphQL", decision: "Use GraphQL.", alternatives_rejected: ["REST"], related_files: ["src/api.ts"] });
const B = DEC({ id: "dec_rest", topic: "api.transport", title: "Use REST", decision: "Use REST.", alternatives_rejected: ["GraphQL"], related_files: ["src/api.ts"] });

test("a contested topic is NOT asserted as authority (#5)", () => {
  const out = renderGrounding([A, B] as never, [A, B] as never);
  assert.ok(!/• "api\.transport": Use GraphQL/.test(out), "the GraphQL side is not stated as the answer");
  assert.ok(!/• "api\.transport": Use REST/.test(out), "the REST side is not stated as the answer");
});

test("the conflict is NAMED, not silently dropped (#5)", () => {
  // Silence would read as "nothing is recorded here", which is how a contested topic
  // gets re-decided by accident — the opposite of the intended fail-safe.
  const out = renderGrounding([A, B] as never, [A, B] as never);
  assert.match(out, /UNRESOLVED/, "the collision is surfaced");
  assert.match(out, /api\.transport/, "…and names the topic");
  assert.ok(out.includes("dec_graphql") && out.includes("dec_rest"), "…and both colliding ids");
  assert.match(out, /ask the human/i, "…and routes it to the human, not the agent");
});

test("a collision whose sides live in DIFFERENT files is still caught (#5)", () => {
  // The file-scoped slice sees only one decision, so a per-file check would call it
  // settled and assert it. The global set is what makes this detectable.
  const farB = { ...B, related_files: ["src/other.ts"] };
  const fileSlice = [A];
  const out = renderGrounding(fileSlice as never, [A, farB] as never);
  assert.ok(!/• "api\.transport": Use GraphQL/.test(out), "must not assert a globally contested topic");
  assert.match(out, /UNRESOLVED/);
});

test("an UNcontested topic is still asserted normally (no regression) (#5)", () => {
  const solo = DEC({ id: "dec_solo", topic: "api.paging", title: "Cursor paging", decision: "Page by cursor.", alternatives_rejected: ["offset"] });
  const out = renderGrounding([solo] as never, [solo] as never);
  assert.match(out, /• "api\.paging": Page by cursor\. \[dec_solo\]/);
  assert.match(out, /rejected: offset/);
  assert.ok(!/UNRESOLVED/.test(out));
});

test("no anchored decisions still returns empty (no regression) (#5)", () => {
  assert.equal(renderGrounding([] as never, [] as never), "");
  assert.equal(renderGrounding([DEC({ id: "dec_untagged" })] as never, [] as never), "", "an un-anchored decision grounds nothing");
});

// ---- #6: the escalation corpus ----

function sharedStore(): { store: HunchStore; cleanup: () => void } {
  const sandbox = mkdtempSync(join(tmpdir(), "hunch-esc-"));
  const root = join(sandbox, "repo");
  const overlay = join(sandbox, "team-memory", ".hunch");
  mkdirSync(overlay, { recursive: true });
  mkdirSync(join(root, ".hunch"), { recursive: true });
  // mode "shared" = unified: the overlay IS the store, the public .hunch is a routing shell.
  writeFileSync(join(root, ".hunch", "local.json"), JSON.stringify({ privateDir: overlay, autoCommit: false, mode: "shared" }) + "\n");
  const store = new HunchStore(hunchPaths(root));
  store.json.ensureDirs();
  return { store, cleanup: () => { store.close(); cleanupDir(sandbox); } };
}

test("a topic collision in a SHARED overlay reaches the escalation surface (#6)", (t) => {
  const { store, cleanup } = sharedStore();
  t.after(cleanup);
  // Both colliding decisions live in the overlay — the only real store in this mode.
  store.putPrivate("decisions", A as never);
  store.putPrivate("decisions", B as never);

  assert.equal(store.json.loadAll("decisions").length, 0, "precondition: the public shell is empty");
  const viaPublicOnly = pendingEscalations(store.json.loadAll("decisions"));
  assert.deepEqual(viaPublicOnly, [], "the old corpus saw nothing — this is the defect");

  const items = pendingEscalations(store.advisoryRecs("decisions"));
  assert.ok(items.length >= 1, "the collision surfaces for the human");
  assert.ok(items.some((e) => e.question.includes("api.transport")), `the question names the topic, got ${JSON.stringify(items)}`);
});
