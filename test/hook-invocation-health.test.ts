import { cleanupDir } from "./fixtures.js";
/**
 * Issue #315: a hunch marker in a hook file proves nothing about what the block
 * actually runs. A block rewritten into a probe, or one pointing at a node/CLI
 * path that no longer exists, is `stale` — present where git runs it, dead in
 * practice — and `hunch doctor` must say so instead of "installed". Every
 * fixture is a fresh temp repo, never a real checkout (con_38bf8aa397); the
 * probe blocks are inspected, never executed.
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, rmSync, readFileSync, writeFileSync, realpathSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { execFileSync, spawnSync } from "node:child_process";
import {
  installPostCommitHook, installPreCommitHook, installPostMergeHook, hookStatus, hookReport,
  hookInvocationHealth, hookInvocationLines, PORTABLE_HOOK_INVOCATION,
  type HookReport, type HookReportEntry,
} from "../src/integrations/hooks.js";

const PROJECT_ROOT = process.cwd();
const TSX = join(PROJECT_ROOT, "node_modules/tsx/dist/cli.mjs");
const CLI = join(PROJECT_ROOT, "src/cli/index.ts");

function git(root: string, ...args: string[]): string {
  return execFileSync("git", args, { cwd: root, encoding: "utf8", env: { ...process.env, GIT_CONFIG_NOSYSTEM: "1" }, stdio: ["ignore", "pipe", "pipe"] }).trim();
}

function repo(prefix = "hunch-hookinv-"): string {
  const r = realpathSync.native(mkdtempSync(join(tmpdir(), prefix)));
  git(r, "init", "-q", "-b", "main");
  git(r, "config", "user.email", "hooks@test.invalid");
  git(r, "config", "user.name", "Hook Invocation");
  git(r, "config", "commit.gpgsign", "false");
  return r;
}

const POST_COMMIT = (r: string) => join(r, ".git", "hooks", "post-commit");

/** Replace the post-commit block's `… sync --from-hook …` line with `line`. */
function rewriteSyncLine(r: string, line: string): void {
  const path = POST_COMMIT(r);
  const text = readFileSync(path, "utf8").split("\n").map((l) => (/sync\s+--from-hook/.test(l) ? line : l)).join("\n");
  writeFileSync(path, text);
}

test("a block rewritten into an arbitrary probe command is stale, not installed", () => {
  const r = repo();
  try {
    assert.equal(installPostCommitHook(r, "hunch").action, "created");
    // NEVER executed — the hook is only ever read here.
    rewriteSyncLine(r, `  ( touch ${JSON.stringify(join(r, "PROBE"))}; echo sync --from-hook --quiet >/dev/null 2>&1 || true ) &`);
    const report = hookReport(r);
    assert.equal(report.postCommit.state, "stale");
    assert.equal(report.postCommit.reason, "not a command Hunch writes");
    assert.equal(hookStatus(r).postCommit, false, "a stale block is not installed");
    assert.equal(report.postCommit.path, POST_COMMIT(r));
  } finally { cleanupDir(r); }
});

test("a JSON-escaped Windows launcher that does not exist is stale and names the decoded path", () => {
  const r = repo();
  try {
    installPostCommitHook(r, "hunch");
    const node = "C:\\nope\\node.exe";
    const entry = "C:\\nope\\index.js";
    rewriteSyncLine(r, `  ( ${JSON.stringify(node)} ${JSON.stringify(entry)} sync --from-hook --quiet >/dev/null 2>&1 || true ) &`);
    const entryReport = hookReport(r).postCommit;
    assert.equal(entryReport.state, "stale");
    assert.equal(entryReport.reason, `${node} does not exist`, "the reason names the decoded path, not the escaped source");
    assert.equal(entryReport.invocation, `${JSON.stringify(node)} ${JSON.stringify(entry)}`);
    assert.equal(hookStatus(r).postCommit, false);
  } finally { cleanupDir(r); }
});

test("every launcher shape Hunch writes reports installed, with the invocation it points at", () => {
  const r = repo();
  try {
    const cases: [string, string][] = [
      ["hunch", "a bare PATH-resolved hunch"],
      ["npx hunch", "npx hunch"],
      [PORTABLE_HOOK_INVOCATION, "the portable exact-version npx spec"],
      [`npx tsx ${JSON.stringify(CLI)}`, "npx tsx <entry>"],
      [`${JSON.stringify(process.execPath)} ${JSON.stringify(CLI)}`, "<node> <entry>"],
      [`${JSON.stringify(process.execPath)} ${JSON.stringify(TSX)} ${JSON.stringify(CLI)}`, "<node> <tsx> <entry>"],
    ];
    for (const [inv, label] of cases) {
      rmSync(POST_COMMIT(r), { force: true });
      installPostCommitHook(r, inv);
      const entry = hookReport(r).postCommit;
      assert.equal(entry.state, "installed", `${label}: ${entry.reason ?? ""}`);
      assert.equal(entry.invocation, inv, label);
      assert.equal(hookStatus(r).postCommit, true, label);
    }
  } finally { cleanupDir(r); }
});

