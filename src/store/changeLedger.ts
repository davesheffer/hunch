/**
 * The per-scope change ledger behind `subscribe` — nuryel.ledger/1.
 *
 * One JSON file per scope partition under `<hunch dir>/changes/`, git-native like every
 * other record, appended atomically (con_902759b3dc). It holds the strictly ordered
 * ChangeEvent stream for that scope (seq 1, 2, 3 … with no gaps) plus the idempotency
 * table the write verb replays from. Seq is per scope, assigned by the writer in the
 * home the scope lives in; a scope has exactly ONE ledger per clone, so within a clone there
 * is never a second sequence to reconcile. Two clones that both appended to one scope are
 * reconciled by `mergeLedgers` (below), for the git merge driver.
 */
import { mkdirSync } from "node:fs";
import { basename, join, resolve } from "node:path";
import { createHash } from "node:crypto";
import { z } from "zod";
import { writeFileAtomic } from "../core/io.js";
import { readStoreArtifact, storeArtifactPath } from "../core/storeArtifact.js";
import { ChangeEventSchema, ScopeSchema, scopePath, type ChangeEvent, type Scope } from "../core/stateContract.js";

export const LEDGER_SCHEMA_VERSION = "nuryel.ledger/1" as const;
export const CHANGES_DIR = "changes";

const IdempotencyEntrySchema = z.object({
  record_id: z.string().min(1),
  /** Hash of the record ON FILE (what reads, events and refs see). */
  record_hash: z.string(),
  /** Hash of the normalized payload as the writer sent it (additive). The store may enrich a
   *  record on put (a private-mode decision gains `valid_from`), so a replay is recognized by
   *  the payload it re-sends, while `record_hash` stays the truth a reader can verify. */
  payload_hash: z.string().optional(),
  facet: z.string(),
  seq: z.number().int().nonnegative(),
  at: z.string(),
}).strict();
export type IdempotencyEntry = z.infer<typeof IdempotencyEntrySchema>;

export const LedgerSchema = z.object({
  schema: z.literal(LEDGER_SCHEMA_VERSION),
  scope: ScopeSchema,
  head_seq: z.number().int().nonnegative(),
  /** Events below this seq were compacted away, or were invalidated by a merge that renumbered
   *  them (see `mergeLedgers`). `events` starts at floor_seq + 1. A subscriber whose cursor is
   *  below the floor must resynchronize (the contract's gap rule, made explicit). */
  floor_seq: z.number().int().nonnegative().default(0),
  events: z.array(ChangeEventSchema),
  idempotency: z.record(z.string(), IdempotencyEntrySchema).default({}),
}).strict();
export type Ledger = z.infer<typeof LedgerSchema>;

// Process-local acceleration only: compare the actual bytes on EVERY read, never
// timestamps or a TTL. Separate processes and same-size replacements stay visible.
// Keep only four small snapshots; oversized ledgers follow the uncached path.
const validatedSnapshots = new Map<string, { text: string; normalized: string; scope: string }>();
const MAX_CACHED_LEDGERS = 4;
const MAX_CACHED_CHARACTERS = 1024 * 1024;

/** Scope ids may carry `:` `@` `+` (safe in the contract, not in every file system), so
 *  the file name is the sanitized id plus a short hash of the exact id — readable AND
 *  collision-free. The scope inside the file is authoritative, the name is a locator. */
export function ledgerFile(hunchDir: string, scope: Scope): string {
  const safe = scope.id.replace(/[^A-Za-z0-9._-]/g, "_").slice(0, 80);
  const tag = createHash("sha256").update(scopePath(scope)).digest("hex").slice(0, 8);
  return join(hunchDir, CHANGES_DIR, `${scope.kind}-${safe}-${tag}.json`);
}

export function emptyLedger(scope: Scope): Ledger {
  return { schema: LEDGER_SCHEMA_VERSION, scope, head_seq: 0, floor_seq: 0, events: [], idempotency: {} };
}

/** Read the ledger for a scope; a missing file is an empty ledger, a corrupt one is an
 *  error (never silently treated as empty — that would restart the sequence). */
