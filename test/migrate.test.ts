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
  return { root, cleanup: () => rmSync(root, { recursive: true, force: true }) };
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
