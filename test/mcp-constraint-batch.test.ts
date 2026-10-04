import { test, type TestContext } from "node:test";
import assert from "node:assert/strict";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";
import { buildServer } from "../src/mcp/server.js";
import { mkConstraint, tempStore } from "./helpers.js";

const AUTH = "src/auth/session.ts";
const EMPTY = "src/ui/view.ts";
const STATEMENT = "Keep the full session invariant.\n" + "Complete rule detail. ".repeat(100);

const text = (result: Awaited<ReturnType<Client["callTool"]>>): string =>
  (result.content as Array<{ type: string; text?: string }>).map((c) => c.text ?? "").join("\n");

async function fixture(t: TestContext) {
  const { store, root, cleanup } = tempStore();
  const blocking = mkConstraint({
    id: "con_batch_blocking", severity: "blocking", statement: STATEMENT,
    rationale: "Preserve every session check.\nIncluding this rationale detail.",
    provenance: { source: "human_confirmed", confidence: 1, evidence: [], last_verified: "2026-10-05T00:00:00Z" },
  });
  const warning = mkConstraint({
    id: "con_batch_warning", statement: "Keep the warning statement.", rationale: "Warning rationale.",
  });
  store.json.put("constraints", warning);
  store.json.put("constraints", blocking);
  const server = buildServer(root);
  const [ct, st] = InMemoryTransport.createLinkedPair();
  const client = new Client({ name: "constraint-batch-test", version: "1" });
  t.after(async () => {
    try { await client.close(); } finally {
      try { await server.close(); } finally { cleanup(); }
    }
  });
  await Promise.all([server.connect(st), client.connect(ct)]);
  const call = (scope: unknown) => client.callTool({ name: "hunch_check_constraints", arguments: { scope } });
  const successful = async (scope: unknown): Promise<string> => {
    const result = await call(scope);
    assert.ok(!result.isError, text(result));
    return text(result);
  };
  return { store, blocking, client, call, successful };
}

test("batch mixed exact paths equals complete individual string results in input order", async (t) => {
  const { successful } = await fixture(t);
  const empty = await successful(EMPTY);
  const constrained = await successful(AUTH);
  assert.equal(empty, `No constraints in scope "${EMPTY}".`);
  assert.match(constrained, /^Constraints affecting "src\/auth\/session\.ts":/);
  assert.equal(await successful([EMPTY, AUTH]), [empty, constrained].join("\n\n"));
});

test("legacy string calls preserve empty scope and complete severity-ordered text", async (t) => {
  const { successful, blocking } = await fixture(t);
  assert.equal(await successful(""), 'No constraints in scope "".');
  assert.equal(await successful(AUTH),
    `Constraints affecting "${AUTH}":\n\n• con_batch_blocking [blocking/advisory_v1] ${STATEMENT}\n    rationale: ${blocking.rationale}\n      ⟨human_confirmed, confidence 1, verified 2026-10-05⟩\n• con_batch_warning [warning/advisory_v1] Keep the warning statement.\n    rationale: Warning rationale.\n      ⟨human_confirmed, confidence 1⟩`);
});

test("overlapping glob and exact scope each retain all their rules", async (t) => {
  const { successful } = await fixture(t);
  const scopes = [AUTH, "src/auth/**"];
  const individual = await Promise.all(scopes.map(successful));
  const batch = await successful(scopes);
  assert.equal(batch, individual.join("\n\n"));
  assert.equal(batch.split("• con_batch_blocking").length - 1, 2);
  assert.equal(batch.split("• con_batch_warning").length - 1, 2);
});

test("only exact duplicate scopes are removed, preserving original spelling and order", async (t) => {
  const { successful } = await fixture(t);
  const scopes = [EMPTY, AUTH, "./src/auth/session.ts", " src/auth/session.ts "];
  const individual = await Promise.all(scopes.map(successful));
  assert.equal(await successful([EMPTY, AUTH, EMPTY, scopes[2], AUTH, scopes[3]]), individual.join("\n\n"));
});

test("a batch accepts the maximum of 16 scopes", async (t) => {
  const { successful } = await fixture(t);
  const scopes = [AUTH, ...Array.from({ length: 15 }, (_, i) => `src/ui/view-${i}.ts`)];
  const individual = await Promise.all(scopes.map(successful));
  assert.equal(await successful(scopes), individual.join("\n\n"));
});

test("invalid batches reject entirely through native MCP argument validation", async (t) => {
  const { call } = await fixture(t);
  const invalid = [
    [], Array.from({ length: 17 }, () => AUTH), [AUTH, 7], [AUTH, null],
    [AUTH, {}], [AUTH, ["src/auth/**"]], [AUTH, ""], [AUTH, " \t\n"],
  ];
  for (const scope of invalid) {
    const result = await call(scope);
    assert.equal(result.isError, true, JSON.stringify(scope));
    assert.match(text(result), /MCP error -32602:.*Invalid arguments/s);
    assert.doesNotMatch(text(result), /Constraints affecting|No constraints in scope|con_batch_blocking/);
  }
});

test("batch returns every matching rule without clipping", async (t) => {
  const { store, successful } = await fixture(t);
  for (let i = 0; i < 20; i++) {
    store.json.put("constraints", mkConstraint({
      id: `con_batch_extra_${i}`, statement: `Complete extra statement ${i}.`, rationale: `Extra rationale ${i}.`,
    }));
  }
  const individual = await successful(AUTH);
  const batch = await successful([AUTH, "src/auth/**"]);
  assert.equal(batch, [individual, await successful("src/auth/**")].join("\n\n"));
  for (let i = 0; i < 20; i++) {
    assert.ok(individual.includes(`Complete extra statement ${i}.\n    rationale: Extra rationale ${i}.`));
  }
});

test("a later batch reads the latest complete constraint after a real store write", async (t) => {
  const { store, blocking, successful } = await fixture(t);
  const scopes = [EMPTY, AUTH];
  const first = await successful(scopes);
  const statement = "Updated full session invariant.\n" + "New complete rule detail. ".repeat(120);
  store.json.put("constraints", { ...blocking, statement, rationale: "Updated complete rationale." });
  const second = await successful(scopes);
  assert.notEqual(second, first);
  assert.ok(second.includes(statement + "\n    rationale: Updated complete rationale."));
  assert.ok(!second.includes(STATEMENT));
  assert.equal(second, [await successful(EMPTY), await successful(AUTH)].join("\n\n"));
});

test("listed tool advertises bounded path and glob batching", async (t) => {
  const { client } = await fixture(t);
  const tool = (await client.listTools()).tools.find((tool) => tool.name === "hunch_check_constraints");
  assert.ok(tool);
  assert.match(tool.description ?? "", /array.*16/);
  const scope = tool.inputSchema.properties?.scope as { description?: string };
  assert.match(scope.description ?? "", /array.*16/);
});
