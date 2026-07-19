import assert from "node:assert/strict";
import { execFileSync, spawnSync } from "node:child_process";
import {
  chmodSync,
  existsSync,
  lstatSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  readlinkSync,
  realpathSync,
  readdirSync,
  rmSync,
  symlinkSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join, relative } from "node:path";
import { test } from "node:test";

const PROJECT_ROOT = process.cwd();
const TSX = join(PROJECT_ROOT, "node_modules/tsx/dist/cli.mjs");
const CLI = join(PROJECT_ROOT, "src/cli/index.ts");

type CodeFixture = {
  root: string;
  remote: string;
  home: string;
  env: NodeJS.ProcessEnv;
};

function git(cwd: string, ...args: string[]): string {
  return execFileSync("git", args, {
    cwd,
    encoding: "utf8",
    env: { ...process.env, GIT_CONFIG_NOSYSTEM: "1", GIT_TERMINAL_PROMPT: "0" },
    stdio: ["ignore", "pipe", "pipe"],
  }).trim();
}

function configureRepo(root: string, name = "Team Test"): void {
  git(root, "config", "user.name", name);
  git(root, "config", "user.email", `${name.toLowerCase().replace(/[^a-z]+/g, "-")}@team.test`);
  git(root, "config", "commit.gpgsign", "false");
}

function actorEnv(home: string): NodeJS.ProcessEnv {
  mkdirSync(home, { recursive: true });
  return {
    ...process.env,
    HOME: home,
    USERPROFILE: home,
    XDG_CONFIG_HOME: join(home, ".config"),
    GIT_CONFIG_NOSYSTEM: "1",
    GIT_TERMINAL_PROMPT: "0",
    GIT_AUTHOR_NAME: "Team Test",
    GIT_AUTHOR_EMAIL: "team-test@team.test",
    GIT_COMMITTER_NAME: "Team Test",
    GIT_COMMITTER_EMAIL: "team-test@team.test",
    HUNCH_PRIVATE_DIR: "",
    HUNCH_SYNTH_PROVIDER: "deterministic",
    HUNCH_EMBEDDINGS: "off",
    NO_COLOR: "1",
    CI: "1",
  };
}

function runCli(fixture: Pick<CodeFixture, "root" | "env">, ...args: string[]) {
  return spawnSync(process.execPath, [TSX, CLI, ...args], {
    cwd: fixture.root,
    env: fixture.env,
    encoding: "utf8",
    timeout: 45_000,
    maxBuffer: 16 * 1024 * 1024,
  });
}

function runCliWithTimeout(
  fixture: Pick<CodeFixture, "root" | "env">,
  timeout: number,
  ...args: string[]
) {
  return spawnSync(process.execPath, [TSX, CLI, ...args], {
    cwd: fixture.root,
    env: fixture.env,
    encoding: "utf8",
    timeout,
    maxBuffer: 16 * 1024 * 1024,
  });
}

function output(run: ReturnType<typeof runCli>): string {
  return `${run.stdout ?? ""}${run.stderr ?? ""}`;
}

function expectCli(fixture: Pick<CodeFixture, "root" | "env">, args: string[], status: number): string {
  const run = runCli(fixture, ...args);
  assert.equal(run.error, undefined, run.error?.message);
  assert.equal(run.signal, null, output(run));
  assert.equal(run.status, status, output(run));
  return output(run);
}

function bareHead(remote: string): string {
  return execFileSync("git", ["--git-dir", remote, "rev-parse", "refs/heads/main"], {
    encoding: "utf8",
  }).trim();
}

function jsonSnapshot(root: string): Array<[string, string]> {
  const hunch = join(root, ".hunch");
  if (!existsSync(hunch)) return [];
  const files: Array<[string, string]> = [];
  const walk = (dir: string): void => {
    for (const name of readdirSync(dir).sort()) {
      const path = join(dir, name);
      const stat = lstatSync(path);
      if (stat.isDirectory()) walk(path);
      else if (name.endsWith(".json")) {
        files.push([
          relative(hunch, path),
          stat.isSymbolicLink() ? `symlink:${readlinkSync(path)}` : readFileSync(path).toString("base64"),
        ]);
      }
    }
  };
  walk(hunch);
  return files;
}

