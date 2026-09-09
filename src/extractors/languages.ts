/**
 * Language registry: one LanguageSpec per supported language, consumed by
 * parse.ts (tree-sitter grammar/query dispatch), indexer.ts / diff.ts /
 * synthesize.ts ("is this a code file?"). Adding a language is a new entry
 * here (+ a new tree-sitter-* dependency), not edits scattered across those
 * four files.
 */
import { basename } from "node:path";
import { loadNativeTreeSitter } from "./nativeTreeSitter.js";
import type { Edge } from "../core/types.js";

export type ParsedSymbolKind = "function" | "method" | "class" | "interface" | "trait" | "enum" | "type" | "variable" | "file";

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
  /** Optional semantic relationship captures. The generic parser/indexer emit
   * these through the normal graph path; languages only describe syntax. */
  relationKindOf?: Record<string, { edgeType: Edge["type"]; label: string }>;
  /** Common builtin/stdlib method names. Member calls to these (e.g. `arr.map(...)`)
   *  must NOT create call edges to unrelated repo symbols that happen to share the
   *  name (DESIGN: keep the graph clean). */
  builtinMethods: Set<string>;
  /** Direct-call builtins for languages such as PHP. These never become repo
   * call edges merely because a project symbol shares the runtime name. */
  builtinFunctions?: Set<string>;
  /** Edge type emitted for this language's calls-list entries (e.g. YAML's
   *  alias->anchor references aren't function calls). Defaults to "calls"
   *  when omitted — every language before YAML. */
  referenceEdgeType?: Edge["type"];
  /** Fallback name for a ".def" capture with no paired ".name" capture (e.g.
   *  a whole-file root symbol with no natural identifier of its own). Omit
   *  for a language where every ".def" always has a name capture — parse.ts
   *  then keeps dropping unnamed defs, the current behavior for TS/Python. */
  fallbackDefName?: (file: string) => string;
  /** Ancestor shapes in which an ERROR node is a known limitation of THIS grammar
   *  rather than a real syntax error. parse.ts forgives an error only when some
   *  ancestor has type `node` AND that ancestor's own parent has type `parentIs` —
   *  the pair is what keeps the tolerance narrow. Omit for a language with no known
   *  grammar false positives; that spec then stays strictly fail-closed. */
  toleratedErrorScopes?: ReadonlyArray<{ readonly node: string; readonly parentIs: string }>;
  /** Patterns whose presence anywhere in the source mean "this isn't actually
   *  {id} text yet — it's a template that renders to {id} later" (Go/Jinja/Helm
   *  delimiters in a .yaml file, e.g.). parse.ts still runs the real parse — a
   *  genuine anchor/symbol elsewhere in the file is still extracted, same as any
   *  other {id} file — but no longer lets the resulting ERROR nodes fail-close
   *  the whole-repo scan completeness gate the way toleratedErrorScopes protects
   *  narrower, per-grammar false positives (issue #33). Keep these narrow: a
   *  pattern that also matches ordinary, always-valid {id} syntax (e.g. GitHub
   *  Actions' `${{ }}` expressions) would silently disable the fail-closed
   *  guarantee for files that were never templated at all. */
  templatingMarkers?: readonly RegExp[];
  /** Extensions within this language where EVERY file is inherently a template
   *  regardless of content — unlike templatingMarkers, this never content-sniffs.
   *  The extension alone means "this file is a template, parseable must never
   *  become false for it," matching Helm's `_helpers.tpl` convention where the
   *  file may be pure Go-template text with no YAML structure of its own at all. */
  alwaysTemplatedExtensions?: readonly string[];
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

const GO_QUERY = `
  (function_declaration name: (identifier) @fn.name) @fn.def
  (method_declaration name: (field_identifier) @method.name) @method.def
  ;; Specific type_spec shapes FIRST: parse.ts keeps the first classification a
  ;; node id receives (same mechanism the Python class patterns rely on), so a
  ;; struct/interface matches its specific pattern before the generic @type.def.
  (type_spec name: (type_identifier) @struct.name type: (struct_type)) @struct.def
  (type_spec name: (type_identifier) @iface.name type: (interface_type)) @iface.def
  (type_spec name: (type_identifier) @type.name) @type.def
  ;; \`type X = Y\` is a distinct type_alias node, not a type_spec.
  (type_alias name: (type_identifier) @type.name) @type.def
  (import_spec path: [(interpreted_string_literal) (raw_string_literal)] @import.src)
  (call_expression function: (identifier) @call.id)
  (call_expression function: (selector_expression field: (field_identifier) @call.member))
`;

