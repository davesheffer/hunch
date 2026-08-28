import { test } from "node:test";
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { mkdtempSync, mkdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";
import { hunchPaths } from "../src/core/paths.js";
import { resourceId, resourceRelationshipId } from "../src/core/ids.js";
import { servedSummary } from "../src/core/served.js";
import { EdgeSchema, ResourceSchema } from "../src/core/types.js";
import { buildServer } from "../src/mcp/server.js";
import { HunchStore } from "../src/store/hunchStore.js";

function mcpDeliveryFixture(): string {
  const root = mkdtempSync(join(tmpdir(), "hunch-mcp-delivery-"));
  mkdirSync(join(root, "src"), { recursive: true });
  writeFileSync(join(root, "src", "context.ts"), "export const context = true;\n");
  writeFileSync(join(root, "src", "to-json-schema.ts"), [
    "export function toJSONSchema(value: unknown) { return resolveReferences(value); }",
    "export function resolveReferences(value: unknown) { // nested reference pointer and definitions assembly",
    "  return value;",
    "}",
  ].join("\n"));
  writeFileSync(join(root, "src", "hidden.ts"), [
    "export function applyBehaviorPolicy(value: unknown) { return value; }",
    "export function retainBehaviorCache(value: unknown) { return value; }",
  ].join("\n"));

  const store = new HunchStore(hunchPaths(root));
  store.json.ensureDirs();
  store.json.put("constraints", {
    id: "con_mcp_receipt",
    type: "architecture",
    statement: "MCP delivery metadata remains machine-readable.",
    scope: ["src/context.ts"],
    severity: "blocking",
    enforcement: "advisory_v1",
    match: null,
    forbids: null,
    rationale: "Orchestrators must not parse prose to recover receipts.",
    source_decision: null,
    violations: [],
    status: "active",
    valid_from: "2026-08-15T00:00:00.000Z",
    valid_to: null,
    provenance: { source: "human_confirmed", confidence: 1, evidence: [] },
  });
  store.reindex();
  store.close();
  return root;
}

function installReviewedLandscape(root: string): void {
  const store = new HunchStore(hunchPaths(root));
  const revision = "a".repeat(40);
  const reviewedAt = "2026-08-26T15:00:00.000Z";
  const candidateHash = `sha256:${"b".repeat(64)}`;
  const discoveryHash = `sha256:${"c".repeat(64)}`;
  const reviewId = `lr_${"d".repeat(24)}`;
  const repositoryId = resourceId("repository", "github.com/acme/payments");
  const apiId = resourceId("api", "openapi.yaml");
  const authority = {
    provenance: {
      source: "extracted:test+human_confirmed",
      confidence: 0.95,
      evidence: [`fixture.json#review@${revision}:${candidateHash}`],
      last_verified: reviewedAt,
    },
    currentness: {
      status: "current" as const,
      verified_at: reviewedAt,
      source_revision: revision,
      source_content_hash: candidateHash,
    },
    metadata: {
      discovery_authority: "human_confirmed",
      landscape_candidate_hash: candidateHash,
      landscape_discovery_hash: discoveryHash,
      landscape_review_id: reviewId,
      landscape_reviewed_by: "platform-team",
      landscape_reviewed_at: reviewedAt,
    },
  };
  for (const resource of [
    ResourceSchema.parse({
      schema: "hunch.resource/1",
      id: repositoryId,
      kind: "repository",
      name: "Payments repository",
      scope: [],
      locator: "github.com/acme/payments",
      lifecycle: "active",
      ...authority,
      created_at: reviewedAt,
      updated_at: reviewedAt,
    }),
    ResourceSchema.parse({
      schema: "hunch.resource/1",
      id: apiId,
      kind: "api",
      name: "Payments API",
      scope: [repositoryId],
      locator: "openapi.yaml",
      lifecycle: "active",
      ...authority,
      created_at: reviewedAt,
      updated_at: reviewedAt,
    }),
  ]) store.json.put("resources", resource);
  store.json.put("edges", EdgeSchema.parse({
    schema: "hunch.resource-relationship/1",
    id: resourceRelationshipId(repositoryId, apiId, "contains"),
    from: repositoryId,
    to: apiId,
    type: "contains",
    reason: "reviewed API declaration",
    strength: 0.95,
    environment: null,
    ...authority,
  }));
  store.reindex();
  store.close();
}

test("hunch_context exposes the delivery envelope and records exactly what MCP served", async (t) => {
  const root = mcpDeliveryFixture();
  const server = buildServer(root);
  const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
  const client = new Client({ name: "mcp-delivery-test", version: "1.0.0" });
  await Promise.all([server.connect(serverTransport), client.connect(clientTransport)]);
  t.after(async () => {
    await client.close().catch(() => {});
    await server.close().catch(() => {});
    rmSync(root, { recursive: true, force: true });
  });

  const listed = await client.listTools();
  const contextTool = listed.tools.find((tool) => tool.name === "hunch_context");
  assert.ok(contextTool?.outputSchema, "tools/list advertises the structured delivery contract");
  assert.ok("delivered" in (contextTool.outputSchema.properties ?? {}));

  const result = await client.callTool({
    name: "hunch_context",
    arguments: { target: "src/context.ts", budget_tokens: 400 },
  });
  const structured = result.structuredContent as {
    text: string;
    profile: string;
    ranking_policy: string;
    delivered: Array<{
      kind: string;
      record_id: string;
      rank: number;
      delivery_reason: string;
      provenance_status: string;
      token_cost: number;
    }>;
    hypotheses: unknown[];
    obligations: unknown[];
    omitted: unknown[];
    budget_tokens: number;
    used_chars: number;
    blocking_overflow: boolean;
    abstention: { active: boolean; withheld: number; retry_hint: string | null };
  };
  const text = (result.content as Array<{ type: string; text?: string }>).map((item) => item.text ?? "").join("\n");

  assert.equal(text, structured.text, "legacy text and structured envelope describe the same delivery");
  assert.equal(structured.profile, "builder");
  assert.equal(structured.ranking_policy, "hunch.delivery-profile/1");
  assert.deepEqual(structured.delivered, [{
    kind: "constraints",
    record_id: "con_mcp_receipt",
    rank: 1,
    delivery_reason: "blocking-reserved",
    provenance_status: "current",
    token_cost: structured.delivered[0]?.token_cost,
  }]);
  assert.ok((structured.delivered[0]?.token_cost ?? 0) > 0);
  assert.deepEqual(structured.hypotheses, []);
  assert.deepEqual(structured.obligations, []);
  assert.deepEqual(structured.omitted, []);
  assert.equal(structured.budget_tokens, 400);
  assert.equal(structured.used_chars, [...structured.text].length);
  assert.equal(structured.blocking_overflow, false);
  assert.deepEqual(structured.abstention, {
    active: false,
    withheld: 0,
    reasons: { "low-confidence": 0, "insufficient-context": 0, "low-relevance": 0 },
    retry_hint: null,
  });

  const receipts = servedSummary(root);
  assert.equal(receipts.total, 1);
  assert.deepEqual(receipts.recent[0], {
    at: receipts.recent[0]?.at,
    session_id: null,
    event: "served",
    kind: "constraints",
    record_id: "con_mcp_receipt",
    target: "src/context.ts",
    rank: 1,
    delivery_reason: "blocking-reserved",
    provenance_status: "current",
    token_cost: structured.delivered[0]?.token_cost,
    delivery_profile: "builder",
    ranking_policy: "hunch.delivery-profile/1",
  });
});

test("hunch_change_identity exposes the exact squash-stable contract without mutating memory", async (t) => {
  const root = mcpDeliveryFixture();
  const git = (...args: string[]) => execFileSync("git", ["-C", root, ...args], {
    encoding: "utf8",
    env: {
      ...process.env,
      GIT_AUTHOR_NAME: "Hunch test",
      GIT_AUTHOR_EMAIL: "hunch@example.test",
      GIT_COMMITTER_NAME: "Hunch test",
      GIT_COMMITTER_EMAIL: "hunch@example.test",
    },
  }).trim();
  git("init", "-q", "-b", "main");
  git("add", "src");
  git("commit", "-qm", "base");
  const base = git("rev-parse", "HEAD");
  writeFileSync(join(root, "src", "context.ts"), "export const context = 'changed';\n");
  git("add", "src/context.ts");
  git("commit", "-qm", "change");

  const server = buildServer(root);
  const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
  const client = new Client({ name: "mcp-change-identity-test", version: "1.0.0" });
  await Promise.all([server.connect(serverTransport), client.connect(clientTransport)]);
  t.after(async () => {
    await client.close().catch(() => {});
    await server.close().catch(() => {});
    rmSync(root, { recursive: true, force: true });
  });

  const tool = (await client.listTools()).tools.find((candidate) => candidate.name === "hunch_change_identity");
  assert.ok(tool?.outputSchema, "tools/list advertises the sealed change identity");
  const result = await client.callTool({ name: "hunch_change_identity", arguments: { base_ref: base } });
  const identity = result.structuredContent as Record<string, unknown>;
  assert.equal(identity.schema, "hunch.change-identity/1");
  assert.equal(identity.algorithm, "git-raw-tree-delta-sha256/1");
  assert.match(String(identity.change_id), /^hchg_[a-f0-9]{24}$/);
  assert.match(String(identity.content_hash), /^sha256:[a-f0-9]{64}$/);
  assert.equal(identity.file_count, 1);
  assert.equal(servedSummary(root).total, 0, "read-only identity derivation never manufactures a delivery receipt");
});

test("hunch_context delivers a reviewed landscape fragment for a plain-English task", async (t) => {
  const root = mcpDeliveryFixture();
  installReviewedLandscape(root);
  const server = buildServer(root);
  const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
  const client = new Client({ name: "mcp-landscape-delivery-test", version: "1.0.0" });
  await Promise.all([server.connect(serverTransport), client.connect(clientTransport)]);
  t.after(async () => {
    await client.close().catch(() => {});
    await server.close().catch(() => {});
    rmSync(root, { recursive: true, force: true });
  });

  const listed = await client.listTools();
  const outputProperties = listed.tools.find((tool) => tool.name === "hunch_context")?.outputSchema?.properties ?? {};
  assert.ok("landscape" in outputProperties, "tools/list advertises the reviewed landscape fragment");
  assert.ok("receipt_id" in outputProperties, "tools/list advertises the exact delivery receipt");

  const result = await client.callTool({
    name: "hunch_context",
    arguments: { target: "payments api", budget_tokens: 1_500 },
  });
  const structured = result.structuredContent as {
    schema_version: string;
    receipt_id: string;
    text: string;
    delivered: Array<{ kind: string; record_id: string }>;
    landscape: {
      schema: string;
      authority: string;
      resources: Array<{ record: { id: string }; required: boolean; blocking: boolean }>;
      relationships: Array<{ record: { from: string; to: string } }>;
      reviewIds: string[];
      discoveryHashes: string[];
      sourceRevisions: string[];
      fragmentHash: string;
    } | null;
    accounted_chars: number;
    budget_tokens: number;
  };

  assert.equal(structured.schema_version, "hunch.delivery-envelope/1");
  assert.match(structured.receipt_id, /^hdr_[a-f0-9]{24}$/);
  assert.doesNotMatch(structured.text, /closest graph matches/i, "reviewed landscape context is not replaced by search fallback");
  assert.equal(structured.landscape?.schema, "hunch.landscape-fragment/1");
  assert.equal(structured.landscape?.authority, "human_confirmed");
  assert.deepEqual(structured.landscape?.resources.map((item) => item.record.id), [
    resourceId("api", "openapi.yaml"),
    resourceId("repository", "github.com/acme/payments"),
  ]);
  assert.ok(structured.landscape?.resources.every((item) => item.required === false && item.blocking === false));
  assert.equal(structured.landscape?.relationships.length, 1);
  assert.match(structured.landscape?.fragmentHash ?? "", /^sha256:[a-f0-9]{64}$/);
  assert.ok(structured.accounted_chars <= structured.budget_tokens * 4);

  const receipts = servedSummary(root);
  assert.equal(receipts.total, 3);
  assert.deepEqual(new Set(receipts.recent.map((item) => item.kind)), new Set(["resources", "relationships"]));
});

test("hunch_shortlist exposes an opt-in bounded diagnostic with no exact-owner claim", async (t) => {
  const root = mcpDeliveryFixture();
  const server = buildServer(root);
  const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
  const client = new Client({ name: "mcp-shortlist-test", version: "1.0.0" });
  await Promise.all([server.connect(serverTransport), client.connect(clientTransport)]);
  t.after(async () => {
    await client.close().catch(() => {});
    await server.close().catch(() => {});
    rmSync(root, { recursive: true, force: true });
  });

  const listed = await client.listTools();
  const shortlistTool = listed.tools.find((tool) => tool.name === "hunch_shortlist");
  assert.ok(shortlistTool, "tools/list advertises the diagnostic");
  assert.match(shortlistTool.description ?? "", /never claims an exact implementation owner/i);
  assert.match(shortlistTool.description ?? "", /hierarchical inspection view/i);
  assert.match(shortlistTool.description ?? "", /progressive inspection queue/i);

  const issue = "toJSONSchema(value) emits a $ref whose nested reference pointer is missing from $defs; reference resolution must assemble definitions.";
  const result = await client.callTool({
    name: "hunch_shortlist",
    arguments: {
      issue,
      limit: 3,
    },
  });
  const text = (result.content as Array<{ type: string; text?: string }>).map((item) => item.text ?? "").join("\n");
  assert.match(text, /Stage: schema-emission/);
  assert.match(text, /Likely file: src\/to-json-schema\.ts/);
  assert.match(text, /src\/to-json-schema\.ts::resolveReferences/);
  assert.doesNotMatch(text, /src\/to-json-schema\.ts::toJSONSchema/);
  assert.match(text, /exact-owner claims are disabled/i);
  assert.match(text, /File-cluster receipt: [a-f0-9]{24}/);
  assert.match(text, /Progressive-plan receipt: [a-f0-9]{24}/);
  assert.match(text, /preserved union 6\/12.*\+25 points/i);

  const optimizedResult = await client.callTool({
    name: "hunch_shortlist",
    arguments: {
      issue,
      limit: 3,
      evidence: {
        version: 1,
        claim: issue,
        probe: { target_before: "red", control_before: "green" },
        execution: [],
        interventions: [{
          owner: "src/hidden.ts::applyBehaviorPolicy",
          target_after: "green",
          control_after: "green",
        }],
      },
    },
  });
  const optimizedText = (optimizedResult.content as Array<{ type: string; text?: string }>).map((item) => item.text ?? "").join("\n");
  assert.match(optimizedText, /Optimization: not applied.*transfer-rejected-read-only/);
  assert.match(optimizedText, /Optimization receipt: [a-f0-9]{24}/);
  assert.match(optimizedText, /Promoted by evidence: none/);
  assert.match(optimizedText, /rejected evidence and causal-owner rerankers/i);
  assert.match(optimizedText, /exact-owner claims are disabled/i);
});

test("hunch_evidence_map compiles supplied observations without claiming ownership", async (t) => {
  const root = mcpDeliveryFixture();
  const server = buildServer(root);
  const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
  const client = new Client({ name: "mcp-evidence-map-test", version: "1.0.0" });
  await Promise.all([server.connect(serverTransport), client.connect(clientTransport)]);
  t.after(async () => {
    await client.close().catch(() => {});
    await server.close().catch(() => {});
    rmSync(root, { recursive: true, force: true });
  });

  const listed = await client.listTools();
  const tool = listed.tools.find((candidate) => candidate.name === "hunch_evidence_map");
  assert.ok(tool, "tools/list advertises the evidence-map compiler");
  assert.match(tool.description ?? "", /executes no code/i);
  assert.match(tool.description ?? "", /never converts behavioral influence into an exact correction-owner claim/i);

  const result = await client.callTool({
    name: "hunch_evidence_map",
    arguments: {
      version: 1,
      claim: "Reference assembly must preserve escaped identifiers.",
      probe: { target_before: "red", control_before: "green", target_after: "green", control_after: "green" },
      execution: [
        { owner: "src/to-json-schema.ts::resolveReferences", target_count: 2, control_count: 0 },
        { owner: "src/to-json-schema.ts::toJSONSchema", target_count: 2, control_count: 2 },
      ],
      interventions: [
        { owner: "src/to-json-schema.ts::resolveReferences", mutation_id: "flip-branch", target_after: "green", control_after: "green" },
      ],
    },
  });
  const text = (result.content as Array<{ type: string; text?: string }>).map((item) => item.text ?? "").join("\n");
  assert.match(text, /Probe authentication: authenticated/);
  assert.match(text, /src\/to-json-schema\.ts::resolveReferences/);
  assert.match(text, /Behavior-sensitive files:\n  - src\/to-json-schema\.ts/);
  assert.match(text, /Exact-owner claim: disabled/);
  assert.match(text, /did not run code or mutate/);
});
