import { cleanupDir } from "./fixtures.js";
import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, mkdirSync, readFileSync, writeFileSync, rmSync, symlinkSync } from "node:fs";
import { execFileSync } from "node:child_process";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { hunchPaths } from "../src/core/paths.js";
import { HunchStore } from "../src/store/hunchStore.js";
import { indexRepo, isExtractorEdge, mergeScannedEdges } from "../src/extractors/indexer.js";
@@CLEANROOM_HOLE_1@@
import { edgeId, resourceId, resourceRelationshipId } from "../src/core/ids.js";
import { EdgeSchema, RESOURCE_RELATIONSHIP_SCHEMA_VERSION, extracted } from "../src/core/types.js";
@@CLEANROOM_HOLE_2@@

function fixtureRepo(): string {
  const root = mkdtempSync(join(tmpdir(), "hunch-idx-"));
  mkdirSync(join(root, "src/auth"), { recursive: true });
  mkdirSync(join(root, "src/billing"), { recursive: true });
  writeFileSync(join(root, "src/auth/session.ts"), `import { jwtDecode } from "./jwt.js";\nexport function verifySession(t){ return jwtDecode(t); }\n`);
  writeFileSync(join(root, "src/auth/jwt.ts"), `export function jwtDecode(t){ return t; }\n`);
  writeFileSync(join(root, "src/billing/charge.ts"), `import { verifySession } from "../auth/session.js";\nexport function charge(t){ return verifySession(t); }\n`);
  return root;
}

test("indexRepo builds symbols, call edges, components, and cross-file blast radius", () => {
  const root = fixtureRepo();
  const store = new HunchStore(hunchPaths(root));
  store.json.ensureDirs();
  const res = indexRepo(store, root, { churn: false });
  store.reindex();

  assert.equal(res.files, 3);
  assert.ok(res.symbols >= 3);

  const syms = store.json.loadAll("symbols");
  const verify = syms.find((s) => s.name === "verifySession")!;
  assert.ok(verify, "verifySession indexed");

  // charge -> verifySession resolved across files
  const deps = store.getDependents(verify.id).map((d) => d.via);
  assert.ok(deps.some((v) => v.includes("charge")), "charge is a dependent of verifySession");

  // components derived from src/<dir>
  const comps = store.json.loadAll("components").map((c) => c.name).sort();
  assert.deepEqual(comps, ["Auth", "Billing"]);

  store.close();
  cleanupDir(root);
});

test("reindex preserves component enrichment and does not churn timestamps", () => {
  const root = fixtureRepo();
  const store = new HunchStore(hunchPaths(root));
  store.json.ensureDirs();
  indexRepo(store, root, { churn: false });

  // curate: enrichment written onto the stored record (what raiseFragility /
  // a human curation pass does)
  const auth = store.json.loadAll("components").find((c) => c.name === "Auth")!;
  store.json.put("components", {
    ...auth,
    responsibility: "Session verification",
    fragility: 0.4,
    provenance: { ...auth.provenance, source: "human", confidence: 0.95 },
  });
  const before = store.json.loadAll("components").find((c) => c.id === auth.id)!;

  indexRepo(store, root, { churn: false }); // unchanged layout → byte-identical record
  const after = store.json.loadAll("components").find((c) => c.id === auth.id)!;
  assert.equal(after.responsibility, "Session verification", "curated responsibility survives reindex");
  assert.equal(after.fragility, 0.4, "raised fragility survives reindex");
  assert.equal(after.provenance.source, "human", "upgraded provenance survives reindex");
  assert.equal(after.created_at, before.created_at, "created_at is stable");
  assert.equal(after.updated_at, before.updated_at, "updated_at untouched when nothing changed");

  // layout change for the same component → record updates, created_at still stable
  writeFileSync(join(root, "src/auth/mfa.ts"), `export function mfa(){ return true; }\n`);
  indexRepo(store, root, { churn: false });
  const grown = store.json.loadAll("components").find((c) => c.id === auth.id)!;
  assert.equal(grown.created_at, before.created_at, "created_at survives a real change");
  assert.equal(grown.responsibility, "Session verification", "enrichment survives a real change");

  store.close();
  cleanupDir(root);
});

test("fast reindex preserves measured churn instead of rewriting it to zero", () => {
  const root = fixtureRepo();
  const g = (...args: string[]) => execFileSync("git", ["-C", root, ...args], { stdio: "ignore" });
  g("init", "-q");
  g("-c", "user.email=t@t", "-c", "user.name=t", "add", "-A");
  g("-c", "user.email=t@t", "-c", "user.name=t", "commit", "-qm", "initial source");
  writeFileSync(join(root, "src/auth/session.ts"), `import { jwtDecode } from "./jwt.js";\nexport function verifySession(t){ return jwtDecode(t); }\n// measured change\n`);
  g("-c", "user.email=t@t", "-c", "user.name=t", "add", "src/auth/session.ts");
  g("-c", "user.email=t@t", "-c", "user.name=t", "commit", "-qm", "change session source");

  const store = new HunchStore(hunchPaths(root));
  try {
    store.json.ensureDirs();
    indexRepo(store, root);
    const symbolsFile = join(root, ".hunch/symbols/index.json");
    const measured = readFileSync(symbolsFile, "utf8");
    const session = store.json.loadAll("symbols").find((symbol) => symbol.file === "src/auth/session.ts")!;
    assert.ok(session.metrics.churn_90d >= 2, `expected measured churn, got ${session.metrics.churn_90d}`);

    indexRepo(store, root, { churn: false });
    assert.equal(readFileSync(symbolsFile, "utf8"), measured,
      "an unchanged fast scan is byte-identical to the last fully measured graph");
  } finally {
    store.close();
    cleanupDir(root);
  }
});

