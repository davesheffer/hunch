/**
 * Workspace ledger, Phase 2 (docs/workspace-ledger.md): the git hooks that keep a machine's
 * record fresh, the shared record/read path, the read-only `hunch_workspaces` MCP tool, the
 * ledger-read refresh, the `/worktrees` scaffold, `hunch worktree`, and the
 * `now` / `doctor` lines.
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import { execFileSync, spawnSync } from "node:child_process";
import { chmodSync, existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";
import { buildServer, buildServerWithRootControl } from "../src/mcp/server.js";
import { HunchStore } from "../src/store/hunchStore.js";
import { hunchPaths } from "../src/core/paths.js";
import { installPostCheckoutHook, installPostCommitHook, hookStatus } from "../src/integrations/hooks.js";
import { writeSlashCommands } from "../src/integrations/scaffold.js";
import { branchRows, recordWorkspaceSnapshot, renderBranchTable, snapshotHasHome, workspaceSummaryLine, workspaceLedgerView } from "../src/integrations/workspaceLedger.js";
import { WorkspaceSchema, workspaceId, type Workspace } from "../src/core/workspace.js";
import { gitHeadUnsettled } from "../src/extractors/git.js";

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

/** A repo (with committed .hunch/) plus a private overlay repo wired through local.json, and
 *  a machine identity under a private XDG root — the shape of a developer's real setup. */
function fixture(): { base: string; repo: string; overlayRoot: string; env: Record<string, string>; cleanup: () => void } {
  const base = mkdtempSync(join(tmpdir(), "hunch-ledger-"));
  const repo = join(base, "repo");
  g(base, "init", "-q", "-b", "main", repo); cfg(repo);
  mkdirSync(join(repo, ".hunch"), { recursive: true });
  writeFileSync(join(repo, ".gitignore"), ".hunch/hunch.sqlite*\n.hunch/local.json\n"); // what `hunch init` writes (ensureGitignore)
  commitFile(repo, ".hunch/manifest.json", '{"schema_version":3}\n', "hunch: init");
  commitFile(repo, "app.ts", "export const x = 1;\n", "code");
  const overlayRoot = join(base, "overlay");
  g(base, "init", "-q", "-b", "main", overlayRoot); cfg(overlayRoot);
  mkdirSync(join(overlayRoot, ".hunch"), { recursive: true });
  writeFileSync(join(overlayRoot, ".gitignore"), ".hunch/hunch.sqlite*\n");
  g(overlayRoot, "add", "-A"); g(overlayRoot, "commit", "-q", "-m", "overlay");
  writeFileSync(join(repo, ".hunch", "local.json"), JSON.stringify({ privateDir: join(overlayRoot, ".hunch"), autoCommit: true, mode: "private" }) + "\n");
  const cfgHome = join(base, "xdg");
  mkdirSync(join(cfgHome, "hunch"), { recursive: true });
  writeFileSync(join(cfgHome, "hunch", "machine.json"), JSON.stringify(MACHINE));
  return { base, repo, overlayRoot, env: { XDG_CONFIG_HOME: cfgHome }, cleanup: () => rmSync(base, { recursive: true, force: true }) };
}

/** Apply an env patch; the returned function restores it (call from `finally` / `t.after`). */
function setEnv(patch: Record<string, string | undefined>): () => void {
  const saved = Object.fromEntries(Object.keys(patch).map((k) => [k, process.env[k]]));
  for (const [k, v] of Object.entries(patch)) { if (v === undefined) delete process.env[k]; else process.env[k] = v; }
  return () => { for (const [k, v] of Object.entries(saved)) { if (v === undefined) delete process.env[k]; else process.env[k] = v; } };
}
function withEnv<T>(patch: Record<string, string | undefined>, fn: () => T): T {
  const restore = setEnv(patch);
  try { return fn(); } finally { restore(); }
}

function cli(cwd: string, env: Record<string, string>, ...args: string[]): { stdout: string; stderr: string; status: number } {
  const res = spawnSync(process.execPath, [TSX, CLI, ...args], {
    cwd, encoding: "utf8", timeout: 180_000,
    env: { ...process.env, HUNCH_PRIVATE_DIR: "", HUNCH_SYNTH_PROVIDER: "deterministic", NO_COLOR: "1", GIT_CONFIG_NOSYSTEM: "1", ...env },
  });
  return { stdout: res.stdout ?? "", stderr: res.stderr ?? "", status: res.status ?? -1 };
}

