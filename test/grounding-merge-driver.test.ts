import { cleanupDir } from "./fixtures.js";
import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, writeFileSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve as resolvePath } from "node:path";
import { execFileSync } from "node:child_process";
import { fileURLToPath } from "node:url";
import { resolveGroundingConflicts, mergeGroundingFile } from "../src/core/groundingMerge.js";
import { installMergeDriver } from "../src/integrations/mergeDriver.js";
import { hunchAttributesAreSafe } from "../src/core/overlaySafety.js";
import { classifyGroundingBlock } from "../src/core/groundingLag.js";
import { OVERLAY_ATTRIBUTES } from "../tooling/matrix-release-verification.mjs";

const REPO_ROOT = resolvePath(fileURLToPath(import.meta.url), "..", "..");
const CLI = [JSON.stringify(process.execPath), resolvePath(REPO_ROOT, "node_modules", "tsx", "dist", "cli.mjs"), resolvePath(REPO_ROOT, "src", "cli", "index.ts")].join(" ");

function git(cwd: string, ...args: string[]): string {
  return execFileSync("git", args, { cwd, encoding: "utf8" }).trim();
}

function configureRepo(root: string): void {
  git(root, "config", "user.email", "t@example.com");
  git(root, "config", "user.name", "T");
}

function countsLine(n: number): string {
  return `Hunch holds **${n} decisions, 2 bugs, 28 constraints, 21 components, 3 policies** today.`;
}

function diff3(base: string, ours: string, theirs: string): string {
  const dir = mkdtempSync(join(tmpdir(), "hunch-diff3-"));
  try {
    writeFileSync(join(dir, "base"), base);
    writeFileSync(join(dir, "ours"), ours);
    writeFileSync(join(dir, "theirs"), theirs);
    const args = ["merge-file", "-p", "--diff3", "-L", "ours", "-L", "base", "-L", "theirs", join(dir, "ours"), join(dir, "base"), join(dir, "theirs")];
    try {
      return execFileSync("git", args, { encoding: "utf8" });
    } catch (e) {
      const out = (e as { stdout?: string | Buffer }).stdout;
      return out == null ? "" : String(out);
    }
  } finally {
    cleanupDir(dir);
  }
}

test("a clean 3-way merge passes through untouched", () => {
  const text = diff3("a\nb\nc\n", "a\nB\nc\n", "a\nb\nc\n");
  assert.doesNotMatch(text, /^<{7} /m);
  const res = resolveGroundingConflicts(text);
  assert.equal(res.conflict, false);
  assert.equal(res.text, text);
});

test("a counts-only hard conflict resolves to the higher count", () => {
  const text = diff3(
    `intro\n${countsLine(240)}\noutro\n`,
    `intro\n${countsLine(241)}\noutro\n`,
    `intro\n${countsLine(243)}\noutro\n`,
  );
  assert.match(text, /^<{7} ours$/m, "fixture must be a real conflict");
  const res = resolveGroundingConflicts(text);
  assert.equal(res.conflict, false);
  assert.equal(res.text, `intro\n${countsLine(243)}\noutro\n`);
});

test("the resolution is the per-field maximum", () => {
  const sentence = (d: number, b: number) => `Totals **${d} decisions, ${b} bugs, 28 constraints, 21 components, 3 policies** here.`;
  const text = diff3(`x\n${sentence(240, 2)}\ny\n`, `x\n${sentence(241, 5)}\ny\n`, `x\n${sentence(243, 2)}\ny\n`);
  assert.match(text, /^<{7} ours$/m);
  const res = resolveGroundingConflicts(text);
  assert.equal(res.conflict, false);
  assert.equal(res.text, `x\n${sentence(243, 5)}\ny\n`);
});

test("a phantom ahead count is not downgraded to lag", () => {
  const text = diff3(
    `intro\n${countsLine(240)}\noutro\n`,
    `intro\n${countsLine(241)}\noutro\n`,
    `intro\n${countsLine(243)}\noutro\n`,
  );
  const merged = resolveGroundingConflicts(text).text.split("\n")[1]!;
  assert.equal(classifyGroundingBlock(merged, countsLine(242)).kind, "ahead");
});

test("a prose conflict is left alone", () => {
  const text = diff3("intro\nbase prose\noutro\n", "intro\nours prose\noutro\n", "intro\ntheirs prose\noutro\n");
  assert.match(text, /^<{7} ours$/m);
  const res = resolveGroundingConflicts(text);
  assert.equal(res.conflict, true);
  assert.equal(res.text, text);
});

test("a counts hunk beside a prose hunk stays a conflict, unresolved", () => {
  const sep = "s1\ns2\ns3\n";
  const text = diff3(
    `${countsLine(240)}\n${sep}prose base\n`,
    `${countsLine(241)}\n${sep}prose ours\n`,
    `${countsLine(243)}\n${sep}prose theirs\n`,
  );
  assert.equal((text.match(/^<{7} ours$/gm) ?? []).length, 2);
  const res = resolveGroundingConflicts(text);
  assert.equal(res.conflict, true);
  assert.equal(res.text, text);
});

