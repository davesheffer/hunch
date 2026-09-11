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
  ScopeSchema, scopePath, stateHash, actionReceiptId, commitmentId, derivedId, relationshipId, externalKey, subjectOfRef,
  assertReadWithinGrants, assertWriteWellFormed, assertDerivedState, isHumanConfirmed,
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

/** Where a scope's records and ledger live in this store (exported for the replay check, which
 *  must read the SAME home the write verb wrote — never a second routing rule). */
export function stateHomeFor(store: HunchStore, scope: Scope): { home: "public" | "private"; hunchDir: string; isPrivate: boolean } {
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


/** Follow `merged_into` to the entity that stands for this one now (cycle-safe, bounded). */
function survivorOf(byId: Map<string, EntityFor["entities"]>, entity: EntityFor["entities"]): EntityFor["entities"] {
  let current = entity;
  const seen = new Set<string>([current.id]);
  while (current.lifecycle === "retired" && current.merged_into) {
    const next = byId.get(current.merged_into);
    if (!next || seen.has(next.id)) break;
    seen.add(next.id);
    current = next;
  }
  return current;
}

/** The entities in the principal's grants that stand for an external key or an entity id — active
 *  ones directly, retired-and-merged ones through the survivor they name. */
function entityIndex(store: HunchStore, principal: Principal, repo: Scope): { byKey: Map<string, EntityFor["entities"]>; bySubject: Map<string, EntityFor["entities"]>; byId: Map<string, EntityFor["entities"]>; survivor: (e: EntityFor["entities"]) => EntityFor["entities"] } {
  const byId = new Map<string, EntityFor["entities"]>();
  for (const e of store.recs("entities")) if (granted(principal, recordScope(e, repo))) byId.set(e.id, e);
  const survivor = (e: EntityFor["entities"]): EntityFor["entities"] => survivorOf(byId, e);
  const byKey = new Map<string, EntityFor["entities"]>();
  const bySubject = new Map<string, EntityFor["entities"]>();
  for (const e of byId.values()) {
    const stands = e.lifecycle === "active" ? e : (e.lifecycle === "retired" && e.merged_into ? survivor(e) : null);
    if (!stands || stands.lifecycle !== "active") continue;
    for (const ref of e.refs) {
      if (!byKey.has(externalKey(ref)) || e.lifecycle === "active") byKey.set(externalKey(ref), stands);
      if (!bySubject.has(subjectOfRef(ref)) || e.lifecycle === "active") bySubject.set(subjectOfRef(ref), stands);
    }
  }
  return { byKey, bySubject, byId, survivor };
}

/** The names one subject is filed under: itself, the entity that stands for it (through merges),
 *  every entity merged into that one, and every key any of them carries. Explicit refs only. */
function subjectAliases(store: HunchStore, principal: Principal, repo: Scope, subject: string): Set<string> {
  const aliases = new Set([subject]);
  const { bySubject, byId, survivor } = entityIndex(store, principal, repo);
  const named = bySubject.get(subject) ?? byId.get(subject);
  if (!named) return aliases;
  const stands = survivor(named);
  if (stands.lifecycle !== "active") return aliases;
  for (const e of byId.values()) {
    if (e.id !== stands.id && survivor(e).id !== stands.id) continue;
    aliases.add(e.id);
    for (const ref of e.refs) aliases.add(subjectOfRef(ref));
  }
  return aliases;
}

/** read — the system-of-record answer for a subject, under the delivery envelope's receipt.
 *  Grants are the first predicate on every candidate; a matching record in a scope the
 *  principal lacks is NAMED in denied_scopes and never described. */
export function readState(store: HunchStore, input: unknown): { response: ReadResponse; envelope: DeliveryEnvelope } {
  const request: ReadRequest = ReadRequestSchema.parse(input);
  if (!granted(request.principal, request.scope)) throw new StateRefusal("outside-grants", `scope ${scopePath(request.scope)} is outside the principal's grants`);
  if (request.observed_page && (request.subject === undefined || request.scopes !== undefined || (request.facets && !request.facets.includes('derived')))) {
    throw new StateRefusal('malformed', 'observation pages require a subject, the derived facet and a single partition without scopes');
  }
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
    // Subject identity by external reference: a read for an external record's key (`event:26904`,
    // `customer:Site:7`) also finds what is filed under the entity that carries that ref, and a
    // read for the entity id finds what was filed under its keys — one explicit hop, grants first.
    const aliases = subjectAliases(store, request.principal, repo, subject);
    const isSubject = (s: string | undefined): boolean => s !== undefined && aliases.has(s);
    // One hop only. Do not broaden aliases: a linked observation does not merge subjects,
    // bring unrelated facts, receipts or commitments, or traverse another relationship.
    const linkedObservations = new Map<string, Set<string>>();
    for (const r of store.recs("relationships")) {
      if (!granted(request.principal, r.scope) || scopePath(r.scope) !== scopePath(request.scope)) continue;
      if (r.type !== "observation_about" || r.lifecycle === "retired" || !isSubject(r.to) || !r.observation_hash) continue;
      const hashes = linkedObservations.get(r.from) ?? new Set<string>();
      hashes.add(r.observation_hash); linkedObservations.set(r.from, hashes);
    }
    const current: StateRef[] = [];
    const inForce: StateRef[] = [];
    const done: StateRef[] = [];
    const observations: EntityFor["derived"][] = [];
    let relationshipsTruncated = false;
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
      const targets = r.id === subject || r.invalidates.some(isSubject) || isSubject(subjectOfRef(r.target));
      if (!targets) continue;
      const scope = admit("receipts", r); if (!scope) continue;
      if (r.state === "succeeded" || r.state === "verified") { done.push(keep("receipts", r, scope)); dependsOn.push(...(r.rests_on ?? [])); }
      if (r.invalidates.some(isSubject)) invalidatedBy.add(r.id);
    }
    if (facets.has("commitments")) for (const c of store.recs("commitments")) {
      if (!isSubject(c.subject) && c.id !== subject) continue;
      const scope = admit("commitments", c); if (!scope) continue;
      if ((c.status === "open" || c.status === "waiting") && c.valid_to == null) inForce.push(keep("commitments", c, scope));
      // A commitment fulfilled by a receipt is part of what HAPPENED for the subject: it
      // leaves in_force and joins done beside the receipt that closed it (the chain's last link).
      else if (c.status === "done" && c.closed_by) done.push(keep("commitments", c, scope));
    }
    if (facets.has("derived")) for (const d of store.recs("derived")) {
      const scope = admit("derived", d); if (!scope) continue;
      if (request.observed_page && scopePath(scope) !== scopePath(request.scope)) continue;
      const direct = isSubject(d.subject) || d.id === subject;
      const linked = scopePath(scope) === scopePath(request.scope) && linkedObservations.get(d.id)?.has(stateHash(d));
      if (!direct && !linked) continue;
      if (!direct) { if (d.state === "unknown" && d.valid_to == null) observations.push(d); continue; }
      if (d.state === "current" && d.valid_to == null) { current.push(keep("derived", d, scope)); dependsOn.push(...d.dependencies); }
      else if (d.state === "unknown" && d.valid_to == null) observations.push(d);
    }
    if (facets.has("entities")) for (const e of store.recs("entities")) {
      if (!isSubject(e.id)) continue;
      const scope = admit("entities", e); if (!scope) continue;
      if (e.lifecycle === "active") current.push(keep("entities", e, scope));
    }
    if (facets.has("relationships")) for (const r of store.recs("relationships")) {
      if (r.lifecycle === "retired") continue;
      if (!isSubject(r.from) && !isSubject(r.to)) continue;
      const scope = admit("relationships", r); if (!scope) continue;
      if (current.length >= 256) { relationshipsTruncated = true; continue; }
      current.push(keep("relationships", r, scope));
    }
    observations.sort((a, b) => Date.parse(b.computed_at) - Date.parse(a.computed_at) || a.id.localeCompare(b.id));
    let offset = 0;
    let page: NonNullable<ReadResponse['state_of_record']>['observed_page'];
    if (request.observed_page) {
      // Fingerprint the authorized membership AND record contents. A change between
      // pages is a conflict, never a silently skipped or duplicated observation.
      const snapshot_hash = stateHash({ scope: request.scope, subject, observations });
      const cursor = request.observed_page.cursor;
      if (cursor && cursor.snapshot_hash !== snapshot_hash) throw new StateRefusal('conflict', 'observations changed between pages; restart from the first page');
      offset = cursor?.offset ?? 0;
      if (offset > observations.length) throw new StateRefusal('malformed', 'observation cursor is outside this snapshot');
      page = { snapshot_hash, total: observations.length, next_cursor: offset + 64 < observations.length ? { snapshot_hash, offset: offset + 64 } : null };
    }
    const observed = observations.slice(offset, offset + 64).map(d => keep("derived", d, recordScope(d, repo)));
    stateOfRecord = { subject, current, in_force: inForce, done, depends_on: dependsOn, invalidated_by: [...invalidatedBy].sort(),
      ...(relationshipsTruncated ? { relationships_truncated: true } : {}),
      ...(observed.length || page ? { observed, observed_truncated: observations.length > offset + observed.length } : {}),
      ...(page ? { observed_page: page } : {}) };
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
      ...(sors.some(s => s.relationships_truncated) ? { relationships_truncated: true } : {}),
      ...(sors.some(s => s.observed?.length) ? { observed: dedupeRefs(s => s.observed ?? []).slice(0, 64),
        observed_truncated: sors.some(s => s.observed_truncated) || dedupeRefs(s => s.observed ?? []).length > 64 } : {}),
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
  /** Internal batch owner rebuilds once in finally while holding the write lock. */
  deferReindex?: boolean;
  /** Internal cache scoped to one uninterrupted partition write lock. Never retained. */
  ledgerCache?: { ledger?: ReturnType<typeof readLedger> };
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
    case "relationships": return r.type === "observation_about" && typeof r.to === "string" ? r.to : typeof r.from === "string" ? r.from : undefined;
    case "receipts": { const t = r.target as { object_type?: string; object_key?: string } | undefined; return t?.object_type && t.object_key ? `${t.object_type}:${t.object_key}` : undefined; }
    case "decisions": return typeof r.topic === "string" ? r.topic : undefined;
    default: return undefined;
  }
}

