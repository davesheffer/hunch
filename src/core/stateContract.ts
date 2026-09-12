/**
 * nuryel.state/1 — the ONE contract every orchestrator and agent speaks to the state layer.
 *
 * Direction (private records vision.deterministic-state-layer, architecture.single-integration-
 * surface): agents are probabilistic, organizations need deterministic state, Nuryel holds it.
 * Protocols are bindings of this contract, never separate integrations. This module is the
 * contract FROZEN AS CODE — the verbs, canonical hashing, id derivation and invariants. The
 * record schemas (facets) live in ./stateRecords.js so the store's kind registry can import
 * them without a cycle; they are re-exported here so callers see one contract module.
 *
 * Facets of organizational state (each maps to a record kind):
 *   decided   — Decision (exists)              in force — Constraint / valid_to (exists)
 *   done      — ActionReceipt                  committed — Commitment
 *   changed   — ExternalRef version pointer    current — DerivedState with dependencies
 *   entity / relationship — external entities and their links (Landscape-shaped)
 *   DNA       — hunch.project-dna/1 profiles keyed by scope (exists; scope keying is new)
 *
 * Three verbs: read (with a delivery receipt), write (provenance + idempotency, returns
 * durability), subscribe (changes to what the caller holds). Invariants are exported as
 * assertions so bindings and tests enforce them, not prose.
 *
 * Compatibility: additive. No existing record changes shape; `scope` on legacy records defaults
 * to the repository scope; the new facets are new record kinds an older reader ignores. The
 * schema version of the JSON store is untouched. Verbs are not wired into the store, CLI or MCP
 * here; bindings are generated from these schemas in a later step.
 */
import { createHash } from "node:crypto";
import { z } from "zod";
import { compareCodeUnits } from "./canonicalOrder.js";
import { DELIVERY_PROFILES, type DeliveryEnvelope } from "./delivery.js";
import { isHumanConfirmed as sourceIsHumanConfirmed } from "./strictgate.js";
import {
  ScopeSchema, scopePath, externalKey, DependencyRefSchema, ExternalRefSchema,
  RECEIPT_SCHEMA_VERSION, COMMITMENT_SCHEMA_VERSION, DERIVED_SCHEMA_VERSION, ENTITY_SCHEMA_VERSION, RELATIONSHIP_SCHEMA_VERSION,
  type Scope, type ActionReceipt, type Commitment, type DerivedState,
} from "./stateRecords.js";

export * from "./stateRecords.js";

export const STATE_CONTRACT_VERSION = "nuryel.state/1" as const;
export const STATE_READ_VERSION = "nuryel.state.read/1" as const;
export const STATE_WRITE_VERSION = "nuryel.state.write/1" as const;
export const STATE_SUBSCRIBE_VERSION = "nuryel.state.subscribe/1" as const;
export const STATE_RECORDS_VERSION = "nuryel.state.records/1" as const;
export const STATE_CAPTURE_VERSION = "nuryel.state.capture/1" as const;
export const STATE_CAPTURE_BATCH_VERSION = "nuryel.state.capture-batch/1" as const;
export const STATE_OBSERVATION_LINKS_VERSION = "nuryel.observation-links/1" as const;
export const STATE_OBSERVATION_REVIEW_VERSION = "nuryel.observation-review/1" as const;
export const STATE_OBSERVATION_PAGES_VERSION = "nuryel.observation-pages/1" as const;

/** Capabilities a server advertises; a client that needs one the server lacks gets a typed
 *  `unsupported`, never a compatible-looking degraded answer. */
export const STATE_CAPABILITIES = [
  STATE_READ_VERSION, STATE_WRITE_VERSION, STATE_SUBSCRIBE_VERSION, STATE_RECORDS_VERSION, STATE_CAPTURE_VERSION, STATE_CAPTURE_BATCH_VERSION, STATE_OBSERVATION_LINKS_VERSION, STATE_OBSERVATION_REVIEW_VERSION, STATE_OBSERVATION_PAGES_VERSION,
  RECEIPT_SCHEMA_VERSION, COMMITMENT_SCHEMA_VERSION, DERIVED_SCHEMA_VERSION, ENTITY_SCHEMA_VERSION, RELATIONSHIP_SCHEMA_VERSION,
] as const;
export type StateCapability = (typeof STATE_CAPABILITIES)[number];

