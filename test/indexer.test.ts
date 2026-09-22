import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, mkdirSync, readFileSync, writeFileSync, rmSync, symlinkSync } from "node:fs";
import { execFileSync } from "node:child_process";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { hunchPaths } from "../src/core/paths.js";
import { HunchStore } from "../src/store/hunchStore.js";
import { indexRepo, isExtractorEdge, mergeScannedEdges } from "../src/extractors/indexer.js";
import { pathMatchesGlob } from "../src/core/glob.js";
import { edgeId, resourceId, resourceRelationshipId } from "../src/core/ids.js";
import { EdgeSchema, RESOURCE_RELATIONSHIP_SCHEMA_VERSION, extracted } from "../src/core/types.js";
import { SYMLINK_SKIP, indexedFixtureStore, seedRootLevelFileFixture } from "./helpers.js";

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
  rmSync(root, { recursive: true, force: true });
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
  rmSync(root, { recursive: true, force: true });
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
    rmSync(root, { recursive: true, force: true });
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
  rmSync(root, { recursive: true, force: true });
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
    rmSync(root, { recursive: true, force: true });
    rmSync(outside, { recursive: true, force: true });
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
  rmSync(root, { recursive: true, force: true });
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
  rmSync(root, { recursive: true, force: true });
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
  rmSync(root, { recursive: true, force: true });
});

function pythonFixtureRepo(): string {
  const root = mkdtempSync(join(tmpdir(), "hunch-idx-py-"));
  mkdirSync(join(root, "src/auth"), { recursive: true });
  mkdirSync(join(root, "src/billing"), { recursive: true });
  writeFileSync(
    join(root, "src/auth/session.py"),
    // same-file (same-component) import used in a call — should yield a same-file
    // call edge — PLUS a cross-component relative import (`..billing.charge`) that
    // is never called, so import resolution (issue #5) genuinely gets exercised
    // as a depends_on edge rather than trivially having nothing to resolve.
    `from .jwt import decode_token\nfrom ..billing.charge import charge\n\ndef verify_session(t):\n    return decode_token(t)\n`,
  );
  writeFileSync(join(root, "src/auth/jwt.py"), `def decode_token(t):\n    return t\n`);
  writeFileSync(
    join(root, "src/billing/charge.py"),
    `def charge(t):\n    return t\n`,
  );
  return root;
}

test("indexRepo resolves Python relative imports across component boundaries (issue #5)", () => {
  const root = pythonFixtureRepo();
  const store = new HunchStore(hunchPaths(root));
  store.json.ensureDirs();
  const res = indexRepo(store, root, { churn: false });
  store.reindex();

  assert.equal(res.files, 3);
  assert.ok(res.symbols >= 3);

  const syms = store.json.loadAll("symbols");
  const verify = syms.find((s) => s.name === "verify_session");
  assert.ok(verify, "verify_session indexed");
  assert.equal(verify!.file, "src/auth/session.py");

  const decode = syms.find((s) => s.name === "decode_token");
  assert.ok(decode, "decode_token indexed");

  // verify_session -> decode_token resolved as a same-file call edge
  const deps = store.getDependents(decode!.id).map((d) => d.via);
  assert.ok(deps.some((v) => v.includes("verify_session")), "verify_session is a dependent of decode_token");

  // components derived from src/<dir>, same as TS
  const comps = store.json.loadAll("components");
  assert.deepEqual(comps.map((c) => c.name).sort(), ["Auth", "Billing"]);

  const auth = comps.find((c) => c.name === "Auth")!;
  const billing = comps.find((c) => c.name === "Billing")!;

  // `from ..billing.charge import charge` in src/auth/session.py now resolves to
  // src/billing/charge.py: 2 leading dots -> up 1 directory from src/auth -> "src",
  // plus the "billing/charge" tail -> src/billing/charge.py. A real, resolvable
  // cross-component import must produce a depends_on edge (issue #5) — this
  // replaces the old assertion that no edge was fabricated (that was true only
  // because resolution didn't exist yet, not because this import is ambiguous).
  const edges = store.json.loadAll("edges");
  assert.ok(
    edges.some((e) => e.type === "depends_on" && e.from === auth.id && e.to === billing.id),
    "Auth depends_on Billing via the resolved cross-package relative import",
  );

  store.close();
  rmSync(root, { recursive: true, force: true });
});

function pythonTooManyDotsFixtureRepo(): string {
  const root = mkdtempSync(join(tmpdir(), "hunch-idx-py-toomanydots-"));
  mkdirSync(join(root, "src/auth"), { recursive: true });
  mkdirSync(join(root, "src/billing"), { recursive: true });
  // src/auth/session.py sits 2 directory levels under the repo root (src, auth).
  // 4 leading dots asks to go up 3 levels from src/auth — past the repo root
  // entirely. This must be skipped, not guessed at or crashed on.
  writeFileSync(
    join(root, "src/auth/session.py"),
    `from ....nonexistent import thing\n\ndef verify_session(t):\n    return t\n`,
  );
  writeFileSync(join(root, "src/billing/charge.py"), `def charge(t):\n    return t\n`);
  return root;
}

test("Python relative import with too many leading dots (above repo root) is skipped, not guessed", () => {
  const root = pythonTooManyDotsFixtureRepo();
  const store = new HunchStore(hunchPaths(root));
  store.json.ensureDirs();
  const res = indexRepo(store, root, { churn: false }); // must not throw
  store.reindex();

  assert.equal(res.files, 2);
  const edges = store.json.loadAll("edges");
  assert.ok(
    !edges.some((e) => e.type === "depends_on"),
    "no depends_on edge is fabricated for an out-of-repo relative import",
  );

  store.close();
  rmSync(root, { recursive: true, force: true });
});

function pythonRelativeAtRepoRootBoundaryFixtureRepo(): string {
  const root = mkdtempSync(join(tmpdir(), "hunch-idx-py-relroot-"));
  mkdirSync(join(root, "pkgs/auth"), { recursive: true });
  mkdirSync(join(root, "otherpkg"), { recursive: true });
  // 3 leading dots from pkgs/auth lands EXACTLY on the repo root (pop === segments.length,
  // not pop > segments.length) — the boundary the "too many dots" guard sits right next to.
  writeFileSync(
    join(root, "pkgs/auth/session.py"),
    `from ...otherpkg.mod import thing\n\ndef verify_session(t):\n    return t\n`,
  );
  writeFileSync(join(root, "otherpkg/mod.py"), `def thing(t):\n    return t\n`);
  return root;
}

test("Python relative import landing exactly on the repo root (dot count == directory depth) resolves", () => {
  const root = pythonRelativeAtRepoRootBoundaryFixtureRepo();
  const store = new HunchStore(hunchPaths(root));
  store.json.ensureDirs();
  indexRepo(store, root, { churn: false });
  store.reindex();

  const comps = store.json.loadAll("components");
  const pkgs = comps.find((c) => c.name === "Pkgs")!;
  const otherpkg = comps.find((c) => c.name === "Otherpkg")!;

  const edges = store.json.loadAll("edges");
  assert.ok(
    edges.some((e) => e.type === "depends_on" && e.from === pkgs.id && e.to === otherpkg.id),
    "Pkgs depends_on Otherpkg when the leading-dot count exactly reaches the repo root",
  );

  store.close();
  rmSync(root, { recursive: true, force: true });
});

