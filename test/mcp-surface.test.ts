import { cleanupDir, isolatedCliEnv, tempDir } from "./fixtures.js";
/**
 * The whole MCP surface over a REAL connection: `hunch mcp` is spawned as a subprocess
 * and driven through the SDK's StdioClientTransport, exactly as an assistant would.
 *
 * EXPECTED_TOOLS is the registry contract. A tool added to src/mcp without a row in
 * VALID below fails this suite until someone writes a call case for it, so no tool
 * ships that has never been called end-to-end.
 */
import { test, before, after } from "node:test";
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { copyFileSync, existsSync, mkdirSync, readFileSync, readdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { Ajv } from "ajv";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StdioClientTransport } from "@modelcontextprotocol/sdk/client/stdio.js";
import { HunchStore } from "../src/store/hunchStore.js";
import { hunchPaths } from "../src/core/paths.js";

const PROJECT_ROOT = process.cwd();
const TSX = join(PROJECT_ROOT, "node_modules/tsx/dist/cli.mjs");
const CLI = join(PROJECT_ROOT, "src/cli/index.ts");
const VERSION = (JSON.parse(readFileSync(join(PROJECT_ROOT, "package.json"), "utf8")) as { version: string }).version;

const EXPECTED_TOOLS = [
  "hunch_blast_radius", "hunch_bug_lineage", "hunch_capture_decision", "hunch_change_identity", "hunch_change_proof",
  "hunch_check_constraints", "hunch_compare", "hunch_conformance", "hunch_constitution_g2_behavior_candidates",
  "hunch_constitution_g2_behavior_materialization", "hunch_constitution_g2_behavior_policy_materialize",
  "hunch_constitution_g2_behavior_replay", "hunch_constitution_g2_candidates", "hunch_constitution_g2_operational_drill",
  "hunch_constitution_g2_readiness", "hunch_constitution_g2_shadow_queue", "hunch_constitution_g3_readiness",
  "hunch_context", "hunch_current_decision", "hunch_escalations", "hunch_evidence_map", "hunch_findings",
  "hunch_get_dependents", "hunch_merge_verdict", "hunch_now", "hunch_path", "hunch_policy_candidates",
  "hunch_policy_card", "hunch_policy_evaluate", "hunch_policy_plan", "hunch_policy_proof", "hunch_policy_shadow",
  "hunch_policy_upgrade_correction", "hunch_pr_impact", "hunch_project_dna", "hunch_project_dna_delta",
  "hunch_project_match", "hunch_query", "hunch_record_correction", "hunch_record_decision", "hunch_record_finding",
  "hunch_report", "hunch_review_imported_adr", "hunch_runbook", "hunch_shortlist", "hunch_structure", "hunch_task",
  "hunch_timeline", "hunch_why", "hunch_wiki_status", "hunch_workspaces",
  "nuryel_capabilities", "nuryel_capture", "nuryel_capture_batch", "nuryel_read", "nuryel_records", "nuryel_subscribe", "nuryel_write",
];

type ToolResult = { content?: unknown; isError?: boolean; structuredContent?: unknown };
type Ctx = {
  root: string; taskId: string; decisionId: string; constraintId: string; findingId: string; bugId: string; policyId: string;
  repo: { kind: string; id: string }; principal: Record<string, unknown>; receiptId: string;
};
type Case = {
  args: (ctx: Ctx) => Record<string, unknown>;
  /** A legitimate refusal for these args (needs a human or external state the fixture cannot have). */
  refuses?: RegExp;
  /** Post-call assertion that the write landed; may capture ids into ctx. */
  check?: (ctx: Ctx, text: string, res: ToolResult) => void;
};

const text = (r: ToolResult): string =>
  ((r.content as { type: string; text?: string }[] | undefined) ?? []).filter((c) => c.type === "text").map((c) => c.text ?? "").join("\n");

const git = (cwd: string, ...args: string[]): string =>
  execFileSync("git", args, { cwd, encoding: "utf8", env: { ...process.env, GIT_CONFIG_NOSYSTEM: "1" }, stdio: ["ignore", "pipe", "pipe"] }).trim();

