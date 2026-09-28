import { cleanupDir } from "./fixtures.js";
import { after, before, test } from "node:test";
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, statSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { prepareArm, prepareTaskBase, proveExposure, repoStateFingerprint } from "../src/benchmark/armIsolation.js";
import { buildMemorySnapshot, hashTree, type MemorySnapshot } from "../src/benchmark/memorySnapshot.js";

const CUTOFF = "2026-01-15T00:00:00Z";
const CLAUDE_HEAD = "# Project\n\nUser intro text.\n\n";
const CLAUDE_BLOCK = "<!-- HUNCH:START — auto-generated, do not edit by hand -->\n## Hunch\n- dec_aaaaaaaaaa\n<!-- HUNCH:END -->\n";
const CLAUDE_TAIL = "\nTrailing user text.\n";
const AGENTS_BLOCK = "<!-- HUNCH:START — auto-generated, do not edit by hand -->\r\nblock line\r\n<!-- HUNCH:END -->";
const AGENTS = `Agents intro\r\n\r\n${AGENTS_BLOCK}\r\n\r\nAgents tail\r\n`;
const STUB_BLOCK = "<!-- HUNCH:START — stub -->\nstub grounding\n<!-- HUNCH:END -->";

let root = "";
let source = "";
let overlay = "";
let emptyHooks = "";
const commits: Record<string, string> = {};

function git(cwd: string, args: string[], date?: string): string {
  return execFileSync("git", [
    "-c", "core.autocrlf=false", "-c", "user.name=Fixture", "-c", "user.email=fixture@example.invalid",
    "-c", "commit.gpgsign=false", "-c", `core.hooksPath=${emptyHooks}`, ...args,
  ], {
    cwd,
    encoding: "utf8",
    env: { ...process.env, ...(date ? { GIT_AUTHOR_DATE: date, GIT_COMMITTER_DATE: date } : {}) },
    windowsHide: true,
  }).trim();
}

function put(repo: string, rel: string, content: string): void {
  mkdirSync(dirname(join(repo, rel)), { recursive: true });
  writeFileSync(join(repo, rel), content);
}

function commit(repo: string, message: string, date: string): string {
  git(repo, ["add", "-A"]);
  git(repo, ["commit", "-q", "-m", message], date);
  return git(repo, ["rev-parse", "HEAD"]);
}

function listRel(dir: string, prefix = ""): string[] {
  return readdirSync(dir, { withFileTypes: true }).flatMap((e) => {
    const rel = prefix ? `${prefix}/${e.name}` : e.name;
    return e.isDirectory() ? listRel(join(dir, e.name), rel) : [rel];
  }).sort();
}

/** The stripped environment the runner would hand prepareArm. */
function childEnv(): Record<string, string> {
  return Object.fromEntries(Object.entries(process.env)
    .filter((kv): kv is [string, string] => kv[1] !== undefined && !/^(GIT_|HUNCH_)/i.test(kv[0])));
}

/** A stand-in for an audited Hunch build: only the dist entry points prepareArm uses.
 *  `indexWritesComponent` makes `index` add a file under .hunch/components/, as the real index may. */
