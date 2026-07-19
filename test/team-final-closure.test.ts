import assert from "node:assert/strict";
import { execFileSync, spawnSync } from "node:child_process";
import {
  chmodSync,
  existsSync,
  lstatSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  readdirSync,
  rmSync,
  watch,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join, relative } from "node:path";
import { test } from "node:test";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StdioClientTransport } from "@modelcontextprotocol/sdk/client/stdio.js";
import { SCHEMA_VERSION } from "../src/core/migrate.js";

const PROJECT_ROOT = process.cwd();
const TSX = join(PROJECT_ROOT, "node_modules/tsx/dist/cli.mjs");
const CLI = join(PROJECT_ROOT, "src/cli/index.ts");

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
  git(root, "config", "user.email", `${name.toLowerCase().replace(/[^a-z]+/g, "-")}@closure.test`);
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
    GIT_AUTHOR_NAME: "Closure Test",
    GIT_AUTHOR_EMAIL: "closure-test@closure.test",
    GIT_COMMITTER_NAME: "Closure Test",
    GIT_COMMITTER_EMAIL: "closure-test@closure.test",
    HUNCH_PRIVATE_DIR: "",
    HUNCH_SYNTH_PROVIDER: "deterministic",
    HUNCH_EMBEDDINGS: "off",
    NO_COLOR: "1",
    CI: "1",
  };
}

function runCli(fixture: Pick<Fixture, "root" | "env">, args: string[], timeout = 45_000) {
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

function waitUntil(predicate: () => boolean, timeoutMs: number): boolean {
  const started = Date.now();
  const sleeper = new Int32Array(new SharedArrayBuffer(4));
  while (Date.now() - started < timeoutMs) {
    if (predicate()) return true;
    Atomics.wait(sleeper, 0, 0, 100);
  }
  return predicate();
}

function expectCli(fixture: Pick<Fixture, "root" | "env">, args: string[], status = 0): string {
  const run = runCli(fixture, args);
  assert.equal(run.error, undefined, run.error?.message);
  assert.equal(run.signal, null, output(run));
  assert.equal(run.status, status, output(run));
  return output(run);
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

function bareFile(remote: string, path: string): string {
  return execFileSync("git", ["--git-dir", remote, "show", `refs/heads/main:${path}`], {
    encoding: "utf8",
  });
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
      else if (stat.isFile() && name.endsWith(".json")) {
        files.push([relative(hunch, path), readFileSync(path).toString("base64")]);
      }
    }
  };
  walk(hunch);
  return files;
}

function makeCodeFixture(
  base: string,
  name: string,
  populate?: (seed: string) => void,
): Fixture {
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
    name: "team-final-closure-fixture",
    private: true,
    type: "module",
    dependencies: { axios: "1.0.0" },
  }, null, 2)}\n`);
  writeFileSync(join(seed, "src/app.ts"), "export const transport = () => fetch('/orders');\n");
  populate?.(seed);
  git(seed, "add", "-A");
  git(seed, "commit", "-qm", "fixture: tiny code repository");
  git(base, "clone", "-q", "--bare", seed, codeRemote);
  git(base, "clone", "-q", codeRemote, root);
  configureRepo(root, name);
  return { root, home, env: actorEnv(home), codeRemote };
}

function makeMemoryRemote(
  base: string,
  name: string,
  populate: (seed: string) => void = (seed) => writeFileSync(join(seed, "README.md"), "# Shared memory\n"),
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

function makeEmptyMemoryRemote(base: string, name: string): string {
  const remote = join(base, `${name}.git`);
  git(base, "init", "-q", "--bare", "-b", "main", remote);
  return remote;
}

function writeTeamRoute(root: string, memoryRemote: string, sharedRef = "refs/heads/main"): void {
  mkdirSync(join(root, ".hunch"), { recursive: true });
  writeFileSync(join(root, ".hunch/team.json"), `${JSON.stringify({
    shared_repo: memoryRemote,
    shared_ref: sharedRef,
  }, null, 2)}\n`);
}

function makeSharedFixture(base: string, name: string): SharedFixture {
  const memoryRemote = makeMemoryRemote(base, `${name}-memory`);
  const code = makeCodeFixture(base, `${name}-code`);
  expectCli(code, ["shared", "--repo", memoryRemote, "--no-hook"]);
  expectCli(code, ["shared", "--sync"]);
  git(code.root, "add", ".gitignore", ".hunch/team.json");
  git(code.root, "commit", "-qm", "chore: advertise shared memory");
  git(code.root, "push", "-q", "origin", "main");
  return { ...code, memoryRemote, overlay: join(code.root, ".hunch-private") };
}

function installFailingPrePush(base: string, repo: string, name: string): string {
  const hooks = join(base, `${name}-hooks`);
  const marker = join(base, `${name}-pre-push-ran`);
  mkdirSync(hooks, { recursive: true });
  const hook = join(hooks, "pre-push");
  writeFileSync(hook, `#!/bin/sh\n: > ${JSON.stringify(marker)}\nexit 97\n`);
  chmodSync(hook, 0o755);
  git(repo, "config", "core.hooksPath", hooks);
  return marker;
}

