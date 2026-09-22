/**
 * Workspace ledger, Phase 1 (docs/workspace-ledger.md): one machine's worktrees and
 * branches snapshotted from REAL git with deterministic merged verdicts, the strict record
 * schema against hostile input, machine identity, cross-machine aggregation rules, and the
 * CLI end to end — including the security claim that a stored record never changes what
 * this machine reports live.
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import { execFileSync, spawnSync } from "node:child_process";
import { existsSync, lstatSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, statSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { HunchStore } from "../src/store/hunchStore.js";
import { hunchPaths } from "../src/core/paths.js";
import { ENTITY_KINDS } from "../src/core/types.js";
import {
  WorkspaceSchema, branchRows, isSafeBranchName, isUnverified, latestPerMachine, planPrune, pruneRefusal, recommendAction, sameWorkspaceContent,
  workspaceId, worktreeRows, type Workspace,
} from "../src/core/workspace.js";
import { defaultMachineLabel, loadOrCreateMachine, machineFile, setMachineLabel } from "../src/core/machine.js";
import { snapshotWorkspace } from "../src/extractors/workspaces.js";

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

/** A clone of a bare `origin` with main pushed, so origin/HEAD resolves the default branch
 *  and upstream tracking exists — the shape every real repository has. */
function fixture(): { base: string; remote: string; repo: string; cleanup: () => void } {
  const base = mkdtempSync(join(tmpdir(), "hunch-ws-"));
  const remote = join(base, "origin.git");
  g(base, "init", "-q", "--bare", "-b", "main", remote);
  const repo = join(base, "repo");
  g(base, "clone", "-q", remote, repo); cfg(repo);
  commitFile(repo, "app.ts", "export const x = 1;\n", "init");
  g(repo, "push", "-q", "-u", "origin", "main");
  g(repo, "remote", "set-head", "origin", "main");
  mkdirSync(join(repo, ".hunch"), { recursive: true });
  commitFile(repo, ".hunch/manifest.json", '{"schema_version":3}\n', "hunch: init");
  g(repo, "push", "-q", "origin", "main");
  return { base, remote, repo, cleanup: () => rmSync(base, { recursive: true, force: true }) };
}

function branch(record: Workspace, name: string) {
  const b = record.branches.find((x) => x.name === name);
  assert.ok(b, `branch ${name} is in the snapshot`);
  return b;
}

// ---- the kind is registered additively ----------------------------------------------------

test("workspaces is an additive store kind: appended after every existing kind, one file per record", () => {
  assert.equal(ENTITY_KINDS.at(-1), "workspaces");
  assert.equal(ENTITY_KINDS.indexOf("workspaces"), 16, "existing kinds keep their positions");
});

// ---- snapshot from real git ----------------------------------------------------------------

test("snapshot classifies merge, squash, rebase, unmerged, never-pushed and gone-upstream branches deterministically", () => {
  const { repo, cleanup } = fixture();
  try {
    // merged by a merge commit → ancestry
    g(repo, "checkout", "-q", "-b", "feat/merged");
    commitFile(repo, "merged.ts", "export const m = 1;\n", "merged work");
    g(repo, "checkout", "-q", "main"); g(repo, "merge", "-q", "--no-ff", "-m", "merge feat/merged", "feat/merged");
    // squash-merged (two commits collapse into one on main) → squash
    g(repo, "checkout", "-q", "-b", "feat/squashed");
    commitFile(repo, "s1.ts", "export const s1 = 1;\n", "s1");
    commitFile(repo, "s2.ts", "export const s2 = 2;\n", "s2");
    g(repo, "checkout", "-q", "main"); g(repo, "merge", "-q", "--squash", "feat/squashed"); g(repo, "commit", "-q", "-m", "squash feat/squashed");
    // both commits cherry-picked individually onto main → rebase (not ancestry, not one squash commit)
    g(repo, "checkout", "-q", "-b", "feat/rebased");
    const r1 = commitFile(repo, "r1.ts", "export const r1 = 1;\n", "r1");
    const r2 = commitFile(repo, "r2.ts", "export const r2 = 2;\n", "r2");
    g(repo, "checkout", "-q", "main"); g(repo, "cherry-pick", "-x", r1, r2); // -x: distinct commits even within the same second
    // unmerged, pushed, then main moved on → behind
    g(repo, "checkout", "-q", "-b", "feat/open");
    commitFile(repo, "open.ts", "export const o = 1;\n", "open work");
    g(repo, "push", "-q", "-u", "origin", "feat/open");
    commitFile(repo, "open2.ts", "export const o2 = 1;\n", "more open work"); // one commit ahead of its upstream
    // pushed, then the remote branch deleted without merging → gone
    g(repo, "checkout", "-q", "-b", "feat/gone", "main");
    commitFile(repo, "gone.ts", "export const gone = 1;\n", "gone work");
    g(repo, "push", "-q", "-u", "origin", "feat/gone"); g(repo, "push", "-q", "origin", "--delete", "feat/gone");
    // never pushed
    g(repo, "checkout", "-q", "-b", "spike/local", "main");
    commitFile(repo, "spike.ts", "export const sp = 1;\n", "spike");
    g(repo, "checkout", "-q", "main"); g(repo, "push", "-q", "origin", "main");

    const record = snapshotWorkspace(repo, { machine: MACHINE, publish: "full" });
    assert.equal(record.default_branch?.name, "main");
    assert.equal(record.default_branch?.ref, "origin/main");
    assert.equal(record.id, workspaceId(MACHINE.id));
    assert.match(record.repository, /^git-remote:sha256:[0-9a-f]{64}$/, "repository is the privacy-safe digest, never the URL");

    assert.equal(branch(record, "main").is_default, true);
    assert.deepEqual([branch(record, "feat/merged").merged.status, branch(record, "feat/merged").merged.method], ["merged", "ancestry"]);
    assert.deepEqual([branch(record, "feat/squashed").merged.status, branch(record, "feat/squashed").merged.method], ["merged", "squash"]);
    assert.deepEqual([branch(record, "feat/rebased").merged.status, branch(record, "feat/rebased").merged.method], ["merged", "rebase"]);
    const open = branch(record, "feat/open");
    assert.equal(open.merged.status, "unmerged");
    assert.equal(open.upstream, "origin/feat/open");
    assert.equal(open.upstream_gone, false);
    assert.equal(open.ahead, 1, "ahead/behind is measured against the branch's own upstream");
    assert.equal(open.behind, 0);
    const gone = branch(record, "feat/gone");
    assert.equal(gone.upstream_gone, true, "a deleted remote branch is reported as gone, not as merged");
    assert.equal(gone.merged.status, "unmerged");
    const spike = branch(record, "spike/local");
    assert.equal(spike.upstream, null);
    assert.equal(spike.merged.status, "unmerged");
    for (const b of record.branches) assert.match(b.merged.evidence[0] ?? "", /.+/, `${b.name} verdict carries evidence`);
  } finally { cleanup(); }
});

