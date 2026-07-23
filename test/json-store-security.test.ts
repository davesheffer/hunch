import { test } from "node:test";
import assert from "node:assert/strict";
import {
  mkdirSync,
  mkdtempSync,
  readFileSync,
  readdirSync,
  rmSync,
  symlinkSync,
  truncateSync,
  writeFileSync,
} from "node:fs";
import { spawnSync } from "node:child_process";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";
import { hunchPaths } from "../src/core/paths.js";
import {
  JsonStore,
  MAX_JSON_RECORD_BYTES,
} from "../src/store/jsonStore.js";
import { buildServer } from "../src/mcp/server.js";

const PROJECT_ROOT = process.cwd();
const TSX = join(PROJECT_ROOT, "node_modules/tsx/dist/cli.mjs");
const CLI = join(PROJECT_ROOT, "src/cli/index.ts");

function decision(id: string, marker = "contained decision") {
  return {
    id,
    title: marker,
    topic: "storage.security",
    status: "accepted",
    context: "",
    decision: marker,
    consequences: [],
    alternatives_rejected: [],
    rejected_tripwires: [],
    related_components: [],
    related_files: [],
    supersedes: null,
    superseded_by: null,
    caused_by_bug: null,
    commit: null,
    valid_from: "2026-07-19T00:00:00.000Z",
    valid_to: null,
    retired: { symbols: [], deps: [] },
    provenance: { source: "human_confirmed", confidence: 0.95, evidence: [] },
    date: "2026-07-19T00:00:00.000Z",
  };
}

function cli(root: string, ...args: string[]) {
  const home = join(root, ".test-home");
  mkdirSync(home, { recursive: true });
  return spawnSync(process.execPath, [TSX, CLI, ...args], {
    cwd: root,
    encoding: "utf8",
    timeout: 30_000,
    env: {
      ...process.env,
      HOME: home,
      USERPROFILE: home,
      XDG_CONFIG_HOME: join(home, ".config"),
      HUNCH_PRIVATE_DIR: "",
      HUNCH_EMBEDDINGS: "off",
      HUNCH_SYNTH_PROVIDER: "deterministic",
      GIT_CONFIG_NOSYSTEM: "1",
      GIT_TERMINAL_PROMPT: "0",
      CI: "1",
    },
  });
}

function linkDirectory(target: string, path: string): void {
  symlinkSync(target, path, process.platform === "win32" ? "junction" : "dir");
}

test("real init refuses a public .hunch symlink without scaffolding its target", () => {
  const root = mkdtempSync(join(tmpdir(), "hunch-json-root-link-root-"));
  const outside = mkdtempSync(join(tmpdir(), "hunch-json-root-link-outside-"));
  try {
    const sentinel = join(outside, "keep.txt");
    writeFileSync(sentinel, "PUBLIC_HUNCH_LINK_TARGET_MUST_STAY_UNTOUCHED\n");
    linkDirectory(outside, join(root, ".hunch"));

    const run = cli(root, "init", "--no-index", "--no-providers", "--no-agent-hooks", "--no-enforce");
    const output = `${run.stdout}${run.stderr}`;
    assert.equal(run.status, 1, output);
    assert.match(output, /unsafe JSON store path|symlinks are not followed/);
    assert.deepEqual(readdirSync(outside), ["keep.txt"]);
    assert.equal(readFileSync(sentinel, "utf8"), "PUBLIC_HUNCH_LINK_TARGET_MUST_STAY_UNTOUCHED\n");
  } finally {
    rmSync(root, { recursive: true, force: true });
    rmSync(outside, { recursive: true, force: true });
  }
});

