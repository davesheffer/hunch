import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, rmSync, readFileSync, writeFileSync, mkdirSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { execFileSync, spawnSync } from "node:child_process";
import { installPostCommitHook, installPreCommitHook } from "../src/integrations/hooks.js";

const PROJECT_ROOT = process.cwd();
const TSX = join(PROJECT_ROOT, "node_modules/tsx/dist/cli.mjs");
const CLI = join(PROJECT_ROOT, "src/cli/index.ts");

function repo(): string {
  const r = mkdtempSync(join(tmpdir(), "hunch-hook-"));
  execFileSync("git", ["init", "-q"], { cwd: r });
  return r;
}
const hookText = (r: string): string => readFileSync(join(r, ".git", "hooks", "post-commit"), "utf8");

test("post-commit hook: default sync line carries no --private / --commit", () => {
  const r = repo();
  try {
    installPostCommitHook(r, "hunch");
    const h = hookText(r);
    assert.match(h, /hunch sync --from-hook --quiet >/);
    assert.doesNotMatch(h, /--private/);
    assert.doesNotMatch(h, /--commit/);
  } finally { rmSync(r, { recursive: true, force: true }); }
});

test("post-commit hook: --private and --commit are emitted only when opted in", () => {
  const r = repo();
  try {
    installPostCommitHook(r, "hunch", { private: true, commit: true });
    assert.match(hookText(r), /sync --from-hook --quiet --private --commit >/);
  } finally { rmSync(r, { recursive: true, force: true }); }
});

test("post-commit hook: local-only private sync forces deterministic synthesis", () => {
  const r = repo();
  try {
    installPostCommitHook(r, "hunch", { private: true, commit: true, localOnly: true });
    assert.match(hookText(r), /HUNCH_SYNTH_PROVIDER=deterministic/);
  } finally { rmSync(r, { recursive: true, force: true }); }
});

test("post-commit hook: --commit without --private (regular auto-commit)", () => {
  const r = repo();
  try {
    installPostCommitHook(r, "hunch", { commit: true });
    const h = hookText(r);
    assert.match(h, /sync --from-hook --quiet --commit >/);
    assert.doesNotMatch(h, /--private/);
  } finally { rmSync(r, { recursive: true, force: true }); }
});

test("post-commit hook: re-install is idempotent (managed block replaced, not duplicated)", () => {
  const r = repo();
  try {
    installPostCommitHook(r, "hunch");
    installPostCommitHook(r, "hunch", { private: true, commit: true });
    const h = hookText(r);
    assert.equal(h.match(/>>> hunch post-commit >>>/g)?.length, 1); // single managed block
    assert.match(h, /--private --commit/);
  } finally { rmSync(r, { recursive: true, force: true }); }
});

test("strict pre-commit enforces the exact alternate index Git is committing", { timeout: 60_000 }, () => {
  const base = mkdtempSync(join(tmpdir(), "hunch-hook-alt-index-"));
  const r = join(base, "repo");
  const home = join(base, "home");
  mkdirSync(join(r, "src"), { recursive: true });
  mkdirSync(home);
  const env: NodeJS.ProcessEnv = {
    ...process.env,
    HOME: home,
    USERPROFILE: home,
    XDG_CONFIG_HOME: join(home, ".config"),
    GIT_CONFIG_NOSYSTEM: "1",
    GIT_TERMINAL_PROMPT: "0",
    GIT_AUTHOR_NAME: "Alternate Index Test",
    GIT_AUTHOR_EMAIL: "alternate-index@test.invalid",
    GIT_COMMITTER_NAME: "Alternate Index Test",
    GIT_COMMITTER_EMAIL: "alternate-index@test.invalid",
    HUNCH_SYNTH_PROVIDER: "deterministic",
    HUNCH_EMBEDDINGS: "off",
    NO_COLOR: "1",
    CI: "1",
  };
  const runGit = (args: string[], extra: NodeJS.ProcessEnv = {}): ReturnType<typeof spawnSync> => spawnSync("git", args, {
    cwd: r,
    env: { ...env, ...extra },
    encoding: "utf8",
  });
  try {
    assert.equal(runGit(["init", "-q", "-b", "main"]).status, 0);
    writeFileSync(join(r, "package.json"), "{\"dependencies\":{\"axios\":\"1.0.0\"}}\n");
    writeFileSync(join(r, "src/app.ts"), "export const request = () => fetch('/safe');\n");
    assert.equal(runGit(["add", "-A"]).status, 0);
    assert.equal(runGit(["commit", "-qm", "fixture: safe baseline"]).status, 0);

    const recorded = spawnSync(process.execPath, [
      TSX, CLI,
      "record-constraint", "ALTERNATE_INDEX_RULE: never import axios in src/app.ts",
      "--scope", "src/app.ts",
      "--severity", "blocking",
      "--forbid-dep", "axios",
    ], { cwd: r, env, encoding: "utf8", timeout: 30_000 });
    assert.equal(recorded.status, 0, `${recorded.stdout ?? ""}${recorded.stderr ?? ""}`);

    const invocation = `${JSON.stringify(process.execPath)} ${JSON.stringify(TSX)} ${JSON.stringify(CLI)}`;
    installPreCommitHook(r, invocation, true);
    const alternateIndex = join(base, "alternate.index");
    assert.equal(runGit(["read-tree", "HEAD"], { GIT_INDEX_FILE: alternateIndex }).status, 0);
    writeFileSync(join(r, "src/app.ts"), 'import axios from "axios";\nexport const request = () => axios.get("/unsafe");\n');
    assert.equal(runGit(["add", "src/app.ts"], { GIT_INDEX_FILE: alternateIndex }).status, 0);
    assert.equal(runGit(["diff", "--cached", "--quiet"]).status, 0, "the default index remains clean");
    const headBefore = execFileSync("git", ["rev-parse", "HEAD"], { cwd: r, env, encoding: "utf8" }).trim();

    const committed = runGit(["commit", "-m", "feat: unsafe alternate-index change"], { GIT_INDEX_FILE: alternateIndex });
    assert.notEqual(committed.status, 0, `${committed.stdout ?? ""}${committed.stderr ?? ""}`);
    assert.match(`${committed.stdout ?? ""}${committed.stderr ?? ""}`, /ALTERNATE_INDEX_RULE|axios|BLOCK/i);
    assert.equal(execFileSync("git", ["rev-parse", "HEAD"], { cwd: r, env, encoding: "utf8" }).trim(), headBefore,
      "the strict hook blocks the exact staged bytes in the alternate index");
  } finally {
    rmSync(base, { recursive: true, force: true });
  }
});
