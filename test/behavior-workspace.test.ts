import test from "node:test";
import assert from "node:assert/strict";
import { execFileSync, spawnSync } from "node:child_process";
import { chmodSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { runHunchWith } from "../vscode-extension/src/spawnCore.js";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StdioClientTransport } from "@modelcontextprotocol/sdk/client/stdio.js";
import { evaluateExecutableBehaviorPolicy } from "../src/constitution/behaviorEvaluator.js";
import { canonicalHash } from "../src/constitution/canonical.js";
import { provisionG2BehaviorDependencySnapshotsForCommits } from "../src/constitution/g2BehaviorDependencies.js";
import { PolicySpecSchema, type PolicySpec } from "../src/constitution/schema.js";
import { shortHash } from "../src/core/ids.js";
import type { G2BehaviorAttestation } from "../src/constitution/g2BehaviorAttestation.js";

function workspaceFixture(): { root: string; policy: PolicySpec; attestation: G2BehaviorAttestation; cleanup: () => void } {
  const root = mkdtempSync(join(tmpdir(), "hunch-behavior-workspace-"));
  const git = (...args: string[]): string => execFileSync("git", args, { cwd: root, encoding: "utf8" }).trim();
  git("init", "-q");
  git("config", "user.email", "test@example.com");
  git("config", "user.name", "Test Human");
  mkdirSync(join(root, "src"), { recursive: true });
  mkdirSync(join(root, "test"), { recursive: true });
  writeFileSync(join(root, "package.json"), JSON.stringify({ name: "behavior-workspace-fixture", version: "1.0.0", type: "module" }));
  writeFileSync(join(root, "package-lock.json"), JSON.stringify({
    name: "behavior-workspace-fixture",
    version: "1.0.0",
    lockfileVersion: 3,
    requires: true,
    packages: { "": { name: "behavior-workspace-fixture", version: "1.0.0" } },
  }));
  writeFileSync(join(root, "src/guard.mjs"), "export function guarded(){ return true; }\n");
  const testSource = [
    'import test from "node:test";',
    'import assert from "node:assert/strict";',
    'import { guarded } from "../src/guard.mjs";',
    'test("guard remains enabled", () => assert.equal(guarded(), true));',
    "",
  ].join("\n");
  writeFileSync(join(root, "test/guard.test.mjs"), testSource);
  git("add", "-A");
  git("commit", "-qm", "fixture: guarded behavior");
  const head = git("rev-parse", "HEAD");
  const snapshots = provisionG2BehaviorDependencySnapshotsForCommits(root, [head]);
  const at = "2026-07-11T20:00:00.000Z";
  const attestationBody = {
    candidate_id: "g2behavior_aaaaaaaaaa",
    candidate_hash: `sha1:${"b".repeat(40)}`,
    commit: head,
    review_hash: `sha1:${"d".repeat(40)}`,
    replay_id: "g2behaviorreplay_aaaaaaaaaa",
    replay_hash: `sha1:${"c".repeat(40)}`,
    dependency_snapshot_ids: snapshots.snapshots.map((snapshot) => snapshot.id),
    disposition: "selected" as const,
    actor: "human:test",
    reason: "The exact executable regression is the durable behavior.",
    supersedes: null,
    data_class: "private" as const,
    authority: "none" as const,
    effects: "review_only" as const,
    created_at: at,
  };
  const attestationHash = canonicalHash(attestationBody);
  const attestation: G2BehaviorAttestation = {
    id: `g2behaviorattest_${shortHash(attestationHash)}`,
    content_hash: attestationHash,
    ...attestationBody,
  };
  const policy = PolicySpecSchema.parse({
    id: "pol_aaaaaaaaaa",
    topic: "behavior.workspace",
    ir_version: 2,
    revision: 3,
    state: "active_advisory",
    statement: "The guarded behavior remains enabled in the pending workspace snapshot.",
    rationale: "A hash-pinned executable regression detects the disabled guard.",
    scope: { repos: ["behavior-workspace-fixture"], paths: [], components: [] },
    assertion: {
      kind: "executable-behavior",
      test: { file: "test/guard.test.mjs", name: "guard remains enabled", source_commit: head, source_hash: canonicalHash(testSource) },
      runner: "node-test",
      attestation: {
        id: attestation.id,
        content_hash: attestation.content_hash,
        candidate_id: attestation.candidate_id,
        candidate_hash: attestation.candidate_hash,
        replay_id: attestation.replay_id,
        replay_hash: attestation.replay_hash,
      },
      dependency_snapshot_ids: snapshots.snapshots.map((snapshot) => snapshot.id),
      timeout_ms: 30_000,
    },
    severity: "warning",
    surfaces: ["pre_commit", "ci", "mcp", "cli"],
    authority: { kind: "human", actor: "human:test", event: `approval-advisory:${at}`, at },
    evidence: ["fixture"],
    proof: null,
    reversal_conditions: [],
    supersedes: null,
    superseded_by: null,
    exception_of: null,
    valid_from: at,
    valid_to: null,
    data_class: "private",
    limitations: [],
    candidate: { alternatives: [], uncertainty: [], conflicts: [], incumbent: null, scope_suggestion: null, counterexamples: [] },
    legacy_refs: [],
    audit: [],
    created_at: at,
    updated_at: at,
    provenance: { source: "human_confirmed+executable_regression", confidence: 1, evidence: ["fixture"], last_verified: at },
  });
  return { root, policy, attestation, cleanup: () => rmSync(root, { recursive: true, force: true }) };
}

