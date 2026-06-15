/**
 * Structured three-way merge of `.hunch/` JSON for TEAM workflows.
 *
 * Concurrent branches both writing the Hunch conflict on `git merge`: the
 * single-file symbols/edges index is rewritten wholesale by `hunch index`, and two
 * people can touch the same decision/bug/constraint. A registered git merge driver
 * (`hunch merge-driver`, wired up by `hunch init`) calls mergeHunchJson per
 * conflicted file so records merge BY ID instead of leaving conflict markers.
 *
 * Scope: git only invokes a content merge driver when the SAME path differs on both
 * sides — so this resolves (a) the symbols/edges index ARRAY and (b) edits to the
 * same id in the same per-record file. Per-record ADD/DELETE across branches are
 * distinct files and git handles them at the tree level (the driver isn't called).
 *
 * Resolution for a record changed on BOTH sides: human-confirmed beats auto, then
 * higher provenance.confidence, then the more recently verified, then a deterministic
 * content tiebreak (so both developers' merges converge on the same result). Records
 * are pure data here — no filesystem access; the CLI reads/writes the files.
 */

type Rec = Record<string, unknown>;

export interface MergeResult {
  text: string;
  /** true → could not structurally merge (corrupt JSON / id-less records); the
   *  caller should fall back to git's normal conflict handling. */
  conflict: boolean;
}

/** Merge three versions of one `.hunch` JSON file (an index array OR a single
 *  record object). Returns the merged text, or conflict=true to fall back. */
export function mergeHunchJson(baseText: string, oursText: string, theirsText: string): MergeResult {
  const ours = parseSide(oursText);
  const theirs = parseSide(theirsText);
  const base = parseSide(baseText);
  // Can't structurally merge non-JSON or id-less records → let git handle it.
  if (!ours.ok || !theirs.ok) return { text: oursText, conflict: true };
  if (!hasIds(ours.records) || !hasIds(theirs.records)) return { text: oursText, conflict: true };

  const merged = mergeRecordsById(base.ok ? base.records : [], ours.records, theirs.records);
  merged.sort((a, b) => String(a.id).localeCompare(String(b.id)));

  // An index file stays an array; a per-record file stays a single object.
  const asArray = ours.isArray || theirs.isArray;
  if (asArray) return { text: serialize(merged), conflict: false };
  if (merged.length === 0) return { text: "", conflict: false }; // both deleted the record
  // A single-record file that produced >1 record means a side rewrote the `id`
  // (a logical rename). Don't silently drop one — fall back so git surfaces it.
  if (merged.length > 1) return { text: oursText, conflict: true };
  return { text: serialize(merged[0]!), conflict: false };
}

/** Three-way merge of record arrays keyed by `id`. Additions on either side are
 *  kept; a record changed on one side only takes that side; a delete is honored
 *  only if the other side left the record unchanged (a modification beats a delete);
 *  a both-sides change is resolved by `pickWinner`. */
export function mergeRecordsById(base: Rec[], ours: Rec[], theirs: Rec[]): Rec[] {
  const b = byId(base);
  const o = byId(ours);
  const t = byId(theirs);
  const ids = new Set<string>([...o.keys(), ...t.keys(), ...b.keys()]);
  const out: Rec[] = [];
  for (const id of ids) {
    const bv = b.get(id);
    const ov = o.get(id);
    const tv = t.get(id);
    if (ov && tv) {
      if (canon(ov) === canon(tv)) out.push(ov);
      else if (bv && canon(ov) === canon(bv)) out.push(tv); // only theirs changed
      else if (bv && canon(tv) === canon(bv)) out.push(ov); // only ours changed
      else out.push(pickWinner(ov, tv)); // both changed (or both added differently)
    } else if (ov && !tv) {
      // theirs lacks it: a delete (bv present & ours unchanged) loses to a keep/modify
      if (bv && canon(ov) === canon(bv)) continue; // theirs deleted, ours unchanged → drop
      out.push(ov); // ours added, or ours modified vs a theirs-delete → keep ours
    } else if (!ov && tv) {
      if (bv && canon(tv) === canon(bv)) continue; // ours deleted, theirs unchanged → drop
      out.push(tv);
    }
    // neither side has it → both deleted → drop
  }
  return out;
}

/** Both sides changed the same record: pick the one to keep. */
export function pickWinner(ours: Rec, theirs: Rec): Rec {
  const oc = humanConfirmed(ours);
  const tc = humanConfirmed(theirs);
  if (oc !== tc) return oc ? ours : theirs; // human-confirmed beats auto

  const od = confidence(ours);
  const td = confidence(theirs);
  if (od !== td) return od > td ? ours : theirs;

  const orr = recency(ours);
  const tr = recency(theirs);
  if (orr !== tr) return orr > tr ? ours : theirs;

  // Deterministic, side-independent tiebreak so A-merges-B and B-merges-A agree.
  return canon(ours) >= canon(theirs) ? ours : theirs;
}

// ---- helpers --------------------------------------------------------------

interface Side {
  ok: boolean;
  isArray: boolean;
  records: Rec[];
}

function parseSide(text: string): Side {
  const trimmed = (text ?? "").trim();
  if (!trimmed) return { ok: true, isArray: false, records: [] }; // empty (e.g. deleted) side
  let v: unknown;
  try {
    v = JSON.parse(trimmed);
  } catch {
    return { ok: false, isArray: false, records: [] };
  }
  if (Array.isArray(v)) return { ok: true, isArray: true, records: v.filter(isRec) };
  if (isRec(v)) return { ok: true, isArray: false, records: [v] };
  return { ok: false, isArray: false, records: [] };
}

function isRec(v: unknown): v is Rec {
  return v !== null && typeof v === "object" && !Array.isArray(v);
}

function hasIds(records: Rec[]): boolean {
  return records.every((r) => typeof r.id === "string" && r.id.length > 0);
}

function byId(records: Rec[]): Map<string, Rec> {
  const m = new Map<string, Rec>();
  for (const r of records) if (typeof r.id === "string") m.set(r.id, r);
  return m;
}

function humanConfirmed(r: Rec): boolean {
  return /human_confirmed/.test(provSource(r));
}

function provSource(r: Rec): string {
  const p = r.provenance;
  return isRec(p) && typeof p.source === "string" ? p.source : "";
}

function confidence(r: Rec): number {
  const p = r.provenance;
  return isRec(p) && typeof p.confidence === "number" ? p.confidence : 0;
}

/** Most recent timestamp on the record (verified / decided / updated), epoch ms. */
function recency(r: Rec): number {
  const p = r.provenance;
  const cands = [
    isRec(p) ? p.last_verified : undefined,
    r.date,
    r.updated_at,
  ];
  let best = 0;
  for (const c of cands) {
    if (typeof c === "string") {
      const t = Date.parse(c);
      if (!Number.isNaN(t) && t > best) best = t;
    }
  }
  return best;
}

/** Stable JSON with recursively SORTED keys, so equality/compare ignore key order. */
export function canon(v: unknown): string {
  return JSON.stringify(sortKeys(v));
}

function sortKeys(v: unknown): unknown {
  if (Array.isArray(v)) return v.map(sortKeys);
  if (v !== null && typeof v === "object") {
    const out: Record<string, unknown> = {};
    for (const k of Object.keys(v as Rec).sort()) out[k] = sortKeys((v as Rec)[k]);
    return out;
  }
  return v;
}

/** Match the store's on-disk format (2-space indent + trailing newline). */
function serialize(v: unknown): string {
  return JSON.stringify(v, null, 2) + "\n";
}
