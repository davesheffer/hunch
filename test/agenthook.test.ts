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
  });
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
