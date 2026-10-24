/**
 * Markdown topic anchors — decision-grounding for PROSE (the doc≠graph spoke,
 * extended to the files the ecosystem already funnels team knowledge into:
 * AGENTS.md, CLAUDE.md, docs/*.md).
 *
 * A tracked markdown file declares which decision topic a section describes:
 *
 *   <!-- hunch:topic auth.session -->               grounding only
 *   <!-- hunch:topic auth.session dec_a1b2c3d4e5 --> PINNED: prose written against that decision
 *
 * Deterministic by construction: drift fires ONLY on an explicit pin whose
 * decision has been superseded — never on a semantic guess (the same philosophy
 * as `anchor-stale` in drift.ts). Unpinned markers still ground the pre-edit
 * hook but can never fire drift.
 */
import type { Decision } from "./types.js";
import { currentForTopic, rejectedForTopic } from "./topics.js";
import { normalizeEol } from "./eol.js";

export interface DocAnchor {
  topic: string;
  /** The decision id the prose was written against, or null for an unpinned marker. */
  pin: string | null;
  /** 1-based line of the marker in the document. */
  line: number;
}

const MARKER = /<!--\s*hunch:topic\s+([A-Za-z0-9._/-]+)(?:\s+(dec_[A-Za-z0-9]+))?\s*-->/g;

/** Expand the leading whitespace of a line to columns. A tab advances to the
 *  NEXT 4-column tab stop (CommonMark), not a flat 4 columns: after two
 *  spaces a tab is worth 2, so `  \t``` ` sits at column 4 like `\t``` `.
 *  Matching-only — offsets always come from the original line. */
function expandTabs(line: string): string {
  const ws = /^[ \t]*/.exec(line)![0];
  if (!ws.includes("\t")) return line;
  let col = 0;
  for (const c of ws) col += c === "\t" ? 4 - (col % 4) : 1;
  return " ".repeat(col) + line.slice(ws.length);
}

/** For every index i of `probe`, whether probe.slice(i) is a thematic break
 *  (`---`, `* * *`, `___`: ≤3 leading spaces, then ≥3 of one char separated by
 *  spaces only). Computed right-to-left in ONE pass so the list-marker walk
 *  below can ask the question at each nesting level without re-scanning the
 *  rest of the line each time — the difference between O(L) and O(L²) on a
 *  line that is nothing but list markers (`- - - …`, an adversarial doc). */
function thematicBreakSuffixes(probe: string): boolean[] {
  const L = probe.length;
  // runFrom[i] = the break-so-far state of probe.slice(i) when it consists only
  // of spaces and one repeated break char: its char, and how many were seen.
  const ok = new Array<boolean>(L + 1).fill(false);
  let ch = "";
  let count = 0;
  let onlySpaceSoFar = true;
  for (let i = L - 1; i >= 0; i--) {
    const c = probe[i]!;
    if (c === " " || c === "\t") {
      // A space never breaks the run; it is allowed anywhere, including the
      // ≤3 leading columns handled by the indent check at the call site.
      ok[i] = ok[i + 1]!;
      continue;
    }
    if (c === "-" || c === "*" || c === "_") {
      if (onlySpaceSoFar) { ch = c; count = 1; onlySpaceSoFar = false; }
      else if (c === ch) count++;
      // Two different break chars: every suffix starting at or before i now
      // mixes them (`- - - * -` is five nested items, not a break), so stop.
      else return ok;
    } else {
      // Any other char means no suffix starting at or before i is a break;
      // ok is already false there, so stop.
      return ok;
    }
    ok[i] = count >= 3;
  }
  return ok;
}

