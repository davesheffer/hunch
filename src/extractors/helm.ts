/**
 * Deterministic text scan for Helm's `define`/`include`/`template` Go-template
 * actions — NOT a Go-template parser, and NOT a tree-sitter query. tree-sitter-yaml
 * has no notion of `{{ }}` content: parsing `{{ include "x" . }}` inside a real
 * YAML mapping value produces only stray `{` flow-mapping-open tokens, with the
 * enclosed text lost to ERROR recovery (verified directly against this repo's
 * tree-sitter-yaml bundle). There is nothing for a tree-sitter query to capture,
 * so this runs as a sidecar text scan over the raw source — invoked only for
 * files under a Helm chart (indexer.ts's chart-root detection), never for
 * arbitrary YAML.
 *
 * Known bounded limitation: this is a token scan, not a full parser. A literal
 * `}}` inside a quoted argument, or an include/define-shaped string inside a
 * `{{/* comment *}}`, can misattribute a char range or produce a phantom call.
 * Both are bounded failure modes (a stray reference to a real symbol name, or a
 * slightly-long symbol range) — the same class of accepted limitation
 * `toleratedErrorScopes` documents for the tree-sitter grammars, not a silent gap.
 * The chart-wide `importedFiles` widening this module's output flows through
 * (indexer.ts) also lets a YAML alias resolve to an anchor in a sibling chart
 * file, even though YAML anchors are properly document-scoped; this only fires
 * when the alias has no matching anchor in its own file (i.e. only on input
 * that's already invalid YAML on its own terms), so it's bounded, but it's a
 * real, disclosed side effect of the chart-scoping mechanism, not something to
 * silently rely on.
 */
import { MAX_BODY_TEXT_CHARS } from "./parse.js";
import type { ParsedSymbolKind } from "./languages.js";

// Offsets below are JS string (UTF-16 code unit) indices, not UTF-8 byte
// offsets — named *Char, not *Byte, to say so honestly (issue #84). Callers
// that merge these into a ParsedSymbol/ParsedCall-shaped array (indexer.ts)
// carry them into that array's startByte/endByte/atByte fields unchanged in
// value; those shared fields are themselves char offsets in practice (also
// #84), so this is not a behavior change, only a locally-honest name.
export interface HelmSymbol {
  name: string;
  kind: ParsedSymbolKind;
  startChar: number;
  endChar: number;
  loc: number;
  bodyText: string;
}
export interface HelmCall {
  callee: string;
  atChar: number;
  endChar: number;
  member: boolean;
}
export interface HelmExtraction {
  symbols: HelmSymbol[];
  calls: HelmCall[];
}

// Matches one `{{ ... }}` action, including the `{{-`/`-}}` whitespace-trim
// markers. Non-greedy so a multi-action line matches each action separately.
const ACTION = /\{\{-?([\s\S]*?)-?\}\}/g;
const BLOCK_OPEN = new Set(["if", "range", "with", "define", "block"]);
const NAME_ARG = /^"([^"]*)"/;
// Matched against an action's RAW inner text (not just a leading keyword) so
// `{{ $labels := include "x" . }}` and `{{ if include "x" . }}` are caught,
// not only the standalone `{{ include "x" . }}` form.
const CALL_SITE = /\b(?:include|template)\s+"([^"]+)"/g;

export function extractHelmDirectives(source: string): HelmExtraction {
  const symbols: HelmSymbol[] = [];
  const calls: HelmCall[] = [];
  const stack: Array<{ name?: string; startChar: number }> = [];

  for (const m of source.matchAll(ACTION)) {
    const raw = m[1]!;
    // "{{" is 2 chars; a trim-marker "{{-" is 3 — this is the char offset of
    // `raw`'s first character within `source`, needed for call-site atChar math.
    const innerStart = m.index! + (source[m.index! + 2] === "-" ? 3 : 2);
    const endChar = m.index! + m[0].length;
    const body = raw.trim();
    const spaceIdx = body.search(/\s/);
    const keyword = spaceIdx === -1 ? body : body.slice(0, spaceIdx);

    if (keyword === "define") {
      const name = NAME_ARG.exec(body.slice(spaceIdx + 1).trim())?.[1];
      stack.push({ name, startChar: m.index! });
    } else if (BLOCK_OPEN.has(keyword)) {
      // if/range/with/block: depth marker only, no symbol on its own.
      stack.push({ startChar: m.index! });
    } else if (keyword === "end") {
      const open = stack.pop();
      if (open?.name) {
        symbols.push({
          name: open.name,
          kind: "variable",
          startChar: open.startChar,
          endChar,
          loc: source.slice(open.startChar, endChar).split("\n").length,
          bodyText: source.slice(open.startChar, endChar).slice(0, MAX_BODY_TEXT_CHARS),
        });
      }
    }

    for (const call of raw.matchAll(CALL_SITE)) {
      const atChar = innerStart + call.index!;
      calls.push({ callee: call[1]!, atChar, endChar: atChar + call[0].length, member: false });
    }
  }
  return { symbols, calls };
}
