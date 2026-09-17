/** Task-scoped observations. Never infer task identity from time or a transport
 * connection. Memory remains in the Git store; these observations survive reindex. */
import { createHash, randomBytes } from "node:crypto";
import { existsSync, readFileSync, realpathSync, rmSync } from "node:fs";
import { join } from "node:path";
import { z } from "zod";
import { assertDeliveryEnvelope, type DeliveryEnvelope } from "./delivery.js";
import { isCredentialFreeText } from "./types.js";
import { withServedDatabase } from "./served.js";
import { assertReportPath, canonicalReportRoot } from "./taskReportPaths.js";

export const TASK_REPORT_SCHEMA = "hunch.task-report/1" as const;
export const TaskIdSchema = z.string().regex(/^htask_[a-f0-9]{24}$/);
const hashSchema = z.string().regex(/^sha256:[a-f0-9]{64}$/);
const safeText = (max: number) => z.string().min(1).max(max).refine(isCredentialFreeText, "credential material is not report evidence");
const MAX_EVENTS = 10_000;
const MAX_EVENT_BYTES = 256_000;
const MAX_TASK_BYTES = 8_000_000;
export function reportHash(value: unknown): string {
  const canonical = (v: unknown): string => {
    if (Array.isArray(v)) return `[${v.map(canonical).join(",")}]`;
    if (v && typeof v === "object") return `{${Object.entries(v).sort(([a], [b]) => a < b ? -1 : a > b ? 1 : 0).map(([k, x]) => `${JSON.stringify(k)}:${canonical(x)}`).join(",")}}`;
    return JSON.stringify(v) ?? "null";
  };
  return `sha256:${createHash("sha256").update(canonical(value)).digest("hex")}`;
}

export const ReportRecordSchema = z.object({
  record_id: safeText(512), kind: safeText(64), content_hash: hashSchema,
  title: z.string().max(500), lesson: z.string().max(12_000),
  recorded_at: z.string().max(64).nullable(),
}).strict();
export type ReportRecord = z.infer<typeof ReportRecordSchema>;
export const ReportClaimSchema = z.object({
  occurrence_id: z.string().regex(/^hocc_[a-f0-9]{24}$/),
  record_id: safeText(512), content_hash: hashSchema,
  action: safeText(1_000),
}).strict();
export type ReportClaim = z.infer<typeof ReportClaimSchema>;
export const ReportCheckSchema = z.object({
  check_id: z.string().regex(/^hev_[a-f0-9]{24}$/).optional(),
  label: safeText(200), command: z.array(safeText(1_024)).min(1).max(64),
  exit_code: z.number().int().nullable(), output_hash: hashSchema,
  before_snapshot: hashSchema.nullable(), after_snapshot: hashSchema.nullable(),
  snapshot_limitations: z.array(z.string().max(300)).max(16),
  timed_out: z.boolean(),
  cancelled: z.boolean().optional(),
  source: z.literal("local-command-runner"),
}).strict();
export type ReportCheck = z.infer<typeof ReportCheckSchema>;

export const ReportSaveSchema = z.object({
  source: z.literal("store-write"), record: ReportRecordSchema,
  home: z.enum(["public", "private"]), operation: z.enum(["created", "updated"]),
}).strict();
export type ReportSave = z.infer<typeof ReportSaveSchema>;
export const ReportDurabilitySchema = z.object({
  save_id: z.string().regex(/^hev_[a-f0-9]{24}$/),
  durability: z.enum(["committed", "pushed"]), commit: z.string().regex(/^(?:[a-f0-9]{40}|[a-f0-9]{64})$/),
  record_hash: hashSchema, source: z.literal("git-record-proof"),
  publication: z.object({ ref: safeText(512), basis: z.enum(["push-status", "remote-ref-confirmed"]) }).strict().optional(),
}).strict().superRefine((proof, ctx) => {
  if ((proof.durability === "pushed") !== !!proof.publication) ctx.addIssue({ code: z.ZodIssueCode.custom, message: "publication proof is required exactly for pushed revisions" });
});
export type ReportDurability = z.infer<typeof ReportDurabilitySchema>;

export const ReportRefusalSchema = z.object({
  source: z.literal("native-edit-gate"), outcome: z.literal("denial-emitted"),
  kind: z.enum(["constraint", "veto"]), record_id: safeText(512),
  target: safeText(1024), reason_hash: hashSchema,
}).strict();
export type ReportRefusal = z.infer<typeof ReportRefusalSchema>;

/** Hunch's own deterministic evaluation of a delivered lesson's DECLARED rule
 * (a constraint's forbids matcher or a decision's conformance predicate) against
 * the files this task changed. Only the local runner writes it; an agent cannot
 * submit one. File overlap alone never yields "satisfied": a lesson with no
 * machine-checkable rule stays `unavailable`, and a rule whose scope this task
 * never touched stays `not-exercised`. */
export const ReportConformanceSchema = z.object({
  source: z.literal("local-rule-check"),
  record_id: safeText(512), kind: z.enum(["constraints", "decisions"]), content_hash: hashSchema,
  rule: z.enum(["constraint-forbids", "decision-conformance"]),
  outcome: z.enum(["satisfied", "violated", "not-exercised", "unavailable"]),
  files: z.array(safeText(1024)).max(64),
  snapshot: hashSchema.nullable(),
  detail: z.string().max(1000),
}).strict();
export type ReportConformance = z.infer<typeof ReportConformanceSchema>;

const TaskSchema = z.object({
  task_id: TaskIdSchema, scope: hashSchema, title: safeText(200),
  started_at: z.string().datetime(), finished_at: z.string().datetime().nullable(),
  state: z.enum(["open", "completed", "interrupted"]),
  /** Who closed the task. "host": the lifecycle hook at Stop, a provisional
   * close that a continuation reopens and an explicit agent finish overrides.
   * Absent on rows written before this field existed (agent closes). */
  closed_by: z.enum(["agent", "host"]).optional(),
  /** Continuity across the prompts of one host session. `session_key` is a hash
   * of (root, provider, session, agent), never the identifier itself; `continues`
   * names the previous prompt's task when this prompt followed it within the
   * continuation window; `episode` names the first task of that chain, the id
   * the chain's graph record is written under. Absent on older rows and on
   * tasks started without a host session (one task, one episode). */
  session_key: hashSchema.optional(),
  continues: TaskIdSchema.optional(),
  episode: TaskIdSchema.optional(),
}).strict();
export type ReportTask = z.infer<typeof TaskSchema>;
export interface TaskDelivery {
  occurrence_id: string; at: string; receipt_id: string;
  envelope_hash: string; envelope: DeliveryEnvelope; records: ReportRecord[];
  /** What the caller asked context for (a file, symbol or task phrase); null for
   * deliveries recorded by releases that did not retain it. */
  target: string | null;
}
export interface TaskReport {
  schema: typeof TASK_REPORT_SCHEMA;
  task: ReportTask;
  deliveries: TaskDelivery[];
  /** `supported_by` names a current, satisfied rule evaluation of the SAME record
   * revision; the attribution itself stays the agent's. */
  claims: Array<ReportClaim & { at: string; attribution: "agent-reported"; supported_by: string | null }>;
  checks: Array<ReportCheck & { at: string; current: boolean }>;
  conformance: Array<ReportConformance & { event_id: string; at: string; current: boolean }>;
  saves: Array<ReportSave & { event_id: string; at: string; durability: "local" | "committed" | "pushed"; proofs: Array<ReportDurability & { at: string }> }>;
  refusals: Array<ReportRefusal & { event_id: string; at: string }>;
  coverage: "no-delivery-observed" | "no-relevant-memory" | "delivered";
  unknowns: string[];
  content_hash: string;
}

