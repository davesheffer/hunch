import { cleanupDir } from "./fixtures.js";
import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, rmSync, writeFileSync, readFileSync, readdirSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { hunchPaths } from "../src/core/paths.js";
import { JsonStore } from "../src/store/jsonStore.js";
import { writeFileAtomic } from "../src/core/io.js";
import {
  migrateRaw,
  readManifest,
  writeManifest,
  SCHEMA_VERSION,
  BASELINE_VERSION,
  type Migration,
} from "../src/core/migrate.js";

function tmp(): { root: string; cleanup: () => void } {
  const root = mkdtempSync(join(tmpdir(), "hunch-mig-"));
  return { root, cleanup: () => cleanupDir(root) };
}

test("migrateRaw applies only migrations in (from, to] in ascending order", () => {
  const migs: Migration[] = [
    { version: 1, description: "add a", up: (_k, r) => ({ ...r, a: 1 }) },
    { version: 2, description: "add b from a", up: (_k, r) => ({ ...r, b: (r.a as number) + 1 }) },
  ];
  // from v0 → current(2): both run
  assert.deepEqual(migrateRaw("decisions", { id: "x" }, 0, migs, 2), { id: "x", a: 1, b: 2 });
  // from v1 → 2: only the v2 migration runs (a must already exist)
  assert.deepEqual(migrateRaw("decisions", { id: "x", a: 5 }, 1, migs, 2), { id: "x", a: 5, b: 6 });
  // from v2 → 2: nothing runs
  assert.deepEqual(migrateRaw("decisions", { id: "x" }, 2, migs, 2), { id: "x" });
});

test("migrateRaw leaves non-object input untouched (loader's Zod pass will reject it)", () => {
  const migs: Migration[] = [{ version: 1, description: "", up: (_k, r) => ({ ...r, a: 1 }) }];
  assert.equal(migrateRaw("bugs", null, 0, migs, 1), null);
  assert.equal(migrateRaw("bugs", "nope", 0, migs, 1), "nope");
  assert.deepEqual(migrateRaw("bugs", [1, 2], 0, migs, 1), [1, 2]);
});

test("production MIGRATIONS at the current version is a no-op", () => {
  // current build: a record already at SCHEMA_VERSION is returned unchanged
  const rec = { id: "d", title: "t" };
  assert.deepEqual(migrateRaw("decisions", rec, SCHEMA_VERSION), rec);
});

test("manifest round-trips; missing/corrupt → BASELINE_VERSION", () => {
  const { root, cleanup } = tmp();
  const paths = hunchPaths(root);
  assert.equal(readManifest(paths).schema_version, BASELINE_VERSION, "missing manifest → baseline");
  writeManifest(paths, 3);
  assert.equal(readManifest(paths).schema_version, 3);
  writeFileSync(paths.manifest, "{ not json");
  assert.equal(readManifest(paths).schema_version, BASELINE_VERSION, "corrupt → baseline");
  cleanup();
});

test("persistMigration rewrites loadable records and never drops an unmigratable one", () => {
  const { root, cleanup } = tmp();
  const store = new JsonStore(hunchPaths(root));
  store.ensureDirs();
  // one valid decision (per-record file) + one valid + one INVALID raw in the single-file index
  store.put("decisions", {
    id: "dec_ok", title: "ok", status: "proposed", context: "", decision: "d", consequences: [],
    alternatives_rejected: [], related_components: [], related_files: [], supersedes: null,
    caused_by_bug: null, commit: null, provenance: { source: "llm_draft", confidence: 0.3, evidence: [] },
    date: "2026-01-01T00:00:00Z",
  } as never);
  const symIndex = join(hunchPaths(root).dir("symbols"), "index.json");
  writeFileSync(symIndex, JSON.stringify([
    { id: "sym_ok", file: "a.ts", name: "f", kind: "function", signature_hash: "", calls: [], called_by: [], metrics: { loc: 1, churn_90d: 0, bug_count: 0, fan_in: 0, fan_out: 0 }, last_changed: "" },
    { id: "sym_bad", kind: "not-a-real-kind" }, // fails Zod
  ], null, 2));

  const res = store.persistMigration();
  assert.ok(res.migrated >= 2, "valid records rewritten");
  assert.equal(res.skipped, 1, "the invalid symbol is counted skipped");
  const after = JSON.parse(readFileSync(symIndex, "utf8")) as Array<{ id: string }>;
  assert.ok(after.some((r) => r.id === "sym_bad"), "unmigratable record preserved, not deleted");
  assert.ok(after.some((r) => r.id === "sym_ok"));
  cleanup();
});

