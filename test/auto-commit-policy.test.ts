import { cleanupDir } from "./fixtures.js";
/**
 * The team-wide `auto_commit` switch in .hunch/config.json: on which branches Hunch
 * auto-commits PUBLIC memory. Every repository here is a temp repo under os.tmpdir(),
 * never a real checkout or worktree of this repo (con_38bf8aa397).
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { execFileSync, spawnSync } from "node:child_process";
import { existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { mkConstraint, tsxLoaderUrl } from "./helpers.js";
import { hunchPaths } from "../src/core/paths.js";
import { autoCommitPolicyOf, readAutoCommitPolicy } from "../src/core/config.js";
import { HunchStore } from "../src/store/hunchStore.js";
import { SCHEMAS } from "../src/core/types.js";
import { flushCapture, flushMemoryHome, flushStateWrite, heldNotice, publicCommitHold, HELD_ON_DEFAULT_BRANCH } from "../src/integrations/sync.js";
import { updateClaudeMd } from "../src/integrations/claudemd.js";
import { repositoryScope, writeState } from "../src/store/stateBinding.js";
import { writeManifest } from "../src/core/migrate.js";
import { __setAfterHoldBackDecisionForTests, commitAndPushHunch } from "../src/extractors/git.js";

const cli = resolve("src/cli/index.ts");
const gitEnv = { ...process.env, GIT_AUTHOR_NAME: "t", GIT_AUTHOR_EMAIL: "t@t", GIT_COMMITTER_NAME: "t", GIT_COMMITTER_EMAIL: "t@t" };
const git = (root: string, ...args: string[]): string => execFileSync("git", ["-C", root, ...args], { env: gitEnv, encoding: "utf8" }).trim();

/** Clear HUNCH_AUTO_COMMIT_DEFAULT_BRANCH for the test and restore it after. */
function isolateEnv(t: { after: (f: () => void) => void }): void {
  const previous = process.env.HUNCH_AUTO_COMMIT_DEFAULT_BRANCH;
  delete process.env.HUNCH_AUTO_COMMIT_DEFAULT_BRANCH;
  t.after(() => { if (previous === undefined) delete process.env.HUNCH_AUTO_COMMIT_DEFAULT_BRANCH; else process.env.HUNCH_AUTO_COMMIT_DEFAULT_BRANCH = previous; });
}

/** A temp repo on main whose committed .hunch/config.json is `config` (none when undefined).
 *  `seed` also commits an initialized store (its manifest), so later captures add only new files. */
