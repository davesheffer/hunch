/**
 * External-boundary integration tests: provider CLIs (faked on PATH), the optional
 * embeddings dependency, every agent hook dialect through the real `hunch hook`
 * CLI, and the generated CI workflow. No real model or pay-per-token API is ever
 * called: provider binaries are local fakes and fetch is trapped while synthesis runs.
 */
import { cleanupDir, isolatedCliEnv, tempDir } from "./fixtures.js";
import { test } from "node:test";
import assert from "node:assert/strict";
import { execFileSync, spawnSync } from "node:child_process";
import { chmodSync, existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join, resolve } from "node:path";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";
import { hunchPaths } from "../src/core/paths.js";
import type { Decision } from "../src/core/types.js";
import { HunchStore } from "../src/store/hunchStore.js";
import { selectEmbedder, TransformersEmbedder } from "../src/store/embedder.js";
import { buildServer } from "../src/mcp/server.js";
import { __resetAvailabilityCacheForTests, pexecIn, resolveSynthesisProvider } from "../src/synthesis/provider.js";
import { draftDecisionSafe, syncCommit } from "../src/synthesis/synthesize.js";
import { loadNativeTreeSitter } from "../src/extractors/nativeTreeSitter.js";
import { writeCiWorkflow } from "../src/integrations/ciAction.js";
import { mkConstraint, tsxLoaderUrl } from "./helpers.js";

const IS_WIN = process.platform === "win32";
const hookCli = resolve("src/cli/index.ts");

// ---------------------------------------------------------------------------
// 1. Provider CLIs
// ---------------------------------------------------------------------------

const FAKE_SCRIPT = String.raw`
const fs = require("fs");
const name = process.argv[2];
const argv = process.argv.slice(3);
if (argv.includes("--version")) { process.stdout.write(name + " 9.9.9-fake\n"); process.exit(0); }
let input = "";
process.stdin.on("data", (d) => { input += d; });
process.stdin.on("end", () => {
  fs.appendFileSync(process.env.FAKE_LOG, JSON.stringify({
    name, argv, stdin: input, pid: process.pid,
    anthropicKey: process.env.ANTHROPIC_API_KEY ?? null,
    openaiKey: process.env.OPENAI_API_KEY ?? null,
  }) + "\n");
  const mode = process.env.FAKE_MODE || "ok";
  if (mode === "exit") { process.stderr.write("fake failure"); process.exit(3); }
  if (mode === "hang") { setTimeout(() => {}, 20000); return; } // self-exits so an orphan cannot stall the run
  const draft = { title: "Route billing through the fake ledger", context: "FAKE_CONTEXT from " + name,
    decision: "FAKE_DECISION from " + name, consequences: ["fake consequence"],
    alternatives_rejected: ["direct ledger writes"], nontrivial: true };
  // "schema" echoes the output contract back as the answer (issue #561); "schema-once"
  // does so only on the first call of the run, so a retry can succeed.
  const callNo = fs.readFileSync(process.env.FAKE_LOG, "utf8").split("\n").filter(Boolean).length;
  const echo = mode === "schema" || (mode === "schema-once" && callNo === 1);
  const schemaEcho = { type: "object", properties: { title: { type: "string" }, decision: { type: "string" } }, required: ["title", "decision"] };
  const text = mode === "malformed" ? "Sorry, I cannot produce JSON today." : JSON.stringify(echo ? schemaEcho : draft);
  if (name === "claude") process.stdout.write(JSON.stringify({ type: "result", subtype: "success", is_error: false, result: text }));
  else if (name === "codex") process.stdout.write(JSON.stringify({ type: "thread.started" }) + "\n" + JSON.stringify({ type: "item.completed", item: { type: "agent_message", text } }) + "\n");
  else process.stdout.write(text);
});
`;

interface FakeCall { pid: number; name: string; argv: string[]; stdin: string; anthropicKey: string | null; openaiKey: string | null }