function otherRecord(observed: string, branches: Array<{ name: string; merged?: Workspace["branches"][number]["merged"] }>): Workspace {
  const head = "b".repeat(40);
  return WorkspaceSchema.parse({
    schema: "hunch.workspace/1", id: workspaceId(OTHER.id), machine: { id: OTHER.id, label: OTHER.label, platform: "linux" },
    repository: "git-remote:sha256:" + "0".repeat(64), publish: "branches", observed_at: observed, fetched_at: null,
    default_branch: { name: "main", ref: "origin/main", head },
    worktrees: [{ id: "wt_0000000b", path: null, branch: branches[0]?.name ?? null, head, is_main: false, dirty: true, locked: false, prunable: false, last_commit_at: null }],
    branches: branches.map((b, i) => ({ name: b.name, head, is_default: false, upstream: null, upstream_gone: false, ahead: null, behind: null, last_commit_at: "2026-09-01T00:00:00.000Z", worktree: i === 0 ? "wt_0000000b" : null, merged: b.merged ?? { status: "unmerged", method: null, evidence: [] } })),
    provenance: { source: "extracted", confidence: 1, evidence: [] },
  });
}

// ---- hooks --------------------------------------------------------------------------------

test("post-checkout hook: constant argv, HUNCH_SYNC-guarded, branch checkouts only ($3 = 1), backgrounded, idempotent; post-commit stays out of it", () => {
  const r = mkdtempSync(join(tmpdir(), "hunch-ledger-hook-"));
  try {
    g(r, "init", "-q");
    assert.equal(hookStatus(r).postCheckout, false);
    const first = installPostCheckoutHook(r, "hunch");
    assert.equal(first.action, "created");
    const text = readFileSync(join(r, ".git", "hooks", "post-checkout"), "utf8");
    assert.match(text, /^#!\/bin\/sh\n/);
    assert.match(text, /if \[ -z "\$HUNCH_SYNC" \] && \[ "\$3" = "1" \]; then/);
    assert.match(text, /\( HUNCH_SYNC=1 hunch workspaces snapshot --quiet >\/dev\/null 2>&1 \|\| true \) &/);
    assert.equal(hookStatus(r).postCheckout, true);
    assert.equal(installPostCheckoutHook(r, "hunch").action, "unchanged");
    assert.equal(installPostCheckoutHook(r, "/opt/hunch/bin/hunch").action, "updated");
    assert.equal(readFileSync(join(r, ".git", "hooks", "post-checkout"), "utf8").match(/workspace ledger/g)?.length, 2, "one managed block, replaced in place");

    // A pre-existing user hook is preserved, ours appended after it.
    writeFileSync(join(r, ".git", "hooks", "post-checkout"), "#!/bin/sh\necho user-hook\n");
    assert.equal(installPostCheckoutHook(r, "hunch").action, "appended");
    assert.match(readFileSync(join(r, ".git", "hooks", "post-checkout"), "utf8"), /^#!\/bin\/sh\necho user-hook\n# >>> hunch post-checkout/);

    // post-commit deliberately does NOT snapshot: a commit changes HEAD, not which branches
    // and worktrees exist, and a background child outliving `git commit` is what held a
    // Windows clone open and broke an unrelated test's teardown (EBUSY).
    installPostCommitHook(r, "hunch");
    const commit = readFileSync(join(r, ".git", "hooks", "post-commit"), "utf8");
    assert.match(commit, /hunch sync --from-hook --quiet >/);
    assert.doesNotMatch(commit, /workspaces snapshot/);
  } finally { rmSync(r, { recursive: true, force: true }); }
});

test("the installed post-checkout hook really records a snapshot on a branch checkout, and not on a file checkout", { skip: process.platform === "win32" ? "sh hook" : false }, () => {
  const { repo, overlayRoot, env, cleanup } = fixture();
  try {
    // The hook must run THIS checkout's CLI: a tiny launcher script stands in for the `hunch` binary.
    const launcher = join(repo, "..", "hunch-launcher.sh");
    writeFileSync(launcher, `#!/bin/sh\nexec "${process.execPath}" "${TSX}" "${CLI}" "$@"\n`);
    chmodSync(launcher, 0o755);
    installPostCheckoutHook(repo, launcher);
    const file = join(overlayRoot, ".hunch", "workspaces", `${workspaceId(MACHINE.id)}.json`);
    const hookEnv = { ...process.env, ...env, HUNCH_PRIVATE_DIR: "", HUNCH_SYNTH_PROVIDER: "deterministic", GIT_CONFIG_NOSYSTEM: "1" };

    execFileSync("git", ["checkout", "-q", "--", "app.ts"], { cwd: repo, env: hookEnv }); // file checkout: $3 = 0
    const deadline0 = Date.now() + 3_000;
    while (Date.now() < deadline0 && !existsSync(file)) Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, 100);
    assert.equal(existsSync(file), false, "a file checkout does not touch the ledger");

    execFileSync("git", ["checkout", "-q", "-b", "feat/hooked"], { cwd: repo, env: hookEnv }); // branch checkout: $3 = 1
    const deadline = Date.now() + 60_000;
    while (Date.now() < deadline && !existsSync(file)) Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, 200);
    assert.ok(existsSync(file), "the backgrounded hook wrote this machine's record into the overlay");
    const record = WorkspaceSchema.parse(JSON.parse(readFileSync(file, "utf8")));
    assert.ok(record.branches.some((b) => b.name === "feat/hooked"));
    assert.equal(record.publish, "branches");
    const logDeadline = Date.now() + 30_000;
    while (Date.now() < logDeadline && !/workspace snapshot/.test(g(overlayRoot, "log", "-1", "--format=%s"))) Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, 200);
    assert.match(g(overlayRoot, "log", "-1", "--format=%s"), /workspace snapshot test-box/);
  } finally { cleanup(); }
});