function legacyDecision(id: string, title: string): Record<string, unknown> {
  return {
    id,
    title,
    status: "proposed",
    context: "Legacy context",
    decision: "Keep the team graph in one physical store.",
    consequences: [],
    alternatives_rejected: [],
    related_components: [],
    related_files: ["src/app.ts"],
    supersedes: null,
    caused_by_bug: null,
    commit: null,
    provenance: { source: "llm_draft", confidence: 0.3, evidence: [] },
    date: "2026-01-02T03:04:05.000Z",
  };
}

function makeExplicitOverlay(base: string, name: string, title: string): { root: string; hunch: string } {
  const root = join(base, name);
  const hunch = join(root, ".hunch");
  mkdirSync(join(hunch, "decisions"), { recursive: true });
  git(root, "init", "-q", "-b", "main");
  configureRepo(root, "Explicit Overlay");
  writeFileSync(join(hunch, "manifest.json"), `${JSON.stringify({ schema_version: SCHEMA_VERSION }, null, 2)}\n`);
  writeFileSync(join(hunch, "decisions/dec_explicit_authority.json"), `${JSON.stringify({
    ...legacyDecision("dec_explicit_authority", title),
    status: "accepted",
    valid_from: "2026-01-02T03:04:05.000Z",
    valid_to: null,
    superseded_by: null,
    retired: { symbols: [], deps: [] },
  }, null, 2)}\n`);
  git(root, "add", ".hunch");
  git(root, "commit", "-qm", "fixture: explicit overlay authority");
  return { root, hunch };
}

async function connectMcp(fixture: Fixture): Promise<Client> {
  const transport = new StdioClientTransport({
    command: process.execPath,
    args: [TSX, CLI, "mcp"],
    cwd: fixture.root,
    env: fixture.env,
  });
  const client = new Client({ name: "team-final-closure", version: "1.0.0" });
  await client.connect(transport);
  return client;
}

function toolText(response: { content: readonly unknown[] }): string {
  return response.content.flatMap((part) => {
    if (!part || typeof part !== "object") return [];
    const candidate = part as { type?: unknown; text?: unknown };
    return candidate.type === "text" && typeof candidate.text === "string" ? [candidate.text] : [];
  }).join("\n");
}

test("a live MCP refuses when team.json appears instead of serving its startup public graph", { timeout: 60_000 }, async () => {
  const base = mkdtempSync(join(tmpdir(), "hunch-live-route-closure-"));
  let client: Client | null = null;
  try {
    const memoryRemote = makeMemoryRemote(base, "late-team-memory");
    const code = makeCodeFixture(base, "late-team-code");
    client = await connectMcp(code);

    const initial = await client.callTool({ name: "hunch_query", arguments: { query: "startup graph" } });
    assert.notEqual(initial.isError, true, JSON.stringify(initial.content));

    mkdirSync(join(code.root, ".hunch"), { recursive: true });
    writeFileSync(join(code.root, ".hunch/team.json"), `${JSON.stringify({
      shared_repo: memoryRemote,
      shared_ref: "refs/heads/main",
    }, null, 2)}\n`);

    const publicBefore = jsonSnapshot(code.root);
    const statusBefore = git(code.root, "status", "--porcelain=v1", "--untracked-files=all");
    const codeHeadBefore = git(code.root, "rev-parse", "HEAD");
    const codeRemoteBefore = bareRefs(code.codeRemote);
    const memoryBefore = bareRefs(memoryRemote);

    const refused = await client.callTool({ name: "hunch_query", arguments: { query: "must reconnect" } });
    const refusalText = refused.content
      .filter((part): part is { type: "text"; text: string } => part.type === "text")
      .map((part) => part.text)
      .join("\n");
    assert.equal(refused.isError, true, JSON.stringify(refused.content));
    assert.match(refusalText, /routing changed.*reconnect|reconnect.*routing changed/i);
    assert.deepEqual(jsonSnapshot(code.root), publicBefore, "the refused request leaves public JSON byte-identical");
    assert.equal(existsSync(join(code.root, ".hunch/local.json")), false, "no shared pointer is auto-installed in-process");
    assert.equal(existsSync(join(code.root, ".hunch-private")), false, "no overlay is cloned by the stale process");
    assert.equal(git(code.root, "status", "--porcelain=v1", "--untracked-files=all"), statusBefore);
    assert.equal(git(code.root, "rev-parse", "HEAD"), codeHeadBefore);
    assert.equal(bareRefs(code.codeRemote), codeRemoteBefore);
    assert.equal(bareRefs(memoryRemote), memoryBefore, "the refused request never fetches from or publishes to team memory");
  } finally {
    if (client) await client.close().catch(() => undefined);
    rmSync(base, { recursive: true, force: true });
  }
});

