import { cleanupDir, trustTeamStoreAs } from "./fixtures.js";
import assert from "node:assert/strict";
import { execFileSync, spawnSync } from "node:child_process";
import { mkdirSync, mkdtempSync, readFileSync, renameSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StdioClientTransport } from "@modelcontextprotocol/sdk/client/stdio.js";
import { HunchStore } from "../src/store/hunchStore.js";
import { hunchPaths } from "../src/core/paths.js";
import { indexRepo } from "../src/extractors/indexer.js";
import type { Decision } from "../src/core/types.js";
import { ConstitutionService } from "../src/constitution/service.js";
import { hunchCliArgs } from "./cli-invocation.js";
// The policy tools are a specialist MCP group; the everyday default hides them (src/mcp/toolset.ts).
process.env.HUNCH_MCP_TOOLS = "all";

const NOW = "2026-07-10T10:00:00.000Z";

function git(cwd: string, ...args: string[]): string {
  return execFileSync("git", args, {
    cwd,
    encoding: "utf8",
    env: { ...process.env, GIT_CONFIG_NOSYSTEM: "1" },
    stdio: ["ignore", "pipe", "pipe"],
  }).trim();
}

function configureRepo(root: string, actor: string, sandbox: string): void {
  const hooks = join(sandbox, `${actor.toLowerCase()}-hooks`);
  mkdirSync(hooks, { recursive: true });
  git(root, "config", "user.name", actor);
  git(root, "config", "user.email", `${actor.toLowerCase()}@sync-gap.test`);
  git(root, "config", "commit.gpgsign", "false");
  git(root, "config", "core.hooksPath", hooks);
}

type Actor = { name: string; root: string; env: NodeJS.ProcessEnv };

function cloneActor(sandbox: string, codeRemote: string, name: string): Actor {
  const root = join(sandbox, name.toLowerCase());
  const home = join(sandbox, `${name.toLowerCase()}-home`);
  mkdirSync(home, { recursive: true });
  git(sandbox, "clone", "-q", codeRemote, root);
  configureRepo(root, name, sandbox);
  return {
    name,
    root,
    env: {
      ...process.env,
      HOME: home,
      USERPROFILE: home,
      XDG_CONFIG_HOME: join(home, ".config"),
      GIT_CONFIG_NOSYSTEM: "1",
      GIT_AUTHOR_NAME: name,
      GIT_AUTHOR_EMAIL: `${name.toLowerCase()}@sync-gap.test`,
      GIT_COMMITTER_NAME: name,
      GIT_COMMITTER_EMAIL: `${name.toLowerCase()}@sync-gap.test`,
      HUNCH_PRIVATE_DIR: "",
      HUNCH_SYNTH_PROVIDER: "deterministic",
      HUNCH_EMBEDDINGS: "off",
      GIT_TERMINAL_PROMPT: "0",
      NO_COLOR: "1",
      CI: "1",
    },
  };
}

function expectCli(actor: Actor, args: string[]): string {
  const run = spawnSync(process.execPath, hunchCliArgs(...args), {
    cwd: actor.root,
    env: actor.env,
    encoding: "utf8",
    timeout: 45_000,
    maxBuffer: 16 * 1024 * 1024,
  });
  const out = `${run.stdout ?? ""}${run.stderr ?? ""}`;
  assert.equal(run.error, undefined, run.error?.message);
  assert.equal(run.status, 0, out);
  return out;
}

async function mcpResult(client: Client, name: string, args: Record<string, unknown>): Promise<{ isError: boolean; text: string }> {
  const response = await client.callTool({ name, arguments: args });
  const payload = response.content.find((part): part is { type: "text"; text: string } => part.type === "text");
  assert.ok(payload, `${name} returned no text payload`);
  return { isError: response.isError === true, text: payload.text };
}