test("GIT-TRACKED vendored dirs (node_modules, dist) are excluded from indexing", () => {
  const root = fixtureRepo();
  // a repo that TRACKS vendored code: `git ls-files` returns it, the walk never runs
  mkdirSync(join(root, "node_modules/lib"), { recursive: true });
  mkdirSync(join(root, "dist"), { recursive: true });
  writeFileSync(join(root, "node_modules/lib/vendored.ts"), `export function vendored(){ return 1; }\n`);
  writeFileSync(join(root, "dist/build-output.ts"), `export function built(){ return 1; }\n`);
  const g = (...args: string[]) => execFileSync("git", ["-C", root, ...args], { stdio: "ignore" });
  g("init", "-q");
  g("-c", "user.email=t@t", "-c", "user.name=t", "add", "-f", "-A");
  g("-c", "user.email=t@t", "-c", "user.name=t", "commit", "-qm", "vendored tracked");
  const store = new HunchStore(hunchPaths(root));
  store.json.ensureDirs();
  const res = indexRepo(store, root, { churn: false });
  assert.equal(res.files, 3, "only the 3 real source files are indexed");
  const files = new Set(store.json.loadAll("symbols").map((s) => s.file.replace(/\\/g, "/")));
  assert.ok(![...files].some((f) => f.includes("node_modules") || f.startsWith("dist/")), `vendored files indexed: ${[...files].join(", ")}`);
  store.close();
  cleanupDir(root);
});

test("a Git-tracked source symlink is skipped without reading its external target", { skip: SYMLINK_SKIP }, () => {
  const root = mkdtempSync(join(tmpdir(), "hunch-idx-symlink-root-"));
  const outside = mkdtempSync(join(tmpdir(), "hunch-idx-symlink-outside-"));
  const outsideFile = join(outside, "outside.ts");
  const outsideBytes = "export function externalSecretDoNotIndex(){ return 42; }\n";
  writeFileSync(outsideFile, outsideBytes);
  mkdirSync(join(root, "src"), { recursive: true });
  symlinkSync(outsideFile, join(root, "src/external.ts"));
  const g = (...args: string[]) => execFileSync("git", ["-C", root, ...args], { stdio: "ignore" });
  g("init", "-q");
  g("-c", "user.email=t@t", "-c", "user.name=t", "add", "src/external.ts");
  g("-c", "user.email=t@t", "-c", "user.name=t", "commit", "-qm", "track source symlink");

  const store = new HunchStore(hunchPaths(root));
  try {
    store.json.ensureDirs();
    const result = indexRepo(store, root, { churn: false });
    assert.equal(result.files, 1, "the tracked entry is discovered without being trusted");
    assert.equal(result.skipped, 1, "the symlink is reported as a skipped scanner input");
    assert.equal(store.json.loadAll("symbols").length, 0);
    assert.equal(store.json.loadAll("edges").length, 0);
    assert.equal(readFileSync(outsideFile, "utf8"), outsideBytes);
  } finally {
    store.close();
    cleanupDir(root);
    cleanupDir(outside);
  }
});

test("same-named symbols in one file get unique, stable ids (no PK collision)", () => {
  const root = mkdtempSync(join(tmpdir(), "hunch-dup-"));
  mkdirSync(join(root, "src"), { recursive: true });
  // two classes each with a method `run` — same (file,name,kind)
  writeFileSync(join(root, "src/svc.ts"), `class A { run(){ return 1; } }\nclass B { run(){ return 2; } }\n`);
  const store = new HunchStore(hunchPaths(root));
  store.json.ensureDirs();
  indexRepo(store, root, { churn: false });
  store.reindex(); // would throw UNIQUE constraint if ids collided

  const runs = store.json.loadAll("symbols").filter((s) => s.name === "run");
  assert.equal(runs.length, 2);
  assert.equal(new Set(runs.map((s) => s.id)).size, 2, "ids are distinct");

  // stable across a re-run
  const firstIds = runs.map((s) => s.id).sort();
  indexRepo(store, root, { churn: false });
  const secondIds = store.json.loadAll("symbols").filter((s) => s.name === "run").map((s) => s.id).sort();
  assert.deepEqual(secondIds, firstIds);
  store.close();
  cleanupDir(root);
});

