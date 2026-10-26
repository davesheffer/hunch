/**
 * Deterministic tree-sitter parsing (no LLM). Extracts, per file:
 *   - symbols: functions, methods, classes, interfaces, types, arrow-fn consts
 *   - imports: module specifiers (for dependency edges)
 *   - calls:   callee names + byte offset (mapped to the enclosing symbol)
 *
 * Uses NATIVE tree-sitter (synchronous, prebuilt for Node 20 — see decision in
 * the commit history; web-tree-sitter's WASM grammars had an incompatible ABI).
 *
 * Language-specific grammar, query and builtin data lives in languages.ts; this
 * file is a generic engine over whichever LanguageSpec matches a file.
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
  /** For a member call on a plain identifier (`x.foo()`), that identifier. */
  qualifier?: string;
}
/** A local name bound by an import: a module object (`imported` null — `import *
 *  as ns`, `require()`, Go package alias) or one aliased member of a module. */
export interface ParsedBinding {
  local: string;
  module: string;
  imported: string | null;
}
/** A call whose target is pinned to one imported module (`ns.fn()`, aliased `g()`). */
export interface QualifiedCall {
  callee: string;
  module: string;
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
  bindings: ParsedBinding[];
  namespace: string | null;
  parseable: boolean;
}

interface LangBundle {
  parser: TreeSitterParser;
  query: TreeSitterParser.Query;
  bindingQuery: TreeSitterParser.Query | null;
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
    const bindingQuery = spec.bindingQuery ? new Parser.Query(grammar as never, spec.bindingQuery) : null;
    b = { parser, query, bindingQuery };
    cache.set(spec.grammarKey, b);
  }
  return b;
}

/** Per-spec templating markers with g/y stripped, so `.test()` is stateless.
 *  Built once per language spec rather than on every parseSource call. */
const statelessMarkers = new WeakMap<LanguageSpec, readonly RegExp[]>();
function templatingMarkersFor(spec: LanguageSpec): readonly RegExp[] {
  let markers = statelessMarkers.get(spec);
  if (!markers) {
    markers = (spec.templatingMarkers ?? []).map((re) => new RegExp(re.source, re.flags.replace(/[gy]/g, "")));
    statelessMarkers.set(spec, markers);
  }
  return markers;
}