test("put() on a single-file index preserves schema-invalid siblings (never silently drops)", () => {
  const { root, cleanup } = tmp();
  const paths = hunchPaths(root);
  const store = new JsonStore(paths);
  store.ensureDirs();
  const valid = { id: "sym_v", file: "a.ts", name: "f", kind: "function", signature_hash: "", calls: [], called_by: [], metrics: { loc: 0, churn_90d: 0, bug_count: 0, fan_in: 0, fan_out: 0 }, last_changed: "" };
  const idx = join(paths.dir("symbols"), "index.json");
  writeFileSync(idx, JSON.stringify([valid, { id: "sym_bad", kind: "nope" }], null, 2));
  store.put("symbols", { ...valid, id: "sym_new" } as never);
  const after = (JSON.parse(readFileSync(idx, "utf8")) as Array<{ id: string }>).map((r) => r.id);
  assert.deepEqual(after, ["sym_bad", "sym_new", "sym_v"], "invalid sibling preserved; index kept id-sorted");
  cleanup();
});

test("put()/delete() refuse to rewrite a corrupt non-empty index (no silent flatten)", () => {
  const { root, cleanup } = tmp();
  const paths = hunchPaths(root);
  const store = new JsonStore(paths);
  store.ensureDirs();
  const idx = join(paths.dir("symbols"), "index.json");
  writeFileSync(idx, '[{"id":"sym_a","file":"a.ts","name":"a","kind":"function" <<TRUNCATED');
  const valid = { id: "sym_new", file: "b.ts", name: "b", kind: "function", signature_hash: "", calls: [], called_by: [], metrics: { loc: 0, churn_90d: 0, bug_count: 0, fan_in: 0, fan_out: 0 }, last_changed: "" };
  assert.throws(() => store.put("symbols", valid as never), /not valid JSON/);
  assert.throws(() => store.delete("symbols", "sym_a"), /not valid JSON/);
  assert.match(readFileSync(idx, "utf8"), /TRUNCATED/, "corrupt index left untouched, not flattened");
  cleanup();
});

test("writeFileAtomic writes the file and leaves no temp file behind", () => {
  const { root, cleanup } = tmp();
  const f = join(root, "x.json");
  writeFileAtomic(f, "hello\n");
  writeFileAtomic(f, "world\n"); // overwrite existing
  assert.equal(readFileSync(f, "utf8"), "world\n");
  assert.equal(readdirSync(root).filter((n) => n.includes(".tmp")).length, 0, "no leaked temp file");
  cleanup();
});

test("loadAll warns once and still loads when .hunch/ is from a NEWER schema", () => {
  const { root, cleanup } = tmp();
  const paths = hunchPaths(root);
  const store = new JsonStore(paths);
  store.ensureDirs();
  writeManifest(paths, SCHEMA_VERSION + 5); // pretend a future build wrote this
  store.put("constraints", {
    id: "con_1", type: "correctness", statement: "x", scope: [], severity: "warning",
    enforcement: "advisory_v1", rationale: "", source_decision: null, violations: [],
    provenance: { source: "derived", confidence: 0.9, evidence: [] },
  } as never);

  const warnings: string[] = [];
  const orig = console.warn;
  console.warn = (m?: unknown) => warnings.push(String(m));
  try {
    const loaded = store.loadAll("constraints");
    assert.equal(loaded.length, 1, "v1-shaped records still load despite a newer manifest");
  } finally {
    console.warn = orig;
  }
  assert.ok(warnings.some((w) => /newer schema/.test(w)), "warned about forward-incompatibility");
  cleanup();
});

test("migrateRaw never mutates its input, even when a step throws mid-way", () => {
  const migs: Migration[] = [
    { version: 2, description: "add a", up: (_k, r) => { r.a = 1; return r; } },
    { version: 3, description: "boom", up: () => { throw new Error("boom"); } },
  ];
  const raw = { id: "x", nested: { n: 1 } };
  const out = migrateRaw("decisions", raw, 1, migs.slice(0, 1), 2) as { nested: { n: number } };
  out.nested.n = 99;
  assert.deepEqual(raw, { id: "x", nested: { n: 1 } }, "result is a deep copy");
  assert.throws(() => migrateRaw("decisions", raw, 1, migs, 3), /boom/);
  assert.deepEqual(raw, { id: "x", nested: { n: 1 } }, "a failed run leaves the original intact");
});