const SHA256 = /^sha256:[a-f0-9]{64}$/;
// Explicit classes, no `i` flag: the pattern must survive zod → JSON schema for MCP output validation.
const TOKEN = /^[A-Za-z0-9][A-Za-z0-9._:@+-]{0,199}$/;
const ISO = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d{1,3})?(?:Z|[+-]\d{2}:\d{2})$/;

// ---- principal --------------------------------------------------------------------------

/** Who is reading or writing. Grants are the scopes the principal may see; authorization is
 *  decided BEFORE retrieval against these, never after ranking. */
export const PrincipalSchema = z.object({
  id: z.string().regex(TOKEN),
  kind: z.enum(["human", "agent", "service"]),
  display: z.string().max(256).optional(),
  grants: z.array(ScopeSchema).min(1).max(64),
}).strict();
export type Principal = z.infer<typeof PrincipalSchema>;

/** One relevant assertion, never a whole conversation. Source text is transient input:
 * only its exact supporting excerpt and a hashed external pointer may reach the store. */
export const CaptureRequestSchema = z.object({
  schema: z.literal(STATE_CAPTURE_VERSION),
  principal: PrincipalSchema,
  scope: ScopeSchema,
  subject: z.string().min(1).max(512),
  statement: z.string().trim().min(1).max(1200),
  relevance: z.object({
    use: z.enum(["decision", "constraint", "preference", "operational_fact", "ongoing_issue"]),
    reason: z.string().trim().min(1).max(600),
  }).strict(),
  evidence: z.array(z.object({
    ref: ExternalRefSchema,
    source_text: z.string().min(1).max(64000),
    excerpt: z.string().trim().min(1).max(1200),
  }).strict()).min(1).max(8),
}).strict();
export type CaptureRequest = z.infer<typeof CaptureRequestSchema>;

/** Sources cross the transport once; assertions name only their supporting excerpts. */
export const CaptureBatchRequestSchema = z.object({
  schema: z.literal(STATE_CAPTURE_BATCH_VERSION), principal: PrincipalSchema, scope: ScopeSchema,
  sources: z.array(CaptureRequestSchema.shape.evidence.element.omit({ excerpt: true })).min(1).max(8),
  observations: z.array(CaptureRequestSchema.pick({ subject: true, statement: true, relevance: true }).extend({
    evidence: z.array(z.object({ source: z.number().int().min(0).max(7), excerpt: z.string().trim().min(1).max(1200) }).strict()).min(1).max(8),
  })).min(0).max(32),
  reviews: z.array(z.object({
    record_id: z.string().regex(/^nds_[a-f0-9]{24}$/), expected_hash: z.string().regex(SHA256),
    reason: z.string().trim().min(1).max(600),
    evidence: z.array(z.object({ source: z.number().int().min(0).max(7), excerpt: z.string().trim().min(1).max(1200) }).strict()).min(1).max(8),
  }).strict()).min(1).max(32).optional(),
}).strict();
export type CaptureBatchRequest = z.infer<typeof CaptureBatchRequestSchema>;

export const CAPTURE_TRANSFORM = "agent-capture/1:";
export const normalizeAssertion = (text: string): string => text.normalize("NFC").replace(/\r\n?/g, "\n").trim();
export function captureTransform(scope: Scope, subject: string, statement: string, evidence: { source: string; excerpt: string }[]): string {
  const identities = [...new Set(evidence.map(e => stateHash({ source: e.source, excerpt: normalizeAssertion(e.excerpt) })))].sort();
  return CAPTURE_TRANSFORM + stateHash({ scope, subject, statement: normalizeAssertion(statement), evidence: identities }).slice(7);
}

export const STATE_FACETS = ["decisions", "constraints", "bugs", "findings", "receipts", "commitments", "derived", "entities", "relationships"] as const;
export type StateFacet = (typeof STATE_FACETS)[number];

// ---- verbs ------------------------------------------------------------------------------