test("real init refuses a committed kind-directory symlink without touching its target", () => {
  const root = mkdtempSync(join(tmpdir(), "hunch-json-init-root-"));
  const outside = mkdtempSync(join(tmpdir(), "hunch-json-init-outside-"));
  try {
    mkdirSync(join(root, ".hunch"));
    const sentinel = join(outside, "dec_keep.json");
    const bytes = JSON.stringify(decision("dec_keep", "INIT_TARGET_MUST_STAY_UNREAD"));
    writeFileSync(sentinel, bytes);
    linkDirectory(outside, join(root, ".hunch", "decisions"));

    const run = cli(root, "init", "--no-index", "--no-providers", "--no-agent-hooks", "--no-enforce");
    const output = `${run.stdout}${run.stderr}`;
    assert.equal(run.status, 1, output);
    assert.match(output, /unsafe JSON store path|symlinks are not followed/);
    assert.equal(readFileSync(sentinel, "utf8"), bytes);
    assert.deepEqual(readdirSync(outside), ["dec_keep.json"], "init created nothing through the symlink");
  } finally {
    rmSync(root, { recursive: true, force: true });
    rmSync(outside, { recursive: true, force: true });
  }
});

test("real index refuses a symbols kind symlink without rewriting the outside index", () => {
  const root = mkdtempSync(join(tmpdir(), "hunch-json-index-root-"));
  const outside = mkdtempSync(join(tmpdir(), "hunch-json-index-outside-"));
  try {
    mkdirSync(join(root, ".hunch"));
    mkdirSync(join(root, "src"));
    writeFileSync(join(root, "src", "app.ts"), "export const app = true;\n");
    const sentinel = join(outside, "index.json");
    const bytes = '[{"id":"sym_outside","name":"INDEX_TARGET_MUST_NOT_CHANGE"}]\n';
    writeFileSync(sentinel, bytes);
    linkDirectory(outside, join(root, ".hunch", "symbols"));

    const run = cli(root, "index");
    const output = `${run.stdout}${run.stderr}`;
    assert.equal(run.status, 1, output);
    assert.match(output, /unsafe JSON store path|symlinks are not followed/);
    assert.equal(readFileSync(sentinel, "utf8"), bytes);
    assert.deepEqual(readdirSync(outside), ["index.json"], "index created nothing through the symlink");
  } finally {
    rmSync(root, { recursive: true, force: true });
    rmSync(outside, { recursive: true, force: true });
  }
});

test("JsonStore skips record symlinks and refuses every write/delete path that targets one", () => {
  const root = mkdtempSync(join(tmpdir(), "hunch-json-record-root-"));
  const outside = mkdtempSync(join(tmpdir(), "hunch-json-record-outside-"));
  const store = new JsonStore(hunchPaths(root));
  try {
    store.ensureDirs();
    const target = join(outside, "secret.json");
    const bytes = JSON.stringify(decision("dec_linked", "RECORD_SYMLINK_SECRET"));
    writeFileSync(target, bytes);
    symlinkSync(target, join(root, ".hunch", "decisions", "dec_linked.json"));

    const warnings: string[] = [];
    const warn = console.warn;
    console.warn = (message?: unknown) => warnings.push(String(message));
    try {
      assert.deepEqual(store.loadAll("decisions"), [], "external record is not ingested");
    } finally {
      console.warn = warn;
    }
    assert.ok(warnings.some((message) => /symlinks and special files are not followed/.test(message)));
    assert.throws(() => store.put("decisions", decision("dec_linked") as never), /unsafe JSON store path/);
    assert.throws(() => store.delete("decisions", "dec_linked"), /unsafe JSON store path/);
    assert.throws(() => store.replaceAll("decisions", []), /unsafe JSON store path/);
    assert.throws(() => store.dropAll("decisions"), /unsafe JSON store path/);
    assert.equal(readFileSync(target, "utf8"), bytes, "outside target stayed byte-identical");
  } finally {
    rmSync(root, { recursive: true, force: true });
    rmSync(outside, { recursive: true, force: true });
  }
});