function writeStubAudited(dir: string, opts: { indexWritesComponent?: boolean } = {}): void {
  put(dir, "package.json", JSON.stringify({ type: "module" }) + "\n");
  put(dir, "dist/integrations/scaffold.js", String.raw`import { mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
export function installClaudeHooks(root, cmd) {
  mkdirSync(join(root, ".claude"), { recursive: true });
  const entry = { hooks: [{ type: "command", command: cmd }] };
  const file = join(root, ".claude", "settings.json");
  writeFileSync(file, JSON.stringify({ hooks: { SessionStart: [entry], UserPromptSubmit: [entry], PreToolUse: [{ matcher: "Edit|Write|MultiEdit", ...entry }] } }, null, 2) + "\n");
  return { path: file, action: "created" };
}
export function writeSlashCommands(root) {
  mkdirSync(join(root, ".claude", "commands"), { recursive: true });
  writeFileSync(join(root, ".claude", "commands", "capture.md"), "Stub capture\n<!-- hunch:generated -->\n");
  return { written: [], skipped: [] };
}
`);
  put(dir, "dist/cli/index.js", String.raw`import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
const args = process.argv.slice(2).join(" ");
const BLOCK = "<!-- HUNCH:START — stub -->\nstub grounding\n<!-- HUNCH:END -->";
const END = "<!-- HUNCH:END -->";
if (args === "grounding --refresh") {
  const text = readFileSync("CLAUDE.md", "utf8");
  const start = text.indexOf("<!-- HUNCH:START");
  const end = text.indexOf(END);
  writeFileSync("CLAUDE.md", start === -1 ? text + BLOCK + "\n" : text.slice(0, start) + BLOCK + text.slice(end + END.length));
  process.exit(0);
}
if (args === "index") {
  if (!process.env.HUNCH_PRIVATE_DIR) process.exit(3);
  if (${opts.indexWritesComponent ? "true" : "false"}) {
    mkdirSync(".hunch/components", { recursive: true });
    writeFileSync(".hunch/components/cmp_stub.json", "{}\n");
  }
  process.exit(0);
}
if (args === "footprint --json") {
  process.stdout.write(JSON.stringify({ schema: "hunch.footprint/1", surfaces: [{ id: "mcp.tools_list", chars: 1234 }] }));
  process.exit(0);
}
process.exit(2);
`);
}

before(() => {
  root = mkdtempSync(join(tmpdir(), "hunch-task-bench-iso-"));
  emptyHooks = join(root, "fixture-hooks");
  mkdirSync(emptyHooks);
  source = join(root, "source");
  mkdirSync(source);
  git(source, ["init", "-q", "-b", "main"]);
  put(source, "src/a.ts", "export const a = 1;\n");
  put(source, "CLAUDE.md", CLAUDE_HEAD + CLAUDE_BLOCK + CLAUDE_TAIL);
  put(source, "AGENTS.md", AGENTS);
  put(source, ".claude/commands/capture.md", "Capture\n<!-- hunch:generated — refreshed by hunch init; delete this line to take ownership -->\n");
  put(source, ".claude/commands/mine.md", "My own command\n");
  // F1: user-owned surfaces with no hunch:generated marker but real Hunch content/name.
  put(source, ".claude/commands/heal.md", "Runs `hunch heal` and calls hunch_capture_decision.\n");
  put(source, ".cursor/rules/hunch.mdc", "---\ndescription: consult the hunch_* MCP tools\n---\nBody.\n");
  put(source, ".hunch/decisions/dec_aaaaaaaaaa.json", JSON.stringify({ id: "dec_aaaaaaaaaa", created_at: "2025-12-31T00:00:00Z" }) + "\n");
  put(source, ".hunch/decisions/dec_cccccccccc.json", JSON.stringify({ id: "dec_cccccccccc", created_at: "2026-03-01T00:00:00Z" }) + "\n");
  put(source, ".hunch/team.json", JSON.stringify({ url: "https://example.invalid/team" }) + "\n");
  commits.c1 = commit(source, "c1", "2026-01-01 00:00:00 +0000");
  put(source, "src/a.ts", "export const a = 2;\n");
  put(source, ".hunch/decisions/dec_bbbbbbbbbb.json", JSON.stringify({ id: "dec_bbbbbbbbbb", created_at: "2026-01-31T00:00:00Z" }) + "\n");
  commits.c2 = commit(source, "c2", "2026-02-01 00:00:00 +0000");
  put(source, ".hunch/config.json", JSON.stringify({ firmness: "advisory" }) + "\n");
  commits.c3 = commit(source, "c3", "2026-02-02 00:00:00 +0000");

  overlay = join(root, "overlay");
  mkdirSync(overlay);
  git(overlay, ["init", "-q", "-b", "main"]);
  put(overlay, ".hunch/findings/fnd_pppppppppp.json", JSON.stringify({ id: "fnd_pppppppppp", created_at: "2026-01-09T00:00:00Z" }) + "\n");
  commits.p1 = commit(overlay, "p1", "2026-01-10 00:00:00 +0000");
  put(overlay, ".hunch/findings/fnd_qqqqqqqqqq.json", JSON.stringify({ id: "fnd_qqqqqqqqqq", created_at: "2026-01-31T00:00:00Z" }) + "\n");
  commits.p2 = commit(overlay, "p2", "2026-02-01 00:00:00 +0000");
});