/** Character ranges covered by code blocks — fenced (``` or ~~~) and indented —
 *  so a documentation EXAMPLE of a marker never registers as a live anchor.
 *  A hand scanner, not a markdown parser: it answers only "is this offset inside
 *  code as a renderer shows it?", line by line and linear in each line's length.
 *
 *  Fences, CommonMark-lite: a fence of N chars (≤3 leading spaces) closes only on
 *  a line of ≥N of the same char and nothing else; an unclosed fence runs to EOF
 *  (reported as `unclosed`, which drift surfaces — issue #381); a backtick
 *  fence's info string may not itself contain a backtick. The "≤3 leading
 *  spaces" is measured relative to the enclosing LIST ITEM's content offset, so a
 *  fence indented under `1. step` (issue #331) is still a fence and not an
 *  indented code block.
 *
 *  A fence hosted in a list item ends where the ITEM ends: at the first
 *  non-blank line dedented below the item's content base. That is what the
 *  rendered document shows — the closing ``` of a sloppily indented example
 *  sits outside the item, so it terminates the item's fence and opens a new
 *  top-level one — and this scanner's job is to agree with the rendering a
 *  reader sees, not with the author's intent. In sloppy docs that differs from
 *  a flat fence scan; the rendering is the tiebreaker.
 *
 *  Also as a renderer reads them (issue #381):
 *  - indented code: ≥4 columns past the container's content, not continuing a
 *    paragraph, runs until a line dedents below that (blank lines inside it);
 *  - blockquotes: `>` prefixes are peeled first, so `> ```` opens a fence inside
 *    the quote, and a line that leaves the quote ends it;
 *  - HTML blocks (CommonMark types 1–6: script/pre/style/textarea, comments,
 *    `<?`, `<!X`, CDATA, block-level tags): their lines are raw HTML, so a ``` or
 *    an indented line inside one opens no code block. A marker inside an HTML
 *    block stays LIVE: it is an HTML comment there too, not shown as an example;
 *  - lazy continuation: a paragraph line dedented out of its list item or quote
 *    that starts no block of its own keeps that item/quote open.
 *
 *  Tabs expand to the next 4-column tab stop (not a flat 4), so `\t``` ` sits
 *  at column 4 exactly as a renderer places it. Offsets always come from the
 *  ORIGINAL line, never from the expanded probe.
 *
 *  Deliberate limits, each a case where it can still disagree with a renderer:
 *  HTML block type 7 (a lone arbitrary tag line) reads as text; a blockquote
 *  nested INSIDE a list item is read as a top-level quote; after a tab right
 *  after a `>`, later tabs on that line expand from the quote's content, not
 *  the line. With no container
 *  open the base is 0 and behaviour is the plain CommonMark-lite one.
 *  Expects LF-normalized, BOM-free text — see parseDocAnchors's normalization;
 *  a caller that skips it re-opens the CRLF fence-detection bug. */