function makeCodeFixture(base: string, name: string, teamRepo?: string): CodeFixture {
  const seed = join(base, `${name}-seed`);
  const remote = join(base, `${name}.git`);
  const root = join(base, `${name}-checkout`);
  const home = join(base, `${name}-home`);
  mkdirSync(join(seed, "src"), { recursive: true });
  git(seed, "init", "-q", "-b", "main");
  configureRepo(seed, "Code Seed");
  writeFileSync(join(seed, ".gitignore"), [
    ".hunch/*.sqlite*",
    ".hunch/**/*.tmp*",
    ".hunch-cache/",
    ".hunch/local.json",
    ".hunch-private/",
    "",
  ].join("\n"));
  writeFileSync(join(seed, "package.json"), `${JSON.stringify({
    name: "tiny-team-fixture",
    private: true,
    type: "module",
    dependencies: { axios: "1.0.0" },
  }, null, 2)}\n`);
  writeFileSync(join(seed, "src/app.ts"), "export const transport = () => fetch('/orders');\n");
  if (teamRepo) {
    mkdirSync(join(seed, ".hunch"), { recursive: true });
    writeFileSync(join(seed, ".hunch/team.json"), `${JSON.stringify({ shared_repo: teamRepo }, null, 2)}\n`);
  }
  git(seed, "add", "-A");
  git(seed, "commit", "-qm", "fixture: tiny code repository");
  git(base, "clone", "-q", "--bare", seed, remote);
  git(base, "clone", "-q", remote, root);
  configureRepo(root, name);
  return { root, remote, home, env: actorEnv(home) };
}

function cloneCodeActor(base: string, remote: string, name: string): CodeFixture {
  const root = join(base, `${name}-checkout`);
  const home = join(base, `${name}-home`);
  git(base, "clone", "-q", remote, root);
  configureRepo(root, name);
  return { root, remote, home, env: actorEnv(home) };
}

function makeMemoryRemote(
  base: string,
  name: string,
  populate: (seed: string) => void = (seed) => writeFileSync(join(seed, "README.md"), "# Team memory\n"),
): string {
  const seed = join(base, `${name}-seed`);
  const remote = join(base, `${name}.git`);
  mkdirSync(seed, { recursive: true });
  git(seed, "init", "-q", "-b", "main");
  configureRepo(seed, "Memory Seed");
  populate(seed);
  git(seed, "add", "-A");
  git(seed, "commit", "-qm", "fixture: memory baseline");
  git(base, "clone", "-q", "--bare", seed, remote);
  return remote;
}

function makeLocalOverlay(root: string): string {
  const overlay = join(root, ".hunch-private");
  mkdirSync(overlay, { recursive: true });
  git(overlay, "init", "-q", "-b", "main");
  configureRepo(overlay, "Local Memory");
  writeFileSync(join(overlay, "LOCAL.md"), "local memory baseline\n");
  git(overlay, "add", "-A");
  git(overlay, "commit", "-qm", "fixture: local overlay baseline");
  return overlay;
}

type MismatchedTeamFixture = {
  code: CodeFixture;
  memoryA: string;
  memoryB: string;
  overlay: string;
  rule: string;
};

