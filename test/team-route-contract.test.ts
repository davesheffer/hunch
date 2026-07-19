import assert from "node:assert/strict";
import { execFileSync, spawn, spawnSync } from "node:child_process";
import {
  chmodSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  readdirSync,
  renameSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { repositoryUsesRemote, sameRemoteUrl } from "../src/extractors/git.js";

const PROJECT_ROOT = process.cwd();
const TSX = join(PROJECT_ROOT, "node_modules/tsx/dist/cli.mjs");
const CLI = join(PROJECT_ROOT, "src/cli/index.ts");
// These fixtures execute the real TypeScript CLI plus several local Git
// round-trips. Keep the ordinary child budget below the enclosing 60–90s test
// budgets, but high enough that one neighboring integration worker cannot turn
// normal process-start variance into a false ETIMEDOUT. Adversarial transport
// cases pass their own much smaller 5s/12s limits explicitly.
const DEFAULT_CLI_TIMEOUT_MS = 45_000;

type Fixture = {
  root: string;
  home: string;
  env: NodeJS.ProcessEnv;
  codeRemote: string;
};

type SharedFixture = Fixture & {
  memoryRemote: string;
  overlay: string;
};

function git(cwd: string, ...args: string[]): string {
  return execFileSync("git", args, {
    cwd,
    encoding: "utf8",
    env: { ...process.env, GIT_CONFIG_NOSYSTEM: "1", GIT_TERMINAL_PROMPT: "0" },
    stdio: ["ignore", "pipe", "pipe"],
  }).trim();
}

function configureRepo(root: string, name: string): void {
  git(root, "config", "user.name", name);
  git(root, "config", "user.email", `${name.toLowerCase().replace(/[^a-z]+/g, "-")}@route.test`);
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
    GIT_AUTHOR_NAME: "Route Test",
    GIT_AUTHOR_EMAIL: "route-test@route.test",
    GIT_COMMITTER_NAME: "Route Test",
    GIT_COMMITTER_EMAIL: "route-test@route.test",
    HUNCH_PRIVATE_DIR: "",
    HUNCH_SYNTH_PROVIDER: "deterministic",
    HUNCH_EMBEDDINGS: "off",
    NO_COLOR: "1",
    CI: "1",
  };
}

function runCli(
  fixture: Pick<Fixture, "root" | "env">,
  args: string[],
  input?: string,
  timeout = DEFAULT_CLI_TIMEOUT_MS,
) {
  return spawnSync(process.execPath, [TSX, CLI, ...args], {
    cwd: fixture.root,
    env: fixture.env,
    input,
    encoding: "utf8",
    timeout,
    maxBuffer: 16 * 1024 * 1024,
  });
}

function output(run: ReturnType<typeof runCli>): string {
  return `${run.stdout ?? ""}${run.stderr ?? ""}`;
}

async function waitFor(predicate: () => boolean, timeoutMs: number): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (!predicate()) {
    if (Date.now() >= deadline) throw new Error("timed out waiting for test condition");
    await new Promise((resolve) => setTimeout(resolve, 20));
  }
}

function expectCli(fixture: Pick<Fixture, "root" | "env">, args: string[], status: number): string {
  const result = runCli(fixture, args);
  assert.equal(result.error, undefined, result.error?.message);
  assert.equal(result.signal, null, output(result));
  assert.equal(result.status, status, output(result));
  return output(result);
}

function bareRefs(remote: string): string {
  return execFileSync("git", [
    "--git-dir", remote,
    "for-each-ref", "--format=%(refname):%(objectname)",
  ], { encoding: "utf8" }).trim();
}

function bareHead(remote: string): string {
  return execFileSync("git", ["--git-dir", remote, "rev-parse", "refs/heads/main"], {
    encoding: "utf8",
  }).trim();
}

function makeMemoryRemote(base: string, name: string, branch = "main", withManifest = false): string {
  const seed = join(base, `${name}-seed`);
  const remote = join(base, `${name}.git`);
  mkdirSync(seed, { recursive: true });
  git(seed, "init", "-q", "-b", branch);
  configureRepo(seed, "Memory Seed");
  writeFileSync(join(seed, "README.md"), "# Shared memory\n");
  if (withManifest) {
    mkdirSync(join(seed, ".hunch"), { recursive: true });
    writeFileSync(join(seed, ".hunch/manifest.json"), "{\n  \"schema_version\": 2\n}\n");
  }
  git(seed, "add", "-A");
  git(seed, "commit", "-qm", "fixture: memory baseline");
  git(base, "clone", "-q", "--bare", seed, remote);
  return remote;
}

function makeEmptyMemoryRemote(base: string, name: string): string {
  const remote = join(base, `${name}.git`);
  git(base, "init", "-q", "--bare", "-b", "main", remote);
  return remote;
}

