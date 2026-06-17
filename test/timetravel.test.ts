import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { hunchPaths } from "../src/core/paths.js";
import { JsonStore } from "../src/store/jsonStore.js";
import { writeManifest } from "../src/core/migrate.js";
import { migrateRaw } from "../src/core/migrate.js";
import { tempStore } from "./helpers.js";
import type { Decision, Constraint } from "../src/core/types.js";

// --- builders --------------------------------------------------------------

function mkDecision(over: Partial<Decision> & { id: string; date: string }): Decision {
  return {
    title: "t", status: "accepted", context: "", decision: "d", consequences: [],
    alternatives_rejected: [], related_components: [], related_files: ["src/auth/session.ts"],
    supersedes: null, superseded_by: null, caused_by_bug: null, commit: null,
    valid_from: over.valid_from ?? over.date, valid_to: null, retired: { symbols: [], deps: [] },
    provenance: { source: "human_confirmed", confidence: 1, evidence: [] },
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

// --- v2 migration (con_947c578b2c: migrate before Zod, never drop) ----------

test("v2 migration backfills decision valid-time from `date` and never drops the record", () => {
  // a v1-shaped decision: no valid_from / valid_to / superseded_by / retired
  const rawV1 = { id: "dec_x", title: "t", status: "accepted", date: "2026-01-01T00:00:00Z" };
  const migrated = migrateRaw("decisions", rawV1, 1) as Record<string, unknown>;
  assert.equal(migrated.valid_from, "2026-01-01T00:00:00Z", "valid_from backfilled from date");
  assert.equal(migrated.valid_to, null, "an accepted decision stays open");
  assert.equal(migrated.superseded_by, null);
  assert.deepEqual(migrated.retired, { symbols: [], deps: [] });
});

test("v2 migration leaves a legacy SUPERSEDED decision's window OPEN (no successor instant known)", () => {
  // Regression guard: closing valid_to at the record's OWN date produces a
  // zero-length [date,date) window that matches NO as-of query — hiding the
  // record from all time-travel. Legacy superseded records must stay queryable.
  const raw = { id: "dec_old", status: "superseded", date: "2026-02-02T00:00:00Z" };
  const m = migrateRaw("decisions", raw, 1) as Record<string, unknown>;
  assert.equal(m.valid_from, "2026-02-02T00:00:00Z");
  assert.equal(m.valid_to, null, "no recorded successor instant → window stays open, not zero-length");
});

test("a migrated legacy-superseded decision is still visible to an as-of query", () => {
  const { store, cleanup } = tempStore();
  try {
    // simulate a migrated v1 superseded record (valid_to left null by the migration)
    store.json.put("decisions", mkDecision({
      id: "dec_legacy_sup", title: "old approach", date: "2026-02-02T00:00:00Z",
      valid_from: "2026-02-02T00:00:00Z", valid_to: null, status: "superseded",
    }));
    const after = store.why("src/auth/session.ts", { asOf: "2026-05-01T00:00:00Z" }).decisions.map((d) => d.id);
    assert.ok(after.includes("dec_legacy_sup"), "open window → findable by time-travel (not hidden)");
  } finally {
    cleanup();
  }
});

test("v2 migration backfills constraint status=active without touching scope/severity", () => {
  const raw = { id: "con_1", type: "security", statement: "s", scope: ["src/**"], severity: "blocking" };
  const m = migrateRaw("constraints", raw, 1) as Record<string, unknown>;
  assert.equal(m.status, "active");
  assert.equal(m.valid_to, null);
  assert.deepEqual(m.scope, ["src/**"], "existing fields untouched");
});

test("a real v1 store loads (and validates) after the v2 bump — no record loss", () => {
  const root = mkdtempSync(join(tmpdir(), "hunch-tt-"));
  try {
    const paths = hunchPaths(root);
    const store = new JsonStore(paths);
    store.ensureDirs();
    writeManifest(paths, 1); // pretend this .hunch/ was written at schema v1
    // hand-write a v1-shaped decision file (missing the v2 fields)
    writeFileSync(join(paths.dir("decisions"), "dec_legacy.json"), JSON.stringify({
      id: "dec_legacy", title: "legacy", status: "accepted", context: "", decision: "d",
      consequences: [], alternatives_rejected: [], related_components: [], related_files: ["a.ts"],
      supersedes: null, caused_by_bug: null, commit: null,
      provenance: { source: "llm_draft", confidence: 0.4, evidence: [] }, date: "2026-01-01T00:00:00Z",
    }, null, 2));
    const loaded = store.loadAll("decisions");
    assert.equal(loaded.length, 1, "legacy record survives the migration");
    assert.equal(loaded[0]!.valid_from, "2026-01-01T00:00:00Z");
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

// --- as-of window filtering ------------------------------------------------

test("why({asOf}) returns only the decision in force at that instant", () => {
  const { store, cleanup } = tempStore();
  try {
    store.json.put("decisions", mkDecision({
      id: "dec_old", title: "JWT-only sessions", date: "2026-01-01T00:00:00Z",
      valid_from: "2026-01-01T00:00:00Z", valid_to: "2026-03-01T00:00:00Z", status: "superseded",
    }));
    store.json.put("decisions", mkDecision({
      id: "dec_new", title: "Redis sessions", date: "2026-03-01T00:00:00Z",
      valid_from: "2026-03-01T00:00:00Z",
    }));

    const at = (iso: string) => store.why("src/auth/session.ts", { asOf: iso }).decisions.map((d) => d.id);
    assert.deepEqual(at("2026-02-01T00:00:00Z"), ["dec_old"], "before supersession → old only");
    assert.deepEqual(at("2026-04-01T00:00:00Z"), ["dec_new"], "after supersession → new only");
    // half-open [from, to): at the exact supersession instant only the new one is in force
    assert.deepEqual(at("2026-03-01T00:00:00Z"), ["dec_new"], "boundary belongs to the successor");

    const all = store.why("src/auth/session.ts").decisions.map((d) => d.id).sort();
    assert.deepEqual(all, ["dec_new", "dec_old"], "no asOf → full history");
  } finally {
    cleanup();
  }
});

test("checkConstraints excludes retired by default but surfaces them via asOf-in-window", () => {
  const { store, cleanup } = tempStore();
  try {
    store.json.put("constraints", mkConstraint({ id: "con_active" }));
    store.json.put("constraints", mkConstraint({
      id: "con_retired", status: "retired",
      valid_from: "2026-01-01T00:00:00Z", valid_to: "2026-03-01T00:00:00Z",
    }));

    const now = store.checkConstraints("src/auth/session.ts").map((c) => c.id);
    assert.deepEqual(now, ["con_active"], "retired invariant is not enforced at HEAD");

    const then = store.checkConstraints("src/auth/session.ts", { asOf: "2026-02-01T00:00:00Z" }).map((c) => c.id);
    assert.ok(then.includes("con_retired"), "time-travel surfaces the invariant that was in force then");
  } finally {
    cleanup();
  }
});

// --- supersession (invalidate, don't delete) -------------------------------

test("supersede() closes the old window, links it, and writes a supersedes edge", () => {
  const { store, cleanup } = tempStore();
  try {
    store.json.put("decisions", mkDecision({ id: "dec_old", date: "2026-01-01T00:00:00Z", valid_from: "2026-01-01T00:00:00Z" }));
    const by = store.json.put("decisions", mkDecision({ id: "dec_new", date: "2026-03-01T00:00:00Z", valid_from: "2026-03-01T00:00:00Z" }));

    const closed = store.supersede("dec_old", by);
    assert.ok(closed, "returns the updated old decision");
    assert.equal(closed!.status, "superseded");
    assert.equal(closed!.superseded_by, "dec_new");
    assert.equal(closed!.valid_to, "2026-03-01T00:00:00Z", "window closes at the successor's valid_from");

    // the old decision is NOT deleted — it's still on disk, just closed
    const reread = store.json.get("decisions", "dec_old");
    assert.equal(reread!.status, "superseded");

    const edge = store.allEdges().find((e) => e.type === "supersedes" && e.from === "dec_new" && e.to === "dec_old");
    assert.ok(edge, "a supersedes edge records the relation");
  } finally {
    cleanup();
  }
});

test("supersede() is a no-op (null) for a missing or self-referential target", () => {
  const { store, cleanup } = tempStore();
  try {
    const d = store.json.put("decisions", mkDecision({ id: "dec_a", date: "2026-01-01T00:00:00Z" }));
    assert.equal(store.supersede("dec_missing", d), null, "unknown id → null");
    assert.equal(store.supersede("dec_a", d), null, "cannot supersede itself");
  } finally {
    cleanup();
  }
});

// --- timeline --------------------------------------------------------------

test("timeline() returns a file's decisions newest-first with windows", () => {
  const { store, cleanup } = tempStore();
  try {
    store.json.put("decisions", mkDecision({ id: "dec_old", date: "2026-01-01T00:00:00Z", valid_from: "2026-01-01T00:00:00Z", valid_to: "2026-03-01T00:00:00Z", status: "superseded" }));
    store.json.put("decisions", mkDecision({ id: "dec_new", date: "2026-03-01T00:00:00Z", valid_from: "2026-03-01T00:00:00Z" }));
    const ids = store.timeline("src/auth/session.ts").map((d) => d.id);
    assert.deepEqual(ids, ["dec_new", "dec_old"], "newest valid_from first");
  } finally {
    cleanup();
  }
});
