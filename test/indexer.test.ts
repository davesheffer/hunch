import { cleanupDir } from "./fixtures.js";
import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, mkdirSync, readFileSync, writeFileSync, rmSync, symlinkSync } from "node:fs";
import { execFileSync } from "node:child_process";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { hunchPaths } from "../src/core/paths.js";
import { HunchStore } from "../src/store/hunchStore.js";
import { indexRepo, isExtractorEdge, mergeScannedEdges, nearestChartRoot } from "../src/extractors/indexer.js";
import { pathMatchesGlob } from "../src/core/glob.js";
import { edgeId, resourceId, resourceRelationshipId } from "../src/core/ids.js";
import { EdgeSchema, RESOURCE_RELATIONSHIP_SCHEMA_VERSION, extracted } from "../src/core/types.js";
import { SYMLINK_SKIP, indexedFixtureStore, seedRootLevelFileFixture } from "./helpers.js";
import { dirname } from "node:path";

function fixtureRepo(): string {
  const root = mkdtempSync(join(tmpdir(), "hunch-idx-"));
  mkdirSync(join(root, "src/auth"), { recursive: true });
  mkdirSync(join(root, "src/billing"), { recursive: true });
  writeFileSync(join(root, "src/auth/session.ts"), `import { jwtDecode } from "./jwt.js";\nexport function verifySession(t){ return jwtDecode(t); }\n`);
  writeFileSync(join(root, "src/auth/jwt.ts"), `export function jwtDecode(t){ return t; }\n`);
  writeFileSync(join(root, "src/billing/charge.ts"), `import { verifySession } from "../auth/session.js";\nexport function charge(t){ return verifySession(t); }\n`);
  return root;
}

test("indexRepo builds symbols, call edges, components, and cross-file blast radius", () => {
  const root = fixtureRepo();
  const store = new HunchStore(hunchPaths(root));
  store.json.ensureDirs();
  const res = indexRepo(store, root, { churn: false });
  store.reindex();

  assert.equal(res.files, 3);
  assert.ok(res.symbols >= 3);

  const syms = store.json.loadAll("symbols");
  const verify = syms.find((s) => s.name === "verifySession")!;
  assert.ok(verify, "verifySession indexed");

  // charge -> verifySession resolved across files
  const deps = store.getDependents(verify.id).map((d) => d.via);
  assert.ok(deps.some((v) => v.includes("charge")), "charge is a dependent of verifySession");

  // components derived from src/<dir>
  const comps = store.json.loadAll("components").map((c) => c.name).sort();
  assert.deepEqual(comps, ["Auth", "Billing"]);

  store.close();
  cleanupDir(root);
});

test("reindex preserves component enrichment and does not churn timestamps", () => {
  const root = fixtureRepo();
  const store = new HunchStore(hunchPaths(root));
  store.json.ensureDirs();
  indexRepo(store, root, { churn: false });

  // curate: enrichment written onto the stored record (what raiseFragility /
  // a human curation pass does)
  const auth = store.json.loadAll("components").find((c) => c.name === "Auth")!;
  store.json.put("components", {
    ...auth,
    responsibility: "Session verification",
    fragility: 0.4,
    provenance: { ...auth.provenance, source: "human", confidence: 0.95 },
  });
  const before = store.json.loadAll("components").find((c) => c.id === auth.id)!;

  indexRepo(store, root, { churn: false }); // unchanged layout → byte-identical record
  const after = store.json.loadAll("components").find((c) => c.id === auth.id)!;
  assert.equal(after.responsibility, "Session verification", "curated responsibility survives reindex");
  assert.equal(after.fragility, 0.4, "raised fragility survives reindex");
  assert.equal(after.provenance.source, "human", "upgraded provenance survives reindex");
  assert.equal(after.created_at, before.created_at, "created_at is stable");
  assert.equal(after.updated_at, before.updated_at, "updated_at untouched when nothing changed");

  // layout change for the same component → record updates, created_at still stable
  writeFileSync(join(root, "src/auth/mfa.ts"), `export function mfa(){ return true; }\n`);
  indexRepo(store, root, { churn: false });
  const grown = store.json.loadAll("components").find((c) => c.id === auth.id)!;
  assert.equal(grown.created_at, before.created_at, "created_at survives a real change");
  assert.equal(grown.responsibility, "Session verification", "enrichment survives a real change");

  store.close();
  cleanupDir(root);
});

test("fast reindex preserves measured churn instead of rewriting it to zero", () => {
  const root = fixtureRepo();
  const g = (...args: string[]) => execFileSync("git", ["-C", root, ...args], { stdio: "ignore" });
  g("init", "-q");
  g("-c", "user.email=t@t", "-c", "user.name=t", "add", "-A");
  g("-c", "user.email=t@t", "-c", "user.name=t", "commit", "-qm", "initial source");
  writeFileSync(join(root, "src/auth/session.ts"), `import { jwtDecode } from "./jwt.js";\nexport function verifySession(t){ return jwtDecode(t); }\n// measured change\n`);
  g("-c", "user.email=t@t", "-c", "user.name=t", "add", "src/auth/session.ts");
  g("-c", "user.email=t@t", "-c", "user.name=t", "commit", "-qm", "change session source");

  const store = new HunchStore(hunchPaths(root));
  try {
    store.json.ensureDirs();
    indexRepo(store, root);
    const symbolsFile = join(root, ".hunch/symbols/index.json");
    const measured = readFileSync(symbolsFile, "utf8");
    const session = store.json.loadAll("symbols").find((symbol) => symbol.file === "src/auth/session.ts")!;
    assert.ok(session.metrics.churn_90d >= 2, `expected measured churn, got ${session.metrics.churn_90d}`);

    indexRepo(store, root, { churn: false });
    assert.equal(readFileSync(symbolsFile, "utf8"), measured,
      "an unchanged fast scan is byte-identical to the last fully measured graph");
  } finally {
    store.close();
    cleanupDir(root);
  }
});

test("GIT-TRACKED vendored dirs (node_modules, dist) are excluded from indexing", () => {
  const root = fixtureRepo();
  // a repo that TRACKS vendored code: `git ls-files` returns it, the walk never runs
  mkdirSync(join(root, "node_modules/lib"), { recursive: true });
  mkdirSync(join(root, "dist"), { recursive: true });
  writeFileSync(join(root, "node_modules/lib/vendored.ts"), `export function vendored(){ return 1; }\n`);
  writeFileSync(join(root, "dist/build-output.ts"), `export function built(){ return 1; }\n`);
  const g = (...args: string[]) => execFileSync("git", ["-C", root, ...args], { stdio: "ignore" });
  g("init", "-q");
  g("-c", "user.email=t@t", "-c", "user.name=t", "add", "-f", "-A");
  g("-c", "user.email=t@t", "-c", "user.name=t", "commit", "-qm", "vendored tracked");
  const store = new HunchStore(hunchPaths(root));
  store.json.ensureDirs();
  const res = indexRepo(store, root, { churn: false });
  assert.equal(res.files, 3, "only the 3 real source files are indexed");
  const files = new Set(store.json.loadAll("symbols").map((s) => s.file.replace(/\\/g, "/")));
  assert.ok(![...files].some((f) => f.includes("node_modules") || f.startsWith("dist/")), `vendored files indexed: ${[...files].join(", ")}`);
  store.close();
  cleanupDir(root);
});

