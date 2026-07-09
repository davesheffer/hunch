import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from "node:fs";
import { execFileSync } from "node:child_process";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { hunchPaths } from "../src/core/paths.js";
import { HunchStore } from "../src/store/hunchStore.js";
import { indexRepo } from "../src/extractors/indexer.js";

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
