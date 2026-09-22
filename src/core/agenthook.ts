/**
 * Provider hook dialects → Hunch's one internal event shape.
 *
 * Hook payloads are an integration boundary: every provider is free to rename
 * fields or tools. Keep that variability here so the policy engine receives
 * the same small, fail-open shape regardless of the assistant that emitted it.
 */
export const HOOK_PROVIDERS = ["claude", "codex", "vscode", "windsurf", "antigravity", "cursor"] as const;
export type HookProvider = (typeof HOOK_PROVIDERS)[number];

export type HunchHookEvent = "PreToolUse" | "PostToolUse" | "PostToolUseFailure" | "UserPromptSubmit" | "SessionStart" | "SubagentStart" | "PreCompact" | "Stop";

/** One file section of a Codex `apply_patch` payload. */
export interface HunchPatchFile {
  /** The path as written in the patch (may be absolute). */
  path: string;
  action: "update" | "add" | "delete";
  /** `*** Move to:` destination, when the section renames the file. */
  moved_to?: string;
  /** Only the lines this section adds (`+` prefix stripped). */
  added_lines: string[];
}

export interface HunchToolInput {
  file_path?: string;
  new_string?: string;
  content?: string;
  edits?: Array<{ new_string?: string }>;
  command?: string;
  skill?: string;
  /** Codex `apply_patch` only: every file the patch touches. `file_path` is the
   * first entry's path and `content` the raw patch, for single-file consumers. */
  patch_files?: HunchPatchFile[];
}

/** A provider-neutral observation of the tool result. Output is ephemeral: the
 * pipeline compares it with bounded expectations but never persists it. */
export interface HunchToolOutcome {
  status: "success" | "failure" | "unknown";
  output: string;
}

