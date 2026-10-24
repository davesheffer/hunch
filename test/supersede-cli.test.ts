import { test } from "node:test";
import assert from "node:assert/strict";
import { execFileSync, spawnSync } from "node:child_process";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { hunchPaths, hunchPathsForDir } from "../src/core/paths.js";
import type { Decision } from "../src/core/types.js";
import { JsonStore } from "../src/store/jsonStore.js";
import { hunchCliArgs } from "./cli-invocation.js";
import { cleanupDir } from "./helpers.js";

/**
 * `hunch supersede <old> --by <new>` must close the decision in the store that
 * HOLDS it — including a private overlay decision (issue #294) — and never write
 * across stores.
 */

const git = (cwd: string, ...args: string[]): string =>
  execFileSync("git", args, { cwd, encoding: "utf8", stdio: ["ignore", "pipe", "pipe"] }).trim();

function initRepo(root: string): void {
  git(root, "init", "-q", "-b", "main");
  git(root, "config", "user.email", "test@example.com");
  git(root, "config", "user.name", "Test Human");
  git(root, "config", "commit.gpgsign", "false");
}

function commitAll(root: string, message: string): void {
  git(root, "add", "-A");
  git(root, "commit", "-q", "-m", message);
}

const decision = (id: string): Decision => ({
  id,
  title: `Decision ${id}`,
  topic: null,
  status: "accepted",
  context: "context",
  decision: "we decided",
  consequences: [],
  alternatives_rejected: [],
  rejected_tripwires: [],
  related_components: [],
  related_files: [],
  supersedes: null,
  superseded_by: null,
  caused_by_bug: null,
  commit: null,
  valid_from: "2026-01-01T00:00:00.000Z",
  valid_to: null,
  retired: { symbols: [], deps: [] },
  provenance: { source: "human_confirmed", confidence: 1, evidence: [], last_verified: "2026-01-01T00:00:00.000Z" },
  date: "2026-01-01T00:00:00.000Z",
});

function sandbox(): { base: string; publicRoot: string; overlayRoot: string; cleanup: () => void } {
  const base = mkdtempSync(join(tmpdir(), "hunch-supersede-"));
  const publicRoot = join(base, "public");
  const overlayRoot = join(base, "overlay");
  mkdirSync(publicRoot);
  mkdirSync(overlayRoot);
  initRepo(publicRoot);
  initRepo(overlayRoot);
  writeFileSync(join(publicRoot, "README.md"), "# project\n");
  return { base, publicRoot, overlayRoot, cleanup: () => cleanupDir(base) };
}

function runSupersede(cwd: string, oldId: string, newId: string, privateDir?: string) {
  const env: NodeJS.ProcessEnv = { ...process.env, HUNCH_SYNTH_PROVIDER: "deterministic", NO_COLOR: "1" };
  if (privateDir) env.HUNCH_PRIVATE_DIR = privateDir; else delete env.HUNCH_PRIVATE_DIR;
  const r = spawnSync(process.execPath, hunchCliArgs("supersede", oldId, "--by", newId), { cwd, env, encoding: "utf8" });
  return { status: r.status, output: `${r.stdout}${r.stderr}` };
}

test("supersede closes an overlay (private) decision in the overlay, not the public repo (#294)", () => {
  const { publicRoot, overlayRoot, cleanup } = sandbox();
  try {
    new JsonStore(hunchPaths(publicRoot)).ensureDirs();
    commitAll(publicRoot, "baseline");
    const overlayStore = new JsonStore(hunchPathsForDir(join(overlayRoot, ".hunch")));
    overlayStore.ensureDirs();
    overlayStore.put("decisions", decision("dec_old"));
    overlayStore.put("decisions", decision("dec_new"));
    commitAll(overlayRoot, "overlay baseline");
    const publicHead = git(publicRoot, "rev-parse", "HEAD");

    const r = runSupersede(publicRoot, "dec_old", "dec_new", join(overlayRoot, ".hunch"));
    assert.equal(r.status, 0, r.output);
    assert.match(r.output, /superseded by/);

    const old = JSON.parse(readFileSync(join(overlayRoot, ".hunch", "decisions", "dec_old.json"), "utf8"));
    assert.equal(old.status, "superseded");
    assert.equal(old.superseded_by, "dec_new");
    assert.ok(old.valid_to);
    const edges = JSON.parse(readFileSync(join(overlayRoot, ".hunch", "edges", "index.json"), "utf8")) as Array<{ from: string; to: string }>;
    assert.ok(edges.some((e) => e.from === "dec_new" && e.to === "dec_old"), "supersedes edge recorded in the overlay");
    assert.match(git(overlayRoot, "log", "-1", "--format=%s"), /^hunch: supersede/);

    assert.equal(git(publicRoot, "rev-parse", "HEAD"), publicHead, "public HEAD unchanged");
    assert.equal(existsSync(join(publicRoot, ".hunch", "decisions", "dec_old.json")), false);
  } finally { cleanup(); }
});

test("supersede refuses to link a private --by to a public old decision", () => {
  const { publicRoot, overlayRoot, cleanup } = sandbox();
  try {
    const publicStore = new JsonStore(hunchPaths(publicRoot));
    publicStore.ensureDirs();
    publicStore.put("decisions", decision("dec_old"));
    commitAll(publicRoot, "baseline");
    const overlayStore = new JsonStore(hunchPathsForDir(join(overlayRoot, ".hunch")));
    overlayStore.ensureDirs();
    overlayStore.put("decisions", decision("dec_new"));
    commitAll(overlayRoot, "overlay baseline");
    const publicHead = git(publicRoot, "rev-parse", "HEAD");

    const r = runSupersede(publicRoot, "dec_old", "dec_new", join(overlayRoot, ".hunch"));
    assert.notEqual(r.status, 0, r.output);
    assert.match(r.output, /not found in the public store/);

    const old = JSON.parse(readFileSync(join(publicRoot, ".hunch", "decisions", "dec_old.json"), "utf8"));
    assert.equal(old.status, "accepted");
    assert.equal(old.superseded_by, null);
    assert.equal(git(publicRoot, "rev-parse", "HEAD"), publicHead);
  } finally { cleanup(); }
});

test("supersede reports a missing old decision as missing, not as a bad --by", () => {
  const { publicRoot, cleanup } = sandbox();
  try {
    new JsonStore(hunchPaths(publicRoot)).ensureDirs();
    commitAll(publicRoot, "baseline");
    const r = runSupersede(publicRoot, "dec_does_not_exist", "dec_also_missing");
    assert.notEqual(r.status, 0, r.output);
    assert.match(r.output, /decision "dec_does_not_exist" not found/);
    assert.doesNotMatch(r.output, /--by/);
  } finally { cleanup(); }
});