// ---- the shared record/read path ----------------------------------------------------------

test("recordWorkspaceSnapshot: off / no-home / written / unchanged / dry-run, one commit per real change", () => {
  const { repo, overlayRoot, env, cleanup } = fixture();
  try {
    withEnv({ ...env, HUNCH_PRIVATE_DIR: undefined }, () => {
      const open = () => new HunchStore(hunchPaths(repo));
      let store = open();
      try {
        assert.equal(snapshotHasHome(store, repo), true);
        const dry = recordWorkspaceSnapshot(store, repo, { dryRun: true });
        assert.equal(dry.status, "dry-run");
        assert.equal(store.recs("workspaces").length, 0);
        const first = recordWorkspaceSnapshot(store, repo);
        assert.equal(first.status, "written");
        assert.equal(first.status === "written" && first.home, "private");
        assert.equal(first.status === "written" && first.flushed, "committed");
        const second = recordWorkspaceSnapshot(store, repo);
        assert.equal(second.status, "unchanged");
        assert.equal(g(overlayRoot, "rev-list", "--count", "HEAD"), "2");
        commitFile(repo, "b.ts", "export const b = 1;\n", "b");
        assert.equal(recordWorkspaceSnapshot(store, repo).status, "written");
        assert.equal(g(overlayRoot, "rev-list", "--count", "HEAD"), "3");
      } finally { store.close(); }

      writeFileSync(join(repo, ".hunch", "config.json"), JSON.stringify({ workspaces: { publish: "off" } }));
      store = open();
      try {
        assert.equal(recordWorkspaceSnapshot(store, repo).status, "off");
        assert.equal(snapshotHasHome(store, repo), false);
      } finally { store.close(); }

      writeFileSync(join(repo, ".hunch", "config.json"), "{}");
      rmSync(join(repo, ".hunch", "local.json"));
      store = open();
      try {
        assert.equal(store.hasPrivate, false);
        assert.equal(recordWorkspaceSnapshot(store, repo).status, "no-home");
        assert.equal(snapshotHasHome(store, repo), false);
        assert.equal(existsSync(join(repo, ".hunch", "workspaces")) && readFileSync(join(repo, ".hunch", "manifest.json"), "utf8").length > 0 && (existsSync(join(repo, ".hunch", "workspaces", `${workspaceId(MACHINE.id)}.json`))), false);
      } finally { store.close(); }

      writeFileSync(join(repo, ".hunch", "config.json"), JSON.stringify({ workspaces: { publish_public: true } }));
      store = open();
      try {
        const pub = recordWorkspaceSnapshot(store, repo);
        assert.equal(pub.status, "written");
        assert.equal(pub.status === "written" && pub.home, "public");
        assert.equal(pub.status === "written" && pub.flushed, "committed");
        assert.ok(existsSync(join(repo, ".hunch", "workspaces", `${workspaceId(MACHINE.id)}.json`)), "opt-in public record");
        assert.match(g(repo, "log", "-1", "--format=%s"), /workspace snapshot test-box/, "committed into the code repo, not pushed");
      } finally { store.close(); }
    });
  } finally { cleanup(); }
});