// A valid compiled policy record, produced by the real compiler in a scratch repo.
function compiledPolicyRecord(sandbox: string): { id: string; json: string } {
  const root = join(sandbox, "policy-source");
  mkdirSync(join(root, "src/api"), { recursive: true });
  mkdirSync(join(root, "src/services"), { recursive: true });
  mkdirSync(join(root, "src/db"), { recursive: true });
  git(sandbox, "init", "-q", root);
  configureRepo(root, "PolicySource", sandbox);
  writeFileSync(join(root, "src/db/client.ts"), "export function dbQuery(sql){ return sql; }\n");
  writeFileSync(join(root, "src/services/orders.ts"), 'import { dbQuery } from "../db/client.js";\nexport function fetchOrders(u){ return dbQuery(u); }\n');
  writeFileSync(join(root, "src/api/orders.ts"), 'import { fetchOrders } from "../services/orders.js";\nexport function listOrders(u){ return fetchOrders(u); }\n');
  git(root, "add", "-A");
  git(root, "commit", "-qm", "fixture: layered orders");
  const store = new HunchStore(hunchPaths(root));
  try {
    store.json.ensureDirs();
    indexRepo(store, root, { churn: false });
    const decision: Decision = {
      id: "dec_sync_gap",
      title: "Order controllers must use OrderService for persistence",
      topic: "orders.controller-db-boundary",
      status: "accepted",
      context: "A direct controller-to-DB optimization reintroduced the N+1 incident.",
      decision: "Controllers reach persistence through the service boundary.",
      consequences: [],
      alternatives_rejected: ["Direct database access from controllers."],
      rejected_tripwires: [],
      related_components: [],
      related_files: ["src/api/orders.ts", "src/services/orders.ts", "src/db/client.ts"],
      supersedes: null,
      superseded_by: null,
      caused_by_bug: null,
      commit: null,
      valid_from: NOW,
      valid_to: null,
      retired: { symbols: [], deps: [] },
      conformance: [{ assert: "not-calls", subject: "listOrders", object: "dbQuery", transitive: false }],
      provenance: { source: "human_confirmed", confidence: 1, evidence: ["review-sync-gap"] },
      date: NOW,
    };
    store.json.put("decisions", decision);
    store.reindex();
    const policy = new ConstitutionService(store, root).compile("dec_sync_gap", { through: "fetchOrders", now: NOW });
    assert.equal(policy.proof ?? null, null, "fixture policy is an unproved candidate");
    return { id: policy.id, json: readFileSync(join(root, ".hunch", "policies", `${policy.id}.json`), "utf8") };
  } finally {
    store.close();
  }
}

