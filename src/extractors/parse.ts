/**
 * Deterministic tree-sitter parsing (no LLM). Extracts, per file:
 *   - symbols: functions, methods, classes, interfaces, types, arrow-fn consts
 *   - imports: module specifiers (for dependency edges)
 *   - calls:   callee names + byte offset (mapped to the enclosing symbol)
 *
 * Uses NATIVE tree-sitter (synchronous, prebuilt for Node 20 — see decision in
 * the commit history; web-tree-sitter's WASM grammars had an incompatible ABI).
 *
 * Language-specific grammar/query/builtin-method data lives in languages.ts —
 * this file is a generic engine over whichever LanguageSpec matches a file.
 */
import type TreeSitterParser from "tree-sitter";
import type { SyntaxNode } from "tree-sitter";
import { languageFor, type LanguageSpec, type ParsedSymbolKind } from "./languages.js";
import { loadNativeTreeSitter } from "./nativeTreeSitter.js";

export type { ParsedSymbolKind } from "./languages.js";

const { Parser } = loadNativeTreeSitter();

export interface ParsedSymbol {
  name: string;
  kind: ParsedSymbolKind;
  startByte: number;
  endByte: number;
  loc: number;
  bodyText: string;
}
export interface ParsedCall {
  callee: string;
  atByte: number;
  endByte: number;
  /** true for `x.foo()` (property access), false for a direct `foo()` call. */
  member: boolean;
}
export interface ParsedFile {
  symbols: ParsedSymbol[];
  imports: string[];
  calls: ParsedCall[];
  parseable: boolean;
}

interface LangBundle {
  parser: TreeSitterParser;
  query: TreeSitterParser.Query;
}
const cache = new Map<string, LangBundle>();

function bundleFor(spec: LanguageSpec): LangBundle {
  let b = cache.get(spec.grammarKey);
  if (!b) {
    const parser = new Parser();
    const grammar = spec.loadGrammar();
    parser.setLanguage(grammar as never);
    const query = new Parser.Query(grammar as never, spec.query);
    b = { parser, query };
    cache.set(spec.grammarKey, b);
  }
  return b;
}

const STR_QUOTES = /^['"`]|['"`]$/g;

export function parseSource(file: string, source: string): ParsedFile | null {
  const spec = languageFor(file);
  if (!spec) return null;
  const { parser, query } = bundleFor(spec);
  // The native binding caps its scratch buffer at 32 KB unless bufferSize is
  // given — without this, any source >= 32768 bytes throws "Invalid argument"
  // and would abort the whole index run. Guard with try/catch as a backstop.
  let tree;
  try {
    tree = parser.parse(source, undefined, { bufferSize: Math.max(32 * 1024, source.length * 2 + 1024) });
  } catch {
    return null;
  }
  const symbols: ParsedSymbol[] = [];
  const imports: string[] = [];
  const calls: ParsedCall[] = [];

  // group captures by their enclosing @*.def via a quick pass: we record names
  // keyed by the def node, then emit a symbol per def.
  const pendingDefs = new Map<number, { kind: ParsedSymbolKind; def: SyntaxNode; name?: string }>();

  for (const cap of query.captures(tree.rootNode)) {
    const cname = cap.name;
    const node = cap.node;
    if (cname.endsWith(".def")) {
      // Keep the FIRST classification a node id receives: a query may have
      // several patterns matching the same node at different specificity
      // (e.g. a Python method inside a class body matches both a class-nested
      // "method.def" pattern and a general "fn.def" pattern — Task 4 relies on
      // this to classify methods correctly without special-casing Python here).
      if (!pendingDefs.has(node.id)) pendingDefs.set(node.id, { kind: spec.defKindOf[cname]!, def: node });
    } else if (spec.nameToDef[cname]) {
      // name capture: find its parent def node id by walking up to the def type
      const defNode = ascendToDef(node, spec.defNodeTypes);
      if (defNode) {
        const existing = pendingDefs.get(defNode.id);
        if (existing) existing.name = node.text;
        else pendingDefs.set(defNode.id, { kind: spec.defKindOf[spec.nameToDef[cname]!]!, def: defNode, name: node.text });
      }
    } else if (cname === "import.src") {
      imports.push(node.text.replace(STR_QUOTES, ""));
    } else if (cname === "call.id") {
      calls.push({ callee: node.text, atByte: node.startIndex, endByte: node.endIndex, member: false });
    } else if (cname === "call.member") {
      // skip builtin method names to avoid false edges to similarly-named symbols
      if (!spec.builtinMethods.has(node.text)) calls.push({ callee: node.text, atByte: node.startIndex, endByte: node.endIndex, member: true });
    }
  }

  for (const { kind, def, name } of pendingDefs.values()) {
    if (!name) continue;
    const loc = def.endPosition.row - def.startPosition.row + 1;
    symbols.push({
      name, kind,
      startByte: def.startIndex, endByte: def.endIndex, loc,
      bodyText: def.text.slice(0, 4000),
    });
  }
  symbols.sort((a, b) => a.startByte - b.startByte);
  return { symbols, imports, calls, parseable: !tree.rootNode.hasError };
}

/** Walk up to the nearest node whose type is a definition this language recognizes. */
function ascendToDef(node: SyntaxNode, defNodeTypes: Set<string>): SyntaxNode | null {
  let cur: SyntaxNode | null = node.parent;
  while (cur) {
    if (defNodeTypes.has(cur.type)) return cur;
    cur = cur.parent;
  }
  return null;
}

/** Map each call site to the innermost symbol whose byte-range contains it.
 *  Keyed by the symbol's `startByte` (a stable per-symbol identity within the
 *  file) rather than its name, so two same-named symbols in one file don't merge
 *  their call sets. The value maps callee name -> `memberOnly` (true iff every
 *  occurrence was a `x.foo()` member call, never a direct `foo()`), so the
 *  indexer can resolve member calls conservatively. */
export function attributeCalls(parsed: ParsedFile): Map<number, Map<string, boolean>> {
  const out = new Map<number, Map<string, boolean>>();
  for (const call of parsed.calls) {
    let best: ParsedSymbol | null = null;
    for (const s of parsed.symbols) {
      if (call.atByte >= s.startByte && call.atByte < s.endByte) {
        if (!best || s.endByte - s.startByte < best.endByte - best.startByte) best = s;
      }
    }
    if (best && best.name !== call.callee) {
      if (!out.has(best.startByte)) out.set(best.startByte, new Map());
      const m = out.get(best.startByte)!;
      const prev = m.get(call.callee);
      m.set(call.callee, prev === undefined ? call.member : prev && call.member);
    }
  }
  return out;
}