// ---- issue #313: a public snapshot never writes mid-operation / on a detached HEAD ----------

/** The fixture, switched to a PUBLIC home: no overlay, `publish_public: true` — the shape in
 *  which a snapshot is a commit on the checked-out code branch. */
function publicFixture(): ReturnType<typeof fixture> {
  const f = fixture();
  rmSync(join(f.repo, ".hunch", "local.json"));
  writeFileSync(join(f.repo, ".hunch", "config.json"), JSON.stringify({ workspaces: { publish_public: true } }));
  return f;
}

/** Nothing of this machine's record reached the code repo: no file, no dirty path under
 *  .hunch/workspaces, no snapshot commit. */
function assertNothingRecorded(repo: string): void {
  assert.equal(existsSync(join(repo, ".hunch", "workspaces", `${workspaceId(MACHINE.id)}.json`)), false, "no ws_*.json in the code repo");
  const porcelain = g(repo, "status", "--porcelain");
  assert.equal(porcelain.split("\n").some((l) => /\.hunch\/workspaces/.test(l)), false, `git status shows nothing under .hunch/workspaces (got: ${porcelain})`);
  assert.doesNotMatch(g(repo, "log", "--format=%s", "-20"), /hunch: workspace snapshot/, "no snapshot commit");
}

/** Leave `repo` stopped in the middle of a rebase (or merge) on a conflict: two branches edit
 *  the same line, and the replay cannot pick a side. */
function conflictAndReplay(repo: string, kind: "rebase" | "merge"): void {
  const here = g(repo, "rev-parse", "--abbrev-ref", "HEAD"); // whatever branch this checkout is on
  commitFile(repo, "conflict.txt", "base\n", "base");
  g(repo, "checkout", "-q", "-b", `conflict/${kind}`);
  commitFile(repo, "conflict.txt", "theirs\n", "their edit");
  g(repo, "checkout", "-q", here);
  commitFile(repo, "conflict.txt", "ours\n", "our edit");
  const res = spawnSync("git", [kind, `conflict/${kind}`], { cwd: repo, encoding: "utf8", env: { ...process.env, GIT_CONFIG_NOSYSTEM: "1" } });
  assert.notEqual(res.status, 0, `git ${kind} must stop on the conflict`);
}

test("a PUBLIC snapshot defers mid-rebase and writes nothing; it records normally once the rebase is aborted (issue #313)", () => {
  const { repo, env, cleanup } = publicFixture();
  try {
    withEnv({ ...env, HUNCH_PRIVATE_DIR: undefined }, () => {
      conflictAndReplay(repo, "rebase");
      assert.ok(existsSync(join(repo, ".git", "rebase-merge")) || existsSync(join(repo, ".git", "rebase-apply")), "the rebase really is in progress");
      let store = new HunchStore(hunchPaths(repo));
      try {
        const out = recordWorkspaceSnapshot(store, repo);
        assert.equal(out.status, "deferred");
        assert.equal(out.status === "deferred" && out.reason, "git-operation-in-progress");
        assertNothingRecorded(repo);
      } finally { store.close(); }

      g(repo, "rebase", "--abort");
      store = new HunchStore(hunchPaths(repo));
      try {
        const out = recordWorkspaceSnapshot(store, repo);
        assert.equal(out.status, "written", "a settled branch records as before");
        assert.equal(out.status === "written" && out.home, "public");
        assert.ok(existsSync(join(repo, ".hunch", "workspaces", `${workspaceId(MACHINE.id)}.json`)));
      } finally { store.close(); }
    });
  } finally { cleanup(); }
});

