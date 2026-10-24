/**
 * The single language registry: one `LanguageSpec` per supported language. The
 * parser reads grammar and query data from here, and the indexer, diff analysis
 * and synthesis ask it "is this a code file?". Adding a language means adding an
 * entry here plus a grammar dependency.
 */
import { basename } from "node:path";
import { loadNativeTreeSitter } from "./nativeTreeSitter.js";
import type { Edge } from "../core/types.js";

export type ParsedSymbolKind = "function" | "method" | "class" | "interface" | "trait" | "enum" | "type" | "variable" | "file";

export interface LanguageSpec {
  /** Stable language id (`typescript`, `python`, `go`, `php`, `yaml`). */
  id: string;
  /** File suffixes, leading dot included, that this spec handles. */
  extensions: string[];
  /** Memoization key for the parser+query bundle. One grammar can serve several
   *  extensions, and two specs may share an `id` yet differ here (TS vs TSX). */
  grammarKey: string;
  /** Lazily returns the tree-sitter Language object. */
  loadGrammar(): unknown;
  /** Tree-sitter query source capturing every construct of interest. */
  query: string;
  /** Node types the parser climbs to when attaching a name capture to its definition. */
  defNodeTypes: Set<string>;
  /** Symbol kind for each capture name ending in `.def`. */
  defKindOf: Record<string, ParsedSymbolKind>;
  /** Maps each `.name` capture to the `.def` capture it belongs to. */
  nameToDef: Record<string, string>;
  /** Optional query binding a local name to an imported module, run with
   *  matches() so captures pair up: @bind.src (module specifier), @bind.local
   *  (local name), @bind.name (an imported member, `from X import name`). Feeds
   *  qualified calls (`ns.fn()`), resolved only inside the bound module's files. */
  bindingQuery?: string;
  /** Local name an import binds when @bind.local is absent (Go `"a/geo"` -> geo). */
  defaultBindingLocal?(src: string): string | null;
  /** Module path of `from <src> import <name>` when name is itself a submodule. */
  joinSubmodule?(src: string, name: string): string;
  /** Optional semantic relationship captures. The generic parser/indexer emit
   * these through the normal graph path; languages only describe syntax. */
  relationKindOf?: Record<string, { edgeType: Edge["type"]; label: string }>;
  /** Common builtin/stdlib method names. A member call whose property is in this
   *  set never produces a call edge to a same-named repo symbol. */
  builtinMethods: Set<string>;
  /** Direct-call builtins for languages such as PHP. These never become repo
   * call edges merely because a project symbol shares the runtime name. */
  builtinFunctions?: Set<string>;
  /** Edge type emitted for this language's call-list entries; defaults to
   *  `"calls"`. YAML sets it because alias-to-anchor links are references. */
  referenceEdgeType?: Edge["type"];
  /** Name for a `.def` capture that has no paired `.name` capture (a whole-file
   *  root symbol, say). When omitted, unnamed defs are dropped. */
  fallbackDefName?: (file: string) => string;
  /** Ancestor shapes in which an ERROR node is a known limitation of THIS grammar
   *  rather than a real syntax error. parse.ts forgives an error only when some
   *  ancestor has type `node` AND that ancestor's own parent has type `parentIs` —
   *  the pair is what keeps the tolerance narrow. `textPattern`, when present,
   *  must also match that ancestor's text. Omit for a language with no
   *  known grammar false positives; that spec then stays strictly fail-closed. */
  toleratedErrorScopes?: ReadonlyArray<{
    readonly node: string;
    readonly parentIs: string;
    readonly textPattern?: RegExp;
  }>;
  /** Optional same-length recovery used only when the original syntax tree is
   *  not parseable. A recovered tree may classify structure, but parse.ts reads
   *  every captured value from the original source at the tree's unchanged
   *  offsets. Keep replacements syntax-equivalent outside the grammar defect. */
  parseErrorRecovery?: (source: string) => string;
  /** Patterns whose presence anywhere in a file's text means the file is a
   *  template that renders into this language later (Go/Jinja/Helm delimiters in
   *  YAML). The real parse still runs, but the resulting error nodes must not make
   *  the file unparseable, so the whole-repo completeness gate does not fail
   *  closed. Keep patterns narrow so they never match always-valid syntax such as
   *  GitHub Actions `${{ }}` expressions. */
  templatingMarkers?: readonly RegExp[];
  /** Extensions where every file is a template regardless of content, with no
   *  sniffing (Helm's `_helpers.tpl` convention). Such files are never reported
   *  unparseable. */
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
  ;; Class-field arrows (\`handler = () => {}\`) are methods in every way that matters.
  (public_field_definition
     name: (property_identifier) @method.name
     value: [(arrow_function) (function_expression)]) @method.def
  (import_statement source: (string) @import.src)
  ;; require("./x") and dynamic import("./x") are imports too, when the specifier is literal.
  (call_expression function: (identifier) @_require arguments: (arguments . (string) @import.src .) (#eq? @_require "require"))
  (call_expression function: (import) arguments: (arguments . (string) @import.src .))
  (call_expression function: (identifier) @call.id)
  (call_expression function: (member_expression property: (property_identifier) @call.member))
  ;; Construction IS a call. Without these, \`new Foo()\` produced no edge at all, so
  ;; every class in a TS/JS repo had fan_in 0: blast radius before a constructor
  ;; change came back empty, and a \`not-calls\` conformance predicate over a class
  ;; could never see its own counterexample.
  (new_expression constructor: (identifier) @call.id)
  (new_expression constructor: (member_expression property: (property_identifier) @call.member))
`;

/** Rendering a component IS a call; lowercase tags are intrinsic elements, not symbols. */
const TSX_QUERY = `${TS_QUERY}
  (jsx_opening_element name: (identifier) @call.id (#match? @call.id "^[A-Z]"))
  (jsx_self_closing_element name: (identifier) @call.id (#match? @call.id "^[A-Z]"))
  (jsx_opening_element name: (member_expression property: (property_identifier) @call.member))
  (jsx_self_closing_element name: (member_expression property: (property_identifier) @call.member))
`;

/** Module-object bindings: \`import * as ns\`, \`const m = require()\`, \`const m = await import()\`. */
const TS_BINDING_QUERY = `
  (import_statement (import_clause (namespace_import (identifier) @bind.local)) source: (string) @bind.src)
  (variable_declarator
     name: (identifier) @bind.local
     value: (call_expression function: (identifier) @_require arguments: (arguments . (string) @bind.src .))
     (#eq? @_require "require"))
  (variable_declarator
     name: (identifier) @bind.local
     value: (await_expression (call_expression function: (import) arguments: (arguments . (string) @bind.src .))))
`;

const TS_BUILTIN_METHODS = new Set([
  // arrays
  "map", "filter", "forEach", "reduce", "find", "findIndex", "some", "every", "includes",
  "push", "pop", "shift", "unshift", "slice", "splice", "concat", "join", "split", "flat",
  "flatMap", "indexOf", "lastIndexOf", "keys", "values", "entries", "sort", "reverse", "fill", "at",
  // Map / Set
  "get", "set", "has", "add", "delete", "clear",
  // Promise
  "then", "catch", "finally", "all", "race", "resolve", "reject",
  // object basics
  "toString", "valueOf", "toJSON", "hasOwnProperty",
  // strings
  "replace", "replaceAll", "trim", "trimStart", "trimEnd", "padStart", "padEnd", "startsWith",
  "endsWith", "toLowerCase", "toUpperCase", "charAt", "charCodeAt", "substring", "substr",
  "repeat", "match", "matchAll",
  // Function / RegExp / JSON / Date / Array / Object statics
  "call", "apply", "bind", "test", "exec", "now", "parse", "stringify", "from", "of", "isArray", "assign",
  // console
  "log", "error", "warn", "info", "debug",
]);

const TS_SHARED = {
  id: "typescript",
  query: TS_QUERY,
  defNodeTypes: new Set([
    "function_declaration",
    "generator_function_declaration",
    "method_definition",
    "class_declaration",
    "interface_declaration",
    "type_alias_declaration",
    "variable_declarator",
    "public_field_definition",
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
  bindingQuery: TS_BINDING_QUERY,
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

/** TSX is a second entry that differs from TYPESCRIPT only in grammar and cache
 *  key (the `id` is shared). It also overrides the query with TSX_QUERY, widens
 *  the tolerated error scopes and adds a recovery pass. */
const TSX: LanguageSpec = {
  ...TS_SHARED,
  extensions: [".tsx", ".jsx"],
  grammarKey: "tsx",
  loadGrammar: () => loadNativeTreeSitter().tsx,
  query: TSX_QUERY,
  // tree-sitter-javascript rejects a bare ampersand in JSX text even though JSX
  // accepts it (tree-sitter-javascript#366). The ERROR is a direct jsx_element
  // child and its text begins at the ampersand. Require both facts plus text that
  // cannot cross into a tag or expression; real JSX errors beside it remain fail-closed.
  toleratedErrorScopes: [
    ...TS_SHARED.toleratedErrorScopes,
    { node: "ERROR", parentIs: "jsx_element", textPattern: /^&[^<>{}]*$/u },
  ],
  // More than one bare ampersand can make the grammar collapse the entire TSX
  // tree instead of emitting the narrow ERROR above. `|` is accepted as JSX
  // text and has the same length; in JS/TS syntax it preserves ampersand
  // operators' arity, so malformed expressions remain malformed on the retry.
  parseErrorRecovery: (source) => source.replaceAll("&", "|"),
};

const PY_QUERY = `
  ;; A class whose body directly holds a def (plain or decorated): the nested def is
  ;; a method. parse.ts keeps the first classification per node, so the generic
  ;; function pattern below does not reclassify it.
  (class_definition
     name: (identifier) @class.name
     body: (block [
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
  (import_from_statement module_name: [(dotted_name) (relative_import)] @import.src)
  (call function: (identifier) @call.id)
  (call function: (attribute attribute: (identifier) @call.member))
`;

const PY_BUILTIN_METHODS = new Set([
  "get", "set", "keys", "values", "items", "pop", "popitem", "update", "setdefault", "copy",
  "clear", "append", "extend", "insert", "remove", "reverse", "sort", "count", "index", "add",
  "discard", "union", "intersection", "difference", "format", "join", "split", "rsplit",
  "splitlines", "strip", "lstrip", "rstrip", "startswith", "endswith", "replace", "find",
  "rfind", "lower", "upper", "title", "capitalize", "encode", "decode", "isdigit", "isalpha",
  "isalnum", "isspace", "read", "write", "close", "open", "readline", "readlines", "run",
  "wait", "poll", "communicate",
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
  ;; An alias is a reference to its anchor.
  (alias (alias_name) @call.id)
  ;; The whole document gets a root symbol (named via fallbackDefName).
  (stream) @doc.def
`;

const YAML: LanguageSpec = {
  id: "yaml",
  extensions: [".yml", ".yaml", ".tpl"],
  grammarKey: "yaml",
  loadGrammar: () => loadNativeTreeSitter().yaml,
  query: YAML_QUERY,
  defNodeTypes: new Set(["block_node", "flow_node"]),
  defKindOf: { "anchor.def": "variable", "doc.def": "file" },
  nameToDef: { "anchor.name": "anchor.def" },
  builtinMethods: new Set(),
  referenceEdgeType: "references",
  // Most aliases sit outside their anchor's byte range, so without a root symbol
  // call attribution would drop them. The file's own name is the root.
  fallbackDefName: (file) => basename(file),
  // Go/Jinja/Helm delimiters make a file invalid YAML until rendered. A `{{` not
  // preceded by `$` (GitHub Actions `${{ }}` is plain valid YAML) and a Jinja `{%`.
  templatingMarkers: [/(?<!\$)\{\{/u, /\{%/u],
  // `.tpl` files (Helm `_helpers.tpl`) are templates by convention, whatever they hold.
  alwaysTemplatedExtensions: [".tpl"],
};

export const LANGUAGES: LanguageSpec[] = [TYPESCRIPT, TSX, PYTHON, GO, PHP, YAML];

/** Every registered extension, de-duplicated, in registry order. */
export const CODE_EXTENSIONS: string[] = [...new Set(LANGUAGES.flatMap((l) => l.extensions))];

/** First spec (registry order) with an extension the file name ends with. */
export function languageFor(file: string): LanguageSpec | null {
  return LANGUAGES.find((l) => l.extensions.some((ext) => file.endsWith(ext))) ?? null;
}

/** Prose formats eligible as synthesis input but never parsed. */
export const PROSE_EXTENSIONS: string[] = [".md"];

/** True for parseable code or prose. Deliberately broader than parseability. */
export function isSubstantive(file: string): boolean {
  return languageFor(file) !== null || PROSE_EXTENSIONS.some((ext) => file.endsWith(ext));
}