test("an explicit HUNCH_PRIVATE_DIR remains authoritative when committed team routing exists and changes", { timeout: 60_000 }, async () => {
  const base = mkdtempSync(join(tmpdir(), "hunch-explicit-route-authority-"));
  let client: Client | null = null;
  try {
    const memoryA = makeMemoryRemote(base, "advertised-memory-a");
    const memoryB = makeMemoryRemote(base, "advertised-memory-b");
    const explicitTitle = "Explicit overlay authority sentinel";
    const explicit = makeExplicitOverlay(base, "explicit-overlay", explicitTitle);
    const code = makeCodeFixture(base, "explicit-route-code", (seed) => writeTeamRoute(seed, memoryA));
    const actor: Fixture = {
      ...code,
      env: { ...code.env, HUNCH_PRIVATE_DIR: explicit.hunch },
    };
    client = await connectMcp(actor);

    const initial = await client.callTool({
      name: "hunch_query",
      arguments: { query: "explicit overlay authority sentinel" },
    });
    assert.notEqual(initial.isError, true, JSON.stringify(initial.content));
    assert.match(toolText(initial), new RegExp(explicitTitle, "i"), "the startup graph includes the explicit overlay");

    writeTeamRoute(code.root, memoryB);
    const rule = "EXPLICIT_ENV_AFTER_TEAM_CHANGE: never import axios in src/app.ts";
    const explicitBefore = jsonSnapshot(explicit.root);
    const publicBefore = jsonSnapshot(code.root);
    const statusBefore = git(code.root, "status", "--porcelain=v1", "--untracked-files=all");
    const codeHeadBefore = git(code.root, "rev-parse", "HEAD");
    const codeRemoteBefore = bareRefs(code.codeRemote);
    const memoryABefore = bareRefs(memoryA);
    const memoryBBefore = bareRefs(memoryB);

    const written = await client.callTool({
      name: "hunch_record_correction",
      arguments: {
        rule,
        scope_hint_file: "src/app.ts",
        severity: "blocking",
        private: true,
      },
    });

    assert.notEqual(written.isError, true, JSON.stringify(written.content));
    assert.match(toolText(written), /PRIVATE overlay/i);
    assert.notDeepEqual(jsonSnapshot(explicit.root), explicitBefore, "the callback writes to the explicit overlay");
    const explicitText = jsonSnapshot(explicit.root)
      .map(([, bytes]) => Buffer.from(bytes, "base64").toString("utf8"))
      .join("\n");
    assert.ok(explicitText.includes(rule), "the correction is persisted only in the explicit overlay");
    assert.deepEqual(jsonSnapshot(code.root), publicBefore, "the explicit private write leaves public JSON unchanged");
    assert.equal(existsSync(join(code.root, ".hunch-private")), false, "committed team routing never auto-clones over an explicit env route");
    assert.equal(git(code.root, "status", "--porcelain=v1", "--untracked-files=all"), statusBefore);
    assert.equal(git(code.root, "rev-parse", "HEAD"), codeHeadBefore);
    assert.equal(bareRefs(code.codeRemote), codeRemoteBefore);
    assert.equal(bareRefs(memoryA), memoryABefore);
    assert.equal(bareRefs(memoryB), memoryBBefore, "neither advertised team remote is touched by the explicit-overlay process");
  } finally {
    if (client) await client.close().catch(() => undefined);
    rmSync(base, { recursive: true, force: true });
  }
});