const edgeRaw = (id: string, type: string) => ({
  id, from: "a", to: "b", type, reason: "", strength: 0.5,
  provenance: { source: "derived", confidence: 0.9, evidence: [] },
});

test("persistMigration: an unmigratable edge stays in its original shape and holds the version (#509)", () => {
  const { root, cleanup } = tmp();
  const paths = hunchPaths(root);
  const store = new JsonStore(paths);
  store.ensureDirs();
  writeManifest(paths, 2); // pre-v3 edges: no schema/environment/metadata yet
  const idx = join(paths.dir("edges"), "index.json");
  const bad = edgeRaw("edge_bad", "not-a-real-type");
  writeFileSync(idx, JSON.stringify([edgeRaw("edge_ok", "calls"), bad], null, 2));

  const res = store.persistMigration();
  assert.equal(res.skipped, 1);
  assert.equal(res.version, 2, "version does not advance past the failed record");
  const after = JSON.parse(readFileSync(idx, "utf8")) as Array<Record<string, unknown>>;
  const keptBad = after.find((r) => r.id === "edge_bad");
  assert.equal(JSON.stringify(keptBad), JSON.stringify(bad), "failed edge kept byte-for-byte, not half-migrated");
  assert.equal(after.find((r) => r.id === "edge_ok")!.schema, "hunch.edge/1", "valid sibling migrated");

  // Manual fix + rerun completes the migration.
  writeManifest(paths, res.version);
  writeFileSync(idx, JSON.stringify(after.map((r) => (r.id === "edge_bad" ? { ...r, type: "calls" } : r)), null, 2));
  const rerun = store.persistMigration();
  assert.deepEqual({ skipped: rerun.skipped, version: rerun.version }, { skipped: 0, version: SCHEMA_VERSION });
  const fixed = (JSON.parse(readFileSync(idx, "utf8")) as Array<Record<string, unknown>>).find((r) => r.id === "edge_bad")!;
  assert.equal(fixed.schema, "hunch.edge/1");
  assert.deepEqual(fixed.metadata, {});
  cleanup();
});

test("persistMigration: an unmigratable per-record file is untouched and a rerun after a fix migrates it (#509)", () => {
  const { root, cleanup } = tmp();
  const paths = hunchPaths(root);
  const store = new JsonStore(paths);
  store.ensureDirs();
  writeManifest(paths, BASELINE_VERSION); // v1 decisions: no valid_from yet
  const v1 = (id: string, status: string) => ({
    id, title: "t", status, context: "", decision: "d", consequences: [], alternatives_rejected: [],
    related_components: [], related_files: [], supersedes: null, caused_by_bug: null, commit: null,
    provenance: { source: "llm_draft", confidence: 0.3, evidence: [] }, date: "2026-01-01T00:00:00Z",
  });
  const dir = paths.dir("decisions");
  writeFileSync(join(dir, "dec_ok.json"), JSON.stringify(v1("dec_ok", "proposed"), null, 2));
  const badPath = join(dir, "dec_bad.json");
  const badBytes = JSON.stringify(v1("dec_bad", "bogus-status"), null, 2);
  writeFileSync(badPath, badBytes);

  const res = store.persistMigration();
  assert.equal(res.skipped, 1);
  assert.equal(res.version, BASELINE_VERSION, "version held so later migrations re-run on the failed record");
  assert.equal(readFileSync(badPath, "utf8"), badBytes, "failed record unchanged byte-for-byte");
  assert.equal((JSON.parse(readFileSync(join(dir, "dec_ok.json"), "utf8")) as { valid_from: string }).valid_from, "2026-01-01T00:00:00Z");

  writeManifest(paths, res.version);
  writeFileSync(badPath, JSON.stringify(v1("dec_bad", "proposed"), null, 2));
  const rerun = store.persistMigration();
  assert.deepEqual({ skipped: rerun.skipped, version: rerun.version }, { skipped: 0, version: SCHEMA_VERSION });
  const fixed = JSON.parse(readFileSync(badPath, "utf8")) as { valid_from: string; superseded_by: unknown };
  assert.equal(fixed.valid_from, "2026-01-01T00:00:00Z", "the v2 migration ran on the fixed record");
  assert.equal(fixed.superseded_by, null);
  cleanup();
});
