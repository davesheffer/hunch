import assert from "node:assert/strict";
import { execFileSync, spawnSync } from "node:child_process";
import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import {
  planLandscapeAdoption,
} from "../src/core/landscapeAdoption.js";
import { resourceId, resourceRelationshipId } from "../src/core/ids.js";
import {
  EdgeSchema,
  ResourceSchema,
  type Edge,
  type Resource,
} from "../src/core/types.js";
import {
  LANDSCAPE_CANDIDATE_SCHEMA_VERSION,
  LANDSCAPE_DISCOVERY_SCHEMA_VERSION,
  landscapeContentHash,
  type LandscapeCandidate,
  type LandscapeDiscoveryIssue,
  type LandscapeDiscoveryResult,
} from "../src/extractors/landscapeDiscovery.js";

const revision = "a".repeat(40);
const timestamp = "2026-08-26T10:00:00.000Z";

function candidate<T extends Resource | Edge>(record: T): LandscapeCandidate<T> {
  const evidence = [{
    kind: "package_manifest" as const,
    sourcePath: "package.json",
    sourceField: "name",
    sourceRevision: revision,
    sourceContentHash: `sha256:${"b".repeat(64)}`,
  }];
  const unsigned = {
    schema: LANDSCAPE_CANDIDATE_SCHEMA_VERSION,
    authority: "candidate" as const,
    record,
    evidence,
  };
  return { ...unsigned, candidateHash: landscapeContentHash(unsigned) };
}

function fixture(issues: LandscapeDiscoveryIssue[] = []): LandscapeDiscoveryResult {
  const repository = ResourceSchema.parse({
    schema: "hunch.resource/1",
    id: resourceId("repository", "github.com/acme/payments"),
    kind: "repository",
    name: "Payments",
    scope: [],
    locator: "https://github.com/acme/payments",
    lifecycle: "active",
    provenance: { source: "extracted:repository-declaration", confidence: 0.8, evidence: ["package.json#repository"] },
    currentness: { status: "unverified", source_revision: revision },
    metadata: { discovery_authority: "candidate" },
    created_at: timestamp,
    updated_at: timestamp,
  });
  const api = ResourceSchema.parse({
    schema: "hunch.resource/1",
    id: resourceId("api", "openapi.yaml"),
    kind: "api",
    name: "openapi.yaml",
    scope: [repository.id],
    locator: "openapi.yaml",
    lifecycle: "active",
    provenance: { source: "extracted:api-declaration", confidence: 0.9, evidence: ["openapi.yaml"] },
    currentness: { status: "unverified", source_revision: revision },
    metadata: { discovery_authority: "candidate" },
    created_at: timestamp,
    updated_at: timestamp,
  });
  const relationship = EdgeSchema.parse({
    schema: "hunch.resource-relationship/1",
    id: resourceRelationshipId(repository.id, api.id, "contains"),
    from: repository.id,
    to: api.id,
    type: "contains",
    reason: "repository declares API",
    strength: 1,
    provenance: { source: "extracted:api-declaration", confidence: 0.9, evidence: ["openapi.yaml"] },
    currentness: { status: "unverified", source_revision: revision },
    environment: null,
    metadata: { discovery_authority: "candidate" },
  });
  const resources = [candidate(repository), candidate(api)].sort((left, right) => left.record.id.localeCompare(right.record.id));
  const relationships = [candidate(relationship)];
  const unsigned = {
    schema: LANDSCAPE_DISCOVERY_SCHEMA_VERSION,
    authority: "candidate" as const,
    sourceRevision: revision,
    repositoryRootIdentity: "github.com/acme/payments",
    resources,
    relationships,
    issues,
  };
  return { ...unsigned, discoveryHash: landscapeContentHash(unsigned) };
}