function fakeBin(dir: string): void {
  const script = join(dir, "fake-provider.cjs");
  writeFileSync(script, FAKE_SCRIPT);
  for (const name of ["claude", "codex", "cursor-agent"]) {
    if (IS_WIN) {
      // pexecIn launches through cmd.exe (shell:true), which resolves the bare name via PATHEXT → .cmd.
      writeFileSync(join(dir, `${name}.cmd`), `@"${process.execPath}" "${script}" ${name} %*\r\n`);
    } else {
      const file = join(dir, name);
      writeFileSync(file, `#!/bin/sh\nexec "${process.execPath}" "${script}" ${name} "$@"\n`);
      chmodSync(file, 0o755);
    }
  }
}

const ENV_KEYS = ["PATH", "FAKE_LOG", "FAKE_MODE", "HUNCH_SYNTH_PROVIDER", "HUNCH_INITIATOR", "CLAUDECODE", "CODEX_THREAD_ID",
  "CODEX_SESSION_ID", "ANTHROPIC_API_KEY", "OPENAI_API_KEY", "HUNCH_SYNTH_BASE_URL", "HUNCH_SYNTH_MODEL"] as const;

/** A temp git repo with one substantive commit, fake provider binaries first on
 *  PATH, and fetch trapped (any network attempt fails the test). */
function providerFixture(t: { after: (fn: () => void) => void }) {
  const sandbox = tempDir("hunch-ext-provider-");
  const bin = join(sandbox, "bin");
  const root = join(sandbox, "repo");
  mkdirSync(bin);
  mkdirSync(join(root, "src", "billing"), { recursive: true });
  fakeBin(bin);
  const log = join(sandbox, "calls.jsonl");
  const saved = Object.fromEntries(ENV_KEYS.map((k) => [k, process.env[k]]));
  for (const k of ["CLAUDECODE", "CODEX_THREAD_ID", "CODEX_SESSION_ID", "HUNCH_INITIATOR", "HUNCH_SYNTH_BASE_URL", "HUNCH_SYNTH_MODEL"]) delete process.env[k];
  process.env.PATH = `${bin}${IS_WIN ? ";" : ":"}${saved.PATH ?? ""}`;
  process.env.FAKE_LOG = log;
  process.env.ANTHROPIC_API_KEY = "sk-ant-should-be-stripped";
  process.env.OPENAI_API_KEY = "sk-openai-should-be-stripped";
  const realFetch = globalThis.fetch;
  let fetches = 0;
  globalThis.fetch = (async () => { fetches++; throw new Error("network forbidden in provider boundary test"); }) as typeof fetch;
  __resetAvailabilityCacheForTests();

  const git = (...args: string[]) => execFileSync("git", ["-c", "user.name=t", "-c", "user.email=t@example.com", ...args], { cwd: root, encoding: "utf8" });
  git("init", "-q");
  writeFileSync(join(root, "src", "billing", "ledger.ts"), "export function postEntry(amount: number) {\n  return { amount, unique_marker_xq7: true };\n}\n");
  writeFileSync(join(root, "src", "billing", "charge.ts"), "import { postEntry } from './ledger';\nexport const charge = (n: number) => postEntry(n);\n");
  git("add", "-A");
  git("commit", "-qm", "feat: route billing through the ledger", "-m", "Charges now post a ledger entry so refunds can be reconciled later on.");
  const store = new HunchStore(hunchPaths(root));
  store.json.ensureDirs();

  t.after(() => {
    globalThis.fetch = realFetch;
    for (const [k, v] of Object.entries(saved)) {
      if (v === undefined) delete process.env[k];
      else process.env[k] = v;
    }
    __resetAvailabilityCacheForTests();
    store.close();
    cleanupDir(sandbox);
  });
  const calls = (): FakeCall[] => existsSync(log)
    ? readFileSync(log, "utf8").split("\n").filter(Boolean).map((l) => JSON.parse(l) as FakeCall)
    : [];
  const sync = async (provider: string | undefined, mode = "ok") => {
    if (provider === undefined) delete process.env.HUNCH_SYNTH_PROVIDER;
    else process.env.HUNCH_SYNTH_PROVIDER = provider;
    process.env.FAKE_MODE = mode;
    __resetAvailabilityCacheForTests();
    return syncCommit(store, root, undefined, { force: true });
  };
  return { root, store, calls, sync, fetches: () => fetches };
}

