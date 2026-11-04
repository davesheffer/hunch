/**
 * `hunch ui` writes: a page request becomes one CLI memory move (`hunch edit | link |
 * remove | restore <id> --json`, or `hunch review --confirm | --unconfirm <id> --json`),
 * and every result carries the inverse move as its Undo.
 *
 * Pure: the request body is allowlisted field by field into argv (`--flag=value`, so a
 * value starting with "-" is never read as an option; no shell), and the undo is built
 * from the CLI's own before/after records. The CLI owns validation, git and the store.
 */
import { TESTIMONY_CONFIDENCE, kindOfId, type MemoryKind as RecordKind } from "../core/memoryEdit.js";

export const UI_ACTIONS = ["edit", "link", "remove", "restore", "confirm", "unconfirm"] as const;
export type UiAction = (typeof UI_ACTIONS)[number];

export const isUiAction = (v: string): v is UiAction => (UI_ACTIONS as readonly string[]).includes(v);

const MAX_TEXT = 20_000;
const MAX_LIST = 200;
/** Windows caps a command line near 32K characters; past it the CLI never starts. */
const MAX_ARGV = 30_000;
const ID = /^(?:dec|con|bug|fnd)_[A-Za-z0-9_-]{1,120}$/;

type Args = { ok: true; args: string[] } | { ok: false; error: string };
type Body = Record<string, unknown>;

const STRING_FIELDS: Record<UiAction, readonly string[]> = {
  edit: ["title", "text", "context", "rationale"],
  link: ["feature"],
  remove: ["reason"],
  restore: ["status"],
  confirm: ["severity"],
  unconfirm: ["severity"],
};
const LIST_FIELDS: Record<UiAction, readonly (readonly [string, string])[]> = {
  edit: [],
  link: [["addFiles", "--add-file"], ["removeFiles", "--remove-file"], ["addComponents", "--add-component"], ["removeComponents", "--remove-component"]],
  remove: [],
  restore: [],
  confirm: [],
  unconfirm: [],
};
const FLAG: Record<string, string> = {
  title: "--title", text: "--text", context: "--context", rationale: "--rationale",
  feature: "--feature", reason: "--reason", status: "--status", severity: "--severity",
};
/** Signing is a `hunch review` act, not a memory move of its own. */
const isReview = (action: UiAction): boolean => action === "confirm" || action === "unconfirm";

/** The CLI argv (after the entry script) for one UI action, or why the request is malformed.
 *  `private`: the store has an overlay, so `hunch review` must look there too (`--private`). */
export function actionArgs(action: UiAction, id: string, body: unknown, ctx: { private?: boolean } = {}): Args {
  if (!ID.test(id)) return { ok: false, error: `"${id}" is not a memory id.` };
  if (body === null || typeof body !== "object" || Array.isArray(body)) return { ok: false, error: "Send a JSON object." };
  const b = body as Body;
  const known = new Set([...STRING_FIELDS[action], ...LIST_FIELDS[action].map(([k]) => k), ...(action === "link" ? ["clearFeature"] : [])]);
  const unknown = Object.keys(b).filter((k) => !known.has(k));
  if (unknown.length) return { ok: false, error: `Unknown field for ${action}: ${unknown.join(", ")}.` };

  const args: string[] = isReview(action) ? ["review", `--${action}=${id}`] : [action, id];
  for (const k of STRING_FIELDS[action]) {
    const v = b[k];
    if (v === undefined) continue;
    if (typeof v !== "string" || v.length > MAX_TEXT || v.includes("\0")) return { ok: false, error: `${k} must be text under ${MAX_TEXT} characters.` };
    args.push(`${FLAG[k]}=${v}`);
  }
  for (const [k, flag] of LIST_FIELDS[action]) {
    const v = b[k];
    if (v === undefined) continue;
    if (!Array.isArray(v) || v.length > MAX_LIST || !v.every((x) => typeof x === "string" && x.length <= 1_024 && !x.includes("\0"))) {
      return { ok: false, error: `${k} must be a list of up to ${MAX_LIST} paths or ids.` };
    }
    for (const x of v as string[]) args.push(`${flag}=${x}`);
  }
  if (action === "link" && b.clearFeature !== undefined) {
    if (b.clearFeature !== true) return { ok: false, error: "clearFeature must be true when given." };
    args.push("--clear-feature");
  }
  if (isReview(action) && ctx.private) args.push("--private");
  args.push("--json");
  if (args.reduce((n, a) => n + a.length + 1, 0) > MAX_ARGV) return { ok: false, error: `That change is too large to save at once (over ${MAX_ARGV} characters). Save it in parts.` };
  return { ok: true, args };
}

