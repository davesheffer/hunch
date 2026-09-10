import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve as resolvePath } from "node:path";
import { execFileSync } from "node:child_process";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { resolveGroundingConflicts, mergeGroundingFile } from "../src/core/groundingMerge.js";
import { installMergeDriver } from "../src/integrations/mergeDriver.js";
import { classifyGroundingBlock } from "../src/core/groundingLag.js";

const repoRoot = fileURLToPath(new URL("..", import.meta.url));
// Invoke THIS checkout's source directly (not whatever `hunch` happens to be
// on PATH — a globally installed release build would not carry the command
// under test) via its own vendored tsx, the same way this repo's own
// .git/hooks/post-commit invokes itself.
const cliInvocation = `${JSON.stringify(process.execPath)} ${JSON.stringify(resolvePath(repoRoot, "node_modules/tsx/dist/cli.mjs"))} ${JSON.stringify(resolvePath(repoRoot, "src/cli/index.ts"))}`;

function git(cwd: string, ...args: string[]): string {
  return execFileSync("git", args, { cwd, encoding: "utf8" }).trim();
}

function configureRepo(root: string): void {
  git(root, "config", "user.email", "test@example.com");
  git(root, "config", "user.name", "Test");
}

const COUNTS_LINE = (n: number) =>
  `This repo has **Hunch** — a curated graph. It currently holds **${n} decisions, 2 bugs, 28 constraints, 21 components, 3 policies**.`;

/** Real `git merge-file --diff3` output for three whole-file contents, so
 *  fixtures match exactly what git actually emits (marker spelling, label
 *  placement) rather than a hand-guessed approximation. */
