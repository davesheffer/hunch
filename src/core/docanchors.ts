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

/** Character ranges covered by fenced code blocks (``` or ~~~), so a
 *  documentation EXAMPLE of a marker never registers as a live anchor.
 *  CommonMark-lite: a fence of N chars (≤3 leading spaces) closes only on a
 *  line of ≥N of the same char and nothing else; an unclosed fence runs to
 *  EOF; a backtick fence's info string may not itself contain a backtick.
 *  The "≤3 leading spaces" is measured relative to the enclosing LIST ITEM's
 *  content offset, so a fence indented under `1. step` (issue #331) is still a
 *  fence and not an indented code block.
 *
 *  A fence hosted in a list item ends where the ITEM ends: at the first
 *  non-blank line dedented below the item's content base. That is what the
 *  rendered document shows — the closing ``` of a sloppily indented example
 *  sits outside the item, so it terminates the item's fence and opens a new
 *  top-level one — and this scanner's job is to agree with the rendering a
 *  reader sees, not with the author's intent. In sloppy docs that differs from
 *  a flat fence scan; the rendering is the tiebreaker.
 *
 *  Tabs expand to the next 4-column tab stop (not a flat 4), so `\t``` ` sits
 *  at column 4 exactly as a renderer places it. Offsets always come from the
 *  ORIGINAL line, never from the expanded probe.
 *
 *  Deliberate limits: no lazy continuations and no blockquote containers — a
 *  `>` prefix is still read as ordinary text. With no list open the item stack
 *  is empty, the base is 0 and behaviour is the plain CommonMark-lite one.
 *  Expects LF-normalized text — see parseDocAnchors's normalization; a caller
 *  that skips it re-opens the CRLF fence-detection bug. */
