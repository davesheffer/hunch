/**
 * nuryel.state/1 bound to the store — the ONE implementation of read / write / subscribe
 * that every transport (MCP today; HTTP, CLI, typed client next) calls. Transport-free:
 * takes a HunchStore and a validated request, returns a validated response, throws a
 * StateRefusal for every typed refusal. No transport may re-implement any rule here.
 *
 * Homing follows the store's routing, decided by SCOPE, never by a flag:
 *   repository scope → the repository's capture home (public `.hunch/`, or the overlay in
 *                      shared mode) — today's git-native store, unchanged;
 *   organization / team / user scopes → the overlay ONLY. They never ride a repository
 *                      (privacy rule of the contract); without an overlay the write is refused.
 * The change ledger for a scope lives in that same home, so a scope has one sequence.
 *
 * Invariants enforced here (exported from stateContract as assertions, not prose):
 * authorization-before-retrieval (grant check is the FIRST predicate on every path),
 * provenance-on-every-write, one-live-decision-per-topic, derived-state-carries-
 * dependencies, external-truth-stays-external (schema refinements), never-in-request-path
 * (there is no proxy verb — this module never fetches anything).
 */
import { basename, join } from "node:path";
import { existsSync, readFileSync } from "node:fs";
import { z } from "zod";
import type { HunchStore } from "./hunchStore.js";
import { appendChanges, latestSeqFor, readLedger, type PendingChange } from "./changeLedger.js";
import { hunchPaths } from "../core/paths.js";
import { decisionId } from "../core/ids.js";
import { ENTITY_KINDS, SCHEMAS, type EntityFor, type EntityKind } from "../core/types.js";
import { captureConflicts, isLive } from "../core/topics.js";
import { buildDeliveryEnvelope, type DeliveryEnvelope } from "../core/delivery.js";
import {
  STATE_CAPABILITIES, STATE_CONTRACT_VERSION, STATE_FACETS, STATE_READ_VERSION, STATE_SUBSCRIBE_VERSION, STATE_WRITE_VERSION,
  ReadRequestSchema, ReadResponseSchema, WriteRequestSchema, WriteResultSchema, SubscribeRequestSchema, ChangeEventSchema,
  RecordsRequestSchema, RecordsResponseSchema, STATE_RECORDS_VERSION,
  ScopeSchema, scopePath, stateHash, actionReceiptId, commitmentId, derivedId,
  assertReadWithinGrants, assertWriteWellFormed, assertDerivedState,
  type Principal, type Scope, type StateFacet, type ReadRequest, type ReadResponse, type WriteRequest, type WriteResult,
  type SubscribeRequest, type ChangeEvent, type StateRef, type DependencyRef, type RecordsRequest, type RecordsResponse,
} from "../core/stateContract.js";

/** A typed refusal. `code` is stable for bindings; `conflict` names the incumbent when one exists. */
export class StateRefusal extends Error {
  constructor(
    readonly code: "outside-grants" | "unsupported" | "malformed" | "identity" | "conflict" | "no-partition-home" | "idempotency",
    message: string,
    readonly conflict: { incumbent_id: string; reason: string } | null = null,
  ) {
    super(message);
    this.name = "StateRefusal";
  }
}

const LEGACY_FACETS = new Set<StateFacet>(["decisions", "constraints", "bugs", "findings"]);
// Explicit classes, no `i` flag: the pattern must survive zod → JSON schema for MCP output validation.
const TOKEN = /^[A-Za-z0-9][A-Za-z0-9._:@+-]{0,199}$/;

/** The partition this store IS. A served partition declares itself in `.hunch/partition.json`
 *  (`{ kind, id }`, committed with the store); a plain checkout is the repository partition
 *  named after its directory, sanitized to the contract's token grammar — stable per clone,
 *  discoverable through `capabilities`, and the scope every legacy record defaults to. */
