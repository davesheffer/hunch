import { test } from "node:test";
import assert from "node:assert/strict";
import { extractK8sManifest, POD_SPEC_PATH_BY_KIND, LABELS_PATH_BY_KIND } from "../src/extractors/k8sManifest.js";

test("a literal Deployment's kind and metadata.name are detected as its resource identity", () => {
  const src = `apiVersion: apps/v1\nkind: Deployment\nmetadata:\n  name: my-app\n`;
  const [doc] = extractK8sManifest(src);
  assert.ok(doc);
  assert.equal(doc!.resource?.kind, "Deployment");
  assert.deepEqual(doc!.resource?.name, { form: "literal", value: "my-app", atChar: src.indexOf("my-app"), endChar: src.indexOf("my-app") + "my-app".length });
});

test("a same-line templated metadata.name is classified as a template form with the raw source text", () => {
  const src = `apiVersion: v1\nkind: ConfigMap\nmetadata:\n  name: {{ include "chart.fullname" . }}\n`;
  const [doc] = extractK8sManifest(src);
  assert.equal(doc!.resource?.name.form, "template");
  assert.equal((doc!.resource!.name as { sourceText: string }).sourceText, `{{ include "chart.fullname" . }}`);
});

test("a kind outside the fixed allowlist produces no resource and no candidates", () => {
  const src = `apiVersion: example.com/v1\nkind: MyCustomResource\nmetadata:\n  name: whatever\n`;
  const [doc] = extractK8sManifest(src);
  assert.equal(doc!.resource, null);
  assert.deepEqual(doc!.references, []);
});

test("multi-document files (--- separated) produce one entry per document with correct char offsets", () => {
  const src = `apiVersion: v1\nkind: ConfigMap\nmetadata:\n  name: cm-one\n---\napiVersion: v1\nkind: Secret\nmetadata:\n  name: sec-one\n`;
  const docs = extractK8sManifest(src);
  assert.equal(docs.length, 2);
  assert.equal(docs[0]!.resource?.kind, "ConfigMap");
  assert.equal(docs[1]!.resource?.kind, "Secret");
  assert.ok(docs[1]!.resource!.startChar >= src.indexOf("---"));
});

test("quoted literal names have their quotes stripped", () => {
  const src = `apiVersion: v1\nkind: ConfigMap\nmetadata:\n  name: "my-config"\n`;
  const [doc] = extractK8sManifest(src);
  assert.equal(doc!.resource?.name.form, "literal");
  assert.equal((doc!.resource!.name as { value: string }).value, "my-config");
});

test("a block-form templated value does not corrupt later structure in the same document", () => {
  const src = [
    `apiVersion: apps/v1`,
    `kind: Deployment`,
    `metadata:`,
    `  name: my-app`,
    `  labels:`,
    `    {{- include "chart.labels" . | nindent 4 }}`,
    `spec:`,
    `  template:`,
    `    spec:`,
    `      containers:`,
    `      - name: app`,
    `        env:`,
    `          - name: X`,
    `            valueFrom:`,
    `              secretKeyRef:`,
    `                name: my-secret`,
    `                key: k`,
    ``,
  ].join("\n");
  const [doc] = extractK8sManifest(src);
  assert.equal(doc!.resource?.kind, "Deployment");
  assert.equal((doc!.resource!.name as { value: string }).value, "my-app");
});

// Task 2

test("a Deployment's env[].valueFrom.secretKeyRef.name produces a Secret reference candidate", () => {
  const src = [
    `apiVersion: apps/v1`, `kind: Deployment`, `metadata:`, `  name: my-app`,
    `spec:`, `  template:`, `    spec:`, `      containers:`, `      - name: app`,
    `        env:`, `          - name: X`, `            valueFrom:`,
    `              secretKeyRef:`, `                name: my-secret`, ``,
  ].join("\n");
  const [doc] = extractK8sManifest(src);
  const ref = doc!.references.find((r) => r.refKind === "Secret");
  assert.ok(ref, "Secret reference candidate found");
  assert.equal((ref!.name as { value: string }).value, "my-secret");
});

test("a Deployment's envFrom[].configMapRef.name produces a ConfigMap reference candidate", () => {
  const src = [
    `apiVersion: apps/v1`, `kind: Deployment`, `metadata:`, `  name: my-app`,
    `spec:`, `  template:`, `    spec:`, `      containers:`, `      - name: app`,
    `        envFrom:`, `          - configMapRef:`, `              name: my-config`, ``,
  ].join("\n");
  const [doc] = extractK8sManifest(src);
  const ref = doc!.references.find((r) => r.refKind === "ConfigMap");
  assert.ok(ref);
  assert.equal((ref!.name as { value: string }).value, "my-config");
});

test("a Pod's (not Deployment-wrapped) volumes[].secret.secretName produces a Secret reference candidate", () => {
  const src = [
    `apiVersion: v1`, `kind: Pod`, `metadata:`, `  name: my-pod`,
    `spec:`, `  containers:`, `  - name: app`, `  volumes:`,
    `  - name: data`, `    secret:`, `      secretName: my-secret`, ``,
  ].join("\n");
  const [doc] = extractK8sManifest(src);
  const ref = doc!.references.find((r) => r.refKind === "Secret");
  assert.ok(ref);
  assert.equal((ref!.name as { value: string }).value, "my-secret");
});

test("a same-line templated secretKeyRef.name is captured as a template-form reference candidate", () => {
  const src = [
    `apiVersion: apps/v1`, `kind: Deployment`, `metadata:`, `  name: my-app`,
    `spec:`, `  template:`, `    spec:`, `      containers:`, `      - name: app`,
    `        env:`, `          - name: X`, `            valueFrom:`,
    `              secretKeyRef:`, `                name: {{ include "chart.secretName" . }}`, ``,
  ].join("\n");
  const [doc] = extractK8sManifest(src);
  const ref = doc!.references.find((r) => r.refKind === "Secret");
  assert.equal(ref!.name.form, "template");
  assert.equal((ref!.name as { sourceText: string }).sourceText, `{{ include "chart.secretName" . }}`);
});

test("a block-injected label above the container spec does not prevent env references from being found (the exact tree-sitter failure case)", () => {
  const src = [
    `apiVersion: apps/v1`, `kind: Deployment`, `metadata:`, `  name: my-app`,
    `  labels:`, `    {{- include "chart.labels" . | nindent 4 }}`,
    `spec:`, `  template:`, `    spec:`, `      containers:`, `      - name: app`,
    `        env:`, `          - name: X`, `            valueFrom:`,
    `              secretKeyRef:`, `                name: my-secret`, ``,
  ].join("\n");
  const [doc] = extractK8sManifest(src);
  const ref = doc!.references.find((r) => r.refKind === "Secret");
  assert.ok(ref, "reference found despite an earlier block-form template injection in the same document");
  assert.equal((ref!.name as { value: string }).value, "my-secret");
});

test("two containers each produce their own independent reference candidates", () => {
  const src = [
    `apiVersion: apps/v1`, `kind: Deployment`, `metadata:`, `  name: my-app`,
    `spec:`, `  template:`, `    spec:`, `      containers:`,
    `      - name: app`, `        env:`, `          - name: A`, `            valueFrom:`,
    `              secretKeyRef:`, `                name: secret-a`,
    `      - name: sidecar`, `        env:`, `          - name: B`, `            valueFrom:`,
    `              secretKeyRef:`, `                name: secret-b`, ``,
  ].join("\n");
  const [doc] = extractK8sManifest(src);
  const names = doc!.references.filter((r) => r.refKind === "Secret").map((r) => (r.name as { value: string }).value).sort();
  assert.deepEqual(names, ["secret-a", "secret-b"]);
});

// Task 3