/** Union read: the partitions a principal wants in ONE answer. `scope` stays required (it is the
 *  primary partition; its envelope and receipt lead the response). An entry the principal is not
 *  granted is NAMED in `denied_scopes` — it never refuses the whole call, and is never described. */
export const ReadScopesSchema = z.array(ScopeSchema).min(1).max(64);

export const ObservationCursorSchema = z.object({
  snapshot_hash: z.string().regex(SHA256), offset: z.number().int().nonnegative().max(Number.MAX_SAFE_INTEGER),
}).strict();

export const ReadRequestSchema = z.object({
  schema: z.literal(STATE_READ_VERSION),
  principal: PrincipalSchema,
  scope: ScopeSchema,
  scopes: ReadScopesSchema.optional(),
  subject: z.string().max(512).optional(),
  task: z.string().max(4096).optional(),
  profile: z.enum(DELIVERY_PROFILES).optional(),
  budget_tokens: z.number().int().min(200).max(200_000).optional(),
  facets: z.array(z.enum(STATE_FACETS)).max(STATE_FACETS.length).optional(),
  /** Explicit single-partition pagination; default subject reads keep their existing bound. */
  observed_page: z.object({ cursor: ObservationCursorSchema.optional() }).strict().optional(),
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
  /** Source-backed observations, not a claim of currentness. Additive; absent on old hosts. */
  observed: z.array(StateRefSchema).max(64).optional(),
  observed_truncated: z.boolean().optional(),
  observed_page: z.object({ snapshot_hash: z.string().regex(SHA256), total: z.number().int().nonnegative(), next_cursor: ObservationCursorSchema.nullable() }).strict().optional(),
  relationships_truncated: z.boolean().optional(),
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
  /** The records behind every ref in `state_of_record`, by id, so a consumer can answer from
   *  the drawer without a second lookup. Additive; absent when there is no subject. */
  records: z.record(z.string(), z.record(z.string(), z.unknown())).optional(),
  /** Union read (additive): the partitions actually read, primary first. Absent on a
   *  single-partition read. */
  scopes: z.array(ScopeSchema).max(64).optional(),
  /** Union read (additive): one delivery receipt per partition read; `receipt_id` above stays
   *  the primary's. */
  receipts: z.array(z.object({ scope: ScopeSchema, receipt_id: z.string().regex(/^hdr_[a-f0-9]{24}$/) }).strict()).max(64).optional(),
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
  /** Why this write happened, when it is not the writer's own doing (additive): an external
   *  source moved. A derived record written back as `stale` with this cause emits an
   *  `invalidated` change naming the pointer — the `changed` facet, finally written by someone. */
  cause: z.object({ kind: z.literal("external"), ref: ExternalRefSchema }).strict().optional(),
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
  /** The record as stored (after normalization and identity derivation), so a writer can verify
   *  what landed without a second lookup. Additive. */
  record: z.record(z.string(), z.unknown()).optional(),
}).strict();
export type WriteResult = z.infer<typeof WriteResultSchema>;

export const CaptureBatchResultSchema = z.object({
  schema: z.literal(STATE_CAPTURE_BATCH_VERSION),
  results: z.array(z.discriminatedUnion("status", [
    z.object({ index: z.number().int(), status: z.literal("saved"), result: WriteResultSchema }).strict(),
    z.object({ index: z.number().int(), status: z.literal("refused"), code: z.string(), message: z.string() }).strict(),
  ])).max(32),
  reviews: z.array(z.discriminatedUnion("status", [
    z.object({ index: z.number().int(), status: z.literal("saved"), result: WriteResultSchema }).strict(),
    z.object({ index: z.number().int(), status: z.literal("refused"), code: z.string(), message: z.string() }).strict(),
  ])).max(32).optional(),
}).strict();
export type CaptureBatchResult = z.infer<typeof CaptureBatchResultSchema>;

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
  /** The record's subject (entity id / topic / external object key), so a subscriber can
   *  filter by what it holds without reading every record. Optional: legacy facets may lack one. */
  subject: z.string().max(512).optional(),
  invalidates: z.array(z.string().max(512)).max(256).default([]),
  cause: z.union([
    z.object({ kind: z.literal("receipt"), receipt_id: z.string().regex(/^nrc_[a-f0-9]{24}$/) }).strict(),
    z.object({ kind: z.literal("external"), ref: ExternalRefSchema }).strict(),
    z.object({ kind: z.literal("write"), principal: z.string().regex(TOKEN) }).strict(),
  ]).optional(),
}).strict();
export type ChangeEvent = z.infer<typeof ChangeEventSchema>;

