import assert from "node:assert/strict";
import { execFileSync, spawnSync } from "node:child_process";
import { copyFileSync, mkdirSync, mkdtempSync, readFileSync, rmSync, symlinkSync, truncateSync, unlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StdioClientTransport } from "@modelcontextprotocol/sdk/client/stdio.js";
import { graphSnapshotFromRecords, sourceGraphSnapshot } from "../src/constitution/evaluator.js";
import { ConstitutionService } from "../src/constitution/service.js";
import { checkConformance } from "../src/core/conformance.js";
import { hunchPaths } from "../src/core/paths.js";
import { MAX_REPO_SOURCE_FILE_BYTES } from "../src/core/safeRepoFile.js";
import type { Decision } from "../src/core/types.js";
import { indexRepo, scanRepo } from "../src/extractors/indexer.js";
import { HunchStore } from "../src/store/hunchStore.js";

const PROJECT_ROOT = process.cwd();
const TSX = join(PROJECT_ROOT, "node_modules/tsx/dist/cli.mjs");
const CLI = join(PROJECT_ROOT, "src/cli/index.ts");
const LAYERED = 'import { fetchOrders } from "../services/orders.js";\nexport function listOrders(u: string){ return fetchOrders(u); }\n';
const BYPASS = 'import { dbQuery } from "../db/client.js";\nexport function listOrders(u: string){ return dbQuery(u); }\n';
const UNRESOLVED_DB_IMPORT = 'import { dbQuery } from "../db/newclient.js";\nexport function listOrders(u: string){ return dbQuery(u); }\n';

function git(root: string, ...args: string[]): string {
  return execFileSync("git", args, {
    cwd: root,
    encoding: "utf8",
    env: { ...process.env, GIT_CONFIG_NOSYSTEM: "1" },
    stdio: ["ignore", "pipe", "pipe"],
  }).trim();
}

function decision(): Decision {
  const now = "2026-07-19T12:00:00.000Z";
  return {
    id: "dec_check_scan_boundary",
    title: "Controllers do not call the database directly",
    topic: "architecture.controller-db-boundary",
    status: "accepted",
    context: "The service owns persistence behavior.",
    decision: "Controllers delegate persistence to the service layer.",
    consequences: [],
    alternatives_rejected: ["Direct database calls from controllers."],
    rejected_tripwires: [],
    related_components: [],
    related_files: ["src/api/orders.ts", "src/services/orders.ts", "src/db/client.ts"],
    supersedes: null,
    superseded_by: null,
    caused_by_bug: null,
    commit: null,
    valid_from: now,
    valid_to: null,
    retired: { symbols: [], deps: [] },
    conformance: [{ assert: "not-calls", subject: "listOrders", object: "dbQuery", transitive: false }],
    provenance: { source: "human_confirmed", confidence: 1, evidence: ["review:controller-boundary"] },
    date: now,
  };
}

function fixture(): { root: string; store: HunchStore; policyId: string; cleanup(): void } {
  const root = mkdtempSync(join(tmpdir(), "hunch-check-scan-"));
  git(root, "init", "-q", "-b", "main");
  git(root, "config", "user.email", "check-scan@test.invalid");
  git(root, "config", "user.name", "Check Scan Test");
  git(root, "config", "commit.gpgsign", "false");
  mkdirSync(join(root, "src/api"), { recursive: true });
  mkdirSync(join(root, "src/services"), { recursive: true });
  mkdirSync(join(root, "src/db"), { recursive: true });
  writeFileSync(join(root, ".gitignore"), [
    ".hunch/*.sqlite*",
    ".hunch/local.json",
    ".hunch/events.log",
    ".hunch/.hunch-commit.lock",
    ".hunch-cache/",
    "",
  ].join("\n"));
  writeFileSync(join(root, "src/db/client.ts"), "export function dbQuery(sql: string){ return sql; }\n");
  writeFileSync(join(root, "src/services/orders.ts"), 'import { dbQuery } from "../db/client.js";\nexport function fetchOrders(u: string){ return dbQuery(u); }\n');
  writeFileSync(join(root, "src/api/orders.ts"), LAYERED);

  const store = new HunchStore(hunchPaths(root));
  store.json.ensureDirs();
  indexRepo(store, root, { churn: false });
  store.json.put("decisions", decision());
  store.reindex();
  const policy = new ConstitutionService(store, root).compile("dec_check_scan_boundary", {
    now: "2026-07-19T12:01:00.000Z",
  });
  return {
    root,
    store,
    policyId: policy.id,
    cleanup: () => {
      store.close();
      rmSync(root, { recursive: true, force: true, maxRetries: 3, retryDelay: 50 });
    },
  };
}

