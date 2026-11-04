/**
 * Human edits to one memory record (`hunch edit | link | remove | restore`).
 *
 * Pure transforms only — record + change + clock in, record out — so every refusal is
 * unit-testable without a store. The CLI owns IO: it reads the record, runs a transform,
 * writes through the store into the home the record already lives in, and commits.
 *
 * Nothing here deletes: `remove` closes a record's lifecycle (status / valid_to / triage)
 * and `restore` reopens it, so the pair round-trips and git history keeps both moves.
 * A human signature vouches for the words it signed: a text edit of a human-confirmed
 * decision or constraint drops it back to agent testimony (`hunch review --confirm`
 * signs it again); link / remove / restore keep provenance.source. A decision's
 * rejected_tripwires keep their own provenance: an edit never touches the alternatives
 * they guard. last_verified is stamped on every change.
 */
import type { Bug, Constraint, Decision, Finding } from "./types.js";
import { safeRepoScope, toPosixTarget } from "./paths.js";
import { captureConflicts, isLive } from "./topics.js";
import { withoutHumanSignature } from "./countersign.js";
import { isImportedAdrDecision } from "./importReview.js";
import { TESTIMONY_CORRECTION_RATIONALE, VOUCHED_CORRECTION_RATIONALE } from "./correction.js";

export type MemoryKind = "decision" | "constraint" | "bug" | "finding";
export type MemoryCollection = "decisions" | "constraints" | "bugs" | "findings";
export type MemoryRecord = Decision | Constraint | Bug | Finding;

export type EditResult<R extends MemoryRecord = MemoryRecord> =
  | { ok: true; record: R; changed: boolean }
  | { ok: false; reason: string };

const PREFIXES: ReadonlyArray<readonly [string, MemoryKind, MemoryCollection]> = [
  ["dec_", "decision", "decisions"],
  ["con_", "constraint", "constraints"],
  ["bug_", "bug", "bugs"],
  ["fnd_", "finding", "findings"],
];

/** The record kind an id names, from its prefix; null for anything else. */
export function kindOfId(id: string): { kind: MemoryKind; collection: MemoryCollection } | null {
  for (const [prefix, kind, collection] of PREFIXES) if (id.startsWith(prefix) && id.length > prefix.length) return { kind, collection };
  return null;
}

const refuse = (reason: string): { ok: false; reason: string } => ({ ok: false, reason });

function stamp<R extends MemoryRecord>(rec: R, patch: Partial<R>, now: string): R {
  return { ...rec, ...patch, provenance: { ...rec.provenance, last_verified: now } };
}

// ---- edit ------------------------------------------------------------------

export interface EditChange { title?: string; text?: string; context?: string; rationale?: string }

export function editRecord(kind: MemoryKind, rec: MemoryRecord, change: EditChange, now: string): EditResult {
  const given = (["title", "text", "context", "rationale"] as const).filter((k) => change[k] !== undefined);
  if (!given.length) return refuse("nothing to edit — pass at least one of --title, --text, --context, --rationale");
  for (const k of ["title", "text"] as const) {
    if (change[k] !== undefined && !change[k]!.trim()) return refuse(`--${k} can't be empty`);
  }
  if (change.title !== undefined && kind === "constraint") return refuse("a constraint has no title — edit its statement with --text");
  if (change.context !== undefined && kind !== "decision") return refuse(`--context applies to decisions only, not a ${kind}`);
  if (change.rationale !== undefined && kind !== "constraint") return refuse(`--rationale applies to constraints only, not a ${kind}`);
  // An imported ADR's words belong to its markdown file: the next import would overwrite an edit here.
  if (kind === "decision" && isImportedAdrDecision(rec as Decision)) return refuse("this decision was imported from an ADR file — edit the ADR markdown and re-run hunch import adrs");

  let patch: Record<string, unknown> = {};
  if (change.title !== undefined) patch.title = change.title;
  if (change.context !== undefined) patch.context = change.context;
  if (change.rationale !== undefined) patch.rationale = change.rationale;
  if (change.text !== undefined) {
    const field = kind === "decision" ? "decision" : kind === "constraint" ? "statement" : kind === "finding" ? "observation" : "symptom";
    patch[field] = change.text;
  }
  const before = rec as unknown as Record<string, unknown>;
  patch = Object.fromEntries(Object.entries(patch).filter(([k, v]) => before[k] !== v));
  if (!Object.keys(patch).length) return { ok: true, record: rec, changed: false };
  const next = stamp(rec, patch as Partial<MemoryRecord>, now);
  return { ok: true, record: kind === "decision" || kind === "constraint" ? unsign(next, "rationale" in patch) : next, changed: true };
}

/** Testimony confidence — the tier an un-vouched correction lands at (correction.ts). */
const TESTIMONY_CONFIDENCE = 0.75;

/** Drop the human signature from edited text; a record without one is returned as is.
 *  A rationale the edit itself set is the human's own words and is kept. */