test("a live advertised-team MCP refuses a coherent team URL and overlay-origin reroute", { timeout: 90_000 }, async () => {
  const base = mkdtempSync(join(tmpdir(), "hunch-live-url-reroute-"));
  let client: Client | null = null;
  try {
    const fixture = makeSharedFixture(base, "live-url-reroute");
    const memoryB = join(base, "live-url-reroute-memory-b.git");
    git(base, "clone", "-q", "--bare", fixture.memoryRemote, memoryB);
    client = await connectMcp(fixture);
    const initial = await client.callTool({ name: "hunch_query", arguments: { query: "startup team graph" } });
    assert.notEqual(initial.isError, true, JSON.stringify(initial.content));

    // Change both halves together. A guard that only checks their current
    // agreement will miss that this long-lived process started on another graph.
    git(fixture.overlay, "remote", "set-url", "origin", memoryB);
    writeTeamRoute(fixture.root, memoryB);
    const callbackRule = "COHERENT_URL_REROUTE_MUST_NOT_REACH_CALLBACK";
    const publicBefore = jsonSnapshot(fixture.root);
    const overlayBefore = jsonSnapshot(fixture.overlay);
    const statusBefore = git(fixture.root, "status", "--porcelain=v1", "--untracked-files=all");
    const overlayStatusBefore = git(fixture.overlay, "status", "--porcelain=v1", "--untracked-files=all");
    const codeHeadBefore = git(fixture.root, "rev-parse", "HEAD");
    const overlayHeadBefore = git(fixture.overlay, "rev-parse", "HEAD");
    const overlayRefsBefore = git(fixture.overlay, "for-each-ref", "--format=%(refname):%(objectname)");
    const codeRemoteBefore = bareRefs(fixture.codeRemote);
    const memoryABefore = bareRefs(fixture.memoryRemote);
    const memoryBBefore = bareRefs(memoryB);

    const refused = await client.callTool({
      name: "hunch_record_correction",
      arguments: {
        rule: callbackRule,
        scope_hint_file: "src/app.ts",
        severity: "blocking",
      },
    });

    assert.equal(refused.isError, true, JSON.stringify(refused.content));
    assert.match(toolText(refused), /route|routing|destination|stale|URL|branch|graph/i);
    assert.match(toolText(refused), /reconnect/i);
    assert.deepEqual(jsonSnapshot(fixture.root), publicBefore, "the refusal leaves public JSON byte-identical");
    assert.deepEqual(jsonSnapshot(fixture.overlay), overlayBefore, "the write callback never mutates the rerouted overlay graph");
    assert.equal(git(fixture.root, "status", "--porcelain=v1", "--untracked-files=all"), statusBefore);
    assert.equal(git(fixture.overlay, "status", "--porcelain=v1", "--untracked-files=all"), overlayStatusBefore);
    assert.equal(git(fixture.root, "rev-parse", "HEAD"), codeHeadBefore);
    assert.equal(git(fixture.overlay, "rev-parse", "HEAD"), overlayHeadBefore);
    assert.equal(git(fixture.overlay, "for-each-ref", "--format=%(refname):%(objectname)"), overlayRefsBefore);
    assert.equal(bareRefs(fixture.codeRemote), codeRemoteBefore);
    assert.equal(bareRefs(fixture.memoryRemote), memoryABefore);
    assert.equal(bareRefs(memoryB), memoryBBefore, "the stale process publishes to neither old nor new memory remote");
  } finally {
    if (client) await client.close().catch(() => undefined);
    rmSync(base, { recursive: true, force: true });
  }
});

test("a live advertised-team MCP refuses a coherent shared_ref semantic reroute", { timeout: 90_000 }, async () => {
  const base = mkdtempSync(join(tmpdir(), "hunch-live-ref-reroute-"));
  let client: Client | null = null;
  try {
    const fixture = makeSharedFixture(base, "live-ref-reroute");
    client = await connectMcp(fixture);
    const initial = await client.callTool({ name: "hunch_query", arguments: { query: "startup team graph" } });
    assert.notEqual(initial.isError, true, JSON.stringify(initial.content));

    // The file remains present and parseable; only its canonical graph branch
    // changes. Existence-only route guards must not treat that as the same route.
    writeTeamRoute(fixture.root, fixture.memoryRemote, "refs/heads/alternate");

    const callbackRule = "COHERENT_SHARED_REF_REROUTE_MUST_NOT_REACH_CALLBACK";
    const publicBefore = jsonSnapshot(fixture.root);
    const overlayBefore = jsonSnapshot(fixture.overlay);
    const statusBefore = git(fixture.root, "status", "--porcelain=v1", "--untracked-files=all");
    const overlayStatusBefore = git(fixture.overlay, "status", "--porcelain=v1", "--untracked-files=all");
    const codeHeadBefore = git(fixture.root, "rev-parse", "HEAD");
    const overlayHeadBefore = git(fixture.overlay, "rev-parse", "HEAD");
    const overlayRefsBefore = git(fixture.overlay, "for-each-ref", "--format=%(refname):%(objectname)");
    const codeRemoteBefore = bareRefs(fixture.codeRemote);
    const memoryBefore = bareRefs(fixture.memoryRemote);

    const refused = await client.callTool({
      name: "hunch_record_correction",
      arguments: {
        rule: callbackRule,
        scope_hint_file: "src/app.ts",
        severity: "blocking",
      },
    });

    assert.equal(refused.isError, true, JSON.stringify(refused.content));
    assert.match(toolText(refused), /route|routing|destination|stale|URL|branch|graph/i);
    assert.match(toolText(refused), /reconnect/i);
    assert.deepEqual(jsonSnapshot(fixture.root), publicBefore);
    assert.deepEqual(jsonSnapshot(fixture.overlay), overlayBefore, "the semantic ref change cannot reach the write callback");
    assert.equal(git(fixture.root, "status", "--porcelain=v1", "--untracked-files=all"), statusBefore);
    assert.equal(git(fixture.overlay, "status", "--porcelain=v1", "--untracked-files=all"), overlayStatusBefore);
    assert.equal(git(fixture.root, "rev-parse", "HEAD"), codeHeadBefore);
    assert.equal(git(fixture.overlay, "rev-parse", "HEAD"), overlayHeadBefore);
    assert.equal(git(fixture.overlay, "for-each-ref", "--format=%(refname):%(objectname)"), overlayRefsBefore);
    assert.equal(bareRefs(fixture.codeRemote), codeRemoteBefore);
    assert.equal(bareRefs(fixture.memoryRemote), memoryBefore);
  } finally {
    if (client) await client.close().catch(() => undefined);
    rmSync(base, { recursive: true, force: true });
  }
});