function makeMismatchedTeamFixture(base: string, name: string): MismatchedTeamFixture {
  const memoryA = makeMemoryRemote(base, `${name}-memory-a`);
  const memoryB = makeMemoryRemote(base, `${name}-memory-b`);
  const code = makeCodeFixture(base, `${name}-code`);
  expectCli(code, ["shared", "--repo", memoryA, "--no-hook"], 0);
  expectCli(code, ["shared", "--sync"], 0);
  const rule = "REMOTE_A_ONLY_RULE: never import axios in src/app.ts";
  const recorded = expectCli(code, [
    "record-constraint", rule,
    "--scope", "src/app.ts",
    "--severity", "blocking",
    "--forbid-dep", "axios",
  ], 0);
  assert.match(recorded, /private memory committed \+ pushed/, recorded);

  // Simulate a branch/checkout that now advertises the team's replacement memory
  // remote while this machine still has yesterday's healthy shared pointer.
  writeFileSync(join(code.root, ".hunch/team.json"), `${JSON.stringify({ shared_repo: memoryB }, null, 2)}\n`);
  git(code.root, "add", ".gitignore", ".hunch/team.json");
  git(code.root, "commit", "-qm", "chore: switch advertised team memory");
  git(code.root, "push", "-q", "origin", "main");
  const overlay = join(code.root, ".hunch-private");
  assert.equal(realpathSync(git(overlay, "remote", "get-url", "origin")), realpathSync(memoryA),
    "fixture retains the old local overlay remote");
  return { code, memoryA, memoryB, overlay, rule };
}

test("strict CLI checks fail closed when committed team memory cannot be cloned", { timeout: 60_000 }, () => {
  const base = mkdtempSync(join(tmpdir(), "hunch-team-unavailable-read-"));
  try {
    const unavailable = join(base, "missing-memory.git");
    const code = makeCodeFixture(base, "unavailable-read", unavailable);
    writeFileSync(join(code.root, "src/app.ts"), "export const transport = () => 'changed';\n");
    const publicJsonBefore = jsonSnapshot(code.root);
    const statusBefore = git(code.root, "status", "--porcelain=v1", "--untracked-files=all");
    const codeHeadBefore = git(code.root, "rev-parse", "HEAD");
    const codeRemoteBefore = bareHead(code.remote);

    const result = runCli(code, "check", "--working", "--strict");
    const text = output(result);
    assert.equal(result.status, 1, text);
    assert.match(text, /team|shared|memory|overlay/i, "the failure must identify the unavailable team-memory boundary");
    const mcp = runCli(code, "mcp");
    const mcpText = output(mcp);
    assert.equal(mcp.status, 1, mcpText);
    assert.match(mcpText, /team|shared|memory|overlay/i,
      "MCP must refuse the same unavailable team-memory boundary before serving tools");
    assert.doesNotMatch(mcpText, /serving Hunch/, "MCP never starts on the public fallback graph");
    assert.deepEqual(jsonSnapshot(code.root), publicJsonBefore, "a failed strict read never creates public JSON memory");
    assert.equal(existsSync(join(code.root, ".hunch/local.json")), false, "no false public/shared pointer is installed");
    assert.equal(git(code.root, "status", "--porcelain=v1", "--untracked-files=all"), statusBefore);
    assert.equal(git(code.root, "rev-parse", "HEAD"), codeHeadBefore);
    assert.equal(bareHead(code.remote), codeRemoteBefore, "a failed memory read never advances code history");
  } finally {
    rmSync(base, { recursive: true, force: true });
  }
});

