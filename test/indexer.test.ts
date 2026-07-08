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
    // call edge — PLUS a cross-component import (billing) that is never called,
    // so Python cross-file import resolution (out of scope, issue #5) genuinely
    // gets exercised rather than trivially having nothing to resolve.
    `from .jwt import decode_token\nfrom ..billing.charge import charge\n\ndef verify_session(t):\n    return decode_token(t)\n`,
  );
  writeFileSync(join(root, "src/auth/jwt.py"), `def decode_token(t):\n    return t\n`);
  writeFileSync(
    join(root, "src/billing/charge.py"),
    `def charge(t):\n    return t\n`,
  );
  return root;
}

test("indexRepo builds symbols and same-file call edges for a Python repo", () => {
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
  const comps = store.json.loadAll("components").map((c) => c.name).sort();
  assert.deepEqual(comps, ["Auth", "Billing"]);

  // NO depends_on edge from Python's `from ..billing.charge import charge` even
  // though it genuinely crosses the Auth/Billing component boundary — cross-file
  // Python import resolution is explicitly out of scope (issue #5), so this
  // assertion actually probes that no fabricated edge is produced rather than
  // passing vacuously because nothing ever referenced billing.
  const edges = store.json.loadAll("edges");
  assert.ok(
    !edges.some((e) => e.type === "depends_on" && (e.from.includes("billing") || e.to.includes("billing"))),
    "no fabricated cross-component depends_on edge for Python imports",
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