/** records — fetch records by id, grants first. A subscribe event names a record; this is how
 *  a consumer gets its body without a subject read. Ids outside the grants are named in
 *  `denied`, unknown ids in `missing`; neither is silently dropped. */
export const RecordsRequestSchema = z.object({
  schema: z.literal(STATE_RECORDS_VERSION),
  principal: PrincipalSchema,
  scope: ScopeSchema,
  ids: z.array(z.string().min(1).max(2048)).min(1).max(256),
}).strict();
export type RecordsRequest = z.infer<typeof RecordsRequestSchema>;

export const RecordsResponseSchema = z.object({
  schema: z.literal(STATE_RECORDS_VERSION),
  scope: ScopeSchema,
  records: z.record(z.string(), z.record(z.string(), z.unknown())),
  facets: z.record(z.string(), z.enum(STATE_FACETS)),
  missing: z.array(z.string().max(2048)).default([]),
  denied: z.array(z.string().max(2048)).default([]),
}).strict();
export type RecordsResponse = z.infer<typeof RecordsResponseSchema>;

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
  // Capture's reserved transform includes assertion/evidence identity, independent of
  // read time and unrelated source edits. Ordinary summary identity is unchanged.
  if (/^agent-capture\/1:[a-f0-9]{64}$/.test(d.transform_version)) {
    return idFrom("nds", { scope: d.scope, subject: d.subject, transform_version: d.transform_version });
  }
  return idFrom("nds", { scope: d.scope, subject: d.subject, transform_version: d.transform_version, dependencies: d.dependencies.map((dep) => stateHash(dep)).sort(compareCodeUnits) });
}

// ---- invariants --------------------------------------------------------------------------

export const STATE_INVARIANTS = [
  { id: "authorization-before-retrieval", statement: "A record outside the principal's grants never enters a candidate set; filtering after ranking is a violation." },
  { id: "similarity-never-authorizes", statement: "Semantic similarity may find candidates; only deterministic dependency, freshness and grant checks make a record current or visible." },
  { id: "never-in-request-path", statement: "Nuryel is read and written by orchestrators; it never proxies, fetches or stores on an agent's behalf. A gate that checks state and refuses is allowed; an intermediary is not." },
  { id: "provenance-on-every-write", statement: "Every write carries provenance and an idempotency key; a replay returns the original record, never a duplicate." },
  { id: "one-live-decision-per-topic", statement: "A second live decision on a topic is refused with the incumbent named; supersession is explicit." },
  { id: "external-truth-stays-external", statement: "External systems remain authoritative for their own content; Nuryel holds credential-free pointers, versions and hashes, never mirrored bodies." },
  { id: "derived-state-carries-dependencies", statement: "A derived statement without dependencies cannot be invalidated and is therefore not state." },
  { id: "one-entity-per-external-ref", statement: "One external record is one entity in a partition: a second active entity carrying an external key an incumbent already carries is refused with the incumbent named, and a subject written as that record's external key is refused with the entity's id named. Identity is explicit refs, never similarity; merge is explicit — a retired entity names the survivor in `merged_into`, the ledger holds the `retired` event, nothing under the old id is rewritten and reads resolve to the survivor — and split is the explicit reverse; never a silent rewrite." },
  { id: "human-correction-outranks-agent-writes", statement: "A record a human confirmed is never overwritten or superseded by an agent or service principal: the agent may replay it, write derived state back stale with the external cause that moved, or close a commitment with a receipt on record. Changing what the human said takes a human." },
  { id: "derived-state-writer-owns-currentness", statement: "No source writes the drawer. The writer of a current derived statement owns keeping its dependencies true: re-validate them on a schedule or on a source event, and write the statement back stale with the moved pointer as cause when one no longer holds. Without this duty an agent may capture source-backed observations only as unknown; observations never assert currentness." },
  { id: "one-current-derived-per-subject-transform", statement: "A subject holds at most one current derived statement per transform: a new one must name the incumbent in supersedes (refused 409 with the incumbent named otherwise); the same identity written again updates or replays that record." },
] as const;

