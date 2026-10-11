/**
 * #427: `hunch shared --repo <url>` against a brand-new EMPTY memory repository asks the
 * user to commit .hunch/team.json, and the strict pre-commit (`hunch init --enforce-strict`)
 * then refused that very commit ("could not refresh the advertised team memory
 * (unconfigured); refusing a stale pass"). An empty remote and a clone that never
 * committed memory are provably in sync — there is nothing to be stale against — so the
 * strict guard passes. A clone that HAS memory against an empty remote (unpublished, or a
 * remote that lost its history) still fails closed, now pointing at `hunch shared --sync`.
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import { execFileSync, spawnSync } from "node:child_process";
import { mkdirSync, mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { cleanupDir } from "./helpers.js";
import { hunchCliArgs } from "./cli-invocation.js";

function env(home: string): NodeJS.ProcessEnv {
  mkdirSync(home, { recursive: true });
  return {
    ...process.env,
    HOME: home,
    USERPROFILE: home,
    XDG_CONFIG_HOME: join(home, ".config"),
    GIT_CONFIG_NOSYSTEM: "1",
    GIT_TERMINAL_PROMPT: "0",
    GIT_AUTHOR_NAME: "Empty Remote",
    GIT_AUTHOR_EMAIL: "empty-remote@test.invalid",
    GIT_COMMITTER_NAME: "Empty Remote",
    GIT_COMMITTER_EMAIL: "empty-remote@test.invalid",
    HUNCH_PRIVATE_DIR: "",
    HUNCH_SYNTH_PROVIDER: "deterministic",
    HUNCH_EMBEDDINGS: "off",
    NO_COLOR: "1",
    CI: "1",
  };
}

function git(cwd: string, e: NodeJS.ProcessEnv, ...args: string[]) {
  return spawnSync("git", args, { cwd, env: e, encoding: "utf8", timeout: 60_000 });
}

function hunch(cwd: string, e: NodeJS.ProcessEnv, ...args: string[]) {
  const run = spawnSync(process.execPath, hunchCliArgs(...args), { cwd, env: e, encoding: "utf8", timeout: 60_000 });
  return { status: run.status, out: `${run.stdout ?? ""}${run.stderr ?? ""}` };
}

function bareRefs(remote: string): string {
  return execFileSync("git", ["--git-dir", remote, "for-each-ref", "--format=%(refname)"], { encoding: "utf8" }).trim();
}

function fixture(base: string): { root: string; memory: string; e: NodeJS.ProcessEnv } {
  const e = env(join(base, "home"));
  const root = join(base, "code");
  const memory = join(base, "memory.git");
  mkdirSync(join(root, "src"), { recursive: true });
  assert.equal(git(base, e, "init", "-q", "--bare", "-b", "main", memory).status, 0);
  assert.equal(git(root, e, "init", "-q", "-b", "main").status, 0);
  git(root, e, "config", "commit.gpgsign", "false");
  writeFileSync(join(root, "src/app.ts"), "export const ok = 1;\n");
  git(root, e, "add", "-A");
  assert.equal(git(root, e, "commit", "-qm", "base").status, 0);
  return { root, memory, e };
}

test("#427: first-time shared setup on an empty memory repo is committable under --enforce-strict", { timeout: 180_000 }, () => {
  const base = mkdtempSync(join(tmpdir(), "hunch-empty-shared-strict-"));
  try {
    const { root, memory, e } = fixture(base);
    const init = hunch(root, e, "init", "--enforce-strict", "--no-index", "--no-providers", "--no-agent-hooks");
    assert.equal(init.status, 0, init.out);
    git(root, e, "add", "-A");
    const initCommit = git(root, e, "commit", "-qm", "chore: hunch init");
    assert.equal(initCommit.status, 0, `${initCommit.stdout}${initCommit.stderr}`);

    const setup = hunch(root, e, "shared", "--repo", memory, "--no-hook");
    assert.equal(setup.status, 0, setup.out);
    assert.match(setup.out, /published \.hunch\/team\.json \(commit it\)/);
    assert.equal(bareRefs(memory), "", "setup alone still does not invent a memory commit");

    const check = hunch(root, e, "check", "--staged", "--strict");
    assert.equal(check.status, 0, `strict check must not call an empty-but-in-sync team memory stale:\n${check.out}`);
    assert.doesNotMatch(check.out, /refusing a stale pass/);
    assert.match(check.out, /no published branch yet; this strict check ran with no team rules/, "the vacuous pass is never silent");

    // The real strict pre-commit guard accepts the commit `hunch shared` asked for.
    git(root, e, "add", ".gitignore", ".hunch/team.json");
    const advertised = git(root, e, "commit", "-m", "hunch: share team memory");
    const out = `${advertised.stdout}${advertised.stderr}`;
    assert.equal(advertised.status, 0, out);
    assert.doesNotMatch(out, /refusing a stale pass/);
    assert.match(out, /no published branch yet/, `the strict pre-commit hook must actually have run:
${out}`);
  } finally {
    cleanupDir(base);
  }
});

test("#427: a clone WITH memory against an empty remote still fails strict closed and names `hunch shared --sync`", { timeout: 180_000 }, () => {
  const base = mkdtempSync(join(tmpdir(), "hunch-empty-shared-unpublished-"));
  try {
    const { root, memory, e } = fixture(base);
    const setup = hunch(root, e, "shared", "--repo", memory, "--no-hook", "--no-auto-commit");
    assert.equal(setup.status, 0, setup.out);
    const overlay = join(root, ".hunch-private");
    // Memory committed in the overlay but never published: the remote is still empty.
    writeFileSync(join(overlay, ".hunch", "unpublished.json"), "{}\n");
    git(overlay, e, "add", "-A");
    assert.equal(git(overlay, e, "-c", "core.hooksPath=", "commit", "-qm", "local memory").status, 0);
    assert.equal(bareRefs(memory), "");

    const refused = hunch(root, e, "check", "--staged", "--strict");
    assert.notEqual(refused.status, 0, refused.out);
    assert.match(refused.out, /\(unconfigured\); refusing a stale pass/);
    assert.match(refused.out, /hunch shared --sync/);

    const synced = hunch(root, e, "shared", "--sync");
    assert.equal(synced.status, 0, synced.out);
    assert.notEqual(bareRefs(memory), "", "--sync publishes the overlay");
    const passed = hunch(root, e, "check", "--staged", "--strict");
    assert.equal(passed.status, 0, passed.out);
  } finally {
    cleanupDir(base);
  }
});