export const LessonReferenceSchema = z.object({
  kind: safeText(64), record_id: safeText(512), content_hash: hashSchema.optional(),
}).strict();
export type LessonReference = z.infer<typeof LessonReferenceSchema>;
export interface LessonHistory {
  schema: "hunch.lesson-history/1";
  reference: LessonReference;
  entries: Array<{ task: ReportTask; event_id: string; at: string; event: "delivery" | "save"; record: ReportRecord; receipt_id: string | null }>;
  index_complete: boolean;
  truncated: boolean;
  next_before: number | null;
}

type Database = Parameters<Parameters<typeof withServedDatabase>[1]>[0];
function taskDb<T>(root: string, run: (db: Database) => T): T {
  return withServedDatabase(root, (db) => {
    db.exec(`CREATE TABLE IF NOT EXISTS report_tasks (
      task_id TEXT PRIMARY KEY, scope TEXT NOT NULL, body TEXT NOT NULL
    );
    CREATE TABLE IF NOT EXISTS report_events (
      event_id TEXT PRIMARY KEY, task_id TEXT NOT NULL, kind TEXT NOT NULL,
      at TEXT NOT NULL, body TEXT NOT NULL, content_hash TEXT NOT NULL
    );
    CREATE INDEX IF NOT EXISTS report_events_task ON report_events(task_id);
    CREATE TABLE IF NOT EXISTS report_record_links (
      event_id TEXT NOT NULL, kind TEXT NOT NULL, record_id TEXT NOT NULL, content_hash TEXT NOT NULL,
      PRIMARY KEY (event_id, kind, record_id, content_hash)
    );
    CREATE INDEX IF NOT EXISTS report_record_lookup ON report_record_links(kind, record_id, content_hash);
    CREATE TABLE IF NOT EXISTS report_history_progress (id INTEGER PRIMARY KEY CHECK(id = 1), through_rowid INTEGER NOT NULL);
    INSERT OR IGNORE INTO report_history_progress VALUES (1, 0);
    CREATE TABLE IF NOT EXISTS report_task_aliases (alias_id TEXT PRIMARY KEY, task_id TEXT NOT NULL);`);
    return run(db);
  });
}

/** A prompt identity that reports to another prompt's task: a host notification
 * turn continues the session's latest task instead of opening a row. Explicit,
 * so Stop never selects a task by recency for a prompt it does not know. */
export function aliasReportTask(root: string, aliasId: string, taskId: string): void {
  TaskIdSchema.parse(aliasId);
  taskDb(root, db => transaction(db, () => {
    readTask(db, root, taskId);
    db.prepare("INSERT OR REPLACE INTO report_task_aliases VALUES (?, ?)").run(aliasId, taskId);
  }));
}
/** The task an aliased prompt identity reports to, or the identity itself. */
export function resolveReportTask(root: string, id: string): string {
  return taskDb(root, db => (db.prepare("SELECT task_id FROM report_task_aliases WHERE alias_id = ?").get(id) as { task_id: string } | undefined)?.task_id ?? id);
}

function deliveryRecords(kind: string, body: unknown): ReportRecord[] {
  if (kind === "save") return [ReportSaveSchema.parse(body).record];
  if (kind !== "delivery") return [];
  const value = body as { envelope: DeliveryEnvelope; records: unknown };
  assertDeliveryEnvelope(value.envelope);
  const records = z.array(ReportRecordSchema).max(512).parse(value.records);
  for (const record of records) {
    if (!value.envelope.delivered.some(r => r.kind === record.kind && r.record_id === record.record_id)) throw new Error("history record was not delivered");
  }
  return records;
}
function indexDeliveryRecords(db: Database, eventId: string, kind: string, body: unknown): void {
  const insert = db.prepare("INSERT OR IGNORE INTO report_record_links VALUES (?, ?, ?, ?)");
  for (const record of deliveryRecords(kind, body)) insert.run(eventId, record.kind, record.record_id, record.content_hash);
}

/** The lookup is derived, never evidence. Backfill at most 64 events and
 * 512 KB per read. Parse outside the writer transaction so a history view cannot
 * hold the writer lock while validating a large legacy ledger. */
