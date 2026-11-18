/** HLD import, grilling and export: a high-level design in any common shape becomes a
 *  reviewed, locked part of the project's memory, and one standard HLD document is
 *  projected back out of the graph.
 *
 *  Import is deterministic (no LLM). A Markdown document, a bare Mermaid file or a
 *  draw.io diagram is parsed into its components, connections and prose sections, and
 *  every gap is turned into a question: a component the text never explains, a
 *  connection with no protocol, a standard concern (goals, data, failure, security,
 *  rejected alternatives...) the design never addresses, a box that matches nothing in
 *  the code. The agent asks the human those questions ONE at a time and records the
 *  answers in the draft (`.hunch/hld/<slug>.json`); it never answers them itself and the
 *  source document is never rewritten. A human then approves the draft in a terminal,
 *  which locks both the source and the draft (src/core/locks.ts), so an approved design
 *  cannot drift under an agent's hands.
 *
 *  Export renders the graph (components and their dependencies, live decisions with what
 *  they rejected, constraints, approved designs with their clarifications) as one
 *  standard Markdown HLD with Mermaid diagrams. The output carries a hunch:generated
 *  marker and the hash of its body, so `export-hld --check` can tell a stale projection
 *  from a hand-edited one. Everything rendered is deterministic: no dates, sorted input. */
import { createHash } from "node:crypto";
import { existsSync, mkdirSync, readFileSync, readdirSync, realpathSync, statSync } from "node:fs";
import { extname, isAbsolute, join, posix, relative } from "node:path";
import { isDeepStrictEqual } from "node:util";
import { inflateRawSync } from "node:zlib";
import { z } from "zod";
import { writeFileAtomic } from "./io.js";
import { fileSha, readLocks } from "./locks.js";
import { HUNCH_DIR, isRepoFile, realpathNorm, safeRepoScope } from "./paths.js";
import type { Component, Constraint, Decision, Edge } from "./types.js";

export const HLD_DIR = `${HUNCH_DIR}/hld`;
export const DEFAULT_HLD_EXPORT = "docs/hld/HLD.md";
const MAX_SOURCE_BYTES = 4 * 1024 * 1024;

// ---- model -------------------------------------------------------------------

export type HldFormat = "markdown" | "mermaid" | "drawio";

export interface HldNode { id: string; label: string }
export interface HldEdge { from: string; to: string; label: string }
export interface HldSection { heading: string; level: number }

export interface ParsedHld {
  format: HldFormat;
  title: string;
  nodes: HldNode[];
  edges: HldEdge[];
  sections: HldSection[];
  /** Prose outside diagrams and code fences, used to see what the text explains. */
  prose: string;
  diagrams: number;
  /** Diagram lines Hunch could not read; surfaced on import so nothing is dropped silently. */
  warnings: string[];
}

export const QUESTION_KINDS = [
  "no-diagram", "missing-goals", "component-role", "connection", "missing-data", "missing-nfr",
  "missing-failure", "missing-security", "missing-alternatives", "unknown-component", "uncovered-components",
] as const;
export type QuestionKind = (typeof QUESTION_KINDS)[number];

const AnswerSchema = z.object({
  text: z.string().min(1).max(4000),
  skipped: z.boolean().default(false),
  via: z.enum(["agent", "cli"]),
  at: z.string(),
}).strict();

const QuestionSchema = z.object({
  id: z.string().regex(/^q_[a-f0-9]{8}$/),
  kind: z.enum(QUESTION_KINDS),
  subject: z.string(),
  question: z.string(),
  answer: AnswerSchema.nullable().default(null),
}).strict();
export type HldQuestion = z.infer<typeof QuestionSchema>;

const DraftSchema = z.object({
  version: z.literal(1),
  source: z.string(),
  source_sha256: z.string().regex(/^sha256:[a-f0-9]{64}$/),
  format: z.enum(["markdown", "mermaid", "drawio"]),
  title: z.string(),
  nodes: z.array(z.object({ id: z.string(), label: z.string() }).strict()),
  edges: z.array(z.object({ from: z.string(), to: z.string(), label: z.string() }).strict()),
  sections: z.array(z.object({ heading: z.string(), level: z.number().int() }).strict()),
  questions: z.array(QuestionSchema),
  status: z.enum(["draft", "approved"]),
  imported_at: z.string(),
  approved: z.object({ by: z.string(), at: z.string(), source_sha256: z.string() }).strict().nullable().default(null),
}).strict();
export type HldDraft = z.infer<typeof DraftSchema>;

// ---- parsing -----------------------------------------------------------------

export function detectFormat(path: string, text: string): HldFormat {
  const ext = extname(path).toLowerCase();
  if (ext === ".drawio" || /<mxfile[\s>]|<mxGraphModel[\s>]/.test(text.slice(0, 4000))) return "drawio";
  if (ext === ".mmd" || ext === ".mermaid") return "mermaid";
  return "markdown";
}

export function parseHld(path: string, text: string): ParsedHld {
  const format = detectFormat(path, text);
  const fallbackTitle = path.split("/").pop()!.replace(/\.[^.]+$/, "");
  if (format === "drawio") {
    const { nodes, edges, pages } = parseDrawio(text);
    return { format, title: fallbackTitle, nodes, edges, sections: [], prose: "", diagrams: pages, warnings: [] };
  }
  if (format === "mermaid") {
    const g = parseMermaid(text);
    return { format, title: fallbackTitle, nodes: g.nodes, edges: g.edges, sections: [], prose: "", diagrams: 1, warnings: g.warnings };
  }
  return parseMarkdown(text, fallbackTitle);
}