for (const [selected, bin] of [["claude-cli", "claude"], ["codex-cli", "codex"], ["cursor-agent", "cursor-agent"]] as const) {
  test(`external:provider: explicitly selected ${selected} is the one invoked, prompt on stdin, keys stripped, JSON becomes a Decision`, { timeout: 60_000 }, async (t) => {
    const fx = providerFixture(t);
    const result = await fx.sync(selected);
    assert.equal(result.status, "written");
    assert.equal(result.provider, selected);
    const calls = fx.calls();
    assert.deepEqual(calls.map((c) => c.name), [bin], "only the selected provider's CLI ran a synthesis call");
    const call = calls[0]!;
    assert.match(call.stdin, /feat: route billing through the ledger/, "commit subject delivered on stdin");
    assert.match(call.stdin, /unique_marker_xq7/, "diff content delivered on stdin");
    assert.ok(!call.argv.join(" ").includes("unique_marker_xq7"), "untrusted diff content never travels in argv");
    if (bin === "claude") {
      assert.deepEqual(call.argv.slice(0, 3), ["-p", "--output-format", "json"]);
      assert.equal(call.anthropicKey, null, "ANTHROPIC_API_KEY stripped → subscription auth");
    } else if (bin === "codex") {
      assert.deepEqual([call.argv[0], call.argv.at(-1)], ["exec", "-"]);
      assert.ok(call.argv.includes("--json"));
      assert.equal(call.openaiKey, null, "OPENAI_API_KEY stripped → subscription auth");
    } else {
      assert.ok(call.argv.includes("-p") && call.argv.includes("--trust"));
    }
    const decision = fx.store.json.get("decisions", result.decision!.id) as Decision;
    assert.equal(decision.decision, `FAKE_DECISION from ${bin}`);
    assert.equal(decision.provenance.source, "llm_draft");
    assert.ok(decision.provenance.evidence.includes(`synth:provider=${selected}`));
    assert.deepEqual(decision.alternatives_rejected, ["direct ledger writes"]);
    assert.equal(fx.fetches(), 0, "no network call");
  });
}

for (const mode of ["malformed", "exit"] as const) {
  test(`external:provider: ${mode} output from the selected CLI falls back to the deterministic heuristic`, { timeout: 60_000 }, async (t) => {
    const fx = providerFixture(t);
    for (const selected of ["claude-cli", "codex-cli", "cursor-agent"]) {
      const result = await fx.sync(selected, mode);
      assert.equal(result.status, "written", selected);
      assert.equal(result.provider, "deterministic", `${selected} ${mode} → heuristic`);
      assert.equal(result.decision!.provenance.source, "inferred");
      const kind = mode === "malformed" ? "no-json" : "provider-error";
      assert.ok(result.decision!.provenance.evidence.includes(`synth:provider=deterministic fallback=${kind}`));
    }
    // Unusable output gets one more sample before the fallback; a crashed CLI does not.
    assert.equal(fx.calls().length, mode === "malformed" ? 6 : 3, "each selected CLI was tried the expected number of times");
    assert.equal(fx.fetches(), 0);
  });
}

// Issue #561: about 1 in 5 claude-cli drafts came back as the JSON Schema itself and
// were silently replaced by the heuristic draft.
test("external:provider: a schema echo is retried once and the second answer is kept", { timeout: 60_000 }, async (t) => {
  const fx = providerFixture(t);
  const result = await fx.sync("claude-cli", "schema-once");
  assert.equal(result.provider, "claude-cli");
  assert.equal(result.fallbackReason, undefined);
  assert.equal(result.decision!.provenance.source, "llm_draft");
  assert.equal(fx.calls().length, 2, "one echo, one retry");
  assert.doesNotMatch(fx.calls()[0]!.stdin, /"properties"\s*:/, "the prompt no longer pastes a JSON Schema to echo");
});