export function readLessonHistory(root: string, reference: LessonReference, options: { limit?: number; before?: number } = {}): LessonHistory {
  const ref = LessonReferenceSchema.parse(reference);
  const { limit, before } = z.object({ limit: z.number().int().min(1).max(30).default(20), before: z.number().int().positive().max(Number.MAX_SAFE_INTEGER).optional() }).strict().parse(options);
  return taskDb(root, db => {
    const { progress, pending } = transaction(db, () => {
      const { through_rowid: progress } = db.prepare("SELECT through_rowid FROM report_history_progress WHERE id = 1").get() as { through_rowid: number };
      const sizes = db.prepare("SELECT rowid AS seq, length(CAST(body AS BLOB)) AS bytes FROM report_events WHERE rowid > ? ORDER BY rowid LIMIT 64").all(progress) as Array<{ seq: number; bytes: number }>;
      let bytes = 0, through = progress;
      for (const row of sizes) {
        if (row.bytes > MAX_EVENT_BYTES) throw new Error("history event exceeds the bounded evidence limit");
        if (bytes + row.bytes > 512_000) break;
        bytes += row.bytes;
        through = row.seq;
      }
      const pending = db.prepare("SELECT rowid AS seq, event_id, kind, body, content_hash FROM report_events WHERE rowid > ? AND rowid <= ? ORDER BY rowid").all(progress, through) as Array<{ seq: number; event_id: string; kind: string; body: string; content_hash: string }>;
      return { progress, pending };
    }, true);
    const prepared = pending.map(event => {
      const body: unknown = JSON.parse(event.body);
      if (reportHash(body) !== event.content_hash) throw new Error("report evidence hash mismatch");
      return { ...event, records: deliveryRecords(event.kind, body) };
    });
    if (prepared.length) transaction(db, () => {
      const current = db.prepare("SELECT through_rowid FROM report_history_progress WHERE id = 1").get() as { through_rowid: number };
      // A concurrent reader or expiry may have changed the derived cursor.
      // Leave it alone; the next read resumes from the current state.
      if (current.through_rowid !== progress) return;
      const exists = db.prepare("SELECT 1 FROM report_events WHERE rowid = ? AND event_id = ? AND content_hash = ?");
      if (prepared.some(event => !exists.get(event.seq, event.event_id, event.content_hash))) return;
      const insert = db.prepare("INSERT OR IGNORE INTO report_record_links VALUES (?, ?, ?, ?)");
      for (const event of prepared) for (const record of event.records) insert.run(event.event_id, record.kind, record.record_id, record.content_hash);
      db.prepare("UPDATE report_history_progress SET through_rowid = ? WHERE id = 1").run(prepared.at(-1)!.seq);
    });
    const { more, rows } = transaction(db, () => {
      const { through_rowid: through } = db.prepare("SELECT through_rowid FROM report_history_progress WHERE id = 1").get() as { through_rowid: number };
      const more = !!db.prepare("SELECT 1 FROM report_events WHERE rowid > ? LIMIT 1").get(through);
      const rows = db.prepare(`SELECT e.rowid AS seq, e.event_id, e.kind, e.at, e.body, e.content_hash, t.body AS task
        FROM report_record_links l JOIN report_events e ON e.event_id = l.event_id
        JOIN report_tasks t ON t.task_id = e.task_id
        WHERE t.scope IN (?, ?, ?) AND l.kind = ? AND l.record_id = ?
          AND (? IS NULL OR l.content_hash = ?) AND e.rowid < ?
        ORDER BY e.rowid DESC LIMIT ?`).all(...scopePair(root), ref.kind, ref.record_id, ref.content_hash ?? null, ref.content_hash ?? null, before ?? Number.MAX_SAFE_INTEGER, limit + 1) as Array<{ seq: number; event_id: string; kind: string; at: string; body: string; content_hash: string; task: string }>;
      return { more, rows };
    }, true);
    const entries = rows.slice(0, limit).map(row => {
      if (Buffer.byteLength(row.body) > MAX_EVENT_BYTES) throw new Error("history event exceeds the bounded evidence limit");
      const body = JSON.parse(row.body);
      if (reportHash(body) !== row.content_hash) throw new Error("report evidence hash mismatch");
      const record = deliveryRecords(row.kind, body).find(r => r.kind === ref.kind && r.record_id === ref.record_id && (!ref.content_hash || r.content_hash === ref.content_hash));
      if (!record || (row.kind !== "delivery" && row.kind !== "save")) throw new Error("history index does not match retained evidence");
      return { task: TaskSchema.parse(JSON.parse(row.task)), event_id: row.event_id, at: row.at, event: row.kind as "delivery" | "save", record, receipt_id: row.kind === "delivery" ? body.envelope.receipt_id as string : null };
    });
    // A cursor from a partial backfill would skip newer historical entries
    // indexed on the next read. Refresh this page until indexing completes.
    return { schema: "hunch.lesson-history/1", reference: ref, entries, index_complete: !more, truncated: rows.length > limit, next_before: !more && rows.length > limit ? rows[limit - 1]!.seq : null };
  });
}
/** Task scope = the physical repository root. Rows written by releases that hashed
 * the caller-cased realpath stay readable until they expire: the caller's own
 * spelling plus, on Windows, the other drive-letter case (a hook and an MCP
 * server spawned by the same host commonly disagree on exactly that). */
function scopeOf(root: string): string { return reportHash(canonicalReportRoot(root)); }
function scopePair(root: string): [string, string, string] {
  const legacy = realpathSync(root);
  const swapped = /^[A-Za-z]:/.test(legacy)
    ? (legacy.charAt(0) === legacy.charAt(0).toLowerCase() ? legacy.charAt(0).toUpperCase() : legacy.charAt(0).toLowerCase()) + legacy.slice(1)
    : legacy;
  return [scopeOf(root), reportHash(legacy), reportHash(swapped)];
}
function readTask(db: Database, root: string, id: string): ReportTask {
  TaskIdSchema.parse(id);
  const row = db.prepare("SELECT body FROM report_tasks WHERE task_id = ? AND scope IN (?, ?, ?)").get(id, ...scopePair(root)) as { body: string } | undefined;
  if (!row) throw new Error("task not found in this repository/worktree; use its exact task ID and working directory");
  return TaskSchema.parse(JSON.parse(row.body));
}
function transaction<T>(db: Database, run: () => T, readOnly = false): T {
  db.exec(readOnly ? "BEGIN" : "BEGIN IMMEDIATE");
  try { const result = run(); db.exec("COMMIT"); return result; }
  catch (error) { db.exec("ROLLBACK"); throw error; }
}
export interface TaskLinks { session_key?: string; continues?: string; episode?: string }
export function startReportTask(root: string, title: string, taskId?: string, links: TaskLinks = {}): ReportTask {
  const task = TaskSchema.parse({ task_id: taskId ?? `htask_${randomBytes(12).toString("hex")}`,
    scope: scopeOf(root), title, started_at: new Date().toISOString(), finished_at: null, state: "open", ...links });
  // Local observations have a bounded lifetime; durable project memory is untouched.
  pruneReportHistory(root);
  return taskDb(root, db => transaction(db, () => {
    const prior = db.prepare("SELECT body FROM report_tasks WHERE task_id = ?").get(task.task_id) as { body: string } | undefined;
    if (prior) {
      const existing = readTask(db, root, task.task_id);
      if (existing.title !== title) throw new Error("task identity already exists with a different title");
      return existing;
    }
    db.prepare("INSERT INTO report_tasks VALUES (?, ?, ?)").run(task.task_id, task.scope, JSON.stringify(task));
    return task;
  }));
}

/** A prompt that follows another in the same session within this window is the
 * same work: its task continues the previous one and shares its episode. */
export const CONTINUATION_WINDOW_MS = 30 * 60_000;
/** The links a new prompt's task takes from the latest task of its session, or
 * null when that task is too old (measured from its close) to be the same work.
 * A task still open is the session's current work however long ago it started:
 * the prompt was interrupted before Stop, or a late observation reopened it. */