after(() => {
  if (root) cleanupDir(root);
});

test("prepareTaskBase rewrites the starting commit without .hunch history and reuses a passing proof", async () => {
  const dest = join(root, "bases", "task-1");
  const built = await prepareTaskBase({ sourceRepo: source, startingCommit: commits.c3!, dest });
  assert.equal(built.base, dest);
  assert.equal(built.proof.tree_equal, true);
  assert.equal(built.proof.hunch_history_empty, true);
  assert.match(built.proof.source_tree_sha256, /^[0-9a-f]{64}$/);
  assert.equal(git(dest, ["log", "--all", "--oneline", "--", ".hunch"]), "");
  assert.equal(existsSync(join(dest, ".hunch")), false);
  assert.equal(readFileSync(join(dest, "src", "a.ts"), "utf8"), "export const a = 2;\n");
  // c3 touched only .hunch/, so it disappears from the rewritten history.
  assert.equal(git(dest, ["rev-list", "--count", "HEAD"]), "2");
  assert.equal(git(dest, ["rev-parse", "HEAD"]), built.head);
  assert.equal(existsSync(`${dest}.src`), false);

  const proofPath = join(root, "bases", "task-1.proof.json");
  const proof = JSON.parse(readFileSync(proofPath, "utf8"));
  assert.equal(proof.starting_commit, commits.c3);
  assert.equal(proof.head, built.head);
  const mtime = statSync(proofPath).mtimeMs;
  const again = await prepareTaskBase({ sourceRepo: source, startingCommit: commits.c3!, dest });
  assert.deepEqual(again, built);
  assert.equal(statSync(proofPath).mtimeMs, mtime);

  // A starting commit that is not a branch tip is fetched by id.
  const older = await prepareTaskBase({ sourceRepo: source, startingCommit: commits.c2!, dest: join(root, "bases", "task-2") });
  assert.equal(older.proof.tree_equal, true);
  assert.equal(older.head, built.head, "same content and dates rewrite to the same head");
});

test("buildMemorySnapshot freezes cutoff-bounded public and private memory with a stable hash", () => {
  const opts = { sourceRepo: source, sourceRef: "main", startingCommit: commits.c3!, privateRepo: overlay, cutoffIso: CUTOFF };
  const first = buildMemorySnapshot({ ...opts, dest: join(root, "snapshots", "one") });
  const second = buildMemorySnapshot({ ...opts, dest: join(root, "snapshots", "two") });

  assert.equal(first.cutoff_at, CUTOFF);
  assert.equal(first.public.revision, commits.c1);
  assert.deepEqual(listRel(join(root, "snapshots", "one", "public")), ["decisions/dec_aaaaaaaaaa.json"]);
  assert.equal(first.public.files, 1);
  assert.equal(first.public.starting_commit, commits.c3);
  assert.deepEqual(first.public.sources, { "decisions/dec_aaaaaaaaaa.json": commits.c1 });
  assert.deepEqual(first.public.dropped.map((d) => d.path).sort(), [
    "config.json", "decisions/dec_bbbbbbbbbb.json", "decisions/dec_cccccccccc.json", "team.json",
  ]);
  assert.equal(
    first.public.dropped.find((d) => d.path === "decisions/dec_bbbbbbbbbb.json")?.reason,
    "no pre-cutoff commit reachable from the starting commit",
  );
  assert.equal(
    first.public.dropped.find((d) => d.path === "decisions/dec_cccccccccc.json")?.reason,
    "capture created_at=2026-03-01T00:00:00Z >= cutoff",
  );
  assert.equal(first.private?.revision, commits.p1);
  assert.deepEqual(listRel(join(root, "snapshots", "one", "private")), ["findings/fnd_pppppppppp.json"]);

  assert.equal(first.public.sha256, second.public.sha256);
  assert.equal(first.private?.sha256, second.private?.sha256);
  assert.equal(hashTree(join(root, "snapshots", "one", "public")).sha256, first.public.sha256);
  const recorded = JSON.parse(readFileSync(join(root, "snapshots", "one", "snapshot.json"), "utf8")) as MemorySnapshot;
  assert.deepEqual(recorded, first);
  assert.deepEqual(buildMemorySnapshot({ ...opts, dest: join(root, "snapshots", "one") }), first, "a matching frozen snapshot is reused");

  assert.throws(() => buildMemorySnapshot({ ...opts, cutoffIso: "2025-06-01T00:00:00Z", dest: join(root, "snapshots", "early") }), /no public memory revision/);
});