test("a Git-tracked source symlink is skipped without reading its external target", { skip: SYMLINK_SKIP }, () => {
  const root = mkdtempSync(join(tmpdir(), "hunch-idx-symlink-root-"));
  const outside = mkdtempSync(join(tmpdir(), "hunch-idx-symlink-outside-"));
  const outsideFile = join(outside, "outside.ts");
  const outsideBytes = "export function externalSecretDoNotIndex(){ return 42; }\n";
  writeFileSync(outsideFile, outsideBytes);
  mkdirSync(join(root, "src"), { recursive: true });
  symlinkSync(outsideFile, join(root, "src/external.ts"));
  const g = (...args: string[]) => execFileSync("git", ["-C", root, ...args], { stdio: "ignore" });
  g("init", "-q");
  g("-c", "user.email=t@t", "-c", "user.name=t", "add", "src/external.ts");
  g("-c", "user.email=t@t", "-c", "user.name=t", "commit", "-qm", "track source symlink");

  const store = new HunchStore(hunchPaths(root));
  try {
    store.json.ensureDirs();
    const result = indexRepo(store, root, { churn: false });
    assert.equal(result.files, 1, "the tracked entry is discovered without being trusted");
    assert.equal(result.skipped, 1, "the symlink is reported as a skipped scanner input");
    assert.equal(store.json.loadAll("symbols").length, 0);
    assert.equal(store.json.loadAll("edges").length, 0);
    assert.equal(readFileSync(outsideFile, "utf8"), outsideBytes);
  } finally {
    store.close();
    cleanupDir(root);
    cleanupDir(outside);
  }
});

test("same-named symbols in one file get unique, stable ids (no PK collision)", () => {
  const root = mkdtempSync(join(tmpdir(), "hunch-dup-"));
  mkdirSync(join(root, "src"), { recursive: true });
  // two classes each with a method `run` — same (file,name,kind)
  writeFileSync(join(root, "src/svc.ts"), `class A { run(){ return 1; } }\nclass B { run(){ return 2; } }\n`);
  const store = new HunchStore(hunchPaths(root));
  store.json.ensureDirs();
  indexRepo(store, root, { churn: false });
  store.reindex(); // would throw UNIQUE constraint if ids collided

  const runs = store.json.loadAll("symbols").filter((s) => s.name === "run");
  assert.equal(runs.length, 2);
  assert.equal(new Set(runs.map((s) => s.id)).size, 2, "ids are distinct");

  // stable across a re-run
  const firstIds = runs.map((s) => s.id).sort();
  indexRepo(store, root, { churn: false });
  const secondIds = store.json.loadAll("symbols").filter((s) => s.name === "run").map((s) => s.id).sort();
  assert.deepEqual(secondIds, firstIds);
  store.close();
  cleanupDir(root);
});

test("member call to a top-level function does NOT create an edge; method calls do (regression #4)", () => {
  const root = mkdtempSync(join(tmpdir(), "hunch-member-"));
  mkdirSync(join(root, "src"), { recursive: true });
  writeFileSync(join(root, "src/a.ts"), `export function helper(){ return 1; }\nexport class S { method(){ return 2; } }\n`);
  writeFileSync(
    join(root, "src/b.ts"),
    `import { helper, S } from "./a.js";\n` +
      `export function direct(){ return helper(); }\n` + // direct call -> edge to helper
      `export function viaMember(o){ return o.helper(); }\n` + // member call to a top-level fn name -> NO edge
      `export function viaMethod(s){ return s.method(); }\n`, // member call to a real method -> edge
  );
  const store = new HunchStore(hunchPaths(root));
  store.json.ensureDirs();
  indexRepo(store, root, { churn: false });
  store.reindex();

  const helper = store.json.loadAll("symbols").find((s) => s.name === "helper")!;
  const method = store.json.loadAll("symbols").find((s) => s.name === "method")!;
  const helperDeps = store.getDependents(helper.id).map((d) => d.via);
  assert.ok(helperDeps.some((v) => v.includes("direct")), "direct call creates an edge");
  assert.ok(!helperDeps.some((v) => v.includes("viaMember")), "member call to a top-level fn does NOT");
  const methodDeps = store.getDependents(method.id).map((d) => d.via);
  assert.ok(methodDeps.some((v) => v.includes("viaMethod")), "member call to a real method creates an edge");

  store.close();
  cleanupDir(root);
});

test("unimported same-named callbacks do NOT resolve to unrelated cross-file symbols", () => {
  const root = mkdtempSync(join(tmpdir(), "hunch-callback-name-"));
  mkdirSync(join(root, "src"), { recursive: true });
  writeFileSync(join(root, "src/store.ts"), `export function resolve(id){ return id; }\n`);
  writeFileSync(
    join(root, "src/provider.ts"),
    `export function execute(){ return new Promise((resolve) => resolve("ok")); }\n`,
  );
  const store = new HunchStore(hunchPaths(root));
  store.json.ensureDirs();
  indexRepo(store, root, { churn: false });
  store.reindex();

  const unrelated = store.json.loadAll("symbols").find((s) => s.file === "src/store.ts" && s.name === "resolve")!;
  assert.ok(unrelated, "the unrelated repository symbol is indexed");
  assert.deepEqual(store.getDependents(unrelated.id), [], "a callback parameter with the same name creates no cross-file call edge");

  store.close();
  cleanupDir(root);
});

/** Write `files` (repo-relative path -> content) into a fresh temp repo, index it
 *  with the standard harness, and hand back the loaded records. */
function indexTree(files: Record<string, string>) {
  const root = mkdtempSync(join(tmpdir(), "hunch-idx-"));
  for (const [rel, content] of Object.entries(files)) {
    mkdirSync(dirname(join(root, rel)), { recursive: true });
    writeFileSync(join(root, rel), content);
  }
  const store = new HunchStore(hunchPaths(root));
  store.json.ensureDirs();
  const res = indexRepo(store, root, { churn: false });
  store.reindex();
  return {
    root, store, res,
    symbols: store.json.loadAll("symbols"),
    edges: store.json.loadAll("edges"),
    components: store.json.loadAll("components"),
  };
}

const CHART_YAML = "apiVersion: v2\nname: demo\nversion: 0.1.0\n";

const refsFrom = (edges: Array<{ type: string; from: string }>, id: string) =>
  edges.filter((e) => e.type === "references" && e.from === id);
const refsTo = (edges: Array<{ type: string; to: string }>, id: string) =>
  edges.filter((e) => e.type === "references" && e.to === id);

/** An apps/v1 Deployment whose pod template carries `labels` ("key: value" each);
 *  `extra` is spliced in raw after the container's image line (pre-indented). */
const deploymentYaml = (name: string, labels: string[], extra = ""): string => `apiVersion: apps/v1
kind: Deployment
metadata:
  name: ${name}
spec:
  template:
    metadata:
      labels:
${labels.map((label) => `        ${label}\n`).join("")}    spec:
      containers:
        - name: app
          image: example/app:1.0
${extra}`;

const serviceYaml = (name: string, selectorBlock: string) => `apiVersion: v1
kind: Service
metadata:
  name: ${name}
spec:
${selectorBlock}
  ports:
    - port: 80
`;

