/**
 * readOrCompute — the reuse rule every derived-state writer otherwise re-derives by hand, and
 * gets wrong first. No dependencies beyond the platform: canonical JSON and WebCrypto SHA-256.
 *
 * Rules applied, in order (docs/nuryel-state-contract.md, "Read or compute"):
 *  1. Read the subject. A current statement under the same transform whose dependency SET equals
 *     the given one is reused and nothing is computed. The set, not the order: the server derives
 *     a statement's identity from its dependency hashes sorted, so order never makes it new.
 *  2. Otherwise run `compute` once and write the result as the subject's current statement.
 *  3. The idempotency key names the REQUEST: subject, transform and dependencies, the content
 *     hash, and computed_at. A key without the content hash is reused when the same evidence
 *     yields new wording, and the contract refuses a reused key with another payload for good
 *     (the pilot's stuck outbox).
 *  4. `supersedes` names the current statement it replaces under the same transform; the server
 *     keeps one current statement per subject and transform and refuses a second.
 *  5. The audience carries forward: without an explicit `visibility` the new statement keeps the
 *     one it supersedes (audiences are preserved across supersession). An explicit change sends
 *     the predecessor's record hash as `expected_version`, which the server requires.
 *  6. No retries. A refusal or a transport failure surfaces to the caller. Calling again re-reads
 *     first, so a write that did land is reused instead of written twice.
 */
import type { DependencyRef, DerivedState, ReadResponse, RecordsResponse, Scope, WriteResult } from "../core/stateContract.js";

/** What the helper needs from a client; `createStateClient` satisfies it. */
export interface ReadOrComputeClient {
  read(request: { scope: Scope; subject: string; facets: ["derived"] }): Promise<ReadResponse>;
  records(request: { scope: Scope; ids: string[] }): Promise<RecordsResponse>;
  write(request: { scope: Scope; facet: "derived"; record: Record<string, unknown>; idempotency_key: string; supersedes?: string; expected_version?: string }): Promise<WriteResult>;
}

export interface ComputedContent {
  content: string;
  field_provenance?: DerivedState["field_provenance"];
}

export interface ReadOrComputeRequest {
  scope: Scope;
  subject: string;
  transform_version: string;
  /** What the statement rests on; at least one. Equal sets reuse, whatever their order. */
  dependencies: DependencyRef[];
  provenance: DerivedState["provenance"];
  /** Record audience. Omitted: the superseded statement's audience is kept. */
  visibility?: DerivedState["visibility"];
  /** Runs only when no current statement rests on exactly these dependencies. */
  compute: () => string | ComputedContent | Promise<string | ComputedContent>;
  /** ISO timestamp for computed_at; defaults to the clock. */
  now?: () => string;
}

export type ReadOrComputeResult =
  | { reused: true; record: DerivedState; read_receipt: string }
  | { reused: false; record: DerivedState; write: WriteResult; superseded: string | null; read_receipt: string };

const DERIVED_SCHEMA = "nuryel.derived/1";

/** The server's canonical form (src/core/stateCanonical.ts): keys in code-unit order, undefined
 *  dropped, non-finite numbers and `__proto__` refused. Kept in step by test. */
export function canonicalJson(value: unknown): string {
  return JSON.stringify(canonical(value));
}
function canonical(value: unknown): unknown {
  if (value === null || typeof value === "string" || typeof value === "boolean") return value;
  if (typeof value === "number") {
    if (!Number.isFinite(value)) throw new Error("canonical form rejects non-finite numbers");
    return value;
  }
  if (Array.isArray(value)) return value.map(canonical);
  if (typeof value === "object") {
    const out: Record<string, unknown> = {};
    for (const key of Object.keys(value as Record<string, unknown>).sort()) {
      if (key === "__proto__") throw new Error("canonical form rejects reserved key __proto__");
      const v = (value as Record<string, unknown>)[key];
      if (v !== undefined) out[key] = canonical(v);
    }
    return out;
  }
  throw new Error(`canonical form rejects ${typeof value}`);
}

