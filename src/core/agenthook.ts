/**
 * Provider hook dialects → Hunch's one internal event shape.
 *
 * Hook payloads are an integration boundary: every provider is free to rename
 * fields or tools. Keep that variability here so the policy engine receives
 * the same small, fail-open shape regardless of the assistant that emitted it.
 */
export const HOOK_PROVIDERS = ["claude", "vscode", "windsurf", "antigravity", "cursor"] as const;
export type HookProvider = (typeof HOOK_PROVIDERS)[number];

export type HunchHookEvent = "PreToolUse" | "PostToolUse" | "UserPromptSubmit" | "SessionStart" | "Stop";

export interface HunchToolInput {
  file_path?: string;
  new_string?: string;
  content?: string;
  edits?: Array<{ new_string?: string }>;
  command?: string;
  skill?: string;
}

export interface HunchHookInput {
  hook_event_name: HunchHookEvent;
  session_id?: string;
  tool_name?: string;
  tool_input?: HunchToolInput;
  prompt?: string;
}

type JsonObject = Record<string, unknown>;

function obj(value: unknown): JsonObject | null {
  return value && typeof value === "object" && !Array.isArray(value) ? value as JsonObject : null;
}

function str(value: unknown): string | undefined {
  return typeof value === "string" && value.trim() ? value : undefined;
}

function stringAt(input: JsonObject, ...keys: string[]): string | undefined {
  for (const key of keys) {
    const value = str(input[key]);
    if (value) return value;
  }
  return undefined;
}

function hunchToolName(name: string | undefined, input: HunchToolInput): string | undefined {
  if (!name) return undefined;
  const lower = name.toLowerCase();
  if (/multi.*(edit|replace)|edit.*files|multi_replace/.test(lower)) return "MultiEdit";
  if (/^(edit|strreplace|replace_string_in_file|replace_file_content)$/.test(lower) || /replace.*(string|content)/.test(lower)) return "Edit";
  if (/^(write|create|create_file|write_to_file)$/.test(lower) || /write.*file/.test(lower)) return "Write";
  if (/(shell|bash|terminal|run_command|run.*command|powershell)/.test(lower)) return "Bash";
  if (/skill/.test(lower)) return "Skill";
  // A provider can call an edit tool something new. A file path plus proposed
  // content is enough to safely treat it as a write for policy purposes.
  if (input.file_path && (input.new_string || input.content || input.edits?.length)) return "Edit";
  return name;
}

function edits(value: unknown): Array<{ new_string?: string }> | undefined {
  if (!Array.isArray(value)) return undefined;
  const normalized = value
    .map((item) => obj(item))
    .filter((item): item is JsonObject => !!item)
    .map((item) => ({ new_string: stringAt(item, "new_string", "newString", "ReplacementContent", "replacementContent") }));
  return normalized.length ? normalized : undefined;
}

function normalizeToolInput(value: unknown): HunchToolInput | undefined {
  const raw = obj(value);
  if (!raw) return undefined;
  const replacementChunks = Array.isArray(raw.ReplacementChunks) ? raw.ReplacementChunks : raw.replacementChunks;
  const chunkEdits = Array.isArray(replacementChunks)
    ? replacementChunks.map((chunk) => obj(chunk)).filter((chunk): chunk is JsonObject => !!chunk)
      .map((chunk) => ({ new_string: stringAt(chunk, "ReplacementContent", "replacementContent", "new_string", "newString") }))
    : undefined;
  const out: HunchToolInput = {
    file_path: stringAt(raw, "file_path", "filePath", "path", "uri", "TargetFile", "targetFile", "AbsolutePath", "absolutePath"),
    new_string: stringAt(raw, "new_string", "newString", "ReplacementContent", "replacementContent", "TargetContent", "targetContent"),
    content: stringAt(raw, "content", "contents", "CodeContent", "codeContent"),
    edits: edits(raw.edits) ?? edits(raw.files) ?? chunkEdits,
    command: stringAt(raw, "command", "commandLine", "CommandLine", "cmd"),
    skill: stringAt(raw, "skill", "skillName", "name"),
  };
  return Object.values(out).some((v) => v !== undefined) ? out : undefined;
}

function eventName(value: unknown, provider: HookProvider): HunchHookEvent | undefined {
  if (typeof value !== "string") return undefined;
  const name = value.toLowerCase();
  const map: Record<string, HunchHookEvent> = {
    pretooluse: "PreToolUse",
    posttooluse: "PostToolUse",
    userpromptsubmit: "UserPromptSubmit",
    sessionstart: "SessionStart",
    stop: "Stop",
  };
  if (map[name]) return map[name];
  if (provider === "cursor") {
    if (name === "beforesubmitprompt") return "UserPromptSubmit";
    if (name === "beforetoolexecution" || name === "beforefileedit" || name === "beforeshellexecution") return "PreToolUse";
    if (name === "afterfileedit" || name === "aftershellexecution") return "PostToolUse";
  }
  if (provider === "windsurf") {
    if (name === "pre_write_code" || name === "pre_run_command") return "PreToolUse";
    if (name === "post_write_code" || name === "post_run_command") return "PostToolUse";
    if (name === "pre_user_prompt") return "UserPromptSubmit";
  }
  // Antigravity's PreInvocation is the lifecycle point which can inject a
  // transient message before the model sees the turn. Internally it provides
  // Hunch's session-orientation behavior.
  if (provider === "antigravity" && name === "preinvocation") return "SessionStart";
  return undefined;
}

