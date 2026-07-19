import assert from "node:assert/strict";
import { execFileSync, spawnSync } from "node:child_process";
import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readdirSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StdioClientTransport } from "@modelcontextprotocol/sdk/client/stdio.js";

const PROJECT_ROOT = process.cwd();
const TSX = join(PROJECT_ROOT, "node_modules/tsx/dist/cli.mjs");
const CLI = join(PROJECT_ROOT, "src/cli/index.ts");
const FIXED_SOURCE = "export function listOrders(user: string) { return [`order:${user}`]; }\n";
const VIOLATING_SOURCE = [
  'import axios from "axios";',
  "export async function listOrders(user: string) { return axios.get(`/orders/${user}`); }",
  "",
].join("\n");

type Fixture = {
  sandbox: string;
  root: string;
  home: string;
  env: NodeJS.ProcessEnv;
  cleanup(): void;
};

type Upgrade = {
  status: "proved" | "already_proved" | "legacy_only" | "pending" | "conflicted";
  correction_id: string;
  evidence: { id: string; data_class: string };
  policy: null | {
    id: string;
    revision: number;
    state: string;
    authority: unknown;
    proof: string | null;
    activation_gate: null | { status: string; reason: string };
    data_class: string;
  };
  plan: null | { id: string; content_hash: string; data_class: string };
  proof: null | { id: string; content_hash: string; proof_class: string; data_class: string };
  authority: string;
};

type EvaluationEnvelope = {
  policy_id: string;
  result: string;
  repository: {
    head: string;
    graph_hash: string;
  };
  deterministic_hash: string;
  enforcement?: {
    blocks: boolean;
    strict_error: boolean;
    gate_error: string | null;
  };
};

function git(root: string, ...args: string[]): string {
  return execFileSync("git", args, {
    cwd: root,
    encoding: "utf8",
    env: { ...process.env, GIT_CONFIG_NOSYSTEM: "1" },
    stdio: ["ignore", "pipe", "pipe"],
  }).trim();
}

function commit(root: string, files: string[], message: string): string {
  git(root, "add", "--", ...files);
  git(root, "commit", "-qm", message);
  return git(root, "rev-parse", "HEAD");
}

function hunchGitignore(): string {
  return [
    "node_modules/",
    "# >>> hunch (derived runtime index — regenerable from .hunch/*.json) >>>",
    ".hunch/*.sqlite",
    ".hunch/*.sqlite-shm",
    ".hunch/*.sqlite-wal",
    ".hunch/*.sqlite-journal",
    ".hunch/**/*.tmp*",
    ".hunch-cache/",
    ".hunch/local.json",
    ".hunch-private/",
    "# <<< hunch <<<",
    "",
  ].join("\n");
}

function codeFixture(label: string, source = VIOLATING_SOURCE, dependencies = ["axios"]): Fixture {
  const sandbox = mkdtempSync(join(tmpdir(), `hunch-md1-e2e-${label}-`));
  const root = join(sandbox, "code");
  const home = join(sandbox, "home");
  const hooks = join(sandbox, "empty-hooks");
  mkdirSync(join(root, "src/api"), { recursive: true });
  mkdirSync(home, { recursive: true });
  mkdirSync(hooks, { recursive: true });
  git(root, "init", "-q");
  git(root, "config", "user.email", "e2e@example.com");
  git(root, "config", "user.name", "MD1 E2E Human");
  git(root, "config", "commit.gpgsign", "false");
  git(root, "config", "core.hooksPath", hooks);
  writeFileSync(join(root, ".gitignore"), hunchGitignore());
  writeFileSync(join(root, "package.json"), `${JSON.stringify({
    name: `md1-${label}-fixture`,
    private: true,
    type: "module",
    dependencies: Object.fromEntries(dependencies.map((dependency) => [dependency, "1.0.0"])),
  }, null, 2)}\n`);
  writeFileSync(join(root, "src/api/orders.ts"), source);
  commit(root, [".gitignore", "package.json", "src/api/orders.ts"], "fixture: initial code");
  return {
    sandbox,
    root,
    home,
    env: {
      ...process.env,
      HOME: home,
      USERPROFILE: home,
      XDG_CONFIG_HOME: join(home, ".config"),
      GIT_CONFIG_NOSYSTEM: "1",
      HUNCH_PRIVATE_DIR: "",
      HUNCH_SYNTH_PROVIDER: "deterministic",
      NO_COLOR: "1",
      CI: "1",
    },
    cleanup: () => rmSync(sandbox, { recursive: true, force: true }),
  };
}