function parseMarkdown(text: string, fallbackTitle: string): ParsedHld {
  const sections: HldSection[] = [];
  const prose: string[] = [];
  const graphs: Array<{ nodes: HldNode[]; edges: HldEdge[]; warnings: string[] }> = [];
  let fence: { marker: string; lang: string; body: string[] } | null = null;
  for (const line of text.split(/\r?\n/)) {
    if (fence) {
      if (line.trim().startsWith(fence.marker)) {
        if (fence.lang === "mermaid") graphs.push(parseMermaid(fence.body.join("\n")));
        fence = null;
      } else fence.body.push(line);
      continue;
    }
    const open = /^\s*(```+|~~~+)\s*([\w-]*)/.exec(line);
    if (open) { fence = { marker: open[1]!, lang: open[2]!.toLowerCase(), body: [] }; continue; }
    const heading = /^(#{1,6})\s+(.+?)\s*#*\s*$/.exec(line);
    if (heading) { sections.push({ heading: heading[2]!, level: heading[1]!.length }); prose.push(heading[2]!); continue; }
    prose.push(line);
  }
  const title = sections.find((s) => s.level === 1)?.heading ?? sections[0]?.heading ?? fallbackTitle;
  const merged = mergeGraphs(graphs);
  return { format: "markdown", title, nodes: merged.nodes, edges: merged.edges, sections, prose: prose.join("\n"), diagrams: graphs.length, warnings: graphs.flatMap((g) => g.warnings) };
}

function mergeGraphs(graphs: Array<{ nodes: HldNode[]; edges: HldEdge[] }>): { nodes: HldNode[]; edges: HldEdge[] } {
  const nodes = new Map<string, HldNode>();
  const edges = new Map<string, HldEdge>();
  for (const g of graphs) {
    for (const n of g.nodes) {
      const prev = nodes.get(n.id);
      if (!prev || (prev.label === prev.id && n.label !== n.id)) nodes.set(n.id, n);
    }
    for (const e of g.edges) edges.set(`${e.from}\u0000${e.to}\u0000${e.label}`, e);
  }
  return { nodes: [...nodes.values()], edges: [...edges.values()] };
}

const NODE_RE = /^([A-Za-z0-9_][\w.-]*)\s*(?:(\[\[|\[\(|\[\/|\[\\|\(\(\(|\(\(|\(\[|\{\{|\[|\(|\{|>)\s*(.*?)\s*(?:\]\]|\)\]|\/\]|\\\]|\)\)\)|\)\)|\]\)|\}\}|\]|\)|\}))?\s*(?::::[\w-]+)?$/;
const SKIP_RE = /^(graph|flowchart|subgraph|end|classDef|class|style|linkStyle|click|direction|%%|accTitle|accDescr|title)(?![\w-])/;
/** Any Mermaid link at one position: optional start head, a variable-length body, optional end head. */
const LINK_Y = /(<|[ox](?=[-=]))?(-{2,}|={2,}|-\.+-|~{3,})(>|[ox](?=[\s|;&]|$))?/y;
const DOTTED_OPEN_Y = /-\./y;
const PIPE_LABEL_Y = /\s*\|([^|]*)\|/y;
/** How an inline label (`A -- text --> B`) ends, per opener. Each match is a single forward search. */
const LABEL_END: Record<string, RegExp> = {
  // only an arrow tail ends a label (`-->`, `---`, `--x`, `--o`); a bare `--` is label text
  "--": /-{2,}(?:>|[ox](?=[\s|;&]|$))|-{3,}/g,
  "==": /={2,}(?:>|[ox](?=[\s|;&]|$))|={3,}/g,
  "-.": /\.-(?:>|[ox](?=[\s|;&]|$))?/g,
};
/** Longer lines are not parsed (a crafted line must not stall the event loop); they are reported. */
export const MAX_MERMAID_LINE = 2000;

function cleanLabel(raw: string): string {
  return raw.replace(/^["'`]|["'`]$/g, "").replace(/<br\s*\/?>/gi, " ").replace(/#quot;/g, "\"").replace(/\s+/g, " ").trim();
}

/** Split one flowchart statement into node texts and the labels of the links between them,
 *  or null when it cannot be read. One left-to-right pass: shapes (`[...]`, `(...)`, `{...}`,
 *  `>...]`, quoted text) are skipped whole, so an arrow inside a label is not a link. */
function splitLinks(line: string): { segments: string[]; labels: string[] } | null {
  const segments: string[] = [];
  const labels: string[] = [];
  let start = 0, depth = 0, quoted = false;
  let i = 0;
  while (i < line.length) {
    const ch = line[i]!;
    if (quoted) { if (ch === "\"") quoted = false; i++; continue; }
    if (ch === "\"") { quoted = true; i++; continue; }
    if (depth > 0) {
      if (ch === "[" || ch === "(" || ch === "{") depth++;
      else if (ch === "]" || ch === ")" || ch === "}") depth--;
      i++;
      continue;
    }
    if (ch === "[" || ch === "(" || ch === "{" || (ch === ">" && /\w/.test(line[i - 1] ?? ""))) { depth = 1; i++; continue; }
    if (ch === "]" || ch === ")" || ch === "}") return null;
    // o/x as a start head only after whitespace (`A o--o B`), never as the end of an id
    if ((ch === "o" || ch === "x") && !/\s/.test(line[i - 1] ?? "")) { i++; continue; }
    LINK_Y.lastIndex = i;
    const link = LINK_Y.exec(line);
    let opener: string | null = null;
    let end = i;
    if (link) {
      const plain = !link[1] && !link[3];
      if (plain && (link[2] === "--" || link[2] === "==")) opener = link[2];
      else end = LINK_Y.lastIndex;
    } else {
      DOTTED_OPEN_Y.lastIndex = i;
      if (DOTTED_OPEN_Y.exec(line)) opener = "-.";
    }
    if (!link && !opener) { i++; continue; }
    let label = "";
    if (opener) {
      const re = LABEL_END[opener]!;
      re.lastIndex = i + 2;
      const close = re.exec(line);
      if (!close) return null;
      label = line.slice(i + 2, close.index).replace(/\.+$/, "");
      end = re.lastIndex;
    }
    PIPE_LABEL_Y.lastIndex = end;
    const pipe = PIPE_LABEL_Y.exec(line);
    if (pipe) { label = pipe[1]!; end = PIPE_LABEL_Y.lastIndex; }
    segments.push(line.slice(start, i));
    labels.push(cleanLabel(label));
    start = i = end;
  }
  if (depth > 0 || quoted) return null;
  segments.push(line.slice(start));
  return { segments, labels };
}

/** Flowchart/graph and sequence diagrams; other Mermaid kinds yield no graph. Lines that
 *  cannot be read are returned as warnings, never dropped silently. */
export function parseMermaid(text: string): { nodes: HldNode[]; edges: HldEdge[]; warnings: string[] } {
  let lines = text.split(/\r?\n/).map((l) => l.replace(/%%.*$/, "").trim()).filter(Boolean);
  // YAML front matter (`---` ... `---`) before the diagram kind
  if (lines[0] === "---") {
    const close = lines.indexOf("---", 1);
    lines = close < 0 ? [] : lines.slice(close + 1);
  }
  const warnings: string[] = [];
  const kind = (lines[0] ?? "").split(/\s+/)[0]!.toLowerCase();
  if (kind === "sequencediagram") return { ...parseSequence(lines.slice(1)), warnings };
  if (kind !== "graph" && kind !== "flowchart") {
    if (kind) warnings.push(`Mermaid "${kind.slice(0, 40)}" diagrams are not read; only flowchart/graph and sequenceDiagram`);
    return { nodes: [], edges: [], warnings };
  }
  const nodes = new Map<string, HldNode>();
  const edges: HldEdge[] = [];
  const node = (token: string): string[] | null => {
    const ids: string[] = [];
    for (const part of token.replace(/;$/, "").split("&")) {
      // collapsed whitespace keeps NODE_RE's lazy label match linear
      const m = NODE_RE.exec(part.replace(/\s+/g, " ").trim());
      if (!m) return null;
      const id = m[1]!;
      const label = m[3] ? cleanLabel(m[3]) : "";
      const prev = nodes.get(id);
      if (!prev) nodes.set(id, { id, label: label || id });
      else if (label && prev.label === prev.id) prev.label = label;
      ids.push(id);
    }
    return ids;
  };
  const unread = (line: string) => warnings.push(`unread Mermaid line: ${line.length > 120 ? `${line.slice(0, 120)}…` : line}`);
  for (const line of lines.slice(1)) {
    if (SKIP_RE.test(line)) continue;
    if (line.length > MAX_MERMAID_LINE) { warnings.push(`Mermaid line longer than ${MAX_MERMAID_LINE} characters not read: ${line.slice(0, 80)}…`); continue; }
    const split = splitLinks(line);
    const groups = split?.segments.map(node);
    if (!split || !groups || groups.some((g) => !g)) { unread(line); continue; }
    for (let i = 0; i < split.labels.length; i++) {
      for (const a of groups[i]!) for (const b of groups[i + 1]!) edges.push({ from: a, to: b, label: split.labels[i]! });
    }
  }
  return { nodes: [...nodes.values()], edges, warnings };
}

function parseSequence(lines: string[]): { nodes: HldNode[]; edges: HldEdge[] } {
  const nodes = new Map<string, HldNode>();
  const edges: HldEdge[] = [];
  const add = (id: string, label?: string) => { if (!nodes.has(id)) nodes.set(id, { id, label: label ? cleanLabel(label) : id }); };
  for (const line of lines) {
    const decl = /^(?:participant|actor)\s+([\w.]+(?:-[\w.]+)*)(?:\s+as\s+(.+))?$/.exec(line);
    if (decl) { add(decl[1]!, decl[2]); continue; }
    const msg = /^([\w.]+(?:-(?![->x)])[\w.]+)*)\s*(?:-{1,2}>{1,2}|-{1,2}[x)])\s*[+-]?([\w.]+(?:-[\w.]+)*)\s*:\s*(.*)$/.exec(line);
    if (msg) { add(msg[1]!); add(msg[2]!); edges.push({ from: msg[1]!, to: msg[2]!, label: cleanLabel(msg[3]!) }); }
  }
  return { nodes: [...nodes.values()], edges };
}

