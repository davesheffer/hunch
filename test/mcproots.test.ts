import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, rmSync, mkdirSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { execFileSync } from "node:child_process";
import { pathToFileURL } from "node:url";
import { resolveActiveRoot } from "../src/mcp/roots.js";
import { buildServerWithRootControl, wireClientRoots } from "../src/mcp/server.js";
import { hunchPaths } from "../src/core/paths.js";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";
import { ListRootsRequestSchema } from "@modelcontextprotocol/sdk/types.js";

const g = (cwd: string, ...a: string[]): void => {
  execFileSync("git", a, { cwd, stdio: ["ignore", "ignore", "ignore"] });
};

/** A repo with a .hunch/, plus a linked worktree on its own branch — the shape
 *  that produces the bug: the MCP server is spawned in `root`, the user works in `wt`. */
function repoWithWorktree(): { root: string; wt: string; cleanup: () => void } {
  const root = mkdtempSync(join(tmpdir(), "hunch-roots-"));
  g(root, "init", "-q");
  g(root, "config", "user.email", "t@example.com");
  g(root, "config", "user.name", "T");
  g(root, "checkout", "-q", "-b", "main");
  mkdirSync(join(root, ".hunch"), { recursive: true });
  writeFileSync(join(root, ".hunch", "seed.json"), "{}\n");
  g(root, "add", "-A");
  g(root, "commit", "-q", "-m", "init");
  const wt = `${root}-wt`;
  g(root, "worktree", "add", "-q", "-b", "feature-x", wt);
  return {
    root,
    wt,
    cleanup: () => {
      rmSync(root, { recursive: true, force: true });
      rmSync(wt, { recursive: true, force: true });
    },
  };
}

test("resolveActiveRoot: no roots advertised → falls back to the spawn cwd (today's behaviour, unsupporting clients unaffected)", () => {
  const { root, cleanup } = repoWithWorktree();
  try {
    assert.equal(resolveActiveRoot([], root), root);
  } finally {
    cleanup();
  }
});

test("resolveActiveRoot: a client-advertised worktree root wins over the spawn cwd", () => {
  const { root, wt, cleanup } = repoWithWorktree();
  try {
    // The server was spawned in the primary checkout (on main), but the client
    // advertises the worktree as its workspace. Captures must follow the worktree.
    assert.equal(resolveActiveRoot([pathToFileURL(wt).href], root), wt);
  } finally {
    cleanup();
  }
});

test("resolveActiveRoot: accepts a plain path as well as a file:// URI", () => {
  const { root, wt, cleanup } = repoWithWorktree();
  try {
    assert.equal(resolveActiveRoot([wt], root), wt);
  } finally {
    cleanup();
  }
});

test("resolveActiveRoot: a subdirectory of a repo resolves to the repo root", () => {
  const { root, wt, cleanup } = repoWithWorktree();
  try {
    const sub = join(wt, "src", "deep");
    mkdirSync(sub, { recursive: true });
    assert.equal(resolveActiveRoot([pathToFileURL(sub).href], root), wt);
  } finally {
    cleanup();
  }
});

test("resolveActiveRoot: an unusable root (nonexistent) is ignored in favour of the fallback", () => {
  const { root, cleanup } = repoWithWorktree();
  try {
    assert.equal(resolveActiveRoot([pathToFileURL(join(root, "does-not-exist")).href], root), root);
  } finally {
    cleanup();
  }
});

test("resolveActiveRoot: with several roots advertised, prefers one that already has a .hunch store", () => {
  const { root, wt, cleanup } = repoWithWorktree();
  const other = mkdtempSync(join(tmpdir(), "hunch-roots-other-"));
  try {
    g(other, "init", "-q");
    // `other` is a git repo but carries no memory; `wt` shares the repo's .hunch.
    mkdirSync(join(wt, ".hunch"), { recursive: true });
    assert.equal(resolveActiveRoot([pathToFileURL(other).href, pathToFileURL(wt).href], root), wt);
  } finally {
    rmSync(other, { recursive: true, force: true });
    cleanup();
  }
});

test("buildServerWithRootControl: starts at the given root and re-homes when the client advertises another", () => {
  const { root, wt, cleanup } = repoWithWorktree();
  try {
    const ctl = buildServerWithRootControl(root);
    assert.equal(ctl.getRoot(), root, "starts at the spawn root");

    ctl.setRoot(resolveActiveRoot([pathToFileURL(wt).href], root));
    assert.equal(ctl.getRoot(), wt, "follows the client-advertised worktree");

    // memory now homes in the worktree, so captures land on its branch
    assert.equal(hunchPaths(ctl.getRoot()).hunch, join(wt, ".hunch"));
  } finally {
    cleanup();
  }
});