test("the first CLI write cannot fall back to public .hunch when committed team memory is unavailable", { timeout: 60_000 }, () => {
  const base = mkdtempSync(join(tmpdir(), "hunch-team-unavailable-write-"));
  try {
    const unavailable = join(base, "missing-memory.git");
    const code = makeCodeFixture(base, "unavailable-write", unavailable);
    const sentinel = "TEAM_UNAVAILABLE_WRITE_MUST_NOT_BECOME_PUBLIC";
    const publicJsonBefore = jsonSnapshot(code.root);
    const statusBefore = git(code.root, "status", "--porcelain=v1", "--untracked-files=all");
    const codeHeadBefore = git(code.root, "rev-parse", "HEAD");
    const codeRemoteBefore = bareHead(code.remote);

    const result = runCli(
      code,
      "record-constraint",
      sentinel,
      "--scope", "src/**",
      "--severity", "blocking",
      "--forbid-symbol", "eval",
    );
    const text = output(result);
    assert.equal(result.status, 1, text);
    assert.match(text, /team|shared|memory|overlay/i, "the write refusal must identify the unavailable team-memory boundary");
    assert.deepEqual(jsonSnapshot(code.root), publicJsonBefore, "the refused team record never lands in public JSON");
    assert.doesNotMatch(
      jsonSnapshot(code.root).map(([, bytes]) => bytes).join("\n"),
      new RegExp(sentinel),
      "the sensitive team rule is absent from public memory",
    );
    assert.equal(existsSync(join(code.root, ".hunch/local.json")), false);
    assert.equal(git(code.root, "status", "--porcelain=v1", "--untracked-files=all"), statusBefore);
    assert.equal(git(code.root, "rev-parse", "HEAD"), codeHeadBefore, "no public memory commit is created");
    assert.equal(bareHead(code.remote), codeRemoteBefore, "the code remote remains byte-for-byte at its original commit");
  } finally {
    rmSync(base, { recursive: true, force: true });
  }
});

test("an existing shared-overlay CLI check refreshes a teammate's new blocking correction without MCP or explicit sync", { timeout: 90_000 }, () => {
  const base = mkdtempSync(join(tmpdir(), "hunch-team-cli-refresh-"));
  try {
    const memoryRemote = makeMemoryRemote(base, "refresh-memory");
    const developer = makeCodeFixture(base, "refresh-code");
    expectCli(developer, ["shared", "--repo", memoryRemote, "--no-hook"], 0);
    expectCli(developer, ["shared", "--sync"], 0);
    git(developer.root, "add", ".gitignore", ".hunch/team.json");
    git(developer.root, "commit", "-qm", "chore: advertise shared team memory");
    git(developer.root, "push", "-q", "origin", "main");

    const developerOverlay = join(developer.root, ".hunch-private");
    const staleOverlayHead = git(developerOverlay, "rev-parse", "HEAD");
    const codeHeadBefore = git(developer.root, "rev-parse", "HEAD");
    const codeRemoteBefore = bareHead(developer.remote);
    const teammate = cloneCodeActor(base, developer.remote, "teammate");
    const rule = "TEAM_LIVE_REFRESH_RULE: never import axios in src/app.ts";
    const recorded = expectCli(teammate, [
      "record-constraint", rule,
      "--scope", "src/app.ts",
      "--severity", "blocking",
      "--forbid-dep", "axios",
    ], 0);
    const teammateOverlay = join(teammate.root, ".hunch-private");
    const teammateDiagnostic = [
      recorded,
      `pointer=${existsSync(join(teammate.root, ".hunch/local.json")) ? readFileSync(join(teammate.root, ".hunch/local.json"), "utf8") : "missing"}`,
      `overlay-status=${existsSync(teammateOverlay) ? git(teammateOverlay, "status", "--porcelain=v1", "--untracked-files=all") : "missing"}`,
      `overlay-log=${existsSync(teammateOverlay) ? git(teammateOverlay, "log", "--oneline", "-3") : "missing"}`,
    ].join("\n");
    assert.match(recorded, /private memory committed \+ pushed/,
      `the teammate correction must be durable before testing refresh:\n${teammateDiagnostic}`);
    const constraintId = recorded.match(/constraint (con_[A-Za-z0-9_-]+)/)?.[1];
    assert.ok(constraintId, recorded);
    const remoteMemoryHead = bareHead(memoryRemote);
    assert.notEqual(remoteMemoryHead, staleOverlayHead, "the teammate really advanced the memory remote");

    writeFileSync(join(developer.root, "src/app.ts"), [
      'import axios from "axios";',
      "export const transport = () => axios.get('/orders');",
      "",
    ].join("\n"));
    const checked = expectCli(developer, ["check", "--working", "--strict"], 1);
    assert.match(checked, new RegExp(constraintId));
    assert.match(checked, /TEAM_LIVE_REFRESH_RULE/);
    assert.equal(git(developerOverlay, "rev-parse", "HEAD"), remoteMemoryHead,
      "the ordinary CLI boundary refreshed the already-configured overlay");
    assert.equal(git(developer.root, "rev-parse", "HEAD"), codeHeadBefore);
    assert.equal(bareHead(developer.remote), codeRemoteBefore, "memory refresh never advances the code remote");
    assert.equal(git(developer.root, "diff", "--cached", "--name-only"), "", "a read-only check stages no code or memory");
  } finally {
    rmSync(base, { recursive: true, force: true });
  }
});

