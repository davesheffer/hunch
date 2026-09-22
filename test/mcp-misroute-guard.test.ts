import { cleanupDir } from "./fixtures.js";
/**
 * The worktree-misroute guard's detection core: a write tool whose caller
 * forgot the `cwd` hint (see cwdHintField in src/mcp/server.ts) can silently
 * commit into whatever checkout the server's cached root currently points
 * at — often the primary checkout, on its default branch — instead of the
 * linked worktree the caller is actually in. `misroutedWorktreeCandidates`
 * detects the shape (file evidence present in a sibling worktree but absent,
 * and not explained by this checkout's own history, at the resolved root)
 * and `guardEvidence` disambiguates a literal backslash-byte filename from a
 * Windows-style separator before that evidence reaches it.
 *
 * Wiring this detection into the four auto-committing write tools is covered
 * separately in test/mcp-misroute-guard-wiring.test.ts.
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync, symlinkSync, unlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileEvidenceFor, FILE_EVIDENCE_FIELD, guardEvidence, misroutedWorktreeCandidates } from "../src/mcp/server.js";
import { SYMLINK_SKIP } from "./helpers.js";

function git(root: string, ...args: string[]): string {
  return execFileSync("git", args, { cwd: root, encoding: "utf8" }).trim();
}

function repo(prefix = "hunch-misroute-"): string {
  // canonicalRootPath() realpaths every root, so the fixture must be canonical
  // too: on macOS tmpdir() is the /var -> /private/var symlink, and a raw path
  // would compare unequal to the resolved root the server legitimately returns.
  const root = mkdtempSync(join(realpathSync(tmpdir()), prefix));
  git(root, "init", "-q");
  git(root, "config", "user.email", "mcp-misroute@example.invalid");
  git(root, "config", "user.name", "MCP Misroute Test");
  mkdirSync(join(root, ".hunch"), { recursive: true });
  writeFileSync(join(root, ".hunch", "seed.json"), "{}\n");
  writeFileSync(join(root, "app.ts"), "export const value = 1;\n");
  git(root, "add", "-A");
  git(root, "commit", "-qm", "fixture");
  // Git's worktree porcelain uses forward slashes on Windows too.
  return process.platform === "win32" ? root.replace(/\\/g, "/") : root;
}

function repoWithWorktree(): { root: string; worktree: string; cleanup: () => void } {
  const root = repo();
  const worktree = `${root}-wt`;
  git(root, "worktree", "add", "-q", "-b", "feature-misroute", worktree);
  return {
    root,
    worktree,
    cleanup: () => {
      try { git(root, "worktree", "remove", "--force", worktree); } catch { /* best effort */ }
      try { cleanupDir(worktree); } catch { /* temp only */ }
      try { cleanupDir(root); } catch { /* temp only */ }
    },
  };
}

// -- misroutedWorktreeCandidates: detection unit tests -----------------------

test("no misroute when the related file exists at the resolved root itself", () => {
  const fixture = repoWithWorktree();
  try {
    assert.deepEqual(misroutedWorktreeCandidates(fixture.root, ["app.ts"]), []);
  } finally {
    fixture.cleanup();
  }
});

test("empty related_files never triggers a misroute", () => {
  const fixture = repoWithWorktree();
  try {
    assert.deepEqual(misroutedWorktreeCandidates(fixture.root, []), []);
  } finally {
    fixture.cleanup();
  }
});

test("flags the sibling worktree when a related file exists there but not at the resolved root (relative evidence)", () => {
  const fixture = repoWithWorktree();
  try {
    writeFileSync(join(fixture.worktree, "only-in-wt.ts"), "export const x = 1;\n");
    git(fixture.worktree, "add", "-A");
    git(fixture.worktree, "commit", "-qm", "wt-only file");
    assert.deepEqual(misroutedWorktreeCandidates(fixture.root, ["only-in-wt.ts"]), [fixture.worktree]);
  } finally {
    fixture.cleanup();
  }
});

test("flags the sibling worktree via an absolute path (naive join() would compare against nothing)", () => {
  const fixture = repoWithWorktree();
  try {
    const abs = join(fixture.worktree, "only-in-wt-abs.ts");
    writeFileSync(abs, "export const x = 1;\n");
    git(fixture.worktree, "add", "-A");
    git(fixture.worktree, "commit", "-qm", "wt-only absolute file");
    assert.deepEqual(misroutedWorktreeCandidates(fixture.root, [abs]), [fixture.worktree]);
  } finally {
    fixture.cleanup();
  }
});