test("buildServerWithRootControl: setting the same root again is a no-op", () => {
  const { root, cleanup } = repoWithWorktree();
  try {
    const ctl = buildServerWithRootControl(root);
    const before = ctl.getRoot();
    ctl.setRoot(root);
    assert.equal(ctl.getRoot(), before);
  } finally {
    cleanup();
  }
});

/** A decision fixture shaped like the store expects. */
const DEC = (id: string, topic: string, title: string) => ({
  id, title, topic, status: "accepted", context: "", decision: `body of ${title}`,
  consequences: [], alternatives_rejected: [], rejected_tripwires: [],
  related_components: [], related_files: [], supersedes: null, superseded_by: null,
  caused_by_bug: null, commit: null, valid_from: "2026-01-01T00:00:00.000Z", valid_to: null,
  retired: { symbols: [], deps: [] },
  provenance: { source: "human_confirmed", confidence: 0.95, evidence: [] },
  date: "2026-01-01T00:00:00.000Z",
});

test("re-homing indexes the new repo: a read tool finds memory that only exists in the worktree", async (t) => {
  const { root, wt, cleanup } = repoWithWorktree();
  let client: Client | undefined;
  t.after(() => { void client?.close().catch(() => {}); cleanup(); });

  // Memory that exists ONLY in the worktree — never indexed by the spawn root's store.
  // A fresh worktree also has no .hunch/*.sqlite (gitignored), so re-homing must build it.
  mkdirSync(join(wt, ".hunch", "decisions"), { recursive: true });
  writeFileSync(
    join(wt, ".hunch", "decisions", "dec_wtaaaaaaaa.json"),
    JSON.stringify(DEC("dec_wtaaaaaaaa", "worktree.only", "worktree-only decision")),
  );

  const ctl = buildServerWithRootControl(root); // spawned in the primary checkout
  const [ct, st] = InMemoryTransport.createLinkedPair();
  client = new Client({ name: "test", version: "0.0.0" });
  await Promise.all([ctl.server.connect(st), client.connect(ct)]);

  ctl.setRoot(wt); // client advertised the worktree

  // hunch_query goes through the sqlite FTS index (store.search → `SELECT … FROM search
  // MATCH`), unlike recs()-backed reads which load JSON directly. A fresh worktree has no
  // .hunch/*.sqlite (gitignored), so without a reindex on re-home this returns nothing.
  const res = (await client.callTool({
    name: "hunch_query",
    arguments: { query: "worktree-only decision" },
  })) as { content: Array<{ type: string; text?: string }> };
  const text = res.content.map((c) => c.text ?? "").join("\n");

  // Assert on the record ID, not the title: the "No matches for \"…\"" response echoes the
  // query verbatim, so matching on title text passes even when nothing was found.
  assert.doesNotMatch(text, /No matches/, `re-homed store returned nothing: ${text}`);
  assert.match(text, /dec_wtaaaaaaaa/, `re-homed store must index the worktree's memory, got: ${text}`);
});

test("resolveActiveRoot: a root that exists but is a FILE is ignored", () => {
  const { root, cleanup } = repoWithWorktree();
  try {
    const f = join(root, "not-a-dir.txt");
    writeFileSync(f, "x");
    assert.equal(resolveActiveRoot([pathToFileURL(f).href], root), root);
  } finally {
    cleanup();
  }
});

test("resolveActiveRoot: a root outside any repo is accepted only when nothing better is advertised", () => {
  const { root, wt, cleanup } = repoWithWorktree();
  const bare = mkdtempSync(join(tmpdir(), "hunch-roots-bare-")); // real dir, no .git, no .hunch
  try {
    // Alone, it is taken at face value (findRoot falls back to the path itself) — the client
    // is asserting this is its workspace, and we have nothing better.
    assert.equal(resolveActiveRoot([pathToFileURL(bare).href], root), bare);
    // But a real store always wins over it.
    assert.equal(resolveActiveRoot([pathToFileURL(bare).href, pathToFileURL(wt).href], root), wt);
  } finally {
    rmSync(bare, { recursive: true, force: true });
    cleanup();
  }
});

