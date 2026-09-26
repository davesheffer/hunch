import { cleanupDir, writeLocalPointer } from "./fixtures.js";
import { tempDir } from "./helpers.js";
/**
 * Workspace ledger, Phase 3 (docs/workspace-ledger.md): the prune planner's refusal rules,
 * pull-request linkage from local commit subjects, and `hunch workspaces prune` end to end —
 * dry run deletes nothing, --apply refuses without confirmation off a terminal, and --apply
 * --yes deletes only what is provably merged and clean, on this machine, never a remote.
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import { execFileSync, spawnSync } from "node:child_process";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { HunchStore } from "../src/store/hunchStore.js";
import { hunchPaths } from "../src/core/paths.js";
import { WorkspaceSchema, planPrune, pruneRefusal, shellQuote, workspaceId, type Workspace } from "../src/core/workspace.js";
import { snapshotWorkspace } from "../src/extractors/workspaces.js";
import { applyPrune, prunePlanFor, pruneConfirmQuestion, renderPrunePlan, type LedgerView } from "../src/integrations/workspaceLedger.js";

const PROJECT_ROOT = process.cwd();
const TSX = join(PROJECT_ROOT, "node_modules/tsx/dist/cli.mjs");
const CLI = join(PROJECT_ROOT, "src/cli/index.ts");

const g = (cwd: string, ...a: string[]): string =>
  execFileSync("git", a, { cwd, encoding: "utf8", stdio: ["ignore", "pipe", "ignore"], env: { ...process.env, GIT_CONFIG_NOSYSTEM: "1" } }).trim();
const cfg = (repo: string): void => { g(repo, "config", "user.email", "t@example.com"); g(repo, "config", "user.name", "T"); };

/** git reports worktree paths with forward slashes, including on Windows, so every path
 *  comparison in this file is made on one normalized form rather than the native one. */
const slash = (p: string): string => p.replace(/\\/g, "/");
const commitFile = (repo: string, file: string, content: string, message: string): string => {
  writeFileSync(join(repo, file), content);
  g(repo, "add", "-A"); g(repo, "commit", "-q", "-m", message);
  return g(repo, "rev-parse", "HEAD");
};

const MACHINE = { id: "mac_0123456789abcdef0123456789abcdef", label: "test-box", created_at: "2026-09-01T00:00:00.000Z" };
const OTHER = { id: "mac_fedcba9876543210fedcba9876543210", label: "other-box", created_at: "2026-09-01T00:00:00.000Z" };
const HEAD = "b".repeat(40);
const MERGED = { status: "merged" as const, method: "ancestry" as const, evidence: ["ancestor"] };

function record(machine: typeof MACHINE, publish: "full" | "branches", worktrees: Array<Partial<Workspace["worktrees"][number]> & { id: string }>, branches: Array<Partial<Workspace["branches"][number]> & { name: string }>): Workspace {
  return WorkspaceSchema.parse({
    schema: "hunch.workspace/1", id: workspaceId(machine.id), machine: { id: machine.id, label: machine.label, platform: "linux" },
    repository: "git-remote:sha256:" + "0".repeat(64), publish, observed_at: new Date().toISOString(), fetched_at: null,
    default_branch: { name: "main", ref: "origin/main", head: HEAD },
    worktrees: worktrees.map((w) => ({ path: publish === "full" ? `/w/${w.id}` : null, branch: null, head: HEAD, is_main: false, dirty: false, locked: false, prunable: false, last_commit_at: null, ...w })),
    branches: branches.map((b) => ({ head: HEAD, is_default: false, upstream: null, upstream_gone: false, ahead: null, behind: null, last_commit_at: null, worktree: null, merged: { status: "unmerged", method: null, evidence: [] }, ...b })),
    provenance: { source: "extracted", confidence: 1, evidence: [] },
  });
}