function makeCodeFixture(base: string, name: string, teamRemote?: string): Fixture {
  const seed = join(base, `${name}-seed`);
  const codeRemote = join(base, `${name}.git`);
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
    name: "team-route-fixture",
    private: true,
    type: "module",
    dependencies: { axios: "1.0.0" },
  }, null, 2)}\n`);
  writeFileSync(join(seed, "src/app.ts"), "export const transport = () => fetch('/orders');\n");
  if (teamRemote) {
    mkdirSync(join(seed, ".hunch"), { recursive: true });
    writeFileSync(join(seed, ".hunch/team.json"), `${JSON.stringify({ shared_repo: teamRemote }, null, 2)}\n`);
  }
  git(seed, "add", "-A");
  git(seed, "commit", "-qm", "fixture: tiny code repository");
  git(base, "clone", "-q", "--bare", seed, codeRemote);
  git(base, "clone", "-q", codeRemote, root);
  configureRepo(root, name);
  return { root, home, env: actorEnv(home), codeRemote };
}

function makeSharedFixture(base: string, name: string): SharedFixture {
  const memoryRemote = makeMemoryRemote(base, `${name}-memory`);
  const code = makeCodeFixture(base, `${name}-code`);
  expectCli(code, ["shared", "--repo", memoryRemote, "--no-hook"], 0);
  expectCli(code, ["shared", "--sync"], 0);
  git(code.root, "add", ".gitignore", ".hunch/team.json");
  git(code.root, "commit", "-qm", "chore: advertise team memory");
  git(code.root, "push", "-q", "origin", "main");
  return { ...code, memoryRemote, overlay: join(code.root, ".hunch-private") };
}

test("explicit shared setup binds its graph epoch before the next Hunch command", { timeout: 60_000 }, () => {
  const base = mkdtempSync(join(tmpdir(), "hunch-immediate-route-binding-"));
  try {
    const memoryA = makeMemoryRemote(base, "binding-memory-a");
    const memoryB = makeMemoryRemote(base, "binding-memory-b");
    const code = makeCodeFixture(base, "binding-code");
    code.env = {
      ...code.env,
      // Match the repository-local variables Git exports to hooks. Every setup
      // operation targeting the memory repository must ignore these code-repo
      // selectors and honor its explicit overlay path.
      GIT_DIR: join(code.root, ".git"),
      GIT_WORK_TREE: code.root,
      GIT_INDEX_FILE: join(code.root, ".git/index"),
    };

    expectCli(code, ["shared", "--repo", memoryA, "--no-hook"], 0);
    const overlay = join(code.root, ".hunch-private");
    assert.match(git(overlay, "config", "--get", "merge.hunch.driver"), /merge-driver/,
      "setup registers the merge driver in the overlay, not the hook's code repository");
    const bindingFile = join(overlay, ".git/hunch-team-route.json");
    assert.equal(existsSync(bindingFile), true, "successful setup durably binds the clone before returning");
    const binding = JSON.parse(readFileSync(bindingFile, "utf8")) as {
      version: number;
      shared_repo: string;
      shared_ref: string;
    };
    assert.equal(binding.version, 1);
    assert.equal(sameRemoteUrl(binding.shared_repo, overlay, memoryA, code.root), true);
    assert.equal(binding.shared_ref, "refs/heads/main");

    const memoryABefore = bareRefs(memoryA);
    const memoryBBefore = bareRefs(memoryB);
    writeFileSync(join(code.root, ".hunch/team.json"), `${JSON.stringify({
      shared_repo: memoryB,
      shared_ref: "refs/heads/main",
    }, null, 2)}\n`);
    git(overlay, "remote", "set-url", "origin", memoryB);

    const refused = runCli(code, ["query", "graph epoch"]);
    assert.equal(refused.status, 1, output(refused));
    assert.match(output(refused), /unavailable|different remote|route|graph/i);
    assert.equal(bareRefs(memoryA), memoryABefore);
    assert.equal(bareRefs(memoryB), memoryBBefore);
    assert.equal(sameRemoteUrl(
      (JSON.parse(readFileSync(bindingFile, "utf8")) as { shared_repo: string }).shared_repo,
      overlay,
      memoryA,
      code.root,
    ), true,
      "a coherent repoint cannot relabel an already-bound clone");
  } finally {
    rmSync(base, { recursive: true, force: true });
  }
});

test("doctor reports the unified overlay schema instead of the public routing shell", { timeout: 60_000 }, () => {
  const base = mkdtempSync(join(tmpdir(), "hunch-unified-doctor-schema-"));
  try {
    const fixture = makeSharedFixture(base, "doctor-schema");
    assert.equal(existsSync(join(fixture.root, ".hunch/manifest.json")), false,
      "the code repository intentionally has no public memory manifest");
    const doctor = expectCli(fixture, ["doctor"], 0);
    assert.match(doctor, /schema:\s+v2 \(hunch v2\)/);
    assert.doesNotMatch(doctor, /run `hunch migrate`/);
  } finally {
    rmSync(base, { recursive: true, force: true });
  }
});

test("a CLI command refuses all handlers when its route changes during the startup pull", { timeout: 60_000 }, async () => {
  const base = mkdtempSync(join(tmpdir(), "hunch-cli-pull-route-race-"));
  let stopMarker: (() => Promise<void>) | null = null;
  let child: ReturnType<typeof spawn> | null = null;
  try {
    const fixture = makeSharedFixture(base, "cli-pull-race");
    const memoryB = makeMemoryRemote(base, "cli-pull-race-memory-b");
    const connection = await startConnectionMarker(base, true);
    stopMarker = connection.stop;
    const stalledRemote = `${connection.rewriteBase.replace(/^https:/, "git:")}memory.git`;
    fixture.env = {
      ...fixture.env,
      HTTP_PROXY: "", HTTPS_PROXY: "", ALL_PROXY: "",
      NO_PROXY: "127.0.0.1,localhost",
      http_proxy: "", https_proxy: "", all_proxy: "",
      no_proxy: "127.0.0.1,localhost",
    };
    writeFileSync(join(fixture.root, ".hunch/team.json"), `${JSON.stringify({
      shared_repo: stalledRemote,
      shared_ref: "refs/heads/main",
    }, null, 2)}\n`);
    git(fixture.overlay, "remote", "set-url", "origin", stalledRemote);
    writeFileSync(join(fixture.overlay, ".git/hunch-team-route.json"), `${JSON.stringify({
      version: 1,
      shared_repo: stalledRemote,
      shared_ref: "refs/heads/main",
    }, null, 2)}\n`);
    const memoryBBefore = bareRefs(memoryB);

    child = spawn(process.execPath, [TSX, CLI, "query", "must not be served"], {
      cwd: fixture.root,
      env: fixture.env,
      stdio: ["ignore", "pipe", "pipe"],
    });
    let stdout = "";
    let stderr = "";
    child.stdout?.on("data", (chunk) => { stdout += String(chunk); });
    child.stderr?.on("data", (chunk) => { stderr += String(chunk); });
    const exited = new Promise<{ code: number | null; signal: NodeJS.Signals | null }>((resolve) => {
      child!.once("exit", (code, signal) => resolve({ code, signal }));
    });

    await waitFor(() => existsSync(connection.marker), 15_000);
    writeFileSync(join(fixture.root, ".hunch/team.json"), `${JSON.stringify({
      shared_repo: memoryB,
      shared_ref: "refs/heads/main",
    }, null, 2)}\n`);
    git(fixture.overlay, "remote", "set-url", "origin", memoryB);

    let exitTimeout!: NodeJS.Timeout;
    const result = await Promise.race([
      exited,
      new Promise<never>((_, reject) => {
        exitTimeout = setTimeout(() => reject(new Error("CLI route-race command did not exit")), 20_000);
      }),
    ]).finally(() => clearTimeout(exitTimeout));
    child = null;
    const text = `${stdout}${stderr}`;
    assert.equal(result.signal, null, text);
    assert.equal(result.code, 1, text);
    assert.match(text, /route changed while.*refreshing|stale memory/i);
    assert.doesNotMatch(text, /No results|must not be served/i, "the query handler never runs on the stale graph");
    assert.equal(bareRefs(memoryB), memoryBBefore);
  } finally {
    if (child && child.exitCode === null && child.signalCode === null) child.kill("SIGKILL");
    if (stopMarker) await stopMarker();
    rmSync(base, { recursive: true, force: true });
  }
});

function markerProgram(base: string, name: string): { program: string; marker: string } {
  const marker = join(base, `${name}-ran`);
  const program = join(base, `${name}.sh`);
  writeFileSync(program, `#!/bin/sh\n: > ${JSON.stringify(marker)}\nexit 1\n`);
  chmodSync(program, 0o755);
  return { program, marker };
}