function fixtureAt(sourceRevision: string, createdAt: string): LandscapeDiscoveryResult {
  const discovery = structuredClone(fixture());
  for (const candidateValue of [...discovery.resources, ...discovery.relationships]) {
    candidateValue.record.currentness.source_revision = sourceRevision;
    for (const evidence of candidateValue.evidence) evidence.sourceRevision = sourceRevision;
    if (candidateValue.record.schema === "hunch.resource/1") {
      candidateValue.record.created_at = createdAt;
      candidateValue.record.updated_at = createdAt;
    }
    const { candidateHash: _candidateHash, ...unsignedCandidate } = candidateValue;
    candidateValue.candidateHash = landscapeContentHash(unsignedCandidate);
  }
  discovery.sourceRevision = sourceRevision;
  const { discoveryHash: _discoveryHash, ...unsignedDiscovery } = discovery;
  discovery.discoveryHash = landscapeContentHash(unsignedDiscovery);
  return discovery;
}

test("HLG-2 review adopts an exact candidate fragment and is idempotent against its reviewed records", () => {
  const discovery = fixture();
  const first = planLandscapeAdoption({
    discovery,
    expectedDiscoveryHash: discovery.discoveryHash,
    reviewer: "platform-team",
    reviewedAt: "2026-08-26T11:00:00.000Z",
    candidateHashes: "all",
  });

  assert.equal(first.receipt.schema, "hunch.landscape-adoption-receipt/1");
  assert.equal(first.receipt.authority, "human_confirmed");
  assert.match(first.receipt.review.reviewId, /^lr_[a-f0-9]+$/);
  assert.match(first.receipt.receiptId, /^la_[a-f0-9]+$/);
  assert.equal(first.resourcesToWrite.length, 2);
  assert.equal(first.relationshipsToWrite.length, 1);
  assert.ok(first.resourcesToWrite.every((record) => record.metadata.discovery_authority === "human_confirmed"));
  assert.ok(first.resourcesToWrite.every((record) => record.provenance.source.endsWith("+human_confirmed")));
  assert.ok(first.relationshipsToWrite.every((record) => record.metadata.landscape_review_id === first.receipt.review.reviewId));

  const retry = planLandscapeAdoption({
    discovery,
    expectedDiscoveryHash: discovery.discoveryHash,
    reviewer: "platform-team",
    reviewedAt: "2026-08-26T11:00:00.000Z",
    candidateHashes: "all",
    existingResources: first.resourcesToWrite,
    existingRelationships: first.relationshipsToWrite,
  });
  assert.deepEqual(retry.resourcesToWrite, []);
  assert.deepEqual(retry.relationshipsToWrite, []);
  assert.deepEqual(retry.receipt.reusedResourceIds, first.receipt.acceptedResourceIds);
  assert.deepEqual(retry.receipt.reusedRelationshipIds, first.receipt.acceptedRelationshipIds);
});

test("HLG-2 reviewed refresh replaces only byte-proven records from an older exact revision", () => {
  const previous = fixtureAt("a".repeat(40), "2026-08-26T10:00:00.000Z");
  const first = planLandscapeAdoption({
    discovery: previous,
    expectedDiscoveryHash: previous.discoveryHash,
    reviewer: "platform-team",
    reviewedAt: "2026-08-26T11:00:00.000Z",
    candidateHashes: "all",
  });
  const current = fixtureAt("c".repeat(40), "2026-08-27T10:00:00.000Z");
  const refreshInput = {
    discovery: current,
    expectedDiscoveryHash: current.discoveryHash,
    reviewer: "platform-team",
    reviewedAt: "2026-08-27T11:00:00.000Z",
    candidateHashes: "all" as const,
    existingResources: first.resourcesToWrite,
    existingRelationships: first.relationshipsToWrite,
  };

  assert.throws(() => planLandscapeAdoption(refreshInput), /different reviewed content/);
  assert.throws(() => planLandscapeAdoption({
    ...refreshInput,
    refreshReviewed: true,
  }), /different reviewed content/, "metadata without the prior exact discovery is not replacement authority");
  assert.throws(() => planLandscapeAdoption({
    ...refreshInput,
    candidateHashes: [current.resources[0]!.candidateHash],
    refreshReviewed: true,
    previousDiscoveries: [previous],
  }), /complete candidate set/, "a partial selection cannot stand in for the prior full review");

  const refreshed = planLandscapeAdoption({
    ...refreshInput,
    refreshReviewed: true,
    previousDiscoveries: [previous],
  });
  assert.deepEqual(refreshed.refreshedResourceIds, first.receipt.acceptedResourceIds);
  assert.deepEqual(refreshed.refreshedRelationshipIds, first.receipt.acceptedRelationshipIds);
  assert.deepEqual(refreshed.receipt.reusedResourceIds, []);
  assert.deepEqual(refreshed.receipt.reusedRelationshipIds, []);
  assert.ok(refreshed.resourcesToWrite.every((record) => record.currentness.source_revision === current.sourceRevision));
  assert.ok(refreshed.relationshipsToWrite.every((record) => record.currentness.source_revision === current.sourceRevision));

  const retry = planLandscapeAdoption({
    discovery: current,
    expectedDiscoveryHash: current.discoveryHash,
    reviewer: "platform-team",
    reviewedAt: "2026-08-27T11:00:00.000Z",
    candidateHashes: "all",
    existingResources: refreshed.resourcesToWrite,
    existingRelationships: refreshed.relationshipsToWrite,
  });
  assert.deepEqual(retry.refreshedResourceIds, []);
  assert.deepEqual(retry.refreshedRelationshipIds, []);
  assert.deepEqual(retry.receipt.reusedResourceIds, refreshed.receipt.acceptedResourceIds);
  assert.deepEqual(retry.receipt.reusedRelationshipIds, refreshed.receipt.acceptedRelationshipIds);
});