test("planPrune: only proven-merged branches with a clean, unlocked, present, non-main worktree are steps; every refusal is named", () => {
  const live = record(MACHINE, "full", [
    { id: "wt_0000000a", branch: "main", is_main: true },
    { id: "wt_0000000b", branch: "feat/clean" },
    { id: "wt_0000000c", branch: "feat/dirty", dirty: true },
    { id: "wt_0000000d", branch: "feat/locked", locked: true },
    { id: "wt_0000000e", branch: "feat/gone", prunable: true, dirty: null },
    { id: "wt_0000000f", branch: "feat/unreadable", dirty: null },
  ], [
    { name: "main", is_default: true, worktree: "wt_0000000a", merged: { status: "unmerged", method: null, evidence: ["default branch"] } },
    { name: "feat/plain", merged: { ...MERGED, method: "squash", pr: 42 } },
    { name: "feat/clean", worktree: "wt_0000000b", merged: MERGED },
    { name: "feat/dirty", worktree: "wt_0000000c", merged: MERGED },
    { name: "feat/locked", worktree: "wt_0000000d", merged: MERGED },
    { name: "feat/gone", worktree: "wt_0000000e", merged: MERGED },
    { name: "feat/unreadable", worktree: "wt_0000000f", merged: MERGED },
    { name: "feat/open" },
    { name: "feat/unknown", merged: { status: "unknown", method: null, evidence: ["no default"] } },
    { name: "feat/onmain", worktree: "wt_0000000a", merged: MERGED },
  ]);
  const other = record(OTHER, "branches", [{ id: "wt_00000010", branch: "fix/theirs" }], [
    { name: "fix/theirs", worktree: "wt_00000010", merged: MERGED },
    { name: "fix/theirs-dirty", merged: MERGED, worktree: null },
  ]);
  const forgedSelf = { ...record(MACHINE, "branches", [], [{ name: "phantom", merged: MERGED }]) };

  const plan = planPrune(live, [live, other, forgedSelf]);
  assert.deepEqual(plan.local.map((s) => s.branch), ["feat/plain", "feat/clean"]);
  assert.deepEqual(plan.local[0]!.commands, ["git branch -d -- feat/plain"]);
  assert.match(plan.local[0]!.why, /^squash \(PR #42\): /);
  assert.deepEqual(plan.local[1]!.commands, ["git worktree remove -- /w/wt_0000000b", "git branch -d -- feat/clean"]);
  assert.deepEqual(plan.skipped, [
    { branch: "feat/dirty", reason: "worktree has uncommitted or untracked changes" },
    { branch: "feat/locked", reason: "worktree is locked" },
    { branch: "feat/gone", reason: "worktree path is missing (git worktree prune first)" },
    { branch: "feat/unreadable", reason: "worktree state could not be read" },
    { branch: "feat/onmain", reason: "checked out in the main worktree (switch away first)" },
  ], "unmerged / unknown / default branches are not 'skipped merged' entries; each refusal names its rule");
  assert.deepEqual(Object.keys(plan.others), ["other-box"], "this machine's stored record is never a source, even for display");
  assert.deepEqual(plan.others["other-box"]!.map((s) => s.commands), [["git worktree remove -- <its worktree>", "git branch -d -- fix/theirs"], ["git branch -d -- fix/theirs-dirty"]]);
  assert.equal(pruneRefusal(live.branches.find((b) => b.name === "feat/unknown")!, undefined), "merge state unknown");
  assert.equal(pruneRefusal(live.branches.find((b) => b.name === "feat/open")!, undefined), "not merged");
  assert.equal(pruneRefusal(live.branches.find((b) => b.name === "main")!, undefined), "default branch");
});

test("printed commands are shell-quoted; a stored path or evidence with a newline or control character is refused by the schema", () => {
  const other = record(OTHER, "full", [{ id: "wt_00000011", branch: "fix/a;b", path: "/home/o/my wt" }, { id: "wt_00000012", branch: "fix/c", path: "C:\\Users\\o\\it's here" }], [
    { name: "fix/a;b", worktree: "wt_00000011", merged: MERGED },
    { name: "fix/$(touch`x`)|y&z>w", merged: MERGED },
    { name: "fix/c", worktree: "wt_00000012", merged: MERGED },
  ]);
  const live = record(MACHINE, "full", [], []);
  const plan = planPrune(live, [live, other]);
  assert.deepEqual(plan.others["other-box"]!.map((s) => s.commands), [
    ["git worktree remove -- '/home/o/my wt'", "git branch -d -- 'fix/a;b'"],
    ["git branch -d -- 'fix/$(touch`x`)|y&z>w'"],
    ["git worktree remove -- 'C:\\Users\\o\\it'\\''s here'", "git branch -d -- fix/c"],
  ]);
  assert.equal(shellQuote("feat/plain-1.2"), "feat/plain-1.2", "a token with nothing special stays bare");
  // What a POSIX shell does with the quoted tokens: each comes back as ONE literal argument.
  if (process.platform !== "win32") {
    for (const token of ["fix/$(touch`x`)|y&z>w", "it's here", "a;b"]) {
      const echoed = execFileSync("sh", ["-c", `printf %s ${shellQuote(token)}`], { encoding: "utf8" });
      assert.equal(echoed, token);
    }
  }

  for (const bad of ["/home/o/wt\ngit branch -D main", "/home/o/wt\u001b[2K", "/home/o/wt\r", "/home/o/\u0085wt"]) {
    assert.throws(() => record(OTHER, "full", [{ id: "wt_00000013", path: bad }], []), /control characters/, JSON.stringify(bad));
  }
  assert.throws(() => record(OTHER, "branches", [], [{ name: "x", merged: { ...MERGED, evidence: ["ok\nforged line"] } }]), /control characters/);
  assert.throws(() => record(OTHER, "branches", [], [{ name: "x\ny", merged: MERGED }]), /git-valid/);
});

test("the schema refuses a pull request on anything but a merged verdict", () => {
  assert.throws(() => record(MACHINE, "branches", [], [{ name: "x", merged: { status: "unmerged", method: null, evidence: [], pr: 7 } }]), /pull request/);
});

// ---- PR linkage from local git ----------------------------------------------------------------

function originFixture(): { base: string; repo: string; cleanup: () => void } {
  const base = tempDir("hunch-prune-");
  const remote = join(base, "origin.git");
  g(base, "init", "-q", "--bare", "-b", "main", remote);
  const repo = join(base, "repo");
  g(base, "clone", "-q", remote, repo); cfg(repo);
  mkdirSync(join(repo, ".hunch"), { recursive: true });
  writeFileSync(join(repo, ".gitignore"), ".hunch/hunch.sqlite*\n.hunch/local.json\n");
  commitFile(repo, ".hunch/manifest.json", '{"schema_version":3}\n', "hunch: init");
  commitFile(repo, "app.ts", "export const x = 1;\n", "init");
  g(repo, "push", "-q", "-u", "origin", "main");
  g(repo, "remote", "set-head", "origin", "main");
  return { base, repo, cleanup: () => cleanupDir(base) };
}

test("a merged branch carries the pull request its LOCAL merge or squash commit subject names; nothing is fetched", () => {
  const { repo, cleanup } = originFixture();
  try {
    g(repo, "checkout", "-q", "-b", "feat/pr-merge"); commitFile(repo, "m.ts", "export const m = 1;\n", "merge work");
    g(repo, "checkout", "-q", "main"); g(repo, "merge", "-q", "--no-ff", "-m", "Merge pull request #12 from davesheffer/feat/pr-merge", "feat/pr-merge");
    g(repo, "checkout", "-q", "-b", "feat/pr-squash"); commitFile(repo, "s1.ts", "export const s1 = 1;\n", "s1"); commitFile(repo, "s2.ts", "export const s2 = 1;\n", "s2");
    g(repo, "checkout", "-q", "main"); g(repo, "merge", "-q", "--squash", "feat/pr-squash"); g(repo, "commit", "-q", "-m", "Squashed feature (#13)");
    g(repo, "checkout", "-q", "-b", "feat/no-pr"); commitFile(repo, "n.ts", "export const n = 1;\n", "n");
    g(repo, "checkout", "-q", "main"); g(repo, "merge", "-q", "--no-ff", "-m", "merge feat/no-pr locally", "feat/no-pr");
    // A merge commit naming a DIFFERENT branch with a similar suffix must not be attributed.
    g(repo, "checkout", "-q", "-b", "pr-merge"); commitFile(repo, "o.ts", "export const o = 1;\n", "o");
    g(repo, "checkout", "-q", "main"); g(repo, "merge", "-q", "--no-ff", "-m", "Merge pull request #99 from someone/other/pr-merge", "pr-merge");
    g(repo, "push", "-q", "origin", "main");

    const rec = snapshotWorkspace(repo, { machine: MACHINE, publish: "branches" });
    const by = (n: string) => rec.branches.find((b) => b.name === n)!.merged;
    assert.equal(by("feat/pr-merge").pr, 12);
    assert.equal(by("feat/pr-merge").method, "ancestry");
    assert.equal(by("feat/pr-squash").pr, 13);
    assert.equal(by("feat/pr-squash").method, "squash");
    assert.equal(by("feat/no-pr").pr, undefined);
    assert.equal(by("pr-merge").pr, undefined, "owner/other/pr-merge is not the branch pr-merge");
    assert.ok(by("feat/pr-merge").evidence.some((e) => e.includes("pull request #12 (from the local commit subject)")));
  } finally { cleanup(); }
});

function liveView(repo: string): LedgerView {
  const live = snapshotWorkspace(repo, { machine: MACHINE, publish: "full" });
  return { machine: MACHINE, live, records: [live], config: { publish: "branches", stale_after_days: 7, publish_public: false } };
}

test("ignored files in a merged worktree are named in the plan and the confirmation — not a refusal (#308)", () => {
  const { base, repo, cleanup } = originFixture();
  try {
    commitFile(repo, ".gitignore", ".hunch/hunch.sqlite*\n.hunch/local.json\n.env\nnode_modules/\n", "ignore env");
    g(repo, "checkout", "-q", "-b", "feat/env"); commitFile(repo, "e.ts", "export const e = 1;\n", "e");
    g(repo, "checkout", "-q", "main"); g(repo, "merge", "-q", "--no-ff", "-m", "merge feat/env", "feat/env"); g(repo, "push", "-q", "origin", "main");
    const wt = join(base, "wt-env");
    g(repo, "worktree", "add", "-q", wt, "feat/env");
    writeFileSync(join(wt, ".env"), "SECRET=local-only\n");
    mkdirSync(join(wt, "node_modules", "pkg"), { recursive: true });
    writeFileSync(join(wt, "node_modules", "pkg", "index.js"), "module.exports = 1;\n");

    const view = liveView(repo);
    const plan = prunePlanFor(view, repo);
    assert.deepEqual(plan.local.map((s) => s.branch), ["feat/env"], "ignored files do not make the worktree dirty");
    assert.deepEqual(plan.local[0]!.ignored, { shown: [".env", "node_modules/"], total: 2 });
    const rendered = renderPrunePlan(view, plan);
    assert.match(rendered, /⚠ also deletes 2 ignored path\(s\) in the worktree: \.env, node_modules\//);
    const question = pruneConfirmQuestion(view, plan);
    assert.match(question, /feat\/env: removing its worktree also deletes 2 ignored path\(s\) in the worktree: \.env, node_modules\//);
    assert.match(question, /Delete 1 branch\(es\) and remove 1 worktree\(s\) on test-box\?$/);
  } finally { cleanup(); }
});

test("a squash-merged branch whose upstream is gone is skipped WHOLE: git branch -d would refuse, so the worktree is not removed first (#309)", () => {
  const { base, repo, cleanup } = originFixture();
  try {
    g(repo, "checkout", "-q", "-b", "feat/sq");
    commitFile(repo, "s1.ts", "export const s1 = 1;\n", "s1"); commitFile(repo, "s2.ts", "export const s2 = 1;\n", "s2");
    g(repo, "push", "-q", "-u", "origin", "feat/sq");
    g(repo, "checkout", "-q", "main"); g(repo, "merge", "-q", "--squash", "feat/sq"); g(repo, "commit", "-q", "-m", "Squash feature (#7)");
    g(repo, "push", "-q", "origin", "main");
    g(repo, "push", "-q", "origin", "--delete", "feat/sq"); g(repo, "fetch", "-q", "--prune");
    const wt = join(base, "wt-sq");
    g(repo, "worktree", "add", "-q", wt, "feat/sq");

    const view = liveView(repo);
    const sq = view.live.branches.find((b) => b.name === "feat/sq")!;
    assert.deepEqual([sq.merged.status, sq.merged.method, sq.upstream_gone], ["merged", "squash", true]);

    // The dry run already says so, instead of promising a delete git will refuse.
    const plan = prunePlanFor(view, repo);
    assert.deepEqual(plan.local.map((s) => s.branch), []);
    const skipped = plan.skipped.find((s) => s.branch === "feat/sq");
    assert.match(skipped?.reason ?? "", /^squash-merged: git branch -d would refuse \(not merged into HEAD\); delete manually after checking$/);
    assert.match(renderPrunePlan(view, plan), /feat\/sq  — squash-merged: git branch -d would refuse/);

    // applyPrune re-checks on its own, so even a step from a plan without that check is skipped whole.
    const pure = planPrune(view.live, view.records).local;
    assert.deepEqual(pure.map((s) => s.branch), ["feat/sq"]);
    const results = applyPrune(repo, pure);
    assert.equal(results.length, 1);
    assert.equal(results[0]!.outcome, "skipped");
    assert.match(results[0]!.detail, /squash-merged: git branch -d would refuse/);
    assert.equal(existsSync(join(wt, "s1.ts")), true, "worktree kept");
    assert.equal(g(repo, "branch", "--list", "feat/sq").replace(/^\+ /, ""), "feat/sq", "branch kept");
  } finally { cleanup(); }
});

// ---- CLI --------------------------------------------------------------------------------------

function cli(cwd: string, env: Record<string, string>, ...args: string[]): { stdout: string; stderr: string; status: number } {
  const res = spawnSync(process.execPath, [TSX, CLI, ...args], {
    cwd, encoding: "utf8", timeout: 180_000,
    env: { ...process.env, HUNCH_PRIVATE_DIR: "", HUNCH_SYNTH_PROVIDER: "deterministic", NO_COLOR: "1", GIT_CONFIG_NOSYSTEM: "1", ...env },
  });
  return { stdout: res.stdout ?? "", stderr: res.stderr ?? "", status: res.status ?? -1 };
}

test("CLI prune: dry run prints per-machine commands and deletes nothing; --apply refuses off a terminal; --apply --yes deletes only the safe set on this machine and never a remote", () => {
  const { base, repo, cleanup } = originFixture();
  try {
    // overlay + machine identity, like a developer's real setup
    const overlayRoot = join(base, "overlay");
    g(base, "init", "-q", "-b", "main", overlayRoot); cfg(overlayRoot);
    mkdirSync(join(overlayRoot, ".hunch"), { recursive: true });
    writeFileSync(join(overlayRoot, ".gitignore"), ".hunch/hunch.sqlite*\n");
    g(overlayRoot, "add", "-A"); g(overlayRoot, "commit", "-q", "-m", "overlay");
    writeLocalPointer(repo, { privateDir: join(overlayRoot, ".hunch"), autoCommit: true, mode: "private" });
    const cfgHome = join(base, "xdg");
    mkdirSync(join(cfgHome, "hunch"), { recursive: true });
    writeFileSync(join(cfgHome, "hunch", "machine.json"), JSON.stringify(MACHINE));
    const env = { XDG_CONFIG_HOME: cfgHome };

    // merged, no worktree → deletable
    g(repo, "checkout", "-q", "-b", "feat/merged"); commitFile(repo, "a.ts", "export const a = 1;\n", "a");
    g(repo, "checkout", "-q", "main"); g(repo, "merge", "-q", "--no-ff", "-m", "Merge pull request #5 from o/feat/merged", "feat/merged");
    // merged, clean worktree → worktree removed then branch deleted
    g(repo, "checkout", "-q", "-b", "feat/wt-clean"); commitFile(repo, "b.ts", "export const b = 1;\n", "b");
    g(repo, "checkout", "-q", "main"); g(repo, "merge", "-q", "--no-ff", "-m", "merge wt-clean", "feat/wt-clean");
    const wtClean = join(base, "wt-clean"); g(repo, "worktree", "add", "-q", wtClean, "feat/wt-clean");
    // merged, dirty worktree → kept
    g(repo, "checkout", "-q", "-b", "feat/wt-dirty"); commitFile(repo, "c.ts", "export const c = 1;\n", "c");
    g(repo, "checkout", "-q", "main"); g(repo, "merge", "-q", "--no-ff", "-m", "merge wt-dirty", "feat/wt-dirty");
    const wtDirty = join(base, "wt-dirty"); g(repo, "worktree", "add", "-q", wtDirty, "feat/wt-dirty");
    writeFileSync(join(wtDirty, "scratch.ts"), "export const s = 1;\n");
    // unmerged, pushed → kept, and its remote branch must survive
    g(repo, "checkout", "-q", "-b", "feat/open"); commitFile(repo, "d.ts", "export const d = 1;\n", "d");
    g(repo, "push", "-q", "-u", "origin", "feat/open");
    g(repo, "checkout", "-q", "main"); g(repo, "push", "-q", "origin", "main");

    // A stored record for ANOTHER machine, and a forged one for THIS machine claiming feat/open merged.
    const store = new HunchStore(hunchPaths(repo));
    try {
      store.json.ensureDirs();
      store.json.put("workspaces", record(OTHER, "branches", [{ id: "wt_00000010", branch: "fix/theirs" }], [{ name: "fix/theirs", worktree: "wt_00000010", merged: MERGED }]));
      store.json.put("workspaces", record(MACHINE, "branches", [], [{ name: "feat/open", merged: MERGED }]));
    } finally { store.close(); }

    const dry = cli(repo, env, "workspaces", "prune");
    assert.equal(dry.status, 0, dry.stderr);
    assert.match(dry.stdout, /This machine \(test-box\) — 2 branch\(es\) provably merged and safe to delete:/);
    assert.match(dry.stdout, /feat\/merged  — ancestry \(PR #5\)/);
    assert.match(dry.stdout, /git branch -d -- feat\/merged/);
    assert.match(slash(dry.stdout), new RegExp(`git worktree remove -- ${slash(wtClean).replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}\\n\\s+git branch -d -- feat/wt-clean`));
    assert.match(dry.stdout, /feat\/wt-dirty  — worktree has uncommitted or untracked changes/);
    assert.doesNotMatch(dry.stdout, /git branch -d -- feat\/open/, "the forged stored record for this machine is never read");
    assert.match(dry.stdout, /On other-box — run there.*never executed from here.*\n\s+git worktree remove -- <its worktree>\n\s+git branch -d -- fix\/theirs/);
    assert.match(dry.stdout, /\(dry run — `hunch workspaces prune --apply`/);
    assert.equal(g(repo, "branch", "--list", "feat/merged"), "feat/merged", "dry run deleted nothing");

    // A public record under THIS machine's id blocks the overlay write (the store's
    // public/private twin guard) — reported, never thrown, with the remedy.
    const twin = cli(repo, env, "workspaces", "snapshot");
    assert.notEqual(twin.status, 0);
    assert.match(twin.stderr, /not written: .*already exists in the other memory home/);
    // The stale twin is in the repo-tracked `.hunch/`, which `forget` refuses (an additive
    // pump never stages a tracked deletion), so the remedy printed is the manual removal.
    assert.match(twin.stderr, /the stale copy lives in this repo's \.hunch\//);
    assert.match(twin.stderr, /git rm \.hunch\/workspaces\/ws_0123456789ab\.json/);
    rmSync(join(repo, ".hunch", "workspaces", `${workspaceId(MACHINE.id)}.json`)); // what the `git rm` recipe does

    const refused = cli(repo, env, "workspaces", "prune", "--apply");
    assert.notEqual(refused.status, 0);
    assert.match(refused.stderr, /stdin is not a terminal; pass --yes/);
    assert.equal(g(repo, "branch", "--list", "feat/merged"), "feat/merged", "nothing deleted without confirmation");

    const applied = cli(repo, env, "workspaces", "prune", "--apply", "--yes");
    assert.equal(applied.status, 0, applied.stderr + applied.stdout);
    assert.match(applied.stdout, /✓ feat\/merged: deleted branch feat\/merged/);
    assert.match(applied.stdout, /✓ feat\/wt-clean: removed worktree .*; deleted branch feat\/wt-clean/);
    assert.match(applied.stdout, /2 deleted, 0 refused by git · ledger updated/);
    assert.equal(g(repo, "branch", "--list", "feat/merged"), "");
    assert.equal(g(repo, "branch", "--list", "feat/wt-clean"), "");
    assert.equal(existsSync(wtClean), false, "clean worktree removed");
    assert.equal(g(repo, "branch", "--list", "feat/wt-dirty").replace(/^\+ /, ""), "feat/wt-dirty", "dirty worktree's branch kept (`+` marks a branch checked out in a linked worktree)");
    assert.ok(existsSync(join(wtDirty, "scratch.ts")), "dirty worktree untouched");
    assert.equal(g(repo, "branch", "--list", "feat/open"), "feat/open", "unmerged branch kept");
    assert.equal(g(join(base, "origin.git"), "branch", "--list", "feat/open"), "feat/open", "remote never touched");
    assert.equal(g(join(base, "origin.git"), "rev-parse", "main"), g(repo, "rev-parse", "main"), "remote main unchanged");

    const stored = WorkspaceSchema.parse(JSON.parse(readFileSync(join(overlayRoot, ".hunch", "workspaces", `${workspaceId(MACHINE.id)}.json`), "utf8")));
    assert.equal(stored.branches.some((b) => b.name === "feat/merged"), false, "memory reflects the deletion");
    assert.equal(stored.worktrees.length, 2);

    const again = cli(repo, env, "workspaces", "prune", "--apply", "--yes");
    assert.equal(again.status, 0);
    assert.match(again.stdout, /nothing to apply on this machine/);
  } finally { cleanup(); }
});