function makeExistingSameOriginOverlay(fixture: Fixture, memoryRemote: string): string {
  const overlay = join(fixture.root, ".hunch-private");
  mkdirSync(overlay, { recursive: true });
  git(overlay, "init", "-q", "-b", "main");
  configureRepo(overlay, "Existing Memory");
  writeFileSync(join(overlay, "LOCAL.md"), "existing local memory\n");
  git(overlay, "add", "LOCAL.md");
  git(overlay, "commit", "-qm", "fixture: existing local memory");
  git(overlay, "remote", "add", "origin", memoryRemote);
  return overlay;
}

function assertExplicitSharedSetupRefusal(
  fixture: Fixture,
  memoryRemote: string,
  overlay: string,
  markers: string[] = [],
): void {
  const statusBefore = git(fixture.root, "status", "--porcelain=v1", "--untracked-files=all");
  const codeHeadBefore = git(fixture.root, "rev-parse", "HEAD");
  const codeRemoteBefore = bareRefs(fixture.codeRemote);
  const memoryBefore = bareRefs(memoryRemote);
  const overlayHeadBefore = git(overlay, "rev-parse", "HEAD");
  const overlayRefsBefore = git(overlay, "for-each-ref", "--format=%(refname):%(objectname)");
  const overlayStatusBefore = git(overlay, "status", "--porcelain=v1", "--untracked-files=all");

  const result = runCli(fixture, ["shared", "--repo", memoryRemote, "--no-hook"]);
  const text = output(result);
  assert.equal(result.error, undefined, result.error?.message);
  assert.equal(result.status, 1, text);
  assert.match(text, /prove|transport|canonical|shared|overlay|remote/i);
  for (const marker of markers) assert.equal(existsSync(marker), false, `${marker} must not execute`);
  assert.equal(existsSync(join(fixture.root, ".hunch/local.json")), false, "no local pointer is written");
  assert.equal(existsSync(join(fixture.root, ".hunch/team.json")), false, "no committed team route is written");
  assert.equal(existsSync(join(fixture.root, ".git/hunch/local.json")), false, "no git-common-dir pointer is written");
  assert.equal(existsSync(join(overlay, ".hunch")), false, "refusal precedes overlay layout mutation");
  assert.equal(git(fixture.root, "status", "--porcelain=v1", "--untracked-files=all"), statusBefore);
  assert.equal(git(fixture.root, "rev-parse", "HEAD"), codeHeadBefore);
  assert.equal(bareRefs(fixture.codeRemote), codeRemoteBefore);
  assert.equal(bareRefs(memoryRemote), memoryBefore);
  assert.equal(git(overlay, "rev-parse", "HEAD"), overlayHeadBefore);
  assert.equal(git(overlay, "for-each-ref", "--format=%(refname):%(objectname)"), overlayRefsBefore,
    "refusal performs no fetch or remote-tracking update");
  assert.equal(git(overlay, "status", "--porcelain=v1", "--untracked-files=all"), overlayStatusBefore);
}

async function startConnectionMarker(base: string, holdOpen = false): Promise<{
  marker: string;
  rewriteBase: string;
  stop: () => Promise<void>;
}> {
  const marker = join(base, "rewritten-remote-contacted");
  const script = [
    'const net = require("node:net");',
    'const fs = require("node:fs");',
    `const marker = ${JSON.stringify(marker)};`,
    "const server = net.createServer((socket) => {",
    '  fs.writeFileSync(marker, "contacted\\n");',
    ...(holdOpen ? ["  socket.on('error', () => {});"] : ["  socket.destroy();", "  server.close();"]),
    "});",
    'server.listen(0, "127.0.0.1", () => process.send?.(server.address().port));',
    holdOpen
      ? 'process.on("SIGTERM", () => process.exit(0));'
      : 'process.on("SIGTERM", () => server.close(() => process.exit(0)));',
  ].join("\n");
  const child = spawn(process.execPath, ["-e", script], {
    stdio: ["ignore", "ignore", "ignore", "ipc"],
  });
  const port = await new Promise<number>((resolve, reject) => {
    let settled = false;
    const timeout = setTimeout(() => {
      if (!settled) reject(new Error("connection-marker server did not become ready"));
    }, 5_000);
    child.once("message", (message) => {
      if (typeof message !== "number") return;
      settled = true;
      clearTimeout(timeout);
      resolve(message);
    });
    child.once("error", (error) => {
      if (settled) return;
      settled = true;
      clearTimeout(timeout);
      reject(error);
    });
    child.once("exit", (code) => {
      if (settled) return;
      settled = true;
      clearTimeout(timeout);
      reject(new Error(`connection-marker server exited before ready (${code ?? "signal"})`));
    });
  });
  return {
    marker,
    rewriteBase: `https://127.0.0.1:${port}/`,
    stop: async () => {
      if (child.exitCode !== null || child.signalCode !== null) return;
      await new Promise<void>((resolve) => {
        child.once("exit", () => resolve());
        if (!child.kill("SIGTERM")) resolve();
      });
    },
  };
}

