/** Lean hook delivery: SessionStart carries no operating loop unless opted in;
 *  edit-hook grounding carries no graph lists (blast, components, landscape)
 *  while hunch_context's envelope keeps them; hook constraints are the file's
 *  own scope, and one served earlier in the task becomes a one-line reference;
 *  a shell write of several files is ONE block with each shared record once. */
import { test } from "node:test";
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { mkdirSync, mkdtempSync, realpathSync, rmSync, utimesSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { buildDeliveryEnvelope } from "../src/core/delivery.js";
import { PIPELINE_LOOP } from "../src/core/pipeline.js";
import { hunchPaths } from "../src/core/paths.js";
import { resetSessionInjections, ServedMarks } from "../src/core/hookcache.js";
import { DecisionSchema } from "../src/core/types.js";
import { HunchStore, type AssembledContext } from "../src/store/hunchStore.js";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";
import { buildServer } from "../src/mcp/server.js";
import { mkConstraint, prov, tsxLoaderUrl } from "./helpers.js";

const cli = resolve("src/cli/index.ts");
const session = () => `lean-${process.pid}-${Math.random().toString(36).slice(2)}`;

function repo(t: { after: (f: () => void) => void }, decisions = true): string {
  const root = realpathSync(mkdtempSync(join(tmpdir(), "hunch-lean-")));
  t.after(() => rmSync(root, { recursive: true, force: true }));
  const git = (...args: string[]) => execFileSync("git", ["-C", root, ...args], { env: { ...process.env, GIT_AUTHOR_NAME: "t", GIT_AUTHOR_EMAIL: "t@t", GIT_COMMITTER_NAME: "t", GIT_COMMITTER_EMAIL: "t@t" } });
  git("init", "-q");
  mkdirSync(join(root, "src"));
  writeFileSync(join(root, "src", "a.ts"), "export const a = 1;\n");
  writeFileSync(join(root, "src", "b.ts"), "export const b = 1;\n");
  git("add", "-A");
  git("commit", "-q", "-m", "init");
  mkdirSync(join(root, ".hunch"));
  writeFileSync(join(root, ".hunch", "config.json"), JSON.stringify({ firmness: "advisory" }));
  const store = new HunchStore(hunchPaths(root));
  store.json.ensureDirs();
  store.json.put("constraints", mkConstraint({ id: "con_shared_src", statement: "Every src module stays free of import-time side effects", scope: ["src/**"], severity: "blocking" }));
  store.json.put("constraints", mkConstraint({ id: "con_only_b", statement: "Module b exports constants only", scope: ["src/b.ts"], severity: "warning" }));
  store.json.put("components", { id: "cmp_src", kind: "module", name: "Src", responsibility: "", paths: ["src/**"], status: "active", owners: [], fragility: 0, provenance: prov(0.6), created_at: "2026-01-01T00:00:00Z", updated_at: "2026-01-01T00:00:00Z" } as never);
  if (decisions) {
    store.json.put("decisions", DecisionSchema.parse({
      id: "dec_lean_a", title: "Module a stays tiny", status: "accepted", decision: "", date: "2026-09-11",
      related_files: ["src/a.ts"], provenance: { source: "human_confirmed", confidence: 1, evidence: [] },
    }));
  }
  store.reindex();
  store.close();
  return root;
}

function hook(root: string, payload: Record<string, unknown>, env: Record<string, string> = {}): string {
  const out = execFileSync(process.execPath, ["--import", tsxLoaderUrl(), cli, "hook", "--provider", "claude"], {
    cwd: root, env: { ...process.env, HUNCH_PIPELINE: "0", HUNCH_TASK_SELECTION: "", HUNCH_SESSION_LOOP: "", ...env },
    input: JSON.stringify({ cwd: root, ...payload }), encoding: "utf8",
  }).trim();
  if (!out) return "";
  const parsed = JSON.parse(out) as { hookSpecificOutput?: { additionalContext?: string } };
  return parsed.hookSpecificOutput?.additionalContext ?? "";
}

const preEdit = (root: string, s: string, file: string) => hook(root, {
  hook_event_name: "PreToolUse", session_id: s, tool_name: "Edit",
  tool_input: { file_path: join(root, file), old_string: "1", new_string: "2" },
});

test("SessionStart: no operating loop by default, the loop on explicit opt-in", t => {
  for (const decisions of [true, false]) {
    const root = repo(t, decisions);
    const plain = hook(root, { hook_event_name: "SessionStart", session_id: session(), source: "startup" }, { HUNCH_PIPELINE: "" });
    assert.ok(!plain.includes(PIPELINE_LOOP.split("\n")[0]!), "no loop by default");
    if (decisions) assert.match(plain, /Hunch orientation/, "orientation stays");
    if (decisions) assert.match(plain, /Orient further/);
    const opted = hook(root, { hook_event_name: "SessionStart", session_id: session(), source: "startup" }, { HUNCH_PIPELINE: "", HUNCH_SESSION_LOOP: "1" });
    assert.ok(opted.includes(PIPELINE_LOOP), "opt-in ships the loop");
    const killed = hook(root, { hook_event_name: "SessionStart", session_id: session(), source: "startup" }, { HUNCH_SESSION_LOOP: "1" });
    assert.ok(!killed.includes(PIPELINE_LOOP.split("\n")[0]!), "the pipeline kill switch wins");
  }
});

test("envelope: graphLists:false drops blast and components; the default (hunch_context) keeps them", () => {
  const ctx = {
    target: "src/a.ts", constraints: [mkConstraint({ id: "con_x", scope: ["src/a.ts"], severity: "blocking" })],
    decisions: [], bugs: [], findings: [], budget_tokens: 1500,
    blast_radius: [{ id: "sym_caller", depth: 1, via: "src/c.ts:caller" }],
    components: [{ id: "cmp_src", name: "Src" }],
  } as unknown as AssembledContext;
  const full = buildDeliveryEnvelope(ctx, { commitReachability: () => "reachable" }).text;
  assert.match(full, /graph \| blast\/d1/);
  assert.match(full, /graph \| components \| Src/);
  const lean = buildDeliveryEnvelope(ctx, { commitReachability: () => "reachable", graphLists: false }).text;
  assert.doesNotMatch(lean, /graph \| (blast|components)/);
  assert.doesNotMatch(lean, /Landscape:/);
  assert.match(lean, /con_x \| constraint\/blocking/);
});

test("hook grounding: no graph lists, own-scope constraints only, a served constraint becomes a reference", t => {
  const root = repo(t);
  const s = session();
  const a = preEdit(root, s, "src/a.ts");
  assert.doesNotMatch(a, /graph \| (blast|components)|Landscape:/);
  assert.match(a, /con_shared_src \| constraint\/blocking \| Every src module stays free of import-time side effects \| scope src\/\*\*/);
  assert.doesNotMatch(a, /con_only_b/, "a constraint scoped to another file is absent");
  const b = preEdit(root, s, "src/b.ts");
  assert.match(b, /con_only_b \| constraint\/warning \| Module b exports constants only \| scope/, "in-scope constraint served in full");
  assert.match(b, /- con_shared_src \| constraint\/blocking \| [^\n|]+ \| shown earlier this session \| hunch_why\("con_shared_src"\)/, "second serve is a one-line reference");
  assert.doesNotMatch(b, /con_shared_src[^\n]*scope src/);
  // The reference switch alone is not a change for the file's own dedupe.
  assert.match(preEdit(root, s, "src/a.ts"), /unchanged this session/);
});

test("hook grounding: a file whose only memory was graph lists stays silent", t => {
  const root = realpathSync(mkdtempSync(join(tmpdir(), "hunch-lean-silent-")));
  t.after(() => rmSync(root, { recursive: true, force: true }));
  execFileSync("git", ["-C", root, "init", "-q"]);
  mkdirSync(join(root, "lib"));
  writeFileSync(join(root, "lib", "x.ts"), "export const x = 1;\n");
  const store = new HunchStore(hunchPaths(root));
  store.json.ensureDirs();
  store.json.put("components", { id: "cmp_lib", kind: "module", name: "Lib", responsibility: "", paths: ["lib/**"], status: "active", owners: [], fragility: 0, provenance: prov(0.6), created_at: "2026-01-01T00:00:00Z", updated_at: "2026-01-01T00:00:00Z" } as never);
  store.reindex();
  store.close();
  assert.equal(preEdit(root, session(), "lib/x.ts"), "");
});

test("shell write of two files sharing a record: one block, the record once, naming both files", t => {
  const root = repo(t);
  const s = session();
  hook(root, { hook_event_name: "PreToolUse", session_id: s, tool_name: "Bash", tool_input: { command: "sed -i" } });
  const at = new Date(Date.now() + 2000);
  for (const f of ["a.ts", "b.ts"]) {
    writeFileSync(join(root, "src", f), "export const changed = 2;\n");
    utimesSync(join(root, "src", f), at, at);
  }
  const out = hook(root, { hook_event_name: "PostToolUse", session_id: s, tool_name: "Bash", tool_input: { command: "sed -i" } });
  assert.match(out, /this shell command wrote src\/a\.ts, src\/b\.ts/);
  assert.equal(out.match(/# Hunch context for/g)?.length, 1, "one merged block");
  assert.match(out, /# Hunch context for "src\/a\.ts", "src\/b\.ts"/);
  assert.equal(out.match(/- con_shared_src \|/g)?.length, 1, "shared record once");
  assert.match(out, /- con_shared_src \| constraint\/blocking \| Every src[^\n]*scope src\/\*\*[^\n]*\| files src\/a\.ts, src\/b\.ts/);
  assert.match(out, /- con_only_b [^\n]*\| files src\/b\.ts/);
  assert.doesNotMatch(out, /graph \| components/);
});

test("hunch_runbook serves the operating loop on request", async () => {
  const root = mkdtempSync(join(tmpdir(), "hunch-lean-runbook-"));
  const server = buildServer(root);
  const [ct, st] = InMemoryTransport.createLinkedPair();
  const client = new Client({ name: "lean-runbook", version: "1" });
  try {
    await Promise.all([client.connect(ct), server.connect(st)]);
    const text = async (task: string) => {
      const r = await client.callTool({ name: "hunch_runbook", arguments: { task } });
      return (r.content as { type: string; text: string }[]).map(c => c.text).join("");
    };
    assert.equal(await text("show me the Operating Loop"), PIPELINE_LOOP);
    assert.ok(!(await text("cut a release")).includes(PIPELINE_LOOP));
  } finally {
    await client.close(); await server.close(); rmSync(root, { recursive: true, force: true });
  }
});

test("a constraint the budget omits is not marked served: it is full text next time", t => {
  const root = repo(t, false);
  const store = new HunchStore(hunchPaths(root));
  const filler = "keep every exported helper pure and documented with its failure modes ".repeat(12);
  for (let i = 0; i < 40; i++) store.json.put("constraints", mkConstraint({ id: `con_bulk_${String(i).padStart(2, "0")}`, statement: `BULK_${i} ${filler}`, scope: ["src/**"], severity: "warning" }));
  store.reindex();
  store.close();
  const s = session();
  const a = preEdit(root, s, "src/a.ts");
  const ids = Array.from({ length: 40 }, (_, i) => `con_bulk_${String(i).padStart(2, "0")}`);
  const shown = ids.filter((id) => a.includes(`- ${id} |`));
  const omitted = ids.filter((id) => !a.includes(`- ${id} |`));
  assert.ok(shown.length && omitted.length, `fixture sanity: the budget omits some (${shown.length} shown)`);
  // A served one probes as served; an omitted one does not (probe marks it, so check each once).
  assert.equal(new ServedMarks(s).probe(`con:${shown[0]}`), true, "a delivered constraint is marked served");
  for (const id of omitted) assert.equal(new ServedMarks(s).probe(`con:${id}`), false, `${id} was never shown, so it is not marked`);
});

test("a served constraint is full text again for a new task and for a subagent", t => {
  const root = repo(t);
  const s = session();
  assert.match(preEdit(root, s, "src/a.ts"), /con_shared_src \| constraint\/blocking \| Every src[^\n]*scope src/);
  const full = /- con_shared_src \| constraint\/blocking \| Every src module stays free of import-time side effects \| scope src\/\*\*/;
  // A subagent starts with fresh context: its own agent identity scopes the mark.
  const sub = hook(root, { hook_event_name: "PreToolUse", session_id: s, agent_id: "agent-sub-1", tool_name: "Edit", tool_input: { file_path: join(root, "src/b.ts"), old_string: "1", new_string: "2" } });
  assert.match(sub, full, "a subagent gets the full text");
  assert.doesNotMatch(sub, /con_shared_src[^\n]*shown earlier/);
  // A prompt that opens a task scopes the mark to that task_id.
  hook(root, { hook_event_name: "UserPromptSubmit", session_id: s, prompt_id: "p-new", prompt: "next task" });
  const next = hook(root, { hook_event_name: "PreToolUse", session_id: s, prompt_id: "p-new", tool_name: "Edit", tool_input: { file_path: join(root, "src/b.ts"), old_string: "1", new_string: "2" } });
  assert.match(next, /Hunch task htask_/, "fixture sanity: the edit reports to the prompt's task");
  assert.match(next, full, "a new task gets the full text");
  assert.doesNotMatch(next, /con_shared_src[^\n]*shown earlier/);
});

test("served marks: rollback after a throw leaves nothing this invocation marked, and keeps earlier serves", () => {
  const s = session();
  const earlier = new ServedMarks(s);
  assert.equal(earlier.probe("con:con_earlier"), false);
  const marks = new ServedMarks(s);
  assert.equal(marks.probe("con:con_earlier"), true, "served by an earlier invocation");
  assert.equal(marks.probe("con:con_now_a"), false);
  assert.equal(marks.probe("con:con_now_b"), false);
  try {
    throw new Error("delivery failed after marking");
  } catch {
    marks.rollback();
  }
  const after = new ServedMarks(s);
  assert.equal(after.probe("con:con_now_a"), false, "rolled back: full text next time");
  assert.equal(after.probe("con:con_now_b"), false, "rolled back: full text next time");
  assert.equal(after.probe("con:con_earlier"), true, "an earlier serve is not this invocation's to undo");
});

test("rollback also forgets a per-file block that was never emitted", () => {
  const sid = session();
  try {
    const first = new ServedMarks(sid);
    assert.equal(first.probe("con:con_X"), false);
    assert.equal(first.mode("pre:src/a.ts", "block", "identity"), "full");
    first.rollback(); // the hook threw before emitting
    const second = new ServedMarks(sid);
    assert.equal(second.probe("con:con_X"), false, "constraint is full text again");
    assert.equal(second.mode("pre:src/a.ts", "block", "identity"), "full", "file block is full again, not a delta");
    assert.equal(new ServedMarks(sid).mode("pre:src/a.ts", "block", "identity"), "delta", "an emitted block still dedups");
  } finally { resetSessionInjections(sid); }
});
