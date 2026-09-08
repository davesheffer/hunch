/**
 * nuryel.state/1 — the RECORD schemas (the facets that are new record kinds in the store).
 *
 * Kept separate from stateContract.ts (verbs, invariants, hashing) because the store's kind
 * registry in types.ts must reference these schemas, and stateContract imports types.ts —
 * this module imports only zod, the id helpers and the provenance leaf, so there is no cycle.
 *
 * Facets here: done (ActionReceipt), committed (Commitment), current (DerivedState with
 * mandatory dependencies), entity / relationship (external, Landscape-shaped), plus the
 * credential-free ExternalRef ("changed") and DependencyRef they share. Scope is the one
 * graph's partition: organization › team › user › repository.
 */
import { z } from "zod";
import { edgeId, resourceId } from "./ids.js";
import { ProvenanceSchema, isCredentialFreeValue } from "./provenance.js";

export const RECEIPT_SCHEMA_VERSION = "nuryel.receipt/1" as const;
export const COMMITMENT_SCHEMA_VERSION = "nuryel.commitment/1" as const;
export const DERIVED_SCHEMA_VERSION = "nuryel.derived/1" as const;
export const ENTITY_SCHEMA_VERSION = "nuryel.entity/1" as const;
export const RELATIONSHIP_SCHEMA_VERSION = "nuryel.relationship/1" as const;

const SHA256 = /^sha256:[a-f0-9]{64}$/;
const TOKEN = /^[a-z0-9][a-z0-9._:@+-]{0,199}$/i;
const ISO = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d{1,3})?(?:Z|[+-]\d{2}:\d{2})$/;
const DAY = /^\d{4}-\d{2}-\d{2}$/;

const credentialFree = (label: string) => z.string().min(1).max(2048).refine(isCredentialFreeValue, { message: `${label} must not carry credential material` });

// ---- scope ------------------------------------------------------------------------------

/** organization › team › user › repository — partitions of ONE graph, not separate stores. */
export const SCOPE_KINDS = ["organization", "team", "user", "repository"] as const;
export const ScopeSchema = z.object({
  kind: z.enum(SCOPE_KINDS),
  id: z.string().regex(TOKEN),
}).strict();
export type Scope = z.infer<typeof ScopeSchema>;
export const scopePath = (scope: Scope): string => `${scope.kind}/${scope.id}`;

// ---- provenance pointer into an external system --------------------------------------------

/** "What changed" and "where this came from": a credential-free pointer to an object that
 *  stays authoritative in its own system. Nuryel never mirrors its content. */
export const ExternalRefSchema = z.object({
  system: z.string().regex(/^[a-z][a-z0-9_-]{0,63}$/),
  object_type: z.string().regex(/^[a-z][a-z0-9_-]{0,63}$/),
  object_key: credentialFree("external object key").max(512),
  version: credentialFree("external version").max(256).optional(),
  content_hash: z.string().regex(SHA256).optional(),
  observed_at: z.string().regex(ISO),
  locator: credentialFree("external locator").optional(),
}).strict();
export type ExternalRef = z.infer<typeof ExternalRefSchema>;

/** What a derived statement rests on. Exactly what a currentness check re-validates. */
export const DependencyRefSchema = z.discriminatedUnion("kind", [
  z.object({ kind: z.literal("record"), id: z.string().regex(TOKEN), record_hash: z.string().regex(SHA256) }).strict(),
  z.object({ kind: z.literal("external"), ref: ExternalRefSchema }).strict(),
  z.object({ kind: z.literal("schema"), name: z.string().max(256), fingerprint: z.string().regex(SHA256) }).strict(),
]);
export type DependencyRef = z.infer<typeof DependencyRefSchema>;

// ---- facets ------------------------------------------------------------------------------

/** done — a side effect that happened. Never replayable as a read; idempotency is explicit. */
export const ActionReceiptSchema = z.object({
  schema: z.literal(RECEIPT_SCHEMA_VERSION),
  id: z.string().regex(/^nrc_[a-f0-9]{24}$/),
  scope: ScopeSchema,
  actor: z.string().regex(TOKEN).describe("principal id"),
  action_kind: z.string().regex(/^[a-z][a-z0-9_]{0,63}$/),
  target: ExternalRefSchema,
  request_fingerprint: z.string().regex(SHA256),
  idempotency_key: z.string().max(256).optional(),
  state: z.enum(["requested", "succeeded", "failed", "unknown", "verified"]),
  occurred_at: z.string().regex(ISO),
  verified_at: z.string().regex(ISO).optional(),
  result_fingerprint: z.string().regex(SHA256).optional(),
  invalidates: z.array(z.string().max(512)).max(64).default([]),
  provenance: ProvenanceSchema,
}).strict();
export type ActionReceipt = z.infer<typeof ActionReceiptSchema>;