// Team sync gap: a teammate's long-lived MCP whose ordinary pulls are in failure
// backoff must not report a just-pushed policy as "not found". An exact policy
// miss bypasses the backoff once (like hunch_current_decision), and abstains
// explicitly when the shared store cannot be refreshed.
test("team policy reads confirm a local miss against fresh shared memory despite pull backoff", { timeout: 300_000 }, async () => {
  const sandbox = mkdtempSync(join(tmpdir(), "hunch-policy-sync-gap-"));
  let client: Client | undefined;
  try {
    const memorySeed = join(sandbox, "memory-seed");
    const memoryRemote = join(sandbox, "memory.git");
    mkdirSync(memorySeed, { recursive: true });
    git(memorySeed, "init", "-q", "-b", "main");
    configureRepo(memorySeed, "MemorySeed", sandbox);
    writeFileSync(join(memorySeed, "README.md"), "# team memory\n");
    git(memorySeed, "add", "README.md");
    git(memorySeed, "commit", "-qm", "seed: shared memory repository");
    git(sandbox, "clone", "-q", "--bare", memorySeed, memoryRemote);

    const codeSeed = join(sandbox, "code-seed");
    const codeRemote = join(sandbox, "code.git");
    mkdirSync(join(codeSeed, "src"), { recursive: true });
    git(codeSeed, "init", "-q", "-b", "main");
    configureRepo(codeSeed, "CodeSeed", sandbox);
    writeFileSync(join(codeSeed, "src/orders.ts"), "export const orders = () => [];\n");
    git(codeSeed, "add", "src/orders.ts");
    git(codeSeed, "commit", "-qm", "feat: tiny orders service");
    git(sandbox, "clone", "-q", "--bare", codeSeed, codeRemote);

    const architect = cloneActor(sandbox, codeRemote, "Architect");
    expectCli(architect, ["init", "--no-index", "--no-enforce", "--no-providers", "--no-agent-hooks"]);
    expectCli(architect, ["shared", "--repo", memoryRemote, "--no-hook"]);
    git(architect.root, "add", "-A");
    git(architect.root, "commit", "-qm", "chore: connect team memory");
    git(architect.root, "push", "-q", "origin", "main");

    const developer = cloneActor(sandbox, codeRemote, "Developer");
    trustTeamStoreAs(developer.env, developer.root);
    expectCli(developer, [
      "record-constraint", "SYNC_GAP_FIRST_WRITE: wire the developer to shared memory",
      "--scope", "src/orders.ts", "--severity", "warning", "--type", "correctness",
    ]);

    // The teammate's policy, staged in a separate memory clone and pushed later.
    const policy = compiledPolicyRecord(sandbox);
    const staging = join(sandbox, "teammate-memory");
    git(sandbox, "clone", "-q", memoryRemote, staging);
    configureRepo(staging, "Teammate", sandbox);
    mkdirSync(join(staging, ".hunch", "policies"), { recursive: true });
    writeFileSync(join(staging, ".hunch", "policies", `${policy.id}.json`), policy.json);
    git(staging, "add", "-A");
    git(staging, "commit", "-qm", "hunch: compile policy");

    // GIT_TRACE on the MCP process only: count its shared-remote contacts (a team
    // pull probes with ls-remote and only fetches when the probe succeeds).
    const gitTrace = join(sandbox, "developer-mcp-git-trace.log");
    writeFileSync(gitTrace, "");
    const fetchCount = (): number => (readFileSync(gitTrace, "utf8").match(/built-in: git (?:ls-remote|fetch)\b/g) ?? []).length;
    const transport = new StdioClientTransport({
      command: process.execPath,
      args: hunchCliArgs("mcp"),
      cwd: developer.root,
      env: { ...developer.env, GIT_TRACE: gitTrace },
    });
    client = new Client({ name: "sync-gap-developer", version: "1.0.0" });
    await client.connect(transport);
    const probeCount = (): number => (readFileSync(gitTrace, "utf8").match(/built-in: git ls-remote/g) ?? []).length;
    const sleep = (ms: number) => new Promise((done) => setTimeout(done, ms));
    // Healthy remote: once the startup pull's 1s cooldown has passed, the request's
    // ordinary pull converges, so the exact miss must not force a second probe.
    await sleep(1_100);
    const probesBeforeHealthyMiss = probeCount();
    const before = await mcpResult(client, "hunch_policy_proof", { policy_id: policy.id });
    assert.equal(before.isError, true, before.text);
    assert.match(before.text, new RegExp(`policy ${policy.id} not found`),
      "with a fresh shared store a confirmed miss keeps the ordinary not-found error");
    assert.equal(probeCount() - probesBeforeHealthyMiss, 1,
      "a miss in a request whose ordinary pull was fresh must not double-fetch");

    // Transient remote failure. An exact miss force-pulls once and abstains; the
    // same miss repeated within the retry window reuses that failure without a
    // fetch; a distinct miss force-pulls. Non-miss reads then deepen the ordinary
    // backoff (2s, 4s, 8s) without adding forced failures.
    const remoteObjects = join(memoryRemote, "objects");
    const unavailableObjects = join(memoryRemote, "objects.transiently-unavailable");
    const assertAbstained = (result: { isError: boolean; text: string }): void => {
      assert.equal(result.isError, true, result.text);
      assert.match(result.text, /refresh is failed/);
      assert.match(result.text, /cannot confirm that policy \S+ is absent from shared team memory/);
      assert.match(result.text, /Retry/);
      assert.doesNotMatch(result.text, /not found/);
    };
    let lastFailureStartedAt = 0;
    renameSync(remoteObjects, unavailableObjects);
    try {
      const fetchesBefore = fetchCount();
      assertAbstained(await mcpResult(client, "hunch_policy_card", { policy_id: policy.id }));
      const fetchesAfterFirst = fetchCount();
      assert.ok(fetchesAfterFirst > fetchesBefore, "the first exact miss must force a shared pull");
      assertAbstained(await mcpResult(client, "hunch_policy_card", { policy_id: policy.id }));
      assert.equal(fetchCount(), fetchesAfterFirst,
        "a repeated miss within the retry window must reuse the failed forced pull, not contact the remote again");
      assertAbstained(await mcpResult(client, "hunch_policy_card", { policy_id: "pol_sync_gap_missing_a" }));
      assert.ok(fetchCount() > fetchesAfterFirst, "a distinct miss after one failure must still force a pull");
      for (const wait of [2_100, 4_100]) {
        await sleep(wait);
        lastFailureStartedAt = Date.now();
        await mcpResult(client, "hunch_query", { query: "sync gap" });
      }
    } finally {
      renameSync(unavailableObjects, remoteObjects);
    }

    // The teammate pushes while this MCP's ordinary pulls are still in backoff.
    git(staging, "push", "-q", "origin", "main");
    const proof = await mcpResult(client, "hunch_policy_proof", { policy_id: policy.id });
    assert.equal(proof.isError, false, proof.text);
    assert.match(proof.text, new RegExp(`Policy ${policy.id} has no proof yet`),
      "the long-lived teammate MCP must see the just-pushed policy despite pull backoff");
    assert.ok(Date.now() - lastFailureStartedAt < 8_000,
      "the final read must complete while the ordinary 8s pull backoff is still active");

    // Global bound: alternating misses A,B,A,B against a dead remote stop contacting
    // it after three consecutive forced failures, until the ordinary backoff passes.
    renameSync(remoteObjects, unavailableObjects);
    try {
      const contactsBefore = fetchCount();
      for (const id of ["pol_sync_gap_alt_a", "pol_sync_gap_alt_b", "pol_sync_gap_alt_a"]) {
        assertAbstained(await mcpResult(client, "hunch_policy_card", { policy_id: id }));
      }
      const contactsAfterLimit = fetchCount();
      assert.ok(contactsAfterLimit - contactsBefore >= 3, "the first three alternating misses each force a pull");
      for (const id of ["pol_sync_gap_alt_b", "pol_sync_gap_alt_a", "pol_sync_gap_alt_b"]) {
        assertAbstained(await mcpResult(client, "hunch_policy_card", { policy_id: id }));
      }
      assert.equal(fetchCount(), contactsAfterLimit,
        "after three consecutive forced failures, misses must abstain without contacting the remote");
    } finally {
      renameSync(unavailableObjects, remoteObjects);
    }
  } finally {
    await client?.close().catch(() => undefined);
    cleanupDir(sandbox);
  }
});

