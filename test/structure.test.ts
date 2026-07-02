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
