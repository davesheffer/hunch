import { cleanupDir } from "./fixtures.js";
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";

import { MEMORY_GRAPH_TESTS, changedPaths, classifyChange, classifyPath, renderText } from "../tooling/merge-class.mjs";

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
    ".hunch/publication.json", ".hunch/publication.local.json", ".hunch/sub/any.local.json",
    "docs/diagram.png", "site/dna-hero.js", "bench/run.ts", "Dockerfile",
  ]) assert.equal(classifyPath(path).group, "outside", path);
  assert.equal(classifyPath("./docs/x.md").group, "docs", "a leading ./ is normalized");
  assert.equal(classifyPath("docs\\x.md").group, "docs", "backslashes are normalized");
  for (const path of [".hunch\\..\\src\\x.ts", ".hunch/../src/x.ts", "docs/./x.md"]) assert.equal(classifyPath(path).group, "outside", `${path} escapes its prefix`);
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

test("memory-only is graph records plus the grounding docs a capture regenerates, nothing else", () => {
  const records = classifyChange([".hunch/findings/fnd_1.json", ".hunch/tasks/htask_1.json", "CLAUDE.md", "AGENTS.md", ".github/copilot-instructions.md"]);
  assert.equal(records.memory_only, true);
  assert.equal(records.class, "bounded");
  assert.match(renderText(records), /· memory-only/);
  assert.equal(classifyChange([".hunch/decisions/dec_1.json", "docs/a.md"]).memory_only, false, "a doc beside a record is bounded, not memory-only");
  assert.equal(classifyChange([".hunch/decisions/dec_1.json", "test/a.test.ts"]).memory_only, false, "a test change must run the tests");
  assert.equal(classifyChange([".hunch/config.json"]).memory_only, false, "store configuration is outside");
  assert.equal(classifyChange([".hunch/pending-commit-repairs.json"]).memory_only, false);
  assert.equal(classifyChange([".hunch/decisions/dec_1.json", "src/core/io.ts"]).memory_only, false);
  assert.equal(classifyChange([]).memory_only, false, "an empty change earns no fast path");
});

test("every test that reads this repo's committed graph or grounding docs runs on the memory-only fast path", () => {
  // A test that reads the repo's own .hunch/ or grounding docs is what a memory-only
  // change can break; one missing from MEMORY_GRAPH_TESTS would let such a change
  // merge on the fast path without it.
  const readsRepoGraph = (source: string) =>
    (/fileURLToPath\(import\.meta\.url\)[^;]*"\.\."/.test(source) || /resolve\(['"]\.hunch\//.test(source) || /process\.cwd\(\),\s*['"](?:\.hunch|CLAUDE\.md|AGENTS\.md)/.test(source))
    && /\.hunch|CLAUDE\.md|AGENTS\.md/.test(source);
  const found = readdirSync("test").filter((name) => name.endsWith(".test.ts") && name !== "merge-class.test.ts")
    .filter((name) => readsRepoGraph(readFileSync(join("test", name), "utf8")))
    .map((name) => `test/${name}`).sort();
  assert.deepEqual(found, [...MEMORY_GRAPH_TESTS].sort());
});

test("changedPaths lists both sides of a rename, so a moved source file cannot hide inside the class", () => {
  const repo = mkdtempSync(join(tmpdir(), "hunch-merge-class-rename-"));
  try {
    const git = (...args: string[]) => execFileSync("git", args, { cwd: repo, encoding: "utf8" });
    git("init", "-q", "-b", "main");
    git("config", "user.email", "test@example.com");
    git("config", "user.name", "Test");
    mkdirSync(join(repo, "src"));
    writeFileSync(join(repo, "src", "x.ts"), "export const x = 1;\n".repeat(20));
    git("add", "."); git("commit", "-q", "-m", "init");
    git("checkout", "-q", "-b", "topic");
    mkdirSync(join(repo, ".hunch"));
    git("mv", "src/x.ts", ".hunch/x.json");
    git("commit", "-q", "-m", "move");
    const result = classifyChange(changedPaths("main", repo));
    assert.deepEqual(result.outside, ["src/x.ts"]);
    assert.equal(result.class, "outside");
    assert.equal(result.memory_only, false);
  } finally { cleanupDir(repo); }
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
    code = 0;
    try { execFileSync("node", [join(process.cwd(), "tooling", "merge-class.mjs"), "--base", "main", "--cwd", repo, "--require-memory-only"], { encoding: "utf8", stdio: "pipe" }); }
    catch (error) { code = (error as { status: number }).status; }
    assert.equal(code, 1, "--require-memory-only fails a change that is not memory-only");
    git("checkout", "-q", "main");
    git("checkout", "-q", "-b", "memory");
    mkdirSync(join(repo, ".hunch", "findings"), { recursive: true });
    writeFileSync(join(repo, ".hunch", "findings", "fnd_1.json"), "{}\n");
    writeFileSync(join(repo, "CLAUDE.md"), "grounding\n");
    git("add", "."); git("commit", "-q", "-m", "memory");
    execFileSync("node", [join(process.cwd(), "tooling", "merge-class.mjs"), "--base", "main", "--cwd", repo, "--require-memory-only"], { encoding: "utf8", stdio: "pipe" });
  } finally { cleanupDir(repo); }
});
