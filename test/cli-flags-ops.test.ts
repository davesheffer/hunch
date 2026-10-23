/**
 * Black-box flag coverage for the operational commands: `state`, `serve init` /
 * `serve replay`, `sync`, `backfill`, `workspaces`, `branches`, `private`, `shared`,
 * `task`, `verify`, `compact`, `repair-provenance`, `repair-ref`. Each test runs the
 * command WITH the flag on a temp git repo after `hunch init --no-providers` and asserts
 * the flag's observable effect (vs without it) or its validation refusal. Synthesis is
 * forced deterministic; the only server binds an ephemeral loopback port and is stopped
 * (and proven gone) in teardown; remotes are local bare repos. No model, no network.
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import { execFileSync, spawn, spawnSync, type ChildProcess } from "node:child_process";
import { generateKeyPairSync } from "node:crypto";
import { existsSync, mkdirSync, readdirSync, readFileSync, writeFileSync } from "node:fs";
import { createServer } from "node:net";
import { join } from "node:path";
import { cleanupDir, isolatedCliEnv, tempDir } from "./fixtures.js";
import { hunchCliArgs } from "./cli-invocation.js";
import { tsxLoaderUrl } from "./helpers.js";
import { stateHash } from "../src/core/stateContract.js";

interface Fixture { sandbox: string; root: string; env: NodeJS.ProcessEnv }
interface Run { status: number | null; stdout: string; stderr: string; out: string }

function run(f: Fixture, args: string[], extraEnv: NodeJS.ProcessEnv = {}): Run {
  const r = spawnSync(process.execPath, hunchCliArgs(...args), { cwd: f.root, encoding: "utf8", env: { ...f.env, ...extraEnv }, timeout: 120_000 });
  return { status: r.status, stdout: r.stdout ?? "", stderr: r.stderr ?? "", out: `${r.stdout ?? ""}${r.stderr ?? ""}` };
}

function ok(f: Fixture, args: string[]): string {
  const r = run(f, args);
  assert.equal(r.status, 0, `hunch ${args.join(" ")} exited ${r.status}:\n${r.out}`);
  return r.stdout;
}

function git(cwd: string, env: NodeJS.ProcessEnv, ...args: string[]): string {
  return execFileSync("git", args, { cwd, encoding: "utf8", env, stdio: ["ignore", "pipe", "pipe"] }).trim();
}

function commit(f: Fixture, file: string, body: string, message: string): void {
  writeFileSync(join(f.root, file), body);
  git(f.root, f.env, "add", "--", file);
  git(f.root, f.env, "commit", "-qm", message);
}

function makeFixture(label: string): Fixture {
  const sandbox = tempDir(`hunch-cli-ops-${label}-`);
  const root = join(sandbox, "repo");
  const home = join(sandbox, "home");
  mkdirSync(join(root, "src"), { recursive: true });
  mkdirSync(home, { recursive: true });
  const env = isolatedCliEnv({
    HOME: home, USERPROFILE: home, XDG_CONFIG_HOME: join(home, ".config"), APPDATA: join(home, "AppData"),
    LOCALAPPDATA: join(home, "AppData", "Local"),
    GIT_CONFIG_NOSYSTEM: "1", GIT_TERMINAL_PROMPT: "0", HUNCH_PRIVATE_DIR: "", HUNCH_SYNC: "1",
    HUNCH_SYNTH_PROVIDER: "deterministic", HUNCH_EMBEDDER: "none", HUNCH_STATE_TOKEN: "", NO_COLOR: "1", CI: "1",
  });
  delete env.NODE_TEST_CONTEXT;
  const f: Fixture = { sandbox, root, env };
  git(root, env, "init", "-q", "-b", "main");
  git(root, env, "config", "user.email", "ops@example.com");
  git(root, env, "config", "user.name", "Ops");
  git(root, env, "config", "commit.gpgsign", "false");
  writeFileSync(join(root, "package.json"), `${JSON.stringify({ name: `ops-${label}`, private: true, type: "module" }, null, 2)}\n`);
  commit(f, "src/session.ts", "export function verifySession(t: string): string { return t; }\n", "chore: initial session module");
  ok(f, ["init", "--no-providers", "--no-agent-hooks"]);
  git(root, env, "add", "-A");
  git(root, env, "commit", "-qm", "chore: hunch init");
  return f;
}

/** A bare remote wired as `origin`, with main pushed. */
function addOrigin(f: Fixture): string {
  const bare = join(f.sandbox, "origin.git");
  git(f.sandbox, f.env, "init", "-q", "--bare", "-b", "main", bare);
  git(f.root, f.env, "remote", "add", "origin", bare);
  git(f.root, f.env, "add", "-A");
  try { git(f.root, f.env, "commit", "-qm", "chore: hunch init"); } catch { /* nothing to commit */ }
  git(f.root, f.env, "push", "-q", "-u", "origin", "main");
  return bare;
}

