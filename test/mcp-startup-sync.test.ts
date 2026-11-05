import { test } from "node:test";
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { mkdirSync, mkdtempSync, realpathSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";
import { StdioClientTransport } from "@modelcontextprotocol/sdk/client/stdio.js";
import { gitCommonDir } from "../src/extractors/git.js";
import { buildServerWithRootControl } from "../src/mcp/server.js";
import { HunchStore } from "../src/store/hunchStore.js";
import { hunchCliArgs } from "./cli-invocation.js";
import { cleanupDir } from "./helpers.js";

function git(cwd: string, ...args: string[]): string {
  return execFileSync("git", args, { cwd, encoding: "utf8", stdio: ["ignore", "pipe", "ignore"] }).trim();
}

/** A record the store accepts, findable by its id with the underscores removed. */
function peerDecision(id: string): string {
  const now = "2026-11-05T00:00:00.000Z";
  return `${JSON.stringify({
    id,
    title: `Peer decision ${id.replaceAll("_", "")}`,
    status: "accepted",
    context: "Captured on another machine.",
    decision: "Reaches this machine through the overlay remote.",
    consequences: [],
    alternatives_rejected: [],
    rejected_tripwires: [],
    related_components: [],
    related_files: [],
    supersedes: null,
    superseded_by: null,
    caused_by_bug: null,
    commit: null,
    valid_from: now,
    valid_to: null,
    retired: { symbols: [], deps: [] },
    provenance: { source: "human_confirmed", confidence: 1, evidence: ["test:peer"] },
    date: now,
  })}\n`;
}

function firstText(result: unknown): string {
  return (result as { content: Array<{ text: string }> }).content[0]!.text;
}

function configure(repo: string): void {
  git(repo, "config", "user.email", "mcp-startup@example.invalid");
  git(repo, "config", "user.name", "MCP Startup Test");
}

/** A code repo whose private overlay is one commit behind its remote. */
function behindOverlay(): {
  root: string;
  overlay: string;
  peerHead: () => string;
  overlayHead: () => string;
  pushFromPeer: (id: string) => void;
  cleanup: () => void;
} {
  const base = mkdtempSync(join(realpathSync(tmpdir()), "hunch-mcp-startup-"));

  const remote = join(base, "memory.git");
  git(base, "init", "--bare", "-q", "-b", "main", remote);
  const peer = join(base, "peer");
  mkdirSync(join(peer, ".hunch", "decisions"), { recursive: true });
  git(peer, "init", "-q", "-b", "main", ".");
  configure(peer);
  git(peer, "remote", "add", "origin", remote);
  writeFileSync(join(peer, ".hunch", "manifest.json"), '{"schema_version":1}\n');
  git(peer, "add", "-A");
  git(peer, "commit", "-qm", "seed");
  git(peer, "push", "-q", "origin", "main");

  const overlay = join(base, "overlay");
  git(base, "clone", "-q", remote, overlay);
  configure(overlay);

  const root = join(base, "code");
  mkdirSync(join(root, ".hunch"), { recursive: true });
  git(root, "init", "-q", "-b", "main", ".");
  configure(root);
  writeFileSync(join(root, ".hunch", "seed.json"), "{}\n");
  git(root, "add", "-A");
  git(root, "commit", "-qm", "fixture");
  const common = gitCommonDir(root);
  mkdirSync(join(common, "hunch"), { recursive: true });
  writeFileSync(join(common, "hunch", "local.json"), `${JSON.stringify({ privateDir: join(overlay, ".hunch"), autoCommit: false })}\n`);

  const pushFromPeer = (id: string): void => {
    writeFileSync(join(peer, ".hunch", "decisions", `${id}.json`), peerDecision(id));
    git(peer, "add", "-A");
    git(peer, "commit", "-qm", id);
    git(peer, "push", "-q", "origin", "main");
  };
  pushFromPeer("dec_peer_first");

  return {
    root,
    overlay,
    peerHead: () => git(peer, "rev-parse", "HEAD"),
    overlayHead: () => git(overlay, "rev-parse", "HEAD"),
    pushFromPeer,
    cleanup: () => cleanupDir(base),
  };
}

function countReindexes(t: { after: (fn: () => void) => void }): () => number {
  const original = HunchStore.prototype.reindexFresh;
  let count = 0;
  HunchStore.prototype.reindexFresh = function counted(this: HunchStore) {
    count++;
    return original.call(this);
  };
  t.after(() => { HunchStore.prototype.reindexFresh = original; });
  return () => count;
}

async function connected(control: ReturnType<typeof buildServerWithRootControl>): Promise<Client> {
  const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
  const client = new Client({ name: "mcp-startup-test", version: "0.0.0" });
  await Promise.all([control.server.connect(serverTransport), client.connect(clientTransport)]);
  return client;
}

test("a deferred server validates its root without pulling or reindexing", async (t) => {
  const fixture = behindOverlay();
  const reindexes = countReindexes(t);
  const before = fixture.overlayHead();

  const control = buildServerWithRootControl(fixture.root, { deferStartupSync: true });
  t.after(async () => { await control.server.close(); fixture.cleanup(); });

  assert.equal(fixture.overlayHead(), before, "construction must not pull the overlay");
  assert.equal(reindexes(), 0, "construction must not rebuild the index");
});

test("the first tool call takes over a deferred startup sync, once, for a private overlay", async (t) => {
  const fixture = behindOverlay();
  const reindexes = countReindexes(t);
  const control = buildServerWithRootControl(fixture.root, { deferStartupSync: true });
  t.after(async () => { await control.server.close(); fixture.cleanup(); });
  const client = await connected(control);

  const first = await client.callTool({ name: "hunch_query", arguments: { query: "decpeerfirst" } });
  assert.equal(!!first.isError, false);
  assert.match(firstText(first), /decpeerfirst/, "the first call must answer from pulled memory");
  assert.equal(fixture.overlayHead(), fixture.peerHead());
  assert.ok(reindexes() >= 1, "the first call serves a rebuilt index");

  // Private overlays pull only at startup, so a later peer commit must stay remote.
  const pulled = fixture.overlayHead();
  fixture.pushFromPeer("dec_peer_second");
  const second = await client.callTool({ name: "hunch_query", arguments: { query: "anything" } });
  assert.equal(!!second.isError, false);
  control.runStartupSync();
  assert.equal(fixture.overlayHead(), pulled, "the startup sync runs once, whichever path took it");
});

test("runStartupSync pulls and reindexes once when no tool call came first", async (t) => {
  const fixture = behindOverlay();
  const reindexes = countReindexes(t);
  const control = buildServerWithRootControl(fixture.root, { deferStartupSync: true });
  t.after(async () => { await control.server.close(); fixture.cleanup(); });

  control.runStartupSync();
  assert.equal(fixture.overlayHead(), fixture.peerHead());
  const afterSync = reindexes();
  assert.ok(afterSync >= 1);

  const pulled = fixture.overlayHead();
  fixture.pushFromPeer("dec_peer_second");
  control.runStartupSync();
  const client = await connected(control);
  const result = await client.callTool({ name: "hunch_query", arguments: { query: "anything" } });
  assert.equal(!!result.isError, false);
  assert.equal(fixture.overlayHead(), pulled, "neither a second run nor the next tool call pulls again");
  assert.equal(reindexes(), afterSync, "an unchanged source stamp is not reindexed again");
});

test("runStartupSync does nothing after the server closed", async (t) => {
  const fixture = behindOverlay();
  const before = fixture.overlayHead();
  const control = buildServerWithRootControl(fixture.root, { deferStartupSync: true });
  await control.server.close();
  t.after(() => fixture.cleanup());

  control.runStartupSync();
  assert.equal(fixture.overlayHead(), before);
});

test("a deferred server still refuses an invalid team store at construction", (t) => {
  const fixture = behindOverlay();
  t.after(() => fixture.cleanup());
  writeFileSync(join(fixture.root, ".hunch", "team.json"), "{ not-json");

  assert.throws(
    () => buildServerWithRootControl(fixture.root, { deferStartupSync: true }),
    /team\.json is invalid or unsafe/,
  );
});

test("construction without the option stays eager for in-process callers", async (t) => {
  const fixture = behindOverlay();
  const reindexes = countReindexes(t);

  const control = buildServerWithRootControl(fixture.root);
  t.after(async () => { await control.server.close(); fixture.cleanup(); });

  assert.equal(fixture.overlayHead(), fixture.peerHead());
  assert.ok(reindexes() >= 1);
});

test("hunch mcp answers initialize before it pulls, and the first tool call catches up", async (t) => {
  const fixture = behindOverlay();
  const before = fixture.overlayHead();
  const transport = new StdioClientTransport({
    command: process.execPath,
    args: hunchCliArgs("mcp"),
    cwd: fixture.root,
    env: { ...process.env, HUNCH_PRIVATE_DIR: "" } as Record<string, string>,
  });
  const client = new Client({ name: "mcp-startup-stdio-test", version: "0.0.0" });
  t.after(async () => { await client.close(); fixture.cleanup(); });
  await client.connect(transport);

  assert.equal(fixture.overlayHead(), before, "the handshake must not wait for the overlay pull");

  const result = await client.callTool({ name: "hunch_query", arguments: { query: "decpeerfirst" } });
  assert.equal(!!result.isError, false);
  assert.match(firstText(result), /decpeerfirst/);
  assert.equal(fixture.overlayHead(), fixture.peerHead());
});
