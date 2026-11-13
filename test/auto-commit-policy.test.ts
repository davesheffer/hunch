import { cleanupDir } from "./fixtures.js";
/**
 * The team-wide `auto_commit` switch in .hunch/config.json: on which branches Hunch
 * auto-commits PUBLIC memory. Every repository here is a temp repo under os.tmpdir(),
 * never a real checkout or worktree of this repo (con_38bf8aa397).
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import { execFileSync, spawnSync } from "node:child_process";
import { existsSync, mkdirSync, mkdtempSync, readdirSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { mkConstraint, tsxLoaderUrl } from "./helpers.js";
import { hunchPaths } from "../src/core/paths.js";
import { autoCommitPolicyOf, readAutoCommitPolicy } from "../src/core/config.js";
import { HunchStore } from "../src/store/hunchStore.js";
import { flushCapture, flushMemoryHome, flushStateWrite, heldNotice, publicCommitHold, HELD_ON_DEFAULT_BRANCH } from "../src/integrations/sync.js";
import { updateClaudeMd } from "../src/integrations/claudemd.js";

const cli = resolve("src/cli/index.ts");
const gitEnv = { ...process.env, GIT_AUTHOR_NAME: "t", GIT_AUTHOR_EMAIL: "t@t", GIT_COMMITTER_NAME: "t", GIT_COMMITTER_EMAIL: "t@t" };
const git = (root: string, ...args: string[]): string => execFileSync("git", ["-C", root, ...args], { env: gitEnv, encoding: "utf8" }).trim();

/** Clear HUNCH_AUTO_COMMIT_DEFAULT_BRANCH for the test and restore it after. */
function isolateEnv(t: { after: (f: () => void) => void }): void {
  const previous = process.env.HUNCH_AUTO_COMMIT_DEFAULT_BRANCH;
  delete process.env.HUNCH_AUTO_COMMIT_DEFAULT_BRANCH;
  t.after(() => { if (previous === undefined) delete process.env.HUNCH_AUTO_COMMIT_DEFAULT_BRANCH; else process.env.HUNCH_AUTO_COMMIT_DEFAULT_BRANCH = previous; });
}

/** A temp repo on main whose committed .hunch/config.json is `config` (none when undefined). */
function repo(t: { after: (f: () => void) => void }, config: unknown): { root: string; commits: () => number; capture: (id: string) => ReturnType<typeof flushCapture>; hunch: string } {
  const root = realpathSync(mkdtempSync(join(tmpdir(), "hunch-autocommit-")));
  t.after(() => cleanupDir(root));
  git(root, "init", "-q", "-b", "main");
  writeFileSync(join(root, ".gitignore"), ".hunch-cache/\n.hunch/local.json\n");
  writeFileSync(join(root, "README.md"), "x\n");
  if (config !== undefined) {
    mkdirSync(join(root, ".hunch"));
    writeFileSync(join(root, ".hunch", "config.json"), typeof config === "string" ? config : JSON.stringify(config));
  }
  git(root, "add", "-A");
  git(root, "commit", "-q", "-m", "init");
  const hunch = hunchPaths(root).hunch;
  const capture = (id: string): ReturnType<typeof flushCapture> => {
    const store = new HunchStore(hunchPaths(root));
    try {
      store.json.ensureDirs();
      store.json.put("constraints", mkConstraint({ id, statement: `rule ${id}`, scope: ["src/**"] }));
      return flushCapture(store, hunch, false, `hunch: capture ${id}`);
    } finally { store.close(); }
  };
  return { root, commits: () => Number(git(root, "rev-list", "--count", "HEAD")), capture, hunch };
}

const LEDGER = { auto_commit: { branches: ["hunch/ledger"] } };

test("autoCommitPolicyOf: the three forms are accepted, anything else is invalid", () => {
  assert.deepEqual(autoCommitPolicyOf(undefined), { kind: "default" });
  assert.deepEqual(autoCommitPolicyOf(true), { kind: "default" });
  assert.deepEqual(autoCommitPolicyOf(false), { kind: "off" });
  assert.deepEqual(autoCommitPolicyOf({ branches: ["hunch/ledger", "main"] }), { kind: "branches", branches: ["hunch/ledger", "main"] });
  assert.deepEqual(autoCommitPolicyOf({ branches: [] }), { kind: "branches", branches: [] }, "an empty list is valid and holds everywhere");
  for (const bad of [{ branches: ["main"], extra: 1 }, { branch: ["main"] }, { branches: ["main", 3] }, { branches: [""] }, { branches: ["a b"] }, { branches: "main" }, "main", null, 0, ["main"], {}]) {
    const policy = autoCommitPolicyOf(bad);
    assert.equal(policy.kind, "invalid", `${JSON.stringify(bad)} is invalid`);
    if (policy.kind === "invalid") {
      assert.match(policy.problem, /\.hunch\/config\.json/);
      assert.match(policy.problem, /auto_commit/);
      assert.doesNotMatch(policy.problem, /\n/);
    }
  }
});