test("executable advisory evaluation distinguishes committed, staged, and working snapshots", () => {
  const fixture = workspaceFixture();
  try {
    assert.equal(evaluateExecutableBehaviorPolicy(fixture.root, fixture.policy).result, "satisfied");

    writeFileSync(join(fixture.root, "src/guard.mjs"), "export function guarded(){ return false; }\n");
    const working = evaluateExecutableBehaviorPolicy(fixture.root, fixture.policy, { workspace: "working" } as never);
    assert.equal(working.result, "violated", "an uncommitted regression must not inherit committed HEAD's satisfied result");
    assert.equal(working.behavior?.workspace?.kind, "working");
    assert.match(working.behavior?.workspace?.snapshot_hash ?? "", /^sha1:[a-f0-9]{40}$/);
    assert.equal(working.repository.base, working.behavior?.commit);
    assert.equal(working.repository.head, `working:${working.behavior?.workspace?.snapshot_hash}`);

    execFileSync("git", ["add", "src/guard.mjs"], { cwd: fixture.root });
    writeFileSync(join(fixture.root, "src/guard.mjs"), "export function guarded(){ return true; }\n");
    const staged = evaluateExecutableBehaviorPolicy(fixture.root, fixture.policy, { workspace: "staged" } as never);
    const completeWorking = evaluateExecutableBehaviorPolicy(fixture.root, fixture.policy, { workspace: "working" } as never);
    assert.equal(staged.result, "violated", "staged evaluation uses the index snapshot even when the worktree differs");
    assert.equal(completeWorking.result, "satisfied", "working evaluation uses the complete worktree rather than the staged snapshot");

    writeFileSync(join(fixture.root, "src/pending.mjs"), "export const pending = false;\n");
    writeFileSync(join(fixture.root, "src/guard.mjs"), 'import { pending } from "./pending.mjs";\nexport function guarded(){ return pending; }\n');
    const untracked = evaluateExecutableBehaviorPolicy(fixture.root, fixture.policy, { workspace: "working" } as never);
    assert.equal(untracked.result, "violated", "working evaluation materializes untracked source dependencies");
    assert.ok(untracked.behavior?.workspace?.files.includes("src/pending.mjs"));

    writeFileSync(join(fixture.root, "package.json"), JSON.stringify({ name: "changed-dependencies", version: "1.0.0", type: "module" }));
    const dependencyChange = evaluateExecutableBehaviorPolicy(fixture.root, fixture.policy, { workspace: "working" } as never);
    assert.equal(dependencyChange.result, "error");
    assert.equal(dependencyChange.behavior?.error_code, "workspace-dependency-input-changed", "dependency drift is visible instead of running against a stale snapshot");
  } finally {
    fixture.cleanup();
  }
});

