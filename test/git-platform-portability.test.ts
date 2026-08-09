import assert from "node:assert/strict";
import { execFileSync, spawnSync } from "node:child_process";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";

import { commitAndPushHunch, gitNullDevice } from "../src/extractors/git.js";
import { dirtyIndexedCodePaths, repoSourceInventory } from "../src/extractors/repoSource.js";

function git(cwd: string, ...args: string[]): string {
  return execFileSync("git", args, {
    cwd,
    encoding: "utf8",
    env: {
      ...process.env,
      GIT_CONFIG_GLOBAL: gitNullDevice(),
      GIT_CONFIG_NOSYSTEM: "1",
      GIT_TERMINAL_PROMPT: "0",
    },
    stdio: ["ignore", "pipe", "pipe"],
  }).trim();
}

function configureRepo(root: string): void {
  git(root, "config", "user.name", "Platform Portability Test");
  git(root, "config", "user.email", "platform-portability@test.invalid");
  git(root, "config", "commit.gpgsign", "false");
}

test("the platform Git null device is accepted as the global config path", () => {
  const root = mkdtempSync(join(tmpdir(), "hunch-git-null-device-"));
  try {
    git(root, "init", "-q");
    const probe = spawnSync("git", ["-C", root, "config", "--list"], {
      encoding: "utf8",
      env: {
        ...process.env,
        GIT_CONFIG_GLOBAL: gitNullDevice(),
        GIT_CONFIG_NOSYSTEM: "1",
      },
    });
    assert.equal(probe.error, undefined, probe.error?.message);
    assert.equal(probe.status, 0, `${probe.stdout ?? ""}${probe.stderr ?? ""}`);
    assert.equal(gitNullDevice(), process.platform === "win32" ? "NUL" : "/dev/null");
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("a standalone overlay commits and pushes one contained JSON record on this platform", () => {
  const base = mkdtempSync(join(tmpdir(), "hunch-git-platform-push-"));
  try {
    const seed = join(base, "seed");
    const remote = join(base, "memory.git");
    const overlay = join(base, "overlay");
    const code = join(base, "code");
    mkdirSync(code);
    git(code, "init", "-q", "-b", "main");
    configureRepo(code);
    writeFileSync(join(code, "app.ts"), "export const publicCode = true;\n");
    git(code, "add", "app.ts");
    git(code, "commit", "-qm", "fixture: protected code");
    mkdirSync(seed);
    git(seed, "init", "-q", "-b", "main");
    configureRepo(seed);
    writeFileSync(join(seed, "README.md"), "# Shared memory\n");
    git(seed, "add", "README.md");
    git(seed, "commit", "-qm", "fixture: seed shared memory");
    git(base, "clone", "-q", "--bare", seed, remote);
    git(base, "clone", "-q", remote, overlay);
    configureRepo(overlay);

    const record = join(overlay, ".hunch", "decisions", "dec_platform_portability.json");
    mkdirSync(join(overlay, ".hunch", "decisions"), { recursive: true });
    writeFileSync(record, "{\"id\":\"dec_platform_portability\"}\n");

    const result = commitAndPushHunch(join(overlay, ".hunch"), "hunch: platform portability", {
      push: true,
      protectedRepoRoot: code,
    });

    assert.equal(result, "pushed");
    assert.equal(git(overlay, "status", "--porcelain=v1", "--untracked-files=all"), "");
    assert.equal(existsSync(join(overlay, ".hunch", ".hunch-commit.lock")), false);
    assert.match(execFileSync("git", [
      "--git-dir", remote,
      "show", "main:.hunch/decisions/dec_platform_portability.json",
    ], { encoding: "utf8" }), /dec_platform_portability/);
  } finally {
    rmSync(base, { recursive: true, force: true });
  }
});

test("overlay publication rejects a redirected Git info attributes parent", () => {
  const base = mkdtempSync(join(tmpdir(), "hunch-git-info-redirect-"));
  try {
    const overlay = join(base, "overlay");
    const externalInfo = join(base, "external-info");
    mkdirSync(overlay);
    mkdirSync(externalInfo);
    git(overlay, "init", "-q", "-b", "main");
    configureRepo(overlay);
    mkdirSync(join(overlay, ".hunch", "decisions"), { recursive: true });
    writeFileSync(join(overlay, ".hunch", "decisions", "dec_redirect.json"),
      "{\"id\":\"dec_redirect\"}\n");
    writeFileSync(join(externalInfo, "attributes"), ".hunch/**/*.json merge=hunch\n");
    rmSync(join(overlay, ".git", "info"), { recursive: true, force: true });
    symlinkSync(externalInfo, join(overlay, ".git", "info"), process.platform === "win32" ? "junction" : "dir");

    const result = commitAndPushHunch(join(overlay, ".hunch"), "hunch: redirected attributes", {
      push: true,
      protectedRepoRoot: base,
    });

    assert.equal(result, null);
    assert.equal(git(overlay, "rev-list", "--all", "--count"), "0", "no memory commit is created");
    assert.equal(git(overlay, "diff", "--cached", "--name-only"), "", "refusal happens before staging");
    assert.equal(readFileSync(join(externalInfo, "attributes"), "utf8"), ".hunch/**/*.json merge=hunch\n");
  } finally {
    rmSync(base, { recursive: true, force: true });
  }
});

test("Git-backed source inventories and dirty-code guards stay active on this platform", () => {
  const root = mkdtempSync(join(tmpdir(), "hunch-repo-source-platform-"));
  try {
    mkdirSync(join(root, "src"), { recursive: true });
    git(root, "init", "-q", "-b", "main");
    configureRepo(root);
    writeFileSync(join(root, "src", "app.ts"), "export const platformValue = 1;\n");
    git(root, "add", "src/app.ts");
    git(root, "commit", "-qm", "fixture: committed source");

    const committed = repoSourceInventory(root, { kind: "commit", ref: "HEAD" });
    assert.match(committed.identity.revision ?? "", /^[0-9a-f]{40,64}$/i);
    const committedEntry = committed.entries.find((entry) => entry.path === "src/app.ts");
    assert.ok(committedEntry);
    assert.match(committedEntry.read().source ?? "", /platformValue = 1/);

    writeFileSync(join(root, "src", "app.ts"), "export const platformValue = 2;\n");
    assert.deepEqual(dirtyIndexedCodePaths(root), ["src/app.ts"]);
    git(root, "add", "src/app.ts");
    const staged = repoSourceInventory(root, { kind: "staged" });
    const stagedEntry = staged.entries.find((entry) => entry.path === "src/app.ts");
    assert.ok(stagedEntry);
    assert.match(stagedEntry.read().source ?? "", /platformValue = 2/);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});
