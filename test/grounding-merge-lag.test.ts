/**
 * fnd_c402046ac7 end to end: two branches each capture one decision and regenerate the
 * SAME "2 decisions" counts line; git merges identical lines with no conflict, the
 * merged store holds 3, and the committed CLAUDE.md is one behind. Nobody erred and no
 * hook ran on the forge — so the freshness rule must call it LAG (not red), the
 * `hunch grounding` command must name it and heal it, and a local post-merge hook must
 * heal it before the developer's next commit.
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { execFileSync, spawnSync } from "node:child_process";
import { updateClaudeMd } from "../src/integrations/claudemd.js";
import { installPostMergeHook } from "../src/integrations/hooks.js";
import { hunchPaths } from "../src/core/paths.js";
import type { Decision } from "../src/core/types.js";
import { HunchStore } from "../src/store/hunchStore.js";

const PROJECT_ROOT = process.cwd();
const TSX = join(PROJECT_ROOT, "node_modules/tsx/dist/cli.mjs");
const CLI = join(PROJECT_ROOT, "src/cli/index.ts");

function decision(id: string, title: string): Decision {
  return {
    id, title, topic: null, status: "accepted", context: "fixture", decision: `Keep the ${title} behavior.`,
    consequences: [], alternatives_rejected: [], rejected_tripwires: [], related_components: [], related_files: [],
    supersedes: null, superseded_by: null, caused_by_bug: null, commit: null, valid_to: null,
    retired: { symbols: [], deps: [] }, provenance: { source: "human_confirmed", confidence: 0.95, evidence: [] },
    date: "2026-01-01T00:00:00.000Z",
  };
}

const countsLine = (root: string): string => /\*\*(\d+) decisions?,[^*]*\*\*/.exec(readFileSync(join(root, "CLAUDE.md"), "utf8"))?.[0] ?? "(no counts)";

