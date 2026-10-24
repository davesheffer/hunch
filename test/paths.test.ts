import { cleanupDir } from "./fixtures.js";
@@CLEANROOM_HOLE_1@@
import { isRepoFile, repoRelativeTarget } from "../src/core/paths.js";
@@CLEANROOM_HOLE_2@@
    cleanupDir(root);
@@CLEANROOM_HOLE_3@@
    cleanupDir(root);
    cleanupDir(outside);
@@CLEANROOM_HOLE_4@@
    cleanupDir(root);
@@CLEANROOM_HOLE_5@@
    cleanupDir(root);
@@CLEANROOM_HOLE_6@@
    cleanupDir(base);
@@CLEANROOM_HOLE_7@@

/** `isRepoFile` — the LAST-RESORT half of "is this a real path", consulted only
 *  after the index misses (issue #334). Deliberately narrow: repo-relative
 *  regular files only. */

test("isRepoFile: a real regular file inside root is true; a directory, a missing path, an escape and an absolute path are all false (issue #334)", () => {
  const root = mkdtempSync(join(tmpdir(), "hunch-isrepofile-"));
  try {
    mkdirSync(join(root, "a"), { recursive: true });
    writeFileSync(join(root, "empty.ts"), "// only a comment\n");
    writeFileSync(join(root, "a", "empty.ts"), "export function f(){ return 1; }\n");

    assert.equal(isRepoFile(root, "empty.ts"), true, "a regular file at the root");
    assert.equal(isRepoFile(root, "a/empty.ts"), true, "a regular file in a subdir");
    // A DIRECTORY must be false — directory targets keep flowing to structure()'s dir tier.
    assert.equal(isRepoFile(root, "a"), false, "a directory is not a file");
    assert.equal(isRepoFile(root, "nope.ts"), false, "a missing path");
    assert.equal(isRepoFile(root, ""), false, "the empty target");
    // Escaping the root is rejected rather than resolved.
    assert.equal(isRepoFile(root, "../outside.ts"), false, "a '..' escape");
    assert.equal(isRepoFile(root, ".."), false, "the parent directory itself");
    // The caller has already run repoRelativeTarget, so anything still absolute is outside the repo.
    assert.equal(isRepoFile(root, join(root, "empty.ts")), false, "an absolute path");
    assert.equal(isRepoFile(root, "C:/win/empty.ts"), false, "a Windows drive letter");
  } finally {
    cleanupDir(root);
  }
});

test("isRepoFile: an in-repo symlink pointing OUTSIDE the root is false — statSync follows links, so lexical containment alone is an existence oracle", { skip: SYMLINK_SKIP }, () => {
  const base = mkdtempSync(join(tmpdir(), "hunch-isrepofile-symlink-"));
  try {
    const root = join(base, "repo");
    const outside = join(base, "outside");
    mkdirSync(root, { recursive: true });
    mkdirSync(outside, { recursive: true });
    writeFileSync(join(outside, "secret.ts"), "export const secret = 1;\n");
    symlinkSync(outside, join(root, "link"));
    // "link/secret.ts" is lexically inside root and statSync says it's a file, but
    // the real target is outside — answering true would leak one bit about a path
    // the caller can't see.
    assert.equal(isRepoFile(root, "link/secret.ts"), false, "a symlinked dir escaping the root");
  } finally {
    cleanupDir(base);
  }
});

test("isRepoFile: a symlink to another file INSIDE the root stays true", { skip: SYMLINK_SKIP }, () => {
  const root = mkdtempSync(join(tmpdir(), "hunch-isrepofile-inlink-"));
  try {
    mkdirSync(join(root, "a"), { recursive: true });
    writeFileSync(join(root, "a", "real.ts"), "export function f(){ return 1; }\n");
    symlinkSync(join(root, "a", "real.ts"), join(root, "alias.ts"));
    assert.equal(isRepoFile(root, "alias.ts"), true, "the real target is still in the repo");
  } finally {
    cleanupDir(root);
  }
});