/** In Go every package-qualified call (fmt.Println, strings.Split, t.Errorf) is a
 *  selector_expression and therefore lands in @call.member — the DOMINANT call form.
 *  This allowlist filters the highest-frequency stdlib/testing method+function names
 *  so they never create false edges to same-named repo symbols; repo-specific member
 *  calls (s.Run(), h.Handle()) pass through and resolve conservatively like TS/PY. */
const GO_BUILTIN_METHODS = new Set([
  "Error", "String", "Read", "Write", "Close", "Len", "Cap", "Reset", "Bytes", "Text",
  "Scan", "Next", "Err", "Lock", "Unlock", "RLock", "RUnlock", "Done", "Add", "Wait",
  "Print", "Printf", "Println", "Sprintf", "Fprintf", "Errorf", "Fatal", "Fatalf", "Fatalln",
  "Log", "Logf", "Helper", "Run", "Parallel", "Skip", "Skipf", "Cleanup",
  "Get", "Set", "Delete", "Load", "Store", "Range", "Value", "Context", "Deadline",
  "Marshal", "Unmarshal", "Encode", "Decode", "Parse", "Format", "Sub", "Before", "After",
  "Join", "Split", "Contains", "Replace", "ReplaceAll", "TrimSpace", "ToLower", "ToUpper",
  "HasPrefix", "HasSuffix", "WriteString", "ReadString", "ReadAll", "Copy", "New", "Now",
  "Since", "Sleep", "Unix", "Exec", "Query", "QueryRow", "Begin", "Commit", "Rollback",
]);

const GO: LanguageSpec = {
  id: "go",
  extensions: [".go"],
  grammarKey: "go",
  loadGrammar: () => loadNativeTreeSitter().go,
  query: GO_QUERY,
  defNodeTypes: new Set(["function_declaration", "method_declaration", "type_spec", "type_alias"]),
  defKindOf: {
    "fn.def": "function", "method.def": "method", "struct.def": "class",
    "iface.def": "interface", "type.def": "type",
  },
  nameToDef: {
    "fn.name": "fn.def", "method.name": "method.def", "struct.name": "struct.def",
    "iface.name": "iface.def", "type.name": "type.def",
  },
  builtinMethods: GO_BUILTIN_METHODS,
};

const PHP_QUERY = `
  (namespace_definition name: (namespace_name) @namespace.name) @namespace.def
  (class_declaration name: (name) @class.name) @class.def
  (interface_declaration name: (name) @iface.name) @iface.def
  (trait_declaration name: (name) @trait.name) @trait.def
  (enum_declaration name: (name) @enum.name) @enum.def
  (function_definition name: (name) @fn.name) @fn.def
  (method_declaration name: (name) @method.name) @method.def

  ;; Keep whole namespace-use declarations so Composer resolution can retain
  ;; aliases, grouped imports, and function/const import modifiers.
  (namespace_use_declaration) @import.src
  ;; Static include/require expressions are resolved conservatively by the PHP
  ;; resolver. Dynamic expressions remain visible as unresolved, never guessed.
  [(include_expression) (include_once_expression)
   (require_expression) (require_once_expression)] @import.src

  (object_creation_expression [(name) (qualified_name)] @import.src)
  (scoped_call_expression scope: [(name) (qualified_name)] @import.src)

  (function_call_expression function: (name) @call.id)
  (function_call_expression function: (qualified_name) @call.id)
  (object_creation_expression [(name) (qualified_name)] @call.id)
  (scoped_call_expression name: (name) @call.member)
  (member_call_expression name: (name) @call.member)
  (nullsafe_member_call_expression name: (name) @call.member)

  (base_clause [(name) (qualified_name) (relative_name)] @relation.extends)
  (class_interface_clause [(name) (qualified_name) (relative_name)] @relation.implements)
  (use_declaration [(name) (qualified_name) (relative_name)] @relation.trait)
`;

const PHP_BUILTIN_METHODS = new Set([
  "count", "strlen", "array_map", "array_filter", "array_reduce", "array_values", "array_keys",
  "in_array", "sprintf", "printf", "implode", "explode", "trim", "ltrim", "rtrim", "str_replace",
  "preg_match", "preg_replace", "json_encode", "json_decode", "getenv", "putenv", "class_exists",
  "interface_exists", "trait_exists", "method_exists", "property_exists", "is_array", "is_string",
  "is_int", "is_bool", "is_null", "assert", "call_user_func", "call_user_func_array",
]);