test("prepareArm no-hunch strips markers and generated commands and proves exposure", async () => {
  const base = await prepareTaskBase({ sourceRepo: source, startingCommit: commits.c3!, dest: join(root, "bases", "task-1") });
  const runDir = join(root, "runs", "no-hunch");
  const prepared = await prepareArm({ base: base.base, arm: "no-hunch", runDir, env: childEnv(), npmCi: false });

  assert.equal(prepared.exposure.ok, true, JSON.stringify(prepared.exposure.checks));
  assert.deepEqual(prepared.exposure.checks.map((c) => c.id), [
    "markers-absent", "generated-commands-absent", "hunch-dir-absent", "hunch-history-empty",
    "mcp-empty", "hooks-absent", "env-clean", "agent-surfaces-clean", "worktree-clean",
  ]);
  assert.equal(prepared.exposure.memory_snapshot_sha256, null);
  assert.equal(prepared.exposure.post_setup_hunch_sha256, null);
  assert.equal(readFileSync(join(prepared.repo, "CLAUDE.md"), "utf8"), "# Project\n\nUser intro text.\n\nTrailing user text.\n");
  assert.deepEqual(readFileSync(join(prepared.repo, "AGENTS.md")), Buffer.from("Agents intro\r\n\r\nAgents tail\r\n"));
  assert.equal(existsSync(join(prepared.repo, ".claude", "commands", "mine.md")), true);
  assert.equal(existsSync(join(prepared.repo, ".claude", "commands", "capture.md")), false);
  assert.equal(existsSync(join(prepared.repo, ".claude", "commands", "heal.md")), false, "unmarked but hunch-mentioning command is removed");
  assert.equal(existsSync(join(prepared.repo, ".cursor", "rules", "hunch.mdc")), false, "hunch-named cursor rule is removed");
  assert.equal(git(prepared.repo, ["status", "--porcelain"]), "");
  assert.equal(git(prepared.repo, ["log", "-1", "--format=%s"]), "bench: arm setup");
  assert.equal(git(prepared.repo, ["remote"]), "");
  assert.equal(git(prepared.repo, ["config", "--local", "--get", "core.hooksPath"]), join(runDir, "empty-hooks"));
  assert.deepEqual(JSON.parse(readFileSync(prepared.mcp_config_path, "utf8")), { mcpServers: {} });
  assert.deepEqual(prepared.env, {});
  assert.equal(prepared.static_hunch_chars.grounding_claude_md, 0);
  assert.equal(prepared.static_hunch_chars.grounding_agents_md, 0);
});

test("agent-surfaces-clean fails on a leftover hunch-matching file under an agent surface dir", () => {
  const repo = join(root, "surfaces-leftover");
  mkdirSync(join(repo, ".cursor", "rules"), { recursive: true });
  writeFileSync(join(repo, ".cursor", "rules", "hunch.mdc"), "---\ndescription: consult the hunch_* MCP tools\n---\n");
  git(repo, ["init", "-q", "-b", "main"]);
  const exposure = proveExposure({ arm: "no-hunch", repo, mcpConfigPath: join(root, "missing-mcp.json"), env: {} });
  const check = exposure.checks.find((c) => c.id === "agent-surfaces-clean");
  assert.equal(check?.ok, false);
  assert.match(check?.detail ?? "", /\.cursor\/rules\/hunch\.mdc/);
  assert.equal(exposure.ok, false);
});