/** committed — an obligation with a due date and an in-force window. */
export const CommitmentSchema = z.object({
  schema: z.literal(COMMITMENT_SCHEMA_VERSION),
  id: z.string().regex(/^ncm_[a-f0-9]{24}$/),
  scope: ScopeSchema,
  subject: z.string().max(512).describe("entity id or stable subject key"),
  title: z.string().min(1).max(512),
  owner: z.string().regex(TOKEN).describe("principal id"),
  due: z.string().regex(DAY),
  status: z.enum(["open", "waiting", "done", "cancelled"]),
  source: ExternalRefSchema.optional(),
  evidence_excerpt: z.string().max(900).optional(),
  valid_from: z.string().regex(ISO),
  valid_to: z.string().regex(ISO).nullable().default(null),
  provenance: ProvenanceSchema,
}).strict();
export type Commitment = z.infer<typeof CommitmentSchema>;

/** current — a statement that is true now, and on what it rests. Dependencies are mandatory:
 *  a derived statement without them cannot be invalidated and therefore cannot be trusted. */
export const DerivedStateSchema = z.object({
  schema: z.literal(DERIVED_SCHEMA_VERSION),
  id: z.string().regex(/^nds_[a-f0-9]{24}$/),
  scope: ScopeSchema,
  subject: z.string().max(512),
  content: z.string().min(1).max(20_000),
  content_hash: z.string().regex(SHA256),
  dependencies: z.array(DependencyRefSchema).min(1).max(256),
  transform_version: z.string().max(128),
  computed_at: z.string().regex(ISO),
  valid_to: z.string().regex(ISO).nullable().default(null),
  state: z.enum(["current", "stale", "unknown"]),
  provenance: ProvenanceSchema,
}).strict();
export type DerivedState = z.infer<typeof DerivedStateSchema>;

const AttributeValue = z.union([z.string().max(2048), z.number().finite(), z.boolean(), z.null()]);

/** entity — a customer, an incident, a thread: a non-code node, Landscape-shaped (kind-qualified
 *  id, lifecycle, provenance), with provenance pointers instead of mirrored content. Stored in
 *  an index file, like resources, because kind-qualified ids are not safe file names. */
export const ExternalEntitySchema = z.object({
  schema: z.literal(ENTITY_SCHEMA_VERSION),
  id: z.string().min(3).max(2048),
  kind: z.string().regex(/^[a-z][a-z0-9_]{0,63}$/),
  name: credentialFree("entity name").max(256),
  scope: ScopeSchema,
  refs: z.array(ExternalRefSchema).min(1).max(64),
  attributes: z.record(z.string().max(128), AttributeValue).default({}),
  lifecycle: z.enum(["active", "deprecated", "retired"]).default("active"),
  provenance: ProvenanceSchema,
  created_at: z.string().regex(ISO),
  updated_at: z.string().regex(ISO),
}).strict().superRefine((entity, ctx) => {
  const prefix = `${entity.kind}:`;
  const key = entity.id.startsWith(prefix) ? entity.id.slice(prefix.length) : "";
  if (!key.trim() || entity.id !== resourceId(entity.kind, key)) {
    ctx.addIssue({ code: z.ZodIssueCode.custom, path: ["id"], message: "entity id must be a canonical kind-qualified identity" });
  }
  if (Object.keys(entity.attributes).length > 64) ctx.addIssue({ code: z.ZodIssueCode.custom, path: ["attributes"], message: "attributes are a minimal projection, not a mirror" });
});
export type ExternalEntity = z.infer<typeof ExternalEntitySchema>;

/** relationship — rides the same identity rule as the graph's edges. Index-file stored. */
export const StateRelationshipSchema = z.object({
  schema: z.literal(RELATIONSHIP_SCHEMA_VERSION),
  id: z.string().regex(/^edge_[a-f0-9]+$/),
  from: z.string().min(1).max(2048),
  to: z.string().min(1).max(2048),
  type: z.string().regex(/^[a-z][a-z0-9_]{0,63}$/),
  scope: ScopeSchema,
  reason: z.string().max(1024).default(""),
  provenance: ProvenanceSchema,
}).strict().superRefine((rel, ctx) => {
  if (rel.id !== edgeId(rel.from, rel.to, rel.type)) ctx.addIssue({ code: z.ZodIssueCode.custom, path: ["id"], message: "relationship id must derive from its endpoints and type" });
});
export type StateRelationship = z.infer<typeof StateRelationshipSchema>;

/** DNA facet: existing Project DNA profiles, keyed by scope. No new schema — the reference only. */
export const DnaFacetRefSchema = z.object({
  schema: z.literal("hunch.project-dna/1"),
  scope: ScopeSchema,
  profile_id: z.string().regex(/^pdna_[a-f0-9]{24}$/),
}).strict();

export const entityId = resourceId;
export const relationshipId = edgeId;