function graphBytes(root: string): Map<string, Buffer> {
  const paths = git(root, "ls-files", "--", ".hunch/symbols", ".hunch/edges", ".hunch/components")
    .split("\n")
    .filter(Boolean);
  return new Map(paths.map((path) => [path, readFileSync(join(root, path))]));
}

function assertByteMapsEqual(actual: Map<string, Buffer>, expected: Map<string, Buffer>): void {
  assert.deepEqual([...actual.keys()].sort(), [...expected.keys()].sort());
  for (const [path, bytes] of expected) assert.deepEqual(actual.get(path), bytes, `${path} changed`);
}

interface RepositoryState {
  graph: Map<string, Buffer>;
  head: string;
  status: string;
  index: Buffer;
}

function repositoryState(root: string): RepositoryState {
  return {
    graph: graphBytes(root),
    head: git(root, "rev-parse", "HEAD"),
    status: git(root, "status", "--porcelain=v1", "-z"),
    index: readFileSync(join(root, ".git/index")),
  };
}

function assertRepositoryState(root: string, before: RepositoryState): void {
  assert.equal(git(root, "rev-parse", "HEAD"), before.head);
  assert.equal(git(root, "status", "--porcelain=v1", "-z"), before.status);
  assert.deepEqual(readFileSync(join(root, ".git/index")), before.index);
  assertByteMapsEqual(graphBytes(root), before.graph);
}

function runCli(root: string, ...args: string[]): ReturnType<typeof spawnSync> {
  return spawnSync(process.execPath, [TSX, CLI, ...args], {
    cwd: root,
    encoding: "utf8",
    env: { ...process.env, HUNCH_PRIVATE_DIR: "", HUNCH_SYNTH_PROVIDER: "deterministic" },
  });
}

function runCheck(root: string, ...args: string[]): ReturnType<typeof spawnSync> {
  return runCli(root, "check", ...args);
}

function assertArchitectureBlock(run: ReturnType<typeof spawnSync>): void {
  assert.equal(run.status, 1, `${run.stdout}${run.stderr}`);
  assert.match(run.stdout as string, /Architectural conformance/i);
  assert.match(run.stdout as string, /listOrders now reaches .*dbQuery.*VIOLATED/i);
}

function semanticReceipt(
  f: { root: string; store: HunchStore; policyId: string },
  scan: ReturnType<typeof scanRepo>,
) {
  const snapshot = sourceGraphSnapshot(f.root, scan.source, scan.symbols, scan.edges, scan.components);
  return new ConstitutionService(f.store, f.root).evaluate({ id: f.policyId, publicOnly: true, snapshot })[0]!.evaluation;
}

test("pure scan changes conformance and static-policy verdicts without persisting graph JSON", () => {
  const f = fixture();
  try {
    git(f.root, "add", "-A");
    git(f.root, "commit", "-qm", "fixture: layered baseline and memory");
    const before = graphBytes(f.root);
    const service = new ConstitutionService(f.store, f.root);
    assert.equal(checkConformance(f.store)[0]?.satisfied, true);
    assert.equal(service.evaluate({ id: f.policyId, publicOnly: true })[0]?.evaluation.result, "satisfied");

    writeFileSync(join(f.root, "src/api/orders.ts"), BYPASS);
    const scan = scanRepo(f.store, f.root, { churn: false });
    const snapshot = graphSnapshotFromRecords(f.root, "working-tree", scan.symbols, scan.edges, scan.components);

    assert.equal(checkConformance(f.store, { graph: scan })[0]?.satisfied, false);
    assert.equal(service.evaluate({ id: f.policyId, publicOnly: true, snapshot })[0]?.evaluation.result, "violated");
    assertByteMapsEqual(graphBytes(f.root), before);
  } finally {
    f.cleanup();
  }
});