test("a nested worktree under root is not swallowed by root's own lexical containment", () => {
  const root = repo("hunch-misroute-nested-");
  const nestedPath = join(root, ".worktrees", "feature");
  const nested = process.platform === "win32" ? nestedPath.replace(/\\/g, "/") : nestedPath;
  try {
    git(root, "worktree", "add", "-q", "-b", "feature-nested", nested);
    const abs = join(nested, "nested-only.ts");
    writeFileSync(abs, "export const x = 1;\n");
    git(nested, "add", "-A");
    git(nested, "commit", "-qm", "nested-only file");
    assert.deepEqual(misroutedWorktreeCandidates(root, [abs]), [nested]);
  } finally {
    try { git(root, "worktree", "remove", "--force", nested); } catch { /* best effort */ }
    cleanupDir(root);
  }
});

test("a legitimate delete/rename at the resolved root is not read as a misroute (pathKnownToHistory)", () => {
  const root = repo("hunch-misroute-history-");
  try {
    // The file exists at the moment the worktree branches off...
    writeFileSync(join(root, "gone.ts"), "export const gone = true;\n");
    git(root, "add", "-A");
    git(root, "commit", "-qm", "add gone.ts");
    const worktree = `${root}-wt`;
    git(root, "worktree", "add", "-q", "-b", "feature-history", worktree);
    // ...then root legitimately deletes it. The worktree, branched earlier, still has it.
    unlinkSync(join(root, "gone.ts"));
    git(root, "add", "-A");
    git(root, "commit", "-qm", "remove gone.ts");
    try {
      assert.deepEqual(
        misroutedWorktreeCandidates(root, ["gone.ts"]),
        [],
        "root's own history explains the absence — not a misroute",
      );
      for (const spelling of ["./gone.ts", "src/../gone.ts", "src/nested/../../gone.ts"]) {
        assert.deepEqual(
          misroutedWorktreeCandidates(root, [spelling]),
          [],
          `root's own history also explains the equivalent path ${spelling}`,
        );
      }
    } finally {
      try { git(root, "worktree", "remove", "--force", worktree); } catch { /* best effort */ }
      cleanupDir(worktree);
    }
  } finally {
    cleanupDir(root);
  }
});

// -- guardEvidence: the backslash-byte disambiguation ------------------------
//
// A literal backslash is a legal POSIX filename byte, not a separator. Feeding
// it straight through toPosixTarget (what every OTHER consumer of related_files
// does) rewrites a real filename into a fake nested path, which can then
// coincidentally collide with something unrelated in a sibling worktree.
// guardEvidence keeps the raw string whenever the filesystem or git history
// confirms it names something real.

test("guardEvidence keeps a real on-disk backslash-byte filename raw, avoiding a false collision", { skip: process.platform === "win32" && "Windows cannot create a literal backslash in a filename" }, () => {
  const fixture = repoWithWorktree();
  try {
    const weird = "weird\\name.ts"; // one real file, literal backslash in the name
    writeFileSync(join(fixture.root, weird), "export const w = 1;\n");
    git(fixture.root, "add", "-A");
    git(fixture.root, "commit", "-qm", "add backslash-byte file");
    // An UNRELATED nested file that a naive toPosixTarget("weird\\name.ts") ->
    // "weird/name.ts" would collide with, if the raw byte were blindly rewritten.
    mkdirSync(join(fixture.worktree, "weird"), { recursive: true });
    writeFileSync(join(fixture.worktree, "weird", "name.ts"), "export const decoy = 1;\n");
    git(fixture.worktree, "add", "-A");
    git(fixture.worktree, "commit", "-qm", "unrelated decoy nested file");

    const evidence = guardEvidence(fixture.root, [weird]);
    assert.deepEqual(evidence, [weird], "the raw backslash-byte string is preserved, not slash-normalized");
    assert.deepEqual(
      misroutedWorktreeCandidates(fixture.root, evidence),
      [],
      "the file genuinely exists at root under its real name — no misroute",
    );
  } finally {
    fixture.cleanup();
  }
});