test("JsonStore rejects traversal IDs and oversized record reads, writes, and deletes", () => {
  const root = mkdtempSync(join(tmpdir(), "hunch-json-bounds-root-"));
  const store = new JsonStore(hunchPaths(root));
  try {
    store.ensureDirs();
    store.put("decisions", decision("dec_safe") as never);
    assert.throws(() => store.put("decisions", decision("../../escape") as never), /unsafe JSON record id/);
    assert.throws(() => store.replaceAll("decisions", [decision("../escape")] as never), /unsafe JSON record id/);
    assert.throws(() => store.delete("decisions", "../../escape"), /unsafe JSON record id/);
    assert.equal(store.get("decisions", "dec_safe")?.id, "dec_safe", "failed replacement did not clear safe data");

    const oversized = join(root, ".hunch", "decisions", "dec_oversized.json");
    writeFileSync(oversized, "");
    truncateSync(oversized, MAX_JSON_RECORD_BYTES + 1);
    store.clearCache();
    const warn = console.warn;
    console.warn = () => {};
    try {
      assert.deepEqual(store.loadAll("decisions").map((record) => record.id), ["dec_safe"]);
    } finally {
      console.warn = warn;
    }
    assert.throws(() => store.put("decisions", decision("dec_oversized") as never), /oversized JSON file/);
    assert.throws(() => store.delete("decisions", "dec_oversized"), /oversized JSON file/);
    assert.throws(() => store.dropAll("decisions"), /oversized JSON file/);

    const huge = decision("dec_huge", "x".repeat(MAX_JSON_RECORD_BYTES));
    assert.throws(() => store.put("decisions", huge as never), /oversized JSON write/);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("MCP startup and query do not ingest an external record through a symlink", async (t) => {
  const root = mkdtempSync(join(tmpdir(), "hunch-json-mcp-root-"));
  const outside = mkdtempSync(join(tmpdir(), "hunch-json-mcp-outside-"));
  const previousPrivate = process.env.HUNCH_PRIVATE_DIR;
  const previousEmbeddings = process.env.HUNCH_EMBEDDINGS;
  process.env.HUNCH_PRIVATE_DIR = "";
  process.env.HUNCH_EMBEDDINGS = "off";
  mkdirSync(join(root, ".hunch", "decisions"), { recursive: true });
  const target = join(outside, "secret.json");
  const bytes = JSON.stringify(decision("dec_mcp_link", "MCP_EXTERNAL_SECRET_MARKER"));
  writeFileSync(target, bytes);
  symlinkSync(target, join(root, ".hunch", "decisions", "dec_mcp_link.json"));

  const warnings: string[] = [];
  const warn = console.warn;
  let server: ReturnType<typeof buildServer> | undefined;
  let client: Client | undefined;
  t.after(async () => {
    console.warn = warn;
    await client?.close().catch(() => {});
    await server?.close().catch(() => {});
    if (previousPrivate === undefined) delete process.env.HUNCH_PRIVATE_DIR;
    else process.env.HUNCH_PRIVATE_DIR = previousPrivate;
    if (previousEmbeddings === undefined) delete process.env.HUNCH_EMBEDDINGS;
    else process.env.HUNCH_EMBEDDINGS = previousEmbeddings;
    rmSync(root, { recursive: true, force: true });
    rmSync(outside, { recursive: true, force: true });
  });

  try {
    console.warn = (message?: unknown) => warnings.push(String(message));
    server = buildServer(root);
  } finally {
    console.warn = warn;
  }
  const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
  client = new Client({ name: "json-store-security", version: "1.0.0" });
  await Promise.all([server.connect(serverTransport), client.connect(clientTransport)]);

  const result = await client.callTool({ name: "hunch_query", arguments: { query: "MCP_EXTERNAL_SECRET_MARKER" } });
  const text = result.content.map((part) => part.type === "text" ? part.text : "").join("\n");
  assert.match(text, /No matches/);
  assert.doesNotMatch(text, /dec_mcp_link/);
  assert.ok(warnings.some((message) => /symlinks and special files are not followed/.test(message)));
  assert.equal(readFileSync(target, "utf8"), bytes);
});
