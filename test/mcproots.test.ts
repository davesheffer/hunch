import { test } from "node:test";
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { existsSync, mkdtempSync, mkdirSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { pathToFileURL } from "node:url";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";
import { ListRootsRequestSchema } from "@modelcontextprotocol/sdk/types.js";
import { HunchStore } from "../src/store/hunchStore.js";
import { decisionId } from "../src/core/ids.js";
import { resolveActiveRoot } from "../src/mcp/roots.js";
import { buildServerWithRootControl, wireClientRoots } from "../src/mcp/server.js";

function git(root: string, ...args: string[]): string {
  return execFileSync("git", args, { cwd: root, encoding: "utf8" }).trim();
}

function repo(prefix = "hunch-roots-"): string {
  // canonicalRootPath() realpaths every root (issue #54), so the fixture must be
  // canonical too: on macOS tmpdir() is the /var -> /private/var symlink, and a raw
  // path would compare unequal to the resolved root the server legitimately returns.
  const root = mkdtempSync(join(realpathSync(tmpdir()), prefix));
  git(root, "init", "-q");
  git(root, "config", "user.email", "mcp-roots@example.invalid");
  git(root, "config", "user.name", "MCP Roots Test");
  mkdirSync(join(root, ".hunch"), { recursive: true });
  writeFileSync(join(root, ".hunch", "seed.json"), "{}\n");
  writeFileSync(join(root, "app.ts"), "export const value = 1;\n");
  git(root, "add", "-A");
  git(root, "commit", "-qm", "fixture");
  return root;
}

function repoWithWorktree(): { root: string; worktree: string; cleanup: () => void } {
  const root = repo();
  const worktree = `${root}-wt`;
  git(root, "worktree", "add", "-q", "-b", "feature-roots", worktree);
  return {
    root,
    worktree,
    cleanup: () => {
      try { git(root, "worktree", "remove", "--force", worktree); } catch { /* best effort */ }
      try { rmSync(worktree, { recursive: true, force: true, maxRetries: 3, retryDelay: 50 }); } catch { /* temp only */ }
      try { rmSync(root, { recursive: true, force: true, maxRetries: 3, retryDelay: 50 }); } catch { /* temp only */ }
    },
  };
}

async function until(predicate: () => boolean, timeoutMs = 3_000): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (!predicate()) {
    if (Date.now() > deadline) throw new Error("timed out waiting for MCP root change");
    await new Promise((resolve) => setTimeout(resolve, 10));
  }
}

function rootsClient(initial: string[]) {
  const client = new Client(
    { name: "mcp-roots-test", version: "0.0.0" },
    { capabilities: { roots: { listChanged: true } } },
  );
  const state = { roots: initial, gate: null as Promise<void> | null };
  client.setRequestHandler(ListRootsRequestSchema, async () => {
    const snapshot = [...state.roots];
    if (state.gate) await state.gate;
    return { roots: snapshot.map((path) => ({ uri: pathToFileURL(path).href, name: "workspace" })) };
  });
  return { client, state };
}

test("resolveActiveRoot follows one advertised worktree and falls back when none are advertised", () => {
  const fixture = repoWithWorktree();
  try {
    assert.equal(resolveActiveRoot([], fixture.root), fixture.root);
    assert.equal(resolveActiveRoot([pathToFileURL(fixture.worktree).href], fixture.root), fixture.worktree);
  } finally {
    fixture.cleanup();
  }
});

