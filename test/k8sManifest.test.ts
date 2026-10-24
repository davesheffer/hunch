import { test } from "node:test";
import assert from "node:assert/strict";
import {
  extractK8sManifest, extractKustomization, isKustomizationFile, kustomizeNamespaces, namespacesCompatible,
  POD_SPEC_PATH_BY_KIND, LABELS_PATH_BY_KIND, type K8sManifestDocument, type ManifestNameRef,
} from "../src/extractors/k8sManifest.js";

const y = (...lines: string[]): string => lines.join("\n") + "\n";
const text = (r: ManifestNameRef): string => (r.form === "literal" ? r.value : r.sourceText);
const refs = (d: K8sManifestDocument): string[][] => d.references.map((r) => [r.refKind, text(r.name)]);
const one = (s: string, opts?: { namespace?: string | null }): K8sManifestDocument => {
  const docs = extractK8sManifest(s, opts);
  assert.equal(docs.length, 1);
  return docs[0]!;
};

const depHead = ["apiVersion: apps/v1", "kind: Deployment", "metadata:", "  name: my-app", "spec:", "  template:", "    spec:", "      containers:"];
const dep = (...tail: string[]): string => y(...depHead, ...tail);
const cm = (name: string): string => y("apiVersion: v1", "kind: ConfigMap", "metadata:", `  name: ${name}`);

test("1/5: literal resource with offsets, quoted literal", () => {
  const src = y("apiVersion: apps/v1", "kind: Deployment", "metadata:", "  name: my-app");
  const r = one(src).resource!;
  assert.equal(r.kind, "Deployment");
  const at = src.indexOf("my-app");
  assert.deepEqual(r.name, { form: "literal", value: "my-app", atChar: at, endChar: at + 6 });
  assert.equal(r.startChar, 0);
  assert.equal(r.endChar, src.length);
  const q = one(cm('"my-config"')).resource!.name;
  assert.equal(q.form === "literal" && q.value, "my-config");
  assert.equal(q.endChar - q.atChar, '"my-config"'.length);
});

test("2/55: template names, quoted or not, are identical", () => {
  const t = '{{ include "chart.fullname" . }}';
  const a = one(cm(t)).resource!.name;
  assert.deepEqual([a.form, text(a)], ["template", t]);
  const b = one(y("kind: Secret", "metadata:", `  name: ${t}`)).resource!.name;
  const c = one(y("kind: Deployment", "metadata:", `  name: "{{ include "mychart.fullname" . }}"`)).resource!.name;
  const d = one(y("kind: Secret", "metadata:", `  name: {{ include "mychart.fullname" . }}`)).resource!.name;
  assert.equal(b.form, "template");
  assert.deepEqual([c.form, text(c)], [d.form, text(d)]);
  assert.equal(text(c), '{{ include "mychart.fullname" . }}');
});

test("3/78: unlisted, templated, or missing kinds give no resource", () => {
  for (const k of ["kind: MyCustomResource", "kind: Namespace", "kind: {{ .Values.k }}", "foo: bar", "kind: deployment"]) {
    const d = one(y("apiVersion: v1", k, "metadata:", "  name: x"));
    assert.deepEqual(d, { resource: null, references: [], selector: null, labels: null });
  }
});

