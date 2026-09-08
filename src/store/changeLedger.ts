/**
 * The per-scope change ledger behind `subscribe` — nuryel.ledger/1.
 *
 * One JSON file per scope partition under `<hunch dir>/changes/`, git-native like every
 * other record, appended atomically (con_902759b3dc). It holds the strictly ordered
 * ChangeEvent stream for that scope (seq 1, 2, 3 … with no gaps) plus the idempotency
 * table the write verb replays from. Seq is per scope, assigned by the writer in the
 * home the scope lives in; a scope has exactly ONE ledger, so there is never a second
 * sequence to reconcile. Merging two clones' ledgers for the same scope is not decided
 * here (see docs/nuryel-state-contract.md, "Not decided here").
 */
import { existsSync, mkdirSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { createHash } from "node:crypto";
import { z } from "zod";
import { writeFileAtomic } from "../core/io.js";
import { ChangeEventSchema, ScopeSchema, scopePath, type ChangeEvent, type Scope } from "../core/stateContract.js";

export const LEDGER_SCHEMA_VERSION = "nuryel.ledger/1" as const;
export const CHANGES_DIR = "changes";

const IdempotencyEntrySchema = z.object({
  record_id: z.string().min(1),
  record_hash: z.string(),
  facet: z.string(),
  seq: z.number().int().nonnegative(),
  at: z.string(),
}).strict();
export type IdempotencyEntry = z.infer<typeof IdempotencyEntrySchema>;

export const LedgerSchema = z.object({
  schema: z.literal(LEDGER_SCHEMA_VERSION),
  scope: ScopeSchema,
  head_seq: z.number().int().nonnegative(),
  events: z.array(ChangeEventSchema),
  idempotency: z.record(z.string(), IdempotencyEntrySchema).default({}),
}).strict();
export type Ledger = z.infer<typeof LedgerSchema>;

/** Scope ids may carry `:` `@` `+` (safe in the contract, not in every file system), so
 *  the file name is the sanitized id plus a short hash of the exact id — readable AND
 *  collision-free. The scope inside the file is authoritative, the name is a locator. */
export function ledgerFile(hunchDir: string, scope: Scope): string {
  const safe = scope.id.replace(/[^A-Za-z0-9._-]/g, "_").slice(0, 80);
  const tag = createHash("sha256").update(scopePath(scope)).digest("hex").slice(0, 8);
  return join(hunchDir, CHANGES_DIR, `${scope.kind}-${safe}-${tag}.json`);
}

export function emptyLedger(scope: Scope): Ledger {
  return { schema: LEDGER_SCHEMA_VERSION, scope, head_seq: 0, events: [], idempotency: {} };
}

/** Read the ledger for a scope; a missing file is an empty ledger, a corrupt one is an
 *  error (never silently treated as empty — that would restart the sequence). */
export function readLedger(hunchDir: string, scope: Scope): Ledger {
  const file = ledgerFile(hunchDir, scope);
  if (!existsSync(file)) return emptyLedger(scope);
  const raw = JSON.parse(readFileSync(file, "utf8")) as unknown;
  const ledger = LedgerSchema.parse(raw);
  if (scopePath(ledger.scope) !== scopePath(scope)) throw new Error(`ledger ${file} belongs to scope ${scopePath(ledger.scope)}, not ${scopePath(scope)}`);
  let expected = 1;
  for (const event of ledger.events) {
    if (event.seq !== expected) throw new Error(`ledger ${file} is not contiguous at seq ${event.seq} (expected ${expected})`);
    expected += 1;
  }
  if (ledger.head_seq !== ledger.events.length) throw new Error(`ledger ${file} head_seq ${ledger.head_seq} disagrees with ${ledger.events.length} events`);
  return ledger;
}

export function writeLedger(hunchDir: string, ledger: Ledger): void {
  const file = ledgerFile(hunchDir, ledger.scope);
  mkdirSync(join(hunchDir, CHANGES_DIR), { recursive: true });
  writeFileAtomic(file, JSON.stringify(LedgerSchema.parse(ledger), null, 2) + "\n");
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
): ChangeEvent[] {
  const ledger = readLedger(hunchDir, scope);
  const appended: ChangeEvent[] = [];
  for (const change of changes) {
    const event: ChangeEvent = ChangeEventSchema.parse({ schema: "nuryel.state.subscribe/1", seq: ledger.head_seq + 1, at, scope, ...change });
    ledger.events.push(event);
    ledger.head_seq = event.seq;
    appended.push(event);
  }
  if (idempotency) {
    ledger.idempotency[idempotency.key] = { ...idempotency.entry, seq: ledger.head_seq, at };
  }
  writeLedger(hunchDir, ledger);
  return appended;
}

/** The latest seq that touched a record in this scope, or 0 when the ledger never saw it. */
export function latestSeqFor(ledger: Ledger, recordId: string): number {
  for (let i = ledger.events.length - 1; i >= 0; i--) {
    if (ledger.events[i]!.record_id === recordId) return ledger.events[i]!.seq;
  }
  return 0;
}