const helmDefine = (name: string) => `{{- define "${name}" -}}\napp: demo\n{{- end -}}\n`;
/** A Deployment named "app" whose labels come from a Helm include of `include`. */
const helmDeployment = (include: string): string => `apiVersion: apps/v1
kind: Deployment
metadata:
  name: app
  labels:
    {{- include "${include}" . | nindent 4 }}
`;

function pythonFixtureFiles(): Record<string, string> {
  return {
    "src/auth/session.py": "from .jwt import decode_token\nfrom ..billing.charge import charge\n\ndef verify_session(t):\n    return decode_token(t)\n",
    "src/auth/jwt.py": "def decode_token(t):\n    return t\n",
    "src/billing/charge.py": "def charge(t):\n    return t\n",
  };
}

test("indexRepo resolves Python imports, calls and component dependencies (#5)", () => {
  const { root, store, res, symbols, edges, components } = indexTree(pythonFixtureFiles());

  assert.equal(res.files, 3);
  assert.ok(res.symbols >= 3);

  const verify = symbols.find((s) => s.name === "verify_session")!;
  assert.equal(verify?.file, "src/auth/session.py");
  const decode = symbols.find((s) => s.name === "decode_token")!;
  assert.ok(decode, "decode_token indexed");
  assert.ok(store.getDependents(decode.id).some((d) => d.via.includes("verify_session")));

  assert.deepEqual(components.map((c) => c.name).sort(), ["Auth", "Billing"]);
  const auth = components.find((c) => c.name === "Auth")!;
  const billing = components.find((c) => c.name === "Billing")!;
  // two dots from src/auth resolves to src/billing/charge.py
  assert.ok(edges.some((e) => e.type === "depends_on" && e.from === auth.id && e.to === billing.id));

  store.close();
  cleanupDir(root);
});

test("a relative Python import climbing above the repo root resolves to nothing", () => {
  const { root, store, res, edges } = indexTree({
    "src/auth/session.py": "from ....outside import thing\n\ndef verify(t):\n    return t\n",
    "src/billing/charge.py": "def charge(t):\n    return t\n",
  });
  assert.equal(res.files, 2);
  assert.equal(edges.filter((e) => e.type === "depends_on").length, 0);

  store.close();
  cleanupDir(root);
});

test("a relative Python import that exactly reaches the repo root still resolves", () => {
  const { root, store, components, edges } = indexTree({
    "pkgs/auth/session.py": "from ...otherpkg.mod import value\n\ndef verify(t):\n    return value\n",
    "otherpkg/mod.py": "value = 1\n\ndef helper():\n    return value\n",
  });
  const pkgs = components.find((c) => c.name === "Pkgs")!;
  const other = components.find((c) => c.name === "Otherpkg")!;
  assert.ok(pkgs && other, "both components exist");
  assert.ok(edges.some((e) => e.type === "depends_on" && e.from === pkgs.id && e.to === other.id));

  store.close();
  cleanupDir(root);
});

function bareDotFixture(withInit: boolean): Record<string, string> {
  return {
    "src/billing/api.py": "from . import charge\n\ndef run():\n    return 1\n",
    ...(withInit ? { "src/billing/__init__.py": "def charge():\n    return 1\n" } : {}),
  };
}

test("a bare-dot Python import resolves within its own package without crashing", () => {
  // Crash-safety / discovery check, not an edge check: the target lives in the
  // same component, so no depends_on edge is expected either way.
  const { root: withInitRoot, store: withInitStore, res: withInit, symbols } = indexTree(bareDotFixture(true));
  assert.equal(withInit.files, 2);
  assert.ok(symbols.some((s) => s.name === "charge" && s.file === "src/billing/__init__.py"));
  withInitStore.close();
  cleanupDir(withInitRoot);

  const { root: noInitRoot, store: noInitStore, res: noInit } = indexTree(bareDotFixture(false));
  assert.equal(noInit.files, 1);
  noInitStore.close();
  cleanupDir(noInitRoot);
});

test("absolute Python imports resolve without a src/ layout; stdlib imports do not", () => {
  const { root, store, res, components, edges } = indexTree({
    "authpkg/session.py": "import billingpkg.charge\nimport os\n\ndef verify(t):\n    return t\n",
    "billingpkg/charge.py": "def charge(t):\n    return t\n",
  });
  assert.equal(res.files, 2);
  const auth = components.find((c) => c.name === "Authpkg")!;
  const billing = components.find((c) => c.name === "Billingpkg")!;
  assert.ok(auth && billing);
  const deps = edges.filter((e) => e.type === "depends_on");
  assert.equal(deps.length, 1);
  assert.ok(deps[0]!.from === auth.id && deps[0]!.to === billing.id);

  store.close();
  cleanupDir(root);
});

test("a bare package import resolves through __init__.py", () => {
  const { root, store, components, edges } = indexTree({
    "authpkg/session.py": "import billingpkg\n\ndef verify(t):\n    return t\n",
    "billingpkg/__init__.py": "def charge():\n    return 1\n",
  });
  const auth = components.find((c) => c.name === "Authpkg")!;
  const billing = components.find((c) => c.name === "Billingpkg")!;
  assert.ok(edges.some((e) => e.type === "depends_on" && e.from === auth.id && e.to === billing.id));

  store.close();
  cleanupDir(root);
});

test("an absolute Python import resolves under the src root in a src layout", () => {
  const { root, store, components, edges } = indexTree({
    "src/auth/session.py": "import billing.charge\n\ndef verify(t):\n    return t\n",
    "src/billing/charge.py": "def charge(t):\n    return t\n",
  });
  const auth = components.find((c) => c.name === "Auth")!;
  const billing = components.find((c) => c.name === "Billing")!;
  assert.ok(edges.some((e) => e.type === "depends_on" && e.from === auth.id && e.to === billing.id));

  store.close();
  cleanupDir(root);
});

test("a cross-file member call to a decorated Python method yields an edge", () => {
  const { root, store, symbols } = indexTree({
    "src/auth/session.py": "class Base:\n    @classmethod\n    def create(cls):\n        return cls()\n",
    "src/billing/charge.py": "from ..auth.session import Base\n\ndef use_it(b):\n    return b.create()\n",
  });
  const create = symbols.find((s) => s.name === "create")!;
  assert.ok(create, "create indexed");
  assert.equal(create.kind, "method");
  assert.equal(create.file, "src/auth/session.py");
  const useIt = symbols.find((s) => s.name === "use_it")!;
  assert.ok(useIt && useIt.file !== create.file);
  assert.ok(store.getDependents(create.id).some((d) => d.via.includes("use_it")));

  store.close();
  cleanupDir(root);
});

test("indexing is deterministic — same ids on re-run", () => {
  const root = fixtureRepo();
  const store = new HunchStore(hunchPaths(root));
  store.json.ensureDirs();
  indexRepo(store, root, { churn: false });
  const first = store.json.loadAll("symbols").map((s) => s.id).sort();
  indexRepo(store, root, { churn: false });
  const second = store.json.loadAll("symbols").map((s) => s.id).sort();
  assert.deepEqual(first, second);
  store.close();
  cleanupDir(root);
});

test("YAML aliases become references edges to their anchor and count toward fan_in", () => {
  const { root, store, res, symbols, edges } = indexTree({
    "config/database.yml": "defaults: &defaults\n  adapter: postgres\ndevelopment:\n  <<: *defaults\n  database: dev\n",
  });
  assert.equal(res.files, 1);
  const defaults = symbols.find((s) => s.name === "defaults")!;
  assert.ok(defaults, "anchor indexed");
  assert.equal(defaults.kind, "variable");
  assert.ok(refsTo(edges, defaults.id).length >= 1);
  assert.ok(defaults.metrics.fan_in >= 1);

  store.close();
  cleanupDir(root);
});