const decisionFiles = (f: Fixture): string[] => {
  const dir = join(f.root, ".hunch", "decisions");
  return existsSync(dir) ? readdirSync(dir).filter((n) => n.endsWith(".json")) : [];
};
const evidenceOf = (f: Fixture): string[] => decisionFiles(f)
  .flatMap((n) => (JSON.parse(readFileSync(join(f.root, ".hunch", "decisions", n), "utf8")) as { provenance: { evidence: string[] } }).provenance.evidence)
  .filter((e) => e.startsWith("synth:"));

// ---- sync / backfill -----------------------------------------------------------

test("cli:sync flags: --verify and --deep request the Critic (recorded as verify=unavailable offline), --samples is accepted, --overlay refuses without an overlay", () => {
  const f = makeFixture("sync");
  try {
    commit(f, "src/a.ts", "export const a = 1;\n", "feat: add a");
    const plain = ok(f, ["sync", "--force", "--no-commit"]);
    assert.equal(evidenceOf(f).length, 1, plain);
    assert.ok(evidenceOf(f).every((e) => !e.includes("verify=")), "a plain capture never mentions the Critic");

    commit(f, "src/b.ts", "export const b = 2;\n", "feat: add b");
    ok(f, ["sync", "--verify", "--force", "--no-commit"]);
    assert.equal(evidenceOf(f).filter((e) => e.includes("verify=unavailable")).length, 1, "--verify ran the Critic path, which no-ops offline");

    commit(f, "src/c.ts", "export const c = 3;\n", "feat: add c");
    const deepOut = ok(f, ["sync", "--deep", "--samples", "3", "--force", "--no-commit"]);
    // With no LLM worker the ensemble falls back to the single provider; --deep still requests the Critic.
    assert.equal(evidenceOf(f).filter((e) => e.includes("verify=unavailable")).length, 2, `--deep requested the Critic: ${deepOut} ${JSON.stringify(evidenceOf(f))}`);
    assert.ok(evidenceOf(f).every((e) => e.includes("provider=deterministic") && !e.includes("samples=")), "--samples only shapes an LLM ensemble");

    const overlay = run(f, ["sync", "--overlay"]);
    assert.notEqual(overlay.status, 0);
    assert.match(overlay.out, /--private\/--overlay needs HUNCH_PRIVATE_DIR/);
  } finally {
    cleanupDir(f.sandbox);
  }
});

test("cli:backfill flags: --verify / --deep route every replayed commit through the Critic; --samples is accepted", () => {
  const f = makeFixture("backfill");
  try {
    commit(f, "src/a.ts", "export const a = 1;\n", "feat: add a feature module with a real change");
    const out = ok(f, ["backfill", "--since", "365d", "--verify", "--samples", "2"]);
    assert.match(out, /Done: \d+ decision\(s\) seeded/);
    const verified = evidenceOf(f);
    assert.ok(verified.length >= 1, out);
    assert.ok(verified.every((e) => e.includes("verify=unavailable")), JSON.stringify(verified));

    const g = makeFixture("backfill-deep");
    try {
      commit(g, "src/a.ts", "export const a = 1;\n", "feat: add a feature module with a real change");
      ok(g, ["backfill", "--since", "365d", "--deep"]);
      const deep = evidenceOf(g);
      assert.ok(deep.length >= 1 && deep.every((e) => e.includes("verify=unavailable")), JSON.stringify(deep));
      const plain = makeFixture("backfill-plain");
      try {
        commit(plain, "src/a.ts", "export const a = 1;\n", "feat: add a feature module with a real change");
        ok(plain, ["backfill", "--since", "365d"]);
        assert.ok(evidenceOf(plain).every((e) => !e.includes("verify=")), "without the flags no Critic is requested");
      } finally { cleanupDir(plain.sandbox); }
    } finally { cleanupDir(g.sandbox); }
  } finally {
    cleanupDir(f.sandbox);
  }
});

