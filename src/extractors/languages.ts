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
  /** Ancestor shapes in which an ERROR node is a known limitation of THIS grammar
   *  rather than a real syntax error. parse.ts forgives an error only when some
   *  ancestor has type `node` AND that ancestor's own parent has type `parentIs` —
   *  the pair is what keeps the tolerance narrow. Omit for a language with no known
   *  grammar false positives; that spec then stays strictly fail-closed. */
  toleratedErrorScopes?: ReadonlyArray<{ readonly node: string; readonly parentIs: string }>;
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
  ;; Construction IS a call. Without these, \`new Foo()\` produced no edge at all, so
  ;; every class in a TS/JS repo had fan_in 0: blast radius before a constructor
  ;; change came back empty, and a \`not-calls\` conformance predicate over a class
  ;; could never see its own counterexample.
  (new_expression constructor: (identifier) @call.id)
  (new_expression constructor: (member_expression property: (property_identifier) @call.member))
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
  // ES2018 relaxed template literals: an INVALID escape (`\x` with no hex, `\u`
  // short, `\u{` unterminated) is legal inside a TAGGED template — the cooked
  // value is undefined and the raw text survives, which is the entire point of
  // String.raw`C:\Users\x`. tree-sitter-javascript never implemented that
  // relaxation and is identical through 0.25.0, so it emits an ERROR node inside
  // the template_string. In an UNTAGGED template the same escape IS a syntax
  // error, and the grammar models the two differently — a tagged template's
  // template_string hangs off a call_expression, an untagged one off whatever
  // consumes the value — so requiring that pair keeps genuine errors failing.
  toleratedErrorScopes: [{ node: "template_string", parentIs: "call_expression" }],
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
  ;; Every class, including one with no directly-nested def: dataclasses, Exception
  ;; subclasses, Enums, TypedDicts and pydantic models are method-less by design and
  ;; were invisible to the entire graph (no symbol, no component, no edges), so
  ;; \`hunch why\` and blast radius came back empty for exactly the classes a refactor
  ;; breaks. parse.ts keys pendingDefs by node id and keeps the first classification,
  ;; so a class that ALSO matches the method-bearing pattern above is not duplicated.
  (class_definition name: (identifier) @class.name) @class.def
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
