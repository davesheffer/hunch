import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, writeFileSync, existsSync } from "node:fs";
import { createRequire } from "node:module";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { test } from "node:test";

// Unit tests for the extension's pure logic. Modules that import the `vscode` API
// load against a minimal fake injected through the CommonJS loader for the
// duration of the imports only; nothing in node_modules is modified.
const EXT_ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const REPO_ROOT = resolve(EXT_ROOT, "..");
const manifest = JSON.parse(readFileSync(join(EXT_ROOT, "package.json"), "utf8"));
const sources = readdirSync(join(EXT_ROOT, "src")).filter((f) => f.endsWith(".ts"))
  .map((f) => ({ file: f, text: readFileSync(join(EXT_ROOT, "src", f), "utf8") }));
const allSource = sources.map((s) => s.text).join("\n");

const settings = new Map<string, unknown>();
class TreeItemStub {
  description?: string; iconPath?: unknown; contextValue?: string; tooltip?: unknown; command?: unknown;
  constructor(public label: string, public collapsibleState?: number) {}
}
const vscodeStub = {
  workspace: { getConfiguration: (section: string) => ({ get: (key: string, fallback?: unknown) => settings.has(`${section}.${key}`) ? settings.get(`${section}.${key}`) : fallback }) },
  window: {}, ProgressLocation: { Notification: 15 },
  TreeItem: TreeItemStub,
  TreeItemCollapsibleState: { None: 0, Collapsed: 1, Expanded: 2 },
  ThemeIcon: class { constructor(public id: string, public color?: unknown) {} },
  ThemeColor: class { constructor(public id: string) {} },
  MarkdownString: class { constructor(public value = "") {} },
  EventEmitter: class { event = () => ({ dispose() {} }); fire() {} dispose() {} },
  /** Replaced per test that needs the built-in Git extension. */
  extensions: { getExtension: (_id: string): unknown => undefined },
};
const require = createRequire(import.meta.url);
const Module = require("node:module") as { _load: (request: string, parent: unknown, isMain: boolean) => unknown };
const originalLoad = Module._load;
let cli: typeof import("../src/cli.js");
let mcp: typeof import("../src/mcpClient.js");
let data: typeof import("../src/hunchData.js");
let workspace: typeof import("../src/workspace.js");
let fence: typeof import("../src/rootBinding.js");
let spawnCore: typeof import("../src/spawnCore.js");
let features: typeof import("../src/featureGroups.js");
let memoryView: typeof import("../src/memoryView.js");
let gitBranch: typeof import("../src/gitBranch.js");
try {
  Module._load = function (request, parent, isMain) {
    return request === "vscode" ? vscodeStub : originalLoad.call(this, request, parent, isMain);
  };
  cli = await import("../src/cli.js");
  mcp = await import("../src/mcpClient.js");
  data = await import("../src/hunchData.js");
  workspace = await import("../src/workspace.js");
  fence = await import("../src/rootBinding.js");
  spawnCore = await import("../src/spawnCore.js");
  features = await import("../src/featureGroups.js");
  memoryView = await import("../src/memoryView.js");
  gitBranch = await import("../src/gitBranch.js");
} finally {
  Module._load = originalLoad;
}
const coreGlob = await import(new URL("../../src/core/glob.ts", import.meta.url).href) as { pathMatchesGlob(p: string, g: string): boolean };
const coreReview = await import(new URL("../../src/core/reviewqueue.ts", import.meta.url).href) as { parseSynth(e?: string[]): unknown; isReady(d: unknown, s: unknown, m?: number): boolean; READY_MIN_GROUNDED: number };

const ids = (re: RegExp) => new Set([...allSource.matchAll(re)].map((m) => m[1]!));
const sorted = (s: Iterable<string>) => [...s].sort();

// ---- manifest ↔ code -------------------------------------------------------
test("contributes.commands is exactly the set of commands the extension registers", () => {
  const registered = ids(/registerCommand\(\s*"([^"]+)"/g);
  const contributed = new Set<string>(manifest.contributes.commands.map((c: { command: string }) => c.command));
  assert.ok(registered.size >= 20);
  assert.deepEqual(sorted(registered), sorted(contributed));
});

test("every menu entry and keybinding references a contributed command", () => {
  const contributed = new Set<string>(manifest.contributes.commands.map((c: { command: string }) => c.command));
  const dangling: string[] = [];
  for (const [menu, entries] of Object.entries(manifest.contributes.menus as Record<string, Array<{ command: string }>>)) {
    for (const entry of entries) if (!contributed.has(entry.command)) dangling.push(`${menu}: ${entry.command}`);
  }
  for (const kb of manifest.contributes.keybindings ?? []) if (!contributed.has(kb.command)) dangling.push(`keybinding: ${kb.command}`);
  assert.deepEqual(dangling, []);
});