test("HLG-2 reviewed refresh refuses tampered prior bytes and repository/revision proof substitution", () => {
  const previous = fixtureAt("a".repeat(40), "2026-08-26T10:00:00.000Z");
  const first = planLandscapeAdoption({
    discovery: previous,
    expectedDiscoveryHash: previous.discoveryHash,
    reviewer: "platform-team",
    reviewedAt: "2026-08-26T11:00:00.000Z",
    candidateHashes: "all",
  });
  const current = fixtureAt("c".repeat(40), "2026-08-27T10:00:00.000Z");
  const tampered = structuredClone(first.resourcesToWrite);
  tampered[0]!.name = "Human edit that retained adoption metadata";
  const input = {
    discovery: current,
    expectedDiscoveryHash: current.discoveryHash,
    reviewer: "platform-team",
    reviewedAt: "2026-08-27T11:00:00.000Z",
    candidateHashes: "all" as const,
    existingResources: tampered,
    existingRelationships: first.relationshipsToWrite,
    refreshReviewed: true,
  };
  assert.throws(() => planLandscapeAdoption({
    ...input,
    previousDiscoveries: [previous],
  }), /different reviewed content/);
  const forgedReview = structuredClone(first.resourcesToWrite);
  forgedReview[0]!.metadata.landscape_review_id = `lr_${"f".repeat(24)}`;
  assert.throws(() => planLandscapeAdoption({
    ...input,
    existingResources: forgedReview,
    previousDiscoveries: [previous],
  }), /different reviewed content/, "a plausible but non-replayable review id is not refresh authority");
  assert.throws(() => planLandscapeAdoption({
    ...input,
    existingResources: first.resourcesToWrite,
    previousDiscoveries: [current],
  }), /older exact discovery revision/);

  const foreign = structuredClone(previous);
  foreign.repositoryRootIdentity = "github.com/other/repository";
  const { discoveryHash: _discoveryHash, ...unsignedForeign } = foreign;
  foreign.discoveryHash = landscapeContentHash(unsignedForeign);
  assert.throws(() => planLandscapeAdoption({
    ...input,
    existingResources: first.resourcesToWrite,
    previousDiscoveries: [foreign],
  }), /different repository/);
});