const explicitSetupPoisonCases: Array<{
  name: string;
  poison: (overlay: string, base: string) => string[];
}> = [
  {
    name: "upload-pack command override",
    poison: (overlay, base) => {
      const marker = markerProgram(base, "setup-uploadpack");
      git(overlay, "config", "remote.origin.uploadpack", marker.program);
      return [marker.marker];
    },
  },
  {
    name: "non-canonical fetch refspec",
    poison: (overlay) => {
      git(overlay, "config", "--unset-all", "remote.origin.fetch");
      git(overlay, "config", "--add", "remote.origin.fetch", "+refs/heads/main:refs/remotes/origin/diverted");
      return [];
    },
  },
];

for (const setupCase of explicitSetupPoisonCases) {
  test(`explicit shared setup rejects an existing same-origin overlay with ${setupCase.name}`, { timeout: 60_000 }, () => {
    const base = mkdtempSync(join(tmpdir(), "hunch-shared-setup-route-"));
    try {
      const memoryRemote = makeMemoryRemote(base, "setup-memory");
      const code = makeCodeFixture(base, "setup-code");
      const overlay = makeExistingSameOriginOverlay(code, memoryRemote);
      const markers = setupCase.poison(overlay, base);
      assertExplicitSharedSetupRefusal(code, memoryRemote, overlay, markers);
      // Control probe after every no-contact assertion: prove the configured
      // upload-pack marker is live and would execute under an ambient Git fetch.
      if (markers.length) {
        const control = spawnSync("git", ["-C", overlay, "fetch", "origin"], {
          encoding: "utf8",
          stdio: "ignore",
          env: { ...process.env, GIT_CONFIG_NOSYSTEM: "1", GIT_TERMINAL_PROMPT: "0" },
        });
        assert.notEqual(control.status, 0, "the deliberately failing upload-pack control aborts raw Git");
        for (const marker of markers) assert.equal(existsSync(marker), true,
          "the post-refusal control proves the marker would detect ambient transport");
      }
    } finally {
      rmSync(base, { recursive: true, force: true });
    }
  });
}

test("explicit shared setup rejects an applicable global url.insteadOf before contacting its rewritten remote", { timeout: 60_000 }, async () => {
  const base = mkdtempSync(join(tmpdir(), "hunch-shared-global-rewrite-"));
  let stopMarker: (() => Promise<void>) | null = null;
  try {
    const code = makeCodeFixture(base, "global-rewrite-code");
    code.env = {
      ...code.env,
      HTTP_PROXY: "",
      HTTPS_PROXY: "",
      ALL_PROXY: "",
      NO_PROXY: "127.0.0.1,localhost",
      http_proxy: "",
      https_proxy: "",
      all_proxy: "",
      no_proxy: "127.0.0.1,localhost",
    };
    const connection = await startConnectionMarker(base);
    stopMarker = connection.stop;
    const advertisedPrefix = "https://team.example.test/";
    const advertisedRemote = `${advertisedPrefix}memory.git`;
    execFileSync("git", [
      "config", "--global",
      `url.${connection.rewriteBase}.insteadOf`, advertisedPrefix,
    ], { env: code.env, stdio: "ignore" });
    const statusBefore = git(code.root, "status", "--porcelain=v1", "--untracked-files=all");
    const codeHeadBefore = git(code.root, "rev-parse", "HEAD");
    const codeRemoteBefore = bareRefs(code.codeRemote);

    const result = runCli(code, ["shared", "--repo", advertisedRemote, "--no-hook"]);
    const text = output(result);

    assert.equal(result.error, undefined, result.error?.message);
    assert.equal(result.status, 1, text);
    assert.match(text, /prove|canonical|shared|remote/i);
    assert.equal(existsSync(connection.marker), false, "the rewritten HTTPS destination receives no TCP connection");
    assert.equal(existsSync(join(code.root, ".hunch-private")), false);
    assert.equal(existsSync(join(code.root, ".hunch/local.json")), false);
    assert.equal(existsSync(join(code.root, ".hunch/team.json")), false);
    assert.equal(existsSync(join(code.root, ".git/hunch/local.json")), false);
    assert.equal(git(code.root, "status", "--porcelain=v1", "--untracked-files=all"), statusBefore);
    assert.equal(git(code.root, "rev-parse", "HEAD"), codeHeadBefore);
    assert.equal(bareRefs(code.codeRemote), codeRemoteBefore);

    // Control probe only after Hunch's no-contact boundary is proved. Raw Git
    // must apply the isolated global rewrite and touch the local TCP marker, or
    // the fixture would be incapable of detecting the regression it claims to.
    const control = spawnSync("git", ["ls-remote", "--refs", "--heads", advertisedRemote], {
      env: code.env,
      encoding: "utf8",
      stdio: "ignore",
      timeout: 5_000,
    });
    assert.notEqual(control.status, 0, "the marker intentionally terminates the raw HTTPS control connection");
    assert.equal(existsSync(connection.marker), true, "raw Git proves the global rewrite and marker are applicable");
  } finally {
    if (stopMarker) await stopMarker();
    rmSync(base, { recursive: true, force: true });
  }
});