function decodeXml(s: string): string {
  return s.replace(/&lt;/g, "<").replace(/&gt;/g, ">").replace(/&quot;/g, "\"").replace(/&#39;|&apos;/g, "'")
    .replace(/&#(\d+);/g, (_, d: string) => String.fromCodePoint(Number(d))).replace(/&#x([0-9a-f]+);/gi, (_, h: string) => String.fromCodePoint(parseInt(h, 16))).replace(/&amp;/g, "&");
}

function htmlToText(s: string): string {
  return cleanLabel(decodeXml(s).replace(/<br\s*\/?>/gi, " ").replace(/<[^>]+>/g, " ").replace(/&nbsp;/g, " "));
}

/** draw.io / diagrams.net: plain or compressed (deflate+base64+URI) pages. */
export function parseDrawio(text: string): { nodes: HldNode[]; edges: HldEdge[]; pages: number } {
  const models: string[] = [];
  const diagramRe = /<diagram\b[^>]*>([\s\S]*?)<\/diagram>/g;
  let pages = 0;
  for (let m = diagramRe.exec(text); m; m = diagramRe.exec(text)) {
    pages++;
    const body = m[1]!.trim();
    if (body.startsWith("<")) { models.push(body); continue; }
    try {
      models.push(decodeURIComponent(inflateRawSync(Buffer.from(body, "base64")).toString("utf8")));
    } catch { /* an unreadable page contributes nothing */ }
  }
  if (!pages) { models.push(text); pages = 1; }
  const nodes = new Map<string, HldNode>();
  const edges: HldEdge[] = [];
  const pendingLabels = new Map<string, string>();
  for (const model of models) {
    const cellRe = /<mxCell\b([^>]*?)(\/?)>/g;
    for (let c = cellRe.exec(model); c; c = cellRe.exec(model)) {
      const attrs = c[1]!;
      const attr = (name: string) => new RegExp(`\\b${name}="([^"]*)"`).exec(attrs)?.[1];
      const id = attr("id");
      if (!id) continue;
      const value = htmlToText(attr("value") ?? "");
      const style = attr("style") ?? "";
      if (attr("edge") === "1") {
        const from = attr("source"), to = attr("target");
        if (from && to) edges.push({ from, to, label: value });
      } else if (attr("vertex") === "1") {
        const parent = attr("parent");
        // an edgeLabel vertex is the label of its parent edge, not a component
        if (/edgeLabel/.test(style) && parent) { if (value) pendingLabels.set(parent, value); continue; }
        if (value || !/text;/.test(style)) nodes.set(id, { id, label: value || id });
      }
    }
  }
  const edgeIds = new Map<string, number>();
  for (const model of models) {
    const re = /<mxCell\b[^>]*?\bid="([^"]*)"[^>]*?\bedge="1"/g;
    for (let m = re.exec(model); m; m = re.exec(model)) edgeIds.set(m[1]!, edgeIds.size);
  }
  for (const [edgeId, label] of pendingLabels) {
    const index = edgeIds.get(edgeId);
    if (index !== undefined && edges[index] && !edges[index]!.label) edges[index]!.label = label;
  }
  return { nodes: [...nodes.values()], edges: edges.filter((e) => nodes.has(e.from) && nodes.has(e.to)), pages };
}

