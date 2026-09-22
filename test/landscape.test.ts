import { cleanupDir } from "./fixtures.js";
import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { resourceId, resourceRelationshipId } from "../src/core/ids.js";
import { migrateRaw, SCHEMA_VERSION } from "../src/core/migrate.js";
import { hunchPaths } from "../src/core/paths.js";
import {
  EdgeSchema,
  RESOURCE_RELATIONSHIP_SCHEMA_VERSION,
  RESOURCE_SCHEMA_VERSION,
  ResourceSchema,
  type Edge,
  type Resource,
} from "../src/core/types.js";
import { HunchStore } from "../src/store/hunchStore.js";
import { prov, tempStore } from "./helpers.js";

const NOW = "2026-08-21T00:00:00.000Z";

function resource(kind: string, key: string, name: string, over: Partial<Resource> = {}): Resource {
  return ResourceSchema.parse({
    schema: RESOURCE_SCHEMA_VERSION,
    id: resourceId(kind, key),
    kind,
    name,
    scope: ["repository:github.com/acme/payments-api"],
    locator: key.includes(".") ? `https://${key}` : null,
    lifecycle: "active",
    provenance: prov(0.95),
    currentness: { status: "current", verified_at: NOW, source_revision: "abc123" },
    metadata: {},
    created_at: NOW,
    updated_at: NOW,
    ...over,
  });
}

function relationship(from: Resource, to: Resource, type: Edge["type"]): Edge {
  return EdgeSchema.parse({
    schema: RESOURCE_RELATIONSHIP_SCHEMA_VERSION,
    id: resourceRelationshipId(from.id, to.id, type),
    from: from.id,
    to: to.id,
    type,
    reason: `${from.name} ${type} ${to.name}`,
    strength: 1,
    provenance: prov(0.95),
    currentness: { status: "current", verified_at: NOW, source_revision: "abc123" },
    environment: null,
    metadata: {},
  });
}

test("HLG-1 resource and relationship identities are canonical and deterministic", () => {
  assert.equal(
    resourceId("Repository", " github.com/acme/payments-api/ "),
    "repository:github.com/acme/payments-api",
  );
  const from = resourceId("repository", "github.com/acme/payments-api");
  const to = resourceId("service", "payments-api");
  assert.equal(
    resourceRelationshipId(from, to, "implements"),
    resourceRelationshipId(from, to, "implements"),
  );
  assert.notEqual(
    resourceRelationshipId(from, to, "implements"),
    resourceRelationshipId(to, from, "implements"),
    "direction is part of relationship identity",
  );
});

test("HLG-1 rejects malformed identities, runtime claims, and credential material at the write schema", () => {
  const base = resource("service", "payments-api", "Payments API");
  assert.throws(() => ResourceSchema.parse({ ...base, id: "service:payments-api/" }), /canonical kind-qualified/i);
  assert.throws(() => ResourceSchema.parse({ ...base, id: "service:" }), /canonical kind-qualified/i);
  assert.throws(() => ResourceSchema.parse({ ...base, locator: "postgres://user:password@db.internal/payments" }), /credential/i);
  assert.throws(() => ResourceSchema.parse({ ...base, metadata: { api_key: "abcd1234" } }), /credential/i);
  assert.throws(() => ResourceSchema.parse({
    ...base,
    provenance: { ...base.provenance, evidence: ["Authorization: Bearer abcdefghijklmnop"] },
  }), /credential/i);
  assert.throws(() => ResourceSchema.parse({
    ...base,
    currentness: { status: "current" },
  }), /requires a verification timestamp/i);
  assert.throws(() => ResourceSchema.parse({ ...base, health: "healthy" }), /unrecognized key/i,
    "durable Hunch resources cannot acquire an ORC-owned live-health field");

  const target = resource("api", "payments/v1", "Payments API v1");
  const valid = relationship(base, target, "exposes");
  assert.throws(() => EdgeSchema.parse({ ...valid, id: "edge_wrong" }), /deterministic/i);
  assert.throws(() => EdgeSchema.parse({
    ...valid,
    from: "Service:payments-api",
    id: resourceRelationshipId("Service:payments-api", valid.to, valid.type),
  }), /kind-qualified/i);
  assert.throws(() => EdgeSchema.parse({ ...valid, currentness: undefined }), /currentness/i);
  assert.throws(() => EdgeSchema.parse({ ...valid, metadata: { access_token: "abcd1234" } }), /credential/i);
  assert.throws(() => EdgeSchema.parse({ ...valid, health: "healthy" }), /unrecognized key/i);
  assert.throws(() => EdgeSchema.parse({
    ...valid,
    provenance: { ...valid.provenance, evidence: ["password=hunter2"] },
  }), /credential/i);
});

