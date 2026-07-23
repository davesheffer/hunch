import { test } from "node:test";
import assert from "node:assert/strict";
import { execFileSync, spawnSync } from "node:child_process";
import { devNull, tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { chmodSync, existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";

const PROJECT_ROOT = process.cwd();
const TSX = join(PROJECT_ROOT, "node_modules/tsx/dist/cli.mjs");
const CLI = join(PROJECT_ROOT, "src/cli/index.ts");

function isolatedEnv(extra: NodeJS.ProcessEnv = {}): NodeJS.ProcessEnv {
  const env: NodeJS.ProcessEnv = {
    ...process.env,
    GIT_CONFIG_NOSYSTEM: "1",
    GIT_CONFIG_GLOBAL: devNull,
    ...extra,
  };
  for (const key of [
    "GIT_ALTERNATE_OBJECT_DIRECTORIES", "GIT_CONFIG", "GIT_CONFIG_PARAMETERS", "GIT_CONFIG_COUNT",
    "GIT_OBJECT_DIRECTORY", "GIT_DIR", "GIT_WORK_TREE", "GIT_IMPLICIT_WORK_TREE", "GIT_GRAFT_FILE",
    "GIT_INDEX_FILE", "GIT_NO_REPLACE_OBJECTS", "GIT_REPLACE_REF_BASE", "GIT_PREFIX",
    "GIT_INTERNAL_SUPER_PREFIX", "GIT_SHALLOW_FILE", "GIT_COMMON_DIR",
  ]) delete env[key];
  return env;
}

function gitRaw(cwd: string, ...args: string[]): string {
  return execFileSync("git", args, {
    cwd,
    encoding: "utf8",
    env: isolatedEnv(),
    stdio: ["ignore", "pipe", "pipe"],
  });
}

function git(cwd: string, ...args: string[]): string {
  return gitRaw(cwd, ...args).trim();
}

function runCli(root: string, ...args: string[]) {
  return spawnSync(process.execPath, [TSX, CLI, ...args], {
    cwd: root,
    encoding: "utf8",
    env: isolatedEnv({
      HUNCH_PRIVATE_DIR: "",
      HUNCH_SYNTH_PROVIDER: "deterministic",
      NO_COLOR: "1",
    }),
    timeout: 20_000,
  });
}

function write(root: string, path: string, contents: string): void {
  const target = join(root, path);
  mkdirSync(dirname(target), { recursive: true });
  writeFileSync(target, contents);
}

function commit(root: string, message: string): string {
  git(root, "add", "-A");
  git(root, "commit", "-qm", message);
  return git(root, "rev-parse", "HEAD");
}

function decision(id: string, title: string): string {
  return `${JSON.stringify({
    id,
    title,
    topic: null,
    status: "accepted",
    context: "Git safety fixture",
    decision: title,
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
    provenance: { source: "human_confirmed", confidence: 1, evidence: [] },
    date: "2026-07-19T00:00:00.000Z",
  }, null, 2)}\n`;
}

const GROUNDING_START = "<!-- HUNCH:START — auto-generated, do not edit by hand -->";
const GROUNDING_END = "<!-- HUNCH:END -->";

function agentsDoc(userProse: string, managed: string): string {
  return [
    "# Team instructions",
    "",
    userProse,
    "",
    GROUNDING_START,
    managed,
    GROUNDING_END,
    "",
    "User-owned tail.",
    "",
  ].join("\n");
}

type RepoSnapshot = {
  head: string;
  tree: string;
  status: string;
  index: string;
  staged: string;
  unstaged: string;
  revertHead: boolean;
  bytes: Record<string, string | null>;
};

function snapshot(root: string, paths: string[]): RepoSnapshot {
  return {
    head: git(root, "rev-parse", "HEAD"),
    tree: git(root, "rev-parse", "HEAD^{tree}"),
    status: gitRaw(root, "status", "--porcelain=v1", "-z", "--untracked-files=all"),
    index: gitRaw(root, "ls-files", "--stage", "-z"),
    staged: gitRaw(root, "diff", "--cached", "--binary", "HEAD", "--"),
    unstaged: gitRaw(root, "diff", "--binary", "HEAD", "--"),
    revertHead: existsSync(join(root, ".git/REVERT_HEAD")),
    bytes: Object.fromEntries(paths.map((path) => {
      const target = join(root, path);
      return [path, existsSync(target) ? readFileSync(target).toString("base64") : null];
    })),
  };
}

function expectRefusal(root: string, sha: string, paths: string[]): void {
  const before = snapshot(root, paths);
  const result = sha.startsWith("-")
    ? runCli(root, "revert-move", "--", sha)
    : runCli(root, "revert-move", sha);
  const output = `${result.stdout ?? ""}${result.stderr ?? ""}`;
  assert.equal(result.status, 1, output);
  assert.match(output, /refused to revert/i);
  assert.match(output, /Nothing changed/i);
  assert.deepEqual(snapshot(root, paths), before, `refusing ${sha} must leave HEAD, index, and every observed byte unchanged`);
}

test("revert-move refuses unsafe commits without mutation, but reverts and publishes an append-only Hunch move", () => {
  const sandbox = mkdtempSync(join(tmpdir(), "hunch-revert-move-"));
  const root = join(sandbox, "repo");
  const remote = join(sandbox, "origin.git");
  const hooks = join(sandbox, "empty-hooks");
  const observed = [
    "src/app.ts",
    ".hunch/decisions/dec_a11ced.json",
    ".hunch/decisions/dec_51de00.json",
    ".hunch/decisions/dec_1a1000.json",
    ".hunch/decisions/dec_7ea000.json",
    ".hunch/decisions/dec_badd0c.json",
    ".hunch/decisions/dec_5afe00.json",
    ".hunch/team.json",
    ".hunch/manifest.json",
    "AGENTS.md",
    "scratch.txt",
  ];

  try {
    mkdirSync(root, { recursive: true });
    mkdirSync(hooks, { recursive: true });
    git(sandbox, "init", "--bare", "-q", "--initial-branch=main", remote);
    git(root, "init", "-q", "-b", "main");
    git(root, "config", "user.email", "revert-move@test.invalid");
    git(root, "config", "user.name", "Revert Move Test");
    git(root, "config", "commit.gpgsign", "false");
    git(root, "config", "core.hooksPath", hooks);
    git(root, "remote", "add", "origin", remote);

    write(root, "src/app.ts", "export const version = 1;\n");
    write(root, "AGENTS.md", agentsDoc("Keep this user prose byte-for-byte.", "old managed Hunch context"));
    commit(root, "fixture: base code");

    write(root, "src/app.ts", "export const version = 2;\n");
    const codeOnly = commit(root, "feat: code only");
    expectRefusal(root, codeOnly, observed);
    expectRefusal(root, "HEAD", observed);
    expectRefusal(root, "--no-edit", observed);

    write(root, "src/app.ts", "export const version = 3;\n");
    write(root, ".hunch/decisions/dec_a11ced.json", decision("dec_a11ced", "Mixed commits are unsafe"));
    const mixed = commit(root, "feat: code plus memory");
    expectRefusal(root, mixed, observed);

    write(root, ".hunch/decisions/dec_7ea000.json", decision("dec_7ea000", "Team routing is not a memory record"));
    write(root, ".hunch/team.json", "{\"repo\":\"https://attacker.invalid/memory.git\",\"ref\":\"refs/heads/main\"}\n");
    const teamRouting = commit(root, "hunch: memory plus team routing");
    expectRefusal(root, teamRouting, observed);

    write(root, ".hunch/decisions/dec_badd0c.json", decision("dec_badd0c", "Grounding cannot roll back user prose"));
    write(root, "AGENTS.md", agentsDoc("Changed outside Hunch's markers.", "unsafe managed refresh"));
    const unsafeGrounding = commit(root, "hunch: memory plus user-owned grounding bytes");
    expectRefusal(root, unsafeGrounding, observed);

    git(root, "branch", "memory-side");
    git(root, "switch", "-q", "memory-side");
    write(root, ".hunch/decisions/dec_51de00.json", decision("dec_51de00", "Side memory"));
    commit(root, "hunch: side memory");
    git(root, "switch", "-q", "main");
    write(root, ".hunch/decisions/dec_1a1000.json", decision("dec_1a1000", "Main memory"));
    commit(root, "hunch: main memory");
    git(root, "merge", "--no-ff", "-qm", "merge: memory branches", "memory-side");
    const merge = git(root, "rev-parse", "HEAD");
    assert.equal(git(root, "show", "-s", "--format=%P", merge).split(/\s+/).length, 2, "fixture is a merge commit");
    expectRefusal(root, merge, observed);

    const safeParentAgents = readFileSync(join(root, "AGENTS.md"));
    write(root, ".hunch/decisions/dec_5afe00.json", decision("dec_5afe00", "Safe append-only memory move"));
    write(root, ".hunch/manifest.json", "{\n  \"schema_version\": 2\n}\n");
    write(root, "AGENTS.md", agentsDoc("Changed outside Hunch's markers.", "safe managed refresh"));
    const safe = commit(root, "hunch: append safe memory and grounding");
    git(root, "push", "-qu", "origin", "main");

    write(root, "scratch.txt", "local work must survive a refusal\n");
    expectRefusal(root, safe, observed);
    rmSync(join(root, "scratch.txt"));

    const filterMarker = join(sandbox, "smudge-filter-ran");
    const infoAttributes = join(root, ".git/info/attributes");
    writeFileSync(infoAttributes, ".hunch/** filter=pwn\n");
    git(root, "config", "filter.pwn.clean", "cat");
    git(root, "config", "filter.pwn.smudge", `sh -c 'touch ${filterMarker}; cat'`);
    git(root, "config", "filter.pwn.required", "true");
    expectRefusal(root, safe, observed);
    assert.equal(existsSync(filterMarker), false, "revert validation must refuse content filters before Git can execute them");
    rmSync(infoAttributes);
    git(root, "config", "--unset-all", "filter.pwn.clean");
    git(root, "config", "--unset-all", "filter.pwn.smudge");
    git(root, "config", "--unset-all", "filter.pwn.required");

    // Adversarial ambient Git state must not change what was validated or run.
    // Without GIT_NO_REPLACE_OBJECTS, this makes `safe` behave like a code commit.
    git(root, "replace", safe, codeOnly);
    writeFileSync(join(hooks, "commit-msg"), "#!/bin/sh\nexit 91\n");
    chmodSync(join(hooks, "commit-msg"), 0o755);
    git(root, "config", "commit.gpgsign", "true");
    git(root, "config", "gpg.program", "false");

    const codeBefore = readFileSync(join(root, "src/app.ts"));
    const mixedBefore = readFileSync(join(root, ".hunch/decisions/dec_a11ced.json"));
    const result = runCli(root, "revert-move", safe);
    const output = `${result.stdout ?? ""}${result.stderr ?? ""}`;
    assert.equal(result.status, 0, output);
    assert.match(output, /reverted memory move/i);
    assert.notEqual(git(root, "rev-parse", "HEAD"), safe, "a successful undo creates a local revert commit");
    assert.equal(git(root, "rev-parse", "HEAD^"), safe, "the revert is based on the validated target at HEAD");
    assert.equal(gitRaw(root, "status", "--porcelain=v1", "-z", "--untracked-files=all"), "", "successful revert leaves a clean checkout");
    assert.equal(existsSync(join(root, ".hunch/decisions/dec_5afe00.json")), false);
    assert.equal(existsSync(join(root, ".hunch/manifest.json")), false);
    assert.deepEqual(readFileSync(join(root, "AGENTS.md")), safeParentAgents, "only the Hunch-managed region is rolled back");
    assert.deepEqual(readFileSync(join(root, "src/app.ts")), codeBefore, "the code graph is untouched");
    assert.deepEqual(readFileSync(join(root, ".hunch/decisions/dec_a11ced.json")), mixedBefore, "older memory is untouched");

    const pushed = runCli(root, "push");
    const pushOutput = `${pushed.stdout ?? ""}${pushed.stderr ?? ""}`;
    assert.equal(pushed.status, 0, pushOutput);
    assert.match(pushOutput, /pushed the current branch/i);
    assert.equal(git(sandbox, "--git-dir", remote, "rev-parse", "refs/heads/main"), git(root, "rev-parse", "HEAD"));
    const remoteTree = gitRaw(sandbox, "--git-dir", remote, "ls-tree", "-r", "--name-only", "refs/heads/main");
    assert.doesNotMatch(remoteTree, /^\.hunch\/decisions\/dec_5afe00\.json$/m);
    assert.doesNotMatch(remoteTree, /^\.hunch\/manifest\.json$/m);
    assert.match(remoteTree, /^AGENTS\.md$/m);
    assert.match(remoteTree, /^src\/app\.ts$/m);
    assert.match(remoteTree, /^\.hunch\/decisions\/dec_a11ced\.json$/m);
  } finally {
    rmSync(sandbox, { recursive: true, force: true });
  }
});