test("case-variant spellings of ONE repo resolve to one canonical root, not an ambiguous pair (issue #54)", () => {
  const root = repo("hunch-roots-case-");
  try {
    // VS Code advertises file:///c%3A/… (lowercase drive) while the spawn cwd
    // says C:\… — same repo, two spellings. Both single-root resolution and the
    // multi-candidate dedup must collapse them.
    const swapped = process.platform === "win32" && /^[A-Za-z]:/.test(root)
      ? (root[0] === root[0]!.toLowerCase() ? root[0]!.toUpperCase() : root[0]!.toLowerCase()) + root.slice(1)
      : root; // POSIX is case-sensitive: same spelling, test degenerates to dedup-of-identical
    const resolved = resolveActiveRoot([pathToFileURL(root).href, pathToFileURL(swapped).href], root);
    assert.notEqual(resolved, null, "one repo in two spellings must never read as ambiguous");
    assert.equal(resolveActiveRoot([pathToFileURL(swapped).href], root), resolved, "either spelling resolves to the same canonical root");
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("resolveActiveRoot refuses an ambiguous multi-repo list instead of choosing the wrong store", () => {
  const first = repo("hunch-roots-first-");
  const second = repo("hunch-roots-second-");
  try {
    assert.equal(
      resolveActiveRoot([pathToFileURL(first).href, pathToFileURL(second).href], first),
      null,
      "two valid Hunch stores have no protocol-level active marker",
    );
  } finally {
    rmSync(first, { recursive: true, force: true });
    rmSync(second, { recursive: true, force: true });
  }
});

test("resolveActiveRoot accepts a valid file root by resolving its containing repository", () => {
  const root = repo();
  try {
    assert.equal(resolveActiveRoot([pathToFileURL(join(root, "app.ts")).href], root), root);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("root control closes the previous SQLite store and closes the active store on shutdown", async (t) => {
  const fixture = repoWithWorktree();
  const originalClose = HunchStore.prototype.close;
  let closes = 0;
  HunchStore.prototype.close = function patchedClose(): void {
    closes++;
    return originalClose.call(this);
  };
  t.after(() => {
    HunchStore.prototype.close = originalClose;
    fixture.cleanup();
  });

  const control = buildServerWithRootControl(fixture.root);
  control.setRoot(fixture.worktree);
  assert.equal(closes, 1, "the superseded store is closed after an idle root swap");

  await control.server.close();
  assert.equal(closes, 2, "server shutdown closes the currently active store");
});

test("a failed root activation leaves the previous root and store active", async (t) => {
  const fixture = repoWithWorktree();
  const invalid = repo("hunch-roots-invalid-team-");
  writeFileSync(join(invalid, ".hunch", "team.json"), "{ not-json");
  const control = buildServerWithRootControl(fixture.root);
  t.after(async () => {
    await control.server.close().catch(() => {});
    fixture.cleanup();
    rmSync(invalid, { recursive: true, force: true });
  });

  assert.throws(
    () => control.setRoot(invalid),
    /team\.json is invalid or unsafe/,
  );
  assert.equal(control.getRoot(), fixture.root, "the original root remains active");
});

test("initialize and roots/list_changed re-home the live MCP server", async (t) => {
  const fixture = repoWithWorktree();
  const second = `${fixture.root}-wt2`;
  git(fixture.root, "worktree", "add", "-q", "-b", "feature-roots-2", second);
  const { client, state } = rootsClient([fixture.worktree]);
  const control = buildServerWithRootControl(fixture.root);
  wireClientRoots(control, fixture.root);
  const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
  t.after(async () => {
    await client.close().catch(() => {});
    await control.server.close().catch(() => {});
    try { git(fixture.root, "worktree", "remove", "--force", second); } catch { /* best effort */ }
    try { rmSync(second, { recursive: true, force: true, maxRetries: 3, retryDelay: 50 }); } catch { /* temp only */ }
    fixture.cleanup();
  });

  await Promise.all([control.server.connect(serverTransport), client.connect(clientTransport)]);
  await until(() => control.getRoot() === fixture.worktree);

  state.roots = [second];
  await client.sendRootsListChanged();
  await until(() => control.getRoot() === second);
  assert.equal(control.getRoot(), second);
});

test("a capture after initialization lands in the advertised worktree, not the spawn checkout", async (t) => {
  const fixture = repoWithWorktree();
  writeFileSync(
    join(fixture.worktree, ".hunch", "local.json"),
    `${JSON.stringify({ autoCommit: false })}\n`,
  );
  const { client } = rootsClient([fixture.worktree]);
  const control = buildServerWithRootControl(fixture.root);
  wireClientRoots(control, fixture.root);
  const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
  t.after(async () => {
    await client.close().catch(() => {});
    await control.server.close().catch(() => {});
    fixture.cleanup();
  });

  await Promise.all([control.server.connect(serverTransport), client.connect(clientTransport)]);
  await until(() => control.getRoot() === fixture.worktree);

  const title = "worktree-rooted capture";
  const result = await client.callTool({
    name: "hunch_record_decision",
    arguments: {
      decision: {
        title,
        topic: "worktree-rooted-capture",
        context: "root routing regression",
        decision: "Write beside the active work",
      },
    },
  }) as { isError?: boolean };
  assert.equal(!!result.isError, false);

  const filename = `${decisionId(`manual:${title}`)}.json`;
  assert.equal(existsSync(join(fixture.worktree, ".hunch", "decisions", filename)), true);
  assert.equal(existsSync(join(fixture.root, ".hunch", "decisions", filename)), false);
});

test("a root swap waits for an in-flight tool request before closing its store", async (t) => {
  const fixture = repoWithWorktree();
  const second = `${fixture.root}-wt2`;
  git(fixture.root, "worktree", "add", "-q", "-b", "feature-roots-2", second);
  const { client, state } = rootsClient([fixture.worktree]);
  const originalSearch = HunchStore.prototype.hybridSearch;
  let releaseSearch = () => {};
  let markStarted = () => {};
  const started = new Promise<void>((resolve) => { markStarted = resolve; });
  const gate = new Promise<void>((resolve) => { releaseSearch = resolve; });
  HunchStore.prototype.hybridSearch = async function delayedSearch(query, limit, options) {
    markStarted();
    await gate;
    return originalSearch.call(this, query, limit, options);
  };

  const control = buildServerWithRootControl(fixture.root);
  wireClientRoots(control, fixture.root);
  const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
  t.after(async () => {
    HunchStore.prototype.hybridSearch = originalSearch;
    releaseSearch();
    await client.close().catch(() => {});
    await control.server.close().catch(() => {});
    try { git(fixture.root, "worktree", "remove", "--force", second); } catch { /* best effort */ }
    try { rmSync(second, { recursive: true, force: true, maxRetries: 3, retryDelay: 50 }); } catch { /* temp only */ }
    fixture.cleanup();
  });

  await Promise.all([control.server.connect(serverTransport), client.connect(clientTransport)]);
  await until(() => control.getRoot() === fixture.worktree);

  const query = client.callTool({ name: "hunch_query", arguments: { query: "anything" } });
  await started;
  state.roots = [second];
  await client.sendRootsListChanged();
  assert.equal(control.getRoot(), fixture.worktree, "the current request keeps its root epoch");

  releaseSearch();
  await query;
  await until(() => control.getRoot() === second);
});

test("a stale roots/list response cannot overwrite a newer workspace", async (t) => {
  const fixture = repoWithWorktree();
  const second = `${fixture.root}-wt2`;
  git(fixture.root, "worktree", "add", "-q", "-b", "feature-roots-2", second);
  const { client, state } = rootsClient([fixture.worktree]);
  const control = buildServerWithRootControl(fixture.root);
  wireClientRoots(control, fixture.root);
  const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
  t.after(async () => {
    await client.close().catch(() => {});
    await control.server.close().catch(() => {});
    try { git(fixture.root, "worktree", "remove", "--force", second); } catch { /* best effort */ }
    try { rmSync(second, { recursive: true, force: true, maxRetries: 3, retryDelay: 50 }); } catch { /* temp only */ }
    fixture.cleanup();
  });

  await Promise.all([control.server.connect(serverTransport), client.connect(clientTransport)]);
  await until(() => control.getRoot() === fixture.worktree);

  let release = () => {};
  state.gate = new Promise<void>((resolve) => { release = resolve; });
  state.roots = [fixture.worktree];
  await client.sendRootsListChanged();
  await new Promise((resolve) => setTimeout(resolve, 25));

  state.gate = null;
  state.roots = [second];
  await client.sendRootsListChanged();
  await until(() => control.getRoot() === second);

  release();
  await new Promise((resolve) => setTimeout(resolve, 25));
  assert.equal(control.getRoot(), second);
});
