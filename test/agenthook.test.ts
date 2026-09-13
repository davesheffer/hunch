import { test } from "node:test";
import assert from "node:assert/strict";
import { contextHookOutput, denyHookOutput, normalizeHookEvent, stopHookOutput } from "../src/core/agenthook.js";

test("normalizes VS Code's camelCase file edit payload", () => {
  const event = normalizeHookEvent({
    hook_event_name: "PreToolUse",
    session_id: "vs-session",
    tool_name: "replace_string_in_file",
    tool_input: { filePath: "/repo/src/a.ts", newString: "new implementation" },
  }, "vscode");
  assert.deepEqual(event, {
    hook_event_name: "PreToolUse",
    session_id: "vs-session",
    tool_name: "Edit",
    tool_input: { file_path: "/repo/src/a.ts", new_string: "new implementation", content: undefined, edits: undefined, command: undefined, skill: undefined },
    prompt: undefined,
    source: undefined,
    agent_type: undefined,
  });
});

test("normalizes session-lifecycle events: SubagentStart agent type, PreCompact, SessionStart compact source", () => {
  const sub = normalizeHookEvent({ hook_event_name: "SubagentStart", session_id: "s1", agent_type: "Explore" }, "claude");
  assert.equal(sub?.hook_event_name, "SubagentStart");
  assert.equal(sub?.agent_type, "Explore");
  const subCamel = normalizeHookEvent({ hook_event_name: "SubagentStart", session_id: "s1", subagentType: "Plan" }, "claude");
  assert.equal(subCamel?.agent_type, "Plan");

  const compact = normalizeHookEvent({ hook_event_name: "PreCompact", session_id: "s1" }, "claude");
  assert.equal(compact?.hook_event_name, "PreCompact");

  const resumed = normalizeHookEvent({ hook_event_name: "SessionStart", session_id: "s1", source: "compact" }, "claude");
  assert.equal(resumed?.hook_event_name, "SessionStart");
  assert.equal(resumed?.source, "compact");
});

test("normalizes successful and failed tool outcomes without persisting raw provider shape", () => {
  const success = normalizeHookEvent({
    hook_event_name: "PostToolUse",
    session_id: "s1",
    tool_name: "Bash",
    tool_input: { command: "npm test" },
    tool_response: { stdout: "Test Files 1 passed", stderr: "", interrupted: false },
  }, "claude");
  assert.deepEqual(success?.tool_outcome, { status: "success", output: "Test Files 1 passed" });

  const failure = normalizeHookEvent({
    hook_event_name: "PostToolUseFailure",
    session_id: "s1",
    tool_name: "Bash",
    tool_input: { command: "npm test" },
    error: "Command exited with non-zero status code 1",
  }, "claude");
  assert.deepEqual(failure?.tool_outcome, { status: "failure", output: "Command exited with non-zero status code 1" });
});

test("normalizes Cursor's lower-camel hook event and snake payload", () => {
  const event = normalizeHookEvent({
    hook_event_name: "preToolUse",
    conversation_id: "cursor-conversation",
    tool_name: "Write",
    tool_input: { file_path: "/repo/src/new.ts", content: "export {};" },
  }, "cursor");
  assert.equal(event?.hook_event_name, "PreToolUse");
  assert.equal(event?.session_id, "cursor-conversation");
  assert.equal(event?.tool_name, "Write");
  assert.equal(event?.tool_input?.file_path, "/repo/src/new.ts");
});

test("normalizes Windsurf lifecycle names and tool_info", () => {
  const event = normalizeHookEvent({
    event: "pre_write_code",
    trajectory_id: "wind-session",
    agent_action_name: "write_code",
    tool_info: { file_path: "/repo/src/a.ts", content: "next" },
  }, "windsurf");
  assert.equal(event?.hook_event_name, "PreToolUse");
  assert.equal(event?.session_id, "wind-session");
  assert.equal(event?.tool_name, "Edit");
  assert.equal(event?.tool_input?.content, "next");
});