// ---- gap detection -----------------------------------------------------------

const TOPICS: Array<{ kind: QuestionKind; subject: string; re: RegExp; question: string }> = [
  { kind: "missing-goals", subject: "goals", re: /\b(goals?|objectives?|purpose|overview|context|motivation|problem|scope|summary)\b|מטר|רקע|סקירה/i,
    question: "What problem does this design solve, for whom, and what is explicitly in and out of scope?" },
  { kind: "missing-data", subject: "data", re: /\b(data|storage|database|db|schema|persist\w*|tables?|store[sd]?|cache)\b|נתונ|מסד/i,
    question: "What data does this design own, where is it stored, and who is the source of truth for each piece?" },
  { kind: "missing-nfr", subject: "non-functional requirements", re: /\b(non-?functional|nfrs?|performance|scal\w+|latency|throughput|availability|sla|slo|load)\b|ביצוע|עומס|זמינות/i,
    question: "What are the non-functional requirements: expected load, latency, availability, and how it scales?" },
  { kind: "missing-failure", subject: "failure handling", re: /\b(failures?|errors?|retr(y|ies)|fallback|resilien\w+|outage|recovery|timeouts?|idempoten\w+|degrad\w+)\b|כשל|שגיא/i,
    question: "What happens when a component or connection fails: retries, timeouts, fallbacks, and what the user sees?" },
  { kind: "missing-security", subject: "security", re: /\b(security|auth\w*|permissions?|encrypt\w*|secrets?|privacy|pii|tokens?|access control|rbac)\b|אבטח|הרשא/i,
    question: "How is access controlled, which data is sensitive, and how are secrets and credentials handled?" },
  { kind: "missing-alternatives", subject: "rejected alternatives", re: /\b(alternatives?|rejected|trade-?offs?|considered|instead of|why not|decisions?)\b|חלופ|נדח/i,
    question: "Which alternatives were considered and rejected, and why? (Rejected options are what Hunch can later block agents from re-introducing.)" },
];

export function normalizeName(s: string): string {
  return s.toLowerCase().replace(/[^a-z0-9\u0590-\u05ff]+/g, "");
}

function componentKeys(c: Component): string[] {
  const keys = new Set([normalizeName(c.name)]);
  for (const p of c.paths) {
    const seg = p.replace(/\/?\*.*$/, "").split("/").filter(Boolean).pop();
    if (seg) keys.add(normalizeName(seg));
  }
  keys.delete("");
  return [...keys];
}

export function matchComponent(label: string, components: readonly Component[]): Component | undefined {
  const key = normalizeName(label);
  if (!key) return undefined;
  const exact = components.find((c) => componentKeys(c).includes(key));
  if (exact) return exact;
  return components.find((c) => componentKeys(c).some((k) => k.length >= 4 && key.length >= 4 && (k.includes(key) || key.includes(k))));
}

function questionId(kind: QuestionKind, subject: string): string {
  return `q_${createHash("sha256").update(`${kind}\u0000${subject}`).digest("hex").slice(0, 8)}`;
}

function mentioned(prose: string, node: HldNode): boolean {
  const text = prose.toLowerCase();
  if (node.label && node.label.length >= 2 && text.includes(node.label.toLowerCase())) return true;
  return node.id.length >= 3 && node.id !== node.label && new RegExp(`\\b${node.id.replace(/[.*+?^${}()|[\]\\-]/g, "\\$&")}\\b`, "i").test(prose);
}

