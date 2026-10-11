import { test } from "node:test";
import assert from "node:assert/strict";
import { execFileSync, spawnSync } from "node:child_process";
import { mkdirSync, readFileSync, readdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { cleanupDir, isolatedCliEnv, tempDir } from "./fixtures.js";
import { hunchCliArgs } from "./cli-invocation.js";
import { runbookDraft } from "../src/core/runbookDraft.js";

/** #425: a runbook draft lists the work, not Hunch's own capture commits or store files. */

test("runbookDraft drops capture commits, store-only commits and Hunch's paths, keeps mixed commits' real files", () => {
  const draft = runbookDraft([
    { subject: "feat(auth): rate-limit logins", files: ["src/auth.ts"] },
    { subject: "hunch: capture dec_0123456789", files: [".hunch/decisions/dec_0123456789.json", "CLAUDE.md", "AGENTS.md"] },
    { subject: "refresh derived graph", files: [".hunch/manifest.json", ".cursor/rules/hunch.mdc", ".github/copilot-instructions.md"] },
    { subject: "feat(auth): session cookie flags", files: ["src/cookie.ts", ".hunch/tests.json", "CLAUDE.md"] },
    { subject: "docs: agent rules for auth", files: ["AGENTS.md"] },
    { subject: "Merge branch 'auth'", files: [] },
  ], ["src/auth.ts", "src/cookie.ts", ".hunch/manifest.json", "CLAUDE.md", "AGENTS.md", ".cursor/rules/hunch.mdc", ".windsurf/rules/hunch.md", ".github/copilot-instructions.md"]);
  assert.deepEqual(draft.steps, ["feat(auth): rate-limit logins", "feat(auth): session cookie flags", "docs: agent rules for auth", "Merge branch 'auth'"]);
  assert.deepEqual(draft.files, ["src/auth.ts", "src/cookie.ts", "AGENTS.md"], "a grounding doc stays only when a human edited it on its own");
});

test("hunch runbook over a range interleaving capture commits records only the real procedure", { timeout: 300_000 }, () => {
  const base = tempDir("hunch-runbook-425-");
  const root = join(base, "repo");
  const home = join(base, "home");
  const noHooks = join(base, "no-hooks");
  mkdirSync(root); mkdirSync(home); mkdirSync(noHooks);
  const env = isolatedCliEnv({
    HUNCH_PRIVATE_DIR: "", HUNCH_EMBEDDINGS: "off", HOME: home, USERPROFILE: home, APPDATA: join(home, "AppData"),
    XDG_CONFIG_HOME: join(home, ".config"), GIT_CONFIG_NOSYSTEM: "1", NO_COLOR: "1", CI: "1",
  });
  const git = (...args: string[]) => execFileSync("git", ["-c", `core.hooksPath=${noHooks}`, ...args], { cwd: root, env, encoding: "utf8", stdio: "pipe" });
  const hunch = (...args: string[]) => spawnSync(process.execPath, hunchCliArgs(...args), { cwd: root, env, encoding: "utf8", timeout: 120_000 });
  const commit = (subject: string, files: Record<string, string>) => {
    for (const [rel, text] of Object.entries(files)) { mkdirSync(join(root, rel, ".."), { recursive: true }); writeFileSync(join(root, rel), text); }
    git("add", "-A"); git("commit", "-qm", subject);
  };
  try {
    git("init", "-q", "-b", "main");
    git("config", "user.name", "Fixture"); git("config", "user.email", "fixture@test.invalid"); git("config", "commit.gpgsign", "false");
    commit("chore: start", { "README.md": "fixture\n" });
    const init = hunch("init", "--no-index");
    assert.equal(init.status, 0, `${init.stdout}${init.stderr}`);
    git("add", "-A"); git("commit", "-qm", "chore: add hunch");
    const start = git("rev-parse", "HEAD").trim();
    commit("feat(auth): rate-limit logins", { "src/auth.ts": "export const limit = 5;\n" });
    commit("hunch: capture dec_0123456789", { ".hunch/notes/a.json": "{}\n", "CLAUDE.md": readFileSync(join(root, "CLAUDE.md"), "utf8") + "\n" });
    commit("feat(auth): session cookie flags", { "src/cookie.ts": "export const secure = true;\n", ".hunch/notes/b.json": "{}\n" });
    commit("hunch: capture test results", { ".hunch/notes/c.json": "{}\n" });
    commit("test(auth): cover login lockout", { "test/auth.test.ts": "// lockout\n" });

    const run = hunch("runbook", `${start}..HEAD`, "--task", "add a new auth rule");
    assert.equal(run.status, 0, `${run.stdout}${run.stderr}`);
    const dir = join(root, ".hunch", "runbooks");
    const [file] = readdirSync(dir).filter((f) => f.endsWith(".json"));
    const rec = JSON.parse(readFileSync(join(dir, file!), "utf8")) as { steps: string[]; files: string[] };
    assert.deepEqual(rec.steps, ["feat(auth): rate-limit logins", "feat(auth): session cookie flags", "test(auth): cover login lockout"]);
    assert.deepEqual([...rec.files].sort(), ["src/auth.ts", "src/cookie.ts", "test/auth.test.ts"]);
  } finally {
    cleanupDir(base);
  }
});
