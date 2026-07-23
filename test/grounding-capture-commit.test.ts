/**
 * Kills the refresh-counts treadmill: every public capture bumps record counts, so the
 * generated grounding blocks (CLAUDE.md, AGENTS.md, …) went stale on the very commit that
 * captured a decision — and the release gate's clean-tree check failed on the next CI
 * `hunch index`. A capture flush must now refresh git-CLEAN grounding docs and fold them
 * into the SAME memory commit, while a user-dirty doc is never touched and never swept.
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { execFileSync, spawnSync } from "node:child_process";
import { commitAndPushHunch } from "../src/extractors/git.js";
import { flushCapture } from "../src/integrations/sync.js";
import { updateClaudeMd } from "../src/integrations/claudemd.js";
import { hunchPaths } from "../src/core/paths.js";
import type { Decision } from "../src/core/types.js";
import { HunchStore } from "../src/store/hunchStore.js";
import { indexRepo } from "../src/extractors/indexer.js";
import { ensureGitignore } from "../src/integrations/gitignore.js";

const PROJECT_ROOT = process.cwd();
const TSX = join(PROJECT_ROOT, "node_modules/tsx/dist/cli.mjs");
const CLI = join(PROJECT_ROOT, "src/cli/index.ts");

function repo(prefix: string): { root: string; git: (...a: string[]) => string; cleanup: () => void } {
  const root = mkdtempSync(join(tmpdir(), prefix));
  const git = (...a: string[]) => execFileSync("git", ["-C", root, ...a], { encoding: "utf8" }).trim();
  git("init", "-q");
  git("config", "user.email", "t@t.co");
  git("config", "user.name", "T");
  git("config", "commit.gpgsign", "false");
  return { root, git, cleanup: () => rmSync(root, { recursive: true, force: true }) };
}

function decision(id: string, title: string): Decision {
  return {
    id,
    title,
    topic: null,
    status: "accepted",
    context: "fixture",
    decision: `Keep the ${title} behavior.`,
    consequences: [],
    alternatives_rejected: [],
    rejected_tripwires: [],
    related_components: [],
    related_files: [],
    supersedes: null,
    superseded_by: null,
    caused_by_bug: null,
    commit: null,
    valid_to: null,
    retired: { symbols: [], deps: [] },
    provenance: { source: "human_confirmed", confidence: 0.95, evidence: [] },
    date: "2026-01-01T00:00:00.000Z",
  };
}

test("commitAndPushHunch folds alsoStage files into the memory commit, after the safety backstop", () => {
  const { root, git, cleanup } = repo("hunch-alsostage-");
  try {
    writeFileSync(join(root, "CLAUDE.md"), "# doc\n");
    git("add", "-A");
    git("commit", "-qm", "init");

    mkdirSync(join(root, ".hunch", "decisions"), { recursive: true });
    writeFileSync(join(root, ".hunch", "decisions", "dec_1.json"), JSON.stringify({ id: "dec_1", title: "x" }));
    writeFileSync(join(root, "CLAUDE.md"), "# doc\nrefreshed counts\n");
    const r = commitAndPushHunch(join(root, ".hunch"), "hunch: capture dec_1", { push: false, alsoStage: [join(root, "CLAUDE.md")] });

    assert.equal(r, "committed");
    assert.equal(git("status", "--porcelain"), "", "the grounding refresh rides the capture commit — clean tree");
    const committed = git("show", "HEAD", "--name-only", "--format=");
    assert.match(committed, /decisions\/dec_1\.json/);
    assert.match(committed, /CLAUDE\.md/);
  } finally { cleanup(); }
});

test("alsoStage never rescues a refused non-memory staged set", () => {
  const { root, git, cleanup } = repo("hunch-alsostage-guard-");
  try {
    writeFileSync(join(root, "app.ts"), "export const x = 1;");
    writeFileSync(join(root, "CLAUDE.md"), "# doc\n");
    git("add", "-A");
    git("commit", "-qm", "code");
    const before = git("rev-list", "--count", "HEAD");

    git("rm", "-q", "app.ts"); // the bug_overlay_clobber shape: a staged deletion
    mkdirSync(join(root, ".hunch"), { recursive: true });
    const r = commitAndPushHunch(join(root, ".hunch"), "hunch: capture", { push: false, alsoStage: [join(root, "CLAUDE.md")] });

    assert.equal(r, null, "backstop refusal wins; alsoStage is ignored");
    assert.equal(git("rev-list", "--count", "HEAD"), before, "no commit was created");
  } finally { cleanup(); }
});

test("flushCapture refreshes a git-clean grounding doc and commits it with the capture", () => {
  const { root, git, cleanup } = repo("hunch-flush-clean-");
  try {
    const store = new HunchStore(hunchPaths(root));
    store.json.ensureDirs();
    store.json.put("decisions", decision("dec_one", "first choice"));
    updateClaudeMd(root, store); // grounding block reflects 1 decision
    git("add", "-A");
    git("commit", "-qm", "baseline");
    assert.match(readFileSync(join(root, "CLAUDE.md"), "utf8"), /\b1 decisions\b/);

    store.json.put("decisions", decision("dec_two", "second choice"));
    const r = flushCapture(store, hunchPaths(root).hunch, false, "hunch: capture dec_two");
    store.close();

    assert.equal(r, "committed");
    assert.equal(git("status", "--porcelain"), "", "counts refresh rides the capture commit — tree stays clean");
    assert.match(git("show", "HEAD:CLAUDE.md"), /\b2 decisions\b/, "the COMMITTED block holds the fresh count");
  } finally { cleanup(); }
});

test("flushCapture leaves a user-dirty grounding doc completely untouched", () => {
  const { root, git, cleanup } = repo("hunch-flush-dirty-");
  try {
    const store = new HunchStore(hunchPaths(root));
    store.json.ensureDirs();
    store.json.put("decisions", decision("dec_one", "first choice"));
    updateClaudeMd(root, store);
    git("add", "-A");
    git("commit", "-qm", "baseline");

    const userEdit = `${readFileSync(join(root, "CLAUDE.md"), "utf8")}\nMY UNCOMMITTED NOTES\n`;
    writeFileSync(join(root, "CLAUDE.md"), userEdit);

    store.json.put("decisions", decision("dec_two", "second choice"));
    const r = flushCapture(store, hunchPaths(root).hunch, false, "hunch: capture dec_two");
    store.close();

    assert.equal(r, "committed", "the memory record still commits");
    assert.equal(readFileSync(join(root, "CLAUDE.md"), "utf8"), userEdit, "dirty doc is neither refreshed nor reverted");
    assert.equal(git("status", "--porcelain"), "M CLAUDE.md", "only the user's own edit remains uncommitted");
    assert.doesNotMatch(git("show", "HEAD", "--name-only", "--format="), /CLAUDE\.md/, "user edits are never swept into a memory commit");
  } finally { cleanup(); }
});

test("hunch index commits refreshed grounding atomically with an auto-pumped graph", () => {
  const { root, git, cleanup } = repo("hunch-index-grounding-");
  try {
    mkdirSync(join(root, "src"), { recursive: true });
    writeFileSync(join(root, "src/app.ts"), "export const app = () => true;\n");
    writeFileSync(join(root, ".gitignore"), "");
    ensureGitignore(root);
    const store = new HunchStore(hunchPaths(root));
    store.json.ensureDirs();
    store.json.put("decisions", decision("dec_one", "first choice"));
    indexRepo(store, root, { churn: false });
    store.reindex();
    updateClaudeMd(root, store);
    store.close();
    git("add", "-A");
    git("commit", "-qm", "fixture: indexed graph and grounding");

    const changed = new HunchStore(hunchPaths(root));
    changed.json.put("decisions", decision("dec_two", "second choice"));
    changed.close();
    assert.match(readFileSync(join(root, "CLAUDE.md"), "utf8"), /\b1 decisions\b/);

    const run = spawnSync(process.execPath, [TSX, CLI, "index"], {
      cwd: root,
      encoding: "utf8",
      env: { ...process.env, HUNCH_SYNTH_PROVIDER: "deterministic", GIT_CONFIG_NOSYSTEM: "1" },
    });
    assert.equal(run.status, 0, `${run.stdout}\n${run.stderr}`);
    assert.equal(git("status", "--porcelain"), "", "index must leave graph and generated grounding clean");
    const committed = git("show", "HEAD", "--name-only", "--format=");
    assert.match(committed, /\.hunch\/decisions\/dec_two\.json/);
    assert.match(committed, /^CLAUDE\.md$/m, "fresh counts belong to the same memory commit");
    assert.match(git("show", "HEAD:CLAUDE.md"), /\b2 decisions\b/);
  } finally { cleanup(); }
});

test("hunch index --no-auto-commit refreshes the graph without moving HEAD", () => {
  const { root, git, cleanup } = repo("hunch-index-no-autocommit-");
  try {
    mkdirSync(join(root, "src"), { recursive: true });
    writeFileSync(join(root, "src/app.ts"), "export const app = () => 1;\n");
    writeFileSync(join(root, ".gitignore"), "");
    ensureGitignore(root);
    const store = new HunchStore(hunchPaths(root));
    store.json.ensureDirs();
    indexRepo(store, root, { churn: false });
    store.reindex();
    store.close();
    git("add", "-A");
    git("commit", "-qm", "fixture: indexed baseline");

    writeFileSync(join(root, "src/app.ts"), "export const app = () => 2;\nexport const addedForIndex = true;\n");
    git("add", "src/app.ts");
    git("commit", "-qm", "feat: change indexed source");
    const before = git("rev-parse", "HEAD");

    const run = spawnSync(process.execPath, [TSX, CLI, "index", "--no-auto-commit"], {
      cwd: root,
      encoding: "utf8",
      env: { ...process.env, HUNCH_SYNTH_PROVIDER: "deterministic", GIT_CONFIG_NOSYSTEM: "1" },
    });
    assert.equal(run.status, 0, `${run.stdout}\n${run.stderr}`);
    assert.equal(git("rev-parse", "HEAD"), before, "a validation-only index cannot create a clean invisible commit");
    assert.notEqual(git("status", "--porcelain"), "", "the refreshed graph remains visible for the caller to review");
    assert.equal(git("log", "-1", "--pretty=%s"), "feat: change indexed source");
  } finally { cleanup(); }
});
