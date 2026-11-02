import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { existsSync, readFileSync } from "node:fs";
import { test } from "node:test";
import { fileURLToPath } from "node:url";

/**
 * tooling/bundle-cli.mjs turns the tsc output into one bundle behind a tiny
 * entry, so every hook process loads one module instead of ~540. These checks
 * run against the built dist/ (npm run build) and pin what the published entry
 * must keep doing. Like every compiled-CLI test (test/cli-invocation.ts) they
 * need HUNCH_TEST_COMPILED_CLI=1 and a fresh build; a plain `npm test` on a
 * clean clone has no dist/ yet.
 */
const dist = (p: string) => fileURLToPath(new URL(`../dist/${p}`, import.meta.url));
const pkg = JSON.parse(readFileSync(new URL("../package.json", import.meta.url), "utf8")) as { version: string; bin: Record<string, string> };
const compiled = process.env.HUNCH_TEST_COMPILED_CLI === "1"
  ? {}
  : { skip: "set HUNCH_TEST_COMPILED_CLI=1 after npm run build" };

test("bundle-cli.mjs: dist/cli/index.js is the generated entry that gates Node then loads the bundle", compiled, () => {
  const entry = readFileSync(dist("cli/index.js"), "utf8");
  assert.match(entry, /^#!\/usr\/bin\/env node\n/, "bin entry keeps its shebang");
  assert.match(entry, /hunch:bundle-entry/);
  // The version gate must be evaluated before the bundle (which imports node:sqlite) is linked.
  assert.ok(entry.indexOf('import "./preflight.js"') < entry.indexOf('import("./index.bundle.js")'));
  assert.ok(existsSync(dist("cli/index.bundle.js")));
  assert.ok(Object.values(pkg.bin).includes("dist/cli/index.js"), "bin still points at the entry hooks are installed with");
});

test("bundle-cli.mjs: the bundle only imports Node builtins and the declared externals", compiled, () => {
  const bundle = readFileSync(dist("cli/index.bundle.js"), "utf8");
  const specifiers = new Set([...bundle.matchAll(/^import\s[^;]*?from\s*"([^"]+)"/gm)].map((m) => m[1]!));
  const stray = [...specifiers].filter((s) => !s.startsWith("node:") && !/^(tree-sitter|@tree-sitter-grammars\/|@huggingface\/transformers)/.test(s));
  assert.deepEqual(stray, [], "a relative or npm import left in the bundle would load the module graph the bundle exists to avoid");
});

test("bundle-cli.mjs: the bundled CLI runs through the published entry", compiled, () => {
  const r = spawnSync(process.execPath, [dist("cli/index.js"), "--version"], { encoding: "utf8" });
  assert.equal(r.status, 0, r.stderr);
  assert.equal(r.stdout.trim(), pkg.version);
});
