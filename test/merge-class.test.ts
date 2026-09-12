import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";

import { changedPaths, classifyChange, classifyPath, renderText } from "../tooling/merge-class.mjs";

test("the bounded class is a path allowlist: docs, tests, memory captures, locale copies", () => {
  assert.equal(classifyPath("docs/task-reports.md").group, "docs");
  assert.equal(classifyPath("README.md").group, "docs");
  assert.equal(classifyPath("test/merge-class.test.ts").group, "tests");
  assert.equal(classifyPath("test/fixtures/repo/a.ts").group, "tests");
  assert.equal(classifyPath(".hunch/decisions/dec_0123456789.json").group, "memory");
  assert.equal(classifyPath("site/changelog.html").group, "locales");
  assert.equal(classifyPath("site/he/changelog.html").group, "locales");
  assert.equal(classifyPath("site/blog/posts.html").group, "locales");
  for (const path of [".github/copilot-instructions.md", ".cursor/rules/hunch.mdc", ".windsurf/rules/hunch.md"]) assert.equal(classifyPath(path).group, "memory", `${path} is a generated grounding block`);
  assert.equal(classifyPath(".github/workflows/hunch-guard.yml").group, "outside", "workflows stay outside");
  assert.equal(classifyPath(".github/other.md").group, "outside", "only the named grounding file under .github/ is inside");
});

test("anything the allowlist does not name is outside, and the never-rung paths are outside regardless", () => {
  for (const path of [
    "src/cli/index.ts", "tooling/merge-class.mjs", "vscode-extension/package.json",
    ".github/workflows/hunch-guard.yml", "package.json", "package-lock.json",
    ".hunch/config.json", ".hunch/local.json", ".hunch/team.json", ".hunch/pending-commit-repairs.json",
    "docs/diagram.png", "site/dna-hero.js", "bench/run.ts", "Dockerfile",
  ]) assert.equal(classifyPath(path).group, "outside", path);
  assert.equal(classifyPath("./docs/x.md").group, "docs", "a leading ./ is normalized");
  assert.equal(classifyPath("docs\\x.md").group, "docs", "backslashes are normalized");
});

test("a change is bounded only when every file is inside; one outside file makes the whole change outside; empty is outside", () => {
  const bounded = classifyChange(["docs/a.md", "test/a.test.ts", ".hunch/findings/fnd_1.json"]);
  assert.equal(bounded.class, "bounded");
  assert.deepEqual(bounded.groups, ["docs", "memory", "tests"]);
  assert.deepEqual(bounded.outside, []);
  const mixed = classifyChange(["docs/a.md", "src/core/io.ts"]);
  assert.equal(mixed.class, "outside");
  assert.deepEqual(mixed.outside, ["src/core/io.ts"]);
  assert.match(renderText(mixed), /✗ src\/core\/io\.ts \[outside\]/);
  assert.match(renderText(mixed), /1 file\(s\) outside the bounded class/);
  assert.equal(classifyChange([]).class, "outside");
  assert.equal(classifyChange(["docs/a.md", "docs/a.md", " "]).files.length, 1, "duplicates and blanks are dropped");
});

test("changedPaths reads the base...HEAD diff of a real repository", () => {
  const repo = mkdtempSync(join(tmpdir(), "hunch-merge-class-"));
  try {
    const git = (...args: string[]) => execFileSync("git", args, { cwd: repo, encoding: "utf8" });
    git("init", "-q", "-b", "main");
    git("config", "user.email", "test@example.com");
    git("config", "user.name", "Test");
    mkdirSync(join(repo, "docs"));
    writeFileSync(join(repo, "docs", "a.md"), "a\n");
    git("add", "."); git("commit", "-q", "-m", "init");
    git("checkout", "-q", "-b", "topic");
    writeFileSync(join(repo, "docs", "b.md"), "b\n");
    mkdirSync(join(repo, "src"));
    writeFileSync(join(repo, "src", "x.ts"), "export {};\n");
    git("add", "."); git("commit", "-q", "-m", "topic");
    const paths = changedPaths("main", repo);
    assert.deepEqual(paths.sort(), ["docs/b.md", "src/x.ts"]);
    const result = classifyChange(paths);
    assert.equal(result.class, "outside");
    assert.deepEqual(result.outside, ["src/x.ts"]);
    const cli = execFileSync("node", [join(process.cwd(), "tooling", "merge-class.mjs"), "--base", "main", "--cwd", repo, "--json"], { encoding: "utf8" });
    assert.equal(JSON.parse(cli).class, "outside");
    let code = 0;
    try { execFileSync("node", [join(process.cwd(), "tooling", "merge-class.mjs"), "--base", "main", "--cwd", repo, "--require-bounded"], { encoding: "utf8", stdio: "pipe" }); }
    catch (error) { code = (error as { status: number }).status; }
    assert.equal(code, 1, "--require-bounded fails an outside change");
  } finally { rmSync(repo, { recursive: true, force: true }); }
});
