/**
 * Capture tokens prove an interview protocol was issued — never that a HUMAN answered.
 *
 * hunch_capture_decision is callable by any agent (or by injected content steering one),
 * so a token minted and consumed entirely inside the agent's MCP channel is agent
 * testimony. Human authority (`human_confirmed`, the thing the strict gate and the
 * edit hook trust) requires a human act outside that channel:
 *   - for a DECISION: an MCP elicitation answered in the client UI (when the client
 *     supports it), or `hunch review --confirm <id>` run by a human;
 *   - for a CORRECTION (which can deny edits): only `hunch review --confirm <id> --severity <s>`.
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { mkdtempSync, rmSync, mkdirSync, readdirSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";
import { ElicitRequestSchema, type ElicitResult } from "@modelcontextprotocol/sdk/types.js";
import { buildServer } from "../src/mcp/server.js";
import { isHumanConfirmed, isStrictBlocker } from "../src/core/strictgate.js";
import type { Constraint, Decision } from "../src/core/types.js";

const projectRoot = process.cwd();
const tsx = join(projectRoot, "node_modules/tsx/dist/cli.mjs");
const cli = join(projectRoot, "src/cli/index.ts");

type Answer = ElicitResult | "no-capability";

async function setup(answer: Answer = "no-capability") {
  const root = mkdtempSync(join(tmpdir(), "hunch-capture-authority-"));
  mkdirSync(join(root, ".hunch", "decisions"), { recursive: true });
  mkdirSync(join(root, ".hunch", "constraints"), { recursive: true });
  writeFileSync(join(root, ".hunch", "local.json"), JSON.stringify({ autoCommit: false }));
  const server = buildServer(root);
  const [clientT, serverT] = InMemoryTransport.createLinkedPair();
  const elicited: string[] = [];
  const client = answer === "no-capability"
    ? new Client({ name: "t", version: "0" })
    : new Client({ name: "t", version: "0" }, { capabilities: { elicitation: {} } });
  if (answer !== "no-capability") {
    client.setRequestHandler(ElicitRequestSchema, async (req) => {
      elicited.push(req.params.message);
      return answer;
    });
  }
  await Promise.all([server.connect(serverT), client.connect(clientT)]);
  const call = async (name: string, args: Record<string, unknown>) => {
    const res = await client.callTool({ name, arguments: args });
    return (res.content as Array<{ text: string }>).map((c) => c.text ?? "").join("\n");
  };
  return {
    root, call, elicited,
    token: async () => /capture_token:"([^"]+)"/.exec(await call("hunch_capture_decision", { topic: "t.topic" }))![1]!,
    cleanup: () => {
      void client.close().catch(() => {});
      try { rmSync(root, { recursive: true, force: true, maxRetries: 3, retryDelay: 50 }); } catch { /* temp dir */ }
    },
  };
}

const readAll = <T>(root: string, kind: string): T[] => {
  const dir = join(root, ".hunch", kind);
  return readdirSync(dir).filter((f) => f.endsWith(".json")).map((f) => JSON.parse(readFileSync(join(dir, f), "utf8")) as T);
};

const REPO_WIDE_BLOCK = { rule: "never edit anything in this repository", severity: "blocking", applies_to_all: true };

test("an MCP-minted token cannot make a repo-wide blocking correction into a strict blocker", async () => {
  const s = await setup();
  try {
    const out = await s.call("hunch_record_correction", { ...REPO_WIDE_BLOCK, capture_token: await s.token() });
    const [c] = readAll<Constraint>(s.root, "constraints");
    assert.equal(c!.provenance.source, "agent_recorded", "a token proves a tool call, not a human signature");
    assert.equal(isHumanConfirmed(c!.provenance.source), false);
    assert.equal(c!.severity, "warning", "an unconfirmed blocking request is capped, so the edit hook cannot deny on it");
    assert.equal(isStrictBlocker(c!, false), false, "never fails hunch check --strict");
    assert.deepEqual(c!.scope, ["**"]);
    assert.match(out, new RegExp(`hunch review --confirm ${c!.id} --severity blocking`), "the response names the exact human command");
  } finally { s.cleanup(); }
});

test("an MCP-minted token cannot mint a human_confirmed decision", async () => {
  const s = await setup();
  try {
    const out = await s.call("hunch_record_decision", {
      decision: { title: "sessions are JWT", topic: "auth.session", decision: "JWT only" },
      capture_token: await s.token(),
    });
    const [d] = readAll<Decision>(s.root, "decisions");
    assert.equal(d!.provenance.source, "agent_recorded");
    assert.ok(d!.provenance.confidence < 0.8, "testimony stays below the strict-confidence bar");
    assert.match(out, new RegExp(`hunch review --confirm ${d!.id}`));
  } finally { s.cleanup(); }
});

test("an unconfirmed tokened write cannot displace another agent's testimony from its id slot", async () => {
  const s = await setup();
  try {
    await s.call("hunch_record_decision", { decision: { title: "How caching works", decision: "Testimony.", topic: "cache.policy" } });
    const out = await s.call("hunch_record_decision", {
      decision: { title: "How caching works", decision: "Replacement.", topic: "cache.strategy" },
      capture_token: await s.token(),
    });
    assert.match(out, /Refusing to overwrite/i, "only a human-confirmed write may take a slot held by testimony");
    const [d] = readAll<Decision>(s.root, "decisions");
    assert.equal(d!.decision, "Testimony.");
  } finally { s.cleanup(); }
});

