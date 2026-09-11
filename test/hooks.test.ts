import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, rmSync, readFileSync, writeFileSync, mkdirSync, existsSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { execFileSync, spawnSync } from "node:child_process";
import { installPostCommitHook, installPreCommitHook, installPostMergeHook, hookStatus } from "../src/integrations/hooks.js";

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

const mergeHookText = (r: string): string => readFileSync(join(r, ".git", "hooks", "post-merge"), "utf8");

test("post-merge hook: invokes repair-provenance from the hook, quietly, WITHOUT --apply (detect-and-queue only)", () => {
  const r = repo();
  try {
    installPostMergeHook(r, "hunch");
    const h = mergeHookText(r);
    assert.match(h, /hunch repair-provenance --from-hook --quiet >/);
    assert.doesNotMatch(h, /--apply/);
    assert.match(h, /HUNCH_MERGE_SYNC/);
  } finally { rmSync(r, { recursive: true, force: true }); }
});

test("post-merge hook: re-install is idempotent (managed block replaced, not duplicated)", () => {
  const r = repo();
  try {
    installPostMergeHook(r, "hunch");
    installPostMergeHook(r, "hunch");
    const h = mergeHookText(r);
    assert.equal(h.match(/>>> hunch post-merge >>>/g)?.length, 1);
  } finally { rmSync(r, { recursive: true, force: true }); }
});

test("post-merge hook: appended to an existing hook file without clobbering it", () => {
  const r = repo();
  try {
    mkdirSync(join(r, ".git", "hooks"), { recursive: true });
    writeFileSync(join(r, ".git", "hooks", "post-merge"), "#!/bin/sh\necho existing\n");
    installPostMergeHook(r, "hunch");
    const h = mergeHookText(r);
    assert.match(h, /echo existing/);
    assert.match(h, />>> hunch post-merge >>>/);
  } finally { rmSync(r, { recursive: true, force: true }); }
});

test("post-merge hook: unchanged action when re-installed identically", () => {
  const r = repo();
  try {
    installPostMergeHook(r, "hunch");
    const result = installPostMergeHook(r, "hunch");
    assert.equal(result.action, "unchanged");
  } finally { rmSync(r, { recursive: true, force: true }); }
});

test("hookStatus: read-only, reports nothing installed on a fresh repo and never creates a managed hook file", () => {
  const r = repo();
  try {
    assert.deepEqual(hookStatus(r), { postCommit: false, preCommit: false, postMerge: false });
    // git itself pre-populates .git/hooks/ with *.sample files on init — that's
    // not this function's concern. What matters is it never creates any of the
    // three REAL hook files it's merely checking for.
    for (const name of ["post-commit", "pre-commit", "post-merge"]) {
      assert.equal(existsSync(join(r, ".git", "hooks", name)), false, `hookStatus must never create ${name}`);
    }
  } finally { rmSync(r, { recursive: true, force: true }); }
});

test("hookStatus: reports exactly which of the three managed hooks are present", () => {
  const r = repo();
  try {
    installPostCommitHook(r, "hunch");
    installPostMergeHook(r, "hunch");
    assert.deepEqual(hookStatus(r), { postCommit: true, preCommit: false, postMerge: true });
  } finally { rmSync(r, { recursive: true, force: true }); }
});

test("hunch index installs/upgrades the post-merge hook for a repo that already has hunch's post-commit hook — the upgrade path for existing installations", () => {
  const r = repo();
  try {
    writeFileSync(join(r, "app.ts"), "export const x = 1;\n");
    execFileSync("git", ["config", "user.email", "t@t.co"], { cwd: r });
    execFileSync("git", ["config", "user.name", "T"], { cwd: r });
    execFileSync("git", ["add", "-A"], { cwd: r });
    execFileSync("git", ["commit", "-qm", "init"], { cwd: r });
    // Simulates a repo that already ran `hunch init` before the post-merge
    // hook existed — it has post-commit, but never post-merge.
    installPostCommitHook(r, "hunch");

    const run = spawnSync(process.execPath, [TSX, CLI, "index", "--no-auto-commit"], {
      cwd: r,
      env: { ...process.env, HUNCH_PRIVATE_DIR: "", HUNCH_SYNTH_PROVIDER: "deterministic" },
      encoding: "utf8",
    });
    assert.equal(run.status, 0, `${run.stdout}${run.stderr}`);
    const hookPath = join(r, ".git", "hooks", "post-merge");
    assert.match(readFileSync(hookPath, "utf8"), /repair-provenance --from-hook --quiet/);
  } finally { rmSync(r, { recursive: true, force: true }); }
});

test("hunch index never installs any hook in a repo that never ran hunch init — no silent hooking of an un-hooked repo (e.g. a CI checkout)", () => {
  const r = repo();
  try {
    writeFileSync(join(r, "app.ts"), "export const x = 1;\n");
    execFileSync("git", ["config", "user.email", "t@t.co"], { cwd: r });
    execFileSync("git", ["config", "user.name", "T"], { cwd: r });
    execFileSync("git", ["add", "-A"], { cwd: r });
    execFileSync("git", ["commit", "-qm", "init"], { cwd: r });

    const run = spawnSync(process.execPath, [TSX, CLI, "index", "--no-auto-commit"], {
      cwd: r,
      env: { ...process.env, HUNCH_PRIVATE_DIR: "", HUNCH_SYNTH_PROVIDER: "deterministic" },
      encoding: "utf8",
    });
    assert.equal(run.status, 0, `${run.stdout}${run.stderr}`);
    assert.equal(existsSync(join(r, ".git", "hooks", "post-merge")), false, "index must never newly hook a repo hunch init was never run on");
    assert.equal(existsSync(join(r, ".git", "hooks", "post-commit")), false);
  } finally { rmSync(r, { recursive: true, force: true }); }
});