/** Which facet a record id belongs to, from its prefix; `null` for a kind-qualified entity id
 *  or an unknown shape (those are looked up across every facet). */
function facetOfId(id: string): StateFacet | null {
  const prefix = /^([a-z]+)_/.exec(id)?.[1];
  switch (prefix) {
    case "dec": return "decisions";
    case "con": return "constraints";
    case "bug": return "bugs";
    case "fnd": return "findings";
    case "nrc": return "receipts";
    case "ncm": return "commitments";
    case "nds": return "derived";
    case "edge": return "relationships";
    default: return null;
  }
}

/** Find a record by id in this store, with the facet it lives in. */
function findRecord(store: HunchStore, id: string): { facet: StateFacet; record: Record<string, unknown> } | null {
  const facets: StateFacet[] = facetOfId(id) ? [facetOfId(id)!] : [...STATE_FACETS];
  for (const facet of facets) {
    const record = store.getRec(facet as EntityKind, id) as Record<string, unknown> | undefined;
    if (record) return { facet, record };
  }
  return null;
}

/** A receipt's `rests_on` record refs: one in a partition this store holds must exist there
 *  with the hash the writer saw (a stale hash means the decision moved — re-read); one in a
 *  partition the store does not hold is a pointer for the reader to resolve. Grants first: a
 *  ref into a partition the principal is not granted is refused by scope, never by content. */
