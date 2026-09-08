/**
 * nuryel.state/1 — search and delivery of the five state kinds (receipts, commitments,
 * derived, entities, relationships). Registered in 1.25 as store kinds, they were stored and
 * counted but neither indexed nor delivered: `hunch_query("customer:Site:7")` could not surface
 * a current summary, an open commitment or a verified receipt, and `hunch_context` had no
 * "State" section. This module is the single place that says, per kind:
 *
 *   - what text goes into the `search` FTS row (subject + content/title + actor + status, so a
 *     subject id and a human phrase both hit),
 *   - whether a record is LIVE (current / in_force / verified…) or HISTORY (superseded, done,
 *     cancelled, failed, retired) — history stays indexed and findable, it only ranks below,
 *   - the one-line render every reader gets (`[commitment/in_force] customer:Site:7 — …`),
 *   - the bounded, deterministically ordered "State" supplements for a context brief.
 *
 * Pure functions over records; no store or SQLite dependency, so the CLI, the MCP server and
 * the store's own reindex/rank paths cannot drift from each other.
 */
import type { ActionReceipt, Commitment, DerivedState, ExternalEntity, StateRelationship } from "./stateRecords.js";
import type { DeliverySupplement } from "./delivery.js";

export const STATE_KINDS = ["receipts", "commitments", "derived", "entities", "relationships"] as const;
export type StateKind = (typeof STATE_KINDS)[number];
const STATE_KIND_SET: ReadonlySet<string> = new Set(STATE_KINDS);

export function isStateKind(kind: string): kind is StateKind {
  return STATE_KIND_SET.has(kind);
}

/** Singular facet label used in renders: `[commitment/in_force]`, `[derived/current]`. */
const FACET_LABEL: Record<StateKind, string> = {
  receipts: "receipt",
  commitments: "commitment",
  derived: "derived",
  entities: "entity",
  relationships: "relationship",
};

export type StateRecord = ActionReceipt | Commitment | DerivedState | ExternalEntity | StateRelationship;

export interface StateLiveness {
  /** The contract's own word for the record's standing: current, in_force, verified, done, superseded … */
  label: string;
  /** True when the record is the state of record NOW; false for history (still indexed, ranked below). */
  live: boolean;
}

/** Liveness per kind, mirroring readState's state_of_record predicates exactly
 *  (derived `current` with an open window; commitment open/waiting with an open window;
 *  receipt succeeded/verified; entity active; a relationship is always current). */
export function stateLiveness(kind: StateKind, record: StateRecord): StateLiveness {
  switch (kind) {
    case "derived": {
      const d = record as DerivedState;
      if (d.valid_to != null) return { label: "superseded", live: false };
      return { label: d.state, live: d.state === "current" };
    }
    case "commitments": {
      const c = record as Commitment;
      if (c.status === "open" || c.status === "waiting") {
        return c.valid_to == null ? { label: "in_force", live: true } : { label: "superseded", live: false };
      }
      return { label: c.status, live: false };
    }
    case "receipts": {
      const r = record as ActionReceipt;
      return { label: r.state, live: r.state === "succeeded" || r.state === "verified" };
    }
    case "entities": {
      const e = record as ExternalEntity;
      return { label: e.lifecycle, live: e.lifecycle === "active" };
    }
    case "relationships":
      return { label: "current", live: true };
  }
}

/** The subject key a reader would type: the commitment/derived subject, the receipt's target
 *  object (`event:10042`), the entity id, or the relationship's `from` endpoint. */
export function stateSubject(kind: StateKind, record: StateRecord): string {
  switch (kind) {
    case "derived": return (record as DerivedState).subject;
    case "commitments": return (record as Commitment).subject;
    case "receipts": { const r = record as ActionReceipt; return `${r.target.object_type}:${r.target.object_key}`; }
    case "entities": return (record as ExternalEntity).id;
    case "relationships": return (record as StateRelationship).from;
  }
}

/** The instant that orders "latest first": computed_at, valid_from, verified_at ?? occurred_at,
 *  updated_at. Relationships carry no clock and sort last among equals. */
export function stateObservedAt(kind: StateKind, record: StateRecord): string {
  switch (kind) {
    case "derived": return (record as DerivedState).computed_at;
    case "commitments": return (record as Commitment).valid_from;
    case "receipts": { const r = record as ActionReceipt; return r.verified_at ?? r.occurred_at; }
    case "entities": return (record as ExternalEntity).updated_at;
    case "relationships": return "";
  }
}

/** The FTS document for a state record: title = the subject key (so an id query hits the
 *  title column, which the snippet and LIKE fallback both prefer), body = the human words plus
 *  the actor/owner, the status label and the dates. Every reader's query — a subject id, a
 *  phrase from a summary, an action kind, a principal — lands on one of these. */
