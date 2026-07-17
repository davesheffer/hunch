import { test } from "node:test";
import assert from "node:assert/strict";
import { tempStore, prov } from "./helpers.js";
import { openMemoryDb, type DB } from "../src/store/db.js";

function seed() {
  const ctx = tempStore();
  const { store } = ctx;
  store.json.replaceAll("symbols", [
    { id: "sym_a", file: "src/auth/session.ts", name: "verifySession", kind: "function", signature_hash: "", calls: [], called_by: [], metrics: { loc: 40, churn_90d: 14, bug_count: 3, fan_in: 2, fan_out: 0 }, last_changed: "" },
    { id: "sym_b", file: "src/billing/charge.ts", name: "charge", kind: "function", signature_hash: "", calls: ["sym_a"], called_by: [], metrics: { loc: 30, churn_90d: 1, bug_count: 0, fan_in: 0, fan_out: 1 }, last_changed: "" },
    { id: "sym_c", file: "src/api/mw.ts", name: "mw", kind: "function", signature_hash: "", calls: ["sym_a"], called_by: [], metrics: { loc: 10, churn_90d: 0, bug_count: 0, fan_in: 0, fan_out: 1 }, last_changed: "" },
  ] as never);
  store.json.replaceAll("edges", [
    { id: "e1", from: "sym_b", to: "sym_a", type: "calls", reason: "", strength: 1, provenance: prov() },
    { id: "e2", from: "sym_c", to: "sym_a", type: "calls", reason: "", strength: 1, provenance: prov() },
  ] as never);
  store.json.put("decisions", { id: "dec_1", title: "Sessions in Redis", status: "accepted", context: "Token leak forced logout impossible", decision: "Server-side sessions", consequences: [], alternatives_rejected: [], related_components: [], related_files: ["src/auth/session.ts"], supersedes: null, caused_by_bug: "bug_1", commit: null, provenance: prov(0.95), date: "2026-05-30T12:00:00Z" } as never);
  store.json.put("bugs", { id: "bug_1", title: "Leaked token usable after reset", symptom: "old token authenticated", root_cause: "stateless JWT not revocable", severity: "critical", status: "fixed", affected_files: ["src/auth/session.ts"], affected_symbols: ["sym_a"], lineage: { introduced_commit: "f00", detected: "t", fixed_commit: "a1b", recurrence_of: null, spawned_decision: "dec_1", spawned_constraint: "con_1" }, provenance: prov(0.88) } as never);
  store.json.put("constraints", { id: "con_1", type: "security", statement: "Revocation must be server-side", scope: ["src/auth/**"], severity: "blocking", enforcement: "advisory_v1", rationale: "from bug_1", source_decision: "dec_1", violations: [], provenance: prov(0.9) } as never);
  store.reindex();
  return ctx;
}

test("reindex counts every entity", () => {
  const { store, cleanup } = seed();
  const { counts } = store.reindex();
  assert.equal(counts.symbols, 3);
  assert.equal(counts.decisions, 1);
  assert.equal(counts.constraints, 1);
  cleanup();
});

test("FTS search finds decision + constraint by topic", () => {
  const { store, cleanup } = seed();
  const refs = store.search("revocation redis").map((h) => h.ref);
  assert.ok(refs.includes("dec_1"));
  cleanup();
});

test("why() returns decisions/bugs/constraints for a file", () => {
  const { store, cleanup } = seed();
  const w = store.why("src/auth/session.ts");
  assert.deepEqual(w.decisions.map((d) => d.id), ["dec_1"]);
  assert.deepEqual(w.bugs.map((b) => b.id), ["bug_1"]);
  assert.deepEqual(w.constraints.map((c) => c.id), ["con_1"]);
  cleanup();
});

test("getDependents walks the graph backward (blast radius)", () => {
  const { store, cleanup } = seed();
  const deps = store.getDependents("sym_a").map((d) => d.id).sort();
  assert.deepEqual(deps, ["sym_b", "sym_c"]);
  assert.deepEqual(store.getDependencies("sym_a"), []);
  cleanup();
});