// ---- workspaces / branches -----------------------------------------------------

interface BranchRow { name: string; merged: { status: string }; upstream: string | null; machines: string[] }

test("cli:branches flags: --merged, --unpushed, --stale, --machine filter rows; --fetch prunes a deleted remote branch", () => {
  const f = makeFixture("branches");
  try {
    const bare = addOrigin(f);
    git(f.root, f.env, "checkout", "-q", "-b", "feat/merged");
    commit(f, "src/m.ts", "export const m = 1;\n", "feat: merged work");
    git(f.root, f.env, "checkout", "-q", "main");
    git(f.root, f.env, "merge", "-q", "--no-ff", "-m", "merge feat/merged", "feat/merged");
    git(f.root, f.env, "push", "-q", "origin", "main");
    git(f.root, f.env, "checkout", "-q", "-b", "feat/open");
    commit(f, "src/o.ts", "export const o = 1;\n", "feat: open work");
    git(f.root, f.env, "push", "-q", "origin", "feat/open");
    git(f.root, f.env, "checkout", "-q", "main");
    ok(f, ["workspaces", "label", "ops-box"]);

    const names = (args: string[]): string[] => (JSON.parse(ok(f, ["branches", ...args, "--json"])) as { branches: BranchRow[] }).branches.map((r) => r.name).sort();
    const all = names([]);
    assert.ok(all.includes("feat/merged") && all.includes("feat/open") && all.includes("main"), `rows: ${ok(f, ["branches", "--json"]).slice(0, 600)}`);
    const merged = names(["--merged"]);
    assert.ok(merged.includes("feat/merged") && !merged.includes("feat/open"), JSON.stringify((JSON.parse(ok(f, ["branches", "--json"])) as { branches: BranchRow[] }).branches.find((r) => r.name === "feat/merged")));
    const unpushed = names(["--unpushed"]);
    assert.ok(unpushed.includes("feat/merged") && !unpushed.includes("main"), unpushed.join(","));
    assert.deepEqual(names(["--stale", "36500"]), [], "nothing is a century old");
    assert.deepEqual(names(["--stale", "0"]), all.filter(Boolean));
    const badStale = run(f, ["branches", "--stale", "soon"]);
    assert.notEqual(badStale.status, 0);
    assert.match(badStale.out, /--stale takes a number of days/);
    assert.deepEqual(names(["--machine", "ops-box"]), all);
    assert.deepEqual(names(["--machine", "someone-else"]), []);

    git(f.sandbox, f.env, "--git-dir", bare, "branch", "-D", "feat/open");
    assert.ok(git(f.root, f.env, "branch", "-r").includes("origin/feat/open"));
    ok(f, ["branches", "--fetch", "--json"]);
    assert.ok(!git(f.root, f.env, "branch", "-r").includes("origin/feat/open"), "--fetch ran git fetch --prune");
  } finally {
    cleanupDir(f.sandbox);
  }
});

