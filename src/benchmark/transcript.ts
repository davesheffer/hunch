// Parses a Claude Code `--output-format stream-json --verbose --include-hook-events` transcript
// into the Gate A metrics (bench/pilot5/GATE-A-HARNESS.md, "Metrics"). Tolerant by design: blank
// and malformed lines are skipped, never thrown.
import type { HookInjections, TaskCost, TokenParts, TranscriptMetrics } from "./types.js";

/** Preregistered investigation tools. */
export const INVESTIGATION_TOOLS: readonly string[] = ["Read", "Grep", "Glob"];
const HUNCH_TOOL_PREFIX = "mcp__hunch__";
const RECORD_ID = /\b(?:dec|con|fnd|bug)_[0-9a-f]{10}\b|\bhtask_[0-9a-f]{24}\b/g;

type Obj = Record<string, unknown>;
const isObj = (value: unknown): value is Obj => typeof value === "object" && value !== null && !Array.isArray(value);
const asString = (value: unknown): string | null => (typeof value === "string" ? value : null);
const asNumber = (value: unknown): number | null => (typeof value === "number" && Number.isFinite(value) ? value : null);

/** An Anthropic `usage` object (result event or assistant message); missing parts count 0. */
function usageParts(usage: Obj): TokenParts {
  return {
    input: asNumber(usage.input_tokens) ?? 0,
    cache_creation: asNumber(usage.cache_creation_input_tokens) ?? 0,
    cache_read: asNumber(usage.cache_read_input_tokens) ?? 0,
    output: asNumber(usage.output_tokens) ?? 0,
  };
}

function addParts(sum: TokenParts | null, parts: TokenParts): TokenParts {
  if (sum === null) return { ...parts };
  return {
    input: sum.input + parts.input,
    cache_creation: sum.cache_creation + parts.cache_creation,
    cache_read: sum.cache_read + parts.cache_read,
    output: sum.output + parts.output,
  };
}

/** Input tokens as Gate A counts them: input + cache creation + cache read. */
const inputOf = (parts: TokenParts): number => parts.input + parts.cache_creation + parts.cache_read;

type TranscriptCost = Pick<TaskCost,
  | "input_tokens" | "output_tokens" | "token_measurement" | "input_token_parts"
  | "main_input_tokens" | "main_output_tokens" | "subagent_input_tokens" | "subagent_output_tokens"
  | "result_events" | "input_tokens_lower_bound" | "output_tokens_lower_bound"
  | "model_calls" | "main_model_calls" | "subagent_model_calls" | "tool_calls" | "investigation_tool_calls" | "call_measurement"
  | "hook_injections" | "background_wakeups">;

/** The token and call fields of a run's TaskCost, from its parsed transcript (null: the agent never ran).
 *  Shared by the live run and `--report-only --recount`, so both count the same way. */
export function transcriptCost(metrics: TranscriptMetrics | null): TranscriptCost {
  const main = metrics?.usage ?? null;
  const session = metrics?.session_usage ?? null;
  // Without modelUsage the session total is the main loop (no subagent streamed), so the subagent share is unknown, not 0.
  const split = session !== null && main !== null && metrics?.model_usage != null;
  const noResult = metrics !== null && metrics.result_events === 0;
  const streamed = metrics?.streamed_usage;
  return {
    input_tokens: session ? inputOf(session) : null,
    output_tokens: session ? session.output : null,
    token_measurement: session ? "provider" : "unavailable",
    input_token_parts: session ? { input: session.input, cache_creation: session.cache_creation, cache_read: session.cache_read } : null,
    main_input_tokens: main ? inputOf(main) : null,
    main_output_tokens: main ? main.output : null,
    subagent_input_tokens: split ? inputOf(session!) - inputOf(main!) : null,
    subagent_output_tokens: split ? session!.output - main!.output : null,
    result_events: metrics ? metrics.result_events : null,
    input_tokens_lower_bound: noResult && streamed ? streamed.main.input + streamed.subagents.input : null,
    output_tokens_lower_bound: noResult && streamed ? streamed.main.output + streamed.subagents.output : null,
    model_calls: metrics ? metrics.model_calls : null,
    main_model_calls: metrics ? metrics.main_model_calls : null,
    subagent_model_calls: metrics ? metrics.subagent_model_calls : null,
    tool_calls: metrics ? metrics.tool_calls : null,
    investigation_tool_calls: metrics ? metrics.investigation_tool_calls : null,
    call_measurement: metrics ? "parsed" : "unavailable",
    hook_injections: metrics ? metrics.hook_injections : null,
    background_wakeups: metrics ? metrics.background_wakeups : null,
  };
}

