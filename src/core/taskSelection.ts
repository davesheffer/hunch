/**
 * Task-scored memory selection (memory-selection design, point 1-3; Gate A v5).
 *
 * The pre-edit hook used to deliver every record anchored to a file, so a hub
 * file filled the headline cap with memory unrelated to the task. This selector
 * scores the live store against the prompt ONCE per task; file grounding then
 * keeps only the decisions, bugs and findings that qualified (constraints are
 * exempt: they are scoped rules, not relevance guesses).
 *
 * PURE on purpose: no fs, no store. Inputs are passed in, so an offline replay
 * can run it against an old store snapshot. The rule is fixed before
 * measurement (no vectors in this step): a record qualifies on >= 2 distinct
 * task terms in its title/rationale, or on a repo path the prompt names that
 * matches the record's files or scope. Below that, nothing (silence, no filler).
 * A term common to many live records (document frequency above the cap) names
 * no task and does not count toward the two.
 */
import type { Bug, Constraint, Decision, Finding } from "./types.js";
import { lexicalTokens, PROFILE_BASE_SCORE, SEVERITY } from "./delivery.js";
import { pathMatchesGlob } from "./glob.js";

export interface TaskSelectionRecords {
  decisions: readonly Decision[];
  bugs: readonly Bug[];
  constraints: readonly Constraint[];
  findings: readonly Finding[];
}

export type TaskSelectionKind = "decision" | "bug" | "constraint" | "finding";

export interface TaskSelection {
  /** Every record clearing the threshold (ids only). */
  qualifying: string[];
  /** At most k, ordered; blocking constraints are never listed (they arrive at edit time). */
  top: Array<{ id: string; kind: TaskSelectionKind; title: string }>;
}

/** Id prefixes of the kinds file grounding filters by a selection (ids.ts:
 *  decisionId/bugId/findingId). Constraints (con_) always pass, so a selection
 *  holding no id with one of these prefixes filters nothing useful — it would
 *  only hide every decision, bug and finding — and counts as no selection. */
const FILTERABLE_ID_PREFIXES = ["dec_", "bug_", "fnd_"] as const;
export function isFilterableSelectionId(id: string): boolean {
  return FILTERABLE_ID_PREFIXES.some((prefix) => id.startsWith(prefix));
}

/** Words a bare follow-up is made of ("continue", "go on", "yes do it", "ok,
 *  next step please"). A prompt of only these names no task of its own and
 *  inherits the continued task's selection; any other word — a verb and an
 *  object ("fix sampler"), a path, another language — is a task of its own
 *  (fail-safe: its own selection, or unfiltered grounding). */
const CONTINUATION_WORDS: ReadonlySet<string> = new Set([
  "continue", "continuing", "go", "on", "ahead", "proceed", "resume", "carry", "keep", "going",
  "yes", "yep", "yeah", "y", "ok", "okay", "sure", "please", "pls", "do", "it", "that", "this",
  "next", "step", "again", "lgtm", "sounds", "good", "fine", "and", "the", "with", "now",
]);
export function isBareFollowUp(prompt: string): boolean {
  const words = (prompt ?? "").toLowerCase().split(/[^\p{L}\p{N}]+/u).filter(Boolean);
  return words.length > 0 && words.every((word) => CONTINUATION_WORDS.has(word));
}

const BRACKET_PAIRS: Readonly<Record<string, string>> = { "(": ")", "[": "]", "{": "}" };
const CLOSING_BRACKETS: Readonly<Record<string, string>> = { ")": "(", "]": "[", "}": "{" };
/** Every `close` in text[from, to) follows its `open` (properly nested, none left open). */
function balanced(text: string, from: number, to: number, open: string, close: string): boolean {
  let depth = 0;
  for (let i = from; i < to; i++) {
    if (text[i] === open) depth++;
    else if (text[i] === close && --depth < 0) return false;
  }
  return depth === 0;
}
/** Strip quoting, sentence punctuation, unmatched or wrapping brackets and a
 *  possessive `'s` from a prompt token until stable. A bracket the path itself
 *  uses (`(auth)/x.ts`, `[id]/page.tsx`, `src/app/(auth)`) is balanced and stays.
 *  Works on [a, b) indices with bracket counts kept current, so trimming a run of
 *  n unmatched brackets is linear, not n rescans of the token. */