test("explicit shared setup rejects an unsafe cloned overlay before integration writes", { timeout: 60_000 }, () => {
  const base = mkdtempSync(join(tmpdir(), "hunch-shared-unsafe-clone-"));
  try {
    const victim = join(base, "outside.txt");
    const victimBytes = "external bytes must remain exact\n";
    writeFileSync(victim, victimBytes);
    const memoryRemote = makeMemoryRemote(base, "unsafe-clone-memory", (seed) => {
      mkdirSync(join(seed, ".hunch"), { recursive: true });
      writeFileSync(join(seed, ".hunch/seed.json"), "{\"seed\":true}\n");
      symlinkSync(victim, join(seed, ".gitignore"));
    });
    const code = makeCodeFixture(base, "unsafe-clone-code");
    const codeHeadBefore = git(code.root, "rev-parse", "HEAD");
    const codeRemoteBefore = bareHead(code.remote);
    const codeStatusBefore = git(code.root, "status", "--porcelain=v1", "--untracked-files=all");

    const result = runCli(code, "shared", "--repo", memoryRemote, "--no-hook");
    const text = output(result);
    assert.equal(result.status, 1, text);
    assert.match(text, /unsafe|refus/i);
    assert.equal(readFileSync(victim, "utf8"), victimBytes, "no integration writer follows the remote symlink");
    assert.equal(existsSync(join(code.root, ".hunch/local.json")), false);
    assert.equal(existsSync(join(code.root, ".hunch/team.json")), false);
    const overlay = join(code.root, ".hunch-private");
    if (existsSync(overlay)) {
      assert.equal(git(overlay, "status", "--porcelain=v1", "--untracked-files=all"), "",
        "the rejected clone remains an exact checkout with no Hunch integration writes");
      assert.equal(existsSync(join(overlay, ".gitattributes")), false);
      const driver = spawnSync("git", ["-C", overlay, "config", "--get", "merge.hunch.driver"], { encoding: "utf8" });
      assert.notEqual(driver.status, 0, "no merge driver is installed into an untrusted checkout");
    }
    assert.equal(git(code.root, "status", "--porcelain=v1", "--untracked-files=all"), codeStatusBefore);
    assert.equal(git(code.root, "rev-parse", "HEAD"), codeHeadBefore);
    assert.equal(bareHead(code.remote), codeRemoteBefore);
  } finally {
    rmSync(base, { recursive: true, force: true });
  }
});

