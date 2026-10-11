import { cleanupDir } from "./fixtures.js";
import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, mkdirSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { hunchPaths } from "../src/core/paths.js";
import { symbolId } from "../src/core/ids.js";
import { HunchStore } from "../src/store/hunchStore.js";
import { indexRepo } from "../src/extractors/indexer.js";
import { extractK8sManifest, extractKustomization, kustomizeNamespaces } from "../src/extractors/k8sManifest.js";

// Issue #382: K8s resource ids derive from identity (kind + namespace + name,
// with the file path already in every symbol id), never from document order;
// and a kustomization's `namespace:` transformer is applied before resolution.

type Indexed = { symbols: Array<{ id: string; name: string; file: string; signature_hash: string }>; edges: Array<{ from: string; to: string; type: string }> };

function indexFixture(prefix: string, files: Record<string, string>): Indexed {
  const root = mkdtempSync(join(tmpdir(), prefix));
  for (const [rel, text] of Object.entries(files)) {
    mkdirSync(join(root, dirname(rel)), { recursive: true });
    writeFileSync(join(root, rel), text);
  }
  const store = new HunchStore(hunchPaths(root));
  store.json.ensureDirs();
  indexRepo(store, root, { churn: false });
  const out = { symbols: store.json.loadAll("symbols"), edges: store.json.loadAll("edges") };
  store.close();
  cleanupDir(root);
  return out;
}

const svcA = `apiVersion: v1\nkind: Service\nmetadata:\n  name: web\n  namespace: a\nspec:\n  ports:\n  - port: 80\n`;
const svcB = `apiVersion: v1\nkind: Service\nmetadata:\n  name: web\n  namespace: b\nspec:\n  ports:\n  - port: 80\n`;
const ingressA = `apiVersion: networking.k8s.io/v1\nkind: Ingress\nmetadata:\n  name: ing\n  namespace: a\nspec:\n  defaultBackend:\n    service:\n      name: web\n`;

// Resource symbol ids in a file, sorted (the per-file module symbol is excluded).
function resourceIds(ix: Indexed, file: string): string[] {
  return ix.symbols.filter((s) => s.file === file && s.name.includes("/")).map((s) => s.id).sort();
}

function referenceEdges(ix: Indexed): string[] {
  return ix.edges.filter((e) => e.type === "references").map((e) => `${e.from}->${e.to}`).sort();
}

test("reordering two same-name Services in different namespaces keeps every id and edge identical (#382)", () => {
  const one = indexFixture("hunch-k8sid-order1-", { "app.yaml": `${svcA}---\n${svcB}---\n${ingressA}` });
  const two = indexFixture("hunch-k8sid-order2-", { "app.yaml": `${svcB}---\n${svcA}---\n${ingressA}` });
  const expected = [
    symbolId("app.yaml", "Service/web@a", "variable"),
    symbolId("app.yaml", "Service/web@b", "variable"),
    symbolId("app.yaml", "Ingress/ing", "variable"), // a unique resource keeps exactly today's id
  ].sort();
  assert.deepEqual(resourceIds(one, "app.yaml"), expected, "same-name Services get kind/name@namespace ids");
  assert.deepEqual(resourceIds(two, "app.yaml"), expected, "each resource keeps its id regardless of document order");
  assert.deepEqual(referenceEdges(one), referenceEdges(two), "edges do not churn when documents are reordered");
  assert.equal(referenceEdges(one).length, 1, "the namespace-a Ingress resolves to the namespace-a Service only");
});

test("the same resource in two overlay directories gets distinct, path-derived ids (#382)", () => {
  const svc = `apiVersion: v1\nkind: Service\nmetadata:\n  name: web\n  namespace: app\n`;
  const ix = indexFixture("hunch-k8sid-overlays-", { "overlays/dev/svc.yaml": svc, "overlays/prod/svc.yaml": svc });
  const dev = ix.symbols.find((s) => s.file === "overlays/dev/svc.yaml" && s.name === "Service/web");
  const prod = ix.symbols.find((s) => s.file === "overlays/prod/svc.yaml" && s.name === "Service/web");
  assert.ok(dev && prod);
  assert.notEqual(dev!.id, prod!.id);
  assert.equal(dev!.id, symbolId("overlays/dev/svc.yaml", "Service/web", "variable"));
  assert.equal(prod!.id, symbolId("overlays/prod/svc.yaml", "Service/web", "variable"));
});

test("a kustomization namespace overrides an explicit different metadata.namespace in a listed manifest (#382)", () => {
  const ingressStaging = ingressA.replace("namespace: a", "namespace: staging");
  const svcProd = svcA.replace("namespace: a", "namespace: prod");
  const ix = indexFixture("hunch-k8sid-kust-file-", {
    "deploy/kustomization.yaml": `apiVersion: kustomize.config.k8s.io/v1beta1\nkind: Kustomization\nnamespace: prod\nresources:\n- app.yaml\n`,
    "deploy/app.yaml": `${ingressStaging}---\n${svcProd}`,
  });
  const ing = ix.symbols.find((s) => s.name === "Ingress/ing");
  const web = ix.symbols.find((s) => s.name === "Service/web");
  assert.ok(ing && web);
  assert.ok(ix.edges.some((e) => e.from === ing!.id && e.to === web!.id && e.type === "references"),
    "Kustomize renders the staging Ingress into prod, so its Service reference resolves to the prod Service");
});