const records = (root: string, kind: string): Record<string, unknown>[] => {
  const dir = join(root, ".hunch", kind);
  if (!existsSync(dir)) return [];
  return readdirSync(dir).filter((f) => f.endsWith(".json")).map((f) => JSON.parse(readFileSync(join(dir, f), "utf8")) as Record<string, unknown>);
};

const sha = (c: string): string => `sha256:${c.repeat(64)}`;
const source = { ref: { system: "crm", object_type: "note", object_key: "surface-note", observed_at: "2026-09-10T12:00:00Z" }, source_text: "Use the west entrance. Call Dana on Thursday." };
const relevance = { use: "operational_fact", reason: "Choose the correct entrance for visits." };

const VALID: Record<string, Case> = {
  hunch_query: { args: () => ({ query: "orders" }) },
  hunch_task: {
    args: () => ({ action: "start", title: "mcp surface task" }),
    check: (ctx, t) => {
      const id = /htask_[a-f0-9]{24}/.exec(t)?.[0];
      assert.ok(id, `task id in start result: ${t}`);
      ctx.taskId = id; // hunch_report(task_id) below re-reads the landed task
    },
  },
  hunch_report: { args: (ctx) => ({ task_id: ctx.taskId }), check: (ctx, t) => assert.ok(t.length > 0 && !/not found|unknown task/i.test(t), t) },
  hunch_runbook: { args: () => ({ task: "add an orders endpoint" }) },
  hunch_why: { args: () => ({ target: "src/orders.ts" }) },
  hunch_bug_lineage: { args: () => ({ symptom_or_symbol: "orders" }) },
  hunch_check_constraints: { args: () => ({ scope: "src/orders.ts" }) },
  hunch_get_dependents: { args: () => ({ symbol: "listOrders" }) },
  hunch_blast_radius: { args: () => ({ target: "src/orders.ts" }) },
  hunch_change_identity: { args: () => ({ base_ref: "HEAD~1" }) },
  hunch_change_proof: { args: () => ({ base_ref: "HEAD~1" }) },
  hunch_project_dna: { args: () => ({}) },
  hunch_project_match: { args: () => ({ kind: "issue", title: "orders list is empty" }) },
  hunch_project_dna_delta: { args: () => ({ from_ref: "HEAD~1", to_ref: "HEAD" }) },
  hunch_context: { args: () => ({ target: "src/orders.ts" }) },
  hunch_shortlist: { args: () => ({ issue: "orders list is empty" }) },
  hunch_evidence_map: { args: () => ({ version: 1, claim: "listOrders returns nothing", probe: { target_before: "red", control_before: "green" } }) },
  hunch_now: { args: () => ({}) },
  hunch_workspaces: { args: () => ({}) },
  hunch_escalations: { args: () => ({}) },
  hunch_review_imported_adr: {
    args: (ctx) => ({ decision_id: ctx.decisionId, expected_source_hash: sha("a"), expected_review_hash: sha("b"), disposition: "approve" }),
    refuses: /import|ADR|review|source/i,
  },
  hunch_wiki_status: { args: () => ({}) },
  hunch_timeline: { args: () => ({ target: "src/orders.ts" }) },
  hunch_capture_decision: { args: () => ({ topic: "orders.paging", seed: "page orders by cursor" }) },
  hunch_current_decision: { args: () => ({ topic: "orders.listing" }), check: (ctx, t) => assert.ok(t.includes(ctx.decisionId), t) },
  hunch_record_decision: {
    args: () => ({ decision: { title: "Page orders by cursor", decision: "Use cursor paging for listOrders", topic: "orders.paging" } }),
    check: (ctx) => assert.ok(records(ctx.root, "decisions").some((d) => d.title === "Page orders by cursor"), "decision JSON landed"),
  },
  hunch_record_correction: {
    args: () => ({ rule: "never return unbounded order lists", scope_hint_file: "src/orders.ts" }),
    check: (ctx) => assert.ok(records(ctx.root, "constraints").some((c) => c.statement === "never return unbounded order lists"), "constraint JSON landed"),
  },
  hunch_record_finding: {
    args: () => ({ finding: { title: "Orders list ignores tenant", observation: "listOrders has no tenant filter", evidence: ["src/orders.ts:1"] } }),
    check: (ctx) => assert.ok(records(ctx.root, "findings").some((f) => f.title === "Orders list ignores tenant"), "finding JSON landed"),
  },
  nuryel_capabilities: {
    args: () => ({}),
    check: (ctx, _t, res) => {
      const caps = res.structuredContent as { repository: { kind: string; id: string } };
      ctx.repo = caps.repository;
      ctx.principal = { id: "surface@test", kind: "agent", grants: [caps.repository] };
    },
  },
  nuryel_read: { args: (ctx) => ({ principal: ctx.principal, scope: ctx.repo }) },
  nuryel_write: {
    args: (ctx) => ({
      principal: ctx.principal, scope: ctx.repo, facet: "receipts", idempotency_key: "surface-receipt-1",
      record: {
        schema: "nuryel.receipt/1", scope: ctx.repo, actor: "surface@test", action_kind: "add_comment",
        target: { system: "crm", object_type: "event", object_key: "10042", version: "2", observed_at: "2026-09-07T12:00:00Z" },
        request_fingerprint: sha("c"), state: "verified", occurred_at: "2026-09-07T08:55:22Z",
        provenance: { source: "imported:surface", confidence: 0.9, evidence: ["row a1"] },
      },
    }),
    check: (ctx, t, res) => {
      const id = (res.structuredContent as { record_id?: string } | undefined)?.record_id;
      assert.ok(id, `record_id in write result: ${t}`);
      ctx.receiptId = id;
    },
  },
  nuryel_capture: {
    args: (ctx) => ({ principal: ctx.principal, scope: ctx.repo, subject: "customer:surface", statement: "Use the west entrance.", relevance, evidence: [{ ...source, excerpt: "Use the west entrance." }] }),
  },
  nuryel_capture_batch: {
    args: (ctx) => ({ principal: ctx.principal, scope: ctx.repo, sources: [source], observations: [{ subject: "customer:surface", statement: "Call Dana on Thursday.", relevance, evidence: [{ source: 0, excerpt: "Call Dana on Thursday." }] }] }),
  },
  nuryel_subscribe: {
    args: (ctx) => ({ principal: ctx.principal, scope: ctx.repo, after_seq: 0 }),
    check: (ctx, t) => assert.ok(t.includes(ctx.receiptId), "the ledger carries the receipt written earlier"),
  },
  nuryel_records: { args: (ctx) => ({ principal: ctx.principal, scope: ctx.repo, ids: [ctx.receiptId] }), check: (ctx, t) => assert.ok(t.includes(ctx.receiptId), t) },
  hunch_findings: { args: () => ({ all: true }), check: (ctx, t) => assert.ok(t.includes(ctx.findingId), "seeded finding listed") },
  hunch_policy_upgrade_correction: { args: (ctx) => ({ constraint_id: ctx.constraintId }) },
  hunch_merge_verdict: { args: () => ({ base: "HEAD~1" }) },
  hunch_structure: { args: () => ({}) },
  hunch_pr_impact: { args: () => ({ base: "HEAD~1" }) },
  hunch_path: { args: () => ({ from: "src/orders.ts", to: "src/api.ts" }) },
  hunch_compare: { args: () => ({ candidates: ["cursor paging", "offset paging"] }) },
  hunch_policy_candidates: { args: () => ({}) },
  hunch_policy_plan: { args: (ctx) => ({ policy_id: ctx.policyId }) },
  hunch_policy_card: { args: (ctx) => ({ policy_id: ctx.policyId }) },
  hunch_policy_shadow: { args: (ctx) => ({ policy_id: ctx.policyId }) },
  hunch_policy_proof: { args: (ctx) => ({ policy_id: ctx.policyId }) },
  hunch_policy_evaluate: { args: () => ({}) },
  hunch_constitution_g2_readiness: { args: () => ({}) },
  hunch_constitution_g3_readiness: { args: () => ({}) },
  hunch_constitution_g2_shadow_queue: { args: () => ({ limit: 5 }) },
  hunch_constitution_g2_operational_drill: { args: () => ({ category: "evaluator_error" }), refuses: /No current private G2 plan/ },
  hunch_constitution_g2_candidates: { args: () => ({ max_commits: 5, limit: 5 }) },
  hunch_conformance: { args: () => ({}) },
  hunch_constitution_g2_behavior_candidates: { args: () => ({ max_commits: 5, limit: 5 }) },
  hunch_constitution_g2_behavior_replay: {
    args: () => ({ candidate_id: "g2behavior_0000000000", review_hash: `sha1:${"0".repeat(40)}`, max_commits: 5 }),
    refuses: /candidate|not found|unknown|no /i,
  },
  hunch_constitution_g2_behavior_materialization: { args: () => ({ max_commits: 5, limit: 5 }), refuses: /human disposition/ },
  hunch_constitution_g2_behavior_policy_materialize: { args: () => ({ max_commits: 5, limit: 5 }), refuses: /private Hunch overlay/ },
};