// ---- real roots handshake ---------------------------------------------------
// Drives the actual protocol: a real Client advertising the `roots` capability, a real
// `roots/list` round trip, and a real `notifications/roots/list_changed`.

/** Poll until `fn()` is true, or throw after `ms`. Keeps the async handshake deterministic
 *  without sleeping a fixed amount. */
async function until(fn: () => boolean, ms = 3000): Promise<void> {
  const deadline = Date.now() + ms;
  while (!fn()) {
    if (Date.now() > deadline) throw new Error("timed out waiting for condition");
    await new Promise((r) => setTimeout(r, 10));
  }
}

/** A client that advertises roots, with control over what it returns and when. */
function rootsClient(initial: string[]) {
  const client = new Client(
    { name: "test", version: "0.0.0" },
    { capabilities: { roots: { listChanged: true } } },
  );
  const state = { roots: initial, gate: null as null | Promise<void>, release: () => {} };
  client.setRequestHandler(ListRootsRequestSchema, async () => {
    const snapshot = state.roots;
    if (state.gate) await state.gate; // hold this response open
    return { roots: snapshot.map((p) => ({ uri: pathToFileURL(p).href, name: "w" })) };
  });
  return { client, state };
}

test("handshake: the server adopts the client's advertised root on initialize", async (t) => {
  const { root, wt, cleanup } = repoWithWorktree();
  const { client } = rootsClient([wt]);
  t.after(() => { void client.close().catch(() => {}); cleanup(); });

  const ctl = buildServerWithRootControl(root); // spawned in the primary checkout
  wireClientRoots(ctl, root);
  const [ct, st] = InMemoryTransport.createLinkedPair();
  await Promise.all([ctl.server.connect(st), client.connect(ct)]);

  await until(() => ctl.getRoot() === wt);
  assert.equal(ctl.getRoot(), wt, "oninitialized must trigger a roots/list and re-home");
});

test("handshake: roots/list_changed re-homes the server", async (t) => {
  const { root, wt, cleanup } = repoWithWorktree();
  const wt2 = `${root}-wt2`;
  g(root, "worktree", "add", "-q", "-b", "feature-y", wt2);
  const { client, state } = rootsClient([wt]);
  t.after(() => { void client.close().catch(() => {}); rmSync(wt2, { recursive: true, force: true }); cleanup(); });

  const ctl = buildServerWithRootControl(root);
  wireClientRoots(ctl, root);
  const [ct, st] = InMemoryTransport.createLinkedPair();
  await Promise.all([ctl.server.connect(st), client.connect(ct)]);
  await until(() => ctl.getRoot() === wt);

  state.roots = [wt2];
  await client.sendRootsListChanged();
  await until(() => ctl.getRoot() === wt2);
  assert.equal(ctl.getRoot(), wt2, "a list_changed notification must re-home the server");
});

test("handshake: a slow reply for an older workspace never overwrites a newer one", async (t) => {
  const { root, wt, cleanup } = repoWithWorktree();
  const wt2 = `${root}-wt2`;
  g(root, "worktree", "add", "-q", "-b", "feature-y", wt2);
  const { client, state } = rootsClient([wt]);
  t.after(() => { void client.close().catch(() => {}); rmSync(wt2, { recursive: true, force: true }); cleanup(); });

  const ctl = buildServerWithRootControl(root);
  wireClientRoots(ctl, root);
  const [ct, st] = InMemoryTransport.createLinkedPair();
  await Promise.all([ctl.server.connect(st), client.connect(ct)]);
  await until(() => ctl.getRoot() === wt);

  // Hold the NEXT response open, then advertise wt2 and fire a change: the stale
  // in-flight reply (wt) must lose to the newer resolved one (wt2).
  let release = () => {};
  state.gate = new Promise<void>((r) => { release = r; });
  state.roots = [wt];
  await client.sendRootsListChanged();          // request #1 — hangs, will answer "wt"
  await new Promise((r) => setTimeout(r, 50));  // let it reach the gate

  state.gate = null;
  state.roots = [wt2];
  await client.sendRootsListChanged();          // request #2 — answers "wt2" immediately
  await until(() => ctl.getRoot() === wt2);

  release();                                     // now let the stale reply land
  await new Promise((r) => setTimeout(r, 100));
  assert.equal(ctl.getRoot(), wt2, "a superseded roots/list reply must not overwrite the newer root");
});
