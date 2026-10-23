import { cleanupDir, isolatedCliEnv, tempDir } from "./fixtures.js";
/**
 * End-to-end coverage of the YAML/Helm/Kubernetes/Kustomize slice of the
 * LanguageSpec registry ("YAML and Helm join the LanguageSpec registry with
 * conservative reference semantics"): the real CLI on a temp git repo after
 * `hunch init --no-providers`, asserting the stored symbols/edges, query/why,
 * MCP blast radius, a strict YAML-scoped constraint, and robustness. Fixtures
 * are generated here; nothing large is checked in. Known limits from #382
 * (remote resources, components:, bases:, globs, a kustomization cycle, two
 * kustomization files in one dir) are asserted as their documented fallback.
 */
import { after, before, describe, test } from "node:test";
import assert from "node:assert/strict";
import { execFileSync, spawnSync } from "node:child_process";
import { mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";
import { hunchPaths } from "../src/core/paths.js";
import { symbolId } from "../src/core/ids.js";
import { pathMatchesGlob } from "../src/core/glob.js";
import { HunchStore } from "../src/store/hunchStore.js";
import { buildServer } from "../src/mcp/server.js";
import { hunchCliArgs } from "./cli-invocation.js";

interface Fixture { sandbox: string; root: string; env: NodeJS.ProcessEnv }
interface Run { status: number | null; stdout: string; stderr: string }
interface Graph {
  symbols: Array<{ id: string; name: string; file: string; kind: string }>;
  edges: Array<{ from: string; to: string; type: string }>;
  components: Array<{ id: string; name: string; paths: string[] }>;
}

function makeEnv(sandbox: string): NodeJS.ProcessEnv {
  const home = join(sandbox, "home");
  mkdirSync(home, { recursive: true });
  return isolatedCliEnv({
    HOME: home, USERPROFILE: home, XDG_CONFIG_HOME: join(home, ".config"), APPDATA: join(home, "AppData"),
    GIT_CONFIG_NOSYSTEM: "1", HUNCH_PRIVATE_DIR: "", HUNCH_SYNC: "1", HUNCH_SYNTH_PROVIDER: "deterministic", NO_COLOR: "1", CI: "1",
  });
}

function git(f: Fixture, ...args: string[]): string {
  return execFileSync("git", args, { cwd: f.root, env: f.env, encoding: "utf8", stdio: ["ignore", "pipe", "pipe"] }).trim();
}

function hunch(f: Fixture, ...args: string[]): Run {
  const r = spawnSync(process.execPath, hunchCliArgs(...args), { cwd: f.root, env: f.env, encoding: "utf8", timeout: 120_000 });
  return { status: r.status, stdout: r.stdout ?? "", stderr: r.stderr ?? "" };
}

function ok(f: Fixture, ...args: string[]): Run {
  const r = hunch(f, ...args);
  assert.equal(r.status, 0, `hunch ${args.join(" ")} failed:\n${r.stdout}\n${r.stderr}`);
  return r;
}

function write(f: Fixture, rel: string, text: string | Buffer): void {
  mkdirSync(join(f.root, rel, ".."), { recursive: true });
  writeFileSync(join(f.root, rel), text);
}

/** A temp git repo with `files` committed, `hunch init --no-providers`, then `hunch index`. */
function makeRepo(label: string, files: Record<string, string | Buffer>): Fixture {
  const sandbox = tempDir(`hunch-helmk8s-${label}-`);
  const root = join(sandbox, "repo");
  mkdirSync(root, { recursive: true });
  const f: Fixture = { sandbox, root, env: makeEnv(sandbox) };
  git(f, "init", "-q", "-b", "main");
  git(f, "config", "user.email", "helm-k8s@example.com");
  git(f, "config", "user.name", "Helm K8s");
  git(f, "config", "commit.gpgsign", "false");
  git(f, "config", "core.autocrlf", "false");
  for (const [rel, text] of Object.entries(files)) write(f, rel, text);
  git(f, "add", "-A");
  git(f, "commit", "-qm", "fixture: manifests");
  ok(f, "init", "--no-providers", "--no-agent-hooks", "--no-auto-commit");
  ok(f, "index", "--no-auto-commit");
  return f;
}

function graph(f: Fixture): Graph {
  const store = new HunchStore(hunchPaths(f.root));
  try {
    return {
      symbols: store.json.loadAll("symbols") as Graph["symbols"],
      edges: store.json.loadAll("edges") as Graph["edges"],
      components: store.json.loadAll("components") as Graph["components"],
    };
  } finally {
    store.close();
  }
}

function sym(g: Graph, file: string, name: string): Graph["symbols"][number] {
  const s = g.symbols.find((x) => x.file === file && x.name === name);
  assert.ok(s, `no symbol ${name} in ${file}; have: ${g.symbols.filter((x) => x.file === file).map((x) => x.name).join(", ")}`);
  return s!;
}

function refsFrom(g: Graph, id: string): string[] {
  return g.edges.filter((e) => e.from === id && e.type === "references").map((e) => e.to).sort();
}

function refsTo(g: Graph, id: string): string[] {
  return g.edges.filter((e) => e.to === id && e.type === "references").map((e) => e.from).sort();
}

// ---------------------------------------------------------------------------
// Fixtures
// ---------------------------------------------------------------------------

const CHART = "charts/web";
const HELM_FILES: Record<string, string> = {
  [`${CHART}/Chart.yaml`]: `apiVersion: v2\nname: web\nversion: 0.1.0\n`,
  [`${CHART}/values.yaml`]: [
    `replicaCount: 2`,
    `image:`,
    `  repository: nginx`,
    `  tag: "1.25"`,
    `defaults: &resourceDefaults`,
    `  cpu: 100m`,
    `  memory: 128Mi`,
    `resources:`,
    `  limits: *resourceDefaults`,
    ``,
  ].join("\n"),
  [`${CHART}/templates/_helpers.tpl`]: [
    `{{- define "web.name" -}}`,
    `{{ .Chart.Name }}`,
    `{{- end -}}`,
    `{{- define "web.fullname" -}}`,
    `{{- if .Values.fullnameOverride -}}`,
    `{{ .Values.fullnameOverride }}`,
    `{{- else -}}`,
    `{{ .Release.Name }}-{{ include "web.name" . }}`,
    `{{- end -}}`,
    `{{- end -}}`,
    `{{- define "web.labels" -}}`,
    `app: web`,
    `chart: {{ include "web.name" . }}`,
    `{{- end -}}`,
    ``,
  ].join("\n"),
  // Multi-document template: Deployment + ConfigMap, literal names, helper includes,
  // and .Values lookups.
  [`${CHART}/templates/deployment.yaml`]: [
    `apiVersion: apps/v1`,
    `kind: Deployment`,
    `metadata:`,
    `  name: web`,
    `  labels:`,
    `    {{- include "web.labels" . | nindent 4 }}`,
    `spec:`,
    `  replicas: {{ .Values.replicaCount }}`,
    `  selector:`,
    `    matchLabels:`,
    `      app: web`,
    `  template:`,
    `    metadata:`,
    `      labels:`,
    `        app: web`,
    `    spec:`,
    `      containers:`,
    `      - name: web`,
    `        image: "{{ .Values.image.repository }}:{{ .Values.image.tag }}"`,
    `        envFrom:`,
    `        - configMapRef:`,
    `            name: web-config`,
    `---`,
    `apiVersion: v1`,
    `kind: ConfigMap`,
    `metadata:`,
    `  name: web-config`,
    `  labels:`,
    `    {{- include "web.labels" . | nindent 4 }}`,
    `data:`,
    `  greeting: hello`,
    ``,
  ].join("\n"),
  [`${CHART}/templates/service.yaml`]: [
    `apiVersion: v1`,
    `kind: Service`,
    `metadata:`,
    `  name: {{ include "web.fullname" . }}`,
    `spec:`,
    `  selector:`,
    `    app: web`,
    `  ports:`,
    `  - port: 80`,
    ``,
  ].join("\n"),
};

const K8S_FILE = "k8s/app.yaml";
const K8S_SHARED = "k8s/shared.yaml";
const K8S_FILES: Record<string, string> = {
  [K8S_FILE]: [
    `apiVersion: apps/v1`, `kind: Deployment`, `metadata:`, `  name: api`, `  namespace: shop`,
    `spec:`, `  selector:`, `    matchLabels:`, `      app: api`, `  template:`, `    metadata:`, `      labels:`, `        app: api`,
    `    spec:`, `      containers:`, `      - name: api`, `        envFrom:`, `        - configMapRef:`, `            name: api-config`,
    `      volumes:`, `      - name: cfg`, `        configMap:`, `          name: api-files`,
    `---`,
    `apiVersion: v1`, `kind: Service`, `metadata:`, `  name: api`, `  namespace: shop`,
    `spec:`, `  selector:`, `    app: api`, `  ports:`, `  - port: 80`,
    `---`,
    `apiVersion: v1`, `kind: ConfigMap`, `metadata:`, `  name: api-config`, `  namespace: shop`, `data:`, `  k: v`,
    `---`,
    `apiVersion: v1`, `kind: ConfigMap`, `metadata:`, `  name: api-files`, `  namespace: shop`, `data:`, `  f: x`,
    `---`,
    `apiVersion: networking.k8s.io/v1`, `kind: Ingress`, `metadata:`, `  name: api`, `  namespace: shop`,
    `spec:`, `  rules:`, `  - http:`, `      paths:`, `      - path: /`, `        pathType: Prefix`, `        backend:`,
    `          service:`, `            name: api`, `            port:`, `              number: 80`,
    ``,
  ].join("\n"),
  // Same kind/name in two namespaces, each with an Ingress pointing at its own Service.
  [K8S_SHARED]: ["a", "b"].map((ns) => [
    `apiVersion: v1`, `kind: Service`, `metadata:`, `  name: web`, `  namespace: ${ns}`, `spec:`, `  ports:`, `  - port: 80`,
    `---`,
    `apiVersion: networking.k8s.io/v1`, `kind: Ingress`, `metadata:`, `  name: ing-${ns}`, `  namespace: ${ns}`,
    `spec:`, `  defaultBackend:`, `    service:`, `      name: web`, ``,
  ].join("\n")).join("---\n"),
};

// Kustomize scenarios. Each lives under its own Chart.yaml so its files share one
// resolution scope (raw manifests otherwise resolve per file): an un-namespaced
// Deployment listed by the kustomization references ConfigMap `cfg`, which exists
// in both prod and dev outside it. Exactly [cm-prod] proves the prod transformer
// applied; [] proves no transformer (two candidates -> ambiguous, no guess).
const DEPLOY = [
  `apiVersion: apps/v1`, `kind: Deployment`, `metadata:`, `  name: api`, `spec:`, `  template:`, `    spec:`,
  `      containers:`, `      - name: app`, `        envFrom:`, `        - configMapRef:`, `            name: cfg`, ``,
].join("\n");
const cm = (ns: string) => `apiVersion: v1\nkind: ConfigMap\nmetadata:\n  name: cfg\n  namespace: ${ns}\n`;
function kustScenario(dir: string, extra: Record<string, string>): Record<string, string> {
  return {
    [`kust/${dir}/Chart.yaml`]: `apiVersion: v2\nname: ${dir}\nversion: 0.1.0\n`,
    [`kust/${dir}/cm-prod.yaml`]: cm("prod"),
    [`kust/${dir}/cm-dev.yaml`]: cm("dev"),
    ...Object.fromEntries(Object.entries(extra).map(([k, v]) => [`kust/${dir}/${k}`, v])),
  };
}
const KUST_FILES: Record<string, string> = {
  ...kustScenario("control", { "deploy.yaml": DEPLOY }),
  ...kustScenario("single", {
    "base/kustomization.yaml": `resources:\n- deploy.yaml\n`,
    "base/deploy.yaml": DEPLOY,
    "overlays/prod/kustomization.yaml": `apiVersion: kustomize.config.k8s.io/v1beta1\nkind: Kustomization\nnamespace: prod\nresources:\n- ../../base\npatches:\n- path: replicas.yaml\n`,
    "overlays/prod/replicas.yaml": `apiVersion: apps/v1\nkind: Deployment\nmetadata:\n  name: api\nspec:\n  replicas: 3\n`,
  }),
  // Nested: prod -> mid -> base, the outermost namespace wins.
  ...kustScenario("nested", {
    "base/kustomization.yaml": `namespace: dev\nresources:\n- deploy.yaml\n`,
    "base/deploy.yaml": DEPLOY,
    "mid/kustomization.yaml": `namespace: dev\nresources:\n- ../base\n`,
    "top/kustomization.yaml": `namespace: prod\nresources: [../mid]\n`,
  }),
  // One base shared by dev and prod overlays -> UNKNOWN namespace -> still ambiguous.
  ...kustScenario("shared", {
    "base/kustomization.yaml": `resources:\n- deploy.yaml\n`,
    "base/deploy.yaml": DEPLOY,
    "overlays/dev/kustomization.yaml": `namespace: dev\nresources:\n- ../../base\n`,
    "overlays/prod/kustomization.yaml": `namespace: prod\nresources:\n- ../../base\n`,
  }),
  // Unsupported per #382: bases: (deprecated field) is not followed.
  ...kustScenario("bases", {
    "base/kustomization.yaml": `resources:\n- deploy.yaml\n`,
    "base/deploy.yaml": DEPLOY,
    "overlay/kustomization.yaml": `namespace: prod\nbases:\n- ../base\n`,
  }),
  // Unsupported per #382: remote resource, glob and components: entries are ignored;
  // the local base listed alongside them is still followed.
  ...kustScenario("mixed", {
    "base/kustomization.yaml": `resources:\n- deploy.yaml\n`,
    "base/deploy.yaml": DEPLOY,
    "comp/kustomization.yaml": `apiVersion: kustomize.config.k8s.io/v1alpha1\nkind: Component\nresources:\n- extra.yaml\n`,
    "comp/extra.yaml": cm("comp"),
    "overlay/kustomization.yaml": `namespace: prod\nresources:\n- https://github.com/example/repo//deploy?ref=v1.0.0\n- "*.yaml"\n- ../base\ncomponents:\n- ../comp\n`,
  }),
  // Unsupported per #382: a glob-only kustomization matches nothing.
  ...kustScenario("glob", {
    "kustomization.yaml": `namespace: prod\nresources:\n- "*.yaml"\n`,
    "deploy.yaml": DEPLOY,
  }),
  // Unsupported per #382: two kustomizations listing each other -> no root renders.
  ...kustScenario("cycle", {
    "a/kustomization.yaml": `namespace: prod\nresources:\n- ../b\n- deploy.yaml\n`,
    "a/deploy.yaml": DEPLOY,
    "b/kustomization.yaml": `namespace: dev\nresources:\n- ../a\n`,
  }),
  // Two kustomization files in one dir -> the later one read wins.
  ...kustScenario("twofiles", {
    "kustomization.yaml": `namespace: dev\nresources:\n- deploy.yaml\n`,
    "kustomization.yml": `namespace: prod\nresources:\n- deploy.yaml\n`,
    "deploy.yaml": DEPLOY,
  }),
};

// ---------------------------------------------------------------------------
// One shared repo for helm / k8s / kustomize (indexed once)
// ---------------------------------------------------------------------------

let repo: Fixture;
let g: Graph;

before(() => {
  repo = makeRepo("main", { "README.md": "# fixture\n", ...HELM_FILES, ...K8S_FILES, ...KUST_FILES });
  g = graph(repo);
});

after(() => {
  if (repo) cleanupDir(repo.sandbox);
});

describe("helm chart", () => {
  const helpers = `${CHART}/templates/_helpers.tpl`;
  const deploy = `${CHART}/templates/deployment.yaml`;
  const service = `${CHART}/templates/service.yaml`;
  const values = `${CHART}/values.yaml`;

  test("helm: named templates, resources and values anchors are indexed as symbols", () => {
    for (const name of ["web.name", "web.fullname", "web.labels"]) assert.equal(sym(g, helpers, name).kind, "variable");
    sym(g, deploy, "Deployment/web");
    sym(g, deploy, "ConfigMap/web-config");
    const svc = g.symbols.find((s) => s.file === service && s.name.startsWith("Service/"));
    assert.ok(svc, "the templated-name Service is a resource symbol");
    assert.match(svc!.name, /web\.fullname/, "a templated name keeps its raw template text, never a guessed render");
    sym(g, values, "resourceDefaults");
  });

  test("helm: include edges point from templates to helpers; helper composition is an edge too", () => {
    const labels = sym(g, helpers, "web.labels").id;
    const name = sym(g, helpers, "web.name").id;
    const fullname = sym(g, helpers, "web.fullname").id;
    assert.ok(refsFrom(g, sym(g, deploy, "Deployment/web").id).includes(labels), "Deployment includes web.labels");
    assert.ok(refsFrom(g, sym(g, deploy, "ConfigMap/web-config").id).includes(labels), "the second document includes web.labels");
    assert.ok(refsTo(g, fullname).some((id) => g.symbols.find((s) => s.id === id)?.file === service), "service.yaml includes web.fullname");
    assert.ok(refsFrom(g, fullname).includes(name), "web.fullname includes web.name");
    assert.ok(refsFrom(g, labels).includes(name), "web.labels includes web.name");
  });

  test("helm: chart-scoped K8s references resolve across the chart (configMapRef, selector)", () => {
    const dep = sym(g, deploy, "Deployment/web").id;
    assert.ok(refsFrom(g, dep).includes(sym(g, deploy, "ConfigMap/web-config").id), "envFrom.configMapRef -> ConfigMap");
    const svc = g.symbols.find((s) => s.file === service && s.name.startsWith("Service/"))!;
    assert.ok(refsFrom(g, svc.id).includes(dep), "Service selector app=web -> Deployment pod labels");
  });

  test("helm: values YAML aliases resolve to anchors; .Values lookups are not reference edges (conservative semantics)", () => {
    const anchor = sym(g, values, "resourceDefaults").id;
    assert.ok(refsTo(g, anchor).length >= 1, "the *resourceDefaults alias references its anchor");
    const valuesIds = new Set(g.symbols.filter((s) => s.file === values).map((s) => s.id));
    const fromTemplates = g.edges.filter((e) => valuesIds.has(e.to) && g.symbols.find((s) => s.id === e.from)?.file.includes("/templates/"));
    assert.deepEqual(fromTemplates, [], ".Values.x is not modelled as a template -> values-key edge");
  });

  test("helm: the chart is grouped into a component", () => {
    for (const file of [deploy, service, helpers, values]) {
      const hit = g.components.find((c) => c.paths.some((glob) => pathMatchesGlob(file, glob)));
      assert.ok(hit, `a component owns ${file}; components: ${g.components.map((c) => `${c.name}=${c.paths.join("|")}`).join(", ")}`);
    }
  });

  test("helm: query and why find the chart's templates", () => {
    const q = ok(repo, "query", "web.labels");
    assert.match(q.stdout, /web\.labels|_helpers\.tpl/, `query output:\n${q.stdout}`);
    const why = ok(repo, "why", deploy);
    assert.match(why.stdout + why.stderr, /deployment\.yaml/, `why output:\n${why.stdout}\n${why.stderr}`);
  });

  // Issue #486: `references` is the only edge type YAML/Helm emits, so getDependents must follow it.
  test("helm: hunch_get_dependents on a helper lists its includers", async () => {
    const server = buildServer(repo.root);
    const [ct, st] = InMemoryTransport.createLinkedPair();
    await server.connect(st);
    const client = new Client({ name: "helm-k8s-test", version: "0.0.0" });
    await client.connect(ct);
    try {
      const res = await client.callTool({ name: "hunch_get_dependents", arguments: { symbol: sym(g, helpers, "web.labels").id } });
      const text = (res.content as Array<{ type: string; text?: string }>).map((c) => c.text ?? "").join("\n");
      assert.match(text, /Deployment\/web/, `dependents:\n${text}`);
      assert.match(text, /ConfigMap\/web-config/, `dependents:\n${text}`);
    } finally {
      await client.close();
      await server.close();
    }
  });

  test("helm: a helper's file blast radius (check --blast) includes the templates that include it", () => {
    const store = new HunchStore(hunchPaths(repo.root));
    try {
      const files = store.blastRadiusFiles(helpers).map((b) => b.file);
      assert.ok(files.includes(deploy), `blast radius of ${helpers}: ${files.join(", ")}`);
    } finally {
      store.close();
    }
  });
});

describe("raw kubernetes manifests", () => {
  test("k8s: multi-document resources get kind/name ids; same kind/name in two namespaces is disambiguated by namespace", () => {
    for (const name of ["Deployment/api", "Service/api", "ConfigMap/api-config", "ConfigMap/api-files", "Ingress/api"]) {
      assert.equal(sym(g, K8S_FILE, name).id, symbolId(K8S_FILE, name, "variable"));
    }
    const webs = g.symbols.filter((s) => s.file === K8S_SHARED && s.name === "Service/web").map((s) => s.id).sort();
    assert.deepEqual(webs, [symbolId(K8S_SHARED, "Service/web@a", "variable"), symbolId(K8S_SHARED, "Service/web@b", "variable")].sort());
  });

  test("k8s: configMapRef, volume configMap, ingress backend and selector produce reference edges", () => {
    const id = (n: string) => sym(g, K8S_FILE, n).id;
    assert.deepEqual(refsFrom(g, id("Deployment/api")), [id("ConfigMap/api-config"), id("ConfigMap/api-files")].sort());
    assert.deepEqual(refsFrom(g, id("Ingress/api")), [id("Service/api")]);
    assert.deepEqual(refsFrom(g, id("Service/api")), [id("Deployment/api")]);
  });

  test("k8s: an Ingress resolves only to the same-namespace Service of a shared name", () => {
    for (const ns of ["a", "b"]) {
      assert.deepEqual(refsFrom(g, sym(g, K8S_SHARED, `Ingress/ing-${ns}`).id), [symbolId(K8S_SHARED, `Service/web@${ns}`, "variable")]);
    }
  });
});

describe("kustomize", () => {
  const cfgRefs = (dir: string, deployRel: string) => {
    const dep = sym(g, `kust/${dir}/${deployRel}`, "Deployment/api").id;
    const prod = sym(g, `kust/${dir}/cm-prod.yaml`, "ConfigMap/cfg").id;
    const dev = sym(g, `kust/${dir}/cm-dev.yaml`, "ConfigMap/cfg").id;
    return refsFrom(g, dep).map((to) => (to === prod ? "prod" : to === dev ? "dev" : to));
  };

  test("kustomize: without a transformer an un-namespaced reference with two candidates resolves to nothing", () => {
    assert.deepEqual(cfgRefs("control", "deploy.yaml"), []);
  });

  test("kustomize: an overlay's namespace applies to its base's resources (patches ignored)", () => {
    assert.deepEqual(cfgRefs("single", "base/deploy.yaml"), ["prod"]);
  });

  test("kustomize: nested kustomizations — the outermost namespace wins", () => {
    assert.deepEqual(cfgRefs("nested", "base/deploy.yaml"), ["prod"]);
  });

  test("kustomize: a base shared by dev and prod overlays has an UNKNOWN namespace and stays ambiguous", () => {
    assert.deepEqual(cfgRefs("shared", "base/deploy.yaml"), []);
  });

  test("kustomize: deprecated bases: is not followed (documented #382 limit) — base keeps no transformer", () => {
    assert.deepEqual(cfgRefs("bases", "base/deploy.yaml"), []);
  });

  test("kustomize: remote, glob and components: entries are ignored without breaking the local base", () => {
    assert.deepEqual(cfgRefs("mixed", "base/deploy.yaml"), ["prod"]);
    sym(g, "kust/mixed/comp/extra.yaml", "ConfigMap/cfg");
  });

  test("kustomize: a glob resource matches nothing (documented #382 limit)", () => {
    assert.deepEqual(cfgRefs("glob", "deploy.yaml"), []);
  });

  test("kustomize: two kustomizations listing each other render no root (documented #382 limit), no crash", () => {
    assert.deepEqual(cfgRefs("cycle", "a/deploy.yaml"), []);
  });

  test("kustomize: two kustomization files in one dir — the later one wins", () => {
    assert.deepEqual(cfgRefs("twofiles", "deploy.yaml"), ["prod"], "kustomization.yml is read after kustomization.yaml");
  });
});

// ---------------------------------------------------------------------------
// Constraint on YAML templates, via the strict staged gate
// ---------------------------------------------------------------------------

describe("helm constraint gate", () => {
  let f: Fixture;
  before(() => {
    f = makeRepo("gate", HELM_FILES);
    ok(f, "record-constraint", "Chart templates must never enable hostNetwork",
      "--scope", `${CHART}/templates/**`, "--severity", "blocking", "--type", "security",
      "--match", "hostNetwork:\\s*true", "--rationale", "pods must not share the node network");
    git(f, "add", "-A");
    git(f, "commit", "-qm", "chore: record constraint");
  });
  after(() => {
    if (f) cleanupDir(f.sandbox);
  });

  test("helm: check --staged --strict blocks a violating template change and passes a compliant one", () => {
    const deploy = `${CHART}/templates/deployment.yaml`;
    const original = HELM_FILES[deploy]!;
    write(f, deploy, original.replace("    spec:\n      containers:", "    spec:\n      hostNetwork: true\n      containers:"));
    git(f, "add", deploy);
    const bad = hunch(f, "check", "--staged", "--strict");
    assert.notEqual(bad.status, 0, `violation must block:\n${bad.stdout}\n${bad.stderr}`);
    assert.match(bad.stdout + bad.stderr, /hostNetwork/);

    write(f, deploy, original.replace("    spec:\n      containers:", "    spec:\n      hostNetwork: false\n      containers:"));
    git(f, "add", deploy);
    const good = hunch(f, "check", "--staged", "--strict");
    assert.equal(good.status, 0, `compliant change must pass:\n${good.stdout}\n${good.stderr}`);
  });
});

// ---------------------------------------------------------------------------
// Robustness
// ---------------------------------------------------------------------------

describe("helm/k8s robustness", () => {
  test("k8s: malformed YAML, a binary .yaml and an enormous values file never crash the index", () => {
    const big = Array.from({ length: 40_000 }, (_, i) => `key${i}:\n  nested: value-${i}-${"x".repeat(8)}`).join("\n") + "\n";
    const f = makeRepo("robust", {
      [`${CHART}/Chart.yaml`]: `apiVersion: v2\nname: web\nversion: 0.1.0\n`,
      [`${CHART}/values.yaml`]: big,
      [`${CHART}/templates/broken.yaml`]: `apiVersion: v1\nkind: ConfigMap\nmetadata:\n  name: [unclosed\n  : : :\n\t- bad indent\n`,
      "k8s/broken.yaml": `kind: Service\nmetadata:\n  name: "unterminated\n  namespace: {a: [b\n`,
      "k8s/binary.yaml": Buffer.from([0x00, 0xff, 0xfe, 0x00, 0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 0x00, 0x00]),
      "k8s/ok.yaml": `apiVersion: v1\nkind: ConfigMap\nmetadata:\n  name: fine\n`,
    });
    try {
      const again = ok(f, "index", "--no-auto-commit");
      assert.doesNotMatch(again.stderr, /TypeError|RangeError|at .*\.ts:\d+/, `no stack trace:\n${again.stderr}`);
      const rg = graph(f);
      sym(rg, "k8s/ok.yaml", "ConfigMap/fine");
    } finally {
      cleanupDir(f.sandbox);
    }
  });
});
