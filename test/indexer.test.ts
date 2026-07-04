import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from "node:fs";
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