const CURRENT_HUNCH_CHECKS = [
  "hunch-dir-present", "mcp-hunch-server", "repo-mcp-json-matches", "hooks-installed", "grounding-present", "worktree-clean",
  "snapshot-hash-match", "private-snapshot-hash-match", "footprint-tools-list",
];

/** prepareArm's snapshot option for a frozen snapshot under `dir`. */
function snapshotOption(dir: string, snapshot: MemorySnapshot) {
  return {
    publicDir: join(dir, "public"),
    privateDir: snapshot.private ? join(dir, "private") : null,
    publicSha256: snapshot.public.sha256,
    privateSha256: snapshot.private?.sha256 ?? null,
  };
}

test("prepareArm current-hunch mounts the snapshot through the audited dist and proves exposure", async () => {
  const base = await prepareTaskBase({ sourceRepo: source, startingCommit: commits.c3!, dest: join(root, "bases", "task-1") });
  const snapshotDir = join(root, "snapshots", "arm");
  const snapshot = buildMemorySnapshot({ sourceRepo: source, sourceRef: "main", startingCommit: commits.c3!, privateRepo: overlay, cutoffIso: CUTOFF, dest: snapshotDir });
  const audited = join(root, "audited");
  writeStubAudited(audited);
  const runDir = join(root, "runs", "current-hunch");
  const prepared = await prepareArm({
    base: base.base,
    arm: "current-hunch",
    runDir,
    nodePath: process.execPath,
    env: childEnv(),
    snapshot: snapshotOption(snapshotDir, snapshot),
    audited: { root: audited },
    npmCi: false,
  });

  assert.equal(prepared.exposure.ok, true, JSON.stringify(prepared.exposure.checks));
  assert.deepEqual(prepared.exposure.checks.map((c) => c.id), CURRENT_HUNCH_CHECKS);
  assert.equal(prepared.exposure.memory_snapshot_sha256, snapshot.public.sha256);
  assert.equal(prepared.exposure.post_setup_hunch_sha256, snapshot.public.sha256, "the stub index leaves .hunch untouched");
  assert.equal(git(prepared.repo, ["ls-files", ".hunch"]), ".hunch/decisions/dec_aaaaaaaaaa.json");

  const privateMount = join(runDir, "private", ".hunch");
  assert.deepEqual(prepared.env, { HUNCH_PRIVATE_DIR: privateMount });
  assert.deepEqual(listRel(privateMount), ["findings/fnd_pppppppppp.json"]);
  const auditedCli = join(audited, "dist", "cli", "index.js");
  const mcp = JSON.parse(readFileSync(prepared.mcp_config_path, "utf8"));
  assert.deepEqual(Object.keys(mcp.mcpServers), ["hunch"]);
  assert.equal(mcp.mcpServers.hunch.command, process.execPath);
  assert.deepEqual(mcp.mcpServers.hunch.args, [auditedCli, "mcp", "--root", prepared.repo]);
  assert.deepEqual(mcp.mcpServers.hunch.env, { HUNCH_PRIVATE_DIR: privateMount });

  const settings = JSON.parse(readFileSync(join(prepared.repo, ".claude", "settings.json"), "utf8"));
  assert.equal(settings.hooks.SessionStart[0].hooks[0].command, `"${process.execPath}" "${auditedCli}" hook`);
  assert.equal(prepared.static_hunch_chars.tools_list, 1234);
  assert.equal(prepared.static_hunch_chars.grounding_claude_md, [...STUB_BLOCK].length);
  assert.equal(prepared.static_hunch_chars.grounding_agents_md, [...AGENTS_BLOCK].length);
  assert.equal(git(prepared.repo, ["status", "--porcelain"]), "");
});