test("volumes[].persistentVolumeClaim.claimName produces a PersistentVolumeClaim reference candidate", () => {
  const src = [
    `apiVersion: apps/v1`, `kind: Deployment`, `metadata:`, `  name: my-app`,
    `spec:`, `  template:`, `    spec:`, `      containers:`, `      - name: app`,
    `      volumes:`, `      - name: data`, `        persistentVolumeClaim:`,
    `          claimName: my-pvc`, ``,
  ].join("\n");
  const [doc] = extractK8sManifest(src);
  const ref = doc!.references.find((r) => r.refKind === "PersistentVolumeClaim");
  assert.ok(ref);
  assert.equal((ref!.name as { value: string }).value, "my-pvc");
});

test("metadata.ownerReferences produces a reference candidate whose refKind is the owner's OWN kind field, not a fixed literal", () => {
  const src = [
    `apiVersion: apps/v1`, `kind: ReplicaSet`, `metadata:`, `  name: my-app-abc123`,
    `  ownerReferences:`, `  - apiVersion: apps/v1`, `    kind: Deployment`,
    `    name: my-app`, ``,
  ].join("\n");
  const [doc] = extractK8sManifest(src);
  const ref = doc!.references.find((r) => r.refKind === "Deployment");
  assert.ok(ref, "owner reference candidate found, keyed by the owner's kind field");
  assert.equal((ref!.name as { value: string }).value, "my-app");
});

test("two ownerReferences entries each pair their OWN name with their OWN kind (no cross-pairing)", () => {
  const src = [
    `apiVersion: v1`, `kind: Pod`, `metadata:`, `  name: my-pod`,
    `  ownerReferences:`,
    `  - apiVersion: apps/v1`, `    kind: ReplicaSet`, `    name: owner-one`,
    `  - apiVersion: batch/v1`, `    kind: Job`, `    name: owner-two`, ``,
  ].join("\n");
  const [doc] = extractK8sManifest(src);
  const byKind = new Map(doc!.references.map((r) => [r.refKind, (r.name as { value: string }).value]));
  assert.equal(byKind.get("ReplicaSet"), "owner-one");
  assert.equal(byKind.get("Job"), "owner-two");
});

test("Ingress backend.service.name produces a Service reference candidate", () => {
  const src = [
    `apiVersion: networking.k8s.io/v1`, `kind: Ingress`, `metadata:`, `  name: my-ingress`,
    `spec:`, `  rules:`, `  - http:`, `      paths:`, `      - backend:`,
    `          service:`, `            name: my-service`, ``,
  ].join("\n");
  const [doc] = extractK8sManifest(src);
  const ref = doc!.references.find((r) => r.refKind === "Service");
  assert.ok(ref);
  assert.equal((ref!.name as { value: string }).value, "my-service");
});

test("HTTPRoute backendRefs[].name produces a Service reference candidate", () => {
  const src = [
    `apiVersion: gateway.networking.k8s.io/v1`, `kind: HTTPRoute`, `metadata:`, `  name: my-route`,
    `spec:`, `  rules:`, `  - backendRefs:`, `    - name: my-service`, `      port: 80`, ``,
  ].join("\n");
  const [doc] = extractK8sManifest(src);
  const ref = doc!.references.find((r) => r.refKind === "Service");
  assert.ok(ref);
  assert.equal((ref!.name as { value: string }).value, "my-service");
});

// Task 4

test("a Service's literal spec.selector is extracted as a label map", () => {
  const src = [
    `apiVersion: v1`, `kind: Service`, `metadata:`, `  name: my-service`,
    `spec:`, `  selector:`, `    app: my-app`, `    tier: web`, ``,
  ].join("\n");
  const [doc] = extractK8sManifest(src);
  assert.deepEqual(doc!.selector, { app: "my-app", tier: "web" });
});

test("a Deployment's literal spec.template.metadata.labels is extracted as a label map", () => {
  const src = [
    `apiVersion: apps/v1`, `kind: Deployment`, `metadata:`, `  name: my-app`,
    `spec:`, `  template:`, `    metadata:`, `      labels:`,
    `        app: my-app`, `        tier: web`, ``,
  ].join("\n");
  const [doc] = extractK8sManifest(src);
  assert.deepEqual(doc!.labels, { app: "my-app", tier: "web" });
});

test("a Service's block-form templated selector ({{ include ... }} block) is left null, not guessed at", () => {
  const src = [
    `apiVersion: v1`, `kind: Service`, `metadata:`, `  name: my-service`,
    `spec:`, `  selector:`, `    {{- include "chart.selectorLabels" . | nindent 4 }}`, ``,
  ].join("\n");
  const [doc] = extractK8sManifest(src);
  assert.equal(doc!.selector, null);
});

test("a Deployment's block-form templated pod-template labels is left null", () => {
  const src = [
    `apiVersion: apps/v1`, `kind: Deployment`, `metadata:`, `  name: my-app`,
    `spec:`, `  template:`, `    metadata:`, `      labels:`,
    `        {{- include "chart.labels" . | nindent 8 }}`, ``,
  ].join("\n");
  const [doc] = extractK8sManifest(src);
  assert.equal(doc!.labels, null);
});

test("every pod-spec-bearing kind also has a pod-template labels path (Phase 2 can't silently skip a workload)", () => {
  // POD_SPEC_PATH_BY_KIND and LABELS_PATH_BY_KIND are two independently
  // maintained tables keyed by the same workload kinds -- adding a kind to
  // one and forgetting the other would silently drop that kind from Phase 2
  // label matching, with no error anywhere.
  assert.deepEqual(Object.keys(POD_SPEC_PATH_BY_KIND).sort(), Object.keys(LABELS_PATH_BY_KIND).sort());
});

test("a Service's same-line templated selector value voids the WHOLE map, not just its own key", () => {
  // Unlike the block-form case above (caught by unresolvedContainers before
  // extractLiteralLabelMap even runs), a same-line template on one key among
  // otherwise-literal siblings only trips extractLiteralLabelMap's own
  // `e.value.form === "template"` guard -- dropping just that guard's entry
  // instead of the whole map would leave `tier: web` looking like the
  // complete selector, which is strictly MORE permissive than the real one
  // (matches any workload with tier: web, regardless of app).
  const src = [
    `apiVersion: v1`, `kind: Service`, `metadata:`, `  name: my-service`,
    `spec:`, `  selector:`, `    app: {{ .Values.name }}`, `    tier: web`, ``,
  ].join("\n");
  const [doc] = extractK8sManifest(src);
  assert.equal(doc!.selector, null, "a partially-templated selector must not resolve to a subset map");
});

test("a Deployment's same-line templated pod-template label value voids the WHOLE labels map", () => {
  const src = [
    `apiVersion: apps/v1`, `kind: Deployment`, `metadata:`, `  name: my-app`,
    `spec:`, `  template:`, `    metadata:`, `      labels:`,
    `        app: {{ .Values.name }}`, `        tier: web`, ``,
  ].join("\n");
  const [doc] = extractK8sManifest(src);
  assert.equal(doc!.labels, null, "a partially-templated labels map must not resolve to a subset map");
});

test("a Pod's own metadata.labels (not wrapped in a template spec) is extracted directly", () => {
  const src = [`apiVersion: v1`, `kind: Pod`, `metadata:`, `  name: my-pod`, `  labels:`, `    app: my-app`, ``].join("\n");
  const [doc] = extractK8sManifest(src);
  assert.deepEqual(doc!.labels, { app: "my-app" });
});

test("a ConfigMap (no selector/labels concept in scope) has null selector and null labels", () => {
  const src = [`apiVersion: v1`, `kind: ConfigMap`, `metadata:`, `  name: my-config`, ``].join("\n");
  const [doc] = extractK8sManifest(src);
  assert.equal(doc!.selector, null);
  assert.equal(doc!.labels, null);
});