test("external:provider: a persistent schema echo falls back with a reason that names it", { timeout: 60_000 }, async (t) => {
  const fx = providerFixture(t);
  const result = await fx.sync("claude-cli", "schema");
  assert.equal(result.provider, "deterministic");
  assert.equal(result.decision!.provenance.source, "inferred", "the fallback stays honestly labeled");
  assert.ok(result.decision!.provenance.evidence.includes("synth:provider=deterministic fallback=echoed-schema"), "the cause survives a quiet hook run");
  assert.match(result.fallbackReason ?? "", /claude-cli: no usable decision JSON in output \(echoed the schema instead of an answer\), 2 attempts/);
  assert.equal(fx.calls().length, 2);
});

test("external:provider: backfill reports each provider fallback and counts it apart from gated heuristics", { timeout: 90_000 }, async (t) => {
  const fx = providerFixture(t);
  const run = spawnSync(process.execPath, ["--import", tsxLoaderUrl(), hookCli, "backfill", "--since", "3650d"], {
    cwd: fx.root,
    env: isolatedCliEnv({ HUNCH_SYNTH_PROVIDER: "claude-cli", FAKE_MODE: "schema", HUNCH_PIPELINE: "0", PATH: process.env.PATH, FAKE_LOG: process.env.FAKE_LOG }),
    encoding: "utf8", timeout: 80_000, windowsHide: true,
  });
  assert.equal(run.status, 0, run.stderr);
  assert.match(run.stdout, /⚠ [0-9a-f]{8} /, "the fallen-back commit is flagged, not ticked");
  assert.match(run.stdout, /heuristic draft instead: claude-cli: no usable decision JSON in output \(echoed the schema instead of an answer\)/);
  assert.match(run.stdout, /Done: 1 decision\(s\) seeded \(0 via LLM, 0 heuristic, 1 heuristic after the LLM failed\)/);
});

test("external:provider: a hung CLI times out (tree killed) and the safe wrapper falls back to the heuristic", { timeout: 60_000 }, async (t) => {
  const fx = providerFixture(t);
  process.env.FAKE_MODE = "hang";
  // The built-in providers hard-code 45–120s timeouts; drive the same spawn
  // transport (pexecIn) against the real fake binary with a short timeout.
  const hung = {
    name: "claude-cli",
    available: async () => true,
    draftDecision: async () => { await pexecIn("claude", ["-p"], { input: "prompt", timeout: 1500 }); throw new Error("unreachable"); },
    draftBug: async () => { throw new Error("unused"); },
  };
  const started = Date.now();
  const draft = await draftDecisionSafe(hung, { subject: "feat: x", body: "", files: ["src/billing/ledger.ts"], diff: "" });
  assert.ok(Date.now() - started < 20_000, "timeout bounded the wait");
  assert.equal(draft.fellBackTo, "deterministic");
  assert.match(draft.fallbackReason ?? "", /timed out after 1500ms/);
  for (const call of fx.calls()) { try { process.kill(call.pid); } catch { /* already gone */ } }
  assert.equal(draft.source, "inferred");
});

const alive = (pid: number): boolean => { try { process.kill(pid, 0); return true; } catch { return false; } };

// Issue #489 (regression of #44): pexecIn used to kill the cmd.exe wrapper with
// child.kill() while taskkill /T ran asynchronously, so the wrapper died first and
// the actual CLI was orphaned. boundedSpawn now waits for taskkill before killing
// the root (POSIX: signals every descendant found by walking a ps snapshot
// from the root, SIGTERM then SIGKILL).
test("external:provider: a timed-out CLI process tree is fully killed (no orphan)", { timeout: 60_000 }, async (t) => {
  const fx = providerFixture(t);
  process.env.FAKE_MODE = "hang";
  await assert.rejects(pexecIn("claude", ["-p"], { input: "prompt", timeout: 1500 }), /timed out/);
  const deadline = Date.now() + 5000;
  while (fx.calls().length === 0 && Date.now() < deadline) await new Promise((r) => setTimeout(r, 100));
  const pid = fx.calls()[0]?.pid;
  assert.ok(pid, "fake CLI recorded its pid");
  while (alive(pid) && Date.now() < deadline) await new Promise((r) => setTimeout(r, 100));
  const orphaned = alive(pid);
  if (orphaned) process.kill(pid);
  assert.equal(orphaned, false, "the CLI grandchild survived the timeout");
});

