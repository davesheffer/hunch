/**
 * nuryel.state/1 — the ONE contract every orchestrator and agent speaks to the state layer.
 *
 * Direction (private records vision.deterministic-state-layer, architecture.single-integration-
 * surface): agents are probabilistic, organizations need deterministic state, Nuryel holds it.
 * Protocols are bindings of this contract, never separate integrations. This module is the
 * contract FROZEN AS CODE — schemas, canonical hashing, id derivation, invariants — with no
 * behaviour change: nothing here is wired into the store, the CLI or MCP yet. Bindings
 * (HTTP, MCP, CLI, typed client) are generated from these schemas in a later step.
 *
 * Facets of organizational state (each maps to a record kind):
 *   decided   — Decision (exists)              in force — Constraint / valid_to (exists)
 *   done      — ActionReceipt (new)            committed — Commitment (new)
 *   changed   — ExternalRef version pointer    current — DerivedState with dependencies (new)
 *   entity / relationship — external entities and their links (new, Landscape-shaped)
 *   DNA       — hunch.project-dna/1 profiles keyed by scope (exists; scope keying is new)
 *
 * Three verbs: read (with a delivery receipt), write (provenance + idempotency, returns
 * durability), subscribe (changes to what the caller holds). Invariants are exported as
 * assertions so bindings and tests enforce them, not prose.
 *
 * Compatibility: additive. No existing record changes shape; `scope` on legacy records defaults
 * to the repository scope; new facets are new record kinds an older reader ignores. The schema
 * version of the JSON store is untouched.
 */
import { createHash } from "node:crypto";
import { z } from "zod";
import { compareCodeUnits } from "./canonicalOrder.js";
import { edgeId, resourceId } from "./ids.js";
import { DELIVERY_PROFILES, type DeliveryEnvelope } from "./delivery.js";
import { ProvenanceSchema, isCredentialFreeText } from "./types.js";

export const STATE_CONTRACT_VERSION = "nuryel.state/1" as const;
export const STATE_READ_VERSION = "nuryel.state.read/1" as const;
export const STATE_WRITE_VERSION = "nuryel.state.write/1" as const;
export const STATE_SUBSCRIBE_VERSION = "nuryel.state.subscribe/1" as const;
export const RECEIPT_SCHEMA_VERSION = "nuryel.receipt/1" as const;
export const COMMITMENT_SCHEMA_VERSION = "nuryel.commitment/1" as const;
export const DERIVED_SCHEMA_VERSION = "nuryel.derived/1" as const;
export const ENTITY_SCHEMA_VERSION = "nuryel.entity/1" as const;
export const RELATIONSHIP_SCHEMA_VERSION = "nuryel.relationship/1" as const;

/** Capabilities a server advertises; a client that needs one the server lacks gets a typed
 *  `unsupported`, never a compatible-looking degraded answer. */
export const STATE_CAPABILITIES = [
  STATE_READ_VERSION, STATE_WRITE_VERSION, STATE_SUBSCRIBE_VERSION,
  RECEIPT_SCHEMA_VERSION, COMMITMENT_SCHEMA_VERSION, DERIVED_SCHEMA_VERSION, ENTITY_SCHEMA_VERSION, RELATIONSHIP_SCHEMA_VERSION,
] as const;
export type StateCapability = (typeof STATE_CAPABILITIES)[number];

const SHA256 = /^sha256:[a-f0-9]{64}$/;
const TOKEN = /^[a-z0-9][a-z0-9._:@+-]{0,199}$/i;
const ISO = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d{1,3})?(?:Z|[+-]\d{2}:\d{2})$/;
const DAY = /^\d{4}-\d{2}-\d{2}$/;

/** Bare secret shapes the general detector does not cover: it looks for assignments, bearer
 *  values, private-key blocks and URL userinfo; a token pasted on its own into an object key or
 *  locator would pass. These prefixes are the common ones. */
const BARE_SECRET = /(?:^|[^A-Za-z0-9])(?:ghp_[A-Za-z0-9]{20,}|github_pat_[A-Za-z0-9_]{20,}|sk-[A-Za-z0-9_-]{16,}|xox[abpr]-[A-Za-z0-9-]{10,}|AKIA[0-9A-Z]{16}|eyJ[A-Za-z0-9_-]{10,}\.[A-Za-z0-9_-]{10,}\.[A-Za-z0-9_-]{10,})/;
const credentialFreeText = (value: string): boolean => isCredentialFreeText(value) && !BARE_SECRET.test(value);
const credentialFree = (label: string) => z.string().min(1).max(2048).refine(credentialFreeText, { message: `${label} must not carry credential material` });