const PHP: LanguageSpec = {
  id: "php",
  extensions: [".php"],
  grammarKey: "php",
  loadGrammar: () => loadNativeTreeSitter().php,
  query: PHP_QUERY,
  defNodeTypes: new Set([
    "namespace_definition", "class_declaration", "interface_declaration", "trait_declaration",
    "enum_declaration", "function_definition", "method_declaration",
  ]),
  defKindOf: {
    "namespace.def": "type", "class.def": "class", "iface.def": "interface",
    "trait.def": "trait", "enum.def": "enum", "fn.def": "function", "method.def": "method",
  },
  nameToDef: {
    "namespace.name": "namespace.def", "class.name": "class.def", "iface.name": "iface.def",
    "trait.name": "trait.def", "enum.name": "enum.def", "fn.name": "fn.def", "method.name": "method.def",
  },
  relationKindOf: {
    "relation.extends": { edgeType: "implements", label: "extends" },
    "relation.implements": { edgeType: "implements", label: "implements" },
    "relation.trait": { edgeType: "implements", label: "uses trait" },
  },
  builtinMethods: PHP_BUILTIN_METHODS,
  builtinFunctions: PHP_BUILTIN_METHODS,
};

const YAML_QUERY = `
  (block_node (anchor (anchor_name) @anchor.name)) @anchor.def
  (flow_node (anchor (anchor_name) @anchor.name)) @anchor.def
  (alias (alias_name) @call.id)
  (stream) @doc.def
`;

const YAML: LanguageSpec = {
  id: "yaml",
  extensions: [".yml", ".yaml", ".tpl"],
  grammarKey: "yaml",
  loadGrammar: () => loadNativeTreeSitter().yaml,
  query: YAML_QUERY,
  // Both block-style (`key: &x\n  ...`) and flow-style (`key: &x {...}`) anchors
  // wrap only the sigil+name; ascendToDef climbs from anchor_name -> anchor ->
  // this enclosing node to find the def whose byte range covers the full value.
  defNodeTypes: new Set(["block_node", "flow_node"]),
  defKindOf: { "anchor.def": "variable", "doc.def": "file" },
  nameToDef: { "anchor.name": "anchor.def" },
  builtinMethods: new Set(),
  // Alias references aren't calls; label the edge accordingly (Task 5).
  referenceEdgeType: "references",
  // Most aliases reference an anchor from OUTSIDE that anchor's own byte range
  // (a sibling key, not a nested value) — without a whole-file fallback symbol,
  // attributeCalls's containment check would silently drop them. See Task 4.
  fallbackDefName: (file) => basename(file),
  // Helm charts / templated CI configs are common .yaml content that only
  // becomes valid YAML after a render step (issue #33). The negative lookbehind
  // on "{{" excludes GitHub Actions' `${{ expression }}` syntax, which is
  // ordinary, always-valid YAML — every workflow file in this repo uses it, so
  // treating it as a templating marker would blanket-disable the fail-closed
  // gate for .github/workflows/**.
  templatingMarkers: [/(?<!\$)\{\{/, /\{%/],
  alwaysTemplatedExtensions: [".tpl"],
};

export const LANGUAGES: LanguageSpec[] = [TYPESCRIPT, TSX, PYTHON, GO, PHP, YAML];

export const CODE_EXTENSIONS: string[] = [...new Set(LANGUAGES.flatMap((l) => l.extensions))];

export function languageFor(file: string): LanguageSpec | null {
  for (const lang of LANGUAGES) {
    if (lang.extensions.some((ext) => file.endsWith(ext))) return lang;
  }
  return null;
}

/** Prose formats worth drafting a decision from even though no LanguageSpec parses
 *  them — no grammar, no symbols/edges, just eligible input to synthesis (issue #12). */
export const PROSE_EXTENSIONS: string[] = [".md"];

/** Broader than languageFor: "is this worth reasoning about" (synthesis input)
 *  rather than "can tree-sitter parse this" (symbol/dependency extraction). */
export function isSubstantive(file: string): boolean {
  return languageFor(file) !== null || PROSE_EXTENSIONS.some((ext) => file.endsWith(ext));
}