export function readLedger(hunchDir: string, scope: Scope): Ledger {
  const file = resolve(ledgerFile(hunchDir, scope));
  const text = readStoreArtifact(hunchDir, [CHANGES_DIR, basename(file)]);
  if (text === null) { validatedSnapshots.delete(file); return emptyLedger(scope); }
  const cached = validatedSnapshots.get(file);
  if (cached?.text === text && cached.scope === scopePath(scope)) {
    validatedSnapshots.delete(file);
    validatedSnapshots.set(file, cached);
    // append/compaction callers mutate their copy. Never expose the cached object.
    return JSON.parse(cached.normalized) as Ledger;
  }
  validatedSnapshots.delete(file);
  const raw = JSON.parse(text) as unknown;
  const ledger = LedgerSchema.parse(raw);
  if (scopePath(ledger.scope) !== scopePath(scope)) throw new Error(`ledger ${file} belongs to scope ${scopePath(ledger.scope)}, not ${scopePath(scope)}`);
  let expected = ledger.floor_seq + 1;
  for (const event of ledger.events) {
    if (event.seq !== expected) throw new Error(`ledger ${file} is not contiguous at seq ${event.seq} (expected ${expected})`);
    expected += 1;
  }
  if (ledger.head_seq !== ledger.floor_seq + ledger.events.length) throw new Error(`ledger ${file} head_seq ${ledger.head_seq} disagrees with floor ${ledger.floor_seq} + ${ledger.events.length} events`);
  if (text.length <= MAX_CACHED_CHARACTERS) {
    while (validatedSnapshots.size >= MAX_CACHED_LEDGERS) validatedSnapshots.delete(validatedSnapshots.keys().next().value!);
    validatedSnapshots.set(file, { text, normalized: JSON.stringify(ledger), scope: scopePath(scope) });
  }
  return ledger;
}

export function writeLedger(hunchDir: string, ledger: Ledger): void {
  writeValidatedLedger(hunchDir, LedgerSchema.parse(ledger));
}

function writeValidatedLedger(hunchDir: string, ledger: Ledger): void {
  const file = storeArtifactPath(hunchDir, CHANGES_DIR, basename(ledgerFile(hunchDir, ledger.scope)));
  mkdirSync(storeArtifactPath(hunchDir, CHANGES_DIR), { recursive: true });
  writeFileAtomic(file, JSON.stringify(ledger, null, 2) + "\n");
}

export type PendingChange = Omit<ChangeEvent, "schema" | "seq" | "at" | "scope">;

/** Append events (in order) and remember an idempotency key in ONE atomic write, so a
 *  crash between "record written" and "event appended" can be detected by the next
 *  writer (record present, ledger silent) rather than producing a half-applied write. */
export function appendChanges(
  hunchDir: string,
  scope: Scope,
  changes: readonly PendingChange[],
  idempotency: { key: string; entry: Omit<IdempotencyEntry, "seq" | "at"> } | null,
  at: string = new Date().toISOString(),
  /** Already validated under the same uninterrupted partition lock; batch-local only. */
  current?: Ledger,
): ChangeEvent[] {
  const ledger = current ?? readLedger(hunchDir, scope);
  if (scopePath(ledger.scope) !== scopePath(scope)) throw new Error("cached ledger belongs to another scope");
  const appended: ChangeEvent[] = [];
  for (const change of changes) {
    const event: ChangeEvent = ChangeEventSchema.parse({ schema: "nuryel.state.subscribe/1", seq: ledger.head_seq + 1, at, scope, ...change });
    ledger.events.push(event);
    ledger.head_seq = event.seq;
    appended.push(event);
  }
  if (idempotency) {
    ledger.idempotency[idempotency.key] = IdempotencyEntrySchema.parse({ ...idempotency.entry, seq: ledger.head_seq, at });
  }
  // The initial ledger and each new event/entry are validated; don't re-validate the
  // full history per assertion. Each append still reaches disk atomically before return.
  writeValidatedLedger(hunchDir, ledger);
  return appended;
}

/** The latest seq that touched a record in this scope, or 0 when the ledger never saw it. */
export function latestSeqFor(ledger: Ledger, recordId: string): number {
  for (let i = ledger.events.length - 1; i >= 0; i--) {
    if (ledger.events[i]!.record_id === recordId) return ledger.events[i]!.seq;
  }
  return 0;
}

/** Keep the newest `keep` events; everything older is dropped and the floor moves up. The
 *  idempotency table is kept whole (it is what makes replays exact); the records themselves are
 *  untouched. Returns how many events were dropped. */
export function compactLedger(hunchDir: string, scope: Scope, opts: { keep?: number } = {}): { dropped: number; floor_seq: number; head_seq: number } {
  const keep = Math.max(0, Math.floor(opts.keep ?? 1000));
  const ledger = readLedger(hunchDir, scope);
  const dropped = Math.max(0, ledger.events.length - keep);
  if (dropped === 0) return { dropped: 0, floor_seq: ledger.floor_seq, head_seq: ledger.head_seq };
  ledger.events = ledger.events.slice(dropped);
  ledger.floor_seq = ledger.head_seq - ledger.events.length;
  writeLedger(hunchDir, ledger);
  return { dropped, floor_seq: ledger.floor_seq, head_seq: ledger.head_seq };
}