function toolResultText(content: unknown): string {
  if (typeof content === "string") return content;
  if (!Array.isArray(content)) return "";
  return content.map((block) => (isObj(block) && block.type === "text" ? asString(block.text) ?? "" : "")).join("");
}

/** Text a hook injected: the structured fields when stdout is a JSON object, else trimmed stdout. */
function hookInjectedText(stdout: string): string[] {
  let parsed: unknown;
  try { parsed = JSON.parse(stdout); } catch { parsed = undefined; }
  if (!isObj(parsed)) return [stdout.trim()];
  const specific = isObj(parsed.hookSpecificOutput) ? parsed.hookSpecificOutput.additionalContext : undefined;
  return [specific, parsed.systemMessage, parsed.reason].filter((value): value is string => typeof value === "string");
}

/**
 * One hook_response's injected context: `output` parsed as JSON when it starts with `{`, its non-empty
 * `hookSpecificOutput.additionalContext`, keyed by `hook_event` (else `hookEventName`, else `hook_name`).
 * Null for anything else, so a Stop hook's `systemMessage` and plain-text output never count.
 */
export function hookInjection(event: Record<string, unknown>): { event: string; chars: number } | null {
  const output = asString(event.output) ?? "";
  if (!output.trimStart().startsWith("{")) return null;
  let parsed: unknown;
  try { parsed = JSON.parse(output); } catch { return null; }
  const specific = isObj(parsed) && isObj(parsed.hookSpecificOutput) ? parsed.hookSpecificOutput : null;
  const context = specific ? asString(specific.additionalContext) : null;
  if (!context) return null;
  const name = asString(event.hook_event) ?? asString(specific!.hookEventName) ?? asString(event.hook_name) ?? "(unknown)";
  return { event: name, chars: [...context].length };
}

/** Sorted unique record ids (same pattern as the transcript parser) in `text`. */
export function recordIdsIn(text: string): string[] {
  return [...new Set(Array.from(text.matchAll(RECORD_ID), (match) => match[0]))].sort();
}

/** Keys whose string is file content (Edit/Write/NotebookEdit bodies, todo text), not a path or command. */
const CONTENT_KEYS = new Set(["content", "new_string", "old_string", "new_source"]);

/** Every string value, recursively, inside each assistant `tool_use` block's `input` —
 *  scanned for out-of-repo path access (see orchestrate.ts's no-out-of-repo-access check).
 *  `content` marks a value under a CONTENT_KEYS key. */
export function toolInputStrings(transcriptText: string): Array<{ value: string; content: boolean; shell: boolean }> {
  const out: Array<{ value: string; content: boolean; shell: boolean }> = [];
  // `shell`: the string sits under a `command` key (Claude Code's Bash/PowerShell, or an argv array under one), so a
  // shell runs it. Other hosts' keys (Codex `exec_command` uses `cmd`) are not read yet; add them with their transcripts.
  const collect = (value: unknown, content = false, shell = false): void => {
    if (typeof value === "string") out.push({ value, content, shell });
    else if (Array.isArray(value)) for (const item of value) collect(item, content, shell);
    else if (isObj(value)) for (const [key, item] of Object.entries(value)) collect(item, content || CONTENT_KEYS.has(key), shell || key === "command");
  };
  for (const line of transcriptText.split(/\r?\n/)) {
    if (!line.trim()) continue;
    let event: unknown;
    try { event = JSON.parse(line); } catch { continue; }
    if (!isObj(event) || event.type !== "assistant" || !isObj(event.message)) continue;
    const content = Array.isArray(event.message.content) ? event.message.content : [];
    for (const block of content) if (isObj(block) && block.type === "tool_use") collect(block.input);
  }
  return out;
}