/** Every gap in the design, as questions in the order a reviewer would ask them. */
export function detectGaps(parsed: ParsedHld, components: readonly Component[]): HldQuestion[] {
  const out: HldQuestion[] = [];
  const ask = (kind: QuestionKind, subject: string, question: string) => {
    const id = questionId(kind, subject);
    if (!out.some((q) => q.id === id)) out.push({ id, kind, subject, question, answer: null });
  };
  const label = (id: string) => parsed.nodes.find((n) => n.id === id)?.label ?? id;
  const headingsAndProse = `${parsed.sections.map((s) => s.heading).join("\n")}\n${parsed.prose}`;
  const proseWords = parsed.prose.split(/\s+/).filter(Boolean).length;

  if (!parsed.nodes.length) {
    ask("no-diagram", "diagram", "The design has no diagram Hunch can read. Which components does it have, and which of them talk to each other?");
  }
  const goals = TOPICS[0]!;
  if (!goals.re.test(headingsAndProse) || proseWords < 15) ask(goals.kind, goals.subject, goals.question);
  for (const n of parsed.nodes) {
    if (mentioned(parsed.prose, n)) continue;
    ask("component-role", n.label, `What is "${n.label}" responsible for, and what does it own?`);
  }
  for (const e of parsed.edges) {
    if (e.label) continue;
    const subject = `${label(e.from)} -> ${label(e.to)}`;
    ask("connection", subject, `How does "${label(e.from)}" talk to "${label(e.to)}": protocol, sync or async, and what data crosses it?`);
  }
  for (const t of TOPICS.slice(1)) if (!t.re.test(headingsAndProse)) ask(t.kind, t.subject, t.question);
  const live = components.filter((c) => c.status === "active");
  if (live.length) {
    const covered = new Set<string>();
    for (const n of parsed.nodes) {
      const hit = matchComponent(n.label, live) ?? matchComponent(n.id, live);
      if (hit) covered.add(hit.id);
      else ask("unknown-component", n.label, `"${n.label}" matches no component in the code. Is it new, external, or named differently in the code (which one)?`);
    }
    const uncovered = live.filter((c) => !covered.has(c.id)).map((c) => c.name).sort();
    if (parsed.nodes.length && uncovered.length) {
      const list = uncovered.length > 12 ? `${uncovered.slice(0, 12).join(", ")} and ${uncovered.length - 12} more` : uncovered.join(", ");
      // the subject carries the full list, so a different set of uncovered components is a new question
      ask("uncovered-components", `uncovered: ${uncovered.join(", ")}`, `These components exist in the code but not in the design: ${list}. Out of scope, or missing from the design?`);
    }
  }
  return out;
}

// ---- drafts ------------------------------------------------------------------

/** The draft file for a canonical source path. A readable slug plus a hash of the exact path,
 *  so `payments.md`, `payments.mmd`, `Payments.md` and `hld-payments.md` never share a draft.
 *  (Drafts written before the hash suffix are not read; HLD import was unreleased then.) */
export function draftPath(source: string): string {
  const slug = source.toLowerCase().replace(/\.[^./]+$/, "").replace(/[^a-z0-9]+/g, "-").replace(/^-+|-+$/g, "").slice(0, 100) || "hld";
  return `${HLD_DIR}/${slug}-${createHash("sha256").update(source).digest("hex").slice(0, 10)}.json`;
}

/** True for `.hunch` itself or anything under it, in any letter case (case-insensitive filesystems). */
export function isHunchPath(rel: string): boolean {
  const p = rel.toLowerCase();
  return p === HUNCH_DIR || p.startsWith(`${HUNCH_DIR}/`);
}

/** Lexical form of a source path: repo-relative, POSIX-normalized (`a//b`, `a/./b` collapse),
 *  never a glob, never under .hunch/. Use `canonicalSource` when the file system is at hand. */
export function sourcePath(rel: string): string | null {
  const scoped = safeRepoScope(rel);
  if (!scoped || /[*?[\]{}]/.test(scoped)) return null;
  const p = posix.normalize(scoped);
  if (p === "." || p === ".." || p.startsWith("../") || p.endsWith("/") || isAbsolute(p) || isHunchPath(p)) return null;
  return p;
}

/** The one canonical form of a source path, used for the draft, its answers, its approval and
 *  its lock: lexically normalized, then (for an existing file) its real path inside the repo, so
 *  a case variant on Windows or a `docs/./x.md` spelling names the same file the hook checks.
 *  Null for anything that is not a file inside the repo (including a symlink pointing out). */
export function canonicalSource(root: string, rel: string): string | null {
  const p = sourcePath(rel);
  if (!p) return null;
  const abs = join(root, p);
  if (!existsSync(abs)) return p;
  if (!isRepoFile(root, p)) return null;
  return sourcePath(relative(realpathNorm(root), realpathSync.native(abs)).replace(/\\/g, "/"));
}

export function readDraft(root: string, source: string): HldDraft | null {
  const file = join(root, draftPath(source));
  if (!existsSync(file)) return null;
  const parsed = DraftSchema.safeParse(JSON.parse(readFileSync(file, "utf8")));
  if (!parsed.success) throw new Error(`${draftPath(source)} is not a valid HLD draft; restore it from git or re-import`);
  if (parsed.data.source !== source) throw new Error(`${draftPath(source)} belongs to ${parsed.data.source}, not ${source}; restore it from git or re-import`);
  return parsed.data;
}

export type HldApproval = "draft" | "approved" | "unverified";

/** Whether a draft is approved, derived from the lock registry rather than trusted from the
 *  draft's own `status` field (which anyone can type): both the source and the draft must be
 *  locked, and the locked hashes must match the current bytes and the approved source hash. */
export function approvalState(root: string, draft: HldDraft): HldApproval {
  if (draft.status !== "approved" || !draft.approved) return "draft";
  const reg = readLocks(root);
  if (reg.corrupt) return "unverified";
  const src = reg.locks.find((l) => l.path === draft.source);
  const answers = reg.locks.find((l) => l.path === draftPath(draft.source));
  const ok = !!src && !!answers
    && src.sha256 === draft.approved.source_sha256 && draft.approved.source_sha256 === draft.source_sha256
    && fileSha(root, draft.source) === src.sha256
    && lockedDraftMatches(root, draft, answers.sha256);
  return ok ? "approved" : "unverified";
}