function runCli(fixture: Fixture, ...args: string[]) {
  return spawnSync(process.execPath, [TSX, CLI, ...args], {
    cwd: fixture.root,
    env: fixture.env,
    encoding: "utf8",
    timeout: 45_000,
    maxBuffer: 16 * 1024 * 1024,
  });
}

function output(run: ReturnType<typeof runCli>): string {
  return `${run.stdout ?? ""}${run.stderr ?? ""}`;
}

function jsonFromSuccessfulCli<T>(run: ReturnType<typeof runCli>): T {
  assert.equal(run.error, undefined, run.error?.message);
  assert.equal(run.signal, null, output(run));
  assert.equal(run.status, 0, output(run));
  return JSON.parse(run.stdout) as T;
}

function jsonFiles(root: string, kind: string): string[] {
  const dir = join(root, ".hunch", kind);
  return existsSync(dir) ? readdirSync(dir).filter((name) => name.endsWith(".json")).sort() : [];
}

function artifactSnapshot(root: string, upgrade: Upgrade): Record<string, string> {
  assert.ok(upgrade.policy && upgrade.plan && upgrade.proof);
  const paths = [
    ["evidence", upgrade.evidence.id],
    ["policies", upgrade.policy.id],
    ["plans", upgrade.plan.id],
    ["proofs", upgrade.proof.id],
  ] as const;
  return Object.fromEntries(paths.map(([kind, id]) => {
    const file = join(root, ".hunch", kind, `${id}.json`);
    return [`${kind}/${id}.json`, readFileSync(file, "utf8")];
  }));
}

async function mcpJson<T>(client: Client, name: string, args: Record<string, unknown>): Promise<T> {
  const response = await client.callTool({ name, arguments: args });
  assert.notEqual(response.isError, true, JSON.stringify(response.content));
  const text = response.content.find((part): part is { type: "text"; text: string } => part.type === "text");
  assert.ok(text, `${name} returned no text payload`);
  return JSON.parse(text.text) as T;
}

function publishablePublicText(root: string): string {
  const files = execFileSync("git", ["ls-files", "--cached", "--others", "--exclude-standard", "-z"], {
    cwd: root,
    encoding: "utf8",
  }).split("\0").filter(Boolean).sort();
  return files.map((file) => `${file}\0${readFileSync(join(root, file), "utf8")}`).join("\0");
}