/** Tools whose valid-argument call is a real bug today: kept, reported, not hidden. */
const TODO: Record<string, string> = {
  hunch_policy_card: "fixture cannot seed a policy proof record (proofs live in the private overlay): proof not found",
  hunch_policy_proof: "fixture cannot seed a policy proof record (proofs live in the private overlay): proof not found",
  hunch_policy_shadow: "fixture cannot seed a policy proof record (proofs live in the private overlay): proof not found",
};

type Schema = { type?: string; properties?: Record<string, { type?: string; enum?: unknown[]; anyOf?: unknown[]; const?: unknown }>; required?: string[] };

/** A value that breaks the tool's schema: drop a required field, else mistype a property. */
function invalidArgs(schema: Schema, valid: Record<string, unknown>): Record<string, unknown> | null {
  const required = schema.required ?? [];
  if (required.length) { const copy = { ...valid }; delete copy[required[0]!]; return copy; }
  const [name, prop] = Object.entries(schema.properties ?? {})[0] ?? [];
  if (!name || !prop) return null;
  const wrong = prop.type === "string" || prop.enum ? 12345 : prop.type === "boolean" || prop.type === "number" || prop.type === "integer" || prop.type === "array" || prop.type === "object" ? "not-the-right-type" : { nope: true };
  return { ...valid, [name]: wrong };
}

