import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, mkdirSync, writeFileSync, rmSync, chmodSync } from "node:fs";
import { spawnSync } from "node:child_process";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { hunchPaths } from "../src/core/paths.js";
import { HunchStore } from "../src/store/hunchStore.js";

const projectRoot = process.cwd();
const tsx = join(projectRoot, "node_modules/tsx/dist/cli.mjs");
const cli = join(projectRoot, "src/cli/index.ts");

function initializedRepo(prefix: string): string {
  const root = mkdtempSync(join(tmpdir(), prefix));
  const store = new HunchStore(hunchPaths(root));
  store.json.ensureDirs();
  store.close();
  return root;
}

function runIndex(root: string) {
  return spawnSync(process.execPath, [tsx, cli, "index"], {
    cwd: root,
    encoding: "utf8",
    env: { ...process.env, HUNCH_PRIVATE_DIR: "", HUNCH_SYNTH_PROVIDER: "deterministic" },
  });
}

test("hunch index CLI builds a queryable graph, updates it, and accepts a complete empty snapshot", () => {
  const root = initializedRepo("hunch-source-e2e-");
  try {
    mkdirSync(join(root, "src/auth"), { recursive: true });
    mkdirSync(join(root, "src/billing"), { recursive: true });
    writeFileSync(join(root, "src/auth/session.ts"), "export function verifySession(t){ return t; }\n");
    writeFileSync(
      join(root, "src/billing/charge.ts"),
      'import { verifySession } from "../auth/session.js";\nexport function charge(t){ return verifySession(t); }\n',
    );

    const first = runIndex(root);
    const firstOutput = `${first.stdout}${first.stderr}`;
    assert.equal(first.status, 0, firstOutput);
    assert.match(firstOutput, /Indexed 2 files/i);

    let store = new HunchStore(hunchPaths(root));
    const verify = store.json.loadAll("symbols").find((symbol) => symbol.name === "verifySession");
    assert.ok(verify, "CLI persisted the parsed symbol graph");
    assert.ok(store.getDependents(verify.id).some((dependent) => dependent.via.includes("charge")));
    const firstIds = store.json.loadAll("symbols").map((symbol) => symbol.id).sort();
    store.close();

    const second = runIndex(root);
    assert.equal(second.status, 0, `${second.stdout}${second.stderr}`);
    store = new HunchStore(hunchPaths(root));
    assert.deepEqual(store.json.loadAll("symbols").map((symbol) => symbol.id).sort(), firstIds, "repeat CLI index is deterministic");
    store.close();

    rmSync(join(root, "src"), { recursive: true, force: true });
    const empty = runIndex(root);
    const emptyOutput = `${empty.stdout}${empty.stderr}`;
    assert.equal(empty.status, 0, emptyOutput);
    assert.match(emptyOutput, /Indexed 0 files/i);
    store = new HunchStore(hunchPaths(root));
    assert.deepEqual(store.json.loadAll("symbols"), []);
    assert.deepEqual(store.json.loadAll("edges"), []);
    assert.deepEqual(store.json.loadAll("components"), []);
    store.close();
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test(
  "hunch index CLI fails visibly on an unreadable subtree and preserves the prior graph",
  { skip: process.platform === "win32" || (typeof process.getuid === "function" && process.getuid() === 0) },
  () => {
    const root = initializedRepo("hunch-source-e2e-failure-");
    const blocked = join(root, "blocked");
    try {
      mkdirSync(join(root, "src"));
      writeFileSync(join(root, "src/kept.ts"), "export function kept(){ return true; }\n");
      const first = runIndex(root);
      assert.equal(first.status, 0, `${first.stdout}${first.stderr}`);
      let store = new HunchStore(hunchPaths(root));
      const before = {
        symbols: store.json.loadAll("symbols"),
        edges: store.json.loadAll("edges"),
        components: store.json.loadAll("components"),
      };
      store.close();

      mkdirSync(blocked);
      writeFileSync(join(blocked, "lost.ts"), "export function lost(){ return false; }\n");
      chmodSync(blocked, 0o000);
      const failed = runIndex(root);
      const failedOutput = `${failed.stdout}${failed.stderr}`;
      assert.notEqual(failed.status, 0, failedOutput);
      assert.match(failedOutput, /Source discovery is incomplete/i);
      assert.match(failedOutput, /read-directory:blocked:EACCES/i);

      store = new HunchStore(hunchPaths(root));
      assert.deepEqual(store.json.loadAll("symbols"), before.symbols);
      assert.deepEqual(store.json.loadAll("edges"), before.edges);
      assert.deepEqual(store.json.loadAll("components"), before.components);
      store.close();
    } finally {
      try { chmodSync(blocked, 0o700); } catch { /* absent */ }
      rmSync(root, { recursive: true, force: true });
    }
  },
);