test("external:provider: no provider selected → deterministic heuristic, no CLI synthesis call, no network", { timeout: 60_000 }, async (t) => {
  const fx = providerFixture(t);
  delete process.env.HUNCH_SYNTH_PROVIDER;
  __resetAvailabilityCacheForTests();
  const resolution = await resolveSynthesisProvider({ root: fx.root });
  assert.equal(resolution.provider.name, "deterministic");
  assert.equal(resolution.source, "ambiguous", "three installed CLIs never select an account by availability");
  const result = await fx.sync(undefined);
  assert.equal(result.provider, "deterministic");
  const offline = await fx.sync("deterministic");
  assert.equal(offline.provider, "deterministic");
  assert.deepEqual(fx.calls(), [], "no fake CLI received a synthesis prompt");
  assert.equal(fx.fetches(), 0, "no network call");
});

// ---------------------------------------------------------------------------
// 2. Embeddings
// ---------------------------------------------------------------------------

function seedDecision(store: HunchStore, id: string, text: string): Decision {
  const now = new Date().toISOString();
  const d: Decision = {
    id, title: "Ledger entries are append-only", topic: null, status: "accepted",
    context: "Refund reconciliation needs history.", decision: text, consequences: [], alternatives_rejected: [], rejected_tripwires: [],
    related_components: [], related_files: ["src/billing/ledger.ts"], supersedes: null, superseded_by: null,
    caused_by_bug: null, commit: null, valid_from: now, valid_to: null, retired: { symbols: [], deps: [] },
    provenance: { source: "human_confirmed", confidence: 1, evidence: [] }, date: now,
  };
  store.json.put("decisions", d);
  return d;
}

test("external:embeddings: real local model embeds and reindex reconciles vectors by content hash", { timeout: 120_000 }, async (t) => {
  const saved = process.env.HUNCH_EMBEDDER;
  delete process.env.HUNCH_EMBEDDER;
  const embedder = await selectEmbedder();
  if (saved !== undefined) process.env.HUNCH_EMBEDDER = saved;
  if (!(embedder instanceof TransformersEmbedder)) { t.skip("model not available (@huggingface/transformers not installed)"); return; }
  for (const pkg of ["@huggingface/transformers", "@xenova/transformers"]) {
    try { const mod = await import(pkg) as { env?: { allowRemoteModels?: boolean } }; if (mod.env) mod.env.allowRemoteModels = false; } catch { /* other name */ }
  }
  let vec: Float32Array[];
  try { vec = await embedder.embed(["ledger"]); } catch { t.skip("model not available (not cached locally; downloads disabled)"); return; }
  assert.equal(vec[0]!.length, embedder.dim);
  const root = tempDir("hunch-ext-embed-");
  const store = new HunchStore(hunchPaths(root));
  t.after(() => { store.close(); cleanupDir(root); });
  store.json.ensureDirs();
  const d = seedDecision(store, "dec_embed_real", "Never mutate a posted ledger entry.");
  store.reindex();
  await store.embedAll(embedder);
  const full = store.embeddingStats(embedder.id);
  assert.equal(full.embedded, full.total);
  store.json.put("decisions", { ...d, decision: `${d.decision} Corrections are new entries.` });
  store.reindex();
  assert.equal(store.embeddingStats(embedder.id).embedded, full.total - 1, "changed text → stale vector pruned");
});

test("external:embeddings: with the optional dependency missing, hunch_query still answers via FTS", { timeout: 60_000 }, async (t) => {
  const root = tempDir("hunch-ext-fts-");
  const saved = process.env.HUNCH_EMBEDDER;
  delete process.env.HUNCH_EMBEDDER;
  // When transformers.js is installed here, force the same null-embedder path the lean install takes.
  if (await selectEmbedder()) process.env.HUNCH_EMBEDDER = "none";
  assert.equal(await selectEmbedder(), null);
  const seed = new HunchStore(hunchPaths(root));
  seed.json.ensureDirs();
  const d = seedDecision(seed, "dec_fts_only", "Ledger entries are immutable; corrections post reversing entries.");
  seed.reindex();
  seed.close();
  const server = buildServer(root);
  const [ct, st] = InMemoryTransport.createLinkedPair();
  const client = new Client({ name: "externals-test", version: "1.0.0" });
  await Promise.all([server.connect(st), client.connect(ct)]);
  t.after(async () => {
    await client.close().catch(() => {});
    await server.close().catch(() => {});
    if (saved === undefined) delete process.env.HUNCH_EMBEDDER; else process.env.HUNCH_EMBEDDER = saved;
    cleanupDir(root);
  });
  const res = await client.callTool({ name: "hunch_query", arguments: { query: "reversing entries ledger" } });
  const text = (res.content as Array<{ text: string }>).map((c) => c.text).join("\n");
  assert.notEqual(res.isError, true, text);
  assert.ok(text.includes(d.id), `FTS-only query found the decision:\n${text}`);
});