test("CLI, MCP, and check share one non-blocking working-snapshot receipt without public leakage", async () => {
  const fixture = workspaceFixture();
  const privateRoot = join(fixture.root, "private/.hunch");
  const tsx = join(process.cwd(), "node_modules/tsx/dist/cli.mjs");
  const cli = join(process.cwd(), "src/cli/index.ts");
  const env = { ...process.env, HUNCH_PRIVATE_DIR: privateRoot, HUNCH_SYNTH_PROVIDER: "deterministic", NO_COLOR: "1" };
  let client: Client | null = null;
  try {
    mkdirSync(join(privateRoot, "policies"), { recursive: true });
    mkdirSync(join(privateRoot, "behavior-attestations"), { recursive: true });
    writeFileSync(join(privateRoot, "policies", `${fixture.policy.id}.json`), `${JSON.stringify(fixture.policy, null, 2)}\n`);
    writeFileSync(join(privateRoot, "behavior-attestations", `${fixture.attestation.id}.json`), `${JSON.stringify(fixture.attestation, null, 2)}\n`);
    writeFileSync(join(fixture.root, "src/guard.mjs"), "export function guarded(){ return false; }\n");

    const cliRun = spawnSync(process.execPath, [tsx, cli, "policy", "evaluate", fixture.policy.id, "--active", "--working", "--strict", "--json"], {
      cwd: fixture.root,
      env,
      encoding: "utf8",
    });
    assert.equal(cliRun.status, 0, cliRun.stderr);
    const cliReceipt = (JSON.parse(cliRun.stdout) as Array<{ result: string; deterministic_hash: string }>)[0]!;
    assert.equal(cliReceipt.result, "violated");

    const transport = new StdioClientTransport({ command: process.execPath, args: [tsx, cli, "mcp"], cwd: fixture.root, env });
    client = new Client({ name: "behavior-workspace-contract-test", version: "1.0.0" });
    await client.connect(transport);
    const mcpCall = await client.callTool({
      name: "hunch_policy_evaluate",
      arguments: { policy_id: fixture.policy.id, active_only: true, workspace: "working" },
    });
    const mcpReceipt = (JSON.parse((mcpCall.content[0] as { type: "text"; text: string }).text) as Array<{ result: string; deterministic_hash: string }>)[0]!;
    assert.equal(mcpReceipt.result, "violated");
    assert.equal(mcpReceipt.deterministic_hash, cliReceipt.deterministic_hash);

    const checkRun = spawnSync(process.execPath, [tsx, cli, "check", "--working", "--strict"], {
      cwd: fixture.root,
      env,
      encoding: "utf8",
    });
    assert.equal(checkRun.status, 0, "an active advisory violation warns but never blocks");
    assert.match(checkRun.stdout, new RegExp(`receipt: ${cliReceipt.deterministic_hash}`));
    assert.match(checkRun.stdout, new RegExp(`${fixture.policy.id} \\[active_advisory\\] violated`));

    const publicRun = spawnSync(process.execPath, [tsx, cli, "check", "--working", "--strict", "--public-only"], {
      cwd: fixture.root,
      env,
      encoding: "utf8",
    });
    assert.equal(publicRun.status, 0, publicRun.stderr);
    assert.doesNotMatch(`${publicRun.stdout}\n${publicRun.stderr}`, new RegExp(`${fixture.policy.id}|guard remains enabled`));

    execFileSync("git", ["add", "src/guard.mjs"], { cwd: fixture.root });
    writeFileSync(join(fixture.root, "src/guard.mjs"), "export function guarded(){ return true; }\n");
    const stagedCli = spawnSync(process.execPath, [tsx, cli, "policy", "evaluate", fixture.policy.id, "--active", "--staged", "--strict", "--json"], {
      cwd: fixture.root,
      env,
      encoding: "utf8",
    });
    assert.equal(stagedCli.status, 0, stagedCli.stderr);
    const stagedReceipt = (JSON.parse(stagedCli.stdout) as Array<{ result: string; deterministic_hash: string }>)[0]!;
    assert.equal(stagedReceipt.result, "violated");
    const stagedMcpCall = await client.callTool({
      name: "hunch_policy_evaluate",
      arguments: { policy_id: fixture.policy.id, active_only: true, workspace: "staged" },
    });
    const stagedMcpReceipt = (JSON.parse((stagedMcpCall.content[0] as { type: "text"; text: string }).text) as Array<{ deterministic_hash: string }>)[0]!;
    assert.equal(stagedMcpReceipt.deterministic_hash, stagedReceipt.deterministic_hash);
    const stagedCheck = spawnSync(process.execPath, [tsx, cli, "check", "--strict"], {
      cwd: fixture.root,
      env,
      encoding: "utf8",
    });
    assert.equal(stagedCheck.status, 0, "default pre-commit check warns but does not block an advisory violation");
    assert.match(stagedCheck.stdout, new RegExp(`receipt: ${stagedReceipt.deterministic_hash}`));
    const workingCli = spawnSync(process.execPath, [tsx, cli, "policy", "evaluate", fixture.policy.id, "--active", "--working", "--json"], {
      cwd: fixture.root,
      env,
      encoding: "utf8",
    });
    assert.equal(workingCli.status, 0, workingCli.stderr);
    assert.equal((JSON.parse(workingCli.stdout) as Array<{ result: string }>)[0]?.result, "satisfied", "working evaluation sees the unstaged repair over the staged regression");
  } finally {
    if (client) await client.close();
    fixture.cleanup();
  }
});