const grantKey = (scope: Scope): string => scopePath(scope);

/** The memory supply chain's top tier: a record whose provenance a human signed. Same tier rule
 *  as the strict gate's (strictgate.isHumanConfirmed), applied to a record instead of a source. */
export function isHumanConfirmed(record: unknown): boolean {
  const source = (record as { provenance?: { source?: unknown } } | null)?.provenance?.source;
  return typeof source === "string" && sourceIsHumanConfirmed(source);
}

/** authorization-before-retrieval, checked on the way OUT as well: nothing in a read response
 *  may sit outside the principal's grants. Bindings must also filter on the way in. */
export function assertReadWithinGrants(principal: Principal, response: ReadResponse): void {
  const granted = new Set(principal.grants.map(grantKey));
  if (!granted.has(grantKey(response.scope))) throw new Error(`read response scope ${grantKey(response.scope)} is outside the principal's grants`);
  const refs = response.state_of_record ? [...response.state_of_record.current, ...response.state_of_record.in_force, ...response.state_of_record.done, ...(response.state_of_record.observed ?? [])] : [];
  for (const ref of refs) {
    if (!granted.has(grantKey(ref.scope))) throw new Error(`state ref ${ref.id} in scope ${grantKey(ref.scope)} leaked outside the principal's grants`);
  }
  for (const denied of response.denied_scopes) {
    if (granted.has(grantKey(denied))) throw new Error(`denied scope ${grantKey(denied)} is actually granted — the response is inconsistent`);
  }
  for (const read of response.scopes ?? []) {
    if (!granted.has(grantKey(read))) throw new Error(`read scope ${grantKey(read)} is outside the principal's grants`);
  }
  for (const receipt of response.receipts ?? []) {
    if (!granted.has(grantKey(receipt.scope))) throw new Error(`receipt for scope ${grantKey(receipt.scope)} is outside the principal's grants`);
  }
}

/** provenance-on-every-write + scope agreement between the envelope and the record. */
export function assertWriteWellFormed(request: WriteRequest): void {
  // Authorization first — before the record is even looked at.
  if (!request.principal.grants.some((g) => grantKey(g) === grantKey(request.scope))) throw new Error("write scope is outside the principal's grants");
  const record = request.record as { provenance?: unknown; scope?: unknown };
  if (!record.provenance || typeof record.provenance !== "object") throw new Error("write record lacks provenance");
  // Only a PARTITION scope on the record is compared: legacy constraints carry path globs
  // under the same key, and those are not a partition claim.
  if (ScopeSchema.safeParse(record.scope).success && stateHash(record.scope) !== stateHash(request.scope)) throw new Error("write record scope disagrees with the request scope");
}

/** derived-state-carries-dependencies + content integrity. */
export function assertDerivedState(d: DerivedState): void {
  if (d.dependencies.length === 0) throw new Error("derived state without dependencies is not state");
  if (stateHash(d.content) !== d.content_hash) throw new Error("derived state content hash does not match its content");
  if (d.transform_version.startsWith(CAPTURE_TRANSFORM)) {
    const content = z.object({
      schema: z.literal("nuryel.observation-content/1"),
      statement: CaptureRequestSchema.shape.statement, relevance: CaptureRequestSchema.shape.relevance,
      evidence: z.array(z.object({ source: z.string(), excerpt: z.string().min(1).max(1200) }).strict()).min(1).max(8),
      captured_by: PrincipalSchema.shape.id,
    }).strict().parse(JSON.parse(d.content));
    if (d.state === "current") throw new Error("capture observations cannot assert currentness; publish a separately revalidated summary");
    if (captureTransform(d.scope, d.subject, content.statement, content.evidence) !== d.transform_version) throw new Error("capture identity does not match its assertion and evidence");
    const pointers = new Set(d.dependencies.filter(dep => dep.kind === "external").map(dep => externalKey(dep.ref)));
    if (content.evidence.some(e => !pointers.has(e.source))) throw new Error("capture evidence lacks its external dependency");
  }
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