test("4/30/49/50/51/74/75/76: document splitting", () => {
  const two = extractK8sManifest(`${cm("cm-one")}---\n${y("kind: Secret", "metadata:", "  name: sec-one")}`);
  assert.deepEqual(two.map((d) => d.resource?.kind), ["ConfigMap", "Secret"]);
  assert.ok(two[1]!.resource!.startChar >= `${cm("cm-one")}`.length);
  const lead = extractK8sManifest(`---\n${cm("a")}`);
  assert.equal(lead.length, 2);
  assert.equal(lead[0]!.resource, null);
  assert.equal(lead[1]!.resource?.kind, "ConfigMap");
  assert.deepEqual(extractK8sManifest(`${cm("a")}--- # the second doc\n${y("kind: Service", "metadata:", "  name: s")}`).map((d) => d.resource?.kind), ["ConfigMap", "Service"]);
  const trailing = extractK8sManifest(`${cm("a")}...\n`);
  assert.equal(trailing.length, 2);
  assert.equal(trailing[0]!.resource?.kind, "ConfigMap");
  assert.equal(extractK8sManifest(`${cm("a")}----\nspec: {}\n`).length, 1);
  assert.equal(extractK8sManifest(`${cm("a")}----\n\n`).length, 1);
  for (const sep of ["--- !!map", "--- &base", "---   ", "...  "]) {
    const docs = extractK8sManifest(`${cm("cm-one")}${sep}\n${y("kind: Secret", "metadata:", "  name: sec-one")}`);
    assert.deepEqual(docs.map((d) => d.resource?.kind), ["ConfigMap", "Secret"], sep);
  }
  for (const notSep of ["---x", "  ---", "... text"]) assert.equal(extractK8sManifest(`${cm("a")}${notSep}\n`).length, 1, notSep);
  const block = y("kind: ConfigMap", "metadata:", "  name: c", "data:", "  s: |", "    --- !!map", "    x: y");
  assert.equal(extractK8sManifest(block).length, 1);
});

test("6/11/46/47: template-injected lines do not hide later fields", () => {
  const d = one(y("kind: Deployment", "metadata:", "  name: my-app", "  labels:", "    {{- include \"x.labels\" . | nindent 4 }}", "spec:", "  template:", "    spec:", "      containers:", "      - name: app", "        env:", "        - name: X", "          valueFrom:", "            secretKeyRef:", "              name: my-secret"));
  assert.equal(d.resource?.kind, "Deployment");
  assert.equal(d.resource?.name.form === "literal" && d.resource.name.value, "my-app");
  assert.deepEqual(refs(d), [["Secret", "my-secret"]]);
  for (const pad of ["", "    ", "        "]) {
    const src = dep("      - name: app", "        envFrom:", `${pad}{{- if true }}`, "        - configMapRef:", "            name: my-config", `${pad}{{- end }}`);
    assert.deepEqual(refs(one(src)), [["ConfigMap", "my-config"]], JSON.stringify(pad));
  }
  const both = dep("      - name: app", "        env:", "{{- if .Values.x }}", "        - name: X", "          valueFrom:", "            secretKeyRef:", "              name: my-secret", "{{- end }}", "        envFrom:", "        - configMapRef:", "            name: my-config");
  assert.deepEqual(refs(one(both)), [["Secret", "my-secret"], ["ConfigMap", "my-config"]]);
});

test("7-9/12/13/63-65: reference shapes and list styles", () => {
  assert.deepEqual(refs(one(dep("      - name: app", "        env:", "          - name: X", "            valueFrom:", "              secretKeyRef:", "                name: my-secret"))), [["Secret", "my-secret"]]);
  assert.deepEqual(refs(one(dep("      - name: app", "        envFrom:", "        - configMapRef:", "            name: my-config"))), [["ConfigMap", "my-config"]]);
  const pod = y("kind: Pod", "metadata:", "  name: p", "spec:", "  containers:", "  - name: c", "  volumes:", "  - name: data", "    secret:", "      secretName: my-secret");
  assert.deepEqual(refs(one(pod)), [["Secret", "my-secret"]]);
  const two = dep("      - name: a", "        env:", "        - name: X", "          valueFrom:", "            secretKeyRef:", "              name: secret-a", "      - name: b", "        env:", "        - name: Y", "          valueFrom:", "            secretKeyRef:", "              name: secret-b");
  assert.deepEqual(refs(one(two)), [["Secret", "secret-a"], ["Secret", "secret-b"]]);
  const pvc = y("kind: Deployment", "metadata:", "  name: d", "spec:", "  template:", "    spec:", "      volumes:", "      - name: data", "        persistentVolumeClaim:", "          claimName: my-pvc");
  assert.deepEqual(refs(one(pvc)), [["PersistentVolumeClaim", "my-pvc"]]);
  const bare = dep("      -", "        name: app", "        envFrom:", "        - configMapRef:", "            name: app-config");
  assert.deepEqual(refs(one(bare)), [["ConfigMap", "app-config"]]);
  const mixed = dep("      -", "        name: main", "        envFrom:", "        - configMapRef:", "            name: config-a", "      - name: sidecar", "        envFrom:", "        - configMapRef:", "            name: config-b");
  assert.deepEqual(refs(one(mixed)), [["ConfigMap", "config-a"], ["ConfigMap", "config-b"]]);
  const ips = y("kind: Deployment", "metadata:", "  name: d", "spec:", "  template:", "    spec:", "      imagePullSecrets:", "      - name: my-registry-secret");
  assert.deepEqual(refs(one(ips)), [["Secret", "my-registry-secret"]]);
  const init = y("kind: Pod", "metadata:", "  name: p", "spec:", "  initContainers:", "  - name: i", "    envFrom:", "    - secretRef:", "        name: s1");
  assert.deepEqual(refs(one(init)), [["Secret", "s1"]]);
  const vct = y("kind: StatefulSet", "metadata:", "  name: s", "spec:", "  volumeClaimTemplates:", "  - metadata:", "      name: data", "    spec:", "      claimName: nope");
  assert.deepEqual(refs(one(vct)), []);
});