test("a Helm include links to its define across files in a chart", () => {
  const { root, store, symbols, edges } = indexTree({
    "Chart.yaml": CHART_YAML,
    "templates/_helpers.tpl": helmDefine("mychart.labels"),
    "templates/deployment.yaml": helmDeployment("mychart.labels"),
  });
  const define = symbols.find((s) => s.name === "mychart.labels" && s.file === "templates/_helpers.tpl")!;
  assert.ok(define, "define indexed");
  assert.equal(define.kind, "variable");
  assert.ok(refsTo(edges, define.id).length >= 1);
  assert.ok(define.metrics.fan_in >= 1);

  store.close();
  cleanupDir(root);
});

test("same-named Helm defines in two charts do not cross-link", () => {
  const chart = (dir: string) => ({
    [`${dir}/Chart.yaml`]: CHART_YAML,
    [`${dir}/templates/_helpers.tpl`]: helmDefine("labels"),
    [`${dir}/templates/deployment.yaml`]: helmDeployment("labels"),
  });
  const { root, store, symbols, edges } = indexTree({ ...chart("chartA"), ...chart("chartB") });
  const fileOf = new Map(symbols.map((s) => [s.id, s.file]));
  for (const dir of ["chartA", "chartB"]) {
    const define = symbols.find((s) => s.name === "labels" && s.kind === "variable" && s.file === `${dir}/templates/_helpers.tpl`)!;
    assert.ok(define, `${dir} define indexed`);
    const incoming = refsTo(edges, define.id);
    assert.ok(incoming.length >= 1, `${dir} define is referenced`);
    assert.ok(incoming.every((e) => fileOf.get(e.from)?.startsWith(`${dir}/`)), `${dir} define only referenced from inside ${dir}`);
  }

  store.close();
  cleanupDir(root);
});

test("a subchart define is not linked to its parent chart's includes (#42)", () => {
  const { root, store, symbols, edges } = indexTree({
    "Chart.yaml": CHART_YAML,
    "templates/_helpers.tpl": helmDefine("labels"),
    "templates/deployment.yaml": helmDeployment("labels"),
    "charts/sub/Chart.yaml": CHART_YAML,
    "charts/sub/templates/_helpers.tpl": helmDefine("labels"),
    "charts/sub/templates/deployment.yaml": helmDeployment("labels"),
  });
  const fileOf = new Map(symbols.map((s) => [s.id, s.file]));
  const parent = symbols.find((s) => s.name === "labels" && s.file === "templates/_helpers.tpl")!;
  const sub = symbols.find((s) => s.name === "labels" && s.file === "charts/sub/templates/_helpers.tpl")!;
  assert.ok(parent && sub, "both defines indexed");
  const intoParent = refsTo(edges, parent.id);
  const intoSub = refsTo(edges, sub.id);
  assert.ok(intoParent.length >= 1 && intoSub.length >= 1);
  assert.ok(intoSub.every((e) => fileOf.get(e.from)?.startsWith("charts/sub/")));
  assert.ok(intoParent.every((e) => !fileOf.get(e.from)?.startsWith("charts/sub/")));

  store.close();
  cleanupDir(root);
});

test("a parent chart include of a subchart-only define is a conservative miss", () => {
  const { root, store, symbols, edges } = indexTree({
    "Chart.yaml": CHART_YAML,
    "templates/deployment.yaml": helmDeployment("sub.labels"),
    "charts/sub/Chart.yaml": CHART_YAML,
    "charts/sub/templates/_helpers.tpl": helmDefine("sub.labels"),
  });
  const define = symbols.find((s) => s.name === "sub.labels")!;
  assert.ok(define, "subchart define indexed");
  assert.equal(define.kind, "variable");
  assert.equal(refsTo(edges, define.id).length, 0);

  store.close();
  cleanupDir(root);
});

test("Helm-looking text outside any chart produces no define and no references", () => {
  const { root, store, symbols, edges } = indexTree({
    "config/notachart.yaml": "note: |\n  {{ include \"something\" . }}\n",
  });
  assert.ok(!symbols.some((s) => s.name === "something"));
  assert.equal(edges.filter((e) => e.type === "references").length, 0);

  store.close();
  cleanupDir(root);
});

test("a Deployment referencing a ConfigMap by name gets a references edge, not a depends_on", () => {
  const { root, store, symbols, edges } = indexTree({
    "Chart.yaml": CHART_YAML,
    "manifests/deployment.yaml": deploymentYaml("my-app", ["app: my-app"], "          envFrom:\n            - configMapRef:\n                name: my-config\n"),
    "manifests/configmap.yaml": "apiVersion: v1\nkind: ConfigMap\nmetadata:\n  name: my-config\ndata:\n  k: v\n",
  });
  const dep = symbols.find((s) => s.name === "Deployment/my-app")!;
  const cm = symbols.find((s) => s.name === "ConfigMap/my-config")!;
  assert.ok(dep && cm, "both resources indexed");
  assert.ok(edges.some((e) => e.type === "references" && e.from === dep.id && e.to === cm.id));
  assert.ok(cm.metrics.fan_in >= 1);
  assert.ok(!edges.some((e) => e.type === "depends_on" && (e.from === dep.id || e.to === dep.id)));

  store.close();
  cleanupDir(root);
});

test("templated resource names resolve by identical template text", () => {
  const name = '{{ include "app.fullname" . }}-secret';
  const { root, store, symbols, edges } = indexTree({
    "Chart.yaml": CHART_YAML,
    "templates/secret.yaml": `apiVersion: v1\nkind: Secret\nmetadata:\n  name: ${name}\nstringData:\n  k: v\n`,
    "templates/deployment.yaml": deploymentYaml("my-app", ["app: my-app"], `          env:\n            - name: K\n              valueFrom:\n                secretKeyRef:\n                  name: ${name}\n                  key: k\n`),
  });
  const secret = symbols.find((s) => s.kind === "variable" && s.file === "templates/secret.yaml" && s.name.startsWith("Secret/"))!;
  const dep = symbols.find((s) => s.name === "Deployment/my-app")!;
  assert.ok(secret && dep, "both resources indexed");
  assert.ok(edges.some((e) => e.type === "references" && e.from === dep.id && e.to === secret.id));

  store.close();
  cleanupDir(root);
});

test("two same-named ConfigMaps in a chart make the reference ambiguous: no edge", () => {
  const cm = "apiVersion: v1\nkind: ConfigMap\nmetadata:\n  name: my-config\ndata:\n  k: v\n";
  const { root, store, symbols, edges } = indexTree({
    "Chart.yaml": CHART_YAML,
    "templates/a.yaml": cm,
    "templates/b.yaml": cm,
    "templates/deployment.yaml": deploymentYaml("my-app", ["app: my-app"], "          envFrom:\n            - configMapRef:\n                name: my-config\n"),
  });
  const dep = symbols.find((s) => s.name === "Deployment/my-app")!;
  assert.equal(refsFrom(edges, dep.id).length, 0);

  store.close();
  cleanupDir(root);
});