test("explicit shared attach rejects an unsafe fetched tree before merge or integration writes", { timeout: 60_000 }, () => {
  const base = mkdtempSync(join(tmpdir(), "hunch-shared-unsafe-fetch-"));
  try {
    const victim = join(base, "outside.json");
    const victimBytes = "outside must not be read or rewritten\n";
    writeFileSync(victim, victimBytes);
    const memoryRemote = makeMemoryRemote(base, "unsafe-fetch-memory", (seed) => {
      mkdirSync(join(seed, ".hunch/decisions"), { recursive: true });
      symlinkSync(victim, join(seed, ".hunch/decisions/dec_escape.json"));
      writeFileSync(join(seed, "REMOTE.md"), "unsafe remote tree\n");
    });
    const code = makeCodeFixture(base, "unsafe-fetch-code");
    const overlay = makeLocalOverlay(code.root);
    const overlayHeadBefore = git(overlay, "rev-parse", "HEAD");
    const overlayStatusBefore = git(overlay, "status", "--porcelain=v1", "--untracked-files=all");
    const codeHeadBefore = git(code.root, "rev-parse", "HEAD");
    const codeRemoteBefore = bareHead(code.remote);

    const result = runCli(code, "shared", "--repo", memoryRemote, "--no-hook");
    const text = output(result);
    assert.equal(result.status, 1, text);
    assert.match(text, /unsafe|refus/i);
    assert.equal(readFileSync(victim, "utf8"), victimBytes);
    assert.equal(git(overlay, "rev-parse", "HEAD"), overlayHeadBefore, "the fetched unsafe OID never reaches HEAD");
    assert.equal(git(overlay, "status", "--porcelain=v1", "--untracked-files=all"), overlayStatusBefore,
      "the checked-out overlay and integration files remain exact");
    assert.equal(existsSync(join(overlay, ".hunch/decisions/dec_escape.json")), false);
    assert.equal(existsSync(join(overlay, ".gitattributes")), false);
    assert.equal(existsSync(join(code.root, ".hunch/local.json")), false);
    assert.equal(existsSync(join(code.root, ".hunch/team.json")), false);
    assert.equal(git(code.root, "rev-parse", "HEAD"), codeHeadBefore);
    assert.equal(bareHead(code.remote), codeRemoteBefore);
  } finally {
    rmSync(base, { recursive: true, force: true });
  }
});

test("existing shared attach merges safely without executing repository post-merge hooks", { timeout: 60_000 }, () => {
  const base = mkdtempSync(join(tmpdir(), "hunch-shared-attach-hooks-"));
  try {
    const memoryRemote = makeMemoryRemote(base, "attach-hook-memory", (seed) => {
      mkdirSync(join(seed, ".hunch/decisions"), { recursive: true });
      writeFileSync(join(seed, ".hunch/decisions/dec_remote.json"), "{\"id\":\"dec_remote\",\"safe\":true}\n");
      writeFileSync(join(seed, "REMOTE.md"), "safe remote memory\n");
    });
    const code = makeCodeFixture(base, "attach-hook-code");
    const overlay = makeLocalOverlay(code.root);
    const marker = join(base, "post-merge-ran");
    const hook = join(overlay, ".git/hooks/post-merge");
    writeFileSync(hook, `#!/bin/sh\n: > ${JSON.stringify(marker)}\n`);
    chmodSync(hook, 0o755);
    const codeHeadBefore = git(code.root, "rev-parse", "HEAD");
    const codeRemoteBefore = bareHead(code.remote);

    const result = runCli(code, "shared", "--repo", memoryRemote, "--no-hook");
    const text = output(result);
    assert.equal(result.status, 0, text);
    assert.equal(existsSync(marker), false, "machine-driven attachment must disable repository hooks");
    assert.equal(existsSync(join(overlay, ".hunch/decisions/dec_remote.json")), true,
      "the safe fetched memory still converges into the local overlay");
    assert.equal(existsSync(join(code.root, ".hunch/local.json")), true);
    assert.equal(existsSync(join(code.root, ".hunch/team.json")), true);
    assert.equal(git(code.root, "rev-parse", "HEAD"), codeHeadBefore);
    assert.equal(bareHead(code.remote), codeRemoteBefore, "setup never pushes or commits the code repository");
  } finally {
    rmSync(base, { recursive: true, force: true });
  }
});