test("CLI and MCP conformance use the complete live working graph without publishing it", async () => {
  const f = fixture();
  let client: Client | undefined;
  try {
    git(f.root, "add", "-A");
    git(f.root, "commit", "-qm", "fixture: layered baseline and memory");
    writeFileSync(join(f.root, "src/api/orders.ts"), BYPASS);
    const beforeViolation = repositoryState(f.root);

    const cliViolation = runCli(f.root, "conform", "--strict");
    assertArchitectureBlock(cliViolation);
    assertRepositoryState(f.root, beforeViolation);

    const env = { ...process.env, HUNCH_PRIVATE_DIR: "", HUNCH_SYNTH_PROVIDER: "deterministic" };
    const transport = new StdioClientTransport({ command: process.execPath, args: [TSX, CLI, "mcp"], cwd: f.root, env });
    client = new Client({ name: "live-conformance-test", version: "1.0.0" });
    await client.connect(transport);
    const mcpViolation = await client.callTool({ name: "hunch_conformance", arguments: {} });
    const violationText = (mcpViolation.content[0] as { type: "text"; text: string }).text;
    assert.notEqual(mcpViolation.isError, true, violationText);
    assert.match(violationText, /listOrders now reaches .*dbQuery.*VIOLATED/i);
    assertRepositoryState(f.root, beforeViolation);

    writeFileSync(join(f.root, "src/api/orders.ts"), "export function listOrders( { return dbQuery();\n");
    const beforeInvalid = repositoryState(f.root);
    const cliInvalid = runCli(f.root, "conform", "--strict");
    assert.equal(cliInvalid.status, 1, `${cliInvalid.stdout}${cliInvalid.stderr}`);
    assert.match(`${cliInvalid.stdout}${cliInvalid.stderr}`, /incomplete semantic source scan rejected 1 file/i);
    assert.match(`${cliInvalid.stdout}${cliInvalid.stderr}`, /parse_failed/i);
    assertRepositoryState(f.root, beforeInvalid);

    const mcpInvalid = await client.callTool({ name: "hunch_conformance", arguments: {} });
    const invalidText = (mcpInvalid.content[0] as { type: "text"; text: string }).text;
    assert.equal(mcpInvalid.isError, true, invalidText);
    assert.match(invalidText, /incomplete working graph/i);
    assert.match(invalidText, /parse_failed/i);
    assertRepositoryState(f.root, beforeInvalid);
  } finally {
    if (client) await client.close();
    f.cleanup();
  }
});

test("default staged check reads stage-0 blobs even when compliant unstaged bytes hide them", () => {
  const f = fixture();
  try {
    git(f.root, "add", "-A");
    git(f.root, "commit", "-qm", "fixture: layered baseline and memory");
    writeFileSync(join(f.root, "src/api/orders.ts"), BYPASS);
    git(f.root, "add", "src/api/orders.ts");
    writeFileSync(join(f.root, "src/api/orders.ts"), LAYERED);

    const stagedScan = scanRepo(f.store, f.root, { churn: false, source: { kind: "staged" } });
    const stagedReceipt = semanticReceipt(f, stagedScan);
    assert.equal(stagedReceipt.result, "violated");
    assert.match(stagedReceipt.repository.head, /^staged:sha1:[0-9a-f]{40}:sha1:[0-9a-f]{40}$/);
    const before = repositoryState(f.root);
    const run = runCheck(f.root, "--strict", "--public-only");

    assertArchitectureBlock(run);
    assertRepositoryState(f.root, before);
  } finally {
    f.cleanup();
  }
});

