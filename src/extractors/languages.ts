/**
 * Language registry: one LanguageSpec per supported language, consumed by
 * parse.ts (tree-sitter grammar/query dispatch), indexer.ts / diff.ts /
 * synthesize.ts ("is this a code file?"). Adding a language is a new entry
 * here (+ a new tree-sitter-* dependency), not edits scattered across those
 * four files.
 */
import { loadNativeTreeSitter } from "./nativeTreeSitter.js";

export type ParsedSymbolKind = "function" | "method" | "class" | "interface" | "type";

export interface LanguageSpec {
  /** Stable id, also used as the grammar-bundle cache key by parse.ts. */
  id: string;
  extensions: string[];
  /** Cache key parse.ts's bundleFor() uses (one grammar+query pair may serve
   *  several extensions, e.g. tsx serves both .tsx and .jsx). */
  grammarKey: string;
  /** Lazily returns the tree-sitter Language object for this spec. */
  loadGrammar(): unknown;
  /** Tree-sitter query source capturing every construct this language cares about. */
  query: string;
  /** Node types ascendToDef() walks up to when resolving a name capture's enclosing def. */
  defNodeTypes: Set<string>;
  /** Query capture-name (ending in ".def") -> the ParsedSymbolKind it represents. */
  defKindOf: Record<string, ParsedSymbolKind>;
  /** Query capture-name (ending in ".name") -> the matching ".def" capture-name. */
  nameToDef: Record<string, string>;
  /** Common builtin/stdlib method names. Member calls to these (e.g. `arr.map(...)`)
   *  must NOT create call edges to unrelated repo symbols that happen to share the
   *  name (DESIGN: keep the graph clean). */
  builtinMethods: Set<string>;
}

const TS_QUERY = `
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

const TS_BUILTIN_METHODS = new Set([
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

const TS_SHARED = {
  id: "typescript",
  query: TS_QUERY,
  defNodeTypes: new Set([
    "function_declaration", "generator_function_declaration", "method_definition",
    "class_declaration", "interface_declaration", "type_alias_declaration", "variable_declarator",
  ]),
  defKindOf: {
    "fn.def": "function", "method.def": "method", "class.def": "class",
    "iface.def": "interface", "type.def": "type", "arrow.def": "function",
  },
  nameToDef: {
    "fn.name": "fn.def", "method.name": "method.def", "class.name": "class.def",
    "iface.name": "iface.def", "type.name": "type.def", "arrow.name": "arrow.def",
  },
  builtinMethods: TS_BUILTIN_METHODS,
} as const;

const TYPESCRIPT: LanguageSpec = {
  ...TS_SHARED,
  extensions: [".ts", ".mts", ".cts", ".js", ".mjs", ".cjs"],
  grammarKey: "ts",
  loadGrammar: () => loadNativeTreeSitter().typescript,
};

/** .tsx/.jsx use the TSX grammar variant; everything else in the TS spec uses
 *  the plain typescript grammar. Both share the same query/def maps/builtins,
 *  so this is a second LanguageSpec entry with a distinct grammarKey/loadGrammar
 *  only — not a second `id` (languageFor callers only care about extension match). */
const TSX: LanguageSpec = {
  ...TS_SHARED,
  extensions: [".tsx", ".jsx"],
  grammarKey: "tsx",
  loadGrammar: () => loadNativeTreeSitter().tsx,
};

const PY_QUERY = `
  (class_definition
    name: (identifier) @class.name
    body: (block
      [
        (function_definition name: (identifier) @method.name) @method.def
        (decorated_definition definition: (function_definition name: (identifier) @method.name) @method.def)
      ])) @class.def
  (function_definition name: (identifier) @fn.name) @fn.def
  (import_statement name: (dotted_name) @import.src)
  (import_statement name: (aliased_import name: (dotted_name) @import.src))
  (import_from_statement module_name: (dotted_name) @import.src)
  (import_from_statement module_name: (relative_import) @import.src)
  (call function: (identifier) @call.id)
  (call function: (attribute attribute: (identifier) @call.member))
`;

const PY_BUILTIN_METHODS = new Set([
  "get", "set", "keys", "values", "items", "pop", "popitem", "update", "setdefault", "copy", "clear",
  "append", "extend", "insert", "remove", "reverse", "sort", "count", "index",
  "add", "discard", "union", "intersection", "difference",
  "format", "join", "split", "rsplit", "splitlines", "strip", "lstrip", "rstrip",
  "startswith", "endswith", "replace", "find", "rfind", "lower", "upper", "title", "capitalize",
  "encode", "decode", "isdigit", "isalpha", "isalnum", "isspace",
  "read", "write", "close", "open", "readline", "readlines",
  "run", "wait", "poll", "communicate",
]);

const PYTHON: LanguageSpec = {
  id: "python",
  extensions: [".py", ".pyi"],
  grammarKey: "python",
  loadGrammar: () => loadNativeTreeSitter().python,
  query: PY_QUERY,
  defNodeTypes: new Set(["function_definition", "class_definition"]),
  defKindOf: { "fn.def": "function", "method.def": "method", "class.def": "class" },
  nameToDef: { "fn.name": "fn.def", "method.name": "method.def", "class.name": "class.def" },
  builtinMethods: PY_BUILTIN_METHODS,
};

export const LANGUAGES: LanguageSpec[] = [TYPESCRIPT, TSX, PYTHON];

export const CODE_EXTENSIONS: string[] = [...new Set(LANGUAGES.flatMap((l) => l.extensions))];

export function languageFor(file: string): LanguageSpec | null {
  for (const lang of LANGUAGES) {
    if (lang.extensions.some((ext) => file.endsWith(ext))) return lang;
  }
  return null;
}