test("tree views, welcome views and language-model tools match what the code creates", () => {
  const views = Object.values(manifest.contributes.views as Record<string, Array<{ id: string }>>).flat().map((v) => v.id);
  assert.deepEqual(sorted(ids(/createTreeView\(\s*"([^"]+)"/g)), sorted(views));
  for (const welcome of manifest.contributes.viewsWelcome) assert.ok(views.includes(welcome.view), welcome.view);
  const containers = new Set(Object.values(manifest.contributes.viewsContainers as Record<string, Array<{ id: string }>>).flat().map((c) => c.id));
  for (const container of Object.keys(manifest.contributes.views)) assert.ok(containers.has(container), `view container ${container}`);
  const tools = manifest.contributes.languageModelTools.map((t: { name: string }) => t.name);
  assert.deepEqual(sorted(ids(/registerTool\(\s*"([^"]+)"/g)), sorted(tools));
});

test("configuration properties match the settings the code reads, with the same defaults", () => {
  const props = manifest.contributes.configuration.properties as Record<string, { default: unknown }>;
  const read = new Map<string, string>();
  for (const { text } of sources) {
    const scoped = text.includes('getConfiguration("hunch")');
    if (!scoped) continue;
    for (const m of text.matchAll(/\.get\(\s*"([^"]+)"\s*,\s*([^)]+?)\s*\)/g)) read.set(`hunch.${m[1]}`, m[2]!);
  }
  assert.deepEqual(sorted(read.keys()), sorted(Object.keys(props)));
  for (const [key, codeDefault] of read) assert.deepEqual(JSON.parse(codeDefault), props[key]!.default, `${key} default`);
});

test("manifest entry point, icon, activation and walkthrough media point at real files", () => {
  assert.equal(manifest.main, "./dist/extension.js", "tsc emits src/extension.ts to dist/extension.js");
  assert.match(sources.find((s) => s.file === "extension.ts")!.text, /export function activate\(/);
  assert.match(sources.find((s) => s.file === "extension.ts")!.text, /export function deactivate\(/);
  assert.ok(existsSync(join(EXT_ROOT, manifest.icon)));
  for (const walkthrough of manifest.contributes.walkthroughs) {
    for (const step of walkthrough.steps) assert.ok(existsSync(join(EXT_ROOT, step.media.markdown)), step.media.markdown);
  }
  assert.deepEqual(manifest.activationEvents, ["workspaceContains:.hunch/**"]);
});

// ---- CLI invocation --------------------------------------------------------
test("cliCommand returns an explicit hunch.cliPath verbatim and probes only for the bare default", () => {
  settings.set("hunch.cliPath", "C:\\tools\\my hunch.cmd");
  assert.equal(cli.cliCommand(), "C:\\tools\\my hunch.cmd");
  settings.delete("hunch.cliPath");
  const probed = cli.cliCommand();
  assert.ok(probed === "hunch" || /hunch(\.cmd)?$/.test(probed), probed);
  assert.equal(cli.cliCommand(), probed, "the probe is pinned for the session");
});

test("runHunchWith resolves (never rejects) with exit code and buffered output", async () => {
  const ok = await spawnCore.runHunchWith(process.execPath, REPO_ROOT, ["-e", "process.stdout.write('out'); process.stderr.write('err')"]);
  assert.deepEqual(ok, { ok: true, stdout: "out", stderr: "err", code: 0 });
  const failed = await spawnCore.runHunchWith(process.execPath, REPO_ROOT, ["-e", "process.exit(3)"]);
  assert.equal(failed.ok, false);
  assert.equal(failed.code, 3);
  const missing = await spawnCore.runHunchWith(join(REPO_ROOT, "definitely-missing-hunch.exe"), REPO_ROOT, ["status"]);
  assert.equal(missing.ok, false);
});

test("HunchMcp handshakes, frames JSON-RPC by line, joins text content and surfaces tool errors", async () => {
  // `node mcp` inside the fake root runs this file: a scripted MCP server.
  const root = mkdtempSync(join(tmpdir(), "hunch-vscode-mcp-"));
  writeFileSync(join(root, "mcp"), `
let initialized = false, buf = "";
const send = (m) => process.stdout.write(JSON.stringify(m) + "\\n");
process.stdout.write("startup noise that is not JSON\\n");
process.stdin.setEncoding("utf8");
process.stdin.on("data", (chunk) => {
  buf += chunk;
  let nl;
  while ((nl = buf.indexOf("\\n")) >= 0) {
    const msg = JSON.parse(buf.slice(0, nl)); buf = buf.slice(nl + 1);
    if (msg.method === "initialize") send({ jsonrpc: "2.0", id: msg.id, result: { protocolVersion: msg.params.protocolVersion } });
    else if (msg.method === "notifications/initialized") initialized = true;
    else if (msg.method === "tools/call" && !initialized) send({ jsonrpc: "2.0", id: msg.id, error: { message: "not initialized" } });
    else if (msg.params.name === "boom") send({ jsonrpc: "2.0", id: msg.id, error: { message: "tool exploded" } });
    else if (msg.params.name === "exit") process.exit(0);
    else send({ jsonrpc: "2.0", id: msg.id, result: { content: [{ type: "text", text: msg.params.name + ":" + JSON.stringify(msg.params.arguments) }, { type: "image", data: "x" }, { type: "text", text: "tail" }] } });
  }
});
`);
  settings.set("hunch.cliPath", process.execPath);
  const client = new mcp.HunchMcp(root);
  try {
    assert.equal(await client.call("hunch_why", { target: "a.ts" }), 'hunch_why:{"target":"a.ts"}\ntail');
    assert.equal(await client.call("hunch_query", { query: "q" }), 'hunch_query:{"query":"q"}\ntail');
    await assert.rejects(client.call("boom", {}), /tool exploded/);
    await assert.rejects(client.call("exit", {}), /hunch mcp exited/);
    assert.equal(await client.call("hunch_why", { target: "b.ts" }), 'hunch_why:{"target":"b.ts"}\ntail', "a dead server restarts on the next call");
  } finally {
    client.dispose();
    settings.delete("hunch.cliPath");
    // Windows holds the killed server's cwd briefly; retry instead of racing it.
    for (let attempt = 0; ; attempt++) {
      try { rmSync(root, { recursive: true, force: true }); break; } catch (error) {
        if (attempt >= 50) throw error;
        await new Promise((done) => setTimeout(done, 100));
      }
    }
  }
});

// ---- workspace root routing --------------------------------------------------
test("workspaceRootForFile does not treat a sibling sharing a name prefix as the owner", () => {
  const a = resolve("/ws/app"), b = resolve("/ws/app-tools");
  assert.equal(workspace.workspaceRootForFile([a, b], join(b, "src", "x.ts")), b);
  assert.equal(workspace.workspaceRootForFile([b, a], join(a, "x.ts")), a);
  assert.equal(workspace.workspaceRootForFile([a, b], a), a, "the folder itself belongs to its root");
  assert.equal(workspace.workspaceRootForFile([a, b]), a, "no active file keeps the first-folder fallback");
  assert.equal(workspace.workspaceRootForFile([], join(a, "x.ts")), undefined);
});

test("RootLoadFence only accepts the latest load for the still-selected root", () => {
  const f = new fence.RootLoadFence();
  const first = f.begin("/a");
  assert.equal(f.isCurrent(first, "/a"), true);
  const second = f.begin("/a");
  assert.equal(f.isCurrent(first, "/a"), false, "a superseded load is stale even for the same root");
  assert.equal(f.isCurrent(second, "/b"), false, "a load for a deselected root is stale");
  assert.equal(f.isCurrent(f.begin(undefined), undefined), true);
});

// ---- read-layer parity with the core ---------------------------------------
test("the extension's glob matcher agrees with the core matcher it mirrors", () => {
  const paths = ["src/a.ts", "src/auth/session.ts", "src/auth", "./src/x/y/z.ts", "src\\win\\p.ts", "test/a.test.ts", "a.ts", "site/dna-hero.js", "src/authz/a.ts"];
  const globs = ["**", "src/**", "src/*.ts", "src/auth", "src/auth/", "**/*.ts", "src/**/z.ts", "**/**/a.ts", "src/?.ts", "src/auth/**", "test/*.test.ts", "site/dna-hero.js", "src/auth*/**"];
  const diverged: string[] = [];
  for (const p of paths) for (const g of globs) {
    if (data.pathMatchesGlob(p, g) !== coreGlob.pathMatchesGlob(p, g)) diverged.push(`${p} ~ ${g}`);
  }
  assert.deepEqual(diverged, []);
});

test("draft triage parses synth telemetry and readiness exactly like the CLI", () => {
  const evidences = [undefined, [], ["synth: provider=claude grounded=0.82 samples=3 agreement=.9 pruned=1 verify=failed"], ["other", "synth: grounded=0.69"], ["synth: grounded=-1"]];
  for (const e of evidences) assert.deepEqual(data.parseSynth(e), coreReview.parseSynth(e));
  assert.equal(data.READY_MIN_GROUNDED, coreReview.READY_MIN_GROUNDED);
  const drafts = [
    { id: "dec_1", title: "a", status: "proposed", provenance: { source: "llm_inferred+verified", confidence: 0.9, evidence: ["synth: grounded=0.8"] } },
    { id: "dec_2", title: "b", status: "proposed", provenance: { source: "llm_inferred+verified", confidence: 0.4, evidence: ["synth: grounded=0.95"] } },
    { id: "dec_3", title: "c", status: "proposed", provenance: { source: "llm_inferred", confidence: 0.95, evidence: ["synth: grounded=0.99"] } },
    { id: "dec_4", title: "d", status: "accepted", provenance: { source: "human_confirmed", confidence: 1 } },
    { id: "dec_5", title: "e", status: "accepted", provenance: { source: "heuristic", confidence: 0.3 } },
  ];
  for (const d of drafts) assert.equal(data.isReady(d, data.parseSynth(d.provenance.evidence)), coreReview.isReady(d, coreReview.parseSynth(d.provenance.evidence)), d.id);
  const queue = data.reviewQueue({ ...emptyHunch(), decisions: drafts });
  assert.deepEqual(queue.ready.map((i) => i.d.id), ["dec_2", "dec_1"], "best-grounded first");
  assert.deepEqual(queue.scrutiny.map((i) => i.d.id), ["dec_5", "dec_3"], "lowest confidence first; confirmed records excluded");
});

// ---- graph queries ---------------------------------------------------------
function emptyHunch(): import("../src/hunchData.js").Hunch {
  return { root: "/r", components: [], edges: [], symbols: [], decisions: [], bugs: [], constraints: [] };
}
function graph(): import("../src/hunchData.js").Hunch {
  return {
    ...emptyHunch(),
    components: [
      { id: "cmp_store", name: "store", paths: ["src/store/**"] },
      { id: "cmp_cli", name: "cli", paths: ["src/cli/**"] },
      { id: "cmp_core", name: "core", paths: ["src/**"] },
    ],
    symbols: [
      { id: "s_write", file: "src/store/io.ts", name: "writeAtomic", kind: "function", metrics: { bug_count: 3, churn_90d: 10, fan_in: 4 } },
      { id: "s_save", file: "src/store/json.ts", name: "save", kind: "function", metrics: { churn_90d: 1 } },
      { id: "s_cmd", file: "src/cli/index.ts", name: "main", kind: "function" },
      { id: "s_util", file: "src/util.ts", name: "util", kind: "function" },
    ],
    edges: [
      { id: "e1", from: "s_save", to: "s_write", type: "calls" },
      { id: "e2", from: "s_cmd", to: "s_save", type: "calls" },
      { id: "e3", from: "s_util", to: "s_write", type: "mentions" },
    ],
    constraints: [
      { id: "con_atomic", statement: "Writes are atomic", scope: ["src/store/io.ts"], severity: "blocking" },
      { id: "con_cli", statement: "CLI exits non-zero on failure", scope: ["src/cli/**"], severity: "warning" },
      { id: "con_all", statement: "No pay-per-token API", scope: ["src/**"], severity: "advisory" },
    ],
    decisions: [{ id: "dec_io", title: "Temp-file rename", status: "accepted", related_files: ["src/store/io.ts"] }],
    bugs: [
      { id: "bug_1", title: "Truncated index", severity: "high", status: "fixed", affected_files: ["src/store/io.ts"], affected_symbols: ["s_write"] },
      { id: "bug_2", title: "Truncated again", lineage: { recurrence_of: "bug_1" }, affected_symbols: ["s_write"] },
      { id: "bug_3", title: "Third time", lineage: { recurrence_of: "bug_2" } },
      { id: "bug_4", title: "Unrelated", lineage: { recurrence_of: "bug_missing" } },
    ],
  };
}

test("why, blast radius and near-constraints walk the dependency graph like the core store", () => {
  const h = graph();
  const w = data.why(h, "src/store/io.ts");
  assert.deepEqual(w.constraints.map((c) => c.id), ["con_atomic", "con_all"], "severity-ranked");
  assert.deepEqual(w.decisions.map((d) => d.id), ["dec_io"]);
  assert.deepEqual(w.bugs.map((b) => b.id), ["bug_1", "bug_2"]);
  assert.deepEqual(w.dependents, [{ name: "save", file: "src/store/json.ts" }]);
  assert.deepEqual(data.blastRadiusFiles(h, "src/store/io.ts"), [
    { file: "src/store/json.ts", via: "save", depth: 1 },
    { file: "src/cli/index.ts", via: "main", depth: 2 },
  ], "non-radius edge types (mentions) are ignored");
  assert.deepEqual(data.blastRadiusFiles(h, "src/store/io.ts", 1).map((b) => b.file), ["src/store/json.ts"]);
  assert.deepEqual(data.nearConstraints(h, "src/store/io.ts").map((n) => n.c.id), ["con_cli"]);
});

test("search, fragility, lineage and the component graph", () => {
  const h = graph();
  assert.deepEqual(data.searchAll(h, "  "), []);
  assert.deepEqual(data.searchAll(h, "truncated index").map((hit) => hit.id), ["bug_1"], "every term must appear");
  assert.equal(data.searchAll(h, "writes")[0]!.id, "con_atomic", "prefix match ranks first");
  const fragile = data.fragileSymbols(h);
  assert.equal(fragile[0]!.name, "writeAtomic");
  assert.equal(fragile[0]!.score, 1);
  assert.ok(data.symbolSignals(h, "src/store/io.ts").has("writeAtomic"));
  assert.deepEqual(data.bugsForSymbol(h, "src/store/io.ts", "writeAtomic").map((b) => b.id), ["bug_1", "bug_2"]);
  const chains = data.lineageChains(h);
  assert.equal(chains.length, 1);
  assert.equal(chains[0]!.bug.id, "bug_1");
  assert.equal(chains[0]!.recurrences[0]!.recurrences[0]!.bug.id, "bug_3");
  const g = data.componentGraph(h);
  const node = (id: string) => g.nodes.find((n) => n.id === id)!;
  assert.equal(node("cmp_store").symbols, 2, "the most specific owner wins");
  assert.equal(node("cmp_core").symbols, 1);
  assert.deepEqual(g.links, [{ source: "cmp_cli", target: "cmp_store", weight: 1 }], "self-calls are dropped");
  assert.equal(data.sevRank("blocking") > data.sevRank("warning"), true);
  assert.equal(data.sevRank(undefined), 0);
});

test("staleness compares guarded-file changes with last verification", () => {
  const rec = { provenance: { last_verified: "2026-01-01T00:00:00Z" }, related_files: ["a.ts"] };
  assert.equal(data.isStale(rec, () => Date.parse("2026-02-01")), true);
  assert.equal(data.isStale(rec, () => Date.parse("2025-12-01")), false);
  assert.equal(data.isStale({ related_files: ["a.ts"] }, () => Date.now()), false, "never-verified is not stale");
  assert.equal(data.isStale({ provenance: { last_verified: "garbage" }, scope: ["a.ts"] }, () => Date.now()), false);
});

test("loadHunch reads the committed store, skipping corrupt and non-JSON files", () => {
  const root = mkdtempSync(join(tmpdir(), "hunch-vscode-load-"));
  const prev = process.env.HUNCH_PRIVATE_DIR;
  delete process.env.HUNCH_PRIVATE_DIR;
  try {
    assert.equal(data.loadHunch(root), null, "no .hunch/ means no memory");
    for (const dir of ["constraints", "decisions", "edges", "symbols"]) mkdirSync(join(root, ".hunch", dir), { recursive: true });
    writeFileSync(join(root, ".hunch", "constraints", "con_a.json"), JSON.stringify({ id: "con_a", statement: "s", scope: ["src/**"] }));
    writeFileSync(join(root, ".hunch", "constraints", "con_bad.json"), "{ truncated");
    writeFileSync(join(root, ".hunch", "constraints", "README.md"), "not a record");
    writeFileSync(join(root, ".hunch", "edges", "index.json"), "{\"not\":\"an array\"}");
    writeFileSync(join(root, ".hunch", "symbols", "index.json"), JSON.stringify([{ id: "s", file: "a.ts", name: "a", kind: "function" }]));
    const h = data.loadHunch(root)!;
    assert.deepEqual(h.constraints.map((c) => c.id), ["con_a"]);
    assert.deepEqual(h.edges, []);
    assert.equal(h.symbols.length, 1);
    assert.deepEqual([h.decisions, h.bugs, h.components], [[], [], []]);
    assert.equal(data.decisionFilePath(h, "dec_x"), join(root, ".hunch", "decisions", "dec_x.json"));
    assert.equal(data.recordFilePath(root, "con_a"), join(root, ".hunch", "constraints", "con_a.json"));
    assert.equal(data.recordFilePath(root, "zzz_a"), null);
  } finally {
    if (prev === undefined) delete process.env.HUNCH_PRIVATE_DIR; else process.env.HUNCH_PRIVATE_DIR = prev;
    rmSync(root, { recursive: true, force: true });
  }
});

test("recordFilePath resolves component ids (core mints cmp_*)", () => {
  assert.equal(data.recordFilePath("/r", "cmp_abc"), join("/r", ".hunch", "components", "cmp_abc.json"));
});

// ---- memory grouped by feature commit (`hunch log --for`) ------------------
const move = (sha: string, subject: string) => ({
  sha, shortSha: sha.slice(0, 7), date: "2026-11-04T10:00:00+02:00", subject, kind: "capture",
  decisionIds: ["dec_a"], otherIds: [], added: 1, modified: 0, deleted: 0, files: [".hunch/decisions/dec_a.json"],
  codeBranch: "feat/x", codeHead: "c".repeat(40),
});
const forBranch = {
  query: "feat/x", kind: "branch", sha: "f".repeat(40), branch: "feat/x",
  merged: { status: "merged", method: "squash", evidence: ["patch-id"], pr: 7 },
  groups: [
    { commit: null, landed: null, moves: [move("1".repeat(40), "hunch: capture late")] },
    { commit: { sha: "a".repeat(40), shortSha: "aaaaaaa", date: "2026-11-03T10:00:00+02:00", subject: "feat: add the thing" },
      landed: "b".repeat(40), moves: [move("2".repeat(40), "hunch: capture one"), move("3".repeat(40), "hunch: capture two")] },
  ],
  notes: ["searched back to the fork point"],
};

test("parseMemoryFor accepts the CLI's --for JSON and rejects anything else", () => {
  assert.deepEqual(features.parseMemoryFor(JSON.stringify(forBranch)), forBranch);
  for (const bad of ["", "not json", "[]", "null", JSON.stringify({ ...forBranch, kind: "tag" }),
    JSON.stringify({ ...forBranch, groups: {} }), JSON.stringify({ ...forBranch, notes: [3] }),
    JSON.stringify({ ...forBranch, groups: [{ commit: null, landed: null }] })]) {
    assert.equal(features.parseMemoryFor(bad), null, bad);
  }
});

test("parseMemoryFor rejects a payload whose rows would break while rendering", () => {
  const [late, done] = forBranch.groups;
  const { decisionIds: _ids, ...moveWithoutIds } = move("4".repeat(40), "hunch: no ids");
  for (const [why, bad] of [
    ["commit without a date", { ...forBranch, groups: [{ ...done, commit: { sha: "a".repeat(40), shortSha: "aaaaaaa", subject: "s" } }] }],
    ["move without decisionIds", { ...forBranch, groups: [{ ...late, moves: [moveWithoutIds] }] }],
    ["move that is not an object", { ...forBranch, groups: [{ ...late, moves: ["x"] }] }],
    ["landed that is not a sha", { ...forBranch, groups: [{ ...done, landed: 7 }] }],
    ["merged without a status", { ...forBranch, merged: { method: "squash" } }],
    ["query that is not a string", { ...forBranch, query: null }],
  ] as const) {
    assert.equal(features.parseMemoryFor(JSON.stringify(bad)), null, why);
  }
});

test("a grouping failure hints at a CLI update only when the CLI lacks --for", () => {
  assert.deepEqual(features.featureFailure({ ok: false, stderr: "error: unknown option '--for'\n" }), { message: "error: unknown option '--for'", hint: "update the Hunch CLI" });
  assert.deepEqual(features.featureFailure({ ok: false, stderr: "error: \"nope\" is not a branch or commit\nmore\n" }), { message: "error: \"nope\" is not a branch or commit", hint: "" });
  assert.deepEqual(features.featureFailure({ ok: false, stderr: "" }), { message: "the CLI failed", hint: "" });
  assert.equal(features.featureFailure({ ok: true, stderr: "" }).message, "unexpected output");
});

test("feature query names the checked-out branch, or HEAD when there is none", () => {
  assert.equal(features.featureQuery("feat/x"), "feat/x");
  assert.equal(features.featureQuery(undefined), "HEAD");
  assert.equal(features.featureQuery(""), "HEAD");
});

test("feature header and group rows say what the CLI says", () => {
  assert.deepEqual(features.headerText(forBranch as never), { label: "feat/x", description: "merged (squash, PR #7)" });
  assert.deepEqual(features.headerText({ ...forBranch, merged: { status: "unmerged", method: null, evidence: [] } } as never), { label: "feat/x", description: "unmerged" });
  assert.deepEqual(features.headerText({ ...forBranch, merged: null } as never), { label: "feat/x", description: "default branch" });
  assert.deepEqual(features.headerText({ ...forBranch, kind: "commit", branch: null, merged: null, query: "HEAD" } as never), { label: "fffffff", description: "commit HEAD" });
  const [late, done] = forBranch.groups as never[];
  assert.deepEqual(features.groupText(late!), { label: "After the last code commit", description: "in progress · 1 move" });
  assert.deepEqual(features.groupText(done!), { label: "feat: add the thing", description: "aaaaaaa · 2 moves · landed bbbbbbb" });
  assert.deepEqual(features.groupText({ ...(late as object), landed: "d".repeat(40) } as never), { label: "After the last code commit", description: "1 move · landed ddddddd" });
});

test("repoFor picks the git repository that owns the root, never an unrelated one", () => {
  const a = resolve("/w/repo"), b = resolve("/w/repo-2");
  assert.equal(features.repoFor([a, b], resolve("/w/repo-2/pkg")), b);
  assert.equal(features.repoFor([resolve("/w"), b], resolve("/w/repo-2")), b, "the nearest repository wins");
  assert.equal(features.repoFor([a], resolve("/elsewhere")), undefined);
});

type Run = (root: string, args: string[]) => Promise<{ ok: boolean; stdout: string; stderr: string; code: number | null }>;
function fakeRunner(log: { ok: boolean; stdout: string; stderr?: string }): { run: Run; calls: string[][] } {
  const calls: string[][] = [];
  const run: Run = async (_root, args) => {
    calls.push(args);
    if (args[0] === "log") return { ok: log.ok, stdout: log.stdout, stderr: log.stderr ?? "", code: log.ok ? 0 : 1 };
    return { ok: true, stdout: "[]", stderr: "", code: 0 };
  };
  return { run, calls };
}
const labels = (nodes: { label?: unknown; description?: unknown }[]) => nodes.map((n) => `${String(n.label)} | ${n.description ?? ""}`);

test("the memory view keeps the flat timeline by default", async () => {
  const fake = fakeRunner({ ok: true, stdout: JSON.stringify([move("9".repeat(40), "hunch: capture flat")]) });
  const tree = new memoryView.MemoryTreeProvider("/r", fake.run, () => "feat/x");
  const roots = await tree.getChildren();
  assert.deepEqual(fake.calls.find((a) => a[0] === "log"), ["log", "--json", "-n", "150"]);
  assert.equal(roots.length, 1);
  assert.ok(roots[0] instanceof memoryView.MoveNode);
});

test("grouped by feature commit, the view reads `hunch log --for <branch>` and nests moves under commits", async () => {
  const fake = fakeRunner({ ok: true, stdout: JSON.stringify(forBranch) });
  const tree = new memoryView.MemoryTreeProvider("/r", fake.run, () => "feat/x");
  tree.setGrouped(true);
  const roots = await tree.getChildren();
  assert.deepEqual(fake.calls.find((a) => a[0] === "log"), ["log", "--json", "--for", "feat/x", "-n", "50"]);
  assert.deepEqual(labels(roots), [
    "feat/x | merged (squash, PR #7)",
    "After the last code commit | in progress · 1 move",
    "feat: add the thing | aaaaaaa · 2 moves · landed bbbbbbb",
    "searched back to the fork point | note",
  ]);
  const late = await tree.getChildren(roots[1]);
  assert.deepEqual(late.map((n) => n.label), ["capture late"]);
  assert.ok(late[0] instanceof memoryView.MoveNode);
  assert.deepEqual((await tree.getChildren(roots[2])).map((n) => n.label), ["capture one", "capture two"]);
  assert.deepEqual(await tree.getChildren(roots[0]), [], "the header has no children");
});

test("grouping follows a branch switch and falls back to HEAD without a branch", async () => {
  let branch: string | undefined = "feat/x";
  const fake = fakeRunner({ ok: true, stdout: JSON.stringify(forBranch) });
  const tree = new memoryView.MemoryTreeProvider("/r", fake.run, () => branch);
  tree.setGrouped(true);
  await tree.getChildren();
  branch = undefined;
  await tree.getChildren();
  assert.deepEqual(fake.calls.filter((a) => a[0] === "log").map((a) => a[3]), ["feat/x", "HEAD"]);
  tree.setGrouped(false);
  const flat = await tree.getChildren();
  assert.deepEqual(fake.calls.filter((a) => a[0] === "log").at(-1), ["log", "--json", "-n", "150"]);
  assert.deepEqual(flat, [], "a --for payload is never shown as a flat timeline");
});

test("a CLI that cannot group says so in the view instead of showing nothing", async () => {
  const fake = fakeRunner({ ok: false, stdout: "", stderr: "error: unknown option '--for'\n" });
  const tree = new memoryView.MemoryTreeProvider("/r", fake.run, () => "feat/x");
  tree.setGrouped(true);
  assert.deepEqual(labels(await tree.getChildren()), ["Could not group by feature commit: error: unknown option '--for' | update the Hunch CLI"]);
  const badRef = fakeRunner({ ok: false, stdout: "", stderr: "error: \"nope\" is not a branch or commit\n" });
  const tree3 = new memoryView.MemoryTreeProvider("/r", badRef.run, () => "nope");
  tree3.setGrouped(true);
  assert.deepEqual(labels(await tree3.getChildren()), ["Could not group by feature commit: error: \"nope\" is not a branch or commit | "]);
  const empty = fakeRunner({ ok: true, stdout: JSON.stringify({ ...forBranch, groups: [], notes: [] }) });
  const tree2 = new memoryView.MemoryTreeProvider("/r", empty.run, () => "feat/x");
  tree2.setGrouped(true);
  assert.deepEqual(labels(await tree2.getChildren()), ["feat/x | merged (squash, PR #7)", "No memory attributed to feat/x. | note"]);
});

test("a feature group row from before a root switch stays empty", async () => {
  let root = "/r";
  const fake = fakeRunner({ ok: true, stdout: JSON.stringify(forBranch) });
  const tree = new memoryView.MemoryTreeProvider(() => root, fake.run, () => "feat/x");
  tree.setGrouped(true);
  const roots = await tree.getChildren();
  root = "/other";
  await tree.getChildren();
  assert.deepEqual(await tree.getChildren(roots[2]), []);
});

test("the flat timeline drops malformed moves and shows a kind it does not know by name", async () => {
  const { decisionIds: _ids, ...broken } = move("5".repeat(40), "hunch: broken");
  const fake = fakeRunner({ ok: true, stdout: JSON.stringify([move("6".repeat(40), "hunch: kept"), broken, null, { ...move("7".repeat(40), "hunch: new kind"), kind: "graft" }]) });
  const tree = new memoryView.MemoryTreeProvider("/r", fake.run);
  assert.deepEqual(labels(await tree.getChildren()), [
    "kept | 2026-11-04 · captured · dec_a",
    "new kind | 2026-11-04 · graft · dec_a",
  ]);
});

// ---- the checked-out branch, from the built-in Git extension ----------------
function fakeEvent<T>() {
  const listeners = new Set<(v: T) => void>();
  return {
    event: (l: (v: T) => void) => { listeners.add(l); return { dispose: () => { listeners.delete(l); } }; },
    fire: (v: T) => { for (const l of [...listeners]) l(v); },
    get size() { return listeners.size; },
  };
}
type FakeHead = { name?: string; commit?: string; type?: number };
function fakeRepo(fsPath: string, HEAD: FakeHead) {
  const changed = fakeEvent<void>();
  return { changed, repo: { rootUri: { fsPath }, state: { HEAD, onDidChange: changed.event } } };
}
function fakeGit(repos: ReturnType<typeof fakeRepo>["repo"][], activation?: Promise<void>) {
  const opened = fakeEvent<unknown>(), closed = fakeEvent<unknown>();
  const api = { repositories: repos, onDidOpenRepository: opened.event, onDidCloseRepository: closed.event };
  const exports = { getAPI: () => api };
  const ext = activation
    ? { isActive: false, exports: undefined, activate: () => activation.then(() => exports) }
    : { isActive: true, exports, activate: async () => exports };
  vscodeStub.extensions.getExtension = () => ext;
  return { api, opened, closed };
}
async function withGit<T>(fn: () => Promise<T> | T): Promise<T> {
  try { return await fn(); } finally { vscodeStub.extensions.getExtension = () => undefined; }
}

test("GitBranches names the local branch only, and fires at once when Git is already active", () => withGit(() => {
  const main = fakeRepo(resolve("/w/repo"), { name: "feat/x", commit: "a", type: 0 });
  const detached = fakeRepo(resolve("/w/detached"), { commit: "b", type: 0 });
  const tag = fakeRepo(resolve("/w/tag"), { name: "v1.0.0", commit: "c", type: 2 });
  fakeGit([main.repo, detached.repo, tag.repo]);
  let calls = 0;
  const branches = new gitBranch.GitBranches(() => { calls++; });
  assert.equal(calls, 1, "the first callback runs inside the constructor");
  assert.equal(branches.branchOf(resolve("/w/repo/pkg")), "feat/x");
  assert.equal(branches.branchOf(resolve("/w/detached")), undefined, "detached HEAD has no branch");
  assert.equal(branches.branchOf(resolve("/w/tag")), undefined, "a checked-out tag is not a branch");
  assert.equal(branches.branchOf(resolve("/elsewhere")), undefined);
  branches.dispose();
}));

test("GitBranches fires on a branch switch or a new commit, not on unrelated state changes", () => withGit(() => {
  const head: FakeHead = { name: "feat/x", commit: "a", type: 0 };
  const r = fakeRepo(resolve("/w/repo"), head);
  const detachedHead: FakeHead = { commit: "d1", type: 0 };
  const d = fakeRepo(resolve("/w/detached"), detachedHead);
  fakeGit([r.repo, d.repo]);
  let calls = 0;
  const branches = new gitBranch.GitBranches(() => { calls++; });
  calls = 0;
  r.changed.fire();
  assert.equal(calls, 0, "same branch, same commit");
  head.commit = "b"; r.changed.fire();
  assert.equal(calls, 1, "a new commit regroups the branch");
  head.name = "feat/y"; r.changed.fire();
  assert.equal(calls, 2, "a branch switch");
  detachedHead.commit = "d2"; d.changed.fire();
  assert.equal(calls, 3, "a detached HEAD that moves");
  branches.dispose();
  assert.equal(r.changed.size + d.changed.size, 0, "dispose drops every listener");
}));

test("GitBranches stops watching a closed repository and tells the view", () => withGit(() => {
  const r = fakeRepo(resolve("/w/repo"), { name: "feat/x", commit: "a", type: 0 });
  const git = fakeGit([r.repo]);
  let calls = 0;
  const branches = new gitBranch.GitBranches(() => { calls++; });
  calls = 0;
  git.api.repositories = [];
  git.closed.fire(r.repo);
  assert.equal(calls, 1);
  assert.equal(r.changed.size, 0, "the closed repository's listener is gone");
  const reopened = fakeRepo(resolve("/w/repo"), { name: "feat/y", commit: "b", type: 0 });
  git.api.repositories = [reopened.repo];
  git.opened.fire(reopened.repo);
  assert.equal(calls, 2);
  assert.equal(branches.branchOf(resolve("/w/repo")), "feat/y");
  branches.dispose();
}));

test("GitBranches disposed while Git activates never subscribes", () => withGit(async () => {
  let activate!: () => void;
  const r = fakeRepo(resolve("/w/repo"), { name: "feat/x", commit: "a", type: 0 });
  const git = fakeGit([r.repo], new Promise<void>((res) => { activate = res; }));
  let calls = 0;
  const branches = new gitBranch.GitBranches(() => { calls++; });
  branches.dispose();
  activate();
  await new Promise((res) => setImmediate(res));
  assert.equal(calls, 0);
  assert.equal(r.changed.size + git.opened.size + git.closed.size, 0);
  assert.equal(branches.branchOf(resolve("/w/repo")), undefined);
}));