test("a PUBLIC snapshot defers on a detached HEAD and writes nothing (issue #313)", () => {
  const { repo, env, cleanup } = publicFixture();
  try {
    withEnv({ ...env, HUNCH_PRIVATE_DIR: undefined }, () => {
      g(repo, "checkout", "-q", "--detach");
      const store = new HunchStore(hunchPaths(repo));
      try {
        const out = recordWorkspaceSnapshot(store, repo);
        assert.equal(out.status, "deferred");
        assert.equal(out.status === "deferred" && out.reason, "detached-head");
        assertNothingRecorded(repo);
      } finally { store.close(); }
    });
  } finally { cleanup(); }
});

test("a PUBLIC snapshot defers mid-merge (MERGE_HEAD present) and writes nothing (issue #313)", () => {
  const { repo, env, cleanup } = publicFixture();
  try {
    withEnv({ ...env, HUNCH_PRIVATE_DIR: undefined }, () => {
      conflictAndReplay(repo, "merge");
      assert.ok(existsSync(join(repo, ".git", "MERGE_HEAD")), "the merge really is in progress");
      const store = new HunchStore(hunchPaths(repo));
      try {
        const out = recordWorkspaceSnapshot(store, repo);
        assert.equal(out.status, "deferred");
        assert.equal(out.status === "deferred" && out.reason, "git-operation-in-progress");
        assertNothingRecorded(repo);
      } finally { store.close(); }
    });
  } finally { cleanup(); }
});

test("a PRIVATE overlay is its own repository: a detached code HEAD still records (issue #313)", () => {
  const { repo, overlayRoot, env, cleanup } = fixture(); // overlay wired through local.json
  try {
    withEnv({ ...env, HUNCH_PRIVATE_DIR: undefined }, () => {
      g(repo, "checkout", "-q", "--detach");
      const store = new HunchStore(hunchPaths(repo));
      try {
        assert.equal(store.hasPrivate, true);
        const out = recordWorkspaceSnapshot(store, repo);
        assert.equal(out.status, "written", "private behaviour is unchanged by the guard");
        assert.equal(out.status === "written" && out.home, "private");
        assert.ok(existsSync(join(overlayRoot, ".hunch", "workspaces", `${workspaceId(MACHINE.id)}.json`)));
      } finally { store.close(); }
    });
  } finally { cleanup(); }
});

test("gitHeadUnsettled: null on a settled branch and outside a repo; per-worktree, so a rebase in a linked worktree is invisible to the main checkout (issue #313)", () => {
  const base = mkdtempSync(join(tmpdir(), "hunch-unsettled-"));
  try {
    const repo = join(base, "repo");
    g(base, "init", "-q", "-b", "main", repo); cfg(repo);
    commitFile(repo, "a.txt", "a\n", "a");
    assert.equal(gitHeadUnsettled(repo), null, "a settled branch");

    const plain = join(base, "not-a-repo");
    mkdirSync(plain, { recursive: true });
    assert.equal(gitHeadUnsettled(plain), null, "not a git repo — fail open");

    const wt = join(base, "wt");
    g(repo, "worktree", "add", "-q", "-b", "side", wt);
    conflictAndReplay(wt, "rebase");
    assert.equal(gitHeadUnsettled(wt), "git-operation-in-progress", "the linked worktree is mid-rebase");
    assert.equal(gitHeadUnsettled(repo), null, "the MAIN checkout of the same repo is untouched");

    g(wt, "rebase", "--abort");
    g(wt, "checkout", "-q", "--detach");
    assert.equal(gitHeadUnsettled(wt), "detached-head");
  } finally { rmSync(base, { recursive: true, force: true }); }
});