test("member call to a top-level function does NOT create an edge; method calls do (regression #4)", () => {
  const root = mkdtempSync(join(tmpdir(), "hunch-member-"));
  mkdirSync(join(root, "src"), { recursive: true });
  writeFileSync(join(root, "src/a.ts"), `export function helper(){ return 1; }\nexport class S { method(){ return 2; } }\n`);
  writeFileSync(
    join(root, "src/b.ts"),
    `import { helper, S } from "./a.js";\n` +
      `export function direct(){ return helper(); }\n` + // direct call -> edge to helper
      `export function viaMember(o){ return o.helper(); }\n` + // member call to a top-level fn name -> NO edge
      `export function viaMethod(s){ return s.method(); }\n`, // member call to a real method -> edge
  );
  const store = new HunchStore(hunchPaths(root));
  store.json.ensureDirs();
  indexRepo(store, root, { churn: false });
  store.reindex();

  const helper = store.json.loadAll("symbols").find((s) => s.name === "helper")!;
  const method = store.json.loadAll("symbols").find((s) => s.name === "method")!;
  const helperDeps = store.getDependents(helper.id).map((d) => d.via);
  assert.ok(helperDeps.some((v) => v.includes("direct")), "direct call creates an edge");
  assert.ok(!helperDeps.some((v) => v.includes("viaMember")), "member call to a top-level fn does NOT");
  const methodDeps = store.getDependents(method.id).map((d) => d.via);
  assert.ok(methodDeps.some((v) => v.includes("viaMethod")), "member call to a real method creates an edge");

  store.close();
  cleanupDir(root);
});

test("unimported same-named callbacks do NOT resolve to unrelated cross-file symbols", () => {
  const root = mkdtempSync(join(tmpdir(), "hunch-callback-name-"));
  mkdirSync(join(root, "src"), { recursive: true });
  writeFileSync(join(root, "src/store.ts"), `export function resolve(id){ return id; }\n`);
  writeFileSync(
    join(root, "src/provider.ts"),
    `export function execute(){ return new Promise((resolve) => resolve("ok")); }\n`,
  );
  const store = new HunchStore(hunchPaths(root));
  store.json.ensureDirs();
  indexRepo(store, root, { churn: false });
  store.reindex();

  const unrelated = store.json.loadAll("symbols").find((s) => s.file === "src/store.ts" && s.name === "resolve")!;
  assert.ok(unrelated, "the unrelated repository symbol is indexed");
  assert.deepEqual(store.getDependents(unrelated.id), [], "a callback parameter with the same name creates no cross-file call edge");

  store.close();
  cleanupDir(root);
});

@@CLEANROOM_HOLE_3@@
  cleanupDir(root);
@@CLEANROOM_HOLE_4@@
  cleanupDir(root);
@@CLEANROOM_HOLE_5@@
  cleanupDir(root);
@@CLEANROOM_HOLE_6@@
  cleanupDir(withInitRoot);
@@CLEANROOM_HOLE_7@@
  cleanupDir(noInitRoot);
@@CLEANROOM_HOLE_8@@
  cleanupDir(root);
@@CLEANROOM_HOLE_9@@
  cleanupDir(root);
@@CLEANROOM_HOLE_10@@
  cleanupDir(root);
@@CLEANROOM_HOLE_11@@
  cleanupDir(root);
@@CLEANROOM_HOLE_12@@
test("indexing is deterministic — same ids on re-run", () => {
  const root = fixtureRepo();
  const store = new HunchStore(hunchPaths(root));
  store.json.ensureDirs();
  indexRepo(store, root, { churn: false });
  const first = store.json.loadAll("symbols").map((s) => s.id).sort();
  indexRepo(store, root, { churn: false });
  const second = store.json.loadAll("symbols").map((s) => s.id).sort();
  assert.deepEqual(first, second);
  store.close();
  cleanupDir(root);
@@CLEANROOM_HOLE_13@@
  cleanupDir(root);
});

@@CLEANROOM_HOLE_14@@
  cleanupDir(root);
@@CLEANROOM_HOLE_15@@
  cleanupDir(root);
@@CLEANROOM_HOLE_16@@
  cleanupDir(root);
@@CLEANROOM_HOLE_17@@
  cleanupDir(root);
@@CLEANROOM_HOLE_18@@
  cleanupDir(root);
@@CLEANROOM_HOLE_19@@
  cleanupDir(root);
@@CLEANROOM_HOLE_20@@
  cleanupDir(root);
@@CLEANROOM_HOLE_21@@
  cleanupDir(root);
@@CLEANROOM_HOLE_22@@
  cleanupDir(root);
@@CLEANROOM_HOLE_23@@
  cleanupDir(root);
@@CLEANROOM_HOLE_24@@
  cleanupDir(root);
@@CLEANROOM_HOLE_25@@
  cleanupDir(root);
@@CLEANROOM_HOLE_26@@
  cleanupDir(root);
@@CLEANROOM_HOLE_27@@
  cleanupDir(root);
@@CLEANROOM_HOLE_28@@
  cleanupDir(root);
@@CLEANROOM_HOLE_29@@
  cleanupDir(root);
@@CLEANROOM_HOLE_30@@
  cleanupDir(root);