function pythonBareDotFixtureRepo(withInit: boolean): string {
  const root = mkdtempSync(join(tmpdir(), "hunch-idx-py-baredot-"));
  mkdirSync(join(root, "src/billing"), { recursive: true });
  writeFileSync(
    join(root, "src/billing/api.py"),
    `from . import charge\n\ndef process(t):\n    return t\n`,
  );
  if (withInit) {
    writeFileSync(join(root, "src/billing/__init__.py"), `def charge(t):\n    return t\n`);
  }
  return root;
}

test("Python bare-dot relative import (`from . import x`) resolves within its own package without crashing", () => {
  // `from . import x` always targets the importing file's OWN directory, which the
  // component-derivation scheme (src/<dir>) always groups into the SAME component
  // as the importer — so this can never surface as a depends_on edge (same-component
  // targets are filtered at indexer.ts:162, same as a JS/TS `./sibling` import).
  // This is a crash-safety / file-discovery check, not an edge assertion.
  const withInitRoot = pythonBareDotFixtureRepo(true);
  const storeWithInit = new HunchStore(hunchPaths(withInitRoot));
  storeWithInit.json.ensureDirs();
  const resWithInit = indexRepo(storeWithInit, withInitRoot, { churn: false });
  storeWithInit.reindex();
  assert.equal(resWithInit.files, 2);
  assert.ok(
    storeWithInit.json.loadAll("symbols").some((s) => s.name === "charge" && s.file === "src/billing/__init__.py"),
    "the __init__.py the bare-dot import targets is indexed",
  );
  storeWithInit.close();
  rmSync(withInitRoot, { recursive: true, force: true });

  const noInitRoot = pythonBareDotFixtureRepo(false);
  const storeNoInit = new HunchStore(hunchPaths(noInitRoot));
  storeNoInit.json.ensureDirs();
  // no __init__.py exists to resolve against — must not throw
  const resNoInit = indexRepo(storeNoInit, noInitRoot, { churn: false });
  storeNoInit.reindex();
  assert.equal(resNoInit.files, 1);
  storeNoInit.close();
  rmSync(noInitRoot, { recursive: true, force: true });
});

function pythonAbsoluteRepoRootFixtureRepo(): string {
  const root = mkdtempSync(join(tmpdir(), "hunch-idx-py-abs-root-"));
  mkdirSync(join(root, "authpkg"), { recursive: true });
  mkdirSync(join(root, "billingpkg"), { recursive: true });
  // no "src/" anywhere in this repo — resolution must fall back to the repo root.
  // `import os` alongside a real same-repo absolute import proves genuinely external
  // names are skipped rather than accidentally matched.
  writeFileSync(
    join(root, "authpkg/session.py"),
    `import billingpkg.charge\nimport os\n\ndef verify_session(t):\n    return t\n`,
  );
  writeFileSync(join(root, "billingpkg/charge.py"), `def charge(t):\n    return t\n`);
  return root;
}

test("Python absolute import resolves off the repo root when there is no src/ layout (issue #5)", () => {
  const root = pythonAbsoluteRepoRootFixtureRepo();
  const store = new HunchStore(hunchPaths(root));
  store.json.ensureDirs();
  const res = indexRepo(store, root, { churn: false });
  store.reindex();

  assert.equal(res.files, 2);
  const comps = store.json.loadAll("components");
  const authpkg = comps.find((c) => c.name === "Authpkg")!;
  const billingpkg = comps.find((c) => c.name === "Billingpkg")!;
  assert.ok(authpkg && billingpkg, "both top-level packages become components");

  const edges = store.json.loadAll("edges").filter((e) => e.type === "depends_on");
  assert.equal(edges.length, 1, "only the resolvable absolute import produces an edge — `import os` does not");
  assert.equal(edges[0]!.from, authpkg.id);
  assert.equal(edges[0]!.to, billingpkg.id);

  store.close();
  rmSync(root, { recursive: true, force: true });
});

function pythonAbsoluteBarePackageFixtureRepo(): string {
  const root = mkdtempSync(join(tmpdir(), "hunch-idx-py-abs-barepkg-"));
  mkdirSync(join(root, "authpkg"), { recursive: true });
  mkdirSync(join(root, "billingpkg"), { recursive: true });
  // `import billingpkg` (no submodule) — only resolvable via the __init__.py
  // candidate, a branch the existing `import billingpkg.charge` test doesn't reach.
  writeFileSync(
    join(root, "authpkg/session.py"),
    `import billingpkg\n\ndef verify_session(t):\n    return t\n`,
  );
  writeFileSync(join(root, "billingpkg/__init__.py"), `def charge(t):\n    return t\n`);
  return root;
}

test("Python absolute import of a bare package (no submodule) resolves via __init__.py", () => {
  const root = pythonAbsoluteBarePackageFixtureRepo();
  const store = new HunchStore(hunchPaths(root));
  store.json.ensureDirs();
  indexRepo(store, root, { churn: false });
  store.reindex();

  const comps = store.json.loadAll("components");
  const authpkg = comps.find((c) => c.name === "Authpkg")!;
  const billingpkg = comps.find((c) => c.name === "Billingpkg")!;

  const edges = store.json.loadAll("edges");
  assert.ok(
    edges.some((e) => e.type === "depends_on" && e.from === authpkg.id && e.to === billingpkg.id),
    "Authpkg depends_on Billingpkg via a bare-package absolute import resolved to __init__.py",
  );

  store.close();
  rmSync(root, { recursive: true, force: true });
});

function pythonAbsoluteSrcLayoutFixtureRepo(): string {
  const root = mkdtempSync(join(tmpdir(), "hunch-idx-py-abs-src-"));
  mkdirSync(join(root, "src/auth"), { recursive: true });
  mkdirSync(join(root, "src/billing"), { recursive: true });
  // absolute import omits the `src.` prefix, matching a poetry/setuptools src-layout
  // repo where `src/` is a build root, not part of the importable package path — only
  // resolvable via the src/ layout root candidate, not the plain repo root.
  writeFileSync(
    join(root, "src/auth/session.py"),
    `import billing.charge\n\ndef verify_session(t):\n    return t\n`,
  );
  writeFileSync(join(root, "src/billing/charge.py"), `def charge(t):\n    return t\n`);
  return root;
}

test("Python absolute import resolves via a detected src/ layout root (issue #5)", () => {
  const root = pythonAbsoluteSrcLayoutFixtureRepo();
  const store = new HunchStore(hunchPaths(root));
  store.json.ensureDirs();
  indexRepo(store, root, { churn: false });
  store.reindex();

  const comps = store.json.loadAll("components");
  const auth = comps.find((c) => c.name === "Auth")!;
  const billing = comps.find((c) => c.name === "Billing")!;

  const edges = store.json.loadAll("edges");
  assert.ok(
    edges.some((e) => e.type === "depends_on" && e.from === auth.id && e.to === billing.id),
    "Auth depends_on Billing via the src/-layout-resolved absolute import",
  );

  store.close();
  rmSync(root, { recursive: true, force: true });
});