test("an MCP write pins its startup contract when routing changes after the record mutation", { timeout: 120_000 }, async () => {
  const base = mkdtempSync(join(tmpdir(), "hunch-handler-route-race-"));
  let client: Client | null = null;
  try {
    const fixture = makeSharedFixture(base, "handler-route-race");
    // Make the synchronous post-write reindex wide enough for the parent to
    // deterministically repoint routing after the atomic record file appears,
    // but before the handler reaches its flush seam.
    const decisions = join(fixture.overlay, ".hunch/decisions");
    mkdirSync(decisions, { recursive: true });
    for (let i = 0; i < 800; i++) {
      const id = `dec_handler_race_${String(i).padStart(4, "0")}`;
      writeFileSync(join(decisions, `${id}.json`), `${JSON.stringify(legacyDecision(id, `Handler race ballast ${i}`), null, 2)}\n`);
    }
    git(fixture.overlay, "add", ".hunch/decisions");
    git(fixture.overlay, "commit", "-qm", "fixture: widen handler route race window");
    git(fixture.overlay, "push", "-q", "origin", "main");
    const memoryB = join(base, "handler-route-race-memory-b.git");
    git(base, "clone", "-q", "--bare", fixture.memoryRemote, memoryB);
    client = await connectMcp(fixture);
    const initial = await client.callTool({ name: "hunch_query", arguments: { query: "handler race ballast" } });
    assert.notEqual(initial.isError, true, JSON.stringify(initial.content));

    const rule = "HANDLER_TIME_REROUTE_MUST_NOT_PUBLISH_TO_EITHER_GRAPH";
    const constraintsDir = join(fixture.overlay, ".hunch/constraints");
    const memoryABefore = bareRefs(fixture.memoryRemote);
    const memoryBBefore = bareRefs(memoryB);
    const codeRemoteBefore = bareRefs(fixture.codeRemote);
    let rerouted = false;
    let resolveRerouted!: () => void;
    const reroutedPromise = new Promise<void>((resolve) => { resolveRerouted = resolve; });
    const watcher = watch(constraintsDir, () => {
      if (rerouted) return;
      const landed = readdirSync(constraintsDir).some((name) => {
        try { return readFileSync(join(constraintsDir, name), "utf8").includes(rule); }
        catch { return false; }
      });
      if (!landed) return;
      rerouted = true;
      git(fixture.overlay, "remote", "set-url", "origin", memoryB);
      writeTeamRoute(fixture.root, memoryB);
      resolveRerouted();
    });
    try {
      const write = client.callTool({
        name: "hunch_record_correction",
        arguments: { rule, scope_hint_file: "src/app.ts", severity: "blocking" },
      });
      let rerouteTimeout!: NodeJS.Timeout;
      await Promise.race([
        reroutedPromise,
        new Promise<never>((_, reject) => {
          rerouteTimeout = setTimeout(() => reject(new Error("record mutation was not observed")), 20_000);
        }),
      ]).finally(() => clearTimeout(rerouteTimeout));
      const result = await write;
      assert.equal(result.isError, true, JSON.stringify(result.content));
      assert.match(toolText(result), /route changed while|reconnect|startup destination/i);
    } finally {
      watcher.close();
    }
    assert.equal(bareRefs(fixture.memoryRemote), memoryABefore, "captured startup contract refuses publication after reroute");
    assert.equal(bareRefs(memoryB), memoryBBefore, "the handler never recomputes and publishes to the new route");
    assert.equal(bareRefs(fixture.codeRemote), codeRemoteBefore);

    await client.close();
    client = null;
    let reconnected: Client | null = null;
    await assert.rejects(async () => {
      reconnected = await connectMcp(fixture);
    }, /unavailable|different remote|route|closed|connection/i,
    "the A-bound overlay is quarantined instead of being reused as graph B");
    if (reconnected) await (reconnected as Client).close().catch(() => undefined);
    const nextCapture = runCli(fixture, [
      "record-constraint", "HANDLER_RACE_FOLLOWUP_CAPTURE",
      "--scope", "src/app.ts",
      "--severity", "warning",
    ]);
    assert.equal(nextCapture.status, 1, output(nextCapture));
    assert.equal(bareRefs(memoryB), memoryBBefore, "a later command cannot sweep the refused A record into B");
    const leaked = spawnSync("git", [
      "--git-dir", memoryB,
      "grep", "-F", rule, "refs/heads/main", "--", ".hunch/constraints",
    ], { encoding: "utf8", stdio: "ignore" });
    assert.notEqual(leaked.status, 0, "the refused race sentinel remains absent from graph B after reconnect/capture attempts");
  } finally {
    if (client) await client.close().catch(() => undefined);
    rmSync(base, { recursive: true, force: true });
  }
});