const STR_QUOTES = /^['"`]|['"`]$/g;
/** Cap on stored symbol body text: enough context for review without bloating JSON records. */
export const MAX_BODY_TEXT_CHARS = 4000;

export function parseSource(file: string, source: string, opts: { throwOnParseError?: boolean } = {}): ParsedFile | null {
  const spec = languageFor(file);
  if (!spec) return null;
  // Templated text is not valid language text until rendered. Still parse, so real
  // anchors/symbols are extracted, but do not let the expected errors mark the file
  // unparseable. Severe templating may stop even the root document node from
  // forming; the fallback whole-file symbol below covers that case.
  const templated = (spec.alwaysTemplatedExtensions ?? []).some((ext) => file.endsWith(ext))
    || templatingMarkersFor(spec).some((re) => re.test(source));
  const { parser, query, bindingQuery } = bundleFor(spec);
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
  const bindings: ParsedBinding[] = [];
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
      // First classification wins: a node matched by several patterns keeps the
      // kind it received first (Python nested methods, Go struct/interface specs).
      if (!pendingDefs.has(node.id)) pendingDefs.set(node.id, { kind: spec.defKindOf[cname]!, def: node });
    } else if (Object.hasOwn(spec.nameToDef, cname)) {
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
      if (!spec.builtinMethods.has(text)) {
        const object = node.parent?.childForFieldName("object") ?? node.parent?.childForFieldName("operand");
        const qualifier = object?.type === "identifier" ? originalText(object) : undefined;
        calls.push({ callee: text, atByte: node.startIndex, endByte: node.endIndex, member: true, qualifier });
      }
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

  for (const match of bindingQuery?.matches(tree.rootNode) ?? []) {
    const text = (capture: string): string | null => {
      const node = match.captures.find((c) => c.name === capture)?.node;
      return node ? originalText(node) : null;
    };
    const src = text("bind.src")?.replace(STR_QUOTES, "");
    if (!src) continue;
    const imported = text("bind.name");
    if (imported) {
      const local = text("bind.local") ?? imported;
      // `from X import Y [as Z]`: Y may be a submodule or a member; record both
      // readings — only the one that resolves to a tracked file/symbol yields an edge.
      if (spec.joinSubmodule) bindings.push({ local, module: spec.joinSubmodule(src, imported), imported: null });
      bindings.push({ local, module: src, imported });
    } else {
      const local = text("bind.local") ?? spec.defaultBindingLocal?.(src) ?? null;
      if (local) bindings.push({ local, module: src, imported: null });
    }
  }

  for (const { kind, def, name } of pendingDefs.values()) {
    const symbolName = name ?? spec.fallbackDefName?.(file);
    if (!symbolName) continue;
    const loc = def.endPosition.row - def.startPosition.row + 1;
    symbols.push({
      name: symbolName, kind,
      startByte: def.startIndex, endByte: def.endIndex, loc,
      bodyText: originalText(def).slice(0, MAX_BODY_TEXT_CHARS),
    });
  }
  // Severe templating can stop the root node from forming; synthesize the whole-file symbol.
  if (templated && spec.fallbackDefName && !symbols.some((s) => s.kind === "file")) {
    symbols.push({
      name: spec.fallbackDefName(file), kind: "file",
      startByte: 0, endByte: source.length, loc: source.split("\n").length,
      bodyText: source.slice(0, MAX_BODY_TEXT_CHARS),
    });
  }
  symbols.sort((a, b) => a.startByte - b.startByte);
  return { symbols, imports, calls, relations, bindings, namespace, parseable: templated || parseable };
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

/** Nearest ancestor of `node` whose type is a definition type, or null. */
function ascendToDef(node: SyntaxNode, defNodeTypes: Set<string>): SyntaxNode | null {
  let cur: SyntaxNode | null = node.parent;
  while (cur) {
    if (defNodeTypes.has(cur.type)) return cur;
    cur = cur.parent;
  }
  return null;
}

/** Index in `symbols` of the narrowest symbol whose [startByte, endByte) range
 *  holds `at`; on equal spans the earlier symbol wins. -1 when nothing encloses it. */
function innermostSymbolAt(symbols: ParsedSymbol[], at: number): number {
  let found = -1;
  let narrowest = Infinity;
  symbols.forEach((sym, i) => {
    if (at < sym.startByte || at >= sym.endByte) return;
    const span = sym.endByte - sym.startByte;
    if (span < narrowest) { narrowest = span; found = i; }
  });
  return found;
}

/** Map each call site to the innermost symbol whose byte-range contains it.
 *  The result is keyed by the symbol's INDEX in `parsed.symbols`, not its start
 *  byte: two distinct symbols can share a start byte (a synthetic whole-file root
 *  beside others starting at byte 0), so callers must look symbols up in the same
 *  array order. Each value maps callee name -> memberOnly, true iff every
 *  occurrence of that callee inside the symbol was a member call, so the indexer
 *  can resolve member calls conservatively. */
export function attributeCalls(parsed: ParsedFile): Map<number, Map<string, boolean>> {
  const out = new Map<number, Map<string, boolean>>();
  for (const call of parsed.calls) {
    const bestIndex = innermostSymbolAt(parsed.symbols, call.atByte);
    const best = bestIndex >= 0 ? parsed.symbols[bestIndex] : undefined;
    if (best && best.name !== call.callee) {
      let m = out.get(bestIndex);
      if (!m) { m = new Map(); out.set(bestIndex, m); }
      const prev = m.get(call.callee);
      m.set(call.callee, prev === undefined ? call.member : prev && call.member);
    }
  }
  return out;
}

/** Map each call bound to an imported module — `ns.fn()` through a module-object
 *  binding, or `g()` through an aliased member import — to the innermost symbol
 *  containing it (same index identity as attributeCalls). A local bound to two
 *  different modules is ambiguous and dropped: never guess a binding. */
export function attributeQualifiedCalls(parsed: ParsedFile): Map<number, QualifiedCall[]> {
  const unique = (entries: Array<[string, QualifiedCall]>): Map<string, QualifiedCall | null> => {
    const out = new Map<string, QualifiedCall | null>();
    for (const [local, target] of entries) {
      const prev = out.get(local);
      out.set(local, prev === undefined || (prev && prev.module === target.module && prev.callee === target.callee) ? target : null);
    }
    return out;
  };
  const modules = unique(parsed.bindings.filter((b) => b.imported === null).map((b) => [b.local, { callee: "", module: b.module }]));
  const aliases = unique(parsed.bindings.filter((b) => b.imported !== null).map((b) => [b.local, { callee: b.imported!, module: b.module }]));
  const out = new Map<number, QualifiedCall[]>();
  if (modules.size === 0 && aliases.size === 0) return out;
  for (const call of parsed.calls) {
    let target: QualifiedCall | null = null;
    if (call.member && call.qualifier) {
      const binding = modules.get(call.qualifier);
      if (binding) target = { callee: call.callee, module: binding.module };
    } else if (!call.member) {
      target = aliases.get(call.callee) ?? null;
    }
    if (!target) continue;
    const bestIndex = innermostSymbolAt(parsed.symbols, call.atByte);
    if (bestIndex < 0) continue;
    const list = out.get(bestIndex) ?? [];
    if (!list.some((t) => t.callee === target!.callee && t.module === target!.module)) list.push(target);
    out.set(bestIndex, list);
  }
  return out;
}

/** Map static semantic relationships (extends/implements/trait use) to the
 * innermost enclosing declaration using the same stable symbol-index identity
 * as call attribution. */
export function attributeRelations(parsed: ParsedFile): Map<number, ParsedRelation[]> {
  const out = new Map<number, ParsedRelation[]>();
  for (const relation of parsed.relations) {
    const bestIndex = innermostSymbolAt(parsed.symbols, relation.atByte);
    if (bestIndex < 0) continue;
    const list = out.get(bestIndex) ?? [];
    list.push(relation);
    out.set(bestIndex, list);
  }
  return out;
}