function pythonDecoratedMethodFixtureRepo(): string {
  const root = mkdtempSync(join(tmpdir(), "hunch-idx-py-decorated-"));
  mkdirSync(join(root, "src/auth"), { recursive: true });
  mkdirSync(join(root, "src/billing"), { recursive: true });
  // A decorated method (kind must classify as "method", not "function" — Finding 1)
  // defined in one component and called via member access from a DIFFERENT file/
  // component. resolveName() requires the callee's file to be statically imported
  // (issue: unimported same-named callbacks must not resolve to unrelated cross-file
  // symbols) — so charge.py imports Base, matching how this call would actually be
  // reached in real code, rather than relying on a bare global-uniqueness guess.
  writeFileSync(
    join(root, "src/auth/session.py"),
    `class Base:\n    @classmethod\n    def create(cls):\n        return cls()\n`,
  );
  writeFileSync(
    join(root, "src/billing/charge.py"),
    `from ..auth.session import Base\n\ndef use_it(b):\n    return b.create()\n`,
  );
  return root;
}

test("cross-file member call to a decorated Python method creates a call edge (regression: Finding 1)", () => {
  const root = pythonDecoratedMethodFixtureRepo();
  const store = new HunchStore(hunchPaths(root));
  store.json.ensureDirs();
  indexRepo(store, root, { churn: false });
  store.reindex();

  const syms = store.json.loadAll("symbols");
  const create = syms.find((s) => s.name === "create");
  assert.ok(create, "create indexed");
  assert.equal(create!.kind, "method", "decorated method classifies as kind \"method\"");
  assert.equal(create!.file, "src/auth/session.py");

  const useIt = syms.find((s) => s.name === "use_it");
  assert.ok(useIt, "use_it indexed");
  assert.notEqual(useIt!.file, create!.file, "caller and callee are in different files");

  // the cross-file member call edge must exist — before the fix, the misclassified
  // "function" symbol was neither `kind === "method"` nor same-file, so the edge
  // was silently dropped.
  const deps = store.getDependents(create!.id).map((d) => d.via);
  assert.ok(deps.some((v) => v.includes("use_it")), "use_it is a dependent of the decorated method create");

  store.close();
  rmSync(root, { recursive: true, force: true });
});

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
  rmSync(root, { recursive: true, force: true });
});

test("YAML anchor/alias produces a \"references\" edge end-to-end, counted toward fan-in like a call", () => {
  const root = mkdtempSync(join(tmpdir(), "hunch-idx-yaml-"));
  mkdirSync(join(root, "config"), { recursive: true });
  writeFileSync(join(root, "config/database.yml"), `
defaults: &defaults
  adapter: postgres

development:
  <<: *defaults
`);
  const store = new HunchStore(hunchPaths(root));
  store.json.ensureDirs();
  const res = indexRepo(store, root, { churn: false });
  store.reindex();

  assert.equal(res.files, 1);
  const syms = store.json.loadAll("symbols");
  const anchor = syms.find((s) => s.name === "defaults");
  assert.ok(anchor, "anchor symbol indexed");
  assert.equal(anchor!.kind, "variable");

  const edges = store.json.loadAll("edges");
  const refEdge = edges.find((e) => e.to === anchor!.id && e.type === "references");
  assert.ok(refEdge, "alias->anchor edge recorded with type \"references\", not \"calls\"");

  assert.ok(anchor!.metrics.fan_in >= 1, "references edges count toward fan-in the same way calls do");

  store.close();
  rmSync(root, { recursive: true, force: true });
});

test("Helm define/include produces a \"references\" edge, chart-scoped by nearest Chart.yaml", () => {
  const root = mkdtempSync(join(tmpdir(), "hunch-idx-helm-"));
  mkdirSync(join(root, "templates"), { recursive: true });
  writeFileSync(join(root, "Chart.yaml"), `apiVersion: v2\nname: mychart\nversion: 0.1.0\n`);
  writeFileSync(join(root, "templates/_helpers.tpl"), `
{{- define "mychart.labels" -}}
app: {{ .Chart.Name }}
{{- end -}}
`);
  writeFileSync(join(root, "templates/deployment.yaml"), `
apiVersion: apps/v1
kind: Deployment
metadata:
  labels:
    {{- include "mychart.labels" . | nindent 4 }}
`);
  const store = new HunchStore(hunchPaths(root));
  store.json.ensureDirs();
  indexRepo(store, root, { churn: false });
  store.reindex();

  const syms = store.json.loadAll("symbols");
  const define = syms.find((s) => s.name === "mychart.labels" && s.file === "templates/_helpers.tpl");
  assert.ok(define, "define block indexed as a symbol");
  assert.equal(define!.kind, "variable");

  const edges = store.json.loadAll("edges");
  const refEdge = edges.find((e) => e.to === define!.id && e.type === "references");
  assert.ok(refEdge, "include -> define recorded as a \"references\" edge across files");
  assert.ok(define!.metrics.fan_in >= 1, "the include counts toward the define's fan_in");

  store.close();
  rmSync(root, { recursive: true, force: true });
});

test("two charts defining the same helper name never produce a cross-chart edge; each chart's own include still resolves within its own chart", () => {
  const root = mkdtempSync(join(tmpdir(), "hunch-idx-helm-multi-"));
  for (const chart of ["chartA", "chartB"]) {
    mkdirSync(join(root, chart, "templates"), { recursive: true });
    writeFileSync(join(root, chart, "Chart.yaml"), `apiVersion: v2\nname: ${chart}\nversion: 0.1.0\n`);
    writeFileSync(join(root, chart, "templates/_helpers.tpl"), `
{{- define "labels" -}}
app: ${chart}
{{- end -}}
`);
    writeFileSync(join(root, chart, "templates/deployment.yaml"), `
metadata:
  labels:
    {{- include "labels" . | nindent 4 }}
`);
  }
  const store = new HunchStore(hunchPaths(root));
  store.json.ensureDirs();
  indexRepo(store, root, { churn: false });
  store.reindex();

  const syms = store.json.loadAll("symbols");
  // Each _helpers.tpl produces TWO symbols: the YAML fallback file-root symbol
  // (kind "file", spanning the whole file) plus the Helm define block itself
  // (kind "variable") — filter to the define, not whichever comes first.
  const defineA = syms.find((s) => s.file === "chartA/templates/_helpers.tpl" && s.kind === "variable")!;
  const defineB = syms.find((s) => s.file === "chartB/templates/_helpers.tpl" && s.kind === "variable")!;
  assert.ok(defineA && defineB, "both charts' define blocks indexed");

  const edges = store.json.loadAll("edges");
  // each chart's include resolves to ITS OWN chart's define, not the other's
  assert.ok(edges.some((e) => e.to === defineA.id && e.type === "references"), "chartA's include resolves within chartA");
  assert.ok(edges.some((e) => e.to === defineB.id && e.type === "references"), "chartB's include resolves within chartB");
  // no edge crosses from a chartB file to chartA's define, or vice versa. An
  // edge's `from`/`to` are symbol ids, not file paths, so resolve `from` back
  // to its file via the symbols list before checking the chart prefix.
  const fileOf = new Map(syms.map((s) => [s.id, s.file] as const));
  const crossChart = edges.filter((e) => e.type === "references" && (
    (e.to === defineA.id && !(fileOf.get(e.from) ?? "").startsWith("chartA/")) ||
    (e.to === defineB.id && !(fileOf.get(e.from) ?? "").startsWith("chartB/"))
  ));
  assert.equal(crossChart.length, 0, "no cross-chart edge for a same-named helper in two separate charts");

  store.close();
  rmSync(root, { recursive: true, force: true });
});

