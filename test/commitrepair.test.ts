@@CLEANROOM_HOLE_1@@
test("planCommitRepair: a same-patch-id candidate beats the unique file-superset candidate (#450)", () => {
  // The release commit is the ONLY superset of related_files; the true
  // replacement carries the identical change but not every related file.
  const orphaned = [D({ id: "dec_1", commit: "sha_old", related_files: ["CHANGELOG.md", "src/a.ts"] })];
  const candidates: CommitCandidate[] = [
    { sha: "sha_release", files: ["CHANGELOG.md", "src/a.ts", "package.json"] },
    { sha: "sha_true", files: ["CHANGELOG.md", "scripts/x.sh"] },
  ];
  const patch = new Map([["sha_old", "p1"], ["sha_true", "p1"], ["sha_release", "p2"]]);
  const patchIdOf = (sha: string) => patch.get(sha) ?? null;
  assert.deepEqual(planCommitRepair(orphaned, candidates).rewrites, [{ id: "dec_1", from: "sha_old", to: "sha_release" }], "file matching alone picks the wrong commit");
  assert.deepEqual(planCommitRepair(orphaned, candidates, patchIdOf).rewrites, [{ id: "dec_1", from: "sha_old", to: "sha_true" }]);
});

test("planCommitRepair: two same-patch-id candidates are ambiguous; no patch-id match falls back to files (#450)", () => {
  const orphaned = [D({ id: "dec_1", commit: "sha_old", related_files: ["src/a.ts"] })];
  const candidates: CommitCandidate[] = [{ sha: "sha_x", files: ["src/a.ts"] }, { sha: "sha_y", files: ["src/b.ts"] }];
  const twice = new Map([["sha_old", "p1"], ["sha_x", "p1"], ["sha_y", "p1"]]);
  assert.deepEqual(planCommitRepair(orphaned, candidates, (s) => twice.get(s) ?? null).rewrites, [], "never guess between identical changes");
  const none = new Map([["sha_old", "p1"], ["sha_x", "p2"]]);
  assert.deepEqual(planCommitRepair(orphaned, candidates, (s) => none.get(s) ?? null).rewrites, [{ id: "dec_1", from: "sha_old", to: "sha_x" }], "a multi-commit squash never matches by patch-id; files still decide");
});

@@CLEANROOM_HOLE_2@@