test("strict CLI refuses an existing shared overlay whose remote differs from committed team.json", { timeout: 90_000 }, () => {
  const base = mkdtempSync(join(tmpdir(), "hunch-team-remote-mismatch-cli-"));
  try {
    const fixture = makeMismatchedTeamFixture(base, "mismatch-cli");
    writeFileSync(join(fixture.code.root, "src/app.ts"), [
      'import axios from "axios";',
      "export const transport = () => axios.get('/orders');",
      "",
    ].join("\n"));
    const codeHeadBefore = git(fixture.code.root, "rev-parse", "HEAD");
    const codeRemoteBefore = bareHead(fixture.code.remote);
    const memoryABefore = bareHead(fixture.memoryA);
    const memoryBBefore = bareHead(fixture.memoryB);
    const overlayHeadBefore = git(fixture.overlay, "rev-parse", "HEAD");
    const publicJsonBefore = jsonSnapshot(fixture.code.root);
    const statusBefore = git(fixture.code.root, "status", "--porcelain=v1", "--untracked-files=all");

    const result = runCli(fixture.code, "check", "--working", "--strict");
    const text = output(result);
    assert.equal(result.error, undefined, result.error?.message);
    assert.equal(result.status, 1, text);
    assert.doesNotMatch(text, /REMOTE_A_ONLY_RULE/,
      "the strict gate must reject remote-identity drift before evaluating stale overlay A");
    assert.match(text, /team\.json|advertised team memory|does not match.*(?:remote|overlay)|(?:remote|overlay).*does not match/i,
      "the failure must identify the committed-vs-local memory identity mismatch");
    assert.deepEqual(jsonSnapshot(fixture.code.root), publicJsonBefore);
    assert.equal(git(fixture.code.root, "status", "--porcelain=v1", "--untracked-files=all"), statusBefore);
    assert.equal(git(fixture.code.root, "rev-parse", "HEAD"), codeHeadBefore);
    assert.equal(bareHead(fixture.code.remote), codeRemoteBefore);
    assert.equal(bareHead(fixture.memoryA), memoryABefore);
    assert.equal(bareHead(fixture.memoryB), memoryBBefore);
    assert.equal(git(fixture.overlay, "rev-parse", "HEAD"), overlayHeadBefore);
  } finally {
    rmSync(base, { recursive: true, force: true });
  }
});

test("MCP refuses an existing shared overlay whose remote differs from committed team.json", { timeout: 90_000 }, () => {
  const base = mkdtempSync(join(tmpdir(), "hunch-team-remote-mismatch-mcp-"));
  try {
    const fixture = makeMismatchedTeamFixture(base, "mismatch-mcp");
    const codeHeadBefore = git(fixture.code.root, "rev-parse", "HEAD");
    const codeRemoteBefore = bareHead(fixture.code.remote);
    const memoryABefore = bareHead(fixture.memoryA);
    const memoryBBefore = bareHead(fixture.memoryB);
    const overlayHeadBefore = git(fixture.overlay, "rev-parse", "HEAD");
    const publicJsonBefore = jsonSnapshot(fixture.code.root);
    const statusBefore = git(fixture.code.root, "status", "--porcelain=v1", "--untracked-files=all");

    const result = runCliWithTimeout(fixture.code, 10_000, "mcp");
    const text = output(result);
    assert.equal(result.error, undefined, result.error?.message);
    assert.equal(result.status, 1, text);
    assert.match(text, /team\.json|advertised team memory|does not match.*(?:remote|overlay)|(?:remote|overlay).*does not match/i,
      "MCP must identify the committed-vs-local memory identity mismatch");
    assert.doesNotMatch(text, /serving Hunch|REMOTE_A_ONLY_RULE/,
      "MCP never serves tools from stale overlay A");
    assert.deepEqual(jsonSnapshot(fixture.code.root), publicJsonBefore);
    assert.equal(git(fixture.code.root, "status", "--porcelain=v1", "--untracked-files=all"), statusBefore);
    assert.equal(git(fixture.code.root, "rev-parse", "HEAD"), codeHeadBefore);
    assert.equal(bareHead(fixture.code.remote), codeRemoteBefore);
    assert.equal(bareHead(fixture.memoryA), memoryABefore);
    assert.equal(bareHead(fixture.memoryB), memoryBBefore);
    assert.equal(git(fixture.overlay, "rev-parse", "HEAD"), overlayHeadBefore);
  } finally {
    rmSync(base, { recursive: true, force: true });
  }
});

