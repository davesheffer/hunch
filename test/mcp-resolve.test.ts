@@CLEANROOM_HOLE_1@@
import { mkdirSync, writeFileSync } from "node:fs";
@@CLEANROOM_HOLE_2@@

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
