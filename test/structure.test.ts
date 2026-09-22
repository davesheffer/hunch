/**
 * hunch structure — graph-served orientation (the anti-grep). Resolution order:
 * repo map / directory / file outline / exact symbol; deterministic, read-only.
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { hunchPaths } from "../src/core/paths.js";
import { HunchStore } from "../src/store/hunchStore.js";
import { indexRepo } from "../src/extractors/indexer.js";
import { formatStructure } from "../src/core/format.js";

// jwt.ts ← session.ts ← charge.ts : a 2-hop dependency chain across 2 dirs.
function indexed() {
  const root = mkdtempSync(join(tmpdir(), "hunch-structure-"));
  mkdirSync(join(root, "src/auth"), { recursive: true });
  mkdirSync(join(root, "src/billing"), { recursive: true });
  writeFileSync(join(root, "src/auth/session.ts"), `import { jwtDecode } from "./jwt.js";\nexport function verifySession(t){ return jwtDecode(t); }\n`);
  writeFileSync(join(root, "src/auth/jwt.ts"), `export function jwtDecode(t){ return t; }\n`);
  writeFileSync(join(root, "src/billing/charge.ts"), `import { verifySession } from "../auth/session.js";\nexport function charge(t){ return verifySession(t); }\n`);
  const store = new HunchStore(hunchPaths(root));
  store.json.ensureDirs();
  indexRepo(store, root, { churn: false });
  store.reindex();
  return { store, cleanup: () => { store.close(); rmSync(root, { recursive: true, force: true }); } };
}

test("structure(): repo map lists directories by symbol weight", (t) => {
  const { store, cleanup } = indexed();
  t.after(cleanup);
  const v = store.structure();
  assert.equal(v.kind, "repo");
  if (v.kind !== "repo") return;
  const dirs = v.dirs.map((d) => d.dir);
  assert.ok(dirs.includes("src/auth"), "src/auth listed");
  assert.ok(dirs.includes("src/billing"), "src/billing listed");
  assert.match(formatStructure(v), /src\/auth/);
});

test("structure(dir): files under the prefix with their symbols", (t) => {
  const { store, cleanup } = indexed();
  t.after(cleanup);
  const v = store.structure("src/auth");
  assert.equal(v.kind, "dir");
  if (v.kind !== "dir") return;
  assert.equal(v.files.length, 2);
  const names = v.files.flatMap((f) => f.symbols.map((s) => s.name));
  assert.ok(names.includes("verifySession") && names.includes("jwtDecode"));
});

test("structure(file): outline with callers from the edge graph", (t) => {
  const { store, cleanup } = indexed();
  t.after(cleanup);
  const v = store.structure("src/auth/jwt.ts");
  assert.equal(v.kind, "file");
  if (v.kind !== "file") return;
  const jwt = v.symbols.find((s) => s.name === "jwtDecode");
  assert.ok(jwt, "jwtDecode in outline");
  assert.ok(jwt!.callers.some((c) => c.includes("verifySession")), "caller resolved via edges");
  // suffix resolution too
  assert.equal(store.structure("auth/jwt.ts").kind, "file");
});

test("structure(symbol): exact definition site with one-hop neighbors; unknown → none", (t) => {
  const { store, cleanup } = indexed();
  t.after(cleanup);
  const v = store.structure("verifySession");
  assert.equal(v.kind, "symbol");
  if (v.kind !== "symbol") return;
  assert.equal(v.matches.length, 1);
  assert.match(v.matches[0]!.file, /session\.ts$/);
  assert.ok(v.matches[0]!.callers.some((c) => c.includes("charge")), "caller side");
  assert.ok(v.matches[0]!.callees.some((c) => c.includes("jwtDecode")), "callee side");
  assert.equal(store.structure("no_such_symbol_xyz").kind, "none");
});

/** A comment-only root `empty.ts` (zero tree-sitter symbols, no covering
 *  component) beside `a/empty.ts` which HAS a function — the shape that fell
 *  through structure()'s unique-suffix fallback and served the nested file's
 *  outline for the root target (issue #334). Plus a root `index.ts` for the
 *  absolute-target case (issue #335). */