test("merge lag: identical count lines merge silently, the doc lags by one, and hunch grounding names + heals it", { timeout: 120_000 }, () => {
  const base = mkdtempSync(join(tmpdir(), "hunch-merge-lag-"));
  const root = join(base, "repo");
  const emptyPrivate = join(base, "empty-private");
  const env: NodeJS.ProcessEnv = {
    ...process.env,
    HUNCH_PRIVATE_DIR: emptyPrivate,
    HUNCH_SYNTH_PROVIDER: "deterministic",
    HUNCH_EMBEDDINGS: "off",
    GIT_CONFIG_NOSYSTEM: "1",
    GIT_AUTHOR_NAME: "T", GIT_AUTHOR_EMAIL: "t@t.invalid", GIT_COMMITTER_NAME: "T", GIT_COMMITTER_EMAIL: "t@t.invalid",
    NO_COLOR: "1",
  };
  const git = (...a: string[]): string => execFileSync("git", ["-C", root, ...a], { encoding: "utf8", env }).trim();
  const hunch = (...a: string[]) => spawnSync(process.execPath, [TSX, CLI, ...a], { cwd: root, env, encoding: "utf8", timeout: 60_000 });
  const capture = (id: string, title: string): void => {
    const store = new HunchStore(hunchPaths(root));
    try {
      store.json.ensureDirs();
      store.json.put("decisions", decision(id, title));
      updateClaudeMd(root, store);
    } finally { store.close(); }
    git("add", "-A");
    git("commit", "-qm", `hunch: capture ${id}`);
  };
  try {
    execFileSync("git", ["init", "-q", "-b", "main", root], { env });
    git("config", "commit.gpgsign", "false");
    writeFileSync(join(root, "CLAUDE.md"), "# Project\n\nUser prose stays.\n");
    writeFileSync(join(root, ".gitignore"), ".hunch/hunch.sqlite*\n");
    git("add", "-A");
    git("commit", "-qm", "init");
    capture("dec_a", "first");
    assert.match(countsLine(root), /^\*\*1 decisions/);

    git("checkout", "-qb", "feat");
    capture("dec_b", "second");
    assert.match(countsLine(root), /^\*\*2 decisions/);
    git("checkout", "-q", "main");
    capture("dec_c", "third");
    assert.match(countsLine(root), /^\*\*2 decisions/, "both sides regenerate the very same line");

    // The forge's merge: no hook, no conflict, and the doc is one behind the store.
    git("merge", "-q", "--no-edit", "feat");
    assert.equal(git("status", "--porcelain"), "", "the merge commits cleanly");
    assert.match(countsLine(root), /^\*\*2 decisions/, "identical lines merged silently");

    const check = hunch("grounding");
    assert.equal(check.status, 0, `lag is never red:\n${check.stdout}${check.stderr}`);
    assert.match(check.stdout, /CLAUDE\.md: counts lag the store \(decisions 2 → 3\)/);
    assert.match(check.stdout, /lag a merge — transient/);
    const json = JSON.parse(hunch("grounding", "--json").stdout) as { docs: Array<{ doc: string; verdict: { kind: string; behind?: string[] } }>; ok: boolean };
    assert.equal(json.ok, true);
    assert.deepEqual(json.docs.find((d) => d.doc === "CLAUDE.md")?.verdict, {
      kind: "lagging",
      committed: { decisions: 2, bugs: 0, constraints: 0, components: 0, policies: 0, findings: 0 },
      generated: { decisions: 3, bugs: 0, constraints: 0, components: 0, policies: 0, findings: 0 },
      behind: ["decisions"],
    });

    // A doc AHEAD of the store is the never-committed-record defect: red.
    const lagging = readFileSync(join(root, "CLAUDE.md"), "utf8");
    writeFileSync(join(root, "CLAUDE.md"), lagging.replace("**2 decisions", "**4 decisions"));
    const ahead = hunch("grounding");
    assert.equal(ahead.status, 1, `ahead must fail:\n${ahead.stdout}`);
    assert.match(ahead.stdout, /counts run AHEAD of the store \(decisions 4 → 3\)/);
    writeFileSync(join(root, "CLAUDE.md"), lagging);

    // --refresh heals from the PUBLIC store and keeps the user's prose.
    const refresh = hunch("grounding", "--refresh");
    assert.equal(refresh.status, 0, refresh.stdout + refresh.stderr);
    assert.match(refresh.stdout, /grounding refreshed: CLAUDE\.md/);
    assert.match(countsLine(root), /^\*\*3 decisions/);
    assert.match(readFileSync(join(root, "CLAUDE.md"), "utf8"), /User prose stays\./);
    assert.match(hunch("grounding").stdout, /✓ grounding docs are fresh\./);
    assert.match(hunch("grounding", "--refresh").stdout, /already fresh/);
    git("add", "-A");
    git("commit", "-qm", "chore(grounding): regenerate");

    // Local merges heal themselves: the post-merge hook regenerates when .hunch/ moved.
    const invocation = `${JSON.stringify(process.execPath)} ${JSON.stringify(TSX)} ${JSON.stringify(CLI)}`;
    assert.equal(installPostMergeHook(root, invocation).action, "created");
    git("checkout", "-qb", "feat2");
    capture("dec_d", "fourth");
    git("checkout", "-q", "main");
    capture("dec_e", "fifth");
    assert.match(countsLine(root), /^\*\*4 decisions/);
    git("merge", "-q", "--no-edit", "feat2");
    assert.match(countsLine(root), /^\*\*5 decisions/, "the post-merge hook re-synced the doc to the merged store");
    assert.equal(git("status", "--porcelain"), "M CLAUDE.md", "left for the developer's next commit, never auto-committed");

    // A merge that brings no memory in leaves the docs alone (no needless rewrite).
    git("add", "-A");
    git("commit", "-qm", "chore(grounding): regenerate");
    git("checkout", "-qb", "code-only");
    writeFileSync(join(root, "src.txt"), "code\n");
    git("add", "-A");
    git("commit", "-qm", "feat: code only");
    git("checkout", "-q", "main");
    writeFileSync(join(root, "other.txt"), "other\n");
    git("add", "-A");
    git("commit", "-qm", "feat: other");
    git("merge", "-q", "--no-edit", "code-only");
    assert.equal(git("status", "--porcelain"), "", "no .hunch/ change in the merge → the hook does nothing");
  } finally {
    rmSync(base, { recursive: true, force: true });
  }
});