test("snapshot reports every worktree with dirty / detached / locked state and links branches to worktrees; branches mode drops paths", () => {
  const { base, repo, cleanup } = fixture();
  try {
    g(repo, "branch", "feat/wt");
    const wt = join(base, "wt-feat");
    g(repo, "worktree", "add", "-q", wt, "feat/wt");
    writeFileSync(join(wt, "uncommitted.ts"), "export const u = 1;\n"); // untracked = work `worktree remove` would refuse
    const detached = join(base, "wt-detached");
    g(repo, "worktree", "add", "-q", "--detach", detached, "main");
    g(repo, "worktree", "lock", detached);

    const full = snapshotWorkspace(repo, { machine: MACHINE, publish: "full" });
    assert.equal(full.worktrees.length, 3);
    const main = full.worktrees.find((w) => w.is_main)!;
    assert.equal(slash(main.path!), slash(repo)); assert.equal(main.branch, "main"); assert.equal(main.dirty, false);
    const feat = full.worktrees.find((w) => w.branch === "feat/wt")!;
    assert.equal(slash(feat.path!), slash(wt)); assert.equal(feat.dirty, true); assert.equal(feat.locked, false);
    const det = full.worktrees.find((w) => w.path && slash(w.path) === slash(detached))!;
    assert.equal(det.branch, null); assert.equal(det.locked, true); assert.equal(det.dirty, false);
    assert.equal(branch(full, "feat/wt").worktree, feat.id, "branch → worktree link by path-free id");
    assert.equal(branch(full, "main").worktree, main.id);

    const branches = snapshotWorkspace(repo, { machine: MACHINE, publish: "branches" });
    assert.ok(branches.worktrees.every((w) => w.path === null), "branches mode carries no path");
    assert.deepEqual(branches.worktrees.map((w) => w.id).sort(), full.worktrees.map((w) => w.id).sort(), "ids are stable across modes");
    assert.equal(branch(branches, "feat/wt").worktree, feat.id);
    const json = JSON.stringify(branches);
    assert.ok(!json.includes(slash(base)) && !json.includes(JSON.stringify(base).slice(1, -1)), "nothing in a branches-mode record mentions a local path");
  } finally { cleanup(); }
});

test("a huge repository degrades to a truncated record that says so; a branch name git would refuse as an argument is skipped and counted", () => {
  const { repo, cleanup } = fixture();
  try {
    const head = g(repo, "rev-parse", "HEAD");
    // `git update-ref` accepts names `check-ref-format --branch` rejects; they must never be recorded.
    execFileSync("git", ["update-ref", "--stdin"], { cwd: repo, input: `create refs/heads/-dash ${head}\ncreate refs/heads/old/one ${head}\ncreate refs/heads/old/two ${head}\n` });
    g(repo, "checkout", "-q", "-b", "feat/newest"); commitFile(repo, "n.ts", "export const n = 1;\n", "newest"); g(repo, "checkout", "-q", "main");
    const record = snapshotWorkspace(repo, { machine: MACHINE, publish: "branches", maxBranches: 2 });
    assert.equal(record.branches.length, 2);
    assert.ok(record.branches.some((b) => b.name === "feat/newest"), "the newest branch survives truncation");
    assert.equal(record.branches.some((b) => b.name === "-dash"), false);
    assert.ok(record.provenance.evidence.includes("truncated: 2 older branch(es) omitted (record holds 2)"), record.provenance.evidence.join(" | "));
    assert.ok(record.provenance.evidence.includes("skipped: 1 branch name(s) git would refuse as a branch argument"), record.provenance.evidence.join(" | "));
    assert.ok(!JSON.stringify(record).includes("-dash"), "the refused name appears nowhere in the record");
  } finally { cleanup(); }
});

test("without a resolvable default branch every verdict is unknown — never unmerged, never merged", () => {
  const base = mkdtempSync(join(tmpdir(), "hunch-ws-nodefault-"));
  try {
    const repo = join(base, "repo");
    g(base, "init", "-q", "-b", "trunk", repo); cfg(repo);
    commitFile(repo, "a.ts", "export const a = 1;\n", "a");
    g(repo, "checkout", "-q", "-b", "feat/x"); commitFile(repo, "b.ts", "export const b = 1;\n", "b");
    const record = snapshotWorkspace(repo, { machine: MACHINE, publish: "branches" });
    assert.equal(record.default_branch, null);
    assert.ok(record.branches.every((b) => b.merged.status === "unknown"));
  } finally { rmSync(base, { recursive: true, force: true }); }
});