test("10: templated reference name", () => {
  const d = one(dep("      - name: app", "        env:", "        - name: X", "          valueFrom:", "            secretKeyRef:", '              name: {{ include "chart.secretName" . }}'));
  assert.deepEqual(refs(d), [["Secret", '{{ include "chart.secretName" . }}']]);
  assert.equal(d.references[0]!.name.form, "template");
});

test("14/15: ownerReferences are paired per item", () => {
  const rs = y("kind: ReplicaSet", "metadata:", "  name: rs", "  ownerReferences:", "  - apiVersion: apps/v1", "    kind: Deployment", "    name: my-app");
  assert.deepEqual(refs(one(rs)), [["Deployment", "my-app"]]);
  const pod = y("kind: Pod", "metadata:", "  name: p", "  ownerReferences:", "  - kind: ReplicaSet", "    name: owner-one", "  - name: owner-two", "    kind: Job");
  assert.deepEqual(refs(one(pod)), [["ReplicaSet", "owner-one"], ["Job", "owner-two"]]);
  const half = y("kind: Pod", "metadata:", "  name: p", "  ownerReferences:", "  - kind: Job", "  - name: orphan");
  assert.deepEqual(refs(one(half)), []);
});

test("16/17/44: ingress, httproute, replicaset", () => {
  const ing = y("kind: Ingress", "metadata:", "  name: i", "spec:", "  rules:", "  - http:", "      paths:", "      - backend:", "          service:", "            name: my-service");
  assert.deepEqual(refs(one(ing)), [["Service", "my-service"]]);
  const def = y("kind: Ingress", "metadata:", "  name: i", "spec:", "  defaultBackend:", "    service:", "      name: dflt");
  assert.deepEqual(refs(one(def)), [["Service", "dflt"]]);
  const route = y("kind: HTTPRoute", "metadata:", "  name: r", "spec:", "  rules:", "  - backendRefs:", "    - name: my-service", "      port: 80");
  assert.deepEqual(refs(one(route)), [["Service", "my-service"]]);
  const rs = y("kind: ReplicaSet", "metadata:", "  name: r", "spec:", "  template:", "    spec:", "      containers:", "      - name: c", "        envFrom:", "        - configMapRef:", "            name: cfg");
  assert.deepEqual(refs(one(rs)), [["ConfigMap", "cfg"]]);
});

