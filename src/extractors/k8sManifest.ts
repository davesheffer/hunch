/**
 * Deterministic text scan for Kubernetes manifest cross-resource references —
 * NOT a tree-sitter walk. Confirmed directly (not assumed): parsing a realistic
 * templated Deployment with this repo's own tree-sitter-yaml bundle showed a
 * same-line templated scalar (`name: {{ include "x" . }}`) parses cleanly, but
 * a block-form injection on its own line (`labels:\n  {{- include ... }}` — the
 * pattern real charts use for metadata.labels and spec.selector) collapses the
 * WHOLE REST OF THE DOCUMENT'S error recovery into a flat, unstructured ERROR
 * node. Real charts place such an injection early (right after metadata.name),
 * so it would poison parsing for every field-path this module needs further
 * down the same document. parseSource() (parse.ts) also never exposes its
 * tree-sitter tree to callers at all -- helm.ts's own text-scan precedent
 * exists for the same reason.
 *
 * This is a line-oriented, indentation-tracking scanner (not flat regex, unlike
 * helm.ts's `{{ }}`-action scan) because K8s field-paths are nested block
 * structure (`spec.template.spec.containers[].env[].valueFrom.secretKeyRef.name`)
 * that a flat scan can't reconstruct. It never interprets `{{ }}` as YAML syntax
 * at all -- a `{{ ... }}` on a line's value side is just that line's raw value
 * text, same-line or block-form alike -- so it is immune to the exact failure
 * mode that broke tree-sitter.
 */

// Offsets below are JS string (UTF-16 code unit) indices, not UTF-8 byte
// offsets, named *Char rather than *Byte to say so honestly.
export type ManifestNameRef =
  | { form: "literal"; value: string; atChar: number; endChar: number }
  | { form: "template"; sourceText: string; atChar: number; endChar: number };

interface K8sReferenceCandidate {
  /** Fixed literal for most kinds ("ConfigMap", "Secret", "PersistentVolumeClaim",
   *  "Service"); for an ownerReferences entry, the reference's OWN `kind` field
   *  value (data-dependent, not statically known). */
  refKind: string;
  name: ManifestNameRef;
  /** The namespace this reference resolves IN, or null for "unknown" (see
   *  literalNamespace). Kubernetes name references are same-namespace by
   *  definition, so this defaults to the referring DOCUMENT's own namespace;
   *  the one shape that can legitimately point elsewhere (a Gateway API
   *  `backendRefs[].namespace` sibling) overrides it. */
  namespace: string | null;
}

type ManifestLabelMap = Record<string, string>;

interface K8sResourceDoc {
  kind: string;
  name: ManifestNameRef;
  /** `metadata.namespace` when it is a plain literal, else null = UNKNOWN (see
   *  literalNamespace). Cluster-scoped kinds need no special case: they simply
   *  never carry the field, so they are unknown and compatible with anything. */
  namespace: string | null;
  startChar: number;
  endChar: number;
}

export interface K8sManifestDocument {
  resource: K8sResourceDoc | null;
  references: K8sReferenceCandidate[];
  selector: ManifestLabelMap | null;
  labels: ManifestLabelMap | null;
}

// ReplicaSet is included alongside the pod-spec-embedding/networking kinds
// specifically because it's the dominant real-world bearer of
// ownerReferences (Deployment -> ReplicaSet -> Pod is the common chain) --
// without it, the single most common ownerReferences case would be silently
// dropped by the allowlist gate below, despite Goal 2 explicitly scoping
// "any resource -> its owner" as in scope. Still a well-known core/apps kind,
// not a CRD -- consistent with the allowlist's own rationale, not an exception to it.
const ALLOWED_KINDS = new Set([
  "Deployment", "StatefulSet", "DaemonSet", "Job", "CronJob", "Pod", "ReplicaSet",
  "Service", "ConfigMap", "Secret", "PersistentVolumeClaim", "Ingress", "HTTPRoute",
]);

interface FieldPathEntry {
  /** Concrete path with real sequence indices, e.g. "spec.containers[0].env[1].value". */
  path: string;
  /** path's containing segment (everything but this entry's own key) -- e.g.
   *  "spec.selector" for a "spec.selector.app.kubernetes.io/instance" entry.
   *  Computed structurally from the frame stack, NOT by string-splitting
   *  `path` on ".": a Kubernetes label key legitimately contains dots
   *  (`app.kubernetes.io/instance` is the `helm create` default), which is
   *  indistinguishable from path nesting once joined into one string. Callers
   *  that need "is this a direct child of prefix X" must compare parentPath,
   *  never re-derive a key by slicing path. */
  parentPath: string;
  /** This entry's own raw key exactly as written, dots/slashes included. */
  key: string;
  value: ManifestNameRef;
}

/** Normalize a concrete path's sequence indices to "[]" for table matching. */
function wildcardPath(path: string): string {
  return path.replace(/\[\d+\]/g, "[]");
}

interface StackFrame {
  indent: number;
  key: string;
  isSeq: boolean;
  hasValue: boolean;
  nextIndex?: number;
}

/** Dot-joined field path for a frame stack (or a prefix of one), e.g.
 *  `spec.template.spec.containers[0].env` -- `\.\[` collapses to `[` since a
 *  sequence-item frame's own key is already `[N]`, and joining it after a
 *  `.` would double the separator. */
