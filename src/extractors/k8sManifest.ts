import { posix } from "node:path";
import { eolLengthAt, sourceLines } from "../core/eol.js";

// Deterministic, line-oriented scan of Kubernetes manifests (possibly raw Helm
// template text) plus a small Kustomize namespace model. Template actions are
// never evaluated; whenever something cannot be decided the answer is null and
// no edge is better than a wrong edge. None of the exports throw.

export type ManifestNameRef =
  | { form: "literal"; value: string; atChar: number; endChar: number }
  | { form: "template"; sourceText: string; atChar: number; endChar: number };

export interface K8sManifestDocument {
  resource: { kind: string; name: ManifestNameRef; namespace: string | null; startChar: number; endChar: number } | null;
  references: Array<{ refKind: string; name: ManifestNameRef; namespace: string | null }>;
  selector: Record<string, string> | null;
  labels: Record<string, string> | null;
}

export interface KustomizationInfo {
  namespace: string | null;
  resources: string[];
}

export const POD_SPEC_PATH_BY_KIND: Record<string, string> = {
  Pod: "spec",
  Deployment: "spec.template.spec",
  StatefulSet: "spec.template.spec",
  DaemonSet: "spec.template.spec",
  Job: "spec.template.spec",
  ReplicaSet: "spec.template.spec",
  CronJob: "spec.jobTemplate.spec.template.spec",
};

export const LABELS_PATH_BY_KIND: Record<string, string> = {
  Pod: "metadata.labels",
  Deployment: "spec.template.metadata.labels",
  StatefulSet: "spec.template.metadata.labels",
  DaemonSet: "spec.template.metadata.labels",
  Job: "spec.template.metadata.labels",
  ReplicaSet: "spec.template.metadata.labels",
  CronJob: "spec.jobTemplate.spec.template.metadata.labels",
};

const KNOWN_KINDS: ReadonlySet<string> = new Set([
  "Deployment", "StatefulSet", "DaemonSet", "Job", "CronJob", "Pod", "ReplicaSet", "Service", "ConfigMap",
  "Secret", "PersistentVolumeClaim", "Ingress", "HTTPRoute",
]);

// Kinds a namespace transformer must leave alone. None is in KNOWN_KINDS today.
const CLUSTER_SCOPED_KINDS: ReadonlySet<string> = new Set([
  "Namespace", "Node", "PersistentVolume", "StorageClass", "CustomResourceDefinition", "ClusterRole",
  "ClusterRoleBinding", "PriorityClass", "IngressClass", "RuntimeClass", "MutatingWebhookConfiguration",
  "ValidatingWebhookConfiguration", "APIService",
]);

type PatternTable = Array<[string, string]>;

function podPatterns(spec: string): PatternTable {
  const out: PatternTable = [];
  for (const list of ["containers[]", "initContainers[]"]) {
    out.push(
      [`${spec}.${list}.envFrom[].configMapRef.name`, "ConfigMap"],
      [`${spec}.${list}.envFrom[].secretRef.name`, "Secret"],
      [`${spec}.${list}.env[].valueFrom.configMapKeyRef.name`, "ConfigMap"],
      [`${spec}.${list}.env[].valueFrom.secretKeyRef.name`, "Secret"],
    );
  }
  out.push(
    [`${spec}.volumes[].configMap.name`, "ConfigMap"],
    [`${spec}.volumes[].secret.secretName`, "Secret"],
    [`${spec}.volumes[].persistentVolumeClaim.claimName`, "PersistentVolumeClaim"],
    [`${spec}.imagePullSecrets[].name`, "Secret"],
  );
  return out;
}

const HTTPROUTE_BACKEND_NAME = "spec.rules[].backendRefs[].name";

const PATTERNS_BY_KIND = new Map<string, Map<string, string>>();
for (const [kind, spec] of Object.entries(POD_SPEC_PATH_BY_KIND)) PATTERNS_BY_KIND.set(kind, new Map(podPatterns(spec)));
PATTERNS_BY_KIND.set("Ingress", new Map([
  ["spec.rules[].http.paths[].backend.service.name", "Service"],
  ["spec.defaultBackend.service.name", "Service"],
]));
PATTERNS_BY_KIND.set("HTTPRoute", new Map([[HTTPROUTE_BACKEND_NAME, "Service"]]));

