import { cleanupDir } from "./fixtures.js";
import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, mkdirSync, writeFileSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { updateHunch, runNpm } from "../src/cli/update.js";
import { Command } from "commander";
import { registerIntegrationCommands } from "../src/cli/integrations.js";
import { writeCodexConfig, writeCodexHooks } from "../src/integrations/providers.js";

const pkg = "@davesheffer/hunch";
function fixture(manifest?: unknown) {
  const root = mkdtempSync(join(tmpdir(), "hunch-update-"));
  if (manifest !== undefined) writeFileSync(join(root, "package.json"), JSON.stringify(manifest));
  const calls: string[][] = [];
  const logs: string[] = [];
  const run = (args: string[]) => { calls.push(args); return JSON.stringify("9.8.7"); };
  return { root, calls, logs, run, log: (line: string) => { logs.push(line); }, cleanup: () => cleanupDir(root) };
}

for (const [section, flag] of [["dependencies", "--save-prod"], ["devDependencies", "--save-dev"], ["optionalDependencies", "--save-optional"]]) {
  test(`update preserves ${section}, uses exact latest and a fresh aliased repair process`, () => {
    const f = fixture({ [section!]: { [pkg]: "1.0.0" } });
    try {
      updateHunch(f.root, {}, f.run, f.log);
      assert.deepEqual(f.calls, [
        ["view", `${pkg}@latest`, "version", "--json"],
        ["install", flag, "--save-exact", `${pkg}@9.8.7`],
        ["exec", "--yes", `--package=hunch-exact@npm:${pkg}@9.8.7`, "--", "hunch", "integrations", "repair-pins"],
      ]);
      assert.match(f.logs.at(-1)!, /Restart or reconnect/);
    } finally { f.cleanup(); }
  });
}

test("global-only installations need no package.json; --global also updates a local install's global CLI", () => {
  for (const manifest of [undefined, { devDependencies: { [pkg]: "1.0.0" } }]) {
    const f = fixture(manifest);
    try {
      updateHunch(f.root, { global: true }, f.run, f.log);
      assert.deepEqual(f.calls.at(-2), ["install", "--global", `${pkg}@9.8.7`]);
    } finally { f.cleanup(); }
  }
});

test("preview only reads the registry", () => {
  const f = fixture();
  try {
    updateHunch(f.root, { dryRun: true }, f.run, f.log);
    assert.equal(f.calls.length, 1);
    assert.ok(f.logs.some(line => line.includes("repair-pins")));
    assert.ok(!f.logs.some(line => line.includes("check passed")));
  } finally { f.cleanup(); }
});

test("updates with Codex hooks explain trust renewal and remaining runtime verification", () => {
  const f = fixture();
  try {
    mkdirSync(join(f.root, ".codex"));
    const file = join(f.root, ".codex", "hooks.json");
    writeFileSync(file, '{"hooks":{}}');
    updateHunch(f.root, {}, f.run, f.log);
    assert.match(f.logs.join("\n"), /\/hooks.*review.*trust.*changed commands/i);
    assert.match(f.logs.join("\n"), /new session/i);
    assert.match(f.logs.join("\n"), /runtime.*not verified/i);
    assert.equal(readFileSync(file, "utf8"), '{"hooks":{}}');
  } finally { f.cleanup(); }
});

test("pin repair gives Codex trust guidance only when its hook commands changed", () => {
  const f = fixture({ dependencies: { [pkg]: "9.8.7" } });
  const previousCwd = process.cwd(), previousExitCode = process.exitCode;
  const previousLog = console.log;
  try {
    mkdirSync(join(f.root, ".git"));
    const inv = { command: "npx", args: ["-y", `--package=hunch-exact@npm:${pkg}@1.0.0`, "hunch"] };
    writeCodexConfig(f.root, inv);
    writeCodexHooks(f.root, inv);
    process.chdir(f.root);
    console.log = f.log;
    const run = () => {
      const program = new Command();
      registerIntegrationCommands(program, () => []);
      program.parse(["node", "hunch", "integrations", "repair-pins"]);
    };
    run();
    assert.match(f.logs.join("\n"), /\/hooks.*review.*trust.*changed commands/i);
    assert.match(f.logs.join("\n"), /new session/i);
    assert.equal(process.exitCode, previousExitCode);
    f.logs.length = 0;
    run();
    assert.doesNotMatch(f.logs.join("\n"), /\/hooks/);
  } finally {
    console.log = previousLog;
    process.chdir(previousCwd);
    process.exitCode = previousExitCode;
    f.cleanup();
  }
});

test("failed install never launches repair; failed repair never reports success", () => {
  for (const failure of ["install", "exec"]) {
    const f = fixture();
    try {
      assert.throws(() => updateHunch(f.root, {}, args => {
        f.calls.push(args);
        if (args[0] === failure) throw new Error("simulated failure");
        return '"9.8.7"';
      }, f.log), /simulated failure/);
      assert.equal(f.calls.at(-1)![0], failure);
      assert.ok(!f.logs.some(line => line.includes("check passed")));
    } finally { f.cleanup(); }
  }
});

test("ambiguous, unsupported and source manifests fail before package installation", () => {
  for (const manifest of [null, [], { name: pkg }, { dependencies: [] },
    { dependencies: { [pkg]: "1" }, devDependencies: { [pkg]: "2" } },
    { dependencies: { [pkg]: "1" }, packageManager: "pnpm@10" },
    { dependencies: { [pkg]: "1" }, workspaces: ["packages/*"] }]) {
    const f = fixture(manifest);
    try {
      assert.throws(() => updateHunch(f.root, {}, f.run, f.log));
      assert.equal(f.calls.length, 0);
    } finally { f.cleanup(); }
  }
});

test("invalid registry versions and shell metacharacters cannot reach a subprocess", () => {
  const f = fixture();
  try {
    for (const version of ["1.2.3 & echo bad", "latest", ["1.2.3"], null]) {
      assert.throws(() => updateHunch(f.root, {}, () => JSON.stringify(version), f.log), /invalid Hunch version/);
    }
    assert.throws(() => runNpm(f.root, ["--version", "&echo"]), /unsafe npm argument/);
  } finally { f.cleanup(); }
});

test("npm runner resolves the platform launcher and propagates subprocess failures", () => {
  const f = fixture();
  try {
    assert.match(runNpm(f.root, ["--version"], true).trim(), /^\d+\.\d+\.\d+$/);
    assert.throws(() => runNpm(f.root, ["hunch-nonexistent-command"], true), /failed/);
  } finally { f.cleanup(); }
});