test("MD-1a black-box journey: CLI capture, durable retry, P3 review, MCP parity, guard, and tamper-safe strict CI", { timeout: 120_000 }, async () => {
  const fixture = codeFixture("public");
  let client: Client | null = null;
  try {
    const transport = new StdioClientTransport({
      command: process.execPath,
      args: [TSX, CLI, "mcp"],
      cwd: fixture.root,
      env: fixture.env,
    });
    client = new Client({ name: "md1-e2e-live-client", version: "1.0.0" });
    await client.connect(transport);
    assert.deepEqual(await mcpJson<EvaluationEnvelope[]>(client, "hunch_policy_evaluate", { public_only: true }), [],
      "a client connected before capture starts from an empty Constitution view");

    const commitsBeforeCapture = Number(git(fixture.root, "rev-list", "--count", "HEAD"));
    const capture = runCli(
      fixture,
      "record-constraint",
      "never import axios in the orders API",
      "--scope", "src/api/orders.ts",
      "--severity", "blocking",
      "--type", "architecture",
      "--rationale", "All outbound requests must use the shared transport controls.",
      "--forbid-dep", "axios",
    );
    assert.equal(capture.status, 0, output(capture));
    const correctionId = output(capture).match(/constraint (con_[a-f0-9]+)/)?.[1];
    assert.ok(correctionId, output(capture));
    assert.equal(Number(git(fixture.root, "rev-list", "--count", "HEAD")), commitsBeforeCapture + 1,
      "the durable correction is committed once through the real capture path");
    const captureCommitFiles = git(fixture.root, "diff-tree", "--no-commit-id", "--name-only", "-r", "HEAD").split("\n").filter(Boolean);
    assert.ok(captureCommitFiles.includes(`.hunch/constraints/${correctionId}.json`));
    assert.equal(captureCommitFiles.every((file) => file.startsWith(".hunch/") && file !== ".hunch/local.json"), true,
      "capture commits memory only and never the local overlay pointer or source code");
    assert.deepEqual(jsonFromSuccessfulCli<unknown[]>(runCli(fixture, "policy", "list", "--public-only", "--json")), [],
      "capture never hides an in-process policy or authority grant");
    assert.deepEqual(jsonFiles(fixture.root, "policies"), []);

    const committedViolation = jsonFromSuccessfulCli<Upgrade>(runCli(
      fixture, "policy", "upgrade-correction", correctionId, "--public-only", "--json",
    ));
    assert.equal(committedViolation.status, "pending");
    assert.equal(committedViolation.policy, null);
    assert.match(JSON.stringify(committedViolation), /baseline.*violat|currently imports axios/i);
    assert.deepEqual(jsonFiles(fixture.root, "policies"), [], "a currently violated baseline cannot mint a policy");

    writeFileSync(join(fixture.root, "src/api/orders.ts"), FIXED_SOURCE);
    const uncommittedFix = jsonFromSuccessfulCli<Upgrade>(runCli(
      fixture, "policy", "upgrade-correction", correctionId, "--public-only", "--json",
    ));
    assert.equal(uncommittedFix.status, "pending");
    assert.equal(uncommittedFix.policy, null);
    assert.deepEqual(jsonFiles(fixture.root, "policies"), [], "an uncommitted fix cannot mint a policy");

    commit(fixture.root, ["src/api/orders.ts"], "fix: remove direct axios import");
    const index = runCli(fixture, "index");
    assert.equal(index.status, 0, output(index));
    assert.match(index.stdout, /correction reviews: 1 proved/);

    const upgrade = jsonFromSuccessfulCli<Upgrade>(runCli(
      fixture, "policy", "upgrade-correction", correctionId, "--public-only", "--json",
    ));
    assert.equal(upgrade.status, "already_proved");
    assert.equal(upgrade.authority, "none");
    assert.ok(upgrade.policy && upgrade.plan && upgrade.proof);
    assert.equal(upgrade.policy.state, "proposed");
    assert.equal(upgrade.policy.authority, null);
    assert.equal(upgrade.policy.activation_gate?.status, "blocked");
    assert.equal(upgrade.proof.proof_class, "P3");

    const show = jsonFromSuccessfulCli<{
      policy: Upgrade["policy"];
      proof: NonNullable<Upgrade["proof"]>;
    }>(runCli(fixture, "policy", "show", upgrade.policy.id, "--proof", "--public-only"));
    assert.equal(show.policy?.id, upgrade.policy.id);
    assert.equal(show.proof.content_hash, upgrade.proof.content_hash);
    const cliCard = jsonFromSuccessfulCli<{ card_hash: string }>(runCli(
      fixture, "policy", "card", upgrade.policy.id, "--public-only", "--json",
    ));
    const cliBaseline = jsonFromSuccessfulCli<EvaluationEnvelope[]>(runCli(
      fixture, "policy", "evaluate", upgrade.policy.id, "--public-only", "--json",
    ));
    assert.equal(cliBaseline[0]?.result, "satisfied");
    assert.match(cliBaseline[0]?.repository.head ?? "", /^working:sha1:[0-9a-f]{40}:sha1:[0-9a-f]{40}$/,
      "a live static evaluation binds exact working source bytes and topology, not a possibly different Git tree");

    const beforeRetry = artifactSnapshot(fixture.root, upgrade);
    const headBeforeRetry = git(fixture.root, "rev-parse", "HEAD");
    const retryIndex = runCli(fixture, "index");
    assert.equal(retryIndex.status, 0, output(retryIndex));
    assert.match(retryIndex.stdout, /correction reviews: 0 proved · 1 current/);
    const headAfterRetry = git(fixture.root, "rev-parse", "HEAD");
    assert.equal(headAfterRetry, headBeforeRetry,
      "an unchanged retry pump must not invent a redundant memory commit");
    const cliRetry = jsonFromSuccessfulCli<Upgrade>(runCli(
      fixture, "policy", "upgrade-correction", correctionId, "--public-only", "--json",
    ));
    assert.equal(cliRetry.status, "already_proved");
    assert.equal(cliRetry.policy?.id, upgrade.policy.id);
    assert.equal(cliRetry.policy?.revision, upgrade.policy.revision);
    const headAfterCliRetry = git(fixture.root, "rev-parse", "HEAD");
    assert.equal(headAfterCliRetry, headAfterRetry,
      `an idempotent CLI retry must not create another memory commit\n${git(fixture.root, "log", "-3", "--format=%H %s")}`);

    const mcpRetry = await mcpJson<Upgrade>(client, "hunch_policy_upgrade_correction", {
      constraint_id: correctionId,
      public_only: true,
      include_artifacts: true,
    });
    assert.equal(mcpRetry.status, "already_proved");
    assert.equal(mcpRetry.policy?.id, upgrade.policy.id);
    assert.equal(mcpRetry.evidence.id, upgrade.evidence.id);
    assert.equal(mcpRetry.plan?.id, upgrade.plan.id);
    assert.equal(mcpRetry.proof?.id, upgrade.proof.id);
    const headAfterMcpRetry = git(fixture.root, "rev-parse", "HEAD");
    assert.equal(headAfterMcpRetry, headAfterCliRetry,
      `an idempotent MCP retry must not create another memory commit\n${git(fixture.root, "log", "-3", "--format=%H %s")}`);
    assert.deepEqual(artifactSnapshot(fixture.root, mcpRetry), beforeRetry,
      "index, CLI, and a long-lived MCP client converge without rewriting immutable artifacts");
    assert.deepEqual(
      readdirSync(join(fixture.root, ".hunch"), { recursive: true }).filter((name) => String(name).includes(".tmp")),
      [],
      "successful retries leave no atomic-write temporary files",
    );

    const mcpCard = await mcpJson<{ card_hash: string }>(client, "hunch_policy_card", {
      policy_id: upgrade.policy.id,
      public_only: true,
    });
    assert.equal(mcpCard.card_hash, cliCard.card_hash);
    const mcpProof = await mcpJson<{ content_hash: string }>(client, "hunch_policy_proof", {
      policy_id: upgrade.policy.id,
      public_only: true,
    });
    assert.equal(mcpProof.content_hash, upgrade.proof.content_hash);
    const parityHead = git(fixture.root, "rev-parse", "HEAD");
    assert.equal(parityHead, headAfterMcpRetry, "read-only card and proof views do not move HEAD");
    const mcpBaseline = await mcpJson<EvaluationEnvelope[]>(client, "hunch_policy_evaluate", {
      policy_id: upgrade.policy.id,
      public_only: true,
    });
    assert.equal(mcpBaseline[0]?.repository.head, cliBaseline[0]?.repository.head,
      "the long-lived MCP server evaluates the same content-identified checkout without restart");
    assert.equal(mcpBaseline[0]?.repository.graph_hash, cliBaseline[0]?.repository.graph_hash,
      "idempotent retries leave the evaluated code graph unchanged");
    assert.equal(mcpBaseline[0]?.deterministic_hash, cliBaseline[0]?.deterministic_hash,
      "the original CLI receipt remains canonical after idempotent retries");
    const cliCurrentBaseline = jsonFromSuccessfulCli<EvaluationEnvelope[]>(runCli(
      fixture, "policy", "evaluate", upgrade.policy.id, "--public-only", "--json",
    ));
    assert.equal(cliCurrentBaseline[0]?.repository.head, cliBaseline[0]?.repository.head);
    assert.deepEqual(mcpBaseline, cliCurrentBaseline,
      "CLI and MCP expose one byte-identical canonical evaluator envelope for the same HEAD");

    const policyFile = join(fixture.root, ".hunch", "policies", `${upgrade.policy.id}.json`);
    for (const mode of ["advisory", "blocking"] as const) {
      const policyBefore = readFileSync(policyFile, "utf8");
      const activation = runCli(fixture, "policy", "accept", upgrade.policy.id, `--${mode}`, "--actor", "human:md1-e2e-owner");
      assert.notEqual(activation.status, 0, output(activation));
      assert.match(output(activation), /cannot activate.*MD-2/i);
      assert.equal(readFileSync(policyFile, "utf8"), policyBefore, `${mode} refusal is mutation-free`);
    }

    writeFileSync(join(fixture.root, "src/api/orders.ts"), VIOLATING_SOURCE);
    const cliViolation = jsonFromSuccessfulCli<EvaluationEnvelope[]>(runCli(
      fixture, "policy", "evaluate", upgrade.policy.id, "--working", "--public-only", "--json",
    ));
    assert.equal(cliViolation[0]?.result, "violated");
    const mcpViolation = await mcpJson<EvaluationEnvelope[]>(client, "hunch_policy_evaluate", {
      policy_id: upgrade.policy.id,
      public_only: true,
      workspace: "working",
    });
    assert.equal(mcpViolation[0]?.deterministic_hash, cliViolation[0]?.deterministic_hash);
    assert.deepEqual(jsonFromSuccessfulCli<unknown[]>(runCli(
      fixture, "policy", "evaluate", "--active", "--working", "--public-only", "--json",
    )), [], "a proposed policy remains non-authoritative even when its assertion is violated");
    const legacyGuard = runCli(fixture, "check", "--working", "--strict", "--public-only");
    assert.equal(legacyGuard.status, 1, output(legacyGuard));
    assert.match(output(legacyGuard), new RegExp(correctionId));

    writeFileSync(join(fixture.root, "src/api/orders.ts"), FIXED_SOURCE);
    writeFileSync(join(fixture.root, "README.md"), "# unrelated working change\n");
    const persisted = JSON.parse(readFileSync(policyFile, "utf8")) as Record<string, unknown>;
    writeFileSync(policyFile, `${JSON.stringify({
      ...persisted,
      state: "active_blocking",
      severity: "blocking",
      authority: {
        kind: "human",
        actor: "human:forged-e2e-owner",
        event: "hostile-persisted-lifecycle",
        at: "2026-07-18T12:00:00.000Z",
      },
    }, null, 2)}\n`);

    const hostileCli = runCli(
      fixture, "policy", "evaluate", "--active", "--working", "--strict", "--public-only", "--json",
    );
    assert.equal(hostileCli.status, 1, output(hostileCli));
    const hostileCliReceipts = JSON.parse(hostileCli.stdout) as EvaluationEnvelope[];
    assert.equal(hostileCliReceipts.length, 1, "active-only evaluation must not hide a persisted active-state configuration error");
    assert.equal(hostileCliReceipts[0]?.enforcement?.blocks, false);
    assert.equal(hostileCliReceipts[0]?.enforcement?.strict_error, true);
    assert.match(hostileCliReceipts[0]?.enforcement?.gate_error ?? "", /cannot activate until MD-2/i);

    const hostileMcp = await mcpJson<EvaluationEnvelope[]>(client, "hunch_policy_evaluate", {
      active_only: true,
      public_only: true,
      workspace: "working",
    });
    assert.equal(hostileMcp[0]?.deterministic_hash, hostileCliReceipts[0]?.deterministic_hash);
    assert.equal(hostileMcp[0]?.enforcement?.blocks, false);
    assert.equal(hostileMcp[0]?.enforcement?.strict_error, true);
    assert.match(hostileMcp[0]?.enforcement?.gate_error ?? "", /cannot activate until MD-2/i);

    const strictCi = runCli(fixture, "check", "--working", "--strict", "--public-only");
    assert.equal(strictCi.status, 1, output(strictCi));
    assert.match(output(strictCi), /gate error:.*cannot activate until MD-2/i);
    assert.doesNotMatch(output(strictCi), /authorized block/i);
  } finally {
    if (client) await client.close();
    fixture.cleanup();
  }
});