function fencedRanges(text: string): Array<[number, number]> {
  const FENCE = /^ {0,3}(`{3,}|~{3,})(.*)$/;
  const ranges: Array<[number, number]> = [];
  let open: { ch: string; len: number; start: number; base: number } | null = null;
  // Content offsets (columns) of the currently open list items, outermost first.
  const items: number[] = [];
  let offset = 0;
  // Whether the previous line was a paragraph-continuation line: non-blank,
  // and not itself a container/leaf opener. Only a bullet or a `1.`/`1)` with
  // non-empty content may interrupt such a paragraph (CommonMark), so prose
  // like "see item\n2. the second point" stays one paragraph.
  let inParagraph = false;
  for (const line of text.split("\n")) {
    // Matching-only copy: tabs advance to the next 4-column tab stop.
    const probe = expandTabs(line);
    const indent = probe.length - probe.replace(/^ +/, "").length;
    const blank = probe.trim() === "";

    if (open) {
      if (!blank && indent < open.base) {
        // The list item holding the fence ended, which ends the fence too.
        ranges.push([open.start, offset - 1]);
        open = null;
      } else {
        const m = FENCE.exec(probe.slice(Math.min(open.base, indent)));
        if (m && m[1]![0]! === open.ch && m[1]!.length >= open.len && m[2]!.trim() === "") {
          ranges.push([open.start, offset + line.length]);
          open = null;
        }
        offset += line.length + 1;
        continue; // the item stack is frozen while a fence is open
      }
    }

    if (blank) {
      offset += line.length + 1;
      inParagraph = false;
      continue; // a blank line neither opens nor closes an item here
    }
    // A dedent that closes an item also closes the paragraph inside it, so the
    // line is a fresh block start: `1. one\n2. two` is two sibling items, not
    // item one's paragraph being "interrupted" by a `2.`.
    let popped = false;
    while (items.length && items.at(-1)! > indent) { items.pop(); popped = true; }
    const isBreak = thematicBreakSuffixes(probe);
    // Walk the line with an INDEX, peeling one list marker per step. Each step
    // is O(marker) and the cheap checks are O(1), so a line costs O(length)
    // however many markers it carries.
    let base = items.at(-1) ?? 0;
    let opened = false;
    let thematic = false;
    for (;;) {
      // Leading spaces of this nesting level: ≤3, else it is indented content
      // (and `    ---` is paragraph text or code, never a thematic break).
      let i = base;
      while (i < probe.length && probe[i] === " " && i - base < 4) i++;
      const lead = i - base;
      if (lead > 3) break;
      if (isBreak[i]) { thematic = true; break; } // thematic break, not a list marker
      const c = probe[i];
      let markerLen = 0;
      if (c === "-" || c === "*" || c === "+") markerLen = 1;
      else if (c !== undefined && c >= "0" && c <= "9") {
        let d = i;
        while (d < probe.length && probe[d]! >= "0" && probe[d]! <= "9" && d - i < 9) d++;
        if (probe[d] === "." || probe[d] === ")") markerLen = d - i + 1;
      }
      if (!markerLen) break;
      // Spaces between the marker and the item's content.
      let s = i + markerLen;
      while (s < probe.length && probe[s] === " ") s++;
      const gap = s - (i + markerLen);
      const emptyItem = s >= probe.length;
      if (!emptyItem && gap === 0) break; // `-foo` / `1.foo` is not a marker
      if (!opened && !popped && inParagraph && items.length === 0) {
        // Interrupting a paragraph: only a bullet, or `1.`/`1)`, and never with
        // empty content. `2. the second point` mid-prose stays paragraph text.
        const ordinal = markerLen > 1 ? probe.slice(i, i + markerLen - 1) : "";
        if (emptyItem || (ordinal !== "" && ordinal !== "1")) break;
      }
      // ≥5 spaces after the marker starts an indented code block, so the
      // item's content begins one column after the marker instead.
      const w = gap >= 1 && gap <= 4 ? gap : 1;
      base = base + lead + markerLen + w;
      items.push(base);
      opened = true;
      continue; // `- 1. x` nests, and "- ```js" opens a fence on the marker line
    }
    const m = FENCE.exec(probe.slice(base));
    if (m) {
      const ch = m[1]![0]!;
      if (!(ch === "`" && m[2]!.includes("`"))) open = { ch, len: m[1]!.length, start: offset, base };
    }
    // A fence line or a thematic break ends the paragraph it follows; ordinary
    // text (including an item's own content) continues or starts one.
    inParagraph = !m && !thematic;
    offset += line.length + 1;
  }
  if (open) ranges.push([open.start, text.length]);
  return ranges;
}

/** Character ranges covered by inline code spans (`…`), same rationale as
 *  fencedRanges: prose quoting a marker in backticks is showing an example.
 *  CommonMark-lite: an opener run pairs with the next run of the SAME length
 *  on the same line; unpaired runs never open a span.
 *  Expects LF-normalized text — see parseDocAnchors's normalization.
 *  `split("\n")` does not split a bare CR, so on CR-only input the whole
 *  document reads as one line and stray backticks on different lines
 *  falsely pair. */
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
 *  fenced code blocks or inline code spans are examples, not declarations,
 *  and are skipped. */
export function parseDocAnchors(text: string): DocAnchor[] {
  // fencedRanges is CRLF-sensitive (its fence-line regex's `.` excludes \r, so
  // "```\r" never matched at all on a CRLF checkout); inlineSpanRanges is
  // lone-CR-sensitive (split("\n") doesn't split a bare CR — see its
  // docblock). Either way an example marker inside a fence/span registered as
  // a live, pinned anchor. Normalizing both CRLF and lone CR once here keeps
  // fencedRanges/inlineSpanRanges/MARKER offsets consistent with each other
  // and with the line numbers reported below.
  text = text.replace(/\r\n?/g, "\n");
  const out: DocAnchor[] = [];
  const skip = [...fencedRanges(text), ...inlineSpanRanges(text)];
  MARKER.lastIndex = 0;
  let m: RegExpExecArray | null;
  while ((m = MARKER.exec(text))) {
    const at = m.index;
    if (skip.some(([s, e]) => at >= s && at <= e)) continue;
    out.push({ topic: m[1]!, pin: m[2] ?? null, line: text.slice(0, at).split("\n").length });
  }
  return out;
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