function framePath(frames: readonly StackFrame[]): string {
  return frames.map((f) => f.key).filter(Boolean).join(".").replace(/\.\[/g, "[");
}

// `\r?` before `$`: without it, a CRLF-terminated line (the Git-for-Windows
// `core.autocrlf=true` default -- every .yaml file in a Windows checkout) never
// matches at all, since JS `.` never matches `\r` and `$` (no /m flag) only
// matches at the true end of the string. That silently zeroes out this whole
// module's output on any Windows clone, with no error. `.*?` (lazy, not `.*`
// greedy) so `\r?` gets first claim on a trailing `\r` instead of the value
// capture swallowing it.
const KEY_LINE = /^(\s*)(-\s+)?([A-Za-z0-9_.\/-]+):[ \t]*(.*?)\r?$/;
// A line that is ENTIRELY a `{{ ... }}` template action (no `key:` prefix at
// all) -- e.g. a block-form injection appearing as a SIBLING after other
// literal keys under the same mapping (`app: my-app` then, on its own later
// line, `{{- include "mychart.selectorLabels" . | nindent 4 }}`). This never
// matches KEY_LINE (there's no colon-terminated key), so without explicit
// handling it's silently invisible to the scanner -- neither contributing a
// value nor marking its container as unresolved, which lets a literal-looking
// map that's actually partially templated pass as fully literal. No capture
// groups: unlike an unrecognized-but-real YAML line, this line's OWN
// indentation is deliberately never inspected -- see
// markAllOpenContainersUnresolved's comment for why.
const BARE_TEMPLATE_LINE = /^\s*(?:-\s+)?\{\{[\s\S]*$/;
// A list-item marker with NOTHING after it on the same line -- the item's
// content is entirely on the following, more-indented lines
// (`containers:\n  -\n    name: app`). Legal YAML, distinct from the inline
// `- name: app` form KEY_LINE already handles: this line has no key of its
// own at all, so without explicit handling it fell to the unrecognized-line
// branch, which used ORDINARY popping and lost the list-item frame entirely
// -- reparenting the item's real children one level up (`containers.name`
// instead of `containers[0].name`), silently dropping every reference under it.
const BARE_LIST_MARKER = /^(\s*)-[ \t]*\r?$/;
// A list item whose ENTIRE content is a block-scalar header (`- |`, `- |-`,
// `- >`, `- |2`, `- | # comment`) -- the idiomatic way a chart inlines a shell
// script into `args:`/`command:`. The item's value is opaque TEXT, not YAML,
// yet the body lines look exactly like manifest fields (a heredoc'd
// `secretKeyRef:` block is the canonical case), and this line matches neither
// KEY_LINE (no colon) nor BARE_LIST_MARKER (something follows the dash), so it
// fell to the unrecognized-line branch and the script body was then scanned as
// the surrounding container's children -- inventing a reference to a resource
// that only ever existed as text. The `key: |` form needs no such handling:
// its body nests under the key's OWN frame, where no reference field-path can
// match. The rest is captured (not `[|>]` inline) so the header can be run
// through stripTrailingComment before BLOCK_SCALAR_HEADER, exactly as a
// key line's value is.
const BLOCK_SCALAR_LIST_ITEM = /^(\s*)-[ \t]+(.*?)\r?$/;
// A YAML block-scalar header (`|`, `>`, plus an optional chomping indicator
// `+`/`-` and/or an explicit indent digit, in either order: `|`, `|-`, `>+`,
// `|2`, `|2-`, `|-2`). When a key's value is JUST this header, the real
// scalar is on the FOLLOWING indented lines, not this one -- treating the
// header token itself as the value (e.g. a resource literally named "|-")
// would be silently, confidently wrong, not merely incomplete.
const BLOCK_SCALAR_HEADER = /^[|>](?:[+-]\d*|\d+[+-]?)?$/;

/** Strip a trailing YAML comment: `#` only opens one at the start of the
 *  value or after whitespace, and never inside a quoted scalar -- so
 *  `key: "a # b"` keeps its `#` and `key: {{ .x | default "#fff" }}` keeps
 *  its Sprig default intact, but `key: my-config  # app settings` drops the
 *  comment. Without this, a comment silently becomes part of the value text:
 *  it never matches the same resource's uncommented name elsewhere, so the
 *  reference quietly resolves to nothing instead of erroring -- the worst
 *  failure mode for a "no match -> no edge, never guess" design, since it's
 *  indistinguishable from correctly declining to guess. */
function stripTrailingComment(raw: string): string {
  let quote: string | null = null;
  for (let i = 0; i < raw.length; i++) {
    const ch = raw[i]!;
    if (quote) { if (ch === quote) quote = null; continue; }
    // A quote only OPENS a quoted scalar at the value's start or after
    // whitespace -- mirrors the # rule below, and keeps a Sprig
    // `default "#fff"` working (its " follows a space) while an apostrophe
    // mid-word (`it's-fine`) no longer opens a phantom quote that would
    // swallow a real trailing comment whole.
    if ((ch === '"' || ch === "'") && (i === 0 || /\s/.test(raw[i - 1]!))) { quote = ch; continue; }
    if (ch === "#" && (i === 0 || /\s/.test(raw[i - 1]!))) return raw.slice(0, i);
  }
  return raw;
}

function stripQuotes(value: string): string {
  if (value.length >= 2) {
    const first = value[0];
    const last = value.at(-1);
    if ((first === '"' && last === '"') || (first === "'" && last === "'")) return value.slice(1, -1);
  }
  return value;
}

/** Line-oriented indentation-stack scan. Handles BOTH real-world YAML list
 *  styles: sequence items at the SAME indent as their parent key
 *  (`containers:\n- name: app`) and at a DEEPER indent (`env:\n  - name: X`) --
 *  both occur in real manifests. A value-less key frame is converted to a
 *  sequence frame IN PLACE (not popped) the first time a `-` line arrives at or
 *  below its own indent; a sequence frame is only ever closed by a
 *  shallower-indent line, never by an equal-indent one (equal-indent means
 *  "next item"). */
function scanFieldPaths(text: string, baseChar: number): { entries: FieldPathEntry[]; unresolvedContainers: Set<string>; valuelessKeyParents: Set<string> } {
  const entries: FieldPathEntry[] = [];
  // A container (mapping) this scanner could not fully account for -- either
  // an explicit {{ }} template injection, OR a line shape KEY_LINE doesn't
  // recognize at all (a quoted key, a YAML merge key `<<:`, ...). Both get the
  // SAME treatment: a dropped/unrecognized key would make a selector/labels
  // map strictly MORE permissive (fewer real constraints), which risks a
  // false-positive edge -- the failure mode this whole module exists to
  // avoid. Silently ignoring what the scanner can't parse is not safe here;
  // "I can't tell" must read as "unresolved," the same as a real template.
  const unresolvedContainers = new Set<string>();
  // The framePath of every container that DIRECTLY holds a key written with no
  // value at all (`tier:`). Deliberately its own set rather than more entries
  // in unresolvedContainers: an ordinary container like `spec:` legitimately
  // holds value-less keys (every nested mapping starts with one), so folding
  // these in would destroy that set's meaning -- "the scanner could not
  // account for this line". Only a map that is supposed to be FLAT
  // (selector/labels) cares, and it checks this set itself.
  const valuelessKeyParents = new Set<string>();
  const stack: StackFrame[] = [];
  let charOffset = baseChar;
  // Indent of the `-` of a `- |` list item whose block-scalar body is being
  // skipped, or null when no such skip is active. The body ends at the first
  // line indented at or shallower than that dash (YAML's own rule for where a
  // sequence item's content stops).
  let blockScalarSkipIndent: number | null = null;

  const popToForListItem = (dashIndent: number): void => {
    while (stack.length) {
      const top = stack[stack.length - 1]!;
      if (top.indent <= dashIndent) {
        if (!top.isSeq && !top.hasValue) top.isSeq = true; // convert in place, first time only
        return; // either already/now a seq frame at or above this indent -- reuse it
      }
      stack.pop();
    }
  };
  const popOrdinary = (indent: number): void => {
    while (stack.length && stack[stack.length - 1]!.indent >= indent) stack.pop();
  };
  // Shared by KEY_LINE's inline `- key: value` form and the bare `-`-alone
  // form: converts/reuses the enclosing sequence frame, then pushes this
  // item's own `[idx]` frame at `itemFrameIndent` -- the caller picks that
  // value so it sits strictly between the sequence frame's own indent and
  // whatever the item's real children will be indented at (itemIndent - 1
  // for the inline form; dashIndent + 1 for the bare form, since a bare
  // marker's children are entirely on later lines with no itemIndent to
  // derive from).
  const enterListItem = (dashIndent: number, itemFrameIndent: number): void => {
    popToForListItem(dashIndent);
    let top = stack[stack.length - 1];
    if (!top || !top.isSeq) {
      top = { indent: dashIndent, key: "", isSeq: true, hasValue: false, nextIndex: 0 };
      stack.push(top);
    }
    const idx = top.nextIndex ?? 0;
    top.nextIndex = idx + 1;
    stack.push({ indent: itemFrameIndent, key: `[${idx}]`, isSeq: false, hasValue: false });
  };
  // Pops to a line's context (same rule an ordinary/list-item key line would
  // use) WITHOUT pushing a frame -- the line has no key of its own -- then
  // marks whatever container it now sits inside as unresolved. Used ONLY for
  // a line that IS real YAML structure the scanner just can't decode the key
  // of (a quoted key, a merge key) -- there, the line's indentation is
  // genuine, meaningful nesting depth. Always uses ordinary (non-list)
  // popping: its one call site never sees a list-marker-prefixed line (that
  // shape -- e.g. `- <<: *base` -- is a known, separate, non-blocking gap,
  // not something this function is meant to special-case).
  const markUnresolvedContainer = (indent: number): void => {
    popOrdinary(indent);
    unresolvedContainers.add(framePath(stack));
  };
  // A `{{ }}` action line's OWN indentation carries NO structural meaning:
  // `{{-` chomps it away entirely, and the extremely common `| indent N`
  // idiom REQUIRES the action to sit at column 0 while injecting content at
  // depth N. Popping the frame stack by that column (as an ordinary line
  // would) either taints the wrong ancestor container or, at column 0,
  // destroys every open frame -- reparenting every subsequent line in the
  // document to the root and losing all their field-paths. Never pop the
  // real stack for this; instead, conservatively taint every container
  // currently open (root down through the innermost), since the injection
  // could be targeting any of them and there is no way to tell which.
  const markAllOpenContainersUnresolved = (): void => {
    for (let depth = 0; depth <= stack.length; depth++) {
      unresolvedContainers.add(framePath(stack.slice(0, depth)));
    }
  };

  for (const line of text.split("\n")) {
    const lineStartChar = charOffset;
    charOffset += line.length + 1; // +1 for the \n split() consumed

    // Inside a `- |` item's body: these lines are script/config TEXT, so they
    // must never be read as field structure. Runs after the charOffset
    // bookkeeping above so skipped lines still advance the offset exactly --
    // every atChar/endChar after the block scalar depends on it.
    if (blockScalarSkipIndent !== null) {
      // A blank line is part of the block scalar (YAML lets a scalar body
      // contain empty lines at any indent), never its terminator.
      if (line.trim().length === 0) continue;
      if (BARE_TEMPLATE_LINE.test(line)) {
        // A `{{ }}` action line's own indentation carries no structural
        // meaning (`{{-` chomps it; the `| indent N` idiom puts the action at
        // column 0 -- see markAllOpenContainersUnresolved), so a column-0
        // action inside a script body must NOT be read as a dedent that ends
        // the skip and re-exposes the remaining body lines as fields. Taint
        // conservatively and stay in the skip: we cannot tell whether the
        // action sits inside the scalar or after it.
        markAllOpenContainersUnresolved();
        continue;
      }
      const indent = line.length - line.trimStart().length;
      if (indent > blockScalarSkipIndent) continue; // still the scalar's body
      blockScalarSkipIndent = null; // dedented out of the item -- real YAML again
    }

    if (BARE_TEMPLATE_LINE.test(line)) {
      markAllOpenContainersUnresolved();
      continue;
    }

    const bareListMarker = BARE_LIST_MARKER.exec(line);
    if (bareListMarker) {
      const dashIndent = bareListMarker[1]!.length;
      enterListItem(dashIndent, dashIndent + 1);
      continue;
    }

    // Checked BEFORE the KEY_LINE match: KEY_LINE can't match this shape
    // anyway (no colon), but without this branch it would land in the
    // unrecognized-line branch below and the body would be scanned as fields.
    const blockScalarItem = BLOCK_SCALAR_LIST_ITEM.exec(line);
    if (blockScalarItem && BLOCK_SCALAR_HEADER.test(stripTrailingComment(blockScalarItem[2]!).trim())) {
      const dashIndent = blockScalarItem[1]!.length;
      // It IS a real sequence item, so enter it exactly as the bare-marker
      // form does -- sibling items after this one must keep their indices.
      enterListItem(dashIndent, dashIndent + 1);
      blockScalarSkipIndent = dashIndent;
      continue;
    }

    const m = KEY_LINE.exec(line);
    if (!m) {
      // Any other non-blank, non-comment line is a shape this scanner can't
      // account for at all (a quoted key, a merge key, ...) -- see
      // unresolvedContainers' own comment above for why this can't be a
      // silent skip.
      const trimmed = line.trim();
      if (trimmed.length > 0 && !trimmed.startsWith("#")) {
        markUnresolvedContainer(line.length - line.trimStart().length);
      }
      continue;
    }
    const [, indentStr, listMarker, key, rawValue] = m;
    const dashIndent = indentStr!.length;
    const itemIndent = dashIndent + (listMarker?.length ?? 0);

    if (listMarker) {
      // itemIndent - 1: strictly between the seq frame's own indent and its
      // children's indent, so a sibling key within this item pops back to
      // (but never past) this frame.
      enterListItem(dashIndent, itemIndent - 1);
    } else {
      popOrdinary(dashIndent);
    }

    const value = stripTrailingComment(rawValue!).trim();
    const parentPath = framePath(stack);
    stack.push({ indent: itemIndent, key: key!, isSeq: false, hasValue: value.length > 0 });
    const path = framePath(stack);

    // A value that OPENS a flow collection (`{`/`[`, never a `{{` template
    // action) means this key's real content is flow syntax, possibly spread
    // over later lines -- a line-oriented scan can't see keys written on the
    // opening line itself (`selector: {app: x,` loses `app` entirely once a
    // later line like `tier: web` gets read as this key's only child). Same
    // rule as any other shape the scanner can't fully account for: mark it
    // unresolved rather than let a partially-seen map read as complete. Also
    // covers the single-line case (`selector: {app: x}`) harmlessly -- that
    // already returned null via "no children found", this just makes the
    // reason explicit instead of incidental.
    if ((value.startsWith("{") && !value.startsWith("{{")) || value.startsWith("[")) unresolvedContainers.add(path);
    // A block-scalar header taints the PARENT container, not this entry's own
    // path: the header is a LEAF value's header (e.g. `app: |-` under
    // `spec.selector`), and extractLiteralLabelMap only ever checks a
    // container's own path (spec.selector) for taint, never a leaf's --
    // tainting the leaf's path here would silently leave the map resolving
    // MINUS this one key, which is the same over-permissive risk as not
    // tainting at all. Checked on the raw (pre-quote-strip) value, same as
    // the flow-collection check above, so a genuine quoted `name: "|"` stays
    // a literal and isn't mistaken for an unterminated block scalar.
    if (BLOCK_SCALAR_HEADER.test(value)) { unresolvedContainers.add(parentPath); continue; }
    // A key written with NO value (`tier:`) creates a frame but never an
    // entry, so it is invisible to extractLiteralLabelMap -- which then
    // returns the map MINUS that key. For a flat string->string map
    // (selector/labels) a value-less direct child is either a null value or a
    // nested container; either way the key is silently absent, and a selector
    // short one key matches strictly MORE workloads than the real one -- the
    // same over-permissive failure as every other unresolved case here.
    // Recorded after the block-scalar branch above, which already taints the
    // parent for its own reason. Note `tier: ""` is NOT value-less: quotes
    // survive stripTrailingComment/trim, so it stays a literal empty string.
    if (value.length === 0) valuelessKeyParents.add(parentPath);

    if (value.length > 0) {
      const colonIdx = line.indexOf(":", dashIndent);
      const valueStartInLine = line.indexOf(value, colonIdx);
      const atChar = lineStartChar + valueStartInLine;
      const endChar = atChar + value.length;
      // Classify on the QUOTE-STRIPPED text, not the raw value: idiomatic
      // Helm text is pre-render, not valid YAML yet, so a template expression
      // routinely appears both bare (`name: {{ include "c.fullname" . }}`)
      // and wrapped in quotes elsewhere in the same chart (`name: "{{ include
      // "c.fullname" . }}"`, e.g. helm create's own test-connection.yaml
      // pattern). Both forms carry the identical expression text once quotes
      // are stripped -- classifying on the raw value would tag one "literal"
      // and the other "template", giving them different nameKeyText (L:/T:)
      // prefixes in indexer.ts and silently breaking the match between a
      // resource's own name and a quoted reference to it.
      //
      // A value like `prefix-{{ .Values.x }}` (template text NOT at the very
      // start) is still classified "literal" here, not "template" --
      // deliberately narrow, matching only the whole-value case. Matching
      // still stays correct either way: both a literal/literal and a
      // template/template comparison require the two sides' raw text to be
      // byte-identical, so a "prefix-{{ x }}" value only ever matches another
      // identical "prefix-{{ x }}" value, never a bare "{{ x }}" -- just via
      // the "literal" bucket instead of the "template" one.
      const unquoted = stripQuotes(value);
      entries.push({
        path,
        parentPath,
        key: key!,
        value: unquoted.startsWith("{{")
          ? { form: "template", sourceText: unquoted, atChar, endChar }
          : { form: "literal", value: unquoted, atChar, endChar },
      });
    }
    // A value-less key (e.g. `selector:`) needs no bookkeeping of its own
    // here: whatever follows it (a real nested mapping, a `{{ }}` block
    // injection, or an unrecognized line) is handled uniformly by the
    // BARE_TEMPLATE_LINE / "unrecognized line" branches above on ITS OWN
    // line, since that line's own popToForListItem/popOrdinary call pops
    // back to (but never past) this key's frame.
  }
  return { entries, unresolvedContainers, valuelessKeyParents };
}

function findEntry(entries: FieldPathEntry[], path: string): FieldPathEntry | undefined {
  return entries.find((e) => e.path === path);
}

/** The RFC 1123 DNS label a real Kubernetes namespace name must be -- the
 *  positive test literalNamespace applies (see there for why). */
const DNS_LABEL = /^[a-z0-9]([-a-z0-9]{0,61}[a-z0-9])?$/;

/** A namespace a reference can be MATCHED on, or null meaning UNKNOWN.
 *  Deliberately narrower than the ManifestNameRef literal/template split that
 *  names get: a name is a resolution KEY (a template's raw text matches
 *  another identical template's raw text, which is real evidence), whereas a
 *  namespace here is only ever a FILTER, and the product rule is that unknown
 *  matches anything. So a templated `namespace: {{ .Release.Namespace }}` is
 *  unknown rather than a `T:`-keyed literal -- two documents whose namespace
 *  renders identically must not be blocked from linking just because one
 *  spells it via a template and the other spells it out, and two DIFFERENT
 *  template expressions are not evidence of different namespaces either.
 *  Absent (no entry at all) and an explicit empty string are unknown for the
 *  same reason: neither names a namespace this scanner can compare.
 *
 *  The literal-ness test is therefore POSITIVE, not a list of excluded
 *  spellings: a value counts only when it already looks like the RFC 1123 DNS
 *  label a real namespace must be. One test then covers every shape the
 *  scanner cannot resolve, without a special case per spelling -- the scanner
 *  only tags a value "template" when the template action starts the value, so
 *  `namespace: app-{{ .Values.env }}` arrives here as a "literal" and would
 *  otherwise block edges against the very namespace it renders to; likewise
 *  YAML null spellings (`~`, `Null`), anchors and tags (`&ns prod`,
 *  `!!str prod`), uppercase, whitespace and empty. Blocking is the damaging
 *  direction (unknown never blocks an edge), so anything uncomparable is
 *  unknown.
 *
 *  `null` is the one spelling the regex admits but must still be rejected,
 *  since it is also the bare YAML null word. It is excluded explicitly rather
 *  than by inspecting quotes: stripQuotes runs in the scanner, so a genuinely
 *  quoted `namespace: "null"` is indistinguishable here -- and reading it as
 *  unknown errs in the conservative direction. */
function literalNamespace(entry: FieldPathEntry | undefined): string | null {
  if (!entry || entry.value.form !== "literal") return null;
  const value = entry.value.value;
  if (value === "null" || !DNS_LABEL.test(value)) return null;
  return value;
}

/** The namespace named at `path`, reading EVERY entry there rather than the
 *  first. A Helm `{{- if }} namespace: prod {{- else }} namespace: staging
 *  {{- end }}` emits both branches as entries on the same path, and taking
 *  findEntry's first one would read the document as confidently `prod` and
 *  block every edge to `staging`. Only an unambiguous agreement -- at least
 *  one entry, all of them the same literal -- is a namespace this scanner can
 *  compare; disagreement is unknown, like any other unresolved shape. */
function namespaceAt(entries: FieldPathEntry[], path: string): string | null {
  let agreed: string | null = null;
  let seen = false;
  for (const e of entries) {
    if (e.path !== path) continue;
    const ns = literalNamespace(e);
    if (ns === null) return null;
    if (seen && ns !== agreed) return null;
    agreed = ns;
    seen = true;
  }
  return agreed;
}

/** Namespace compatibility per the product rule: a MISSING (unknown) namespace
 *  matches anything; two DIFFERENT literal namespaces block the edge. */
export function namespacesCompatible(a: string | null, b: string | null): boolean {
  return a === null || b === null || a === b;
}

interface FieldPathSpec {
  /** Wildcarded path, e.g. "spec.template.spec.containers[].env[].valueFrom.secretKeyRef.name". */
  path: string;
  refKind: string;
}

/** Where a kind's pod spec lives -- factored once so container/volume field
 *  paths below aren't hand-duplicated per kind. */
export const POD_SPEC_PATH_BY_KIND: Record<string, string> = {
  Pod: "spec",
  Deployment: "spec.template.spec",
  StatefulSet: "spec.template.spec",
  DaemonSet: "spec.template.spec",
  Job: "spec.template.spec",
  CronJob: "spec.jobTemplate.spec.template.spec",
  // ReplicaSet embeds a pod spec the same shape as Deployment -- it's
  // allowlisted primarily as the dominant ownerReferences bearer (see
  // ALLOWED_KINDS above), but a hand-written ReplicaSet's own env/volume
  // references and pod-template labels are real and worth extracting too,
  // not silently dropped just because it's a secondary use case.
  ReplicaSet: "spec.template.spec",
};

const CONTAINER_REF_SUFFIXES: Array<{ suffix: string; refKind: string }> = [
  { suffix: "envFrom[].configMapRef.name", refKind: "ConfigMap" },
  { suffix: "envFrom[].secretRef.name", refKind: "Secret" },
  { suffix: "env[].valueFrom.configMapKeyRef.name", refKind: "ConfigMap" },
  { suffix: "env[].valueFrom.secretKeyRef.name", refKind: "Secret" },
];

// volumeClaimTemplates is deliberately excluded: on a StatefulSet it's a
// TEMPLATE the controller uses to create its own PVCs, not a reference to a
// separately-authored PersistentVolumeClaim resource elsewhere in the repo.
// Only volumes[].persistentVolumeClaim.claimName is a real reference.
const VOLUME_REF_SUFFIXES: Array<{ suffix: string; refKind: string }> = [
  { suffix: "volumes[].configMap.name", refKind: "ConfigMap" },
  { suffix: "volumes[].secret.secretName", refKind: "Secret" },
  { suffix: "volumes[].persistentVolumeClaim.claimName", refKind: "PersistentVolumeClaim" },
];

// Pod-spec-level (not container- or volume-scoped) references: a registry
// pull secret is a legitimate Secret reference, distinct from the
// container/volume-scoped ones above.
const POD_SPEC_REF_SUFFIXES: Array<{ suffix: string; refKind: string }> = [
  { suffix: "imagePullSecrets[].name", refKind: "Secret" },
];

function fieldSpecsForKind(kind: string): FieldPathSpec[] {
  const specs: FieldPathSpec[] = [];
  const podSpecPath = POD_SPEC_PATH_BY_KIND[kind];
  if (podSpecPath) {
    for (const containerList of ["containers[]", "initContainers[]"]) {
      for (const { suffix, refKind } of CONTAINER_REF_SUFFIXES) specs.push({ path: `${podSpecPath}.${containerList}.${suffix}`, refKind });
    }
    for (const { suffix, refKind } of VOLUME_REF_SUFFIXES) specs.push({ path: `${podSpecPath}.${suffix}`, refKind });
    for (const { suffix, refKind } of POD_SPEC_REF_SUFFIXES) specs.push({ path: `${podSpecPath}.${suffix}`, refKind });
  }
  if (kind === "Ingress") {
    specs.push({ path: "spec.rules[].http.paths[].backend.service.name", refKind: "Service" });
    specs.push({ path: "spec.defaultBackend.service.name", refKind: "Service" });
  }
  if (kind === "HTTPRoute") specs.push({ path: "spec.rules[].backendRefs[].name", refKind: "Service" });
  return specs;
}

/** The ONE reference shape in fieldSpecsForKind that Kubernetes lets point at
 *  another namespace: a Gateway API `backendRefs[]` entry carries an optional
 *  `namespace` SIBLING of its own `name`. Every other shape here
 *  (configMapRef/secretRef/volumes/imagePullSecrets/Ingress backend/
 *  ownerReferences) is same-namespace by API definition and has no namespace
 *  field at all, so none of them needs an override. Read off the concrete
 *  (non-wildcarded) entry list by exact parentPath -- the same
 *  pair-siblings-by-index technique extractOwnerReferenceCandidates uses --
 *  rather than new parsing machinery. */
const NAMESPACE_SIBLING_PATHS = new Set(["spec.rules[].backendRefs[]"]);

function extractFieldReferences(kind: string, entries: FieldPathEntry[], docNamespace: string | null): K8sReferenceCandidate[] {
  const specs = fieldSpecsForKind(kind);
  const out: K8sReferenceCandidate[] = [];
  for (const e of entries) {
    const wp = wildcardPath(e.path);
    const spec = specs.find((s) => s.path === wp);
    if (!spec) continue;
    // A sibling that EXISTS but isn't a comparable literal (templated, empty)
    // must read as unknown, NOT fall back to the document's namespace: it is
    // an explicit statement that the target lives somewhere this scanner
    // cannot name, which is the opposite of "same namespace as me". So the
    // sibling's existence is checked before its literal-ness.
    const siblingPath = `${e.parentPath}.namespace`;
    const hasSibling = NAMESPACE_SIBLING_PATHS.has(wildcardPath(e.parentPath)) && entries.some((c) => c.path === siblingPath);
    out.push({ refKind: spec.refKind, name: e.value, namespace: hasSibling ? namespaceAt(entries, siblingPath) : docNamespace });
  }
  return out;
}

/** ownerReferences' target kind is DATA (a sibling `.kind` field), not a fixed
 *  literal like every other refKind here -- this pairs each ownerReferences[N]
 *  list element's `.name` with its OWN `.kind` by concrete index, so two owner
 *  entries never get cross-paired. Not expressible via FieldPathSpec's
 *  single-fixed-refKind model, so it's a dedicated pass over the concrete
 *  (non-wildcarded) entries. */
function extractOwnerReferenceCandidates(entries: FieldPathEntry[], docNamespace: string | null): K8sReferenceCandidate[] {
  const byIndex = new Map<string, { name?: FieldPathEntry; kind?: FieldPathEntry }>();
  for (const e of entries) {
    const m = /^metadata\.ownerReferences(\[\d+\])\.(name|kind)$/.exec(e.path);
    if (!m) continue;
    const slot = byIndex.get(m[1]!) ?? {};
    slot[m[2] as "name" | "kind"] = e;
    byIndex.set(m[1]!, slot);
  }
  const out: K8sReferenceCandidate[] = [];
  for (const { name, kind } of byIndex.values()) {
    if (!name || !kind || kind.value.form !== "literal") continue; // an owner's kind must be a literal to type the reference at all
    // An ownerReferences entry has NO namespace field in the API at all -- an
    // owner is always in the owned object's own namespace (or cluster-scoped),
    // so the document's namespace is the only correct answer here.
    out.push({ refKind: kind.value.value, name: name.value, namespace: docNamespace });
  }
  return out;
}

export const LABELS_PATH_BY_KIND: Record<string, string> = {
  Deployment: "spec.template.metadata.labels",
  StatefulSet: "spec.template.metadata.labels",
  DaemonSet: "spec.template.metadata.labels",
  Job: "spec.template.metadata.labels",
  CronJob: "spec.jobTemplate.spec.template.metadata.labels",
  Pod: "metadata.labels",
  ReplicaSet: "spec.template.metadata.labels",
};

/** A literal label map at `prefix.<key>` for each direct child leaf. Returns
 *  null (not an empty map) when: the prefix itself is a block-form template
 *  injection (no literal keys exist to read at all), no direct-child leaf
 *  exists, or any direct-child leaf is itself templated -- a partially-literal
 *  map is still unusable for subset-match without evaluating the templated
 *  half, so the whole map is treated as unresolved. */
function extractLiteralLabelMap(prefix: string, entries: FieldPathEntry[], unresolvedContainers: Set<string>, valuelessKeyParents: Set<string>): ManifestLabelMap | null {
  if (unresolvedContainers.has(prefix)) return null;
  // A value-less direct child (`tier:`) never produced an entry at all, so the
  // map below would come back without it -- see valuelessKeyParents' comment
  // in scanFieldPaths for why a short map is the dangerous direction.
  if (valuelessKeyParents.has(prefix)) return null;
  // A real Kubernetes label/selector map is always flat (string -> string) --
  // any entry whose parentPath is a DEEPER descendant of prefix (not prefix
  // itself) means some direct child of prefix was itself a nested container
  // (block-form `team: {owner: p}`, invalid k8s but not rejected by this
  // scanner), which would otherwise just be silently absent from the flat
  // map returned below -- the same "dropped key makes the map more
  // permissive" risk as every other unresolved-container case here.
  if (entries.some((e) => e.parentPath !== prefix && e.parentPath.startsWith(`${prefix}.`))) return null;
  // Built via entries + Object.fromEntries, not plain `map[key] = value`
  // assignment: a label key of "__proto__" assigned that way is silently
  // swallowed by a plain object literal (it sets the prototype, not an own
  // property) while `found` still gets set true -- the result is an
  // empty-looking map that Object.entries() treats as vacuously satisfied by
  // every workload, i.e. a Service selecting everything. Not reachable via a
  // syntactically valid Kubernetes label key, but the blast radius (matches
  // EVERY workload, not just a wrong one) is disproportionate to how cheap
  // this guard is. Object.fromEntries's own key-setting is NOT the special
  // __proto__ accessor (verified: it creates a real own property, and the
  // result still has the normal Object.prototype -- Object.create(null)
  // would also close the hole but changes every map's prototype, which
  // breaks plain-object equality elsewhere).
  const pairs: Array<[string, string]> = [];
  for (const e of entries) {
    // Match on parentPath, never by slicing e.path on the prefix length: a
    // Kubernetes label key legitimately contains dots (app.kubernetes.io/
    // instance is the `helm create` default), which is indistinguishable
    // from nesting once folded into one dot-joined path string. parentPath
    // is computed structurally from the frame stack, so it's exact -- no
    // guessing by counting dots in what's left after the prefix.
    if (e.parentPath !== prefix) continue;
    if (e.value.form !== "template") pairs.push([e.key, e.value.value]);
    else return null; // any templated label value makes the whole map unusable for subset matching
  }
  return pairs.length > 0 ? Object.fromEntries(pairs) : null;
}

function buildDocument(text: string, docStartChar: number, entries: FieldPathEntry[], unresolvedContainers: Set<string>, valuelessKeyParents: Set<string>): K8sManifestDocument {
  const kindEntry = findEntry(entries, "kind");
  const kind = kindEntry?.value.form === "literal" ? kindEntry.value.value : null;
  if (!kind || !ALLOWED_KINDS.has(kind)) return { resource: null, references: [], selector: null, labels: null };

  // Found with the same entry machinery as metadata.name, so it inherits the
  // scanner's quote-stripping, comment-stripping and CRLF tolerance for free.
  // Read OUTSIDE the `resource` branch below: a document with no
  // metadata.name still emits references, and those references carry this
  // document's namespace.
  const namespace = namespaceAt(entries, "metadata.namespace");

  const nameEntry = findEntry(entries, "metadata.name");
  const resource: K8sResourceDoc | null = nameEntry
    ? { kind, name: nameEntry.value, namespace, startChar: docStartChar, endChar: docStartChar + text.length }
    : null;

  const references = [...extractFieldReferences(kind, entries, namespace), ...extractOwnerReferenceCandidates(entries, namespace)];
  const selector = kind === "Service" ? extractLiteralLabelMap("spec.selector", entries, unresolvedContainers, valuelessKeyParents) : null;
  const labelsPath = LABELS_PATH_BY_KIND[kind];
  const labels = labelsPath ? extractLiteralLabelMap(labelsPath, entries, unresolvedContainers, valuelessKeyParents) : null;
  return { resource, references, selector, labels };
}

// Matches a YAML document-start marker (`---`) or a document-end marker
// (`...`). Per the YAML spec `---` FOLLOWED BY WHITESPACE starts a document
// whatever trails it on that line -- a comment (`--- # second doc`), a tag
// (`--- !!map`), an anchor (`--- &base`) -- so the trailing text is matched
// generically rather than as a comment only. Without that, a tagged or
// anchored separator silently failed to split at all, merging two documents
// into one: the later document's fields overwrite the earlier one's (object
// spread order), and the earlier resource's symbol/edges vanish entirely.
// Whatever trails the marker is consumed WITH the boundary -- for a tag or
// anchor nothing is lost, and inline content written after the marker
// (`--- kind: Pod`, legal but vanishingly rare) is dropped, which errs toward
// fewer edges, this module's standing bias. `----` (four or more dashes) is
// deliberately NOT a separator -- real YAML doesn't treat it as one either,
// and it still isn't here: the dashes must be followed by whitespace or end
// of line.
const DOC_SEPARATOR = /^(?:---(?:[ \t]+.*)?|\.\.\.)[ \t]*\r?$/m;

export function extractK8sManifest(source: string): K8sManifestDocument[] {
  const docs: K8sManifestDocument[] = [];
  const boundaries: number[] = [];
  for (const m of source.matchAll(new RegExp(DOC_SEPARATOR, "gm"))) boundaries.push(m.index!, m.index! + m[0].length);
  const starts = [0, ...boundaries.filter((_, i) => i % 2 === 1)];
  const ends = [...boundaries.filter((_, i) => i % 2 === 0), source.length];
  for (let i = 0; i < starts.length; i++) {
    const start = starts[i]!;
    const end = ends[i]!;
    const text = source.slice(start, end);
    const { entries, unresolvedContainers, valuelessKeyParents } = scanFieldPaths(text, start);
    docs.push(buildDocument(text, start, entries, unresolvedContainers, valuelessKeyParents));
  }
  return docs;
}