@@CLEANROOM_HOLE_31@@
  cleanupDir(root);
@@CLEANROOM_HOLE_32@@
  cleanupDir(root);
@@CLEANROOM_HOLE_33@@
  cleanupDir(root);
@@CLEANROOM_HOLE_34@@
  cleanupDir(root);
@@CLEANROOM_HOLE_35@@
  cleanupDir(root);
@@CLEANROOM_HOLE_36@@
for (const dirtyKind of ["staged", "unstaged", "untracked"] as const) {
  test(`requireClean rejects ${dirtyKind} indexed-code changes before graph JSON writes`, () => {
    const root = fixtureRepo();
    const git = (...args: string[]) => execFileSync("git", ["-C", root, ...args], { encoding: "utf8" }).trim();
    git("init", "-q", "-b", "main");
    git("config", "user.email", "index-clean@test.invalid");
    git("config", "user.name", "Index Clean Test");
    git("add", "src");
    git("commit", "-qm", "fixture: clean source");

    const store = new HunchStore(hunchPaths(root));
    try {
      store.json.ensureDirs();
      indexRepo(store, root, { churn: false });
      const symbolsFile = join(root, ".hunch/symbols/index.json");
      const before = readFileSync(symbolsFile);

      if (dirtyKind === "untracked") {
        writeFileSync(join(root, "src/auth/pending.ts"), "export function pending(){ return true; }\n");
      } else {
        writeFileSync(join(root, "src/auth/session.ts"), "export function dirty(){ return false; }\n");
        if (dirtyKind === "staged") git("add", "src/auth/session.ts");
      }

      assert.throws(
        () => indexRepo(store, root, { churn: false, requireClean: true }),
        /dirty indexed code.*commit or stash/i,
      );
      assert.deepEqual(readFileSync(symbolsFile), before, "the failed preflight writes no graph bytes");
    } finally {
      store.close();
      cleanupDir(root);
    }
  });
}

function goFixtureRepo(): string {
  const root = mkdtempSync(join(tmpdir(), "hunch-idx-go-"));
  mkdirSync(join(root, "src/auth"), { recursive: true });
  mkdirSync(join(root, "src/billing"), { recursive: true });
  writeFileSync(join(root, "go.mod"), `module example.com/demo\n\ngo 1.22\n`);
  writeFileSync(
    join(root, "src/auth/session.go"),
    // a same-file direct call (VerifySession -> decodeToken) plus a module-prefixed
    // cross-component import that is only used via a package-qualified (member)
    // call, so import resolution genuinely carries the depends_on edge.
    `package auth\n\nimport (\n\t"fmt"\n\t"example.com/demo/src/billing"\n)\n\nfunc VerifySession(t string) string {\n\tid := decodeToken(t)\n\tfmt.Println(billing.Charge(id))\n\treturn id\n}\n\nfunc decodeToken(t string) string {\n\treturn t\n}\n`,
  );
  writeFileSync(
    join(root, "src/billing/charge.go"),
    `package billing\n\nfunc Charge(t string) string {\n\treturn t\n}\n`,
  );
  return root;
}

test("indexRepo resolves module-prefixed Go imports across component boundaries", () => {
  const root = goFixtureRepo();
  const store = new HunchStore(hunchPaths(root));
  store.json.ensureDirs();
  const res = indexRepo(store, root, { churn: false });
  store.reindex();

  assert.equal(res.files, 2);
  assert.ok(res.symbols >= 3);

  const syms = store.json.loadAll("symbols");
  const verify = syms.find((s) => s.name === "VerifySession");
  assert.ok(verify, "VerifySession indexed");
  assert.equal(verify!.file, "src/auth/session.go");

  const decode = syms.find((s) => s.name === "decodeToken");
  assert.ok(decode, "decodeToken indexed");
  const deps = store.getDependents(decode!.id).map((d) => d.via);
  assert.ok(deps.some((v) => v.includes("VerifySession")), "VerifySession is a dependent of decodeToken");

  const comps = store.json.loadAll("components");
  assert.deepEqual(comps.map((c) => c.name).sort(), ["Auth", "Billing"]);
  const auth = comps.find((c) => c.name === "Auth")!;
  const billing = comps.find((c) => c.name === "Billing")!;

  // "example.com/demo/src/billing" strips the go.mod module prefix to the
  // src/billing directory and must land a depends_on edge; the stdlib "fmt"
  // import resolves to nothing and must not fabricate one.
  const edges = store.json.loadAll("edges");
  assert.ok(
    edges.some((e) => e.type === "depends_on" && e.from === auth.id && e.to === billing.id),
    "Auth depends_on Billing via the module-prefixed import",
  );

  store.close();
  cleanupDir(root);
});
@@CLEANROOM_HOLE_37@@