// Comment-stripping fix

test("an inline YAML comment after a value is stripped, not folded into the value", () => {
  const src = [`apiVersion: v1`, `kind: ConfigMap`, `metadata:`, `  name: my-config  # app settings`, ``].join("\n");
  const [doc] = extractK8sManifest(src);
  assert.equal((doc!.resource!.name as { value: string }).value, "my-config");
});

test("a ConfigMap name with a trailing comment still resolves against a Deployment's uncommented reference to it", () => {
  const src = [
    `apiVersion: apps/v1`, `kind: Deployment`, `metadata:`, `  name: my-app`,
    `spec:`, `  template:`, `    spec:`, `      containers:`, `      - name: app`,
    `        envFrom:`, `          - configMapRef:`, `              name: my-config`, ``,
  ].join("\n");
  const [doc] = extractK8sManifest(src);
  const ref = doc!.references.find((r) => r.refKind === "ConfigMap");
  assert.equal((ref!.name as { value: string }).value, "my-config");

  const configMapSrc = [`apiVersion: v1`, `kind: ConfigMap`, `metadata:`, `  name: my-config  # app settings`, ``].join("\n");
  const [configMapDoc] = extractK8sManifest(configMapSrc);
  // Both sides normalize to the same literal value -- the comment never
  // leaks into either side's identity, so a downstream (scope, kind, name)
  // resolver would see them as the same candidate.
  assert.equal((configMapDoc!.resource!.name as { value: string }).value, (ref!.name as { value: string }).value);
});

test("a quoted value's own # character is NOT treated as a comment opener", () => {
  const src = [`apiVersion: v1`, `kind: ConfigMap`, `metadata:`, `  name: "my-config#not-a-comment"`, ``].join("\n");
  const [doc] = extractK8sManifest(src);
  assert.equal((doc!.resource!.name as { value: string }).value, "my-config#not-a-comment");
});

test("a Sprig default inside a template expression ({{ .x | default \"#fff\" }}) keeps its # intact", () => {
  const src = [`apiVersion: v1`, `kind: ConfigMap`, `metadata:`, `  name: {{ .Values.color | default "#fff" }}`, ``].join("\n");
  const [doc] = extractK8sManifest(src);
  assert.equal((doc!.resource!.name as { sourceText: string }).sourceText, `{{ .Values.color | default "#fff" }}`);
});

test("a value-less key with only a trailing comment on its own line is still treated as opening a nested block, not an inline value", () => {
  // kind: Pod, not ConfigMap -- Pod is the kind LABELS_PATH_BY_KIND extracts
  // metadata.labels for; a ConfigMap has no labels concept in this scanner.
  const src = [`apiVersion: v1`, `kind: Pod`, `metadata:`, `  name: my-pod`, `  labels:  # no literal labels here`, `    app: my-app`, ``].join("\n");
  const [doc] = extractK8sManifest(src);
  assert.deepEqual(doc!.labels, { app: "my-app" });
});

// Edge cases identified during review

test("a file starting with a leading --- separator produces a harmless empty leading document, not an off-by-one on the real ones", () => {
  const src = `---\napiVersion: v1\nkind: ConfigMap\nmetadata:\n  name: cm-one\n`;
  const docs = extractK8sManifest(src);
  assert.equal(docs.length, 2, "leading --- splits off one empty document ahead of the real one");
  assert.equal(docs[0]!.resource, null, "the empty leading document has no resource");
  assert.equal(docs[1]!.resource?.kind, "ConfigMap");
});

test("a flow-style selector (selector: {app: my-app}) is conservatively left unresolved, not walked as a literal map", () => {
  const src = [`apiVersion: v1`, `kind: Service`, `metadata:`, `  name: my-service`, `spec:`, `  selector: {app: my-app}`, ``].join("\n");
  const [doc] = extractK8sManifest(src);
  assert.equal(doc!.selector, null, "flow-style collections aren't walked by this scanner -- conservative miss, not a guess");
});

test("a ConfigMap's data: block scalar containing manifest-looking YAML text does not produce phantom nested resources", () => {
  const src = [
    `apiVersion: v1`, `kind: ConfigMap`, `metadata:`, `  name: my-config`,
    `data:`, `  embedded.yaml: |`, `    kind: Deployment`, `    metadata:`, `      name: not-a-real-resource`, ``,
  ].join("\n");
  const docs = extractK8sManifest(src);
  assert.equal(docs.length, 1, "the block-scalar body is not split into a second document");
  assert.equal(docs[0]!.resource?.kind, "ConfigMap");
  assert.equal((docs[0]!.resource!.name as { value: string }).value, "my-config");
});

// Dotted label keys: a Kubernetes label key legitimately contains dots
// (app.kubernetes.io/instance is the `helm create` default), which is
// indistinguishable from path nesting once folded into one dot-joined
// string -- FieldPathEntry.parentPath/key must be tracked structurally,
// never re-derived by slicing/counting dots in the joined path.

test("an all-dotted selector (the helm create default convention) is extracted, not silently dropped", () => {
  const src = [
    `apiVersion: v1`, `kind: Service`, `metadata:`, `  name: my-service`,
    `spec:`, `  selector:`,
    `    app.kubernetes.io/name: my-app`,
    `    app.kubernetes.io/instance: prod`, ``,
  ].join("\n");
  const [doc] = extractK8sManifest(src);
  assert.deepEqual(doc!.selector, { "app.kubernetes.io/name": "my-app", "app.kubernetes.io/instance": "prod" });
});

test("a mixed selector whose dotted key differs from the workload's does NOT subset-match on the plain-key remainder alone", () => {
  // Without structural parentPath/key tracking, both sides collapse to
  // {app: my-app} (the dotted key silently dropped), which makes a real
  // mismatch (prod vs staging) look like a match.
  const selectorSrc = [
    `apiVersion: v1`, `kind: Service`, `metadata:`, `  name: my-service`,
    `spec:`, `  selector:`, `    app: my-app`, `    app.kubernetes.io/instance: prod`, ``,
  ].join("\n");
  const labelsSrc = [
    `apiVersion: apps/v1`, `kind: Deployment`, `metadata:`, `  name: my-app`,
    `spec:`, `  template:`, `    metadata:`, `      labels:`,
    `        app: my-app`, `        app.kubernetes.io/instance: staging`, ``,
  ].join("\n");
  const selector = extractK8sManifest(selectorSrc)[0]!.selector!;
  const labels = extractK8sManifest(labelsSrc)[0]!.labels!;
  assert.deepEqual(selector, { app: "my-app", "app.kubernetes.io/instance": "prod" });
  assert.deepEqual(labels, { app: "my-app", "app.kubernetes.io/instance": "staging" });
  // The values genuinely differ -- a real subset check must reject this.
  const isSubset = Object.entries(selector).every(([k, v]) => labels[k] === v);
  assert.equal(isSubset, false, "differing app.kubernetes.io/instance values must NOT read as a match");
});

test("a label key containing both a dot and a slash round-trips into the map with its key intact", () => {
  const src = [
    `apiVersion: v1`, `kind: Pod`, `metadata:`, `  name: my-pod`,
    `  labels:`, `    app.kubernetes.io/name: my-app`, ``,
  ].join("\n");
  const [doc] = extractK8sManifest(src);
  assert.deepEqual(doc!.labels, { "app.kubernetes.io/name": "my-app" });
});