function codeRanges(text: string): { ranges: Array<[number, number]>; unclosed: { start: number; line: number } | null } {
  const ranges: Array<[number, number]> = [];
  type Open =
    | { kind: "fence"; ch: string; len: number; start: number; base: number; q: number; line: number }
    | { kind: "indent"; start: number; end: number; base: number; q: number }
    | { kind: "html"; end: RegExp | "blank"; q: number };
  let open: Open | null = null;
  // Open list items, outermost first: the quote depth each lives in and its content column.
  const items: Array<{ q: number; base: number }> = [];
  let curQ = 0; // quote depth of the current block
  let offset = 0;
  let lineNo = 0;
  // Whether the previous line was a paragraph-continuation line: non-blank,
  // and not itself a container/leaf opener. Only a bullet or a `1.`/`1)` with
  // non-empty content may interrupt such a paragraph (CommonMark), so prose
  // like "see item\n2. the second point" stays one paragraph.
  let inParagraph = false;
  const closeOpen = (lineStart: number): void => {
    if (open?.kind === "fence") ranges.push([open.start, lineStart - 1]);
    else if (open?.kind === "indent") ranges.push([open.start, open.end]);
    open = null;
  };
  for (const line of text.split("\n")) {
    lineNo++;
    const lineStart = offset;
    offset += line.length + 1;
    // Matching-only copy: tabs advance to the next 4-column tab stop.
    const probe = expandTabs(line);

    if (open) {
      const held = peelQuotes(probe, open.q);
      if (held.q < open.q) {
        closeOpen(lineStart); // the quote holding the block ended, which ends the block too
      } else {
        const rest = held.rest;
        const indent = leadingSpaces(rest);
        const blank = rest.trim() === "";
        if (open.kind === "fence") {
          if (!blank && indent < open.base) {
            closeOpen(lineStart); // the list item holding the fence ended, which ends the fence too
          } else {
            const m = FENCE.exec(rest.slice(Math.min(open.base, indent)));
            if (m && m[1]![0]! === open.ch && m[1]!.length >= open.len && m[2]!.trim() === "") {
              ranges.push([open.start, lineStart + line.length]);
              open = null;
            }
            continue; // the container stacks are frozen while a fence is open
          }
        } else if (open.kind === "indent") {
          if (blank) continue;
          if (indent >= open.base + 4) { open.end = lineStart + line.length; continue; }
          closeOpen(lineStart);
        } else {
          if (open.end === "blank" ? blank : open.end.test(rest)) { open = null; inParagraph = false; }
          continue;
        }
      }
    }

    const { q, rest } = peelQuotes(probe, Infinity);
    const indent = leadingSpaces(rest);
    if (rest.trim() === "") {
      while (items.length && items.at(-1)!.q > q) items.pop();
      curQ = q;
      inParagraph = false;
      continue; // a blank line neither opens nor closes an item here
    }
    const isBreak = thematicBreakSuffixes(rest);
    // Lazy continuation: a paragraph line that falls out of its item or quote but
    // starts no block of its own still belongs to that paragraph, so every
    // container stays open (`- foo\nbar` — bar is item text).
    const top = items.at(-1);
    const leaves = q < curQ || (top !== undefined && top.q === q && top.base > indent);
    if (inParagraph && leaves && !startsBlock(rest, indent, isBreak)) continue;
    // A dedent that closes an item also closes the paragraph inside it, so the
    // line is a fresh block start: `1. one\n2. two` is two sibling items, not
    // item one's paragraph being "interrupted" by a `2.`.
    let popped = q !== curQ;
    while (items.length && (items.at(-1)!.q !== q || items.at(-1)!.base > indent)) { items.pop(); popped = true; }
    curQ = q;
    // Walk the line with an INDEX, peeling one list marker per step. Each step
    // is O(marker) and the cheap checks are O(1), so a line costs O(length)
    // however many markers it carries.
    let base = items.at(-1)?.base ?? 0;
    let opened = false;
    let thematic = false;
    let indented = false;
    let at = base;
    for (;;) {
      // Leading spaces of this nesting level: ≤3, else it is indented content
      // (and `    ---` is paragraph text or code, never a thematic break).
      let i = base;
      while (i < rest.length && rest[i] === " " && i - base < 4) i++;
      at = i;
      if (i - base > 3) { indented = true; break; }
      if (isBreak[i]) { thematic = true; break; } // thematic break, not a list marker
      const c = rest[i];
      let markerLen = 0;
      if (c === "-" || c === "*" || c === "+") markerLen = 1;
      else if (c !== undefined && c >= "0" && c <= "9") {
        let d = i;
        while (d < rest.length && rest[d]! >= "0" && rest[d]! <= "9" && d - i < 9) d++;
        if (rest[d] === "." || rest[d] === ")") markerLen = d - i + 1;
      }
      if (!markerLen) break;
      // Spaces between the marker and the item's content.
      let s = i + markerLen;
      while (s < rest.length && rest[s] === " ") s++;
      const gap = s - (i + markerLen);
      const emptyItem = s >= rest.length;
      if (!emptyItem && gap === 0) break; // `-foo` / `1.foo` is not a marker
      if (!opened && !popped && inParagraph && items.length === 0) {
        // Interrupting a paragraph: only a bullet, or `1.`/`1)`, and never with
        // empty content. `2. the second point` mid-prose stays paragraph text.
        const ordinal = markerLen > 1 ? rest.slice(i, i + markerLen - 1) : "";
        if (emptyItem || (ordinal !== "" && ordinal !== "1")) break;
      }
      // ≥5 spaces after the marker starts an indented code block, so the
      // item's content begins one column after the marker instead.
      const w = gap >= 1 && gap <= 4 ? gap : 1;
      base = i + markerLen + w;
      items.push({ q, base });
      opened = true;
      continue; // `- 1. x` nests, and "- ```js" opens a fence on the marker line
    }
    if (indented) {
      // An indented code block cannot interrupt a paragraph: there it is text.
      if (!inParagraph || opened) {
        open = { kind: "indent", start: lineStart, end: lineStart + line.length, base, q };
        inParagraph = false;
      }
      continue;
    }
    const content = rest.slice(at);
    const html = htmlBlockEnd(content);
    if (html) {
      if (html === "blank" || !html.test(content)) open = { kind: "html", end: html, q };
      inParagraph = false;
      continue;
    }
    const m = FENCE.exec(rest.slice(base));
    if (m) {
      const ch = m[1]![0]!;
      if (!(ch === "`" && m[2]!.includes("`"))) open = { kind: "fence", ch, len: m[1]!.length, start: lineStart, base, q, line: lineNo };
    }
    // A fence line, a thematic break or a heading (ATX, or a `===` setext
    // underline beneath a paragraph) ends the paragraph it follows; ordinary
    // text (including an item's own content) continues or starts one.
    const setext: boolean = inParagraph && /^=+[ \t]*$/.test(content);
    inParagraph = !m && !thematic && !setext && content.trim() !== "" && !/^#{1,6}(?:[ \t]|$)/.test(content);
  }
  let unclosed: { start: number; line: number } | null = null;
  const last = open as Open | null;
  if (last?.kind === "fence") { ranges.push([last.start, text.length]); unclosed = { start: last.start, line: last.line }; }
  else if (last?.kind === "indent") ranges.push([last.start, last.end]);
  return { ranges, unclosed };
}