test("outside a chart, K8s references resolve only within the same file", () => {
  // The unrelated file deliberately reuses the SAME ConfigMap name: file scope
  // is what must keep the Deployment bound to its own bundle's ConfigMap.
  const cm = "apiVersion: v1\nkind: ConfigMap\nmetadata:\n  name: my-config\ndata:\n  k: v\n";
  const { root, store, symbols, edges } = indexTree({
    "manifests/bundle.yaml": `${deploymentYaml("my-app", ["app: my-app"], "          envFrom:\n            - configMapRef:\n                name: my-config\n")}---\n${cm}`,
    "manifests/unrelated.yaml": cm,
  });
  const dep = symbols.find((s) => s.name === "Deployment/my-app")!;
  const local = symbols.find((s) => s.name === "ConfigMap/my-config" && s.file === "manifests/bundle.yaml")!;
  const other = symbols.find((s) => s.name === "ConfigMap/my-config" && s.file === "manifests/unrelated.yaml")!;
  assert.ok(dep && local && other, "all three resources indexed");
  assert.ok(edges.some((e) => e.type === "references" && e.from === dep.id && e.to === local.id));
  assert.ok(!edges.some((e) => e.type === "references" && e.from === dep.id && e.to === other.id));

  store.close();
  cleanupDir(root);
});

test("a Service selector that is a subset of workload labels links to the workload", () => {
  const { root, store, symbols, edges } = indexTree({
    "Chart.yaml": CHART_YAML,
    "templates/service.yaml": serviceYaml("my-service", "  selector:\n    app: my-app"),
    "templates/deployment.yaml": deploymentYaml("my-app", ["app: my-app", "tier: web"]),
  });
  const svc = symbols.find((s) => s.name === "Service/my-service")!;
  const dep = symbols.find((s) => s.name === "Deployment/my-app")!;
  assert.ok(edges.some((e) => e.type === "references" && e.from === svc.id && e.to === dep.id));

  store.close();
  cleanupDir(root);
});

test("a Service selector that differs from workload labels links nothing", () => {
  const { root, store, symbols, edges } = indexTree({
    "Chart.yaml": CHART_YAML,
    "templates/service.yaml": serviceYaml("my-service", "  selector:\n    app: other-app"),
    "templates/deployment.yaml": deploymentYaml("my-app", ["app: my-app"]),
  });
  const svc = symbols.find((s) => s.name === "Service/my-service")!;
  assert.equal(refsFrom(edges, svc.id).length, 0);

  store.close();
  cleanupDir(root);
});

test("a partially templated selector yields no selector map at all (#82)", () => {
  const { root, store, symbols, edges } = indexTree({
    "Chart.yaml": CHART_YAML,
    "templates/service.yaml": serviceYaml("my-service", '  selector:\n    app: {{ .Values.app }}\n    tier: web'),
    "templates/deployment.yaml": deploymentYaml("my-app", ["tier: web"]),
  });
  const svc = symbols.find((s) => s.name === "Service/my-service")!;
  assert.equal(refsFrom(edges, svc.id).length, 0);

  store.close();
  cleanupDir(root);
});

test("a Service fans out to every workload its selector matches", () => {
  const { root, store, symbols, edges } = indexTree({
    "Chart.yaml": CHART_YAML,
    "templates/service.yaml": serviceYaml("my-service", "  selector:\n    app: my-app"),
    "templates/blue.yaml": deploymentYaml("my-app-blue", ["app: my-app", "track: blue"]),
    "templates/green.yaml": deploymentYaml("my-app-green", ["app: my-app", "track: green"]),
  });
  const svc = symbols.find((s) => s.name === "Service/my-service")!;
  for (const name of ["Deployment/my-app-blue", "Deployment/my-app-green"]) {
    const dep = symbols.find((s) => s.name === name)!;
    assert.ok(edges.some((e) => e.type === "references" && e.from === svc.id && e.to === dep.id), name);
  }

  store.close();
  cleanupDir(root);
});

test("dotted selector keys are compared exactly, not as nested paths", () => {
  const { root, store, symbols, edges } = indexTree({
    "Chart.yaml": CHART_YAML,
    "templates/service.yaml": serviceYaml("my-service", "  selector:\n    app: my-app\n    app.kubernetes.io/instance: prod"),
    "templates/deployment.yaml": deploymentYaml("my-app", ["app: my-app", "app.kubernetes.io/instance: staging"]),
  });
  const svc = symbols.find((s) => s.name === "Service/my-service")!;
  assert.ok(svc, "service indexed");
  assert.equal(refsFrom(edges, svc.id).length, 0);

  store.close();
  cleanupDir(root);
});

test("a quoted selector key taints the whole selector", () => {
  // An unparseable key means we cannot prove the selector is complete; matching
  // on only the keys we did understand could link a Service to the wrong workload.
  const { root, store, symbols, edges } = indexTree({
    "Chart.yaml": CHART_YAML,
    "templates/service.yaml": serviceYaml("svc-a", '  selector:\n    "app.kubernetes.io/name": mychart\n    app.kubernetes.io/instance: rel-a'),
    "templates/deployment.yaml": deploymentYaml("dep-other-chart", ["app.kubernetes.io/name: other", "app.kubernetes.io/instance: rel-a"]),
  });
  const svc = symbols.find((s) => s.name === "Service/svc-a")!;
  assert.ok(svc, "service indexed");
  assert.equal(refsFrom(edges, svc.id).length, 0);

  store.close();
  cleanupDir(root);
});

test("a selector with a conditional Helm block yields no edge", () => {
  const { root, store, symbols, edges } = indexTree({
    "Chart.yaml": CHART_YAML,
    "templates/service.yaml": serviceYaml("my-svc", '  selector:\n    app: my-app\n{{- if .Values.canary }}\n    track: canary\n{{- end }}'),
    "templates/deployment.yaml": deploymentYaml("my-app-canary", ["app: my-app", "track: canary"]),
  });
  const svc = symbols.find((s) => s.name === "Service/my-svc")!;
  assert.equal(refsFrom(edges, svc.id).length, 0);

  store.close();
  cleanupDir(root);
});

test("a flow-mapping selector yields no edge", () => {
  const { root, store, symbols, edges } = indexTree({
    "Chart.yaml": CHART_YAML,
    "templates/service.yaml": serviceYaml("web-svc", "  selector: {app: web-frontend,\n    tier: web}"),
    "templates/deployment.yaml": deploymentYaml("api-backend", ["app: api-backend", "tier: web"]),
  });
  const svc = symbols.find((s) => s.name === "Service/web-svc")!;
  assert.equal(refsFrom(edges, svc.id).length, 0);

  store.close();
  cleanupDir(root);
});

test("block-scalar names are never taken as literal resource names", () => {
  const { root, store, symbols, edges } = indexTree({
    "Chart.yaml": CHART_YAML,
    "templates/configmap.yaml": "apiVersion: v1\nkind: ConfigMap\nmetadata:\n  name: |-\n    shared-config\ndata:\n  k: v\n",
    "templates/deployment.yaml": deploymentYaml("web", ["app: web"], "          envFrom:\n            - configMapRef:\n                name: |-\n                  other-config\n"),
  });
  assert.ok(!symbols.some((s) => s.name.includes("|-")));
  const dep = symbols.find((s) => s.name === "Deployment/web")!;
  assert.ok(dep, "deployment indexed");
  assert.equal(refsFrom(edges, dep.id).length, 0);

  store.close();
  cleanupDir(root);
});