test("automatic shared capture pushes with repository pre-push hooks disabled", { timeout: 90_000 }, () => {
  const base = mkdtempSync(join(tmpdir(), "hunch-auto-push-hook-closure-"));
  try {
    const fixture = makeSharedFixture(base, "automatic-push");
    const marker = installFailingPrePush(base, fixture.overlay, "automatic-push");
    const sentinel = "AUTOMATIC_TEAM_PUSH_MUST_BYPASS_PRE_PUSH_HOOK";
    const publicBefore = jsonSnapshot(fixture.root);
    const codeHeadBefore = git(fixture.root, "rev-parse", "HEAD");
    const codeRemoteBefore = bareRefs(fixture.codeRemote);
    const memoryHeadBefore = bareHead(fixture.memoryRemote);

    const recorded = expectCli(fixture, [
      "record-constraint", sentinel,
      "--scope", "src/app.ts",
      "--severity", "blocking",
      "--forbid-dep", "axios",
    ]);

    assert.match(recorded, /private memory committed \+ pushed/, recorded);
    assert.equal(existsSync(marker), false, "the overlay repository's pre-push hook must not execute");
    assert.notEqual(bareHead(fixture.memoryRemote), memoryHeadBefore, "the normal automatic push reaches team memory");
    assert.match(
      execFileSync("git", ["--git-dir", fixture.memoryRemote, "grep", "-F", sentinel, "refs/heads/main", "--", ".hunch/constraints"], { encoding: "utf8" }),
      new RegExp(sentinel),
    );
    assert.deepEqual(jsonSnapshot(fixture.root), publicBefore, "unified capture never forks a public JSON copy");
    assert.equal(git(fixture.root, "rev-parse", "HEAD"), codeHeadBefore);
    assert.equal(bareRefs(fixture.codeRemote), codeRemoteBefore, "memory automation never pushes code history");
  } finally {
    rmSync(base, { recursive: true, force: true });
  }
});

test("a truly empty shared remote boots on the first unified capture and auto-joins a second actor", { timeout: 120_000 }, () => {
  const base = mkdtempSync(join(tmpdir(), "hunch-empty-first-capture-closure-"));
  try {
    const memoryRemote = makeEmptyMemoryRemote(base, "empty-first-memory");
    const code = makeCodeFixture(base, "empty-first-code");
    for (const key of ["GIT_AUTHOR_NAME", "GIT_AUTHOR_EMAIL", "GIT_COMMITTER_NAME", "GIT_COMMITTER_EMAIL"]) {
      delete code.env[key];
    }
    execFileSync("git", ["config", "--file", join(code.home, ".gitconfig"), "commit.gpgsign", "true"]);
    assert.equal(bareRefs(memoryRemote), "", "the setup starts against a truly empty remote");

    const setup = expectCli(code, ["shared", "--repo", memoryRemote, "--no-hook"]);
    assert.match(setup, /published \.hunch\/team\.json/i, setup);
    assert.equal(bareRefs(memoryRemote), "", "setup alone does not invent a memory commit");
    const team = JSON.parse(readFileSync(join(code.root, ".hunch/team.json"), "utf8")) as {
      shared_repo: string;
      shared_ref: string;
    };
    assert.equal(team.shared_repo, memoryRemote);
    assert.equal(team.shared_ref, "refs/heads/main");

    git(code.root, "add", ".gitignore", ".hunch/team.json");
    git(code.root, "commit", "-qm", "chore: advertise empty team memory");
    git(code.root, "push", "-q", "origin", "main");
    const advertisedCodeHead = git(code.root, "rev-parse", "HEAD");
    const codeRemoteBeforeCapture = bareRefs(code.codeRemote);
    const publicBeforeCapture = jsonSnapshot(code.root);
    const overlay = join(code.root, ".hunch-private");
    const marker = installFailingPrePush(base, overlay, "empty-first-capture");
    const rule = "EMPTY_REMOTE_FIRST_CAPTURE_SPINE: never import axios in src/app.ts";

    const captured = expectCli(code, [
      "record-constraint", rule,
      "--scope", "src/app.ts",
      "--severity", "blocking",
      "--forbid-dep", "axios",
    ]);
    assert.match(captured, /private memory committed \+ pushed/i, captured);
    assert.equal(existsSync(marker), false, "the first contract push bypasses repository pre-push hooks");
    assert.match(bareRefs(memoryRemote), /^refs\/heads\/main:[0-9a-f]+$/);
    assert.match(
      execFileSync("git", ["--git-dir", memoryRemote, "grep", "-F", rule, "refs/heads/main", "--", ".hunch/constraints"], { encoding: "utf8" }),
      new RegExp(rule),
    );
    assert.equal(git(overlay, "rev-parse", "--abbrev-ref", "@{upstream}"), "origin/main");
    assert.deepEqual(jsonSnapshot(code.root), publicBeforeCapture, "the first capture creates no public memory copy");
    assert.equal(git(code.root, "rev-parse", "HEAD"), advertisedCodeHead);
    assert.equal(bareRefs(code.codeRemote), codeRemoteBeforeCapture, "memory capture does not move code history");

    const secondRoot = join(base, "second-actor");
    git(base, "clone", "-q", code.codeRemote, secondRoot);
    configureRepo(secondRoot, "Second Actor");
    const secondHome = join(base, "second-actor-home");
    const second: Fixture = {
      root: secondRoot,
      home: secondHome,
      env: actorEnv(secondHome),
      codeRemote: code.codeRemote,
    };
    const memoryBeforeJoin = bareRefs(memoryRemote);
    const codeBeforeJoin = bareRefs(code.codeRemote);
    const queried = expectCli(second, ["query", "EMPTY_REMOTE_FIRST_CAPTURE_SPINE"]);
    assert.match(queried, new RegExp(rule));
    const secondOverlay = join(secondRoot, ".hunch-private");
    assert.equal(git(secondOverlay, "rev-parse", "--abbrev-ref", "@{upstream}"), "origin/main");
    assert.equal(bareRefs(memoryRemote), memoryBeforeJoin, "auto-join reads but does not publish team memory");
    assert.equal(bareRefs(code.codeRemote), codeBeforeJoin, "auto-join never mutates the code remote");
    assert.equal(existsSync(join(secondRoot, ".hunch/constraints")), false, "the second actor also has no public rule copy");
  } finally {
    rmSync(base, { recursive: true, force: true });
  }
});