test("MD-1a private cross-adapter journey keeps every sensitive token and artifact outside the public repo", { timeout: 90_000 }, async () => {
  const privateDependency = "@private-e2e/transport";
  const privateRule = `PRIVATE_E2E_RULE: never import ${privateDependency}`;
  const privateRationale = "PRIVATE_E2E_RATIONALE: route through the undisclosed transport boundary";
  const fixture = codeFixture("private", FIXED_SOURCE, []);
  const overlayRoot = join(fixture.sandbox, "private-memory");
  const privateRoot = join(overlayRoot, ".hunch");
  let client: Client | null = null;
  try {
    mkdirSync(privateRoot, { recursive: true });
    git(overlayRoot, "init", "-q");
    git(overlayRoot, "config", "user.email", "e2e@example.com");
    git(overlayRoot, "config", "user.name", "MD1 E2E Human");
    git(overlayRoot, "config", "commit.gpgsign", "false");
    git(overlayRoot, "commit", "--allow-empty", "-qm", "fixture: private memory root");
    mkdirSync(join(fixture.root, ".hunch"), { recursive: true });
    writeFileSync(join(fixture.root, ".hunch/local.json"), `${JSON.stringify({
      privateDir: privateRoot,
      autoCommit: false,
      mode: "private",
    }, null, 2)}\n`);
    fixture.env.HUNCH_PRIVATE_DIR = privateRoot;
    const publicHead = git(fixture.root, "rev-parse", "HEAD");

    const capture = runCli(
      fixture,
      "record-constraint", privateRule,
      "--scope", "src/api/orders.ts",
      "--severity", "blocking",
      "--rationale", privateRationale,
      "--forbid-dep", privateDependency,
      "--private",
    );
    assert.equal(capture.status, 0, output(capture));
    const capturedCorrectionId = output(capture).match(/constraint (con_[a-f0-9]+)/)?.[1];
    assert.ok(capturedCorrectionId, output(capture));
    assert.equal(git(fixture.root, "rev-parse", "HEAD"), publicHead, "private capture cannot create a public commit");
    assert.equal(git(fixture.root, "ls-files", ".hunch/local.json"), "",
      "local overlay configuration must not enter the public index");

    const correctionFiles = jsonFiles(overlayRoot, "constraints");
    assert.equal(correctionFiles.length, 1);
    const correctionId = correctionFiles[0]!.replace(/\.json$/, "");
    assert.equal(correctionId, capturedCorrectionId);
    const transport = new StdioClientTransport({
      command: process.execPath,
      args: [TSX, CLI, "mcp"],
      cwd: fixture.root,
      env: fixture.env,
    });
    client = new Client({ name: "md1-private-cross-adapter-e2e", version: "1.0.0" });
    await client.connect(transport);
    const upgrade = await mcpJson<Upgrade>(client, "hunch_policy_upgrade_correction", {
      constraint_id: correctionId,
      private_only: true,
      include_artifacts: true,
    });
    assert.equal(upgrade.status, "proved");
    assert.equal(upgrade.authority, "none");
    assert.ok(upgrade.policy && upgrade.plan && upgrade.proof);

    const artifacts = [
      ["constraints", correctionId],
      ["evidence", upgrade.evidence.id],
      ["policies", upgrade.policy.id],
      ["plans", upgrade.plan.id],
      ["proofs", upgrade.proof.id],
    ] as const;
    for (const [kind, id] of artifacts) {
      assert.equal(existsSync(join(privateRoot, kind, `${id}.json`)), true, `${kind}/${id} exists privately`);
      assert.equal(existsSync(join(fixture.root, ".hunch", kind, `${id}.json`)), false, `${kind}/${id} never exists publicly`);
    }

    const publicList = runCli(fixture, "policy", "list", "--public-only", "--json");
    const publicEvaluation = runCli(fixture, "policy", "evaluate", "--public-only", "--json");
    assert.deepEqual(jsonFromSuccessfulCli<unknown[]>(publicList), []);
    assert.deepEqual(jsonFromSuccessfulCli<unknown[]>(publicEvaluation), []);
    const publicMcp = await mcpJson<unknown[]>(client, "hunch_policy_evaluate", { public_only: true });
    assert.deepEqual(publicMcp, []);

    const privateTokens = [
      privateRule,
      privateDependency,
      privateRationale,
      correctionId,
      upgrade.evidence.id,
      upgrade.policy.id,
      upgrade.plan.id,
      upgrade.proof.id,
    ];
    const publicSurfaces = [
      publishablePublicText(fixture.root),
      publicList.stdout,
      publicList.stderr,
      publicEvaluation.stdout,
      publicEvaluation.stderr,
      JSON.stringify(publicMcp),
    ].join("\n");
    for (const token of privateTokens) {
      assert.equal(publicSurfaces.includes(token), false, `public surfaces leaked ${JSON.stringify(token)}`);
    }
    assert.equal(git(fixture.root, "rev-parse", "HEAD"), publicHead);
    assert.equal(git(fixture.root, "ls-files", ".hunch/local.json"), "");
  } finally {
    if (client) await client.close();
    fixture.cleanup();
  }
});

