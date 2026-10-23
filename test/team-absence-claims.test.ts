import { cleanupDir, trustTeamStoreAs } from "./fixtures.js";
import assert from "node:assert/strict";
import { execFileSync, spawnSync } from "node:child_process";
import { mkdirSync, mkdtempSync, readFileSync, renameSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StdioClientTransport } from "@modelcontextprotocol/sdk/client/stdio.js";
import { ElicitRequestSchema } from "@modelcontextprotocol/sdk/types.js";
import { HunchStore } from "../src/store/hunchStore.js";
import { hunchPaths } from "../src/core/paths.js";
import { indexRepo } from "../src/extractors/indexer.js";
import type { Decision } from "../src/core/types.js";
import { ConstitutionService } from "../src/constitution/service.js";
import { hunchCliArgs } from "./cli-invocation.js";
// Discovery must see every MCP group, including the specialist policy tools.
process.env.HUNCH_MCP_TOOLS = "all";

// Bug class: in shared team mode a long-lived MCP whose ordinary pulls sit behind a
// cooldown/backoff presents LOCAL absence as TEAM absence ("policy X not found" for a
// policy a teammate just pushed). Every tool that answers "not found / none / no
// current" for an exact id must either see the teammate's record or abstain
// explicitly ("cannot confirm"), never claim plain absence.

const NOW = "2026-07-10T10:00:00.000Z";
const ABSTAIN = /cannot confirm/i;

// Every tool whose input schema takes an exact record id or topic must be classified
// here; a new id-taking tool fails discovery until someone decides whether its
// absence answer is a team-absence claim.
//   checked      — teammate-propagation case + dead-remote abstention case below.
//   absence-only — no MCP path creates its record; only the dead-remote case runs.
//   exempt       — the id never yields an absence claim about team memory.
const CLASSIFICATION: Record<string, string> = {
  hunch_current_decision: "checked",
  hunch_why: "checked",
  hunch_findings: "checked",
  hunch_policy_upgrade_correction: "checked",
  hunch_policy_plan: "checked",
  hunch_policy_card: "checked",
  hunch_policy_shadow: "checked",
  hunch_policy_proof: "checked",
  hunch_policy_evaluate: "checked",
  hunch_review_imported_adr: "absence-only: imported ADRs are created by CLI import, not by any MCP tool",
  hunch_capture_decision: "exempt: topic is a proposal for the interview; writes nothing and reads no record",
  hunch_record_correction: "exempt: write; source_decision is only validated against the public home",
  nuryel_records: "exempt: nuryel.state/1 contract; ids resolve against the served partition's grants and ledger, not the team-memory pull",
  hunch_constitution_g2_behavior_candidates: "exempt: private G2 review packet over code history; decision_id selects a batch",
  hunch_constitution_g2_behavior_replay: "exempt: private G2 replay bound to an exact reviewed packet hash",
  hunch_constitution_g2_behavior_materialization: "exempt: private G2 review packet over code history; decision_id selects a batch",
  hunch_constitution_g2_behavior_policy_materialize: "exempt: private G2 write bound to an exact reviewed packet",
};

const ID_PARAM = /^(?:id|ids|topic)$|_id$/;
function idLikeParams(schema: { properties?: Record<string, { description?: string }> }): string[] {
  return Object.entries(schema.properties ?? {})
    .filter(([name, prop]) => name !== "task_id"
      && (ID_PARAM.test(name) || /\brecord id\b|\bid of an?\b/i.test(prop.description ?? "")))
    .map(([name]) => name);
}

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
  git(root, "config", "user.email", `${actor.toLowerCase()}@absence.test`);
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
      GIT_AUTHOR_EMAIL: `${name.toLowerCase()}@absence.test`,
      GIT_COMMITTER_NAME: name,
      GIT_COMMITTER_EMAIL: `${name.toLowerCase()}@absence.test`,
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

async function connectMcp(actor: Actor): Promise<Client> {
  const transport = new StdioClientTransport({ command: process.execPath, args: hunchCliArgs("mcp"), cwd: actor.root, env: actor.env });
  const client = new Client({ name: `absence-${actor.name.toLowerCase()}`, version: "1.0.0" }, { capabilities: { elicitation: {} } });
  client.setRequestHandler(ElicitRequestSchema, async () => ({ action: "accept", content: { confirm: true } }));
  await client.connect(transport);
  return client;
}

type Result = { isError: boolean; text: string };
async function mcpResult(client: Client, name: string, args: Record<string, unknown>): Promise<Result> {
  const response = await client.callTool({ name, arguments: args });
  const payload = response.content.find((part): part is { type: "text"; text: string } => part.type === "text");
  assert.ok(payload, `${name} returned no text payload`);
  return { isError: response.isError === true, text: payload.text };
}