test("fresh team auto-discovery bounds a non-responsive transport and removes its staged clone", { timeout: 30_000 }, async () => {
  const base = mkdtempSync(join(tmpdir(), "hunch-bounded-autojoin-"));
  let stopMarker: (() => Promise<void>) | null = null;
  try {
    const connection = await startConnectionMarker(base, true);
    stopMarker = connection.stop;
    const code = makeCodeFixture(base, "bounded-autojoin-code", `${connection.rewriteBase}memory.git`);
    code.env = {
      ...code.env,
      HTTP_PROXY: "", HTTPS_PROXY: "", ALL_PROXY: "",
      NO_PROXY: "127.0.0.1,localhost",
      http_proxy: "", https_proxy: "", all_proxy: "",
      no_proxy: "127.0.0.1,localhost",
    };
    const started = Date.now();
    const result = runCli(code, ["check", "--working", "--strict"], undefined, 12_000);
    const elapsed = Date.now() - started;
    assert.equal(result.status, 1, output(result));
    assert.ok(elapsed >= 4_000 && elapsed < 10_000, `clone should stop near its 5s bound (elapsed ${elapsed}ms)`);
    assert.equal(existsSync(connection.marker), true, "the deliberately stalled transport was actually contacted");
    assert.equal(existsSync(join(code.root, ".hunch-private")), false);
    assert.equal(readdirSync(code.root).some((name) => name.startsWith(".hunch-private.tmp-")), false,
      "timed-out clone state is removed instead of poisoning future starts");
    assert.equal(existsSync(join(code.root, ".hunch/local.json")), false);
  } finally {
    if (stopMarker) await stopMarker();
    rmSync(base, { recursive: true, force: true });
  }
});

test("explicit shared preflight conservatively treats generic HTTPS and SSH URLs as one code publication", { timeout: 30_000 }, () => {
  const base = mkdtempSync(join(tmpdir(), "hunch-shared-publication-alias-"));
  try {
    const code = makeCodeFixture(base, "publication-alias-code");
    const codeUrl = "https://git.example.test/Acme/Platform-Memory.git";
    const requestedOverlay = "ssh://git@git.example.test/acme/platform-memory.git";
    git(code.root, "remote", "set-url", "origin", codeUrl);
    assert.equal(repositoryUsesRemote(code.root, requestedOverlay), true,
      "publication preflight ignores generic transport/account aliases conservatively");
    const statusBefore = git(code.root, "status", "--porcelain=v1", "--untracked-files=all");
    const codeHeadBefore = git(code.root, "rev-parse", "HEAD");
    const codeRemoteBefore = bareRefs(code.codeRemote);

    const result = runCli(code, ["shared", "--repo", requestedOverlay, "--no-hook"], undefined, 5_000);
    const text = output(result);

    assert.equal(result.error, undefined, result.error?.message);
    assert.equal(result.status, 1, text);
    assert.match(text, /different from every remote configured for the code repository and from the code repository itself/i);
    assert.equal(existsSync(join(code.root, ".hunch-private")), false);
    assert.equal(existsSync(join(code.root, ".hunch/local.json")), false);
    assert.equal(existsSync(join(code.root, ".hunch/team.json")), false);
    assert.equal(git(code.root, "status", "--porcelain=v1", "--untracked-files=all"), statusBefore);
    assert.equal(git(code.root, "rev-parse", "HEAD"), codeHeadBefore);
    assert.equal(bareRefs(code.codeRemote), codeRemoteBefore);
  } finally {
    rmSync(base, { recursive: true, force: true });
  }
});

test("explicit shared preflight rejects direct local code repositories and their detached bare history", { timeout: 30_000 }, () => {
  const base = mkdtempSync(join(tmpdir(), "hunch-shared-direct-code-boundary-"));
  try {
    const code = makeCodeFixture(base, "direct-code-boundary");
    git(code.root, "remote", "remove", "origin");
    for (const requested of [code.root, code.codeRemote]) {
      assert.equal(repositoryUsesRemote(code.root, requested), true,
        "a local target with the code repository identity/history is one publication boundary");
      const statusBefore = git(code.root, "status", "--porcelain=v1", "--untracked-files=all");
      const headBefore = git(code.root, "rev-parse", "HEAD");
      const remoteBefore = bareRefs(code.codeRemote);
      const result = runCli(code, ["shared", "--repo", requested, "--no-hook"]);
      assert.equal(result.status, 1, output(result));
      assert.match(output(result), /different from every remote configured for the code repository and from the code repository itself/i);
      assert.equal(existsSync(join(code.root, ".hunch-private")), false);
      assert.equal(existsSync(join(code.root, ".hunch/local.json")), false);
      assert.equal(existsSync(join(code.root, ".hunch/team.json")), false);
      assert.equal(git(code.root, "status", "--porcelain=v1", "--untracked-files=all"), statusBefore);
      assert.equal(git(code.root, "rev-parse", "HEAD"), headBefore);
      assert.equal(bareRefs(code.codeRemote), remoteBefore);
    }
  } finally {
    rmSync(base, { recursive: true, force: true });
  }
});

function assertStrictRouteRefusal(
  fixture: SharedFixture,
  markers: string[] = [],
): void {
  writeFileSync(join(fixture.root, "src/app.ts"), "export const transport = () => 'changed';\n");
  const codeHeadBefore = git(fixture.root, "rev-parse", "HEAD");
  const codeRemoteBefore = bareRefs(fixture.codeRemote);
  const memoryBefore = bareRefs(fixture.memoryRemote);
  const overlayHeadBefore = git(fixture.overlay, "rev-parse", "HEAD");
  const overlayRefsBefore = git(fixture.overlay, "for-each-ref", "--format=%(refname):%(objectname)");
  const statusBefore = git(fixture.root, "status", "--porcelain=v1", "--untracked-files=all");

  const result = runCli(fixture, ["check", "--working", "--strict"]);
  const text = output(result);
  assert.equal(result.error, undefined, result.error?.message);
  assert.equal(result.status, 1, text);
  assert.match(text, /team|route|remote|overlay|refspec|override/i);
  for (const marker of markers) assert.equal(existsSync(marker), false, `${marker} must not execute`);
  assert.equal(git(fixture.root, "status", "--porcelain=v1", "--untracked-files=all"), statusBefore);
  assert.equal(git(fixture.root, "rev-parse", "HEAD"), codeHeadBefore);
  assert.equal(bareRefs(fixture.codeRemote), codeRemoteBefore);
  assert.equal(bareRefs(fixture.memoryRemote), memoryBefore);
  assert.equal(git(fixture.overlay, "rev-parse", "HEAD"), overlayHeadBefore);
  assert.equal(git(fixture.overlay, "for-each-ref", "--format=%(refname):%(objectname)"), overlayRefsBefore,
    "route refusal performs no fetch or remote-tracking update");
}