test("normalizes Antigravity toolCall and PreInvocation safely", () => {
  const edit = normalizeHookEvent({
    conversationId: "ag-conversation",
    toolCall: {
      name: "replace_file_content",
      args: { TargetFile: "/repo/src/a.ts", ReplacementContent: "next" },
    },
  }, "antigravity");
  assert.equal(edit?.hook_event_name, "PreToolUse");
  assert.equal(edit?.session_id, "ag-conversation");
  assert.equal(edit?.tool_name, "Edit");
  assert.equal(edit?.tool_input?.file_path, "/repo/src/a.ts");
  assert.equal(edit?.tool_input?.new_string, "next");

  const orient = normalizeHookEvent({ conversationId: "ag-conversation", invocationNum: 0 }, "antigravity");
  assert.equal(orient?.hook_event_name, "SessionStart");
});

test("unknown hook payloads fail open", () => {
  assert.equal(normalizeHookEvent(null, "cursor"), null);
  assert.equal(normalizeHookEvent({ hook_event_name: "not-an-event" }, "claude"), null);
  assert.equal(normalizeHookEvent({ event: "post_read_code" }, "windsurf"), null);
});

test("each native dialect gets its native deny/context/stop response", () => {
  assert.deepEqual(contextHookOutput("antigravity", "SessionStart", "orient"), { injectSteps: [{ ephemeralMessage: "orient" }] });
  assert.deepEqual(contextHookOutput("windsurf", "PreToolUse", "ignored"), null);
  assert.deepEqual(denyHookOutput("antigravity", "no"), { output: { decision: "deny", reason: "no" } });
  assert.deepEqual(denyHookOutput("windsurf", "no"), { output: null, exitCode: 2, stderr: "no" });
  assert.deepEqual(denyHookOutput("cursor", "no"), { output: { permission: "deny", user_message: "no", agent_message: "no" } });
  assert.deepEqual(stopHookOutput("vscode", "verify"), { continue: false, stopReason: "verify" });
  assert.deepEqual(stopHookOutput("cursor", "verify"), { followup_message: "verify" });
  assert.deepEqual(stopHookOutput("antigravity", "verify"), { decision: "continue", reason: "verify" });
});

test("normalizes Codex hooks: apply_patch targets the first patched file, turn_id is the prompt identity, shell argv joins", () => {
  const patch = "*** Begin Patch\n*** Update File: src/app.ts\n@@\n-old\n+new\n*** End Patch\n";
  const edit = normalizeHookEvent({
    hook_event_name: "PreToolUse", session_id: "thread-1", turn_id: "turn-7", cwd: "/repo",
    tool_name: "apply_patch", tool_input: { input: patch },
  }, "codex");
  assert.equal(edit?.hook_event_name, "PreToolUse");
  assert.equal(edit?.tool_name, "Edit", "a patch with a file path is an edit for policy purposes");
  assert.equal(edit?.tool_input?.file_path, "src/app.ts");
  assert.equal(edit?.tool_input?.content, patch);
  assert.equal(edit?.prompt_id, "turn-7");
  assert.equal(edit?.cwd, "/repo");
  const shell = normalizeHookEvent({ hook_event_name: "PostToolUse", session_id: "thread-1", turn_id: "turn-7", tool_name: "local_shell", tool_input: { command: ["bash", "-lc", "npm test"] }, tool_response: { output: "ok" } }, "codex");
  assert.equal(shell?.tool_name, "Bash");
  assert.equal(shell?.tool_input?.command, "bash -lc npm test");
  assert.equal(shell?.tool_outcome?.status, "success");
  const prompt = normalizeHookEvent({ hook_event_name: "UserPromptSubmit", session_id: "thread-1", turn_id: "turn-8", prompt: "fix it" }, "codex");
  assert.equal(prompt?.prompt_id, "turn-8");
  assert.deepEqual(contextHookOutput("codex", "PreToolUse", "ctx"), { hookSpecificOutput: { hookEventName: "PreToolUse", additionalContext: "ctx" } }, "Codex reads Claude Code's stdout contract");
  assert.deepEqual(denyHookOutput("codex", "no").output, { hookSpecificOutput: { hookEventName: "PreToolUse", permissionDecision: "deny", permissionDecisionReason: "no" } });
  assert.equal(normalizeHookEvent({ hook_event_name: "PreToolUse", session_id: "t", tool_name: "apply_patch", tool_input: { input: "not a patch" } }, "codex")?.tool_input, undefined, "a non-patch input is not a file edit");
});