/** The draft we were GIVEN must be the one whose bytes are locked, not merely share a source:
 *  the canonical file's exact bytes must hash to the lock, and its parsed content must equal
 *  the given draft (compared parsed, so a human's reformatting does not void an approval). */
function lockedDraftMatches(root: string, draft: HldDraft, lockedSha: string): boolean {
  try {
    const bytes = readFileSync(join(root, draftPath(draft.source)));
    if (`sha256:${createHash("sha256").update(bytes).digest("hex")}` !== lockedSha) return false;
    const locked = DraftSchema.safeParse(JSON.parse(bytes.toString("utf8")));
    return locked.success && isDeepStrictEqual(locked.data, DraftSchema.parse(draft));
  } catch {
    return false;
  }
}

function serializedDraft(draft: HldDraft): string {
  return `${JSON.stringify(DraftSchema.parse(draft), null, 2)}\n`;
}


/** Every draft stored under its own canonical file name. A file whose name is not
 *  `draftPath(source)` (a copy, a forgery, a pre-hash-suffix draft) is never a draft. */
export function listDrafts(root: string): HldDraft[] {
  const dir = join(root, HLD_DIR);
  if (!existsSync(dir)) return [];
  const out: HldDraft[] = [];
  for (const f of readdirSync(dir).filter((f) => f.endsWith(".json")).sort()) {
    const parsed = DraftSchema.safeParse(JSON.parse(readFileSync(join(dir, f), "utf8")));
    if (parsed.success && draftPath(parsed.data.source) === `${HLD_DIR}/${f}`) out.push(parsed.data);
  }
  return out;
}

export function writeDraft(root: string, draft: HldDraft): void {
  const file = join(root, draftPath(draft.source));
  mkdirSync(join(root, HLD_DIR), { recursive: true });
  writeFileAtomic(file, serializedDraft(draft));
}

export function sourceSha(root: string, source: string): string {
  const abs = join(root, source);
  if (!isRepoFile(root, source)) throw new Error(`${source} is not a file inside the repository`);
  const st = statSync(abs);
  if (!st.isFile()) throw new Error(`${source} is not a file`);
  if (st.size > MAX_SOURCE_BYTES) throw new Error(`${source} is larger than ${MAX_SOURCE_BYTES} bytes`);
  return `sha256:${createHash("sha256").update(readFileSync(abs)).digest("hex")}`;
}

export interface ImportResult { draft: HldDraft; parsed: ParsedHld; carried: number; previous: HldDraft | null }

/** Parse a source and build its draft. Answers to questions that still apply are carried
 *  over from a previous draft (same question id), so re-importing an edited design only
 *  asks what is new. Refuses an approved draft unless the caller has a human's say-so. */
export function importHld(root: string, rel: string, components: readonly Component[], opts: { reopen?: boolean; at?: string } = {}): ImportResult {
  const source = canonicalSource(root, rel);
  if (!source) throw new Error(`cannot import ${rel}: give a repo-relative file inside the repository and outside ${HUNCH_DIR}/`);
  if (!existsSync(join(root, source))) throw new Error(`${source} does not exist`);
  const sha = sourceSha(root, source);
  const text = readFileSync(join(root, source), "utf8");
  const parsed = parseHld(source, text);
  const previous = readDraft(root, source);
  // Refuse on ANY sign of an approval, verified or not: a failing verification (source edited
  // after approval, a broken registry) must never let an agent overwrite the human's answers.
  const reg = readLocks(root);
  const lockedHere = reg.corrupt || reg.locks.some((l) => l.path === source || l.path === draftPath(source));
  if (previous?.status === "approved" && !opts.reopen) {
    throw new Error(`${source} is an approved, locked HLD (approved by ${previous.approved!.by}). Only a human reopens it, by running \`hunch import-hld ${source}\` in a terminal.`);
  }
  if (lockedHere && !opts.reopen) {
    throw new Error(`${source} has an approval lock in .hunch/locks.json${reg.corrupt ? " (the registry is unreadable)" : ""}. Only a human reopens it, by running \`hunch import-hld ${source}\` in a terminal.`);
  }
  const answers = new Map((previous?.questions ?? []).filter((q) => q.answer).map((q) => [q.id, q.answer!]));
  let carried = 0;
  const questions = detectGaps(parsed, components).map((q) => {
    const a = answers.get(q.id);
    if (a) carried++;
    return a ? { ...q, answer: a } : q;
  });
  const draft: HldDraft = {
    version: 1, source, source_sha256: sha, format: parsed.format, title: parsed.title,
    nodes: parsed.nodes, edges: parsed.edges, sections: parsed.sections, questions,
    status: "draft", imported_at: opts.at ?? new Date().toISOString(), approved: null,
  };
  return { draft, parsed, carried, previous };
}

export function nextQuestion(draft: HldDraft): HldQuestion | null {
  return draft.questions.find((q) => !q.answer) ?? null;
}

export function openCount(draft: HldDraft): number {
  return draft.questions.filter((q) => !q.answer).length;
}

export function answerQuestion(draft: HldDraft, id: string, input: { text?: string; skip?: boolean; via: "agent" | "cli"; at?: string }): HldDraft {
  if (draft.status === "approved") throw new Error(`${draft.source} is approved and locked; answers can no longer change`);
  const q = draft.questions.find((x) => x.id === id);
  if (!q) throw new Error(`no question ${id} in the draft for ${draft.source} (see \`hunch hld ${draft.source}\`)`);
  const text = input.skip ? "(skipped by the human)" : (input.text ?? "").trim();
  if (!text) throw new Error("an answer needs text (or skip it explicitly)");
  if (text.length > 4000) throw new Error("an answer is limited to 4000 characters");
  const answer = { text, skipped: !!input.skip, via: input.via, at: input.at ?? new Date().toISOString() };
  return { ...draft, questions: draft.questions.map((x) => (x.id === id ? { ...x, answer } : x)) };
}

