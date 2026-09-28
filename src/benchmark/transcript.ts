// Parses a Claude Code `--output-format stream-json --verbose --include-hook-events` transcript
// into the Gate A metrics (bench/pilot5/GATE-A-HARNESS.md, "Metrics"). Tolerant by design: blank
// and malformed lines are skipped, never thrown.
import type { TranscriptMetrics } from "./types.js";

/** Preregistered investigation tools. */
export const INVESTIGATION_TOOLS: readonly string[] = ["Read", "Grep", "Glob"];
const HUNCH_TOOL_PREFIX = "mcp__hunch__";
const RECORD_ID = /\b(?:dec|con|fnd|bug)_[0-9a-f]{10}\b|\bhtask_[0-9a-f]{24}\b/g;

type Obj = Record<string, unknown>;
const isObj = (value: unknown): value is Obj => typeof value === "object" && value !== null && !Array.isArray(value);
const asString = (value: unknown): string | null => (typeof value === "string" ? value : null);
const asNumber = (value: unknown): number | null => (typeof value === "number" && Number.isFinite(value) ? value : null);

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

/** Sorted unique record ids (same pattern as the transcript parser) in `text`. */
export function recordIdsIn(text: string): string[] {
  return [...new Set(Array.from(text.matchAll(RECORD_ID), (match) => match[0]))].sort();
}

/** Keys whose string is file content (Edit/Write/NotebookEdit bodies, todo text), not a path or command. */
const CONTENT_KEYS = new Set(["content", "new_string", "old_string", "new_source"]);

/** Every string value, recursively, inside each assistant `tool_use` block's `input` —
 *  scanned for out-of-repo path access (see orchestrate.ts's no-out-of-repo-access check).
 *  `content` marks a value under a CONTENT_KEYS key. */
export function toolInputStrings(transcriptText: string): Array<{ value: string; content: boolean }> {
  const out: Array<{ value: string; content: boolean }> = [];
  const collect = (value: unknown, content = false): void => {
    if (typeof value === "string") out.push({ value, content });
    else if (Array.isArray(value)) for (const item of value) collect(item, content);
    else if (isObj(value)) for (const [key, item] of Object.entries(value)) collect(item, content || CONTENT_KEYS.has(key));
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
  let usage: TranscriptMetrics["usage"] = null;
  let modelUsage: TranscriptMetrics["model_usage"] = null;
  let hookEvents = 0;
  let hookChars = 0;
  const messageIds = new Set<string>();
  const toolUses = new Map<string, string>(); // tool_use id -> tool name
  const injected: string[] = [];

  for (const event of events) {
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
    } else if (event.type === "assistant" && isObj(event.message)) {
      const id = asString(event.message.id);
      if (id !== null) messageIds.add(id);
      const content = Array.isArray(event.message.content) ? event.message.content : [];
      for (const block of content) {
        if (!isObj(block) || block.type !== "tool_use") continue;
        const useId = asString(block.id) ?? `anonymous:${toolUses.size}`;
        if (!toolUses.has(useId)) toolUses.set(useId, asString(block.name) ?? "(unknown)");
      }
    } else if (event.type === "result") {
      result = {
        subtype: asString(event.subtype),
        is_error: typeof event.is_error === "boolean" ? event.is_error : null,
        num_turns: asNumber(event.num_turns),
      };
      const reported = event.usage;
      usage = isObj(reported)
        ? {
            input: asNumber(reported.input_tokens) ?? 0,
            cache_creation: asNumber(reported.cache_creation_input_tokens) ?? 0,
            cache_read: asNumber(reported.cache_read_input_tokens) ?? 0,
            output: asNumber(reported.output_tokens) ?? 0,
          }
        : null;
      modelUsage = isObj(event.modelUsage) ? event.modelUsage : null;
    }
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
    usage,
    model_usage: modelUsage,
    model_calls: messageIds.size,
    tool_calls: toolUses.size,
    tool_histogram: histogram,
    investigation_tool_calls: names.filter((name) => INVESTIGATION_TOOLS.includes(name)).length,
    hunch_tool_calls: names.filter((name) => name.startsWith(HUNCH_TOOL_PREFIX)).length,
    hunch_dynamic_chars: { tool_results: toolResultChars, hooks: hookChars },
    hook_events: hookEvents,
    delivered_record_ids: [...delivered].sort(),
  };
}