const routeCases: Array<{
  name: string;
  mutate: (fixture: SharedFixture, base: string) => string[];
}> = [
  {
    name: "origin uploadpack override",
    mutate: (fixture, base) => {
      const marker = markerProgram(base, "uploadpack-override");
      git(fixture.overlay, "config", "remote.origin.uploadpack", marker.program);
      return [marker.marker];
    },
  },
  {
    name: "origin receivepack override",
    mutate: (fixture, base) => {
      const marker = markerProgram(base, "receivepack-override");
      git(fixture.overlay, "config", "remote.origin.receivepack", marker.program);
      return [marker.marker];
    },
  },
  {
    name: "non-canonical origin fetch refspec",
    mutate: (fixture) => {
      git(fixture.overlay, "config", "--unset-all", "remote.origin.fetch");
      git(fixture.overlay, "config", "--add", "remote.origin.fetch", "+refs/heads/main:refs/remotes/origin/diverted");
      return [];
    },
  },
  {
    name: "origin push refspec",
    mutate: (fixture) => {
      git(fixture.overlay, "config", "--add", "remote.origin.push", "refs/heads/main:refs/heads/diverted");
      return [];
    },
  },
  {
    name: "origin mirror mode",
    mutate: (fixture) => {
      git(fixture.overlay, "config", "remote.origin.mirror", "true");
      return [];
    },
  },
  {
    name: "alternate origin push URL",
    mutate: (fixture, base) => {
      const alternate = makeMemoryRemote(base, "alternate-push-memory");
      const marker = join(base, "alternate-push-ran");
      const hook = join(alternate, "hooks/pre-receive");
      writeFileSync(hook, `#!/bin/sh\n: > ${JSON.stringify(marker)}\nexit 1\n`);
      chmodSync(hook, 0o755);
      git(fixture.overlay, "remote", "set-url", "--push", "origin", alternate);
      return [marker];
    },
  },
  {
    name: "file URL origin alias",
    mutate: (fixture) => {
      git(fixture.overlay, "remote", "set-url", "origin", `file://${fixture.memoryRemote}`);
      return [];
    },
  },
  {
    name: "non-canonical branch upstream",
    mutate: (fixture) => {
      git(fixture.overlay, "push", "-q", "origin", "HEAD:refs/heads/other");
      git(fixture.overlay, "fetch", "-q", "origin");
      git(fixture.overlay, "config", "branch.main.remote", "origin");
      git(fixture.overlay, "config", "branch.main.merge", "refs/heads/other");
      return [];
    },
  },
  {
    name: "non-canonical push.default",
    mutate: (fixture) => {
      git(fixture.overlay, "config", "push.default", "matching");
      return [];
    },
  },
];

for (const routeCase of routeCases) {
  test(`strict team route rejects ${routeCase.name} before Git transport`, { timeout: 60_000 }, () => {
    const base = mkdtempSync(join(tmpdir(), "hunch-team-route-config-"));
    try {
      const fixture = makeSharedFixture(base, routeCase.name.replace(/[^a-z]+/gi, "-"));
      const markers = routeCase.mutate(fixture, base);
      assertStrictRouteRefusal(fixture, markers);
    } finally {
      rmSync(base, { recursive: true, force: true });
    }
  });
}

test("an empty-memory clone auto-joins after exactly one canonical branch is published", { timeout: 90_000 }, () => {
  const base = mkdtempSync(join(tmpdir(), "hunch-team-empty-autojoin-"));
  try {
    const memoryRemote = makeEmptyMemoryRemote(base, "empty-memory");
    const code = makeCodeFixture(base, "empty-autojoin-code", memoryRemote);
    writeFileSync(join(code.root, "src/app.ts"), "export const transport = () => 'changed';\n");
    const first = runCli(code, ["check", "--working", "--strict"]);
    assert.equal(first.error, undefined, first.error?.message);
    assert.equal(first.status, 1, output(first));
    const overlay = join(code.root, ".hunch-private");
    assert.equal(existsSync(join(overlay, ".git")), true, "the empty clone is retained for bounded later repair");

    const publisher = join(base, "publisher");
    mkdirSync(publisher, { recursive: true });
    git(publisher, "init", "-q", "-b", "main");
    configureRepo(publisher, "Memory Publisher");
    writeFileSync(join(publisher, "README.md"), "# Canonical team memory\n");
    git(publisher, "add", "README.md");
    git(publisher, "commit", "-qm", "fixture: publish canonical memory branch");
    git(publisher, "remote", "add", "origin", memoryRemote);
    git(publisher, "push", "-q", "origin", "main");
    const publishedHead = bareHead(memoryRemote);
    assert.equal(
      execFileSync("git", ["--git-dir", memoryRemote, "for-each-ref", "--format=%(refname)", "refs/heads"], {
        encoding: "utf8",
      }).trim(),
      "refs/heads/main",
      "repair is permitted only after exactly one canonical branch exists",
    );
    const codeHeadBefore = git(code.root, "rev-parse", "HEAD");
    const codeRemoteBefore = bareRefs(code.codeRemote);
    const memoryBeforeJoin = bareRefs(memoryRemote);
    const statusBeforeJoin = git(code.root, "status", "--porcelain=v1", "--untracked-files=all");

    const joined = runCli(code, ["check", "--working", "--strict"]);
    assert.equal(joined.error, undefined, joined.error?.message);
    assert.equal(joined.status, 0, output(joined));
    assert.equal(git(overlay, "rev-parse", "HEAD"), publishedHead);
    assert.equal(git(overlay, "rev-parse", "--abbrev-ref", "@{upstream}"), "origin/main");
    assert.equal(git(code.root, "status", "--porcelain=v1", "--untracked-files=all"), statusBeforeJoin);
    assert.equal(git(code.root, "rev-parse", "HEAD"), codeHeadBefore);
    assert.equal(bareRefs(code.codeRemote), codeRemoteBefore);
    assert.equal(bareRefs(memoryRemote), memoryBeforeJoin, "auto-join is read-only against team memory");
  } finally {
    rmSync(base, { recursive: true, force: true });
  }
});

