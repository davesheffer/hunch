import assert from "node:assert/strict";
import { spawnSync, execFileSync } from "node:child_process";
import { mkdtempSync, readFileSync, readdirSync, writeFileSync, unlinkSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { hunchPaths } from "../src/core/paths.js";
import { indexRepo, scanRepo } from "../src/extractors/indexer.js";
import { loadNativeTreeSitter } from "../src/extractors/nativeTreeSitter.js";
import { HunchStore } from "../src/store/hunchStore.js";
import { cleanupDir } from "./helpers.js";

const examples = [
  ["ts", "export function alpha() { return 1; }"],
  ["tsx", "export function alpha() { return <div/>; }"],
  ["py", "def alpha():\n    return 1\n"],
  ["go", "package main\nfunc alpha() int { return 1 }\n"],
  ["php", "<?php function alpha() { return 1; }"],
  ["yaml", "base: &alpha {value: 1}\ncopy: *alpha\n"],
] as const;
const facets = ["symbols", "edges", "components"] as const;
function snapshot(root: string) {
  return facets.map((kind) => readdirSync(join(root, ".hunch", kind)).sort()
    .map((file) => [file, readFileSync(join(root, ".hunch", kind, file), "utf8")]));
}

for (const [extension, source] of examples) {
  test(`index refuses an untyped parser failure for every ${extension} file without rewriting the graph`, (t) => {
    const root = mkdtempSync(join(tmpdir(), "hunch-parse-all-"));
    const store = new HunchStore(hunchPaths(root));
    t.after(() => { store.close(); cleanupDir(root); });
    writeFileSync(join(root, `alpha.${extension}`), source);
    store.json.ensureDirs();
    indexRepo(store, root, { churn: false });
    assert.ok(store.json.loadAll("symbols").length > 0);
    const before = snapshot(root);
    t.mock.method(loadNativeTreeSitter().Parser.prototype, "parse", () => {
      throw new Error("grammar ABI failure sentinel");
    });
    assert.throws(() => indexRepo(store, root, { churn: false }), /grammar ABI failure sentinel/);
    assert.deepEqual(snapshot(root), before);
  });
}

test("one failed language preserves the whole graph even when another language parses", (t) => {
  const root = mkdtempSync(join(tmpdir(), "hunch-parse-mixed-"));
  const store = new HunchStore(hunchPaths(root));
  t.after(() => { store.close(); cleanupDir(root); });
  writeFileSync(join(root, "alpha.ts"), examples[0][1]);
  writeFileSync(join(root, "beta.py"), examples[2][1]);
  store.json.ensureDirs();
  indexRepo(store, root, { churn: false });
  const before = snapshot(root);
  writeFileSync(join(root, "alpha.ts"), "export function (");
  const scan = scanRepo(store, root, { churn: false });
  assert.equal(scan.result.coverage.find((c) => c.language === "python")?.parsed, 1);
  assert.throws(() => indexRepo(store, root, { churn: false }), /typescript.*alpha\.ts/);
  assert.deepEqual(snapshot(root), before);
});

test("a single bad file remains skippable when another file of its language parses", (t) => {
  const root = mkdtempSync(join(tmpdir(), "hunch-parse-partial-"));
  const store = new HunchStore(hunchPaths(root));
  t.after(() => { store.close(); cleanupDir(root); });
  writeFileSync(join(root, "alpha.ts"), examples[0][1]);
  writeFileSync(join(root, "bad.ts"), "export function (");
  store.json.ensureDirs();
  const result = indexRepo(store, root, { churn: false });
  assert.equal(result.skipped, 1);
  assert.equal(result.coverage[0]?.parsed, 1);
  assert.ok(store.json.loadAll("symbols").some((s) => s.name === "alpha"));
});

test("a TSX-only repository with bare ampersand text indexes completely", (t) => {
  const root = mkdtempSync(join(tmpdir(), "hunch-tsx-ampersand-"));
  const store = new HunchStore(hunchPaths(root));
  t.after(() => { store.close(); cleanupDir(root); });
  writeFileSync(join(root, "label.tsx"), "export const Label = () => <span>{left} & middle & {right}</span>;\n");
  store.json.ensureDirs();
  const result = indexRepo(store, root, { churn: false });
  assert.equal(result.skipped, 0);
  assert.equal(result.coverage.find((item) => item.language === "typescript")?.parsed, 1);
  assert.ok(store.json.loadAll("symbols").some((symbol) => symbol.name === "Label"));
});

test("valid symbol-free source and deleting all source files may still clear the graph", (t) => {
  const root = mkdtempSync(join(tmpdir(), "hunch-parse-empty-"));
  const store = new HunchStore(hunchPaths(root));
  t.after(() => { store.close(); cleanupDir(root); });
  store.json.ensureDirs();
  writeFileSync(join(root, "alpha.ts"), examples[0][1]);
  indexRepo(store, root, { churn: false });
  writeFileSync(join(root, "alpha.ts"), "// deliberately empty\n");
  assert.equal(indexRepo(store, root, { churn: false }).symbols, 0);
  unlinkSync(join(root, "alpha.ts"));
  assert.equal(indexRepo(store, root, { churn: false }).files, 0);
});

test("index CLI and doctor report the all-files condition without replacing stored records", (t) => {
  const root = mkdtempSync(join(tmpdir(), "hunch-parse-cli-"));
  t.after(() => cleanupDir(root));
  const git = (...args: string[]) => execFileSync("git", args, { cwd: root, stdio: "pipe" });
  git("init", "-q");
  git("config", "user.name", "Fixture");
  git("config", "user.email", "fixture@example.invalid");
  writeFileSync(join(root, "alpha.ts"), examples[0][1]);
  git("add", "alpha.ts");
  git("-c", "core.hooksPath=", "commit", "-qm", "valid source");
  const cli = (...args: string[]) => spawnSync(process.execPath, [
    join(process.cwd(), "node_modules/tsx/dist/cli.mjs"),
    join(process.cwd(), "src/cli/index.ts"), ...args,
  ], { cwd: root, encoding: "utf8", env: { ...process.env, HUNCH_PRIVATE_DIR: "", HUNCH_SYNTH_PROVIDER: "deterministic", NO_COLOR: "1" } });
  const seeded = cli("index", "--no-auto-commit");
  assert.equal(seeded.status, 0, seeded.stdout + seeded.stderr);
  const before = snapshot(root);
  writeFileSync(join(root, "alpha.ts"), "export function (");
  git("add", "alpha.ts");
  git("-c", "core.hooksPath=", "commit", "-qm", "broken source");
  for (const args of [["index", "--no-auto-commit"], ["doctor"]]) {
    const result = cli(...args);
    assert.equal(result.status, 1, result.stdout + result.stderr);
    assert.match(result.stdout + result.stderr, /typescript.*alpha\.ts/);
    assert.deepEqual(snapshot(root), before);
  }
});