export function partitionOf(store: HunchStore): Scope {
  const declared = join(hunchPaths(store.publicRoot).hunch, "partition.json");
  if (existsSync(declared)) {
    const parsed = ScopeSchema.safeParse(JSON.parse(readFileSync(declared, "utf8")));
    if (!parsed.success) throw new StateRefusal("unsupported", `${declared} does not declare a valid partition scope`);
    return parsed.data;
  }
  const raw = basename(store.publicRoot).replace(/[^A-Za-z0-9._:@+-]/g, "-").replace(/^[^A-Za-z0-9]+/, "");
  const id = TOKEN.test(raw) ? raw : "repository";
  return { kind: "repository", id };
}
/** @deprecated name kept for callers written before served partitions; same value as partitionOf. */
export const repositoryScope = partitionOf;

export const SubscribeResponseSchema = z.object({
  schema: z.literal(STATE_SUBSCRIBE_VERSION),
  scope: ScopeSchema,
  /** The scope's newest seq — the caller's cursor for the next call, whatever filters applied. */
  head_seq: z.number().int().nonnegative(),
  events: z.array(ChangeEventSchema),
  /** True when facet / subject filters were applied: `events` is then a subsequence and
   *  assertChangeSequence does not apply; `head_seq` remains the cursor. */
  filtered: z.boolean(),
  /** Events below this seq were compacted away. */
  floor_seq: z.number().int().nonnegative().default(0),
  /** True when `after_seq` was below the floor: the caller's cursor is stale, the events returned
   *  start at the floor, and the caller must rebuild what it holds from a read. */
  resync: z.boolean().default(false),
}).strict();
export type SubscribeResponse = z.infer<typeof SubscribeResponseSchema>;

export function capabilities(store: HunchStore): { protocol: typeof STATE_CONTRACT_VERSION; capabilities: string[]; repository: Scope; partitions: Scope["kind"][] } {
  const own = partitionOf(store);
  const partitions: Scope["kind"][] = store.hasPrivate ? ["organization", "team", "user", "repository"] : [own.kind];
  return { protocol: STATE_CONTRACT_VERSION, capabilities: [...STATE_CAPABILITIES], repository: own, partitions };
}

// ---- homing --------------------------------------------------------------------------------

const granted = (principal: Principal, scope: Scope): boolean => principal.grants.some((g) => scopePath(g) === scopePath(scope));

function homeFor(store: HunchStore, scope: Scope): { home: "public" | "private"; hunchDir: string; isPrivate: boolean } {
  const own = partitionOf(store);
  if (scopePath(scope) === scopePath(own)) {
    // The store IS this partition: its capture home (public `.hunch/`, or the overlay in shared mode).
    const home = store.captureHome(false);
    return { home, hunchDir: home === "private" ? store.privateDir! : hunchPaths(store.publicRoot).hunch, isPrivate: false };
  }
  if (scope.kind === "repository") throw new StateRefusal("unsupported", `this store serves ${scopePath(own)}, not ${scopePath(scope)}`);
  if (!store.hasPrivate || !store.privateDir) {
    throw new StateRefusal("no-partition-home", `${scope.kind} partitions never ride a repository; configure an overlay (hunch private / hunch shared) to hold ${scopePath(scope)}`);
  }
  return { home: "private", hunchDir: store.privateDir, isPrivate: true };
}

const recordScope = (record: unknown, repo: Scope): Scope => {
  const s = (record as { scope?: unknown }).scope;
  const parsed = ScopeSchema.safeParse(s);
  return parsed.success ? parsed.data : repo;
};

// ---- read ----------------------------------------------------------------------------------

function refOf(facet: StateFacet, record: { id: string }, scope: Scope): StateRef {
  return { facet, id: record.id, record_hash: stateHash(record), scope };
}


/** read — the system-of-record answer for a subject, under the delivery envelope's receipt.
 *  Grants are the first predicate on every candidate; a matching record in a scope the
 *  principal lacks is NAMED in denied_scopes and never described. */
