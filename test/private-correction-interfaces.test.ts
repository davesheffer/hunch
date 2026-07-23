import { test } from "node:test";
import assert from "node:assert/strict";
import { execFileSync, spawnSync } from "node:child_process";
import { existsSync, mkdirSync, readFileSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import { join, relative } from "node:path";
import { tmpdir } from "node:os";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StdioClientTransport } from "@modelcontextprotocol/sdk/client/stdio.js";
import { buildCorrectionConstraint } from "../src/core/correction.js";
import { hunchPaths } from "../src/core/paths.js";
import { indexRepo } from "../src/extractors/indexer.js";
import { HunchStore } from "../src/store/hunchStore.js";

const NOW = "2026-07-17T10:00:00.000Z";
const PROJECT_ROOT = process.cwd();
const TSX = join(PROJECT_ROOT, "node_modules/tsx/dist/cli.mjs");
const CLI = join(PROJECT_ROOT, "src/cli/index.ts");

type PrivateUpgrade = {
  status: "proved" | "already_proved";
  correction_id: string;
  evidence: { id: string; data_class: string };
  policy: { id: string; data_class: string };
  plan: { id: string; data_class: string };
  proof: { id: string; data_class: string };
  authority: string;
};

function git(cwd: string, ...args: string[]): string {
  return execFileSync("git", args, { cwd, encoding: "utf8", stdio: ["ignore", "pipe", "pipe"] }).trim();
}

function initializeRepo(root: string): void {
  git(root, "init", "-q");
  git(root, "config", "user.email", "test@example.com");
  git(root, "config", "user.name", "Test Human");
}

function publishablePublicText(root: string): string {
  const names = execFileSync("git", ["ls-files", "--cached", "--others", "--exclude-standard", "-z"], {
    cwd: root,
    encoding: "utf8",
  }).split("\0").filter(Boolean).sort();
  return names.map((name) => `${name}\0${readFileSync(join(root, name), "utf8")}`).join("\0");
}

function assertExactZero(label: string, text: string, privateTokens: readonly string[]): void {
  for (const token of privateTokens) {
    assert.equal(text.includes(token), false, `${label} leaked exact private token ${JSON.stringify(token)}`);
  }
}

function assertPrivatePacketOnlyInOverlay(
  root: string,
  privateRoot: string,
  upgrade: PrivateUpgrade,
): void {
  const artifacts = [
    ["constraints", upgrade.correction_id],
    ["evidence", upgrade.evidence.id],
    ["policies", upgrade.policy.id],
    ["plans", upgrade.plan.id],
    ["proofs", upgrade.proof.id],
  ] as const;
  for (const [kind, id] of artifacts) {
    assert.ok(existsSync(join(privateRoot, kind, `${id}.json`)), `${kind}/${id} exists in the standalone private overlay`);
    assert.equal(existsSync(join(root, ".hunch", kind, `${id}.json`)), false, `${kind}/${id} never exists in the public home`);
  }
  assert.equal(upgrade.evidence.data_class, "private");
  assert.equal(upgrade.policy.data_class, "private");
  assert.equal(upgrade.plan.data_class, "private");
  assert.equal(upgrade.proof.data_class, "private");
  assert.equal(upgrade.authority, "none");
}

function privateFixture(label: string, autoCommit = false): {
  root: string;
  overlayRoot: string;
  privateRoot: string;
  ruleSentinel: string;
  dependencySentinel: string;
  correctionId: string;
  env: NodeJS.ProcessEnv;
  cleanup: () => void;
} {
  const root = execFileSync("mktemp", ["-d", join(tmpdir(), `hunch-private-${label}-public-XXXXXX`)], { encoding: "utf8" }).trim();
  const overlayRoot = execFileSync("mktemp", ["-d", join(tmpdir(), `hunch-private-${label}-overlay-XXXXXX`)], { encoding: "utf8" }).trim();
  const privateRoot = join(overlayRoot, ".hunch");
  initializeRepo(root);
  initializeRepo(overlayRoot);
  mkdirSync(join(root, "src"), { recursive: true });
  writeFileSync(join(root, "src/orders.ts"), "export function listOrders(user: string) { return user; }\n");
  writeFileSync(join(root, ".gitignore"), ".hunch/hunch.sqlite*\n.hunch/local.json\n");
  git(root, "add", "src/orders.ts", ".gitignore");
  git(root, "commit", "-qm", "fixture: public source");
  git(overlayRoot, "commit", "--allow-empty", "-qm", "fixture: standalone private overlay");

  const initial = new HunchStore(hunchPaths(root));
  initial.json.ensureDirs();
  indexRepo(initial, root, { churn: false });
  initial.reindex();
  initial.close();

  mkdirSync(privateRoot, { recursive: true });
  writeFileSync(join(root, ".hunch/local.json"), JSON.stringify({
    privateDir: privateRoot,
    autoCommit,
    mode: "private",
  }) + "\n");
  const ruleSentinel = `PRIVATE_${label.toUpperCase()}_RULE_SENTINEL: never import @private-${label}/transport`;
  const dependencySentinel = `@private-${label}/transport`;
  const configured = new HunchStore(hunchPaths(root));
  const correction = buildCorrectionConstraint({
    rule: ruleSentinel,
    scope_hint_file: "src/orders.ts",
    severity: "blocking",
    rationale: `PRIVATE_${label.toUpperCase()}_RATIONALE_SENTINEL`,
    knownDeps: [dependencySentinel],
  }, NOW);
  configured.putPrivate("constraints", correction);
  configured.reindex();
  configured.close();

  assert.equal(realpathSync(git(root, "rev-parse", "--show-toplevel")), realpathSync(root));
  assert.equal(realpathSync(git(overlayRoot, "rev-parse", "--show-toplevel")), realpathSync(overlayRoot));
  assert.notEqual(realpathSync(root), realpathSync(overlayRoot));
  assert.match(relative(root, privateRoot), /^\.\.(?:\/|$)/, "private home is outside the public repository");

  return {
    root,
    overlayRoot,
    privateRoot,
    ruleSentinel,
    dependencySentinel,
    correctionId: correction.id,
    env: { ...process.env, HUNCH_PRIVATE_DIR: privateRoot, HUNCH_SYNTH_PROVIDER: "deterministic" },
    cleanup: () => {
      rmSync(root, { recursive: true, force: true });
      rmSync(overlayRoot, { recursive: true, force: true });
    },
  };
}