test("a reland (revert of a revert) or a value flipped back is NOT merged: only default-branch commits after the merge base count; a genuine squash still is (#307)", () => {
  const { repo, cleanup } = fixture();
  try {
    commitFile(repo, "flag.ts", "export const flag = false;\n", "add flag");
    const featureCommit = commitFile(repo, "feature.ts", "export const feature = 1;\n", "Add feature (#10)");
    commitFile(repo, "flag.ts", "export const flag = true;\n", "Enable flag (#11)");
    commitFile(repo, "flag.ts", "export const flag = false;\n", "Disable flag (#12)");
    g(repo, "revert", "--no-edit", featureCommit); // the feature broke production: reverted on main
    g(repo, "push", "-q", "origin", "main");
    // The feature is relanded on a branch (revert of the revert), not merged yet.
    g(repo, "checkout", "-q", "-b", "feat/reland"); g(repo, "revert", "--no-edit", "HEAD");
    g(repo, "push", "-q", "-u", "origin", "feat/reland");
    // The flag is flipped back on a branch: its patch equals the OLD "Enable flag (#11)".
    g(repo, "checkout", "-q", "-b", "feat/flip", "main");
    commitFile(repo, "flag.ts", "export const flag = true;\n", "enable flag again");
    g(repo, "checkout", "-q", "main");

    const before = snapshotWorkspace(repo, { machine: MACHINE, publish: "full" });
    for (const name of ["feat/reland", "feat/flip"]) {
      const b = branch(before, name);
      assert.equal(b.merged.status, "unmerged", `${name}: a patch that matches only a commit behind the merge base is not merged — ${b.merged.evidence.join(" | ")}`);
      assert.equal(b.merged.pr, undefined, `${name} is never credited to the old pull request`);
      assert.equal(pruneRefusal(b, undefined), "not merged");
    }
    assert.deepEqual(planPrune(before, [before]).local.map((s) => s.branch), [], "neither branch is offered for deletion");

    // The reland really lands (squash-merged AFTER the merge base): now it is merged, and
    // credited to the new pull request, not the original one.
    g(repo, "merge", "-q", "--squash", "feat/reland"); g(repo, "commit", "-q", "-m", "Reland feature (#20)"); g(repo, "push", "-q", "origin", "main");
    const after = snapshotWorkspace(repo, { machine: MACHINE, publish: "full" });
    const landed = branch(after, "feat/reland").merged;
    assert.deepEqual([landed.status, landed.method, landed.pr], ["merged", "squash", 20]);
    assert.equal(branch(after, "feat/flip").merged.status, "unmerged");
  } finally { cleanup(); }
});

test("a branch with no commits of its own is labeled no-commits, not merged by ancestry, and never offered for deletion", () => {
  const { base, repo, cleanup } = fixture();
  try {
    const old = g(repo, "rev-parse", "HEAD~1");
    g(repo, "branch", "feat/fresh");               // created at main, nothing committed yet
    g(repo, "branch", "feat/older", old);          // created at an older main commit
    const wt = join(base, "wt-fresh");
    g(repo, "worktree", "add", "-q", wt, "feat/fresh");
    g(repo, "checkout", "-q", "-b", "feat/merged"); commitFile(repo, "m.ts", "export const m = 1;\n", "m");
    g(repo, "checkout", "-q", "main"); g(repo, "merge", "-q", "--no-ff", "-m", "merge feat/merged", "feat/merged"); g(repo, "push", "-q", "origin", "main");

    const record = snapshotWorkspace(repo, { machine: MACHINE, publish: "full" });
    for (const name of ["feat/fresh", "feat/older"]) {
      const b = branch(record, name);
      assert.deepEqual([b.merged.status, b.merged.method], ["no-commits", null], `${name}: ${b.merged.evidence.join(" | ")}`);
      assert.equal(pruneRefusal(b, undefined), "no commits of its own");
    }
    assert.deepEqual([branch(record, "feat/merged").merged.status, branch(record, "feat/merged").merged.method], ["merged", "ancestry"], "a real merge is still merged");
    const plan = planPrune(record, [record]);
    assert.deepEqual(plan.local.map((s) => s.branch), ["feat/merged"]);
    assert.equal(plan.skipped.some((s) => s.branch.startsWith("feat/fresh") || s.branch === "feat/older"), false);
    const rows = branchRows([record]);
    const fresh = rows.find((r) => r.name === "feat/fresh")!;
    assert.match(fresh.action, /^keep: no commits of its own/);
    assert.equal(rows.filter((r) => r.action.startsWith("delete local")).map((r) => r.name).join(), "feat/merged");
  } finally { cleanup(); }
});

test("status.showUntrackedFiles=no cannot hide an untracked file: the worktree is dirty and prune refuses it (#308)", () => {
  const { base, repo, cleanup } = fixture();
  try {
    g(repo, "checkout", "-q", "-b", "feat/wt"); commitFile(repo, "w.ts", "export const w = 1;\n", "w");
    g(repo, "checkout", "-q", "main"); g(repo, "merge", "-q", "--no-ff", "-m", "merge feat/wt", "feat/wt"); g(repo, "push", "-q", "origin", "main");
    const wt = join(base, "wt-untracked");
    g(repo, "worktree", "add", "-q", wt, "feat/wt");
    g(repo, "config", "status.showUntrackedFiles", "no");
    writeFileSync(join(wt, "new-work.ts"), "export const unsaved = 1;\n");
    assert.equal(g(wt, "status", "--porcelain"), "", "precondition: plain git status hides the file under this config");

    const record = snapshotWorkspace(repo, { machine: MACHINE, publish: "full" });
    const w = record.worktrees.find((x) => x.branch === "feat/wt")!;
    assert.equal(w.dirty, true);
    const plan = planPrune(record, [record]);
    assert.deepEqual(plan.local.map((s) => s.branch), []);
    assert.deepEqual(plan.skipped, [{ branch: "feat/wt", reason: "worktree has uncommitted or untracked changes" }]);
  } finally { cleanup(); }
});