/** Parse a provider name supplied by a hook config. Unknown values intentionally
 * return null so a bad config cannot make an edit fail. */
export function hookProvider(value: unknown): HookProvider | null {
  return typeof value === "string" && (HOOK_PROVIDERS as readonly string[]).includes(value.toLowerCase())
    ? value.toLowerCase() as HookProvider
    : null;
}

/** Normalize a hook stdin payload. Unknown/malformed events return null and the
 * CLI exits successfully without output — the Never Block on Hook Failure rule. */
export function normalizeHookEvent(raw: unknown, provider: HookProvider): HunchHookInput | null {
  const input = obj(raw);
  if (!input) return null;

  if (provider === "antigravity") {
    const agEvent = input.toolCall ? "PreToolUse" : input.invocationNum !== undefined ? "PreInvocation" : input.executionNum !== undefined ? "Stop" : undefined;
    const event = eventName(agEvent, provider);
    if (!event) return null;
    const call = obj(input.toolCall);
    const toolInput = normalizeToolInput(call?.args);
    return {
      hook_event_name: event,
      session_id: stringAt(input, "conversationId"),
      tool_name: hunchToolName(stringAt(call ?? {}, "name"), toolInput ?? {}),
      tool_input: toolInput,
    };
  }

  if (provider === "windsurf") {
    const event = eventName(input.event ?? input.hook_event_name, provider);
    if (!event) return null;
    const info = obj(input.tool_info) ?? obj(input.toolInput) ?? obj(input.tool_input);
    const toolInput = normalizeToolInput(info);
    return {
      hook_event_name: event,
      session_id: stringAt(input, "trajectory_id", "session_id", "sessionId"),
      tool_name: hunchToolName(stringAt(input, "agent_action_name", "tool_name", "toolName"), toolInput ?? {}),
      tool_input: toolInput,
      prompt: stringAt(input, "prompt", "user_prompt", "userPrompt"),
    };
  }

  const event = eventName(input.hook_event_name ?? input.hookEventName ?? input.event, provider);
  if (!event) return null;
  const toolInput = normalizeToolInput(input.tool_input ?? input.toolInput);
  return {
    hook_event_name: event,
    session_id: stringAt(input, "session_id", "sessionId", "conversation_id", "conversationId"),
    tool_name: hunchToolName(stringAt(input, "tool_name", "toolName"), toolInput ?? {}),
    tool_input: toolInput,
    prompt: stringAt(input, "prompt", "user_prompt", "userPrompt"),
  };
}

/** Provider-aware hook output. Context output is intentionally omitted for
 * Windsurf because its documented hook protocol has no agent-context channel;
 * its always-on project rule + MCP server remain the grounding delivery path. */
export function contextHookOutput(provider: HookProvider, event: HunchHookEvent, text: string): object | null {
  if (provider === "windsurf") return null;
  if (provider === "antigravity") {
    return event === "SessionStart" ? { injectSteps: [{ ephemeralMessage: text }] } : { decision: "allow" };
  }
  if (provider === "cursor") return { permission: "allow", agent_message: text };
  return { hookSpecificOutput: { hookEventName: event, additionalContext: text } };
}

/** Strict-deny response in each native dialect. Windsurf uses documented exit
 * code 2; the caller writes this error to stderr and preserves exit success for
 * every accidental/malformed invocation. */
export function denyHookOutput(provider: HookProvider, reason: string): { output: object | null; exitCode?: number; stderr?: string } {
  if (provider === "windsurf") return { output: null, exitCode: 2, stderr: reason };
  if (provider === "antigravity") return { output: { decision: "deny", reason } };
  if (provider === "cursor") return { output: { permission: "deny", user_message: reason, agent_message: reason } };
  return {
    output: { hookSpecificOutput: { hookEventName: "PreToolUse", permissionDecision: "deny", permissionDecisionReason: reason } },
  };
}

/** Stop-gate output in each native dialect. */
export function stopHookOutput(provider: HookProvider, reason: string): object {
  if (provider === "vscode") return { continue: false, stopReason: reason };
  if (provider === "cursor") return { followup_message: reason };
  if (provider === "antigravity") return { decision: "continue", reason };
  return { decision: "block", reason };
}