test("MD-1a private CLI upgrade writes only to a standalone overlay and public CLI output/history stay sentinel-clean", () => {
  const fixture = privateFixture("cli", true);
  try {
    const upgradeRun = spawnSync(process.execPath, [
      TSX, CLI, "policy", "upgrade-correction", fixture.correctionId, "--private", "--json",
    ], { cwd: fixture.root, env: fixture.env, encoding: "utf8" });
    assert.equal(upgradeRun.status, 0, upgradeRun.stderr);
    const upgrade = JSON.parse(upgradeRun.stdout) as PrivateUpgrade;
    assert.equal(upgrade.status, "proved");
    assertPrivatePacketOnlyInOverlay(fixture.root, fixture.privateRoot, upgrade);

    const privateTokens = [
      fixture.ruleSentinel,
      fixture.dependencySentinel,
      `PRIVATE_CLI_RATIONALE_SENTINEL`,
      upgrade.correction_id,
      upgrade.evidence.id,
      upgrade.policy.id,
      upgrade.plan.id,
      upgrade.proof.id,
    ];
    const publicList = spawnSync(process.execPath, [TSX, CLI, "policy", "list", "--public-only", "--json"], {
      cwd: fixture.root,
      env: fixture.env,
      encoding: "utf8",
    });
    assert.equal(publicList.status, 0, publicList.stderr);
    assert.deepEqual(JSON.parse(publicList.stdout), []);
    const publicEvaluation = spawnSync(process.execPath, [TSX, CLI, "policy", "evaluate", "--public-only", "--json"], {
      cwd: fixture.root,
      env: fixture.env,
      encoding: "utf8",
    });
    assert.equal(publicEvaluation.status, 0, publicEvaluation.stderr);
    assert.deepEqual(JSON.parse(publicEvaluation.stdout), []);
    assertExactZero("public CLI outputs", `${publicList.stdout}\n${publicList.stderr}\n${publicEvaluation.stdout}\n${publicEvaluation.stderr}`, privateTokens);
    assertExactZero("public publishable files after CLI upgrade", publishablePublicText(fixture.root), privateTokens);
    assertExactZero("public Git history after CLI upgrade", git(fixture.root, "log", "--all", "-p", "--format=%H%n%s"), privateTokens);
  } finally {
    fixture.cleanup();
  }
});

test("MD-1a private MCP upgrade writes only to a standalone overlay and public MCP output/history stay sentinel-clean", async () => {
  const fixture = privateFixture("mcp", true);
  let client: Client | null = null;
  try {
    const transport = new StdioClientTransport({
      command: process.execPath,
      args: [TSX, CLI, "mcp"],
      cwd: fixture.root,
      env: fixture.env,
    });
    client = new Client({ name: "private-correction-interface-test", version: "1.0.0" });
    await client.connect(transport);
    const upgradeCall = await client.callTool({
      name: "hunch_policy_upgrade_correction",
      arguments: { constraint_id: fixture.correctionId, private_only: true, include_artifacts: true },
    });
    const upgrade = JSON.parse((upgradeCall.content[0] as { type: "text"; text: string }).text) as PrivateUpgrade;
    assert.equal(upgrade.status, "proved");
    assertPrivatePacketOnlyInOverlay(fixture.root, fixture.privateRoot, upgrade);

    const privateTokens = [
      fixture.ruleSentinel,
      fixture.dependencySentinel,
      `PRIVATE_MCP_RATIONALE_SENTINEL`,
      upgrade.correction_id,
      upgrade.evidence.id,
      upgrade.policy.id,
      upgrade.plan.id,
      upgrade.proof.id,
    ];
    const candidates = await client.callTool({ name: "hunch_policy_candidates", arguments: { public_only: true } });
    const escalations = await client.callTool({ name: "hunch_escalations", arguments: {} });
    const evaluations = await client.callTool({ name: "hunch_policy_evaluate", arguments: { public_only: true } });
    const publicMcpOutput = [candidates, escalations, evaluations]
      .flatMap((result) => result.content)
      .filter((part): part is { type: "text"; text: string } => part.type === "text")
      .map((part) => part.text)
      .join("\n");
    assert.match(publicMcpOutput, /No Constitution policy candidates/);
    assert.match(publicMcpOutput, /Nothing needs a human decision/);
    assertExactZero("public MCP outputs", publicMcpOutput, privateTokens);
    assertExactZero("public publishable files after MCP upgrade", publishablePublicText(fixture.root), privateTokens);
    assertExactZero("public Git history after MCP upgrade", git(fixture.root, "log", "--all", "-p", "--format=%H%n%s"), privateTokens);
  } finally {
    if (client) await client.close();
    fixture.cleanup();
  }
});