function assertRestsOn(store: HunchStore, principal: Principal, scope: Scope, restsOn: readonly DependencyRef[]): void {
  const repo = partitionOf(store);
  for (const dep of restsOn) {
    if (dep.kind !== "record") continue;
    const refScope = dep.scope ?? scope;
    if (!granted(principal, refScope)) throw new StateRefusal("outside-grants", `rests_on ${dep.id} points into ${scopePath(refScope)}, which is outside the principal's grants`);
    const found = findRecord(store, dep.id);
    if (!found) {
      const held = scopePath(refScope) === scopePath(scope) || scopePath(refScope) === scopePath(repo) || (store.hasPrivate && refScope.kind !== "repository");
      if (held) throw new StateRefusal("conflict", `rests_on ${dep.id} is not on record in ${scopePath(refScope)}: a receipt rests on state that exists; write or re-read it first`, { incumbent_id: dep.id, reason: "rests_on target absent" });
      continue; // a partition this store does not hold: a pointer, resolved by the reader
    }
    const actualScope = recordScope(found.record, repo);
    if (scopePath(actualScope) !== scopePath(refScope)) throw new StateRefusal("conflict", `rests_on ${dep.id} lives in ${scopePath(actualScope)}, not ${scopePath(refScope)}`, { incumbent_id: dep.id, reason: "rests_on scope mismatch" });
    const actualHash = stateHash(found.record);
    if (actualHash !== dep.record_hash) throw new StateRefusal("conflict", `rests_on ${dep.id} has moved: the record on file hashes ${actualHash}, not ${dep.record_hash} — re-read it and rest on what is current`, { incumbent_id: dep.id, reason: "rests_on hash mismatch" });
  }
}

