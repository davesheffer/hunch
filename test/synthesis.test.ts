import { test } from "node:test";
import assert from "node:assert/strict";
import { tempStore, prov } from "./helpers.js";
import { recordFailure, salientTerms, isSignificant, isTrivialSubject } from "../src/synthesis/synthesize.js";
import { selectProvider } from "../src/synthesis/provider.js";
import type { DiffAnalysis } from "../src/extractors/diff.js";

// Force the deterministic provider so tests never need credentials.
process.env.HUNCH_SYNTH_PROVIDER = "deterministic";

// Minimal DiffAnalysis with overrides for the field(s) under test.
function analysis(over: Partial<DiffAnalysis> = {}): DiffAnalysis {
  return {
    filesAdded: [], filesDeleted: [], filesModified: [], filesRenamed: [],
    addedSymbols: [], removedSymbols: [], changedSymbols: [],
    addedDeps: [], removedDeps: [], addedLines: 0, removedLines: 0,
    addedLinesByFile: new Map(), ...over,
  };
}

test("isSignificant gates the paid LLM: trivia → deterministic; real signal → LLM", () => {
  // no structural change, no churn, one file, no body → not worth a paid call
  assert.equal(isSignificant({ body: "" }, analysis(), ["src/a.ts"]), false);
  // any structural change qualifies
  assert.equal(isSignificant({ body: "" }, analysis({ addedSymbols: [{ name: "f", kind: "function" }] }), ["src/a.ts"]), true);
  assert.equal(isSignificant({ body: "" }, analysis({ addedDeps: ["redis"] }), ["src/a.ts"]), true);
  // churn over the line threshold qualifies
  assert.equal(isSignificant({ body: "" }, analysis({ addedLines: 8, removedLines: 8 }), ["src/a.ts"]), true);
  // several files qualify even with no structural delta
  assert.equal(isSignificant({ body: "" }, analysis(), ["a.ts", "b.ts", "c.ts"]), true);
  // an explanatory commit body (≥40 chars) qualifies (intent worth capturing)
  assert.equal(isSignificant({ body: "x".repeat(50) }, analysis(), ["src/a.ts"]), true);
});

test("isTrivialSubject: SKIP_SUBJECT match is skipped UNLESS the body is substantive (regression #4)", () => {
  // trivial subject, no body -> trivial (today's behavior, preserved)
  assert.equal(isTrivialSubject({ subject: "Merge branch 'main' into feature", body: "" }), true);
  assert.equal(isTrivialSubject({ subject: "bump: lodash to 4.2.0", body: "" }), true);
  // trivial subject, short/whitespace-only body -> still trivial
  assert.equal(isTrivialSubject({ subject: "wip", body: "   " }), true);
  assert.equal(isTrivialSubject({ subject: "format: prettier", body: "x".repeat(39) }), true);
  // trivial subject, substantive body (>= SIG_MIN_BODY chars) -> NOT trivial anymore
  assert.equal(isTrivialSubject({ subject: "Merge branch 'feature' into main", body: "x".repeat(40) }), false);
  assert.equal(
    isTrivialSubject({
      subject: "Merge pull request #42 from org/feature-branch",
      body: "Adds OAuth2 login support with JWT tokens, replacing the old session-cookie flow.",
    }),
    false,
  );
  // non-trivial subject -> never trivial, regardless of body
  assert.equal(isTrivialSubject({ subject: "feat: add x", body: "" }), false);
  assert.equal(isTrivialSubject({ subject: "feat: add x", body: "x".repeat(100) }), false);
});

test("isTrivialSubject: chore(deps) subjects are recognized as SKIP_SUBJECT (regex fix, regression #4)", () => {
  // chore(deps) with no body -> trivial. Regression guard for a pre-existing bug where
  // the SKIP_SUBJECT regex's `\b` after "chore(deps)" never fires (no word/non-word
  // transition before ":" or a space), so these commits silently fell through to the
  // isSignificant() gate instead of being treated as SKIP_SUBJECT.
  assert.equal(isTrivialSubject({ subject: "chore(deps): bump lodash from 4.1.0 to 4.2.0", body: "" }), true);
  // substantive body still overrides, same as every other SKIP_SUBJECT alternative
  assert.equal(
    isTrivialSubject({ subject: "chore(deps): bump lodash from 4.1.0 to 4.2.0", body: "x".repeat(40) }),
    false,
  );
  // the other SKIP_SUBJECT alternatives are unaffected by the chore(deps) fix
  assert.equal(isTrivialSubject({ subject: "Merge branch 'main' into feature", body: "" }), true);
  assert.equal(isTrivialSubject({ subject: "revert: bad change", body: "" }), true);
  assert.equal(isTrivialSubject({ subject: "bump: lodash to 4.2.0", body: "" }), true);
  assert.equal(isTrivialSubject({ subject: "format: prettier", body: "" }), true);
  assert.equal(isTrivialSubject({ subject: "lint: eslint fixes", body: "" }), true);
  assert.equal(isTrivialSubject({ subject: "wip", body: "" }), true);
});

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