test("schema v2 legacy edges forward-migrate before validation without becoming resource relationships", () => {
  const legacy = {
    id: "edge_legacy", from: "sym_a", to: "sym_b", type: "calls", reason: "a calls b",
    strength: 1, provenance: prov(),
  };
  const migrated = migrateRaw("edges", legacy, 2) as Record<string, unknown>;
  assert.equal(SCHEMA_VERSION, 3);
  assert.equal(migrated.schema, "hunch.edge/1");
  assert.equal(migrated.environment, null);
  assert.deepEqual(migrated.metadata, {});
  assert.equal(EdgeSchema.parse(migrated).type, "calls");
});

test("repository-local landscape chain round-trips through JSON and rebuilds the derived index", () => {
  const { store, cleanup } = tempStore();
  try {
    const product = resource("product", "commerce", "Commerce", { scope: ["product:commerce"] });
    const capability = resource("capability", "payments", "Payments", { scope: [product.id] });
    const repository = resource("repository", "github.com/acme/payments-api", "Payments repository");
    const service = resource("service", "payments-api", "Payments service");
    const api = resource("api", "payments/v1", "Payments API v1", { contract_version: "v1" });
    const database = resource("database", "payments", "Payments database");
    const external = resource("repository", "github.com/acme/identity-sdk", "Identity SDK", {
      scope: ["repository:github.com/acme/payments-api"],
    });
    const resources = [product, capability, repository, service, api, database, external];
    const edges = [
      relationship(capability, product, "belongs_to"),
      relationship(repository, capability, "implements"),
      relationship(service, repository, "implemented_by"),
      relationship(service, api, "exposes"),
      relationship(service, database, "writes_to"),
      relationship(repository, external, "depends_on"),
    ];

    store.json.replaceAll("resources", resources);
    store.json.replaceAll("edges", edges);
    const first = store.json.loadAll("resources");
    assert.deepEqual(first.map((item) => item.id), [...resources].sort((a, b) => a.id.localeCompare(b.id)).map((item) => item.id));

    const { counts } = store.reindex();
    assert.equal(counts.resources, resources.length);
    assert.equal(counts.edges, edges.length);
    assert.equal((store.db.prepare("SELECT count(*) AS n FROM resources").get() as { n: number }).n, resources.length);
    assert.equal((store.db.prepare("SELECT count(*) AS n FROM resource_relationships").get() as { n: number }).n, edges.length);
    assert.ok(store.search("Payments API").some((hit) => hit.ref === api.id));

    store.close();
    const restarted = new HunchStore(hunchPaths(store.publicRoot));
    try {
      restarted.reindex();
      assert.deepEqual(restarted.json.loadAll("resources"), first, "restart preserves exact resource identities and provenance");
      assert.equal((restarted.db.prepare("SELECT count(*) AS n FROM resource_relationships").get() as { n: number }).n, edges.length);
    } finally {
      restarted.close();
    }
  } finally {
    cleanup();
  }
});

test("resources preserve the public/private single-source boundary while the derived view unions both", () => {
  const base = mkdtempSync(join(tmpdir(), "hunch-landscape-overlay-"));
  const publicRoot = join(base, "public");
  const privateHunch = join(base, "private-memory");
  mkdirSync(publicRoot, { recursive: true });
  const previous = process.env.HUNCH_PRIVATE_DIR;
  process.env.HUNCH_PRIVATE_DIR = privateHunch;
  const store = new HunchStore(hunchPaths(publicRoot));
  try {
    store.json.ensureDirs();
    const publicResource = resource("repository", "github.com/acme/public", "Public repository");
    const privateResource = resource("system", "internal-payments", "Internal payments");
    store.putCapture("resources", publicResource);
    store.putCapture("resources", privateResource, true);

    assert.deepEqual(store.json.loadAll("resources").map((item) => item.id), [publicResource.id]);
    assert.deepEqual(store.recs("resources").map((item) => item.id).sort(), [privateResource.id, publicResource.id].sort());
    assert.equal(store.reindex().counts.resources, 2, "the local derived view sees both authorized homes");
  } finally {
    store.close();
    if (previous === undefined) delete process.env.HUNCH_PRIVATE_DIR;
    else process.env.HUNCH_PRIVATE_DIR = previous;
    cleanupDir(base);
  }
});
