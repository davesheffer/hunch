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
import type { Edge } from "../core/types.js";
import { languageFor, type LanguageSpec, type ParsedSymbolKind } from "./languages.js";
import { loadNativeTreeSitter } from "./nativeTreeSitter.js";

export type { ParsedSymbolKind } from "./languages.js";

/** Resolved on first parse, not at import: loading the native addons copies six
 *  `.node` files into a temp dir and dlopens them (~1.5s+ cold), which every CLI
 *  command and every editor hook would otherwise pay just for importing this
 *  module. loadNativeTreeSitter() memoizes the runtime itself. */
const parserRuntime = (): typeof TreeSitterParser => loadNativeTreeSitter().Parser;

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
export interface ParsedRelation {
  target: string;
  atByte: number;
  endByte: number;
  edgeType: Edge["type"];
  label: string;
}
export interface ParsedFile {
  symbols: ParsedSymbol[];
  imports: string[];
  calls: ParsedCall[];
  relations: ParsedRelation[];
  namespace: string | null;
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
    const Parser = parserRuntime();
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
/** Cap on a stored symbol's bodyText — large enough for review context, small
 *  enough that a huge function/file doesn't bloat every JSON symbol record. */
export const MAX_BODY_TEXT_CHARS = 4000;

export function parseSource(file: string, source: string, opts: { throwOnParseError?: boolean } = {}): ParsedFile | null {
  const spec = languageFor(file);
  if (!spec) return null;
  // Templated text (Helm chart / Jinja CI config) isn't {spec.id} yet — a real
  // grammar correctly reports ERROR nodes for the delimiters. Still run the
  // parse below (a well-formed anchor elsewhere in the file still contributes
  // a real symbol, same as any other YAML file) — just don't let those
  // expected errors fail-close the whole-repo scan on content that was never
  // meant to stand alone (#33). Heavy top-level templating can break error
  // recovery badly enough that even the whole-file root node never forms
  // (root.type becomes "ERROR", not "stream") — the fallback-symbol synthesis
  // below covers that case so the file doesn't vanish from the component graph.
  // String.prototype.search ignores lastIndex (unlike RegExp.test with a /g or
  // /y flag), so a future templatingMarkers entry can't introduce cross-call
  // statefulness here even if it forgets to keep its pattern flag-free.
  const templated = (spec.alwaysTemplatedExtensions?.some((ext) => file.endsWith(ext)) ?? false)
    || (spec.templatingMarkers?.some((marker) => source.search(marker) !== -1) ?? false);
  const { parser, query } = bundleFor(spec);
  // The native binding caps its scratch buffer at 32 KB unless bufferSize is
  // given — without this, any source >= 32768 bytes throws "Invalid argument"
  // and would abort the whole index run. Guard with try/catch as a backstop.
  let tree;
  try {
    tree = parser.parse(source, undefined, { bufferSize: Math.max(32 * 1024, source.length * 2 + 1024) });
  } catch (error) {
    // Index scans need the underlying diagnostic for whole-language failures.
    // Other callers retain the historical best-effort null result.
    if (opts.throwOnParseError) throw error;
    return null;
  }
  let parseable = isParseable(tree.rootNode, spec);
  let usingRecoveredTree = false;
  if (!parseable && spec.parseErrorRecovery) {
    const recoveredSource = spec.parseErrorRecovery(source);
    // Offsets from the recovery tree are used against the original source below.
    // Refuse a misconfigured recovery rather than corrupt captured names/text.
    if (recoveredSource.length === source.length) {
      try {
        const recoveredTree = parser.parse(recoveredSource, undefined, { bufferSize: Math.max(32 * 1024, recoveredSource.length * 2 + 1024) });
        if (isParseable(recoveredTree.rootNode, spec)) {
          tree = recoveredTree;
          parseable = true;
          usingRecoveredTree = true;
        }
      } catch (error) {
        if (opts.throwOnParseError) throw error;
      }
    }
  }
  const symbols: ParsedSymbol[] = [];
  const imports: string[] = [];
  const calls: ParsedCall[] = [];
  const relations: ParsedRelation[] = [];
  let namespace: string | null = null;
  const originalText = (node: SyntaxNode): string => usingRecoveredTree
    ? source.slice(node.startIndex, node.endIndex)
    : node.text;

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
        if (existing) existing.name = originalText(node);
        else pendingDefs.set(defNode.id, { kind: spec.defKindOf[spec.nameToDef[cname]!]!, def: defNode, name: originalText(node) });
      }
      if (cname === "namespace.name") namespace = originalText(node);
    } else if (cname === "import.src") {
      imports.push(originalText(node).replace(STR_QUOTES, ""));
    } else if (cname === "call.id") {
      const text = originalText(node);
      if (!spec.builtinFunctions?.has(text)) {
        calls.push({ callee: text, atByte: node.startIndex, endByte: node.endIndex, member: false });
      }
    } else if (cname === "call.member") {
      // skip builtin method names to avoid false edges to similarly-named symbols
      const text = originalText(node);
      if (!spec.builtinMethods.has(text)) calls.push({ callee: text, atByte: node.startIndex, endByte: node.endIndex, member: true });
    } else if (spec.relationKindOf?.[cname]) {
      const relation = spec.relationKindOf[cname]!;
      relations.push({
        target: originalText(node),
        atByte: node.startIndex,
        endByte: node.endIndex,
        edgeType: relation.edgeType,
        label: relation.label,
      });
    }
  }

  for (const { kind, def, name } of pendingDefs.values()) {
    const resolvedName = name ?? spec.fallbackDefName?.(file);
    if (!resolvedName) continue;
    const loc = def.endPosition.row - def.startPosition.row + 1;
    symbols.push({
      name: resolvedName, kind,
      startByte: def.startIndex, endByte: def.endIndex, loc,
      bodyText: originalText(def).slice(0, MAX_BODY_TEXT_CHARS),
    });
  }
  // Every other successfully-parsed YAML file gets at least a file-root symbol
  // (fallbackDefName). If templating broke error recovery badly enough that
  // the doc.def capture never fired, synthesize the same fallback here rather
  // than let the file silently drop out of the component graph. Push it before
  // the sort below — parse()'s callers (indexer.ts) rely on symbols staying in
  // start-byte order.
  if (templated && spec.fallbackDefName && !symbols.some((s) => s.kind === "file")) {
    symbols.push({
      name: spec.fallbackDefName(file),
      kind: "file",
      startByte: 0,
      endByte: source.length,
      loc: source.split("\n").length,
      bodyText: source.slice(0, MAX_BODY_TEXT_CHARS),
    });
  }
  symbols.sort((a, b) => a.startByte - b.startByte);
  return { symbols, imports, calls, relations, namespace, parseable: templated || parseable };
}