test("reindex keeps supersedes edges and reviewed relationships (#288)", () => {
  const root = fixtureRepo();
  const store = new HunchStore(hunchPaths(root));
  store.json.ensureDirs();
  const first = indexRepo(store, root, { churn: false });
  const extractorEdgesBefore = store.json.loadAll("edges").filter(isExtractorEdge).length;
  assert.ok(extractorEdgesBefore > 0, "the fixture yields extractor edges");
  assert.equal(extractorEdgesBefore, first.edges, "the scan count covers exactly the extractor edges");

  // shaped exactly like supersedeIn writes it (src/store/hunchStore.ts)
  const supersedes = EdgeSchema.parse({
    schema: "hunch.edge/1",
    id: edgeId("dec_new", "dec_old", "supersedes"),
    from: "dec_new",
    to: "dec_old",
    type: "supersedes",
    reason: "dec_new supersedes dec_old",
    strength: 1,
    provenance: { source: "derived", confidence: 1, evidence: ["dec_new", "dec_old"] },
    environment: null,
    metadata: {},
  });
  store.json.put("edges", supersedes);

  // a human-reviewed Landscape relationship, as `hunch landscape adopt` writes it
  const repositoryId = resourceId("repository", "https://github.com/acme/payments");
  const apiId = resourceId("api", "openapi.yaml");
  const relationship = EdgeSchema.parse({
    schema: RESOURCE_RELATIONSHIP_SCHEMA_VERSION,
    id: resourceRelationshipId(repositoryId, apiId, "contains"),
    from: repositoryId,
    to: apiId,
    type: "contains",
    reason: "repository declares API",
    strength: 1,
    provenance: { source: "extracted:api-declaration", confidence: 0.9, evidence: ["openapi.yaml"] },
    currentness: { status: "unverified", source_revision: "deadbeef" },
    environment: null,
    metadata: { discovery_authority: "reviewed" },
  });
  store.json.put("edges", relationship);

  indexRepo(store, root, { churn: false });

  const after = store.json.loadAll("edges");
  assert.deepEqual(after.find((e) => e.id === supersedes.id), supersedes, "supersedes edge survives reindex");
  assert.deepEqual(after.find((e) => e.id === relationship.id), relationship, "reviewed relationship survives reindex");
  assert.equal(after.filter(isExtractorEdge).length, extractorEdgesBefore, "every extractor edge is still there");

  store.close();
  cleanupDir(root);
});

test("reindex still drops stale extractor edges", () => {
  const root = fixtureRepo();
  const store = new HunchStore(hunchPaths(root));
  store.json.ensureDirs();
  indexRepo(store, root, { churn: false });

  const stale = store.json.loadAll("edges").find((e) => isExtractorEdge(e) && e.reason.includes("charge"));
  assert.ok(stale, "charge -> verifySession edge indexed on the first pass");

  rmSync(join(root, "src/billing/charge.ts"));
  indexRepo(store, root, { churn: false });

  assert.equal(
    store.json.loadAll("edges").find((e) => e.id === stale.id),
    undefined,
    "an extractor edge whose source is gone is not carried forward",
  );

  store.close();
  cleanupDir(root);
});

test("mergeScannedEdges keeps the carried edge on an id collision", () => {
  const carried = EdgeSchema.parse({
    schema: "hunch.edge/1",
    id: edgeId("a", "b", "supersedes"),
    from: "a", to: "b", type: "supersedes",
    reason: "carried", strength: 1,
    provenance: { source: "derived", confidence: 1, evidence: [] },
    environment: null, metadata: {},
  });
  const collidingScan = { ...carried, reason: "scanned", provenance: extracted(0.8, ["src/a.ts"]) };
  const freshScan = EdgeSchema.parse({
    schema: "hunch.edge/1",
    id: edgeId("c", "d", "calls"),
    from: "c", to: "d", type: "calls",
    reason: "c calls d", strength: 0.8,
    provenance: extracted(0.8, ["src/a.ts"]),
    environment: null, metadata: {},
  });

  const merged = mergeScannedEdges([carried], [collidingScan, freshScan]);
  assert.deepEqual(merged, [carried, freshScan], "the carried edge wins, the non-colliding scan is appended");
  assert.equal(new Set(merged.map((e) => e.id)).size, merged.length, "no duplicate ids");
});

// Issue #297 gap 1: a Kubernetes reference resolves WITHIN a namespace. A
// MISSING namespace is UNKNOWN and matches anything; two DIFFERENT literal
// namespaces block the edge.

