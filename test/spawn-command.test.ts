import { test } from "node:test";
import assert from "node:assert/strict";
import { join, win32 } from "node:path";
import { resolveSpawnCommand } from "../src/core/spawnCommand.js";
import { finishReportTask, readTaskReport, startReportTask } from "../src/core/taskReport.js";
import { runReportCheck } from "../src/core/taskReportEvidence.js";
import { execFileSync, spawnSync } from "node:child_process";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";

const win = { platform: "win32" as const, execPath: "C:\\Program Files\\nodejs\\node.exe", env: { PATH: "C:\\tools;C:\\Program Files\\nodejs", PATHEXT: ".COM;.EXE;.BAT;.CMD", ComSpec: "C:\\Windows\\system32\\cmd.exe" } };
// Windows paths are case-insensitive; PATHEXT is upper-case while shims are lower-case on disk.
const files = new Set([
  "c:\\program files\\nodejs\\node_modules\\npm\\bin\\npx-cli.js",
  "c:\\program files\\nodejs\\node_modules\\npm\\bin\\npm-cli.js",
  "c:\\program files\\nodejs\\npx.cmd",
  "c:\\tools\\tsx.cmd",
  "c:\\tools\\rg.exe",
  "c:\\tools\\noext",
]);
const exists = (p: string) => files.has(p.toLowerCase());

test("POSIX argv passes through untouched", () => {
  assert.deepEqual(resolveSpawnCommand(["npx", "tsx", "--test"], { platform: "linux" }), { file: "npx", args: ["tsx", "--test"], how: "direct" });
});

test("Windows: npm and npx run as Node scripts, no shim and no shell", () => {
  const r = resolveSpawnCommand(["npx", "tsx", "--test", "test/a.test.ts"], { ...win, exists });
  assert.equal(r.how, "npm-cli");
  assert.equal(r.file, win.execPath);
  assert.deepEqual(r.args, [win32.join("C:\\Program Files\\nodejs", "node_modules", "npm", "bin", "npx-cli.js"), "tsx", "--test", "test/a.test.ts"]);
  assert.equal(resolveSpawnCommand(["NPM", "test"], { ...win, exists }).how, "npm-cli");
});

test("Windows: a .cmd launcher on PATH goes through cmd.exe with a pre-quoted line; an .exe spawns directly", () => {
  const shim = resolveSpawnCommand(["tsx", "--test", "test/my file.test.ts"], { ...win, exists });
  assert.equal(shim.how, "cmd-shim");
  assert.equal(shim.file, "C:\\Windows\\system32\\cmd.exe");
  assert.equal(shim.windowsVerbatimArguments, true);
  assert.deepEqual(shim.args.slice(0, 4), ["/d", "/v:off", "/s", "/c"]);
  assert.equal(shim.args[4]!.toLowerCase(), '"c:\\tools\\tsx.cmd --test "test/my file.test.ts""');
  const exe = resolveSpawnCommand(["rg", "-n", "x"], { ...win, exists });
  assert.equal(exe.how, "pathext");
  assert.equal(exe.file.toLowerCase(), "c:\\tools\\rg.exe");
  assert.deepEqual(exe.args, ["-n", "x"]);
  // An extensionless file on PATH is not a Windows executable; fall through unchanged.
  assert.equal(resolveSpawnCommand(["noext"], { ...win, exists }).how, "direct");
  // Explicit paths and explicit extensions are not rewritten.
  assert.deepEqual(resolveSpawnCommand(["C:\\x\\tool.exe", "a"], { ...win, exists }), { file: "C:\\x\\tool.exe", args: ["a"], how: "direct" });
});

test("Windows: batch-launcher arguments keep percent signs, quotes and backslashes literal", () => {
  const quoted = (arg: string) => {
    const line = resolveSpawnCommand(["tsx", arg], { ...win, exists }).args[4]!;
    return line.slice('"C:\\tools\\tsx.CMD '.length, -1);
  };
  // `%` is escaped outside the quotes, so cmd.exe never expands a variable.
  assert.equal(quoted("50%OS%"), String.raw`"50"^%"OS"^%""`);
  // Embedded quotes are doubled so cmd.exe's quote state follows the argument;
  // backslashes before a quote (embedded or closing) are doubled for MSVCRT.
  assert.equal(quoted(String.raw`a\"&b`), String.raw`"a\\""&b"`);
  assert.equal(quoted("dir with space\\"), '"dir with space\\\\"');
  assert.equal(quoted(String.raw`a\b c`), String.raw`"a\b c"`);
  assert.equal(quoted(""), '""');
  // A line break would silently truncate the cmd.exe line; refuse it instead.
  assert.throws(() => resolveSpawnCommand(["tsx", "a\nb"], { ...win, exists }), /line break/);
});

