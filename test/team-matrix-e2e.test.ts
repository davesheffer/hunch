import assert from "node:assert/strict";
import { execFileSync, spawnSync } from "node:child_process";
import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  realpathSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { test } from "node:test";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StdioClientTransport } from "@modelcontextprotocol/sdk/client/stdio.js";

const PROJECT_ROOT = process.cwd();
const TSX = join(PROJECT_ROOT, "node_modules/tsx/dist/cli.mjs");
const CLI = join(PROJECT_ROOT, "src/cli/index.ts");
const TEAM_RULE = "MATRIX_TEAM_RULE: never import axios in src/orders.ts; use the shared fetch transport";
const FIRST_COMMAND_WRITE_RULE = "MATRIX_FIRST_COMMAND_WRITE: keep retry state outside the public code repository";
const INITIAL_SOURCE = [
  "export async function listOrders(user: string) {",
  "  const response = await fetch(`/orders/${user}`);",
  "  return response.json();",
  "}",
  "",
].join("\n");
const VIOLATING_SOURCE = [
  'import axios from "axios";',
  "export const orderCacheKey = (user: string) => `orders:${user}`;",
  "export async function listOrders(user: string) {",
  "  return (await axios.get(`/orders/${user}`)).data;",
  "}",
  "",
].join("\n");
const REPAIRED_SOURCE = [
  "export const orderCacheKey = (user: string) => `orders:${user}`;",
  "export async function listOrders(user: string) {",
  "  const response = await fetch(`/orders/${user}`);",
  "  return response.json();",
  "}",
  "",
].join("\n");

type Actor = {
  name: string;
  root: string;
  home: string;
  env: NodeJS.ProcessEnv;
};

type CorrectionUpgrade = {
  status: string;
  evidence: { id: string; data_class: string };
  policy: null | { id: string; state: string; authority: unknown };
  plan: null | { id: string; content_hash: string };
  proof: null | { id: string; content_hash: string; proof_class: string };
  authority: string;
};

function git(cwd: string, ...args: string[]): string {
  return execFileSync("git", args, {
    cwd,
    encoding: "utf8",
    env: { ...process.env, GIT_CONFIG_NOSYSTEM: "1" },
    stdio: ["ignore", "pipe", "pipe"],
  }).trim();
}

function configureRepo(root: string, actor: string, sandbox: string): void {
  // Hooks are machine-local state. Giving every simulated teammate the same
  // hooksPath would let Architect's `hunch init` install a post-commit hook for
  // Developer and Reviewer too — cross-machine behavior Git never provides.
  const hooks = join(sandbox, `${actor.toLowerCase()}-hooks`);
  mkdirSync(hooks, { recursive: true });
  git(root, "config", "user.name", actor);
  git(root, "config", "user.email", `${actor.toLowerCase()}@matrix.test`);
  git(root, "config", "commit.gpgsign", "false");
  git(root, "config", "core.hooksPath", hooks);
}

function actorEnv(home: string, name: string): NodeJS.ProcessEnv {
  return {
    ...process.env,
    HOME: home,
    USERPROFILE: home,
    XDG_CONFIG_HOME: join(home, ".config"),
    GIT_CONFIG_NOSYSTEM: "1",
    GIT_AUTHOR_NAME: name,
    GIT_AUTHOR_EMAIL: `${name.toLowerCase()}@matrix.test`,
    GIT_COMMITTER_NAME: name,
    GIT_COMMITTER_EMAIL: `${name.toLowerCase()}@matrix.test`,
    HUNCH_PRIVATE_DIR: "",
    HUNCH_SYNTH_PROVIDER: "deterministic",
    HUNCH_EMBEDDINGS: "off",
    HUNCH_TEAM_CLONE_DEBUG: "1",
    GIT_TERMINAL_PROMPT: "0",
    NO_COLOR: "1",
    CI: "1",
  };
}

function cloneActor(sandbox: string, codeRemote: string, name: string): Actor {
  const root = join(sandbox, name.toLowerCase());
  const home = join(sandbox, `${name.toLowerCase()}-home`);
  mkdirSync(home, { recursive: true });
  git(sandbox, "clone", "-q", codeRemote, root);
  configureRepo(root, name, sandbox);
  return { name, root, home, env: actorEnv(home, name) };
}

function runCli(actor: Actor, ...args: string[]) {
  return spawnSync(process.execPath, [TSX, CLI, ...args], {
    cwd: actor.root,
    env: actor.env,
    encoding: "utf8",
    timeout: 45_000,
    maxBuffer: 16 * 1024 * 1024,
  });
}