test("same-named ConfigMaps in namespaces a and b: a Deployment in a resolves only to the one in a", () => {
  const root = mkdtempSync(join(tmpdir(), "hunch-idx-k8sns-pick-"));
  mkdirSync(join(root, "templates"), { recursive: true });
  writeFileSync(join(root, "Chart.yaml"), `apiVersion: v2\nname: mychart\nversion: 0.1.0\n`);
  writeFileSync(join(root, "templates/configmap-a.yaml"), `apiVersion: v1\nkind: ConfigMap\nmetadata:\n  name: shared-name\n  namespace: a\n`);
  writeFileSync(join(root, "templates/configmap-b.yaml"), `apiVersion: v1\nkind: ConfigMap\nmetadata:\n  name: shared-name\n  namespace: b\n`);
  writeFileSync(join(root, "templates/deployment.yaml"), `
apiVersion: apps/v1
kind: Deployment
metadata:
  name: my-app
  namespace: a
spec:
  template:
    spec:
      containers:
      - name: app
        envFrom:
        - configMapRef:
            name: shared-name
`);
  const store = new HunchStore(hunchPaths(root));
  store.json.ensureDirs();
  indexRepo(store, root, { churn: false });
  store.reindex();

  const syms = store.json.loadAll("symbols");
  const deployment = syms.find((s) => s.name === "Deployment/my-app");
  const cmA = syms.find((s) => s.name === "ConfigMap/shared-name" && s.file === "templates/configmap-a.yaml");
  const cmB = syms.find((s) => s.name === "ConfigMap/shared-name" && s.file === "templates/configmap-b.yaml");
  assert.ok(deployment && cmA && cmB, "all three resource symbols indexed");

  const edges = store.json.loadAll("edges");
  assert.ok(edges.some((e) => e.from === deployment!.id && e.to === cmA!.id && e.type === "references"), "namespace a disambiguates what was previously an ambiguous 2-candidate match");
  assert.equal(edges.some((e) => e.from === deployment!.id && e.to === cmB!.id), false, "the same-named ConfigMap in namespace b is never targeted");

  store.close();
  cleanupDir(root);
});

test("a Deployment with no namespace still resolves to a single ConfigMap in namespace b (unknown matches anything)", () => {
  const root = mkdtempSync(join(tmpdir(), "hunch-idx-k8sns-unknown-"));
  mkdirSync(join(root, "templates"), { recursive: true });
  writeFileSync(join(root, "Chart.yaml"), `apiVersion: v2\nname: mychart\nversion: 0.1.0\n`);
  writeFileSync(join(root, "templates/configmap.yaml"), `apiVersion: v1\nkind: ConfigMap\nmetadata:\n  name: my-config\n  namespace: b\n`);
  writeFileSync(join(root, "templates/deployment.yaml"), `
apiVersion: apps/v1
kind: Deployment
metadata:
  name: my-app
spec:
  template:
    spec:
      containers:
      - name: app
        envFrom:
        - configMapRef:
            name: my-config
`);
  const store = new HunchStore(hunchPaths(root));
  store.json.ensureDirs();
  indexRepo(store, root, { churn: false });
  store.reindex();

  const syms = store.json.loadAll("symbols");
  const deployment = syms.find((s) => s.name === "Deployment/my-app");
  const configMap = syms.find((s) => s.name === "ConfigMap/my-config");
  const edges = store.json.loadAll("edges");
  assert.ok(edges.some((e) => e.from === deployment!.id && e.to === configMap!.id && e.type === "references"), "an unknown namespace must not start blocking edges that resolved before");

  store.close();
  cleanupDir(root);
});

test("a Deployment in namespace a does NOT resolve to the only ConfigMap when that ConfigMap is in namespace b", () => {
  const root = mkdtempSync(join(tmpdir(), "hunch-idx-k8sns-cross-"));
  mkdirSync(join(root, "templates"), { recursive: true });
  writeFileSync(join(root, "Chart.yaml"), `apiVersion: v2\nname: mychart\nversion: 0.1.0\n`);
  writeFileSync(join(root, "templates/configmap.yaml"), `apiVersion: v1\nkind: ConfigMap\nmetadata:\n  name: my-config\n  namespace: b\n`);
  writeFileSync(join(root, "templates/deployment.yaml"), `
apiVersion: apps/v1
kind: Deployment
metadata:
  name: my-app
  namespace: a
spec:
  template:
    spec:
      containers:
      - name: app
        envFrom:
        - configMapRef:
            name: my-config
`);
  const store = new HunchStore(hunchPaths(root));
  store.json.ensureDirs();
  indexRepo(store, root, { churn: false });
  store.reindex();

  const syms = store.json.loadAll("symbols");
  const deployment = syms.find((s) => s.name === "Deployment/my-app");
  const configMap = syms.find((s) => s.name === "ConfigMap/my-config");
  assert.ok(deployment && configMap, "both resource symbols indexed");
  const edges = store.json.loadAll("edges");
  assert.equal(edges.some((e) => e.from === deployment!.id && e.to === configMap!.id), false, "two different literal namespaces block the edge");

  store.close();
  cleanupDir(root);
});

test("a reference in namespace a with one candidate in a and one with no namespace is ambiguous -- no edge", () => {
  const root = mkdtempSync(join(tmpdir(), "hunch-idx-k8sns-ambig-"));
  mkdirSync(join(root, "templates"), { recursive: true });
  writeFileSync(join(root, "Chart.yaml"), `apiVersion: v2\nname: mychart\nversion: 0.1.0\n`);
  writeFileSync(join(root, "templates/configmap-a.yaml"), `apiVersion: v1\nkind: ConfigMap\nmetadata:\n  name: shared-name\n  namespace: a\n`);
  writeFileSync(join(root, "templates/configmap-unknown.yaml"), `apiVersion: v1\nkind: ConfigMap\nmetadata:\n  name: shared-name\n`);
  writeFileSync(join(root, "templates/deployment.yaml"), `
apiVersion: apps/v1
kind: Deployment
metadata:
  name: my-app
  namespace: a
spec:
  template:
    spec:
      containers:
      - name: app
        envFrom:
        - configMapRef:
            name: shared-name
`);
  const store = new HunchStore(hunchPaths(root));
  store.json.ensureDirs();
  indexRepo(store, root, { churn: false });
  store.reindex();

  const syms = store.json.loadAll("symbols");
  const deployment = syms.find((s) => s.name === "Deployment/my-app");
  const edges = store.json.loadAll("edges");
  assert.equal(edges.filter((e) => e.type === "references" && e.from === deployment!.id).length, 0, "an unknown-namespace candidate stays compatible, so two candidates survive the filter and the existing don't-guess rule declines");

  store.close();
  cleanupDir(root);
});