test("hunch doctor: both hooks missing points at hunch init, not hunch index (index alone can't fix this)", () => {
  const r = repo();
  try {
    writeFileSync(join(r, "app.ts"), "export const x = 1;\n");
    execFileSync("git", ["config", "user.email", "t@t.co"], { cwd: r });
    execFileSync("git", ["config", "user.name", "T"], { cwd: r });
    execFileSync("git", ["add", "-A"], { cwd: r });
    execFileSync("git", ["commit", "-qm", "init"], { cwd: r });

    const run = spawnSync(process.execPath, [TSX, CLI, "doctor"], {
      cwd: r,
      env: { ...process.env, HUNCH_PRIVATE_DIR: "", HUNCH_SYNTH_PROVIDER: "deterministic" },
      encoding: "utf8",
    });
    assert.match(`${run.stdout}${run.stderr}`, /hooks:.*⚠.*missing.*post-commit.*post-merge/s);
    assert.match(`${run.stdout}${run.stderr}`, /hunch init/);
  } finally { rmSync(r, { recursive: true, force: true }); }
});

test("hunch doctor: only post-merge missing points at hunch index, which will actually fix it", () => {
  const r = repo();
  try {
    writeFileSync(join(r, "app.ts"), "export const x = 1;\n");
    execFileSync("git", ["config", "user.email", "t@t.co"], { cwd: r });
    execFileSync("git", ["config", "user.name", "T"], { cwd: r });
    execFileSync("git", ["add", "-A"], { cwd: r });
    execFileSync("git", ["commit", "-qm", "init"], { cwd: r });
    installPostCommitHook(r, "hunch"); // simulates a repo hunch-index would now actually upgrade

    const run = spawnSync(process.execPath, [TSX, CLI, "doctor"], {
      cwd: r,
      env: { ...process.env, HUNCH_PRIVATE_DIR: "", HUNCH_SYNTH_PROVIDER: "deterministic" },
      encoding: "utf8",
    });
    assert.match(`${run.stdout}${run.stderr}`, /hooks:.*⚠.*missing.*post-merge/s);
    assert.doesNotMatch(`${run.stdout}${run.stderr}`, /missing.*post-commit/s);
    assert.match(`${run.stdout}${run.stderr}`, /hunch index/);
    assert.doesNotMatch(`${run.stdout}${run.stderr}`, /hunch init/, "hunch index alone fixes this — must not send the human to the heavier command");
  } finally { rmSync(r, { recursive: true, force: true }); }
});

test("hunch doctor reports hooks installed once post-commit and post-merge are present", () => {
  const r = repo();
  try {
    writeFileSync(join(r, "app.ts"), "export const x = 1;\n");
    execFileSync("git", ["config", "user.email", "t@t.co"], { cwd: r });
    execFileSync("git", ["config", "user.name", "T"], { cwd: r });
    execFileSync("git", ["add", "-A"], { cwd: r });
    execFileSync("git", ["commit", "-qm", "init"], { cwd: r });
    installPostCommitHook(r, "hunch");
    installPostMergeHook(r, "hunch");

    const run = spawnSync(process.execPath, [TSX, CLI, "doctor"], {
      cwd: r,
      env: { ...process.env, HUNCH_PRIVATE_DIR: "", HUNCH_SYNTH_PROVIDER: "deterministic" },
      encoding: "utf8",
    });
    assert.match(run.stdout, /hooks:\s+post-commit, post-merge installed/);
    assert.doesNotMatch(`${run.stdout}${run.stderr}`, /⚠.*missing/);
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

test("post-merge hook: refreshes grounding only when the merge touched .hunch/, loop-guarded, never fatal", () => {
  const r = repo();
  try {
    const first = installPostMergeHook(r, "hunch");
    assert.equal(first.action, "created");
    const h = readFileSync(join(r, ".git", "hooks", "post-merge"), "utf8");
    assert.match(h, /git diff --quiet ORIG_HEAD HEAD -- \.hunch/);
    assert.match(h, /HUNCH_SYNC=1 hunch grounding --refresh 2>\/dev\/null \|\| true/);
    assert.match(h, /if \[ -z "\$HUNCH_SYNC" \]/);
    assert.equal(installPostMergeHook(r, "hunch").action, "unchanged");
    assert.equal(installPostMergeHook(r, "npx hunch").action, "updated");
    assert.equal((readFileSync(join(r, ".git", "hooks", "post-merge"), "utf8").match(/hunch post-merge >>>/g) ?? []).length, 1, "one managed block");
    // An existing user hook is preserved.
    writeFileSync(join(r, ".git", "hooks", "post-merge"), "#!/bin/sh\necho user-hook\n");
    assert.equal(installPostMergeHook(r, "hunch").action, "appended");
    assert.match(readFileSync(join(r, ".git", "hooks", "post-merge"), "utf8"), /^#!\/bin\/sh\necho user-hook\n# >>> hunch post-merge >>>/);
  } finally { rmSync(r, { recursive: true, force: true }); }
});
