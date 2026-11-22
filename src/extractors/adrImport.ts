/**
 * MADR/Nygard ADR corpus import (roadmap: MADR bridge, import half).
 *
 * Deterministic, no-LLM: parse an existing `docs/adr`-style corpus into Decision
 * records so an ADR-practicing repo gets a populated graph on day 1 instead of
 * waiting for commit backfill. Mapping contract:
 *   accepted            -> status accepted (live)
 *   proposed/draft      -> status proposed
 *   rejected            -> status rejected
 *   superseded           -> status superseded, valid_to closed (bi-temporal)
 *   deprecated + successor -> status superseded, closed at the successor date
 *   deprecated, bare     -> status accepted with a loud review warning; the raw
 *                           lifecycle remains in provenance evidence
 *   "Considered Options" minus the chosen one -> alternatives_rejected
 *   file slug           -> topic `adr.<slug>` (namespaced so an import can never
 *                          collide with a live hand-captured topic; the CLI still
 *                          drops the anchor entirely if a collision exists)
 *   provenance          -> source "imported:madr", the ADR file as evidence
 *
 * Ids derive from the ADR's repo-relative path (decisionId("madr:<relPath>")),
 * so re-importing an updated corpus is an idempotent per-record update, never a
 * duplicate. Parsing is pure (string in, records out) — the CLI owns all IO.
 */
import { createHash } from "node:crypto";
import { decisionId } from "../core/ids.js";
import { normalizeEol } from "../core/eol.js";
import type { Decision } from "../core/types.js";

/** Directories probed (in order) when no explicit dir is given — adr-tools'
 *  default (doc/adr), MADR's (docs/decisions), and the common variants. */
export const ADR_DIR_CANDIDATES = [
  "docs/adr",
  "docs/decisions",
  "doc/adr",
  "adr",
  "docs/architecture/decisions",
] as const;

/** An ADR file is NNNN-slug.md (adr-tools / MADR convention). Templates and
 *  indexes (adr-template.md, README.md, index.md) never match. */
export const ADR_FILE_RE = /^(\d{1,5})-([a-z0-9@][a-z0-9@._-]*)\.md$/i;

/** A structurally valid ADR filename can still name corpus scaffolding rather
 * than a decision. Keep this classification separate from parse failure so the
 * CLI can exclude templates quietly instead of falsely calling their filename
 * malformed. */
export function isAdrCorpusTemplate(relPath: string): boolean {
  const base = relPath.split("/").pop() ?? relPath;
  const match = ADR_FILE_RE.exec(base);
  return match !== null
    && Number(match[1]) === 0
    && /^(?:adr[-_.]?)?template(?:[-_.]|$)/i.test(match[2]!);
}

/** Decision.date is required even when an ADR has no date and no Git history is
 * available (for example, a copied corpus outside a repository). Use an honest,
 * deterministic sentinel instead of the import clock: re-importing the same
 * bytes must not silently make an old decision look current. */
export const UNDATED_ADR_DATE = "1970-01-01T00:00:00.000Z";

export interface AdrSource {
  /** repo-relative posix path, e.g. docs/adr/0005-use-postgres.md */
  relPath: string;
  text: string;
  /** ISO date of the source file's introduction commit, when available. */
  sourceDate?: string | null;
  /** Full source introduction commit, when available. */
  sourceRevision?: string | null;
}

export interface ParsedAdr {
  relPath: string;
  number: number;
  slug: string;
  title: string;
  /** raw status text as written (e.g. "Superseded by [ADR-7](...)") */
  statusRaw: string;
  status: "proposed" | "accepted" | "rejected" | "superseded";
  date: string | null;
  context: string;
  decision: string;
  consequences: string[];
  consideredOptions: string[];
  chosenOption: string | null;
  sourceHash: string;
  /** ADR numbers this one supersedes / is superseded by (from status text + links) */
  supersedesNumbers: number[];
  supersededByNumbers: number[];
}

export interface AdrImportResult {
  decisions: Decision[];
  warnings: string[];
}

const FRONTMATTER_RE = /^---\r?\n([\s\S]*?)\r?\n---\r?\n?/;