function repo(t: { after: (f: () => void) => void }, config: unknown, seed = false): { root: string; commits: () => number; capture: (id: string) => ReturnType<typeof flushCapture>; hunch: string } {
  const root = realpathSync(mkdtempSync(join(tmpdir(), "hunch-autocommit-")));
  t.after(() => cleanupDir(root));
  git(root, "init", "-q", "-b", "main");
  writeFileSync(join(root, ".gitignore"), ".hunch-cache/\n.hunch/local.json\n");
  writeFileSync(join(root, "README.md"), "x\n");
  if (config !== undefined) {
    mkdirSync(join(root, ".hunch"));
    writeFileSync(join(root, ".hunch", "config.json"), typeof config === "string" ? config : JSON.stringify(config));
  }
  if (seed) {
    writeFileSync(join(root, ".gitignore"), ".hunch-cache/\n.hunch/local.json\n.hunch/*.sqlite*\n");
    const seeded = new HunchStore(hunchPaths(root));
    try { seeded.json.ensureDirs(); } finally { seeded.close(); }
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

test("a misspelled top-level auto_commit key fails closed and names the key", t => {
  const dir = realpathSync(mkdtempSync(join(tmpdir(), "hunch-autocommit-typo-")));
  t.after(() => cleanupDir(dir));
  for (const key of ["autoCommit", "auto-commit", "AUTO_COMMIT", "autocommit", "auto_commits"]) {
    writeFileSync(join(dir, "config.json"), JSON.stringify({ [key]: { branches: ["hunch/ledger"] } }));
    const policy = readAutoCommitPolicy(dir);
    assert.equal(policy.kind, "invalid", `${key} is not read as absent`);
    if (policy.kind === "invalid") {
      assert.match(policy.problem, new RegExp(`key "${key}"; the team setting is spelled "auto_commit"`));
      assert.equal(policy.problem.includes('"autoCommit" on/off belongs in .hunch/local.json'), key !== "auto_commits", "the local.json hint only for the autoCommit spelling");
    }
  }
  writeFileSync(join(dir, "config.json"), JSON.stringify({ auto_commit: false, autoCommit: true }));
  assert.deepEqual(readAutoCommitPolicy(dir), { kind: "off" }, "the real key wins when both are present");
  writeFileSync(join(dir, "config.json"), JSON.stringify({ autoCommitDefaultBranch: true }));
  assert.deepEqual(readAutoCommitPolicy(dir), { kind: "default" }, "a longer key is not a near miss");
});

test("retire-constraint --reason under a non-default hold says the policy held it, not the default branch; doctor shows the policy", t => {
  isolateEnv(t);
  const { root, commits } = repo(t, { auto_commit: false });
  const seed = new HunchStore(hunchPaths(root));
  try {
    seed.json.ensureDirs();
    seed.json.put("constraints", mkConstraint({ id: "con_old", statement: "rule old", scope: ["src/**"] }));
    seed.json.put("constraints", mkConstraint({ id: "con_two", statement: "rule two", scope: ["src/**"] }));
  } finally { seed.close(); }
  git(root, "add", "-A");
  git(root, "commit", "-q", "-m", "seed");
  git(root, "checkout", "-q", "-b", "feat/x");
  const env: NodeJS.ProcessEnv = { ...gitEnv, HUNCH_PRIVATE_DIR: "", HUNCH_SYNTH_PROVIDER: "deterministic" };
  const run = (...args: string[]) => spawnSync(process.execPath, ["--import", tsxLoaderUrl(), cli, ...args], { cwd: root, env, encoding: "utf8" });

  const retire = run("retire-constraint", "con_old", "--reason", "superseded by the ledger");
  assert.equal(retire.status, 0, retire.stderr);
  assert.equal(commits(), 2, "auto_commit false holds the retire commit");
  assert.match(retire.stderr, /"auto_commit": false/, "the hold's real reason is printed");
  assert.match(retire.stdout, /--reason is not recorded anywhere: the auto-commit policy held the commit/);
  assert.doesNotMatch(retire.stdout + retire.stderr, /default branch/, "feat/x is not the default branch");

  const remove = run("remove", "con_two", "--reason", "gone");
  assert.equal(remove.status, 0, remove.stderr);
  assert.equal(commits(), 2, "the edit-family move is held too");
  assert.match(remove.stdout, /--reason is not recorded anywhere: the auto-commit policy held the commit/);
  assert.doesNotMatch(remove.stdout + remove.stderr, /default branch/);

  const doctor = run("doctor");
  assert.equal(doctor.status, 0, "the policy line never fails doctor");
  assert.match(doctor.stdout, /auto-commit: public memory is never auto-committed \(\.hunch\/config\.json "auto_commit": false\)/);
  writeFileSync(join(root, ".hunch", "config.json"), JSON.stringify(LEDGER));
  assert.match(run("doctor").stdout, /auto-commit: public memory commits only on hunch\/ledger \(\.hunch\/config\.json auto_commit\.branches\)/);
  writeFileSync(join(root, ".hunch", "config.json"), JSON.stringify({ autoCommit: false }));
  const invalid = run("doctor");
  assert.equal(invalid.status, 0, "an invalid policy warns; it fails closed, so doctor does not fail");
  assert.match(invalid.stdout, /auto-commit: ⚠ \.hunch\/config\.json has a key "autoCommit"; .* — public memory is never auto-committed until it is fixed/);
  writeFileSync(join(root, ".hunch", "config.json"), JSON.stringify({ firmness: "advisory" }));
  assert.doesNotMatch(run("doctor").stdout, /auto-commit:/, "silent at the default policy");
});

// Issue #642: a state write under a capture hold must not sweep the held capture into its commit.

/** isolateEnv plus HUNCH_PRIVATE_DIR="" so every write is public. */
function isolateStateEnv(t: { after: (f: () => void) => void }): void {
  isolateEnv(t);
  const previous = process.env.HUNCH_PRIVATE_DIR;
  process.env.HUNCH_PRIVATE_DIR = "";
  t.after(() => { if (previous === undefined) delete process.env.HUNCH_PRIVATE_DIR; else process.env.HUNCH_PRIVATE_DIR = previous; });
}

const stateProv = { source: "imported:sofia", confidence: 0.9, evidence: ["row a1"] };
type StateScope = { kind: string; id: string };
const commitmentWrite = (scope: StateScope, principal: unknown, title: string, key: string) => ({
  schema: "nuryel.state.write/1", principal, scope, facet: "commitments", idempotency_key: key,
  record: { schema: "nuryel.commitment/1", scope, subject: "customer:c1", title, owner: "david", due: "2026-09-30", status: "open", valid_from: "2026-09-08T10:00:00Z", valid_to: null, provenance: stateProv },
});
const entityRecord = (scope: StateScope, id: string) => ({
  schema: "nuryel.entity/1", id, kind: "customer", name: `Clinic ${id}`, scope,
  refs: [{ system: "gmail", object_type: "thread", object_key: `k-${id}`, observed_at: "2026-09-09T08:05:00Z" }],
  attributes: {}, lifecycle: "active", provenance: stateProv, created_at: "2026-09-09T08:00:00Z", updated_at: "2026-09-09T08:00:00Z",
});
const headFiles = (root: string): string[] => git(root, "ls-tree", "-r", "--name-only", "HEAD").split("\n").filter(Boolean);
const untracked = (root: string): string[] => git(root, "ls-files", "--others", "--exclude-standard").split("\n").filter(Boolean);
const everCommitted = (root: string): string[] => git(root, "log", "--all", "--name-only", "--format=").split("\n").filter(Boolean);
const heldList = (root: string): string => join(root, ".hunch-cache", "held-captures.json");
/** Every record id HEAD's change ledgers name is on record in HEAD: its own file, or for the
 *  index-file kinds (entities, relationships) an entry in HEAD's `<kind>/index.json`. */
function assertLedgerClosed(root: string): void {
  const files = headFiles(root);
  const ledgers = files.filter((f) => f.startsWith(".hunch/changes/"));
  assert.ok(ledgers.length > 0, "a change ledger is committed");
  for (const ledger of ledgers) {
    const parsed = JSON.parse(git(root, "show", `HEAD:${ledger}`)) as { events: { record_id: string; facet: string }[]; idempotency?: Record<string, { record_id: string; facet: string }> };
    for (const event of [...parsed.events, ...Object.values(parsed.idempotency ?? {})]) {
      if (event.facet === "entities" || event.facet === "relationships") {
        const index = `.hunch/${event.facet}/index.json`;
        assert.ok(files.includes(index) && git(root, "show", `HEAD:${index}`).includes(JSON.stringify(event.record_id)), `${event.record_id} named by ${ledger} is in HEAD's ${index}`);
      } else assert.ok(files.some((f) => f.endsWith(`/${event.record_id}.json`)), `${event.record_id} named by ${ledger} is in HEAD`);
    }
  }
}
/** One state write of a commitment through flushStateWrite (or with no flush when `flush` is false). */
function writeCommitment(root: string, title: string, key: string, flush = true): { id: string; durability: string } {
  const hunch = hunchPaths(root).hunch;
  const store = new HunchStore(hunchPaths(root));
  try {
    const scope = repositoryScope(store);
    const principal = { id: "sofia@david", kind: "agent", grants: [scope] };
    const result = writeState(store, commitmentWrite(scope, principal, title, key), flush ? { flush: (isPrivate, message) => flushStateWrite(store, hunch, isPrivate, message) } : {});
    return { id: result.record_id!, durability: result.durability };
  } finally { store.close(); }
}

test("#642: a held capture is not swept into a later state write; the state record and its ledger are committed", t => {
  isolateStateEnv(t);
  const { root, commits, capture } = repo(t, undefined, true);
  assert.equal(capture("con_held"), "held");
  assert.ok(existsSync(heldList(root)), "the hold recorded what it left behind");
  const { id, durability } = writeCommitment(root, "A", "idem-key-A");
  assert.equal(durability, "committed");
  assert.equal(commits(), 2);
  const files = headFiles(root);
  assert.ok(files.includes(`.hunch/commitments/${id}.json`), "the state record is in HEAD");
  assert.ok(files.some((f) => f.startsWith(".hunch/changes/")), "its change ledger is in HEAD");
  assert.ok(!files.includes(".hunch/constraints/con_held.json"), "the held capture is not swept in");
  assert.ok(untracked(root).includes(".hunch/constraints/con_held.json"), "the held capture stays on disk, untracked");
  assert.ok(!everCommitted(root).some((f) => f.startsWith(".hunch-cache/")), "the held list is never committed");
  assertLedgerClosed(root);
});

test("#642: a state write left uncommitted is committed by the next state write; a capture held in between is not", t => {
  isolateStateEnv(t);
  const { root, commits, capture } = repo(t, undefined, true);
  const first = writeCommitment(root, "A", "idem-key-A", false);
  assert.equal(first.durability, "local");
  assert.ok(untracked(root).includes(`.hunch/commitments/${first.id}.json`), "record A is left dirty");
  assert.equal(capture("con_held"), "held");
  const second = writeCommitment(root, "B", "idem-key-B");
  assert.equal(second.durability, "committed");
  assert.equal(commits(), 2);
  const files = headFiles(root);
  assert.ok(files.includes(`.hunch/commitments/${first.id}.json`), "the stranded record A rides the commit");
  assert.ok(files.includes(`.hunch/commitments/${second.id}.json`), "record B is committed");
  assert.ok(untracked(root).includes(".hunch/constraints/con_held.json"), "the held capture stays untracked");
  assertLedgerClosed(root);
});

test("#642: a held file whose bytes changed after the hold gets base behavior and is swept", t => {
  isolateStateEnv(t);
  const { root, capture } = repo(t, undefined, true);
  assert.equal(capture("con_held"), "held");
  const file = join(root, ".hunch", "constraints", "con_held.json");
  writeFileSync(file, readFileSync(file, "utf8").replace("rule con_held", "rule con_held edited"));
  assert.equal(writeCommitment(root, "A", "idem-key-A").durability, "committed");
  assert.ok(headFiles(root).includes(".hunch/constraints/con_held.json"), "the changed held file is swept, as before");
  assert.ok(!existsSync(heldList(root)) || !readFileSync(heldList(root), "utf8").includes("con_held"), "its stale entry is pruned");
  assertLedgerClosed(root);
});

test("#642: a held capture edit of a committed record gets base behavior: an unrelated state write sweeps it", t => {
  isolateStateEnv(t);
  const { root, hunch, capture } = repo(t, undefined);
  git(root, "checkout", "-q", "-b", "feat/x");
  assert.equal(capture("con_shared"), "committed", "a feature branch commits the capture");
  git(root, "checkout", "-q", "main");
  git(root, "merge", "-q", "--ff-only", "feat/x");
  const store = new HunchStore(hunchPaths(root));
  try {
    store.json.put("constraints", { ...store.json.get("constraints", "con_shared")!, statement: "rule EDITED BY HELD CAPTURE" });
    assert.equal(flushCapture(store, hunch, false, "hunch: edit con_shared"), "held");
  } finally { store.close(); }
  assert.equal(writeCommitment(root, "A", "idem-key-A").durability, "committed");
  assert.equal(JSON.parse(git(root, "show", "HEAD:.hunch/constraints/con_shared.json")).statement, "rule EDITED BY HELD CAPTURE", "only new files stay out: the edit is swept, as before");
  assert.equal(git(root, "status", "--porcelain", "--", ".hunch/constraints"), "");
  assertLedgerClosed(root);
});

test("#642: the held list is pruned once the held capture is committed by hand", t => {
  isolateStateEnv(t);
  const { root, commits, capture } = repo(t, undefined, true);
  assert.equal(capture("con_held"), "held");
  assert.ok(existsSync(heldList(root)));
  git(root, "add", "--", ".hunch/constraints/con_held.json");
  git(root, "commit", "-q", "-m", "user: commit the held capture");
  assert.equal(writeCommitment(root, "A", "idem-key-A").durability, "committed");
  assert.equal(commits(), 3);
  assert.ok(!existsSync(heldList(root)), "nothing held is dirty any more: the list is gone");
  assert.ok(!everCommitted(root).some((f) => f.startsWith(".hunch-cache/")), "the held list is never committed");
  assertLedgerClosed(root);
});

test("#642: with no held list a state write is exactly base: every dirty file is committed, unknown ones too", t => {
  isolateStateEnv(t);
  const { root } = repo(t, undefined);
  mkdirSync(join(root, ".hunch", "constraints"), { recursive: true });
  writeFileSync(join(root, ".hunch", "constraints", "con_unknown.json"), JSON.stringify(mkConstraint({ id: "con_unknown", statement: "rule unknown", scope: ["src/**"] }), null, 2) + "\n");
  assert.notEqual(publicCommitHold(hunchPaths(root).hunch), null, "the default hold is active on main");
  assert.equal(writeCommitment(root, "A", "idem-key-A").durability, "committed");
  assert.ok(headFiles(root).includes(".hunch/constraints/con_unknown.json"), "the unknown dirty file is swept, as before");
  assert.ok(!existsSync(heldList(root)));
  assertLedgerClosed(root);
});

test("#642: when the policy allows the branch, a state write sweeps as before", t => {
  isolateStateEnv(t);
  const { root, capture, hunch } = repo(t, LEDGER);
  assert.equal(capture("con_held"), "held", "main is not listed");
  assert.ok(existsSync(heldList(root)));
  git(root, "checkout", "-q", "-b", "hunch/ledger");
  assert.equal(publicCommitHold(hunch), null);
  assert.equal(writeCommitment(root, "A", "idem-key-A").durability, "committed");
  assert.ok(headFiles(root).includes(".hunch/constraints/con_held.json"), "a listed branch commits everything");
  assertLedgerClosed(root);
});

test("#642: index-file kinds: a held entity capture keeps entities/index.json out; a state entity write commits it beside a held capture", t => {
  isolateStateEnv(t);
  const { root, hunch } = repo(t, undefined, true);
  const store = new HunchStore(hunchPaths(root));
  try {
    store.json.ensureDirs();
    const scope = repositoryScope(store);
    store.json.put("entities", entityRecord(scope, "customer:held-1") as never);
    assert.equal(flushCapture(store, hunch, false, "hunch: capture entity", undefined, undefined, "entities"), "held");
  } finally { store.close(); }
  assert.equal(writeCommitment(root, "A", "idem-key-A").durability, "committed");
  assert.ok(!headFiles(root).includes(".hunch/entities/index.json"), "the held entity index is not swept in");
  assertLedgerClosed(root);

  // The other direction: a state entity write beside a held constraint capture commits its index.
  const second = repo(t, undefined, true);
  assert.equal(second.capture("con_held"), "held");
  const state = new HunchStore(hunchPaths(second.root));
  try {
    const scope = repositoryScope(state);
    const principal = { id: "sofia@david", kind: "agent", grants: [scope] };
    const write = { schema: "nuryel.state.write/1", principal, scope, facet: "entities", idempotency_key: "idem-ent-1", record: entityRecord(scope, "customer:clinic-7") };
    assert.equal(writeState(state, write, { flush: (isPrivate, message) => flushStateWrite(state, second.hunch, isPrivate, message) }).durability, "committed");
  } finally { state.close(); }
  const files = headFiles(second.root);
  assert.ok(files.includes(".hunch/entities/index.json"), "the state entity index is committed");
  assert.ok(!files.includes(".hunch/constraints/con_held.json"), "the held capture is not swept in");
  assertLedgerClosed(second.root);
});

/** A state write of constraint `con_shared` by a human (flush, no flush, or flush refused by a staged user file). */
function writeSharedConstraint(root: string, statement: string, flush: boolean): { outcome: string; durability: string } {
  const hunch = hunchPaths(root).hunch;
  const store = new HunchStore(hunchPaths(root));
  try {
    store.json.ensureDirs();
    const scope = repositoryScope(store);
    const principal = { id: "david", kind: "human", grants: [scope] };
    const record = mkConstraint({ id: "con_shared", statement, scope: ["src/**"] });
    const result = writeState(store, { schema: "nuryel.state.write/1", principal, scope, facet: "constraints", record, idempotency_key: "idem-con-1" }, flush ? { flush: (isPrivate, message) => flushStateWrite(store, hunch, isPrivate, message) } : {});
    return { outcome: result.outcome, durability: result.durability };
  } finally { store.close(); }
}
function heldEditOfShared(root: string): void {
  const store = new HunchStore(hunchPaths(root));
  try {
    store.json.put("constraints", { ...store.json.get("constraints", "con_shared")!, statement: "rule EDITED BY HELD CAPTURE" });
    assert.equal(flushCapture(store, hunchPaths(root).hunch, false, "hunch: edit con_shared"), "held");
  } finally { store.close(); }
}
const cleanFor = (root: string, path: string): string => git(root, "status", "--porcelain", "--", path);

for (const variant of ["refused flush", "no flush"] as const) {
  test(`#642 A1 (${variant}): a stranded state record a held capture then edits is swept, so the ledger stays closed`, t => {
    isolateStateEnv(t);
    const { root } = repo(t, undefined, true);
    if (variant === "refused flush") {
      mkdirSync(join(root, "src"), { recursive: true });
      writeFileSync(join(root, "src", "a.ts"), "export const a = 1;\n");
      git(root, "add", "--", "src/a.ts");
    }
    const first = writeSharedConstraint(root, "rule v1", variant === "refused flush");
    assert.equal(first.durability, "local");
    if (variant === "refused flush") git(root, "commit", "-q", "-m", "user: a.ts");
    heldEditOfShared(root);
    assert.equal(writeCommitment(root, "A", "idem-key-A").durability, "committed");
    assert.ok(headFiles(root).includes(".hunch/constraints/con_shared.json"), "the record the ledger names is in HEAD");
    assert.equal(cleanFor(root, ".hunch/constraints/con_shared.json"), "", "and nothing of it is left dirty");
    assertLedgerClosed(root);
  });
}

test("#642 A2: a state replay onto a held capture sweeps it, so its idempotency entry names a record in HEAD", t => {
  isolateStateEnv(t);
  const { root, capture } = repo(t, undefined);
  assert.equal(capture("con_shared"), "held");
  const store = new HunchStore(hunchPaths(root));
  let record: unknown;
  try { record = store.json.get("constraints", "con_shared"); } finally { store.close(); }
  const state = new HunchStore(hunchPaths(root));
  try {
    const scope = repositoryScope(state);
    const principal = { id: "david", kind: "human", grants: [scope] };
    const result = writeState(state, { schema: "nuryel.state.write/1", principal, scope, facet: "constraints", record, idempotency_key: "idem-con-1" }, { flush: (isPrivate, message) => flushStateWrite(state, hunchPaths(root).hunch, isPrivate, message) });
    assert.equal(result.durability, "committed");
  } finally { state.close(); }
  assert.ok(headFiles(root).includes(".hunch/constraints/con_shared.json"), "the replayed record is in HEAD");
  assert.equal(cleanFor(root, ".hunch/constraints/con_shared.json"), "");
  assertLedgerClosed(root);
});

test("#642 R6: a held edit of a committed state record gets base behavior: a later state write sweeps it", t => {
  isolateStateEnv(t);
  const { root } = repo(t, undefined);
  assert.equal(writeSharedConstraint(root, "rule con_shared", true).durability, "committed");
  heldEditOfShared(root);
  assert.equal(writeCommitment(root, "A", "idem-key-A").durability, "committed");
  assert.equal(JSON.parse(git(root, "show", "HEAD:.hunch/constraints/con_shared.json")).statement, "rule EDITED BY HELD CAPTURE", "the edit is swept, as before");
  assert.equal(cleanFor(root, ".hunch/constraints/con_shared.json"), "");
  assertLedgerClosed(root);
});

test("#642: manifest.json is never held, and a dirty manifest sends the state write to base", t => {
  isolateStateEnv(t);
  const { root, capture } = repo(t, undefined);
  assert.equal(capture("con_held"), "held");
  assert.doesNotMatch(readFileSync(heldList(root), "utf8"), /manifest\.json/);
  assert.equal(writeCommitment(root, "A", "idem-key-A").durability, "committed");
  assert.ok(headFiles(root).includes(".hunch/manifest.json"), "the manifest is committed");
  assert.ok(headFiles(root).includes(".hunch/constraints/con_held.json"), "with everything else dirty, as base");
  assertLedgerClosed(root);
});

test("#642: a held migration that rewrites the committed manifest is unattributable: the state write sweeps, so HEAD keeps records and manifest in step", t => {
  isolateStateEnv(t);
  const { root, hunch } = repo(t, undefined);
  const paths = hunchPaths(root);
  mkdirSync(join(hunch, "constraints"), { recursive: true });
  const raw: Record<string, unknown> = { ...mkConstraint({ id: "con_old", statement: "rule from schema v1", scope: ["src/**"] }) };
  delete raw.status; delete raw.valid_to; delete raw.valid_from;
  writeFileSync(join(hunch, "constraints", "con_old.json"), JSON.stringify(raw, null, 2) + "\n");
  writeFileSync(join(hunch, "manifest.json"), JSON.stringify({ schema_version: 1 }, null, 2) + "\n");
  git(root, "add", "-A");
  git(root, "commit", "-q", "-m", "v1 store");
  const store = new HunchStore(paths);
  try {
    const result = store.json.persistMigration();
    writeManifest(paths, result.version);
    store.reindex();
    assert.equal(flushMemoryHome(store, hunch, "public", "hunch: migrate schema"), "held");
  } finally { store.close(); }
  assert.equal(writeCommitment(root, "A", "idem-key-A").durability, "committed");
  assert.ok("status" in JSON.parse(git(root, "show", "HEAD:.hunch/constraints/con_old.json")), "HEAD has the migrated record");
  assert.notEqual(JSON.parse(git(root, "show", "HEAD:.hunch/manifest.json")).schema_version, 1, "with the manifest it was migrated to");
  assert.equal(git(root, "status", "--porcelain", "--", ".hunch", ":!.hunch/*.sqlite*"), "", "nothing is left behind");
  assertLedgerClosed(root);
});

test("#642: an unborn HEAD gives no exact dirty set: the state write commits everything base would", t => {
  isolateStateEnv(t);
  const root = realpathSync(mkdtempSync(join(tmpdir(), "hunch-autocommit-unborn-")));
  t.after(() => cleanupDir(root));
  git(root, "init", "-q", "-b", "main");
  writeFileSync(join(root, ".gitignore"), ".hunch-cache/\n.hunch/local.json\n.hunch/*.sqlite*\n");
  const hunch = hunchPaths(root).hunch;
  mkdirSync(hunch, { recursive: true });
  writeFileSync(join(hunch, "config.json"), JSON.stringify({ auto_commit: false }, null, 2) + "\n");
  const zero = writeCommitment(root, "zero", "idem-key-zero", false);
  git(root, "add", "--", ".hunch");
  const store = new HunchStore(hunchPaths(root));
  try {
    store.json.put("constraints", mkConstraint({ id: "con_held", statement: "rule held", scope: ["src/**"] }));
    assert.equal(flushCapture(store, hunch, false, "hunch: capture con_held"), "held");
  } finally { store.close(); }
  const one = writeCommitment(root, "one", "idem-key-one");
  assert.equal(one.durability, "committed");
  const files = headFiles(root);
  for (const file of [`.hunch/commitments/${zero.id}.json`, `.hunch/commitments/${one.id}.json`, ".hunch/constraints/con_held.json"]) assert.ok(files.includes(file), `${file} is in HEAD: ${files.join(", ")}`);
  if (existsSync(join(hunch, "manifest.json"))) assert.ok(files.includes(".hunch/manifest.json"), "the manifest is in HEAD");
  assert.equal(git(root, "status", "--porcelain", "--", ".hunch", ":!.hunch/*.sqlite*"), "", "nothing staged or dirty is left behind");
  assertLedgerClosed(root);
});

test("#642 legacy: a held migration of a store with no committed manifest commits records and manifest together", t => {
  isolateStateEnv(t);
  const { root, hunch } = repo(t, undefined);
  writeFileSync(join(root, ".gitignore"), ".hunch-cache/\n.hunch/local.json\n.hunch/*.sqlite*\n");
  mkdirSync(join(hunch, "constraints"), { recursive: true });
  const raw: Record<string, unknown> = { ...mkConstraint({ id: "con_old", statement: "rule from schema v1", scope: ["src/**"] }) };
  delete raw.status; delete raw.valid_to; delete raw.valid_from;
  writeFileSync(join(hunch, "constraints", "con_old.json"), JSON.stringify(raw, null, 2) + "\n");
  git(root, "add", "-A");
  git(root, "commit", "-q", "-m", "legacy v1 store, no manifest");
  const paths = hunchPaths(root);
  const store = new HunchStore(paths);
  try {
    const result = store.json.persistMigration();
    writeManifest(paths, result.version);
    store.reindex();
    assert.equal(flushMemoryHome(store, hunch, "public", "hunch: migrate schema"), "held");
  } finally { store.close(); }
  assert.equal(writeCommitment(root, "A", "idem-key-A").durability, "committed");
  const files = headFiles(root);
  if (files.includes(".hunch/manifest.json")) assert.ok("status" in JSON.parse(git(root, "show", "HEAD:.hunch/constraints/con_old.json")), "a committed manifest comes with the records it migrated");
  assert.equal(git(root, "status", "--porcelain", "--", ".hunch"), "", "nothing is left behind, as base");
  assertLedgerClosed(root);
});

test("#642 replay: an exact replay of a committed record a held capture edited sweeps the edit, as base", t => {
  isolateStateEnv(t);
  const { root } = repo(t, undefined, true);
  const hunch = hunchPaths(root).hunch;
  assert.equal(writeSharedConstraint(root, "rule v1", true).durability, "committed");
  heldEditOfShared(root);
  assert.equal(writeCommitment(root, "stayed-local", "idem-key-local", false).durability, "local");
  const store = new HunchStore(hunchPaths(root));
  try {
    const scope = repositoryScope(store);
    const principal = { id: "david", kind: "human", grants: [scope] };
    const record = mkConstraint({ id: "con_shared", statement: "rule v1", scope: ["src/**"] });
    const result = writeState(store, { schema: "nuryel.state.write/1", principal, scope, facet: "constraints", record, idempotency_key: "idem-con-1" }, { flush: (isPrivate, message) => flushStateWrite(store, hunch, isPrivate, message) });
    assert.equal(result.outcome, "replayed");
    assert.equal(result.durability, "committed");
  } finally { store.close(); }
  assert.equal(JSON.parse(git(root, "show", "HEAD:.hunch/constraints/con_shared.json")).statement, "rule EDITED BY HELD CAPTURE", "HEAD matches the working tree, as base");
  assert.equal(git(root, "status", "--porcelain", "--", ".hunch"), "", "nothing is left behind");
  assertLedgerClosed(root);
});

const decisionRecord = (id: string, over: Record<string, unknown> = {}) => SCHEMAS.decisions.parse({ id, title: `session storage ${id}`, status: "accepted", context: "c", decision: `use ${id}`, consequences: [], alternatives_rejected: [], related_components: [], related_files: ["src/auth.ts"], supersedes: null, caused_by_bug: null, commit: null, provenance: { source: "human_confirmed", confidence: 0.9, evidence: [] }, date: "2026-01-01T00:00:00Z", valid_from: "2026-01-01T00:00:00Z", topic: "auth-session", ...over });
/** A seeded repo whose HEAD also has `seedRecords` written through the store. */
function committedRepo(t: { after: (f: () => void) => void }, seedRecords: (store: HunchStore) => void): { root: string; hunch: string } {
  const { root, hunch } = repo(t, undefined, true);
  const store = new HunchStore(hunchPaths(root));
  try { seedRecords(store); store.reindex(); } finally { store.close(); }
  git(root, "add", "-A");
  git(root, "commit", "-q", "-m", "seed records");
  return { root, hunch };
}

test("#642: a held supersede is one unit: a later state write commits the successor with the superseded decision", t => {
  isolateStateEnv(t);
  const { root, hunch } = committedRepo(t, (store) => { store.putCapture("decisions", decisionRecord("dec_old")); });
  const store = new HunchStore(hunchPaths(root));
  try {
    const rec = store.putCapture("decisions", decisionRecord("dec_new", { supersedes: "dec_old", valid_from: "2026-11-15T00:00:00Z", date: "2026-11-15T00:00:00Z" }));
    assert.ok(store.supersede("dec_old", rec));
    store.reindex();
    assert.equal(flushCapture(store, hunch, false, "hunch: capture dec_new"), "held");
  } finally { store.close(); }
  assert.equal(writeCommitment(root, "A", "idem-key-A").durability, "committed");
  const old = JSON.parse(git(root, "show", "HEAD:.hunch/decisions/dec_old.json"));
  assert.equal(old.superseded_by, "dec_new");
  assert.ok(headFiles(root).includes(".hunch/decisions/dec_new.json"), "no dangling successor: dec_new rides along");
  assert.equal(git(root, "status", "--porcelain", "--", ".hunch", ":!.hunch/*.sqlite*"), "");
  assertLedgerClosed(root);
});

test("#642: a held correction that retires a constraint is one unit: the replacement is committed with the retire", t => {
  isolateStateEnv(t);
  const { root, hunch } = committedRepo(t, (store) => { store.putCapture("constraints", mkConstraint({ id: "con_old", statement: "rule old", scope: ["src/**"] })); });
  const store = new HunchStore(hunchPaths(root));
  try {
    store.putCapture("constraints", mkConstraint({ id: "con_new", statement: "rule new", scope: ["src/**"] }));
    store.putCapture("constraints", { ...store.json.get("constraints", "con_old")!, status: "retired", valid_to: "2026-11-15T00:00:00Z" });
    assert.equal(flushCapture(store, hunch, false, "hunch: correction"), "held");
  } finally { store.close(); }
  assert.ok(!existsSync(heldList(root)) || !readFileSync(heldList(root), "utf8").includes("con_new"), "a batch that edits a tracked file is not held");
  assert.equal(writeCommitment(root, "A", "idem-key-A").durability, "committed");
  assert.equal(JSON.parse(git(root, "show", "HEAD:.hunch/constraints/con_old.json")).status, "retired");
  assert.ok(headFiles(root).includes(".hunch/constraints/con_new.json"), "the replacement is committed with the retire");
  assertLedgerClosed(root);
});

test("#642: a pure-new held capture stays out when a later tracked edit from another batch does not name it", t => {
  isolateStateEnv(t);
  const { root, hunch } = committedRepo(t, (store) => { store.putCapture("constraints", mkConstraint({ id: "con_tracked", statement: "rule tracked", scope: ["src/**"] })); });
  const store = new HunchStore(hunchPaths(root));
  try {
    store.putCapture("constraints", mkConstraint({ id: "con_held", statement: "rule held", scope: ["src/**"] }));
    assert.equal(flushCapture(store, hunch, false, "hunch: capture con_held"), "held");
    store.putCapture("constraints", { ...store.json.get("constraints", "con_tracked")!, statement: "rule tracked, edited" });
    assert.equal(flushCapture(store, hunch, false, "hunch: edit con_tracked"), "held");
  } finally { store.close(); }
  assert.equal(writeCommitment(root, "A", "idem-key-A").durability, "committed");
  assert.equal(JSON.parse(git(root, "show", "HEAD:.hunch/constraints/con_tracked.json")).statement, "rule tracked, edited", "the tracked edit is swept, as base");
  assert.ok(!headFiles(root).includes(".hunch/constraints/con_held.json"), "the earlier new capture stays out");
  assert.ok(untracked(root).includes(".hunch/constraints/con_held.json"));
  assertLedgerClosed(root);
});

test("#642: a held new record that a committed file names is committed with it", t => {
  isolateStateEnv(t);
  const { root, hunch } = committedRepo(t, (store) => { store.putCapture("constraints", mkConstraint({ id: "con_tracked", statement: "rule tracked", scope: ["src/**"] })); });
  const store = new HunchStore(hunchPaths(root));
  try {
    store.putCapture("constraints", mkConstraint({ id: "con_ref", statement: "rule referenced", scope: ["src/**"] }));
    assert.equal(flushCapture(store, hunch, false, "hunch: capture con_ref"), "held");
    store.putCapture("constraints", { ...store.json.get("constraints", "con_tracked")!, statement: "rule tracked, see con_ref" });
    assert.equal(flushCapture(store, hunch, false, "hunch: edit con_tracked"), "held");
  } finally { store.close(); }
  assert.match(readFileSync(heldList(root), "utf8"), /con_ref/, "fixture: con_ref is on the held list");
  assert.equal(writeCommitment(root, "A", "idem-key-A").durability, "committed");
  assert.ok(headFiles(root).includes(".hunch/constraints/con_ref.json"), "the referenced record is not left out");
  assert.equal(git(root, "status", "--porcelain", "--", ".hunch", ":!.hunch/*.sqlite*"), "");
  assertLedgerClosed(root);
});

/** Seam hook: between the hold-back decision and the commit, rewrite the state record being
 *  committed so its bytes name `id` (a capture landing in the window, e.g. a supersede). */
function nameHeldInWindow(root: string, id: string): () => void {
  return () => {
    const dir = join(root, ".hunch", "commitments");
    for (const name of readdirSync(dir).filter((n) => n.endsWith(".json"))) {
      const file = join(dir, name);
      writeFileSync(file, JSON.stringify({ ...JSON.parse(readFileSync(file, "utf8")), note: `supersedes ${id}` }, null, 2) + "\n");
    }
  };
}

test("#642 race: a held record a committed file names only after the decision is carried by a follow-up commit", t => {
  isolateStateEnv(t);
  const { root, capture } = repo(t, undefined, true);
  assert.equal(capture("con_old"), "held");
  assert.match(readFileSync(heldList(root), "utf8"), /con_old/, "fixture: con_old is on the held list");
  __setAfterHoldBackDecisionForTests(nameHeldInWindow(root, "con_old"));
  t.after(() => __setAfterHoldBackDecisionForTests(null));
  let written: { id: string; durability: string };
  try { written = writeCommitment(root, "A", "idem-key-A"); } finally { __setAfterHoldBackDecisionForTests(null); }
  assert.equal(written.durability, "committed");
  const files = headFiles(root);
  assert.match(git(root, "show", `HEAD:.hunch/commitments/${written.id}.json`), /con_old/, "fixture: HEAD's state record names con_old");
  assert.ok(files.includes(".hunch/constraints/con_old.json"), "the record HEAD names is in HEAD, via the follow-up commit");
  assert.match(git(root, "log", "-1", "--format=%B"), /carries held records the commit above references/);
  assert.ok(!existsSync(heldList(root)) || !readFileSync(heldList(root), "utf8").includes("con_old"), "con_old is no longer held");
  assertLedgerClosed(root);
});

test("#642 race backstop: with no reference in the window the held record stays out and stays held", t => {
  isolateStateEnv(t);
  const { root, commits, capture } = repo(t, undefined, true);
  assert.equal(capture("con_old"), "held");
  const written = writeCommitment(root, "A", "idem-key-A");
  assert.equal(written.durability, "committed");
  assert.equal(commits(), 2, "no follow-up commit");
  assert.ok(!headFiles(root).includes(".hunch/constraints/con_old.json"), "con_old is not in HEAD");
  assert.match(readFileSync(heldList(root), "utf8"), /constraints\/con_old\.json/, "con_old is still held");
  assertLedgerClosed(root);
});

/** repo() whose committed CLAUDE.md carries a generated Hunch block, so a state commit can be
 *  checked for refreshing it. */
function groundedRepo(t: { after: (f: () => void) => void }): ReturnType<typeof repo> {
  const made = repo(t, undefined, true);
  writeFileSync(join(made.root, "CLAUDE.md"), "# project\n");
  const store = new HunchStore(hunchPaths(made.root));
  try { updateClaudeMd(made.root, store); } finally { store.close(); }
  git(made.root, "add", "-A");
  git(made.root, "commit", "-q", "-m", "grounding");
  return made;
}
const claudeMdClean = (root: string): boolean => {
  const store = new HunchStore(hunchPaths(root));
  try { updateClaudeMd(root, store); } finally { store.close(); }
  return git(root, "status", "--porcelain", "--", "CLAUDE.md") === "";
};

test("#642 R2-F1: when nothing is held back the state commit carries the refreshed grounding docs", t => {
  isolateStateEnv(t);
  const { root, capture } = groundedRepo(t);
  assert.equal(capture("con_held"), "held");
  // The held file's bytes change after the hold: it is no candidate, so base sweeps it.
  const file = join(root, ".hunch", "constraints", "con_held.json");
  writeFileSync(file, readFileSync(file, "utf8").replace("rule con_held", "rule con_held, edited"));
  assert.equal(writeSharedConstraint(root, "state rule shared", true).durability, "committed");
  assert.ok(headFiles(root).includes(".hunch/constraints/con_held.json"), "fixture: nothing was held back");
  assert.ok(git(root, "show", "--name-only", "--format=", "HEAD").split("\n").includes("CLAUDE.md"), "CLAUDE.md rides the state commit");
  assert.ok(claudeMdClean(root), "the committed CLAUDE.md is current");
});

test("#642 R2-F1: when a candidate is held back the grounding docs stay out of the state commit (documented residual)", t => {
  isolateStateEnv(t);
  const { root, capture } = groundedRepo(t);
  assert.equal(capture("con_held"), "held");
  assert.equal(writeSharedConstraint(root, "state rule shared", true).durability, "committed");
  assert.ok(!headFiles(root).includes(".hunch/constraints/con_held.json"), "fixture: the capture is held back");
  assert.ok(!git(root, "show", "--name-only", "--format=", "HEAD").split("\n").includes("CLAUDE.md"), "held records are not counted in committed docs");
});

test("#642 R2-F2: a held file the user staged by hand is committed, never unstaged", t => {
  isolateStateEnv(t);
  const { root, capture } = repo(t, undefined, true);
  assert.equal(capture("con_held"), "held");
  git(root, "add", ".hunch/constraints/con_held.json");
  assert.equal(writeCommitment(root, "A", "idem-key-A").durability, "committed");
  assert.ok(headFiles(root).includes(".hunch/constraints/con_held.json"), "the user-staged file is in HEAD, as base");
  assert.ok(!existsSync(heldList(root)) || !readFileSync(heldList(root), "utf8").includes("con_held"), "it is no longer held");
});

test("#642 R2-F2: a held file the user marked intent-to-add (git add -N) is committed, never held back", t => {
  isolateStateEnv(t);
  const { root, capture } = repo(t, undefined, true);
  assert.equal(capture("con_held"), "held");
  git(root, "add", "-N", ".hunch/constraints/con_held.json");
  assert.equal(writeCommitment(root, "A", "idem-key-A").durability, "committed");
  assert.ok(headFiles(root).includes(".hunch/constraints/con_held.json"), "the intent-to-add file is in HEAD, as base");
  assert.equal(git(root, "status", "--porcelain", "--", ".hunch/constraints/con_held.json"), "", "its status is clean");
});

test("#642 R2-F3: a held index.json with 900 ids is checked in chunks and stays out", t => {
  isolateStateEnv(t);
  const { root, hunch, commits } = repo(t, undefined, true);
  mkdirSync(join(hunch, "entities"), { recursive: true });
  const body = JSON.stringify(Array.from({ length: 900 }, (_, i) => ({ id: `customer:clinic-${String(i).padStart(6, "0")}` })));
  writeFileSync(join(hunch, "entities", "index.json"), body);
  mkdirSync(join(hunch, "commitments"), { recursive: true });
  writeFileSync(join(hunch, "commitments", "cmt_x.json"), JSON.stringify({ id: "cmt_x" }));
  let still: string[] | null = null;
  const entries = { "entities/index.json": createHash("sha256").update(body).digest("hex") };
  assert.equal(commitAndPushHunch(hunch, "hunch: state write", { push: false, holdBack: { entries, onResult: (paths) => { still = paths; } } }), "committed");
  assert.equal(commits(), 2, "one state commit, no carry commit");
  assert.ok(!headFiles(root).includes(".hunch/entities/index.json"), "the held index stays out");
  assert.deepEqual(still, ["entities/index.json"]);
});

test("#642 R2-F3: a held index.json with more ids than the cap is committed with the state write (base)", t => {
  isolateStateEnv(t);
  const { root, hunch, commits } = repo(t, undefined, true);
  mkdirSync(join(hunch, "entities"), { recursive: true });
  const body = JSON.stringify(Array.from({ length: 1500 }, (_, i) => ({ id: `customer:clinic-${String(i).padStart(6, "0")}` })));
  writeFileSync(join(hunch, "entities", "index.json"), body);
  mkdirSync(join(hunch, "commitments"), { recursive: true });
  writeFileSync(join(hunch, "commitments", "cmt_x.json"), JSON.stringify({ id: "cmt_x" }));
  let still: string[] | null = null;
  const entries = { "entities/index.json": createHash("sha256").update(body).digest("hex") };
  assert.equal(commitAndPushHunch(hunch, "hunch: state write", { push: false, holdBack: { entries, onResult: (paths) => { still = paths; } } }), "committed");
  assert.equal(commits(), 2, "one state commit, no carry commit");
  assert.ok(headFiles(root).includes(".hunch/entities/index.json"), "over the cap nothing is held back: the index is in HEAD, as base");
  assert.deepEqual(still, [], "the held list no longer lists it");
});

/** One state write of constraint `id` through flushStateWrite; a second call with the same id is an exact replay. */
function stateConstraint(root: string, id: string): { outcome: string; durability: string } {
  const store = new HunchStore(hunchPaths(root));
  try {
    const scope = repositoryScope(store);
    const principal = { id: "david", kind: "human", grants: [scope] };
    const record = mkConstraint({ id, statement: `state rule ${id}`, scope: ["src/**"] });
    const result = writeState(store, { schema: "nuryel.state.write/1", principal, scope, facet: "constraints", record, idempotency_key: `idem-${id}` }, { flush: (isPrivate, message) => flushStateWrite(store, hunchPaths(root).hunch, isPrivate, message) });
    return { outcome: result.outcome, durability: result.durability };
  } finally { store.close(); }
}
/** Held con_x; a committed state record con_s0; the user then commits (commit -a) an edit of con_s0 that names con_x. */
function headNamesHeldRepo(t: { after: (f: () => void) => void }): ReturnType<typeof repo> {
  isolateStateEnv(t);
  const made = groundedRepo(t);
  const { root } = made;
  assert.equal(made.capture("con_x"), "held");
  assert.equal(stateConstraint(root, "con_s0").durability, "committed");
  assert.ok(!headFiles(root).includes(".hunch/constraints/con_x.json"), "fixture: con_x was held back");
  const file = join(root, ".hunch", "constraints", "con_s0.json");
  const rec = JSON.parse(readFileSync(file, "utf8"));
  rec.statement = `${rec.statement} (see con_x)`;
  writeFileSync(file, `${JSON.stringify(rec, null, 2)}\n`);
  git(root, "commit", "-q", "-am", "user wip");
  assert.match(git(root, "grep", "-l", "-F", "con_x", "HEAD", "--", ".hunch"), /con_s0\.json/, "fixture: HEAD names con_x");
  return made;
}

test("#642: an exact-replay state write commits a held record HEAD already names (base sweeps it)", t => {
  const { root } = headNamesHeldRepo(t);
  assert.equal(stateConstraint(root, "con_s0").outcome, "replayed", "fixture: the second identical write is an exact replay");
  assert.ok(headFiles(root).includes(".hunch/constraints/con_x.json"), "HEAD names con_x, so con_x is in HEAD after the state flush");
  assert.ok(!existsSync(heldList(root)) || !readFileSync(heldList(root), "utf8").includes("con_x"), "it is off the held list");
});

test("#642: a state write when HEAD already names a held record commits it in one commit, and the committed CLAUDE.md is current", t => {
  const { root, commits } = headNamesHeldRepo(t);
  const before = commits();
  assert.equal(stateConstraint(root, "con_s1").durability, "committed");
  assert.equal(commits(), before + 1, "one commit for the write, no carry commit");
  assert.ok(headFiles(root).includes(".hunch/constraints/con_x.json"), "con_x is in HEAD: nothing is held back");
  assert.ok(claudeMdClean(root), "the committed CLAUDE.md is current");
});

/** Held con_x; the user commits (commit -a) an edit of the tracked markdown file `rel` that names con_x. */
function markdownNamesHeldRepo(t: { after: (f: () => void) => void }, rel: string, body: string): ReturnType<typeof repo> {
  isolateStateEnv(t);
  const made = groundedRepo(t);
  const { root } = made;
  mkdirSync(join(root, rel, ".."), { recursive: true });
  if (rel !== "CLAUDE.md") {
    writeFileSync(join(root, rel), "# auth\n");
    git(root, "add", "-A");
    git(root, "commit", "-q", "-m", "docs");
  }
  assert.equal(made.capture("con_x"), "held");
  assert.ok(!headFiles(root).includes(".hunch/constraints/con_x.json"), "fixture: con_x was held back");
  const file = join(root, rel);
  writeFileSync(file, rel === "CLAUDE.md" ? `${readFileSync(file, "utf8")}\n${body}\n` : body);
  git(root, "commit", "-q", "-am", "user wip");
  assert.match(git(root, "show", `HEAD:${rel}`), /con_x/, "fixture: the committed markdown names con_x");
  assert.ok(!headFiles(root).includes(".hunch/constraints/con_x.json"), "fixture: git commit -am leaves con_x.json untracked");
  return made;
}

test("#642: a committed CLAUDE.md that names a held record sends the state write to base (con_x is committed)", t => {
  const { root } = markdownNamesHeldRepo(t, "CLAUDE.md", "See con_x for the rule.");
  assert.equal(stateConstraint(root, "con_s1").durability, "committed");
  assert.ok(headFiles(root).includes(".hunch/constraints/con_x.json"), "HEAD CLAUDE.md names con_x, so con_x is in HEAD");
});

test("#642: a committed docs/auth.md doc anchor that names a held record sends the state write to base", t => {
  const { root } = markdownNamesHeldRepo(t, "docs/auth.md", "# auth\n<!-- hunch:topic auth-session con_x -->\n");
  assert.equal(stateConstraint(root, "con_s1").durability, "committed");
  assert.ok(headFiles(root).includes(".hunch/constraints/con_x.json"), "the anchor names con_x, so con_x is in HEAD");
});