test("a Service's selector in namespace a binds a label-matching workload with no namespace but NOT one in namespace b", () => {
  const root = mkdtempSync(join(tmpdir(), "hunch-idx-k8sns-sel-"));
  mkdirSync(join(root, "manifests"), { recursive: true });
  writeFileSync(join(root, "Chart.yaml"), `apiVersion: v2\nname: mychart\nversion: 0.1.0\n`);
  writeFileSync(join(root, "manifests/service.yaml"), `
apiVersion: v1
kind: Service
metadata:
  name: my-service
  namespace: a
spec:
  selector:
    app: my-app
`);
  writeFileSync(join(root, "manifests/deployment-b.yaml"), `
apiVersion: apps/v1
kind: Deployment
metadata:
  name: app-in-b
  namespace: b
spec:
  template:
    metadata:
      labels:
        app: my-app
    spec:
      containers:
      - name: app
`);
  writeFileSync(join(root, "manifests/deployment-unknown.yaml"), `
apiVersion: apps/v1
kind: Deployment
metadata:
  name: app-no-ns
spec:
  template:
    metadata:
      labels:
        app: my-app
    spec:
      containers:
      - name: app
`);
  const store = new HunchStore(hunchPaths(root));
  store.json.ensureDirs();
  indexRepo(store, root, { churn: false });
  store.reindex();

  const syms = store.json.loadAll("symbols");
  const service = syms.find((s) => s.name === "Service/my-service");
  const inB = syms.find((s) => s.name === "Deployment/app-in-b");
  const noNs = syms.find((s) => s.name === "Deployment/app-no-ns");
  assert.ok(service && inB && noNs, "all three resource symbols indexed");

  const edges = store.json.loadAll("edges");
  assert.equal(edges.some((e) => e.from === service!.id && e.to === inB!.id), false, "a Service never selects pods in another namespace, however well the labels match");
  assert.ok(edges.some((e) => e.from === service!.id && e.to === noNs!.id && e.type === "references"), "an unknown-namespace workload still matches");

  store.close();
  cleanupDir(root);
});

test("a Deployment in namespace a resolves to the only ConfigMap when that ConfigMap has NO namespace", () => {
  // The mirror of the cross-namespace block above: unknown matches anything in
  // BOTH directions, so a literal-namespace reference still reaches a target
  // whose namespace this scanner could not name.
  const root = mkdtempSync(join(tmpdir(), "hunch-idx-k8sns-lit-unknown-"));
  mkdirSync(join(root, "templates"), { recursive: true });
  writeFileSync(join(root, "Chart.yaml"), `apiVersion: v2\nname: mychart\nversion: 0.1.0\n`);
  writeFileSync(join(root, "templates/configmap.yaml"), `apiVersion: v1\nkind: ConfigMap\nmetadata:\n  name: my-config\n`);
  writeFileSync(join(root, "templates/deployment.yaml"), `
apiVersion: apps/v1
kind: Deployment
metadata:
  name: my-app
  namespace: a
spec:
  template:
    spec:
      containers:
      - name: app
        envFrom:
        - configMapRef:
            name: my-config
`);
  const store = new HunchStore(hunchPaths(root));
  store.json.ensureDirs();
  indexRepo(store, root, { churn: false });
  store.reindex();

  const syms = store.json.loadAll("symbols");
  const deployment = syms.find((s) => s.name === "Deployment/my-app");
  const configMap = syms.find((s) => s.name === "ConfigMap/my-config");
  assert.ok(deployment && configMap, "both resource symbols indexed");
  const edges = store.json.loadAll("edges");
  assert.ok(edges.some((e) => e.from === deployment!.id && e.to === configMap!.id && e.type === "references"), "a literal-namespace reference still reaches an unknown-namespace target");

  store.close();
  cleanupDir(root);
});

