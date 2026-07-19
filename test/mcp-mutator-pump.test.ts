import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StdioClientTransport } from "@modelcontextprotocol/sdk/client/stdio.js";
import { buildCorrectionConstraint } from "../src/core/correction.js";
import { hunchPaths } from "../src/core/paths.js";
import { indexRepo } from "../src/extractors/indexer.js";
import { writeAgentsMd } from "../src/integrations/providers.js";
import { HunchStore } from "../src/store/hunchStore.js";

const PROJECT_ROOT = process.cwd();
const TSX = join(PROJECT_ROOT, "node_modules/tsx/dist/cli.mjs");
const CLI = join(PROJECT_ROOT, "src/cli/index.ts");

function git(cwd: string, ...args: string[]): string {
  return execFileSync("git", args, {
    cwd,
    encoding: "utf8",
    env: { ...process.env, GIT_CONFIG_NOSYSTEM: "1" },
    stdio: ["ignore", "pipe", "pipe"],
  }).trim();
}

function initGit(root: string): void {
  git(root, "init", "-q", "-b", "main");
  git(root, "config", "user.email", "mcp-pump@test.invalid");
  git(root, "config", "user.name", "MCP Pump Test");
}

function commitAll(root: string, message: string): string {
  git(root, "add", "-A");
  git(root, "commit", "-qm", message);
  return git(root, "rev-parse", "HEAD");
}

function publicFixture(label: string): { root: string; cleanup: () => void } {
  const root = mkdtempSync(join(tmpdir(), `hunch-mcp-${label}-`));
  initGit(root);
  mkdirSync(join(root, "src"), { recursive: true });
  writeFileSync(join(root, "src/orders.ts"), "export const listOrders = () => [];\n");
  writeFileSync(join(root, ".gitignore"), [
    ".hunch/hunch.sqlite*",
    ".hunch/local.json",
    ".hunch-cache/",
    "",
  ].join("\n"));
  const store = new HunchStore(hunchPaths(root));
  store.json.ensureDirs();
  indexRepo(store, root, { churn: false });
  store.reindex();
  store.close();
  commitAll(root, "fixture: public graph");
  return {
    root,
    cleanup: () => rmSync(root, { recursive: true, force: true, maxRetries: 3, retryDelay: 50 }),
  };
}

function privateOverlay(root: string, label: string, mode: "private" | "shared"): { overlayRoot: string; hunch: string } {
  const overlayRoot = mkdtempSync(join(tmpdir(), `hunch-mcp-${label}-overlay-`));
  const hunch = join(overlayRoot, ".hunch");
  initGit(overlayRoot);
  mkdirSync(hunch, { recursive: true });
  writeFileSync(join(overlayRoot, ".gitignore"), ".hunch/hunch.sqlite*\n");
  commitAll(overlayRoot, "fixture: overlay repository");
  writeFileSync(join(root, ".hunch/local.json"), `${JSON.stringify({
    privateDir: hunch,
    autoCommit: true,
    mode,
  }, null, 2)}\n`);
  return { overlayRoot, hunch };
}

async function connect(root: string): Promise<Client> {
  const transport = new StdioClientTransport({
    command: process.execPath,
    args: [TSX, CLI, "mcp"],
    cwd: root,
    env: {
      ...process.env,
      HUNCH_PRIVATE_DIR: "",
      HUNCH_SYNTH_PROVIDER: "deterministic",
      GIT_CONFIG_NOSYSTEM: "1",
    },
  });
  const client = new Client({ name: "mcp-mutator-pump-test", version: "1.0.0" });
  await client.connect(transport);
  return client;
}

async function callJson<T>(client: Client, name: string, args: Record<string, unknown>): Promise<T> {
  const response = await client.callTool({ name, arguments: args });
  assert.equal(response.isError, undefined, JSON.stringify(response));
  const text = response.content
    .filter((part): part is { type: "text"; text: string } => part.type === "text")
    .map((part) => part.text)
    .join("\n");
  return JSON.parse(text) as T;
}

async function callText(client: Client, name: string, args: Record<string, unknown>): Promise<string> {
  const response = await client.callTool({ name, arguments: args });
  assert.equal(response.isError, undefined, JSON.stringify(response));
  return response.content
    .filter((part): part is { type: "text"; text: string } => part.type === "text")
    .map((part) => part.text)
    .join("\n");
}