test("alternate-index pre-commit checks scan the same staged blobs they enumerate", () => {
  const f = fixture();
  try {
    git(f.root, "add", "-A");
    git(f.root, "commit", "-qm", "fixture: layered baseline and memory");
    const alternateIndex = join(f.root, ".git", "alternate-index");
    copyFileSync(join(f.root, ".git", "index"), alternateIndex);
    writeFileSync(join(f.root, "src/api/orders.ts"), BYPASS);
    const alternateEnv = { ...process.env, GIT_INDEX_FILE: alternateIndex };
    execFileSync("git", ["add", "src/api/orders.ts"], { cwd: f.root, env: alternateEnv, stdio: "ignore" });
    writeFileSync(join(f.root, "src/api/orders.ts"), LAYERED);
    const before = repositoryState(f.root);

    const run = spawnSync(process.execPath, [TSX, CLI, "check", "--strict", "--public-only"], {
      cwd: f.root,
      encoding: "utf8",
      env: { ...alternateEnv, HUNCH_PRIVATE_DIR: "", HUNCH_SYNTH_PROVIDER: "deterministic" },
    });

    assertArchitectureBlock(run);
    assertRepositoryState(f.root, before);
  } finally {
    f.cleanup();
  }
});

test("commit check reads the exact commit tree instead of checkout bytes", () => {
  const f = fixture();
  try {
    git(f.root, "add", "-A");
    git(f.root, "commit", "-qm", "fixture: layered baseline and memory");
    writeFileSync(join(f.root, "src/api/orders.ts"), BYPASS);
    git(f.root, "add", "src/api/orders.ts");
    git(f.root, "commit", "-qm", "fixture: violating commit");
    const violatingCommit = git(f.root, "rev-parse", "HEAD");
    writeFileSync(join(f.root, "src/api/orders.ts"), LAYERED);

    const commitScan = scanRepo(f.store, f.root, { churn: false, source: { kind: "commit", ref: violatingCommit } });
    const commitReceipt = semanticReceipt(f, commitScan);
    assert.equal(commitReceipt.result, "violated");
    assert.match(commitReceipt.repository.head, new RegExp(`^commit:${violatingCommit}:sha1:[0-9a-f]{40}:sha1:[0-9a-f]{40}$`));
    const before = repositoryState(f.root);
    const run = runCheck(f.root, "--commit", violatingCommit, "--strict", "--public-only");

    assertArchitectureBlock(run);
    assertRepositoryState(f.root, before);
  } finally {
    f.cleanup();
  }
});

test("base check evaluates the exact current HEAD tree instead of checkout bytes", () => {
  const f = fixture();
  try {
    git(f.root, "add", "-A");
    git(f.root, "commit", "-qm", "fixture: layered baseline and memory");
    const base = git(f.root, "rev-parse", "HEAD");
    writeFileSync(join(f.root, "src/api/orders.ts"), BYPASS);
    git(f.root, "add", "src/api/orders.ts");
    git(f.root, "commit", "-qm", "fixture: violating branch head");
    const head = git(f.root, "rev-parse", "HEAD");
    writeFileSync(join(f.root, "src/api/orders.ts"), LAYERED);

    const baseScan = scanRepo(f.store, f.root, { churn: false, source: { kind: "base" } });
    const baseReceipt = semanticReceipt(f, baseScan);
    assert.equal(baseReceipt.result, "violated");
    assert.match(baseReceipt.repository.head, new RegExp(`^base:${head}:sha1:[0-9a-f]{40}:sha1:[0-9a-f]{40}$`));
    const before = repositoryState(f.root);
    const run = runCheck(f.root, "--base", base, "--strict", "--public-only");

    assertArchitectureBlock(run);
    assertRepositoryState(f.root, before);
  } finally {
    f.cleanup();
  }
});