test("a snapshot is stable across runs, and the content check ignores only the observation stamps", () => {
  const { repo, cleanup } = fixture();
  try {
    const a = snapshotWorkspace(repo, { machine: MACHINE, publish: "branches", now: new Date("2026-09-17T00:00:00Z") });
    const b = snapshotWorkspace(repo, { machine: MACHINE, publish: "branches", now: new Date("2026-09-18T00:00:00Z") });
    assert.ok(sameWorkspaceContent(a, b));
    commitFile(repo, "c.ts", "export const c = 1;\n", "c");
    const c = snapshotWorkspace(repo, { machine: MACHINE, publish: "branches" });
    assert.ok(!sameWorkspaceContent(a, c), "a new commit is a content change");
  } finally { cleanup(); }
});

// ---- hostile input: the schema and the loader ---------------------------------------------

function validRecord(): Workspace {
  return WorkspaceSchema.parse({
    schema: "hunch.workspace/1", id: workspaceId(MACHINE.id), machine: { id: MACHINE.id, label: MACHINE.label, platform: "linux" },
    repository: "git-remote:sha256:" + "0".repeat(64), publish: "branches", observed_at: "2026-09-17T00:00:00.000Z", fetched_at: null,
    default_branch: { name: "main", ref: "origin/main", head: "a".repeat(40) },
    worktrees: [{ id: "wt_00000001", path: null, branch: "main", head: "a".repeat(40), is_main: true, dirty: false, locked: false, prunable: false, last_commit_at: null }],
    branches: [{ name: "main", head: "a".repeat(40), is_default: true, upstream: "origin/main", upstream_gone: false, ahead: 0, behind: 0, last_commit_at: null, worktree: "wt_00000001", merged: { status: "unmerged", method: null, evidence: ["default branch"] } }],
    provenance: { source: "extracted", confidence: 1, evidence: [] },
  });
}

test("branch names that could smuggle a git argument or break a ref are refused", () => {
  for (const bad of ["--upload-pack=/tmp/x", "-D", "-", "a b", "a..b", "a@{1}", "x.lock", ".hidden", "a//b", "a\nb", "a\x00b", "a:b", "a?b", "a*b", "a[b", "a\\b", "a~1", "a^", "@", "a/", "/a", "a.", "a/.b", "x".repeat(257)]) {
    assert.equal(isSafeBranchName(bad), false, JSON.stringify(bad));
  }
  for (const ok of ["main", "feat/x", "claude/git-branches-worktrees-tracking-7v15a6", "release-1.2.3", "user@host", "a.b", "עברית"]) {
    assert.equal(isSafeBranchName(ok), true, ok);
  }
  const rec = validRecord();
  const forged = { ...rec, branches: [{ ...rec.branches[0]!, name: "--upload-pack=/tmp/x" }] };
  assert.equal(WorkspaceSchema.safeParse(forged).success, false);
});

test("the record schema is strict, bounded, credential-free and self-consistent", () => {
  const rec = validRecord();
  const refuse = (patch: (r: Workspace) => unknown, why: string) => assert.equal(WorkspaceSchema.safeParse(patch(structuredClone(rec))).success, false, why);
  refuse((r) => ({ ...r, extra: 1 }), "unknown top-level field");
  refuse((r) => ({ ...r, machine: { ...r.machine, hostname: "dave-mbp" } }), "unknown machine field (no hostname)");
  refuse((r) => ({ ...r, id: "ws_000000000000" }), "id not derived from the machine id");
  refuse((r) => ({ ...r, worktrees: [{ ...r.worktrees[0]!, path: "/home/dave/hunch" }] }), "a path in branches mode");
  refuse((r) => ({ ...r, publish: "full", worktrees: [{ ...r.worktrees[0]!, path: "https://user:secret@github.com/x" }] }), "credential in a path");
  refuse((r) => ({ ...r, publish: "full", worktrees: [{ ...r.worktrees[0]!, path: "/tmp/ghp_" + "a".repeat(30) }] }), "bare token in a path");
  refuse((r) => ({ ...r, branches: [{ ...r.branches[0]!, worktree: "wt_deadbeef" }] }), "branch pointing at a worktree the record does not carry");
  refuse((r) => ({ ...r, branches: [{ ...r.branches[0]!, merged: { status: "merged", method: null, evidence: [] } }] }), "merged without a method");
  refuse((r) => ({ ...r, branches: [{ ...r.branches[0]!, merged: { status: "unmerged", method: "squash", evidence: [] } }] }), "unmerged with a method");
  refuse((r) => ({ ...r, branches: [r.branches[0]!, r.branches[0]!] }), "duplicate branch");
  refuse((r) => ({ ...r, branches: [{ ...r.branches[0]!, upstream: "origin/--force" }] }), "upstream with a flag-shaped branch");
  refuse((r) => ({ ...r, branches: [{ ...r.branches[0]!, head: "not-a-sha" }] }), "non-sha head");
  refuse((r) => ({ ...r, machine: { ...r.machine, id: "mac_short" } }), "machine id shape");
  refuse((r) => ({ ...r, machine: { ...r.machine, label: "-rf" } }), "label starting with a dash");
  refuse((r) => ({ ...r, observed_at: "yesterday" }), "non-ISO timestamp");
  refuse((r) => ({ ...r, worktrees: Array.from({ length: 513 }, (_, i) => ({ ...r.worktrees[0]!, id: `wt_${i.toString(16).padStart(8, "0")}` })), branches: [] }), "unbounded worktree list");
  refuse((r) => ({ ...r, provenance: { ...r.provenance, evidence: ["Bearer " + "x".repeat(40)] } }), "credential in provenance");
  refuse((r) => ({ ...r, branches: [{ ...r.branches[0]!, merged: { status: "unmerged", method: null, evidence: ["see ghp_" + "a".repeat(30)] } }] }), "credential in verdict evidence");
  assert.equal(WorkspaceSchema.safeParse(rec).success, true);
});