test("18-25/45: selector and labels", () => {
  const svc = (...sel: string[]): string => y("kind: Service", "metadata:", "  name: s", "spec:", "  selector:", ...sel);
  assert.deepEqual(one(svc("    app: my-app", "    tier: web")).selector, { app: "my-app", tier: "web" });
  assert.equal(one(svc('    {{- include "x.selector" . | nindent 4 }}')).selector, null);
  assert.equal(one(svc("    app: {{ .Values.name }}", "    tier: web")).selector, null);
  const d = y("kind: Deployment", "metadata:", "  name: d", "spec:", "  template:", "    metadata:", "      labels:", "        app: my-app", "        tier: web", "    spec:", "      containers:", "      - name: c");
  assert.deepEqual(one(d).labels, { app: "my-app", tier: "web" });
  assert.equal(one(d).selector, null);
  assert.equal(one(d.replace("tier: web", "tier: {{ .Values.t }}")).labels, null);
  assert.equal(one(y("kind: Deployment", "spec:", "  template:", "    metadata:", "      labels:", '        {{- include "l" . | nindent 8 }}')).labels, null);
  assert.deepEqual(one(y("kind: Pod", "metadata:", "  name: p", "  labels:", "    app: my-app")).labels, { app: "my-app" });
  assert.deepEqual(one(y("kind: Pod", "metadata:", "  name: p", "  labels:  # no literal labels here", "    app: my-app")).labels, { app: "my-app" });
  const rs = y("kind: ReplicaSet", "metadata:", "  name: r", "spec:", "  template:", "    metadata:", "      labels:", "        app: my-app", "    spec:", "      containers:", "      - name: c");
  assert.deepEqual(one(rs).labels, { app: "my-app" });
  const bare = one(cm("c"));
  assert.deepEqual([bare.selector, bare.labels], [null, null]);
});

test("22: both path tables share their key set", () => {
  assert.deepEqual(Object.keys(POD_SPEC_PATH_BY_KIND).sort(), Object.keys(LABELS_PATH_BY_KIND).sort());
  assert.equal(POD_SPEC_PATH_BY_KIND.CronJob, "spec.jobTemplate.spec.template.spec");
  assert.equal(LABELS_PATH_BY_KIND.Pod, "metadata.labels");
});

test("26-28/37: comment stripping", () => {
  const n = (v: string): ManifestNameRef => one(cm(v)).resource!.name;
  assert.equal(text(n("my-config  # app settings")), "my-config");
  assert.equal(text(n('"my-config#not-a-comment"')), "my-config#not-a-comment");
  assert.equal(text(n('{{ .Values.color | default "#fff" }}')), '{{ .Values.color | default "#fff" }}');
  assert.equal(text(n("it's-fine  # a real comment")), "it's-fine");
  assert.equal(text(n("my-config#x")), "my-config#x");
  const d = one(dep("      - name: app", "        envFrom:", "        - configMapRef:", "            name: my-config  # c"));
  assert.deepEqual(refs(d), [["ConfigMap", "my-config"]]);
});

test("31/52-54: flow collections give null", () => {
  const svc = (...sel: string[]): string => y("kind: Service", "metadata:", "  name: s", "spec:", ...sel);
  assert.equal(one(svc("  selector: {app: my-app}")).selector, null);
  assert.equal(one(svc("  selector: {app: web-frontend,", "    tier: web", "  }")).selector, null);
  assert.equal(one(svc("  selector: [a]")).selector, null);
  assert.equal(one(y("kind: Pod", "metadata:", "  name: p", "  labels: {app: x,", "    tier: y}")).labels, null);
});

test("32: block scalar body is opaque", () => {
  const src = y("kind: ConfigMap", "metadata:", "  name: my-config", "data:", "  embedded.yaml: |", "    kind: Deployment", "    metadata:", "      name: not-a-real-resource");
  const d = one(src);
  assert.equal(d.resource?.kind, "ConfigMap");
  assert.equal(text(d.resource!.name), "my-config");
});

