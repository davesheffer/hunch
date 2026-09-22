import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, rmSync, existsSync, readdirSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { JsonStore } from "../src/store/jsonStore.js";
import { hunchPaths, hunchPathsForDir } from "../src/core/paths.js";
import { movePublicMemoryToPrivate } from "../src/store/privateMigrate.js";
import { ignoreHunchMemory, HUNCH_MEMORY_DIRS } from "../src/integrations/gitignore.js";
import type { Decision, Constraint } from "../src/core/types.js";

const CON = (id: string, statement: string): Constraint => ({
  id, type: "correctness", statement, scope: ["src/**"], severity: "warning", enforcement: "advisory_v1",
  rationale: "", source_decision: null, violations: [], status: "active",
  valid_from: "2026-01-01T00:00:00Z", valid_to: null,
  provenance: { source: "human_confirmed", confidence: 1, evidence: [] },
} as unknown as Constraint);

const DEC = (id: string, title: string): Decision => ({
  id, title, status: "accepted", context: "", decision: "",
  consequences: [], alternatives_rejected: [], rejected_tripwires: [],
  related_components: [], related_files: [], supersedes: null, superseded_by: null,
  caused_by_bug: null, commit: null, valid_from: "2026-01-01T00:00:00Z", valid_to: null,
  retired: { symbols: [], deps: [] },
  provenance: { source: "human_confirmed", confidence: 1, evidence: [] },
  date: "2026-01-01T00:00:00Z",
} as unknown as Decision);

function stores(): { pub: JsonStore; priv: JsonStore; roots: string[]; cleanup: () => void } {
  const pubRoot = mkdtempSync(join(tmpdir(), "hunch-mig-pub-"));
  const privRoot = mkdtempSync(join(tmpdir(), "hunch-mig-priv-"));
  const pub = new JsonStore(hunchPaths(pubRoot));
  const priv = new JsonStore(hunchPathsForDir(join(privRoot, ".hunch")));
  pub.ensureDirs();
  priv.ensureDirs();
  return {
    pub, priv, roots: [pubRoot, privRoot],
    cleanup: () => { rmSync(pubRoot, { recursive: true, force: true }); rmSync(privRoot, { recursive: true, force: true }); },
  };
}

test("private --migrate REFUSES when an on-disk record failed to load — never silently deletes it (issue #29)", () => {
  const { pub, priv, roots, cleanup } = stores();
  try {
    pub.put("decisions", DEC("dec_ok", "loads fine"));
    // A record the validating loader will SKIP with a warning: syntax error.
    // Post-migrate dropAll would have deleted it forever.
    writeFileSync(join(roots[0]!, ".hunch", "decisions", "dec_broken.json"), '{"id": "dec_broken",');
    const warn = console.warn; console.warn = () => { /* silence the expected skip warning */ };
    try {
      assert.throws(() => movePublicMemoryToPrivate(pub, priv), /refusing to migrate decisions.*1 on-disk record/s);
    } finally {
      console.warn = warn;
    }
    assert.equal(existsSync(join(roots[0]!, ".hunch", "decisions", "dec_broken.json")), true, "the unloadable record is untouched");
    assert.deepEqual(priv.loadAll("decisions"), [], "nothing was absorbed for the refused kind");
    // A kind whose ONLY records are invalid must also refuse (the old 0-loaded
    // fast path skipped the merge entirely while the wipe still ran).
    rmSync(join(roots[0]!, ".hunch", "decisions", "dec_ok.json"), { force: true });
    // This test mutates record files directly, behind the store. loadAll memoizes per
    // kind keyed by the kind directory's mtime, and the whole test runs in ~40ms — well
    // inside one filesystem timestamp tick — so without an explicit invalidation the
    // cache keeps serving the just-deleted record and the counts falsely agree. The
    // long-lived MCP server calls this for the same reason after an out-of-band
    // `hunch migrate`.
    pub.clearCache();
    const warn2 = console.warn; console.warn = () => { /* expected skip warning */ };
    try {
      assert.throws(() => movePublicMemoryToPrivate(pub, priv), /refusing to migrate decisions/);
    } finally {
      console.warn = warn2;
    }
    // A 0-byte merge tombstone is an intentional absence, not a load failure.
    rmSync(join(roots[0]!, ".hunch", "decisions", "dec_broken.json"), { force: true });
    writeFileSync(join(roots[0]!, ".hunch", "decisions", "dec_tomb.json"), "");
    pub.clearCache(); // same out-of-band mutation, same reason
    assert.doesNotThrow(() => movePublicMemoryToPrivate(pub, priv));
  } finally {
    cleanup();
  }
});

