import { test } from "node:test";
import assert from "node:assert/strict";
import { tempStore, prov } from "./helpers.js";
import { recordFailure, salientTerms } from "../src/synthesis/synthesize.js";
import { selectProvider } from "../src/synthesis/provider.js";

// Force the deterministic provider so tests never need credentials.
process.env.BRAIN_SYNTH_PROVIDER = "deterministic";

test("deterministic provider is always available and drafts a low-confidence decision", async () => {
  const p = await selectProvider();
  assert.equal(p.name, "deterministic");
  const d = await p.draftDecision({ subject: "feat: add X", body: "", files: ["src/x.ts"], diff: "" });
  assert.ok(d.title.length > 0);
  assert.ok(d.confidence <= 0.4, "auto-captured = advisory/low-confidence");
});

test("recordFailure ranks suspects, writes a bug, and promotes a constraint on recurrence", async () => {
  const { store, root, cleanup } = tempStore();
  store.json.replaceAll("symbols", [
    { id: "sym_a", file: "src/auth/session.ts", name: "verifySession", kind: "function", signature_hash: "", calls: [], called_by: [], metrics: { loc: 40, churn_90d: 14, bug_count: 0, fan_in: 5, fan_out: 0 }, last_changed: "" },
  ] as never);
  store.json.put("components", { id: "cmp_auth", kind: "module", name: "Auth", responsibility: "", paths: ["src/auth/**"], status: "active", owners: [], fragility: 0, provenance: prov(0.6), created_at: "2026-01-01T00:00:00Z", updated_at: "2026-01-01T00:00:00Z" } as never);
  store.reindex();

  // First failure (one test), then a DIFFERENT test failing with the same symptom
  // class — a genuine recurrence (distinct bug id, overlapping symptom).
  const first = await recordFailure(store, root, {
    test: "auth.revocation.spec.ts",
    message: "verifySession returned a valid session for a revoked token",
  });
  assert.equal(first.bug.status, "open");
  assert.ok(first.bug.affected_symbols.includes("sym_a"), "ranked the mentioned symbol as a suspect");
  store.reindex(); // CLI reindexes after each record-bug, so the next run sees this bug

  const second = await recordFailure(store, root, {
    test: "auth.logout.spec.ts",
    message: "verifySession returned a valid session for a revoked token after logout",
  });
  assert.notEqual(second.bug.id, first.bug.id, "distinct bug id");
  assert.equal(second.bug.lineage.recurrence_of, first.bug.id, "detected recurrence");
  assert.ok(second.constraint, "promoted a regression constraint on recurrence");
  assert.equal(second.bug.lineage.spawned_constraint, second.constraint!.id);

  const comp = store.json.get("components", "cmp_auth")!;
  assert.ok(comp.fragility > 0, "raised component fragility");
  cleanup();
});

test("UNRELATED failures are NOT flagged as recurrence (regression #1: no boilerplate false-positive)", async () => {
  const { store, root, cleanup } = tempStore();
  store.json.replaceAll("symbols", [
    { id: "sym_db", file: "src/db.ts", name: "query", kind: "function", signature_hash: "", calls: [], called_by: [], metrics: { loc: 5, churn_90d: 1, bug_count: 0, fan_in: 1, fan_out: 0 }, last_changed: "" },
    { id: "sym_api", file: "src/api.ts", name: "handler", kind: "function", signature_hash: "", calls: [], called_by: [], metrics: { loc: 5, churn_90d: 1, bug_count: 0, fan_in: 1, fan_out: 0 }, last_changed: "" },
  ] as never);
  store.reindex();

  await recordFailure(store, root, { test: "db.spec.ts", message: "query connection timeout exceeded" });
  store.reindex();
  const second = await recordFailure(store, root, { test: "api.spec.ts", message: "handler response timeout exceeded" });
  // shared boilerplate ("timeout","exceeded"/"spec") must NOT trip recurrence
  assert.equal(second.bug.lineage.recurrence_of, null, "unrelated failures not a recurrence");
  assert.equal(second.constraint, undefined, "no bogus constraint promoted");
  cleanup();
});

test("salientTerms strips the synthetic suspect list but keeps legitimate prose (regression R4 #1)", () => {
  // deterministic synthetic list ("<ident> @ <path>") -> identifiers stripped
  const synthetic = salientTerms("Suspected in: parseConfig @ src/a.ts, loadStore @ src/b.ts");
  assert.ok(!synthetic.has("parseconfig") && !synthetic.has("loadstore"), "suspect identifiers removed");
  // legitimate LLM prose that merely contains the phrase (no "<ident> @") is preserved
  const prose = salientTerms("Stale entries served. Suspected in: the warmer. TTL comparison uses seconds so entries never expire and eviction is skipped");
  for (const t of ["comparison", "seconds", "expire", "eviction", "skipped"]) {
    assert.ok(prose.has(t), `diagnostic term "${t}" preserved`);
  }
});

test("no-mention failures do NOT recur via the shared fallback suspect list (regression R3 #1)", async () => {
  const { store, root, cleanup } = tempStore();
  // several symbols, NONE named in either failure message → deterministic provider
  // falls back to the same churn-ranked suspects for both (the trap).
  store.json.replaceAll("symbols", ["alpha", "beta", "gamma", "delta"].map((n, i) => ({
    id: `sym_${n}`, file: `src/${n}.ts`, name: n, kind: "function", signature_hash: "",
    calls: [], called_by: [], metrics: { loc: 5, churn_90d: 5 - i, bug_count: 0, fan_in: 5 - i, fan_out: 0 }, last_changed: "",
  })) as never);
  store.reindex();

  await recordFailure(store, root, { test: "t1.spec.ts", message: "expected 200 but got 500" });
  store.reindex();
  const second = await recordFailure(store, root, { test: "t2.spec.ts", message: "AssertionError values are different" });
  assert.equal(second.bug.lineage.recurrence_of, null, "unrelated no-mention failures are not a recurrence");
  assert.equal(second.constraint, undefined, "no bogus constraint promoted");
  cleanup();
});

test("decision capture is idempotent for the same commit+title", async () => {
  const { store, cleanup } = tempStore();
  store.json.put("decisions", { id: "x", title: "t", status: "proposed", context: "", decision: "", consequences: [], alternatives_rejected: [], related_components: [], related_files: [], supersedes: null, caused_by_bug: null, commit: "abc", provenance: prov(0.3), date: "2026-01-01T00:00:00Z" } as never);
  const before = store.json.loadAll("decisions").length;
  store.json.put("decisions", { id: "x", title: "t2", status: "proposed", context: "", decision: "", consequences: [], alternatives_rejected: [], related_components: [], related_files: [], supersedes: null, caused_by_bug: null, commit: "abc", provenance: prov(0.3), date: "2026-01-01T00:00:00Z" } as never);
  assert.equal(store.json.loadAll("decisions").length, before, "same id updates, not duplicates");
  cleanup();
});