function unsign<R extends MemoryRecord>(rec: R, rationaleEdited: boolean): R {
  if (!rec.provenance.source.split("+").includes("human_confirmed")) return rec;
  const out: R = {
    ...rec,
    provenance: {
      ...rec.provenance,
      source: withoutHumanSignature(rec.provenance.source),
      confidence: Math.min(rec.provenance.confidence ?? TESTIMONY_CONFIDENCE, TESTIMONY_CONFIDENCE),
    },
  };
  const con = out as unknown as Constraint;
  if (!rationaleEdited && con.rationale === VOUCHED_CORRECTION_RATIONALE) con.rationale = TESTIMONY_CORRECTION_RATIONALE;
  return out;
}

// ---- link ------------------------------------------------------------------

export interface LinkChange {
  feature?: string;
  clearFeature?: boolean;
  addFiles?: string[];
  removeFiles?: string[];
  addComponents?: string[];
  removeComponents?: string[];
  /** Component ids present in the store — an add of anything else is refused. */
  knownComponents?: ReadonlySet<string>;
  /** Every decision visible to the store, for the one-live-decision-per-topic guard. */
  decisions?: readonly Decision[];
  /** Where the record lives; a `private:` file link is allowed only in the private home. */
  home?: "public" | "private";
}

function fileField(kind: MemoryKind): "related_files" | "scope" | "affected_files" {
  return kind === "decision" ? "related_files" : kind === "constraint" ? "scope" : "affected_files";
}

/** Add then remove, de-duplicated, order-preserving; removing an absent entry is a no-op. */
function applyList(list: readonly string[], add: readonly string[], remove: readonly string[]): string[] {
  const out = [...list];
  for (const a of add) if (!out.includes(a)) out.push(a);
  return out.filter((x) => !remove.includes(x));
}

/** The conflict message when `rec` would become a second live decision on `topic`. */
export function topicConflict(rec: Decision, topic: string, decisions: readonly Decision[]): string | null {
  const others = captureConflicts(decisions, topic, rec.id, null);
  if (!others.length) return null;
  return `topic "${topic}" already has a live decision: ${others.map((o) => `${o.id} ("${o.title}")`).join(", ")} — supersede it first`;
}

/** A file link as stored, or a refusal: repo-relative only, and `private:` only from the
 *  private home (a public record must not depend on unsharable files). */
export function fileLink(raw: string, home: LinkChange["home"]): { ok: true; link: string } | { ok: false; reason: string } {
  const value = toPosixTarget(raw.trim());
  if (value.startsWith("private:")) {
    if (home !== "private") return refuse(`"${raw}" is a private reference; only a record in the private overlay can link one`);
    const rest = safeRepoScope(value.slice("private:".length));
    return rest ? { ok: true, link: `private:${rest}` } : refuse(`"${raw}" must be a path relative to the overlay repo (no absolute path, no "..")`);
  }
  const link = safeRepoScope(value);
  return link ? { ok: true, link } : refuse(`"${raw}" must be a path relative to the repo root (no absolute path, no "..")`);
}

export function linkRecord(kind: MemoryKind, rec: MemoryRecord, change: LinkChange, now: string): EditResult {
  const addFiles: string[] = [];
  for (const raw of change.addFiles ?? []) {
    if (!raw.trim()) continue;
    const r = fileLink(raw, change.home);
    if (!r.ok) return r;
    addFiles.push(r.link);
  }
  const removeFiles = (change.removeFiles ?? []).map((f) => toPosixTarget(f.trim())).filter(Boolean);
  const addComponents = (change.addComponents ?? []).map((c) => c.trim()).filter(Boolean);
  const removeComponents = (change.removeComponents ?? []).map((c) => c.trim()).filter(Boolean);
  const touchesFeature = change.feature !== undefined || !!change.clearFeature;
  if (!touchesFeature && !addFiles.length && !removeFiles.length && !addComponents.length && !removeComponents.length) {
    return refuse("nothing to link — pass --feature, --clear-feature, --add-file, --remove-file, --add-component or --remove-component");
  }
  if (change.feature !== undefined && change.clearFeature) return refuse("--feature and --clear-feature are mutually exclusive");
  if (change.feature !== undefined && !change.feature.trim()) return refuse("--feature can't be empty (use --clear-feature to unset it)");
  if (touchesFeature && kind !== "decision") return refuse(`a feature (topic) belongs to decisions only, not a ${kind}`);
  if ((addComponents.length || removeComponents.length) && kind !== "decision") return refuse(`components link to decisions only, not a ${kind}`);

  const patch: Record<string, unknown> = {};
  const before = rec as unknown as Record<string, string[]>;

  if (addFiles.length || removeFiles.length) {
    const field = fileField(kind);
    const next = applyList(before[field] ?? [], addFiles, removeFiles);
    // An empty scope matches no file, yet grounding would still list the rule as enforced.
    if (kind === "constraint" && !next.length) return refuse("a constraint needs at least one file or glob in its scope — remove the constraint instead");
    if (next.join("\n") !== (before[field] ?? []).join("\n")) patch[field] = next;
  }

  if (kind === "decision") {
    const dec = rec as Decision;
    for (const c of addComponents) {
      if (!change.knownComponents?.has(c)) return refuse(`component "${c}" not found`);
    }
    if (addComponents.length || removeComponents.length) {
      const next = applyList(dec.related_components, addComponents, removeComponents);
      if (next.join("\n") !== dec.related_components.join("\n")) patch.related_components = next;
    }
    if (touchesFeature) {
      const topic = change.clearFeature ? null : change.feature!.trim();
      if (topic !== dec.topic) {
        if (topic !== null && isLive(dec)) {
          const conflict = topicConflict(dec, topic, change.decisions ?? []);
          if (conflict) return refuse(conflict);
        }
        patch.topic = topic;
      }
    }
  }

  if (!Object.keys(patch).length) return { ok: true, record: rec, changed: false };
  return { ok: true, record: stamp(rec, patch as Partial<MemoryRecord>, now), changed: true };
}