test("a legacy team file derives a sole master branch without silently assuming main", { timeout: 90_000 }, () => {
  const base = mkdtempSync(join(tmpdir(), "hunch-legacy-master-route-"));
  try {
    const memoryRemote = makeMemoryRemote(base, "legacy-master-memory", "master", true);
    const code = makeCodeFixture(base, "legacy-master-code", memoryRemote);
    writeFileSync(join(code.root, "src/app.ts"), "export const transport = () => 'legacy-master';\n");
    const opened = runCli(code, ["check", "--working", "--strict"]);
    assert.equal(opened.status, 0, output(opened));
    const overlay = join(code.root, ".hunch-private");
    assert.equal(git(overlay, "rev-parse", "--abbrev-ref", "@{upstream}"), "origin/master");
    const team = JSON.parse(execFileSync("git", ["show", "HEAD:.hunch/team.json"], {
      cwd: code.root,
      encoding: "utf8",
    })) as { shared_repo: string; shared_ref?: string };
    assert.equal(team.shared_repo, memoryRemote);
    assert.equal(team.shared_ref, undefined, "the fixture exercises the pre-shared_ref format");

    const rule = "LEGACY_MASTER_ROUTE_STAYS_LIVE: never import axios";
    const captured = expectCli(code, [
      "record-constraint", rule,
      "--scope", "src/app.ts",
      "--severity", "blocking",
      "--forbid-dep", "axios",
    ], 0);
    assert.match(captured, /private memory committed \+ pushed/i, captured);
    assert.match(
      execFileSync("git", ["--git-dir", memoryRemote, "grep", "-F", rule, "refs/heads/master", "--", ".hunch/constraints"], { encoding: "utf8" }),
      new RegExp(rule),
    );
    assert.notEqual(
      spawnSync("git", ["--git-dir", memoryRemote, "show-ref", "--verify", "--quiet", "refs/heads/main"]).status,
      0,
      "legacy master is not silently forked into a new main graph",
    );
  } finally {
    rmSync(base, { recursive: true, force: true });
  }
});

test("fresh auto-join refuses an explicit team route whose remote has multiple heads", { timeout: 60_000 }, () => {
  const base = mkdtempSync(join(tmpdir(), "hunch-multihead-autojoin-"));
  try {
    const memoryRemote = makeMemoryRemote(base, "multihead-memory");
    execFileSync("git", ["--git-dir", memoryRemote, "update-ref", "refs/heads/alternate", "refs/heads/main"]);
    const code = makeCodeFixture(base, "multihead-code", memoryRemote);
    writeFileSync(join(code.root, ".hunch/team.json"), `${JSON.stringify({
      shared_repo: memoryRemote,
      shared_ref: "refs/heads/main",
    }, null, 2)}\n`);
    git(code.root, "add", ".hunch/team.json");
    git(code.root, "commit", "-qm", "fixture: make canonical team ref explicit");
    const statusBefore = git(code.root, "status", "--porcelain=v1", "--untracked-files=all");
    const refsBefore = bareRefs(memoryRemote);

    const result = runCli(code, ["check", "--working", "--strict"]);
    assert.equal(result.status, 1, output(result));
    assert.match(output(result), /team|overlay|remote|unavailable/i);
    assert.equal(existsSync(join(code.root, ".hunch-private")), false, "an invalid staged clone is never installed");
    assert.equal(readdirSync(code.root).some((name) => name.startsWith(".hunch-private.tmp-")), false,
      "temporary clone state is removed");
    assert.equal(existsSync(join(code.root, ".hunch/local.json")), false);
    assert.equal(git(code.root, "status", "--porcelain=v1", "--untracked-files=all"), statusBefore);
    assert.equal(bareRefs(memoryRemote), refsBefore);
  } finally {
    rmSync(base, { recursive: true, force: true });
  }
});

test("sameRemoteUrl preserves distinct local .git paths and generic SSH usernames", () => {
  const base = mkdtempSync(join(tmpdir(), "hunch-remote-identity-contract-"));
  try {
    const plain = join(base, "memory");
    const dotted = join(base, "memory.git");
    mkdirSync(plain);
    mkdirSync(dotted);
    assert.equal(sameRemoteUrl(plain, base, dotted, base), false,
      "two existing local paths remain distinct even when one ends in .git");
    assert.equal(
      sameRemoteUrl(
        "ssh://alice@git.example.test/x/memory.git", base,
        "ssh://bob@git.example.test/x/memory.git", base,
      ),
      false,
      "generic SSH account names are part of route identity",
    );
    assert.equal(
      sameRemoteUrl(
        "alice@git.example.test:x/memory.git", base,
        "bob@git.example.test:x/memory.git", base,
      ),
      false,
      "scp-style generic SSH account names are part of route identity",
    );
    assert.equal(
      sameRemoteUrl(
        "ssh://alice@git.example.test/x/memory.git", base,
        "https://git.example.test/x/memory.git", base,
      ),
      false,
      "generic transports are part of route identity",
    );
    assert.equal(
      sameRemoteUrl(
        "git@github.com:OpenAI/example.git", base,
        "https://github.com/openai/example", base,
      ),
      true,
      "known provider aliases remain intentionally equivalent",
    );
  } finally {
    rmSync(base, { recursive: true, force: true });
  }
});