const FENCE = /^ {0,3}(`{3,}|~{3,})(.*)$/;

const leadingSpaces = (s: string): number => s.length - s.replace(/^ +/, "").length;

/** Peel up to `max` blockquote markers (`>`, ≤3 spaces before it, one optional
 *  space after) off a tab-expanded line: the quote depth and what follows. */
function peelQuotes(probe: string, max: number): { q: number; rest: string } {
  let q = 0;
  let i = 0;
  let col = 0;
  let pad = 0;
  while (q < max) {
    let j = i;
    while (j < probe.length && probe[j] === " " && j - i < 3) j++;
    if (probe[j] !== ">") break;
    col += j - i + 1;
    i = j + 1;
    pad = 0;
    if (probe[i] === " ") { i++; col++; }
    else if (probe[i] === "\t") {
      // The tab's first column is the quote's optional space; the rest of it is
      // content indentation (CommonMark 5.1). `>\t<!-- … -->` is a paragraph, not code.
      const width = 4 - (col % 4);
      i++; col += width; pad = width - 1;
    }
    q++;
  }
  return q ? { q, rest: " ".repeat(pad) + expandTabs(probe.slice(i)) } : { q, rest: probe };
}

/** Whether a line (≤3 columns in) opens a block of its own, which a lazy
 *  continuation line by definition does not. */
function startsBlock(rest: string, indent: number, isBreak: boolean[]): boolean {
  if (indent > 3) return false;
  const s = rest.slice(indent);
  return isBreak[indent] === true || FENCE.test(rest) || /^#{1,6}(?:[ \t]|$)/.test(s) || s[0] === ">"
    || htmlBlockEnd(s) !== null || /^(?:[-*+]|\d{1,9}[.)])(?:[ \t]|$)/.test(s);
}

const HTML_BLOCK_TAGS = new Set(("address article aside base basefont blockquote body caption center col colgroup dd details dialog dir div dl dt "
  + "fieldset figcaption figure footer form frame frameset h1 h2 h3 h4 h5 h6 head header hr html iframe legend li link main menu menuitem "
  + "nav noframes ol optgroup option p param search section summary table tbody td tfoot th thead title tr track ul").split(" "));

/** The end condition of the HTML block (CommonMark types 1–6) a line opens:
 *  a pattern that closes it on a later (or the same) line, "blank" for a block
 *  that runs to the next blank line, or null when the line opens none. */
function htmlBlockEnd(s: string): RegExp | "blank" | null {
  if (s[0] !== "<") return null;
  if (/^<(?:script|pre|style|textarea)(?:[\s>]|$)/i.test(s)) return /<\/(?:script|pre|style|textarea)>/i;
  if (s.startsWith("<!--")) return /-->/;
  if (s.startsWith("<?")) return /\?>/;
  if (s.startsWith("<![CDATA[")) return /\]\]>/;
  if (/^<![A-Za-z]/.test(s)) return />/;
  const tag = /^<\/?([A-Za-z][A-Za-z0-9-]*)(?:[\s>]|\/>|$)/.exec(s);
  return tag && HTML_BLOCK_TAGS.has(tag[1]!.toLowerCase()) ? "blank" : null;
}

/** Character ranges covered by inline code spans (`…`), same rationale as
 *  codeRanges: prose quoting a marker in backticks is showing an example.
 *  CommonMark-lite: an opener run pairs with the next run of the SAME length
@@CLEANROOM_HOLE_1@@
function inlineSpanRanges(text: string): Array<[number, number]> {
  const ranges: Array<[number, number]> = [];
  let offset = 0;
  for (const line of text.split("\n")) {
    let pending: { len: number; start: number } | null = null;
    const runs = /`+/g;
    let m: RegExpExecArray | null;
    while ((m = runs.exec(line))) {
      if (!pending) pending = { len: m[0].length, start: m.index };
      else if (m[0].length === pending.len) {
        ranges.push([offset + pending.start, offset + m.index + m[0].length - 1]);
        pending = null;
      }
    }
    offset += line.length + 1;
  }
  return ranges;
}