export interface HunchHookInput {
  hook_event_name: HunchHookEvent;
  session_id?: string;
  /** Native Claude correlation; never synthesize these from prompt text/time. */
  prompt_id?: string;
  cwd?: string;
  agent_id?: string;
  tool_name?: string;
  tool_input?: HunchToolInput;
  tool_outcome?: HunchToolOutcome;
  prompt?: string;
  /** SessionStart origin ("startup" | "resume" | "clear" | "compact") — compaction
   * summarizes away injected grounding, so "compact" resets injection dedup. */
  source?: string;
  /** SubagentStart: the delegated agent's type (e.g. "Explore", "Plan"). */
  agent_type?: string;
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

/** Parse Codex `apply_patch` text into one entry per touched file. Only `+` lines
 * inside a file section count as added: removed (`-`) and context (` `) lines are
 * text the edit takes away or leaves alone, so a content-matched gate must not read
 * them as proposed content. Paths are returned exactly as written in the patch;
 * the CLI normalizes them against the repository root. */
const PATCH_HEADER = /^\*\*\* (Update|Add|Delete) File: (.+?)\s*$/;
const PATCH_MOVE = /^\*\*\* Move to: (.+?)\s*$/;
export function parseApplyPatch(patch: string): HunchPatchFile[] {
  const files: HunchPatchFile[] = [];
  let current: HunchPatchFile | undefined;
  for (const line of patch.split(/\r?\n/)) {
    const header = PATCH_HEADER.exec(line);
    if (header) {
      current = { path: header[2]!, action: header[1]!.toLowerCase() as HunchPatchFile["action"], added_lines: [] };
      files.push(current);
      continue;
    }
    if (!current) continue;
    const move = PATCH_MOVE.exec(line);
    if (move) {
      current.moved_to = move[1]!;
      continue;
    }
    // `*** End Patch` / `*** End of File` close sections; they carry no content.
    if (line.startsWith("*** ")) continue;
    // A unified-diff style file header is not content; apply_patch has none, but
    // a model can still emit one.
    if (/^\+\+\+ (?:[ab]\/|\/dev\/null)/.test(line)) continue;
    if (line.startsWith("+")) current.added_lines.push(line.slice(1));
  }
  return files;
}

/** Codex edits files through `apply_patch`, whose input is the patch text itself
 * (`*** Update File: path`). Every touched file is listed in `patch_files` so the
 * pre-edit gate runs per file; the first path stays `file_path` and the whole patch
 * stays `content` for consumers that read the single-file shape.
 *
 * TODO(codex-exec-patch): a Codex code-mode `exec` tool call that embeds an
 * apply_patch does NOT reach this parser: `.codex/hooks.json` (integrations/
 * providers.ts) matches PreToolUse on `apply_patch` only, and `normalizeHookEvent`
 * enables patch parsing only for tool names `apply_patch`/`patch`. No captured
 * payload of such a call exists in the repo, so its shape is not guessed here;
 * capture a real hook payload before extending the matcher or this parser. */
function applyPatchInput(raw: JsonObject): HunchToolInput | undefined {
  const patch = [raw.input, raw.patch, raw.content].find((v): v is string => typeof v === "string" && /\*\*\* Begin Patch/.test(v));
  if (!patch) return undefined;
  const files = parseApplyPatch(patch);
  return files.length ? { file_path: files[0]!.path, content: patch, patch_files: files } : undefined;
}

function normalizeToolInput(value: unknown, allowPatch = false): HunchToolInput | undefined {
  const raw = obj(value);
  if (!raw) return undefined;
  // Only Codex's apply_patch tool carries patch text in a generic `input`,
  // `patch`, or `content` field. A normal Write can contain documentation or
  // examples with these markers; interpreting those as a patch would retarget
  // policy to the first file named in the prose.
  const patched = allowPatch ? applyPatchInput(raw) : undefined;
  if (patched) return patched;
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
    // Codex's shell tools carry argv arrays (["bash", "-lc", "…"]); policies read one string.
    command: stringAt(raw, "command", "commandLine", "CommandLine", "cmd")
      ?? (Array.isArray(raw.command) && raw.command.every(p => typeof p === "string") ? (raw.command as string[]).join(" ") : undefined),
    skill: stringAt(raw, "skill", "skillName", "name"),
  };
  return Object.values(out).some((v) => v !== undefined) ? out : undefined;
}

const MAX_TOOL_OUTPUT = 200_000;

function toolOutput(value: unknown): string {
  if (typeof value === "string") return value.slice(0, MAX_TOOL_OUTPUT);
  const raw = obj(value);
  if (raw) {
    const parts = ["stdout", "stderr", "output", "content", "error", "message"]
      .map((key) => raw[key])
      .flatMap((item) => typeof item === "string" && item ? [item] : []);
    if (parts.length) return parts.join("\n").slice(0, MAX_TOOL_OUTPUT);
  }
  try {
    return JSON.stringify(value ?? "").slice(0, MAX_TOOL_OUTPUT);
  } catch {
    return "";
  }
}

function explicitToolOutcome(response: unknown): HunchToolOutcome["status"] {
  const raw = obj(response);
  // A bare string carries no status. Codex sends a Bash call's raw output this
  // way, without its exit code, and a failing test run prints output as readily
  // as a passing one. Status-looking text inside it ("Exit code: 0") is output
  // the command itself can print, so it is never parsed as a status either.
  if (!raw) return "unknown";
  if (raw.success === false || raw.is_error === true || raw.isError === true || (raw.error !== undefined && raw.error !== null)) return "failure";
  const status = raw.status;
  if (typeof status === "string") {
    if (/^(?:failure|failed|error|errored)$/i.test(status.trim())) return "failure";
  }
  let explicitSuccess = raw.success === true || raw.is_error === false || raw.isError === false;
  for (const key of ["exit_code", "exitCode", "return_code", "returnCode"]) {
    const value = raw[key];
    const numeric = typeof value === "number" ? value : typeof value === "string" && /^-?\d+$/.test(value.trim()) ? Number(value) : undefined;
    if (numeric === undefined || !Number.isFinite(numeric)) continue;
    if (numeric !== 0) return "failure";
    explicitSuccess = true;
  }
  if (typeof status === "string" && /^(?:success|succeeded|ok|completed)$/i.test(status.trim())) explicitSuccess = true;
  if (explicitSuccess) return "success";
  // Common successful tool-result shapes carry output fields even when the
  // output is empty (Claude Code routes failed calls to PostToolUseFailure
  // instead). An unstructured string remains unknown (see above).
  if (["stdout", "stderr", "output", "content"].some(key => Object.prototype.hasOwnProperty.call(raw, key))) return "success";
  return "unknown";
}