function frontmatterField(fm: string, key: string): string | null {
  const m = new RegExp(`^${key}:[ \\t]*(.+)$`, "mi").exec(fm);
  if (!m) return null;
  return m[1]!.trim().replace(/^["']|["']$/g, "");
}

/** Normalize a Markdown section heading for the small ADR vocabulary. */
function normalizeHeading(value: string): string {
  return value
    .replace(/\s+\(optional\)\s*$/i, "")
    .replace(/[*_`]/g, "")
    .trim()
    .toLowerCase();
}

/** Read level-2+ Markdown sections while preserving their hierarchy. A level-2
 * MADR section includes its nested level-3 text, and the nested section is also
 * addressable on its own. Infection's older ADRs use level 3 for every top-level
 * section, so accepting only `##` silently lost their status and content. */
function sections(body: string): Map<string, string> {
  const out = new Map<string, string>();
  const lines = body.split(/\r?\n/);
  const headings: Array<{ line: number; level: number; title: string }> = [];
  let fence: { char: "`" | "~"; length: number } | null = null;
  for (let line = 0; line < lines.length; line++) {
    const value = lines[line]!;
    const marker = /^\s*(`{3,}|~{3,})/.exec(value)?.[1];
    if (marker) {
      const char = marker[0] as "`" | "~";
      if (!fence) fence = { char, length: marker.length };
      else if (fence.char === char && marker.length >= fence.length) fence = null;
      continue;
    }
    if (fence) continue;
    const heading = /^(#{2,6})\s+(.+?)\s*$/.exec(value);
    if (heading) headings.push({ line, level: heading[1]!.length, title: heading[2]! });
  }
  for (let index = 0; index < headings.length; index++) {
    const heading = headings[index]!;
    let end = lines.length;
    for (let next = index + 1; next < headings.length; next++) {
      if (headings[next]!.level <= heading.level) {
        end = headings[next]!.line;
        break;
      }
    }
    out.set(normalizeHeading(heading.title), lines.slice(heading.line + 1, end).join("\n").trim());
  }
  return out;
}

function sectionOf(secs: Map<string, string>, ...names: string[]): string {
  for (const n of names) {
    const v = secs.get(normalizeHeading(n));
    if (v) return v;
  }
  return "";
}

/** Top-level `- ` / `* ` list items of a section (MADR "Considered Options"). */
function listItems(sectionText: string): string[] {
  const items: string[] = [];
  for (const line of sectionText.split(/\r?\n/)) {
    const m = /^[-*]\s+(.+)$/.exec(line.trim());
    if (m) items.push(stripMdLinks(m[1]!.trim()));
  }
  return items;
}

/** Consequences render either as a list or prose paragraphs; normalize to items. */
function consequenceItems(sectionText: string): string[] {
  const items = listItems(sectionText);
  if (items.length) return items.map((i) => i.replace(/^(good|bad|neutral),\s*(because\s*)?/i, "").trim()).filter(Boolean);
  const prose = sectionText.trim();
  return prose ? [stripMdLinks(prose)] : [];
}

/** MADR usually lists options, while older corpora often describe rejected
 * alternatives as prose paragraphs. Preserve either form instead of silently
 * dropping the latter from alternatives_rejected. */
function alternativeItems(sectionText: string): string[] {
  const listed = listItems(sectionText);
  if (listed.length) return listed;
  return sectionText
    .split(/\r?\n\s*\r?\n/)
    .map((paragraph) => stripMdLinks(paragraph).replace(/\s+/g, " ").trim())
    .filter((paragraph) => paragraph.length > 0 && !/^\[[^\]]+\]:\s*/.test(paragraph));
}

function stripMdLinks(s: string): string {
  return s
    .replace(/\[([^\]]*)\]\([^)]*\)/g, "$1")
    .replace(/\[([^\]]*)\]\[[^\]]*\]/g, "$1")
    .trim();
}

/** ADR cross-reference numbers in a status/frontmatter phrase, e.g.
 *  "Superseded by [ADR-0007](0007-x.md)" or "supersedes 3". */
function adrRefNumbers(text: string): number[] {
  const out = new Set<number>();
  for (const match of text.matchAll(/\bADR[-\s]+0*(\d{1,5})\b/gi)) out.add(Number(match[1]));
  for (const match of text.matchAll(/(?:^|[(/])0*(\d{1,5})-[a-z0-9@][a-z0-9@._-]*\.md\b/gi)) out.add(Number(match[1]));
  // Frontmatter commonly uses `supersedes: 4`; accept a bare number only when
  // the entire field is numeric. Never treat issue/PR references such as #1760
  // as ADR relationships.
  const bare = /^\s*0*(\d{1,5})\s*$/.exec(text);
  if (bare) out.add(Number(bare[1]));
  return [...out];
}

/** MADR 2.x and many hand-written ADRs keep metadata as a bullet list between
 * the `#` title and the first section heading (`- Status: accepted`,
 * `* **Status:** accepted`). Read the status from that header block only, so a
 * "Status:" bullet deeper in the body is never mistaken for metadata. */
function headerBulletStatus(body: string): string | undefined {
  const lines = body.split(/\r?\n/);
  const title = lines.findIndex((l) => /^#\s+/.test(l));
  for (let i = title + 1; i < lines.length; i++) {
    const line = lines[i]!;
    if (/^#{1,6}\s/.test(line)) break;
    const m = /^\s*[-*+]\s+[*_]{0,2}status[*_]{0,2}\s*:\s*[*_]{0,2}\s*(.+?)\s*$/i.exec(line);
    if (m) return m[1]!.replace(/[*_]+$/, "").trim() || undefined;
  }
  return undefined;
}

function mapStatus(raw: string): ParsedAdr["status"] {
  const s = raw.toLowerCase();
  // MADR permits a bare `deprecated` lifecycle with no replacement relation.
  // Hunch has no deprecated Decision status, and inventing `superseded` would
  // silently fabricate a history edge and remove the record from live recall.
  // Keep it advisory/live unless an explicit successor below proves closure;
  // provenance retains the source status and the mapper emits a warning.
  if (/deprecat/.test(s)) return "accepted";
  if (/supersed/.test(s)) return "superseded";
  if (/reject/.test(s)) return "rejected";
  if (/accept|approv/.test(s)) return "accepted";
  return "proposed";
}

/** Parse one ADR markdown file (MADR 3.x/4 frontmatter style, MADR 2.x header
 *  bullets, or Nygard heading style). Returns null when the filename doesn't follow NNNN-slug.md. */
export function parseAdrMarkdown(text: string, relPath: string): ParsedAdr | null {
  const base = relPath.split("/").pop() ?? relPath;
  const nameMatch = ADR_FILE_RE.exec(base);
  if (!nameMatch) return null;
  const number = Number(nameMatch[1]);
  const slug = nameMatch[2]!.toLowerCase();
  if (isAdrCorpusTemplate(relPath)) return null;

  const fmMatch = FRONTMATTER_RE.exec(text);
  const fm = fmMatch ? fmMatch[1]! : "";
  const body = fmMatch ? text.slice(fmMatch[0].length) : text;

  const titleMatch = /^#\s+(.+?)\s*$/m.exec(body);
  // Nygard titles carry the number ("1. Record architecture decisions") — strip it.
  const title = (titleMatch ? titleMatch[1]! : slug.replace(/[-_]/g, " ")).replace(/^\d+\.\s*/, "").trim();

  const secs = sections(body);
  const statusSection = sectionOf(secs, "Status");
  const statusRaw =
    frontmatterField(fm, "status") ??
    statusSection.split(/\r?\n/).map((l) => l.trim()).filter(Boolean)[0] ??
    headerBulletStatus(body) ??
    "";
  const status = mapStatus(statusRaw);
  const date = frontmatterField(fm, "date");

  // Cross-links live in the status phrase(s) and frontmatter supersede fields.
  const statusText = `${statusRaw}\n${statusSection}`;
  const supersededByNumbers: number[] = [];
  const supersedesNumbers: number[] = [];
  for (const line of statusText.split(/\r?\n/)) {
    if (/superseded\s+by|deprecated\s+by|replaced\s+by/i.test(line)) supersededByNumbers.push(...adrRefNumbers(line.replace(/.*?(?:by)/i, "")));
    else if (/supersedes|replaces/i.test(line)) supersedesNumbers.push(...adrRefNumbers(line.replace(/.*?(?:supersedes|replaces)/i, "")));
  }
  for (const key of ["superseded-by", "superseded_by"]) {
    const v = frontmatterField(fm, key);
    if (v) supersededByNumbers.push(...adrRefNumbers(v));
  }
  const fmSupersedes = frontmatterField(fm, "supersedes");
  if (fmSupersedes) supersedesNumbers.push(...adrRefNumbers(fmSupersedes));

  const decisionOutcome = sectionOf(secs, "Decision Outcome", "Decision");
  const chosenMatch = /chosen option:\s*["“]?([^"”\n,]+)["”]?/i.exec(decisionOutcome);
  const consideredOptions = alternativeItems(sectionOf(secs, "Considered Options", "Alternatives Considered", "Options"));

  // "### Consequences" nests inside Decision Outcome in MADR; Nygard has it top-level.
  let consequencesText = sectionOf(secs, "Consequences");
  if (!consequencesText) {
    const nested = /###\s+Consequences\s*\r?\n([\s\S]*?)(?=\r?\n###\s|$)/i.exec(decisionOutcome);
    if (nested) consequencesText = nested[1]!.trim();
  }

  return {
    relPath,
    number,
    slug,
    title,
    statusRaw,
    status,
    date,
    context: stripMdLinks(sectionOf(secs, "Context and Problem Statement", "Context")).trim(),
    decision: stripMdLinks(decisionOutcome.replace(/###\s+Consequences[\s\S]*$/i, "")).trim(),
    consequences: consequenceItems(consequencesText),
    consideredOptions,
    chosenOption: chosenMatch ? chosenMatch[1]!.trim() : null,
    // Line endings and a BOM are checkout artifacts (core.autocrlf), not content: hash the
    // canonical text so an approval binds the same ADR on every platform (#673).
    sourceHash: createHash("sha256").update(normalizeEol(text).replace(/^\uFEFF/, "")).digest("hex"),
    supersedesNumbers: [...new Set(supersedesNumbers)],
    supersededByNumbers: [...new Set(supersededByNumbers)],
  };
}

export function adrDecisionId(relPath: string): string {
  return decisionId(`madr:${relPath}`);
}

/** Map a parsed corpus to Decision records. Pure: cross-links resolve by ADR
 *  number WITHIN the given corpus only; unresolvable references become warnings,
 *  never guessed ids. Bi-temporal closure: a superseded ADR's valid_to is its
 *  successor's valid_from (falling back to the successor's date, then its own
 *  date) so as-of queries see the corpus's real history. */
export function mapAdrCorpus(sources: AdrSource[]): AdrImportResult {
  const warnings: string[] = [];
  const parsed: ParsedAdr[] = [];
  for (const src of sources) {
    const p = parseAdrMarkdown(src.text, src.relPath);
    if (!p) {
      if (!isAdrCorpusTemplate(src.relPath)) {
        warnings.push(`${src.relPath}: filename does not follow NNNN-slug.md — skipped`);
      }
      continue;
    }
    parsed.push(p);
  }
  const byNumber = new Map<number, ParsedAdr>();
  const sourceByPath = new Map(sources.map((source) => [source.relPath, source] as const));
  for (const p of parsed) {
    if (byNumber.has(p.number)) warnings.push(`duplicate ADR number ${p.number}: ${byNumber.get(p.number)!.relPath} and ${p.relPath} — cross-links resolve to the first`);
    else byNumber.set(p.number, p);
  }

  // Derive the missing half of each supersede link so a one-sided "Superseded by"
  // still closes windows and sets both pointers.
  for (const p of parsed) {
    for (const n of p.supersedesNumbers) {
      const target = byNumber.get(n);
      if (!target) { warnings.push(`${p.relPath}: supersedes ADR ${n}, which is not in the corpus`); continue; }
      if (!target.supersededByNumbers.includes(p.number)) target.supersededByNumbers.push(p.number);
    }
    for (const n of p.supersededByNumbers) {
      const successor = byNumber.get(n);
      if (!successor) { warnings.push(`${p.relPath}: superseded by ADR ${n}, which is not in the corpus`); continue; }
      if (!successor.supersedesNumbers.includes(p.number)) successor.supersedesNumbers.push(p.number);
    }
  }

  const decisions: Decision[] = parsed.map((p) => {
    const successor = p.supersededByNumbers.map((n) => byNumber.get(n)).find(Boolean) ?? null;
    if (/deprecat/i.test(p.statusRaw) && !successor) {
      warnings.push(`${p.relPath}: deprecated status names no resolvable successor — kept in force as accepted; raw status remains in provenance evidence, review and record an explicit successor or rejection`);
    }
    const superseded = p.status === "superseded" || !!successor;
    const sourceDate = sourceByPath.get(p.relPath)?.sourceDate || null;
    const sourceRevision = sourceByPath.get(p.relPath)?.sourceRevision || null;
    const effectiveDate = p.date ?? sourceDate ?? UNDATED_ADR_DATE;
    const successorSourceDate = successor ? (sourceByPath.get(successor.relPath)?.sourceDate || null) : null;
    const validTo = superseded ? (successor?.date ?? successorSourceDate ?? p.date ?? sourceDate) : null;
    const alternatives = p.consideredOptions.filter(
      (o) => !p.chosenOption || o.toLowerCase() !== p.chosenOption.toLowerCase(),
    );
    return {
      id: adrDecisionId(p.relPath),
      title: p.title,
      topic: `adr.${p.slug}`,
      status: superseded ? "superseded" : p.status,
      context: p.context,
      decision: p.decision || p.title,
      consequences: p.consequences,
      alternatives_rejected: alternatives,
      rejected_tripwires: [],
      related_components: [],
      related_files: [p.relPath],
      supersedes: p.supersedesNumbers.map((n) => byNumber.get(n)).filter(Boolean).map((t) => adrDecisionId(t!.relPath))[0] ?? null,
      superseded_by: successor ? adrDecisionId(successor.relPath) : null,
      caused_by_bug: null,
      commit: sourceRevision,
      valid_from: p.date ?? sourceDate ?? undefined,
      valid_to: validTo,
      retired: { symbols: [], deps: [] },
      provenance: {
        source: "imported:madr",
        confidence: 0.75,
        evidence: [
          p.relPath,
          `sha256:${p.sourceHash}`,
          ...(sourceRevision ? [`source-commit:${sourceRevision}`] : []),
          `status: ${p.statusRaw || "(none)"}`,
        ],
      },
      date: effectiveDate,
    };
  });

  // A corpus must not import two LIVE decisions onto one topic (the store-wide
  // one-live-per-topic invariant): keep the highest ADR number live, close the rest.
  const liveByTopic = new Map<string, Decision[]>();
  for (const d of decisions) {
    if (d.status === "accepted" && d.topic) {
      const list = liveByTopic.get(d.topic) ?? [];
      list.push(d);
      liveByTopic.set(d.topic, list);
    }
  }
  for (const [topic, list] of liveByTopic) {
    if (list.length < 2) continue;
    list.sort((a, b) => adrNumberOf(a, parsed) - adrNumberOf(b, parsed));
    const winner = list[list.length - 1]!;
    for (const loser of list.slice(0, -1)) {
      loser.status = "superseded";
      loser.superseded_by = winner.id;
      loser.valid_to = winner.valid_from ?? loser.date;
      warnings.push(`topic ${topic}: two live ADRs — kept ${winner.id} live, closed ${loser.id}`);
    }
  }

  return { decisions, warnings };
}

function adrNumberOf(d: Decision, parsed: ParsedAdr[]): number {
  const rel = d.related_files[0];
  return parsed.find((p) => p.relPath === rel)?.number ?? 0;
}