test("installMergeDriver routes the grounding docs to the grounding driver", () => {
  const root = mkdtempSync(join(tmpdir(), "hunch-grounding-route-"));
  try {
    git(root, "init", "-q", "-b", "main");
    installMergeDriver(root, "hunch");
    const attrs = readFileSync(join(root, ".gitattributes"), "utf8");
    assert.equal(attrs, OVERLAY_ATTRIBUTES,
      "Matrix release verification must recognize the exact installed attributes; update its expectation when routing changes");
    for (const p of ["CLAUDE.md", "AGENTS.md", ".github/copilot-instructions.md", ".cursor/rules/hunch.mdc", ".windsurf/rules/hunch.md"]) {
      const escaped = p.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
      assert.match(attrs, new RegExp(`^${escaped} merge=hunch-grounding$`, "m"), p);
    }
    assert.match(attrs, /^\.hunch\/\*\*\/\*\.json merge=hunch$/m);
    assert.ok(git(root, "config", "--get", "merge.hunch-grounding.driver").includes("merge-driver-grounding"));
    assert.ok(git(root, "config", "--get", "merge.hunch.driver").includes("merge-driver"));
  } finally {
    cleanupDir(root);
  }
});

test("an ours-side deletion against a theirs-side edit is never treated as resolved", () => {
  const text = diff3(
    `intro\n${countsLine(240)}\noutro\n`,
    "intro\noutro\n",
    `intro\n${countsLine(243)}\noutro\n`,
  );
  assert.match(text, /^<{7} ours/m);
  const res = resolveGroundingConflicts(text);
  assert.equal(res.conflict, true);
  assert.match(res.text, /^<{7} ours/m);
});

test("CRLF input resolves and keeps its line endings", () => {
  const crlf = (s: string) => s.replace(/\n/g, "\r\n");
  const text = diff3(
    crlf(`intro\n${countsLine(240)}\noutro\n`),
    crlf(`intro\n${countsLine(241)}\noutro\n`),
    crlf(`intro\n${countsLine(243)}\noutro\n`),
  );
  assert.match(text, /^<{7} ours\r?$/m);
  const res = resolveGroundingConflicts(text);
  assert.equal(res.conflict, false);
  assert.doesNotMatch(res.text, /<{7}/);
  assert.equal(res.text.replace(/\r\n/g, "").includes("\n"), false, "resolved CRLF text retains its line endings");
});

test("mergeGroundingFile reports a git-level error without a write", () => {
  const dir = mkdtempSync(join(tmpdir(), "hunch-grounding-bin-"));
  try {
    writeFileSync(join(dir, "ours"), "one\ntw\0o\nthree\n");
    writeFileSync(join(dir, "base"), "one\ntwo\nthree\n");
    writeFileSync(join(dir, "theirs"), "one\nTWO\nthree\n");
    const res = mergeGroundingFile(join(dir, "base"), join(dir, "ours"), join(dir, "theirs"));
    assert.equal(res.conflict, true);
    assert.equal(res.write, null);
  } finally {
    cleanupDir(dir);
  }
});

function setupRepo(root: string, oursBody: string): void {
  git(root, "init", "-q", "-b", "main");
  configureRepo(root);
  installMergeDriver(root, CLI);
  const doc = (body: string) => `# Project\n<!-- HUNCH:START -->\n${body}<!-- HUNCH:END -->\n`;
  writeFileSync(join(root, "CLAUDE.md"), doc(`${countsLine(240)}\n`));
  git(root, "add", "-A");
  git(root, "commit", "-q", "-m", "base");
  git(root, "checkout", "-q", "-b", "ours");
  writeFileSync(join(root, "CLAUDE.md"), doc(oursBody));
  git(root, "commit", "-qam", "ours");
  git(root, "checkout", "-q", "main");
  git(root, "checkout", "-q", "-b", "theirs");
  writeFileSync(join(root, "CLAUDE.md"), doc(`${countsLine(243)}\n`));
  git(root, "commit", "-qam", "theirs");
  git(root, "checkout", "-q", "ours");
}

test("end to end: git auto-resolves a counts-only conflict", () => {
  const root = mkdtempSync(join(tmpdir(), "hunch-grounding-e2e-"));
  try {
    setupRepo(root, `${countsLine(241)}\n`);
    git(root, "merge", "--no-edit", "-q", "theirs");
    assert.equal(git(root, "ls-files", "-u"), "");
    const merged = readFileSync(join(root, "CLAUDE.md"), "utf8");
    assert.doesNotMatch(merged, /<{7}|={7}|>{7}/);
  } finally {
    cleanupDir(root);
  }
});

test("end to end: a genuine conflict still stops the merge", () => {
  const root = mkdtempSync(join(tmpdir(), "hunch-grounding-e2e-conflict-"));
  try {
    setupRepo(root, "");
    assert.throws(() => git(root, "merge", "--no-edit", "-q", "theirs"), /Command failed/);
    assert.notEqual(git(root, "ls-files", "-u"), "");
    assert.match(readFileSync(join(root, "CLAUDE.md"), "utf8"), /<{7}/);
  } finally {
    cleanupDir(root);
  }
});

test("installed grounding attributes permit private capture without permitting arbitrary transforms", () => {
  const root = mkdtempSync(join(tmpdir(), "hunch-grounding-attribute-safety-"));
  try {
    git(root, "init", "-q");
    installMergeDriver(root, "hunch");
    const attrs = readFileSync(join(root, ".gitattributes"), "utf8");
    assert.equal(hunchAttributesAreSafe(attrs), true, "the installer's exact rules must allow private capture");
    for (const unsafe of [
      "*.json merge=hunch-grounding", "AGENTS.md filter=evil", "AGENTS.md merge=evil",
      "AGENTS.md merge=hunch-grounding filter=evil", "*.json text eol=crlf",
      "AGENTS.md working-tree-encoding=UTF-16", "*.md merge=hunch-grounding",
    ]) assert.equal(hunchAttributesAreSafe(attrs + unsafe + "\n"), false, unsafe);
  } finally { cleanupDir(root); }
});