/** A commitment closed by a receipt: `closed_by` must name a succeeded/verified receipt the
 *  principal can see, and the status must be done — a closure is a fact that happened, never
 *  an opinion. Returns the receipt id when the closure is well-formed. */
function assertClosedBy(store: HunchStore, principal: Principal, commitment: EntityFor["commitments"]): string | null {
  if (!commitment.closed_by) return null;
  if (commitment.status !== "done") throw new StateRefusal("malformed", `closed_by names a receipt but status is ${commitment.status}: a commitment closed by a receipt is done`);
  const receipt = store.getRec("receipts", commitment.closed_by) as EntityFor["receipts"] | undefined;
  const scope = receipt ? recordScope(receipt, partitionOf(store)) : null;
  if (!receipt || !scope || !granted(principal, scope)) {
    throw new StateRefusal("conflict", `closed_by ${commitment.closed_by} is not a receipt on record within the principal's grants: a commitment is closed by an action that happened — write the receipt first, then close with its id`, { incumbent_id: commitment.closed_by, reason: "closed_by receipt absent" });
  }
  if (receipt.state !== "succeeded" && receipt.state !== "verified") {
    throw new StateRefusal("conflict", `closed_by ${commitment.closed_by} is ${receipt.state}, not succeeded or verified: only an action that happened closes a commitment`, { incumbent_id: commitment.closed_by, reason: `closed_by receipt ${receipt.state}` });
  }
  return commitment.closed_by;
}

/** one-entity-per-external-ref. An entity: no other active entity in the partition may carry one
 *  of its external keys (the incumbent is named; merge/split are explicit, later). A commitment or
 *  derived statement: its subject may not be the external key of a record an entity already
 *  carries — the entity's id is the subject, and the refusal names it (the writer re-derives;
 *  ids derive from the subject, so nothing is rewritten under it). A subject no entity claims
 *  stays a free-form key: explicit refs only, no guessing. */
