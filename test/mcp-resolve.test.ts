import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { tempStore, prov, mkSymbol } from "./helpers.js";
import { resolveSymbols, resolveFiles } from "../src/mcp/server.js";

function seed() {
  const ctx = tempStore();
  const { store } = ctx;
  store.json.replaceAll("symbols", [
    mkSymbol("sym_db", "src/db.ts", "connect"),
    mkSymbol("sym_mongo", "src/mongodb.ts", "connectMongo"),
    // "datastore" merely CONTAINS "store" as a substring — no "/" boundary before it,
    // so this must never match a "store/db.ts" target (the issue's own example).
    mkSymbol("sym_datastore_db", "src/datastore/db.ts", "connectDatastore"),
    mkSymbol("sym_store_db", "src/store/db.ts", "connectStore"),
    mkSymbol("sym_auth", "src/auth/session.ts", "verifySession"),
  ]);
  store.json.put("constraints", {
    id: "con_1", type: "security", statement: "must not break", scope: ["src/auth/**"], severity: "blocking",
    enforcement: "advisory_v1", rationale: "x", source_decision: null, violations: [], provenance: prov(0.9),
  } as never);
  store.reindex();
  return ctx;
}

test("resolveSymbols matches only a segment-anchored suffix — 'db.ts' must not pull 'mongodb.ts', 'store/db.ts' must not pull 'datastore/db.ts' (issue #300)", () => {
  const { store, cleanup } = seed();
  const dbMatches = resolveSymbols(store, "db.ts").map((s) => s.id).sort();
  assert.deepEqual(dbMatches, ["sym_datastore_db", "sym_db", "sym_store_db"].sort(), "every real db.ts file matches, mongodb.ts never does");
  const storeDbMatches = resolveSymbols(store, "store/db.ts").map((s) => s.id);
  assert.deepEqual(storeDbMatches, ["sym_store_db"], "'datastore/db.ts' must not match 'store/db.ts' — 'store' there is a substring, not a path segment");
  const exact = resolveSymbols(store, "src/db.ts").map((s) => s.id);
  assert.deepEqual(exact, ["sym_db"]);
  cleanup();
});

test("resolveSymbols/resolveFiles rewrite an absolute target to repo-relative before matching (issue #296)", () => {
  const { store, root, cleanup } = seed();
  const abs = join(root, "src", "auth", "session.ts");
  assert.deepEqual(resolveSymbols(store, abs).map((s) => s.id), ["sym_auth"]);
  assert.deepEqual(resolveFiles(store, abs), ["src/auth/session.ts"]);
  cleanup();
});

test("resolveSymbols: the absolute-path rewrite is the ONLY thing that produces the right match — without it, a root-level same-basename file leaks in (issue #296/#299)", () => {
  // Without the repo-relative rewrite, resolveSymbols falls straight to the
  // segment-anchored suffix tier on the RAW absolute target. That suffix tier
  // still happens to find the right file too (any relative path is trivially a
  // suffix of `root + "/" + thatPath`) — which is exactly why a naive "does it
  // find sym_auth" assertion doesn't discriminate. But an UNRELATED root-level
  // "session.ts" is *also* a segment-anchored suffix of that same absolute
  // string ("…/src/auth/session.ts" ends with "/session.ts"), so the suffix
  // tier alone returns BOTH files. Only the rewrite lets the exact-file tier
  // resolve first and return the single correct match.
  const { store, root, cleanup } = seed();
  store.json.put("symbols", mkSymbol("sym_root_session", "session.ts", "unrelatedRootSession") as never);
  const abs = join(root, "src", "auth", "session.ts");
  assert.deepEqual(resolveSymbols(store, abs).map((s) => s.id), ["sym_auth"], "must resolve to exactly the target file, never the unrelated root-level same-basename file");
  cleanup();
});

test("resolveSymbols: exact match wins over a would-be suffix match when both are indexed (issue #299)", () => {
  const { store, cleanup } = seed();
  store.json.put("symbols", mkSymbol("sym_root_index", "index.ts", "rootIndex") as never);
  store.json.put("symbols", mkSymbol("sym_nested_index", "a/index.ts", "nestedIndex") as never);
  assert.deepEqual(resolveSymbols(store, "index.ts").map((s) => s.id), ["sym_root_index"], "the root index.ts must not also pull in a/index.ts via suffix leakage");
  assert.deepEqual(resolveSymbols(store, "a/index.ts").map((s) => s.id), ["sym_nested_index"]);
  cleanup();
});

test("resolveSymbols: a real indexed file with zero symbols returns [] rather than suffix-leaking an unrelated same-basename file (issue #299)", () => {
  const { store, cleanup } = seed();
  // "docs/README.md" has no symbols of its own but IS covered by an indexed
  // component (a real file with zero tree-sitter symbols — README.md,
  // package.json, Dockerfile, ...). A root-level "README.md" with a symbol
  // exists elsewhere in the graph and must never leak in via suffix matching.
  store.json.put("symbols", mkSymbol("sym_root_readme", "README.md", "rootReadmeSymbol") as never);
  store.json.put("components", {
    id: "cmp_docs", kind: "module", name: "docs", responsibility: "", paths: ["docs/**"], status: "active",
    owners: [], fragility: 0, provenance: prov(0.9), created_at: "", updated_at: "",
  } as never);
  assert.deepEqual(resolveSymbols(store, "docs/README.md").map((s) => s.id), [], "a real, indexed, symbol-less file must not fall through to suffix matching");
  assert.deepEqual(resolveFiles(store, "docs/README.md"), ["docs/README.md"], "resolveFiles still names the file itself even with zero symbols");
  cleanup();
});

test("checkConstraints matches an absolute target the same as its repo-relative form (issue #296)", () => {
  const { store, root, cleanup } = seed();
  const rel = store.checkConstraints("src/auth/session.ts").map((c) => c.id);
  const abs = store.checkConstraints(join(root, "src", "auth", "session.ts")).map((c) => c.id);
  assert.deepEqual(rel, ["con_1"]);
  assert.deepEqual(abs, rel);
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