export function continuationLinks(previous: ReportTask | null, nowMs = Date.now()): { continues: string; episode: string } | null {
  if (!previous) return null;
  const links = { continues: previous.task_id, episode: previous.episode ?? previous.task_id };
  if (previous.state === "open") return links;
  const reference = Date.parse(previous.finished_at ?? previous.started_at);
  if (!Number.isFinite(reference) || nowMs - reference > CONTINUATION_WINDOW_MS) return null;
  return links;
}
function newestSessionTask(db: Database, root: string, sessionKey: string): ReportTask | null {
  const row = db.prepare("SELECT body FROM report_tasks WHERE scope IN (?, ?, ?) AND json_extract(body, '$.session_key') = ? ORDER BY rowid DESC LIMIT 1").get(...scopePair(root), sessionKey) as { body: string } | undefined;
  return row ? TaskSchema.parse(JSON.parse(row.body)) : null;
}
/** The most recent task of a session in this worktree, or null. */
export function latestSessionTask(root: string, sessionKey: string): ReportTask | null {
  return taskDb(root, db => newestSessionTask(db, root, sessionKey));
}
/** Check-starts still inside their own timeout plus the grace window, minus the
 * results that arrived: while positive, a runner may still deliver a result. */
function pendingChecks(db: Database, taskId: string): number {
  const { pending } = db.prepare(`SELECT SUM(CASE WHEN kind = 'check-start' AND (julianday('now') - julianday(at)) * 86400000 < COALESCE(json_extract(body, '$.timeout_ms'), ${MAX_PENDING_CHECK_MS}) + ${CHECK_RESULT_GRACE_MS} THEN 1 WHEN kind = 'check' AND json_extract(body, '$.check_id') IS NOT NULL THEN -1 ELSE 0 END) AS pending FROM report_events WHERE task_id = ?`).get(taskId) as { pending: number | null };
  return pending ?? 0;
}
/** Tasks of a session that an earlier prompt left open are over once the
 * session moves on: the prompt was interrupted before its Stop, a notification
 * turn reused the task, or a late observation reopened it. Close them as host
 * closes, except `keepId` (the prompt now running), the session's newest task
 * when `keepNewest` (a notification turn continues it), and any task whose
 * verification may still deliver a result. Returns the ids closed here so the
 * caller can persist their records. */
export function settleSessionTasks(root: string, sessionKey: string, options: { keepId?: string | null; keepNewest?: boolean } = {}): string[] {
  return taskDb(root, db => transaction(db, () => {
    const rows = db.prepare("SELECT body FROM report_tasks WHERE scope IN (?, ?, ?) AND json_extract(body, '$.session_key') = ? AND json_extract(body, '$.state') = 'open' ORDER BY rowid").all(...scopePair(root), sessionKey) as Array<{ body: string }>;
    const newest = options.keepNewest ? newestSessionTask(db, root, sessionKey)?.task_id : undefined;
    const closed: string[] = [];
    for (const row of rows) {
      const task = TaskSchema.parse(JSON.parse(row.body));
      if (task.task_id === options.keepId || task.task_id === newest || pendingChecks(db, task.task_id) > 0) continue;
      db.prepare("UPDATE report_tasks SET body = ? WHERE task_id = ?").run(JSON.stringify(TaskSchema.parse({ ...task, state: "completed", finished_at: new Date().toISOString(), closed_by: "host" })), task.task_id);
      closed.push(task.task_id);
    }
    return closed;
  }));
}
/** Whether a task of ANOTHER session (or of no session) was open in this
 * worktree during the window: working-tree edits made then cannot be told apart
 * by mtime, so the caller attributes only commits. `ownIds` are the episode's
 * own tasks; any other task without a session key counts as foreign. */
export function sessionsOverlap(root: string, sessionKey: string | undefined, from: string, to: string | null, ownIds: readonly string[] = []): boolean {
  return taskDb(root, db => {
    const rows = db.prepare("SELECT body FROM report_tasks WHERE scope IN (?, ?, ?) AND json_extract(body, '$.started_at') <= ? AND (json_extract(body, '$.finished_at') IS NULL OR json_extract(body, '$.finished_at') >= ?)").all(...scopePair(root), to ?? new Date().toISOString(), from) as Array<{ body: string }>;
    return rows.some(r => {
      const task = TaskSchema.parse(JSON.parse(r.body));
      if (ownIds.includes(task.task_id)) return false;
      return !sessionKey || !task.session_key || task.session_key !== sessionKey;
    });
  });
}
/** Every task of an episode, oldest first: the head and the prompts that continued it. */
export function episodeTasks(root: string, headId: string): ReportTask[] {
  return taskDb(root, db => (db.prepare("SELECT body FROM report_tasks WHERE task_id = ? OR json_extract(body, '$.episode') = ? ORDER BY rowid").all(headId, headId) as Array<{ body: string }>).map(r => TaskSchema.parse(JSON.parse(r.body))));
}