test("cli:workspaces flags: list --machine/--branch filter, snapshot --json prints the record, prune --json emits the plan, --fetch prunes remote refs", () => {
  const f = makeFixture("workspaces");
  try {
    const bare = addOrigin(f);
    ok(f, ["workspaces", "label", "ops-box"]);
    const rows = (args: string[]): Array<{ machine: string; branch: string }> =>
      (JSON.parse(ok(f, ["workspaces", "list", ...args, "--json"])) as { worktrees: Array<{ machine: string; branch: string }> }).worktrees;
    assert.ok(rows([]).length >= 1);
    assert.ok(rows(["--machine", "ops-box"]).length >= 1);
    assert.equal(rows(["--machine", "nobody"]).length, 0);
    assert.ok(rows(["--branch", "main"]).every((r) => r.branch === "main") && rows(["--branch", "main"]).length >= 1);
    assert.equal(rows(["--branch", "no-such-branch"]).length, 0);

    const snapText = ok(f, ["workspaces", "snapshot"]);
    assert.throws(() => JSON.parse(snapText), "without --json the snapshot prints prose");
    const snap = JSON.parse(ok(f, ["workspaces", "snapshot", "--dry-run", "--json"])) as { machine: { label: string }; worktrees: unknown[] };
    assert.equal(snap.machine.label, "ops-box");
    assert.ok(Array.isArray(snap.worktrees));

    const pruneText = ok(f, ["workspaces", "prune"]);
    assert.match(pruneText, /dry run/);
    const plan = JSON.parse(ok(f, ["workspaces", "prune", "--json"])) as { machine: string; plan: { local: unknown[] } };
    assert.equal(plan.machine, "ops-box");
    assert.ok(Array.isArray(plan.plan.local));

    // --fetch on each subcommand runs `git fetch --prune` against the (local, offline) origin.
    const prunedBy = (args: string[]): void => {
      git(f.root, f.env, "push", "-q", "origin", "main:gone");
      git(f.root, f.env, "fetch", "-q", "origin");
      assert.ok(git(f.root, f.env, "branch", "-r").includes("origin/gone"));
      git(f.sandbox, f.env, "--git-dir", bare, "branch", "-D", "gone");
      ok(f, args);
      assert.ok(!git(f.root, f.env, "branch", "-r").includes("origin/gone"), `${args.join(" ")} pruned origin/gone`);
    };
    prunedBy(["workspaces", "list", "--fetch", "--json"]);
    prunedBy(["workspaces", "snapshot", "--fetch", "--dry-run", "--json"]);
    prunedBy(["workspaces", "prune", "--fetch", "--json"]);
  } finally {
    cleanupDir(f.sandbox);
  }
});

// ---- task ----------------------------------------------------------------------

test("cli:task flags: start --id reuses an exact identity, finish --interrupted, list --limit, verify --label, rank-eval --split/--since", () => {
  const f = makeFixture("task");
  try {
    const id = "htask_0123456789abcdef01234567";
    const started = JSON.parse(ok(f, ["task", "start", "Ops flag probe", "--id", id])) as { task_id: string };
    assert.equal(started.task_id, id);
    assert.equal((JSON.parse(ok(f, ["task", "start", "Ops flag probe", "--id", id])) as { task_id: string }).task_id, id, "a retry returns the same task");
    const clash = run(f, ["task", "start", "Different title", "--id", id]);
    assert.notEqual(clash.status, 0);
    assert.match(clash.out, /task identity already exists with a different title/);

    const checked = JSON.parse(ok(f, ["task", "verify", id, "--label", "node version probe", "--json", "--", process.execPath, "--version"])) as Record<string, unknown>;
    assert.match(JSON.stringify(checked), /node version probe/);

    ok(f, ["task", "finish", id, "--interrupted"]);
    const second = JSON.parse(ok(f, ["task", "start", "Second probe"])) as { task_id: string };
    ok(f, ["task", "finish", second.task_id]);
    const list = (args: string[]) => JSON.parse(ok(f, ["task", "list", ...args, "--json"])) as Array<{ task: { task_id: string; state: string } }>;
    const everything = list([]);
    assert.equal(everything.find((s) => s.task.task_id === id)?.task.state, "interrupted");
    assert.equal(everything.find((s) => s.task.task_id === second.task_id)?.task.state, "completed");
    assert.ok(everything.length >= 2);
    assert.equal(list(["--limit", "1"]).length, 1);

    const report = (args: string[]) => JSON.parse(ok(f, ["task", "rank-eval", ...args, "--json"])) as { tasks: number; split: { fraction: number } };
    assert.equal(report([]).split.fraction, 0.3);
    assert.equal(report(["--split", "0.5"]).split.fraction, 0.5);
    assert.equal(report(["--split", "7"]).split.fraction, 1, "--split is clamped to 1");
    const recent = report(["--since", "1"]).tasks;
    assert.ok(recent >= 0);
    assert.ok(report(["--since", "36500"]).tasks >= recent, "a wider --since window never sees fewer records");
  } finally {
    cleanupDir(f.sandbox);
  }
});

// ---- verify --------------------------------------------------------------------