test("a block-form template injection appearing as a LATER sibling after literal keys taints the whole map, not just a lookahead from the opening key", () => {
  // Regression: the opening `selector:` key already has a literal first
  // child (`app: my-app`), so the value-less-key-then-{{-on-next-line
  // lookahead never fires for THIS key -- the injection lands as a sibling
  // several lines later, which must still be caught.
  const src = [
    `apiVersion: v1`, `kind: Service`, `metadata:`, `  name: my-service`,
    `spec:`, `  selector:`, `    app: my-app`,
    `    {{- include "mychart.selectorLabels" . | nindent 4 }}`, ``,
  ].join("\n");
  const [doc] = extractK8sManifest(src);
  assert.equal(doc!.selector, null, "partially-templated map (literal siblings + a later injection) must not read as fully literal");
});

// Comment-stripping quote hardening

test("an apostrophe mid-word does not open a phantom quote that swallows a real trailing comment", () => {
  const src = [`apiVersion: v1`, `kind: ConfigMap`, `metadata:`, `  name: it's-fine  # a real comment`, ``].join("\n");
  const [doc] = extractK8sManifest(src);
  assert.equal((doc!.resource!.name as { value: string }).value, "it's-fine");
});

// CRLF line endings: `core.autocrlf=true` is the Git-for-Windows default, so
// every .yaml file in a Windows checkout is CRLF-terminated -- without the
// `\r?` in KEY_LINE, this silently zeroes out the whole module's output (JS
// `.` never matches `\r`, and `$` without /m only matches at true end-of-string).

test("a CRLF-terminated manifest is scanned identically to its LF equivalent", () => {
  const lf = `apiVersion: apps/v1\nkind: Deployment\nmetadata:\n  name: my-app\nspec:\n  template:\n    spec:\n      containers:\n      - name: app\n        envFrom:\n        - configMapRef:\n            name: my-config\n`;
  const crlf = lf.replace(/\n/g, "\r\n");
  const [lfDoc] = extractK8sManifest(lf);
  const [crlfDoc] = extractK8sManifest(crlf);
  assert.equal(crlfDoc!.resource?.kind, "Deployment");
  assert.equal((crlfDoc!.resource!.name as { value: string }).value, (lfDoc!.resource!.name as { value: string }).value);
  assert.equal(crlfDoc!.references.length, lfDoc!.references.length);
  assert.equal((crlfDoc!.references[0]!.name as { value: string }).value, "my-config");
});

test("a CRLF-terminated Service selector and workload labels are extracted the same as LF", () => {
  const lf = `apiVersion: v1\nkind: Service\nmetadata:\n  name: my-service\nspec:\n  selector:\n    app: my-app\n`;
  const crlf = lf.replace(/\n/g, "\r\n");
  const [doc] = extractK8sManifest(crlf);
  assert.deepEqual(doc!.selector, { app: "my-app" });
});

// Unrecognized line shapes: a line the scanner can't parse at all (a quoted
// key, a YAML merge key) must taint its container as unresolved, not
// silently vanish -- a dropped key makes a selector/labels map strictly MORE
// permissive, which risks a false-positive edge on real, untemplated YAML.

test("a quoted label key is left unresolved (null), not silently dropped from the map", () => {
  const src = [
    `apiVersion: v1`, `kind: Service`, `metadata:`, `  name: my-service`,
    `spec:`, `  selector:`, `    "app.kubernetes.io/name": mychart`, `    app.kubernetes.io/instance: rel-a`, ``,
  ].join("\n");
  const [doc] = extractK8sManifest(src);
  assert.equal(doc!.selector, null, "a quoted key the scanner can't parse must taint the whole map, not vanish silently");
});

test("a YAML merge key (<<: *anchor) is left unresolved (null), not silently dropped from the map", () => {
  const src = [
    `apiVersion: apps/v1`, `kind: Deployment`, `metadata:`, `  name: my-app`,
    `spec:`, `  template:`, `    metadata:`, `      labels:`,
    `        <<: *commonLabels`, `        app: my-app`, ``,
  ].join("\n");
  const [doc] = extractK8sManifest(src);
  assert.equal(doc!.labels, null);
});

test("an unresolved-line taint at one nesting level does not affect an unrelated sibling container", () => {
  const src = [
    `apiVersion: v1`, `kind: Service`, `metadata:`, `  name: my-service`,
    `  "weird-quoted-key": value`, // unresolved, taints metadata (irrelevant to selector)
    `spec:`, `  selector:`, `    app: my-app`, ``,
  ].join("\n");
  const [doc] = extractK8sManifest(src);
  assert.deepEqual(doc!.selector, { app: "my-app" }, "an unresolved line under metadata must not taint spec.selector");
});

// ReplicaSet full wiring: ReplicaSet was allowlisted only for its role as the
// dominant ownerReferences bearer, but left out of the pod-spec/labels
// tables, silently dropping its OWN container references and pod-template
// labels.

test("a hand-written ReplicaSet's own envFrom/volumes references are extracted, not silently dropped", () => {
  const src = [
    `apiVersion: apps/v1`, `kind: ReplicaSet`, `metadata:`, `  name: my-rs`,
    `spec:`, `  template:`, `    spec:`, `      containers:`, `      - name: app`,
    `        envFrom:`, `        - configMapRef:`, `            name: my-config`, ``,
  ].join("\n");
  const [doc] = extractK8sManifest(src);
  const ref = doc!.references.find((r) => r.refKind === "ConfigMap");
  assert.ok(ref, "ReplicaSet's own container references must be extracted, same as any other pod-spec-embedding kind");
});

test("a ReplicaSet's pod-template labels are extracted for Phase 2 matching", () => {
  const src = [
    `apiVersion: apps/v1`, `kind: ReplicaSet`, `metadata:`, `  name: my-rs`,
    `spec:`, `  template:`, `    metadata:`, `      labels:`, `        app: my-app`,
    `    spec:`, `      containers:`, `      - name: app`, ``,
  ].join("\n");
  const [doc] = extractK8sManifest(src);
  assert.deepEqual(doc!.labels, { app: "my-app" });
});

// A {{ }} action line's own indentation is meaningless: `{{-` chomps it away,
// and the `| indent N` idiom REQUIRES the action at column 0 while injecting
// content at depth N. The same manifest at three different (semantically
// irrelevant) action indents must produce identical output -- and,
// critically, a column-0 action must NOT destroy tracking of every
// field-path that follows it in the document.

function refsOf(src: string): Array<[string, string]> {
  return extractK8sManifest(src)[0]!.references.map((r): [string, string] => [r.refKind, r.name.form === "literal" ? r.name.value : r.name.sourceText]);
}

test("a template action's indent (column 0, mid, or co-indented with its siblings) does not change which references are extracted", () => {
  const withActionAt = (actionIndent: string) => [
    `apiVersion: apps/v1`, `kind: Deployment`, `metadata:`, `  name: my-app`,
    `spec:`, `  template:`, `    spec:`, `      containers:`, `      - name: app`,
    `        envFrom:`,
    `${actionIndent}{{- if true }}`,
    `        - configMapRef:`,
    `            name: my-config`,
    `${actionIndent}{{- end }}`, ``,
  ].join("\n");
  const col0 = refsOf(withActionAt(""));
  const mid = refsOf(withActionAt("    "));
  const coIndented = refsOf(withActionAt("        "));
  assert.deepEqual(col0, [["ConfigMap", "my-config"]]);
  assert.deepEqual(mid, col0, "action at a mid indent must extract the same reference as column 0");
  assert.deepEqual(coIndented, col0, "action co-indented with its siblings must extract the same reference as column 0");
});

test("a column-0 template action does not annihilate the frame stack for the rest of the document (regression: everything after it used to be lost)", () => {
  const src = [
    `apiVersion: apps/v1`, `kind: Deployment`, `metadata:`, `  name: my-app`,
    `spec:`, `  template:`, `    spec:`, `      containers:`,
    `      - name: app`,
    `{{- if .Values.extraEnv }}`,
    `        env:`, `          - name: X`, `            valueFrom:`,
    `              secretKeyRef:`, `                name: my-secret`,
    `{{- end }}`,
    `        envFrom:`, `        - configMapRef:`, `            name: my-config`, ``,
  ].join("\n");
  const refs = refsOf(src);
  assert.deepEqual(refs.sort(), [["ConfigMap", "my-config"], ["Secret", "my-secret"]].sort());
});