export function readState(store: HunchStore, input: unknown): { response: ReadResponse; envelope: DeliveryEnvelope } {
  const request: ReadRequest = ReadRequestSchema.parse(input);
  if (!granted(request.principal, request.scope)) throw new StateRefusal("outside-grants", `scope ${scopePath(request.scope)} is outside the principal's grants`);
  const repo = partitionOf(store);
  const facets = new Set<StateFacet>(request.facets ?? STATE_FACETS);
  const target = request.task ?? request.subject ?? scopePath(request.scope);
  const ctx = store.assembleContext(target, request.budget_tokens ?? 1500);
  const envelope = buildDeliveryEnvelope(ctx, {
    root: store.publicRoot,
    symbols: store.recs("symbols"),
    components: store.recs("components"),
    decisionCorpus: store.recs("decisions"),
    profile: request.profile ?? "builder",
  });

  let stateOfRecord: ReadResponse["state_of_record"] = null;
  const records: Record<string, Record<string, unknown>> = {};
  const denied = new Map<string, Scope>();
  // Union read against ONE store: every requested scope the principal lacks is named up front;
  // the partitions actually read are declared so a caller never mistakes this for the union
  // (a multi-partition host merges per-store answers with mergeReadResponses).
  for (const s of request.scopes ?? []) if (!granted(request.principal, s)) denied.set(scopePath(s), s);
  if (request.subject !== undefined) {
    const subject = request.subject;
    const current: StateRef[] = [];
    const inForce: StateRef[] = [];
    const done: StateRef[] = [];
    const dependsOn: DependencyRef[] = [];
    const invalidatedBy = new Set<string>();
    /** authorization-before-retrieval: the grant check runs before the record is examined. */
    const admit = (facet: StateFacet, record: { id: string }): Scope | null => {
      const scope = recordScope(record, repo);
      if (!granted(request.principal, scope)) { denied.set(scopePath(scope), scope); return null; }
      return scope;
    };
    const keep = (facet: StateFacet, record: { id: string }, scope: Scope): StateRef => {
      records[record.id] = record as unknown as Record<string, unknown>;
      return refOf(facet, record, scope);
    };
    if (facets.has("decisions")) for (const d of store.recs("decisions")) {
      if (d.topic !== subject && d.id !== subject) continue;
      const scope = admit("decisions", d); if (!scope) continue;
      if (isLive(d)) current.push(keep("decisions", d, scope));
    }
    if (facets.has("constraints")) for (const c of store.recs("constraints")) {
      if (c.id !== subject && !c.scope.includes(subject)) continue;
      const scope = admit("constraints", c); if (!scope) continue;
      if (c.status === "active" && c.valid_to == null) inForce.push(keep("constraints", c, scope));
    }
    if (facets.has("receipts")) for (const r of store.recs("receipts")) {
      const targets = r.id === subject || r.invalidates.includes(subject) || `${r.target.object_type}:${r.target.object_key}` === subject;
      if (!targets) continue;
      const scope = admit("receipts", r); if (!scope) continue;
      if (r.state === "succeeded" || r.state === "verified") done.push(keep("receipts", r, scope));
      if (r.invalidates.includes(subject)) invalidatedBy.add(r.id);
    }
    if (facets.has("commitments")) for (const c of store.recs("commitments")) {
      if (c.subject !== subject && c.id !== subject) continue;
      const scope = admit("commitments", c); if (!scope) continue;
      if ((c.status === "open" || c.status === "waiting") && c.valid_to == null) inForce.push(keep("commitments", c, scope));
    }
    if (facets.has("derived")) for (const d of store.recs("derived")) {
      if (d.subject !== subject && d.id !== subject) continue;
      const scope = admit("derived", d); if (!scope) continue;
      if (d.state === "current" && d.valid_to == null) { current.push(keep("derived", d, scope)); dependsOn.push(...d.dependencies); }
    }
    if (facets.has("entities")) for (const e of store.recs("entities")) {
      if (e.id !== subject) continue;
      const scope = admit("entities", e); if (!scope) continue;
      if (e.lifecycle === "active") current.push(keep("entities", e, scope));
    }
    if (facets.has("relationships")) for (const r of store.recs("relationships")) {
      if (r.from !== subject && r.to !== subject) continue;
      const scope = admit("relationships", r); if (!scope) continue;
      current.push(keep("relationships", r, scope));
    }
    stateOfRecord = { subject, current, in_force: inForce, done, depends_on: dependsOn, invalidated_by: [...invalidatedBy].sort() };
  }
  const response = ReadResponseSchema.parse({
    schema: STATE_READ_VERSION,
    receipt_id: envelope.receipt_id,
    scope: request.scope,
    state_of_record: stateOfRecord,
    denied_scopes: [...denied.values()],
    ...(stateOfRecord ? { records } : {}),
    ...(request.scopes ? { scopes: [request.scope], receipts: [{ scope: request.scope, receipt_id: envelope.receipt_id }] } : {}),
  });
  assertReadWithinGrants(request.principal, response);
  return { response, envelope };
}