test("workspaceSummaryLine reads stored records only and counts machines, dirty worktrees and deletable branches", () => {
  const now = new Date("2026-09-17T12:00:00Z");
  const config = { publish: "branches" as const, stale_after_days: 7, publish_public: false };
  assert.equal(workspaceSummaryLine([], config, now), null);
  const fresh = otherRecord("2026-09-17T10:00:00Z", [{ name: "feat/x" }, { name: "fix/old", merged: { status: "merged", method: "squash", evidence: ["p"] } }]);
  const line = workspaceSummaryLine([fresh], config, now)!;
  assert.equal(line, "🗂 Workspaces in memory: 1 machine(s) · 1 worktree(s) (1 dirty) · 2 branch(es), 1 deletable — `hunch branches` for the verdicts");
  const stale = { ...fresh, observed_at: "2026-09-01T10:00:00Z" };
  assert.match(workspaceSummaryLine([stale], config, now)!, /1 machine\(s\) \(1 unverified\)/);
});

test("a no-commits branch reads as 'no commits' in the branch table, is kept, and never counts as deletable", () => {
  const now = new Date("2026-09-17T12:00:00Z");
  const config = { publish: "branches" as const, stale_after_days: 7, publish_public: false };
  const rec = otherRecord("2026-09-17T10:00:00Z", [
    { name: "feat/fresh", merged: { status: "no-commits", method: null, evidence: ["on origin/main first-parent history"] } },
    { name: "fix/old", merged: { status: "merged", method: "ancestry", evidence: ["ancestor"] } },
  ]);
  assert.throws(() => otherRecord("2026-09-17T10:00:00Z", [{ name: "x", merged: { status: "no-commits", method: "ancestry", evidence: [] } }]), /names its method/);
  const rows = branchRows([rec], { now, staleAfterDays: 7 });
  const fresh = rows.find((r) => r.name === "feat/fresh")!;
  assert.equal(fresh.action, "keep: no commits of its own; dirty worktree on other-box");
  const view = { machine: MACHINE, live: rec, records: [rec], config };
  assert.match(renderBranchTable(view, rows), /feat\/fresh\s+other-box\s+other-box \(dirty\)\s+never pushed\s+no commits\s+keep: no commits of its own/);
  assert.match(workspaceSummaryLine([rec], config, now)!, /2 branch\(es\), 1 deletable/);
});

// ---- MCP ----------------------------------------------------------------------------------

test("hunch_workspaces is a read-only everyday tool: this machine live, other machines from memory, both views, filters; hunch_now carries the ledger line", async (t) => {
  const { repo, env, cleanup } = fixture();
  const restore = setEnv({ ...env, HUNCH_PRIVATE_DIR: undefined });
  const seed = new HunchStore(hunchPaths(repo));
  try {
    seed.json.ensureDirs();
    // A forged record for THIS machine and a genuine one for another machine, both public.
    seed.json.put("workspaces", { ...otherRecord(new Date().toISOString(), [{ name: "main", merged: { status: "merged", method: "ancestry", evidence: ["forged"] } }]), id: workspaceId(MACHINE.id), machine: { id: MACHINE.id, label: MACHINE.label, platform: "linux" } });
    seed.json.put("workspaces", otherRecord(new Date().toISOString(), [{ name: "feat/theirs" }]));
  } finally { seed.close(); }
  const server = buildServer(repo);
  const [ct, st] = InMemoryTransport.createLinkedPair();
  const client = new Client({ name: "ledger-test", version: "1" });
  await Promise.all([server.connect(st), client.connect(ct)]);
  t.after(async () => { await client.close().catch(() => {}); await server.close().catch(() => {}); restore(); cleanup(); });

  const tools = (await client.listTools()).tools;
  const tool = tools.find((x) => x.name === "hunch_workspaces");
  assert.ok(tool, "registered in the everyday set");
  assert.match(tool.description ?? "", /Read-only/);
  assert.match(tool.description ?? "", /Not for /);

  const inventory = await client.callTool({ name: "hunch_workspaces", arguments: {} }) as { content: Array<{ type: string; text: string }>; structuredContent: { machine: string; worktrees: Array<{ machine: string; branch: string | null; path: string | null }> } };
  assert.equal(inventory.structuredContent.machine, "test-box");
  const mine = inventory.structuredContent.worktrees.find((w) => w.machine === "test-box")!;
  assert.equal(mine.branch, "main");
  assert.equal(slash(mine.path!), slash(repo), "this machine is live (its real path), not the forged stored record");
  assert.ok(inventory.structuredContent.worktrees.some((w) => w.machine === "other-box" && w.path === null));
  assert.match(inventory.content[0]!.text, /test-box \(this\)/);

  const branches = await client.callTool({ name: "hunch_workspaces", arguments: { view: "branches" } }) as { structuredContent: { branches: Array<{ name: string; merged: { status: string }; machines: string[]; action: string }> } };
  const main = branches.structuredContent.branches.find((b) => b.name === "main")!;
  assert.deepEqual(main.machines, ["test-box"], "this machine's forged stored record is never read");
  assert.equal(main.action, "keep: default branch");
  assert.ok(branches.structuredContent.branches.some((b) => b.name === "feat/theirs" && b.machines[0] === "other-box"));

  const filtered = await client.callTool({ name: "hunch_workspaces", arguments: { view: "branches", machine: "other-box" } }) as { structuredContent: { branches: Array<{ name: string }> } };
  assert.deepEqual(filtered.structuredContent.branches.map((b) => b.name), ["feat/theirs"]);
  const merged = await client.callTool({ name: "hunch_workspaces", arguments: { view: "branches", merged_only: true } }) as { structuredContent: { branches: unknown[] } };
  assert.equal(merged.structuredContent.branches.length, 0, "live git says nothing is merged; the forged verdict does not count");

  const now = await client.callTool({ name: "hunch_now", arguments: {} }) as { content: Array<{ text: string }> };
  assert.match(now.content[0]!.text, /🗂 Workspaces in memory: 2 machine\(s\)/);
});