// ---------------------------------------------------------------------------
// 3. Hook dialects through the real CLI
// ---------------------------------------------------------------------------

function hookRepo(t: { after: (fn: () => void) => void }): string {
  const root = tempDir("hunch-ext-hook-");
  t.after(() => cleanupDir(root));
  execFileSync("git", ["init", "-q", root]);
  mkdirSync(join(root, ".hunch"));
  writeFileSync(join(root, ".gitignore"), ".hunch-cache/\n");
  writeFileSync(join(root, ".hunch", "config.json"), JSON.stringify({ firmness: "strict" }));
  mkdirSync(join(root, "src", "billing"), { recursive: true });
  writeFileSync(join(root, "src", "billing", "charge.ts"), "export const charge = 1;\n");
  const store = new HunchStore(hunchPaths(root));
  store.json.ensureDirs();
  store.json.put("constraints", mkConstraint({ id: "con_billing_frozen", statement: "Billing is frozen", scope: ["src/billing/**"], severity: "blocking" }));
  store.reindex();
  store.close();
  return root;
}

function runHook(root: string, provider: string, input: string) {
  const run = spawnSync(process.execPath, ["--import", tsxLoaderUrl(), hookCli, "hook", "--provider", provider], {
    cwd: root, env: isolatedCliEnv({ HUNCH_PIPELINE: "0" }), input, encoding: "utf8", timeout: 60_000, windowsHide: true,
  });
  return { status: run.status, stdout: run.stdout.trim(), stderr: run.stderr };
}

const target = (root: string) => join(root, "src", "billing", "charge.ts");
const HOOK_CASES: Array<{ provider: string; todo?: string; payload: (root: string) => unknown; denied: (r: ReturnType<typeof runHook>) => boolean }> = [
  {
    provider: "claude",
    payload: (root) => ({ hook_event_name: "PreToolUse", session_id: "cc-1", cwd: root, tool_name: "Edit", tool_input: { file_path: target(root), old_string: "1", new_string: "2" } }),
    denied: (r) => r.status === 0 && JSON.parse(r.stdout).hookSpecificOutput?.permissionDecision === "deny",
  },
  {
    provider: "codex",
    payload: (root) => ({ hook_event_name: "PreToolUse", session_id: "cx-1", turn_id: "t1", cwd: root, tool_name: "apply_patch",
      tool_input: { input: "*** Begin Patch\n*** Update File: src/billing/charge.ts\n@@\n-export const charge = 1;\n+export const charge = 2;\n*** End Patch\n" } }),
    denied: (r) => r.status === 0 && JSON.parse(r.stdout).hookSpecificOutput?.permissionDecision === "deny",
  },
  {
    provider: "cursor",
    payload: (root) => ({ hook_event_name: "preToolUse", conversation_id: "cu-1", workspace_roots: [root], tool_name: "Write", tool_input: { file_path: target(root), content: "export const charge = 2;\n" } }),
    denied: (r) => r.status === 0 && JSON.parse(r.stdout).permission === "deny",
  },
  {
    // Windsurf (Cascade) documented payload: the event travels in agent_action_name.
    provider: "windsurf",
    payload: (root) => ({ agent_action_name: "pre_write_code", trajectory_id: "ws-1", execution_id: "e1", timestamp: "2026-10-22T00:00:00Z",
      tool_info: { file_path: target(root), edits: [{ old_string: "1", new_string: "2" }] } }),
    denied: (r) => r.status === 2 && r.stdout === "" && /con_billing_frozen|Billing is frozen/.test(r.stderr),
  },
  {
    provider: "antigravity",
    payload: (root) => ({ conversationId: "ag-1", toolCall: { name: "replace_file_content", args: { TargetFile: target(root), ReplacementContent: "export const charge = 2;" } } }),
    denied: (r) => r.status === 0 && JSON.parse(r.stdout).decision === "deny",
  },
];

