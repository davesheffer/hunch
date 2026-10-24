import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { tempStore, prov, mkSymbol } from "./helpers.js";
import { resolveSymbols, resolveFiles } from "../src/mcp/server.js";

function seed() {
  const ctx = tempStore();
  ctx.store.json.replaceAll("symbols", [
    mkSymbol("sym_db", "src/db.ts", "dbConnect"),
    mkSymbol("sym_mongo", "src/mongodb.ts", "mongoConnect"),
    mkSymbol("sym_datastore_db", "src/datastore/db.ts", "datastoreConnect"),
    mkSymbol("sym_store_db", "src/store/db.ts", "storeConnect"),
    mkSymbol("sym_auth", "src/auth/session.ts", "verifySession"),
  ] as never);
  ctx.store.json.put("constraints", {
    id: "con_1", type: "security", statement: "Sessions must be verified", scope: ["src/auth/**"],
    severity: "blocking", enforcement: "advisory_v1", match: null, rationale: "auth", provenance: prov(1),
    created_at: "2026-01-01T00:00:00Z", updated_at: "2026-01-01T00:00:00Z",
  } as never);
  ctx.store.reindex();
  return ctx;
}

const ids = (store: ReturnType<typeof seed>["store"], target: string) => resolveSymbols(store, target).map((s) => s.id);

test("resolveSymbols: a bare basename matches whole path segments only (issue #300)", () => {
  const { store, cleanup } = seed();
  assert.deepEqual(ids(store, "db.ts").sort(), ["sym_datastore_db", "sym_db", "sym_store_db"]);
  assert.ok(!ids(store, "db.ts").includes("sym_mongo"), "mongodb.ts is not a db.ts");
  assert.deepEqual(ids(store, "store/db.ts"), ["sym_store_db"]);
  assert.deepEqual(ids(store, "src/db.ts"), ["sym_db"]);
  cleanup();
});

test("resolveSymbols/resolveFiles: an absolute target is rewritten to its repo-relative form (issue #296)", () => {
  const { store, root, cleanup } = seed();
  const abs = join(root, "src/auth/session.ts");
  assert.deepEqual(ids(store, abs), ["sym_auth"]);
  assert.deepEqual(resolveFiles(store, abs), ["src/auth/session.ts"]);
  cleanup();
});

test("resolveSymbols: the absolute-path rewrite is what discriminates (#296/#299)", () => {
  const { store, root, cleanup } = seed();
  // Without the rewrite, the suffix tier on the raw absolute path would also match the
  // unrelated root-level session.ts, since both end in a "session.ts" segment.
  store.json.put("symbols", mkSymbol("sym_root_session", "session.ts", "rootSession") as never);
  assert.deepEqual(ids(store, join(root, "src/auth/session.ts")), ["sym_auth"]);
  cleanup();
});

test("resolveSymbols: an exact file match beats the suffix tier (#299)", () => {
  const { store, cleanup } = seed();
  store.json.put("symbols", mkSymbol("sym_root_index", "index.ts", "rootIndex") as never);
  store.json.put("symbols", mkSymbol("sym_a_index", "a/index.ts", "nestedIndex") as never);
  assert.deepEqual(ids(store, "index.ts"), ["sym_root_index"]);
  assert.deepEqual(ids(store, "a/index.ts"), ["sym_a_index"]);
  cleanup();
});

test("resolveSymbols: an indexed symbol-less file does not suffix-leak (#299)", () => {
  const { store, cleanup } = seed();
  store.json.put("symbols", mkSymbol("sym_readme", "README.md", "readme") as never);
  store.json.put("components", {
    id: "cmp_docs", kind: "module", name: "Docs", responsibility: "", paths: ["docs/**"], status: "active",
    owners: [], fragility: 0, provenance: prov(0.6), created_at: "2026-01-01T00:00:00Z", updated_at: "2026-01-01T00:00:00Z",
  } as never);
  assert.deepEqual(ids(store, "docs/README.md"), []);
  assert.deepEqual(resolveFiles(store, "docs/README.md"), ["docs/README.md"]);
  cleanup();
});

test("store.checkConstraints: relative and absolute forms of a path agree", () => {
  const { store, root, cleanup } = seed();
  const rel = store.checkConstraints("src/auth/session.ts").map((c) => c.id);
  assert.deepEqual(rel, ["con_1"]);
  assert.deepEqual(store.checkConstraints(join(root, "src/auth/session.ts")).map((c) => c.id), rel);
  cleanup();
});

test("resolveSymbols: a REAL working-tree file the index cannot see must not suffix-leak a same-basename nested file (issue #334)", () => {
  const { store, root, cleanup } = seed();
  // #299 answered "is this a real path" from graph data alone. A real
  // comment-only root file — zero tree-sitter symbols, no component glob
  // covering it — is invisible there, so it fell to the suffix tier and
  // returned a/empty.ts's symbols. The working tree is the last-resort answer.
  mkdirSync(join(root, "a"), { recursive: true });
  writeFileSync(join(root, "empty.ts"), "// only a comment — no symbols at all\n");
  writeFileSync(join(root, "a", "empty.ts"), "export function nestedEmpty(){ return 1; }\n");
  store.json.put("symbols", mkSymbol("sym_nested_empty", "a/empty.ts", "nestedEmpty") as never);

  assert.deepEqual(resolveSymbols(store, "empty.ts").map((s) => s.id), [], "the real root file must not pull the nested file's symbols");
  assert.deepEqual(resolveSymbols(store, "a/empty.ts").map((s) => s.id), ["sym_nested_empty"], "the nested file still resolves exactly");
  // A DIRECTORY target must keep resolving the way it does on origin/main:
  // isRepoFile is false for a directory, so the suffix tier is still open to it.
  assert.deepEqual(resolveSymbols(store, "a").map((s) => s.id), [], "a bare directory name matches no symbol file, as before");
  assert.deepEqual(resolveFiles(store, "empty.ts"), ["empty.ts"], "resolveFiles still names the file itself");
  cleanup();
});