test("block-form Helm includes in selectors and labels never throw or link", () => {
  const { root, store, res, symbols, edges } = indexTree({
    "Chart.yaml": CHART_YAML,
    "templates/service.yaml": serviceYaml("my-service", '  selector:\n    {{- include "demo.selectorLabels" . | nindent 4 }}'),
    "templates/deployment.yaml": "apiVersion: apps/v1\nkind: Deployment\nmetadata:\n  name: my-app\nspec:\n  template:\n    metadata:\n      labels:\n        {{- include \"demo.selectorLabels\" . | nindent 8 }}\n",
  });
  assert.ok(res);
  const svc = symbols.find((s) => s.name === "Service/my-service")!;
  assert.ok(svc, "service still indexed");
  assert.equal(refsFrom(edges, svc.id).length, 0);

  store.close();
  cleanupDir(root);
});

test("a TS call never resolves to a Helm define of the same name", () => {
  const { root, store, symbols, edges } = indexTree({
    "Chart.yaml": CHART_YAML,
    "templates/_helpers.tpl": helmDefine("labels"),
    "src/app.ts": "export function run() { return labels(); }\n",
  });
  const define = symbols.find((s) => s.name === "labels" && s.kind === "variable" && s.file === "templates/_helpers.tpl")!;
  const run = symbols.find((s) => s.name === "run")!;
  assert.ok(define && run, "both symbols indexed");
  assert.ok(!edges.some((e) => e.from === run.id && e.to === define.id));

  store.close();
  cleanupDir(root);
});

test("chart-wide YAML sibling widening does not pollute TS call resolution", () => {
  const { root, store, symbols, edges } = indexTree({
    "Chart.yaml": CHART_YAML,
    "src/helper.ts": "export function labels() { return 1; }\n",
    "src/app.ts": 'import { labels } from "./helper.js";\nexport function run() { return labels(); }\n',
    "values.yaml": "labels: &labels\n  a: 1\n",
  });
  const run = symbols.find((s) => s.name === "run")!;
  const helper = symbols.find((s) => s.name === "labels" && s.file === "src/helper.ts")!;
  assert.ok(run && helper, "both TS symbols indexed");
  const call = edges.find((e) => e.type === "calls" && e.from === run.id);
  assert.ok(call, "run has a calls edge");
  assert.equal(call!.to, helper.id);

  store.close();
  cleanupDir(root);
});

test("a top-level include sharing start byte 0 with a define is attributed by symbol index", () => {
  const { root, store, symbols, edges } = indexTree({
    "Chart.yaml": CHART_YAML,
    "templates/_helpers.tpl": '{{- define "c.name" -}}\nx\n{{- end -}}\n{{ include "c.name" . }}\n',
  });
  const inFile = symbols.filter((s) => s.file === "templates/_helpers.tpl");
  const fileSym = inFile.find((s) => s.kind === "file")!;
  const define = inFile.find((s) => s.name === "c.name" && s.kind === "variable")!;
  assert.ok(fileSym && define, "file root and define both indexed");
  assert.notEqual(fileSym.id, define.id);
  const into = edges.filter((e) => e.type === "references" && e.to === define.id);
  assert.equal(into.length, 1, "exactly one references edge into the included define");
  assert.equal(into[0]!.from, fileSym.id, "the top-level include is attributed to the file root");
  assert.ok(!edges.some((e) => e.from === define.id), "no edge originates from the define");

  store.close();
  cleanupDir(root);
});

for (const dirtyKind of ["staged", "unstaged", "untracked"] as const) {
  test(`requireClean rejects ${dirtyKind} indexed-code changes before graph JSON writes`, () => {
    const root = fixtureRepo();
    const git = (...args: string[]) => execFileSync("git", ["-C", root, ...args], { encoding: "utf8" }).trim();
    git("init", "-q", "-b", "main");
    git("config", "user.email", "index-clean@test.invalid");
    git("config", "user.name", "Index Clean Test");
    git("add", "src");
    git("commit", "-qm", "fixture: clean source");

    const store = new HunchStore(hunchPaths(root));
    try {
      store.json.ensureDirs();
      indexRepo(store, root, { churn: false });
      const symbolsFile = join(root, ".hunch/symbols/index.json");
      const before = readFileSync(symbolsFile);

      if (dirtyKind === "untracked") {
        writeFileSync(join(root, "src/auth/pending.ts"), "export function pending(){ return true; }\n");
      } else {
        writeFileSync(join(root, "src/auth/session.ts"), "export function dirty(){ return false; }\n");
        if (dirtyKind === "staged") git("add", "src/auth/session.ts");
      }

      assert.throws(
        () => indexRepo(store, root, { churn: false, requireClean: true }),
        /dirty indexed code.*commit or stash/i,
      );
      assert.deepEqual(readFileSync(symbolsFile), before, "the failed preflight writes no graph bytes");
    } finally {
      store.close();
      cleanupDir(root);
    }
  });
}

function goFixtureRepo(): string {
  const root = mkdtempSync(join(tmpdir(), "hunch-idx-go-"));
  mkdirSync(join(root, "src/auth"), { recursive: true });
  mkdirSync(join(root, "src/billing"), { recursive: true });
  writeFileSync(join(root, "go.mod"), `module example.com/demo\n\ngo 1.22\n`);
  writeFileSync(
    join(root, "src/auth/session.go"),
    // a same-file direct call (VerifySession -> decodeToken) plus a module-prefixed
    // cross-component import that is only used via a package-qualified (member)
    // call, so import resolution genuinely carries the depends_on edge.
    `package auth\n\nimport (\n\t"fmt"\n\t"example.com/demo/src/billing"\n)\n\nfunc VerifySession(t string) string {\n\tid := decodeToken(t)\n\tfmt.Println(billing.Charge(id))\n\treturn id\n}\n\nfunc decodeToken(t string) string {\n\treturn t\n}\n`,
  );
  writeFileSync(
    join(root, "src/billing/charge.go"),
    `package billing\n\nfunc Charge(t string) string {\n\treturn t\n}\n`,
  );
  return root;
}

test("indexRepo resolves module-prefixed Go imports across component boundaries", () => {
  const root = goFixtureRepo();
  const store = new HunchStore(hunchPaths(root));
  store.json.ensureDirs();
  const res = indexRepo(store, root, { churn: false });
  store.reindex();

  assert.equal(res.files, 2);
  assert.ok(res.symbols >= 3);

  const syms = store.json.loadAll("symbols");
  const verify = syms.find((s) => s.name === "VerifySession");
  assert.ok(verify, "VerifySession indexed");
  assert.equal(verify!.file, "src/auth/session.go");

  const decode = syms.find((s) => s.name === "decodeToken");
  assert.ok(decode, "decodeToken indexed");
  const deps = store.getDependents(decode!.id).map((d) => d.via);
  assert.ok(deps.some((v) => v.includes("VerifySession")), "VerifySession is a dependent of decodeToken");

  const comps = store.json.loadAll("components");
  assert.deepEqual(comps.map((c) => c.name).sort(), ["Auth", "Billing"]);
  const auth = comps.find((c) => c.name === "Auth")!;
  const billing = comps.find((c) => c.name === "Billing")!;
  // "example.com/demo/src/billing" strips the go.mod module prefix to the
  // src/billing directory and must land a depends_on edge; the stdlib "fmt"
  // import resolves to nothing and must not fabricate one.
  const edges = store.json.loadAll("edges");
  assert.ok(
    edges.some((e) => e.type === "depends_on" && e.from === auth.id && e.to === billing.id),
    "Auth depends on Billing through the module-prefixed import",
  );

  store.close();
  cleanupDir(root);
});