/** Union read — one state_of_record across several partitions, each read by `readState` against
 *  its own store. Pure: no store, no grants decided here (every input already passed its own
 *  grant check). The primary's receipt, scope and envelope lead; refs concatenate (each already
 *  carries its partition), `depends_on` concatenates, `invalidated_by` is a sorted union, `records`
 *  merge by id (first writer wins — ids are identity, two copies are the same record),
 *  `denied_scopes` is the union of every partition's denied plus `extraDenied` (requested-but-
 *  ungranted scopes the host refused to open), `scopes` names the partitions read and `receipts`
 *  carries one delivery receipt per partition. Reusable by any host (HTTP today; MCP or CLI
 *  fronting several roots later). */
export function mergeReadResponses(primary: ReadResponse, others: readonly ReadResponse[], extraDenied: readonly Scope[] = []): ReadResponse {
  const all = [primary, ...others];
  const scopes = new Map<string, Scope>();
  const receipts = new Map<string, { scope: Scope; receipt_id: string }>();
  for (const r of all) {
    for (const s of r.scopes ?? [r.scope]) if (!scopes.has(scopePath(s))) scopes.set(scopePath(s), s);
    for (const x of r.receipts ?? [{ scope: r.scope, receipt_id: r.receipt_id }]) if (!receipts.has(scopePath(x.scope))) receipts.set(scopePath(x.scope), x);
  }
  const denied = new Map<string, Scope>();
  for (const s of [...all.flatMap((r) => r.denied_scopes), ...extraDenied]) if (!scopes.has(scopePath(s)) && !denied.has(scopePath(s))) denied.set(scopePath(s), s);

  const sors = all.map((r) => r.state_of_record).filter((s): s is NonNullable<ReadResponse["state_of_record"]> => s !== null);
  let stateOfRecord: ReadResponse["state_of_record"] = null;
  const records: Record<string, Record<string, unknown>> = {};
  if (sors.length) {
    const refKey = (ref: StateRef): string => `${ref.facet}|${scopePath(ref.scope)}|${ref.id}`;
    const dedupeRefs = (pick: (s: NonNullable<ReadResponse["state_of_record"]>) => StateRef[]): StateRef[] => {
      const seen = new Set<string>();
      const out: StateRef[] = [];
      for (const ref of sors.flatMap(pick)) { const k = refKey(ref); if (!seen.has(k)) { seen.add(k); out.push(ref); } }
      return out;
    };
    const seenDeps = new Set<string>();
    const dependsOn: DependencyRef[] = [];
    for (const dep of sors.flatMap((s) => s.depends_on)) { const k = stateHash(dep); if (!seenDeps.has(k)) { seenDeps.add(k); dependsOn.push(dep); } }
    stateOfRecord = {
      subject: sors[0]!.subject,
      current: dedupeRefs((s) => s.current),
      in_force: dedupeRefs((s) => s.in_force),
      done: dedupeRefs((s) => s.done),
      depends_on: dependsOn,
      invalidated_by: [...new Set(sors.flatMap((s) => s.invalidated_by))].sort(),
    };
    for (const r of all) for (const [id, record] of Object.entries(r.records ?? {})) if (!(id in records)) records[id] = record;
  }
  return ReadResponseSchema.parse({
    schema: STATE_READ_VERSION,
    receipt_id: primary.receipt_id,
    scope: primary.scope,
    state_of_record: stateOfRecord,
    denied_scopes: [...denied.values()],
    ...(stateOfRecord ? { records } : {}),
    scopes: [...scopes.values()],
    receipts: [...receipts.values()],
  });
}

// ---- write ---------------------------------------------------------------------------------

export interface WriteOptions {
  /** Durability step after the record is on disk (auto-commit / push). Absent = "local". */
  flush?: (isPrivate: boolean, message: string) => "pushed" | "committed" | null;
  now?: () => Date;
}