test("a template action inside a Service's selector, at column 0, leaves the selector unresolved rather than a false-positive partial match", () => {
  const src = [
    `apiVersion: v1`, `kind: Service`, `metadata:`, `  name: my-svc`,
    `spec:`, `  selector:`, `    app: my-app`,
    `{{- if .Values.stableOnly }}`,
    `    track: stable`,
    `{{- end }}`, ``,
  ].join("\n");
  const [doc] = extractK8sManifest(src);
  assert.equal(doc!.selector, null, "a column-0 conditional inside the selector must taint the whole map, not leave a partial literal one");
});

// Document separators: `--- # comment` is legal YAML and must still split
// documents; `...` is a document-end marker. Missing either silently merges
// two documents into one.

test("a document separator with a trailing comment (--- # note) still splits documents", () => {
  const src = [
    `apiVersion: v1`, `kind: ConfigMap`, `metadata:`, `  name: cm-one`,
    `--- # the second doc`,
    `apiVersion: v1`, `kind: Service`, `metadata:`, `  name: svc-two`, ``,
  ].join("\n");
  const docs = extractK8sManifest(src);
  assert.equal(docs.length, 2);
  assert.equal(docs[0]!.resource?.kind, "ConfigMap");
  assert.equal(docs[1]!.resource?.kind, "Service");
});

test("a document-end marker (...) is recognized as a document boundary", () => {
  const src = [`apiVersion: v1`, `kind: ConfigMap`, `metadata:`, `  name: cm-one`, `...`, ``].join("\n");
  const docs = extractK8sManifest(src);
  assert.equal(docs[0]!.resource?.kind, "ConfigMap");
});

test("four or more dashes at column 0 (----) is NOT mistaken for a document separator", () => {
  const src = [`apiVersion: v1`, `kind: ConfigMap`, `metadata:`, `  name: cm-one`, `----`, `spec: {}`, ``].join("\n");
  const docs = extractK8sManifest(src);
  assert.equal(docs.length, 1, "four dashes must not be treated as a document boundary the way three dashes are");
  assert.equal(docs[0]!.resource?.kind, "ConfigMap");
});

// A flow collection value is a shape a line-oriented scan can't fully see:
// keys written on the OPENING line of a multi-line `{ ... }`/`[ ... ]` value
// are invisible to the scanner, which silently drops them instead of the
// whole map reading as unresolved -- for a selector, a dropped key makes the
// match strictly MORE permissive.

test("a multi-line flow-style selector is left unresolved (null), not a partial map missing the key written on its opening line", () => {
  const src = [
    `apiVersion: v1`, `kind: Service`, `metadata:`, `  name: my-service`,
    `spec:`, `  selector: {app: web-frontend,`, `    tier: web`, `  }`, ``,
  ].join("\n");
  const [doc] = extractK8sManifest(src);
  assert.equal(doc!.selector, null, "app was written on the selector's own opening line and must not silently vanish");
});

test("a multi-line flow-style labels map does not bake a trailing comma into a value", () => {
  const src = [
    `apiVersion: v1`, `kind: Pod`, `metadata:`, `  name: my-pod`,
    `  labels: {app: myapp,`, `    tier: web`, `  }`, ``,
  ].join("\n");
  const [doc] = extractK8sManifest(src);
  assert.equal(doc!.labels, null, "a partially-seen flow map must not read as resolved, comma-corrupted values included");
});

test("a single-line flow-style selector is still left unresolved, same as before (no behavior change for the already-correct case)", () => {
  const src = [`apiVersion: v1`, `kind: Service`, `metadata:`, `  name: my-service`, `spec:`, `  selector: {app: my-app}`, ``].join("\n");
  const [doc] = extractK8sManifest(src);
  assert.equal(doc!.selector, null);
});

// Quoted vs. unquoted template text: idiomatic Helm text is pre-render, not
// valid YAML yet, so the SAME template expression routinely appears both
// bare and quoted in one chart (helm create's own test-connection.yaml
// quotes it). Classifying on the raw value instead of the quote-stripped
// text would tag one "literal" and the other "template", giving them
// different nameKeyText prefixes and silently breaking the match between a
// resource's own name and a quoted reference.

test("a quoted template expression classifies as the SAME template form as its unquoted equivalent", () => {
  const unquotedSrc = [`apiVersion: v1`, `kind: Secret`, `metadata:`, `  name: {{ include "mychart.fullname" . }}`, ``].join("\n");
  // Realistic helm create-style quoting: unescaped inner quotes -- Helm text
  // is pre-render, not valid YAML yet, so this is common and tolerated.
  const quotedSrc = String.raw`apiVersion: apps/v1
kind: Deployment
metadata:
  name: "{{ include "mychart.fullname" . }}"
`;
  const unquotedName = extractK8sManifest(unquotedSrc)[0]!.resource!.name;
  const quotedName = extractK8sManifest(quotedSrc)[0]!.resource!.name;
  assert.equal(unquotedName.form, "template");
  assert.equal(quotedName.form, "template", "a quoted template expression must classify as \"template\", not \"literal\"");
  assert.equal((quotedName as { sourceText: string }).sourceText, (unquotedName as { sourceText: string }).sourceText,
    "quoted and unquoted forms of the identical expression must produce identical sourceText, so they share the same nameKeyText and can match");
});

// A block-scalar header (`|`, `>`, plus chomping/indent indicators) is not a
// value -- the real scalar is on the FOLLOWING indented lines. Reading the
// header token itself as the value is silently, confidently WRONG (not
// merely incomplete): two resources with nothing in common both key on the
// literal string "|-" and collide.

test("a resource whose name is a block scalar is unidentifiable (null resource), not literally named the header token", () => {
  const src = [`apiVersion: v1`, `kind: ConfigMap`, `metadata:`, `  name: |-`, `    real-config`, ``].join("\n");
  const [doc] = extractK8sManifest(src);
  assert.equal(doc!.resource, null, "a block-scalar name must not produce a resource literally named \"|-\"");
});

test("a block-scalar Secret/ConfigMap reference name is not extracted as the literal header token", () => {
  const src = [
    `apiVersion: apps/v1`, `kind: Deployment`, `metadata:`, `  name: my-app`,
    `spec:`, `  template:`, `    spec:`, `      containers:`, `      - name: app`,
    `        envFrom:`, `        - configMapRef:`, `            name: |-`, `              real-config`, ``,
  ].join("\n");
  const [doc] = extractK8sManifest(src);
  assert.equal(doc!.references.length, 0, "a block-scalar reference name must not silently resolve to the literal header token");
});

test("a block-scalar label VALUE taints the whole selector map (parentPath, not the leaf's own path)", () => {
  const src = [
    `apiVersion: v1`, `kind: Service`, `metadata:`, `  name: my-svc`,
    `spec:`, `  selector:`, `    app: |-`, `      web`, `    tier: api`, ``,
  ].join("\n");
  const [doc] = extractK8sManifest(src);
  assert.equal(doc!.selector, null, "the block-scalar app value must taint the whole map, not leave {tier: api} as a partial one");
});

test("every block-scalar header spelling (|, |-, |+, |2, >, >-) is recognized", () => {
  for (const header of ["|", "|-", "|+", "|2", "|2-", "|-2", ">", ">-", ">+"]) {
    const src = [`apiVersion: v1`, `kind: ConfigMap`, `metadata:`, `  name: ${header}`, `    x`, ``].join("\n");
    const [doc] = extractK8sManifest(src);
    assert.equal(doc!.resource, null, `header "${header}" must be recognized as a block scalar, not a literal name`);
  }
});