test("working check includes safe untracked code in its semantic graph", () => {
  const f = fixture();
  try {
    writeFileSync(join(f.root, "src/api/orders.ts"), UNRESOLVED_DB_IMPORT);
    git(f.root, "add", "-A");
    git(f.root, "commit", "-qm", "fixture: unresolved import baseline and memory");
    writeFileSync(join(f.root, "src/db/newclient.ts"), "export function dbQuery(sql: string){ return sql; }\n");

    const workingScan = scanRepo(f.store, f.root, { churn: false, source: { kind: "working" } });
    assert.ok(workingScan.symbols.some((symbol) => symbol.file === "src/db/newclient.ts" && symbol.name === "dbQuery"),
      "working semantic inventory includes the safe untracked symbol");
    assert.equal(checkConformance(f.store, { graph: workingScan })[0]?.satisfied, false);
    assert.match(semanticReceipt(f, workingScan).repository.head, /^working:sha1:[0-9a-f]{40}:sha1:[0-9a-f]{40}$/);

    const before = repositoryState(f.root);
    const run = runCheck(f.root, "--working", "--strict", "--public-only");

    assertArchitectureBlock(run);
    assertRepositoryState(f.root, before);
  } finally {
    f.cleanup();
  }
});

test("source receipts distinguish body-only staged byte changes with identical graph topology", () => {
  const f = fixture();
  try {
    git(f.root, "add", "-A");
    git(f.root, "commit", "-qm", "fixture: layered baseline and memory");
    const baseline = scanRepo(f.store, f.root, { churn: false, source: { kind: "staged" } });
    const baselineSnapshot = sourceGraphSnapshot(f.root, baseline.source, baseline.symbols, baseline.edges, baseline.components);

    writeFileSync(join(f.root, "src/api/orders.ts"), `${LAYERED}// body-only receipt change\n`);
    git(f.root, "add", "src/api/orders.ts");
    const before = repositoryState(f.root);
    const changed = scanRepo(f.store, f.root, { churn: false, source: { kind: "staged" } });
    const changedSnapshot = sourceGraphSnapshot(f.root, changed.source, changed.symbols, changed.edges, changed.components);

    assert.equal(changedSnapshot.graph_hash, baselineSnapshot.graph_hash, "topology is intentionally unchanged");
    assert.notEqual(changed.source.content_hash, baseline.source.content_hash, "raw staged bytes change the source identity");
    assert.notEqual(changedSnapshot.head, baselineSnapshot.head, "the receipt cannot collapse distinct source bodies");
    assertRepositoryState(f.root, before);
  } finally {
    f.cleanup();
  }
});

for (const unsafe of ["symlink", "oversized"] as const) {
  test(`strict staged semantic scan fails closed on a supported-code ${unsafe}`, () => {
    const f = fixture();
    try {
      git(f.root, "add", "-A");
      git(f.root, "commit", "-qm", "fixture: layered baseline and memory");
      const unsafePath = join(f.root, "src/api/unsafe.ts");
      if (unsafe === "symlink") symlinkSync("../db/client.ts", unsafePath);
      else {
        writeFileSync(unsafePath, "");
        truncateSync(unsafePath, MAX_REPO_SOURCE_FILE_BYTES + 1);
      }
      git(f.root, "add", "src/api/unsafe.ts");

      const before = repositoryState(f.root);
      const run = runCheck(f.root, "--strict", "--public-only");

      assert.equal(run.status, 1, `${run.stdout}${run.stderr}`);
      assert.match(run.stdout as string, /Incomplete semantic source scan/i);
      assert.match(run.stdout as string, unsafe === "symlink" ? /unsupported Git mode 120000/i : /exceeds the .* source limit/i);
      assertRepositoryState(f.root, before);
    } finally {
      f.cleanup();
    }
  });
}

for (const source of ["staged", "working"] as const) {
  test(`strict ${source} semantic scan fails closed on syntax-invalid source`, () => {
    const f = fixture();
    try {
      git(f.root, "add", "-A");
      git(f.root, "commit", "-qm", "fixture: layered baseline and memory");
      writeFileSync(join(f.root, "src/api/syntax-error.ts"), "export function broken( { return dbQuery();\n");
      if (source === "staged") git(f.root, "add", "src/api/syntax-error.ts");

      const before = repositoryState(f.root);
      const run = runCheck(f.root, ...(source === "working" ? ["--working"] : []), "--strict", "--public-only");

      assert.equal(run.status, 1, `${run.stdout}${run.stderr}`);
      assert.match(run.stdout as string, /Incomplete semantic source scan/i);
      assert.match(run.stdout as string, /syntax errors.*parse_failed/i);
      assertRepositoryState(f.root, before);
    } finally {
      f.cleanup();
    }
  });
}