const DNS_LABEL = /^[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?$/u;
const BLOCK_HEADER = /^[|>](?:[+-]\d*|\d+[+-]?)?$/u;
const KEY_LINE = /^([ \t]*)(-[ \t]+)?([A-Za-z0-9_./-]+):[ \t]*([\s\S]*)$/u;
const BARE_TEMPLATE = /^[ \t]*(?:-[ \t]+)?\{\{/u;
const BARE_MARKER = /^([ \t]*)-[ \t]*$/u;
const MARKER_TEXT = /^([ \t]*)-[ \t]+([\s\S]+)$/u;
const SEPARATOR = /^(?:---(?:[ \t][\s\S]*)?|\.\.\.[ \t]*)$/u;

function isValidNamespace(value: string): boolean {
  return value !== "null" && DNS_LABEL.test(value);
}

function unquote(value: string): string {
  if (value.length >= 2 && (value[0] === '"' || value[0] === "'") && value[value.length - 1] === value[0]) {
    return value.slice(1, -1);
  }
  return value;
}

/** Drop a trailing YAML comment; quotes only open at a word start. */
function stripComment(value: string): string {
  let quote: string | null = null;
  for (let i = 0; i < value.length; i++) {
    const c = value[i]!;
    if (quote) {
      if (c === quote) quote = null;
      continue;
    }
    const wordStart = i === 0 || value[i - 1] === " " || value[i - 1] === "\t";
    if (!wordStart) continue;
    if (c === '"' || c === "'") quote = c;
    else if (c === "#") return value.slice(0, i);
  }
  return value;
}

function indentOf(line: string): number {
  let n = 0;
  while (n < line.length && (line[n] === " " || line[n] === "\t")) n++;
  return n;
}

function makeRef(value: string, at: number): ManifestNameRef {
  const inner = unquote(value);
  const endChar = at + value.length;
  return inner.startsWith("{{")
    ? { form: "template", sourceText: inner, atChar: at, endChar }
    : { form: "literal", value: inner, atChar: at, endChar };
}

interface Entry { path: string; parent: string; ref: ManifestNameRef }
interface Frame { kind: "key" | "seq" | "item"; indent: number; path: string; inline: boolean; next: number }
interface Scan { entries: Entry[]; tainted: Set<string>; valueless: Set<string> }

function scanDocument(docText: string, base: number): Scan {
  const entries: Entry[] = [];
  const tainted = new Set<string>();
  const valueless = new Set<string>();
  const stack: Frame[] = [];
  let skipBody: number | null = null; // dash column of a list-item block scalar

  const container = (): string => (stack.length ? stack[stack.length - 1]!.path : "");
  const closeFrom = (indent: number): void => {
    while (stack.length && stack[stack.length - 1]!.indent >= indent) stack.pop();
  };
  const taintOpen = (): void => {
    tainted.add("");
    for (const f of stack) tainted.add(f.path);
  };
  const openItem = (dash: number, itemIndent: number): void => {
    while (stack.length && stack[stack.length - 1]!.indent > dash) stack.pop();
    let seq = stack[stack.length - 1];
    if (seq && seq.kind === "key" && !seq.inline) {
      seq.kind = "seq";
      seq.next = 0;
    } else if (!seq || seq.kind !== "seq") {
      seq = { kind: "seq", indent: dash, path: seq ? seq.path : "", inline: true, next: 0 };
      stack.push(seq);
    }
    stack.push({ kind: "item", indent: itemIndent, path: `${seq.path}[${seq.next++}]`, inline: true, next: 0 });
  };

  for (const line of sourceLines(docText)) {
    const content = line.content;
    if (skipBody !== null) {
      if (content.trim() === "") continue;
      if (BARE_TEMPLATE.test(content)) {
        taintOpen();
        continue;
      }
      if (indentOf(content) > skipBody) continue;
      skipBody = null;
    }
    if (BARE_TEMPLATE.test(content)) {
      taintOpen();
      continue;
    }
    const bare = BARE_MARKER.exec(content);
    if (bare) {
      const dash = bare[1]!.length;
      openItem(dash, dash + 0.5); // children sit anywhere deeper than the dash
      continue;
    }
    const itemText = MARKER_TEXT.exec(content);
    if (itemText && BLOCK_HEADER.test(stripComment(itemText[2]!).trim())) {
      const dash = itemText[1]!.length;
      openItem(dash, dash + 1);
      skipBody = dash;
      continue;
    }
    const key = KEY_LINE.exec(content);
    if (key) {
      const indent = key[1]!.length;
      const keyCol = indent + (key[2]?.length ?? 0);
      if (key[2]) openItem(indent, keyCol - 1);
      closeFrom(keyCol);
      const parent = container();
      const path = parent ? `${parent}.${key[3]!}` : key[3]!;
      const value = stripComment(key[4]!).trim();
      let inline = true;
      if (value === "") {
        valueless.add(parent);
        inline = false;
      } else {
        if (value.startsWith("[") || (value.startsWith("{") && !value.startsWith("{{"))) tainted.add(path);
        if (BLOCK_HEADER.test(value)) {
          tainted.add(parent);
        } else {
          const colon = content.indexOf(":", indent);
          let pos = content.indexOf(value, colon + 1);
          if (pos < 0) pos = colon + 1;
          entries.push({ path, parent, ref: makeRef(value, base + line.start + pos) });
        }
      }
      stack.push({ kind: "key", indent: keyCol, path, inline, next: 0 });
      continue;
    }
    const trimmed = content.trim();
    if (trimmed === "" || trimmed.startsWith("#")) continue;
    closeFrom(indentOf(content));
    tainted.add(container());
  }
  return { entries, tainted, valueless };
}

/** Agreeing, valid, literal namespaces only; anything else is unknown. */
function resolveNamespace(refs: ManifestNameRef[]): string | null {
  if (refs.length === 0) return null;
  let found: string | null = null;
  for (const ref of refs) {
    if (ref.form !== "literal" || !isValidNamespace(ref.value)) return null;
    if (found !== null && found !== ref.value) return null;
    found = ref.value;
  }
  return found;
}

function labelMap(scan: Scan, at: string): Record<string, string> | null {
  if (scan.tainted.has(at) || scan.valueless.has(at)) return null;
  const prefix = `${at}.`;
  const out: Record<string, string> = {};
  let count = 0;
  for (const e of scan.entries) {
    if (e.parent.startsWith(prefix)) return null;
    if (e.parent !== at) continue;
    if (e.ref.form !== "literal") return null;
    Object.defineProperty(out, e.path.slice(prefix.length), { value: e.ref.value, enumerable: true, writable: true, configurable: true });
    count++;
  }
  return count === 0 ? null : out;
}

function assemble(scan: Scan, docStart: number, docText: string, opts: { namespace?: string | null } | undefined): K8sManifestDocument {
  const empty: K8sManifestDocument = { resource: null, references: [], selector: null, labels: null };
  const { entries } = scan;
  const kindEntry = entries.find((e) => e.path === "kind");
  if (!kindEntry || kindEntry.ref.form !== "literal" || !KNOWN_KINDS.has(kindEntry.ref.value)) return empty;
  const kind = kindEntry.ref.value;

  const byPath = new Map<string, Entry[]>();
  for (const e of entries) {
    const list = byPath.get(e.path);
    if (list) list.push(e);
    else byPath.set(e.path, [e]);
  }
  const refsAt = (path: string): ManifestNameRef[] => (byPath.get(path) ?? []).map((e) => e.ref);

  const override = opts?.namespace;
  const namespace = override !== undefined && !CLUSTER_SCOPED_KINDS.has(kind) ? override : resolveNamespace(refsAt("metadata.namespace"));

  const nameEntry = byPath.get("metadata.name")?.[0];
  const resource = nameEntry
    ? { kind, name: nameEntry.ref, namespace, startChar: docStart, endChar: docStart + docText.length }
    : null;

  const references: K8sManifestDocument["references"] = [];
  const patterns = PATTERNS_BY_KIND.get(kind);
  if (patterns) {
    for (const e of entries) {
      const refKind = patterns.get(e.path.replace(/\[\d+\]/gu, "[]"));
      if (!refKind) continue;
      let ns = namespace;
      if (kind === "HTTPRoute") {
        const sibling = refsAt(`${e.parent}.namespace`);
        if (sibling.length > 0) ns = resolveNamespace(sibling);
      }
      references.push({ refKind, name: e.ref, namespace: ns });
    }
  }

  const owners = new Map<string, { name?: ManifestNameRef; kind?: ManifestNameRef }>();
  const ownerPath = /^metadata\.ownerReferences\[(\d+)\]\.(name|kind)$/u;
  for (const e of entries) {
    const m = ownerPath.exec(e.path);
    if (!m) continue;
    const group = owners.get(m[1]!) ?? {};
    group[m[2] as "name" | "kind"] = e.ref;
    owners.set(m[1]!, group);
  }
  for (const g of owners.values()) {
    if (g.name && g.kind && g.kind.form === "literal") references.push({ refKind: g.kind.value, name: g.name, namespace });
  }

  const labelsPath = LABELS_PATH_BY_KIND[kind];
  return {
    resource,
    references,
    selector: kind === "Service" ? labelMap(scan, "spec.selector") : null,
    labels: labelsPath ? labelMap(scan, labelsPath) : null,
  };
}

export function extractK8sManifest(source: string, opts?: { namespace?: string | null }): K8sManifestDocument[] {
  // Split on separator lines, independent of YAML structure.
  const spans: Array<{ start: number; end: number }> = [];
  let start = 0;
  for (const line of sourceLines(source)) {
    if (!SEPARATOR.test(line.content)) continue;
    spans.push({ start, end: line.start });
    start = line.end + eolLengthAt(source, line.end);
  }
  spans.push({ start, end: source.length });
  return spans.map(({ start: s, end }) => {
    const docText = source.slice(s, end);
    return assemble(scanDocument(docText, s), s, docText, opts);
  });
}

export function namespacesCompatible(a: string | null, b: string | null): boolean {
  return a === null || b === null || a === b;
}

export function isKustomizationFile(path: string): boolean {
  return /(?:^|\/)(?:kustomization\.ya?ml|Kustomization)$/u.test(path);
}

export function extractKustomization(source: string): KustomizationInfo {
  let namespace: string | null = null;
  const resources: string[] = [];
  let inResources = false;
  for (const line of sourceLines(source)) {
    const text = stripComment(line.content).trimEnd();
    if (text === "") continue;
    if (inResources) {
      const item = /^[ \t]*-[ \t]+(\S[\s\S]*)$/u.exec(text);
      if (item) {
        resources.push(unquote(item[1]!.trim()));
        continue;
      }
    }
    if (/^[ \t]/u.test(text)) continue;
    inResources = false;
    const m = /^([A-Za-z]+):(?:[ \t]+([\s\S]*))?$/u.exec(text);
    if (!m) continue;
    const value = (m[2] ?? "").trim();
    if (m[1] === "namespace") {
      const ns = unquote(value);
      namespace = isValidNamespace(ns) ? ns : null;
    } else if (m[1] === "resources") {
      if (value === "") inResources = true;
      else if (value.startsWith("[") && value.endsWith("]")) {
        for (const part of value.slice(1, -1).split(",")) {
          const entry = unquote(part.trim());
          if (entry !== "") resources.push(entry);
        }
      }
    }
  }
  return { namespace, resources };
}

/**
 * Effective namespace per manifest file after Kustomize's namespace transformer.
 * A file reached with conflicting namespaces maps to null; a file that is only
 * ever kept as written (or never rendered) is absent.
 */
export function kustomizeNamespaces(kustomizations: ReadonlyMap<string, KustomizationInfo>, files: ReadonlySet<string>): Map<string, string | null> {
  const filesOf = new Map<string, string[]>();
  const basesOf = new Map<string, string[]>();
  const referenced = new Set<string>();
  for (const [dir, info] of kustomizations) {
    const ownFiles: string[] = [];
    const bases: string[] = [];
    for (const entry of info.resources) {
      if (entry === "") continue;
      let resolved = posix.join(dir, entry).replace(/\/+$/u, "");
      if (resolved === ".") resolved = "";
      if (resolved === ".." || resolved.startsWith("../")) continue;
      if (files.has(resolved)) ownFiles.push(resolved);
      else if (kustomizations.has(resolved) && resolved !== dir) {
        bases.push(resolved);
        referenced.add(resolved);
      }
    }
    filesOf.set(dir, ownFiles);
    basesOf.set(dir, bases);
  }

  // null stands for "keep as written".
  const seen = new Set<string>();
  const recorded = new Map<string, Set<string | null>>();
  const render = (dir: string, outer: string | null): void => {
    const key = `${dir}\u0000${outer ?? ""}`;
    if (seen.has(key)) return;
    seen.add(key);
    const effective = outer ?? kustomizations.get(dir)!.namespace;
    for (const file of filesOf.get(dir)!) {
      const set = recorded.get(file) ?? new Set<string | null>();
      set.add(effective);
      recorded.set(file, set);
    }
    for (const base of basesOf.get(dir)!) render(base, effective);
  };
  for (const dir of kustomizations.keys()) if (!referenced.has(dir)) render(dir, null);

  const out = new Map<string, string | null>();
  for (const [file, set] of recorded) {
    if (set.size > 1) out.set(file, null);
    else {
      const only = [...set][0]!;
      if (only !== null) out.set(file, only);
    }
  }
  return out;
}
