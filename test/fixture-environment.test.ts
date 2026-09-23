import { test } from "node:test";
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { realpathSync, rmSync, rmdirSync, symlinkSync } from "node:fs";
import { join } from "node:path";
import { detectInitiator } from "../src/synthesis/initiator.js";
import { cleanupDir, isolatedCliEnv, tempDir } from "./helpers.js";
import { fixtureGitEnv, fixtureGitSystemConfig } from "../tooling/run-tests.mjs";
import { foreignRepoEnv } from "../src/extractors/git.js";

test("fixture CLI environment drops every inherited initiator and preserves explicit fixture choices", () => {
  const inherited = { CLAUDECODE: "1", CODEX_THREAD_ID: "thread", CODEX_SESSION_ID: "session", HUNCH_INITIATOR: "claude-cli", HUNCH_SYNTH_PROVIDER: "claude-cli", PATH: "fixture-bin" };
  const env = isolatedCliEnv({ HUNCH_SYNTH_PROVIDER: "codex-cli" }, inherited);
  assert.deepEqual(detectInitiator(env), { provider: null, source: "unknown" });
  assert.equal(env.HUNCH_SYNTH_PROVIDER, "codex-cli");
  assert.equal(env.PATH, inherited.PATH);
  assert.equal(isolatedCliEnv({}, inherited).HUNCH_SYNTH_PROVIDER, "deterministic");
  assert.equal(inherited.HUNCH_INITIATOR, "claude-cli", "never mutate the host environment");
});

test("fixture roots resolve a symlinked temporary parent before git reports their paths", () => {
  const root = tempDir("hunch-canonical-fixture-");
  try {
    assert.equal(root, realpathSync.native(root), "expand Windows short-name aliases as Git does");
    const alias = join(root, "alias");
    symlinkSync(root, alias, process.platform === "win32" ? "junction" : "dir");
    const child = tempDir("child-", alias);
    assert.equal(child, realpathSync.native(child));
    assert.ok(child.startsWith(root));
    assert.ok(!child.includes("alias"));
  } finally { cleanupDir(root); }
});

test("the test runner disables Git background maintenance without losing inherited config", () => {
  const inherited = { ...process.env, GIT_CONFIG_COUNT: "2", GIT_CONFIG_KEY_0: "user.name", GIT_CONFIG_VALUE_0: "Fixture Human", GIT_CONFIG_KEY_1: "gc.auto", GIT_CONFIG_VALUE_1: "999" };
  const env = fixtureGitEnv(inherited);
  assert.equal(env.GIT_CONFIG_COUNT, "3");
  assert.equal(env.GIT_CONFIG_KEY_0, "user.name");
  assert.equal(env.GIT_CONFIG_VALUE_1, "0");
  assert.equal(env.GIT_CONFIG_KEY_2, "maintenance.auto");
  assert.equal(env.GIT_CONFIG_VALUE_2, "false");
  assert.deepEqual(fixtureGitEnv(env), env, "adding the fixture settings twice is idempotent");
  assert.equal(inherited.GIT_CONFIG_VALUE_1, "999", "the parent environment is untouched");

  const root = tempDir("hunch-git-maintenance-");
  try {
    execFileSync("git", ["init", "-q", root], { env });
    assert.equal(execFileSync("git", ["config", "--get", "gc.auto"], { cwd: root, env, encoding: "utf8" }).trim(), "0");
    assert.equal(execFileSync("git", ["config", "--get", "maintenance.auto"], { cwd: root, env, encoding: "utf8" }).trim(), "false");
  } finally { cleanupDir(root); }
});

test("fixture Git settings survive Hunch's Git environment sanitization", () => {
  const root = tempDir("hunch-test-global-git-");
  const original = join(root, "original.gitconfig");
  execFileSync("git", ["config", "--file", original, "user.name", "Original Human"]);
  const config = fixtureGitSystemConfig();
  try {
    const repo = join(root, "repo");
    const env = fixtureGitEnv({ ...process.env, GIT_CONFIG_GLOBAL: original, GIT_CONFIG_SYSTEM: config.file });
    delete env.GIT_CONFIG_NOSYSTEM;
    execFileSync("git", ["init", "-q", repo], { env });
    const sanitized = foreignRepoEnv(env);
    assert.equal(sanitized.GIT_CONFIG_COUNT, undefined, "product Git calls strip runtime pairs");
    assert.equal(sanitized.GIT_CONFIG_SYSTEM, config.file, "the test-only system config survives");
    assert.equal(sanitized.GIT_CONFIG_GLOBAL, original, "fixture global config remains independent");
    const get = (key: string) => execFileSync("git", ["config", "--get", key], { cwd: repo, env: sanitized, encoding: "utf8" }).trim();
    assert.equal(get("user.name"), "Original Human", "the developer's existing global settings remain available");
    assert.equal(get("gc.auto"), "0");
    assert.equal(get("maintenance.auto"), "false");
  } finally {
    rmSync(config.file, { force: true });
    rmdirSync(config.dir);
    cleanupDir(root);
  }
});
