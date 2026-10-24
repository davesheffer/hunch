// Migration registry gate (con_947c578b2c): every schema step v(n-1) -> v(n) in
// src/core/migrate.ts must have a registered step test below that loads a RAW
// v(n-1) fixture for EVERY record kind the step touches, asserts the exact v(n)
// shape, and proves an unmigratable sibling of that kind is never silently dropped.
// Bumping SCHEMA_VERSION or appending a Migration without registering it here fails.
import { cleanupDir } from "./fixtures.js";
import { test } from "node:test";
import assert from "node:assert/strict";
import { existsSync, mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { hunchPaths } from "../src/core/paths.js";
import { ENTITY_KINDS, type EntityKind } from "../src/core/types.js";
import { JsonStore } from "../src/store/jsonStore.js";
import { BASELINE_VERSION, MIGRATIONS, SCHEMA_VERSION, migrateRaw, writeManifest } from "../src/core/migrate.js";

type Raw = Record<string, unknown>;
interface KindStep {
  /** A raw record exactly as a v(n-1) store wrote it. */
  fixture: () => Raw;
  /** The exact raw shape the step must produce. */
  expected: Raw;
  /** Fields that must survive the full chain to SCHEMA_VERSION and Zod. */
  loaded: Raw;
}

const provenance = { source: "human_confirmed", confidence: 1, evidence: [] };
const v1Decision = (): Raw => ({
  id: "dec_mig_v1", title: "legacy", status: "accepted", context: "", decision: "d", consequences: [],
  alternatives_rejected: [], related_components: [], related_files: [], supersedes: null,
  caused_by_bug: null, commit: null, provenance, date: "2025-01-02T03:04:05Z",
});
const v1Constraint = (): Raw => ({
  id: "con_mig_v1", type: "correctness", statement: "legacy invariant", scope: ["src/**"],
  severity: "blocking", enforcement: "ci", rationale: "", source_decision: null, violations: [], provenance,
});
const v2Edge = (): Raw => ({
  id: "edge_mig_v2", from: "cmp_a", to: "cmp_b", type: "depends_on", reason: "legacy", strength: 0.5, provenance,
});

/** Step registry: produced version -> kind -> fixture/expectation. */
const STEP_TESTS: Record<number, Partial<Record<EntityKind, KindStep>>> = {
  2: {
    decisions: {
      fixture: v1Decision,
      expected: { ...v1Decision(), valid_from: "2025-01-02T03:04:05Z", valid_to: null, superseded_by: null, retired: { symbols: [], deps: [] } },
      loaded: { valid_from: "2025-01-02T03:04:05Z", valid_to: null, superseded_by: null },
    },
    constraints: {
      fixture: v1Constraint,
      expected: { ...v1Constraint(), status: "active", valid_to: null },
      loaded: { status: "active", valid_to: null },
    },
  },
  3: {
    edges: {
      fixture: v2Edge,
      expected: { ...v2Edge(), schema: "hunch.edge/1", environment: null, metadata: {} },
      loaded: { schema: "hunch.edge/1", environment: null },
    },
  },
};

/** Kinds a migration touches: probe `up` on an empty record of every kind, plus the
 *  `kind === "<k>"` literals in its source (catches rename-only transforms). */
function touchedKinds(up: (kind: EntityKind, raw: Raw) => Raw): Set<EntityKind> {
  const out = new Set<EntityKind>();
  for (const kind of ENTITY_KINDS) {
    if (JSON.stringify(up(kind, {})) !== "{}") out.add(kind);
  }
  for (const m of up.toString().matchAll(/kind\s*===?\s*["']([a-z_]+)["']/g)) {
    assert.ok((ENTITY_KINDS as readonly string[]).includes(m[1]!), `migration names unknown kind ${m[1]}`);
    out.add(m[1] as EntityKind);
  }
  return out;
}

const SINGLE_FILE_KINDS = new Set<EntityKind>(["symbols", "edges", "resources", "entities", "relationships"]);
/** A record of `kind` no migration can make Zod-valid. */
const unmigratable = (kind: EntityKind): Raw => ({ id: `${kind.slice(0, 3)}_unmigratable`, provenance: "not-an-object", bogus_field: true });

test("every SCHEMA_VERSION step is a registered, contiguous migration", () => {
  const versions = MIGRATIONS.map((m) => m.version);
  assert.deepEqual([...versions].sort((a, b) => a - b), versions, "MIGRATIONS stays ascending");
  const expected: number[] = [];
  for (let v = BASELINE_VERSION + 1; v <= SCHEMA_VERSION; v++) expected.push(v);
  assert.deepEqual(versions, expected, "each version in (BASELINE, SCHEMA_VERSION] has exactly one migration");
  assert.deepEqual(Object.keys(STEP_TESTS).map(Number).sort((a, b) => a - b), expected,
    "every schema step has a registered step test in test/migration-registry.test.ts (and no stale ones)");
});

test("every kind a step touches has a raw fixture, and every fixture is a touched kind", () => {
  for (const m of MIGRATIONS) {
    const touched = [...touchedKinds(m.up.bind(m))].sort();
    const registered = Object.keys(STEP_TESTS[m.version] ?? {}).sort();
    assert.deepEqual(registered, touched, `v${m.version} (${m.description}) fixtures must cover exactly the kinds it touches`);
    if (m.kinds) assert.deepEqual([...m.kinds].sort(), touched, `v${m.version} declares exactly the kinds it touches`);
  }
});

for (const m of MIGRATIONS) {
  for (const [kind, step] of Object.entries(STEP_TESTS[m.version] ?? {}) as Array<[EntityKind, KindStep]>) {
    test(`v${m.version - 1} -> v${m.version}: raw ${kind} migrates to the exact v${m.version} shape, idempotently`, () => {
      const once = migrateRaw(kind, step.fixture(), m.version - 1, MIGRATIONS, m.version);
      assert.deepEqual(once, step.expected);
      const twice = migrateRaw(kind, structuredClone(once), m.version - 1, MIGRATIONS, m.version);
      assert.deepEqual(twice, step.expected, "re-running the step changes nothing");
      // Untouched kinds pass through unchanged.
      const other = ENTITY_KINDS.find((k) => !(k in (STEP_TESTS[m.version] ?? {})))!;
      assert.deepEqual(migrateRaw(other, step.fixture(), m.version - 1, MIGRATIONS, m.version), step.fixture());
    });

    test(`v${m.version - 1} store: ${kind} loads through every later step and an unmigratable sibling is never dropped`, () => {
      const root = mkdtempSync(join(tmpdir(), "hunch-migreg-"));
      try {
        const paths = hunchPaths(root);
        const store = new JsonStore(paths);
        store.ensureDirs();
        writeManifest(paths, m.version - 1);
        const good = step.fixture();
        const bad = unmigratable(kind);
        const dir = paths.dir(kind);
        let badFile: string;
        if (SINGLE_FILE_KINDS.has(kind)) {
          badFile = join(dir, "index.json");
          writeFileSync(badFile, JSON.stringify([bad, good], null, 2));
        } else {
          writeFileSync(join(dir, `${good.id as string}.json`), JSON.stringify(good, null, 2));
          badFile = join(dir, `${bad.id as string}.json`);
          writeFileSync(badFile, JSON.stringify(bad, null, 2));
        }
        const badBefore = readFileSync(badFile, "utf8");

        const loaded = store.loadAll(kind) as unknown as Raw[];
        const rec = loaded.find((r) => r.id === good.id);
        assert.ok(rec, `${kind} v${m.version - 1} record must load (migrated BEFORE Zod), not be skipped`);
        for (const [k, v] of Object.entries(step.loaded)) assert.deepEqual(rec[k], v, `${kind}.${k} after load`);

        const res = store.persistMigration();
        assert.ok(res.skipped >= 1, "the unmigratable record is counted, not hidden");
        assert.ok(existsSync(badFile), "unmigratable record's file survives");
        if (SINGLE_FILE_KINDS.has(kind)) {
          const after = JSON.parse(readFileSync(badFile, "utf8")) as Raw[];
          // Index kinds re-encode the whole file, so assert every original field
          // survives rather than byte equality.
          const kept = after.find((r) => r.id === bad.id);
          assert.ok(kept, "unmigratable record preserved in the index");
          for (const [k, v] of Object.entries(bad)) assert.deepEqual(kept[k], v, `unmigratable ${kind}.${k} preserved`);
          const migrated = after.find((r) => r.id === good.id)!;
          for (const [k, v] of Object.entries(step.loaded)) assert.deepEqual(migrated[k], v, `${kind}.${k} persisted`);
        } else {
          assert.equal(readFileSync(badFile, "utf8"), badBefore, "unmigratable record file left as-is");
          const migrated = JSON.parse(readFileSync(join(dir, `${good.id as string}.json`), "utf8")) as Raw;
          for (const [k, v] of Object.entries(step.loaded)) assert.deepEqual(migrated[k], v, `${kind}.${k} persisted`);
        }
      } finally {
        cleanupDir(root);
      }
    });
  }
}