export function stateSearchDoc(kind: StateKind, record: StateRecord): { title: string; body: string } {
  const { label } = stateLiveness(kind, record);
  const subject = stateSubject(kind, record);
  switch (kind) {
    case "derived": {
      const d = record as DerivedState;
      return { title: subject, body: `${d.content} ${label} ${d.transform_version} ${d.computed_at.slice(0, 10)}` };
    }
    case "commitments": {
      const c = record as Commitment;
      return { title: subject, body: `${c.title} ${c.evidence_excerpt ?? ""} ${label} ${c.status} owner ${c.owner} due ${c.due}` };
    }
    case "receipts": {
      const r = record as ActionReceipt;
      return {
        title: subject,
        body: `${r.action_kind} ${r.actor} ${label} ${r.target.system} ${r.target.object_type} ${r.target.object_key} ${r.occurred_at.slice(0, 10)} ${r.invalidates.join(" ")}`,
      };
    }
    case "entities": {
      const e = record as ExternalEntity;
      const attrs = Object.entries(e.attributes).map(([k, v]) => `${k} ${v ?? ""}`).join(" ");
      return { title: subject, body: `${e.name} ${e.kind} ${label} ${attrs}` };
    }
    case "relationships": {
      const r = record as StateRelationship;
      return { title: subject, body: `${r.type} ${r.to} ${r.reason}` };
    }
  }
}

const DERIVED_HEADLINE_CHARS = 120;

function oneLine(value: string, max: number): string {
  const flat = value.replace(/\s+/g, " ").trim();
  return flat.length <= max ? flat : `${flat.slice(0, Math.max(0, max - 1)).trimEnd()}…`;
}

/** The one-line render shared by hunch_query, `hunch query` and the context "State" section:
 *    [commitment/in_force] customer:Site:7 — "send report" due 2026-09-11 (owner sofia)
 *    [derived/current] customer:Site:7 — <first 120 chars of the summary>
 *    [receipt/verified] event:10042 — events_add_actions by sofia@david 2026-09-08 */
export function renderStateLine(kind: StateKind, record: StateRecord): string {
  const { label } = stateLiveness(kind, record);
  const head = `[${FACET_LABEL[kind]}/${label}] ${stateSubject(kind, record)} — `;
  switch (kind) {
    case "derived":
      return `${head}${oneLine((record as DerivedState).content, DERIVED_HEADLINE_CHARS)}`;
    case "commitments": {
      const c = record as Commitment;
      return `${head}"${oneLine(c.title, 100)}" due ${c.due} (owner ${c.owner})`;
    }
    case "receipts": {
      const r = record as ActionReceipt;
      return `${head}${r.action_kind} by ${r.actor} ${(r.verified_at ?? r.occurred_at).slice(0, 10)}`;
    }
    case "entities": {
      const e = record as ExternalEntity;
      return `${head}${oneLine(e.name, 100)} (${e.kind})`;
    }
    case "relationships": {
      const r = record as StateRelationship;
      return `${head}${r.type} → ${r.to}${r.reason ? ` (${oneLine(r.reason, 80)})` : ""}`;
    }
  }
}

/** One ranked state hit, as the store's stateSlice() returns it. `score` is the search
 *  score (bm25: lower is better; 0 for the LIKE fallback and exact-subject matches). */
export interface StateHit<K extends StateKind = StateKind> {
  kind: K;
  record: StateRecord;
  score: number;
}

/** Bounded caps for the context "State" section: current derived, in-force commitments,
 *  latest receipts. Deliberately small — a brief, not a dump; `nuryel_read` is the full view. */
export const STATE_SLICE_CAPS = { derived: 3, commitments: 5, receipts: 3 } as const;

export interface StateSlice {
  derived: StateHit<"derived">[];
  commitments: StateHit<"commitments">[];
  receipts: StateHit<"receipts">[];
}

/** Deterministic order for a state slice: score (best first), then observed_at DESC (latest
 *  first), then id ASC. Applied after liveness filtering, before the cap. */
export function compareStateHits(a: StateHit, b: StateHit): number {
  if (a.score !== b.score) return a.score - b.score;
  const at = stateObservedAt(b.kind, b.record).localeCompare(stateObservedAt(a.kind, a.record));
  if (at !== 0) return at;
  return (a.record as { id: string }).id.localeCompare((b.record as { id: string }).id);
}

/** Supplement priority band for the State section: above Project DNA (425), below
 *  decision-grounding (1000) and the ranked memory records (which are not supplements). */
const STATE_SUPPLEMENT_PRIORITY = 500;

/** Render a state slice as delivery supplements (one header + one line per record) so the
 *  section shares the context brief's hard budget and receipt like every other grounding.
 *  Empty slice → no supplements at all: a store with zero state records is byte-identical. */
export function stateSupplements(slice: StateSlice, target: string): DeliverySupplement[] {
  const hits: StateHit[] = [...slice.derived, ...slice.commitments, ...slice.receipts];
  if (!hits.length) return [];
  const out: DeliverySupplement[] = [{
    id: "state-of-record",
    kind: "state",
    text: `STATE (nuryel.state/1) for "${target}": ${slice.derived.length} current derived, ${slice.commitments.length} in-force commitment(s), ${slice.receipts.length} latest receipt(s). Follow the state of record; nuryel_read(subject) returns the full records.`,
    priority: STATE_SUPPLEMENT_PRIORITY,
  }];
  hits.forEach((hit, index) => {
    out.push({
      id: (hit.record as { id: string }).id,
      kind: `state-${FACET_LABEL[hit.kind]}`,
      text: renderStateLine(hit.kind, hit.record),
      // Strictly descending so the sort in buildDeliveryEnvelope keeps slice order.
      priority: STATE_SUPPLEMENT_PRIORITY - 1 - index,
    });
  });
  return out;
}