test("Windows: a real .cmd shim that forwards %* delivers every argument unchanged", { skip: process.platform !== "win32" }, t => {
  const dir = mkdtempSync(join(tmpdir(), "hunch-cmd-quote-"));
  t.after(() => rmSync(dir, { recursive: true, force: true, maxRetries: 5, retryDelay: 50 }));
  writeFileSync(join(dir, "argv.js"), "process.stdout.write(JSON.stringify(process.argv.slice(2)));\n");
  writeFileSync(join(dir, "hunch-argv.cmd"), `@echo off\r\n"${process.execPath}" "%~dp0argv.js" %*\r\n`);
  const env = { ...process.env, PATH: `${dir};${process.env.PATH ?? ""}`, OS: "Windows_NT", HUNCH_QUOTE_PROBE: "expanded" };
  const args = ["50%OS%", String.raw`a\"&echo INJECTED&\"b`, '"&echo INJECTED&"', "%HUNCH_QUOTE_PROBE%","%%", "%", "\\%\\", 'q"x', '\\"',
    "tr ail\\", "a&b|c<d>e^f(g)!h", "", " ", "\\\\server\\share\\", "--flag=x;y,z", '"a b"', "!OS!", "^", "é ü"];
  const resolved = resolveSpawnCommand(["hunch-argv", ...args], { env });
  assert.equal(resolved.how, "cmd-shim");
  const out = spawnSync(resolved.file, resolved.args, { cwd: dir, env, encoding: "utf8", windowsHide: true, windowsVerbatimArguments: resolved.windowsVerbatimArguments });
  assert.equal(out.status, 0, out.stderr);
  assert.doesNotMatch(out.stdout + out.stderr, /^INJECTED/m);
  assert.deepEqual(JSON.parse(out.stdout), args);
});

test("a synchronous launch refusal is a recorded failure, not a rejected runner", { skip: process.platform !== "win32" }, async t => {
  const root = mkdtempSync(join(tmpdir(), "hunch-spawn-einval-"));
  t.after(() => rmSync(root, { recursive: true, force: true, maxRetries: 5, retryDelay: 50 }));
  execFileSync("git", ["init", "-q", root]);
  writeFileSync(join(root, ".gitignore"), ".hunch-cache/\n");
  const task = startReportTask(root, "Batch file argument");
  let streamed = "";
  // A batch file named by path cannot be spawned without cmd.exe; Node refuses synchronously.
  const shim = join(root, "direct.cmd");
  writeFileSync(shim, "@echo off\r\n");
  const check = await runReportCheck(root, task.task_id, [shim], "direct batch", 10_000, { onStderr: c => { streamed += c.toString(); } });
  assert.equal(check.exit_code, null);
  assert.match(streamed, /could not start/);
  assert.equal(readTaskReport(root, task.task_id).checks.length, 1);
  finishReportTask(root, task.task_id, "interrupted");
});

test("a command that cannot start is a visible failure, not a silent null", async t => {
  const root = mkdtempSync(join(tmpdir(), "hunch-spawn-"));
  t.after(() => rmSync(root, { recursive: true, force: true, maxRetries: 5, retryDelay: 50 }));
  execFileSync("git", ["init", "-q", root]);
  writeFileSync(join(root, ".gitignore"), ".hunch-cache/\n");
  const task = startReportTask(root, "Spawn failure");
  let streamed = "";
  const check = await runReportCheck(root, task.task_id, ["definitely-not-a-command-hunch-test"], "missing", 10_000, { onStderr: c => { streamed += c.toString(); } });
  assert.equal(check.exit_code, null);
  assert.match(streamed, /could not start "definitely-not-a-command-hunch-test"/);
  assert.equal(readTaskReport(root, task.task_id).checks.length, 1);
  finishReportTask(root, task.task_id, "interrupted");
});

test("npx actually runs through the resolver on this machine", { skip: process.platform !== "win32" }, async t => {
  const root = mkdtempSync(join(tmpdir(), "hunch-spawn-npx-"));
  t.after(() => rmSync(root, { recursive: true, force: true, maxRetries: 5, retryDelay: 50 }));
  execFileSync("git", ["init", "-q", root]);
  writeFileSync(join(root, ".gitignore"), ".hunch-cache/\n");
  const task = startReportTask(root, "npx on windows");
  const check = await runReportCheck(root, task.task_id, ["npx", "--version"], "npx --version", 60_000);
  assert.equal(check.exit_code, 0, "npx must run without a shell shim");
});
