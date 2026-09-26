// Context footprint (#372): how much text Hunch injects into an agent's
// context, measured deterministically from the same code paths the product
// serves. Tokens are an estimate (characters / 4), not a tokenizer.
import { execFileSync } from "node:child_process";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";
import { buildServer } from "../mcp/server.js";
import { renderHunchSection } from "../integrations/claudemd.js";
import { HunchStore } from "../store/hunchStore.js";
import { hunchPaths } from "./paths.js";
import { PIPELINE_LOOP } from "./pipeline.js";
import { HOOK_REMINDER } from "./hookText.js";
import { taskInstruction } from "./taskReportHook.js";

export interface FootprintSurface {
  id: string;
  chars: number;
  est_tokens: number;
  detail?: Record<string, number>;
}

export interface FootprintReport {
  schema: "hunch.footprint/1";
  estimate: "chars/4";
  surfaces: FootprintSurface[];
  unmeasured: string[];
}

const CONTEXT_BUDGET = 1500;

const estTokens = (chars: number): number => Math.ceil(chars / 4);
const surface = (id: string, chars: number, detail?: Record<string, number>): FootprintSurface =>
  ({ id, chars, est_tokens: estTokens(chars), ...(detail ? { detail } : {}) });
const jsonChars = (v: unknown): number => (v === undefined ? 0 : JSON.stringify(v).length);

/** A host shows one channel of a tool result: Claude Code shows only
 * structuredContent, text-only hosts only content. The larger one is the cost. */
function hostVisible(id: string, result: Record<string, unknown>): FootprintSurface {
  const content = jsonChars(result.content), structured = jsonChars(result.structuredContent);
  return surface(id, Math.max(content, structured), { content_chars: content, structured_chars: structured });
}

/** The hunch_task start and finish results for a task with one delivered lesson.
 * Driven in a throwaway store, never `root`: a task writes a ledger row, and
 * `taskRecords: false` keeps finish from writing or committing a graph record. */