// The four-client conformance fixture (G3 profile ci/cli/mcp/vscode): the VS Code
// surface is certified by executing the extension's REAL spawn seam
// (vscode-extension/src/spawnCore.runHunchWith) against a real npm-style shim —
// the exact quoting, Windows .cmd handling, and result shaping the panel uses.
// Labels are not evidence (dec_ce86ca9cec); only this execution is.
test("CLI, MCP, check, and the VS Code seam share one non-blocking working-snapshot receipt without public leakage", async () => {
  const fixture = workspaceFixture();
  const privateRoot = join(fixture.root, "private/.hunch");
  const tsx = join(process.cwd(), "node_modules/tsx/dist/cli.mjs");
  const cli = join(process.cwd(), "src/cli/index.ts");
  const envPatch: Record<string, string> = { HUNCH_PRIVATE_DIR: privateRoot, HUNCH_SYNTH_PROVIDER: "deterministic", NO_COLOR: "1" };
  const saved = new Map(Object.keys(envPatch).map((key) => [key, process.env[key]] as const));
  let client: Client | null = null;
  let binDir: string | null = null;
  try {
    mkdirSync(join(privateRoot, "policies"), { recursive: true });
    mkdirSync(join(privateRoot, "behavior-attestations"), { recursive: true });
    writeFileSync(join(privateRoot, "policies", `${fixture.policy.id}.json`), `${JSON.stringify(fixture.policy, null, 2)}\n`);
    writeFileSync(join(privateRoot, "behavior-attestations", `${fixture.attestation.id}.json`), `${JSON.stringify(fixture.attestation, null, 2)}\n`);
    writeFileSync(join(fixture.root, "src/guard.mjs"), "export function guarded(){ return false; }\n");
    const env = { ...process.env, ...envPatch };

    // Surface 1 — CLI (the canonical receipt)
    const cliRun = spawnSync(process.execPath, [tsx, cli, "policy", "evaluate", fixture.policy.id, "--active", "--working", "--strict", "--json"], { cwd: fixture.root, env, encoding: "utf8" });
    assert.equal(cliRun.status, 0, cliRun.stderr);
    const cliReceipt = (JSON.parse(cliRun.stdout) as Array<{ result: string; deterministic_hash: string }>)[0]!;
    assert.equal(cliReceipt.result, "violated");

    // Surface 2 — client-neutral MCP
    const transport = new StdioClientTransport({ command: process.execPath, args: [tsx, cli, "mcp"], cwd: fixture.root, env });
    client = new Client({ name: "vscode-conformance-test", version: "1.0.0" });
    await client.connect(transport);
    const mcpCall = await client.callTool({ name: "hunch_policy_evaluate", arguments: { policy_id: fixture.policy.id, active_only: true, workspace: "working" } });
    const mcpReceipt = (JSON.parse((mcpCall.content[0] as { type: "text"; text: string }).text) as Array<{ deterministic_hash: string }>)[0]!;
    assert.equal(mcpReceipt.deterministic_hash, cliReceipt.deterministic_hash);

    // Surface 3 — check (the CI/pre-commit surface)
    const checkRun = spawnSync(process.execPath, [tsx, cli, "check", "--working", "--strict"], { cwd: fixture.root, env, encoding: "utf8" });
    assert.equal(checkRun.status, 0, "an active advisory violation warns but never blocks");
    assert.match(checkRun.stdout, new RegExp(`receipt: ${cliReceipt.deterministic_hash}`));

    // Surface 4 — the VS Code seam: a real npm-style shim, spawned exactly as the
    // panel spawns `hunch` (spawnCore), inheriting the host environment. The shim
    // lives OUTSIDE the fixture repo — a working snapshot includes untracked
    // files, so planting it inside would (correctly) change the receipt.
    binDir = mkdtempSync(join(tmpdir(), "hunch-vscode-shim-"));
    let shim: string;
    if (process.platform === "win32") {
      shim = join(binDir, "hunch.cmd");
      writeFileSync(shim, `@"${process.execPath}" "${tsx}" "${cli}" %*\r\n`);
    } else {
      shim = join(binDir, "hunch");
      writeFileSync(shim, `#!/bin/sh\nexec "${process.execPath}" "${tsx}" "${cli}" "$@"\n`);
      chmodSync(shim, 0o755);
    }
    Object.assign(process.env, envPatch); // the extension seam inherits VS Code's env
    const vs = await runHunchWith(shim, fixture.root, ["policy", "evaluate", fixture.policy.id, "--active", "--working", "--strict", "--json"]);
    assert.equal(vs.ok, true, vs.stderr);
    const vsReceipt = (JSON.parse(vs.stdout) as Array<{ result: string; deterministic_hash: string }>)[0]!;
    assert.equal(vsReceipt.result, "violated");
    assert.equal(vsReceipt.deterministic_hash, cliReceipt.deterministic_hash, "the VS Code seam returns the identical canonical receipt");

    // Public-only leak resistance THROUGH the seam — nothing private can ever
    // reach a render surface the panel would show from public-only output.
    const pub = await runHunchWith(shim, fixture.root, ["check", "--working", "--strict", "--public-only"]);
    assert.equal(pub.ok, true, pub.stderr);
    assert.doesNotMatch(`${pub.stdout}\n${pub.stderr}`, new RegExp(`${fixture.policy.id}|guard remains enabled`));
  } finally {
    for (const [key, value] of saved) {
      if (value === undefined) delete process.env[key];
      else process.env[key] = value;
    }
    if (client) await client.close();
    if (binDir) { try { rmSync(binDir, { recursive: true, force: true }); } catch { /* best effort */ } }
    fixture.cleanup();
  }
});