test("a launcher whose path no longer exists is stale, whichever shape it is", () => {
  const r = repo();
  try {
    const missing = join(r, "gone", "index.ts");
    const cases: [string, string][] = [
      [`npx tsx ${JSON.stringify(missing)}`, missing],
      [`${JSON.stringify(process.execPath)} ${JSON.stringify(missing)}`, missing],
      ["/nonexistent/bin/hunch", "/nonexistent/bin/hunch"],
    ];
    for (const [inv, gone] of cases) {
      rmSync(POST_COMMIT(r), { force: true });
      installPostCommitHook(r, inv);
      const entry = hookReport(r).postCommit;
      assert.equal(entry.state, "stale", inv);
      assert.equal(entry.reason, `${gone} does not exist`, inv);
      assert.equal(hookStatus(r).postCommit, false, inv);
    }
  } finally { cleanupDir(r); }
});

test("markers with no command line left between them are stale, not installed", () => {
  const r = repo();
  try {
    writeFileSync(POST_COMMIT(r), "#!/bin/sh\n# >>> hunch post-commit >>>\n# <<< hunch post-commit <<<\n");
    const entry = hookReport(r).postCommit;
    assert.equal(entry.state, "stale");
    assert.equal(entry.reason, "the block has no `hunch sync --from-hook` command");
    assert.equal(entry.invocation, undefined, "nothing to report as a launcher");
    assert.equal(hookStatus(r).postCommit, false);
  } finally { cleanupDir(r); }
});

test("an older block shape (env assignment, no parentheses) is still installed", () => {
  const r = repo();
  try {
    writeFileSync(POST_COMMIT(r), "#!/bin/sh\n# >>> hunch post-commit >>>\nHUNCH_SYNC=1 hunch sync --from-hook --quiet &\n# <<< hunch post-commit <<<\n");
    const entry = hookReport(r).postCommit;
    assert.equal(entry.state, "installed", entry.reason ?? "");
    assert.equal(entry.invocation, "hunch");
    assert.equal(hookStatus(r).postCommit, true);
  } finally { cleanupDir(r); }
});

test("post-merge: one stale half makes the hook stale; re-installing heals it", () => {
  const r = repo();
  try {
    assert.equal(installPostMergeHook(r, "hunch").action, "created");
    const path = join(r, ".git", "hooks", "post-merge");
    const text = readFileSync(path, "utf8").split("\n")
      .map((l) => (/repair-provenance/.test(l) && !l.startsWith("#") ? `  ( /nonexistent/bin/hunch repair-provenance --from-hook --quiet >/dev/null 2>&1 || true ) &` : l))
      .join("\n");
    writeFileSync(path, text);
    assert.equal(hookReport(r).postMerge.state, "stale");
    assert.equal(hookStatus(r).postMerge, false);

    assert.equal(installPostMergeHook(r, "hunch").action, "updated", "a stale block falls through to the rewrite path");
    assert.equal(hookReport(r).postMerge.state, "installed");
    assert.equal(hookStatus(r).postMerge, true);
  } finally { cleanupDir(r); }
});

test("a block carrying both a probe line and a working hunch line still works, so it is installed", () => {
  const r = repo();
  try {
    writeFileSync(POST_COMMIT(r), [
      "#!/bin/sh",
      "# >>> hunch post-commit >>>",
      `  ( touch ${JSON.stringify(join(r, "PROBE"))}; echo sync --from-hook >/dev/null 2>&1 || true ) &`,
      "  ( hunch sync --from-hook --quiet >/dev/null 2>&1 || true ) &",
      "# <<< hunch post-commit <<<",
      "",
    ].join("\n"));
    const entry = hookReport(r).postCommit;
    assert.equal(entry.state, "installed", entry.reason ?? "");
    assert.equal(entry.invocation, "hunch");
  } finally { cleanupDir(r); }
});