test("private --migrate REFUSES when an OVERLAY record failed to load — replaceAll would delete it as stale (issue #289)", () => {
  const { pub, priv, roots, cleanup } = stores();
  try {
    pub.put("decisions", DEC("dec_pub", "public, loads fine"));
    priv.put("decisions", DEC("dec_priv", "overlay, loads fine"));
    // Two overlay records the validating loader SKIPS: a syntax error and a
    // future-schema record this version cannot validate. Neither is in the merged
    // set, so replaceAll's delete-stale step would remove both — and push it.
    const broken = join(roots[1]!, ".hunch", "decisions", "dec_typo.json");
    const future = join(roots[1]!, ".hunch", "decisions", "dec_future.json");
    writeFileSync(broken, '{"id": "dec_typo",');
    writeFileSync(future, JSON.stringify({ id: "dec_future", schema_version: 9999, shape: "unknown to this version" }));
    priv.clearCache(); // out-of-band mutation, same reason as above
    const warn = console.warn; console.warn = () => { /* silence the expected skip warnings */ };
    try {
      assert.throws(() => movePublicMemoryToPrivate(pub, priv), /refusing to migrate decisions.*2 overlay record/s);
    } finally {
      console.warn = warn;
    }
    assert.equal(existsSync(broken), true, "the unloadable overlay record is untouched");
    assert.equal(existsSync(future), true, "the future-schema overlay record is untouched");
    assert.equal(existsSync(join(roots[1]!, ".hunch", "decisions", "dec_pub.json")), false, "nothing was absorbed for the refused kind");
  } finally {
    cleanup();
  }
});

test("private --migrate: unions public records into the overlay, preserving private-only records", () => {
  const { pub, priv, cleanup } = stores();
  try {
    pub.put("decisions", DEC("dec_pub", "public decision"));
    pub.put("constraints", CON("con_pub", "public constraint"));
    priv.put("decisions", DEC("dec_priv", "private-only decision"));

    const res = movePublicMemoryToPrivate(pub, priv);

    assert.equal(res.moved.decisions, 1);
    assert.equal(res.moved.constraints, 1);
    assert.equal(res.total, 2);
    assert.deepEqual(priv.loadAll("decisions").map((d) => d.id).sort(), ["dec_priv", "dec_pub"]); // union
    assert.deepEqual(priv.loadAll("constraints").map((c) => c.id), ["con_pub"]);
  } finally { cleanup(); }
});

test("private --migrate: a record present in BOTH stores is absorbed once, not duplicated", () => {
  const { pub, priv, cleanup } = stores();
  try {
    pub.put("decisions", DEC("dec_shared", "from public"));
    priv.put("decisions", DEC("dec_shared", "from private"));
    movePublicMemoryToPrivate(pub, priv);
    const ids = priv.loadAll("decisions").map((d) => d.id);
    assert.deepEqual(ids, ["dec_shared"]); // single record, no duplicate id
  } finally { cleanup(); }
});

test("private --migrate: never writes to the public store; dropAll empties it afterward", () => {
  const { pub, priv, roots: [pubRoot], cleanup } = stores();
  try {
    pub.put("decisions", DEC("dec_pub", "public"));
    pub.put("constraints", CON("con_pub", "public constraint"));

    movePublicMemoryToPrivate(pub, priv);
    // move() copies, never deletes — the public store still has its records here.
    assert.equal(pub.loadAll("decisions").length, 1);
    assert.equal(pub.loadAll("constraints").length, 1);

    // the CLI empties the public store only after the move returns.
    for (const kind of ["components", "edges", "symbols", "decisions", "bugs", "constraints"] as const) pub.dropAll(kind);
    assert.equal(pub.loadAll("decisions").length, 0);
    assert.equal(pub.loadAll("constraints").length, 0);
    const decDir = join(pubRoot!, ".hunch", "decisions");
    assert.ok(!readdirSync(decDir).some((f) => f.endsWith(".json")), "public decisions dir still has JSON files");
  } finally { cleanup(); }
});

test("private --migrate: ignoreHunchMemory adds the memory tree once and is idempotent", () => {
  const root = mkdtempSync(join(tmpdir(), "hunch-mig-gi-"));
  try {
    writeFileSync(join(root, ".gitignore"), "node_modules/\n");
    const first = ignoreHunchMemory(root);
    assert.equal(first.action, "appended");
    const gi = readFileSync(join(root, ".gitignore"), "utf8");
    for (const dir of HUNCH_MEMORY_DIRS) assert.match(gi, new RegExp(`^${dir.replace(/[.]/g, "\\.")}/$`, "m"));

    const second = ignoreHunchMemory(root);
    assert.equal(second.action, "unchanged"); // re-running is a no-op
    const occurrences = readFileSync(join(root, ".gitignore"), "utf8").split("private-only").length - 1;
    assert.equal(occurrences, 2); // exactly one marked block (START + END markers)
  } finally { rmSync(root, { recursive: true, force: true }); }
});