function appendEvent(root: string, taskId: string, kind: string, body: unknown, eventId?: string): string {
  const encoded = JSON.stringify(body);
  if (Buffer.byteLength(encoded) > MAX_EVENT_BYTES) throw new Error("report event exceeds the bounded evidence limit");
  const id = eventId ?? `hev_${randomBytes(12).toString("hex")}`;
  if (!/^(hev|hocc)_[a-f0-9]{24}$/.test(id)) throw new Error("invalid report event identity");
  const contentHash = reportHash(body);
  return taskDb(root, db => transaction(db, () => {
    const task = readTask(db, root, taskId);
    const prior = db.prepare("SELECT task_id, kind, content_hash FROM report_events WHERE event_id = ?").get(id) as { task_id: string; kind: string; content_hash: string } | undefined;
    if (prior) {
      if (prior.task_id !== taskId || prior.kind !== kind || prior.content_hash !== contentHash) throw new Error("report event identity conflicts with existing evidence");
      return id;
    }
    // The task the observation lands on: the named one, unless the host closed
    // it and the session has since moved on.
    let target = task;
    if (task.state !== "open" && !(kind === "check" && task.state === "interrupted")) {
      if (task.closed_by !== "host") throw new Error("task is already closed; start a new task for new work");
      // The host closed this task at Stop. When a later prompt of the session
      // exists, this is that prompt's work named by an old id (the grounding
      // says to reuse ids): it lands on the session's newest task, which the
      // next Stop closes, instead of reopening one no Stop would close again.
      // Verification stays on its own task (a result must match its start), and
      // a task the agent closed is final. Otherwise the turn went on (another
      // hook's block, a resumed prompt): reopen; the next Stop closes it again.
      const newest = kind === "check" || kind === "check-start" || !task.session_key ? null : newestSessionTask(db, root, task.session_key);
      if (newest && newest.task_id !== task.task_id && (newest.state === "open" || newest.closed_by === "host")) target = newest;
      if (target.state !== "open") {
        target = TaskSchema.parse({ ...target, state: "open", finished_at: null, closed_by: undefined });
        db.prepare("UPDATE report_tasks SET body = ? WHERE task_id = ?").run(JSON.stringify(target), target.task_id);
      }
    }
    const tid = target.task_id;
    if (kind === "check") {
      const check = ReportCheckSchema.parse(body);
      if (!check.check_id || !db.prepare("SELECT event_id FROM report_events WHERE event_id = ? AND task_id = ? AND kind = 'check-start'").get(check.check_id, tid)) throw new Error("verification result has no matching start in this task");
    }
    const { total, bytes } = db.prepare("SELECT COUNT(*) AS total, COALESCE(SUM(length(CAST(body AS BLOB))), 0) AS bytes FROM report_events WHERE task_id = ?").get(tid) as { total: number; bytes: number };
    const reserved = Math.max(0, pendingChecks(db, tid) + (kind === "check-start" ? 1 : kind === "check" ? -1 : 0));
    if (total + 1 + reserved > MAX_EVENTS || bytes + Buffer.byteLength(encoded) + reserved * MAX_EVENT_BYTES > MAX_TASK_BYTES) throw new Error("task observation limit reached; start a new task");
    if (kind === "claim") {
      const claim = ReportClaimSchema.parse(body);
      const row = db.prepare("SELECT body FROM report_events WHERE event_id = ? AND task_id = ? AND kind = 'delivery'").get(claim.occurrence_id, tid) as { body: string } | undefined;
      if (!row) throw new Error("claim does not refer to a delivery in this task");
      const delivery = JSON.parse(row.body) as { records: ReportRecord[] };
      if (!delivery.records.some(r => r.record_id === claim.record_id && r.content_hash === claim.content_hash)) throw new Error("claim record revision was not delivered in this task");
    }
    const inserted = db.prepare("INSERT INTO report_events VALUES (?, ?, ?, ?, ?, ?)").run(id, tid, kind, new Date().toISOString(), encoded, contentHash);
    indexDeliveryRecords(db, id, kind, body);
    // Advance only over contiguous observed inserts; an older writer may have
    // left unindexed events. Historical gaps are filled by bounded reads above.
    const seq = Number(inserted.lastInsertRowid);
    db.prepare("UPDATE report_history_progress SET through_rowid = ? WHERE id = 1 AND through_rowid = ?").run(seq, seq - 1);
    return id;
  }));
}

/** The record revisions among `records` that this task has not received before.
 * Powers the one-line "Hunch recalled …" indication on a lesson's FIRST delivery
 * in a task; repeats of the same revision stay silent (deduplicated per task and
 * revision, never per session or file). Read-only; never throws for callers
 * that must stay silent on failure — they catch. */
export function unseenLessons(root: string, taskId: string, records: readonly ReportRecord[]): ReportRecord[] {
  if (!records.length) return [];
  return taskDb(root, db => {
    readTask(db, root, taskId);
    const seen = db.prepare(`SELECT 1 FROM report_record_links l JOIN report_events e ON e.event_id = l.event_id
      WHERE e.task_id = ? AND e.kind = 'delivery' AND l.kind = ? AND l.record_id = ? AND l.content_hash = ? LIMIT 1`);
    return records.filter(r => !seen.get(taskId, r.kind, r.record_id, r.content_hash));
  });
}
/** Strict operation for explicit callers. Passive integrations catch failure
 * and disclose it without blocking context delivery. Empty envelopes count. */
export function recordTaskDelivery(root: string, taskId: string, envelope: DeliveryEnvelope, records: ReportRecord[], occurrenceId = `hocc_${randomBytes(12).toString("hex")}`, target?: string): string {
  assertDeliveryEnvelope(envelope);
  const snapshots = z.array(ReportRecordSchema).max(512).parse(records);
  const seen = new Set<string>();
  for (const record of snapshots) {
    const key = `${record.kind}:${record.record_id}`;
    if (seen.has(key) || !envelope.delivered.some(r => r.record_id === record.record_id && r.kind === record.kind)) throw new Error("snapshot is duplicated or was not delivered");
    seen.add(key);
  }
  // The target is optional so envelopes recorded without one keep their exact
  // event hash; it is bounded like any other retained text.
  const retainedTarget = typeof target === "string" && target.trim() && target.length <= 1024 && isCredentialFreeText(target) ? target : undefined;
  return appendEvent(root, taskId, "delivery", { envelope, records: snapshots, ...(retainedTarget ? { target: retainedTarget } : {}) }, occurrenceId);
}
export function recordReportClaim(root: string, taskId: string, claim: ReportClaim): string {
  const value = ReportClaimSchema.parse(claim);
  return appendEvent(root, taskId, "claim", value, `hev_${reportHash({ taskId, value }).slice(7, 31)}`);
}
/** Internal write-path observers; no MCP endpoint accepts fabricated saves or
 * publication claims. Retained observations never authorize memory mutations. */
export function recordReportSave(root: string, taskId: string, save: ReportSave): string {
  return appendEvent(root, taskId, "save", ReportSaveSchema.parse(save));
}
export function recordReportDurability(root: string, taskId: string, proof: ReportDurability): string {
  const value = ReportDurabilitySchema.parse(proof);
  const report = readTaskReport(root, taskId);
  if (!report.saves.some(s => s.event_id === value.save_id && s.record.content_hash === value.record_hash)) throw new Error("durability proof does not name an exact save in this task");
  return appendEvent(root, taskId, "durability", value);
}
/** Internal observer of an actual emitted edit denial. This is not a model
 * assertion and does not establish that the host honored the response. */
export function recordReportRefusal(root: string, taskId: string, refusal: ReportRefusal): string {
  return appendEvent(root, taskId, "refusal", ReportRefusalSchema.parse(refusal));
}
/** Only the local rule runner calls this; no MCP endpoint accepts a submitted
 * outcome. The evaluated revision must be one this task actually received. */
export function recordReportConformance(root: string, taskId: string, conformance: ReportConformance): string {
  const value = ReportConformanceSchema.parse(conformance);
  const report = readTaskReport(root, taskId);
  if (!report.deliveries.some(d => d.records.some(r => r.kind === value.kind && r.record_id === value.record_id && r.content_hash === value.content_hash))) throw new Error("rule evaluation does not name a record revision delivered in this task");
  return appendEvent(root, taskId, "conformance", value);
}
/** Only the local runner calls this. MCP never accepts a claimed successful check. */
export function recordReportCheck(root: string, taskId: string, check: ReportCheck): string {
  const value = ReportCheckSchema.parse(check);
  if (!value.check_id) throw new Error("verification result requires a reserved check identity");
  return appendEvent(root, taskId, "check", value, `hev_${reportHash({ taskId, check: value.check_id }).slice(7, 31)}`);
}
/** A start without a result blocks completion only while the runner could still
 * deliver one: its own timeout plus a minute of grace. After that the runner is
 * gone (a killed process, a closed laptop) and the report's unknowns already say
 * the result was not retained; freezing the task forever would add nothing.
 * Starts recorded before the timeout was retained use the verification ceiling. */