test("hookInvocationHealth: only the shapes Hunch writes are accepted", () => {
  const root = PROJECT_ROOT;
  const ok = (cmd: string) => hookInvocationHealth(cmd, root).ok;
  const reason = (cmd: string) => {
    const h = hookInvocationHealth(cmd, root);
    return h.ok ? null : h.reason;
  };
  assert.equal(ok("  ( HUNCH_SYNC=1 hunch "), true, "leading paren + env assignments are part of the block, not the command");
  assert.equal(hookInvocationHealth("  ( HUNCH_SYNC=1 hunch ", root).invocation, "hunch");
  assert.equal(reason("hunch; rm -rf /"), "not a command Hunch writes", "an unquoted metacharacter");
  assert.equal(reason("$(which hunch)"), "not a command Hunch writes", "a command substitution");
  assert.equal(reason("`which hunch`"), "not a command Hunch writes", "a backtick substitution");
  assert.equal(reason('"$HOME/x" '), "not a command Hunch writes", "an expansion inside double quotes");
  assert.equal(reason('"unterminated '), "not a command Hunch writes");
  assert.equal(reason("   "), "not a command Hunch writes", "no tokens at all");
  assert.equal(reason("echo"), "not a command Hunch writes");
  assert.equal(reason(JSON.stringify(process.execPath)), "not a command Hunch writes", "node with no script to run");
  assert.equal(reason("hunch extra"), "not a command Hunch writes", "a bare hunch takes no extra words");
  assert.equal(ok("'hunch'"), true, "a single-quoted launcher is literal");
});

test("a package runner in front of the launcher is ours, whichever runner the user adapted the snippet to", () => {
  const root = PROJECT_ROOT;
  const ok = (cmd: string) => hookInvocationHealth(cmd, root).ok;
  const reason = (cmd: string) => {
    const h = hookInvocationHealth(cmd, root);
    return h.ok ? null : h.reason;
  };
  // Users paste Hunch's snippet into husky / a tracked hook file and swap the
  // runner for the one their repo uses; none of these may read stale.
  for (const cmd of [
    "pnpm exec hunch", "pnpm hunch", "yarn hunch", "yarn run hunch", "bunx hunch", "npm exec -- hunch",
    "npx -y @davesheffer/hunch", "npx -p @davesheffer/hunch@1.0.0 hunch", "env X=1 hunch",
    `pnpm exec tsx ${JSON.stringify(CLI)}`,
  ]) assert.equal(ok(cmd), true, cmd);
  assert.equal(reason("pnpm exec eslint"), "not a command Hunch writes", "a runner running someone else's tool");
  assert.equal(reason("env"), "not a command Hunch writes", "a runner with nothing to run");
  assert.equal(reason("npx"), "not a command Hunch writes");
  // What a runner would resolve is never verified (that would mean a network
  // install), but a local tsx entry it points at still has to exist.
  const missing = join(PROJECT_ROOT, "gone", "index.ts");
  assert.equal(reason(`npx tsx ${JSON.stringify(missing)}`), `${missing} does not exist`);
});

test("runtime flags are not script paths, but a runtime with no script at all is not ours", () => {
  const root = PROJECT_ROOT;
  const q = JSON.stringify;
  assert.equal(hookInvocationHealth(`${q(process.execPath)} --no-warnings ${q(CLI)}`, root).ok, true, "a node flag before the entry");
  const bare = hookInvocationHealth(`${q(process.execPath)} --no-warnings`, root);
  assert.equal(bare.ok ? null : bare.reason, "not a command Hunch writes", "flags alone are not a script to run");
});

test("a `~/` launcher is expanded before it is checked, and reported as it was written", () => {
  // Deliberately a path that cannot exist — the real home directory is never written to.
  const tilde = "~/definitely-not-here-hunch-test/hunch";
  const h = hookInvocationHealth(tilde, PROJECT_ROOT);
  assert.equal(h.ok ? null : h.reason, `${tilde} does not exist`, "the reason keeps the token as written");
});

test("a stale hook reports the Hunch options its block carried, so a re-install cannot silently drop them", () => {
  const r = repo();
  try {
    // A launcher that is gone after a reinstall — never executed.
    const dead = `${JSON.stringify(join(r, "gone", "node"))} ${JSON.stringify(join(r, "gone", "cli", "index.js"))}`;
    installPostCommitHook(r, dead, { private: true, commit: true });
    installPreCommitHook(r, dead, true);
    const report = hookReport(r);
    assert.equal(report.postCommit.state, "stale");
    assert.deepEqual(report.postCommit.flags, ["--private", "--commit"]);
    assert.equal(report.preCommit.state, "stale");
    assert.deepEqual(report.preCommit.flags, ["--strict"]);
  } finally { cleanupDir(r); }
});