/** The page's kinds for new memory, mapped to `hunch new <kind>`. */
const NEW_KIND: Record<string, string> = { decision: "decision", rule: "constraint", finding: "finding" };
const NEW_STRINGS: Record<string, string> = {
  title: "--title", text: "--text", context: "--context", rationale: "--rationale",
  feature: "--feature", severity: "--severity", status: "--status",
};
const NEW_LISTS: Record<string, string> = { rejected: "--rejected", evidence: "--evidence", files: "--file", components: "--component" };

/** The CLI argv for one new memory (`hunch new <kind> … --json`), or why the request is
 *  malformed. Which fields fit which kind is the CLI's call; this only allowlists names. */
export function newArgs(body: unknown): Args {
  if (body === null || typeof body !== "object" || Array.isArray(body)) return { ok: false, error: "Send a JSON object." };
  const b = body as Body;
  const kind = typeof b.kind === "string" && Object.hasOwn(NEW_KIND, b.kind) ? NEW_KIND[b.kind] : undefined;
  if (!kind) return { ok: false, error: "Choose a decision, rule or finding." };
  const unknown = Object.keys(b).filter((k) => k !== "kind" && !Object.hasOwn(NEW_STRINGS, k) && !Object.hasOwn(NEW_LISTS, k));
  if (unknown.length) return { ok: false, error: `Unknown field for new memory: ${unknown.join(", ")}.` };
  if (typeof b.text !== "string") return { ok: false, error: "text is required." };

  const args: string[] = ["new", kind];
  for (const [k, flag] of Object.entries(NEW_STRINGS)) {
    const v = b[k];
    if (v === undefined) continue;
    if (typeof v !== "string" || v.length > MAX_TEXT || v.includes("\0")) return { ok: false, error: `${k} must be text under ${MAX_TEXT} characters.` };
    args.push(`${flag}=${v}`);
  }
  for (const [k, flag] of Object.entries(NEW_LISTS)) {
    const v = b[k];
    if (v === undefined) continue;
    if (!Array.isArray(v) || v.length > MAX_LIST || !v.every((x) => typeof x === "string" && x.length <= MAX_TEXT && !x.includes("\0"))) {
      return { ok: false, error: `${k} must be a list of up to ${MAX_LIST} entries.` };
    }
    for (const x of v as string[]) args.push(`${flag}=${x}`);
  }
  args.push("--json");
  if (args.reduce((n, a) => n + a.length + 1, 0) > MAX_ARGV) return { ok: false, error: `That memory is too large to save at once (over ${MAX_ARGV} characters). Shorten it.` };
  return { ok: true, args };
}

/** What the CLI prints with --json (runMemoryMove; `hunch new`, whose before is null). */
export interface MoveResult {
  changed: boolean;
  id: string;
  kind: RecordKind;
  home: "public" | "private";
  before: Record<string, unknown> | null;
  after: Record<string, unknown>;
  flush: string | null;
}

export interface Undo {
  action: UiAction;
  body: Body;
  /** Shown next to Undo when it can't put everything back. */
  note?: string;
}

const TEXT_FIELD: Record<RecordKind, string> = { decision: "decision", constraint: "statement", bug: "symptom", finding: "observation" };
const FILE_FIELD: Record<RecordKind, string> = { decision: "related_files", constraint: "scope", bug: "affected_files", finding: "affected_files" };

const list = (v: unknown): string[] => (Array.isArray(v) ? v.filter((x): x is string => typeof x === "string") : []);
const minus = (a: readonly string[], b: readonly string[]): string[] => a.filter((x) => !b.includes(x));
const signed = (rec: Record<string, unknown>): boolean => {
  const source = (rec.provenance as { source?: unknown } | undefined)?.source;
  return typeof source === "string" && source.split("+").includes("human_confirmed");
};