test("33-36/41-43: dotted keys, quoted keys, taint locality", () => {
  const svc = (...sel: string[]): string => y("kind: Service", "metadata:", "  name: s", "spec:", "  selector:", ...sel);
  assert.deepEqual(one(svc("    app.kubernetes.io/name: my-app", "    app.kubernetes.io/instance: prod")).selector, { "app.kubernetes.io/name": "my-app", "app.kubernetes.io/instance": "prod" });
  const pod = y("kind: Pod", "metadata:", "  name: p", "  labels:", "    app.kubernetes.io/name: my-app");
  assert.deepEqual(one(pod).labels, { "app.kubernetes.io/name": "my-app" });
  assert.equal(one(svc("    app: my-app", "    {{- include \"x\" . | nindent 4 }}")).selector, null);
  assert.equal(one(svc('    "app.kubernetes.io/name": mychart')).selector, null);
  assert.equal(one(y("kind: Deployment", "spec:", "  template:", "    metadata:", "      labels:", "        <<: *commonLabels", "        app: x")).labels, null);
  assert.deepEqual(one(y("kind: Service", "metadata:", "  name: s", '  "weird-quoted-key": value', "spec:", "  selector:", "    app: my-app")).selector, { app: "my-app" });
  assert.equal(one(svc("    app: my-app", "{{- if .Values.x }}", "    track: stable", "{{- end }}")).selector, null);
  const dep2 = y("kind: Deployment", "metadata:", "  name: d", "spec:", "  template:", "    metadata:", "      labels:", "        instance: staging");
  assert.deepEqual(one(dep2).labels, { instance: "staging" });
});

test("38-40: line endings", () => {
  const lf = dep("      - name: app", "        envFrom:", "        - configMapRef:", "            name: my-config");
  const crlf = lf.replace(/\n/g, "\r\n");
  const a = one(lf);
  const b = one(crlf);
  assert.equal(b.resource?.kind, a.resource?.kind);
  assert.equal(text(b.resource!.name), text(a.resource!.name));
  assert.deepEqual(refs(b), refs(a));
  const mixed = "apiVersion: v1\r\nkind: ConfigMap\rmetadata:\n  name: mixed\r\n";
  const at = mixed.indexOf("mixed");
  assert.deepEqual(one(mixed).resource!.name, { form: "literal", value: "mixed", atChar: at, endChar: at + 5 });
  const svc = y("kind: Service", "metadata:", "  name: s", "spec:", "  selector:", "    app: my-app").replace(/\n/g, "\r\n");
  assert.deepEqual(one(svc).selector, { app: "my-app" });
  assert.equal(one(y("kind: ConfigMap", "metadata:", "  name: c", "  namespace: prod").replace(/\n/g, "\r\n")).resource?.namespace, "prod");
});

test("56-60/66-70: block scalars", () => {
  assert.equal(one(y("kind: ConfigMap", "metadata:", "  name: |-", "    real-config")).resource, null);
  const ref = dep("      - name: app", "        envFrom:", "        - configMapRef:", "            name: |-", "              body");
  assert.deepEqual(refs(one(ref)), []);
  assert.equal(one(y("kind: Service", "metadata:", "  name: s", "spec:", "  selector:", "    app: |-", "      web", "    tier: api")).selector, null);
  for (const h of ["|", "|-", "|+", "|2", "|2-", "|-2", ">", ">-", ">+"]) {
    assert.equal(one(y("kind: ConfigMap", "metadata:", `  name: ${h}`, "  other: x")).resource, null, h);
  }
  const q = one(y("kind: ConfigMap", "metadata:", '  name: "|"')).resource!.name;
  assert.equal(q.form === "literal" && q.value, "|");
  const job = (...extra: string[]): string => y("kind: Job", "metadata:", "  name: j", "spec:", "  template:", "    spec:", "      containers:", "      - name: main", "        args:", "        - |", "          cat <<EOF", "          env:", "          - name: X", "            valueFrom:", "              secretKeyRef:", "                name: prod-db-creds", "          EOF", ...extra);
  const j = one(job());
  assert.equal(j.resource?.kind, "Job");
  assert.deepEqual(refs(j), []);
  const j2 = one(job("      - name: sidecar", "        env:", "        - name: Y", "          valueFrom:", "            secretKeyRef:", "              name: real-secret"));
  assert.deepEqual(refs(j2), [["Secret", "real-secret"]]);
  const j3 = one(y("kind: Job", "metadata:", "  name: j", "spec:", "  template:", "    spec:", "      containers:", "      - name: main", "        args:", "        - |", "          before", "{{- if .Values.x }}", "          secretKeyRef:", "            name: prod-db-creds"));
  assert.deepEqual(refs(j3), []);
  const deeper = y("kind: Job", "metadata:", "  name: j", "spec:", "  template:", "    spec:", "      containers:", "      - name: main", "        args:", "          - |-", "            secretKeyRef:", "              name: a", "          - >", "            secretKeyRef:", "              name: b");
  assert.deepEqual(refs(one(deeper)), []);
  const cmt = y("kind: Job", "metadata:", "  name: j", "spec:", "  template:", "    spec:", "      containers:", "      - name: main", "        args:", "        - | # entrypoint script", "          secretKeyRef:", "            name: a");
  assert.deepEqual(refs(one(cmt)), []);
});