function output(run: ReturnType<typeof runCli>): string {
  return `${run.stdout ?? ""}${run.stderr ?? ""}`;
}

function expectCli(actor: Actor, args: string[], status = 0): string {
  const run = runCli(actor, ...args);
  assert.equal(run.error, undefined, run.error?.message);
  assert.equal(run.signal, null, output(run));
  assert.equal(run.status, status, output(run));
  return output(run);
}

async function connectMcp(actor: Actor): Promise<Client> {
  const transport = new StdioClientTransport({
    command: process.execPath,
    args: [TSX, CLI, "mcp"],
    cwd: actor.root,
    env: actor.env,
  });
  const client = new Client({ name: `matrix-${actor.name.toLowerCase()}`, version: "1.0.0" });
  await client.connect(transport);
  return client;
}

async function mcpText(client: Client, name: string, args: Record<string, unknown>): Promise<string> {
  const response = await client.callTool({ name, arguments: args });
  assert.notEqual(response.isError, true, JSON.stringify(response.content));
  const payload = response.content.find((part): part is { type: "text"; text: string } => part.type === "text");
  assert.ok(payload, `${name} returned no text payload`);
  return payload.text;
}

async function mcpJson<T>(client: Client, name: string, args: Record<string, unknown>): Promise<T> {
  return JSON.parse(await mcpText(client, name, args)) as T;
}