const MAX_PATH_TOKEN_CHARS = 1024;
/** Wrapping pairs unwrapped per token; each unwrap rescans the token, and prose never nests deeper. */
const MAX_UNWRAPS = 8;
function trimPathToken(raw: string): string {
  const counts: Record<string, number> = { "(": 0, ")": 0, "[": 0, "]": 0, "{": 0, "}": 0 };
  for (let i = 0; i < raw.length; i++) if (raw[i]! in counts) counts[raw[i]!]!++;
  const n = (ch: string) => counts[ch]!;
  const dropAt = (i: number) => { if (raw[i]! in counts) counts[raw[i]!]!--; };
  let a = 0;
  let b = raw.length;
  let unwraps = 0;
  for (let before = -1; a < b && before !== b - a;) {
    before = b - a;
    // A trailing opening bracket can never close, so it goes first (keeps `[id]/x.ts[` from losing its head).
    const lastOpen = raw[b - 1]!;
    if (BRACKET_PAIRS[lastOpen] && n(lastOpen) > n(BRACKET_PAIRS[lastOpen]!)) dropAt(--b);
    if (a >= b) break;
    const head = raw[a]!;
    const close = BRACKET_PAIRS[head];
    const headOpen = CLOSING_BRACKETS[head];
    if ("`'\"<\u2018\u201c".includes(head)) dropAt(a++);
    else if (close && unwraps < MAX_UNWRAPS && b - a >= 2 && raw[b - 1] === close && n(head) === n(close) && balanced(raw, a + 1, b - 1, head, close)) {
      unwraps++;
      dropAt(a++);
      dropAt(--b);
    }
    else if (close && n(head) > n(close)) dropAt(a++);
    else if (headOpen && n(head) > n(headOpen)) dropAt(a++);
    if (a >= b) break;
    const tail = raw[b - 1]!;
    const open = CLOSING_BRACKETS[tail];
    if ("`'\">,.;:!?\u2019\u201d".includes(tail)) dropAt(--b);
    else if (open && n(open) < n(tail)) dropAt(--b);
    if (b - a >= 2 && "sS".includes(raw[b - 1]!) && "'\u2019".includes(raw[b - 2]!)) b -= 2;
  }
  return raw.slice(a, b);
}

export interface TaskSelectionOptions {
  /** Prompt-time list size (design: K = 3). */
  k?: number;
  /** Optional existence check for a repo-relative path the prompt names. */
  pathExists?: (path: string) => boolean;
  /** Repository root, only to strip it from absolute paths in the prompt (string work, no fs). */
  root?: string;
}

const MIN_DISTINCT_TERMS = 2;
/** Document-frequency cap, fixed before the pilot replay: a prompt term counts
 *  only when at most max(MIN_DF_CAP, ceil(DF_CAP_RATIO × live records)) records
 *  contain it. */
export const MIN_DF_CAP = 3;
export const DF_CAP_RATIO = 0.05;
const DEFAULT_K = 3;
const LIVE_FINDING_TRIAGE: ReadonlySet<string> = new Set(["open", "accepted-risk", "scheduled"]);

/** The live slice the pre-edit grounding would ever deliver at HEAD: decisions and
 *  constraints still in force (the store's why() window plus delivery's retired
 *  test), every bug (why() keeps fixed ones as lessons), and findings whose triage
 *  liveFindingsFor() keeps. */
export function liveSelectionRecords(all: TaskSelectionRecords): TaskSelectionRecords {
  return {
    decisions: all.decisions.filter((d) => d.status !== "rejected" && d.status !== "superseded" && !d.superseded_by && d.valid_to == null),
    bugs: [...all.bugs],
    constraints: all.constraints.filter((c) => c.status !== "retired" && c.valid_to == null),
    findings: all.findings.filter((f) => LIVE_FINDING_TRIAGE.has(f.triage)),
  };
}

/** Repo paths the prompt names: a markdown link `[label](target)` reads as its
 *  target, then a whitespace token containing `/` or ending in a file extension,
 *  stripped of quoting/punctuation/unmatched brackets, a trailing `:line[:col]`
 *  or `:start-end` and a possessive `'s`, forward-slashed, repo-relative. A drive-letter root compares
 *  case-insensitively (Windows paths are case-insensitive on every host). */