// ---- scope + principal ------------------------------------------------------------------

/** organization › team › user › repository — partitions of ONE graph, not separate stores. */
export const SCOPE_KINDS = ["organization", "team", "user", "repository"] as const;
export const ScopeSchema = z.object({
  kind: z.enum(SCOPE_KINDS),
  id: z.string().regex(TOKEN),
}).strict();
export type Scope = z.infer<typeof ScopeSchema>;
export const scopePath = (scope: Scope): string => `${scope.kind}/${scope.id}`;

/** Who is reading or writing. Grants are the scopes the principal may see; authorization is
 *  decided BEFORE retrieval against these, never after ranking. */
export const PrincipalSchema = z.object({
  id: z.string().regex(TOKEN),
  kind: z.enum(["human", "agent", "service"]),
  display: z.string().max(256).optional(),
  grants: z.array(ScopeSchema).min(1).max(64),
}).strict();
export type Principal = z.infer<typeof PrincipalSchema>;

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
 *  id, lifecycle, provenance), with provenance pointers instead of mirrored content. */
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

/** relationship — rides the same identity rule as the graph's edges. */
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

export const STATE_FACETS = ["decisions", "constraints", "bugs", "findings", "receipts", "commitments", "derived", "entities", "relationships"] as const;
export type StateFacet = (typeof STATE_FACETS)[number];

// ---- verbs ------------------------------------------------------------------------------

export const ReadRequestSchema = z.object({
  schema: z.literal(STATE_READ_VERSION),
  principal: PrincipalSchema,
  scope: ScopeSchema,
  subject: z.string().max(512).optional(),
  task: z.string().max(4096).optional(),
  profile: z.enum(DELIVERY_PROFILES).optional(),
  budget_tokens: z.number().int().min(200).max(200_000).optional(),
  facets: z.array(z.enum(STATE_FACETS)).max(STATE_FACETS.length).optional(),
}).strict();
export type ReadRequest = z.infer<typeof ReadRequestSchema>;

const StateRefSchema = z.object({
  facet: z.enum(STATE_FACETS),
  id: z.string().min(1).max(2048),
  record_hash: z.string().regex(SHA256),
  scope: ScopeSchema,
}).strict();
export type StateRef = z.infer<typeof StateRefSchema>;

/** The system-of-record answer for a subject: what is true now, on what it rests, what would
 *  invalidate it. Carried beside the existing delivery envelope, under the same receipt. */
export const StateOfRecordSchema = z.object({
  subject: z.string().max(512),
  current: z.array(StateRefSchema).max(256),
  in_force: z.array(StateRefSchema).max(256),
  done: z.array(StateRefSchema).max(256),
  depends_on: z.array(DependencyRefSchema).max(1024),
  invalidated_by: z.array(z.string().max(512)).max(256),
}).strict();
export type StateOfRecord = z.infer<typeof StateOfRecordSchema>;

export const ReadResponseSchema = z.object({
  schema: z.literal(STATE_READ_VERSION),
  receipt_id: z.string().regex(/^hdr_[a-f0-9]{24}$/).describe("the delivery envelope's receipt"),
  scope: ScopeSchema,
  state_of_record: StateOfRecordSchema.nullable(),
  /** Scopes the principal asked about but is not granted — named, never silently dropped. */
  denied_scopes: z.array(ScopeSchema).max(64).default([]),
}).strict();
export type ReadResponse = z.infer<typeof ReadResponseSchema>;

export const WriteRequestSchema = z.object({
  schema: z.literal(STATE_WRITE_VERSION),
  principal: PrincipalSchema,
  scope: ScopeSchema,
  facet: z.enum(STATE_FACETS),
  record: z.record(z.string(), z.unknown()),
  idempotency_key: z.string().min(8).max(256),
  expected_version: z.union([z.string().max(256), z.number().int().nonnegative()]).nullable().default(null),
  supersedes: z.string().max(2048).optional(),
}).strict();
export type WriteRequest = z.infer<typeof WriteRequestSchema>;