export const CHECK_RESULT_GRACE_MS = 60_000;
export const MAX_PENDING_CHECK_MS = 6 * 60 * 60_000;
export function beginReportCheck(root: string, taskId: string, label: string, timeoutMs?: number): string {
  const timeout = Number.isInteger(timeoutMs) && (timeoutMs as number) > 0 ? { timeout_ms: timeoutMs } : {};
  return appendEvent(root, taskId, "check-start", { label: safeText(200).parse(label), ...timeout });
}
/** `by: "host"` is the lifecycle hook closing the prompt's task at Stop. It is
 * provisional: a later observation reopens the task (see appendEvent) and an
 * explicit agent finish, with any outcome, replaces it. Pending verification
 * keeps the task open for either closer. */
export function finishReportTask(root: string, taskId: string, state: "completed" | "interrupted" = "completed", options: { by?: "agent" | "host" } = {}): ReportTask {
  const by = options.by ?? "agent";
  return taskDb(root, db => transaction(db, () => {
    const task = readTask(db, root, taskId);
    if (task.state !== "open") {
      if (task.closed_by === "host" && by === "agent") {
        const confirmed = TaskSchema.parse({ ...task, state, finished_at: task.state === state ? task.finished_at : new Date().toISOString(), closed_by: "agent" });
        db.prepare("UPDATE report_tasks SET body = ? WHERE task_id = ?").run(JSON.stringify(confirmed), taskId);
        return confirmed;
      }
      if (task.state !== state) throw new Error("task already closed with a different outcome");
      return task;
    }
    if (state === "completed") {
      const { pending } = db.prepare(`SELECT SUM(CASE WHEN kind = 'check-start' AND (julianday('now') - julianday(at)) * 86400000 < COALESCE(json_extract(body, '$.timeout_ms'), ${MAX_PENDING_CHECK_MS}) + ${CHECK_RESULT_GRACE_MS} THEN 1 WHEN kind = 'check' AND json_extract(body, '$.check_id') IS NOT NULL THEN -1 ELSE 0 END) AS pending FROM report_events WHERE task_id = ?`).get(taskId) as { pending: number | null };
      if ((pending ?? 0) > 0) throw new Error("verification is still running or was interrupted; wait for its result or close the task as interrupted");
    }
    const finished = TaskSchema.parse({ ...task, state, finished_at: new Date().toISOString(), closed_by: by });
    db.prepare("UPDATE report_tasks SET body = ? WHERE task_id = ?").run(JSON.stringify(finished), taskId);
    return finished;
  }));
}
/** A report with no observation of any kind. Presentation surfaces may stay
 * silent for it; the task row itself is retained so "never touched Hunch" is
 * still countable (hunch report / the VS Code view / task list). */
export function isEmptyTaskReport(report: Pick<TaskReport, "deliveries" | "claims" | "checks" | "conformance" | "saves" | "refusals">): boolean {
  return !report.deliveries.length && !report.claims.length && !report.checks.length && !report.conformance.length && !report.saves.length && !report.refusals.length;
}

export interface TaskSummary {
  task: ReportTask;
  deliveries: number;
  lessons: number;
  claims: number;
  saves: number;
  refusals: number;
  /** Standing of the last recorded check, or null when none ran. */
  check: { label: string; state: "passed" | "failed" | "timed out" | "cancelled"; current: boolean } | null;
  /** Any delivered rule evaluated as violated on the changed files. */
  violated: boolean;
  coverage: TaskReport["coverage"];
  empty: boolean;
  /** Generated evidence view, when one has been written for this task. */
  report_html: string | null;
  /** Set when the observation ledger could not be read for this task. */
  error: string | null;
  /** Set when the task has a graph record (.hunch/tasks/), and where it lives. */
  durable?: { home: "public" | "private" } | null;
}

/** One bounded summary per recent task for status lines and host views; the
 * card and evidence view remain the authoritative renderings. */
export function summarizeTaskReport(root: string, taskId: string, currentSnapshot: string | null = null): TaskSummary {
  const html = join(root, ".hunch-cache", "reports", `${taskId}.html`);
  try {
    const report = readTaskReport(root, taskId, currentSnapshot);
    const last = report.checks.at(-1);
    const standing = new Map(report.conformance.map(r => [`${r.kind}:${r.record_id}:${r.content_hash}`, r]));
    return {
      task: report.task,
      deliveries: report.deliveries.length,
      lessons: new Set(report.deliveries.flatMap(d => d.records).map(r => `${r.kind}:${r.record_id}`)).size,
      claims: report.claims.length,
      saves: report.saves.length,
      refusals: report.refusals.length,
      check: last ? { label: last.label, state: last.cancelled ? "cancelled" : last.timed_out ? "timed out" : last.exit_code === 0 ? "passed" : "failed", current: last.current } : null,
      violated: [...standing.values()].some(r => r.outcome === "violated"),
      coverage: report.coverage,
      empty: isEmptyTaskReport(report),
      report_html: existsSync(html) ? html : null,
      error: null,
    };
  } catch (e) {
    return taskDb(root, db => {
      const row = db.prepare("SELECT body FROM report_tasks WHERE task_id = ?").get(taskId) as { body: string } | undefined;
      if (!row) throw e;
      return { task: TaskSchema.parse(JSON.parse(row.body)), deliveries: 0, lessons: 0, claims: 0, saves: 0, refusals: 0, check: null, violated: false, coverage: "no-delivery-observed" as const, empty: true, report_html: existsSync(html) ? html : null, error: (e as Error).message };
    });
  }
}

export function listTaskSummaries(root: string, limit = 30, currentSnapshot: string | null = null): TaskSummary[] {
  if (!existsSync(join(root, ".hunch-cache", "served.db"))) return [];
  return listReportTasks(root).slice(0, Math.max(1, Math.min(limit, 30))).map(task => summarizeTaskReport(root, task.task_id, currentSnapshot));
}

/** One line for a terminal status line. Empty string when nothing was observed
 * for the task, so a bare prompt shows no Hunch noise at all. */
export function renderTaskStatusLine(summary: TaskSummary | null): string {
  if (!summary || summary.empty) return "";
  const parts = [`Hunch`];
  parts.push(summary.lessons ? `${summary.lessons} lesson${summary.lessons === 1 ? "" : "s"} recalled` : summary.deliveries ? "memory delivered" : "no delivery");
  if (summary.violated) parts.push("rule violated");
  else if (summary.claims) parts.push(`${summary.claims} applied`);
  if (summary.saves) parts.push(`${summary.saves} saved`);
  if (summary.refusals) parts.push("edit denied");
  if (summary.check) parts.push(`${summary.check.label}: ${summary.check.state}${summary.check.current ? "" : " (source changed)"}`);
  else parts.push("no check recorded");
  return parts.join(" · ");
}