test("a hunch_workspaces call publishes this machine's record (no timer, no child process); a server nobody asks never writes", async (t) => {
  const { repo, overlayRoot, env, cleanup } = fixture();
  const restore = setEnv({ ...env, HUNCH_PRIVATE_DIR: undefined });
  t.after(() => { restore(); cleanup(); });
  const file = join(overlayRoot, ".hunch", "workspaces", `${workspaceId(MACHINE.id)}.json`);

  // Merely building and closing a server writes nothing: no session-start timer exists, so a
  // long-running MCP session in an unrelated test can never have its overlay written under it
  // (and no detached child can outlive it and hold the clone directory open — the Windows
  // EBUSY that broke team-matrix-e2e's teardown).
  const idle = buildServerWithRootControl(repo);
  await new Promise((r) => setTimeout(r, 500));
  await idle.server.close().catch(() => {});
  assert.equal(existsSync(file), false);
  assert.equal(g(overlayRoot, "log", "-1", "--format=%s"), "overlay", "no commit from an unused session");

  const server = buildServer(repo);
  const [ct, st] = InMemoryTransport.createLinkedPair();
  const client = new Client({ name: "ledger-refresh", version: "1" });
  await Promise.all([server.connect(st), client.connect(ct)]);
  try {
    const res = await client.callTool({ name: "hunch_workspaces", arguments: {} }) as { structuredContent: { worktrees: Array<{ path: string | null }> } };
    assert.ok(res.structuredContent.worktrees.some((w) => w.path && slash(w.path) === slash(repo)), "the READ still shows this machine's real path");
    assert.ok(existsSync(file), "the call published this machine's record");
    const record = WorkspaceSchema.parse(JSON.parse(readFileSync(file, "utf8")));
    assert.equal(record.machine.label, "test-box");
    assert.equal(record.publish, "branches");
    assert.ok(record.worktrees.every((w) => w.path === null), "published under the configured publish mode, not the read's full paths");
    assert.match(g(overlayRoot, "log", "-1", "--format=%s"), /workspace snapshot test-box/, "committed through the ordinary capture funnel");

    // A second call is a no-op: unchanged content never commits again.
    await client.callTool({ name: "hunch_workspaces", arguments: { view: "branches" } });
    assert.equal(g(overlayRoot, "rev-list", "--count", "HEAD"), "2");
  } finally {
    await client.close().catch(() => {});
    await server.close().catch(() => {});
  }
});