export const DURABILITY = ["pushed", "committed", "local"] as const;
export const WriteResultSchema = z.object({
  schema: z.literal(STATE_WRITE_VERSION),
  record_id: z.string().min(1).max(2048),
  record_hash: z.string().regex(SHA256),
  durability: z.enum(DURABILITY),
  outcome: z.enum(["created", "updated", "replayed", "superseded"]),
  conflict: z.object({ incumbent_id: z.string().max(2048), reason: z.string().max(512) }).strict().nullable().default(null),
}).strict();
export type WriteResult = z.infer<typeof WriteResultSchema>;

export const SubscribeRequestSchema = z.object({
  schema: z.literal(STATE_SUBSCRIBE_VERSION),
  principal: PrincipalSchema,
  scope: ScopeSchema,
  after_seq: z.number().int().nonnegative(),
  subjects: z.array(z.string().max(512)).max(256).optional(),
  facets: z.array(z.enum(STATE_FACETS)).max(STATE_FACETS.length).optional(),
}).strict();
export type SubscribeRequest = z.infer<typeof SubscribeRequestSchema>;

export const ChangeEventSchema = z.object({
  schema: z.literal(STATE_SUBSCRIBE_VERSION),
  seq: z.number().int().positive(),
  at: z.string().regex(ISO),
  scope: ScopeSchema,
  facet: z.enum(STATE_FACETS),
  record_id: z.string().min(1).max(2048),
  record_hash: z.string().regex(SHA256),
  change: z.enum(["created", "updated", "superseded", "retired", "invalidated"]),
  invalidates: z.array(z.string().max(512)).max(256).default([]),
  cause: z.union([
    z.object({ kind: z.literal("receipt"), receipt_id: z.string().regex(/^nrc_[a-f0-9]{24}$/) }).strict(),
    z.object({ kind: z.literal("external"), ref: ExternalRefSchema }).strict(),
    z.object({ kind: z.literal("write"), principal: z.string().regex(TOKEN) }).strict(),
  ]).optional(),
}).strict();
export type ChangeEvent = z.infer<typeof ChangeEventSchema>;

export const CapabilityNegotiationSchema = z.object({
  protocol: z.literal(STATE_CONTRACT_VERSION),
  capabilities: z.array(z.string().max(128)).max(64),
}).strict();

export function negotiate(offered: readonly string[], required: readonly string[] = STATE_CAPABILITIES): { supported: string[]; unsupported: string[] } {
  const have = new Set(offered);
  const supported: string[] = [];
  const unsupported: string[] = [];
  for (const cap of required) (have.has(cap) ? supported : unsupported).push(cap);
  return { supported, unsupported };
}

// ---- canonical form, hashes, ids -----------------------------------------------------------

/** Canonical JSON: keys sorted by code unit at every level, `undefined` dropped, non-finite
 *  numbers rejected. Two records with the same facts hash the same regardless of who wrote them. */
export function canonicalize(value: unknown): unknown {
  if (value === null || typeof value === "string" || typeof value === "boolean") return value;
  if (typeof value === "number") {
    if (!Number.isFinite(value)) throw new Error("canonical form rejects non-finite numbers");
    return value;
  }
  if (Array.isArray(value)) return value.map(canonicalize);
  if (typeof value === "object") {
    const out: Record<string, unknown> = {};
    for (const key of Object.keys(value as Record<string, unknown>).sort(compareCodeUnits)) {
      const v = (value as Record<string, unknown>)[key];
      if (v !== undefined) out[key] = canonicalize(v);
    }
    return out;
  }
  throw new Error(`canonical form rejects ${typeof value}`);
}

export function stateHash(value: unknown): string {
  return `sha256:${createHash("sha256").update(JSON.stringify(canonicalize(value))).digest("hex")}`;
}

const idFrom = (prefix: string, seed: unknown): string => `${prefix}_${createHash("sha256").update(JSON.stringify(canonicalize(seed))).digest("hex").slice(0, 24)}`;

/** Identity = what makes two receipts the same action: who did what to which object, with which
 *  request. Re-sending the same action replays the same receipt instead of minting a second one. */