export function promptPaths(prompt: string, root?: string): string[] {
  const out = new Set<string>();
  const rootPrefix = root ? `${root.replace(/\\/g, "/").replace(/\/+$/, "")}/` : null;
  // Label and target may each hold one level of brackets (`[app/[id]/x.ts](app/[id]/x.ts)`,
  // a linked `src/app/(auth)/page.tsx`); the label never spans a `[`, so a run of `[` fails fast.
  const links = prompt.replace(/\[(?:[^[\]\n]|\[[^[\]\n]{0,256}\]){0,256}\]\(((?:[^()\s]|\([^()\s]{0,256}\)){1,1024})\)/g, " $1 ");
  for (const raw of links.split(/\s+/)) {
    // No repo path is this long; trimming pasted junk one bracket at a time would stall the prompt hook.
    if (raw.length > MAX_PATH_TOKEN_CHARS) continue;
    let token = trimPathToken(raw).replace(/\\/g, "/").replace(/:\d+(?:[:-]\d+)?$/, "");
    if (!token || /^[a-z][a-z0-9+.-]*:\/\//i.test(token)) continue;
    if (!token.includes("/") && !/\.[a-z0-9]{1,8}$/i.test(token)) continue;
    if (rootPrefix) {
      const foldCase = process.platform === "win32" || /^[a-z]:\//i.test(token);
      if (foldCase ? token.toLowerCase().startsWith(rootPrefix.toLowerCase()) : token.startsWith(rootPrefix)) token = token.slice(rootPrefix.length);
    }
    token = token.replace(/^(?:\.\/)+/, "");
    // Absolute (outside the root) or parent-relative paths name nothing in this repo.
    if (!token || token.startsWith("/") || /^[a-z]:/i.test(token) || token.split("/").includes("..")) continue;
    out.add(token);
  }
  return [...out];
}

interface Scored {
  id: string;
  kind: TaskSelectionKind;
  title: string;
  /** How many distinct prompt-named paths the record's anchors cover. */
  pathHits: number;
  terms: number;
  priority: number;
  listable: boolean;
}

/** Score live records against one prompt. Text fields per kind (title + rationale):
 *  decision title/context/decision; bug title/symptom/root_cause; constraint
 *  statement/rationale; finding title/observation. Path anchors: decision
 *  related_files, bug/finding affected_files, constraint scope globs. Priority
 *  ties break on the builder profile's kind/severity score in delivery.ts. */
export function selectForTask(records: TaskSelectionRecords, promptText: string, opts: TaskSelectionOptions = {}): TaskSelection {
  const k = Math.max(0, opts.k ?? DEFAULT_K);
  const taskTerms = lexicalTokens(promptText ?? "");
  // Without an existence check (pure/offline) only a slashed token is trusted as a
  // path: "e.g.", "Node.js" or "v1.2" would otherwise match a broad glob.
  const paths = promptPaths(promptText ?? "", opts.root).filter((p) => opts.pathExists ? opts.pathExists(p) : p.includes("/"));
  if (!taskTerms.size && !paths.length) return { qualifying: [], top: [] };
  const base = PROFILE_BASE_SCORE.builder;
  // Tokenize every record once: the same tokens feed the document frequency and the score.
  const candidates: Array<Omit<Scored, "pathHits" | "terms"> & { tokens: Set<string>; anchors: readonly string[] }> = [];
  const consider = (id: string, kind: TaskSelectionKind, title: string, text: string[], anchors: readonly string[], priority: number, listable: boolean) => {
    candidates.push({ id, kind, title, tokens: lexicalTokens(text.join(" ")), anchors, priority, listable });
  };
  for (const c of records.constraints) {
    consider(c.id, "constraint", c.statement, [c.statement, c.rationale], c.scope,
      base.constraints + SEVERITY[c.severity] * 10 + (c.provenance.confidence ?? 0), c.severity !== "blocking");
  }
  for (const d of records.decisions) {
    consider(d.id, "decision", d.title, [d.title, d.context, d.decision], d.related_files,
      base.decisions + (d.status === "accepted" ? 20 : 0) + (d.provenance.confidence ?? 0), true);
  }
  for (const b of records.bugs) {
    consider(b.id, "bug", b.title, [b.title, b.symptom, b.root_cause], b.affected_files,
      base.bugs + SEVERITY[b.severity] * 10 + (b.status === "open" || b.status === "regressed" ? 10 : 0), true);
  }
  for (const f of records.findings) {
    consider(f.id, "finding", f.title, [f.title, f.observation], f.affected_files, base.findings + SEVERITY[f.severity] * 10, true);
  }
  const dfCap = Math.max(MIN_DF_CAP, Math.ceil(DF_CAP_RATIO * candidates.length));
  const rareTerms = [...taskTerms].filter((term) => candidates.filter((c) => c.tokens.has(term)).length <= dfCap);
  const scored: Scored[] = [];
  for (const { tokens, anchors, ...rest } of candidates) {
    let terms = 0;
    for (const term of rareTerms) if (tokens.has(term)) terms++;
    const pathHits = paths.filter((p) => anchors.some((anchor) => pathMatchesGlob(p, anchor))).length;
    if (pathHits > 0 || terms >= MIN_DISTINCT_TERMS) scored.push({ ...rest, pathHits, terms });
  }
  // A record anchored to more of the files the prompt names outranks one that
  // shares a single (often hub) file with it; rare terms break the remaining ties.
  scored.sort((a, b) => b.pathHits - a.pathHits || b.terms - a.terms || b.priority - a.priority || a.id.localeCompare(b.id));
  return {
    qualifying: scored.map((s) => s.id),
    top: scored.filter((s) => s.listable).slice(0, k).map(({ id, kind, title }) => ({ id, kind, title })),
  };
}