test("the real shared post-commit hook clears code-repository Git env and publishes to memory", { timeout: 120_000 }, () => {
  const base = mkdtempSync(join(tmpdir(), "hunch-real-hook-env-closure-"));
  try {
    const memoryRemote = makeMemoryRemote(base, "real-hook-memory");
    const code = makeCodeFixture(base, "real-hook-code");
    expectCli(code, ["shared", "--repo", memoryRemote]);
    git(code.root, "add", ".gitignore", ".hunch/team.json");
    const advertised = spawnSync("git", ["commit", "-qm", "chore: advertise team memory"], {
      cwd: code.root,
      env: { ...code.env, HUNCH_SYNC: "1" },
      encoding: "utf8",
    });
    assert.equal(advertised.status, 0, output(advertised as ReturnType<typeof runCli>));
    git(code.root, "push", "-q", "origin", "main");
    const codeRemoteBefore = bareRefs(code.codeRemote);
    const memoryBefore = bareRefs(memoryRemote);
    const publicBefore = jsonSnapshot(code.root);

    writeFileSync(join(code.root, "src/app.ts"), [
      "// REAL_POST_COMMIT_TEAM_SPINE",
      "export const transport = () => fetch('/orders', { method: 'POST' });",
      "",
    ].join("\n"));
    git(code.root, "add", "src/app.ts");
    const committed = spawnSync("git", [
      "commit", "-m", "feat: route orders through the team spine",
      "-m", "Keep the order transport decision visible to every teammate.",
    ], {
      cwd: code.root,
      env: code.env,
      encoding: "utf8",
      timeout: 20_000,
    });
    assert.equal(committed.status, 0, `${committed.stdout ?? ""}${committed.stderr ?? ""}`);
    assert.equal(waitUntil(() => bareRefs(memoryRemote) !== memoryBefore, 30_000), true,
      "the background post-commit hook must advance the memory remote");
    assert.match(
      execFileSync("git", [
        "--git-dir", memoryRemote,
        "grep", "-F", "src/app.ts", "refs/heads/main", "--", ".hunch/decisions",
      ], { encoding: "utf8" }),
      /src\/app\.ts/,
      "the real hook captured the committed code decision in the shared graph",
    );
    assert.deepEqual(jsonSnapshot(code.root), publicBefore, "the hook creates no public memory copy");
    assert.equal(bareRefs(code.codeRemote), codeRemoteBefore, "the hook never pushes the code repository");
  } finally {
    rmSync(base, { recursive: true, force: true });
  }
});

test("explicit shared attach merges and pushes with repository pre-push hooks disabled", { timeout: 90_000 }, () => {
  const base = mkdtempSync(join(tmpdir(), "hunch-attach-push-hook-closure-"));
  try {
    const memoryRemote = makeMemoryRemote(base, "attach-memory");
    const code = makeCodeFixture(base, "attach-code");
    const overlay = join(code.root, ".hunch-private");
    mkdirSync(overlay, { recursive: true });
    git(overlay, "init", "-q", "-b", "main");
    configureRepo(overlay, "Existing Local Memory");
    writeFileSync(join(overlay, "LOCAL_SENTINEL.txt"), "existing local team memory\n");
    git(overlay, "add", "LOCAL_SENTINEL.txt");
    git(overlay, "commit", "-qm", "fixture: existing local memory");
    const marker = installFailingPrePush(base, overlay, "attach-push");
    const codeHeadBefore = git(code.root, "rev-parse", "HEAD");
    const codeRemoteBefore = bareRefs(code.codeRemote);
    const memoryHeadBefore = bareHead(memoryRemote);

    const attached = expectCli(code, ["shared", "--repo", memoryRemote, "--no-hook"]);

    assert.match(attached, /attached the existing local store.*merged \+ pushed/, attached);
    assert.equal(existsSync(marker), false, "the existing overlay's pre-push hook must not execute");
    assert.notEqual(bareHead(memoryRemote), memoryHeadBefore, "the attach path publishes the converged graph");
    assert.equal(bareFile(memoryRemote, "LOCAL_SENTINEL.txt"), "existing local team memory\n");
    assert.equal(git(code.root, "rev-parse", "HEAD"), codeHeadBefore);
    assert.equal(bareRefs(code.codeRemote), codeRemoteBefore, "explicit attach never pushes the code repository");
  } finally {
    rmSync(base, { recursive: true, force: true });
  }
});