export function approveDraft(draft: HldDraft, currentSha: string, by: string, at?: string): HldDraft {
  const name = by.trim();
  if (!name || name.length > 128 || /[\r\n]/.test(name)) throw new Error("--reviewed-by must be a 1-128 character name");
  if (draft.status === "approved") throw new Error(`${draft.source} is already approved`);
  if (currentSha !== draft.source_sha256) throw new Error(`${draft.source} changed since it was imported; re-run \`hunch import-hld ${draft.source}\` first`);
  const open = openCount(draft);
  if (open) throw new Error(`${open} question(s) are still unanswered; answer or skip each before approving (\`hunch hld ${draft.source}\`)`);
  return { ...draft, status: "approved", approved: { by: name, at: at ?? new Date().toISOString(), source_sha256: currentSha } };
}

/** The interrogation protocol an agent follows for one draft. */
export function grillingProtocol(draft: HldDraft, approval: HldApproval = "draft"): string {
  const q = nextQuestion(draft);
  const done = draft.questions.length - openCount(draft);
  const head = [
    `HLD draft for ${draft.source} ("${draft.title}"): ${draft.nodes.length} component(s), ${draft.edges.length} connection(s), ${draft.questions.length} question(s), ${done} answered.`,
    "",
    "Protocol (follow exactly):",
    "1. Ask the human ONE question at a time, in your own words but without changing its meaning. Wait for the answer.",
    "2. Never answer a question yourself, and never infer an answer from the code or the document. If the human doesn't know, ask whether to skip it.",
    "3. Record each answer with hunch_hld(action:\"answer\", file, question_id, answer) — the human's words, not a summary that adds facts. Use skip:true only when the human says to skip.",
    "4. When every question is answered, tell the human to approve it in a terminal: hunch hld-approve " + draft.source + " --reviewed-by <name>. Approval locks the design; you cannot approve it.",
  ];
  if (approval === "approved") return `${draft.source} is approved by ${draft.approved!.by} and locked. Nothing to ask.`;
  if (draft.status === "approved") return `${draft.source} claims approval, but its locks do not match (approval unverified). Only a human re-approves it in a terminal: hunch import-hld ${draft.source}, then hunch hld-approve.`;
  if (!q) return `${head.join("\n")}\n\nAll questions are answered. Ask the human to review and approve: hunch hld-approve ${draft.source} --reviewed-by <name>`;
  return `${head.join("\n")}\n\nNext question (${q.id}, ${q.kind}):\n${q.question}`;
}

// ---- export ------------------------------------------------------------------

export const HLD_MARKER_PREFIX = "<!-- hunch:generated hld v1";

export interface ExportInput {
  title: string;
  components: readonly Component[];
  edges: readonly Edge[];
  decisions: readonly Decision[];
  constraints: readonly Constraint[];
  drafts: readonly HldDraft[];
  /** Verified approval per draft (`approvalState`); without it a draft's own status is used. */
  approval?: (draft: HldDraft) => HldApproval;
}