test("a genuinely quoted single-pipe value is NOT mistaken for a block scalar header", () => {
  const src = [`apiVersion: v1`, `kind: ConfigMap`, `metadata:`, `  name: "|"`, ``].join("\n");
  const [doc] = extractK8sManifest(src);
  assert.equal(doc!.resource?.kind, "ConfigMap");
  assert.equal((doc!.resource!.name as { value: string }).value, "|", "a quoted literal pipe must stay a literal, not be treated as an unterminated block scalar");
});

// A nested map under a selector/labels key silently vanishes, making the map
// more permissive (invalid k8s, but not rejected by this scanner -- same
// "dropped key" risk as every other unresolved case).

test("a nested map under a selector key (invalid k8s, but not rejected by this scanner) taints the whole map instead of silently dropping the nested key", () => {
  const src = [
    `apiVersion: v1`, `kind: Service`, `metadata:`, `  name: my-svc`,
    `spec:`, `  selector:`, `    app: web`, `    team:`, `      owner: p`, ``,
  ].join("\n");
  const [doc] = extractK8sManifest(src);
  assert.equal(doc!.selector, null, "a nested map under the selector must taint the whole map, not leave {app: web} as a partial one");
});

// __proto__ as a label key: a plain object literal silently swallows an
// assignment to "__proto__" (it sets the prototype, not an own property),
// which would make Object.entries() see an empty map that vacuously matches
// every workload -- unreachable via a syntactically valid k8s label key, but
// the blast radius (every workload, not just a wrong one) warranted a
// one-line hardening anyway.

test("a __proto__ label key round-trips as a real own property, not silently swallowed into the object's prototype", () => {
  const src = [`apiVersion: v1`, `kind: Service`, `metadata:`, `  name: my-svc`, `spec:`, `  selector:`, `    __proto__: web`, ``].join("\n");
  const [doc] = extractK8sManifest(src);
  assert.ok(Object.prototype.hasOwnProperty.call(doc!.selector, "__proto__"), "__proto__ must be a real own property of the returned map");
  assert.equal(doc!.selector!["__proto__"], "web");
});

// A bare `-` list marker with nothing else on its line: the item's content
// is entirely on later, more-indented lines. Without explicit handling this
// falls to the unrecognized-line branch, which uses ordinary (non-list)
// popping and loses the item's own frame, silently reparenting everything
// under it one level up and dropping every reference inside.

test("a bare dash list marker (item body entirely on following lines) still extracts references from inside it", () => {
  const src = [
    `apiVersion: apps/v1`, `kind: Deployment`, `metadata:`, `  name: my-app`,
    `spec:`, `  template:`, `    spec:`, `      containers:`,
    `      -`,
    `        name: app`,
    `        envFrom:`,
    `          - configMapRef:`,
    `              name: app-config`, ``,
  ].join("\n");
  const [doc] = extractK8sManifest(src);
  const ref = doc!.references.find((r) => r.refKind === "ConfigMap");
  assert.ok(ref, "a reference nested under a bare-dash list item must still be extracted");
  assert.equal((ref!.name as { value: string }).value, "app-config");
});

test("a bare dash list marker followed by a second real inline item both get distinct sequence indices", () => {
  const src = [
    `apiVersion: apps/v1`, `kind: Deployment`, `metadata:`, `  name: my-app`,
    `spec:`, `  template:`, `    spec:`, `      containers:`,
    `      -`,
    `        name: app`,
    `        envFrom:`,
    `          - configMapRef:`,
    `              name: config-a`,
    `      - name: sidecar`,
    `        envFrom:`,
    `        - configMapRef:`,
    `            name: config-b`, ``,
  ].join("\n");
  const [doc] = extractK8sManifest(src);
  const names = doc!.references.filter((r) => r.refKind === "ConfigMap").map((r) => (r.name as { value: string }).value).sort();
  assert.deepEqual(names, ["config-a", "config-b"]);
});

// imagePullSecrets[].name -> Secret (found while verifying this design
// against real production Helm charts: a registry pull secret is a common,
// legitimate reference the original field-path table never covered).

test("spec.template.spec.imagePullSecrets[].name produces a Secret reference candidate", () => {
  const src = [
    `apiVersion: apps/v1`, `kind: Deployment`, `metadata:`, `  name: my-app`,
    `spec:`, `  template:`, `    spec:`, `      imagePullSecrets:`,
    `      - name: my-registry-secret`, `      containers:`, `      - name: app`, ``,
  ].join("\n");
  const [doc] = extractK8sManifest(src);
  const ref = doc!.references.find((r) => r.refKind === "Secret");
  assert.ok(ref);
  assert.equal((ref!.name as { value: string }).value, "my-registry-secret");
});

// Issue #297 gap 2: a `- |` list item's block-scalar body is opaque TEXT (the
// idiomatic way a chart inlines a shell script into args:/command:), but it
// matches neither KEY_LINE nor BARE_LIST_MARKER, so it fell to the
// unrecognized-line branch and its body -- which routinely contains a
// heredoc'd manifest -- was scanned as the surrounding container's fields,
// inventing references to resources that only ever existed as script text.

test("a script inlined via a `- |` args item does not yield phantom references from its heredoc'd manifest text", () => {
  const src = [
    `apiVersion: batch/v1`, `kind: Job`, `metadata:`, `  name: migrate`,
    `spec:`, `  template:`, `    spec:`, `      containers:`,
    `      - name: runner`,
    `        args:`,
    `        - |`,
    `          cat <<EOF`,
    `          env:`,
    `          - name: DB_PASSWORD`,
    `            valueFrom:`,
    `              secretKeyRef:`,
    `                name: prod-db-creds`,
    `          EOF`, ``,
  ].join("\n");
  const [doc] = extractK8sManifest(src);
  assert.equal(doc!.resource?.kind, "Job");
  assert.equal(
    doc!.references.find((r) => (r.name as { value?: string }).value === "prod-db-creds"),
    undefined,
    "a secretKeyRef that exists only as script text must not become a reference",
  );
});

test("a REAL secretKeyRef on a container declared after a `- |` args item is still extracted (the skip ends at the right line)", () => {
  const src = [
    `apiVersion: batch/v1`, `kind: Job`, `metadata:`, `  name: migrate`,
    `spec:`, `  template:`, `    spec:`, `      containers:`,
    `      - name: runner`,
    `        args:`,
    `        - |`,
    `          cat <<EOF`,
    `          env:`,
    `          - name: DB_PASSWORD`,
    `            valueFrom:`,
    `              secretKeyRef:`,
    `                name: prod-db-creds`,
    `          EOF`,
    `      - name: sidecar`,
    `        env:`,
    `          - name: REAL`,
    `            valueFrom:`,
    `              secretKeyRef:`,
    `                name: real-secret`, ``,
  ].join("\n");
  const [doc] = extractK8sManifest(src);
  const names = doc!.references.filter((r) => r.refKind === "Secret").map((r) => (r.name as { value: string }).value);
  assert.deepEqual(names, ["real-secret"], "only the real second container's secretKeyRef, never the scripted one");
});

test("a column-0 {{ }} action inside a `- |` script body does not end the skip and re-expose the rest as fields", () => {
  // A `{{ }}` action line's own indentation is meaningless (`{{-` chomps it,
  // `| indent N` puts it at column 0), so it must never read as a dedent out
  // of the block scalar -- otherwise every body line after it is scanned as
  // manifest structure again.
  const src = [
    `apiVersion: batch/v1`, `kind: Job`, `metadata:`, `  name: migrate`,
    `spec:`, `  template:`, `    spec:`, `      containers:`,
    `      - name: runner`,
    `        args:`,
    `        - |`,
    `          set -e`,
    `{{- if .Values.debug }}`,
    `          env:`,
    `          - name: DB_PASSWORD`,
    `            valueFrom:`,
    `              secretKeyRef:`,
    `                name: prod-db-creds`,
    `{{- end }}`, ``,
  ].join("\n");
  const [doc] = extractK8sManifest(src);
  assert.equal(
    doc!.references.find((r) => (r.name as { value?: string }).value === "prod-db-creds"),
    undefined,
    "a column-0 template action must not terminate the block-scalar skip",
  );
});