function indexedWithEmptyRootFile() {
  const root = mkdtempSync(join(tmpdir(), "hunch-structure-real-"));
  mkdirSync(join(root, "a"), { recursive: true });
  writeFileSync(join(root, "empty.ts"), "// only a comment — no symbols at all\n");
  writeFileSync(join(root, "a/empty.ts"), `export function nestedEmpty(){ return 1; }\n`);
  writeFileSync(join(root, "index.ts"), `export function rootIndex(){ return 1; }\n`);
  const store = new HunchStore(hunchPaths(root));
  store.json.ensureDirs();
  indexRepo(store, root, { churn: false });
  store.reindex();
  return { store, root, cleanup: () => { store.close(); rmSync(root, { recursive: true, force: true }); } };
}

test("structure(): an absolute in-repo path resolves identically to its repo-relative form (issue #335)", (t) => {
  const { store, root, cleanup } = indexedWithEmptyRootFile();
  t.after(cleanup);
  const rel = store.structure("index.ts");
  const abs = store.structure(join(root, "index.ts"));
  assert.equal(rel.kind, "file", "the relative form resolves to a file outline");
  assert.deepEqual(abs, rel, "the absolute form must not fall through to kind:none");
});

test("structure(): a real root file with zero symbols must not serve a same-basename nested file's outline (issue #334)", (t) => {
  const { store, cleanup } = indexedWithEmptyRootFile();
  t.after(cleanup);
  // "empty.ts" is a REAL working-tree file the index cannot see (no symbols, no
  // covering component), so the unique-suffix fallback would have resolved it to
  // "a/empty.ts". It must not.
  const v = store.structure("empty.ts");
  assert.notEqual(v.kind === "file" ? v.file : null, "a/empty.ts", "the root target must never resolve to the nested file");
  // The nested file still resolves on its own exact path.
  const nested = store.structure("a/empty.ts");
  assert.equal(nested.kind, "file");
  if (nested.kind === "file") assert.ok(nested.symbols.some((s) => s.name === "nestedEmpty"));
});

test("structure(): a real symbol-less file reports kind:none with realFile, and renders as a real file rather than an unknown path (issue #334)", (t) => {
  const { store, cleanup } = indexedWithEmptyRootFile();
  t.after(cleanup);
  const v = store.structure("empty.ts");
  assert.equal(v.kind, "none", "no symbols to outline");
  assert.equal(v.kind === "none" ? v.realFile : undefined, true, "but the file itself is real");
  const rendered = formatStructure(v);
  assert.match(rendered, /real file/, "the message must say so");
  assert.doesNotMatch(rendered, /not a known file/, "and must never claim a file we just stat'd doesn't exist");
  // An actually-unknown target keeps the original message.
  assert.match(formatStructure(store.structure("no_such_path_xyz.ts")), /not a known file/);
});

/** A component `paths` glob covers a path no file actually occupies: with symbols
 *  in `test/a.test.ts` and `src/test/util.ts`, the derived `test/**` component
 *  makes `test/util.ts` look "known" although nothing is there. Gating the suffix
 *  tier on glob coverage rather than on-disk existence killed the resolution. */
function indexedWithGlobPhantom() {
  const root = mkdtempSync(join(tmpdir(), "hunch-structure-phantom-"));
  mkdirSync(join(root, "test"), { recursive: true });
  mkdirSync(join(root, "src/test"), { recursive: true });
  writeFileSync(join(root, "test/a.test.ts"), `export function aTest(){ return 1; }\n`);
  writeFileSync(join(root, "src/test/util.ts"), `export function util(){ return 2; }\n`);
  const store = new HunchStore(hunchPaths(root));
  store.json.ensureDirs();
  indexRepo(store, root, { churn: false });
  store.reindex();
  return { store, root, cleanup: () => { store.close(); rmSync(root, { recursive: true, force: true }); } };
}

test("structure(): a glob-covered path that no file occupies still suffix-resolves — coverage is not existence", (t) => {
  const { store, cleanup } = indexedWithGlobPhantom();
  t.after(cleanup);
  assert.equal(store.isKnownPath("test/util.ts"), true, "the test/** component covers it, so isKnownPath says 'known'");
  const v = store.structure("test/util.ts");
  assert.equal(v.kind, "file", "but nothing is on disk there, so the suffix tier must still run");
  assert.equal(v.kind === "file" ? v.file : null, "src/test/util.ts");
});