test("root-level files are owned by exact path, never a catch-all glob (#34)", (t) => {
  const { store, cleanup } = indexedFixtureStore(seedRootLevelFileFixture);
  t.after(cleanup);
  const root = store.json.loadAll("components").find((c) => c.name === ".")!;
  assert.ok(root, "root component exists");
  assert.deepEqual(root.paths, ["config.ts", "settings.ts"]);
  for (const path of root.paths) {
    assert.equal(pathMatchesGlob("config.ts", path), path === "config.ts");
    assert.equal(pathMatchesGlob("settings.ts", path), path === "settings.ts");
    assert.equal(pathMatchesGlob("src/auth/session.ts", path), false);
  }
});

test("reindex keeps supersedes edges and reviewed relationships (#288)", () => {
  const root = fixtureRepo();
  const store = new HunchStore(hunchPaths(root));
  store.json.ensureDirs();
  const first = indexRepo(store, root, { churn: false });
  const extractorEdgesBefore = store.json.loadAll("edges").filter(isExtractorEdge).length;
  assert.ok(extractorEdgesBefore > 0, "the fixture yields extractor edges");
  assert.equal(extractorEdgesBefore, first.edges, "the scan count covers exactly the extractor edges");

  // shaped exactly like supersedeIn writes it (src/store/hunchStore.ts)
  const supersedes = EdgeSchema.parse({
    schema: "hunch.edge/1",
    id: edgeId("dec_new", "dec_old", "supersedes"),
    from: "dec_new",
    to: "dec_old",
    type: "supersedes",
    reason: "dec_new supersedes dec_old",
    strength: 1,
    provenance: { source: "derived", confidence: 1, evidence: ["dec_new", "dec_old"] },
    environment: null,
    metadata: {},
  });
  store.json.put("edges", supersedes);

  // a human-reviewed Landscape relationship, as `hunch landscape adopt` writes it
  const repositoryId = resourceId("repository", "https://github.com/acme/payments");
  const apiId = resourceId("api", "openapi.yaml");
  const relationship = EdgeSchema.parse({
    schema: RESOURCE_RELATIONSHIP_SCHEMA_VERSION,
    id: resourceRelationshipId(repositoryId, apiId, "contains"),
    from: repositoryId,
    to: apiId,
    type: "contains",
    reason: "repository declares API",
    strength: 1,
    provenance: { source: "extracted:api-declaration", confidence: 0.9, evidence: ["openapi.yaml"] },
    currentness: { status: "unverified", source_revision: "deadbeef" },
    environment: null,
    metadata: { discovery_authority: "reviewed" },
  });
  store.json.put("edges", relationship);

  indexRepo(store, root, { churn: false });

  const after = store.json.loadAll("edges");
  assert.deepEqual(after.find((e) => e.id === supersedes.id), supersedes, "supersedes edge survives reindex");
  assert.deepEqual(after.find((e) => e.id === relationship.id), relationship, "reviewed relationship survives reindex");
  assert.equal(after.filter(isExtractorEdge).length, extractorEdgesBefore, "every extractor edge is still there");

  store.close();
  cleanupDir(root);
});

test("reindex still drops stale extractor edges", () => {
  const root = fixtureRepo();
  const store = new HunchStore(hunchPaths(root));
  store.json.ensureDirs();
  indexRepo(store, root, { churn: false });

  const stale = store.json.loadAll("edges").find((e) => isExtractorEdge(e) && e.reason.includes("charge"));
  assert.ok(stale, "charge -> verifySession edge indexed on the first pass");

  rmSync(join(root, "src/billing/charge.ts"));
  indexRepo(store, root, { churn: false });

  assert.equal(
    store.json.loadAll("edges").find((e) => e.id === stale.id),
    undefined,
    "an extractor edge whose source is gone is not carried forward",
  );

  store.close();
  cleanupDir(root);
});

test("mergeScannedEdges keeps the carried edge on an id collision", () => {
  const carried = EdgeSchema.parse({
    schema: "hunch.edge/1",
    id: edgeId("a", "b", "supersedes"),
    from: "a", to: "b", type: "supersedes",
    reason: "carried", strength: 1,
    provenance: { source: "derived", confidence: 1, evidence: [] },
    environment: null, metadata: {},
  });
  const collidingScan = { ...carried, reason: "scanned", provenance: extracted(0.8, ["src/a.ts"]) };
  const freshScan = EdgeSchema.parse({
    schema: "hunch.edge/1",
    id: edgeId("c", "d", "calls"),
    from: "c", to: "d", type: "calls",
    reason: "c calls d", strength: 0.8,
    provenance: extracted(0.8, ["src/a.ts"]),
    environment: null, metadata: {},
  });

  const merged = mergeScannedEdges([carried], [collidingScan, freshScan]);
  assert.deepEqual(merged, [carried, freshScan], "the carried edge wins, the non-colliding scan is appended");
  assert.equal(new Set(merged.map((e) => e.id)).size, merged.length, "no duplicate ids");
});

// Issue #297 gap 1: a Kubernetes reference resolves WITHIN a namespace. A
// MISSING namespace is UNKNOWN and matches anything; two DIFFERENT literal
// namespaces block the edge.

/** Container-level envFrom pulling every key of ConfigMap `name`. */
const envFromConfigMap = (name: string) => `          envFrom:\n            - configMapRef:\n                name: ${name}\n`;
/** A minimal ConfigMap, optionally pinned to a namespace. */
const nsConfigMap = (name: string, namespace: string | null) =>
  `apiVersion: v1\nkind: ConfigMap\nmetadata:\n  name: ${name}\n${namespace === null ? "" : `  namespace: ${namespace}\n`}data:\n  k: v\n`;
/** Insert `namespace:` right after a manifest's top-level metadata name line. */
const inNamespace = (manifest: string, namespace: string) =>
  manifest.replace(/^( {2}name: .*\n)/m, (line) => `${line}  namespace: ${namespace}\n`);

test("a namespace picks the matching ConfigMap out of two same-named ones", () => {
  const { root, store, symbols, edges } = indexTree({
    "Chart.yaml": CHART_YAML,
    "templates/cm-a.yaml": nsConfigMap("shared-config", "a"),
    "templates/cm-b.yaml": nsConfigMap("shared-config", "b"),
    "templates/deployment.yaml": inNamespace(deploymentYaml("my-app", ["app: my-app"], envFromConfigMap("shared-config")), "a"),
  });
  const dep = symbols.find((s) => s.name === "Deployment/my-app")!;
  const inA = symbols.find((s) => s.name === "ConfigMap/shared-config" && s.file === "templates/cm-a.yaml")!;
  const inB = symbols.find((s) => s.name === "ConfigMap/shared-config" && s.file === "templates/cm-b.yaml")!;
  assert.ok(dep && inA && inB, "all three resources indexed");
  assert.ok(edges.some((e) => e.type === "references" && e.from === dep.id && e.to === inA.id), "namespace a disambiguates to cm-a");
  assert.ok(!edges.some((e) => e.to === inB.id), "nothing links into the namespace-b ConfigMap");

  store.close();
  cleanupDir(root);
});