test("61/71-73/62: value-less keys and empty strings", () => {
  const svc = (...sel: string[]): string => y("kind: Service", "metadata:", "  name: s", "spec:", "  selector:", ...sel);
  assert.equal(one(svc("    app: web", "    team:", "    owner: p")).selector, null);
  assert.equal(one(svc("    tier:", "    app: web")).selector, null);
  assert.equal(one(svc("    tier: # todo: pick one", "    app: web")).selector, null);
  assert.deepEqual(one(svc('    tier: ""', "    app: web")).selector, { tier: "", app: "web" });
  const proto = one(svc("    __proto__: web")).selector!;
  assert.ok(Object.prototype.hasOwnProperty.call(proto, "__proto__"));
  assert.equal(Object.getOwnPropertyDescriptor(proto, "__proto__")!.value, "web");
  assert.equal(Object.getPrototypeOf(one(svc("    a: b")).selector), Object.prototype);
  const d = y("kind: Deployment", "spec:", "  template:", "    metadata:", "      labels:", "        tier:", "        app: web");
  assert.equal(one(d).labels, null);
});

test("77-79: document namespace", () => {
  const ns = (v: string | null): string | null => one(y("kind: ConfigMap", "metadata:", "  name: c", ...(v === null ? [] : [`  namespace:${v}`]))).resource!.namespace;
  assert.equal(ns(" prod"), "prod");
  for (const v of [null, ' ""', "", " {{ .Release.Namespace }}", " app-{{ .Values.env }}", " null", " Null", " NULL", " ~", " &ns prod", " !!str prod", " Prod"]) {
    assert.equal(ns(v), null, String(v));
  }
  for (const v of [' "prod"', " prod  # where it lives"]) assert.equal(ns(v), "prod", v);
  const branches = (a: string, b: string): string => y("kind: ConfigMap", "metadata:", "  name: c", "{{- if true }}", `  namespace: ${a}`, "{{- else }}", `  namespace: ${b}`, "{{- end }}");
  assert.equal(one(branches("prod", "staging")).resource!.namespace, null);
  assert.equal(one(branches("prod", "prod")).resource!.namespace, "prod");
});

test("80-83: reference namespaces and override", () => {
  const d = one(y("kind: Deployment", "metadata:", "  name: d", "  namespace: prod", "spec:", "  template:", "    spec:", "      containers:", "      - name: c", "        envFrom:", "        - configMapRef:", "            name: cfg"));
  assert.equal(d.references.length, 1);
  assert.equal(d.references[0]!.namespace, "prod");
  const route = (sib: string[]): string => y("kind: HTTPRoute", "metadata:", "  name: r", "  namespace: prod", "spec:", "  rules:", "  - backendRefs:", "    - name: svc", ...sib);
  assert.equal(one(route(["      namespace: other"])).references[0]!.namespace, "other");
  assert.equal(one(route([])).references[0]!.namespace, "prod");
  assert.equal(one(route(["      namespace: {{ .Values.ns }}"])).references[0]!.namespace, null);
  const r83 = y("kind: HTTPRoute", "metadata:", "  name: r", "  namespace: staging", "spec:", "  rules:", "  - backendRefs:", "    - name: a", "    - name: b", "      namespace: shared");
  const withProd = one(r83, { namespace: "prod" });
  assert.equal(withProd.resource!.namespace, "prod");
  assert.deepEqual(withProd.references.map((r) => r.namespace), ["prod", "shared"]);
  assert.equal(one(r83, { namespace: null }).resource!.namespace, null);
  assert.equal(one(r83).resource!.namespace, "staging");
});