test("checkConstraints matches by glob scope, severity-sorted", () => {
  const { store, cleanup } = seed();
  const cons = store.checkConstraints("src/auth/session.ts");
  assert.equal(cons[0]?.id, "con_1");
  assert.equal(store.checkConstraints("src/other/x.ts").length, 0);
  cleanup();
});

test("bugLineage finds by symbol and exposes lineage", () => {
  const { store, cleanup } = seed();
  const bugs = store.bugLineage("sym_a");
  assert.equal(bugs[0]?.id, "bug_1");
  assert.equal(bugs[0]?.lineage.fixed_commit, "a1b");
  cleanup();
});

test("fragility ranks the buggy, churned, central symbol first", () => {
  const { store, cleanup } = seed();
  const top = store.fragility(3);
  assert.equal(top[0]?.name, "verifySession");
  assert.ok(top[0]!.score >= top[1]!.score);
  cleanup();
});

test("non-ASCII (CJK) query returns results, never silently [] (regression #2)", () => {
  const { store, cleanup } = tempStore();
  store.json.put("decisions", { id: "dec_jp", title: "セッションをRedisに保存", status: "accepted", context: "", decision: "サーバ側セッション", consequences: [], alternatives_rejected: [], related_components: [], related_files: [], supersedes: null, caused_by_bug: null, commit: null, provenance: prov(0.9), date: "2026-01-01T00:00:00Z" } as never);
  store.reindex();
  const refs = store.search("セッション").map((h) => h.ref);
  assert.ok(refs.includes("dec_jp"), "CJK query matched (FTS or LIKE), not empty");
  cleanup();
});

test("punctuation-only query (no FTS tokens) uses the LIKE fallback (regression #2/#11)", () => {
  const { store, cleanup } = tempStore();
  // statement contains "::" — a token that toFtsQuery() maps to null (no word chars)
  store.json.put("constraints", { id: "con_ns", type: "architecture", statement: "Namespace symbols with :: separators", scope: ["src/**"], severity: "advisory", enforcement: "advisory_v1", rationale: "", source_decision: null, violations: [], provenance: prov(0.8) } as never);
  store.reindex();
  const refs = store.search("::").map((h) => h.ref);
  assert.ok(refs.includes("con_ns"), "punctuation-only query matched via LIKE, not empty");
  cleanup();
});

test("plain search fallback keeps reindex and scoped retrieval working without FTS5", async () => {
  const { store, cleanup } = tempStore();
  // Inject the same schema openDb selects when sqlite_compileoption_used reports
  // no ENABLE_FTS5 (the official Linux Node build exercised this path in CI).
  (store as unknown as { _db: DB | null })._db = openMemoryDb({ forcePlainSearch: true });
  store.json.put("decisions", {
    id: "dec_plain", title: "Redis session memory", status: "accepted", context: "", decision: "Keep sessions server-side",
    consequences: [], alternatives_rejected: [], related_components: [], related_files: [], supersedes: null,
    caused_by_bug: null, commit: null, provenance: prov(0.9), date: "2026-07-17T00:00:00Z",
  } as never);
  store.json.put("runbooks", {
    id: "rb_plain", task: "release version", trigger: ["publish package"], steps: ["run tests"], gotchas: [],
    outcome: "published", files: ["package.json"], source_range: null,
    valid_from: "2026-07-17T00:00:00Z", valid_to: null,
    provenance: prov(0.9), date: "2026-07-17T00:00:00Z",
  } as never);
  store.reindex();

  assert.ok(store.search("redis sessions").some((hit) => hit.ref === "dec_plain"));
  assert.ok((await store.searchRunbooks("release package")).some((hit) => hit.ref === "rb_plain"));
  const schema = store.db.prepare(`SELECT sql FROM sqlite_master WHERE name = 'search'`).get() as { sql: string };
  assert.doesNotMatch(schema.sql, /VIRTUAL\s+TABLE/i);
  cleanup();
});
