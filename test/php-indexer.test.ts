import { cleanupDir } from "./fixtures.js";
import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, mkdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { hunchPaths } from "../src/core/paths.js";
import { indexRepo, scanRepo } from "../src/extractors/indexer.js";
import { HunchStore } from "../src/store/hunchStore.js";

function fixture(): { root: string; store: HunchStore } {
  const root = mkdtempSync(join(tmpdir(), "hunch-php-index-"));
  for (const directory of ["src/Contracts", "src/Support"]) mkdirSync(join(root, directory), { recursive: true });
  writeFileSync(join(root, "composer.json"), JSON.stringify({ autoload: { "psr-4": { "App\\": "src/" } } }));
  writeFileSync(join(root, "src/Contracts/Runner.php"), "<?php namespace App\\Contracts; interface Runner { public function run(): void; }\n");
  writeFileSync(join(root, "src/Support/Logs.php"), "<?php namespace App\\Support; trait Logs { public function log(): void {} }\n");
  writeFileSync(join(root, "src/BaseWorker.php"), "<?php namespace App; class BaseWorker {}\n");
  writeFileSync(join(root, "src/Helper.php"), "<?php namespace App; class Helper { public function execute(): void {} public static function build(): void {} }\n");
  writeFileSync(join(root, "src/Worker.php"), `<?php
namespace App;
use App\\Contracts\\Runner;
use App\\Support\\Logs;
class Worker extends BaseWorker implements Runner {
  use Logs;
  public function run(): void {
    $helper = new Helper();
    $helper->execute();
    Helper::build();
  }
}
`);
  writeFileSync(join(root, "bootstrap.php"), "<?php function boot(): void { require 'src/Helper.php'; }\n");
  const store = new HunchStore(hunchPaths(root));
  store.json.ensureDirs();
  return { root, store };
}

test("PHP indexing resolves Composer calls and static type relationships through the normal graph", () => {
  const { root, store } = fixture();
  try {
    const scan = scanRepo(store, root, { churn: false });
    assert.deepEqual(scan.result.coverage, [{ language: "php", eligible: 6, parsed: 6, skipped: 0, reasons: {} }]);
    assert.deepEqual(scan.issues, []);
    const symbol = (name: string, file: string) => scan.symbols.find((candidate) => candidate.name === name && candidate.file === file)!;
    const worker = symbol("Worker", "src/Worker.php");
    const run = symbol("run", "src/Worker.php");
    const base = symbol("BaseWorker", "src/BaseWorker.php");
    const contract = symbol("Runner", "src/Contracts/Runner.php");
    const trait = symbol("Logs", "src/Support/Logs.php");
    const helper = symbol("Helper", "src/Helper.php");
    const execute = symbol("execute", "src/Helper.php");
    const build = symbol("build", "src/Helper.php");
    const hasEdge = (from: string, to: string, type: string) => scan.edges.some((edge) => edge.from === from && edge.to === to && edge.type === type);
    assert.ok(hasEdge(worker.id, base.id, "implements"));
    assert.ok(hasEdge(worker.id, contract.id, "implements"));
    assert.ok(hasEdge(worker.id, trait.id, "implements"));
    assert.ok(hasEdge(run.id, helper.id, "calls"), "constructor call resolves to the class");
    assert.ok(hasEdge(run.id, execute.id, "calls"), "member call resolves only through imported/current-namespace files");
    assert.ok(hasEdge(run.id, build.id, "calls"), "static call resolves through its class scope");
    const dependencyReasons = scan.edges.filter((edge) => edge.type === "depends_on").map((edge) => edge.reason);
    assert.ok(dependencyReasons.some((reason) => /bootstrap\.php imports src\/Helper\.php/.test(reason)), dependencyReasons.join("; "));
  } finally {
    store.close();
    cleanupDir(root);
  }
});

test("PHP coverage reports every parse failure with a bounded reason", () => {
  const { root, store } = fixture();
  try {
    writeFileSync(join(root, "src/Broken.php"), "<?php class Broken { public function x( {");
    const scan = scanRepo(store, root, { churn: false });
    assert.deepEqual(scan.result.coverage, [{ language: "php", eligible: 7, parsed: 6, skipped: 1, reasons: { parse_failed: 1 } }]);
    assert.deepEqual(scan.issues.map(({ path, code }) => ({ path, code })), [{ path: "src/Broken.php", code: "parse_failed" }]);
  } finally {
    store.close();
    cleanupDir(root);
  }
});

test("PHP type relationships participate in bounded path and impact queries", () => {
  const { root, store } = fixture();
  try {
    indexRepo(store, root, { churn: false });
    store.reindex();
    const [worker] = store.resolveNodeIds("Worker");
    const [contract] = store.resolveNodeIds("Runner");
    assert.ok(worker && contract);
    assert.deepEqual(store.shortestPath(worker, contract, 1)?.map(({ id }) => id), [worker, contract]);
    assert.ok(store.getDependents(contract, 1).some(({ id }) => id === worker));
    assert.ok(store.blastRadiusFiles("src/Contracts/Runner.php", 1)
      .some(({ file }) => file === "src/Worker.php"));
  } finally {
    store.close();
    cleanupDir(root);
  }
});
