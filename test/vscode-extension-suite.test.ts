import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { readdirSync, readFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import test from "node:test";

// The VS Code extension has no node_modules of its own; its unit tests run on the
// root's tsx through its own `npm test`. Bridging it here puts it under the root
// suite (and so under the release gate CI runs) without a separate workflow step.
const EXT_ROOT = join(resolve(dirname(fileURLToPath(import.meta.url)), ".."), "vscode-extension");

test("the VS Code extension's own test script passes", () => {
  const script = JSON.parse(readFileSync(join(EXT_ROOT, "package.json"), "utf8")).scripts?.test as string | undefined;
  assert.equal(script, "node ../tooling/run-tests.mjs test/*.test.mts");
  // Enumerate explicitly rather than rely on shell/node glob expansion (differs per platform).
  const files = readdirSync(join(EXT_ROOT, "test")).filter((f) => f.endsWith(".test.mts")).sort().map((f) => `test/${f}`);
  assert.ok(files.length > 0, "no vscode-extension test files found");
  // node:test marks its child processes with NODE_TEST_CONTEXT; a nested
  // `node --test` that inherits it prints "run() is being called recursively
  // within a test file. skipping running files." and exits 0 having run nothing.
  const { NODE_TEST_CONTEXT: _context, ...env } = process.env;
  const run = spawnSync(process.execPath, ["../tooling/run-tests.mjs", ...files], {
    cwd: EXT_ROOT, encoding: "utf8", windowsHide: true, timeout: 120_000, env,
  });
  const output = `${run.stdout}\n${run.stderr}`;
  assert.equal(run.status, 0, output.slice(-4000));
  assert.doesNotMatch(output, /skipping running files/, "the nested run must not be skipped as recursive");
  // A green exit alone proves nothing: the extension's tests must actually run and pass.
  const passed = Number(/^\S* ?pass (\d+)$/m.exec(output)?.[1] ?? 0);
  assert.ok(passed > 0, `expected the extension's tests to run and pass, saw:\n${output.slice(-4000)}`);
  assert.match(output, /^\S* ?fail 0$/m, output.slice(-4000));
});