function normalizeToolOutcome(input: JsonObject, event: HunchHookEvent): HunchToolOutcome | undefined {
  if (event !== "PostToolUse" && event !== "PostToolUseFailure") return undefined;
  const response = input.tool_response ?? input.toolResponse ?? input.tool_result ?? input.toolResult;
  return {
    // Claude Code splits successful and failed calls into separate lifecycle
    // events. Providers without that split may expose an explicit result flag.
    status: event === "PostToolUseFailure" ? "failure" : explicitToolOutcome(response),
    output: event === "PostToolUseFailure"
      ? toolOutput(input.error ?? response)
      : toolOutput(response),
  };
}

function eventName(value: unknown, provider: HookProvider): HunchHookEvent | undefined {
  if (typeof value !== "string") return undefined;
  const name = value.toLowerCase();
  const map: Record<string, HunchHookEvent> = {
    pretooluse: "PreToolUse",
    posttooluse: "PostToolUse",
    posttoolusefailure: "PostToolUseFailure",
    userpromptsubmit: "UserPromptSubmit",
    sessionstart: "SessionStart",
    subagentstart: "SubagentStart",
    precompact: "PreCompact",
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
    const toolOutcome = normalizeToolOutcome(input, event);
    return {
      hook_event_name: event,
      session_id: stringAt(input, "trajectory_id", "session_id", "sessionId"),
      tool_name: hunchToolName(stringAt(input, "agent_action_name", "tool_name", "toolName"), toolInput ?? {}),
      tool_input: toolInput,
      ...(toolOutcome ? { tool_outcome: toolOutcome } : {}),
      prompt: stringAt(input, "prompt", "user_prompt", "userPrompt"),
    };
  }

  const event = eventName(input.hook_event_name ?? input.hookEventName ?? input.event, provider);
  if (!event) return null;
  const rawToolName = stringAt(input, "tool_name", "toolName");
  const toolInput = normalizeToolInput(input.tool_input ?? input.toolInput,
    provider === "codex" && /^(?:apply_patch|patch)$/i.test(rawToolName ?? ""));
  const toolOutcome = normalizeToolOutcome(input, event);
  return {
    hook_event_name: event,
    session_id: stringAt(input, "session_id", "sessionId", "conversation_id", "conversationId"),
    // Codex delivers the same lifecycle payload with `turn_id` where Claude Code
    // says `prompt_id`; both are native per-prompt identities, never synthesized.
    ...(provider === "codex" && input.prompt_id === undefined && input.turn_id !== undefined ? { prompt_id: typeof input.turn_id === "string" ? input.turn_id : "" } : {}),
    ...(provider === "claude" || provider === "codex" ? Object.fromEntries(["prompt_id", "cwd", "agent_id"].filter(key => input[key] !== undefined).map(key => [key, typeof input[key] === "string" ? input[key] : ""])) : {}),
    tool_name: hunchToolName(rawToolName, toolInput ?? {}),
    tool_input: toolInput,
    ...(toolOutcome ? { tool_outcome: toolOutcome } : {}),
    prompt: stringAt(input, "prompt", "user_prompt", "userPrompt"),
    source: stringAt(input, "source"),
    agent_type: stringAt(input, "agent_type", "agentType", "subagent_type", "subagentType"),
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