test("`- |-` and `- >` headers and deeper-indented args items are both recognized as block scalars", () => {
  // Both real-world YAML list styles: list items at the SAME indent as their
  // key (the tests above) and DEEPER than it (here), with chomping and folded
  // headers rather than a plain `|`.
  const src = [
    `apiVersion: batch/v1`, `kind: Job`, `metadata:`, `  name: migrate`,
    `spec:`, `  template:`, `    spec:`, `      containers:`,
    `      - name: runner`,
    `        args:`,
    `          - |-`,
    `            env:`,
    `            - name: A`,
    `              valueFrom:`,
    `                secretKeyRef:`,
    `                  name: scripted-a`,
    `          - >`,
    `            env:`,
    `            - name: B`,
    `              valueFrom:`,
    `                secretKeyRef:`,
    `                  name: scripted-b`, ``,
  ].join("\n");
  const [doc] = extractK8sManifest(src);
  assert.deepEqual(doc!.references.filter((r) => r.refKind === "Secret"), [], "neither block-scalar body contributes a reference");
});

test("a `- |` header carrying a trailing comment is still recognized as a block scalar", () => {
  const src = [
    `apiVersion: batch/v1`, `kind: Job`, `metadata:`, `  name: migrate`,
    `spec:`, `  template:`, `    spec:`, `      containers:`,
    `      - name: runner`,
    `        args:`,
    `        - | # entrypoint script`,
    `          env:`,
    `          - name: A`,
    `            valueFrom:`,
    `              secretKeyRef:`,
    `                name: scripted-a`, ``,
  ].join("\n");
  const [doc] = extractK8sManifest(src);
  assert.deepEqual(doc!.references.filter((r) => r.refKind === "Secret"), []);
});

// Issue #297 gap 3: a key written with NO value (`tier:`) creates a frame but
// never an entry, so a flat selector/labels map came back MINUS that key --
// matching strictly MORE workloads than the manifest actually says.

test("a Service selector containing a value-less key resolves to null, not to the map minus that key", () => {
  const src = [
    `apiVersion: v1`, `kind: Service`, `metadata:`, `  name: my-service`,
    `spec:`, `  selector:`, `    tier:`, `    app: web`, ``,
  ].join("\n");
  const [doc] = extractK8sManifest(src);
  assert.equal(doc!.selector, null, "a selector short one key is more permissive than the real one -- must not resolve");
});

test("a workload's pod-template labels containing a value-less key resolves to null", () => {
  const src = [
    `apiVersion: apps/v1`, `kind: Deployment`, `metadata:`, `  name: my-app`,
    `spec:`, `  template:`, `    metadata:`, `      labels:`,
    `        tier:`, `        app: web`, ``,
  ].join("\n");
  const [doc] = extractK8sManifest(src);
  assert.equal(doc!.labels, null);
});

test("a value-less selector key whose line carries a trailing comment is still treated as value-less", () => {
  const src = [
    `apiVersion: v1`, `kind: Service`, `metadata:`, `  name: my-service`,
    `spec:`, `  selector:`, `    tier: # todo: pick one`, `    app: web`, ``,
  ].join("\n");
  const [doc] = extractK8sManifest(src);
  assert.equal(doc!.selector, null, "stripTrailingComment leaves an empty value, which is still value-less");
});

test("a quoted empty selector value stays a literal empty string, not a value-less key", () => {
  // Regression guard for the value-less rule: `tier: ""` is a real, explicit
  // empty-string label value that a workload can genuinely carry, and it must
  // keep resolving -- only a key with NO value at all voids the map.
  const src = [
    `apiVersion: v1`, `kind: Service`, `metadata:`, `  name: my-service`,
    `spec:`, `  selector:`, `    tier: ""`, `    app: web`, ``,
  ].join("\n");
  const [doc] = extractK8sManifest(src);
  assert.deepEqual(doc!.selector, { tier: "", app: "web" });
});

// Issue #297 gap 4: per YAML, `---` followed by whitespace starts a document
// whatever trails it -- a tag, an anchor -- not only a comment.

test("a `--- !!map` tagged separator splits the file into two documents", () => {
  const src = [
    `apiVersion: v1`, `kind: ConfigMap`, `metadata:`, `  name: cm-one`,
    `--- !!map`,
    `apiVersion: v1`, `kind: Secret`, `metadata:`, `  name: sec-one`, ``,
  ].join("\n");
  const docs = extractK8sManifest(src);
  assert.equal(docs.length, 2);
  assert.equal((docs[0]!.resource!.name as { value: string }).value, "cm-one");
  assert.equal((docs[1]!.resource!.name as { value: string }).value, "sec-one");
});

test("a `--- &anchor` anchored separator splits the file into two documents", () => {
  const src = [
    `apiVersion: v1`, `kind: ConfigMap`, `metadata:`, `  name: cm-one`,
    `--- &base`,
    `apiVersion: v1`, `kind: Secret`, `metadata:`, `  name: sec-one`, ``,
  ].join("\n");
  const docs = extractK8sManifest(src);
  assert.equal(docs.length, 2);
  assert.equal((docs[0]!.resource!.name as { value: string }).value, "cm-one");
  assert.equal((docs[1]!.resource!.name as { value: string }).value, "sec-one");
});

test("a `----` rule line still does not split the file, even with the relaxed separator", () => {
  // Regression guard: the dashes must be followed by whitespace or end of
  // line, so a four-dash rule is still not a document marker.
  const src = [
    `apiVersion: v1`, `kind: ConfigMap`, `metadata:`, `  name: cm-one`,
    `----`, ``,
  ].join("\n");
  assert.equal(extractK8sManifest(src).length, 1);
});

test("an indented `--- !!map` inside a block-scalar body does not split the file", () => {
  // Regression guard: the separator is anchored to column 0, so manifest-
  // looking text embedded in a ConfigMap's data: block scalar stays inert.
  const src = [
    `apiVersion: v1`, `kind: ConfigMap`, `metadata:`, `  name: my-config`,
    `data:`, `  embedded.yaml: |`,
    `    --- !!map`,
    `    kind: Deployment`, ``,
  ].join("\n");
  const docs = extractK8sManifest(src);
  assert.equal(docs.length, 1, "an indented tagged separator is block-scalar text, not a document boundary");
  assert.equal(docs[0]!.resource?.kind, "ConfigMap");
});

// Issue #297 gap 1: a reference must not resolve across namespaces. A MISSING
// namespace is UNKNOWN and matches anything; two DIFFERENT literal namespaces
// block the edge.

test("a literal metadata.namespace is parsed onto the resource", () => {
  const src = `apiVersion: v1\nkind: ConfigMap\nmetadata:\n  name: my-config\n  namespace: prod\n`;
  const [doc] = extractK8sManifest(src);
  assert.equal(doc!.resource?.namespace, "prod");
});

test("an absent metadata.namespace reads as null (unknown), not as an empty string", () => {
  const src = `apiVersion: v1\nkind: ConfigMap\nmetadata:\n  name: my-config\n`;
  const [doc] = extractK8sManifest(src);
  assert.equal(doc!.resource?.namespace, null);
});