/** What a record is ABOUT, for subscribers filtering by subject. Mirrors the read verb's matching. */
function subjectOf(facet: StateFacet, record: unknown): string | undefined {
  const r = record as Record<string, unknown>;
  switch (facet) {
    case "commitments": case "derived": return typeof r.subject === "string" ? r.subject : undefined;
    case "entities": return typeof r.id === "string" ? r.id : undefined;
    case "relationships": return typeof r.from === "string" ? r.from : undefined;
    case "receipts": { const t = r.target as { object_type?: string; object_key?: string } | undefined; return t?.object_type && t.object_key ? `${t.object_type}:${t.object_key}` : undefined; }
    case "decisions": return typeof r.topic === "string" ? r.topic : undefined;
    default: return undefined;
  }
}

/** Top-level fields whose canonical hash differs between two records, sorted. */
function differingFields(a: Record<string, unknown>, b: Record<string, unknown>): string[] {
  const keys = new Set([...Object.keys(a), ...Object.keys(b)]);
  return [...keys].filter((k) => stateHash(a[k] ?? null) !== stateHash(b[k] ?? null)).sort();
}

/** Records the store can close a valid-time window on when superseded. */
function closeWindow(store: HunchStore, facet: StateFacet, incumbentId: string, byId: string, at: string, isPrivate: boolean): boolean {
  if (facet === "decisions") {
    const by = store.getRec("decisions", byId);
    if (!by) return false;
    return (isPrivate ? store.supersedePrivate(incumbentId, by) : store.supersede(incumbentId, by)) !== null;
  }
  const old = store.getRec(facet as EntityKind, incumbentId) as Record<string, unknown> | undefined;
  if (!old || !("valid_to" in old)) return false;
  const closed = { ...old, valid_to: old.valid_to ?? at, ...(facet === "derived" ? { state: "stale" } : {}) };
  store.putCapture(facet as EntityKind, closed as EntityFor[EntityKind], isPrivate);
  return true;
}

/** Normalize + validate the record for its facet; enforce the identity rule (an id, when
 *  given, must be the one the record's facts derive). Returns the canonical record. */
function normalizeRecord(facet: StateFacet, scope: Scope, raw: Record<string, unknown>, principal: Principal): EntityFor[EntityKind] {
  const record: Record<string, unknown> = { ...raw };
  if (LEGACY_FACETS.has(facet)) {
    // Legacy records carry no partition scope (a constraint's `scope` is its path globs);
    // the repository scope is implied, so an echoed partition is dropped, not stored.
    if (ScopeSchema.safeParse(record.scope).success) delete record.scope;
  } else {
    record.scope = scope;
  }
  // Authorship tier (memory supply chain): only a human principal may sign as
  // human_confirmed through this path; an agent's write is agent testimony.
  const prov = record.provenance as { source?: string } | undefined;
  if (prov && typeof prov.source === "string" && principal.kind !== "human" && prov.source.split("+").includes("human_confirmed")) {
    record.provenance = { ...prov, source: prov.source.split("+").map((t) => (t === "human_confirmed" ? "agent_recorded" : t)).join("+") };
  }
  let expectedId: string | null = null;
  try {
    if (facet === "receipts") expectedId = actionReceiptId(record as never);
    else if (facet === "commitments") expectedId = commitmentId(record as never);
    else if (facet === "derived") expectedId = derivedId(record as never);
    else if (facet === "decisions" && typeof record.id !== "string") expectedId = decisionId(String(record.topic ?? record.title ?? ""));
  } catch (e) {
    throw new StateRefusal("malformed", `cannot derive ${facet} identity: ${(e as Error).message}`);
  }
  if (expectedId) {
    if (typeof record.id === "string" && record.id !== expectedId) throw new StateRefusal("identity", `${facet} id ${record.id} is not the identity its facts derive (${expectedId}); ids are derived, never chosen`);
    record.id = expectedId;
  }
  const parsed = SCHEMAS[facet as EntityKind].safeParse(record);
  if (!parsed.success) throw new StateRefusal("malformed", `${facet} record is malformed: ${parsed.error.issues.map((i) => `${i.path.join(".") || "record"}: ${i.message}`).join("; ")}`);
  if (facet === "derived") {
    try { assertDerivedState(parsed.data as EntityFor["derived"]); } catch (e) { throw new StateRefusal("malformed", (e as Error).message); }
  }
  return parsed.data as EntityFor[EntityKind];
}

