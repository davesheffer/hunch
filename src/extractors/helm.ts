import type { ParsedSymbolKind } from "./languages.js";
import { MAX_BODY_TEXT_CHARS } from "./parse.js";

/**
 * Deterministic token scan over Helm chart template text. Reports `define`
 * blocks as symbols and `include` / `template` references as calls. This is
 * not a Go-template parser: comments and quoting are deliberately ignored.
 * All offsets are JS string (UTF-16) indices into the source.
 */

export interface HelmSymbol {
  name: string;
  kind: ParsedSymbolKind;
  /** Index of the first `{` of the opening define action (inclusive). */
  startChar: number;
  /** Index just past the `}}` of the matching end action (exclusive). */
  endChar: number;
  loc: number;
  bodyText: string;
}

export interface HelmCall {
  callee: string;
  /** Index of the first letter of the `include` / `template` keyword. */
  atChar: number;
  /** Index just past the closing quote of the name (exclusive). */
  endChar: number;
  member: boolean;
}

export interface HelmExtraction {
  symbols: HelmSymbol[];
  calls: HelmCall[];
}

/** An open block; `name` is set only for a named `define`. */
interface Frame {
  start: number;
  name: string | null;
}

const OPENERS = new Set(["if", "range", "with", "block"]);
const CALL_RE = /(?<![A-Za-z0-9_])(?:include|template)\s+"([^"]+)"/g;

export function extractHelmDirectives(source: string): HelmExtraction {
  const symbols: HelmSymbol[] = [];
  const calls: HelmCall[] = [];
  const stack: Frame[] = [];

  let pos = 0;
  while (pos < source.length) {
    const open = source.indexOf("{{", pos);
    if (open === -1) break;
    const close = source.indexOf("}}", open + 2);
    if (close === -1) break;

    const innerStart = source[open + 2] === "-" ? open + 3 : open + 2;
    const innerEnd = close - 1 >= innerStart && source[close - 1] === "-" ? close - 1 : close;
    const inner = innerEnd > innerStart ? source.slice(innerStart, innerEnd) : "";
    const actionEnd = close + 2;
    pos = actionEnd;

    // Calls: any action, any keyword.
    CALL_RE.lastIndex = 0;
    for (let m = CALL_RE.exec(inner); m; m = CALL_RE.exec(inner)) {
      const atChar = innerStart + m.index;
      calls.push({ callee: m[1]!, atChar, endChar: atChar + m[0].length, member: false });
    }

    const trimmed = inner.trim();
    const ws = trimmed.search(/\s/);
    const keyword = ws === -1 ? trimmed : trimmed.slice(0, ws);

    if (keyword === "define") {
      const rest = trimmed.slice(keyword.length).trimStart();
      let name: string | null = null;
      if (rest.startsWith('"')) {
        const q = rest.indexOf('"', 1);
        const candidate = q === -1 ? "" : rest.slice(1, q);
        if (candidate.length > 0) name = candidate;
      }
      stack.push({ start: open, name });
    } else if (OPENERS.has(keyword)) {
      stack.push({ start: open, name: null });
    } else if (keyword === "end") {
      const frame = stack.pop();
      if (frame && frame.name !== null) {
        const span = source.slice(frame.start, actionEnd);
        symbols.push({
          name: frame.name,
          kind: "variable",
          startChar: frame.start,
          endChar: actionEnd,
          loc: span.split("\n").length,
          bodyText: span.slice(0, MAX_BODY_TEXT_CHARS),
        });
      }
    }
  }

  return { symbols, calls };
}