test("an explicitly empty metadata.namespace reads as null (unknown)", () => {
  // `namespace: ""` names no namespace this scanner can compare against, so
  // it must not become a literal "" that blocks every real namespace.
  const src = `apiVersion: v1\nkind: ConfigMap\nmetadata:\n  name: my-config\n  namespace: ""\n`;
  const [doc] = extractK8sManifest(src);
  assert.equal(doc!.resource?.namespace, null);
});

test("a value-less metadata.namespace key reads as null (unknown)", () => {
  const src = `apiVersion: v1\nkind: ConfigMap\nmetadata:\n  name: my-config\n  namespace:\n`;
  const [doc] = extractK8sManifest(src);
  assert.equal(doc!.resource?.namespace, null);
});

test("a quoted metadata.namespace has its quotes stripped, same as the name", () => {
  const src = `apiVersion: v1\nkind: ConfigMap\nmetadata:\n  name: my-config\n  namespace: "prod"\n`;
  const [doc] = extractK8sManifest(src);
  assert.equal(doc!.resource?.namespace, "prod");
});

test("a templated metadata.namespace reads as null (unknown), never as a template-keyed literal", () => {
  // A namespace is only ever a FILTER here, not a resolution key: blocking an
  // edge because one side spells the namespace via {{ .Release.Namespace }}
  // and the other spells it out would be a false negative.
  const src = `apiVersion: v1\nkind: ConfigMap\nmetadata:\n  name: my-config\n  namespace: {{ .Release.Namespace }}\n`;
  const [doc] = extractK8sManifest(src);
  assert.equal(doc!.resource?.namespace, null);
});

test("a trailing comment is stripped from metadata.namespace", () => {
  const src = `apiVersion: v1\nkind: ConfigMap\nmetadata:\n  name: my-config\n  namespace: prod  # where it lives\n`;
  const [doc] = extractK8sManifest(src);
  assert.equal(doc!.resource?.namespace, "prod");
});

test("a CRLF-terminated metadata.namespace line parses without the carriage return", () => {
  const src = `apiVersion: v1\r\nkind: ConfigMap\r\nmetadata:\r\n  name: my-config\r\n  namespace: prod\r\n`;
  const [doc] = extractK8sManifest(src);
  assert.equal(doc!.resource?.namespace, "prod");
});

test("a reference made by a document carries that document's namespace", () => {
  const src = [
    `apiVersion: apps/v1`, `kind: Deployment`,
    `metadata:`, `  name: my-app`, `  namespace: prod`,
    `spec:`, `  template:`, `    spec:`, `      containers:`,
    `      - name: app`, `        envFrom:`, `        - configMapRef:`,
    `            name: my-config`, ``,
  ].join("\n");
  const [doc] = extractK8sManifest(src);
  assert.equal(doc!.references.length, 1);
  assert.equal(doc!.references[0]!.namespace, "prod");
});

test("an HTTPRoute backendRef's own namespace sibling overrides the document's namespace", () => {
  // The one shape in fieldSpecsForKind that Kubernetes lets point across
  // namespaces (Gateway API cross-namespace backendRefs).
  const src = [
    `apiVersion: gateway.networking.k8s.io/v1`, `kind: HTTPRoute`,
    `metadata:`, `  name: my-route`, `  namespace: prod`,
    `spec:`, `  rules:`, `  - backendRefs:`,
    `    - name: my-service`, `      namespace: other`, ``,
  ].join("\n");
  const [doc] = extractK8sManifest(src);
  assert.equal(doc!.references.length, 1);
  assert.equal(doc!.references[0]!.namespace, "other", "the explicit sibling wins over the document's own namespace");
});

test("an HTTPRoute backendRef with no namespace sibling falls back to the document's namespace", () => {
  const src = [
    `apiVersion: gateway.networking.k8s.io/v1`, `kind: HTTPRoute`,
    `metadata:`, `  name: my-route`, `  namespace: prod`,
    `spec:`, `  rules:`, `  - backendRefs:`,
    `    - name: my-service`, ``,
  ].join("\n");
  const [doc] = extractK8sManifest(src);
  assert.equal(doc!.references[0]!.namespace, "prod");
});

test("an HTTPRoute backendRef whose namespace sibling is templated reads as unknown, NOT as the document's namespace", () => {
  // An explicit-but-unreadable sibling states the target is elsewhere; falling
  // back to the document's namespace would be a confident wrong answer.
  const src = [
    `apiVersion: gateway.networking.k8s.io/v1`, `kind: HTTPRoute`,
    `metadata:`, `  name: my-route`, `  namespace: prod`,
    `spec:`, `  rules:`, `  - backendRefs:`,
    `    - name: my-service`, `      namespace: {{ .Values.ns }}`, ``,
  ].join("\n");
  const [doc] = extractK8sManifest(src);
  assert.equal(doc!.references[0]!.namespace, null);
});

test("a PARTIALLY templated metadata.namespace reads as null (unknown), like a wholly templated one", () => {
  // The scanner only tags a value "template" when the action STARTS it, so
  // `app-{{ .Values.env }}` arrives as a literal -- and reading it as one
  // would block every edge to the `app-prod` it actually renders to.
  const src = `apiVersion: v1\nkind: ConfigMap\nmetadata:\n  name: my-config\n  namespace: app-{{ .Values.env }}\n`;
  const [doc] = extractK8sManifest(src);
  assert.equal(doc!.resource?.namespace, null);
});

test("a YAML null metadata.namespace reads as null (unknown), in either spelling", () => {
  // `~` and `null` are the same empty value as an absent key. `null` can only
  // be excluded by name: stripQuotes already ran, so a quoted "null" is
  // indistinguishable here -- and unknown is the direction that never blocks.
  for (const spelling of ["null", "Null", "NULL", "~"]) {
    const src = `apiVersion: v1\nkind: ConfigMap\nmetadata:\n  name: my-config\n  namespace: ${spelling}\n`;
    const [doc] = extractK8sManifest(src);
    assert.equal(doc!.resource?.namespace, null, `namespace: ${spelling} must not read as a literal namespace`);
  }
});

test("an anchored or tagged metadata.namespace reads as null (unknown), never as the decorated text", () => {
  // A line-oriented scan sees `&ns prod` / `!!str prod` whole; neither is a
  // name any other document's namespace can be compared against.
  for (const decorated of ["&ns prod", "!!str prod"]) {
    const src = `apiVersion: v1\nkind: ConfigMap\nmetadata:\n  name: my-config\n  namespace: ${decorated}\n`;
    const [doc] = extractK8sManifest(src);
    assert.equal(doc!.resource?.namespace, null, `namespace: ${decorated} must not read as a literal namespace`);
  }
});

test("a document with TWO conflicting metadata.namespace entries reads as null (unknown), not as the first", () => {
  // The Helm `{{- if }}` / `{{- else }}` shape: both branches are emitted as
  // entries on the same path, and taking the first would confidently block
  // every edge to the other branch's namespace.
  const src = [
    `apiVersion: v1`, `kind: ConfigMap`,
    `metadata:`, `  name: my-config`,
    `{{- if .Values.isProd }}`, `  namespace: prod`,
    `{{- else }}`, `  namespace: staging`, `{{- end }}`, ``,
  ].join("\n");
  const [doc] = extractK8sManifest(src);
  assert.equal(doc!.resource?.namespace, null);
});

test("a document with two AGREEING metadata.namespace entries reads as that namespace", () => {
  // Unambiguous agreement is still a namespace this scanner can compare; only
  // disagreement is unknown.
  const src = [
    `apiVersion: v1`, `kind: ConfigMap`,
    `metadata:`, `  name: my-config`,
    `{{- if .Values.pinned }}`, `  namespace: prod`,
    `{{- else }}`, `  namespace: prod`, `{{- end }}`, ``,
  ].join("\n");
  const [doc] = extractK8sManifest(src);
  assert.equal(doc!.resource?.namespace, "prod");
});