/** write — provenance + idempotency in, durability out. A replay returns the original;
 *  a conflict names the incumbent; nothing is ever silently overwritten or duplicated. */
export function writeState(store: HunchStore, input: unknown, opts: WriteOptions = {}): WriteResult {
  const request: WriteRequest = WriteRequestSchema.parse(input);
  try { assertWriteWellFormed(request); } catch (e) {
    throw new StateRefusal(/grants/.test((e as Error).message) ? "outside-grants" : "malformed", (e as Error).message);
  }
  const { home, hunchDir, isPrivate } = homeFor(store, request.scope);
  const now = (opts.now ?? (() => new Date()))().toISOString();
  const facet = request.facet;
  if (!(ENTITY_KINDS as readonly string[]).includes(facet)) throw new StateRefusal("unsupported", `facet ${facet} is not a store kind`);
  const record = normalizeRecord(facet, request.scope, request.record, request.principal);
  const id = (record as { id: string }).id;
  const hash = stateHash(record);
  const ledger = readLedger(hunchDir, request.scope);
  const durability = () => opts.flush?.(isPrivate, `nuryel: write ${id}`) ?? "local";
  const result = (outcome: WriteResult["outcome"], conflict: WriteResult["conflict"] = null, rid = id, rhash = hash): WriteResult =>
    WriteResultSchema.parse({ schema: STATE_WRITE_VERSION, record_id: rid, record_hash: rhash, durability: durability(), outcome, conflict, record: store.getRec(facet as EntityKind, rid) ?? record });

  // Idempotency: the same key replays the original; the same key with a different payload
  // is a refusal, never a second record.
  const seen = ledger.idempotency[request.idempotency_key];
  if (seen) {
    if (seen.record_hash === hash && seen.record_id === id) return result("replayed");
    // Say WHAT differs and what to do: a stable key with a varying payload (a timestamp, new
    // wording) is the trap every writer falls into once; the refusal must teach the way out.
    const stored = store.getRec(facet as EntityKind, seen.record_id) as Record<string, unknown> | undefined;
    const differing = stored ? differingFields(stored, record as Record<string, unknown>) : [];
    const where = differing.length ? ` — this payload differs in: ${differing.join(", ")}` : (seen.record_id !== id ? ` — this payload derives a different identity (${id})` : "");
    throw new StateRefusal("idempotency", `idempotency key "${request.idempotency_key}" was already used for ${seen.record_id}${where}. A key names ONE request payload: re-send the original payload to replay it, or use a new key to write this payload (the record keeps its derived id and is updated in place).`, { incumbent_id: seen.record_id, reason: "idempotency key reused with a different payload" });
  }

  const existing = store.recsInHome(facet as EntityKind, home).find((r) => (r as { id: string }).id === id) as Record<string, unknown> | undefined;
  if (existing && stateHash(existing) === hash) {
    appendChanges(hunchDir, request.scope, [], { key: request.idempotency_key, entry: { record_id: id, record_hash: hash, facet } }, now);
    return result("replayed");
  }
  if (existing && request.expected_version !== null) {
    const ok = typeof request.expected_version === "number"
      ? latestSeqFor(ledger, id) === request.expected_version
      : stateHash(existing) === request.expected_version;
    if (!ok) throw new StateRefusal("conflict", `expected_version does not match the incumbent ${id}`, { incumbent_id: id, reason: "expected_version mismatch" });
  }

  // one-live-decision-per-topic — refuse with the incumbent named; supersession is explicit.
  let supersedes: string | null = request.supersedes ?? null;
  if (facet === "decisions") {
    const d = record as EntityFor["decisions"];
    if (d.topic && d.status === "accepted") {
      const willClose = supersedes && store.recsInHome("decisions", home).some((x) => x.id === supersedes) ? supersedes : null;
      const conflicts = captureConflicts(store.recsInHome("decisions", home), d.topic, d.id, willClose);
      if (conflicts.length) {
        throw new StateRefusal("conflict", `topic ${d.topic} already has a live decision ${conflicts[0]!.id}; pass supersedes to replace it`, { incumbent_id: conflicts[0]!.id, reason: "one-live-decision-per-topic" });
      }
    }
  }
  if (supersedes && !store.recsInHome(facet as EntityKind, home).some((r) => (r as { id: string }).id === supersedes)) {
    throw new StateRefusal("conflict", `supersedes ${supersedes} is not a ${facet} record in this partition`, { incumbent_id: supersedes, reason: "supersede target absent" });
  }
  if (supersedes === id) supersedes = null;

  store.putCapture(facet as EntityKind, record, isPrivate);
  const changes: PendingChange[] = [];
  const cause = { kind: "write" as const, principal: request.principal.id };
  const invalidates = facet === "receipts" ? (record as EntityFor["receipts"]).invalidates : [];
  const subject = subjectOf(facet, record);
  if (supersedes) {
    const closed = closeWindow(store, facet, supersedes, id, now, isPrivate);
    if (closed) {
      const old = store.getRec(facet as EntityKind, supersedes)!;
      changes.push({ facet, record_id: supersedes, record_hash: stateHash(old), change: "superseded", subject: subjectOf(facet, old), invalidates: [], cause });
    }
  }
  changes.push({ facet, record_id: id, record_hash: hash, change: existing ? "updated" : "created", subject, invalidates, cause });
  appendChanges(hunchDir, request.scope, changes, { key: request.idempotency_key, entry: { record_id: id, record_hash: hash, facet } }, now);
  store.reindex();
  return result(supersedes ? "superseded" : existing ? "updated" : "created");
}