for (const source of ["staged", "working"] as const) {
  test(`strict ${source} semantic scan rejects non-UTF-8 source bytes losslessly`, () => {
    const f = fixture();
    try {
      git(f.root, "add", "-A");
      git(f.root, "commit", "-qm", "fixture: layered baseline and memory");
      const path = "src/api/invalid-encoding.ts";
      writeFileSync(join(f.root, path), Buffer.concat([
        Buffer.from("export function validSyntax(){ return true; } // ", "utf8"),
        Buffer.from([0xff]),
        Buffer.from("\n", "utf8"),
      ]));
      if (source === "staged") git(f.root, "add", path);

      const before = repositoryState(f.root);
      const scan = scanRepo(f.store, f.root, { churn: false, source: { kind: source } });
      assert.equal(scan.issues[0]?.code, "invalid_encoding");
      const run = runCheck(f.root, ...(source === "working" ? ["--working"] : []), "--strict", "--public-only");

      assert.equal(run.status, 1, `${run.stdout}${run.stderr}`);
      assert.match(run.stdout as string, /not valid UTF-8.*invalid_encoding/i);
      assertRepositoryState(f.root, before);
    } finally {
      f.cleanup();
    }
  });
}

test("raw non-UTF-8 Git paths remain distinct and make strict staged scans fail closed", () => {
  const f = fixture();
  try {
    git(f.root, "add", "-A");
    git(f.root, "commit", "-qm", "fixture: layered baseline and memory");
    const oid = execFileSync("git", ["hash-object", "-w", "--stdin"], {
      cwd: f.root,
      input: "export function rawPath(){ return true; }\n",
      encoding: "utf8",
    }).trim();
    const rawPath = (byte: number) => Buffer.concat([Buffer.from("src/"), Buffer.from([byte]), Buffer.from(".ts")]);
    const record = (path: Buffer) => Buffer.concat([Buffer.from(`100644 ${oid}\t`), path, Buffer.from([0])]);
    execFileSync("git", ["update-index", "-z", "--index-info"], {
      cwd: f.root,
      input: Buffer.concat([record(rawPath(0x80)), record(rawPath(0x81))]),
      stdio: ["pipe", "ignore", "pipe"],
    });

    const scan = scanRepo(f.store, f.root, { churn: false, source: { kind: "staged" } });
    assert.equal(scan.issues.length, 2);
    assert.equal(new Set(scan.issues.map((issue) => issue.path)).size, 2, "distinct raw pathname bytes cannot collapse through U+FFFD");
    assert.ok(scan.issues.every((issue) => issue.code === "unsafe_path"));

    const before = repositoryState(f.root);
    const run = runCheck(f.root, "--strict", "--public-only");
    assert.equal(run.status, 1, `${run.stdout}${run.stderr}`);
    assert.match(run.stdout as string, /Incomplete semantic source scan/i);
    assert.match(run.stdout as string, /not valid UTF-8.*unsafe_path/i);
    assertRepositoryState(f.root, before);
  } finally {
    f.cleanup();
  }
});

test("live policy evaluation and shadow recording fail closed on an incomplete working source graph", () => {
  const f = fixture();
  try {
    git(f.root, "add", "-A");
    git(f.root, "commit", "-qm", "fixture: layered baseline and memory");
    symlinkSync("../db/client.ts", join(f.root, "src/api/unsafe.ts"));
    const before = repositoryState(f.root);

    const evaluated = runCli(f.root, "policy", "evaluate", f.policyId, "--public-only", "--json");
    assert.equal(evaluated.status, 1, `${evaluated.stdout}${evaluated.stderr}`);
    assert.match(`${evaluated.stdout}${evaluated.stderr}`, /incomplete semantic source scan rejected 1 file/i);
    assert.match(`${evaluated.stdout}${evaluated.stderr}`, /src\/api\/unsafe\.ts \[symlink\]/i);
    assertRepositoryState(f.root, before);

    const shadowed = runCli(f.root, "policy", "shadow", f.policyId, "--record");
    assert.equal(shadowed.status, 1, `${shadowed.stdout}${shadowed.stderr}`);
    assert.match(`${shadowed.stdout}${shadowed.stderr}`, /incomplete semantic source scan rejected 1 file/i);
    assertRepositoryState(f.root, before);
  } finally {
    f.cleanup();
  }
});

