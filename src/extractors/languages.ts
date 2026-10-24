@@CLEANROOM_HOLE_1@@
export type ParsedSymbolKind = "function" | "method" | "class" | "interface" | "trait" | "enum" | "type" | "variable" | "file";
@@CLEANROOM_HOLE_2@@
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
@@CLEANROOM_HOLE_3@@
  /** Direct-call builtins for languages such as PHP. These never become repo
   * call edges merely because a project symbol shares the runtime name. */
  builtinFunctions?: Set<string>;
@@CLEANROOM_HOLE_4@@
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
@@CLEANROOM_HOLE_5@@
  ;; Class-field arrows (\`handler = () => {}\`) are methods in every way that matters.
  (public_field_definition
     name: (property_identifier) @method.name
     value: [(arrow_function) (function_expression)]) @method.def
@@CLEANROOM_HOLE_6@@
  ;; require("./x") and dynamic import("./x") are imports too, when the specifier is literal.
  (call_expression function: (identifier) @_require arguments: (arguments . (string) @import.src .) (#eq? @_require "require"))
  (call_expression function: (import) arguments: (arguments . (string) @import.src .))
@@CLEANROOM_HOLE_7@@
  ;; Construction IS a call. Without these, \`new Foo()\` produced no edge at all, so
  ;; every class in a TS/JS repo had fan_in 0: blast radius before a constructor
  ;; change came back empty, and a \`not-calls\` conformance predicate over a class
  ;; could never see its own counterexample.
  (new_expression constructor: (identifier) @call.id)
  (new_expression constructor: (member_expression property: (property_identifier) @call.member))
@@CLEANROOM_HOLE_8@@
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

@@CLEANROOM_HOLE_9@@
    "public_field_definition",
@@CLEANROOM_HOLE_10@@
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
@@CLEANROOM_HOLE_11@@
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
@@CLEANROOM_HOLE_12@@
  ;; Every class, including one with no directly-nested def: dataclasses, Exception
  ;; subclasses, Enums, TypedDicts and pydantic models are method-less by design and
  ;; were invisible to the entire graph (no symbol, no component, no edges), so
  ;; \`hunch why\` and blast radius came back empty for exactly the classes a refactor
  ;; breaks. parse.ts keys pendingDefs by node id and keeps the first classification,
  ;; so a class that ALSO matches the method-bearing pattern above is not duplicated.
  (class_definition name: (identifier) @class.name) @class.def
@@CLEANROOM_HOLE_13@@
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

@@CLEANROOM_HOLE_14@@
export const LANGUAGES: LanguageSpec[] = [TYPESCRIPT, TSX, PYTHON, GO, PHP, YAML];
@@CLEANROOM_HOLE_15@@