test("84: extractKustomization", () => {
  assert.deepEqual(extractKustomization(y('namespace: "prod" # env', "resources:", "- a.yaml", "- ../base", "patches:", "- path: p.yaml")), { namespace: "prod", resources: ["a.yaml", "../base"] });
  assert.deepEqual(extractKustomization("resources: [a.yaml, 'b.yaml']\r\n"), { namespace: null, resources: ["a.yaml", "b.yaml"] });
  assert.equal(extractKustomization("namespace: Not_Valid\n").namespace, null);
  assert.equal(extractKustomization("namespace: null\n").namespace, null);
  assert.deepEqual(extractKustomization(""), { namespace: null, resources: [] });
});

test("85: kustomizeNamespaces", () => {
  const map = kustomizeNamespaces(
    new Map([
      ["base", { namespace: "base-ns", resources: ["svc.yaml"] }],
      ["overlays/dev", { namespace: "dev", resources: ["../../base"] }],
      ["overlays/prod", { namespace: "prod", resources: ["../../base/"] }],
      ["solo/base", { namespace: null, resources: ["cm.yaml"] }],
      ["solo/overlay", { namespace: "prod", resources: ["../base"] }],
      ["plain", { namespace: null, resources: ["x.yaml"] }],
    ]),
    new Set(["base/svc.yaml", "solo/base/cm.yaml", "plain/x.yaml"]),
  );
  assert.ok(map.has("base/svc.yaml"));
  assert.equal(map.get("base/svc.yaml"), null);
  assert.equal(map.get("solo/base/cm.yaml"), "prod");
  assert.equal(map.has("plain/x.yaml"), false);
  const cyc = kustomizeNamespaces(new Map([["a", { namespace: "x", resources: ["../b", "f.yaml"] }], ["b", { namespace: "y", resources: ["../a"] }]]), new Set(["a/f.yaml"]));
  assert.equal(cyc.size, 0);
  const esc = kustomizeNamespaces(new Map([["", { namespace: "r", resources: ["../x.yaml", "a.yaml", "./"] }]]), new Set(["a.yaml", "../x.yaml"]));
  assert.deepEqual([...esc], [["a.yaml", "r"]]);
});

test("86: span stability across positions and line endings", () => {
  for (const eol of ["\n", "\r\n"]) {
    const a = `kind: ConfigMap${eol}metadata:${eol}  name: a${eol}`;
    const b = `kind: Secret${eol}metadata:${eol}  name: b${eol}`;
    const s1 = `${a}---${eol}${b}`;
    assert.deepEqual(extractK8sManifest(s1).map((d) => s1.slice(d.resource!.startChar, d.resource!.endChar)), [a, b]);
    const s2 = `${b}--- # tagged${eol}${a}`;
    assert.deepEqual(extractK8sManifest(s2).map((d) => s2.slice(d.resource!.startChar, d.resource!.endChar)), [b, a]);
  }
});

test("3/helpers: namespacesCompatible, isKustomizationFile, totality", () => {
  assert.equal(namespacesCompatible(null, "a"), true);
  assert.equal(namespacesCompatible("a", null), true);
  assert.equal(namespacesCompatible("a", "a"), true);
  assert.equal(namespacesCompatible("a", "b"), false);
  for (const p of ["kustomization.yaml", "x/kustomization.yml", "a/b/Kustomization"]) assert.equal(isKustomizationFile(p), true, p);
  for (const p of ["foo-kustomization.yaml", "kustomization.YAML", "x/kustomization.yaml.bak"]) assert.equal(isKustomizationFile(p), false, p);
  for (const s of ["", "\u0000", "---", "- - a", ":\n:::", "kind: Pod\n  - \n-\n{{", "a: 'unterminated\n"]) {
    assert.doesNotThrow(() => extractK8sManifest(s));
    assert.doesNotThrow(() => extractKustomization(s));
  }
});