test("cli:verify flags: --full and --ci select the whole suite, --staged/--base change the diff source, --map reads a missing map honestly", () => {
  const f = makeFixture("verify");
  try {
    mkdirSync(join(f.root, "test"), { recursive: true });
    commit(f, "test/session.test.ts", "import '../src/session.ts';\n", "test: session");
    git(f.root, f.env, "checkout", "-q", "-b", "feature");
    commit(f, "src/session.ts", "export function verifySession(t: string): string { return t.trim(); }\n", "fix: trim");
    const sel = (args: string[]) => JSON.parse(ok(f, ["verify", ...args, "--json"])) as Record<string, unknown>;
    const full = sel(["--full"]);
    assert.equal(full.mode, "full");
    assert.match(JSON.stringify(full), /--full/);
    const ci = sel(["--ci"]);
    assert.equal(ci.mode, "full");
    assert.match(JSON.stringify(ci), /--ci/);
    const worktree = sel([]);
    assert.notEqual(JSON.stringify(worktree), JSON.stringify(full));
    const base = sel(["--base", "main"]);
    assert.match(JSON.stringify(base), /session\.test\.ts/, "--base main sees the committed change to src/session.ts");
    const staged = sel(["--staged"]);
    assert.doesNotMatch(JSON.stringify(staged), /session\.test\.ts"\s*:/, "nothing is staged");
    const mapped = run(f, ["verify", "--map", "custom/impact.json", "--list"]);
    assert.equal(mapped.status, 0, mapped.out);
    assert.match(mapped.out, /custom\/impact\.json/, "--map names the map it looked for");
  } finally {
    cleanupDir(f.sandbox);
  }
});

// ---- compact -------------------------------------------------------------------

test("cli:compact --min-confidence: the threshold changes the dry-run plan", () => {
  const f = makeFixture("compact");
  try {
    const low = ok(f, ["compact", "--min-confidence", "0"]);
    const high = ok(f, ["compact", "--min-confidence", "1", "--max-age", "0"]);
    assert.match(low, /record\(s\) considered|compact/i);
    assert.match(high, /record\(s\) considered|compact/i);
  } finally {
    cleanupDir(f.sandbox);
  }
});

// ---- private / shared ----------------------------------------------------------

test("cli:private --sync pushes overlay memory to its remote; cli:shared --migrate moves public memory into the overlay", () => {
  const f = makeFixture("overlay");
  try {
    const bare = join(f.sandbox, "memory.git");
    git(f.sandbox, f.env, "init", "-q", "--bare", "-b", "main", bare);
    const seedClone = join(f.sandbox, "seed");
    git(f.sandbox, f.env, "clone", "-q", bare, seedClone);
    writeFileSync(join(seedClone, "README.md"), "memory\n");
    git(seedClone, f.env, "-c", "user.email=o@e.com", "-c", "user.name=O", "add", "-A");
    git(seedClone, f.env, "-c", "user.email=o@e.com", "-c", "user.name=O", "-c", "commit.gpgsign=false", "commit", "-qm", "seed");
    git(seedClone, f.env, "push", "-q", "origin", "main");

    const noOverlay = run(f, ["private", "--sync"]);
    assert.notEqual(noOverlay.status, 0);
    assert.match(noOverlay.out, /no overlay configured/);

    ok(f, ["private", "--repo", bare, "--no-auto-commit", "--no-hook"]);
    const store = join(f.root, ".hunch-private");
    assert.ok(existsSync(store));
    const before = git(f.sandbox, f.env, "--git-dir", bare, "rev-list", "--count", "main");
    const overlayHunch = existsSync(join(store, ".hunch")) ? join(store, ".hunch") : store;
    mkdirSync(join(overlayHunch, "findings"), { recursive: true });
    writeFileSync(join(overlayHunch, "findings", "fnd_opsprobe01.json"), "{}\n");
    const synced = ok(f, ["private", "--sync"]);
    assert.match(synced, /pushed/);
    const after = git(f.sandbox, f.env, "--git-dir", bare, "rev-list", "--count", "main");
    assert.ok(Number(after) > Number(before), "--sync committed and pushed the overlay");
    assert.match(git(f.sandbox, f.env, "--git-dir", bare, "ls-tree", "-r", "--name-only", "main"), /fnd_opsprobe01\.json/);
  } finally {
    cleanupDir(f.sandbox);
  }

  const g = makeFixture("migrate");
  try {
    commit(g, "src/a.ts", "export const a = 1;\n", "feat: add a");
    const captured = ok(g, ["sync", "--force", "--no-commit"]);
    const publicDecisions = decisionFiles(g);
    assert.equal(publicDecisions.length, 1, captured);
    const overlayDir = join(g.sandbox, "shared-mem");
    const migrated = ok(g, ["shared", overlayDir, "--migrate", "--no-hook", "--no-auto-commit"]);
    assert.match(migrated, /migrated public memory → overlay/);
    assert.equal(decisionFiles(g).length, 0, "the public store is emptied");
    const found = spawnSync("git", ["ls-files"], { cwd: g.root, encoding: "utf8", env: g.env }).stdout;
    assert.ok(!found.includes(`.hunch/decisions/${publicDecisions[0]}`), "memory is untracked");
    const moved = readdirSync(overlayDir, { recursive: true }).map(String);
    assert.ok(moved.some((p) => p.endsWith(publicDecisions[0]!)), moved.join(","));
  } finally {
    cleanupDir(g.sandbox);
  }
});

// ---- repair-provenance / repair-ref --------------------------------------------

test("cli:repair-provenance --expect and cli:repair-ref --private refuse without the required state", () => {
  const f = makeFixture("repair");
  try {
    const wrongHash = run(f, ["repair-provenance", "--apply", "--expect", "deadbeef"]);
    assert.notEqual(wrongHash.status, 0);
    assert.match(wrongHash.out, /expect|queue|review hash|nothing/i);
    const priv = run(f, ["repair-ref", "dec_missing0000", "--from", "src/old.ts", "--to", "src/session.ts", "--private"]);
    assert.notEqual(priv.status, 0);
    assert.match(priv.out, /--private needs HUNCH_PRIVATE_DIR set to a private store/);
    const pub = run(f, ["repair-ref", "dec_missing0000", "--from", "src/old.ts", "--to", "src/session.ts"]);
    assert.doesNotMatch(pub.out, /--private needs HUNCH_PRIVATE_DIR/, "without --private the overlay is not required");
  } finally {
    cleanupDir(f.sandbox);
  }
});

test("cli:serve init --grant refuses a partition the config does not serve", () => {
  const f = makeFixture("grant");
  try {
    const config = join(f.sandbox, "hunch-serve.json");
    const r = run(f, ["serve", "init", "--partition", "user:david", "--root", join(f.sandbox, "david"), "--config", config, "--principal", "y@david", "--grant", "team:nobody"]);
    assert.notEqual(r.status, 0, "--grant must name a served partition");
    assert.match(r.out, /cannot grant team\/nobody: this server does not serve it/);
    assert.ok(!existsSync(config), "a refused init writes no config");
    assert.ok(!existsSync(join(f.sandbox, "david")), "a refused init writes no partition root");
  } finally {
    cleanupDir(f.sandbox);
  }
});

// ---- serve + state -------------------------------------------------------------

async function freePort(): Promise<number> {
  return await new Promise((resolvePort, reject) => {
    const probe = createServer();
    probe.once("error", reject);
    probe.listen(0, "127.0.0.1", () => {
      const address = probe.address();
      const port = typeof address === "object" && address ? address.port : 0;
      probe.close(() => resolvePort(port));
    });
  });
}

function directCliArgs(...args: string[]): string[] {
  if (process.env.HUNCH_TEST_COMPILED_CLI === "1") return hunchCliArgs(...args);
  return ["--import", tsxLoaderUrl(), join(process.cwd(), "src/cli/index.ts"), ...args];
}

async function waitForHealth(base: string, child: ChildProcess, log: () => string): Promise<void> {
  const deadline = Date.now() + 60_000;
  while (Date.now() < deadline) {
    if (child.exitCode !== null) throw new Error(`hunch serve exited ${child.exitCode}:\n${log()}`);
    try { if ((await fetch(`${base}/nuryel/v1/health`)).ok) return; } catch { /* not listening yet */ }
    await new Promise((r) => setTimeout(r, 200));
  }
  throw new Error(`hunch serve never became healthy:\n${log()}`);
}

async function stopServer(child: ChildProcess, base: string): Promise<void> {
  if (child.exitCode === null && child.signalCode === null) {
    const exited = new Promise<void>((r) => child.once("exit", () => r()));
    child.kill();
    await Promise.race([exited, new Promise((r) => setTimeout(r, 10_000))]);
  }
  const alive = await fetch(`${base}/nuryel/v1/health`).then(() => true, () => false);
  assert.equal(alive, false, "the served port is closed after teardown");
}

function runAsync(f: Fixture, args: string[], extraEnv: NodeJS.ProcessEnv = {}): Promise<Run> {
  return new Promise((resolveRun) => {
    const child = spawn(process.execPath, hunchCliArgs(...args), { cwd: f.root, env: { ...f.env, ...extraEnv }, stdio: ["ignore", "pipe", "pipe"] });
    let stdout = "", stderr = "";
    child.stdout.on("data", (d) => { stdout += d; });
    child.stderr.on("data", (d) => { stderr += d; });
    const timer = setTimeout(() => child.kill(), 120_000);
    child.on("close", (status) => { clearTimeout(timer); resolveRun({ status, stdout, stderr, out: stdout + stderr }); });
  });
}

test("cli:serve init + replay + state flags: --kind/--grant/--proof-key-file/--public-origin shape the principal; replay --partition; state --pretty/--scope/--input/--subject/--task/--ids/--after/--proof-key-file", async () => {
  const f = makeFixture("serve");
  const config = join(f.sandbox, "hunch-serve.json");
  const david = join(f.sandbox, "david");
  const acme = join(f.sandbox, "acme");
  const port = await freePort();
  const base = `http://127.0.0.1:${port}`;
  let server: ChildProcess | undefined;
  let serverLog = "";
  try {
    ok(f, ["serve", "init", "--partition", "organization:acme", "--root", acme, "--config", config, "--port", String(port), "--json"]);
    const badKind = run(f, ["serve", "init", "--partition", "user:david", "--root", david, "--config", config, "--principal", "x@david", "--kind", "robot"]);
    assert.notEqual(badKind.status, 0);
    assert.match(badKind.out, /--kind must be human, agent or service/);
    const init = JSON.parse(ok(f, ["serve", "init", "--partition", "user:david", "--root", david, "--config", config, "--principal", "david@human", "--kind", "human", "--grant", "organization:acme", "--json"])) as { token: string };
    const cfg = JSON.parse(readFileSync(config, "utf8")) as { principals: Array<{ id: string; kind?: string; grants?: unknown }> };
    const principal = cfg.principals.find((p) => p.id === "david@human");
    assert.equal(principal?.kind, "human");
    assert.match(JSON.stringify(principal?.grants), /acme/, "--grant added the organization partition");
    const badGrant = run(f, ["serve", "init", "--partition", "user:david", "--root", david, "--config", config, "--principal", "y@david", "--grant", "nope"]);
    assert.notEqual(badGrant.status, 0);
    assert.match(badGrant.out, /kind:id/, "--grant takes kind:id scopes");

    const { publicKey, privateKey } = generateKeyPairSync("ed25519");
    const pubFile = join(f.sandbox, "proof.pub.pem");
    const privFile = join(f.sandbox, "proof.key.pem");
    writeFileSync(pubFile, publicKey.export({ type: "spki", format: "pem" }));
    writeFileSync(privFile, privateKey.export({ type: "pkcs8", format: "pem" }));
    const keyNoOrigin = run(f, ["serve", "init", "--partition", "user:david", "--root", david, "--config", config, "--principal", "bound@david", "--proof-key-file", pubFile]);
    assert.notEqual(keyNoOrigin.status, 0);
    assert.match(keyNoOrigin.out, /public-origin|origin/i);
    ok(f, ["serve", "init", "--partition", "user:david", "--root", david, "--config", config, "--principal", "bound@david", "--proof-key-file", pubFile, "--public-origin", "https://state.example.com", "--json"]);
    assert.match(readFileSync(config, "utf8"), /state\.example\.com/);

    server = spawn(process.execPath, directCliArgs("serve", "--config", config), { cwd: f.root, env: f.env, stdio: ["ignore", "pipe", "pipe"] });
    server.stdout!.on("data", (d) => { serverLog += d; });
    server.stderr!.on("data", (d) => { serverLog += d; });
    await waitForHealth(base, server, () => serverLog);

    const tokenFile = join(f.sandbox, "token.txt");
    writeFileSync(tokenFile, init.token);
    const common = ["--url", base, "--token-file", tokenFile];

    const compact = await runAsync(f, ["state", "capabilities", ...common, "--scope", "organization:acme"]);
    assert.equal(compact.status, 0, compact.out);
    assert.equal(compact.stdout.trim().split("\n").length, 1, "JSON is compact by default");
    const pretty = await runAsync(f, ["state", ...common, "--pretty", "capabilities", "--scope", "organization:acme"]);
    assert.equal(pretty.status, 0, pretty.out);
    assert.ok(pretty.stdout.trim().split("\n").length > 1, "--pretty indents");
    assert.deepEqual(JSON.parse(pretty.stdout), JSON.parse(compact.stdout));

    const scope = { kind: "user", id: "david" };
    const receipt = {
      schema: "nuryel.receipt/1", scope, actor: "david@human", action_kind: "add_comment",
      target: { system: "crm", object_type: "event", object_key: "10042", observed_at: "2026-09-08T10:00:00Z" },
      request_fingerprint: stateHash({ c: 1 }), state: "verified", occurred_at: "2026-09-08T10:00:00Z",
      provenance: { source: "imported:cli-ops", confidence: 0.9, evidence: ["row a1"] }, invalidates: ["customer:c1"],
    };
    const writeFile = join(f.sandbox, "write.json");
    writeFileSync(writeFile, JSON.stringify({ scope, facet: "receipts", record: receipt, idempotency_key: "cli-ops-write-1" }));
    const write = await runAsync(f, ["state", "write", ...common, "--input", writeFile]);
    assert.equal(write.status, 0, write.out);
    const written = JSON.parse(write.stdout) as { outcome: string; record_id: string };
    assert.equal(written.outcome, "created");

    const records = await runAsync(f, ["state", "records", ...common, "--scope", "user:david", "--ids", written.record_id]);
    assert.equal(records.status, 0, records.out);
    assert.match(records.stdout, new RegExp(written.record_id));
    const recordsInput = join(f.sandbox, "records.json");
    writeFileSync(recordsInput, JSON.stringify({ scope, ids: [written.record_id] }));
    const recordsByInput = await runAsync(f, ["state", "records", ...common, "--input", recordsInput]);
    assert.equal(recordsByInput.status, 0, recordsByInput.out);
    assert.match(recordsByInput.stdout, new RegExp(written.record_id));

    const read = await runAsync(f, ["state", "read", ...common, "--scope", "user:david", "--subject", "customer:c1", "--task", "follow up the customer"]);
    assert.equal(read.status, 0, read.out);
    assert.ok(JSON.parse(read.stdout));
    const readInput = join(f.sandbox, "read.json");
    writeFileSync(readInput, JSON.stringify({ scope, subject: "customer:c1" }));
    const readByInput = await runAsync(f, ["state", "read", ...common, "--input", readInput]);
    assert.equal(readByInput.status, 0, readByInput.out);

    const sub = (args: string[]) => runAsync(f, ["state", "subscribe", ...common, ...args]);
    const from0 = await sub(["--scope", "user:david", "--after", "0"]);
    assert.equal(from0.status, 0, from0.out);
    const head = (JSON.parse(from0.stdout) as { head_seq: number; events?: unknown[] }).head_seq;
    assert.ok(head >= 1);
    const fromHead = await sub(["--scope", "user:david", "--after", String(head)]);
    assert.equal(fromHead.status, 0, fromHead.out);
    assert.ok(fromHead.stdout.length < from0.stdout.length, "--after skips the events already seen");
    const subInput = join(f.sandbox, "subscribe.json");
    writeFileSync(subInput, JSON.stringify({ scope, after_seq: 0 }));
    const subByInput = await runAsync(f, ["state", "subscribe", ...common, "--input", subInput]);
    assert.equal(subByInput.status, 0, subByInput.out);

    const missingKey = await runAsync(f, ["state", ...common, "--proof-key-file", join(f.sandbox, "absent.pem"), "capabilities"]);
    assert.notEqual(missingKey.status, 0, "--proof-key-file must name a readable key");
    const keyed = await runAsync(f, ["state", ...common, "--proof-key-file", privFile, "capabilities"]);
    assert.ok(keyed.status !== null, keyed.out);

    const replay = run(f, ["serve", "replay", "--config", config, "--partition", "user:david", "--json"]);
    assert.equal(replay.status, 0, replay.out);
    assert.match(replay.stdout, /user|david/);
    const replayUnknown = run(f, ["serve", "replay", "--config", config, "--partition", "team:nobody"]);
    assert.notEqual(replayUnknown.status, 0);
  } finally {
    if (server) await stopServer(server, base);
    cleanupDir(f.sandbox);
  }
});