const eventIdentity = (e: ChangeEvent): string => [e.change, e.facet, e.record_id, e.record_hash, e.at, e.cause ? JSON.stringify(e.cause) : ""].join("|");

/** Three-way merge of one scope's ledger, for the git merge driver: two clones that both
 *  appended to the same partition. The union of events is kept (identity = what changed, to
 *  which hash, when, by whom), ordered by time then ours-before-theirs, and RE-SEQUENCED from
 *  the higher floor. When that renumbering moves an event either side had already published,
 *  no pre-merge cursor of EITHER side can be trusted — a cursor could otherwise sit above an
 *  event that now holds a lower seq and never see it (issue #285). The floor is then raised
 *  past BOTH pre-merge heads, so every such cursor satisfies subscribe's `after_seq <
 *  floor_seq` and resynchronizes from the floor; a cursor equal to the larger head is exactly
 *  the failing case, hence the `+ 1`. A merge that renumbers nothing keeps today's seqs (no
 *  cursor could have seen a different numbering) and the floor stays put. Idempotency entries
 *  are unioned; a key both sides used for different records is a conflict the caller must
 *  surface (ours is kept). */
export function mergeLedgers(base: Ledger | null, ours: Ledger, theirs: Ledger): { ledger: Ledger; conflicts: string[] } {
  if (scopePath(ours.scope) !== scopePath(theirs.scope)) throw new Error("ledgers for different scopes cannot be merged");
  const seen = new Map<string, ChangeEvent>();
  const order: ChangeEvent[] = [];
  const add = (e: ChangeEvent): void => { const k = eventIdentity(e); if (!seen.has(k)) { seen.set(k, e); order.push(e); } };
  for (const e of base?.events ?? []) add(e);
  for (const e of ours.events) add(e);
  for (const e of theirs.events) add(e);
  // The tiebreak is "ours before theirs", so only an event theirs ALONE contributed sorts late:
  // side 1 iff theirs holds it and neither ours nor base does. Deciding by object identity
  // (`includes`) would instead put anything ours compacted away — base's object, which `add`
  // keeps — after its same-`at` siblings and silently reorder a batch both sides already had.
  const ourIdentities = new Set(ours.events.map(eventIdentity));
  const baseIdentities = new Set((base?.events ?? []).map(eventIdentity));
  const theirsOnly = (e: ChangeEvent): boolean => {
    const k = eventIdentity(e);
    return !ourIdentities.has(k) && !baseIdentities.has(k);
  };
  const ranked = order.map((e, i) => ({ e, i, side: (theirsOnly(e) ? 1 : 0) }));
  ranked.sort((a, b) => a.e.at.localeCompare(b.e.at) || a.side - b.side || a.i - b.i);
  const theirSeqs = new Map(theirs.events.map((e) => [eventIdentity(e), e.seq]));
  const ourSeqs = new Map(ours.events.map((e) => [eventIdentity(e), e.seq]));
  let floor = Math.max(base?.floor_seq ?? 0, ours.floor_seq, theirs.floor_seq);
  const renumbers = ranked.some(({ e }, i) => {
    const k = eventIdentity(e);
    const merged = floor + i + 1;
    return (ourSeqs.get(k) ?? merged) !== merged || (theirSeqs.get(k) ?? merged) !== merged;
  });
  if (renumbers) floor = Math.max(floor, Math.max(ours.head_seq, theirs.head_seq) + 1);
  const events = ranked.map(({ e }, i) => ({ ...e, seq: floor + i + 1 }));
  const conflicts: string[] = [];
  const idempotency: Ledger["idempotency"] = { ...(base?.idempotency ?? {}), ...theirs.idempotency, ...ours.idempotency };
  for (const [key, entry] of Object.entries(theirs.idempotency)) {
    const mine = ours.idempotency[key];
    if (mine && mine.record_id !== entry.record_id) conflicts.push(`idempotency key ${key}: ours ${mine.record_id}, theirs ${entry.record_id} (kept ours)`);
  }
  for (const key of Object.keys(idempotency)) {
    const entry = idempotency[key]!;
    const at = events.find((e) => e.record_id === entry.record_id && e.record_hash === entry.record_hash);
    idempotency[key] = { ...entry, seq: at ? at.seq : Math.min(entry.seq, floor + events.length) };
  }
  return { ledger: { schema: LEDGER_SCHEMA_VERSION, scope: ours.scope, floor_seq: floor, head_seq: floor + events.length, events, idempotency }, conflicts };
}
