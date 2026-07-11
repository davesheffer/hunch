/**
 * Deterministic tree-sitter parsing (no LLM). Extracts, per file:
 *   - symbols: functions, methods, classes, interfaces, types, arrow-fn consts
 *   - imports: module specifiers (for dependency edges)
 *   - calls:   callee names + byte offset (mapped to the enclosing symbol)
 *
 * Uses NATIVE tree-sitter (synchronous, prebuilt for Node 20 — see decision in
 * the commit history; web-tree-sitter's WASM grammars had an incompatible ABI).
 */
import type TreeSitterParser from "tree-sitter";
import type { SyntaxNode } from "tree-sitter";
import { loadNativeTreeSitter } from "./nativeTreeSitter.js";

const { Parser, typescript, tsx } = loadNativeTreeSitter();

export type ParsedSymbolKind = "function" | "method" | "class" | "interface" | "type";

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

/** Extremely common builtin/array/object/string/promise method names. Member
 *  calls to these (e.g. `arr.map(...)`) must NOT create call edges to unrelated
 *  repo symbols that happen to share the name (DESIGN: keep the graph clean). */
const BUILTIN_METHODS = new Set([
  "map", "filter", "forEach", "reduce", "find", "findIndex", "some", "every", "includes",
  "push", "pop", "shift", "unshift", "slice", "splice", "concat", "join", "split", "flat", "flatMap",
  "indexOf", "lastIndexOf", "keys", "values", "entries", "sort", "reverse", "fill", "at",
  "get", "set", "has", "add", "delete", "clear",
  "then", "catch", "finally", "all", "race", "resolve", "reject",
  "toString", "valueOf", "toJSON", "hasOwnProperty",
  "replace", "replaceAll", "trim", "trimStart", "trimEnd", "padStart", "padEnd", "startsWith", "endsWith",
  "toLowerCase", "toUpperCase", "charAt", "charCodeAt", "substring", "substr", "repeat", "match", "matchAll",
  "call", "apply", "bind", "test", "exec", "now", "parse", "stringify", "from", "of", "isArray", "assign",
  "log", "error", "warn", "info", "debug",
]);
export interface ParsedFile {
  symbols: ParsedSymbol[];
  imports: string[];
  calls: ParsedCall[];
  parseable: boolean;
}

/** Tree-sitter query capturing every construct we care about in one pass. */
const QUERY_SRC = `
  (function_declaration name: (identifier) @fn.name) @fn.def
  (generator_function_declaration name: (identifier) @fn.name) @fn.def
  (method_definition name: (property_identifier) @method.name) @method.def
  (class_declaration name: (type_identifier) @class.name) @class.def
  (interface_declaration name: (type_identifier) @iface.name) @iface.def
  (type_alias_declaration name: (type_identifier) @type.name) @type.def
  (variable_declarator
     name: (identifier) @arrow.name
     value: [(arrow_function) (function_expression)]) @arrow.def
  (import_statement source: (string) @import.src)
  (call_expression function: (identifier) @call.id)
  (call_expression function: (member_expression property: (property_identifier) @call.member))
`;

interface LangBundle {
  parser: TreeSitterParser;
  query: TreeSitterParser.Query;
}
const cache = new Map<string, LangBundle>();

function bundleFor(lang: unknown, key: string): LangBundle {
  let b = cache.get(key);
  if (!b) {
    const parser = new Parser();
    parser.setLanguage(lang as never);
    const query = new Parser.Query(lang, QUERY_SRC);
    b = { parser, query };
    cache.set(key, b);
  }
  return b;
}

function pickLanguage(file: string): { lang: unknown; key: string } | null {
  if (file.endsWith(".tsx") || file.endsWith(".jsx")) return { lang: tsx, key: "tsx" };
  if (file.endsWith(".ts") || file.endsWith(".mts") || file.endsWith(".cts")) return { lang: typescript, key: "ts" };
  if (file.endsWith(".js") || file.endsWith(".mjs") || file.endsWith(".cjs")) return { lang: typescript, key: "ts" };
  return null;
}

const STR_QUOTES = /^['"`]|['"`]$/g;

export function parseSource(file: string, source: string): ParsedFile | null {
  const picked = pickLanguage(file);
  if (!picked) return null;
  const { parser, query } = bundleFor(picked.lang, picked.key);
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

  const defKind: Record<string, ParsedSymbolKind> = {
    "fn.def": "function", "method.def": "method", "class.def": "class",
    "iface.def": "interface", "type.def": "type", "arrow.def": "function",
  };
  const nameToDef: Record<string, string> = {
    "fn.name": "fn.def", "method.name": "method.def", "class.name": "class.def",
    "iface.name": "iface.def", "type.name": "type.def", "arrow.name": "arrow.def",
  };

  for (const cap of query.captures(tree.rootNode)) {
    const cname = cap.name;
    const node = cap.node;
    if (cname.endsWith(".def")) {
      pendingDefs.set(node.id, { kind: defKind[cname]!, def: node });
    } else if (nameToDef[cname]) {
      // name capture: find its parent def node id by walking up to the def type
      const defNode = ascendToDef(node);
      if (defNode) {
        const existing = pendingDefs.get(defNode.id);
        if (existing) existing.name = node.text;
        else pendingDefs.set(defNode.id, { kind: defKind[nameToDef[cname]!]!, def: defNode, name: node.text });
      }
    } else if (cname === "import.src") {
      imports.push(node.text.replace(STR_QUOTES, ""));
    } else if (cname === "call.id") {
      calls.push({ callee: node.text, atByte: node.startIndex, endByte: node.endIndex, member: false });
    } else if (cname === "call.member") {
      // skip builtin method names to avoid false edges to similarly-named symbols
      if (!BUILTIN_METHODS.has(node.text)) calls.push({ callee: node.text, atByte: node.startIndex, endByte: node.endIndex, member: true });
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

/** Walk up to the nearest node whose type is a definition we recognize. */
function ascendToDef(node: SyntaxNode): SyntaxNode | null {
  const defTypes = new Set([
    "function_declaration", "generator_function_declaration", "method_definition",
    "class_declaration", "interface_declaration", "type_alias_declaration", "variable_declarator",
  ]);
  let cur: SyntaxNode | null = node.parent;
  while (cur) {
    if (defTypes.has(cur.type)) return cur;
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