test("MCP correction capture commits refreshed assistant grounding with the constraint", async () => {
  const fixture = publicFixture("correction-grounding-pump");
  let client: Client | null = null;
  try {
    const bootstrap = new HunchStore(hunchPaths(fixture.root));
    writeAgentsMd(fixture.root, bootstrap);
    bootstrap.close();
    commitAll(fixture.root, "fixture: tracked assistant grounding");
    const before = git(fixture.root, "rev-parse", "HEAD");

    client = await connect(fixture.root);
    const response = await callText(client, "hunch_record_correction", {
      rule: "Order exports must remain synchronous.",
      scope_hint_file: "src/orders.ts",
      severity: "warning",
      type: "correctness",
      rationale: "The consuming support script cannot await this boundary.",
    });
    const constraintId = response.match(/constraint (con_[a-f0-9]+)/)?.[1];
    assert.ok(constraintId, response);
    await client.close();
    client = null;

    assert.notEqual(git(fixture.root, "rev-parse", "HEAD"), before);
    const committed = git(fixture.root, "show", "--name-only", "--format=", "HEAD");
    assert.match(committed, new RegExp(`\\.hunch/constraints/${constraintId}\\.json`));
    assert.match(committed, /^AGENTS\.md$/m,
      "the refreshed cross-assistant grounding belongs in the same durable memory commit");
    assert.equal(git(fixture.root, "status", "--porcelain", "--", ".hunch", "AGENTS.md"), "",
      "a successful capture must not leave its graph or generated grounding dirty");
    assert.match(git(fixture.root, "show", "HEAD:AGENTS.md"), /Order exports must remain synchronous/);
  } finally {
    if (client) await client.close();
    fixture.cleanup();
  }
});

test("MCP policy evaluation scans exact working content without mutating Git or the public graph", async () => {
  const fixture = publicFixture("evaluate-pump");
  let client: Client | null = null;
  try {
    writeFileSync(join(fixture.root, "src/orders.ts"), "export const listOrders = () => [];\nexport const newOrder = () => ({ id: 1 });\n");
    const before = git(fixture.root, "rev-parse", "HEAD");
    const statusBefore = git(fixture.root, "status", "--porcelain=v1");
    const indexBefore = git(fixture.root, "ls-files", "--stage");
    const publicDiffBefore = git(fixture.root, "diff", "--", ".hunch");

    client = await connect(fixture.root);
    const receipts = await callJson<unknown[]>(client, "hunch_policy_evaluate", { public_only: true });
    assert.deepEqual(receipts, []);
    await client.close();
    client = null;

    const after = git(fixture.root, "rev-parse", "HEAD");
    assert.equal(after, before, "a neutral evaluation must never create a memory commit");
    assert.equal(git(fixture.root, "status", "--porcelain=v1"), statusBefore);
    assert.equal(git(fixture.root, "ls-files", "--stage"), indexBefore, "evaluation must not alter the Git index");
    assert.equal(git(fixture.root, "diff", "--", ".hunch"), publicDiffBefore,
      "the working source scan must not rewrite durable graph JSON");
  } finally {
    if (client) await client.close();
    fixture.cleanup();
  }
});