test("migrate fails closed when committed team memory is unavailable", { timeout: 60_000 }, () => {
  const base = mkdtempSync(join(tmpdir(), "hunch-team-unavailable-migrate-"));
  try {
    const unavailable = join(base, "missing-memory.git");
    const code = makeCodeFixture(base, "unavailable-migrate", unavailable);
    const publicJsonBefore = jsonSnapshot(code.root);
    const statusBefore = git(code.root, "status", "--porcelain=v1", "--untracked-files=all");
    const codeHeadBefore = git(code.root, "rev-parse", "HEAD");
    const codeRemoteBefore = bareHead(code.remote);

    const result = runCli(code, "migrate");
    const text = output(result);
    assert.deepEqual(
      jsonSnapshot(code.root),
      publicJsonBefore,
      `migrate mutated public memory instead of failing closed (status=${result.status}):\n${text}`,
    );
    assert.equal(result.error, undefined, result.error?.message);
    assert.equal(result.status, 1, text);
    assert.match(text, /team|shared|memory|overlay/i);
    assert.equal(existsSync(join(code.root, ".hunch/local.json")), false);
    assert.equal(git(code.root, "status", "--porcelain=v1", "--untracked-files=all"), statusBefore);
    assert.equal(git(code.root, "rev-parse", "HEAD"), codeHeadBefore);
    assert.equal(bareHead(code.remote), codeRemoteBefore);
  } finally {
    rmSync(base, { recursive: true, force: true });
  }
});

test("worktree creation fails closed when committed team memory is unavailable", { timeout: 60_000 }, () => {
  const base = mkdtempSync(join(tmpdir(), "hunch-team-unavailable-worktree-"));
  try {
    const unavailable = join(base, "missing-memory.git");
    const code = makeCodeFixture(base, "unavailable-worktree", unavailable);
    const destinationName = "team-memory-unavailable-worktree";
    const destination = join(code.root, destinationName);
    const publicJsonBefore = jsonSnapshot(code.root);
    const statusBefore = git(code.root, "status", "--porcelain=v1", "--untracked-files=all");
    const refsBefore = git(code.root, "for-each-ref", "--format=%(refname):%(objectname)");
    const worktreesBefore = git(code.root, "worktree", "list", "--porcelain");
    const codeHeadBefore = git(code.root, "rev-parse", "HEAD");
    const codeRemoteBefore = bareHead(code.remote);

    const result = runCli(code, "worktree", destinationName, "--no-index");
    const text = output(result);
    assert.equal(
      existsSync(destination),
      false,
      `worktree was created before team-memory availability was proved (status=${result.status}):\n${text}`,
    );
    assert.equal(result.error, undefined, result.error?.message);
    assert.equal(result.status, 1, text);
    assert.match(text, /team|shared|memory|overlay/i);
    assert.deepEqual(jsonSnapshot(code.root), publicJsonBefore);
    assert.equal(existsSync(join(code.root, ".hunch/local.json")), false);
    assert.equal(git(code.root, "status", "--porcelain=v1", "--untracked-files=all"), statusBefore);
    assert.equal(git(code.root, "for-each-ref", "--format=%(refname):%(objectname)"), refsBefore,
      "failed worktree creation adds no branch or ref");
    assert.equal(git(code.root, "worktree", "list", "--porcelain"), worktreesBefore);
    assert.equal(git(code.root, "rev-parse", "HEAD"), codeHeadBefore);
    assert.equal(bareHead(code.remote), codeRemoteBefore);
  } finally {
    rmSync(base, { recursive: true, force: true });
  }
});