test("readAutoCommitPolicy: a missing file is the default; an unparseable or non-object file fails closed", t => {
  const dir = realpathSync(mkdtempSync(join(tmpdir(), "hunch-autocommit-read-")));
  t.after(() => cleanupDir(dir));
  assert.deepEqual(readAutoCommitPolicy(dir), { kind: "default" });
  writeFileSync(join(dir, "config.json"), "{ not json");
  assert.equal(readAutoCommitPolicy(dir).kind, "invalid");
  writeFileSync(join(dir, "config.json"), "[1]");
  assert.equal(readAutoCommitPolicy(dir).kind, "invalid");
  writeFileSync(join(dir, "config.json"), "﻿" + JSON.stringify(LEDGER));
  assert.deepEqual(readAutoCommitPolicy(dir), { kind: "branches", branches: ["hunch/ledger"] }, "a BOM is tolerated");
  writeFileSync(join(dir, "config.json"), JSON.stringify({ firmness: "advisory" }));
  assert.deepEqual(readAutoCommitPolicy(dir), { kind: "default" }, "read fresh on every call, no cache");
});

test("auto_commit.branches: public memory commits only on a listed branch; local/env opt-ins do not override the list", t => {
  isolateEnv(t);
  const { root, commits, capture, hunch } = repo(t, LEDGER);

  git(root, "checkout", "-q", "-b", "feat/x");
  assert.equal(capture("con_feat"), "held", "an unlisted feature branch holds the capture");
  assert.equal(commits(), 1);
  assert.ok(existsSync(join(root, ".hunch", "constraints", "con_feat.json")), "the record stays on disk");
  assert.match(heldNotice(hunch), /branch "feat\/x" is not listed in auto_commit\.branches in \.hunch\/config\.json \(hunch\/ledger\)/);
  const pump = new HunchStore(hunchPaths(root));
  try {
    assert.equal(flushMemoryHome(pump, hunch, "public", "hunch: plan policy pol_x"), "held", "every public memory flush follows the list");
  } finally { pump.close(); }
  assert.equal(commits(), 1);

  // A state-contract write commits on whatever branch it serves, under every policy.
  const state = new HunchStore(hunchPaths(root));
  try {
    state.json.put("constraints", mkConstraint({ id: "con_state", statement: "rule state", scope: ["src/**"] }));
    assert.equal(flushStateWrite(state, hunch, false, "nuryel: write con_state"), "committed");
  } finally { state.close(); }
  assert.equal(commits(), 2);

  git(root, "checkout", "-q", "main");
  writeFileSync(join(root, ".hunch", "local.json"), JSON.stringify({ autoCommitDefaultBranch: true }));
  process.env.HUNCH_AUTO_COMMIT_DEFAULT_BRANCH = "1";
  assert.equal(capture("con_main"), "held", "main is unlisted: the per-machine opt-ins do not override the team list");
  assert.equal(commits(), 1);
  assert.match(heldNotice(hunch), /branch "main" is not listed/);
  delete process.env.HUNCH_AUTO_COMMIT_DEFAULT_BRANCH;
  rmSync(join(root, ".hunch", "local.json"));

  git(root, "checkout", "-q", "--detach");
  assert.match(publicCommitHold(hunch) ?? "", /HEAD is detached/);
  git(root, "checkout", "-q", "main");

  git(root, "checkout", "-q", "-b", "hunch/ledger");
  assert.equal(capture("con_ledger"), "committed", "the listed branch commits");
  assert.equal(commits(), 2);
  assert.equal(publicCommitHold(hunch), null);
});

test("auto_commit.branches listing main commits on main", t => {
  isolateEnv(t);
  const { commits, capture } = repo(t, { auto_commit: { branches: ["main"] } });
  assert.equal(capture("con_main"), "committed");
  assert.equal(commits(), 2);
});