test("hunch doctor's stale hint names the init options that keep the block's flags", { timeout: 120_000 }, () => {
  const r = repo();
  try {
    writeFileSync(join(r, "app.ts"), "export const x = 1;\n");
    git(r, "add", "-A");
    git(r, "commit", "-qm", "init");
    installPostCommitHook(r, "hunch");
    installPostMergeHook(r, "hunch");
    // A strict pre-commit guard whose launcher no longer exists.
    installPreCommitHook(r, join(r, "gone", "bin", "hunch"), true);

    const run = spawnSync(process.execPath, [TSX, CLI, "doctor"], {
      cwd: r,
      env: { ...process.env, HUNCH_PRIVATE_DIR: "", HUNCH_SYNTH_PROVIDER: "deterministic", NO_COLOR: "1" },
      encoding: "utf8",
    });
    const out = `${run.stdout}${run.stderr}`;
    assert.match(out, /⚠ stale: pre-commit/, out);
    assert.match(out, /--enforce-strict/, out);
  } finally { cleanupDir(r); }
});

test("a runtime not named node is ours only as an absolute path running Hunch's CLI entry", () => {
  const r = repo();
  try {
    // process.execPath is not always called `node` (Debian's `nodejs`); the file only has to exist.
    const runtime = join(r, "nodejs");
    const other = join(r, "script.js");
    writeFileSync(runtime, "");
    writeFileSync(other, "");
    const q = JSON.stringify;
    assert.equal(hookInvocationHealth(`${q(runtime)} ${q(CLI)}`, r).ok, true);
    const foreign = hookInvocationHealth(`${q(runtime)} ${q(other)}`, r);
    assert.equal(foreign.ok ? null : foreign.reason, "not a command Hunch writes", "an arbitrary program running an arbitrary script");
    const gone = hookInvocationHealth(`${q(join(r, "gone", "nodejs"))} ${q(CLI)}`, r);
    assert.equal(gone.ok ? null : gone.reason, `${join(r, "gone", "nodejs")} does not exist`);
    const bare = hookInvocationHealth(`nodejs ${q(CLI)}`, r);
    assert.equal(bare.ok ? null : bare.reason, "not a command Hunch writes", "a PATH-resolved unknown runtime is never what Hunch writes");
  } finally { cleanupDir(r); }
});

test("hookInvocationLines: identical invocations share a line, and only a differing one is flagged", () => {
  const entry = (state: HookReportEntry["state"], invocation?: string): HookReportEntry =>
    ({ state, manager: "none", path: "/x", ...(invocation ? { invocation } : {}) });
  const report: HookReport = {
    postCommit: entry("installed", "hunch"),
    postMerge: entry("installed", "hunch"),
    preCommit: entry("stale", "/opt/other/hunch"),
    postCheckout: entry("missing"),
  };
  assert.deepEqual(hookInvocationLines(report, "hunch"), [
    "post-commit, post-merge → hunch",
    "pre-commit → /opt/other/hunch (differs from the running Hunch: hunch)",
  ]);
  assert.deepEqual(hookInvocationLines(report, ""), [
    "post-commit, post-merge → hunch",
    "pre-commit → /opt/other/hunch",
  ], "no running invocation to compare against: no suffix");
});

test("hunch doctor reports a stale hook instead of calling it installed", { timeout: 120_000 }, () => {
  const r = repo();
  try {
    writeFileSync(join(r, "app.ts"), "export const x = 1;\n");
    git(r, "add", "-A");
    git(r, "commit", "-qm", "init");
    installPostCommitHook(r, "hunch");
    installPostMergeHook(r, "hunch");
    rewriteSyncLine(r, `  ( ${JSON.stringify("C:\\nope\\node.exe")} ${JSON.stringify("C:\\nope\\index.js")} sync --from-hook --quiet >/dev/null 2>&1 || true ) &`);

    const run = spawnSync(process.execPath, [TSX, CLI, "doctor"], {
      cwd: r,
      env: { ...process.env, HUNCH_PRIVATE_DIR: "", HUNCH_SYNTH_PROVIDER: "deterministic", NO_COLOR: "1" },
      encoding: "utf8",
    });
    const out = `${run.stdout}${run.stderr}`;
    assert.match(out, /hooks:.*⚠ stale: post-commit/s, out);
    assert.match(out, /C:\\nope\\node\.exe does not exist/, out);
    assert.doesNotMatch(out, /hooks:\s+post-commit, post-merge installed/, out);
  } finally { cleanupDir(r); }
});