test("guardEvidence keeps a since-deleted backslash-byte filename raw via history, avoiding a false collision", { skip: process.platform === "win32" && "Windows cannot create a literal backslash in a filename" }, () => {
  const fixture = repoWithWorktree();
  try {
    const weird = "weird\\name.ts";
    writeFileSync(join(fixture.root, weird), "export const w = 1;\n");
    git(fixture.root, "add", "-A");
    git(fixture.root, "commit", "-qm", "add backslash-byte file");
    unlinkSync(join(fixture.root, weird));
    git(fixture.root, "add", "-A");
    git(fixture.root, "commit", "-qm", "remove backslash-byte file");
    // Same unrelated decoy a naive normalization would collide with.
    mkdirSync(join(fixture.worktree, "weird"), { recursive: true });
    writeFileSync(join(fixture.worktree, "weird", "name.ts"), "export const decoy = 1;\n");
    git(fixture.worktree, "add", "-A");
    git(fixture.worktree, "commit", "-qm", "unrelated decoy nested file");

    const evidence = guardEvidence(fixture.root, [weird]);
    assert.deepEqual(evidence, [weird], "the raw backslash-byte string is preserved via git history, not slash-normalized");
    assert.deepEqual(
      misroutedWorktreeCandidates(fixture.root, evidence),
      [],
      "root's own history explains the deletion under the real name — no misroute",
    );
  } finally {
    fixture.cleanup();
  }
});

test("guardEvidence still normalizes a genuine Windows-style separator with no real POSIX file behind it", () => {
  const fixture = repoWithWorktree();
  try {
    mkdirSync(join(fixture.worktree, "src"), { recursive: true });
    writeFileSync(join(fixture.worktree, "src", "session.ts"), "export const s = 1;\n");
    git(fixture.worktree, "add", "-A");
    git(fixture.worktree, "commit", "-qm", "wt-only nested file");

    const evidence = guardEvidence(fixture.root, ["src\\session.ts"]);
    assert.deepEqual(evidence, ["src/session.ts"], "no real backslash-byte file or history entry — normalized as a Windows path");
    assert.deepEqual(misroutedWorktreeCandidates(fixture.root, evidence), [fixture.worktree]);
  } finally {
    fixture.cleanup();
  }
});

// -- Kernel-aware absolute-path symlink handling ------------------------------

test(
  "an absolute path through a symlink+'..' is attributed by the KERNEL's cancellation point, not a naive lexical dirname",
  { skip: SYMLINK_SKIP },
  () => {
    const fixture = repoWithWorktree();
    try {
      // A real file living directly in the worktree...
      writeFileSync(join(fixture.worktree, "secret.ts"), "export const secret = 1;\n");
      git(fixture.worktree, "add", "-A");
      git(fixture.worktree, "commit", "-qm", "secret.ts");
      // ...reached from ROOT through a symlink to a SUBDIRECTORY of the worktree
      // (so the symlink's own lexical parent is root, but its TARGET's parent is
      // the worktree) plus a ".." that pops back out of it.
      mkdirSync(join(fixture.worktree, "sub"));
      symlinkSync(join(fixture.worktree, "sub"), join(fixture.root, "link"), "dir");
      // Built by string concatenation, NOT path.join()/path.resolve(): either would
      // lexically collapse the ".." itself before the code under test ever sees it,
      // defeating the very case this test exists to exercise.
      const f = `${fixture.root}/link/../secret.ts`;

      if (process.platform === "win32") {
        // Win32 normalizes dot segments before traversing the symlink. Prove
        // the actual filesystem result rather than imposing POSIX semantics.
        assert.throws(() => readFileSync(f), { code: "ENOENT" });
        assert.deepEqual(misroutedWorktreeCandidates(fixture.root, [f]), []);
        return;
      }
      assert.equal(readFileSync(f, "utf8"), "export const secret = 1;\n");

      // The kernel cancels ".." against the symlink TARGET's parent (the
      // worktree), landing on a real file — never on <root>/secret.ts, which
      // does not exist. A purely lexical dirname("<root>/link") would wrongly
      // land there instead and attribute the file to root.
      assert.deepEqual(
        misroutedWorktreeCandidates(fixture.root, [f]),
        [fixture.worktree],
        "the guard must agree with the kernel's own resolution of symlink+'..'",
      );
    } finally {
      fixture.cleanup();
    }
  },
);

// -- FILE_EVIDENCE_FIELD: total map over every StateFacet --------------------

test("FILE_EVIDENCE_FIELD/fileEvidenceFor cover every StateFacet explicitly", () => {
  assert.deepEqual(FILE_EVIDENCE_FIELD, {
    decisions: "related_files",
    findings: "affected_files",
    bugs: "affected_files",
    constraints: "scope",
    receipts: null,
    commitments: null,
    derived: null,
    entities: null,
    relationships: null,
    conventions: null,
  });
  assert.deepEqual(fileEvidenceFor("decisions", { related_files: ["a.ts", 7, "b.ts"] }), ["a.ts", "b.ts"]);
  assert.deepEqual(fileEvidenceFor("receipts", { related_files: ["a.ts"] }), [], "receipts carries no file evidence");
});