export interface TaskReportStats {
  since: string;
  tasks: number;
  completed: number;
  with_delivery: number;
  with_check: number;
  with_claim: number;
  with_save: number;
  with_refusal: number;
  empty: number;
  /** with_delivery / tasks, the adherence number worth watching; null when no tasks. */
  delivery_rate: number | null;
}

/** Adherence over a window: how many prompts Hunch actually reached. Counts
 * come from the ledger, never from agent claims; a claim is counted as a claim. */
export function taskReportStats(root: string, days = 7): TaskReportStats {
  const since = new Date(Date.now() - Math.max(1, days) * 86_400_000).toISOString();
  const empty: TaskReportStats = { since, tasks: 0, completed: 0, with_delivery: 0, with_check: 0, with_claim: 0, with_save: 0, with_refusal: 0, empty: 0, delivery_rate: null };
  if (!existsSync(join(root, ".hunch-cache", "served.db"))) return empty;
  return taskDb(root, db => {
    const tasks = (db.prepare("SELECT body FROM report_tasks WHERE scope IN (?, ?, ?) AND json_extract(body, '$.started_at') >= ?").all(...scopePair(root), since) as Array<{ body: string }>)
      .map(r => TaskSchema.parse(JSON.parse(r.body)));
    if (!tasks.length) return empty;
    const kinds = (taskId: string) => new Set((db.prepare("SELECT DISTINCT kind FROM report_events WHERE task_id = ?").all(taskId) as Array<{ kind: string }>).map(r => r.kind));
    const stats = { ...empty, tasks: tasks.length };
    for (const task of tasks) {
      const k = kinds(task.task_id);
      if (task.state === "completed") stats.completed++;
      if (k.has("delivery")) stats.with_delivery++;
      if (k.has("check") || k.has("check-start")) stats.with_check++;
      if (k.has("claim")) stats.with_claim++;
      if (k.has("save")) stats.with_save++;
      if (k.has("refusal")) stats.with_refusal++;
      if (!k.size) stats.empty++;
    }
    stats.delivery_rate = stats.with_delivery / stats.tasks;
    return stats;
  });
}