test("a kustomization namespace resolves an un-namespaced manifest in prod across a shared scope (#382)", () => {
  // Chart.yaml only gives these files one shared resolution scope (raw
  // manifests resolve per file); the kustomization is what is under test.
  const cm = (ns: string) => `apiVersion: v1\nkind: ConfigMap\nmetadata:\n  name: cfg\n  namespace: ${ns}\n`;
  const svc = (ns: string) => `apiVersion: v1\nkind: Service\nmetadata:\n  name: web\n  namespace: ${ns}\n`;
  const ix = indexFixture("hunch-k8sid-kust-scope-", {
    "Chart.yaml": `apiVersion: v2\nname: mychart\nversion: 0.1.0\n`,
    "kustomization.yaml": `namespace: prod\nresources:\n  - deploy.yaml\n  - ./ingress.yaml\n  - namespace.yaml\n`,
    "deploy.yaml": `apiVersion: apps/v1\nkind: Deployment\nmetadata:\n  name: api\nspec:\n  template:\n    spec:\n      containers:\n      - name: app\n        envFrom:\n        - configMapRef:\n            name: cfg\n`,
    "ingress.yaml": ingressA.replace("namespace: a", "namespace: staging"),
    "namespace.yaml": `apiVersion: v1\nkind: Namespace\nmetadata:\n  name: prod\n`,
    "cm-prod.yaml": cm("prod"),
    "cm-other.yaml": cm("other"),
    "svc-prod.yaml": svc("prod"),
    "svc-staging.yaml": svc("staging"),
  });
  const byFile = (f: string) => ix.symbols.find((s) => s.file === f && s.name.includes("/"))!; // the resource, not the per-file module symbol
  const refs = (from: string) => ix.edges.filter((e) => e.from === from && e.type === "references").map((e) => e.to);
  assert.deepEqual(refs(byFile("deploy.yaml").id), [byFile("cm-prod.yaml").id], "the un-namespaced Deployment is in prod, so cfg is no longer ambiguous");
  assert.deepEqual(refs(byFile("ingress.yaml").id), [byFile("svc-prod.yaml").id], "the staging Ingress is rendered into prod and targets the prod Service");
  assert.equal(ix.symbols.some((s) => s.file === "namespace.yaml" && s.name.startsWith("Namespace/")), false, "a cluster-scoped Namespace is not a namespaced resource symbol");
});

test("extractK8sManifest's namespace override replaces metadata.namespace but not an explicit backendRefs namespace", () => {
  const src = `apiVersion: gateway.networking.k8s.io/v1\nkind: HTTPRoute\nmetadata:\n  name: r\n  namespace: staging\nspec:\n  rules:\n  - backendRefs:\n    - name: a\n    - name: b\n      namespace: shared\n`;
  const [doc] = extractK8sManifest(src, { namespace: "prod" });
  assert.equal(doc!.resource?.namespace, "prod");
  assert.deepEqual(doc!.references.map((r) => r.namespace), ["prod", "shared"]);
  const [unknown] = extractK8sManifest(src, { namespace: null });
  assert.equal(unknown!.resource?.namespace, null, "a conflicting transformer namespace is UNKNOWN, not the stale explicit one");
  const [none] = extractK8sManifest(src);
  assert.equal(none!.resource?.namespace, "staging", "no transformer keeps today's behaviour");
});

test("extractKustomization reads namespace and block/flow resources, ignoring other keys", () => {
  assert.deepEqual(
    extractKustomization(`namespace: "prod" # env\nresources:\n- a.yaml\n- ../base\npatches:\n- path: p.yaml\n`),
    { namespace: "prod", resources: ["a.yaml", "../base"] },
  );
  assert.deepEqual(extractKustomization(`resources: [a.yaml, 'b.yaml']\n`), { namespace: null, resources: ["a.yaml", "b.yaml"] });
  assert.equal(extractKustomization(`namespace: Not_Valid\n`).namespace, null);
});

test("kustomizeNamespaces: outer overlay wins over its base; a base shared by two overlays is UNKNOWN", () => {
  const files = new Set(["base/svc.yaml", "solo/base/cm.yaml", "plain/x.yaml"]);
  const k = new Map([
    ["base", { namespace: "base-ns", resources: ["svc.yaml"] }],
    ["overlays/dev", { namespace: "dev", resources: ["../../base"] }],
    ["overlays/prod", { namespace: "prod", resources: ["../../base/"] }],
    ["solo/base", { namespace: null, resources: ["cm.yaml"] }],
    ["solo/overlay", { namespace: "prod", resources: ["../base"] }],
    ["plain", { namespace: null, resources: ["x.yaml"] }],
  ]);
  const out = kustomizeNamespaces(k, files);
  assert.equal(out.get("base/svc.yaml"), null, "rendered into both dev and prod");
  assert.ok(out.has("base/svc.yaml"));
  assert.equal(out.get("solo/base/cm.yaml"), "prod", "a single overlay's namespace applies to its base");
  assert.equal(out.has("plain/x.yaml"), false, "no transformer namespace -> no override");
});