async function measureTaskLifecycle(): Promise<FootprintSurface[]> {
  const dir = mkdtempSync(join(tmpdir(), "hunch-footprint-"));
  try {
    // A real task runs in a git repo; the source snapshot reads git.
    try { execFileSync("git", ["init", "-q", dir], { stdio: "ignore" }); } catch { /* measured without git */ }
    const store = new HunchStore(hunchPaths(dir));
    try {
      store.json.ensureDirs();
      writeFileSync(join(dir, ".hunch", "local.json"), JSON.stringify({ taskRecords: false, autoCommit: false }));
      store.json.put("constraints", {
        id: "con_footprint_sample", type: "architecture", statement: "Tool results stay machine-readable.",
        scope: ["src/sample.ts"], severity: "blocking", enforcement: "advisory_v1", match: null, forbids: null,
        rationale: "Orchestrators must not parse prose.", source_decision: null, violations: [], status: "active",
        valid_from: "2026-01-01T00:00:00.000Z", valid_to: null,
        provenance: { source: "human_confirmed", confidence: 1, evidence: [] },
      });
      store.reindex();
    } finally {
      store.close();
    }
    const server = buildServer(dir);
    const [ct, st] = InMemoryTransport.createLinkedPair();
    const client = new Client({ name: "hunch-footprint", version: "1" });
    await Promise.all([server.connect(st), client.connect(ct)]);
    try {
      const start = await client.callTool({ name: "hunch_task", arguments: { action: "start", title: "Assistant task" } });
      const taskId = (start.structuredContent as { task?: { task_id?: string } } | undefined)?.task?.task_id;
      if (start.isError || !taskId) throw new Error("hunch_task start failed");
      await client.callTool({ name: "hunch_context", arguments: { target: "src/sample.ts", task_id: taskId } });
      const finish = await client.callTool({ name: "hunch_task", arguments: { action: "finish", task_id: taskId } });
      if (finish.isError) throw new Error("hunch_task finish failed");
      return [hostVisible("mcp.hunch_task.start", start), hostVisible("mcp.hunch_task.finish", finish)];
    } finally {
      await client.close();
      await server.close();
    }
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
}

/** Surfaces built inline from live host/session state; not measurable in-process. */
const UNMEASURED = [
  "hook.session.orientation — SessionStart text is built inline in the `hook` command action (src/cli/index.ts) from live session state",
  "hook.pre_edit.grounding — PreToolUse grounding is built per edited file and event",
];

/** The file most decisions cite — a FILE target, so the brief carries per-record
 *  lines and omissions the way a pre-edit call does. "src" when no decision names one. */
function busiestFile(store: HunchStore): string {
  const counts = new Map<string, number>();
  for (const d of store.advisoryRecs("decisions")) {
    for (const f of new Set(d.related_files)) if (!f.includes("*")) counts.set(f, (counts.get(f) ?? 0) + 1);
  }
  return [...counts].sort((a, b) => b[1] - a[1] || a[0].localeCompare(b[0]))[0]?.[0] ?? "src";
}

export async function measureFootprint(root: string, opts: { target?: string } = {}): Promise<FootprintReport> {
  const surfaces: FootprintSurface[] = [];
  let target = opts.target;
  if (!target) {
    const store = new HunchStore(hunchPaths(root));
    try { target = busiestFile(store); } finally { store.close(); }
  }

  const server = buildServer(root);
  const [ct, st] = InMemoryTransport.createLinkedPair();
  const client = new Client({ name: "hunch-footprint", version: "1" });
  await Promise.all([server.connect(st), client.connect(ct)]);
  try {
    const tools = (await client.listTools()).tools;
    let outputChars = 0, inputChars = 0, descriptionChars = 0, largest = 0;
    for (const t of tools) {
      outputChars += jsonChars(t.outputSchema);
      inputChars += jsonChars(t.inputSchema);
      descriptionChars += (t.description ?? "").length;
      largest = Math.max(largest, jsonChars(t));
    }
    surfaces.push(surface("mcp.tools_list", jsonChars(tools), {
      output_schema_chars: outputChars,
      input_schema_chars: inputChars,
      description_chars: descriptionChars,
      tools: tools.length,
      largest_tool_chars: largest,
    }));
    // What hosts that drop outputSchema actually pay.
    const core = tools.map(t => ({ name: t.name, description: t.description, inputSchema: t.inputSchema }));
    surfaces.push(surface("mcp.tools_list.core", jsonChars(core)));

    const result = await client.callTool({ name: "hunch_context", arguments: { target, budget_tokens: CONTEXT_BUDGET } });
    // A host shows the model one channel — structuredContent when it reads it,
    // content otherwise — so the cost it pays is the larger, not the sum.
    const contentChars = jsonChars(result.content);
    const structuredChars = jsonChars(result.structuredContent);
    const chars = Math.max(contentChars, structuredChars);
    surfaces.push(surface("mcp.hunch_context", chars, {
      content_chars: contentChars,
      structured_chars: structuredChars,
      budget_tokens: CONTEXT_BUDGET,
      // est_tokens / budget, ×100 as an integer percentage.
      budget_ratio_pct: Math.round((estTokens(chars) / CONTEXT_BUDGET) * 100),
    }));
  } finally {
    await client.close();
    await server.close();
  }

  surfaces.push(...await measureTaskLifecycle());

  const store = new HunchStore(hunchPaths(root));
  try {
    surfaces.push(surface("grounding.block", renderHunchSection(store, root).length));
  } finally {
    store.close();
  }

  surfaces.push(surface("hook.session.pipeline_loop", PIPELINE_LOOP.length));
  surfaces.push(surface("hook.prompt.reminder", HOOK_REMINDER.length));
  // Every prompt gets a task instruction: full once per session, compact after.
  // Measured for a host whose stop hook closes the task, with a fixed installed
  // launcher and cwd so the number does not move with the checkout path.
  const sampleTask = { task_id: "htask_" + "0".repeat(24), title: "Assistant task" };
  const sampleCwd = JSON.stringify("/home/user/repo");
  const sampleLauncher = () => ({ shell: "node /home/user/repo/node_modules/@davesheffer/hunch/dist/cli/index.js" });
  surfaces.push(surface("hook.prompt.task_instruction", taskInstruction(sampleTask, sampleCwd, "claude", sampleLauncher).length));
  surfaces.push(surface("hook.prompt.task_instruction.compact", taskInstruction(sampleTask, sampleCwd, "claude", sampleLauncher, "compact").length));

  return { schema: "hunch.footprint/1", estimate: "chars/4", surfaces, unmeasured: [...UNMEASURED] };
}