// ---- subscribe -----------------------------------------------------------------------------

/** subscribe — the scope's ordered change stream after a cursor. Unfiltered, the events are
 *  contiguous and assertChangeSequence holds; filtered, `head_seq` is still the cursor. */
export function subscribeState(store: HunchStore, input: unknown): SubscribeResponse {
  const request: SubscribeRequest = SubscribeRequestSchema.parse(input);
  if (!granted(request.principal, request.scope)) throw new StateRefusal("outside-grants", `scope ${scopePath(request.scope)} is outside the principal's grants`);
  const { hunchDir } = homeFor(store, request.scope);
  const ledger = readLedger(hunchDir, request.scope);
  const facets = request.facets ? new Set<string>(request.facets) : null;
  const subjects = request.subjects ? new Set(request.subjects) : null;
  const filtered = !!(facets || subjects);
  const resync = request.after_seq < ledger.floor_seq;
  const after = resync ? ledger.floor_seq : request.after_seq;
  const events: ChangeEvent[] = ledger.events.filter((e) =>
    e.seq > after
    && (!facets || facets.has(e.facet))
    && (!subjects || subjects.has(e.record_id) || (e.subject !== undefined && subjects.has(e.subject)) || e.invalidates.some((s) => subjects.has(s))));
  return SubscribeResponseSchema.parse({ schema: STATE_SUBSCRIBE_VERSION, scope: request.scope, head_seq: ledger.head_seq, events, filtered, floor_seq: ledger.floor_seq, resync });
}

// ---- records ------------------------------------------------------------------------------

/** records — fetch by id, grants first. Every id is accounted for: found, denied (its scope is
 *  outside the grants — named, never described) or missing. */
export function recordsState(store: HunchStore, input: unknown): RecordsResponse {
  const request: RecordsRequest = RecordsRequestSchema.parse(input);
  if (!granted(request.principal, request.scope)) throw new StateRefusal("outside-grants", `scope ${scopePath(request.scope)} is outside the principal's grants`);
  const repo = partitionOf(store);
  const records: Record<string, Record<string, unknown>> = {};
  const facets: Record<string, StateFacet> = {};
  const denied: string[] = [];
  const missing: string[] = [];
  for (const id of new Set(request.ids)) {
    let found: { facet: StateFacet; record: Record<string, unknown> } | null = null;
    for (const facet of STATE_FACETS) {
      const record = store.getRec(facet as EntityKind, id) as Record<string, unknown> | undefined;
      if (record) { found = { facet, record }; break; }
    }
    if (!found) { missing.push(id); continue; }
    const scope = recordScope(found.record, repo);
    if (!granted(request.principal, scope)) { denied.push(id); continue; }
    records[id] = found.record;
    facets[id] = found.facet;
  }
  return RecordsResponseSchema.parse({ schema: STATE_RECORDS_VERSION, scope: request.scope, records, facets, missing, denied });
}