/** Parse every hunch:topic marker out of a markdown document. Markers inside
 *  code blocks or inline code spans are examples, not declarations, and are
 *  skipped. */
export function parseDocAnchors(text: string): DocAnchor[] {
  return scanDocAnchors(text).anchors;
}

/** parseDocAnchors plus what drift reports about the document: a fence that
 *  never closes hides every marker below it, almost always by mistake (#381). */
export function scanDocAnchors(text: string): { anchors: DocAnchor[]; unclosedFence: { line: number; hidden: number } | null } {
  // codeRanges is CRLF-sensitive (its fence-line regex's `.` excludes \r, so
@@CLEANROOM_HOLE_2@@
  // codeRanges/inlineSpanRanges/MARKER offsets consistent with each other
  // and with the line numbers reported below. A leading BOM is dropped too, so
  // line 1 starts at column 0 (#381); it is one char on line 1, so line numbers hold.
  text = normalizeEol(text).replace(/^\uFEFF/, "");
  const anchors: DocAnchor[] = [];
  const code = codeRanges(text);
  const skip = [...code.ranges, ...inlineSpanRanges(text)];
  let hidden = 0;
  MARKER.lastIndex = 0;
  let m: RegExpExecArray | null;
  while ((m = MARKER.exec(text))) {
    const at = m.index;
    if (skip.some(([s, e]) => at >= s && at <= e)) {
      if (code.unclosed && at > code.unclosed.start) hidden++;
      continue;
    }
    anchors.push({ topic: m[1]!, pin: m[2] ?? null, line: text.slice(0, at).split("\n").length });
  }
  return { anchors, unclosedFence: code.unclosed && hidden ? { line: code.unclosed.line, hidden } : null };
}

const clip = (s: string, n = 220): string => (s.length > n ? s.slice(0, n - 1).trimEnd() + "…" : s);

/** Pre-edit grounding for a markdown document that carries topic anchors: the
 *  CURRENT decision per declared topic (graph over prose), what it rejected,
 *  and a stale-pin warning the editor can heal inline. Empty when no anchor
 *  resolves to a decision. */
export function renderDocGrounding(anchors: readonly DocAnchor[], decisions: readonly Decision[]): string {
  const parts: string[] = [];
  const seen = new Set<string>();
  for (const a of anchors) {
    if (seen.has(a.topic)) continue;
    seen.add(a.topic);
    const current = currentForTopic(decisions, a.topic);
    if (!current) continue;
    let line = `• topic "${a.topic}" → current decision ${current.id} — "${current.title}": ${clip(current.decision)}`;
    const rejected = rejectedForTopic(decisions, a.topic);
    if (rejected.length) line += `\n    rejected: ${rejected.slice(0, 3).map((r) => clip(r, 90)).join("; ")}`;
    // Scan ALL markers for this topic, not just the first: the topic dedupe must not
    // let an earlier unpinned marker swallow a later marker's stale-pin warning.
    const stalePin = anchors.find((x) => x.topic === a.topic && x.pin && x.pin !== current.id)?.pin;
    if (stalePin) {
      line += `\n    ⚠ this section is PINNED to ${stalePin}, which is no longer current — reconcile the prose with ${current.id}, then re-pin.`;
    }
    parts.push(line);
  }
  if (!parts.length) return "";
  return `🧭 Doc-grounding — this document declares topic anchors; the GRAPH is the source of truth. Follow the current decision, update prose to match it:\n${parts.join("\n")}`;
}