test("migrate in unified shared mode upgrades only overlay JSON and publishes that overlay", { timeout: 90_000 }, () => {
  const base = mkdtempSync(join(tmpdir(), "hunch-unified-migrate-closure-"));
  try {
    const overlayId = "dec_overlay_legacy";
    const publicId = "dec_public_legacy_sentinel";
    const memoryRemote = makeMemoryRemote(base, "legacy-memory", (seed) => {
      mkdirSync(join(seed, ".hunch/decisions"), { recursive: true });
      writeFileSync(join(seed, ".hunch/manifest.json"), "{\n  \"schema_version\": 1\n}\n");
      writeFileSync(
        join(seed, `.hunch/decisions/${overlayId}.json`),
        `${JSON.stringify(legacyDecision(overlayId, "Overlay legacy record"), null, 2)}\n`,
      );
    });
    const code = makeCodeFixture(base, "legacy-code", (seed) => {
      mkdirSync(join(seed, ".hunch/decisions"), { recursive: true });
      writeFileSync(
        join(seed, ".hunch/manifest.json"),
        `{\n    \"schema_version\": ${SCHEMA_VERSION}\n}\n`,
      );
      writeFileSync(
        join(seed, `.hunch/decisions/${publicId}.json`),
        `${JSON.stringify(legacyDecision(publicId, "Public byte sentinel"), null, 4)}\n`,
      );
    });

    expectCli(code, ["shared", "--repo", memoryRemote, "--no-hook"]);
    git(code.root, "add", ".gitignore", ".hunch/team.json");
    git(code.root, "commit", "-qm", "chore: advertise legacy shared memory");
    git(code.root, "push", "-q", "origin", "main");

    const overlay = join(code.root, ".hunch-private");
    const overlayManifest = join(overlay, ".hunch/manifest.json");
    const overlayRecord = join(overlay, `.hunch/decisions/${overlayId}.json`);
    assert.equal(JSON.parse(readFileSync(overlayManifest, "utf8")).schema_version, 1, "fixture starts at schema v1");
    const overlayRecordBefore = readFileSync(overlayRecord, "utf8");
    const publicBefore = jsonSnapshot(code.root);
    const codeHeadBefore = git(code.root, "rev-parse", "HEAD");
    const codeRemoteBefore = bareRefs(code.codeRemote);
    const memoryHeadBefore = bareHead(memoryRemote);

    const migrated = expectCli(code, ["migrate"]);

    assert.match(migrated, new RegExp(`Migrated v1.*v${SCHEMA_VERSION}`), migrated);
    assert.equal(JSON.parse(readFileSync(overlayManifest, "utf8")).schema_version, SCHEMA_VERSION);
    assert.notEqual(readFileSync(overlayRecord, "utf8"), overlayRecordBefore, "the overlay's legacy record is persistently rewritten");
    const upgraded = JSON.parse(readFileSync(overlayRecord, "utf8")) as {
      valid_from?: string;
      valid_to?: string | null;
      superseded_by?: string | null;
      retired?: { symbols?: unknown[]; deps?: unknown[] };
    };
    assert.equal(upgraded.valid_from, "2026-01-02T03:04:05.000Z");
    assert.equal(upgraded.valid_to, null);
    assert.equal(upgraded.superseded_by, null);
    assert.deepEqual(upgraded.retired, { symbols: [], deps: [] });
    assert.deepEqual(jsonSnapshot(code.root), publicBefore, "public manifest and records remain byte-identical");
    assert.equal(git(code.root, "rev-parse", "HEAD"), codeHeadBefore);
    assert.equal(bareRefs(code.codeRemote), codeRemoteBefore, "migration never advances code history");
    assert.notEqual(bareHead(memoryRemote), memoryHeadBefore, "the overlay migration is committed and pushed");
    assert.equal(bareFile(memoryRemote, ".hunch/manifest.json"), readFileSync(overlayManifest, "utf8"));
    assert.equal(bareFile(memoryRemote, `.hunch/decisions/${overlayId}.json`), readFileSync(overlayRecord, "utf8"));
  } finally {
    rmSync(base, { recursive: true, force: true });
  }
});
