import { cleanupDir } from "./fixtures.js";
/**
 * Memory lane Phase 1 (hunch-private#62): every PUBLIC memory commit names the
 * code it was captured against, in git trailers, so memory stays linked to its
 * feature commit even after it moves off the code branch.
 *
 *   Hunch-Code-Branch: <branch at capture time>   (omitted on a detached HEAD)
 *   Hunch-Code-Head:   <nearest first-parent commit that is not a hunch: commit>
 *
 * The private and shared overlays are out of scope (user, 2026-10-20): their
 * commits carry no trailers.
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { mkdirSync, mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { commitAndPushHunch, revertMemoryMove } from "../src/extractors/git.js";
import { parseMemoryLog } from "../src/core/memorylog.js";
import { gitMemoryLog } from "../src/extractors/git.js";

const git = (cwd: string, ...a: string[]): string =>
  execFileSync("git", ["-C", cwd, ...a], { encoding: "utf8", stdio: ["ignore", "pipe", "ignore"] }).trim();

function repo(prefix: string, seed = "feat: seed"): { root: string; hunch: string; cleanup: () => void } {
  const root = mkdtempSync(join(tmpdir(), prefix));
  git(root, "init", "-q", "-b", "main", ".");
  git(root, "config", "user.email", "t@example.com");
  git(root, "config", "user.name", "T");
  const hunch = join(root, ".hunch");
  mkdirSync(join(hunch, "decisions"), { recursive: true });
  writeFileSync(join(root, ".gitignore"), ".hunch/hunch.sqlite*\n");
  writeFileSync(join(root, "app.ts"), "export const a = 1;\n");
  git(root, "add", "-A");
  git(root, "commit", "-qm", seed);
  return { root, hunch, cleanup: () => cleanupDir(root) };
}

const writeDec = (hunch: string, id: string): void => {
  mkdirSync(join(hunch, "decisions"), { recursive: true }); // a revert drops a directory left empty
  writeFileSync(join(hunch, "decisions", `${id}.json`), JSON.stringify({ id }) + "\n");
};

const trailer = (root: string, key: string): string =>
  git(root, "log", "-1", `--format=%(trailers:key=${key},valueonly,separator=%x20)`);

test("a public memory commit carries the code branch and head it was captured against", () => {
  const { root, hunch, cleanup } = repo("hunch-trailers-");
  try {
    git(root, "switch", "-q", "-c", "feat/b");
    writeFileSync(join(root, "app.ts"), "export const a = 2;\n");
    git(root, "commit", "-qam", "feat: c1");
    const c1 = git(root, "rev-parse", "HEAD");

    writeDec(hunch, "dec_one");
    assert.equal(commitAndPushHunch(hunch, "hunch: capture dec_one", { push: false }), "committed");
    assert.equal(git(root, "log", "-1", "--format=%s"), "hunch: capture dec_one", "the subject is unchanged");
    assert.equal(trailer(root, "Hunch-Code-Branch"), "feat/b");
    assert.equal(trailer(root, "Hunch-Code-Head"), c1);

    // HEAD is now a memory commit; the next capture still names the CODE head.
    writeDec(hunch, "dec_two");
    assert.equal(commitAndPushHunch(hunch, "hunch: capture dec_two", { push: false }), "committed");
    assert.equal(trailer(root, "Hunch-Code-Head"), c1, "a preceding memory commit is never the code head");

    const moves = parseMemoryLog(gitMemoryLog(root, 10));
    assert.deepEqual(
      moves.slice(0, 2).map((m) => [m.subject, m.codeBranch, m.codeHead]),
      [["hunch: capture dec_two", "feat/b", c1], ["hunch: capture dec_one", "feat/b", c1]],
      "hunch log exposes the link",
    );
    assert.equal(moves.length, 2, "the seed commit did not touch .hunch/ records");
  } finally { cleanup(); }
});

test("a user's code commit titled hunch: is still the code head", () => {
  const { root, hunch, cleanup } = repo("hunch-trailers-userhunch-");
  try {
    git(root, "switch", "-q", "-c", "feat/b");
    // A tag with the branch's name must not turn the trailer into "heads/feat/b".
    git(root, "tag", "feat/b");
    writeDec(hunch, "dec_one");
    assert.equal(commitAndPushHunch(hunch, "hunch: capture dec_one", { push: false }), "committed");
    writeFileSync(join(root, "app.ts"), "export const a = 3;\n");
    git(root, "commit", "-qam", "hunch: real code change by the user");
    const code = git(root, "rev-parse", "HEAD");
    writeDec(hunch, "dec_two");
    assert.equal(commitAndPushHunch(hunch, "hunch: capture dec_two", { push: false }), "committed");
    assert.equal(trailer(root, "Hunch-Code-Head"), code, "a code commit is never skipped for its subject");
    assert.equal(trailer(root, "Hunch-Code-Branch"), "feat/b");
  } finally { cleanup(); }
});

test("a memory commit from before the trailers is skipped when it touched only memory", () => {
  const { root, hunch, cleanup } = repo("hunch-trailers-legacy-");
  try {
    const code = git(root, "rev-parse", "HEAD");
    writeDec(hunch, "dec_old");
    writeFileSync(join(root, "AGENTS.md"), "grounding\n");
    git(root, "add", "-A");
    git(root, "commit", "-qm", "hunch: capture dec_old");
    writeDec(hunch, "dec_new");
    assert.equal(commitAndPushHunch(hunch, "hunch: capture dec_new", { push: false }), "committed");
    assert.equal(trailer(root, "Hunch-Code-Head"), code);
  } finally { cleanup(); }
});

test("a reverted memory move is not the code head, and neither is reverting that revert", () => {
  const { root, hunch, cleanup } = repo("hunch-trailers-revert-");
  try {
    const code = git(root, "rev-parse", "HEAD");
    writeDec(hunch, "dec_one");
    assert.equal(commitAndPushHunch(hunch, "hunch: capture dec_one", { push: false }), "committed");
    const captured = git(root, "rev-parse", "HEAD");
    assert.equal(revertMemoryMove(captured, root), true);
    assert.equal(git(root, "log", "-1", "--format=%s"), 'Revert "hunch: capture dec_one"');
    writeDec(hunch, "dec_two");
    assert.equal(commitAndPushHunch(hunch, "hunch: capture dec_two", { push: false }), "committed");
    assert.equal(trailer(root, "Hunch-Code-Head"), code, "the revert touched only memory");

    // Git titles a revert of a revert either Reapply "..." or Revert "Revert "..."", by version.
    for (const subject of ['Reapply "hunch: capture dec_one"', 'Revert "Revert "hunch: capture dec_one""']) {
      writeDec(hunch, "dec_one");
      git(root, "add", "-A");
      git(root, "commit", "-qm", subject);
      git(root, "rm", "-q", join(".hunch", "decisions", "dec_one.json"));
      git(root, "commit", "-qm", 'Revert "hunch: capture dec_one"');
    }
    writeDec(hunch, "dec_three");
    assert.equal(commitAndPushHunch(hunch, "hunch: capture dec_three", { push: false }), "committed");
    assert.equal(trailer(root, "Hunch-Code-Head"), code);

    // A revert that touches code is a code commit, whatever it is titled.
    writeFileSync(join(root, "app.ts"), "export const a = 4;\n");
    git(root, "commit", "-qam", 'Revert "hunch: capture dec_two"');
    const revertWithCode = git(root, "rev-parse", "HEAD");
    writeDec(hunch, "dec_four");
    assert.equal(commitAndPushHunch(hunch, "hunch: capture dec_four", { push: false }), "committed");
    assert.equal(trailer(root, "Hunch-Code-Head"), revertWithCode);
  } finally { cleanup(); }
});

test("a caller's own trailer paragraph keeps working", () => {
  const { root, hunch, cleanup } = repo("hunch-trailers-paragraph-");
  try {
    git(root, "switch", "-q", "-c", "feat/b");
    writeDec(hunch, "dec_one");
    assert.equal(commitAndPushHunch(hunch, "hunch: capture dec_one\n\nTask: tsk_1", { push: false }), "committed");
    assert.equal(trailer(root, "Task"), "tsk_1");
    assert.equal(trailer(root, "Hunch-Code-Branch"), "feat/b");
  } finally { cleanup(); }
});

test("a detached HEAD records the code head only", () => {
  const { root, hunch, cleanup } = repo("hunch-trailers-detached-");
  try {
    const head = git(root, "rev-parse", "HEAD");
    git(root, "switch", "-q", "--detach");
    writeDec(hunch, "dec_detached");
    assert.equal(commitAndPushHunch(hunch, "hunch: capture dec_detached", { push: false }), "committed");
    assert.equal(trailer(root, "Hunch-Code-Branch"), "");
    assert.equal(trailer(root, "Hunch-Code-Head"), head);
    const [move] = parseMemoryLog(gitMemoryLog(root, 1));
    assert.equal(move?.codeBranch, null);
    assert.equal(move?.codeHead, head);
  } finally { cleanup(); }
});

test("a memory commit without trailers parses as an unknown link", () => {
  const header = "@@@" + ["a".repeat(40), "aaaaaaa", "2026-11-03T10:00:00+02:00", "hunch: capture\twith tab"].join("\t");
  // Empty trailer fields (today's format on a pre-trailer commit) and a line with
  // no link section at all (older canned input) both mean "unknown", never a guess.
  for (const line of [`${header}\x1f\x1f`, header, `${header}\x1fnot a branch\x1fnot-a-sha`]) {
    const [move] = parseMemoryLog(`${line}\nA\t.hunch/decisions/dec_1.json\n`);
    assert.equal(move?.subject, "hunch: capture\twith tab");
    assert.equal(move?.codeBranch, null);
    assert.equal(move?.codeHead, null);
    assert.deepEqual(move?.decisionIds, ["dec_1"]);
  }
  // A unit separator inside a subject stays in the subject.
  const [odd] = parseMemoryLog(`${header}\x1fpart\x1ffeat/b\x1f${"b".repeat(40)}\nA\t.hunch/decisions/dec_1.json\n`);
  assert.equal(odd?.subject, "hunch: capture\twith tab\x1fpart");
  assert.equal(odd?.codeBranch, "feat/b");
  assert.equal(odd?.codeHead, "b".repeat(40));
});

test("an overlay commit carries no code trailers (overlays are out of scope)", () => {
  const code = repo("hunch-trailers-code-");
  // A distinct seed: identical seeds share commit objects, which the overlay guard refuses.
  const overlay = repo("hunch-trailers-overlay-", "overlay: seed");
  try {
    writeDec(overlay.hunch, "dec_private");
    const result = commitAndPushHunch(overlay.hunch, "hunch: capture dec_private", { push: true, protectedRepoRoot: code.root });
    assert.equal(result, "committed", "no remote, so the overlay commit stays local");
    assert.equal(git(overlay.root, "log", "-1", "--format=%s"), "hunch: capture dec_private");
    assert.equal(trailer(overlay.root, "Hunch-Code-Branch"), "");
    assert.equal(trailer(overlay.root, "Hunch-Code-Head"), "");
  } finally { overlay.cleanup(); code.cleanup(); }
});

test("after a rebase the code head is the rewritten commit, not the stale sha an older trailer names", () => {
  const { root, hunch, cleanup } = repo("hunch-trailers-rebase-");
  try {
    git(root, "switch", "-q", "-c", "feat/b");
    writeFileSync(join(root, "app.ts"), "export const a = 2;\n");
    git(root, "commit", "-qam", "feat: c2");
    const c2 = git(root, "rev-parse", "HEAD");
    writeDec(hunch, "dec_one");
    assert.equal(commitAndPushHunch(hunch, "hunch: capture dec_one", { push: false }), "committed");
    git(root, "switch", "-q", "main");
    writeFileSync(join(root, "other.ts"), "export const b = 1;\n");
    git(root, "add", "other.ts");
    git(root, "commit", "-qm", "feat: c3");
    git(root, "switch", "-q", "feat/b");
    git(root, "rebase", "-q", "main");
    const rewritten = git(root, "rev-parse", "HEAD~1");
    assert.notEqual(rewritten, c2);

    writeDec(hunch, "dec_two");
    assert.equal(commitAndPushHunch(hunch, "hunch: capture dec_two", { push: false }), "committed");
    assert.equal(trailer(root, "Hunch-Code-Head"), rewritten, "the head is read from the branch, never copied from a trailer");
  } finally { cleanup(); }
});

test("a nested .hunch/ still recognises its own memory-only commits", () => {
  const root = mkdtempSync(join(tmpdir(), "hunch-trailers-nested-"));
  try {
    git(root, "init", "-q", "-b", "main", ".");
    git(root, "config", "user.email", "t@example.com");
    git(root, "config", "user.name", "T");
    const project = join(root, "packages", "api");
    const hunch = join(project, ".hunch");
    mkdirSync(join(hunch, "decisions"), { recursive: true });
    writeFileSync(join(root, ".gitignore"), "hunch.sqlite*\n");
    writeFileSync(join(project, "app.ts"), "export const a = 1;\n");
    git(root, "add", "-A");
    git(root, "commit", "-qm", "feat: seed");
    const code = git(root, "rev-parse", "HEAD");
    writeDec(hunch, "dec_old");
    writeFileSync(join(project, "AGENTS.md"), "grounding\n");
    git(root, "add", "-A");
    git(root, "commit", "-qm", "hunch: capture dec_old");
    writeDec(hunch, "dec_new");
    assert.equal(commitAndPushHunch(hunch, "hunch: capture dec_new", { push: false }), "committed");
    assert.equal(trailer(root, "Hunch-Code-Head"), code);
  } finally { cleanupDir(root); }
});

test("a tracked file named HEAD inside .hunch/ does not hide the code head", () => {
  const { root, hunch, cleanup } = repo("hunch-trailers-headfile-");
  try {
    writeFileSync(join(hunch, "HEAD"), "not a ref\n");
    git(root, "add", "-A");
    git(root, "commit", "-qm", "feat: add a file named HEAD");
    const code = git(root, "rev-parse", "HEAD");
    writeDec(hunch, "dec_one");
    assert.equal(commitAndPushHunch(hunch, "hunch: capture dec_one", { push: false }), "committed");
    assert.equal(trailer(root, "Hunch-Code-Head"), code);
  } finally { cleanup(); }
});

test("a shallow clone whose boundary is a memory commit records no code head", () => {
  const origin = repo("hunch-trailers-shallow-origin-");
  const clone = mkdtempSync(join(tmpdir(), "hunch-trailers-shallow-clone-"));
  try {
    writeDec(origin.hunch, "dec_old");
    git(origin.root, "add", "-A");
    git(origin.root, "commit", "-qm", "hunch: capture dec_old");
    execFileSync("git", ["clone", "-q", "--depth", "1", `file://${origin.root.replace(/\\/g, "/")}`, clone], { stdio: "ignore" });
    git(clone, "config", "user.email", "t@example.com");
    git(clone, "config", "user.name", "T");
    writeDec(join(clone, ".hunch"), "dec_new");
    assert.equal(commitAndPushHunch(join(clone, ".hunch"), "hunch: capture dec_new", { push: false }), "committed");
    assert.equal(trailer(clone, "Hunch-Code-Head"), "", "the boundary's history is unknown, so nothing is guessed");
    assert.equal(trailer(clone, "Hunch-Code-Branch"), "main");
  } finally { origin.cleanup(); cleanupDir(clone); }
});

test("a caller trailer without a space or with a folded line stays a trailer", () => {
  for (const tail of ["Task:tsk_1", "Task: tsk_1\n  continued"]) {
    const { root, hunch, cleanup } = repo("hunch-trailers-fold-");
    try {
      writeDec(hunch, "dec_one");
      assert.equal(commitAndPushHunch(hunch, `hunch: capture dec_one\n\n${tail}`, { push: false }), "committed");
      assert.match(trailer(root, "Task"), /^tsk_1/, tail);
      assert.equal(trailer(root, "Hunch-Code-Branch"), "main", tail);
    } finally { cleanup(); }
  }
});