// ---- remove / restore ------------------------------------------------------

/** Retire a record without deleting it. Constraints are retired by the store
 *  (`retireConstraint`); this mirrors that result so the CLI can refuse uniformly.
 *  A record whose validity window already closed is refused: `restore` reopens the
 *  window, so removing it would not round-trip. */
export function removeRecord(kind: MemoryKind, rec: MemoryRecord, now: string): EditResult {
  if (kind === "bug") return refuse("a bug is the record of what broke; it can't be removed");
  if (kind === "decision") {
    const dec = rec as Decision;
    if (dec.status === "rejected" || dec.status === "superseded") return refuse(`decision "${dec.id}" is already ${dec.status}`);
    if (dec.valid_to) return refuse(`decision "${dec.id}" already stopped applying on ${dec.valid_to}`);
    const status = dec.status === "proposed" ? "rejected" : "superseded";
    return { ok: true, changed: true, record: stamp(dec, { status, valid_to: now }, now) };
  }
  if (kind === "constraint") {
    const con = rec as Constraint;
    if (con.status === "retired") return refuse(`constraint "${con.id}" is already retired`);
    if (con.valid_to) return refuse(`constraint "${con.id}" already stopped applying on ${con.valid_to}`);
    return { ok: true, changed: true, record: stamp(con, { status: "retired", valid_to: now }, now) };
  }
  const fnd = rec as Finding;
  if (fnd.triage === "stale" || fnd.triage === "resolved") return refuse(`finding "${fnd.id}" is already ${fnd.triage}`);
  return { ok: true, changed: true, record: stamp(fnd, { triage: "stale" }, now) };
}

export const RESTORABLE_FINDING_TRIAGE = ["open", "accepted-risk", "scheduled"] as const;

export interface RestoreChange { status?: string; decisions?: readonly Decision[] }

export function restoreRecord(kind: MemoryKind, rec: MemoryRecord, change: RestoreChange, now: string): EditResult {
  if (kind === "bug") return refuse("a bug can't be removed, so there is nothing to restore");
  if (kind === "decision") {
    const dec = rec as Decision;
    if (dec.status !== "rejected" && dec.status !== "superseded") return refuse(`decision "${dec.id}" is ${dec.status}, not removed`);
    if (dec.superseded_by) return refuse(`decision "${dec.id}" was replaced by ${dec.superseded_by}; restoring it would fork the history`);
    // Invert `remove`: a rejected draft returns as a draft, a superseded decision as accepted.
    // Shipping a former draft takes an explicit --status accepted.
    const status = change.status ?? (dec.status === "rejected" ? "proposed" : "accepted");
    if (status !== "proposed" && status !== "accepted") return refuse(`--status for a decision must be proposed or accepted, not "${status}"`);
    const next = stamp(dec, { status, valid_to: null }, now);
    if (dec.topic && isLive(next)) {
      const conflict = topicConflict(next, dec.topic, change.decisions ?? []);
      if (conflict) return refuse(conflict);
    }
    return { ok: true, changed: true, record: next };
  }
  if (kind === "constraint") {
    const con = rec as Constraint;
    if (con.status !== "retired") return refuse(`constraint "${con.id}" is ${con.status}, not removed`);
    if (change.status !== undefined) return refuse("--status doesn't apply to a constraint; it returns to active");
    return { ok: true, changed: true, record: stamp(con, { status: "active", valid_to: null }, now) };
  }
  const fnd = rec as Finding;
  if (fnd.triage !== "stale" && fnd.triage !== "resolved") return refuse(`finding "${fnd.id}" is ${fnd.triage}, not removed`);
  const triage = change.status ?? "open";
  if (!(RESTORABLE_FINDING_TRIAGE as readonly string[]).includes(triage)) {
    return refuse(`--status for a finding must be one of ${RESTORABLE_FINDING_TRIAGE.join(", ")}, not "${triage}"`);
  }
  return { ok: true, changed: true, record: stamp(fnd, { triage: triage as Finding["triage"] }, now) };
}