test("a forged record on disk is skipped by the loader; valid siblings still load; a symlinked kind dir is refused", () => {
  const root = mkdtempSync(join(tmpdir(), "hunch-ws-forged-"));
  try {
    const store = new HunchStore(hunchPaths(root));
    try {
      store.json.ensureDirs();
      const dir = join(root, ".hunch", "workspaces");
      const good = validRecord();
      writeFileSync(join(dir, `${good.id}.json`), JSON.stringify(good));
      const forged = { ...validRecord(), id: workspaceId(OTHER.id), machine: { ...OTHER, platform: "linux" }, branches: [{ ...good.branches[0]!, name: "--upload-pack=x" }] };
      writeFileSync(join(dir, `${forged.id}.json`), JSON.stringify(forged));
      writeFileSync(join(dir, "ws_garbage00000.json"), "{not json");
      writeFileSync(join(dir, "ws_huge00000000.json"), JSON.stringify({ ...good, id: "ws_huge00000000" }) + " ".repeat(9 * 1024 * 1024));
      const warn = console.warn; const warnings: string[] = [];
      console.warn = (m: unknown) => { warnings.push(String(m)); };
      try {
        const loaded = store.json.loadAll("workspaces");
        assert.deepEqual(loaded.map((r) => r.id), [good.id], "only the valid record loads");
      } finally { console.warn = warn; }
      assert.ok(warnings.some((w) => /invalid|corrupt|skipping/i.test(w)), "the refusal is visible, not silent");
      assert.ok(existsSync(join(dir, `${forged.id}.json`)), "the forged file is left as written, never rewritten");
    } finally { store.close(); }
    // A symlinked kind directory (a cloned repo pointing .hunch/workspaces elsewhere) is refused outright.
    const root2 = mkdtempSync(join(tmpdir(), "hunch-ws-symlink-"));
    try {
      mkdirSync(join(root2, ".hunch"), { recursive: true });
      mkdirSync(join(root2, "elsewhere"));
      symlinkSync(join(root2, "elsewhere"), join(root2, ".hunch", "workspaces"));
      const store2 = new HunchStore(hunchPaths(root2));
      try { assert.throws(() => store2.json.loadAll("workspaces"), /symlink|unsafe|refus/i); } finally { store2.close(); }
    } finally { rmSync(root2, { recursive: true, force: true }); }
  } finally { rmSync(root, { recursive: true, force: true }); }
});

// ---- machine identity ----------------------------------------------------------------------

test("machine identity is minted once, random, owner-only, and never the hostname; a broken file re-mints", () => {
  const home = mkdtempSync(join(tmpdir(), "hunch-ws-home-"));
  try {
    // The XDG root here is a real path on the running platform, so `machineFile` must judge
    // it as that platform does — `platform: "linux"` would call `C:\\…` relative on Windows.
    const opts = { env: { XDG_CONFIG_HOME: join(home, "cfg") }, home, platform: process.platform };
    const file = machineFile(opts);
    assert.equal(file, join(home, "cfg", "hunch", "machine.json"));
    const a = loadOrCreateMachine(opts);
    assert.match(a.id, /^mac_[0-9a-f]{32}$/);
    assert.equal(a.label, defaultMachineLabel(a.id));
    assert.match(a.label, /^machine-[0-9a-f]{4}$/, "default label embeds nothing personal");
    assert.deepEqual(loadOrCreateMachine(opts), a, "stable across calls");
    assert.notEqual(loadOrCreateMachine({ ...opts, home: mkdtempSync(join(tmpdir(), "hunch-ws-home2-")), env: {} }).id, a.id, "a different user root is a different machine");
    if (process.platform !== "win32") assert.equal(statSync(file).mode & 0o777, 0o600);
    assert.equal(!!readFileSync(file, "utf8").match(/hostname|username/), false);

    assert.equal(setMachineLabel("build-box", opts).label, "build-box");
    assert.equal(loadOrCreateMachine(opts).label, "build-box");
    assert.throws(() => setMachineLabel("-rf /", opts), /label/);
    assert.throws(() => setMachineLabel("a".repeat(65), opts), /label/);

    writeFileSync(file, "{\"id\":\"mac_nope\"}");
    const reminted = loadOrCreateMachine(opts);
    assert.match(reminted.id, /^mac_[0-9a-f]{32}$/);
    assert.notEqual(reminted.id, a.id);
    assert.equal(lstatSync(file).isSymbolicLink(), false);
    // XDG_CONFIG_HOME containing a `.hunch` segment is ignored (findRoot's repository marker).
    assert.equal(machineFile({ env: { XDG_CONFIG_HOME: "/tmp/.hunch/x" }, home, platform: "linux" }), join(home, ".config", "hunch", "machine.json"));
    assert.equal(machineFile({ env: { XDG_CONFIG_HOME: "relative/x" }, home, platform: "linux" }), join(home, ".config", "hunch", "machine.json"));
  } finally { rmSync(home, { recursive: true, force: true }); }
});

// ---- aggregation across machines -----------------------------------------------------------

function machineRecord(machine: typeof MACHINE, observed: string, branches: Array<Partial<Workspace["branches"][number]> & { name: string }>, worktrees: Array<Partial<Workspace["worktrees"][number]> & { id: string }> = []): Workspace {
  const head = "b".repeat(40);
  return WorkspaceSchema.parse({
    schema: "hunch.workspace/1", id: workspaceId(machine.id), machine: { id: machine.id, label: machine.label, platform: "linux" },
    repository: "git-remote:sha256:" + "0".repeat(64), publish: "branches", observed_at: observed, fetched_at: null,
    default_branch: { name: "main", ref: "origin/main", head },
    worktrees: worktrees.map((w) => ({ path: null, branch: null, head, is_main: false, dirty: false, locked: false, prunable: false, last_commit_at: null, ...w })),
    branches: branches.map((b) => ({ head, is_default: false, upstream: null, upstream_gone: false, ahead: null, behind: null, last_commit_at: "2026-09-01T00:00:00.000Z", worktree: null, merged: { status: "unmerged", method: null, evidence: [] }, ...b })),
    provenance: { source: "extracted", confidence: 1, evidence: [] },
  });
}