/** `sha256:<hex>` over the canonical form — the server's stateHash. */
export async function stateHash(value: unknown): Promise<string> {
  const digest = await globalThis.crypto.subtle.digest("SHA-256", new TextEncoder().encode(canonicalJson(value)));
  return `sha256:${Array.from(new Uint8Array(digest), (b) => b.toString(16).padStart(2, "0")).join("")}`;
}

function dependencySet(dependencies: readonly DependencyRef[]): string {
  return dependencies.map(canonicalJson).sort().join("\n");
}

function sameScope(a: Scope | undefined, b: Scope): boolean {
  return !!a && a.kind === b.kind && a.id === b.id;
}

export async function readOrCompute(client: ReadOrComputeClient, request: ReadOrComputeRequest): Promise<ReadOrComputeResult> {
  const { scope, subject, transform_version, dependencies, provenance } = request;
  if (!Array.isArray(dependencies) || dependencies.length === 0) throw new Error("readOrCompute: derived state needs at least one dependency (a statement nothing can invalidate is not state)");

  const read = await client.read({ scope, subject, facets: ["derived"] });
  const refs = (read.state_of_record?.current ?? []).filter((ref) => ref.facet === "derived" && sameScope(ref.scope, scope));
  const recordHash = new Map(refs.map((ref) => [ref.id, ref.record_hash]));
  let records = read.records ?? {};
  const unseen = refs.map((ref) => ref.id).filter((id) => !records[id]);
  // Hosts that predate `records` on the read answer by id instead.
  if (unseen.length) records = { ...records, ...(await client.records({ scope, ids: unseen })).records };
  const current = refs
    .map((ref) => records[ref.id] as DerivedState | undefined)
    .filter((r): r is DerivedState => !!r && r.schema === DERIVED_SCHEMA && r.subject === subject && r.transform_version === transform_version && r.state === "current" && r.valid_to == null);

  const wanted = dependencySet(dependencies);
  const reusable = current.find((r) => dependencySet(r.dependencies) === wanted);
  if (reusable) return { reused: true, record: reusable, read_receipt: read.receipt_id };

  const computed = await request.compute();
  const { content, field_provenance } = typeof computed === "string" ? { content: computed, field_provenance: undefined } : computed;
  if (typeof content !== "string" || content.length === 0) throw new Error("readOrCompute: compute must return non-empty content");
  const content_hash = await stateHash(content);
  const computed_at = (request.now ?? (() => new Date().toISOString()))();
  const incumbent = current.find((r) => dependencySet(r.dependencies) !== wanted) ?? null;

  const statement = await stateHash({ scope, subject, transform_version, dependencies: dependencies.map(canonicalJson).sort() });
  const idempotency_key = `derived:${statement.slice(7, 23)}:${content_hash.slice(7, 23)}:${computed_at}`;
  const visibility = request.visibility !== undefined ? request.visibility : incumbent?.visibility;
  const audienceChanges = !!incumbent && canonicalJson(incumbent.visibility ?? null) !== canonicalJson(visibility ?? null);
  const record: Record<string, unknown> = {
    ...(visibility ? { visibility } : {}),
    schema: DERIVED_SCHEMA, scope, subject, content, content_hash, dependencies,
    ...(field_provenance ? { field_provenance } : {}),
    transform_version, computed_at, valid_to: null, state: "current", provenance,
  };
  const write = await client.write({
    scope, facet: "derived", record, idempotency_key,
    ...(incumbent ? { supersedes: incumbent.id } : {}),
    ...(audienceChanges ? { expected_version: recordHash.get(incumbent!.id) } : {}),
  });
  const stored = (write.record ?? { ...record, id: write.record_id }) as DerivedState;
  return { reused: false, record: stored, write, superseded: incumbent?.id ?? null, read_receipt: read.receipt_id };
}
