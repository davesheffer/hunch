import { test } from "node:test";
import assert from "node:assert/strict";
import { execFileSync, spawnSync } from "node:child_process";
import { mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { cleanupDir, isolatedCliEnv, tempDir } from "./fixtures.js";

/** `hunch init` prints a short summary with one next step; `--details` prints every
 *  step and the integration matrix. Warnings print in both. */
function fixture(gitignore?: string) {
  const dir = tempDir("hunch-init-output-");
  const repo = join(dir, "repo"), home = join(dir, "home");
  mkdirSync(join(repo, "src"), { recursive: true });
  mkdirSync(home, { recursive: true });
  const env = isolatedCliEnv({ HUNCH_PRIVATE_DIR: "", HUNCH_EMBEDDINGS: "off", HOME: home, USERPROFILE: home, XDG_CONFIG_HOME: join(home, ".config"), GIT_CONFIG_NOSYSTEM: "1", NO_COLOR: "1", PATH: process.env.PATH });
  const git = (...args: string[]) => execFileSync("git", args, { cwd: repo, env, encoding: "utf8", stdio: "pipe" });
  git("init", "-q", "-b", "main");
  git("config", "user.email", "fixture@example.invalid");
  git("config", "user.name", "Fixture");
  writeFileSync(join(repo, "src/app.ts"), "export function app() { return 1; }\n");
  if (gitignore) writeFileSync(join(repo, ".gitignore"), gitignore);
  git("add", "-A");
  git("commit", "-qm", "fixture");
  const init = (...args: string[]) => spawnSync(process.execPath, [join(process.cwd(), "node_modules/tsx/dist/cli.mjs"), join(process.cwd(), "src/cli/index.ts"), "init", "--no-agent-hooks", ...args], { cwd: repo, env, encoding: "utf8", timeout: 120_000 });
  return { dir, init };
}

test("hunch init prints a short summary with one next step", () => {
  const { dir, init } = fixture();
  try {
    const run = init();
    assert.equal(run.status, 0, run.stdout + run.stderr);
    assert.match(run.stdout, /Hunch is set up in /);
    assert.match(run.stdout, /code index: indexed committed HEAD \(1 files/);
    assert.match(run.stdout, /\nNext: reload your assistant/);
    assert.match(run.stdout, /hunch init --details/);
    assert.doesNotMatch(run.stdout, /untested/, "the integration matrix moved to --details");
    assert.doesNotMatch(run.stdout, /⚠/, "a clean repository has no warnings");
    assert.ok(run.stdout.trim().split("\n").length <= 10, run.stdout);
  } finally {
    cleanupDir(dir);
  }
});

test("hunch init --details prints every step and the integration matrix", () => {
  const { dir, init } = fixture();
  try {
    const run = init("--details");
    assert.equal(run.status, 0, run.stdout + run.stderr);
    assert.match(run.stdout, /Initializing Hunch at /);
    assert.match(run.stdout, /✓ \.hunch\/ scaffolded/);
    assert.match(run.stdout, /Hunch integrations — expected/);
    assert.doesNotMatch(run.stdout, /\nNext: reload your assistant/);
  } finally {
    cleanupDir(dir);
  }
});

test("hunch init warns when the repository's .gitignore keeps memory out of Git", () => {
  const { dir, init } = fixture("node_modules/\n.hunch/\n");
  try {
    const run = init();
    assert.equal(run.status, 0, run.stdout + run.stderr);
    assert.match(run.stdout, /⚠ \.gitignore line 2 \(`\.hunch\/`\) ignores \.hunch\/, so captured memory is never committed or shared/);
  } finally {
    cleanupDir(dir);
  }
});