test("branch rows union machines, keep a dirty worktree, flag diverged heads and stale machines; recommendations follow the documented rules", () => {
  const now = new Date("2026-09-17T12:00:00Z");
  const merged = { status: "merged" as const, method: "squash" as const, evidence: ["patch-id"] };
  const a = machineRecord(MACHINE, "2026-09-17T10:00:00Z", [
    { name: "fix/old", merged, upstream: "origin/fix/old", upstream_gone: true },
    { name: "feat/x", upstream: "origin/feat/x", ahead: 2, behind: 0, worktree: "wt_0000000a" },
    { name: "spike/y", last_commit_at: "2026-07-01T00:00:00.000Z" },
    { name: "diverged", head: "c".repeat(40) },
    { name: "main", is_default: true },
  ], [{ id: "wt_0000000a", branch: "feat/x", dirty: true }]);
  const b = machineRecord(OTHER, "2026-09-01T10:00:00Z", [ // 16 days old → unverified
    { name: "fix/old", merged: { status: "unknown", method: null, evidence: [] }, worktree: "wt_0000000b" },
    { name: "diverged", head: "d".repeat(40) },
  ], [{ id: "wt_0000000b", branch: "fix/old", dirty: false }]);
  const rows = Object.fromEntries(branchRows([a, b], { now }).map((r) => [r.name, r]));

  assert.deepEqual(rows["fix/old"]!.machines, ["other-box", "test-box"]);
  assert.equal(rows["fix/old"]!.merged.method, "squash", "a proven merge on one machine outranks unknown on another");
  assert.equal(rows["fix/old"]!.action, "delete local on other-box, test-box; prune worktree on other-box (unverified: other-box)");
  assert.equal(rows["feat/x"]!.action, "keep; dirty worktree on test-box");
  assert.deepEqual(rows["feat/x"]!.dirty_on, ["test-box"]);
  assert.equal(rows["spike/y"]!.action, "review: unpushed, 78d idle");
  assert.equal(rows["diverged"]!.action, "review: local heads differ across other-box, test-box (unverified: other-box)");
  assert.equal(rows["main"]!.action, "keep: default branch");
  assert.equal(recommendAction({ ...rows["fix/old"]!, dirty_on: ["test-box"], unverified_on: [] }, { now }), "keep: dirty worktree on test-box");
  assert.equal(recommendAction({ ...rows["fix/old"]!, merged: { status: "unknown", method: null, evidence: [] }, unverified_on: [] }, { now }), "review: merge state unknown");
  assert.equal(recommendAction({ ...rows["spike/y"]!, upstream: "origin/spike/y", upstream_gone: true }, { now }), "review: upstream deleted, unmerged work, 78d idle");

  const wt = worktreeRows([a, b], { now });
  assert.deepEqual(wt.map((w) => [w.machine, w.branch, w.dirty, w.unverified]), [["other-box", "fix/old", false, true], ["test-box", "feat/x", true, false]]);
  assert.equal(isUnverified(b, { now }), true);
  assert.equal(isUnverified(b, { now, staleAfterDays: 30 }), false);
  const newerA = { ...a, observed_at: "2026-09-17T11:00:00Z", branches: [] };
  assert.deepEqual(latestPerMachine([a, newerA, b]).map((r) => [r.machine.label, r.observed_at]), [["other-box", "2026-09-01T10:00:00Z"], ["test-box", "2026-09-17T11:00:00Z"]], "newest observation per machine wins");
});

// ---- CLI end to end -----------------------------------------------------------------------

function cli(cwd: string, env: Record<string, string>, ...args: string[]): { stdout: string; stderr: string; status: number } {
  const res = spawnSync(process.execPath, [TSX, CLI, ...args], {
    cwd, encoding: "utf8", timeout: 120_000,
    env: { ...process.env, HUNCH_PRIVATE_DIR: "", HUNCH_SYNTH_PROVIDER: "deterministic", NO_COLOR: "1", GIT_CONFIG_NOSYSTEM: "1", ...env },
  });
  return { stdout: res.stdout ?? "", stderr: res.stderr ?? "", status: res.status ?? -1 };
}

function machineEnv(base: string, machine: typeof MACHINE): Record<string, string> {
  const cfgHome = join(base, "xdg");
  mkdirSync(join(cfgHome, "hunch"), { recursive: true });
  writeFileSync(join(cfgHome, "hunch", "machine.json"), JSON.stringify(machine));
  return { XDG_CONFIG_HOME: cfgHome };
}