test("HLG-2 review refuses stale hashes, partial relationships, silent issues, and graph overwrites", () => {
  const discovery = fixture();
  assert.throws(() => planLandscapeAdoption({
    discovery,
    expectedDiscoveryHash: `sha256:${"0".repeat(64)}`,
    reviewer: "platform-team",
    candidateHashes: "all",
  }), /changed after review/);

  assert.throws(() => planLandscapeAdoption({
    discovery,
    expectedDiscoveryHash: discovery.discoveryHash,
    reviewer: "platform-team",
    candidateHashes: [discovery.relationships[0]!.candidateHash],
  }), /requires both endpoint resource candidates/);

  const withIssues = fixture([{
    code: "repository_identity_conflict",
    sourcePath: "package.json",
    sourceField: "repository",
    detail: "two declarations disagree",
  }]);
  assert.throws(() => planLandscapeAdoption({
    discovery: withIssues,
    expectedDiscoveryHash: withIssues.discoveryHash,
    reviewer: "platform-team",
    candidateHashes: "all",
  }), /explicitly acknowledge/);
  const acknowledged = planLandscapeAdoption({
    discovery: withIssues,
    expectedDiscoveryHash: withIssues.discoveryHash,
    reviewer: "platform-team",
    reviewedAt: "2026-08-26T11:00:00.000Z",
    candidateHashes: "all",
    acknowledgeIssues: true,
  });
  assert.deepEqual(acknowledged.receipt.review.acknowledgedIssueCodes, ["repository_identity_conflict"]);

  const conflicting = ResourceSchema.parse({
    ...discovery.resources[0]!.record,
    name: "Human curated name",
    metadata: {},
  });
  assert.throws(() => planLandscapeAdoption({
    discovery,
    expectedDiscoveryHash: discovery.discoveryHash,
    reviewer: "platform-team",
    candidateHashes: [discovery.resources[0]!.candidateHash],
    existingResources: [conflicting],
  }), /different reviewed content/);
});

test("HLG-2 review verifies candidate and discovery content before granting authority", () => {
  const discovery = fixture();
  const tampered = structuredClone(discovery);
  tampered.resources[0]!.record.name = "Tampered after discovery";
  assert.throws(() => planLandscapeAdoption({
    discovery: tampered,
    expectedDiscoveryHash: tampered.discoveryHash,
    reviewer: "platform-team",
    candidateHashes: "all",
  }), /failed its content hash/);
});

test("HLG-2 reuse verifies full reviewed bytes instead of trusting copied metadata hashes", () => {
  const discovery = fixture();
  const first = planLandscapeAdoption({
    discovery,
    expectedDiscoveryHash: discovery.discoveryHash,
    reviewer: "platform-team",
    reviewedAt: "2026-08-26T11:00:00.000Z",
    candidateHashes: "all",
  });
  const tampered = structuredClone(first.resourcesToWrite);
  tampered[0]!.name = "Changed while retaining the old candidate hash";
  assert.throws(() => planLandscapeAdoption({
    discovery,
    expectedDiscoveryHash: discovery.discoveryHash,
    reviewer: "platform-team",
    reviewedAt: "2026-08-26T11:00:00.000Z",
    candidateHashes: "all",
    existingResources: tampered,
    existingRelationships: first.relationshipsToWrite,
  }), /different reviewed content/);

  assert.throws(() => planLandscapeAdoption({
    discovery,
    expectedDiscoveryHash: discovery.discoveryHash,
    reviewer: "platform-team",
    reviewedAt: "2026-08-26T11:00:00.000Z",
    candidateHashes: "all",
    existingResources: [first.resourcesToWrite[0]!, first.resourcesToWrite[0]!],
  }), /duplicate id/);
});

