/**
 * Elixir module resolution for the indexer (static, no `mix xref`).
 *
 * Elixir has no file-level import specifiers: a module is named by its
 * `defmodule` and reached through `alias` / `import` / `require` / `use`
 * directives or a fully-qualified remote call (`App.Orders.apply/1`). This file
 * turns one parsed file into module scopes (which module owns each symbol, with
 * nested modules expanded to their full name) and lexical alias/import scopes
 * (per module or function body, effective from the directive onward), then
 * expands module references where they are written. Resolution is
 * conservative: `__MODULE__` outside any module, a variable qualifier, or a
 * reference to a module the repo does not define all resolve to nothing.
 */
import type { ParsedFile, ParsedSymbol } from "./parse.js";

export type ElixirDirectiveKind = "alias" | "import" | "require" | "use";

export interface ElixirDirective {
  kind: ElixirDirectiveKind;
  /** Each module the directive names. `local` is the alias it binds (alias, or
   *  `require ..., as:`), null when it binds none. */
  modules: Array<{ ref: string; local: string | null }>;
}

const DIRECTIVE_HEAD = /^(alias|import|require|use)\b\s*\(?\s*/u;
const MODULE_REF = /^((?:__MODULE__|[A-Z]\w*)(?:\.[A-Z]\w*)*)/u;
const MODULE_PART = /^[A-Z]\w*(?:\.[A-Z]\w*)*$/u;

/** Parse a directive's source text. Non-module targets (Erlang `:ets`,
 *  `unquote(mod)`) yield a directive with no modules; text that is not a
 *  directive at all yields null. */
export function parseElixirDirective(text: string): ElixirDirective | null {
  const clean = text.replace(/#[^\n]*/gu, "");
  const head = DIRECTIVE_HEAD.exec(clean.trimStart());
  if (!head) return null;
  const kind = head[1] as ElixirDirectiveKind;
  const rest = clean.trimStart().slice(head[0].length);
  const mod = MODULE_REF.exec(rest);
  if (!mod) return { kind, modules: [] };
  const base = stripElixirPrefix(mod[1]!);
  const after = rest.slice(mod[0].length).trimStart();
  const binds = kind === "alias" || kind === "require";
  if (after.startsWith(".{")) {
    const close = after.indexOf("}");
    if (close < 0) return { kind, modules: [] };
    const parts = after.slice(2, close).split(",").map((part) => part.trim()).filter(Boolean);
    if (!parts.every((part) => MODULE_PART.test(part))) return { kind, modules: [] };
    return {
      kind,
      // `alias A.{B.C}` binds the LAST segment, `C`, like a plain alias; `require`
      // binds nothing without `as:`, which a multi-form cannot carry.
      modules: parts.map((part) => ({ ref: `${base}.${part}`, local: kind === "alias" ? lastSegment(part) : null })),
    };
  }
  const as = /^,\s*(?:[\s\S]*?\b)?as:\s*([A-Z]\w*)\b/u.exec(after);
  const local = as && binds ? as[1]! : kind === "alias" ? lastSegment(base) : null;
  return { kind, modules: [{ ref: base, local }] };
}

function stripElixirPrefix(ref: string): string {
  return ref.startsWith("Elixir.") ? ref.slice("Elixir.".length) : ref;
}

function lastSegment(ref: string): string {
  return ref.slice(ref.lastIndexOf(".") + 1);
}

/** `import Mod, only: [f: 1]` / `except: [g: 2]` name filters (arity ignored). */
export interface ElixirImport {
  module: string;
  /** Names `only:` admits; null when every name is admitted. */
  only: Set<string> | null;
  except: Set<string>;
}

const IMPORT_ONLY = /\bonly:\s*\[([^\]]*)\]/u;
const IMPORT_EXCEPT = /\bexcept:\s*\[([^\]]*)\]/u;
// Keyword form `name: 1` or tuple form `{:name, 1}`; both are legal filters.
const KEYWORD_NAME = /(?:([a-z_]\w*[?!]?)\s*:\s*\d+|\{\s*:([a-z_]\w*[?!]?)\s*,\s*\d+\s*\})/gu;

/** Name filters of an `import` directive's text. `only: :functions` and other
 *  non-list forms admit every name. */