test("a referrer without a namespace still resolves to a namespaced ConfigMap", () => {
  const { root, store, symbols, edges } = indexTree({
    "Chart.yaml": CHART_YAML,
    "templates/configmap.yaml": nsConfigMap("my-config", "b"),
    "templates/deployment.yaml": deploymentYaml("my-app", ["app: my-app"], envFromConfigMap("my-config")),
  });
  const dep = symbols.find((s) => s.name === "Deployment/my-app")!;
  const cm = symbols.find((s) => s.name === "ConfigMap/my-config")!;
  assert.ok(dep && cm);
  assert.ok(edges.some((e) => e.type === "references" && e.from === dep.id && e.to === cm.id));

  store.close();
  cleanupDir(root);
});

test("different literal namespaces on referrer and target produce no edge", () => {
  const { root, store, symbols, edges } = indexTree({
    "Chart.yaml": CHART_YAML,
    "templates/configmap.yaml": nsConfigMap("my-config", "b"),
    "templates/deployment.yaml": inNamespace(deploymentYaml("my-app", ["app: my-app"], envFromConfigMap("my-config")), "a"),
  });
  const dep = symbols.find((s) => s.name === "Deployment/my-app")!;
  const cm = symbols.find((s) => s.name === "ConfigMap/my-config")!;
  assert.ok(dep && cm, "both resources indexed");
  assert.ok(!edges.some((e) => e.from === dep.id && e.to === cm.id), "a cross-namespace reference never binds");

  store.close();
  cleanupDir(root);
});

test("two candidates surviving the namespace filter still yield no guess", () => {
  const { root, store, symbols, edges } = indexTree({
    "Chart.yaml": CHART_YAML,
    "templates/cm-a.yaml": nsConfigMap("my-config", "a"),
    "templates/cm-any.yaml": nsConfigMap("my-config", null),
    "templates/deployment.yaml": inNamespace(deploymentYaml("my-app", ["app: my-app"], envFromConfigMap("my-config")), "a"),
  });
  const dep = symbols.find((s) => s.name === "Deployment/my-app")!;
  assert.ok(dep);
  assert.equal(refsFrom(edges, dep.id).length, 0);

  store.close();
  cleanupDir(root);
});

test("a Service selector never reaches a workload in another namespace", () => {
  const { root, store, symbols, edges } = indexTree({
    "Chart.yaml": CHART_YAML,
    "manifests/service.yaml": inNamespace(serviceYaml("web-svc", "  selector:\n    app: web"), "a"),
    "manifests/web-b.yaml": inNamespace(deploymentYaml("web-b", ["app: web"]), "b"),
    "manifests/web-any.yaml": deploymentYaml("web-any", ["app: web"]),
  });
  const svc = symbols.find((s) => s.name === "Service/web-svc")!;
  const inB = symbols.find((s) => s.name === "Deployment/web-b")!;
  const unscoped = symbols.find((s) => s.name === "Deployment/web-any")!;
  assert.ok(svc && inB && unscoped, "all three resources indexed");
  assert.ok(!edges.some((e) => e.from === svc.id && e.to === inB.id), "label match across namespaces is not a selection");
  assert.ok(edges.some((e) => e.type === "references" && e.from === svc.id && e.to === unscoped.id));

  store.close();
  cleanupDir(root);
});

test("a namespaced referrer still resolves to a ConfigMap without a namespace", () => {
  const { root, store, symbols, edges } = indexTree({
    "Chart.yaml": CHART_YAML,
    "templates/configmap.yaml": nsConfigMap("my-config", null),
    "templates/deployment.yaml": inNamespace(deploymentYaml("my-app", ["app: my-app"], envFromConfigMap("my-config")), "a"),
  });
  const dep = symbols.find((s) => s.name === "Deployment/my-app")!;
  const cm = symbols.find((s) => s.name === "ConfigMap/my-config")!;
  assert.ok(dep && cm);
  assert.ok(edges.some((e) => e.type === "references" && e.from === dep.id && e.to === cm.id));

  store.close();
  cleanupDir(root);
});

test("unscoped and same-namespace Service selectors both bind to a namespaced workload", () => {
  const { root, store, symbols, edges } = indexTree({
    "Chart.yaml": CHART_YAML,
    "manifests/svc-any.yaml": serviceYaml("svc-any", "  selector:\n    app: web"),
    "manifests/svc-b.yaml": inNamespace(serviceYaml("svc-b", "  selector:\n    app: web"), "b"),
    "manifests/deployment.yaml": inNamespace(deploymentYaml("web", ["app: web"]), "b"),
  });
  const dep = symbols.find((s) => s.name === "Deployment/web")!;
  assert.ok(dep);
  for (const name of ["Service/svc-any", "Service/svc-b"]) {
    const svc = symbols.find((s) => s.name === name)!;
    assert.ok(svc, `${name} indexed`);
    assert.ok(edges.some((e) => e.type === "references" && e.from === svc.id && e.to === dep.id), `${name} selects the workload`);
  }

  store.close();
  cleanupDir(root);
});

test("a namespace mixing literal text with a template expression is treated as unknown", () => {
  const { root, store, symbols, edges } = indexTree({
    "Chart.yaml": CHART_YAML,
    "templates/configmap.yaml": nsConfigMap("my-config", "app-prod"),
    "templates/deployment.yaml": inNamespace(deploymentYaml("my-app", ["app: my-app"], envFromConfigMap("my-config")), "app-{{ .Values.env }}"),
  });
  const dep = symbols.find((s) => s.name === "Deployment/my-app")!;
  const cm = symbols.find((s) => s.name === "ConfigMap/my-config")!;
  assert.ok(dep && cm);
  assert.ok(edges.some((e) => e.type === "references" && e.from === dep.id && e.to === cm.id), "a partly templated namespace must not block the edge");

  store.close();
  cleanupDir(root);
});

test("a null namespace behaves like no namespace at all", () => {
  const { root, store, symbols, edges } = indexTree({
    "Chart.yaml": CHART_YAML,
    "templates/configmap.yaml": nsConfigMap("my-config", "app-prod"),
    "templates/deployment.yaml": inNamespace(deploymentYaml("my-app", ["app: my-app"], envFromConfigMap("my-config")), "null"),
  });
  const dep = symbols.find((s) => s.name === "Deployment/my-app")!;
  const cm = symbols.find((s) => s.name === "ConfigMap/my-config")!;
  assert.ok(dep && cm);
  assert.ok(edges.some((e) => e.type === "references" && e.from === dep.id && e.to === cm.id));

  store.close();
  cleanupDir(root);
});

test("nearestChartRoot: absolute path with no chart returns null instead of recursing forever", () => {
  assert.equal(nearestChartRoot([])("/abs/dir/x.yaml"), null);
});

test("nearestChartRoot: resolves the nearest tracked chart root", () => {
  const lookup = nearestChartRoot(["charts/a/Chart.yaml", "charts/a/templates/t.yaml"]);
  assert.equal(lookup("charts/a/templates/t.yaml"), "charts/a");
  assert.equal(lookup("other/x.yaml"), null);
});

test("nearestChartRoot: repo-root chart has root empty string", () => {
  const lookup = nearestChartRoot(["Chart.yaml", "templates/t.yaml"]);
  assert.equal(lookup("templates/t.yaml"), "");
});
