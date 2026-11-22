import { test } from "node:test";
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { chmodSync, existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { execFileSync } from "node:child_process";
import { commitAndPushHunch } from "../src/extractors/git.js";
import { isIndexedCodePath } from "../src/extractors/repoSource.js";
import { isHunchHookCommand } from "../src/integrations/hookmatch.js";
import { installClaudeHooks, writeMcpJson } from "../src/integrations/scaffold.js";
import { inspectIntegrations, machineLocalIntegrationFiles, repairIntegrationPins } from "../src/integrations/health.js";
import { applyUninstall, planUninstall } from "../src/integrations/uninstall.js";
import { HUNCH_VERSION } from "../src/core/version.js";
import {
  CLAUDE_HOOK_LAUNCHER_COMMAND, isLauncherHookCommand, isLegacyLauncherHookCommand, HOOK_LAUNCHER_FILE, LEGACY_HOOK_LAUNCHER_FILE, claudeAgentHookCommand, bootstrapRunsLauncher, claudeHookLauncherCommand, hookBootstrap, hookBootstrapV3, launcherPinOf, ownsLauncherText, removeLegacyHookLauncher, renderHookLauncher, writeHookLauncher,
} from "../src/integrations/hookLauncher.js";
import { publishedMcpInvocation, shellInvocation } from "../src/cli/invocation.js";
import { cleanupDir } from "./fixtures.js";

const win = process.platform === "win32";
const NPX_HOOK = `${shellInvocation(publishedMcpInvocation())} hook`;
type T = { after: (fn: () => void) => void };

function tmp(t: T): string {
  const dir = mkdtempSync(join(tmpdir(), "hunch-launcher-"));
  t.after(() => cleanupDir(dir));
  return dir;
}

test("the hook bootstrap carries no character bash, sh, PowerShell or cmd expands inside double quotes", () => {
  for (const ch of ["$", "`", "!", "%", "\\", "\"", "\n", "\r"]) assert.equal(hookBootstrap().includes(ch), false, `bootstrap contains ${JSON.stringify(ch)}`);
  assert.ok(hookBootstrap().startsWith("(function(){") && hookBootstrap().endsWith("})()"), "wrapped, so it leaks no globals");
  for (const ch of ["$", "`", "!", "%", "\\", "\"", "\n", "\r"]) assert.equal(hookBootstrapV3().includes(ch), false, `shape-3 bootstrap contains ${JSON.stringify(ch)}`);
  assert.match(CLAUDE_HOOK_LAUNCHER_COMMAND, new RegExp(`--package=hunch-exact@npm:@davesheffer/hunch@${HUNCH_VERSION.replace(/\./g, "\\.")}'`));
});

test("the Claude Code hook matcher owns the bootstrap command as a whole command only", () => {
  const ours = [CLAUDE_HOOK_LAUNCHER_COMMAND, claudeHookLauncherCommand("1.2.3"), claudeHookLauncherCommand("2.0.0-rc.1"), `  ${CLAUDE_HOOK_LAUNCHER_COMMAND}  `];
  const foreign = [
    `${CLAUDE_HOOK_LAUNCHER_COMMAND}; rm x`,
    `foo && ${CLAUDE_HOOK_LAUNCHER_COMMAND}`,
    `${CLAUDE_HOOK_LAUNCHER_COMMAND}x`,
    `${CLAUDE_HOOK_LAUNCHER_COMMAND} --provider x`,
    CLAUDE_HOOK_LAUNCHER_COMMAND.replace("hook-launch.cjs", "evil.cjs"),
    CLAUDE_HOOK_LAUNCHER_COMMAND.replace("process.exitCode=", "require('x');process.exitCode="),
    claudeHookLauncherCommand("1.2.3 && rm"),
    `node "$CLAUDE_PROJECT_DIR/.hunch/hook-launch.cjs" hook`,
    `bash -c '${CLAUDE_HOOK_LAUNCHER_COMMAND}'`,
  ];
  for (const c of ours) assert.equal(isHunchHookCommand(c, false), true, `ours: ${c}`);
  for (const c of foreign) assert.equal(isHunchHookCommand(c, false), false, `foreign: ${c}`);
  for (const c of ours) assert.equal(isHunchHookCommand(c, true), false, `provider: ${c}`);
});

test("installClaudeHooks migrates the npx hook to the bootstrap and back, one Hunch entry per event, foreign hooks kept", (t) => {
  const root = tmp(t);
  const file = join(root, ".claude", "settings.json");
  const foreign = "./scripts/mine.sh hook";
  mkdirSync(join(root, ".claude"), { recursive: true });
  writeFileSync(file, JSON.stringify({ hooks: {
    Stop: [{ hooks: [{ type: "command", command: NPX_HOOK }, { type: "command", command: foreign }] }],
    SessionStart: [{ hooks: [{ type: "command", command: claudeHookLauncherCommand("1.0.0") }] }],
  } }, null, 2));
  const check = (want: string) => {
    const j = JSON.parse(readFileSync(file, "utf8")) as { hooks: Record<string, { hooks: { command: string }[] }[]> };
    for (const [event, entries] of Object.entries(j.hooks)) {
      const cmds = entries.flatMap((e) => e.hooks.map((h) => h.command));
      assert.deepEqual(cmds.filter((c) => c !== foreign), [want], `${event}: exactly one Hunch command`);
    }
    assert.ok(j.hooks.Stop!.flatMap((e) => e.hooks.map((h) => h.command)).includes(foreign), "foreign hook kept");
  };
  installClaudeHooks(root, CLAUDE_HOOK_LAUNCHER_COMMAND);
  check(CLAUDE_HOOK_LAUNCHER_COMMAND);
  assert.equal(installClaudeHooks(root, CLAUDE_HOOK_LAUNCHER_COMMAND).action, "unchanged");
  installClaudeHooks(root, NPX_HOOK);
  check(NPX_HOOK);
  installClaudeHooks(root, CLAUDE_HOOK_LAUNCHER_COMMAND);
  check(CLAUDE_HOOK_LAUNCHER_COMMAND);
});

test("writeHookLauncher writes the pinned launcher, is idempotent and keeps a file without its marker", (t) => {
  const root = tmp(t);
  assert.equal(writeHookLauncher(root).action, "created");
  assert.equal(writeHookLauncher(root).action, "unchanged");
  const file = join(root, HOOK_LAUNCHER_FILE);
  assert.equal(launcherPinOf(readFileSync(file, "utf8")), HUNCH_VERSION);
  assert.equal(writeHookLauncher(root, "9.9.9").action, "updated");
  writeFileSync(file, "// mine\n");
  assert.equal(writeHookLauncher(root).action, "kept");
  assert.equal(readFileSync(file, "utf8"), "// mine\n");
});

test("repair-pins is all-or-nothing: a write that fails mid-way restores every file already written", (t) => {
  if (!win && process.getuid?.() === 0) return t.skip("root ignores permission bits");
  const root = tmp(t);
  // .mcp.json (written first, at the root) gives POSIX a write that succeeds before the
  // locked one fails, so the rollback runs on every platform.
  writeMcpJson(root, { command: "npx", args: ["-y", "--package=hunch-exact@npm:@davesheffer/hunch@1.0.0", "hunch"] });
  installClaudeHooks(root, claudeHookLauncherCommand("1.0.0"));
  writeHookLauncher(root, "1.0.0");
  const mcp = join(root, ".mcp.json");
  const settings = join(root, ".claude", "settings.json");
  const launcher = join(root, HOOK_LAUNCHER_FILE);
  const mcpBefore = readFileSync(mcp, "utf8");
  const before = readFileSync(settings, "utf8");
  // Windows: a read-only attribute blocks the rename over the launcher only (settings.json
  // and .mcp.json written first). POSIX rename ignores the file's mode, so lock .claude/:
  // .mcp.json is written, then settings.json fails.
  const locked = win ? launcher : dirname(launcher);
  const failed = (win ? HOOK_LAUNCHER_FILE : ".claude/settings.json").replace(/[.\/]/g, "\\$&");
  chmodSync(locked, win ? 0o444 : 0o555);
  try {
    assert.throws(() => repairIntegrationPins(root), new RegExp(`could not write ${failed}.*restored ${win ? 2 : 1} already-updated file`));
  } finally {
    chmodSync(locked, win ? 0o666 : 0o755);
  }
  assert.equal(readFileSync(mcp, "utf8"), mcpBefore, ".mcp.json rolled back");
  assert.equal(readFileSync(settings, "utf8"), before, "settings.json rolled back");
  assert.equal(launcherPinOf(readFileSync(launcher, "utf8")), "1.0.0");
  const repaired = repairIntegrationPins(root);
  assert.ok([".mcp.json", ".claude/settings.json", HOOK_LAUNCHER_FILE].every((f) => repaired.includes(f)), `all repaired once writable: ${repaired}`);
  assert.notEqual(readFileSync(settings, "utf8"), before);
});

test("doctor reports a missing or markerless launcher and its pin drift; repair-pins refreshes a marker-owned launcher", (t) => {
  const root = tmp(t);
  installClaudeHooks(root, CLAUDE_HOOK_LAUNCHER_COMMAND);
  const launcherIssues = () => inspectIntegrations(root, "claude").issues.filter((i) => i.file === HOOK_LAUNCHER_FILE);
  const notes = () => inspectIntegrations(root, "claude").notes.join("\n");
  assert.deepEqual(launcherIssues(), [], "a missing launcher is a note: hooks still run via npx");
  assert.match(notes(), /missing/);
  writeHookLauncher(root, "1.0.0");
  const drift = launcherIssues();
  assert.deepEqual(drift.map((i) => i.code), ["version-drift"]);
  assert.ok(inspectIntegrations(root, "claude").pins.some((p) => p.file === HOOK_LAUNCHER_FILE && p.version === "1.0.0"));
  assert.ok(repairIntegrationPins(root).includes(HOOK_LAUNCHER_FILE));
  assert.equal(launcherPinOf(readFileSync(join(root, HOOK_LAUNCHER_FILE), "utf8")), HUNCH_VERSION);
  assert.deepEqual(launcherIssues(), []);
  writeFileSync(join(root, HOOK_LAUNCHER_FILE), "// mine\n");
  assert.deepEqual(launcherIssues(), [], "a user-owned launcher is a note, never a failure");
  assert.match(notes(), /no hunch:hook-launcher header line/);
  assert.equal(repairIntegrationPins(root).includes(HOOK_LAUNCHER_FILE), false, "a markerless launcher is the user's");
});

/** A project with a launcher pinned to 9.9.9, empty npm prefix/cache, and a fake npx-cli.js
 *  (HUNCH_HOOK_NPX_CLI) that echoes its args and stdin and exits 0. */
function fixture(t: T) {
  const base = tmp(t);
  const proj = join(base, "proj");
  const launcher = join(proj, HOOK_LAUNCHER_FILE);
  mkdirSync(dirname(launcher), { recursive: true });
  writeFileSync(launcher, renderHookLauncher("9.9.9"));
  const fakeNpx = join(base, "fake-npx-cli.js");
  writeFileSync(fakeNpx, `let s = ""; process.stdin.on("data", (d) => s += d).on("end", () => { process.stdout.write("NPX " + process.argv.slice(2).join(" ") + " <" + s + ">"); process.exit(0); });`);
  const cache = join(base, "cache");
  const prefix = join(base, "prefix");
  const env: NodeJS.ProcessEnv = {
    ...process.env,
    CLAUDE_PROJECT_DIR: proj,
    HUNCH_HOOK_NPX_CLI: fakeNpx,
    npm_config_cache: cache,
    npm_config_prefix: prefix,
    APPDATA: join(base, "appdata"),
    LOCALAPPDATA: join(base, "localappdata"),
  };
  /** Install a fake @davesheffer/hunch at `dir` whose CLI echoes `tag`, args and stdin and exits 3. */
  const pkg = (dir: string, version: string, tag = "HIT", entrySource?: string) => {
    mkdirSync(join(dir, "dist", "cli"), { recursive: true });
    writeFileSync(join(dir, "package.json"), JSON.stringify({ name: "@davesheffer/hunch", version, type: "module", bin: { hunch: "dist/cli/index.js" } }));
    writeFileSync(join(dir, "dist", "cli", "index.js"), entrySource
      ?? `import { spawnSync } from "node:child_process";
if (process.argv[2] === "child") { process.stdout.write("CHILD " + JSON.stringify(process.execArgv) + " " + process.argv.slice(3).join(" ")); process.exit(0); }
let s = ""; process.stdin.on("data", (d) => s += d).on("end", () => {
  if (s === "BLOCK") { process.stderr.write("denied by hunch"); process.exitCode = 2; return; }
  if (s === "SPAWN") { const r = spawnSync(process.execPath, [...process.execArgv, process.argv[1], "child", "x"], { encoding: "utf8" }); process.stdout.write(r.stdout + r.stderr); return; }
  process.stdout.write("${tag} " + process.argv.slice(2).join(" ") + " <" + s + ">"); process.exitCode = 3; });`);
  };
  const run = (extra: NodeJS.ProcessEnv = {}, input = "IN") => spawnSync(process.execPath, [launcher, "hook"], { env: { ...env, ...extra }, input, encoding: "utf8", timeout: 30_000 });
  return { base, proj, launcher, cache, prefix, env, pkg, run };
}
const NPX_OUT = "NPX -y --package=hunch-exact@npm:@davesheffer/hunch@9.9.9 hunch hook <IN>";

test("hook launcher: runs the npx-cached CLI of exactly the pinned version in-process with stdin and exit code (npm_config_cache)", (t) => {
  const f = fixture(t);
  f.pkg(join(f.cache, "_npx", "aaa", "node_modules", "hunch-exact"), "9.9.9");
  const r = f.run();
  assert.equal(r.stdout, "HIT hook <IN>", r.stderr);
  assert.equal(r.status, 3);
});

test("hook launcher: finds the pinned CLI under the global prefix (npm_config_prefix), and prefers the npx cache over it", (t) => {
  const f = fixture(t);
  f.pkg(win ? join(f.prefix, "node_modules", "@davesheffer", "hunch") : join(f.prefix, "lib", "node_modules", "@davesheffer", "hunch"), "9.9.9", "GLOBAL");
  let r = f.run();
  assert.equal(r.stdout, "GLOBAL hook <IN>", r.stderr);
  f.pkg(join(f.cache, "_npx", "aaa", "node_modules", "@davesheffer", "hunch"), "9.9.9", "CACHE");
  r = f.run();
  assert.equal(r.stdout, "CACHE hook <IN>", r.stderr);
});

test("hook launcher: a symlinked (npm link) package of the pinned version is never run", (t) => {
  const f = fixture(t);
  const real = join(f.base, "checkout");
  f.pkg(real, "9.9.9", "LINKED");
  const link = win ? join(f.prefix, "node_modules", "@davesheffer", "hunch") : join(f.prefix, "lib", "node_modules", "@davesheffer", "hunch");
  mkdirSync(join(link, ".."), { recursive: true });
  symlinkSync(real, link, win ? "junction" : "dir");
  const r = f.run();
  assert.equal(r.stdout, NPX_OUT, r.stderr);
});

test("hook launcher: another installed version is a miss and falls back to the pinned npx with stdin, exit code and no deprecation warning", (t) => {
  const f = fixture(t);
  f.pkg(join(f.cache, "_npx", "aaa", "node_modules", "hunch-exact"), "9.9.8");
  f.pkg(join(f.cache, "_npx", "bbb", "node_modules", "@davesheffer", "hunch"), "9.9.10");
  const r = f.run();
  assert.equal(r.stdout, NPX_OUT, r.stderr);
  assert.equal(r.status, 0, "fail-open: a failing npx never blocks the call");
  assert.doesNotMatch(r.stderr, /DEP0190|DeprecationWarning/);
});

test("hook launcher: nothing installed falls back to npx; a CLI that fails to load falls back too", (t) => {
  const f = fixture(t);
  assert.ok(f.env.HUNCH_HOOK_NPX_CLI, "the fake npx stands in for npm's npx-cli.js");
  let r = f.run();
  assert.equal(r.stdout, NPX_OUT, r.stderr);
  assert.equal(r.status, 0, "fail-open: a failing npx never blocks the call");
  f.pkg(join(f.cache, "_npx", "aaa", "node_modules", "hunch-exact"), "9.9.9", "HIT", `throw new Error("boom");`);
  r = f.run();
  assert.equal(r.stdout, NPX_OUT, r.stderr);
  assert.equal(r.status, 0, "fail-open: a failing npx never blocks the call");
});

/** Shells available here that Claude Code may run a hook command in. */
function shells(): Array<{ name: string; run: (cmd: string, env: NodeJS.ProcessEnv, cwd: string, input?: string) => ReturnType<typeof spawnSync> }> {
  const out: ReturnType<typeof shells> = [];
  const opts = (env: NodeJS.ProcessEnv, cwd: string, input = "IN") => ({ env, cwd, input, encoding: "utf8" as const, timeout: 60_000, windowsHide: true });
  for (const sh of ["bash", "sh"]) {
    if (spawnSync(sh, ["-c", "exit 0"], { windowsHide: true }).status === 0) out.push({ name: sh, run: (cmd, env, cwd, input) => spawnSync(sh, ["-c", cmd], opts(env, cwd, input)) });
  }
  if (win) {
    out.push({ name: "cmd", run: (cmd, env, cwd, input) => spawnSync(process.env.ComSpec ?? "cmd.exe", ["/d", "/s", "/c", `"${cmd}"`], { ...opts(env, cwd, input), windowsVerbatimArguments: true }) });
    out.push({ name: "powershell", run: (cmd, env, cwd, input) => spawnSync("powershell.exe", ["-NoProfile", "-NonInteractive", "-Command", cmd], opts(env, cwd, input)) });
  }
  return out;
}

/** PowerShell 5.1 `-Command` reports any failed native command as exit 1, whatever its code
 *  (the same for the old npx command); every other shell passes the code through. */
function exitIs(shell: string, got: number | null, want: number, what: string): void {
  if (shell === "powershell" && want !== 0) assert.notEqual(got, 0, `${shell} ${what} exit`);
  else assert.equal(got, want, `${shell} ${what} exit`);
}

test("the bootstrap hook command runs the launcher or the pinned npx identically in every available shell (CLAUDE_PROJECT_DIR)", (t) => {
  const f = fixture(t);
  f.pkg(join(f.cache, "_npx", "aaa", "node_modules", "hunch-exact"), "9.9.9");
  const cmd = claudeHookLauncherCommand("9.9.9");
  const cwd = f.base;
  const results: string[] = [];
  for (const sh of shells()) {
    const present = sh.run(cmd, f.env, cwd);
    assert.equal(String(present.stdout), "HIT hook <IN>", `${sh.name} present: ${String(present.stderr)}`);
    exitIs(sh.name, present.status, 3, "present");
    const unset = { ...f.env };
    delete unset.CLAUDE_PROJECT_DIR;
    const noEnv = sh.run(cmd, unset, cwd);
    assert.equal(String(noEnv.stdout), NPX_OUT, `${sh.name} env unset: ${String(noEnv.stderr)}`);
    exitIs(sh.name, noEnv.status, 0, "env unset");
    const blocked = sh.run(cmd, f.env, cwd, "BLOCK");
    assert.match(String(blocked.stderr), /denied by hunch/, `${sh.name} stderr passthrough`);
    exitIs(sh.name, blocked.status, 2, "block");
    results.push(sh.name);
  }
  rmSync(f.launcher);
  for (const sh of shells()) {
    const missing = sh.run(cmd, f.env, cwd);
    assert.equal(String(missing.stdout), NPX_OUT, `${sh.name} missing: ${String(missing.stderr)}`);
    exitIs(sh.name, missing.status, 0, "missing");
  }
  writeFileSync(f.launcher, "throw new Error('not ours')\n");
  for (const sh of shells()) {
    const markerless = sh.run(cmd, f.env, cwd);
    assert.equal(String(markerless.stdout), NPX_OUT, `${sh.name} markerless: ${String(markerless.stderr)}`);
  }
  assert.ok(results.length > 0 && existsSync(f.proj));
});

test("a CLI loaded through the bootstrap re-spawns itself with clean execArgv (siblingfix/ui spawn shape)", (t) => {
  const f = fixture(t);
  f.pkg(join(f.cache, "_npx", "aaa", "node_modules", "hunch-exact"), "9.9.9");
  const r = spawnSync(process.execPath, ["-e", hookBootstrap("9.9.9"), "hook"], { env: f.env, input: "SPAWN", encoding: "utf8", timeout: 30_000 });
  assert.equal(r.stdout, "CHILD [] x", r.stderr);
});

test("init's Claude hook command: a published install writes the launcher and the bootstrap; source runs keep theirs", (t) => {
  const root = tmp(t);
  const said: string[] = [];
  assert.equal(claudeAgentHookCommand(root, { installed: false, agentHookShell: "/n/node /x/dist/cli/index.js" }, (l) => said.push(l)), "/n/node /x/dist/cli/index.js hook");
  assert.equal(existsSync(join(root, HOOK_LAUNCHER_FILE)), false);
  assert.equal(claudeAgentHookCommand(root, { installed: true, agentHookShell: "npx" }, (l) => said.push(l)), CLAUDE_HOOK_LAUNCHER_COMMAND);
  assert.equal(launcherPinOf(readFileSync(join(root, HOOK_LAUNCHER_FILE), "utf8")), HUNCH_VERSION);
  assert.match(said.join("\n"), /created \.claude\/hunch-hook-launch\.cjs: commit it/);
  writeFileSync(join(root, HOOK_LAUNCHER_FILE), "// mine\n");
  assert.equal(claudeAgentHookCommand(root, { installed: true, agentHookShell: "npx" }, (l) => said.push(l)), CLAUDE_HOOK_LAUNCHER_COMMAND);
  assert.match(said.at(-1)!, /kept your existing .*pinned npx fallback/);
});

test("re-init with CRLF line endings only reports unchanged for the launcher and settings.json", (t) => {
  const root = tmp(t);
  writeHookLauncher(root);
  installClaudeHooks(root, CLAUDE_HOOK_LAUNCHER_COMMAND);
  for (const rel of [HOOK_LAUNCHER_FILE, ".claude/settings.json"]) {
    const file = join(root, rel);
    writeFileSync(file, readFileSync(file, "utf8").replace(/\n/g, "\r\n"));
  }
  assert.equal(writeHookLauncher(root).action, "unchanged");
  assert.equal(installClaudeHooks(root, CLAUDE_HOOK_LAUNCHER_COMMAND).action, "unchanged");
});

test("repair-pins repairs the bootstrap's pin inside settings.json and regenerates a stale marker-owned launcher", (t) => {
  const root = tmp(t);
  installClaudeHooks(root, claudeHookLauncherCommand("1.0.0"));
  writeHookLauncher(root);
  const file = join(root, HOOK_LAUNCHER_FILE);
  writeFileSync(file, readFileSync(file, "utf8").replace("Runs the installed", "Runs (edited) the installed"));
  assert.match(inspectIntegrations(root, "claude").issues.filter((i) => i.file === HOOK_LAUNCHER_FILE).map((i) => i.detail).join("\n"), /modified, or written by an older Hunch template/);
  const repaired = repairIntegrationPins(root);
  assert.ok(repaired.includes(".claude/settings.json") && repaired.includes(HOOK_LAUNCHER_FILE), repaired.join(","));
  const j = JSON.parse(readFileSync(join(root, ".claude", "settings.json"), "utf8")) as { hooks: Record<string, { hooks: { command: string }[] }[]> };
  for (const entries of Object.values(j.hooks)) for (const e of entries) for (const h of e.hooks) assert.equal(h.command, CLAUDE_HOOK_LAUNCHER_COMMAND);
  assert.equal(readFileSync(file, "utf8"), renderHookLauncher(HUNCH_VERSION));
  assert.deepEqual(inspectIntegrations(root, "claude").issues.filter((i) => i.file === HOOK_LAUNCHER_FILE), []);
});

test("a symlinked launcher with a stale pin names the manual fix, never repair-pins it skips", (t) => {
  const root = tmp(t);
  installClaudeHooks(root, CLAUDE_HOOK_LAUNCHER_COMMAND);
  const file = join(root, HOOK_LAUNCHER_FILE);
  const real = join(root, "real-launch.cjs");
  writeFileSync(real, renderHookLauncher("1.0.0"));
  try { symlinkSync(real, file, "file"); } catch (e) {
    if (win && (e as NodeJS.ErrnoException).code === "EPERM") return t.skip("file symlinks need Developer Mode on Windows");
    throw e;
  }
  const details = () => inspectIntegrations(root, "claude").issues.filter((i) => i.file === HOOK_LAUNCHER_FILE).map((i) => i.detail);
  assert.ok(details().length > 0, "drift still reported");
  const manual = () => {
    assert.ok(details().length > 0, "drift still reported");
    for (const d of details()) {
      assert.doesNotMatch(d, /run hunch integrations repair-pins/, d);
      assert.match(d, /symlink.*re-create it as a regular file/, d);
    }
  };
  manual();
  assert.deepEqual(repairIntegrationPins(root).filter((f) => f === HOOK_LAUNCHER_FILE), [], "repair-pins still never writes through it");
  assert.equal(launcherPinOf(readFileSync(real, "utf8")), "1.0.0");
  // A marker-owned target with no readable pin takes the same manual route.
  writeFileSync(real, renderHookLauncher("1.0.0").replace(/^.*const PIN.*$/m, ""));
  assert.equal(launcherPinOf(readFileSync(real, "utf8")), null);
  manual();
});

test("a launcher under a symlinked .claude directory names the manual fix for every issue form", (t) => {
  const root = tmp(t);
  const real = join(root, "real-claude");
  mkdirSync(real);
  symlinkSync(real, join(root, ".claude"), win ? "junction" : "dir");
  installClaudeHooks(root, CLAUDE_HOOK_LAUNCHER_COMMAND);
  const file = join(real, "hunch-hook-launch.cjs");
  for (const text of [renderHookLauncher("1.0.0"), renderHookLauncher(HUNCH_VERSION).replace(/^.*const PIN.*$/m, ""), `${renderHookLauncher(HUNCH_VERSION)}// edit\n`]) {
    writeFileSync(file, text);
    const details = inspectIntegrations(root, "claude").issues.filter((i) => i.file === HOOK_LAUNCHER_FILE).map((i) => i.detail);
    assert.ok(details.length > 0, "an issue is reported");
    for (const d of details) assert.match(d, /symlink, which repair-pins never writes through/, d);
  }
});

test("a git-ignored launcher is machine-local, and is never moved while a machine-local settings.json is skipped", (t) => {
  const root = tmp(t);
  assert.equal(spawnSync("git", ["init", "-q"], { cwd: root }).status, 0);
  writeFileSync(join(root, ".gitignore"), `.claude/settings.json\n${HOOK_LAUNCHER_FILE}\n`);
  installClaudeHooks(root, claudeHookLauncherCommand("1.0.0"));
  writeHookLauncher(root, "1.0.0");
  const local = new Set(machineLocalIntegrationFiles(root));
  assert.ok(local.has(HOOK_LAUNCHER_FILE) && local.has(".claude/settings.json"), [...local].join(","));
  assert.deepEqual(repairIntegrationPins(root, { skip: (f) => f === ".claude/settings.json" }), []);
  assert.equal(launcherPinOf(readFileSync(join(root, HOOK_LAUNCHER_FILE), "utf8")), "1.0.0");
});

test("plain uninstall deletes a marker-owned launcher and keeps a user-owned one", (t) => {
  const root = tmp(t);
  writeHookLauncher(root);
  applyUninstall(planUninstall(root));
  assert.equal(existsSync(join(root, HOOK_LAUNCHER_FILE)), false);
  mkdirSync(dirname(join(root, HOOK_LAUNCHER_FILE)), { recursive: true });
  writeFileSync(join(root, HOOK_LAUNCHER_FILE), "// mine\n");
  applyUninstall(planUninstall(root));
  assert.equal(readFileSync(join(root, HOOK_LAUNCHER_FILE), "utf8"), "// mine\n");
});

test("re-init migrates a shape-1 repo: the .hunch launcher is removed and settings get one current-shape entry per event", (t) => {
  const root = tmp(t);
  const legacy = join(root, LEGACY_HOOK_LAUNCHER_FILE);
  mkdirSync(dirname(legacy), { recursive: true });
  writeFileSync(legacy, renderHookLauncher(HUNCH_VERSION));
  const v1 = `node -e "${hookBootstrap()}" hook`.replace("P.join(d,'.claude','hunch-hook-launch.cjs')", "P.join(d,'.hunch','hook-launch.cjs')");
  assert.notEqual(v1, CLAUDE_HOOK_LAUNCHER_COMMAND);
  assert.equal(isHunchHookCommand(v1, false), true, "the shipped shape stays ours");
  installClaudeHooks(root, v1);
  const said: string[] = [];
  installClaudeHooks(root, claudeAgentHookCommand(root, { installed: true, agentHookShell: "npx" }, (l) => said.push(l)));
  assert.equal(existsSync(legacy), false);
  assert.match(said.join("\n"), /removed the old \.hunch\/hook-launch\.cjs/);
  const j = JSON.parse(readFileSync(join(root, ".claude", "settings.json"), "utf8")) as { hooks: Record<string, { hooks: { command: string }[] }[]> };
  for (const [event, entries] of Object.entries(j.hooks)) assert.deepEqual(entries.flatMap((e) => e.hooks.map((h) => h.command)), [CLAUDE_HOOK_LAUNCHER_COMMAND], event);
});

test("doctor reports a stale bootstrap pin once per file, not once per occurrence", (t) => {
  const root = tmp(t);
  installClaudeHooks(root, claudeHookLauncherCommand("1.0.0"));
  writeHookLauncher(root);
  const drift = inspectIntegrations(root, "claude").issues.filter((i) => i.code === "version-drift" && i.file === ".claude/settings.json");
  assert.equal(drift.length, 1);
});

test("repair-pins (the `hunch update` step) neither throws nor fails on a missing or user-owned launcher", (t) => {
  const root = tmp(t);
  installClaudeHooks(root, CLAUDE_HOOK_LAUNCHER_COMMAND);
  assert.deepEqual(repairIntegrationPins(root).filter((f) => f === HOOK_LAUNCHER_FILE), []);
  assert.deepEqual(inspectIntegrations(root, "claude").issues.filter((i) => i.file === HOOK_LAUNCHER_FILE), []);
  mkdirSync(dirname(join(root, HOOK_LAUNCHER_FILE)), { recursive: true });
  writeFileSync(join(root, HOOK_LAUNCHER_FILE), "// mine\n");
  assert.deepEqual(repairIntegrationPins(root).filter((f) => f === HOOK_LAUNCHER_FILE), []);
  assert.deepEqual(inspectIntegrations(root, "claude").issues.filter((i) => i.file === HOOK_LAUNCHER_FILE), []);
});

test("memory auto-commit still commits with an untracked or a modified launcher present", (t) => {
  const root = tmp(t);
  const git = (...a: string[]) => execFileSync("git", ["-C", root, ...a], { encoding: "utf8", stdio: ["ignore", "pipe", "ignore"] }).trim();
  git("init", "-q", "-b", "main", ".");
  git("config", "user.email", "t@example.com");
  git("config", "user.name", "T");
  const hunch = join(root, ".hunch");
  mkdirSync(join(hunch, "decisions"), { recursive: true });
  writeFileSync(join(root, ".gitignore"), ".hunch/hunch.sqlite*\n");
  writeFileSync(join(root, "app.ts"), "export const a = 1;\n");
  git("add", "-A");
  git("commit", "-qm", "feat: seed");
  git("switch", "-q", "-c", "feat/x");
  writeHookLauncher(root);
  writeFileSync(join(hunch, "decisions", "dec_one.json"), JSON.stringify({ id: "dec_one" }) + "\n");
  assert.equal(commitAndPushHunch(hunch, "hunch: capture dec_one", { push: false }), "committed", "untracked launcher");
  git("add", HOOK_LAUNCHER_FILE);
  git("commit", "-qm", "chore: launcher");
  writeHookLauncher(root, "9.9.9");
  writeFileSync(join(hunch, "decisions", "dec_two.json"), JSON.stringify({ id: "dec_two" }) + "\n");
  assert.equal(commitAndPushHunch(hunch, "hunch: capture dec_two", { push: false }), "committed", "modified launcher");
  assert.equal(git("log", "-1", "--format=%s"), "hunch: capture dec_two");
});

test("uninstall --purge deletes a marker-owned launcher too, and prunes the .claude/ it leaves empty", (t) => {
  const root = tmp(t);
  writeHookLauncher(root);
  installClaudeHooks(root, claudeAgentHookCommand(root, { installed: true, agentHookShell: "npx" }, () => {}));
  const result = applyUninstall(planUninstall(root, { purge: true }));
  assert.deepEqual(result.failed, []);
  assert.equal(existsSync(join(root, HOOK_LAUNCHER_FILE)), false);
  assert.equal(existsSync(join(root, ".claude")), false, "nothing of ours is left in .claude/");
});

test("the generated launcher is never indexed as user code; other .claude files are unchanged", () => {
  assert.equal(isIndexedCodePath(HOOK_LAUNCHER_FILE), false);
  assert.equal(isIndexedCodePath(".claude/foo.cjs"), true);
  assert.equal(isIndexedCodePath("src/hunch-hook-launch.cjs"), true);
});

test("init keeps going when the launcher path cannot be read (a directory) and says why", (t) => {
  const root = tmp(t);
  mkdirSync(join(root, HOOK_LAUNCHER_FILE), { recursive: true });
  const l = writeHookLauncher(root);
  assert.equal(l.action, "kept");
  assert.ok(l.reason);
  const said: string[] = [];
  assert.equal(claudeAgentHookCommand(root, { installed: true, agentHookShell: "npx" }, (x) => said.push(x)), CLAUDE_HOOK_LAUNCHER_COMMAND);
  assert.match(said.join("\n"), /⚠ kept \.claude\/hunch-hook-launch\.cjs as is: it could not be read/);
});

test("a directory at either launcher path never breaks repair-pins, doctor or uninstall (plain and --purge); it is left alone", (t) => {
  for (const purge of [false, true]) {
    const root = tmp(t);
    mkdirSync(join(root, ".hunch"), { recursive: true });
    installClaudeHooks(root, CLAUDE_HOOK_LAUNCHER_COMMAND);
    mkdirSync(join(root, HOOK_LAUNCHER_FILE), { recursive: true });
    mkdirSync(join(root, LEGACY_HOOK_LAUNCHER_FILE), { recursive: true });
    assert.deepEqual(repairIntegrationPins(root).filter((f) => f === HOOK_LAUNCHER_FILE), []);
    assert.deepEqual(inspectIntegrations(root, "claude").issues.filter((i) => i.file === HOOK_LAUNCHER_FILE), []);
    const plan = planUninstall(root, { purge });
    assert.deepEqual(plan.refused, [], `purge=${purge}`);
    assert.equal(plan.steps.some((s) => s.kind === "delete" && (s.path === HOOK_LAUNCHER_FILE || s.path === LEGACY_HOOK_LAUNCHER_FILE)), false);
    assert.deepEqual(applyUninstall(plan).failed, []);
    assert.equal(existsSync(join(root, HOOK_LAUNCHER_FILE)), true, "the directory is not ours");
  }
});

test("doctor: a marker-owned launcher without a readable pin is an issue repair-pins regenerates; markerless stays a note", (t) => {
  const root = tmp(t);
  installClaudeHooks(root, CLAUDE_HOOK_LAUNCHER_COMMAND);
  writeHookLauncher(root);
  const file = join(root, HOOK_LAUNCHER_FILE);
  writeFileSync(file, readFileSync(file, "utf8").replace(/^const PIN = .*$/m, "const PIN = process.env.X;"));
  const issues = () => inspectIntegrations(root, "claude").issues.filter((i) => i.file === HOOK_LAUNCHER_FILE);
  assert.deepEqual(issues().map((i) => i.code), ["hook-launcher"]);
  assert.match(issues()[0]!.detail, /no readable pin/);
  assert.ok(repairIntegrationPins(root).includes(HOOK_LAUNCHER_FILE));
  assert.equal(readFileSync(file, "utf8"), renderHookLauncher(HUNCH_VERSION));
  assert.deepEqual(issues(), []);
  writeFileSync(file, "// mine, no pin\n");
  assert.deepEqual(issues(), []);
  assert.match(inspectIntegrations(root, "claude").notes.join("\n"), /no hunch:hook-launcher header line, so it is yours/);
  assert.equal(repairIntegrationPins(root).includes(HOOK_LAUNCHER_FILE), false);
});

test("#646: ownership is the marker header line, not the marker quoted anywhere in the file", (t) => {
  const generated = renderHookLauncher("1.0.0");
  assert.equal(ownsLauncherText(generated), true);
  assert.equal(ownsLauncherText(generated.replace(/\n/g, "\r\n")), true, "a CRLF checkout is still ours");
  assert.equal(ownsLauncherText("\uFEFF" + generated), true, "a BOM is still ours");
  assert.equal(ownsLauncherText(generated.split("\n").slice(1).join("\n")), true, "no shebang: the header is the first line");
  // The user took the file over (deleted the header, as it says) but the marker is still quoted.
  const takenOver = generated.split("\n").filter((line) => !line.startsWith("// hunch:hook-launcher")).join("\n")
    + "// forked from hunch:hook-launcher 1.0.0\nconst NOTE = \"hunch:hook-launcher\";\n";
  assert.ok(takenOver.includes("hunch:hook-launcher"), "fixture: the marker is still quoted");
  assert.equal(ownsLauncherText(takenOver), false);
  assert.equal(launcherPinOf(takenOver), null, "a taken-over file has no pin Hunch reads");
  assert.equal(ownsLauncherText("// note\n// see hunch:hook-launcher\n"), false, "marker after a non-header comment");
  assert.equal(ownsLauncherText("#!/usr/bin/env node\n// x\n// hunch:hook-launcher 1.0.0\n"), false, "third line is not the header");
  assert.equal(ownsLauncherText("// hunch:hook-launcherX 1.0.0\n"), false, "a longer word is not the marker");

  const root = tmp(t);
  installClaudeHooks(root, CLAUDE_HOOK_LAUNCHER_COMMAND);
  const file = join(root, HOOK_LAUNCHER_FILE);
  mkdirSync(dirname(file), { recursive: true });
  writeFileSync(file, takenOver);
  assert.equal(writeHookLauncher(root).action, "kept", "init keeps it");
  assert.equal(repairIntegrationPins(root).includes(HOOK_LAUNCHER_FILE), false, "repair-pins keeps it");
  // The frozen bootstrap still runs it (marker anywhere), so doctor says so instead of "yours".
  assert.equal(bootstrapRunsLauncher(takenOver), true);
  const issues = inspectIntegrations(root, "claude").issues.filter((i) => i.file === HOOK_LAUNCHER_FILE);
  assert.ok(issues.some((i) => i.code === "hook-launcher" && /off its header line.*bootstrap still runs it.*pins 1\.0\.0/.test(i.detail)), JSON.stringify(issues));
  assert.ok(issues.some((i) => i.code === "version-drift"), `its stale pin is still drift-checked: ${JSON.stringify(issues)}`);
  assert.doesNotMatch(inspectIntegrations(root, "claude").notes.join("\n"), /so it is yours/);
  const said: string[] = [];
  claudeAgentHookCommand(root, { installed: true, agentHookShell: "x" }, (line) => said.push(line));
  assert.match(said.join("\n"), /bootstrap still runs it/);
  assert.equal(readFileSync(file, "utf8"), takenOver, "init still keeps it");
  // With every mention gone it is plainly the user's: a note, no issue.
  writeFileSync(file, "// mine\n");
  assert.deepEqual(inspectIntegrations(root, "claude").issues.filter((i) => i.file === HOOK_LAUNCHER_FILE), []);
  assert.match(inspectIntegrations(root, "claude").notes.join("\n"), /so it is yours/);
  writeFileSync(file, takenOver);
  applyUninstall(planUninstall(root));
  assert.equal(readFileSync(file, "utf8"), takenOver, "plain uninstall keeps it");
  applyUninstall(planUninstall(root, { purge: true }));
  assert.equal(readFileSync(file, "utf8"), takenOver, "uninstall --purge keeps it");
  const legacy = join(root, LEGACY_HOOK_LAUNCHER_FILE);
  mkdirSync(dirname(legacy), { recursive: true });
  writeFileSync(legacy, takenOver);
  assert.equal(removeLegacyHookLauncher(root), false, "the shape-1 cleanup keeps it");
  assert.equal(readFileSync(legacy, "utf8"), takenOver);
});

test("#646: the frozen bootstrap runs a file with the marker off its header line, which is why doctor flags it", (t) => {
  const f = fixture(t);
  writeFileSync(f.launcher, `process.stdout.write("FORKED"); // forked from ${"hunch:hook-launcher"} 9.9.9\n`);
  assert.equal(ownsLauncherText(readFileSync(f.launcher, "utf8")), false, "fixture: not header-owned");
  const r = spawnSync(process.execPath, ["-e", hookBootstrap("9.9.9"), "hook"], { env: f.env, input: "IN", encoding: "utf8", timeout: 30_000 });
  assert.equal(r.stdout, "FORKED", r.stderr);
  writeFileSync(f.launcher, `process.stdout.write("FORKED");\n`);
  const npx = spawnSync(process.execPath, ["-e", hookBootstrap("9.9.9"), "hook"], { env: f.env, input: "IN", encoding: "utf8", timeout: 30_000 });
  assert.equal(npx.stdout, NPX_OUT, "with no mention it runs the pinned npx fallback");
});

test("doctor: shape-1 hooks get a legacy-launcher migrate note, not a missing .claude launcher", (t) => {
  const root = tmp(t);
  const v1 = `node -e "${hookBootstrap()}" hook`.replace("P.join(d,'.claude','hunch-hook-launch.cjs')", "P.join(d,'.hunch','hook-launch.cjs')");
  installClaudeHooks(root, v1);
  const notes = inspectIntegrations(root, "claude").notes.join("\n");
  assert.match(notes, /legacy launcher \(\.hunch\/hook-launch\.cjs\); run `hunch init` to migrate/);
  assert.doesNotMatch(notes, /hunch-hook-launch\.cjs is missing/);
});

test("#680: the shape-2 bootstrap is legacy (init upgrades it); the current command is recognised and not legacy", () => {
  const shape2 = `node -e "${hookBootstrap("1.2.3")}" hook`;
  assert.equal(isLauncherHookCommand(shape2), true);
  assert.equal(isLegacyLauncherHookCommand(shape2), true);
  assert.equal(isLauncherHookCommand(CLAUDE_HOOK_LAUNCHER_COMMAND), true);
  assert.equal(isLegacyLauncherHookCommand(CLAUDE_HOOK_LAUNCHER_COMMAND), false);
  assert.notEqual(CLAUDE_HOOK_LAUNCHER_COMMAND, `node -e "${hookBootstrap()}" hook`);
});

/** #680: a failing, slow or denying npx must never make the hook exit non-zero (except a deliberate exit 2). */
function failOpenCases(t: T) {
  const f = fixture(t);
  const fake = (body: string) => { writeFileSync(join(f.base, "fake-npx-cli.js"), body); };
  const cases: Array<[string, (extra: NodeJS.ProcessEnv) => ReturnType<typeof spawnSync>]> = [
    ["launcher", (extra) => f.run(extra)],
    ["bootstrap", (extra) => { const env = { ...f.env, ...extra }; delete env.CLAUDE_PROJECT_DIR; return spawnSync(process.execPath, ["-e", hookBootstrapV3("9.9.9"), "hook"], { env, input: "IN", encoding: "utf8", timeout: 30_000 }); }],
  ];
  return { f, fake, cases };
}

test("#680: npx exiting 1 or timing out runs without Hunch (exit 0, stderr says so); exit 2 and clean output pass through", (t) => {
  const { fake, cases } = failOpenCases(t);
  for (const [name, run] of cases) {
    fake(`process.exit(1);`);
    let r = run({});
    assert.equal(r.status, 0, `${name} exit 1: ${String(r.stderr)}`);
    assert.match(String(r.stderr), /ran without Hunch checks/, name);
    assert.match(String(r.stderr), /exit 1/, name);
    assert.match((JSON.parse(String(r.stdout).trim()) as { systemMessage: string }).systemMessage, /ran without Hunch checks/, `${name} systemMessage on stdout`);
    fake(`setTimeout(() => {}, 20000);`);
    r = run({ HUNCH_HOOK_NPX_TIMEOUT_MS: "500" });
    assert.equal(r.status, 0, `${name} timeout: ${String(r.stderr)}`);
    assert.match(String(r.stderr), /ran without Hunch checks/, name);
    assert.match(String(r.stderr), /timed out/, name);
    fake(`process.stderr.write("deny reason"); process.exit(2);`);
    r = run({});
    assert.equal(r.status, 2, `${name} exit 2: ${String(r.stderr)}`);
    assert.match(String(r.stderr), /deny reason/, name);
    assert.doesNotMatch(String(r.stderr), /ran without Hunch checks/, name);
    fake(`process.stdout.write(JSON.stringify({ ok: true }));`);
    r = run({});
    assert.equal(r.status, 0, `${name} ok: ${String(r.stderr)}`);
    assert.equal(String(r.stdout), '{"ok":true}', name);
    assert.doesNotMatch(String(r.stderr), /ran without Hunch checks/, name);
  }
});

test("#680: HUNCH_HOOK_NPX_TIMEOUT_MS only caps when a positive finite number; 1.5, Infinity and 1e400 never throw", (t) => {
  const { fake, cases } = failOpenCases(t);
  fake(`process.stdout.write("SLOWOK");`);
  for (const [name, run] of cases) {
    for (const v of ["Infinity", "1e400", "-5", "abc", ""]) {
      const r = run({ HUNCH_HOOK_NPX_TIMEOUT_MS: v });
      assert.equal(r.status, 0, `${name} ${v}: ${String(r.stderr)}`);
      assert.equal(String(r.stdout), "SLOWOK", `${name} ${v} counts as unset`);
    }
    const r = run({ HUNCH_HOOK_NPX_TIMEOUT_MS: "1.5" });
    assert.equal(r.status, 0, `${name} 1.5: ${String(r.stderr)}`);
    assert.doesNotMatch(String(r.stderr), /RangeError|ERR_/, name);
  }
});

test("#680: a shape-2 settings command is flagged older but still gets the launcher checks", (t) => {
  const root = tmp(t);
  installClaudeHooks(root, `node -e "${hookBootstrap()}" hook`);
  let report = inspectIntegrations(root, "claude");
  const notes = report.notes.join("\n");
  assert.match(notes, /older hook command; run `hunch init` to get the fail-open npx fallback/);
  assert.doesNotMatch(notes, /legacy launcher/);
  assert.match(notes, /hunch-hook-launch\.cjs is missing/, "launcher-missing check still runs");
  const file = join(root, HOOK_LAUNCHER_FILE);
  mkdirSync(dirname(file), { recursive: true });
  writeFileSync(file, `process.stdout.write("FORKED"); // forked from ${"hunch:hook-launcher"} 1.0.0
`);
  report = inspectIntegrations(root, "claude");
  assert.ok(report.issues.some((i) => i.code === "hook-launcher"), "marker off the header line is still an issue");
});

test("#680: the launcher says so on stdout and exits 0 when the CLI fails to load after stdin was read", (t) => {
  const f = fixture(t);
  f.pkg(join(f.cache, "_npx", "aaa", "node_modules", "hunch-exact"), "9.9.9", "HIT",
    `process.stdin.on("data", () => {}); await new Promise((r) => setTimeout(r, 200)); throw new Error("late boom");`);
  const r = f.run();
  assert.equal(r.status, 0, String(r.stderr));
  assert.match(String(r.stderr), /ran without Hunch checks/);
  assert.match(String(r.stdout), /"systemMessage":".*late boom/);
});