test("a nested subchart (charts/<sub>/Chart.yaml) resolves to its OWN chart root, not the parent's (issue #42)", () => {
  const root = mkdtempSync(join(tmpdir(), "hunch-idx-helm-subchart-"));
  mkdirSync(join(root, "templates"), { recursive: true });
  writeFileSync(join(root, "Chart.yaml"), `apiVersion: v2\nname: parent\nversion: 0.1.0\n`);
  writeFileSync(join(root, "templates/_helpers.tpl"), `
{{- define "labels" -}}
app: parent
{{- end -}}
`);
  writeFileSync(join(root, "templates/deployment.yaml"), `
metadata:
  labels:
    {{- include "labels" . | nindent 4 }}
`);

  mkdirSync(join(root, "charts/sub/templates"), { recursive: true });
  writeFileSync(join(root, "charts/sub/Chart.yaml"), `apiVersion: v2\nname: sub\nversion: 0.1.0\n`);
  writeFileSync(join(root, "charts/sub/templates/_helpers.tpl"), `
{{- define "labels" -}}
app: sub
{{- end -}}
`);
  writeFileSync(join(root, "charts/sub/templates/deployment.yaml"), `
metadata:
  labels:
    {{- include "labels" . | nindent 4 }}
`);

  const store = new HunchStore(hunchPaths(root));
  store.json.ensureDirs();
  indexRepo(store, root, { churn: false });
  store.reindex();

  const syms = store.json.loadAll("symbols");
  const parentDefine = syms.find((s) => s.file === "templates/_helpers.tpl" && s.kind === "variable")!;
  const subDefine = syms.find((s) => s.file === "charts/sub/templates/_helpers.tpl" && s.kind === "variable")!;
  assert.ok(parentDefine && subDefine, "both the parent chart's and the subchart's define blocks indexed");

  const edges = store.json.loadAll("edges");
  // the subchart's own include resolves within the subchart's own scope, not the parent's
  assert.ok(edges.some((e) => e.to === subDefine.id && e.type === "references"), "subchart's include resolves within its own chart scope");
  assert.ok(edges.some((e) => e.to === parentDefine.id && e.type === "references"), "parent chart's include resolves within its own chart scope");
  // no edge crosses the nested-chart boundary in either direction (nearest-ancestor
  // scoping is a deliberate conservative approximation -- see nearestChartRoot's doc
  // comment: it misses a legitimate parent-includes-subchart-define edge rather than
  // ever fabricating a wrong one)
  const fileOf = new Map(syms.map((s) => [s.id, s.file] as const));
  const crossChart = edges.filter((e) => e.type === "references" && (
    (e.to === subDefine.id && !(fileOf.get(e.from) ?? "").startsWith("charts/sub/")) ||
    (e.to === parentDefine.id && (fileOf.get(e.from) ?? "").startsWith("charts/sub/"))
  ));
  assert.equal(crossChart.length, 0, "no edge crosses the nested subchart boundary in either direction");

  store.close();
  rmSync(root, { recursive: true, force: true });
});

test("a parent chart including a define that exists ONLY in a subchart produces no edge (conservative miss, issue #42)", () => {
  // Real Helm's template namespace is release-global, so this include WOULD
  // resolve in an actual `helm template` run -- nearest-ancestor scoping
  // deliberately doesn't model that (see nearestChartRoot's doc comment) and
  // misses this edge rather than guessing which chart's define was meant.
  const root = mkdtempSync(join(tmpdir(), "hunch-idx-helm-subchart-miss-"));
  mkdirSync(join(root, "templates"), { recursive: true });
  writeFileSync(join(root, "Chart.yaml"), `apiVersion: v2\nname: parent\nversion: 0.1.0\n`);
  writeFileSync(join(root, "templates/deployment.yaml"), `
metadata:
  labels:
    {{- include "sub.labels" . | nindent 4 }}
`);

  mkdirSync(join(root, "charts/sub/templates"), { recursive: true });
  writeFileSync(join(root, "charts/sub/Chart.yaml"), `apiVersion: v2\nname: sub\nversion: 0.1.0\n`);
  writeFileSync(join(root, "charts/sub/templates/_helpers.tpl"), `
{{- define "sub.labels" -}}
app: sub
{{- end -}}
`);

  const store = new HunchStore(hunchPaths(root));
  store.json.ensureDirs();
  indexRepo(store, root, { churn: false });
  store.reindex();

  const syms = store.json.loadAll("symbols");
  const subDefine = syms.find((s) => s.name === "sub.labels" && s.kind === "variable")!;
  assert.ok(subDefine, "the subchart's define is still indexed as a symbol");

  const edges = store.json.loadAll("edges");
  assert.equal(
    edges.filter((e) => e.to === subDefine.id && e.type === "references").length,
    0,
    "nearest-ancestor scoping misses the release-global resolution rather than fabricating an edge",
  );

  store.close();
  rmSync(root, { recursive: true, force: true });
});

test("a plain .yaml file with no ancestor Chart.yaml is unaffected by Helm-shaped text", () => {
  const root = mkdtempSync(join(tmpdir(), "hunch-idx-helm-nochart-"));
  mkdirSync(join(root, "config"), { recursive: true });
  writeFileSync(join(root, "config/notachart.yaml"), `
note: |
  literal text that happens to look like {{ include "something" . }}
`);
  const store = new HunchStore(hunchPaths(root));
  store.json.ensureDirs();
  indexRepo(store, root, { churn: false });
  store.reindex();

  const syms = store.json.loadAll("symbols");
  assert.ok(!syms.some((s) => s.name === "something"), "no Helm dialect extraction outside a chart");
  const edges = store.json.loadAll("edges");
  assert.ok(!edges.some((e) => e.type === "references"), "no references edge fabricated outside a chart");

  store.close();
  rmSync(root, { recursive: true, force: true });
});