export function parseTranscript(text: string): TranscriptMetrics {
  const events: Obj[] = [];
  for (const line of text.split(/\r?\n/)) {
    if (!line.trim()) continue;
    try {
      const value: unknown = JSON.parse(line);
      if (isObj(value)) events.push(value);
    } catch { /* malformed line: skip */ }
  }

  let init: TranscriptMetrics["init"] = null;
  let result: TranscriptMetrics["result"] = null;
  let resultEvents = 0;
  let usage: TranscriptMetrics["usage"] = null;
  let modelUsage: TranscriptMetrics["model_usage"] = null;
  let hookEvents = 0;
  let hookChars = 0;
  const hookInjections: HookInjections = { by_event: {}, total: { injections: 0, chars: 0 } };
  let initEvents = 0;
  const messages = new Map<string, { subagent: boolean; input: number; output: number }>(); // message id -> last usage seen
  const toolUses = new Map<string, string>(); // tool_use id -> tool name
  const injected: string[] = [];

  for (const event of events) {
    if (event.type === "system" && event.subtype === "init") initEvents++;
    if (event.type === "system" && event.subtype === "init" && !init) {
      const servers = Array.isArray(event.mcp_servers) ? event.mcp_servers : [];
      const serverStatus: Record<string, string> = {};
      for (const server of servers) {
        if (!isObj(server)) continue;
        const name = asString(server.name);
        const status = asString(server.status);
        if (name !== null && status !== null) serverStatus[name] = status;
      }
      const memoryPaths = isObj(event.memory_paths) ? event.memory_paths : null;
      init = {
        model: asString(event.model),
        api_key_source: asString(event.apiKeySource),
        mcp_servers: servers.map((server) => (isObj(server) ? asString(server.name) : asString(server))).filter((name): name is string => name !== null),
        mcp_server_status: serverStatus,
        tool_names: Array.isArray(event.tools) ? event.tools.filter((name): name is string => typeof name === "string") : [],
        memory_paths_auto: memoryPaths ? asString(memoryPaths.auto) : null,
      };
    } else if (event.type === "system" && event.subtype === "hook_response") {
      hookEvents++;
      for (const piece of hookInjectedText(asString(event.stdout) ?? "")) {
        hookChars += piece.length;
        injected.push(piece);
      }
      const injection = hookInjection(event);
      if (injection) {
        const slot = hookInjections.by_event[injection.event] ??= { injections: 0, chars: 0 };
        slot.injections++;
        slot.chars += injection.chars;
        hookInjections.total.injections++;
        hookInjections.total.chars += injection.chars;
      }
    } else if (event.type === "assistant" && isObj(event.message)) {
      const id = asString(event.message.id);
      if (id !== null) {
        // Subagent messages carry the spawning Agent call's id; the stream repeats a message per content block.
        const reported = isObj(event.message.usage) ? usageParts(event.message.usage) : null;
        const previous = messages.get(id);
        messages.set(id, {
          subagent: event.parent_tool_use_id !== null && event.parent_tool_use_id !== undefined,
          input: reported ? inputOf(reported) : previous?.input ?? 0,
          output: reported ? reported.output : previous?.output ?? 0,
        });
      }
      const content = Array.isArray(event.message.content) ? event.message.content : [];
      for (const block of content) {
        if (!isObj(block) || block.type !== "tool_use") continue;
        const useId = asString(block.id) ?? `anonymous:${toolUses.size}`;
        if (!toolUses.has(useId)) toolUses.set(useId, asString(block.name) ?? "(unknown)");
      }
    } else if (event.type === "result") {
      // A background-task notification re-invokes the session and emits another result event. Each
      // `usage` covers only its own invocation, so they add up; `modelUsage` is cumulative, so the last wins.
      resultEvents++;
      result = {
        subtype: asString(event.subtype),
        is_error: typeof event.is_error === "boolean" ? event.is_error : null,
        num_turns: asNumber(event.num_turns),
      };
      if (isObj(event.usage)) usage = addParts(usage, usageParts(event.usage));
      // Only the last result's: an earlier cumulative value misses the invocations after it.
      modelUsage = isObj(event.modelUsage) ? event.modelUsage : null;
    }
  }

  const subagentCalls = [...messages.values()].filter((message) => message.subagent).length;
  // Without modelUsage the main loop is the session only when no subagent ran; otherwise the total is unknown.
  let sessionUsage: TokenParts | null = resultEvents === 0 || subagentCalls > 0 ? null : usage;
  if (resultEvents > 0 && modelUsage !== null) {
    let total: TokenParts = { input: 0, cache_creation: 0, cache_read: 0, output: 0 };
    for (const model of Object.values(modelUsage)) {
      if (!isObj(model)) continue;
      total = addParts(total, {
        input: asNumber(model.inputTokens) ?? 0,
        cache_creation: asNumber(model.cacheCreationInputTokens) ?? 0,
        cache_read: asNumber(model.cacheReadInputTokens) ?? 0,
        output: asNumber(model.outputTokens) ?? 0,
      });
    }
    // The subagent share is total - main; a total below the main loop is an inconsistent report, not a number.
    sessionUsage = usage !== null && (inputOf(total) < inputOf(usage) || total.output < usage.output) ? null : total;
  }
  const streamed = { main: { input: 0, output: 0 }, subagents: { input: 0, output: 0 } };
  for (const message of messages.values()) {
    const side = message.subagent ? streamed.subagents : streamed.main;
    side.input += message.input;
    side.output += message.output;
  }

  // Results are matched after every tool_use is known, so line order cannot drop one.
  let toolResultChars = 0;
  const seenResults = new Set<string>();
  for (const event of events) {
    if (event.type !== "user" || !isObj(event.message) || !Array.isArray(event.message.content)) continue;
    for (const block of event.message.content) {
      if (!isObj(block) || block.type !== "tool_result") continue;
      const useId = asString(block.tool_use_id);
      if (useId === null || seenResults.has(useId) || !toolUses.get(useId)?.startsWith(HUNCH_TOOL_PREFIX)) continue;
      seenResults.add(useId);
      const body = toolResultText(block.content);
      toolResultChars += body.length;
      injected.push(body);
    }
  }

  const histogram: Record<string, number> = {};
  for (const name of toolUses.values()) histogram[name] = (histogram[name] ?? 0) + 1;
  const names = [...toolUses.values()];
  const delivered = new Set<string>();
  for (const piece of injected) for (const match of piece.matchAll(RECORD_ID)) delivered.add(match[0]);

  return {
    init,
    result,
    result_events: resultEvents,
    usage,
    model_usage: modelUsage,
    session_usage: sessionUsage,
    streamed_usage: streamed,
    model_calls: messages.size,
    main_model_calls: messages.size - subagentCalls,
    subagent_model_calls: subagentCalls,
    tool_calls: toolUses.size,
    tool_histogram: histogram,
    investigation_tool_calls: names.filter((name) => INVESTIGATION_TOOLS.includes(name)).length,
    hunch_tool_calls: names.filter((name) => name.startsWith(HUNCH_TOOL_PREFIX)).length,
    hunch_dynamic_chars: { tool_results: toolResultChars, hooks: hookChars },
    hook_events: hookEvents,
    hook_injections: hookInjections,
    background_wakeups: Math.max(0, initEvents - 1),
    delivered_record_ids: [...delivered].sort(),
  };
}