test("a human who DECLINES (or does not check the box) in the client UI leaves a decision as testimony", async () => {
  for (const answer of [{ action: "decline" }, { action: "cancel" }, { action: "accept", content: { confirm: false } }] as ElicitResult[]) {
    const s = await setup(answer);
    try {
      await s.call("hunch_record_decision", {
        decision: { title: "sessions are JWT", topic: "auth.session", decision: "JWT only" },
        capture_token: await s.token(),
      });
      assert.equal(s.elicited.length, 1, "the human was asked");
      const [d] = readAll<Decision>(s.root, "decisions");
      assert.equal(d!.provenance.source, "agent_recorded", `answer ${JSON.stringify(answer)} must not confirm`);
    } finally { s.cleanup(); }
  }
});

test("a human confirmation answered in the client UI (elicitation) earns human_confirmed for a decision", async () => {
  const s = await setup({ action: "accept", content: { confirm: true } });
  try {
    await s.call("hunch_record_decision", {
      decision: { title: "sessions are JWT", topic: "auth.session", decision: "JWT only" },
      capture_token: await s.token(),
    });
    assert.equal(s.elicited.length, 1);
    assert.match(s.elicited[0]!, /sessions are JWT/, "the human sees exactly what they are confirming");
    const [d] = readAll<Decision>(s.root, "decisions");
    assert.equal(d!.provenance.source, "human_confirmed");
    assert.equal(d!.provenance.confidence, 0.95);
  } finally { s.cleanup(); }
});

test("an in-client confirmation never grants a correction blocking authority: only `hunch review --confirm` does", async () => {
  // Hosts can auto-answer elicitation (hooks, SDK handlers), and a blocking rule denies
  // every matching edit — so corrections are never elicited, even on a client that
  // supports it and would accept.
  const s = await setup({ action: "accept", content: { confirm: true } });
  try {
    const out = await s.call("hunch_record_correction", { rule: "never call the metered API from here", scope_hint_file: "src/pay.ts", severity: "blocking", capture_token: await s.token() });
    assert.equal(s.elicited.length, 0, "no prompt the human's answer could not act on");
    const [c] = readAll<Constraint>(s.root, "constraints");
    assert.equal(c!.provenance.source, "agent_recorded");
    assert.equal(c!.severity, "warning");
    assert.equal(isStrictBlocker(c!, false), false);
    assert.match(out, new RegExp(`hunch review --confirm ${c!.id} --severity blocking`));
  } finally { s.cleanup(); }
});

test("an un-tokened write never prompts the human (no elicitation spam) and stays testimony", async () => {
  const s = await setup({ action: "accept", content: { confirm: true } });
  try {
    await s.call("hunch_record_correction", { rule: "never import lodash here", scope_hint_file: "src/util.ts", severity: "blocking" });
    assert.equal(s.elicited.length, 0);
    const [c] = readAll<Constraint>(s.root, "constraints");
    assert.equal(c!.provenance.source, "agent_recorded");
  } finally { s.cleanup(); }
});

test("hunch review --confirm: a human countersigns a correction (granting severity) and a decision (keeping status)", async () => {
  const s = await setup();
  const run = (...args: string[]) => spawnSync(process.execPath, [tsx, cli, ...args], {
    cwd: s.root, encoding: "utf8", env: { ...process.env, HUNCH_PRIVATE_DIR: "", HUNCH_SYNTH_PROVIDER: "deterministic" },
  });
  try {
    await s.call("hunch_record_correction", { rule: "never call the metered API from here", scope_hint_file: "src/pay.ts", severity: "blocking", capture_token: await s.token() });
    await s.call("hunch_record_decision", {
      decision: { title: "move to a queue", topic: "jobs.queue", decision: "adopt a queue", status: "proposed" },
      capture_token: await s.token(),
    });
    const [c0] = readAll<Constraint>(s.root, "constraints");
    const [d0] = readAll<Decision>(s.root, "decisions");
    assert.equal(c0!.provenance.source, "agent_recorded", "precondition");
    assert.equal(d0!.provenance.source, "agent_recorded", "precondition");

    const rc = run("review", "--confirm", c0!.id, "--severity", "blocking");
    assert.equal(rc.status, 0, `${rc.stdout}${rc.stderr}`);
    const [c1] = readAll<Constraint>(s.root, "constraints");
    assert.equal(c1!.provenance.source, "human_confirmed");
    assert.equal(c1!.severity, "blocking");
    assert.equal(isStrictBlocker(c1!, false), true);
    assert.equal(c1!.statement, c0!.statement, "content is untouched — only the signature and granted severity change");

    const rd = run("review", "--confirm", d0!.id);
    assert.equal(rd.status, 0, `${rd.stdout}${rd.stderr}`);
    const [d1] = readAll<Decision>(s.root, "decisions");
    assert.equal(d1!.provenance.source, "human_confirmed");
    assert.equal(d1!.provenance.confidence, 0.95);
    assert.equal(d1!.status, "proposed", "confirming is not shipping: status is unchanged");

    const bad = run("review", "--confirm", d0!.id, "--severity", "blocking");
    assert.notEqual(bad.status, 0, "--severity applies only to a constraint");
  } finally { s.cleanup(); }
});