test("MD-1a mixed dependency meaning stays legacy-only and never guesses a policy", { timeout: 60_000 }, () => {
  const fixture = codeFixture("ambiguous", FIXED_SOURCE, ["axios", "got"]);
  try {
    const capture = runCli(
      fixture,
      "record-constraint", "never import axios or got in the orders API",
      "--scope", "src/api/orders.ts",
      "--severity", "blocking",
      "--forbid-dep", "axios,got",
    );
    assert.equal(capture.status, 0, output(capture));
    const correctionId = output(capture).match(/constraint (con_[a-f0-9]+)/)?.[1];
    assert.ok(correctionId, output(capture));

    const index = runCli(fixture, "index");
    assert.equal(index.status, 0, output(index));
    assert.match(index.stdout, /1 legacy-only/);
    const upgrade = jsonFromSuccessfulCli<Upgrade>(runCli(
      fixture, "policy", "upgrade-correction", correctionId, "--public-only", "--json",
    ));
    assert.equal(upgrade.status, "legacy_only");
    assert.equal(upgrade.policy, null);
    assert.equal(upgrade.plan, null);
    assert.equal(upgrade.proof, null);
    assert.equal(upgrade.authority, "none");
    assert.deepEqual(jsonFiles(fixture.root, "policies"), []);
    assert.deepEqual(jsonFiles(fixture.root, "plans"), []);
    assert.deepEqual(jsonFiles(fixture.root, "proofs"), []);
    assert.deepEqual(jsonFromSuccessfulCli<unknown[]>(runCli(fixture, "policy", "list", "--public-only", "--json")), []);
  } finally {
    fixture.cleanup();
  }
});