test("a literal ConfigMap reference from a Deployment produces a \"references\" edge and correct fan_in/fan_out", () => {
  const root = mkdtempSync(join(tmpdir(), "hunch-idx-k8sref-"));
  mkdirSync(join(root, "manifests"), { recursive: true });
  writeFileSync(join(root, "Chart.yaml"), `apiVersion: v2\nname: mychart\nversion: 0.1.0\n`);
  writeFileSync(join(root, "manifests/deployment.yaml"), `
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
  writeFileSync(join(root, "manifests/configmap.yaml"), `
apiVersion: v1
kind: ConfigMap
metadata:
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
  const refEdge = edges.find((e) => e.from === deployment!.id && e.to === configMap!.id && e.type === "references");
  assert.ok(refEdge, "Deployment -> ConfigMap recorded as a \"references\" edge");
  assert.ok(configMap!.metrics.fan_in >= 1, "the reference counts toward the ConfigMap's fan_in");
  assert.equal(edges.some((e) => e.type === "depends_on" && (e.from === deployment!.id || e.to === deployment!.id)), false, "no component-level depends_on edge for this same-directory pair (spec Non-goals)");

  store.close();
  rmSync(root, { recursive: true, force: true });
});

test("a Helm chart's Secret name and its Deployment's secretKeyRef.name are the identical template text -- resolves via template-text equality", () => {
  const root = mkdtempSync(join(tmpdir(), "hunch-idx-k8sref-tpl-"));
  mkdirSync(join(root, "templates"), { recursive: true });
  writeFileSync(join(root, "Chart.yaml"), `apiVersion: v2\nname: mychart\nversion: 0.1.0\n`);
  writeFileSync(join(root, "templates/secret.yaml"), `
apiVersion: v1
kind: Secret
metadata:
  name: {{ include "mychart.secretName" . }}
`);
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
        env:
          - name: X
            valueFrom:
              secretKeyRef:
                name: {{ include "mychart.secretName" . }}
`);
  const store = new HunchStore(hunchPaths(root));
  store.json.ensureDirs();
  indexRepo(store, root, { churn: false });
  store.reindex();

  const syms = store.json.loadAll("symbols");
  const secret = syms.find((s) => s.kind === "variable" && s.file === "templates/secret.yaml" && s.name.startsWith("Secret/"));
  const deployment = syms.find((s) => s.name === "Deployment/my-app");
  assert.ok(secret && deployment, "both resource symbols indexed");

  const edges = store.json.loadAll("edges");
  assert.ok(edges.some((e) => e.from === deployment!.id && e.to === secret!.id && e.type === "references"), "identical template-expression text resolves to a references edge");

  store.close();
  rmSync(root, { recursive: true, force: true });
});

test("two ConfigMaps with the same name in the same chart scope are ambiguous -- no edge is fabricated", () => {
  const root = mkdtempSync(join(tmpdir(), "hunch-idx-k8sref-ambig-"));
  mkdirSync(join(root, "templates"), { recursive: true });
  writeFileSync(join(root, "Chart.yaml"), `apiVersion: v2\nname: mychart\nversion: 0.1.0\n`);
  writeFileSync(join(root, "templates/configmap-a.yaml"), `apiVersion: v1\nkind: ConfigMap\nmetadata:\n  name: shared-name\n`);
  writeFileSync(join(root, "templates/configmap-b.yaml"), `apiVersion: v1\nkind: ConfigMap\nmetadata:\n  name: shared-name\n`);
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
            name: shared-name
`);
  const store = new HunchStore(hunchPaths(root));
  store.json.ensureDirs();
  indexRepo(store, root, { churn: false });
  store.reindex();

  const edges = store.json.loadAll("edges");
  const syms = store.json.loadAll("symbols");
  const deployment = syms.find((s) => s.name === "Deployment/my-app");
  assert.equal(edges.filter((e) => e.type === "references" && e.from === deployment!.id).length, 0, "ambiguous (2 candidates) match produces no edge");

  store.close();
  rmSync(root, { recursive: true, force: true });
});

test("a raw manifest (no Chart.yaml) resolves a ConfigMap reference WITHIN its own file but not to an unrelated file", () => {
  const root = mkdtempSync(join(tmpdir(), "hunch-idx-k8sref-raw-"));
  mkdirSync(join(root, "manifests"), { recursive: true });
  writeFileSync(join(root, "manifests/bundle.yaml"), `
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
---
apiVersion: v1
kind: ConfigMap
metadata:
  name: my-config
`);
  // Deliberately the SAME name as bundle.yaml's own ConfigMap (not a
  // different name) -- this is what actually exercises file-scope isolation.
  // A different name would never match on any code path, silently passing
  // regardless of whether isolation works at all.
  writeFileSync(join(root, "manifests/unrelated.yaml"), `apiVersion: v1\nkind: ConfigMap\nmetadata:\n  name: my-config\n`);
  const store = new HunchStore(hunchPaths(root));
  store.json.ensureDirs();
  indexRepo(store, root, { churn: false });
  store.reindex();

  const syms = store.json.loadAll("symbols");
  const deployment = syms.find((s) => s.name === "Deployment/my-app");
  const ownConfigMap = syms.find((s) => s.name === "ConfigMap/my-config" && s.file === "manifests/bundle.yaml");
  const unrelatedConfigMap = syms.find((s) => s.name === "ConfigMap/my-config" && s.file === "manifests/unrelated.yaml");
  assert.ok(deployment && ownConfigMap && unrelatedConfigMap, "all three resource symbols indexed, including the same-named unrelated one");

  const edges = store.json.loadAll("edges");
  assert.ok(edges.some((e) => e.from === deployment!.id && e.to === ownConfigMap!.id && e.type === "references"), "own-file (no chart root) resolution still works");
  assert.equal(edges.some((e) => e.from === deployment!.id && e.to === unrelatedConfigMap!.id), false, "the same-named ConfigMap in a different, unrelated file (no shared chart scope) is never targeted");

  store.close();
  rmSync(root, { recursive: true, force: true });
});