test("HUNCH_WORKSPACE_REFRESH=0 makes a hunch_workspaces call read-only", async (t) => {
  const { repo, overlayRoot, env, cleanup } = fixture();
  const restore = setEnv({ ...env, HUNCH_PRIVATE_DIR: undefined, HUNCH_WORKSPACE_REFRESH: "0" });
  t.after(() => { restore(); cleanup(); });
  const server = buildServer(repo);
  const [ct, st] = InMemoryTransport.createLinkedPair();
  const client = new Client({ name: "ledger-optout", version: "1" });
  await Promise.all([server.connect(st), client.connect(ct)]);
  try {
    const res = await client.callTool({ name: "hunch_workspaces", arguments: {} }) as { structuredContent: { worktrees: unknown[] } };
    assert.ok(res.structuredContent.worktrees.length >= 1, "the read still works");
    assert.equal(existsSync(join(overlayRoot, ".hunch", "workspaces", `${workspaceId(MACHINE.id)}.json`)), false);
  } finally {
    await client.close().catch(() => {});
    await server.close().catch(() => {});
  }
});

// ---- scaffold, worktree, doctor, now ------------------------------------------------------

test("hunch init scaffolds /worktrees, which routes the agent to hunch_workspaces and never to git or a delete", () => {
  const root = mkdtempSync(join(tmpdir(), "hunch-ledger-scaffold-"));
  try {
    const { written } = writeSlashCommands(root);
    assert.ok(written.some((p) => p.endsWith("worktrees.md")));
    const body = readFileSync(join(root, ".claude", "commands", "worktrees.md"), "utf8");
    assert.match(body, /hunch_workspaces\(view: "branches"\)/);
    assert.match(body, /Do NOT run `git branch`/);
    assert.match(body, /You never delete a branch/);
    assert.match(body, /hunch:generated/);
  } finally { rmSync(root, { recursive: true, force: true }); }
});

test("CLI: hunch worktree records the new worktree; doctor and now report the ledger", { skip: process.platform === "win32" ? "sh launcher" : false }, () => {
  const { base, repo, overlayRoot, env, cleanup } = fixture();
  try {
    const wt = cli(repo, env, "worktree", join(base, "wt-feat"), "-b", "feat/from-cli", "--no-index");
    assert.equal(wt.status, 0, wt.stderr);
    assert.match(wt.stdout, /✓ workspace ledger updated \(2 worktree\(s\) on this machine → overlay\)/);
    const file = join(overlayRoot, ".hunch", "workspaces", `${workspaceId(MACHINE.id)}.json`);
    const record = WorkspaceSchema.parse(JSON.parse(readFileSync(file, "utf8")));
    assert.equal(record.worktrees.length, 2);
    assert.ok(record.branches.some((b) => b.name === "feat/from-cli" && b.worktree !== null));

    const doctor = cli(repo, env, "doctor");
    assert.match(doctor.stdout, /workspaces: this machine is test-box · record in memory: yes \(\S+\) · 0 other machine\(s\)/);
    assert.match(doctor.stdout, /post-checkout hook not installed \(`hunch index` adds it\)|hooks:\s+⚠ missing/);

    const now = cli(repo, env, "now", "--private");
    assert.match(now.stdout, /🗂 Workspaces in memory: 1 machine\(s\) · 2 worktree\(s\)/);
    const nowPublic = cli(repo, env, "now");
    assert.doesNotMatch(nowPublic.stdout, /Workspaces in memory/, "the public hot view never reads the overlay");
  } finally { cleanup(); }
});

test("workspaceLedgerView never includes this machine's stored record, even when it is the only one", () => {
  const { repo, env, cleanup } = fixture();
  try {
    withEnv({ ...env, HUNCH_PRIVATE_DIR: undefined }, () => {
      const store = new HunchStore(hunchPaths(repo));
      try {
        store.json.ensureDirs();
        store.json.put("workspaces", { ...otherRecord(new Date().toISOString(), [{ name: "phantom" }]), id: workspaceId(MACHINE.id), machine: { id: MACHINE.id, label: MACHINE.label, platform: "linux" } });
        const view = workspaceLedgerView(store, repo);
        assert.equal(view.records.length, 1);
        assert.equal(view.records[0], view.live);
        assert.equal(view.live.branches.some((b) => b.name === "phantom"), false);
      } finally { store.close(); }
    });
  } finally { cleanup(); }
});