test("MCP private correction upgrade pumps the public index and the exact private artifact home", async () => {
  const fixture = publicFixture("private-upgrade-pump");
  const overlay = privateOverlay(fixture.root, "private-upgrade-pump", "private");
  let client: Client | null = null;
  try {
    const correction = buildCorrectionConstraint({
      rule: "Keep the order module straightforward for the support team.",
      scope_hint_file: "src/orders.ts",
      severity: "warning",
      type: "architecture",
      rationale: "This fixture intentionally has no compilable package projection.",
      knownDeps: [],
    }, "2026-07-19T10:00:00.000Z");
    const store = new HunchStore(hunchPaths(fixture.root));
    store.putPrivate("constraints", correction);
    store.close();
    commitAll(overlay.overlayRoot, "fixture: private correction");

    writeFileSync(join(fixture.root, "src/private-upgrade-index.ts"), "export const indexedBeforeUpgrade = true;\n");
    commitAll(fixture.root, "feat: make public graph stale");
    const publicBefore = git(fixture.root, "rev-parse", "HEAD");
    const privateBefore = git(overlay.overlayRoot, "rev-parse", "HEAD");

    client = await connect(fixture.root);
    const upgrade = await callJson<{
      status: string;
      evidence: { id: string; data_class: string };
      policy: null | { id: string };
    }>(client, "hunch_policy_upgrade_correction", {
      constraint_id: correction.id,
      private_only: true,
      include_artifacts: true,
    });
    assert.equal(upgrade.status, "legacy_only");
    assert.equal(upgrade.policy, null);
    assert.equal(upgrade.evidence.data_class, "private");
    await client.close();
    client = null;

    assert.notEqual(git(fixture.root, "rev-parse", "HEAD"), publicBefore,
      "the index mutation belongs to the public graph even when policy artifacts are private");
    assert.notEqual(git(overlay.overlayRoot, "rev-parse", "HEAD"), privateBefore,
      "the private evidence mutation must be committed in the overlay");
    assert.match(git(fixture.root, "show", "--name-only", "--format=", "HEAD"), /\.hunch\/(?:symbols|components|edges)\//);
    const publicHistory = git(fixture.root, "log", "-p", `${publicBefore}..HEAD`);
    assert.doesNotMatch(publicHistory, new RegExp(correction.id),
      "a private correction id must not leak through the public derived-graph commit message");
    assert.doesNotMatch(publicHistory, /Keep the order module straightforward/);
    assert.match(git(overlay.overlayRoot, "show", "--name-only", "--format=", "HEAD"),
      new RegExp(`\\.hunch/evidence/${upgrade.evidence.id}\\.json`));
    assert.equal(existsSync(join(fixture.root, ".hunch/evidence", `${upgrade.evidence.id}.json`)), false,
      "private correction evidence must never be copied into the public graph");
    assert.equal(git(fixture.root, "ls-tree", "-r", "--name-only", "HEAD").includes(`.hunch/evidence/${upgrade.evidence.id}.json`), false,
      "the public memory commit must contain only the public index mutation");
    assert.equal(git(fixture.root, "status", "--porcelain", "--", ".hunch"), "");
    assert.equal(git(overlay.overlayRoot, "status", "--porcelain", "--", ".hunch"), "");
  } finally {
    if (client) await client.close();
    rmSync(overlay.overlayRoot, { recursive: true, force: true, maxRetries: 3, retryDelay: 50 });
    fixture.cleanup();
  }
});

test("MCP shared mode keeps a legacy public correction upgrade in its actual public home", async () => {
  const fixture = publicFixture("shared-public-upgrade");
  let client: Client | null = null;
  let overlayRoot: string | null = null;
  try {
    const correction = buildCorrectionConstraint({
      rule: "Keep the public migration note next to the public source graph.",
      scope_hint_file: "src/orders.ts",
      severity: "warning",
      type: "architecture",
      rationale: "Legacy public corrections stay public after shared mode is enabled.",
      knownDeps: [],
    }, "2026-07-19T10:05:00.000Z");
    const publicStore = new HunchStore(hunchPaths(fixture.root));
    publicStore.json.put("constraints", correction);
    publicStore.close();
    commitAll(fixture.root, "fixture: legacy public correction");

    const overlay = privateOverlay(fixture.root, "shared-public-upgrade", "shared");
    overlayRoot = overlay.overlayRoot;
    const publicBefore = git(fixture.root, "rev-parse", "HEAD");
    const privateBefore = git(overlay.overlayRoot, "rev-parse", "HEAD");

    client = await connect(fixture.root);
    const upgrade = await callJson<{
      status: string;
      evidence: { id: string; data_class: string };
      policy: null | { id: string };
    }>(client, "hunch_policy_upgrade_correction", {
      constraint_id: correction.id,
      include_artifacts: true,
    });
    assert.equal(upgrade.status, "legacy_only");
    assert.equal(upgrade.policy, null);
    assert.equal(upgrade.evidence.data_class, "public");
    await client.close();
    client = null;

    assert.notEqual(git(fixture.root, "rev-parse", "HEAD"), publicBefore,
      "shared capture routing must not redirect an existing public correction's evidence");
    assert.equal(git(overlay.overlayRoot, "rev-parse", "HEAD"), privateBefore,
      "the shared overlay is not the artifact home for this legacy public correction");
    assert.match(git(fixture.root, "show", "--name-only", "--format=", "HEAD"),
      new RegExp(`\\.hunch/evidence/${upgrade.evidence.id}\\.json`));
    assert.equal(git(fixture.root, "status", "--porcelain", "--", ".hunch"), "");
    assert.equal(git(overlay.overlayRoot, "status", "--porcelain", "--", ".hunch"), "");
    assert.equal(readFileSync(join(fixture.root, ".hunch/evidence", `${upgrade.evidence.id}.json`), "utf8").includes(correction.id), true);
  } finally {
    if (client) await client.close();
    if (overlayRoot) rmSync(overlayRoot, { recursive: true, force: true, maxRetries: 3, retryDelay: 50 });
    fixture.cleanup();
  }
});