async function mcpOk(client: Client, name: string, args: Record<string, unknown>): Promise<string> {
  const result = await mcpResult(client, name, args);
  assert.equal(result.isError, false, `${name}: ${result.text}`);
  return result.text;
}

// Distinct valid compiled policy records, produced by the real compiler in a scratch repo.
function compiledPolicies(sandbox: string, count: number): { id: string; json: string }[] {
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
    const policies: { id: string; json: string }[] = [];
    for (let n = 1; n <= count; n++) {
      const decision: Decision = {
        id: `dec_absence_${n}`,
        title: `Order controllers must use OrderService for persistence (${n})`,
        topic: `orders.controller-db-boundary-${n}`,
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
        provenance: { source: "human_confirmed", confidence: 1, evidence: [`review-absence-${n}`] },
        date: NOW,
      };
      store.json.put("decisions", decision);
      store.reindex();
      const policy = new ConstitutionService(store, root).compile(decision.id, { through: "fetchOrders", now: NOW });
      policies.push({ id: policy.id, json: readFileSync(join(root, ".hunch", "policies", `${policy.id}.json`), "utf8") });
    }
    assert.equal(new Set(policies.map((p) => p.id)).size, count, "each policy case needs a policy B has never seen");
    return policies;
  } finally {
    store.close();
  }
}

async function recordDecision(client: Client, topic: string): Promise<string> {
  const interview = await mcpOk(client, "hunch_capture_decision", { topic, seed: `Absence probe for ${topic}`, deciding: true });
  const token = interview.match(/capture_token:"([^"]+)"/)?.[1];
  assert.ok(token, interview);
  const text = await mcpOk(client, "hunch_record_decision", {
    capture_token: token,
    decision: {
      topic,
      title: `Absence probe decision for ${topic}`,
      decision: "Orders reach the network only through the shared fetch transport.",
      context: "The whole team needs one durable answer across clones and assistant sessions.",
      alternatives_rejected: ["Direct axios calls — revisit if the shared transport loses required controls."],
      related_files: ["src/orders.ts"],
      status: "accepted",
    },
  });
  assert.match(text, /committed \+ pushed/, text);
  const id = text.match(/Recorded decision (dec_[A-Za-z0-9_-]+)/)?.[1];
  assert.ok(id, text);
  return id;
}

const sleep = (ms: number) => new Promise((done) => setTimeout(done, ms));

type Case = {
  tool: string;
  // Teammate A creates/pushes the record; returns the exact subject B queries with.
  create: (n: number) => Promise<string>;
  args: (subject: string) => Record<string, unknown>;
  // The record was returned (not merely "some answer").
  found: (subject: string) => RegExp;
  // A plain local-absence answer about this exact subject.
  absence: (subject: string) => RegExp;
};

const esc = (s: string): string => s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");

// Today's real gaps (asserted, kept, reported). Remove an entry when the tool learns
// to confirm its miss against fresh team memory. Empty since #487: every checked
// tool routes its miss through confirmSharedMiss.
const TODO: Record<string, string> = {};