const spawnEnv = (): Record<string, string> => Object.fromEntries(Object.entries(isolatedCliEnv({
  HUNCH_MCP_TOOLS: "all", HUNCH_PRIVATE_DIR: "", GIT_CONFIG_NOSYSTEM: "1", HUNCH_NO_UPDATE_CHECK: "1",
})).filter((e): e is [string, string] => typeof e[1] === "string"));

async function connect(root: string): Promise<{ client: Client; transport: StdioClientTransport }> {
  const transport = new StdioClientTransport({ command: process.execPath, args: [TSX, CLI, "mcp"], cwd: root, env: spawnEnv(), stderr: "ignore" });
  const client = new Client({ name: "mcp-surface-test", version: "1.0.0" });
  await client.connect(transport);
  return { client, transport };
}

let root = "";
let mcp: { client: Client; transport: StdioClientTransport };
let tools: { name: string; inputSchema: Schema }[] = [];
const ctx = {} as Ctx;

/** Call and classify: a thrown protocol error is returned, not raised, so the caller decides. */
async function call(client: Client, name: string, args: Record<string, unknown>): Promise<ToolResult | Error> {
  try { return (await client.callTool({ name, arguments: args }, undefined, { timeout: 60_000 })) as ToolResult; }
  catch (error) { return error as Error; }
}