/** True when every ERROR/MISSING node in the tree sits in an ancestor shape this
 *  language declares as a known grammar limitation (LanguageSpec.toleratedErrorScopes).
 *
 *  This matters because `conform` is fail-CLOSED on scan completeness: one file
 *  reporting parseable:false rejects the WHOLE architectural-conformance scan, so a
 *  grammar false positive takes down the gate for the entire repo. Scoping the
 *  tolerance to a declared ancestor pair — rather than downgrading unparseable files
 *  to a warning — keeps the completeness guarantee intact for real syntax errors.
 *
 *  A tolerated ERROR's children are not visited: tree-sitter reports the same span
 *  again as a nested ERROR child, and the raw text inside a template literal cannot
 *  contain an independent error to hide. */
function isParseable(root: SyntaxNode, spec: LanguageSpec): boolean {
  if (!root.hasError) return true; // covers ERROR and MISSING; no walk needed
  const scopes = spec.toleratedErrorScopes ?? [];
  if (scopes.length === 0) return false;
  let ok = true;
  const visit = (node: SyntaxNode): void => {
    if (!ok) return;
    if (node.type === "ERROR" || node.isMissing) {
      if (!inToleratedScope(node, scopes)) ok = false;
      return;
    }
    for (let i = 0; i < node.childCount; i++) visit(node.child(i)!);
  };
  visit(root);
  return ok;
}

function inToleratedScope(node: SyntaxNode, scopes: NonNullable<LanguageSpec["toleratedErrorScopes"]>): boolean {
  for (let ancestor: SyntaxNode | null = node; ancestor; ancestor = ancestor.parent) {
    for (const scope of scopes) {
      if (ancestor.type === scope.node
        && ancestor.parent?.type === scope.parentIs
        && (!scope.textPattern || ancestor.text.search(scope.textPattern) !== -1)) return true;
    }
  }
  return false;
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
 *  Keyed by the symbol's position (index) in `parsed.symbols` — NOT its
 *  startByte, which is not a reliable per-symbol identity: a language whose
 *  extractor merges a synthetic whole-file symbol with independently-derived
 *  symbols (e.g. YAML's fallback-root synthetic symbol alongside Helm's
 *  regex-derived `define` blocks) can produce two distinct symbols that both
 *  start at byte 0. Indexing by array position is unique by construction,
 *  regardless of byte overlap — the caller must consume the exact same
 *  `parsed.symbols` array (or an equivalently-ordered copy) to look up a
 *  symbol by the index this function returns. The value maps callee name ->
 *  `memberOnly` (true iff every occurrence was a `x.foo()` member call, never
 *  a direct `foo()`), so the indexer can resolve member calls conservatively. */
export function attributeCalls(parsed: ParsedFile): Map<number, Map<string, boolean>> {
  const out = new Map<number, Map<string, boolean>>();
  for (const call of parsed.calls) {
    let best: ParsedSymbol | null = null;
    let bestIndex = -1;
    for (let i = 0; i < parsed.symbols.length; i++) {
      const s = parsed.symbols[i]!;
      if (call.atByte >= s.startByte && call.atByte < s.endByte) {
        if (!best || s.endByte - s.startByte < best.endByte - best.startByte) {
          best = s;
          bestIndex = i;
        }
      }
    }
    if (best && best.name !== call.callee) {
      if (!out.has(bestIndex)) out.set(bestIndex, new Map());
      const m = out.get(bestIndex)!;
      const prev = m.get(call.callee);
      m.set(call.callee, prev === undefined ? call.member : prev && call.member);
    }
  }
  return out;
}

/** Map static semantic relationships (extends/implements/trait use) to the
 * innermost enclosing declaration using the same stable symbol-index identity
 * as call attribution. */
export function attributeRelations(parsed: ParsedFile): Map<number, ParsedRelation[]> {
  const out = new Map<number, ParsedRelation[]>();
  for (const relation of parsed.relations) {
    let best: ParsedSymbol | null = null;
    let bestIndex = -1;
    for (let index = 0; index < parsed.symbols.length; index++) {
      const symbol = parsed.symbols[index]!;
      if (relation.atByte >= symbol.startByte && relation.atByte < symbol.endByte
        && (!best || symbol.endByte - symbol.startByte < best.endByte - best.startByte)) {
        best = symbol;
        bestIndex = index;
      }
    }
    if (bestIndex < 0) continue;
    const list = out.get(bestIndex) ?? [];
    list.push(relation);
    out.set(bestIndex, list);
  }
  return out;
}