function strictHookInput(root: string): string {
  return JSON.stringify({
    hook_event_name: "PreToolUse",
    session_id: `route-${root}`,
    tool_name: "Edit",
    tool_input: {
      file_path: join(root, "src/app.ts"),
      new_string: 'import axios from "axios";',
    },
  });
}

function recordBlockingRule(fixture: Fixture, statement: string): string {
  return expectCli(fixture, [
    "record-constraint", statement,
    "--scope", "src/app.ts",
    "--severity", "blocking",
    "--forbid-dep", "axios",
  ], 0);
}

test("strict PreToolUse is silent when fresh advertised team memory is unavailable", { timeout: 60_000 }, () => {
  const base = mkdtempSync(join(tmpdir(), "hunch-team-hook-unavailable-"));
  try {
    const code = makeCodeFixture(base, "hook-unavailable-code");
    recordBlockingRule(code, "PUBLIC_FALLBACK_RULE: never import axios in src/app.ts");
    const unavailable = join(base, "missing-memory.git");
    writeFileSync(join(code.root, ".hunch/team.json"), `${JSON.stringify({ shared_repo: unavailable }, null, 2)}\n`);
    writeFileSync(join(code.root, ".hunch/config.json"), "{\"firmness\":\"strict\"}\n");
    git(code.root, "add", ".hunch/team.json", ".hunch/config.json");
    git(code.root, "commit", "-qm", "fixture: advertise unavailable team memory");
    git(code.root, "push", "-q", "origin", "main");
    const codeHeadBefore = git(code.root, "rev-parse", "HEAD");
    const codeRemoteBefore = bareRefs(code.codeRemote);

    const result = runCli(code, ["hook", "--provider", "claude"], strictHookInput(code.root));
    assert.equal(result.error, undefined, result.error?.message);
    assert.equal(result.status, 0, output(result));
    assert.equal(output(result), "", "hook route failure must emit neither deny, allow, nor public grounding");
    assert.equal(git(code.root, "rev-parse", "HEAD"), codeHeadBefore);
    assert.equal(bareRefs(code.codeRemote), codeRemoteBefore);
  } finally {
    rmSync(base, { recursive: true, force: true });
  }
});

test("strict PreToolUse is silent when the local overlay route mismatches committed team memory", { timeout: 90_000 }, () => {
  const base = mkdtempSync(join(tmpdir(), "hunch-team-hook-mismatch-"));
  try {
    const fixture = makeSharedFixture(base, "hook-mismatch");
    const recorded = recordBlockingRule(fixture, "STALE_OVERLAY_RULE: never import axios in src/app.ts");
    assert.match(recorded, /private memory committed \+ pushed/, recorded);
    const replacementRemote = makeMemoryRemote(base, "hook-replacement-memory");
    writeFileSync(join(fixture.root, ".hunch/team.json"), `${JSON.stringify({ shared_repo: replacementRemote }, null, 2)}\n`);
    writeFileSync(join(fixture.root, ".hunch/config.json"), "{\"firmness\":\"strict\"}\n");
    git(fixture.root, "add", ".hunch/team.json", ".hunch/config.json");
    git(fixture.root, "commit", "-qm", "fixture: replace advertised team memory");
    git(fixture.root, "push", "-q", "origin", "main");
    const codeHeadBefore = git(fixture.root, "rev-parse", "HEAD");
    const codeRemoteBefore = bareRefs(fixture.codeRemote);
    const memoryABefore = bareRefs(fixture.memoryRemote);
    const memoryBBefore = bareRefs(replacementRemote);
    const overlayHeadBefore = git(fixture.overlay, "rev-parse", "HEAD");

    const result = runCli(fixture, ["hook", "--provider", "claude"], strictHookInput(fixture.root));
    assert.equal(result.error, undefined, result.error?.message);
    assert.equal(result.status, 0, output(result));
    assert.equal(output(result), "", "hook route mismatch must emit neither deny, allow, nor stale grounding");
    assert.equal(git(fixture.root, "rev-parse", "HEAD"), codeHeadBefore);
    assert.equal(bareRefs(fixture.codeRemote), codeRemoteBefore);
    assert.equal(bareRefs(fixture.memoryRemote), memoryABefore);
    assert.equal(bareRefs(replacementRemote), memoryBBefore);
    assert.equal(git(fixture.overlay, "rev-parse", "HEAD"), overlayHeadBefore);
  } finally {
    rmSync(base, { recursive: true, force: true });
  }
});

test("strict PreToolUse is silent when a configured team overlay is stale and its remote goes offline", { timeout: 90_000 }, () => {
  const base = mkdtempSync(join(tmpdir(), "hunch-team-hook-stale-offline-"));
  try {
    const fixture = makeSharedFixture(base, "hook-stale-offline");
    const rule = "STALE_OFFLINE_RULE_MUST_NOT_DENY: never import axios in src/app.ts";
    const recorded = recordBlockingRule(fixture, rule);
    assert.match(recorded, /private memory committed \+ pushed/i, recorded);
    writeFileSync(join(fixture.root, ".hunch/config.json"), "{\"firmness\":\"strict\"}\n");
    const unavailable = `${fixture.memoryRemote}.offline`;
    renameSync(fixture.memoryRemote, unavailable);
    const overlayHeadBefore = git(fixture.overlay, "rev-parse", "HEAD");
    const codeHeadBefore = git(fixture.root, "rev-parse", "HEAD");
    const codeRemoteBefore = bareRefs(fixture.codeRemote);

    const result = runCli(fixture, ["hook", "--provider", "claude"], strictHookInput(fixture.root));
    assert.equal(result.status, 0, output(result));
    assert.equal(output(result), "", "strict hook fail-opens instead of denying from stale local team rules");
    assert.equal(git(fixture.overlay, "rev-parse", "HEAD"), overlayHeadBefore);
    assert.equal(git(fixture.root, "rev-parse", "HEAD"), codeHeadBefore);
    assert.equal(bareRefs(fixture.codeRemote), codeRemoteBefore);
  } finally {
    rmSync(base, { recursive: true, force: true });
  }
});