test("a Service's literal selector resolves to a workload whose pod-template labels are a superset", () => {
  const root = mkdtempSync(join(tmpdir(), "hunch-idx-k8ssel-"));
  mkdirSync(join(root, "manifests"), { recursive: true });
  writeFileSync(join(root, "Chart.yaml"), `apiVersion: v2\nname: mychart\nversion: 0.1.0\n`);
  writeFileSync(join(root, "manifests/service.yaml"), `
apiVersion: v1
kind: Service
metadata:
  name: my-service
spec:
  selector:
    app: my-app
`);
  writeFileSync(join(root, "manifests/deployment.yaml"), `
apiVersion: apps/v1
kind: Deployment
metadata:
  name: my-app
spec:
  template:
    metadata:
      labels:
        app: my-app
        tier: web
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
  const deployment = syms.find((s) => s.name === "Deployment/my-app");
  assert.ok(service && deployment);

  const edges = store.json.loadAll("edges");
  assert.ok(edges.some((e) => e.from === service!.id && e.to === deployment!.id && e.type === "references"), "Service selector subset-matches the Deployment's pod-template labels");

  store.close();
  rmSync(root, { recursive: true, force: true });
});

test("a Service's selector that is NOT a subset of a workload's labels produces no edge to it", () => {
  const root = mkdtempSync(join(tmpdir(), "hunch-idx-k8ssel-nomatch-"));
  mkdirSync(join(root, "manifests"), { recursive: true });
  writeFileSync(join(root, "Chart.yaml"), `apiVersion: v2\nname: mychart\nversion: 0.1.0\n`);
  writeFileSync(join(root, "manifests/service.yaml"), `
apiVersion: v1
kind: Service
metadata:
  name: my-service
spec:
  selector:
    app: other-app
`);
  writeFileSync(join(root, "manifests/deployment.yaml"), `
apiVersion: apps/v1
kind: Deployment
metadata:
  name: my-app
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
  const edges = store.json.loadAll("edges");
  assert.equal(edges.filter((e) => e.from === service!.id && e.type === "references").length, 0, "non-matching selector produces no edge");

  store.close();
  rmSync(root, { recursive: true, force: true });
});

test("a Service's selector with ONE same-line templated key among literal siblings produces no edge, not a false-positive on the literal keys alone (issue #82 review)", () => {
  const root = mkdtempSync(join(tmpdir(), "hunch-idx-k8ssel-partial-template-"));
  mkdirSync(join(root, "manifests"), { recursive: true });
  writeFileSync(join(root, "Chart.yaml"), `apiVersion: v2\nname: mychart\nversion: 0.1.0\n`);
  writeFileSync(join(root, "manifests/service.yaml"), `
apiVersion: v1
kind: Service
metadata:
  name: my-service
spec:
  selector:
    app: {{ .Values.name }}
    tier: web
`);
  writeFileSync(join(root, "manifests/deployment.yaml"), `
apiVersion: apps/v1
kind: Deployment
metadata:
  name: my-app
spec:
  template:
    metadata:
      labels:
        tier: web
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
  const edges = store.json.loadAll("edges");
  assert.equal(
    edges.filter((e) => e.from === service!.id && e.type === "references").length,
    0,
    "a partially-templated selector must resolve to no map at all, not a subset map that happens to match on the untemplated keys",
  );

  store.close();
  rmSync(root, { recursive: true, force: true });
});

test("a Service's selector matching TWO workloads' labels produces edges to BOTH -- fan-out is intentional here, unlike Phase 1's ambiguity guard", () => {
  const root = mkdtempSync(join(tmpdir(), "hunch-idx-k8ssel-fanout-"));
  mkdirSync(join(root, "manifests"), { recursive: true });
  writeFileSync(join(root, "Chart.yaml"), `apiVersion: v2\nname: mychart\nversion: 0.1.0\n`);
  writeFileSync(join(root, "manifests/service.yaml"), `
apiVersion: v1
kind: Service
metadata:
  name: my-service
spec:
  selector:
    app: my-app
`);
  writeFileSync(join(root, "manifests/deployment-blue.yaml"), `
apiVersion: apps/v1
kind: Deployment
metadata:
  name: my-app-blue
spec:
  template:
    metadata:
      labels:
        app: my-app
        track: blue
    spec:
      containers:
      - name: app
`);
  writeFileSync(join(root, "manifests/deployment-green.yaml"), `
apiVersion: apps/v1
kind: Deployment
metadata:
  name: my-app-green
spec:
  template:
    metadata:
      labels:
        app: my-app
        track: green
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
  const blue = syms.find((s) => s.name === "Deployment/my-app-blue");
  const green = syms.find((s) => s.name === "Deployment/my-app-green");
  assert.ok(service && blue && green);

  const edges = store.json.loadAll("edges");
  assert.ok(edges.some((e) => e.from === service!.id && e.to === blue!.id && e.type === "references"), "matches the blue deployment");
  assert.ok(edges.some((e) => e.from === service!.id && e.to === green!.id && e.type === "references"), "AND matches the green deployment -- a real blue/green pattern, not an error to guard against");

  store.close();
  rmSync(root, { recursive: true, force: true });
});

test("a dotted app.kubernetes.io/instance label that genuinely differs between Service selector and workload labels does NOT produce a references edge (regression: a false-positive edge on real, untemplated YAML)", () => {
  const root = mkdtempSync(join(tmpdir(), "hunch-idx-k8ssel-dotted-"));
  mkdirSync(join(root, "manifests"), { recursive: true });
  writeFileSync(join(root, "Chart.yaml"), `apiVersion: v2\nname: mychart\nversion: 0.1.0\n`);
  writeFileSync(join(root, "manifests/service.yaml"), `
apiVersion: v1
kind: Service
metadata:
  name: my-service
spec:
  selector:
    app: my-app
    app.kubernetes.io/instance: prod
`);
  writeFileSync(join(root, "manifests/deployment.yaml"), `
apiVersion: apps/v1
kind: Deployment
metadata:
  name: my-app
spec:
  template:
    metadata:
      labels:
        app: my-app
        app.kubernetes.io/instance: staging
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
  assert.ok(service);
  const edges = store.json.loadAll("edges");
  assert.equal(edges.filter((e) => e.from === service!.id && e.type === "references").length, 0,
    "the app label matches but app.kubernetes.io/instance genuinely differs (prod vs staging) -- must not read as a match");

  store.close();
  rmSync(root, { recursive: true, force: true });
});

test("a quoted selector key the scanner can't parse produces NO edge, not an over-permissive false-positive one (regression)", () => {
  const root = mkdtempSync(join(tmpdir(), "hunch-idx-k8ssel-quoted-"));
  mkdirSync(join(root, "manifests"), { recursive: true });
  writeFileSync(join(root, "Chart.yaml"), `apiVersion: v2\nname: mychart\nversion: 0.1.0\n`);
  // svc-a's selector genuinely requires BOTH name=mychart AND instance=rel-a.
  // The quoted key must not be silently dropped -- if it were, the selector
  // would collapse to {instance: rel-a}, which dep-other-chart satisfies even
  // though its own name label is a completely different chart's.
  writeFileSync(join(root, "manifests/service.yaml"), `
apiVersion: v1
kind: Service
metadata:
  name: svc-a
spec:
  selector:
    "app.kubernetes.io/name": mychart
    app.kubernetes.io/instance: rel-a
`);
  writeFileSync(join(root, "manifests/deployment.yaml"), `
apiVersion: apps/v1
kind: Deployment
metadata:
  name: dep-other-chart
spec:
  template:
    metadata:
      labels:
        app.kubernetes.io/name: OTHERCHART
        app.kubernetes.io/instance: rel-a
    spec:
      containers:
      - name: app
`);
  const store = new HunchStore(hunchPaths(root));
  store.json.ensureDirs();
  indexRepo(store, root, { churn: false });
  store.reindex();

  const syms = store.json.loadAll("symbols");
  const service = syms.find((s) => s.name === "Service/svc-a");
  assert.ok(service);
  const edges = store.json.loadAll("edges");
  assert.equal(edges.filter((e) => e.from === service!.id && e.type === "references").length, 0,
    "the quoted app.kubernetes.io/name key must taint the whole selector, not silently vanish and over-match on the remainder");

  store.close();
  rmSync(root, { recursive: true, force: true });
});

test("a column-0 template conditional inside a Service's selector does not produce a false-positive edge to the wrong workload (regression)", () => {
  const root = mkdtempSync(join(tmpdir(), "hunch-idx-k8ssel-col0-"));
  mkdirSync(join(root, "manifests"), { recursive: true });
  writeFileSync(join(root, "Chart.yaml"), `apiVersion: v2\nname: mychart\nversion: 0.1.0\n`);
  // The selector's REAL intent is app=my-app AND track=stable, but the
  // second line lives inside a column-0 {{- if }} -- the idiomatic way Helm
  // charts guard an optional selector constraint. If the action's own column
  // were (wrongly) treated as structure, this would either drop the
  // conditional line's taint entirely or attach it to the wrong ancestor,
  // leaving app=my-app as a fully literal (and over-permissive) selector.
  writeFileSync(join(root, "manifests/service.yaml"), `
apiVersion: v1
kind: Service
metadata:
  name: my-svc
spec:
  selector:
    app: my-app
{{- if .Values.stableOnly }}
    track: stable
{{- end }}
`);
  writeFileSync(join(root, "manifests/deployment-canary.yaml"), `
apiVersion: apps/v1
kind: Deployment
metadata:
  name: my-app-canary
spec:
  template:
    metadata:
      labels:
        app: my-app
        track: canary
    spec:
      containers:
      - name: app
`);
  const store = new HunchStore(hunchPaths(root));
  store.json.ensureDirs();
  indexRepo(store, root, { churn: false });
  store.reindex();

  const syms = store.json.loadAll("symbols");
  const service = syms.find((s) => s.name === "Service/my-svc");
  assert.ok(service);
  const edges = store.json.loadAll("edges");
  assert.equal(edges.filter((e) => e.from === service!.id && e.type === "references").length, 0,
    "the column-0 conditional must taint the whole selector, not leave app=my-app as a false-positive match against the canary track");

  store.close();
  rmSync(root, { recursive: true, force: true });
});

test("a multi-line flow-style selector does not produce a false-positive edge from a dropped key (regression)", () => {
  const root = mkdtempSync(join(tmpdir(), "hunch-idx-k8ssel-flow-"));
  mkdirSync(join(root, "manifests"), { recursive: true });
  writeFileSync(join(root, "Chart.yaml"), `apiVersion: v2\nname: mychart\nversion: 0.1.0\n`);
  // The selector's real intent is app=web-frontend AND tier=web. Written as a
  // multi-line flow mapping, `app` sits on the SAME line as `selector:` --
  // invisible to a line-oriented scan unless that key's whole container is
  // marked unresolved. A workload with a DIFFERENT app but the same tier
  // must never match.
  writeFileSync(join(root, "manifests/service.yaml"), `
apiVersion: v1
kind: Service
metadata:
  name: web-svc
spec:
  selector: {app: web-frontend,
    tier: web
  }
`);
  writeFileSync(join(root, "manifests/api.yaml"), `
apiVersion: apps/v1
kind: Deployment
metadata:
  name: api-backend
spec:
  template:
    metadata:
      labels:
        app: api-backend
        tier: web
    spec:
      containers:
      - name: app
`);
  const store = new HunchStore(hunchPaths(root));
  store.json.ensureDirs();
  indexRepo(store, root, { churn: false });
  store.reindex();

  const syms = store.json.loadAll("symbols");
  const service = syms.find((s) => s.name === "Service/web-svc");
  assert.ok(service);
  const edges = store.json.loadAll("edges");
  assert.equal(edges.filter((e) => e.from === service!.id && e.type === "references").length, 0,
    "the multi-line flow selector's dropped app key must taint the whole map, not leave tier=web as a false-positive match against a different app");

  store.close();
  rmSync(root, { recursive: true, force: true });
});

test("two resources whose names are both block-scalar headers do not collide into a false-positive edge (regression)", () => {
  const root = mkdtempSync(join(tmpdir(), "hunch-idx-k8sref-blockscalar-"));
  mkdirSync(join(root, "manifests"), { recursive: true });
  writeFileSync(join(root, "Chart.yaml"), `apiVersion: v2\nname: mychart\nversion: 0.1.0\n`);
  // Both this ConfigMap's name and the Deployment's reference to a
  // COMPLETELY DIFFERENT ConfigMap use a block-scalar header -- if the
  // header token itself were read as the value, both would collapse to the
  // same garbage key ("|-") and collide, even though nothing about them
  // actually matches.
  writeFileSync(join(root, "manifests/configmap.yaml"), `
apiVersion: v1
kind: ConfigMap
metadata:
  name: |-
    real-config
`);
  writeFileSync(join(root, "manifests/deployment.yaml"), `
apiVersion: apps/v1
kind: Deployment
metadata:
  name: web
spec:
  template:
    spec:
      containers:
      - name: app
        envFrom:
        - configMapRef:
            name: |-
              totally-different-config
`);
  const store = new HunchStore(hunchPaths(root));
  store.json.ensureDirs();
  indexRepo(store, root, { churn: false });
  store.reindex();

  const syms = store.json.loadAll("symbols");
  // Neither block-scalar-named resource should produce a real symbol at all
  // (unidentifiable), let alone a symbol literally named "ConfigMap/|-".
  assert.equal(syms.some((s) => s.name.includes("|-")), false, "no symbol should be literally named using the block-scalar header token");
  const deployment = syms.find((s) => s.name === "Deployment/web");
  assert.ok(deployment);
  const edges = store.json.loadAll("edges");
  assert.equal(edges.filter((e) => e.from === deployment!.id && e.type === "references").length, 0,
    "two unrelated block-scalar-named resources must not collide into a references edge");

  store.close();
  rmSync(root, { recursive: true, force: true });
});

test("a Helm-templated block-form selector/labels pair produces no Phase 2 edge and does not crash indexing", () => {
  const root = mkdtempSync(join(tmpdir(), "hunch-idx-k8ssel-tpl-"));
  mkdirSync(join(root, "templates"), { recursive: true });
  writeFileSync(join(root, "Chart.yaml"), `apiVersion: v2\nname: mychart\nversion: 0.1.0\n`);
  writeFileSync(join(root, "templates/service.yaml"), `
apiVersion: v1
kind: Service
metadata:
  name: my-service
spec:
  selector:
    {{- include "mychart.selectorLabels" . | nindent 4 }}
`);
  writeFileSync(join(root, "templates/deployment.yaml"), `
apiVersion: apps/v1
kind: Deployment
metadata:
  name: my-app
spec:
  template:
    metadata:
      labels:
        {{- include "mychart.labels" . | nindent 8 }}
    spec:
      containers:
      - name: app
`);
  const store = new HunchStore(hunchPaths(root));
  store.json.ensureDirs();
  const res = indexRepo(store, root, { churn: false }); // must not throw
  store.reindex();

  const syms = store.json.loadAll("symbols");
  const service = syms.find((s) => s.name === "Service/my-service");
  assert.ok(service, "Service resource still indexed even though its selector is unresolved");
  const edges = store.json.loadAll("edges");
  assert.equal(edges.filter((e) => e.from === service!.id && e.type === "references").length, 0, "templated block-form selector/labels: documented gap, not a guess");
  assert.ok(res, "indexRepo completes without throwing");

  store.close();
  rmSync(root, { recursive: true, force: true });
});

test("a chart-wide Helm define does not fabricate a cross-language edge into a same-named TS symbol (finding #1)", () => {
  const root = mkdtempSync(join(tmpdir(), "hunch-idx-helm-nofab-"));
  mkdirSync(join(root, "templates"), { recursive: true });
  mkdirSync(join(root, "src"), { recursive: true });
  writeFileSync(join(root, "Chart.yaml"), `apiVersion: v2\nname: mychart\nversion: 0.1.0\n`);
  writeFileSync(join(root, "templates/_helpers.tpl"), `
{{- define "labels" -}}
app: x
{{- end -}}
`);
  writeFileSync(join(root, "src/app.ts"), `export function run() { return labels(); }\n`);

  const store = new HunchStore(hunchPaths(root));
  store.json.ensureDirs();
  indexRepo(store, root, { churn: false });
  store.reindex();

  const syms = store.json.loadAll("symbols");
  const helmLabels = syms.find((s) => s.name === "labels" && s.file === "templates/_helpers.tpl" && s.kind === "variable");
  const run = syms.find((s) => s.name === "run" && s.file === "src/app.ts");
  assert.ok(helmLabels, "Helm labels define indexed as a symbol");
  assert.ok(run, "TS run function indexed as a symbol");

  const edges = store.json.loadAll("edges");
  assert.ok(
    !edges.some((e) => e.from === run!.id && e.to === helmLabels!.id),
    "a TS function calling an unrelated same-named identifier must not get an edge into an unrelated chart-wide Helm define",
  );

  store.close();
  rmSync(root, { recursive: true, force: true });
});

test("chart-wide widening for YAML files must not silently drop a genuine cross-file TS import edge (finding #1)", () => {
  const root = mkdtempSync(join(tmpdir(), "hunch-idx-helm-noloss-"));
  mkdirSync(join(root, "src"), { recursive: true });
  writeFileSync(join(root, "Chart.yaml"), `apiVersion: v2\nname: mychart\nversion: 0.1.0\n`);
  writeFileSync(join(root, "src/helper.ts"), `export function labels() { return "x"; }\n`);
  writeFileSync(join(root, "src/app.ts"), `import { labels } from "./helper.js";\nexport function run() { return labels(); }\n`);
  // An unrelated chart-scoped YAML anchor sharing the same name as the real
  // imported TS symbol — the spurious candidate that, pre-fix, made resolveName's
  // "more than one candidate in scope -> null, don't guess" rule fire on a
  // resolution scope it was never supposed to see.
  writeFileSync(join(root, "values.yaml"), `commonLabels: &labels\n  app: x\n`);

  const store = new HunchStore(hunchPaths(root));
  store.json.ensureDirs();
  indexRepo(store, root, { churn: false });
  store.reindex();

  const syms = store.json.loadAll("symbols");
  const run = syms.find((s) => s.name === "run" && s.file === "src/app.ts");
  const helperLabels = syms.find((s) => s.name === "labels" && s.file === "src/helper.ts");
  assert.ok(run && helperLabels, "both TS symbols indexed");

  const edges = store.json.loadAll("edges");
  const edge = edges.find((e) => e.from === run!.id && e.type === "calls");
  assert.ok(edge, "run -> labels call edge must exist");
  assert.equal(
    edge!.to,
    helperLabels!.id,
    "the genuine cross-file TS import-based call edge must resolve to helper.ts's labels(), not be lost to a spurious chart-wide candidate",
  );

  store.close();
  rmSync(root, { recursive: true, force: true });
});

test("a Helm define at byte 0 (no leading newline) does not collide with the YAML whole-file fallback symbol, and a top-level include outside the define still resolves (regression: startByte-keyed attribution)", () => {
  const root = mkdtempSync(join(tmpdir(), "hunch-idx-helm-byte0-"));
  mkdirSync(join(root, "templates"), { recursive: true });
  writeFileSync(join(root, "Chart.yaml"), `apiVersion: v2\nname: mychart\nversion: 0.1.0\n`);
  // No leading newline: the define block is the literal first bytes of the
  // file, so both it and YAML's synthetic whole-file fallback symbol start at
  // byte 0. The trailing include sits OUTSIDE the define, at the top level.
  writeFileSync(
    join(root, "templates/_helpers.tpl"),
    `{{- define "c.name" -}}\nfoo\n{{- end -}}\n{{ include "c.name" . }}\n`,
  );
  const store = new HunchStore(hunchPaths(root));
  store.json.ensureDirs();
  indexRepo(store, root, { churn: false });
  store.reindex();

  const syms = store.json.loadAll("symbols").filter((s) => s.file === "templates/_helpers.tpl");
  const fileSym = syms.find((s) => s.kind === "file");
  const defineSym = syms.find((s) => s.kind === "variable" && s.name === "c.name");
  assert.ok(fileSym, "the whole-file fallback symbol still exists distinctly");
  assert.ok(defineSym, "the c.name define block still exists as its own distinct symbol");
  assert.notEqual(fileSym!.id, defineSym!.id, "the two byte-0 symbols must not collapse into one");

  const edges = store.json.loadAll("edges");
  const edge = edges.find((e) => e.to === defineSym!.id && e.type === "references");
  assert.ok(edge, "the top-level include (outside the define) must produce a references edge into c.name");
  assert.equal(
    edge!.from,
    fileSym!.id,
    "the include is outside the define block, so its caller must be the whole-file fallback symbol, not the define itself",
  );

  store.close();
  rmSync(root, { recursive: true, force: true });
});

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
      rmSync(root, { recursive: true, force: true });
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
  rmSync(root, { recursive: true, force: true });
});

test("root-level indexed files get exact-match component paths, not a match-everything glob (issue #34)", (t) => {
  const { store, cleanup } = indexedFixtureStore(seedRootLevelFileFixture);
  t.after(cleanup);

  const comps = store.json.loadAll("components");
  const rootComp = comps.find((c) => c.name === ".");
  assert.ok(rootComp, "root-level files get a '.' component");
  assert.deepEqual(
    rootComp.paths,
    ["config.ts", "settings.ts"],
    "root component paths are exact files, not a './**' glob",
  );

  // every exact-match path must match its own root file only — never every file in the repo.
  for (const p of rootComp.paths) {
    assert.ok(pathMatchesGlob("config.ts", p) === (p === "config.ts"));
    assert.ok(pathMatchesGlob("settings.ts", p) === (p === "settings.ts"));
    assert.ok(!pathMatchesGlob("src/auth/session.ts", p));
  }
});

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
  rmSync(root, { recursive: true, force: true });
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
  rmSync(root, { recursive: true, force: true });
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
  rmSync(root, { recursive: true, force: true });
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
  rmSync(root, { recursive: true, force: true });
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
  rmSync(root, { recursive: true, force: true });
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
  rmSync(root, { recursive: true, force: true });
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
  rmSync(root, { recursive: true, force: true });
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
  rmSync(root, { recursive: true, force: true });
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
  rmSync(root, { recursive: true, force: true });
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
  rmSync(root, { recursive: true, force: true });
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
  rmSync(root, { recursive: true, force: true });
});
