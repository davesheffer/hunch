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
import { existsSync, mkdirSync, readFileSync, readdirSync, statSync } from "node:fs";
import { extname, join } from "node:path";
import { inflateRawSync } from "node:zlib";
import { z } from "zod";
import { writeFileAtomic } from "./io.js";
import { HUNCH_DIR, safeRepoScope } from "./paths.js";
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
    return { format, title: fallbackTitle, nodes, edges, sections: [], prose: "", diagrams: pages };
  }
  if (format === "mermaid") {
    const g = parseMermaid(text);
    return { format, title: fallbackTitle, nodes: g.nodes, edges: g.edges, sections: [], prose: "", diagrams: 1 };
  }
  return parseMarkdown(text, fallbackTitle);
}

function parseMarkdown(text: string, fallbackTitle: string): ParsedHld {
  const sections: HldSection[] = [];
  const prose: string[] = [];
  const graphs: Array<{ nodes: HldNode[]; edges: HldEdge[] }> = [];
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
  return { format: "markdown", title, nodes: merged.nodes, edges: merged.edges, sections, prose: prose.join("\n"), diagrams: graphs.length };
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
const ARROW_RE = /\s*(<-->|<==>|<-\.->|-->|---|-\.->|-\.-|==>|===|--[xo]|<--|~~~)(?:\|([^|]*)\|)?\s*/;
const SKIP_RE = /^(graph|flowchart|subgraph|end|classDef|class|style|linkStyle|click|direction|%%|accTitle|accDescr|title)\b/;

function cleanLabel(raw: string): string {
  return raw.replace(/^["'`]|["'`]$/g, "").replace(/<br\s*\/?>/gi, " ").replace(/#quot;/g, "\"").replace(/\s+/g, " ").trim();
}

/** Flowchart/graph and sequence diagrams; other Mermaid kinds yield no graph. */
export function parseMermaid(text: string): { nodes: HldNode[]; edges: HldEdge[] } {
  const lines = text.split(/\r?\n/).map((l) => l.replace(/%%.*$/, "").trim()).filter(Boolean);
  const kind = (lines[0] ?? "").split(/\s+/)[0]!.toLowerCase();
  if (kind === "sequencediagram") return parseSequence(lines.slice(1));
  if (kind !== "graph" && kind !== "flowchart") return { nodes: [], edges: [] };
  const nodes = new Map<string, HldNode>();
  const edges: HldEdge[] = [];
  const node = (token: string): string[] => token.split(/\s*&\s*/).flatMap((part) => {
    const m = NODE_RE.exec(part.trim());
    if (!m) return [];
    const id = m[1]!;
    const label = m[3] ? cleanLabel(m[3]) : "";
    const prev = nodes.get(id);
    if (!prev) nodes.set(id, { id, label: label || id });
    else if (label && prev.label === prev.id) prev.label = label;
    return [id];
  });
  for (const raw of lines.slice(1)) {
    if (SKIP_RE.test(raw)) continue;
    // `A -- text --> B` / `A -. text .-> B` / `A == text ==> B` carry the label inline.
    const line = raw
      .replace(/\s--\s+([^>|-][^>|]*?)\s+-->\s*/g, " -->|$1| ")
      .replace(/\s-\.\s+([^>|]+?)\s+\.->\s*/g, " -.->|$1| ")
      .replace(/\s==\s+([^>|]+?)\s+==>\s*/g, " ==>|$1| ");
    const parts = line.split(ARROW_RE);
    // split with 2 capture groups: [node, arrow, label, node, arrow, label, node...]
    let prev: string[] = node(parts[0]!.replace(/;$/, ""));
    for (let i = 1; i + 2 < parts.length; i += 3) {
      const label = cleanLabel(parts[i + 1] ?? "");
      const next = node((parts[i + 2] ?? "").replace(/;$/, ""));
      for (const a of prev) for (const b of next) edges.push({ from: a, to: b, label });
      prev = next;
    }
  }
  return { nodes: [...nodes.values()], edges };
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
      ask("uncovered-components", "uncovered", `These components exist in the code but not in the design: ${list}. Out of scope, or missing from the design?`);
    }
  }
  return out;
}

// ---- drafts ------------------------------------------------------------------

export function draftPath(source: string): string {
  const slug = source.toLowerCase().replace(/\.[^./]+$/, "").replace(/[^a-z0-9]+/g, "-").replace(/^-+|-+$/g, "").slice(0, 120) || "hld";
  return `${HLD_DIR}/${slug}.json`;
}

export function sourcePath(rel: string): string | null {
  const p = safeRepoScope(rel);
  if (!p || /[*?[\]{}]/.test(p) || p.startsWith(`${HUNCH_DIR}/`)) return null;
  return p;
}

export function readDraft(root: string, source: string): HldDraft | null {
  const file = join(root, draftPath(source));
  if (!existsSync(file)) return null;
  const parsed = DraftSchema.safeParse(JSON.parse(readFileSync(file, "utf8")));
  if (!parsed.success) throw new Error(`${draftPath(source)} is not a valid HLD draft; restore it from git or re-import`);
  return parsed.data;
}

export function listDrafts(root: string): HldDraft[] {
  const dir = join(root, HLD_DIR);
  if (!existsSync(dir)) return [];
  const out: HldDraft[] = [];
  for (const f of readdirSync(dir).filter((f) => f.endsWith(".json")).sort()) {
    const parsed = DraftSchema.safeParse(JSON.parse(readFileSync(join(dir, f), "utf8")));
    if (parsed.success) out.push(parsed.data);
  }
  return out;
}

export function writeDraft(root: string, draft: HldDraft): void {
  const file = join(root, draftPath(draft.source));
  mkdirSync(join(root, HLD_DIR), { recursive: true });
  writeFileAtomic(file, `${JSON.stringify(DraftSchema.parse(draft), null, 2)}\n`);
}

export function sourceSha(root: string, source: string): string {
  const abs = join(root, source);
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
  const source = sourcePath(rel);
  if (!source) throw new Error(`cannot import ${rel}: give a repo-relative file path outside ${HUNCH_DIR}/`);
  if (!existsSync(join(root, source))) throw new Error(`${source} does not exist`);
  const sha = sourceSha(root, source);
  const text = readFileSync(join(root, source), "utf8");
  const parsed = parseHld(source, text);
  const previous = readDraft(root, source);
  if (previous?.status === "approved" && !opts.reopen) {
    throw new Error(`${source} is an approved, locked HLD (approved by ${previous.approved!.by}). Only a human reopens it, by running \`hunch import-hld ${source}\` in a terminal.`);
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
export function grillingProtocol(draft: HldDraft): string {
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
  if (draft.status === "approved") return `${draft.source} is approved by ${draft.approved!.by} and locked. Nothing to ask.`;
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
  const approved = input.drafts.filter((d) => d.status === "approved").slice().sort((a, b) => a.source.localeCompare(b.source));
  const pending = input.drafts.filter((d) => d.status !== "approved").slice().sort((a, b) => a.source.localeCompare(b.source));

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
    for (const d of pending) out.push(`- \`${d.source}\`: ${openCount(d)} of ${d.questions.length} question(s) open`);
    out.push("");
  }
  return `${out.join("\n").replace(/\n{3,}/g, "\n\n").trimEnd()}\n`;
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
export function exportState(existing: string | null, fresh: string): ExportState {
  if (existing === null) return "absent";
  const nl = existing.indexOf("\n");
  const first = nl < 0 ? existing : existing.slice(0, nl);
  if (!first.startsWith(HLD_MARKER_PREFIX)) return "foreign";
  const recorded = /sha256:[a-f0-9]{64}/.exec(first)?.[0];
  if (!recorded || recorded !== bodyHash(nl < 0 ? "" : existing.slice(nl + 1))) return "edited";
  return existing === fresh ? "fresh" : "stale";
}