function mmLabel(s: string): string {
  return s.replace(/"/g, "#quot;").replace(/[\r\n]+/g, " ").slice(0, 120);
}

function mmEdgeLabel(s: string): string {
  return s.replace(/[|"]/g, "'").replace(/[\r\n]+/g, " ").slice(0, 80);
}

function cell(s: string): string {
  return s.replace(/\|/g, "\\|").replace(/[\r\n]+/g, " ").trim() || "—";
}

function renderGraph(nodes: ReadonlyArray<{ id: string; label: string }>, edges: ReadonlyArray<{ from: string; to: string; label: string }>): string[] {
  const ids = new Map(nodes.map((n, i) => [n.id, `n${i}`]));
  const lines = ["```mermaid", "flowchart LR"];
  for (const n of nodes) lines.push(`  ${ids.get(n.id)}["${mmLabel(n.label)}"]`);
  for (const e of edges) {
    const a = ids.get(e.from), b = ids.get(e.to);
    if (!a || !b) continue;
    lines.push(e.label ? `  ${a} -->|"${mmEdgeLabel(e.label)}"| ${b}` : `  ${a} --> ${b}`);
  }
  lines.push("```");
  return lines;
}

function inForce(r: { status?: string; superseded_by?: string | null; valid_to?: string | null }): boolean {
  return !r.valid_to && !r.superseded_by && r.status !== "superseded" && r.status !== "rejected";
}

/** The standard HLD body (everything after the marker line). Deterministic for the same graph. */
export function renderHldBody(input: ExportInput): string {
  const comps = input.components.filter((c) => c.status === "active").slice().sort((a, b) => a.name.localeCompare(b.name));
  const compIds = new Set(comps.map((c) => c.id));
  const deps = input.edges
    .filter((e) => e.type === "depends_on" && e.from !== e.to && compIds.has(e.from) && compIds.has(e.to))
    .map((e) => ({ from: e.from, to: e.to, label: "" }))
    .sort((a, b) => `${a.from}>${a.to}`.localeCompare(`${b.from}>${b.to}`));
  const decisions = input.decisions.filter((d) => d.status === "accepted" && inForce(d)).slice().sort((a, b) => (a.topic ?? a.title).localeCompare(b.topic ?? b.title) || a.id.localeCompare(b.id));
  const sevRank = { blocking: 0, warning: 1, advisory: 2 } as const;
  const constraints = input.constraints.filter((c) => inForce(c as { valid_to?: string | null })).slice()
    .sort((a, b) => sevRank[a.severity] - sevRank[b.severity] || a.statement.localeCompare(b.statement));
  const state = (d: HldDraft): HldApproval => input.approval ? input.approval(d) : d.status === "approved" ? "approved" : "draft";
  const approved = input.drafts.filter((d) => state(d) === "approved").slice().sort((a, b) => a.source.localeCompare(b.source));
  const pending = input.drafts.filter((d) => state(d) !== "approved").slice().sort((a, b) => a.source.localeCompare(b.source));

  const out: string[] = [`# ${input.title} — High-Level Design`, ""];
  out.push("> Generated by Hunch from the project's engineering memory. The graph is the source of truth: change a decision, constraint or approved design there and re-run `hunch export-hld`. Hand edits are detected (`hunch export-hld --check`) and never silently overwritten.", "");

  out.push("## 1. Overview", "");
  const goals = approved.flatMap((d) => d.questions.filter((q) => q.kind === "missing-goals" && q.answer && !q.answer.skipped).map((q) => `- **${d.title}:** ${q.answer!.text}`));
  if (goals.length) out.push(...goals, "");
  out.push(`- ${comps.length} component(s), ${deps.length} dependency edge(s), ${decisions.length} decision(s) in force, ${constraints.length} constraint(s), ${approved.length} approved design(s).`, "");

  out.push("## 2. Architecture", "");
  if (comps.length) out.push(...renderGraph(comps.map((c) => ({ id: c.id, label: c.name })), deps), "");
  else out.push("_No components indexed yet. Run `hunch index`._", "");

  out.push("## 3. Components", "");
  if (comps.length) {
    out.push("| Component | Responsibility | Paths |", "| --- | --- | --- |");
    for (const c of comps) out.push(`| ${cell(c.name)} | ${cell(c.responsibility)} | ${cell(c.paths.map((p) => `\`${p}\``).join(", "))} |`);
    out.push("");
  } else out.push("_None._", "");

  out.push("## 4. Decisions", "");
  if (decisions.length) {
    for (const d of decisions) {
      out.push(`### ${d.title}${d.topic ? ` (\`${d.topic}\`)` : ""}`, "");
      if (d.decision) out.push(`- **Decision:** ${d.decision.replace(/\s+/g, " ").trim()}`);
      if (d.context) out.push(`- **Why:** ${d.context.replace(/\s+/g, " ").trim()}`);
      for (const r of d.alternatives_rejected) out.push(`- **Rejected:** ${r.replace(/\s+/g, " ").trim()}`);
      out.push(`- **Record:** \`${d.id}\``, "");
    }
  } else out.push("_No decisions in force._", "");

  out.push("## 5. Constraints", "");
  if (constraints.length) {
    out.push("| Severity | Rule | Scope |", "| --- | --- | --- |");
    for (const c of constraints) out.push(`| ${c.severity} | ${cell(c.statement)} | ${cell(c.scope.map((s) => `\`${s}\``).join(", "))} |`);
    out.push("");
  } else out.push("_None._", "");

  out.push("## 6. Approved designs", "");
  if (approved.length) {
    for (const d of approved) {
      out.push(`### ${d.title}`, "", `Source: \`${d.source}\` · approved by ${d.approved!.by} on ${d.approved!.at.slice(0, 10)} · locked`, "");
      if (d.nodes.length) out.push(...renderGraph(d.nodes, d.edges), "");
      const answered = d.questions.filter((q) => q.answer && !q.answer.skipped);
      if (answered.length) {
        out.push("**Clarifications**", "");
        for (const q of answered) out.push(`- _${q.question}_  `, `  ${q.answer!.text.replace(/\s+/g, " ").trim()}`);
        out.push("");
      }
    }
  } else out.push("_No approved designs yet. Import one with `hunch import-hld <file>`._", "");

  if (pending.length) {
    out.push("## 7. Designs under review", "");
    for (const d of pending) {
      out.push(state(d) === "unverified"
        ? `- \`${d.source}\`: approval unverified (no matching lock in \`.hunch/locks.json\`)`
        : `- \`${d.source}\`: ${openCount(d)} of ${d.questions.length} question(s) open`);
    }
    out.push("");
  }
  return `${out.join("\n").replace(/\n{3,}/g, "\n\n").trimEnd()}\n`;
}

/** A title that does not depend on where the repository is checked out (a renamed clone or a
 *  CI directory must render the same document): package.json's name, else a fixed string. */
export function exportTitle(root: string): string {
  try {
    const name = (JSON.parse(readFileSync(join(root, "package.json"), "utf8")) as { name?: unknown }).name;
    if (typeof name === "string" && name.trim() && name.length <= 120 && !/[\r\n]/.test(name)) return name.trim();
  } catch { /* no or unreadable package.json */ }
  return "Project";
}

export function bodyHash(body: string): string {
  return `sha256:${createHash("sha256").update(body).digest("hex")}`;
}

export function renderHld(input: ExportInput): string {
  const body = renderHldBody(input);
  return `${HLD_MARKER_PREFIX} ${bodyHash(body)} — regenerate with \`hunch export-hld\`; do not edit by hand -->\n${body}`;
}

export type ExportState = "absent" | "fresh" | "stale" | "edited" | "foreign";

/** How an existing file relates to a fresh render: missing, up to date, behind the graph,
 *  hand-edited after generation, or not ours at all (no marker: never overwritten). */
export function exportState(raw: string | null, fresh: string): ExportState {
  if (raw === null) return "absent";
  // a BOM or CRLF line endings (an editor, git autocrlf) are not a hand edit
  const existing = raw.replace(/^﻿/, "").replace(/\r\n/g, "\n");
  const nl = existing.indexOf("\n");
  const first = nl < 0 ? existing : existing.slice(0, nl);
  if (!first.startsWith(HLD_MARKER_PREFIX)) return "foreign";
  const recorded = /sha256:[a-f0-9]{64}/.exec(first)?.[0];
  if (!recorded || recorded !== bodyHash(nl < 0 ? "" : existing.slice(nl + 1))) return "edited";
  return existing === fresh ? "fresh" : "stale";
}