before(async () => {
  root = tempDir("hunch-mcp-surface-");
  git(root, "init", "-q", "-b", "main");
  git(root, "config", "user.email", "surface@test.invalid");
  git(root, "config", "user.name", "Surface Test");
  git(root, "config", "commit.gpgsign", "false");
  mkdirSync(join(root, "src"), { recursive: true });
  writeFileSync(join(root, "src", "orders.ts"), "export const listOrders = () => [];\n");
  git(root, "add", "-A"); git(root, "commit", "-qm", "orders");
  writeFileSync(join(root, "src", "api.ts"), "import { listOrders } from \"./orders.js\";\nexport const handler = () => listOrders();\n");
  git(root, "add", "-A"); git(root, "commit", "-qm", "api");
  execFileSync(process.execPath, [TSX, CLI, "init", "--no-providers"], { cwd: root, env: spawnEnv(), stdio: "ignore", timeout: 120_000 });
  writeFileSync(join(root, ".hunch", "local.json"), JSON.stringify({ autoCommit: false }));

  // Seed a bug and a policy straight into the JSON source of truth.
  const store = new HunchStore(hunchPaths(root));
  try {
    store.json.ensureDirs();
    ctx.bugId = "bug_surface01";
    store.json.put("bugs", {
      id: ctx.bugId, title: "Orders list empty after deploy", symptom: "orders list is empty", root_cause: "missing tenant filter",
      severity: "medium", status: "open", affected_files: ["src/orders.ts"], affected_symbols: ["listOrders"],
      lineage: { introduced_commit: null, detected: null, fixed_commit: null, recurrence_of: null, spawned_decision: null, spawned_constraint: null },
      provenance: { source: "human_confirmed", confidence: 1, evidence: [] },
    } as never);
    store.reindex();
  } finally { store.close(); }
  const policyFile = readdirSync(join(PROJECT_ROOT, ".hunch", "policies")).filter((f) => f.endsWith(".json")).sort()[0]!;
  mkdirSync(join(root, ".hunch", "policies"), { recursive: true });
  copyFileSync(join(PROJECT_ROOT, ".hunch", "policies", policyFile), join(root, ".hunch", "policies", policyFile));
  ctx.policyId = policyFile.replace(/\.json$/, "");
  ctx.root = root;

  mcp = await connect(root);
  // Decision (with topic), constraint and finding through the real write tools.
  const seeds: [string, Record<string, unknown>][] = [
    ["hunch_record_decision", { decision: { title: "List orders newest first", decision: "listOrders sorts by created_at desc", topic: "orders.listing", related_files: ["src/orders.ts"] } }],
    ["hunch_record_correction", { rule: "orders must always be tenant-scoped", scope_hint_file: "src/orders.ts", severity: "blocking" }],
    ["hunch_record_finding", { finding: { title: "Seed finding", observation: "seeded observation", affected_files: ["src/orders.ts"] } }],
  ];
  for (const [name, args] of seeds) {
    const res = await call(mcp.client, name, args);
    assert.ok(!(res instanceof Error) && !res.isError, `${name} seed: ${res instanceof Error ? res.message : text(res)}`);
  }
  ctx.decisionId = String(records(root, "decisions").find((d) => d.topic === "orders.listing")?.id);
  ctx.constraintId = String(records(root, "constraints").find((c) => c.statement === "orders must always be tenant-scoped")?.id);
  ctx.findingId = String(records(root, "findings").find((f) => f.title === "Seed finding")?.id);
  assert.match(ctx.decisionId, /^dec_/); assert.match(ctx.constraintId, /^con_/); assert.match(ctx.findingId, /^fnd_/);
  // An MCP correction is agent testimony; only a human countersign makes it upgradable (#493).
  execFileSync(process.execPath, [TSX, CLI, "review", "--confirm", ctx.constraintId], { cwd: root, env: spawnEnv(), stdio: "ignore", timeout: 120_000 });
  git(root, "add", "-A"); git(root, "commit", "-qm", "seed memory");
  tools = (await mcp.client.listTools()).tools as typeof tools;
});

after(async () => {
  await mcp?.client.close().catch(() => {});
  if (root) cleanupDir(root);
});

test("initialize handshake reports the hunch server at the package.json version", () => {
  const info = mcp.client.getServerVersion();
  assert.equal(info?.name, "hunch");
  assert.equal(info?.version, VERSION);
  assert.ok(mcp.client.getServerCapabilities()?.tools, "tools capability advertised");
});