test("HLG-2 CLI review stays read-only and adopt persists only the hash-bound reviewed fragment", (t) => {
  const root = mkdtempSync(join(tmpdir(), "hunch-landscape-adopt-cli-"));
  t.after(() => rmSync(root, { recursive: true, force: true }));
  const git = (...args: string[]) => execFileSync("git", ["-C", root, ...args], { encoding: "utf8" }).trim();
  git("init", "-q");
  git("config", "user.name", "Hunch Test");
  git("config", "user.email", "hunch@example.test");
  writeFileSync(join(root, "package.json"), `${JSON.stringify({
    name: "@acme/reviewed-repository",
    repository: "https://github.com/acme/reviewed-repository.git",
  }, null, 2)}\n`, "utf8");
  git("add", "package.json");
  git("commit", "-qm", "fixture");

  const projectRoot = process.cwd();
  const tsx = join(projectRoot, "node_modules/tsx/dist/cli.mjs");
  const cli = join(projectRoot, "src/cli/index.ts");
  const review = spawnSync(process.execPath, [tsx, cli, "landscape", "review", "--json"], {
    cwd: root,
    encoding: "utf8",
    env: { ...process.env, HUNCH_PRIVATE_DIR: "" },
  });
  assert.equal(review.status, 0, review.stderr);
  const discovery = JSON.parse(review.stdout) as LandscapeDiscoveryResult;
  assert.equal(existsSync(join(root, ".hunch")), false, "review cannot create graph state");

  const adopt = spawnSync(process.execPath, [
    tsx,
    cli,
    "landscape",
    "adopt",
    "--ref",
    discovery.sourceRevision,
    "--expected",
    discovery.discoveryHash,
    "--all",
    "--reviewed-by",
    "platform-team",
  ], {
    cwd: root,
    encoding: "utf8",
    env: { ...process.env, HUNCH_PRIVATE_DIR: "" },
  });
  assert.equal(adopt.status, 0, adopt.stderr);
  assert.match(adopt.stdout, /hunch\.landscape-adoption-receipt\/1/);
  assert.match(adopt.stdout, /accepted 2 resource\(s\) and 1 relationship\(s\)/);

  const resources = JSON.parse(readFileSync(join(root, ".hunch/resources/index.json"), "utf8")) as Resource[];
  const relationships = JSON.parse(readFileSync(join(root, ".hunch/edges/index.json"), "utf8")) as Edge[];
  assert.equal(resources.length, 2);
  assert.equal(relationships.length, 1);
  assert.ok(resources.every((record) => record.currentness.status === "current"));
  assert.ok(resources.every((record) => record.metadata.discovery_authority === "human_confirmed"));

  const packageJson = JSON.parse(readFileSync(join(root, "package.json"), "utf8")) as Record<string, unknown>;
  packageJson.version = "2.0.0";
  writeFileSync(join(root, "package.json"), `${JSON.stringify(packageJson, null, 2)}\n`, "utf8");
  git("add", "package.json");
  git("commit", "-qm", "new exact landscape revision");

  const nextReview = spawnSync(process.execPath, [tsx, cli, "landscape", "review", "--json"], {
    cwd: root,
    encoding: "utf8",
    env: { ...process.env, HUNCH_PRIVATE_DIR: "" },
  });
  assert.equal(nextReview.status, 0, nextReview.stderr);
  const nextDiscovery = JSON.parse(nextReview.stdout) as LandscapeDiscoveryResult;
  assert.notEqual(nextDiscovery.sourceRevision, discovery.sourceRevision);

  const refreshArgs = [
    tsx,
    cli,
    "landscape",
    "adopt",
    "--ref",
    nextDiscovery.sourceRevision,
    "--expected",
    nextDiscovery.discoveryHash,
    "--all",
    "--reviewed-by",
    "platform-team",
  ];
  const refusedRefresh = spawnSync(process.execPath, refreshArgs, {
    cwd: root,
    encoding: "utf8",
    env: { ...process.env, HUNCH_PRIVATE_DIR: "" },
  });
  assert.equal(refusedRefresh.status, 1);
  assert.match(refusedRefresh.stderr, /different reviewed content/);

  const refreshed = spawnSync(process.execPath, [...refreshArgs, "--refresh-reviewed"], {
    cwd: root,
    encoding: "utf8",
    env: { ...process.env, HUNCH_PRIVATE_DIR: "" },
  });
  assert.equal(refreshed.status, 0, refreshed.stderr);
  assert.match(refreshed.stdout, /\(3 refreshed\)/);
  const refreshedResources = JSON.parse(readFileSync(join(root, ".hunch/resources/index.json"), "utf8")) as Resource[];
  const refreshedRelationships = JSON.parse(readFileSync(join(root, ".hunch/edges/index.json"), "utf8")) as Edge[];
  assert.ok(refreshedResources.every((record) => record.currentness.source_revision === nextDiscovery.sourceRevision));
  assert.ok(refreshedRelationships.every((record) => record.currentness.source_revision === nextDiscovery.sourceRevision));
});