test("CLI: this machine is always LIVE — a stored record claiming a branch is merged never changes the verdict; other machines come from memory", () => {
  const { base, repo, cleanup } = fixture();
  try {
    const env = machineEnv(base, MACHINE);
    g(repo, "checkout", "-q", "-b", "feat/open"); const openHead = commitFile(repo, "o.ts", "export const o = 1;\n", "open"); g(repo, "checkout", "-q", "main");
    const store = new HunchStore(hunchPaths(repo));
    try {
      store.json.ensureDirs();
      // Forged: THIS machine's record says feat/open is merged (and adds a phantom branch).
      const forgedSelf = machineRecord(MACHINE, new Date().toISOString(), [
        { name: "feat/open", merged: { status: "merged", method: "ancestry", evidence: ["forged"] } },
        { name: "phantom", merged: { status: "merged", method: "ancestry", evidence: ["forged"] } },
      ]);
      store.json.put("workspaces", forgedSelf);
      // Genuine: another machine holds feat/open in a dirty worktree.
      store.json.put("workspaces", machineRecord(OTHER, new Date().toISOString(), [{ name: "feat/open", head: openHead, worktree: "wt_0000000b" }], [{ id: "wt_0000000b", branch: "feat/open", head: openHead, dirty: true }]));
    } finally { store.close(); }

    const out = cli(repo, env, "branches", "--json");
    assert.equal(out.status, 0, out.stderr);
    const rows = (JSON.parse(out.stdout) as { branches: Array<{ name: string; merged: { status: string }; machines: string[]; action: string }> }).branches;
    const open = rows.find((r) => r.name === "feat/open")!;
    assert.equal(open.merged.status, "unmerged", "live git wins over the forged stored record");
    assert.deepEqual(open.machines, ["other-box", "test-box"]);
    assert.equal(open.action, "keep: unpushed; dirty worktree on other-box");
    assert.equal(rows.some((r) => r.name === "phantom"), false, "this machine's stored record is not read at all");

    const table = cli(repo, env, "branches");
    assert.match(table.stdout, /feat\/open\s+other-box,test-box\s+other-box \(dirty\)\s+never pushed\s+no\s+keep: unpushed; dirty worktree on other-box/);
    assert.match(table.stdout, /main .*keep: default branch/);
    const inv = cli(repo, env, "workspaces");
    assert.match(inv.stdout, /test-box \(this\)\s+\S+repo\s+main\s+(yes|-)\s+\S+ ago\s+live/); // dirty: the derived sqlite index is untracked here
    assert.match(inv.stdout, /other-box\s+yes\s+feat\/open\s+yes\s+-\s+\d+m ago/);
    assert.match(inv.stdout, /1 other machine\(s\) in memory/);
  } finally { cleanup(); }
});

test("CLI: snapshot writes nothing without an overlay (dry-run too), writes into a private overlay once, and skips an unchanged re-run", () => {
  const { base, repo, cleanup } = fixture();
  try {
    const env = machineEnv(base, MACHINE);
    const dry = cli(repo, env, "workspaces", "snapshot", "--dry-run");
    assert.equal(dry.status, 0, dry.stderr);
    const dryRecord = JSON.parse(dry.stdout) as Workspace;
    assert.equal(dryRecord.publish, "branches", "default publish mode carries no paths");
    assert.ok(dryRecord.worktrees.every((w) => w.path === null));
    assert.equal(existsSync(join(repo, ".hunch", "workspaces")) && readdirSync(join(repo, ".hunch", "workspaces")).length > 0, false, "dry-run writes nothing");

    const noOverlay = cli(repo, env, "workspaces", "snapshot");
    assert.equal(noOverlay.status, 0, noOverlay.stderr);
    assert.match(noOverlay.stdout, /No memory overlay is configured/);
    assert.equal(existsSync(join(repo, ".hunch", "workspaces")) && readdirSync(join(repo, ".hunch", "workspaces")).length > 0, false, "public .hunch/ untouched by default");

    // A private overlay (its own git repo): the record lands there, committed.
    const overlayRoot = join(base, "overlay");
    g(base, "init", "-q", "-b", "main", overlayRoot); cfg(overlayRoot);
    mkdirSync(join(overlayRoot, ".hunch"), { recursive: true });
    writeFileSync(join(overlayRoot, ".gitignore"), ".hunch/hunch.sqlite*\n");
    g(overlayRoot, "add", "-A"); g(overlayRoot, "commit", "-q", "-m", "overlay");
    writeFileSync(join(repo, ".hunch", "local.json"), JSON.stringify({ privateDir: join(overlayRoot, ".hunch"), autoCommit: true, mode: "private" }) + "\n");

    const first = cli(repo, env, "workspaces", "snapshot");
    assert.equal(first.status, 0, first.stderr);
    assert.match(first.stdout, /✓ recorded 1 worktree\(s\), 1 branch\(es\) as test-box \(ws_0123456789ab, publish=branches\) → overlay, committed/);
    const file = join(overlayRoot, ".hunch", "workspaces", "ws_0123456789ab.json");
    assert.ok(existsSync(file));
    assert.equal(WorkspaceSchema.safeParse(JSON.parse(readFileSync(file, "utf8"))).success, true, "what is on disk passes the strict schema");
    assert.match(g(overlayRoot, "log", "-1", "--format=%s"), /workspace snapshot test-box/);
    assert.equal(existsSync(join(repo, ".hunch", "workspaces", "ws_0123456789ab.json")), false, "never the public store");

    const second = cli(repo, env, "workspaces", "snapshot");
    assert.match(second.stdout, /unchanged since .* nothing written/);
    assert.match(g(overlayRoot, "log", "-1", "--format=%s"), /workspace snapshot test-box/, "no second commit");

    commitFile(repo, "n.ts", "export const n = 1;\n", "n");
    const third = cli(repo, env, "workspaces", "snapshot", "--quiet");
    assert.equal(third.stdout, "");
    assert.equal(g(overlayRoot, "rev-list", "--count", "HEAD"), "3", "a real change commits again");

    const forget = cli(repo, env, "workspaces", "forget", "test-box");
    assert.match(forget.stdout, /forgot 1 record/);
    assert.equal(existsSync(file), false);
    assert.match(cli(repo, env, "workspaces", "forget", "nobody").stderr, /no workspace record/);
  } finally { cleanup(); }
});

/** Hunch publication is ADDITIVE: the memory pump never stages a tracked deletion (see
 *  `stagedMemoryPaths` in src/extractors/git.ts). Deleting a `publish_public` workspace
 *  record therefore used to strand `D .hunch/workspaces/<id>.json` in the working tree and
 *  wedge every LATER public auto-commit. `forget` refuses it and prints the manual recipe. */