test("a tag named like the listed branch does not hide the branch from the policy", t => {
  isolateEnv(t);
  const { root, commits, capture, hunch } = repo(t, LEDGER);
  git(root, "checkout", "-q", "-b", "hunch/ledger");
  git(root, "tag", "hunch/ledger");
  assert.equal(git(root, "rev-parse", "--abbrev-ref", "HEAD"), "heads/hunch/ledger", "fixture sanity: the tag makes abbrev-ref ambiguous");
  assert.equal(publicCommitHold(hunch), null);
  assert.equal(capture("con_tagged"), "committed");
  assert.equal(commits(), 2);
});

test("auto_commit false holds on a feature branch; an invalid value holds too", t => {
  isolateEnv(t);
  const off = repo(t, { auto_commit: false });
  git(off.root, "checkout", "-q", "-b", "feat/x");
  assert.equal(off.capture("con_off"), "held");
  assert.equal(off.commits(), 1);
  assert.match(heldNotice(off.hunch), /\.hunch\/config\.json sets "auto_commit": false/);

  const bad = repo(t, { auto_commit: { brnaches: ["feat/x"] } });
  git(bad.root, "checkout", "-q", "-b", "feat/x");
  assert.equal(bad.capture("con_bad"), "held", "a malformed setting fails closed");
  assert.equal(bad.commits(), 1);
  assert.match(heldNotice(bad.hunch), /^not auto-committed: \.hunch\/config\.json auto_commit has key\(s\) brnaches/);
});

test("without auto_commit the default is unchanged: a feature branch commits, main holds", t => {
  isolateEnv(t);
  const { root, commits, capture, hunch } = repo(t, { firmness: "advisory" });
  assert.equal(capture("con_main"), "held");
  assert.equal(heldNotice(hunch), HELD_ON_DEFAULT_BRANCH);
  git(root, "checkout", "-q", "-b", "feat/x");
  assert.equal(capture("con_feat"), "committed");
  assert.equal(commits(), 2);
});

test("the post-commit `hunch sync` on an unlisted branch makes no commit and leaves tracked grounding at HEAD", t => {
  const root = realpathSync(mkdtempSync(join(tmpdir(), "hunch-autocommit-sync-")));
  t.after(() => cleanupDir(root));
  git(root, "init", "-q", "-b", "main");
  writeFileSync(join(root, ".gitignore"), ".hunch-cache/\n.hunch/local.json\n");
  mkdirSync(join(root, "src"));
  writeFileSync(join(root, "src", "cache.ts"), "export const size = 10;\n");
  writeFileSync(join(root, "CLAUDE.md"), "# project\n");
  const seed = new HunchStore(hunchPaths(root));
  try {
    seed.json.ensureDirs();
    updateClaudeMd(root, seed);
  } finally { seed.close(); }
  writeFileSync(join(root, ".hunch", "config.json"), JSON.stringify(LEDGER));
  git(root, "add", "-A");
  git(root, "commit", "-q", "-m", "init");
  git(root, "checkout", "-q", "-b", "feat/x");
  const env: NodeJS.ProcessEnv = { ...gitEnv, HUNCH_PRIVATE_DIR: "", HUNCH_SYNTH_PROVIDER: "deterministic", HUNCH_AUTO_COMMIT_DEFAULT_BRANCH: "1" };
  const commits = () => Number(git(root, "rev-list", "--count", "HEAD"));
  const decisions = () => existsSync(join(root, ".hunch", "decisions")) ? readdirSync(join(root, ".hunch", "decisions")).filter((n) => n.endsWith(".json")).length : 0;
  const change = (n: number) => {
    writeFileSync(join(root, "src", "cache.ts"), `export const size = ${n};\nexport function evict(keys: string[]): string[] { return keys.slice(${n}); }\n`);
    git(root, "add", "src");
    git(root, "commit", "-q", "-m", `feat(cache): bound the cache at ${n} entries`, "-m", `Evict the oldest keys past ${n} so memory stays flat under load.`);
  };
  const sync = (...args: string[]) => {
    const run = spawnSync(process.execPath, ["--import", tsxLoaderUrl(), cli, "sync", "HEAD", ...args], { cwd: root, env, encoding: "utf8" });
    assert.equal(run.status, 0, run.stderr);
    return run.stdout;
  };

  change(20);
  sync("--from-hook", "--quiet", "--commit");
  assert.equal(decisions(), 1, "the capture is written");
  assert.equal(commits(), 2, "no hunch commit lands on the unlisted branch");
  assert.equal(git(root, "status", "--porcelain", "--", "CLAUDE.md"), "", "tracked grounding stays at HEAD");
  change(30);
  assert.match(sync(), /not auto-committed: branch "feat\/x" is not listed in auto_commit\.branches/, "a manual sync says why");
  assert.equal(commits(), 3);
});