test("tools/list equals the expected registry and every inputSchema is a valid JSON Schema object", () => {
  assert.deepEqual(tools.map((t) => t.name).sort(), [...EXPECTED_TOOLS].sort(), "new or removed MCP tool: update EXPECTED_TOOLS and add a VALID call case");
  assert.deepEqual(Object.keys(VALID).sort(), [...EXPECTED_TOOLS].sort(), "every expected tool has a valid-argument call case");
  const ajv = new Ajv({ strict: false, validateFormats: false });
  for (const tool of tools) {
    assert.equal(tool.inputSchema.type, "object", `${tool.name}: inputSchema.type`);
    assert.ok(ajv.validateSchema(tool.inputSchema), `${tool.name}: ${ajv.errorsText(ajv.errors)}`);
    assert.doesNotThrow(() => ajv.compile(tool.inputSchema), `${tool.name}: schema compiles`);
    for (const req of tool.inputSchema.required ?? []) assert.ok(tool.inputSchema.properties?.[req], `${tool.name}: required '${req}' is a declared property`);
  }
});

test("every tool answers valid arguments, and refuses invalid ones cleanly without killing the server", async (t) => {
  for (const name of Object.keys(VALID)) {
    const spec = VALID[name]!;
    const schema = tools.find((x) => x.name === name)!.inputSchema;
    await t.test(name, { todo: TODO[name] }, async () => {
      const args = spec.args(ctx);
      const res = await call(mcp.client, name, args);
      assert.ok(!(res instanceof Error), `${name}: protocol error ${res instanceof Error ? res.message : ""}`);
      const body = text(res);
      assert.ok(body.trim().length > 0, `${name}: non-empty text content`);
      if (spec.refuses) {
        assert.equal(res.isError, true, `${name}: expected a clean refusal, got ${body.slice(0, 400)}`);
        assert.match(body, spec.refuses);
      } else {
        assert.ok(!res.isError, `${name}: isError with valid args: ${body.slice(0, 600)}`);
        spec.check?.(ctx, body, res);
      }

      const bad = invalidArgs(schema, args);
      if (bad) {
        const refused = await call(mcp.client, name, bad);
        const clean = refused instanceof Error ? /invalid|-32602|validation|expected|required/i.test(refused.message) : refused.isError === true;
        assert.ok(clean, `${name}: invalid args not refused cleanly: ${refused instanceof Error ? refused.message : text(refused).slice(0, 300)}`);
      }
      const alive = await call(mcp.client, "hunch_escalations", {});
      assert.ok(!(alive instanceof Error) && !alive.isError, `${name}: server still alive after the invalid call`);
    });
  }
});

test("unknown tool is an error and the server stays alive", async () => {
  const res = await call(mcp.client, "hunch_no_such_tool", {});
  assert.ok(res instanceof Error || res.isError === true, "unknown tool refused");
  if (!(res instanceof Error)) assert.match(text(res), /not found|unknown|no_such/i);
  const alive = await call(mcp.client, "hunch_now", {});
  assert.ok(!(alive instanceof Error) && !alive.isError);
});

test("a burst of 20 concurrent calls returns 20 answers", async () => {
  const names = ["hunch_now", "hunch_query", "hunch_why", "hunch_check_constraints"];
  const argsFor: Record<string, Record<string, unknown>> = { hunch_now: {}, hunch_query: { query: "orders" }, hunch_why: { target: "src/orders.ts" }, hunch_check_constraints: { scope: "src/orders.ts" } };
  const results = await Promise.all(Array.from({ length: 20 }, (_, i) => call(mcp.client, names[i % 4]!, argsFor[names[i % 4]!]!)));
  assert.equal(results.length, 20);
  for (const [i, r] of results.entries()) assert.ok(!(r instanceof Error) && !r.isError && text(r).length > 0, `burst call ${i}`);
});

test("server survives client disconnect: a second client reconnects and sees the persisted writes", async () => {
  const pid = mcp.transport.pid;
  await mcp.client.close();
  if (pid) {
    const deadline = Date.now() + 10_000;
    const alive = (): boolean => { try { process.kill(pid, 0); return true; } catch { return false; } };
    while (alive() && Date.now() < deadline) await new Promise((r) => setTimeout(r, 100));
    assert.ok(!alive(), "the first server process exits when its client disconnects");
  }
  mcp = await connect(root);
  assert.equal(mcp.client.getServerVersion()?.version, VERSION);
  const res = await call(mcp.client, "hunch_current_decision", { topic: "orders.listing" });
  assert.ok(!(res instanceof Error) && !res.isError && text(res).includes(ctx.decisionId), "the reconnected server serves the decision written by the first");
});