/** The move that puts `before` back, or null when nothing changed. A new record has no
 *  before: its Undo retires it (`hunch remove`), since nothing is ever deleted. */
export function undoFor(action: UiAction | "new", result: MoveResult): Undo | null {
  if (!result.changed || !kindOfId(result.id)) return null;
  if (action === "new") return { action: "remove", body: {} };
  const { kind, after } = result;
  const before = result.before ?? {};
  if (action === "confirm" || action === "unconfirm") {
    const body: Body = {};
    const notes: string[] = [];
    if (kind === "constraint" && typeof before.severity === "string") {
      // --unconfirm never leaves a rule blocking, so it can't put that back.
      if (action === "confirm" && before.severity === "blocking") notes.push("Undo sets it to warn before edits: only a confirmed rule can block edits.");
      else if (before.severity !== after.severity) body.severity = before.severity;
    }
    // --unconfirm caps trust at testimony and never raises it, so higher trust can't come back.
    const was = (before.provenance as { confidence?: unknown } | undefined)?.confidence;
    if (action === "confirm" && typeof was === "number" && was > TESTIMONY_CONFIDENCE) {
      notes.push(`Undo leaves it as unconfirmed agent testimony, trusted less than before: ${Math.round(TESTIMONY_CONFIDENCE * 100)}%, not ${Math.round(was * 100)}%.`);
    }
    const undo: Undo = { action: action === "confirm" ? "unconfirm" : "confirm", body };
    return notes.length ? { ...undo, note: notes.join(" ") } : undo;
  }
  if (action === "edit") {
    const body: Body = {};
    const fields: Array<[string, string]> = [["title", "title"], ["text", TEXT_FIELD[kind]], ["context", "context"], ["rationale", "rationale"]];
    for (const [arg, field] of fields) {
      if (kind === "constraint" && arg === "title") continue;
      if (before[field] !== after[field] && typeof before[field] === "string") body[arg] = before[field];
    }
    if (!Object.keys(body).length) return null;
    return signed(before) && !signed(after)
      ? { action, body, note: "Undo restores the words, not your confirmation. To confirm it again, use Confirm as mine." }
      : { action, body };
  }
  if (action === "link") {
    const body: Body = {};
    const field = FILE_FIELD[kind];
    const added = minus(list(after[field]), list(before[field])), dropped = minus(list(before[field]), list(after[field]));
    if (added.length) body.removeFiles = added;
    if (dropped.length) body.addFiles = dropped;
    if (kind === "decision") {
      const addedC = minus(list(after.related_components), list(before.related_components));
      const droppedC = minus(list(before.related_components), list(after.related_components));
      if (addedC.length) body.removeComponents = addedC;
      if (droppedC.length) body.addComponents = droppedC;
      if (before.topic !== after.topic) {
        if (typeof before.topic === "string") body.feature = before.topic;
        else body.clearFeature = true;
      }
    }
    return Object.keys(body).length ? { action, body } : null;
  }
  if (action === "remove") {
    if (kind === "decision" && typeof before.status === "string") return { action: "restore", body: { status: before.status } };
    if (kind === "finding" && typeof before.triage === "string") return { action: "restore", body: { status: before.triage } };
    return { action: "restore", body: {} };
  }
  // remove picks the closed state from the open one, so it may not land where restore started.
  const was = kind === "finding" ? before.triage : before.status;
  const will = kind === "decision" ? (after.status === "proposed" ? "rejected" : "superseded") : kind === "finding" ? "stale" : was;
  return typeof was === "string" && was !== will
    ? { action: "remove", body: {}, note: `Undo removes it again, marked ${will} rather than ${was}.` }
    : { action: "remove", body: {} };
}

/** The refusal a person should read, from the CLI's stderr (`error: <msg>` lines). */
export function cliError(stderr: string, stdout: string): string {
  const lines = `${stderr}\n${stdout}`.split(/\r?\n/).map((l) => l.trim()).filter(Boolean);
  const marked = lines.filter((l) => l.startsWith("error:")).map((l) => l.slice("error:".length).trim());
  const text = (marked.length ? marked : lines.slice(-3)).join(" ");
  return text.slice(0, 2_000) || "The change was refused.";
}
