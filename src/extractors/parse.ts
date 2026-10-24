/**
 * Deterministic tree-sitter parsing (no LLM). Extracts, per file:
 *   - symbols: functions, methods, classes, interfaces, types, arrow-fn consts
 *   - imports: module specifiers (for dependency edges)
 *   - calls:   callee names + byte offset (mapped to the enclosing symbol)
 *
 * Uses NATIVE tree-sitter (synchronous, prebuilt for Node 20 — see decision in
 * the commit history; web-tree-sitter's WASM grammars had an incompatible ABI).
@@CLEANROOM_HOLE_1@@
 */
import type TreeSitterParser from "tree-sitter";
import type { SyntaxNode } from "tree-sitter";
import type { Edge } from "../core/types.js";
@@CLEANROOM_HOLE_2@@
import { loadNativeTreeSitter } from "./nativeTreeSitter.js";

@@CLEANROOM_HOLE_3@@

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

@@CLEANROOM_HOLE_4@@
  if (!b) {
    const Parser = parserRuntime();
    const parser = new Parser();
@@CLEANROOM_HOLE_5@@
    const bindingQuery = spec.bindingQuery ? new Parser.Query(grammar as never, spec.bindingQuery) : null;
    b = { parser, query, bindingQuery };
@@CLEANROOM_HOLE_6@@
  }
  return b;
}

const STR_QUOTES = /^['"`]|['"`]$/g;
@@CLEANROOM_HOLE_7@@

export function parseSource(file: string, source: string, opts: { throwOnParseError?: boolean } = {}): ParsedFile | null {
@@CLEANROOM_HOLE_8@@
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
@@CLEANROOM_HOLE_9@@
      // name capture: find its parent def node id by walking up to the def type
@@CLEANROOM_HOLE_10@@
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
@@CLEANROOM_HOLE_11@@
    const loc = def.endPosition.row - def.startPosition.row + 1;
    symbols.push({
@@CLEANROOM_HOLE_12@@
      startByte: def.startIndex, endByte: def.endIndex, loc,
      bodyText: originalText(def).slice(0, MAX_BODY_TEXT_CHARS),
@@CLEANROOM_HOLE_13@@
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

@@CLEANROOM_HOLE_14@@
  let cur: SyntaxNode | null = node.parent;
  while (cur) {
@@CLEANROOM_HOLE_15@@
    cur = cur.parent;
  }
  return null;
}

/** Map each call site to the innermost symbol whose byte-range contains it.
@@CLEANROOM_HOLE_16@@
export function attributeCalls(parsed: ParsedFile): Map<number, Map<string, boolean>> {
  const out = new Map<number, Map<string, boolean>>();
  for (const call of parsed.calls) {
    let best: ParsedSymbol | null = null;
@@CLEANROOM_HOLE_17@@
      if (call.atByte >= s.startByte && call.atByte < s.endByte) {
@@CLEANROOM_HOLE_18@@
      }
    }
    if (best && best.name !== call.callee) {
@@CLEANROOM_HOLE_19@@
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
    let best: ParsedSymbol | null = null;
    let bestIndex = -1;
    for (let i = 0; i < parsed.symbols.length; i++) {
      const s = parsed.symbols[i]!;
      if (call.atByte >= s.startByte && call.atByte < s.endByte && (!best || s.endByte - s.startByte < best.endByte - best.startByte)) {
        best = s;
        bestIndex = i;
      }
    }
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