for (const c of HOOK_CASES) {
  test(`external:hook:${c.provider}: a guarded PreToolUse edit is denied in the host's native format`, { timeout: 120_000, todo: c.todo ?? false }, (t) => {
    const root = hookRepo(t);
    const r = runHook(root, c.provider, JSON.stringify(c.payload(root)));
    assert.ok(c.denied(r), `native deny expected; got status=${r.status} stdout=${r.stdout} stderr=${r.stderr.slice(0, 300)}`);
  });

  test(`external:hook:${c.provider}: garbage input exits 0 and never blocks`, { timeout: 120_000 }, (t) => {
    const root = hookRepo(t);
    for (const garbage of ["", "not json {", "null", "[1,2,3]", "{\"hook_event_name\":\"NoSuchEvent\"}", "{\"toolCall\":42}"]) {
      const r = runHook(root, c.provider, garbage);
      assert.equal(r.status, 0, `${JSON.stringify(garbage)} → exit ${r.status}: ${r.stderr.slice(0, 300)}`);
      if (r.stdout) {
        const out = JSON.parse(r.stdout) as Record<string, unknown>;
        assert.notEqual((out.hookSpecificOutput as { permissionDecision?: string } | undefined)?.permissionDecision, "deny");
        assert.notEqual(out.permission, "deny");
        assert.notEqual(out.decision, "deny");
      }
    }
  });
}

// ---------------------------------------------------------------------------
// 4. CI workflow
// ---------------------------------------------------------------------------

test("external:ci: generated workflow parses as YAML and every `hunch …` command it runs is a real CLI command", { timeout: 120_000 }, (t) => {
  const root = tempDir("hunch-ext-ci-");
  t.after(() => cleanupDir(root));
  execFileSync("git", ["init", "-q", root]);
  const { path, action } = writeCiWorkflow(root);
  assert.equal(action, "created");
  const yaml = readFileSync(path, "utf8");

  const { Parser, yaml: grammar } = loadNativeTreeSitter();
  const parser = new Parser();
  parser.setLanguage(grammar as never);
  const rootNode = parser.parse(yaml).rootNode as unknown as { hasError: boolean | (() => boolean) };
  const hasError = typeof rootNode.hasError === "function" ? rootNode.hasError() : rootNode.hasError;
  assert.equal(hasError, false, "workflow is syntactically valid YAML");
  assert.match(yaml, /^jobs:\n {2}hunch-guard:\n {4}runs-on: /m, "structural: jobs.hunch-guard.runs-on");
  assert.match(yaml, /^on:\n {2}pull_request:/m);

  const commands = yaml.split("\n")
    .map((l) => /^\s*(?:run:\s*)?hunch\s+([a-z][a-z-]*)(.*)$/.exec(l))
    .filter((m): m is RegExpExecArray => !!m);
  assert.ok(commands.length > 0, "workflow runs at least one hunch command");
  for (const [, sub, rest] of commands) {
    const help = spawnSync(process.execPath, ["--import", tsxLoaderUrl(), hookCli, sub!, "--help"], {
      cwd: root, env: isolatedCliEnv(), encoding: "utf8", timeout: 60_000, windowsHide: true,
    });
    assert.equal(help.status, 0, `hunch ${sub} --help exits 0: ${help.stderr.slice(0, 300)}`);
    assert.match(help.stdout, new RegExp(`Usage: hunch ${sub}\\b`), `"${sub}" is a real subcommand, not the root help`);
    for (const flag of rest!.match(/--[a-z][a-z-]*/g) ?? []) {
      assert.ok(help.stdout.includes(flag), `hunch ${sub} accepts ${flag}`);
    }
  }
});