test("team absence claims: id-taking MCP tools never present local absence as team absence", { timeout: 330_000 }, async (t) => {
  const sandbox = mkdtempSync(join(tmpdir(), "hunch-absence-claims-"));
  const clients: Client[] = [];
  const remoteObjects = (remote: string) => join(remote, "objects");
  const deadObjects = (remote: string) => join(remote, "objects.transiently-unavailable");
  let memoryRemote = "";
  let remoteDown = false;
  const takeRemoteDown = (): void => { renameSync(remoteObjects(memoryRemote), deadObjects(memoryRemote)); remoteDown = true; };
  const bringRemoteUp = (): void => { if (remoteDown) renameSync(deadObjects(memoryRemote), remoteObjects(memoryRemote)); remoteDown = false; };
  try {
    const memorySeed = join(sandbox, "memory-seed");
    memoryRemote = join(sandbox, "memory.git");
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
    writeFileSync(join(codeSeed, "src/orders.ts"), "export async function listOrders(user: string) {\n  return (await fetch(`/orders/${user}`)).json();\n}\n");
    git(codeSeed, "add", "src/orders.ts");
    git(codeSeed, "commit", "-qm", "feat: tiny orders service");
    git(sandbox, "clone", "-q", "--bare", codeSeed, codeRemote);

    const teammate = cloneActor(sandbox, codeRemote, "Architect");
    expectCli(teammate, ["init", "--no-index", "--no-enforce", "--no-providers", "--no-agent-hooks"]);
    expectCli(teammate, ["shared", "--repo", memoryRemote, "--no-hook"]);
    git(teammate.root, "add", "-A");
    git(teammate.root, "commit", "-qm", "chore: connect team memory");
    git(teammate.root, "push", "-q", "origin", "main");

    const reader = cloneActor(sandbox, codeRemote, "Developer");
    trustTeamStoreAs(reader.env, reader.root);
    expectCli(reader, [
      "record-constraint", "ABSENCE_FIRST_WRITE: wire the developer to shared memory",
      "--scope", "src/orders.ts", "--severity", "warning", "--type", "correctness",
    ]);

    // Policies are compiled artifacts, not MCP captures: the teammate pushes them from
    // a plain memory clone, exactly as a CLI compile + memory push would.
    const policies = compiledPolicies(sandbox, 5);
    const staging = join(sandbox, "teammate-memory");
    git(sandbox, "clone", "-q", memoryRemote, staging);
    configureRepo(staging, "PolicyTeammate", sandbox);
    let nextPolicy = 0;
    const pushPolicy = (): string => {
      const policy = policies[nextPolicy++]!;
      git(staging, "pull", "-q", "--rebase", "origin", "main");
      mkdirSync(join(staging, ".hunch", "policies"), { recursive: true });
      writeFileSync(join(staging, ".hunch", "policies", `${policy.id}.json`), policy.json);
      git(staging, "add", "-A");
      git(staging, "commit", "-qm", `hunch: compile policy ${policy.id}`);
      git(staging, "push", "-q", "origin", "main");
      return policy.id;
    };

    const a = await connectMcp(teammate);
    clients.push(a);
    const b = await connectMcp(reader);
    clients.push(b);

    // -- Discovery: every id-taking tool is classified ---------------------------
    const { tools } = await b.listTools();
    const discovered = tools
      .filter((tool) => idLikeParams(tool.inputSchema as { properties?: Record<string, { description?: string }> }).length > 0)
      .map((tool) => tool.name)
      .sort();
    assert.deepEqual(discovered, Object.keys(CLASSIFICATION).sort(),
      "a tool that takes an exact record id/topic must be classified in CLASSIFICATION");

    const policyAbsence = (id: string) => new RegExp(`policy ${esc(id)} not found|no policy ${esc(id)}`, "i");
    const policyCase = (tool: string): Case => ({
      tool,
      create: async () => pushPolicy(),
      args: (id) => ({ policy_id: id }),
      found: (id) => new RegExp(esc(id)),
      absence: policyAbsence,
    });
    const cases: Case[] = [
      {
        tool: "hunch_current_decision",
        create: async (n) => { const topic = `absence.topic-${n}`; await recordDecision(a, topic); return topic; },
        args: (topic) => ({ topic }),
        found: (topic) => new RegExp(`Current decision for "${esc(topic)}": dec_`),
        absence: (topic) => new RegExp(`No current decision for topic "${esc(topic)}"`),
      },
      {
        tool: "hunch_why",
        create: async (n) => recordDecision(a, `absence.why-${n}`),
        args: (id) => ({ target: id }),
        found: () => /Absence probe decision for absence\.why-/,
        absence: () => /No record|not found/i,
      },
      {
        tool: "hunch_findings",
        create: async (n) => {
          const text = await mcpOk(a, "hunch_record_finding", {
            finding: {
              title: `Absence probe finding ${n}`,
              observation: "Orders retries are not bounded by the shared transport.",
              evidence: ["grep -n retry src/orders.ts -> (no output)"],
              affected_files: ["src/orders.ts"],
              severity: "low",
            },
          });
          const id = text.match(/fnd_[A-Za-z0-9_-]+/)?.[0];
          assert.ok(id, text);
          return id;
        },
        args: (id) => ({ id }),
        found: () => /Absence probe finding/,
        absence: (id) => new RegExp(`No finding "${esc(id)}"|not found`, "i"),
      },
      policyCase("hunch_policy_plan"),
      policyCase("hunch_policy_card"),
      policyCase("hunch_policy_shadow"),
      policyCase("hunch_policy_proof"),
      policyCase("hunch_policy_evaluate"),
      {
        tool: "hunch_policy_upgrade_correction",
        create: async (n) => {
          const text = await mcpOk(a, "hunch_record_correction", {
            rule: `ABSENCE_RULE_${n}: never import axios in src/orders.ts; use the shared fetch transport`,
            scope_hint_file: "src/orders.ts",
            severity: "warning",
            type: "architecture",
            rationale: "Retry and audit controls live in the shared transport boundary.",
          });
          const id = text.match(/constraint (con_[A-Za-z0-9_-]+)/)?.[1];
          assert.ok(id, text);
          return id;
        },
        args: (id) => ({ constraint_id: id }),
        found: (id) => new RegExp(esc(id)),
        absence: (id) => new RegExp(`correction ${esc(id)} not found|constraint ${esc(id)} not found`, "i"),
      },
    ];
    assert.deepEqual(cases.map((c) => c.tool).sort(),
      Object.entries(CLASSIFICATION).filter(([, kind]) => kind === "checked").map(([tool]) => tool).sort(),
      "every checked tool has a propagation case");

    // The sync gap, made deterministic per case:
    //  1. reset B's failure counter with a confirmed miss (a forced, fresh pull);
    //  2. teammate A creates and pushes the record while B is idle;
    //  3. with the remote down, three non-miss reads fail B's ordinary pull
    //     (backoff 1s, 2s, 4s), so B never fetched A's record;
    //  4. restore the remote and query at once: B's ordinary pull is still in its
    //     4s backoff, so its local memory is stale and only a confirmed miss sees A.
    const assertContract = (c: Case, subject: string, result: Result): void => {
      if (ABSTAIN.test(result.text)) {
        assert.doesNotMatch(result.text, c.absence(subject), result.text);
        return;
      }
      assert.doesNotMatch(result.text, c.absence(subject),
        `${c.tool} presented local absence as team absence for ${subject}: ${result.text}`);
      assert.match(result.text, c.found(subject),
        `${c.tool} neither returned the teammate's record nor abstained: ${result.text}`);
    };

    // -- Propagation: A pushes, B (stale, inside backoff) queries immediately -------
    let n = 0;
    for (const c of cases) {
      n++;
      await t.test(`${c.tool}: teammate's just-pushed record is returned or abstained on`, TODO[c.tool] ? { todo: TODO[c.tool] } : {}, async () => {
        // The correction upgrade runs last: it re-indexes and flushes B's memory homes.
        const reset = await mcpResult(b, "hunch_current_decision", { topic: `absence.reset-${n}` });
        assert.equal(reset.isError, false, `reset pull must succeed: ${reset.text}`);
        const subject = await c.create(n);
        let lastFailureStartedAt = 0;
        takeRemoteDown();
        try {
          for (const wait of [1_100, 1_100, 2_100]) {
            await sleep(wait);
            lastFailureStartedAt = Date.now();
            await mcpResult(b, "hunch_now", {});
          }
        } finally {
          bringRemoteUp();
        }
        assert.ok(Date.now() - lastFailureStartedAt < 3_500, `${c.tool} query must start inside B's 4s pull backoff`);
        const result = await mcpResult(b, c.tool, c.args(subject));
        assertContract(c, subject, result);
      });
    }

    // -- Unavailable remote: a non-existent id must abstain ------------------------
    const absent: { tool: string; args: Record<string, unknown>; absence: RegExp }[] = [
      { tool: "hunch_current_decision", args: { topic: "absence.never-recorded" }, absence: /No current decision/ },
      { tool: "hunch_why", args: { target: "dec_absence_never" }, absence: /No record|not found/i },
      { tool: "hunch_findings", args: { id: "fnd_absence_never" }, absence: /No finding|not found/i },
      { tool: "hunch_policy_upgrade_correction", args: { constraint_id: "con_absence_never" }, absence: /not found/i },
      ...["hunch_policy_plan", "hunch_policy_card", "hunch_policy_shadow", "hunch_policy_proof", "hunch_policy_evaluate"]
        .map((tool, i) => ({ tool, args: { policy_id: `pol_absence_never_${i}` }, absence: /not found/i })),
      {
        tool: "hunch_review_imported_adr",
        args: {
          decision_id: "dec_absence_never_imported",
          expected_source_hash: `sha256:${"0".repeat(64)}`,
          expected_review_hash: `sha256:${"0".repeat(64)}`,
          disposition: "decline",
        },
        absence: /not present|not found/i,
      },
    ];
    assert.deepEqual(absent.map((x) => x.tool).sort(),
      Object.entries(CLASSIFICATION).filter(([, kind]) => kind === "checked" || kind.startsWith("absence-only")).map(([tool]) => tool).sort(),
      "every checked/absence-only tool has a dead-remote case");
    takeRemoteDown();
    try {
      for (const x of absent) {
        await t.test(`${x.tool}: unknown id abstains while the team remote is unavailable`, TODO[`${x.tool}#absent`] ? { todo: TODO[`${x.tool}#absent`] } : {}, async () => {
          const result = await mcpResult(b, x.tool, x.args);
          assert.doesNotMatch(result.text, x.absence, `${x.tool} claimed absence it cannot confirm: ${result.text}`);
          assert.match(result.text, ABSTAIN, `${x.tool} must abstain explicitly: ${result.text}`);
          assert.match(result.text, /^Shared team memory refresh is \S+; Hunch cannot confirm that .+\. Retry when the shared store is available\.$/,
            `${x.tool} must use the shared miss confirmation: ${result.text}`);
          assert.equal(result.isError, true, `${x.tool} abstention is an error result: ${result.text}`);
        });
      }
    } finally {
      bringRemoteUp();
    }
  } finally {
    if (remoteDown) bringRemoteUp();
    for (const client of clients) await client.close().catch(() => undefined);
    cleanupDir(sandbox);
  }
});