function diff3(base: string, ours: string, theirs: string): string {
  const dir = mkdtempSync(join(tmpdir(), "hunch-diff3-fixture-"));
  try {
    const write = (name: string, text: string) => {
      const p = join(dir, name);
      writeFileSync(p, text);
      return p;
    };
    const o = write("ours.txt", ours);
    const b = write("base.txt", base);
    const t = write("theirs.txt", theirs);
    try {
      return execFileSync("git", ["merge-file", "-p", "--diff3", "-L", "ours", "-L", "base", "-L", "theirs", o, b, t], { encoding: "utf8" });
    } catch (e) {
      const err = e as { stdout?: string | Buffer };
      return typeof err.stdout === "string" ? err.stdout : (err.stdout?.toString() ?? "");
    }
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
}

test("resolveGroundingConflicts: a clean 3-way merge (no conflict markers) passes through untouched", () => {
  const text = diff3("a\nb\nc\n", "a\nb2\nc\n", "a\nb\nc\n"); // only ours changed
  assert.doesNotMatch(text, /<<<<<<</);
  const res = resolveGroundingConflicts(text);
  assert.equal(res.conflict, false);
  assert.equal(res.text, text);
});

test("resolveGroundingConflicts: a hard conflict confined to the counts sentence resolves to the HIGHER count, silently", () => {
  // Not "ours" unconditionally: whichever side is higher is preserved, so a
  // discarded higher count (potentially a real ahead-of-store signal on the
  // side we'd otherwise throw away) is never silently lost.
  const base = `intro\n${COUNTS_LINE(240)}\noutro\n`;
  const ours = `intro\n${COUNTS_LINE(241)}\noutro\n`;
  const theirs = `intro\n${COUNTS_LINE(243)}\noutro\n`;
  const text = diff3(base, ours, theirs);
  assert.match(text, /<<<<<<< ours/, "sanity: git actually conflicted here");
  const res = resolveGroundingConflicts(text);
  assert.equal(res.conflict, false);
  assert.equal(res.text, `intro\n${COUNTS_LINE(243)}\noutro\n`);
});

test("resolveGroundingConflicts: the resolution takes the max PER FIELD, not just from whichever whole line is bigger", () => {
  const sentence = (decisions: number, bugs: number) =>
    `This repo has **Hunch** — a curated graph. It currently holds **${decisions} decisions, ${bugs} bugs, 28 constraints, 21 components, 3 policies**.`;
  const base = `intro\n${sentence(240, 2)}\noutro\n`;
  const ours = `intro\n${sentence(241, 5)}\noutro\n`; // higher bugs, lower decisions
  const theirs = `intro\n${sentence(243, 2)}\noutro\n`; // higher decisions, lower bugs
  const text = diff3(base, ours, theirs);
  assert.match(text, /<<<<<<< ours/, "sanity: git actually conflicted here");
  const res = resolveGroundingConflicts(text);
  assert.equal(res.conflict, false);
  assert.equal(res.text, `intro\n${sentence(243, 5)}\noutro\n`, "each field independently takes the higher of the two sides");
});

test("resolveGroundingConflicts + classifyGroundingBlock: an incoming (theirs) phantom/uncommitted-record count is never silently downgraded to lag", () => {
  // davesheffer's reproduction: base=240, ours=241, theirs=243, but the real
  // merged store only ends up with 242 records (theirs' 243 was never fully
  // committed — a phantom count, the exact fnd_6391b4242f shape). Unconditionally
  // keeping `ours` would discard the 243 and read as "lagging" (safe, wrong);
  // the resolution must preserve enough of theirs' claim that classifying the
  // resolved doc against the TRUE merged store still reports "ahead".
  const base = `intro\n${COUNTS_LINE(240)}\noutro\n`;
  const ours = `intro\n${COUNTS_LINE(241)}\noutro\n`;
  const theirs = `intro\n${COUNTS_LINE(243)}\noutro\n`;
  const text = diff3(base, ours, theirs);
  const res = resolveGroundingConflicts(text);
  assert.equal(res.conflict, false);
  const resolvedBlock = res.text.split("\n")[1]!; // strip the intro/outro test scaffolding
  const trueMergedStoreBlock = COUNTS_LINE(242); // theirs' claimed 3rd decision never actually landed
  const verdict = classifyGroundingBlock(resolvedBlock, trueMergedStoreBlock);
  assert.equal(verdict.kind, "ahead", "the discarded higher count must still surface as ahead-of-store, not silently become lag");
});

test("resolveGroundingConflicts: a conflict outside the counts sentence is left as a real conflict", () => {
  const base = "intro\nOLD PROSE\noutro\n";
  const ours = "intro\nOURS PROSE\noutro\n";
  const theirs = "intro\nTHEIRS PROSE\noutro\n";
  const text = diff3(base, ours, theirs);
  assert.match(text, /<<<<<<< ours/);
  const res = resolveGroundingConflicts(text);
  assert.equal(res.conflict, true);
  assert.equal(res.text, text, "must not rewrite a conflict it can't safely resolve");
});

test("resolveGroundingConflicts: a counts-only hunk alongside a real prose conflict in the same file stays a conflict", () => {
  const base = `${COUNTS_LINE(240)}\nunchanged\nunchanged\nunchanged\nOLD PROSE\n`;
  const ours = `${COUNTS_LINE(241)}\nunchanged\nunchanged\nunchanged\nOURS PROSE\n`;
  const theirs = `${COUNTS_LINE(243)}\nunchanged\nunchanged\nunchanged\nTHEIRS PROSE\n`;
  const text = diff3(base, ours, theirs);
  const hunks = text.match(/<<<<<<< ours/g);
  assert.equal(hunks?.length, 2, "sanity: two independent hunks");
  const res = resolveGroundingConflicts(text);
  assert.equal(res.conflict, true);
  assert.equal(res.text, text, "must not partially resolve — the whole file stays a real conflict");
});

test("installMergeDriver: routes the five generated grounding docs through merge=hunch-grounding, alongside the existing .hunch/ JSON driver", () => {
  const root = mkdtempSync(join(tmpdir(), "hunch-mergedriver-grounding-"));
  try {
    execFileSync("git", ["init", "-q", "-b", "main", root]);
    installMergeDriver(root, "hunch");
    const attrs = readFileSync(join(root, ".gitattributes"), "utf8");
    for (const f of ["CLAUDE.md", "AGENTS.md", ".github/copilot-instructions.md", ".cursor/rules/hunch.mdc", ".windsurf/rules/hunch.md"]) {
      assert.match(attrs, new RegExp(`^${f.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")} merge=hunch-grounding$`, "m"));
    }
    assert.match(attrs, /^\.hunch\/\*\*\/\*\.json merge=hunch$/m, "existing JSON driver routing is untouched");
    const cfg = (key: string) => execFileSync("git", ["config", "--get", key], { cwd: root, encoding: "utf8" }).trim();
    assert.match(cfg("merge.hunch-grounding.driver"), /merge-driver-grounding/);
    assert.match(cfg("merge.hunch.driver"), /merge-driver/); // still registered, unaffected
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("resolveGroundingConflicts: an ours-side DELETION conflicting with a theirs-side edit is never silently treated as resolved", () => {
  // ours removed the counts line entirely; theirs edited it. A hunk shaped
  // this way has an EMPTY ours side — the regression case where an
  // over-strict marker regex simply failed to match the hunk at all, leaving
  // the raw conflict markers in place while still reporting conflict:false.
  const base = `intro\n${COUNTS_LINE(240)}\noutro\n`;
  const ours = "intro\noutro\n";
  const theirs = `intro\n${COUNTS_LINE(243)}\noutro\n`;
  const text = diff3(base, ours, theirs);
  assert.match(text, /<<<<<<< ours/, "sanity: git actually conflicted here");
  const res = resolveGroundingConflicts(text);
  assert.equal(res.conflict, true, "a deletion-vs-edit hunk is not a counts-only hunk and must stay a real conflict");
  assert.match(res.text, /<<<<<<< ours/, "conflict markers must be visible, never silently dropped");
});

test("resolveGroundingConflicts: CRLF line endings don't defeat marker detection on the happy path", () => {
  const nl = (s: string) => s.replace(/\n/g, "\r\n");
  const base = nl(`intro\n${COUNTS_LINE(240)}\noutro\n`);
  const ours = nl(`intro\n${COUNTS_LINE(241)}\noutro\n`);
  const theirs = nl(`intro\n${COUNTS_LINE(243)}\noutro\n`);
  const text = diff3(base, ours, theirs);
  assert.match(text, /<<<<<<< ours\r?\n/, "sanity: git actually conflicted here");
  const res = resolveGroundingConflicts(text);
  assert.equal(res.conflict, false);
  assert.doesNotMatch(res.text, /<<<<<<</, "no marker may survive into a result reported as resolved");
});

test("mergeGroundingFile: a git-level error (binary content) is never mistaken for diff3 output — never truncates the file", () => {
  const dir = mkdtempSync(join(tmpdir(), "hunch-mergefile-binary-"));
  try {
    const write = (name: string, buf: Buffer) => {
      const p = join(dir, name);
      writeFileSync(p, buf);
      return p;
    };
    const o = write("ours.txt", Buffer.from("intro\nline\x00binary\noutro\n"));
    const b = write("base.txt", Buffer.from("intro\nline\noutro\n"));
    const t = write("theirs.txt", Buffer.from("intro\nedited\noutro\n"));
    const res = mergeGroundingFile(b, o, t);
    assert.equal(res.conflict, true);
    assert.equal(res.write, null, "must never guess content when git itself errored — nothing to write");
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("end-to-end: a real `git merge` with the driver installed auto-resolves a counts-only conflict with no markers left behind", () => {
  const root = mkdtempSync(join(tmpdir(), "hunch-grounding-e2e-clean-"));
  try {
    git(root, "init", "-q", "-b", "main");
    configureRepo(root);
    installMergeDriver(root, cliInvocation);
    const doc = join(root, "CLAUDE.md");
    writeFileSync(doc, `# Project\n<!-- HUNCH:START -->\n${COUNTS_LINE(240)}\n<!-- HUNCH:END -->\n`);
    git(root, "add", "-A"); git(root, "commit", "-q", "-m", "base");
    git(root, "checkout", "-q", "-b", "ours");
    writeFileSync(doc, `# Project\n<!-- HUNCH:START -->\n${COUNTS_LINE(241)}\n<!-- HUNCH:END -->\n`);
    git(root, "commit", "-q", "-am", "ours captures a decision");
    git(root, "checkout", "-q", "main");
    git(root, "checkout", "-q", "-b", "theirs");
    writeFileSync(doc, `# Project\n<!-- HUNCH:START -->\n${COUNTS_LINE(243)}\n<!-- HUNCH:END -->\n`);
    git(root, "commit", "-q", "-am", "theirs captures three decisions");
    git(root, "checkout", "-q", "ours");
    git(root, "merge", "--no-edit", "-q", "theirs");
    assert.equal(git(root, "ls-files", "-u"), "", "the driver must leave nothing unmerged");
    const merged = readFileSync(doc, "utf8");
    assert.doesNotMatch(merged, /<{7}|={7}|>{7}/, "no conflict markers may survive an auto-resolved counts-only conflict");
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("end-to-end: a real `git merge` with the driver installed leaves a genuine conflict for a human — deletion vs. edit is never silently resolved", () => {
  const root = mkdtempSync(join(tmpdir(), "hunch-grounding-e2e-conflict-"));
  try {
    git(root, "init", "-q", "-b", "main");
    configureRepo(root);
    installMergeDriver(root, cliInvocation);
    const doc = join(root, "CLAUDE.md");
    writeFileSync(doc, `# Project\n<!-- HUNCH:START -->\n${COUNTS_LINE(240)}\n<!-- HUNCH:END -->\n`);
    git(root, "add", "-A"); git(root, "commit", "-q", "-m", "base");
    git(root, "checkout", "-q", "-b", "ours");
    writeFileSync(doc, "# Project\n<!-- HUNCH:START -->\n<!-- HUNCH:END -->\n"); // ours deletes the counts line
    git(root, "commit", "-q", "-am", "ours drops the line by hand");
    git(root, "checkout", "-q", "main");
    git(root, "checkout", "-q", "-b", "theirs");
    writeFileSync(doc, `# Project\n<!-- HUNCH:START -->\n${COUNTS_LINE(243)}\n<!-- HUNCH:END -->\n`);
    git(root, "commit", "-q", "-am", "theirs captures three decisions");
    git(root, "checkout", "-q", "ours");
    assert.throws(() => git(root, "merge", "--no-edit", "-q", "theirs"), /Command failed/, "a real conflict must stop the merge, not auto-commit");
    assert.notEqual(git(root, "ls-files", "-u"), "", "the deletion-vs-edit hunk must be left unresolved for a human");
    const onDisk = readFileSync(doc, "utf8");
    assert.match(onDisk, /<{7}|={7}|>{7}/, "conflict markers must be visible on disk, never silently dropped");
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});