export function actionReceiptId(r: Pick<ActionReceipt, "scope" | "actor" | "action_kind" | "target" | "request_fingerprint"> & { idempotency_key?: string }): string {
  return idFrom("nrc", { scope: r.scope, actor: r.actor, action_kind: r.action_kind, target: { system: r.target.system, object_type: r.target.object_type, object_key: r.target.object_key }, request_fingerprint: r.request_fingerprint, idempotency_key: r.idempotency_key ?? null });
}
export function commitmentId(c: Pick<Commitment, "scope" | "subject" | "title" | "owner" | "due">): string {
  return idFrom("ncm", { scope: c.scope, subject: c.subject, title: c.title.trim(), owner: c.owner, due: c.due });
}
export function derivedId(d: Pick<DerivedState, "scope" | "subject" | "transform_version" | "dependencies">): string {
  return idFrom("nds", { scope: d.scope, subject: d.subject, transform_version: d.transform_version, dependencies: d.dependencies.map((dep) => stateHash(dep)).sort(compareCodeUnits) });
}
export const entityId = resourceId;
export const relationshipId = edgeId;

// ---- invariants --------------------------------------------------------------------------

export const STATE_INVARIANTS = [
  { id: "authorization-before-retrieval", statement: "A record outside the principal's grants never enters a candidate set; filtering after ranking is a violation." },
  { id: "similarity-never-authorizes", statement: "Semantic similarity may find candidates; only deterministic dependency, freshness and grant checks make a record current or visible." },
  { id: "never-in-request-path", statement: "Nuryel is read and written by orchestrators; it never proxies, fetches or stores on an agent's behalf. A gate that checks state and refuses is allowed; an intermediary is not." },
  { id: "provenance-on-every-write", statement: "Every write carries provenance and an idempotency key; a replay returns the original record, never a duplicate." },
  { id: "one-live-decision-per-topic", statement: "A second live decision on a topic is refused with the incumbent named; supersession is explicit." },
  { id: "external-truth-stays-external", statement: "External systems remain authoritative for their own content; Nuryel holds credential-free pointers, versions and hashes, never mirrored bodies." },
  { id: "derived-state-carries-dependencies", statement: "A derived statement without dependencies cannot be invalidated and is therefore not state." },
] as const;

const grantKey = (scope: Scope): string => scopePath(scope);

/** authorization-before-retrieval, checked on the way OUT as well: nothing in a read response
 *  may sit outside the principal's grants. Bindings must also filter on the way in. */
export function assertReadWithinGrants(principal: Principal, response: ReadResponse): void {
  const granted = new Set(principal.grants.map(grantKey));
  if (!granted.has(grantKey(response.scope))) throw new Error(`read response scope ${grantKey(response.scope)} is outside the principal's grants`);
  const refs = response.state_of_record ? [...response.state_of_record.current, ...response.state_of_record.in_force, ...response.state_of_record.done] : [];
  for (const ref of refs) {
    if (!granted.has(grantKey(ref.scope))) throw new Error(`state ref ${ref.id} in scope ${grantKey(ref.scope)} leaked outside the principal's grants`);
  }
  for (const denied of response.denied_scopes) {
    if (granted.has(grantKey(denied))) throw new Error(`denied scope ${grantKey(denied)} is actually granted — the response is inconsistent`);
  }
}

/** provenance-on-every-write + scope agreement between the envelope and the record. */
export function assertWriteWellFormed(request: WriteRequest): void {
  // Authorization first — before the record is even looked at.
  if (!request.principal.grants.some((g) => grantKey(g) === grantKey(request.scope))) throw new Error("write scope is outside the principal's grants");
  const record = request.record as { provenance?: unknown; scope?: unknown };
  if (!record.provenance || typeof record.provenance !== "object") throw new Error("write record lacks provenance");
  if (record.scope !== undefined && stateHash(record.scope) !== stateHash(request.scope)) throw new Error("write record scope disagrees with the request scope");
}

/** derived-state-carries-dependencies + content integrity. */
export function assertDerivedState(d: DerivedState): void {
  if (d.dependencies.length === 0) throw new Error("derived state without dependencies is not state");
  if (stateHash(d.content) !== d.content_hash) throw new Error("derived state content hash does not match its content");
}

/** Subscribe streams are strictly ordered per scope; a gap or regression means the caller must
 *  resynchronize instead of trusting what it holds. */
export function assertChangeSequence(events: readonly ChangeEvent[], afterSeq: number): void {
  let expected = afterSeq + 1;
  for (const event of events) {
    if (event.seq !== expected) throw new Error(`change stream gap: expected seq ${expected}, got ${event.seq}`);
    expected += 1;
  }
}

/** A delivery envelope is the read receipt this contract reuses unchanged. */
export function receiptOf(envelope: Pick<DeliveryEnvelope, "receipt_id">): string {
  return envelope.receipt_id;
}