async function recordDecision(
  client: Client,
  input: { topic: string; title: string; decision: string; relatedFiles?: string[] },
): Promise<{ id: string; text: string }> {
  const interview = await mcpText(client, "hunch_capture_decision", {
    topic: input.topic,
    seed: input.decision,
    deciding: true,
  });
  const token = interview.match(/capture_token:\"([^\"]+)\"/)?.[1];
  assert.ok(token, interview);
  const text = await mcpText(client, "hunch_record_decision", {
    capture_token: token,
    decision: {
      topic: input.topic,
      title: input.title,
      decision: input.decision,
      context: "The whole team needs one durable answer across clones and assistant sessions.",
      alternatives_rejected: ["Direct axios calls — revisit if the shared transport loses required controls."],
      related_files: input.relatedFiles ?? ["src/orders.ts"],
      status: "accepted",
    },
  });
  const id = text.match(/Recorded decision (dec_[A-Za-z0-9_-]+)/)?.[1];
  assert.ok(id, text);
  assert.match(text, /SHARED store/);
  assert.match(text, /committed \+ pushed/);
  return { id, text };
}

function remoteTree(remote: string): string[] {
  const text = execFileSync("git", ["--git-dir", remote, "ls-tree", "-r", "--name-only", "main"], {
    encoding: "utf8",
  }).trim();
  return text ? text.split("\n").sort() : [];
}

function remoteJson<T>(remote: string, path: string): T {
  return JSON.parse(execFileSync("git", ["--git-dir", remote, "show", `main:${path}`], {
    encoding: "utf8",
  })) as T;
}

function seedRemotes(sandbox: string): { codeRemote: string; memoryRemote: string } {
  const memorySeed = join(sandbox, "memory-seed");
  const memoryRemote = join(sandbox, "memory.git");
  mkdirSync(memorySeed, { recursive: true });
  git(memorySeed, "init", "-q", "-b", "main");
  configureRepo(memorySeed, "MemorySeed", sandbox);
  writeFileSync(join(memorySeed, "README.md"), "# Matrix team memory\n");
  git(memorySeed, "add", "README.md");
  git(memorySeed, "commit", "-qm", "seed: shared memory repository");
  git(sandbox, "clone", "-q", "--bare", memorySeed, memoryRemote);

  const codeSeed = join(sandbox, "code-seed");
  const codeRemote = join(sandbox, "code.git");
  mkdirSync(join(codeSeed, "src"), { recursive: true });
  git(codeSeed, "init", "-q", "-b", "main");
  configureRepo(codeSeed, "CodeSeed", sandbox);
  writeFileSync(join(codeSeed, ".gitignore"), "node_modules/\n");
  writeFileSync(join(codeSeed, "package.json"), `${JSON.stringify({
    name: "matrix-team-fixture",
    private: true,
    type: "module",
    dependencies: { axios: "1.0.0" },
  }, null, 2)}\n`);
  writeFileSync(join(codeSeed, "src/orders.ts"), INITIAL_SOURCE);
  git(codeSeed, "add", ".gitignore", "package.json", "src/orders.ts");
  git(codeSeed, "commit", "-qm", "feat: tiny orders service");
  git(sandbox, "clone", "-q", "--bare", codeSeed, codeRemote);
  return { codeRemote, memoryRemote };
}

test("team Matrix: three isolated clones share live memory, catch a bad branch, repair it, and never leak it publicly", { timeout: 300_000 }, async () => {
  const sandbox = mkdtempSync(join(tmpdir(), "hunch-team-matrix-"));
  const clients: Client[] = [];
  try {
    const { codeRemote, memoryRemote } = seedRemotes(sandbox);
    const architect = cloneActor(sandbox, codeRemote, "Architect");

    expectCli(architect, ["init", "--no-index", "--no-enforce", "--no-providers", "--no-agent-hooks"]);
    const rejectedShared = runCli(architect, "shared", "--repo", "https://matrix-token@example.test/memory.git", "--no-hook");
    assert.equal(rejectedShared.status, 1, output(rejectedShared));
    assert.match(output(rejectedShared), /without embedded credentials/);
    assert.equal(existsSync(join(architect.root, ".hunch-private")), false,
      "an unsafe committed team URL must be rejected before cloning an overlay");
    assert.equal(existsSync(join(architect.root, ".hunch", "local.json")), false,
      "an unsafe committed team URL must be rejected before writing a local pointer");
    const sharedSetup = expectCli(architect, ["shared", "--repo", memoryRemote, "--no-hook"]);
    assert.match(sharedSetup, /shared overlay enabled/);
    assert.match(sharedSetup, /UNIFIED/);
    git(architect.root, "add", "-A");
    git(architect.root, "commit", "-qm", "chore: connect the team memory Matrix");
    git(architect.root, "push", "-q", "origin", "main");

    const linkedWorktree = join(sandbox, "architect-linked-worktree");
    const worktreeSetup = expectCli(architect, [
      "worktree", linkedWorktree, "-b", "matrix-linked-worktree", "--no-index",
    ]);
    assert.match(worktreeSetup, /memory shared via the git common dir/);
    const commonDirRaw = git(architect.root, "rev-parse", "--git-common-dir");
    const commonDir = resolve(architect.root, commonDirRaw);
    const sharedPointer = JSON.parse(readFileSync(join(commonDir, "hunch", "local.json"), "utf8")) as { mode: string };
    assert.equal(sharedPointer.mode, "shared", "hunch worktree must preserve unified team routing");

    const architectClient = await connectMcp(architect);
    clients.push(architectClient);
    const linkedArchitect: Actor = { ...architect, name: "ArchitectWorktree", root: linkedWorktree };
    const heartbeatCapture = expectCli(linkedArchitect, [
      "record-constraint",
      "MATRIX_EXTERNAL_HEARTBEAT: preserve the live same-overlay refresh path",
      "--scope", "src/matrix-heartbeat.ts",
      "--severity", "warning",
      "--type", "correctness",
    ]);
    const heartbeatId = heartbeatCapture.match(/constraint (con_[A-Za-z0-9_-]+)/)?.[1];
    assert.ok(heartbeatId, heartbeatCapture);
    const sameOverlayRefresh = await mcpText(architectClient, "hunch_query", { query: "MATRIX_EXTERNAL_HEARTBEAT" });
    assert.match(sameOverlayRefresh, new RegExp(heartbeatId),
      "a CLI process that advances the same overlay must invalidate the long-lived MCP FTS index");
    git(architect.root, "worktree", "remove", "--force", linkedWorktree);
    const architecture = await recordDecision(architectClient, {
      topic: "orders.transport",
      title: "Orders use the shared fetch transport",
      decision: "Use fetch through the shared transport boundary; never call axios directly in orders.",
    });
    assert.ok(remoteTree(memoryRemote).includes(`.hunch/decisions/${architecture.id}.json`),
      "the architect's decision must reach the shared bare remote, not merely local disk");

    const developer = cloneActor(sandbox, codeRemote, "Developer");
    assert.equal(existsSync(join(developer.root, ".hunch", "local.json")), false,
      "the teammate begins as a genuinely fresh clone");
    const firstWrite = expectCli(developer, [
      "record-constraint",
      FIRST_COMMAND_WRITE_RULE,
      "--scope", "src/matrix-first-command.ts",
      "--severity", "warning",
      "--type", "correctness",
    ]);
    const firstWriteId = firstWrite.match(/constraint (con_[A-Za-z0-9_-]+)/)?.[1];
    assert.ok(firstWriteId, firstWrite);
    assert.match(firstWrite, /committed \+ pushed/);
    assert.ok(remoteTree(memoryRemote).includes(`.hunch/constraints/${firstWriteId}.json`),
      "a fresh clone's first CLI write must publish to shared memory");
    assert.equal(existsSync(join(developer.root, ".hunch", "constraints", `${firstWriteId}.json`)), false,
      "a fresh clone's first CLI write must never land in public code memory");
    assert.ok(!remoteTree(codeRemote).includes(`.hunch/constraints/${firstWriteId}.json`));
    assert.equal(git(developer.root, "status", "--short"), "",
      "first-command auto-wiring may create only ignored machine-local code-repo state");
    const developerClient = await connectMcp(developer);
    clients.push(developerClient);
    const initialGrounding = await mcpText(developerClient, "hunch_current_decision", { topic: "orders.transport" });
    assert.match(initialGrounding, new RegExp(architecture.id));
    const developerPointer = JSON.parse(readFileSync(join(developer.root, ".hunch", "local.json"), "utf8")) as {
      privateDir: string;
      mode: string;
    };
    assert.equal(developerPointer.mode, "shared");
    const developerOverlayRoot = resolve(developer.root, developerPointer.privateDir, "..");
    assert.match(git(developerOverlayRoot, "config", "--get", "merge.hunch.driver"), /merge-driver/,
      "a fresh teammate clone must be ready to converge structured memory conflicts");
    assert.match(readFileSync(join(developerOverlayRoot, ".gitattributes"), "utf8"), /\.hunch\/\*\*\/\*\.json merge=hunch/);
    assert.equal(git(developer.root, "status", "--short", "--", ".hunch/local.json"), "",
      "the machine-local pointer is ignored and cannot ride the code branch");

    // Execute the installed driver through a real same-record Git conflict. Merely
    // finding config text would let a malformed or non-executable command pass. Start
    // from a common valid decision, diverge in two physical overlay clones, and require
    // Developer's higher-confidence record to win without conflict markers.
    const architectPointer = JSON.parse(readFileSync(join(architect.root, ".hunch", "local.json"), "utf8")) as {
      privateDir: string;
    };
    const architectOverlayRoot = resolve(architect.root, architectPointer.privateDir, "..");
    configureRepo(architectOverlayRoot, "ArchitectMemory", sandbox);
    configureRepo(developerOverlayRoot, "DeveloperMemory", sandbox);
    git(architectOverlayRoot, "pull", "-q", "--ff-only", "origin", "main");
    const architectureRecord = JSON.parse(readFileSync(
      join(architectOverlayRoot, ".hunch", "decisions", `${architecture.id}.json`),
      "utf8",
    )) as Record<string, unknown>;
    const probeId = "dec_matrix_merge_driver_probe";
    const probeRelative = `.hunch/decisions/${probeId}.json`;
    const probeProvenance = architectureRecord.provenance as Record<string, unknown>;
    const probeBase: Record<string, unknown> = {
      ...architectureRecord,
      id: probeId,
      topic: "matrix.merge-driver-probe",
      title: "Matrix merge-driver probe",
      status: "proposed",
      context: "Common merge-driver baseline.",
      decision: "Keep structured memory conflicts deterministic.",
      related_files: ["src/matrix-merge-driver.ts"],
      provenance: { ...probeProvenance, confidence: 0.7 },
    };
    const writeProbe = (overlayRoot: string, value: Record<string, unknown>): void => {
      const file = join(overlayRoot, probeRelative);
      mkdirSync(join(overlayRoot, ".hunch", "decisions"), { recursive: true });
      writeFileSync(file, `${JSON.stringify(value, null, 2)}\n`);
    };
    writeProbe(architectOverlayRoot, probeBase);
    git(architectOverlayRoot, "add", probeRelative);
    git(architectOverlayRoot, "commit", "-qm", "test: seed Matrix merge probe");
    git(architectOverlayRoot, "push", "-q", "origin", "main");
    git(developerOverlayRoot, "pull", "-q", "--ff-only", "origin", "main");

    writeProbe(architectOverlayRoot, {
      ...probeBase,
      context: "Architect's concurrent edit.",
      provenance: { ...probeProvenance, confidence: 0.8 },
    });
    git(architectOverlayRoot, "add", probeRelative);
    git(architectOverlayRoot, "commit", "-qm", "test: architect edits merge probe");
    writeProbe(developerOverlayRoot, {
      ...probeBase,
      context: "Developer's concurrent edit wins by confidence.",
      provenance: { ...probeProvenance, confidence: 0.9 },
    });
    git(developerOverlayRoot, "add", probeRelative);
    git(developerOverlayRoot, "commit", "-qm", "test: developer edits merge probe");
    git(architectOverlayRoot, "push", "-q", "origin", "main");
    git(developerOverlayRoot, "pull", "-q", "--no-rebase", "--no-edit", "origin", "main");
    assert.equal(git(developerOverlayRoot, "ls-files", "-u"), "",
      "the installed structured driver must resolve the real same-record conflict");
    const mergedProbe = JSON.parse(readFileSync(join(developerOverlayRoot, probeRelative), "utf8")) as {
      context: string;
    };
    assert.equal(mergedProbe.context, "Developer's concurrent edit wins by confidence.");
    assert.doesNotMatch(readFileSync(join(developerOverlayRoot, probeRelative), "utf8"), /<{7}|={7}|>{7}/);
    git(developerOverlayRoot, "push", "-q", "origin", "main");
    assert.doesNotMatch(
      git(architectOverlayRoot, "ls-files", "--others", "--exclude-standard", "--", ".hunch"),
      /\.sqlite(?:$|\n)/,
      "derived indexes created while exercising the driver must be ignored",
    );

    const correctionText = await mcpText(architectClient, "hunch_record_correction", {
      rule: TEAM_RULE,
      scope_hint_file: "src/orders.ts",
      severity: "blocking",
      type: "architecture",
      rationale: "Authentication, retry, and audit controls live in the shared transport boundary.",
      source_decision: architecture.id,
    });
    const constraintId = correctionText.match(/constraint (con_[A-Za-z0-9_-]+)/)?.[1];
    assert.ok(constraintId, correctionText);
    assert.match(correctionText, /committed \+ pushed/);
    assert.ok(remoteTree(memoryRemote).includes(`.hunch/constraints/${constraintId}.json`));
    assert.equal(git(architectOverlayRoot, "status", "--short", "--", ".hunch"), "",
      "the next automatic capture must sweep pending JSON and leave a clean memory tree");

    const upgrade = await mcpJson<CorrectionUpgrade>(architectClient, "hunch_policy_upgrade_correction", {
      constraint_id: constraintId,
      include_artifacts: true,
    });
    assert.equal(upgrade.status, "proved");
    assert.equal(upgrade.authority, "none");
    assert.ok(upgrade.policy && upgrade.plan && upgrade.proof);
    assert.equal(upgrade.policy.state, "proposed");
    assert.equal(upgrade.policy.authority, null);
    assert.equal(upgrade.proof.proof_class, "P3");
    const provedArtifactPaths = [
      `.hunch/evidence/${upgrade.evidence.id}.json`,
      `.hunch/policies/${upgrade.policy.id}.json`,
      `.hunch/plans/${upgrade.plan.id}.json`,
      `.hunch/proofs/${upgrade.proof.id}.json`,
    ];
    const provedRemoteTree = remoteTree(memoryRemote);
    for (const path of provedArtifactPaths) {
      assert.ok(provedRemoteTree.includes(path), `${path} must be pushed with the team proof packet`);
    }

    // A read-looking MCP plan request is also a write path when its canonical
    // default-budget plan is missing. First materialize that exact MCP plan, delete
    // it in a real team-memory commit, then require the same long-lived server to
    // recreate and publish the byte-identical receipt before replying.
    const canonicalPlan = await mcpJson<{ id: string; content_hash: string }>(
      architectClient,
      "hunch_policy_plan",
      { policy_id: upgrade.policy.id },
    );
    const planRelative = `.hunch/plans/${canonicalPlan.id}.json`;
    assert.equal(remoteJson<{ content_hash: string }>(memoryRemote, planRelative).content_hash, canonicalPlan.content_hash,
      "the canonical MCP plan must exist remotely before failure injection");
    rmSync(join(architectOverlayRoot, planRelative), { force: true });
    git(architectOverlayRoot, "add", "-u", "--", planRelative);
    git(architectOverlayRoot, "commit", "-qm", "test: remove Matrix proof plan");
    git(architectOverlayRoot, "push", "-q", "origin", "main");
    assert.ok(!remoteTree(memoryRemote).includes(planRelative),
      "the failure injection must remove the plan from authoritative team memory");
    const recreatedPlan = await mcpJson<{ id: string; content_hash: string }>(
      architectClient,
      "hunch_policy_plan",
      { policy_id: upgrade.policy.id },
    );
    assert.equal(recreatedPlan.id, canonicalPlan.id,
      "the exact deleted canonical plan ID must be recreated");
    assert.equal(recreatedPlan.content_hash, canonicalPlan.content_hash,
      "plan recreation may refresh metadata but must preserve canonical content");
    const recreatedPlanRelative = `.hunch/plans/${recreatedPlan.id}.json`;
    assert.ok(remoteTree(memoryRemote).includes(recreatedPlanRelative),
      "the MCP response's exact content-addressed replacement must exist on the shared remote");
    assert.equal(remoteJson<{ content_hash: string }>(memoryRemote, recreatedPlanRelative).content_hash, recreatedPlan.content_hash,
      "hunch_policy_plan must push a recreated plan before the MCP response completes");
    assert.equal(git(architectOverlayRoot, "status", "--short", "--", ".hunch"), "",
      "MCP plan recreation must leave no unpublished team-memory artifact");
    const teammatePlan = await mcpJson<{ id: string; content_hash: string }>(
      developerClient,
      "hunch_policy_plan",
      { policy_id: upgrade.policy.id },
    );
    assert.equal(teammatePlan.id, recreatedPlan.id);
    assert.equal(teammatePlan.content_hash, recreatedPlan.content_hash,
      "the already-running teammate MCP must read the exact restored plan without restart");

    // Critical liveness proof: this is the SAME developer MCP connection that started
    // before the correction existed. No restart, init, sync command, or shared directory.
    const liveConstraint = await mcpText(developerClient, "hunch_check_constraints", { scope: "src/orders.ts" });
    assert.match(liveConstraint, new RegExp(constraintId));
    assert.match(liveConstraint, /MATRIX_TEAM_RULE/);
    const developerProof = await mcpJson<{ content_hash: string }>(developerClient, "hunch_policy_proof", {
      policy_id: upgrade.policy.id,
    });
    assert.equal(developerProof.content_hash, upgrade.proof.content_hash,
      "the connected teammate must receive the same immutable P3 proof without restart");

    // Exercise a core CLI lifecycle write through a separate process. The policy is
    // activation-blocked but explicitly retireable while proposed, so this transition
    // cannot grant authority or weaken the legacy blocking correction under review.
    const retired = expectCli(architect, [
      "policy", "retire", upgrade.policy.id,
      "--actor", "human:matrix-architect",
      "--reason", "The Matrix fixture closes this proposal after proving cross-process lifecycle delivery.",
    ]);
    assert.match(retired, /retired; window closed, history retained/);
    const remotePolicy = remoteJson<{
      state: string;
      valid_to: string | null;
      audit: Array<{ action: string; actor: string }>;
    }>(memoryRemote, `.hunch/policies/${upgrade.policy.id}.json`);
    assert.equal(remotePolicy.state, "retired",
      "the CLI lifecycle mutation must be present on the shared remote when the command returns");
    assert.ok(remotePolicy.valid_to);
    assert.equal(remotePolicy.audit.at(-1)?.action, "retired");
    assert.equal(remotePolicy.audit.at(-1)?.actor, "human:matrix-architect");
    const teammateCard = await mcpJson<{ policy: { id: string; state: string } }>(
      developerClient,
      "hunch_policy_card",
      { policy_id: upgrade.policy.id },
    );
    assert.equal(teammateCard.policy.id, upgrade.policy.id);
    assert.equal(teammateCard.policy.state, "retired",
      "the already-running teammate MCP must refresh the CLI lifecycle mutation without restart");
    assert.equal(git(developer.root, "rev-parse", "HEAD"), git(developer.root, "rev-parse", "origin/main"),
      "read-only Matrix traffic must never create a hidden commit in the teammate's code clone");

    git(developer.root, "checkout", "-qb", "feature/order-cache");
    writeFileSync(join(developer.root, "src/orders.ts"), VIOLATING_SOURCE);
    const agentVerdict = await mcpText(developerClient, "hunch_merge_verdict", { working: true });
    assert.match(agentVerdict, /VERDICT:.*BLOCK/);
    assert.match(agentVerdict, new RegExp(constraintId));
    const localRed = expectCli(developer, ["check", "--working", "--strict"], 1);
    assert.match(localRed, new RegExp(constraintId));
    assert.equal(git(developer.root, "diff", "--cached", "--name-only"), "",
      "a read-only Hunch review must never stage generated memory or grounding files in the code repo");
    git(developer.root, "add", "src/orders.ts");
    assert.deepEqual(git(developer.root, "diff", "--cached", "--name-only").split("\n"), ["src/orders.ts"]);
    git(developer.root, "commit", "-qm", "feat: add order cache key with a bad transport");
    git(developer.root, "push", "-q", "-u", "origin", "feature/order-cache");

    const reviewer = cloneActor(sandbox, codeRemote, "Reviewer");
    git(reviewer.root, "checkout", "-q", "-b", "feature/order-cache", "origin/feature/order-cache");
    assert.equal(existsSync(join(reviewer.root, ".hunch", "local.json")), false,
      "the reviewer begins as a genuinely fresh clone");
    // The strict CLI check is the reviewer's FIRST Hunch process. No MCP start or
    // init command may pre-wire the team overlay and hide a CLI-first false-green.
    const reviewRed = expectCli(reviewer, ["check", "--base", "origin/main", "--strict"], 1);
    assert.match(reviewRed, new RegExp(constraintId));
    const reviewerPointer = JSON.parse(readFileSync(join(reviewer.root, ".hunch", "local.json"), "utf8")) as {
      privateDir: string;
      mode: string;
    };
    assert.equal(reviewerPointer.mode, "shared",
      "the first CLI check must leave every later reviewer process on the shared graph");
    assert.equal(git(reviewer.root, "status", "--short"), "",
      "the first CLI check may create only ignored machine-local code-repo state");
    const reviewerClient = await connectMcp(reviewer);
    clients.push(reviewerClient);
    assert.match(await mcpText(reviewerClient, "hunch_current_decision", { topic: "orders.transport" }), new RegExp(architecture.id));

    // Failure injection for the WHOLE public receipt, not only the legacy constraint
    // report: a private/shared conformance decision used to be evaluated after the
    // publicOnly boundary and printed its title/id into the supposedly safe CI output.
    const privateConformanceSentinel = "MATRIX_PRIVATE_CONFORMANCE_SENTINEL";
    const reviewerMemory = resolve(reviewer.root, reviewerPointer.privateDir);
    mkdirSync(join(reviewerMemory, "decisions"), { recursive: true });
    const privateConformanceFile = join(reviewerMemory, "decisions", "dec_matrix_private_conformance.json");
    writeFileSync(privateConformanceFile, `${JSON.stringify({
      id: "dec_matrix_private_conformance",
      title: privateConformanceSentinel,
      topic: "matrix.private-conformance",
      status: "accepted",
      context: `${privateConformanceSentinel}: secret architectural rationale`,
      decision: "A private-only symbol must exist.",
      consequences: [],
      alternatives_rejected: [],
      rejected_tripwires: [],
      related_components: [],
      related_files: ["src/orders.ts"],
      supersedes: null,
      superseded_by: null,
      caused_by_bug: null,
      commit: null,
      valid_from: "2026-07-18T00:00:00.000Z",
      valid_to: null,
      retired: { symbols: [], deps: [] },
      conformance: [{ assert: "exists", subject: "MATRIX_PRIVATE_MISSING_SYMBOL", transitive: false }],
      provenance: { source: "human_confirmed", confidence: 1, evidence: [] },
      date: "2026-07-18T00:00:00.000Z",
    }, null, 2)}\n`);
    const privateReceipt = expectCli(reviewer, ["check", "--base", "origin/main", "--strict"], 1);
    assert.match(privateReceipt, new RegExp(privateConformanceSentinel),
      "the internal team review still enforces and explains private conformance");

    // Public PR comments intentionally exclude the shared/private overlay at the read
    // boundary. The internal reviewer check above has teeth; this surface proves that
    // neither the rule nor its id can leak into a public comment or shared CI log.
    const publicReceipt = expectCli(reviewer, [
      "check", "--base", "origin/main", "--strict", "--public-only", "--format", "markdown",
    ]);
    assert.doesNotMatch(publicReceipt, /MATRIX_TEAM_RULE/);
    assert.doesNotMatch(publicReceipt, new RegExp(constraintId));
    assert.doesNotMatch(publicReceipt, new RegExp(privateConformanceSentinel));
    rmSync(privateConformanceFile, { force: true });

    writeFileSync(join(developer.root, "src/orders.ts"), REPAIRED_SOURCE);
    assert.equal(git(developer.root, "diff", "--cached", "--name-only"), "",
      "the shared-memory background flow must leave the code index untouched between reviews");
    git(developer.root, "add", "src/orders.ts");
    git(developer.root, "commit", "-qm", "fix: keep the cache key and restore the shared transport");
    git(developer.root, "push", "-q");
    git(reviewer.root, "pull", "-q", "--ff-only");
    assert.deepEqual(
      git(reviewer.root, "diff", "--name-only", "origin/main...HEAD").split("\n").filter(Boolean),
      ["src/orders.ts"],
      "green must come from exactly the repaired code change, never a vacuous diff or leaked memory artifacts",
    );
    const reviewGreen = expectCli(reviewer, ["check", "--base", "origin/main", "--strict"]);
    assert.match(reviewGreen, /touch no recorded invariants/i);
    assert.doesNotMatch(reviewGreen, /BLOCK/);

    // Complete the review lifecycle: merge the repaired, still-nonempty feature,
    // publish main, and prove another teammate receives the exact safe code.
    git(reviewer.root, "checkout", "-q", "main");
    git(reviewer.root, "pull", "-q", "--ff-only", "origin", "main");
    git(reviewer.root, "merge", "-q", "--ff-only", "feature/order-cache");
    git(reviewer.root, "push", "-q", "origin", "main");
    const mergedMain = execFileSync("git", ["--git-dir", codeRemote, "show", "main:src/orders.ts"], {
      encoding: "utf8",
    });
    assert.equal(mergedMain, REPAIRED_SOURCE);
    // Public static-index pumping intentionally creates local `.hunch` commits in
    // the code repository, while unified team captures stay in the private
    // overlay. Rebase those derived public commits over the reviewed mainline;
    // requiring a fast-forward would incorrectly treat durable index pumping as
    // a split-brain failure.
    git(architect.root, "pull", "-q", "--rebase", "origin", "main");
    assert.equal(git(architect.root, "status", "--porcelain"), "",
      "rebasing durable public graph commits over reviewed code must leave a clean architect tree");
    assert.equal(readFileSync(join(architect.root, "src/orders.ts"), "utf8"), REPAIRED_SOURCE,
      "the architect receives the reviewed implementation from the code remote");
    const architectPublicMemory = git(architect.root, "log", "-p", "origin/main..HEAD");
    for (const sentinel of [TEAM_RULE, FIRST_COMMAND_WRITE_RULE, constraintId, privateConformanceSentinel]) {
      assert.equal(architectPublicMemory.includes(sentinel), false,
        `rebased public graph history must not contain private/team sentinel ${sentinel}`);
    }
    const allowedPublicGrounding = new Set([
      "AGENTS.md",
      "CLAUDE.md",
      ".github/copilot-instructions.md",
      ".cursor/rules/hunch.mdc",
      ".windsurf/rules/hunch.md",
    ]);
    const rebasedPaths = git(architect.root, "log", "--format=", "--name-only", "origin/main..HEAD")
      .split("\n")
      .filter(Boolean);
    assert.ok(rebasedPaths.length > 0, "the fixture must exercise at least one local public-memory commit");
    assert.ok(rebasedPaths.every((path) => path.startsWith(".hunch/") || allowedPublicGrounding.has(path)),
      `rebased local-only commits may touch only public graph/grounding paths, got: ${rebasedPaths.join(", ")}`);

    const implementation = await recordDecision(developerClient, {
      topic: "orders.cache-key",
      title: "Order cache keys stay transport-independent",
      decision: "Keep the cache-key helper pure so transport repairs cannot invalidate cache identity.",
    });
    assert.ok(remoteTree(memoryRemote).includes(`.hunch/decisions/${implementation.id}.json`));
    const architectLiveView = await mcpText(architectClient, "hunch_current_decision", { topic: "orders.cache-key" });
    assert.match(architectLiveView, new RegExp(implementation.id),
      "the architect's already-running MCP must receive the developer's decision without restart");

    const overlays = [architect, developer, reviewer].map((actor) => {
      const pointer = JSON.parse(readFileSync(join(actor.root, ".hunch", "local.json"), "utf8")) as { privateDir: string; mode: string };
      assert.equal(pointer.mode, "shared");
      return realpathSync(resolve(actor.root, pointer.privateDir, ".."));
    });
    assert.equal(new Set(overlays).size, 3, "every actor must use an isolated overlay clone");
    assert.equal(new Set([architect.root, developer.root, reviewer.root].map((root) => realpathSync(root))).size, 3,
      "every actor must use an isolated code clone");

    const projectHistory = execFileSync("git", ["--git-dir", codeRemote, "log", "-p", "--all", "--"], {
      encoding: "utf8",
      maxBuffer: 16 * 1024 * 1024,
    });
    assert.doesNotMatch(projectHistory, /MATRIX_TEAM_RULE/,
      "shared memory must never enter any reachable project-repository commit");
    assert.doesNotMatch(projectHistory, new RegExp(FIRST_COMMAND_WRITE_RULE),
      "a first-command shared write must never enter project-repository history");
    assert.equal(remoteTree(memoryRemote).filter((path) => path === `.hunch/constraints/${constraintId}.json`).length, 1);
  } finally {
    for (const client of clients.reverse()) await client.close().catch(() => undefined);
    if (process.env.HUNCH_KEEP_TEAM_MATRIX === "1") {
      console.error(`# HUNCH_KEEP_TEAM_MATRIX=${sandbox}`);
    } else {
      rmSync(sandbox, { recursive: true, force: true });
    }
  }
});