// Issue #474: hunch_why(<record id>) answering "No record <id>" is the same kind of
// team-absence claim, so a shared-mode id miss is confirmed against a fresh pull.
test("hunch_why(<record id>) confirms a shared-memory miss against a fresh pull despite pull backoff", { timeout: 300_000 }, async () => {
  const sandbox = mkdtempSync(join(tmpdir(), "hunch-why-sync-gap-"));
  let client: Client | undefined;
  try {
    const memorySeed = join(sandbox, "memory-seed");
    const memoryRemote = join(sandbox, "memory.git");
    mkdirSync(memorySeed, { recursive: true });
    git(memorySeed, "init", "-q", "-b", "main");
    configureRepo(memorySeed, "MemorySeed", sandbox);
    writeFileSync(join(memorySeed, "README.md"), "# team memory\n");
    git(memorySeed, "add", "README.md");
    git(memorySeed, "commit", "-qm", "seed: shared memory repository");
    git(sandbox, "clone", "-q", "--bare", memorySeed, memoryRemote);

    const codeSeed = join(sandbox, "code-seed");
    const codeRemote = join(sandbox, "code.git");
    mkdirSync(join(codeSeed, "src"), { recursive: true });
    git(codeSeed, "init", "-q", "-b", "main");
    configureRepo(codeSeed, "CodeSeed", sandbox);
    writeFileSync(join(codeSeed, "src/orders.ts"), "export const orders = () => [];\n");
    git(codeSeed, "add", "src/orders.ts");
    git(codeSeed, "commit", "-qm", "feat: tiny orders service");
    git(sandbox, "clone", "-q", "--bare", codeSeed, codeRemote);

    const architect = cloneActor(sandbox, codeRemote, "Architect");
    expectCli(architect, ["init", "--no-index", "--no-enforce", "--no-providers", "--no-agent-hooks"]);
    expectCli(architect, ["shared", "--repo", memoryRemote, "--no-hook"]);
    git(architect.root, "add", "-A");
    git(architect.root, "commit", "-qm", "chore: connect team memory");
    git(architect.root, "push", "-q", "origin", "main");

    const developer = cloneActor(sandbox, codeRemote, "Developer");
    trustTeamStoreAs(developer.env, developer.root);
    expectCli(developer, [
      "record-constraint", "WHY_SYNC_GAP_FIRST_WRITE: wire the developer to shared memory",
      "--scope", "src/orders.ts", "--severity", "warning", "--type", "correctness",
    ]);

    const id = "dec_5ca1ab1e01";
    const decision: Decision = {
      id, title: "Orders are paginated server-side", topic: null, status: "accepted",
      context: "", decision: "Paginate on the server.", consequences: [],
      alternatives_rejected: ["Client-side paging of the full list."], rejected_tripwires: [],
      related_components: [], related_files: ["src/orders.ts"], supersedes: null, superseded_by: null,
      caused_by_bug: null, commit: null, valid_from: NOW, valid_to: null, retired: { symbols: [], deps: [] },
      provenance: { source: "human_confirmed", confidence: 1, evidence: ["why-sync-gap"] }, date: NOW,
    };
    const staging = join(sandbox, "teammate-memory");
    git(sandbox, "clone", "-q", memoryRemote, staging);
    configureRepo(staging, "Teammate", sandbox);
    mkdirSync(join(staging, ".hunch", "decisions"), { recursive: true });
    writeFileSync(join(staging, ".hunch", "decisions", `${id}.json`), `${JSON.stringify(decision, null, 2)}\n`);
    // A second decision whose window opens far in the future: held locally after the
    // pull, but outside any present as_of window.
    const futureId = "dec_5ca1ab1e02";
    const future: Decision = { ...decision, id: futureId, title: "Future paging", valid_from: "2099-01-01T00:00:00.000Z", date: "2099-01-01T00:00:00.000Z" };
    writeFileSync(join(staging, ".hunch", "decisions", `${futureId}.json`), JSON.stringify(future, null, 2));
    // Same window, hand-written id shape (not hex): still "No record <id> as of" (#493).
    const handId = "dec_future_paging";
    writeFileSync(join(staging, ".hunch", "decisions", `${handId}.json`), JSON.stringify({ ...future, id: handId }, null, 2));
    git(staging, "add", "-A");
    git(staging, "commit", "-qm", "hunch: record decision");

    client = new Client({ name: "why-sync-gap-developer", version: "1.0.0" });
    await client.connect(new StdioClientTransport({ command: process.execPath, args: hunchCliArgs("mcp"), cwd: developer.root, env: developer.env }));
    const sleep = (ms: number) => new Promise((done) => setTimeout(done, ms));
    // Put the ordinary request pulls into FAILURE backoff (remote objects transiently
    // gone). Each failed ordinary pull doubles the window: 1s, 2s, 4s, then 8s after
    // the fourth, which leaves the forced path a wide margin. Then restore the remote.
    await sleep(1_100);
    const remoteObjects = join(memoryRemote, "objects");
    const unavailableObjects = join(memoryRemote, "objects.transiently-unavailable");
    let lastFailureStartedAt = 0;
    renameSync(remoteObjects, unavailableObjects);
    try {
      await mcpResult(client, "hunch_query", { query: "orders" });
      for (const wait of [1_100, 2_100, 4_100]) {
        await sleep(wait);
        lastFailureStartedAt = Date.now();
        await mcpResult(client, "hunch_query", { query: "orders" });
      }
    } finally {
      renameSync(unavailableObjects, remoteObjects);
    }
    // The teammate pushes while this MCP's ordinary pulls are still in backoff: only
    // the forced confirmation of the id miss can see the record.
    git(staging, "push", "-q", "origin", "main");
    const why = await mcpResult(client, "hunch_why", { target: id });
    assert.ok(Date.now() - lastFailureStartedAt < 8_000,
      "the read must complete while the ordinary 8s pull backoff is still active");
    assert.equal(why.isError, false, why.text);
    assert.ok(why.text.includes(`DECISION ${id} [accepted] Orders are paginated server-side`), why.text);
    assert.match(why.text, /Client-side paging of the full list/);
    assert.doesNotMatch(why.text, /No record/);

    // A record held locally but outside its as_of window is not a team-absence
    // claim: with the remote down it answers "No record … as of" without a forced
    // pull (a forced pull would fail and abstain with "cannot confirm").
    renameSync(remoteObjects, unavailableObjects);
    try {
      const windowed = await mcpResult(client, "hunch_why", { target: futureId, as_of: "HEAD" });
      assert.equal(windowed.isError, false, windowed.text);
      assert.match(windowed.text, new RegExp(`No record ${futureId} as of`));
      assert.doesNotMatch(windowed.text, /cannot confirm/);
      const handWindowed = await mcpResult(client, "hunch_why", { target: handId, as_of: "HEAD" });
      assert.equal(handWindowed.isError, false, handWindowed.text);
      assert.match(handWindowed.text, new RegExp(`No record ${handId} as of`));
      assert.doesNotMatch(handWindowed.text, /cannot confirm|No recorded/);
    } finally {
      renameSync(unavailableObjects, remoteObjects);
    }
  } finally {
    await client?.close().catch(() => undefined);
    cleanupDir(sandbox);
  }
});
