import { test } from "node:test";
import assert from "node:assert/strict";
import { cpSync, mkdirSync, readFileSync, symlinkSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { execFileSync, spawnSync } from "node:child_process";
import { installPostCommitHook } from "../src/integrations/hooks.js";
import { cleanupDir, isolatedCliEnv, tempDir } from "./fixtures.js";

for (const commit of [false, true]) test(`linked init preserves shared auto-commit=${commit} and reports the effective setting`, () => {
  const base = tempDir("hunch-init-shared-");
  const main = join(base, "main"), wt = join(base, "linked"), home = join(base, "home");
  const env = isolatedCliEnv({ HUNCH_PRIVATE_DIR: "", HUNCH_EMBEDDINGS: "off", HOME: home, USERPROFILE: home, XDG_CONFIG_HOME: join(home, ".config"), GIT_CONFIG_NOSYSTEM: "1", HUNCH_SYNC: "1", NO_COLOR: "1" });
  const git = (...args: string[]) => execFileSync("git", args, { cwd: main, env, encoding: "utf8", stdio: "pipe" });
  try {
    mkdirSync(main); mkdirSync(home);
    git("init", "-q", "-b", "main");
    git("config", "user.name", "Fixture"); git("config", "user.email", "fixture@test.invalid"); git("config", "commit.gpgsign", "false");
    writeFileSync(join(main, "README.md"), "fixture\n");
    git("add", "-A"); git("commit", "-qm", "fixture");
    git("worktree", "add", "-q", "-b", "linked", wt);
    // Execute an actual worktree-local CLI; an external launcher intentionally
    // has authority to rewrite the shared block and would not reproduce #357.
    cpSync(join(process.cwd(), "src"), join(wt, "src"), { recursive: true });
    writeFileSync(join(wt, "package.json"), '{"type":"module","version":"0.0.0"}\n');
    symlinkSync(join(process.cwd(), "node_modules"), join(wt, "node_modules"), process.platform === "win32" ? "junction" : "dir");
    const entry = join(base, "global", "cli", "index.js");
    mkdirSync(join(base, "global", "cli"), { recursive: true }); writeFileSync(entry, "// never executed\n");
    installPostCommitHook(main, `${JSON.stringify(process.execPath)} ${JSON.stringify(entry)}`, { commit });
    const hook = join(main, ".git", "hooks", "post-commit");
    const before = readFileSync(hook, "utf8");
    const run = spawnSync(process.execPath, [join(process.cwd(), "node_modules/tsx/dist/cli.mjs"), join(wt, "src/cli/index.ts"), "init", "--no-index", "--no-providers", "--no-agent-hooks", "--no-enforce", ...(commit ? ["--no-auto-commit"] : [])], { cwd: wt, env, encoding: "utf8", timeout: 60_000 });
    const output = `${run.stdout}${run.stderr}`;
    assert.equal(run.status, 0, output);
    assert.equal(readFileSync(hook, "utf8"), before, "a linked init must not add a default flag or remove an existing one");
    if (commit) {
      assert.doesNotMatch(output, /✓ auto-commit OFF \(captures stay uncommitted/);
      assert.match(output, /shared post-commit hook still auto-commits/);
      assert.equal(JSON.parse(readFileSync(join(wt, ".hunch/local.json"), "utf8")).autoCommit, false);
    } else assert.doesNotMatch(output, /auto-commit on/);
  } finally { cleanupDir(base); }
});