export function listReportTasks(root: string): ReportTask[] {
  return taskDb(root, db => (db.prepare("SELECT body FROM report_tasks WHERE scope IN (?, ?, ?) ORDER BY rowid DESC LIMIT 30").all(...scopePair(root)) as Array<{ body: string }>).map(r => TaskSchema.parse(JSON.parse(r.body))));
}
export function reportActivity(root: string): string {
  if (!existsSync(join(root, ".hunch-cache", "served.db"))) return "Task reporting: no task activity observed yet. Reconnect the agent after updating; inspect with `hunch report`.";
  try {
    return taskDb(root, db => {
      const row = db.prepare(`SELECT COUNT(*) AS total, SUM(CASE WHEN json_extract(body, '$.state') = 'completed' THEN 1 ELSE 0 END) AS completed FROM report_tasks WHERE scope IN (?, ?, ?)`).get(...scopePair(root)) as { total: number; completed: number | null };
      const { deliveries } = db.prepare("SELECT COUNT(*) AS deliveries FROM report_events WHERE kind = 'delivery' AND task_id IN (SELECT task_id FROM report_tasks WHERE scope IN (?, ?, ?))").get(...scopePair(root)) as { deliveries: number };
      return `Task reporting: ${row.total} observed task(s), ${row.completed ?? 0} completed report(s), ${deliveries} linked context delivery(s). Activity alone does not prove contribution; inspect with \`hunch report\`.`;
    });
  } catch { return "Task reporting: observation ledger unavailable; activity and contribution are unverified."; }
}
/** Exact task deletion is a user-invoked operation, never a memory deletion. */
export function forgetReportTask(root: string, taskId: string): void {
  taskDb(root, db => transaction(db, () => {
    const task = readTask(db, root, taskId);
    if (task.state === "open") throw new Error("close the task before deleting its report history");
    const file = assertReportPath(root, ".hunch-cache", "reports", `${task.task_id}.html`);
    rmSync(file, { force: true });
    rmSync(assertReportPath(root, ".hunch-cache", "reports", `${task.task_id}.public.html`), { force: true });
    db.prepare("DELETE FROM report_record_links WHERE event_id IN (SELECT event_id FROM report_events WHERE task_id = ?)").run(taskId);
    db.prepare("DELETE FROM report_events WHERE task_id = ?").run(taskId);
    db.prepare("DELETE FROM report_tasks WHERE task_id = ?").run(taskId);
    db.exec("UPDATE report_history_progress SET through_rowid = 0 WHERE id = 1");
  }));
}
export function pruneReportHistory(root: string, olderThanDays = 90): number {
  if (!Number.isInteger(olderThanDays) || olderThanDays < 1 || olderThanDays > 3650) throw new Error("retention must be 1–3650 days");
  const cutoff = new Date(Date.now() - olderThanDays * 86_400_000).toISOString();
  return taskDb(root, db => transaction(db, () => {
    const expired = db.prepare(`SELECT task_id FROM report_tasks
      WHERE scope IN (?, ?, ?) AND ((json_extract(body, '$.state') != 'open' AND json_extract(body, '$.finished_at') < ?)
        OR (json_extract(body, '$.state') = 'open' AND json_extract(body, '$.started_at') < ?)) LIMIT 1000`)
      .all(...scopePair(root), cutoff, cutoff) as Array<{ task_id: string }>;
    for (const task of expired) {
      // Serialize expiry with concurrent starts/results. Discard abandoned
      // evidence without inventing a completion or interruption observation.
      TaskIdSchema.parse(task.task_id);
      rmSync(assertReportPath(root, ".hunch-cache", "reports", `${task.task_id}.html`), { force: true });
      rmSync(assertReportPath(root, ".hunch-cache", "reports", `${task.task_id}.public.html`), { force: true });
      db.prepare("DELETE FROM report_record_links WHERE event_id IN (SELECT event_id FROM report_events WHERE task_id = ?)").run(task.task_id);
      db.prepare("DELETE FROM report_events WHERE task_id = ?").run(task.task_id);
      db.prepare("DELETE FROM report_tasks WHERE task_id = ?").run(task.task_id);
    }
    if (expired.length) db.exec("UPDATE report_history_progress SET through_rowid = 0 WHERE id = 1");
    return expired.length;
  }));
}
export function reportPresentationEnabled(root: string): boolean {
  try { return JSON.parse(readFileSync(join(root, ".hunch", "local.json"), "utf8")).reportPresentation !== false; }
  catch { return true; }
}
export function readTaskReport(root: string, taskId: string, currentSnapshot: string | null = null): TaskReport {
  const { task, events } = taskDb(root, db => transaction(db, () => {
    const task = readTask(db, root, taskId);
    const { bytes } = db.prepare("SELECT COALESCE(SUM(length(CAST(body AS BLOB))), 0) AS bytes FROM report_events WHERE task_id = ?").get(taskId) as { bytes: number };
    if (bytes > MAX_TASK_BYTES) throw new Error("report exceeds the bounded evidence byte limit");
    const events = db.prepare("SELECT event_id, kind, at, body, content_hash FROM report_events WHERE task_id = ? ORDER BY rowid LIMIT ?").all(taskId, MAX_EVENTS + 1) as Array<{ event_id: string; kind: string; at: string; body: string; content_hash: string }>;
    if (events.length > MAX_EVENTS) throw new Error("report exceeds the bounded observation limit");
    if (events.reduce((sum, event) => sum + Buffer.byteLength(event.body), 0) > MAX_TASK_BYTES) throw new Error("report exceeds the bounded evidence byte limit");
    return { task, events };
  }, true));
    // Parse and derive outside the transaction: rendering must not hold a write lock.
    const deliveries: TaskDelivery[] = [], claims: TaskReport["claims"] = [], checks: TaskReport["checks"] = [], refusals: TaskReport["refusals"] = [], saves: TaskReport["saves"] = [], conformance: TaskReport["conformance"] = [];
    for (const event of events) {
      const value = JSON.parse(event.body);
      if (reportHash(value) !== event.content_hash) throw new Error("report evidence hash mismatch");
      if (event.kind === "delivery") {
        assertDeliveryEnvelope(value.envelope);
        deliveries.push({ occurrence_id: event.event_id, at: event.at, receipt_id: value.envelope.receipt_id, envelope_hash: reportHash(value.envelope), envelope: value.envelope, records: z.array(ReportRecordSchema).parse(value.records), target: typeof value.target === "string" ? value.target : null });
      } else if (event.kind === "claim") claims.push({ ...ReportClaimSchema.parse(value), at: event.at, attribution: "agent-reported", supported_by: null });
      else if (event.kind === "conformance") {
        const rule = ReportConformanceSchema.parse(value);
        conformance.push({ ...rule, event_id: event.event_id, at: event.at, current: currentSnapshot !== null && rule.snapshot === currentSnapshot });
      }
      else if (event.kind === "save") saves.push({ ...ReportSaveSchema.parse(value), event_id: event.event_id, at: event.at, durability: "local", proofs: [] });
      else if (event.kind === "durability") {
        const proof = ReportDurabilitySchema.parse(value);
        const save = saves.find(s => s.event_id === proof.save_id && s.record.content_hash === proof.record_hash);
        if (!save) throw new Error("durability proof does not match retained save");
        save.proofs.push({ ...proof, at: event.at });
        if (save.durability !== "pushed") save.durability = proof.durability;
      }
      else if (event.kind === "refusal") refusals.push({ ...ReportRefusalSchema.parse(value), event_id: event.event_id, at: event.at });
      else if (event.kind === "check") {
        const check = ReportCheckSchema.parse(value);
        checks.push({ ...check, at: event.at, current: currentSnapshot !== null && check.before_snapshot === currentSnapshot && check.after_snapshot === currentSnapshot });
      } else if (event.kind !== "check-start") throw new Error("unsupported report event kind; update Hunch before reading this report");
    }
    // The LAST evaluation of a record revision is its standing; a satisfied rule
    // supports a claim only while the evaluated source is still the current source.
    const standing = new Map<string, TaskReport["conformance"][number]>();
    for (const rule of conformance) standing.set(`${rule.kind}:${rule.record_id}:${rule.content_hash}`, rule);
    const supported = [...standing.values()].filter(rule => rule.outcome === "satisfied" && rule.current);
    for (const claim of claims) {
      const rule = supported.find(r => r.record_id === claim.record_id && r.content_hash === claim.content_hash);
      claim.supported_by = rule?.event_id ?? null;
    }
    const delivered = deliveries.reduce((n, d) => n + d.envelope.delivered.length, 0);
    const unknowns: string[] = [];
    if (!deliveries.length) unknowns.push("No task-linked context delivery was observed. This does not establish that the agent did not use Hunch.");
    if (deliveries.some(d => d.records.length !== d.envelope.delivered.length)) unknowns.push("Some delivered records lack an exact retained snapshot.");
    if (deliveries.some(d => d.envelope.abstention.active)) unknowns.push("Some memory was withheld because relevance or confidence was insufficient.");
    if (!claims.length && delivered && !supported.length) unknowns.push("Memory was delivered; its contribution to the result is unverified.");
    if (claims.some(c => !c.supported_by)) unknowns.push("An agent-reported application has no current, satisfied rule evaluation supporting it.");
    if ([...standing.values()].some(r => r.outcome === "violated")) unknowns.push("The changed files violate a delivered lesson's declared rule.");
    if ([...standing.values()].some(r => r.outcome === "satisfied" && !r.current)) unknowns.push("A delivered rule was satisfied when evaluated, but source has changed since; re-run the evaluation.");
    if ([...standing.values()].some(r => r.outcome === "not-exercised")) unknowns.push("Some delivered rules were not exercised: no changed file falls in their scope.");
    if ([...standing.values()].some(r => r.outcome === "unavailable")) unknowns.push("Some delivered lessons declare no machine-checkable rule or could not be evaluated; their application is agent-reported at best.");
    if (saves.some(s => s.durability === "local")) unknowns.push("Some saved revisions have no exact Git commit or push proof; they were observed written locally.");
    if (refusals.length) unknowns.push("A denial response was emitted. Whether the host honored it, or a bug was prevented, is not established.");
    if (!checks.length) unknowns.push("No independent command verification was recorded for this task.");
    if (events.filter(e => e.kind === "check-start").length > checks.filter(c => c.check_id).length) unknowns.push("A verification command is still running or its result was not retained.");
    if (task.state === "open") unknowns.push("Task is still open; completion has not been observed.");
    if (task.state === "interrupted") unknowns.push("Task was interrupted; no successful completion is implied.");
    const unsigned = { schema: TASK_REPORT_SCHEMA, task, deliveries, claims, checks, conformance, refusals, saves, coverage: !deliveries.length ? "no-delivery-observed" as const : !delivered ? "no-relevant-memory" as const : "delivered" as const, unknowns };
    return { ...unsigned, content_hash: reportHash(unsigned) };
}