export function parseElixirImportFilter(text: string): { only: Set<string> | null; except: Set<string> } {
  const clean = text.replace(/#[^\n]*/gu, "");
  const names = (list: string | undefined): Set<string> =>
    new Set([...(list ?? "").matchAll(KEYWORD_NAME)].map((match) => (match[1] ?? match[2])!));
  const only = IMPORT_ONLY.exec(clean);
  return { only: only ? names(only[1]) : null, except: names(IMPORT_EXCEPT.exec(clean)?.[1]) };
}

/** One lexical scope: a module or function body, or the file's top level. Each
 *  binding keeps its directive's offset, because an Elixir alias or import
 *  takes effect from the directive onward, never before it. */
interface ElixirScope {
  aliases: Array<{ at: number; local: string; fqn: string }>;
  imports: Array<ElixirImport & { at: number }>;
}

/** Remote call `Mod.fun()` with its module already expanded at the call site. */
export interface ElixirRemoteCall {
  callee: string;
  module: string;
}

/** Module scopes and aliases of one parsed Elixir file. Indices are positions in
 *  `parsed.symbols`. */
export interface ElixirFileAnalysis {
  symbols: ParsedSymbol[];
  /** Full module name per module/protocol symbol index; null for a `defimpl`
   *  (its functions live in a derived module this resolver does not name). */
  moduleFqn: Map<number, string | null>;
  /** Index of each symbol's owning module (itself for a module), or -1. */
  owner: number[];
  /** Nearest strictly-enclosing module per symbol index, or -1. */
  parentModule: number[];
  /** Lexical scopes keyed by the symbol whose body holds the directive (module
   *  or function); -1 is the file top level. A site sees its own scope, then its
   *  enclosing modules' scopes, so a directive in module A never reaches module
   *  B in the same file, and only directives that precede the site count. */
  scopes: Map<number, ElixirScope>;
  /** Full names named by any directive, for depends_on edges. */
  referencedModules: string[];
  /** Full names each directive named, keyed by the directive's start offset. */
  directiveTargets: Map<number, string[]>;
  /** Remote calls per innermost enclosing symbol index; a qualifier that does
   *  not expand to a module name (a variable, `__MODULE__` outside a module) is
   *  dropped. */
  remoteCalls: Map<number, ElixirRemoteCall[]>;
}

const IMPL_TEXT = /^defimpl\b/u;

function isModuleSymbol(symbol: ParsedSymbol): boolean {
  return symbol.kind === "class" || symbol.kind === "interface";
}

export function analyzeElixirFile(parsed: ParsedFile): ElixirFileAnalysis {
  const { symbols } = parsed;
  const moduleFqn = new Map<number, string | null>();
  // Nearest strictly-enclosing module for every symbol (symbols are sorted by
  // start byte, so an enclosing module always precedes what it holds).
  const parentModule = symbols.map((symbol, index) => {
    let best = -1;
    for (let i = 0; i < index; i++) {
      const candidate = symbols[i]!;
      if (!isModuleSymbol(candidate)) continue;
      if (candidate.startByte <= symbol.startByte && symbol.endByte <= candidate.endByte
        && (candidate.startByte !== symbol.startByte || candidate.endByte !== symbol.endByte)) best = i;
    }
    return best;
  });
  const owner = symbols.map((symbol, index) => (isModuleSymbol(symbol) ? index : parentModule[index]!));
  const analysis: ElixirFileAnalysis = {
    symbols, moduleFqn, owner, parentModule,
    scopes: new Map(), referencedModules: [], directiveTargets: new Map(), remoteCalls: new Map(),
  };
  const scopeOf = (key: number): ElixirScope => {
    let scope = analysis.scopes.get(key);
    if (!scope) analysis.scopes.set(key, scope = { aliases: [], imports: [] });
    return scope;
  };

  symbols.forEach((symbol, index) => {
    if (!isModuleSymbol(symbol)) return;
    if (IMPL_TEXT.test(symbol.bodyText)) {
      moduleFqn.set(index, null);
      return;
    }
    const parent = parentModule[index]!;
    const parentFqn = parent >= 0 ? moduleFqn.get(parent) ?? null : null;
    if (parent >= 0 && parentFqn === null) {
      // A module nested in a defimpl: its real name is unknowable here.
      moduleFqn.set(index, null);
      return;
    }
    const written = stripElixirPrefix(symbol.name);
    if (written.startsWith("__MODULE__.")) {
      // `defmodule __MODULE__.Sub` names Outer.Sub outright: no nesting prefix
      // beyond the expansion and no implicit alias. At top level `__MODULE__`
      // is nil, so the name is unknowable.
      moduleFqn.set(index, parentFqn ? `${parentFqn}${written.slice("__MODULE__".length)}` : null);
      return;
    }
    moduleFqn.set(index, parentFqn ? `${parentFqn}.${written}` : written);
    // `defmodule Outer do defmodule Inner` aliases Inner -> Outer.Inner (first
    // segment) in Outer's scope, from the nested module onward.
    if (parentFqn) {
      const first = written.split(".")[0]!;
      scopeOf(parent).aliases.push({ at: symbol.startByte, local: first, fqn: `${parentFqn}.${first}` });
    }
  });

  // Directives in source order, each expanded against only the bindings before
  // it (`alias App.Orders` then `alias Orders.Line` names App.Orders.Line).
  const directives = parsed.relations
    .filter((relation) => relation.label === "alias" || relation.label === "import"
      || relation.label === "require" || relation.label === "use")
    .sort((a, b) => a.atByte - b.atByte);
  const referencedModules = new Set<string>();
  for (const relation of directives) {
    const directive = parseElixirDirective(relation.target);
    if (!directive) continue;
    const scope = scopeOf(innermostAt(analysis, relation.atByte));
    const targets: string[] = [];
    analysis.directiveTargets.set(relation.atByte, targets);
    for (const { ref, local } of directive.modules) {
      const fqn = elixirExpandAt(analysis, relation.atByte, ref);
      if (!fqn) continue;
      targets.push(fqn);
      referencedModules.add(fqn);
      if (directive.kind === "import") scope.imports.push({ at: relation.atByte, module: fqn, ...parseElixirImportFilter(relation.target) });
      if (local) scope.aliases.push({ at: relation.atByte, local, fqn });
    }
  }
  analysis.referencedModules = [...referencedModules];

  // Member calls reach builtinMemberCalls with their qualifier (the spec's
  // memberCallsViaBindingsOnly); expand each where it is written.
  for (const call of parsed.builtinMemberCalls ?? []) {
    if (!call.qualifier) continue;
    const index = innermostAt(analysis, call.atByte);
    if (index < 0) continue;
    const module = elixirExpandAt(analysis, call.atByte, call.qualifier);
    if (!module) continue;
    const list = analysis.remoteCalls.get(index) ?? [];
    if (!list.some((known) => known.callee === call.callee && known.module === module)) list.push({ callee: call.callee, module });
    analysis.remoteCalls.set(index, list);
  }
  return analysis;
}

/** Index of the narrowest symbol whose range holds `at` (equal spans: the
 *  earlier one), or -1. */
function innermostAt(analysis: ElixirFileAnalysis, at: number): number {
  let found = -1;
  analysis.symbols.forEach((symbol, index) => {
    if (symbol.startByte > at || at >= symbol.endByte) return;
    const best = found >= 0 ? analysis.symbols[found]! : null;
    if (!best || symbol.endByte - symbol.startByte < best.endByte - best.startByte) found = index;
  });
  return found;
}

/** Scope keys from `key` outwards through enclosing modules to the top level. */
function scopeChain(analysis: ElixirFileAnalysis, key: number): number[] {
  const chain: number[] = [];
  for (let cur = key; cur >= 0; cur = analysis.parentModule[cur] ?? -1) chain.push(cur);
  chain.push(-1);
  return chain;
}

/** The aliases in force at byte offset `at`: in each scope from the innermost
 *  outwards, the latest binding before `at` (an inner scope's binding wins). */
export function elixirAliasesAt(analysis: ElixirFileAnalysis, at: number): ReadonlyMap<string, string> {
  const merged = new Map<string, string>();
  for (const key of scopeChain(analysis, innermostAt(analysis, at))) {
    // Latest binding before the site wins. Bindings are not stored in byte
    // order (a nested defmodule's implicit alias is recorded before the
    // directives), so compare offsets rather than trusting push order.
    const own = new Map<string, { at: number; fqn: string }>();
    for (const binding of analysis.scopes.get(key)?.aliases ?? []) {
      if (binding.at >= at) continue;
      const prior = own.get(binding.local);
      if (!prior || binding.at >= prior.at) own.set(binding.local, { at: binding.at, fqn: binding.fqn });
    }
    for (const [local, { fqn }] of own) if (!merged.has(local)) merged.set(local, fqn);
  }
  return merged;
}

/** The imports in force inside symbol `index`: those of its scope chain that
 *  precede the symbol's end (a module-level import after a function does not
 *  reach it). */
export function elixirImportsIn(analysis: ElixirFileAnalysis, index: number): ElixirImport[] {
  const end = analysis.symbols[index]?.endByte ?? 0;
  return scopeChain(analysis, index)
    .flatMap((key) => analysis.scopes.get(key)?.imports ?? [])
    .filter((entry) => entry.at < end);
}

/** Full name of the innermost nameable module holding byte offset `at`, or null. */
function contextAt(analysis: ElixirFileAnalysis, at: number): string | null {
  let cur = innermostAt(analysis, at);
  if (cur >= 0 && !isModuleSymbol(analysis.symbols[cur]!)) cur = analysis.parentModule[cur] ?? -1;
  return cur >= 0 ? analysis.moduleFqn.get(cur) ?? null : null;
}

/** Expand module reference `ref` as written at byte offset `at`. */
export function elixirExpandAt(analysis: ElixirFileAnalysis, at: number, ref: string): string | null {
  return expandElixirModule(ref, elixirAliasesAt(analysis, at), contextAt(analysis, at));
}

/** Expand a module reference as written at a site inside module `context` (its
 *  full name, or null outside any nameable module). Returns null when the
 *  reference cannot be named without guessing. */
export function expandElixirModule(
  ref: string,
  aliases: ReadonlyMap<string, string | null>,
  context: string | null,
): string | null {
  const written = stripElixirPrefix(ref);
  if (written === "__MODULE__" || written.startsWith("__MODULE__.")) {
    return context ? `${context}${written.slice("__MODULE__".length)}` : null;
  }
  if (!MODULE_PART.test(written)) return null;
  const dot = written.indexOf(".");
  const first = dot < 0 ? written : written.slice(0, dot);
  if (!aliases.has(first)) return written;
  const target = aliases.get(first);
  return target ? `${target}${dot < 0 ? "" : written.slice(dot)}` : null;
}