test("CLI: forget refuses a record committed in the public .hunch/, keeps the file, and leaves later public auto-commits working", () => {
  const { base, repo, cleanup } = fixture();
  try {
    const env = machineEnv(base, MACHINE);
    writeFileSync(join(repo, ".hunch", "config.json"), JSON.stringify({ workspaces: { publish_public: true } }) + "\n");
    // A FOREIGN machine's record, committed into the repo-tracked .hunch/ exactly as a
    // publish_public snapshot on that machine would have left it.
    const other = machineRecord(OTHER, new Date().toISOString(), [{ name: "fix/old" }]);
    const store = new HunchStore(hunchPaths(repo));
    try { store.json.ensureDirs(); store.json.put("workspaces", other); } finally { store.close(); }
    const file = join(repo, ".hunch", "workspaces", `${workspaceId(OTHER.id)}.json`);
    assert.ok(existsSync(file));
    g(repo, "add", "-A"); g(repo, "commit", "-q", "-m", "hunch: public workspace record");
    const commitsBefore = g(repo, "rev-list", "--count", "HEAD");

    const forget = cli(repo, env, "workspaces", "forget", "other-box");
    assert.notEqual(forget.status, 0, "nothing forgotten + one refused → non-zero exit");
    assert.ok(existsSync(file), "the public record file is NOT deleted");
    assert.match(forget.stdout, /refused: ws_[0-9a-f]+ \(other-box\) lives in this repo's \.hunch\//);
    assert.match(forget.stdout, new RegExp(`git rm \\.hunch/workspaces/${workspaceId(OTHER.id)}\\.json`));
    assert.match(forget.stdout, /git commit -m "hunch: forget workspace other-box"/);
    assert.equal(g(repo, "status", "--porcelain", "--", ".hunch"), "", "no stranded `D .hunch/…` in the working tree");
    assert.equal(g(repo, "rev-list", "--count", "HEAD"), commitsBefore, "a refusal commits nothing");

    // The real damage the old behaviour did: a LATER public auto-commit must still land.
    const snap = cli(repo, env, "workspaces", "snapshot");
    assert.equal(snap.status, 0, snap.stderr);
    assert.match(snap.stdout, /→ public \.hunch\/, committed/);
    assert.match(g(repo, "log", "-1", "--format=%s"), /workspace snapshot test-box/);
    assert.ok(existsSync(join(repo, ".hunch", "workspaces", `${workspaceId(MACHINE.id)}.json`)));
    assert.equal(g(repo, "status", "--porcelain", "--", ".hunch"), "", "the public store stays clean");

    assert.match(cli(repo, env, "workspaces", "forget", "nobody").stderr, /no workspace record/);
  } finally { cleanup(); }
});

test("CLI: forget with both homes forgets the overlay record and reports the refused public one", () => {
  const { base, repo, cleanup } = fixture();
  try {
    const env = machineEnv(base, MACHINE);
    writeFileSync(join(repo, ".hunch", "config.json"), JSON.stringify({ workspaces: { publish_public: true } }) + "\n");
    const overlayRoot = join(base, "overlay");
    g(base, "init", "-q", "-b", "main", overlayRoot); cfg(overlayRoot);
    mkdirSync(join(overlayRoot, ".hunch"), { recursive: true });
    writeFileSync(join(overlayRoot, ".gitignore"), ".hunch/hunch.sqlite*\n");
    g(overlayRoot, "add", "-A"); g(overlayRoot, "commit", "-q", "-m", "overlay");

    // One record per home, under DIFFERENT machine ids (one home per record is the
    // store's contract) but both matching `forget`'s label/id lookup by id.
    const publicRecord = machineRecord(OTHER, new Date().toISOString(), [{ name: "fix/old" }]);
    let store = new HunchStore(hunchPaths(repo));
    try { store.json.ensureDirs(); store.json.put("workspaces", publicRecord); } finally { store.close(); }
    g(repo, "add", "-A"); g(repo, "commit", "-q", "-m", "hunch: public workspace record");

    writeFileSync(join(repo, ".hunch", "local.json"), JSON.stringify({ privateDir: join(overlayRoot, ".hunch"), autoCommit: true, mode: "private" }) + "\n");
    const first = cli(repo, env, "workspaces", "snapshot");
    assert.equal(first.status, 0, first.stderr);
    const overlayFile = join(overlayRoot, ".hunch", "workspaces", `${workspaceId(MACHINE.id)}.json`);
    assert.ok(existsSync(overlayFile), "this machine's record went to the overlay");

    // Forget both by id in one run each: the overlay one goes, the public one is refused.
    const overlayForget = cli(repo, env, "workspaces", "forget", "test-box");
    assert.equal(overlayForget.status, 0, overlayForget.stderr);
    assert.match(overlayForget.stdout, /forgot 1 record\(s\) for test-box/);
    assert.equal(existsSync(overlayFile), false);

    const publicFile = join(repo, ".hunch", "workspaces", `${workspaceId(OTHER.id)}.json`);
    const publicForget = cli(repo, env, "workspaces", "forget", "other-box");
    assert.notEqual(publicForget.status, 0);
    assert.ok(existsSync(publicFile), "an overlay being configured does not make the public record deletable");
    assert.match(publicForget.stdout, /git rm \.hunch\/workspaces\//);
    assert.equal(g(repo, "status", "--porcelain", "--", ".hunch/workspaces"), "", "no stranded deletion");
  } finally { cleanup(); }
});

test("CLI: label shows and sets the machine label, refusing unsafe values", () => {
  const base = mkdtempSync(join(tmpdir(), "hunch-ws-label-"));
  try {
    const env = { XDG_CONFIG_HOME: join(base, "xdg") };
    const shown = cli(base, env, "workspaces", "label");
    assert.match(shown.stdout, /^machine-[0-9a-f]{4}  \(mac_[0-9a-f]{32}, .*machine\.json\)/);
    assert.match(cli(base, env, "workspaces", "label", "build-box").stdout, /^build-box  \(mac_/);
    assert.match(cli(base, env, "workspaces", "label").stdout, /^build-box/);
    const bad = cli(base, env, "workspaces", "label", "bad label!");
    assert.notEqual(bad.status, 0);
  } finally { rmSync(base, { recursive: true, force: true }); }
});