test("a Service with NO namespace selects a label-matching workload in namespace b, and a Service in b selects the one in b", () => {
  // The selector-side mirrors of the test above: unknown on the SELECTOR side
  // matches anything, and two matching literals still bind.
  const root = mkdtempSync(join(tmpdir(), "hunch-idx-k8sns-sel-unknown-"));
  mkdirSync(join(root, "manifests"), { recursive: true });
  writeFileSync(join(root, "Chart.yaml"), `apiVersion: v2\nname: mychart\nversion: 0.1.0\n`);
  writeFileSync(join(root, "manifests/service-unknown.yaml"), `
apiVersion: v1
kind: Service
metadata:
  name: svc-no-ns
spec:
  selector:
    app: my-app
`);
  writeFileSync(join(root, "manifests/service-b.yaml"), `
apiVersion: v1
kind: Service
metadata:
  name: svc-in-b
  namespace: b
spec:
  selector:
    app: my-app
`);
  writeFileSync(join(root, "manifests/deployment-b.yaml"), `
apiVersion: apps/v1
kind: Deployment
metadata:
  name: app-in-b
  namespace: b
spec:
  template:
    metadata:
      labels:
        app: my-app
    spec:
      containers:
      - name: app
`);
  const store = new HunchStore(hunchPaths(root));
  store.json.ensureDirs();
  indexRepo(store, root, { churn: false });
  store.reindex();

  const syms = store.json.loadAll("symbols");
  const svcNoNs = syms.find((s) => s.name === "Service/svc-no-ns");
  const svcInB = syms.find((s) => s.name === "Service/svc-in-b");
  const inB = syms.find((s) => s.name === "Deployment/app-in-b");
  assert.ok(svcNoNs && svcInB && inB, "all three resource symbols indexed");

  const edges = store.json.loadAll("edges");
  assert.ok(edges.some((e) => e.from === svcNoNs!.id && e.to === inB!.id && e.type === "references"), "an unknown-namespace Service still selects a literal-namespace workload");
  assert.ok(edges.some((e) => e.from === svcInB!.id && e.to === inB!.id && e.type === "references"), "two identical literal namespaces bind");

  store.close();
  cleanupDir(root);
});

test("a Deployment whose namespace is PARTIALLY templated still resolves to the only ConfigMap in namespace app-prod", () => {
  // `app-{{ .Values.env }}` is not a namespace this scanner can compare, so it
  // must read as unknown -- reading it as the literal text would block the
  // very edge it renders to, a regression against what resolved before #297.
  const root = mkdtempSync(join(tmpdir(), "hunch-idx-k8sns-parttpl-"));
  mkdirSync(join(root, "templates"), { recursive: true });
  writeFileSync(join(root, "Chart.yaml"), `apiVersion: v2\nname: mychart\nversion: 0.1.0\n`);
  writeFileSync(join(root, "templates/configmap.yaml"), `apiVersion: v1\nkind: ConfigMap\nmetadata:\n  name: cfg\n  namespace: app-prod\n`);
  writeFileSync(join(root, "templates/deployment.yaml"), `
apiVersion: apps/v1
kind: Deployment
metadata:
  name: my-app
  namespace: app-{{ .Values.env }}
spec:
  template:
    spec:
      containers:
      - name: app
        envFrom:
        - configMapRef:
            name: cfg
`);
  const store = new HunchStore(hunchPaths(root));
  store.json.ensureDirs();
  indexRepo(store, root, { churn: false });
  store.reindex();

  const syms = store.json.loadAll("symbols");
  const deployment = syms.find((s) => s.name === "Deployment/my-app");
  const configMap = syms.find((s) => s.name === "ConfigMap/cfg");
  assert.ok(deployment && configMap, "both resource symbols indexed");
  const edges = store.json.loadAll("edges");
  assert.ok(edges.some((e) => e.from === deployment!.id && e.to === configMap!.id && e.type === "references"), "a partially templated namespace is unknown, and unknown never blocks an edge");

  store.close();
  cleanupDir(root);
});

test("a Deployment whose namespace is the YAML null word still resolves to the only ConfigMap in namespace app-prod", () => {
  const root = mkdtempSync(join(tmpdir(), "hunch-idx-k8sns-null-"));
  mkdirSync(join(root, "templates"), { recursive: true });
  writeFileSync(join(root, "Chart.yaml"), `apiVersion: v2\nname: mychart\nversion: 0.1.0\n`);
  writeFileSync(join(root, "templates/configmap.yaml"), `apiVersion: v1\nkind: ConfigMap\nmetadata:\n  name: cfg\n  namespace: app-prod\n`);
  writeFileSync(join(root, "templates/deployment.yaml"), `
apiVersion: apps/v1
kind: Deployment
metadata:
  name: my-app
  namespace: null
spec:
  template:
    spec:
      containers:
      - name: app
        envFrom:
        - configMapRef:
            name: cfg
`);
  const store = new HunchStore(hunchPaths(root));
  store.json.ensureDirs();
  indexRepo(store, root, { churn: false });
  store.reindex();

  const syms = store.json.loadAll("symbols");
  const deployment = syms.find((s) => s.name === "Deployment/my-app");
  const configMap = syms.find((s) => s.name === "ConfigMap/cfg");
  assert.ok(deployment && configMap, "both resource symbols indexed");
  const edges = store.json.loadAll("edges");
  assert.ok(edges.some((e) => e.from === deployment!.id && e.to === configMap!.id && e.type === "references"), "`namespace: null` is the same empty value as an absent key, so it must not block");

  store.close();
  cleanupDir(root);
});