test("strict working semantic scan fails closed when a tracked code path becomes non-regular", () => {
  const f = fixture();
  try {
    const device = join(f.root, "src/api/device.ts");
    writeFileSync(device, "export function device(){ return true; }\n");
    git(f.root, "add", "-A");
    git(f.root, "commit", "-qm", "fixture: regular source baseline and memory");
    unlinkSync(device);
    mkdirSync(device);

    const before = repositoryState(f.root);
    const run = runCheck(f.root, "--working", "--strict", "--public-only");

    assert.equal(run.status, 1, `${run.stdout}${run.stderr}`);
    assert.match(run.stdout as string, /Incomplete semantic source scan/i);
    assert.match(run.stdout as string, /not a regular file.*non_regular/i);
    assertRepositoryState(f.root, before);
  } finally {
    f.cleanup();
  }
});

test("strict staged semantic scan fails closed when an indexed blob cannot be read", () => {
  const f = fixture();
  try {
    git(f.root, "add", "-A");
    git(f.root, "commit", "-qm", "fixture: readable baseline and memory");
    const path = "src/api/missing-blob.ts";
    writeFileSync(join(f.root, path), "export function missingBlob(){ return true; }\n");
    git(f.root, "add", path);
    const row = git(f.root, "ls-files", "--stage", "--", path);
    const oid = row.match(/^[0-7]{6} ([0-9a-f]{40,64}) 0\t/)?.[1];
    assert.ok(oid, `fixture stage-0 blob missing: ${row}`);
    unlinkSync(join(f.root, ".git/objects", oid.slice(0, 2), oid.slice(2)));
    const beforeHead = git(f.root, "rev-parse", "HEAD");
    const beforeIndex = readFileSync(join(f.root, ".git/index"));
    const beforeGraph = graphBytes(f.root);

    const run = runCheck(f.root, "--strict", "--public-only");

    assert.equal(run.status, 1, `${run.stdout}${run.stderr}`);
    assert.match(run.stdout as string, /Incomplete semantic source scan/i);
    assert.match(run.stdout as string, /blob could not be read.*read_failed/i);
    assert.equal(git(f.root, "rev-parse", "HEAD"), beforeHead);
    assert.deepEqual(readFileSync(join(f.root, ".git/index")), beforeIndex);
    assertByteMapsEqual(graphBytes(f.root), beforeGraph);
  } finally {
    f.cleanup();
  }
});

test("strict staged semantic scan reports a conflicted entry even when changed-file enumeration is empty", () => {
  const f = fixture();
  try {
    git(f.root, "add", "-A");
    git(f.root, "commit", "-qm", "fixture: conflict base and memory");
    git(f.root, "checkout", "-qb", "other");
    writeFileSync(join(f.root, "src/api/orders.ts"), BYPASS);
    git(f.root, "add", "src/api/orders.ts");
    git(f.root, "commit", "-qm", "fixture: other side");
    git(f.root, "checkout", "-q", "main");
    writeFileSync(join(f.root, "src/api/orders.ts"), `${LAYERED}// main side\n`);
    git(f.root, "add", "src/api/orders.ts");
    git(f.root, "commit", "-qm", "fixture: main side");
    const merge = spawnSync("git", ["merge", "other"], { cwd: f.root, encoding: "utf8" });
    assert.notEqual(merge.status, 0, "fixture must contain an unresolved index conflict");

    const before = repositoryState(f.root);
    const run = runCheck(f.root, "--strict", "--public-only");

    assert.equal(run.status, 1, `${run.stdout}${run.stderr}`);
    assert.match(run.stdout as string, /Incomplete semantic source scan/i);
    assert.match(run.stdout as string, /unresolved Git index stages.*conflicted/i);
    assertRepositoryState(f.root, before);
  } finally {
    f.cleanup();
  }
});