test("prepareArm current-hunch fails exposure when the frozen public snapshot was tampered with", async () => {
  const base = await prepareTaskBase({ sourceRepo: source, startingCommit: commits.c3!, dest: join(root, "bases", "task-1") });
  const snapshotDir = join(root, "snapshots", "tampered");
  const snapshot = buildMemorySnapshot({ sourceRepo: source, sourceRef: "main", startingCommit: commits.c3!, privateRepo: overlay, cutoffIso: CUTOFF, dest: snapshotDir });
  writeFileSync(join(snapshotDir, "public", "decisions", "dec_aaaaaaaaaa.json"), JSON.stringify({ id: "dec_aaaaaaaaaa", tampered: true }) + "\n");
  const audited = join(root, "audited-tampered");
  writeStubAudited(audited);
  const prepared = await prepareArm({
    base: base.base,
    arm: "current-hunch",
    runDir: join(root, "runs", "tampered"),
    nodePath: process.execPath,
    env: childEnv(),
    snapshot: snapshotOption(snapshotDir, snapshot),
    audited: { root: audited },
    npmCi: false,
  });

  assert.equal(prepared.exposure.ok, false);
  const failing = prepared.exposure.checks.filter((c) => !c.ok).map((c) => c.id);
  assert.deepEqual(failing, ["snapshot-hash-match"]);
});

test("prepareArm current-hunch checks the snapshot hash before index rewrites components/", async () => {
  const base = await prepareTaskBase({ sourceRepo: source, startingCommit: commits.c3!, dest: join(root, "bases", "task-1") });
  const snapshotDir = join(root, "snapshots", "indexed");
  const snapshot = buildMemorySnapshot({ sourceRepo: source, sourceRef: "main", startingCommit: commits.c3!, privateRepo: overlay, cutoffIso: CUTOFF, dest: snapshotDir });
  const audited = join(root, "audited-indexing");
  writeStubAudited(audited, { indexWritesComponent: true });
  const prepared = await prepareArm({
    base: base.base,
    arm: "current-hunch",
    runDir: join(root, "runs", "indexed"),
    nodePath: process.execPath,
    env: childEnv(),
    snapshot: snapshotOption(snapshotDir, snapshot),
    audited: { root: audited },
    npmCi: false,
  });

  assert.equal(prepared.exposure.ok, true, JSON.stringify(prepared.exposure.checks));
  assert.deepEqual(prepared.exposure.checks.map((c) => c.id), CURRENT_HUNCH_CHECKS);
  assert.equal(prepared.exposure.checks.find((c) => c.id === "snapshot-hash-match")?.ok, true);
  assert.equal(prepared.exposure.memory_snapshot_sha256, snapshot.public.sha256);
  assert.match(prepared.exposure.post_setup_hunch_sha256 ?? "", /^[0-9a-f]{64}$/);
  assert.notEqual(prepared.exposure.post_setup_hunch_sha256, prepared.exposure.memory_snapshot_sha256);
  assert.equal(git(prepared.repo, ["ls-files", ".hunch"]), ".hunch/components/cmp_stub.json\n.hunch/decisions/dec_aaaaaaaaaa.json");
});

test("repoStateFingerprint changes when a watched repository is written", () => {
  const notRepo = join(root, "not-a-repo");
  mkdirSync(notRepo, { recursive: true });
  const beforeWrite = repoStateFingerprint([source, notRepo]);
  assert.equal(beforeWrite[source]?.head, commits.c3);
  assert.equal(beforeWrite[source]?.status, "");
  assert.deepEqual(beforeWrite[notRepo], { head: null, status: null });
  writeFileSync(join(source, "stray.txt"), "written by a run\n");
  const afterWrite = repoStateFingerprint([source, notRepo]);
  assert.notDeepEqual(afterWrite, beforeWrite);
  assert.match(afterWrite[source]?.status ?? "", /stray\.txt/);
});