function assertExternalIdentity(store: HunchStore, principal: Principal, scope: Scope, facet: StateFacet, record: EntityFor[EntityKind]): void {
  const repo = partitionOf(store);
  const inPartition = (e: EntityFor["entities"]): boolean => scopePath(recordScope(e, repo)) === scopePath(scope);
  if (facet === "entities") {
    const entity = record as EntityFor["entities"];
    if (entity.merged_into !== undefined) {
      const target = store.recs("entities").find((e) => e.id === entity.merged_into);
      if (!target || !inPartition(target)) throw new StateRefusal("conflict", `merged_into ${entity.merged_into} is not an entity on record in ${scopePath(scope)}: a merge names a survivor that exists — write it first`, { incumbent_id: entity.merged_into, reason: "merge survivor absent" });
      if (!granted(principal, recordScope(target, repo))) throw new StateRefusal("outside-grants", `merged_into ${entity.merged_into} is outside the principal's grants`);
      if (target.lifecycle !== "active") throw new StateRefusal("conflict", `merged_into ${entity.merged_into} is ${target.lifecycle}${target.merged_into ? ` (merged into ${target.merged_into})` : ""}: the survivor of a merge is an active entity — merge into the one that stands now`, { incumbent_id: target.merged_into ?? target.id, reason: "merge survivor not active" });
    }
    if (entity.lifecycle !== "active") return;
    const keys = new Set(entity.refs.map(externalKey));
    for (const other of store.recs("entities")) {
      if (other.id === entity.id || other.lifecycle !== "active" || !inPartition(other)) continue;
      const shared = other.refs.map(externalKey).find((k) => keys.has(k));
      if (shared) throw new StateRefusal("conflict", `${shared} is already carried by entity ${other.id} in ${scopePath(scope)}: one external record is one entity — write under ${other.id}, or retire it first (merge and split are explicit)`, { incumbent_id: other.id, reason: "one-entity-per-external-ref" });
    }
    return;
  }
  if (facet !== "commitments" && facet !== "derived") return;
  const subject = (record as { subject: string }).subject;
  const { bySubject, byId, survivor } = entityIndex(store, principal, repo);
  const byKey = bySubject.get(subject);
  if (byKey && byKey.id !== subject && inPartition(byKey)) {
    throw new StateRefusal("identity", `subject ${subject} is the external key of entity ${byKey.id} in ${scopePath(scope)}: the entity's id is the subject — re-derive with subject ${byKey.id}`, { incumbent_id: byKey.id, reason: "subject is an entity's external key" });
  }
  const named = byId.get(subject);
  if (named && named.lifecycle === "retired" && named.merged_into && inPartition(named)) {
    const stands = survivor(named);
    if (stands.id !== named.id && stands.lifecycle === "active") {
      throw new StateRefusal("identity", `subject ${subject} was merged into ${stands.id}: new state goes under the survivor — re-derive with subject ${stands.id}`, { incumbent_id: stands.id, reason: "subject was merged" });
    }
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
    else if (facet === "relationships") expectedId = relationshipId(String(record.from), String(record.to), String(record.type));
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
  const { home, hunchDir, isPrivate } = stateHomeFor(store, request.scope);
  const now = (opts.now ?? (() => new Date()))().toISOString();
  const facet = request.facet;
  const getHere = (id: string) => facet === "derived" || facet === "receipts" || facet === "commitments"
    ? store.getStateDirect(facet, id, home)
    : home === "private" ? store.getPrivateRec(facet as EntityKind, id) : store.json.get(facet as EntityKind, id);
  if (!(ENTITY_KINDS as readonly string[]).includes(facet)) throw new StateRefusal("unsupported", `facet ${facet} is not a store kind`);
  const record = normalizeRecord(facet, request.scope, request.record, request.principal);
  let replayLink: EntityFor["relationships"] | undefined;
  if (facet === "relationships" && (record as EntityFor["relationships"]).type === "observation_about") {
    const link = record as EntityFor["relationships"];
    const observation = store.getStateDirect("derived", link.from, home);
    if (!observation || scopePath(observation.scope) !== scopePath(request.scope) || !granted(request.principal, observation.scope)) throw new StateRefusal("conflict", "observation is absent from the granted partition");
    if (!observation.transform_version.startsWith("agent-capture/1:")) throw new StateRefusal("malformed", "only captured observations can be linked");
    if (link.lifecycle !== "retired" && (observation.state !== "unknown" || observation.valid_to != null || stateHash(observation) !== link.observation_hash)) throw new StateRefusal("conflict", "observation changed or is no longer eligible; re-read before linking");
    const prior = getHere(link.id) as EntityFor["relationships"] | undefined;
    if (prior?.lifecycle === "retired" && link.lifecycle !== "retired" && request.expected_version === null) throw new StateRefusal("conflict", "retired observation link requires an explicit expected_version to reactivate");
    // Repeated reads and different agents do not rewrite an identical association.
    // Preserve its first author/evidence time and avoid index/Git work on replay.
    if (prior && prior.from === link.from && prior.to === link.to && prior.type === link.type && prior.reason === link.reason
      && prior.observation_hash === link.observation_hash && prior.lifecycle === link.lifecycle
      && prior.evidence && link.evidence && externalKey(prior.evidence) === externalKey(link.evidence) && prior.evidence.content_hash === link.evidence.content_hash) {
      replayLink = prior;
    }
  }
  const id = (record as { id: string }).id;
  assertExternalIdentity(store, request.principal, request.scope, facet, record);
  /** The normalized PAYLOAD hash: what idempotency recognizes on a re-send. */
  const hash = stateHash(record);
  const ledger = opts.ledgerCache?.ledger ?? readLedger(hunchDir, request.scope);
  if (opts.ledgerCache) opts.ledgerCache.ledger = ledger;
  const durability = () => opts.flush?.(isPrivate, `nuryel: write ${id}`) ?? "local";
  /** The result reports the record ON FILE and its hash — the store may enrich a record on put
   *  (a private-mode decision gains `valid_from`), and a writer that goes on to rest a receipt
   *  on this record must hold the hash a reader will verify, never a pre-store one. */
  const result = (outcome: WriteResult["outcome"], conflict: WriteResult["conflict"] = null, rid = id): WriteResult => {
    const onFile = getHere(rid) ?? record;
    return WriteResultSchema.parse({ schema: STATE_WRITE_VERSION, record_id: rid, record_hash: stateHash(onFile), durability: durability(), outcome, conflict, record: onFile });
  };

  // Idempotency: the same key replays the original; the same key with a different payload
  // is a refusal, never a second record.
  const seen = ledger.idempotency[request.idempotency_key];
  if (seen) {
    if (seen.record_id === id && (seen.record_hash === hash || seen.payload_hash === hash)) return result("replayed");
    // Say WHAT differs and what to do: a stable key with a varying payload (a timestamp, new
    // wording) is the trap every writer falls into once; the refusal must teach the way out.
    const stored = store.getRec(facet as EntityKind, seen.record_id) as Record<string, unknown> | undefined;
    const differing = stored ? differingFields(stored, record as Record<string, unknown>) : [];
    const where = differing.length ? ` — this payload differs in: ${differing.join(", ")}` : (seen.record_id !== id ? ` — this payload derives a different identity (${id})` : "");
    throw new StateRefusal("idempotency", `idempotency key "${request.idempotency_key}" was already used for ${seen.record_id}${where}. A key names ONE request payload: re-send the original payload to replay it, or use a new key to write this payload (the record keeps its derived id and is updated in place).`, { incumbent_id: seen.record_id, reason: "idempotency key reused with a different payload" });
  }

  const existing = getHere(id) as Record<string, unknown> | undefined;
  if (facet === 'derived') {
    const review = (record as EntityFor['derived']).review;
    if (review && stateHash(review) !== stateHash(existing?.review ?? null) && review.by !== request.principal.id) throw new StateRefusal('malformed', 'reviewer must be the initiating principal');
  }
  if (existing && stateHash(existing) === hash) {
    appendChanges(hunchDir, request.scope, [], { key: request.idempotency_key, entry: { record_id: id, record_hash: hash, payload_hash: hash, facet } }, now, opts.ledgerCache?.ledger);
    return result("replayed");
  }
  if (existing && request.expected_version !== null) {
    const ok = typeof request.expected_version === "number"
      ? latestSeqFor(ledger, id) === request.expected_version
      : stateHash(existing) === request.expected_version;
    if (!ok) throw new StateRefusal("conflict", `expected_version does not match the incumbent ${id}`, { incumbent_id: id, reason: "expected_version mismatch" });
  }

  if (replayLink) {
    const recordHash = stateHash(replayLink);
    appendChanges(hunchDir, request.scope, [], { key: request.idempotency_key, entry: { record_id: replayLink.id, record_hash: recordHash, payload_hash: hash, facet } }, now, opts.ledgerCache?.ledger);
    return WriteResultSchema.parse({ schema: STATE_WRITE_VERSION, record_id: replayLink.id, record_hash: recordHash, record: replayLink, outcome: "replayed", conflict: null, durability: "local" });
  }

  // human-correction-outranks-agent-writes: what a human confirmed, an agent does not rewrite.
  // Allowed for an agent: a replay (the same facts, the tier downgrade aside), a derived statement
  // written back stale with the external cause that moved (the writer's currentness duty), a
  // commitment closed by a receipt on record (a fact that happened) — both keep the human's
  // provenance on the record. Everything else on a human-confirmed incumbent — in place or by
  // supersession — is refused with the incumbent named.
  let supersedes: string | null = request.supersedes ?? null;
  if (request.principal.kind !== "human") {
    const guard = (incumbent: Record<string, unknown> | undefined, how: "overwrite" | "supersede"): "replay" | "keep-provenance" | null => {
      if (!incumbent || !isHumanConfirmed(incumbent)) return null;
      const incumbentId = String(incumbent.id);
      const changed = how === "overwrite" ? differingFields(incumbent, record as Record<string, unknown>).filter((f) => f !== "provenance") : ["a new record"];
      if (how === "overwrite") {
        if (changed.length === 0) return "replay";
        const staleWithCause = facet === "derived" && incumbent.state === "current" && (record as EntityFor["derived"]).state === "stale" && request.cause?.kind === "external"
          && changed.every((f) => f === "state" || f === "valid_to");
        const closedByReceipt = facet === "commitments" && !!(record as EntityFor["commitments"]).closed_by && (record as EntityFor["commitments"]).status === "done"
          && changed.every((f) => f === "status" || f === "closed_by" || f === "valid_to");
        if (staleWithCause || closedByReceipt) return "keep-provenance";
      }
      throw new StateRefusal("conflict", `${incumbentId} was confirmed by a human; ${request.principal.kind === "agent" ? "an agent" : "a service"} principal may not ${how} it (differs in: ${changed.join(", ")}). A human writes the change, or the agent leaves the record as the human left it.`, { incumbent_id: incumbentId, reason: "human-confirmed incumbent" });
    };
    const verdict = guard(existing, "overwrite");
    if (verdict === "replay") {
      appendChanges(hunchDir, request.scope, [], { key: request.idempotency_key, entry: { record_id: id, record_hash: stateHash(existing!), payload_hash: hash, facet } }, now, opts.ledgerCache?.ledger);
      return result("replayed");
    }
    if (verdict === "keep-provenance") (record as { provenance: unknown }).provenance = existing!.provenance;
    if (supersedes && supersedes !== id) guard(store.getRec(facet as EntityKind, supersedes) as Record<string, unknown> | undefined, "supersede");
  }

  // one-live-decision-per-topic — refuse with the incumbent named; supersession is explicit.
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
  // A supersede target must still be open. Two writers racing to replace the same incumbent
  // would otherwise both succeed and leave two current records for one subject (fnd_eeb8bf3cb8);
  // the loser is told which record is current now, so it can re-read and supersede that one.
  // The writer that closed the incumbent itself (same id, new key) is not a loser.
  if (supersedes && facet !== "decisions") {
    const incumbent = store.getRec(facet as EntityKind, supersedes) as Record<string, unknown> | undefined;
    if (incumbent && "valid_to" in incumbent && incumbent.valid_to !== null) {
      const subject = subjectOf(facet, incumbent);
      const open = store.recsInHome(facet as EntityKind, home)
        .filter((r) => subjectOf(facet, r) === subject && (r as { valid_to?: string | null }).valid_to === null)
        .map((r) => (r as { id: string }).id).sort();
      if (!open.includes(id)) {
        const current = open.length ? `the current ${facet} record for ${subject ?? "that subject"} is ${open.join(", ")}` : `no ${facet} record for ${subject ?? "that subject"} is open now`;
        throw new StateRefusal("conflict", `supersedes ${supersedes} was already superseded (window closed ${String(incumbent.valid_to)}); ${current}: re-read and supersede that one`, { incumbent_id: open[0] ?? supersedes, reason: "supersede target already closed" });
      }
      supersedes = null; // already closed by this record: nothing to close again, no second "superseded" event
    }
  }

  // The chain (Gate 4): a receipt names what it rested on, a closure names the receipt.
  // Both are checked against the drawer, grants first, before anything lands.
  if (facet === "receipts") assertRestsOn(store, request.principal, request.scope, (record as EntityFor["receipts"]).rests_on ?? []);
  const closedBy = facet === "commitments" ? assertClosedBy(store, request.principal, record as EntityFor["commitments"]) : null;

  store.putCapture(facet as EntityKind, record, isPrivate);
  /** What is on file now — the hash every event, ref and result carries. */
  const onFileHash = stateHash(getHere(id) ?? record);
  const changes: PendingChange[] = [];
  const cause = closedBy ? { kind: "receipt" as const, receipt_id: closedBy } : request.cause ?? { kind: "write" as const, principal: request.principal.id };
  // A current derived statement written back as stale is an INVALIDATION, not an update: the
  // ledger says so, and names the external pointer that moved when the writer gives one.
  const invalidated = facet === "derived" && !!existing && (existing.state === "current" || existing.state === "unknown") && (record as EntityFor["derived"]).state === "stale";
  const invalidates = facet === "receipts" ? (record as EntityFor["receipts"]).invalidates : [];
  // An entity leaving service is a `retired` change (a merge names the survivor in the record).
  const retired = (facet === "entities" || facet === "relationships") && (record as EntityFor["entities"]).lifecycle === "retired" && (!existing || existing.lifecycle !== "retired");
  const subject = subjectOf(facet, record);
  if (supersedes) {
    const closed = closeWindow(store, facet, supersedes, id, now, isPrivate);
    if (closed) {
      const old = store.getRec(facet as EntityKind, supersedes)!;
      changes.push({ facet, record_id: supersedes, record_hash: stateHash(old), change: "superseded", subject: subjectOf(facet, old), invalidates: [], cause });
    }
  }
  changes.push({ facet, record_id: id, record_hash: onFileHash, change: invalidated ? "invalidated" : retired ? "retired" : existing ? "updated" : "created", subject, invalidates: invalidated && subject ? [subject] : invalidates, cause });
  appendChanges(hunchDir, request.scope, changes, { key: request.idempotency_key, entry: { record_id: id, record_hash: onFileHash, payload_hash: hash, facet } }, now, opts.ledgerCache?.ledger);
  if (!opts.deferReindex) store.reindex();
  return result(supersedes ? "superseded" : existing ? "updated" : "created");
}

// ---- subscribe -----------------------------------------------------------------------------

/** subscribe — the scope's ordered change stream after a cursor. Unfiltered, the events are
 *  contiguous and assertChangeSequence holds; filtered, `head_seq` is still the cursor. */
export function subscribeState(store: HunchStore, input: unknown): SubscribeResponse {
  const request: SubscribeRequest = SubscribeRequestSchema.parse(input);
  if (!granted(request.principal, request.scope)) throw new StateRefusal("outside-grants", `scope ${scopePath(request.scope)} is outside the principal's grants`);
  const { hunchDir } = stateHomeFor(store, request.scope);
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
