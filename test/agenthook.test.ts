import { test } from "node:test";
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { contextHookOutput, denyHookOutput, normalizeHookEvent, parseApplyPatch, stopHookOutput } from "../src/core/agenthook.js";
import { hunchPaths } from "../src/core/paths.js";
import { armExecutionObligations, emptyState, loadPipelineState, onCommand, onEdit, pendingExecutionObligations } from "../src/core/pipeline.js";
import type { Constraint } from "../src/core/types.js";
import { HunchStore } from "../src/store/hunchStore.js";
import { mkConstraint, tsxLoaderUrl } from "./helpers.js";

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

  const codexFailure = normalizeHookEvent({
    hook_event_name: "PostToolUse",
    session_id: "s1",
    tool_name: "Bash",
    tool_input: { command: "sh -c 'exit 7'" },
    tool_response: { exit_code: 7, output: "" },
  }, "codex");
  assert.equal(codexFailure?.tool_outcome?.status, "failure", "an explicit nonzero result in PostToolUse is failure evidence");

  const contradictory = normalizeHookEvent({
    hook_event_name: "PostToolUse",
    session_id: "s1",
    tool_name: "Bash",
    tool_response: { success: true, exit_code: 7 },
  }, "codex");
  assert.equal(contradictory?.tool_outcome?.status, "failure", "a nonzero result outranks a contradictory success flag");

  const nonfinite = normalizeHookEvent({
    hook_event_name: "PostToolUse",
    session_id: "s1",
    tool_name: "Bash",
    tool_response: { exit_code: Number.POSITIVE_INFINITY },
  }, "codex");
  assert.equal(nonfinite?.tool_outcome?.status, "unknown", "nonfinite result codes are not failure evidence");

  const httpResponse = normalizeHookEvent({
    hook_event_name: "PostToolUse",
    session_id: "s1",
    tool_name: "Bash",
    tool_response: { status_code: 200, code: 200 },
  }, "codex");
  assert.equal(httpResponse?.tool_outcome?.status, "unknown", "generic status fields are not process exit evidence");

  const codexUnknown = normalizeHookEvent({
    hook_event_name: "PostToolUse",
    session_id: "s1",
    tool_name: "Bash",
    tool_input: { command: "sh -c 'exit 7'" },
    tool_response: "",
  }, "codex");
  assert.equal(codexUnknown?.tool_outcome?.status, "unknown", "an empty PostToolUse result cannot prove failure or success");
});

test("a Codex command's plain-string output is not success evidence", () => {
  // Codex sends a Bash call's PostToolUse `tool_response` as the command's raw
  // output string; the exit code is not part of it. A failing test run prints
  // output too, so text alone must not satisfy an expected-success obligation.
  const failingRun = normalizeHookEvent({
    hook_event_name: "PostToolUse", session_id: "thread-1", turn_id: "turn-1",
    tool_name: "Bash", tool_input: { command: "npx vitest run src/preprocess.test.ts" },
    tool_response: "FAIL src/preprocess.test.ts\nTest Files 1 failed | 3 passed\n",
  }, "codex");
  assert.equal(failingRun?.tool_outcome?.status, "unknown");
  assert.match(failingRun?.tool_outcome?.output ?? "", /1 failed/, "the output is still kept for marker matching");
  // Text that merely looks like an exit status is printed output, not a status.
  for (const spoof of ["Process exited with code 0\nOutput:\nok", "Exit code: 0\nok"]) {
    assert.equal(normalizeHookEvent({ hook_event_name: "PostToolUse", session_id: "t", tool_name: "Bash", tool_response: spoof }, "codex")?.tool_outcome?.status, "unknown", spoof);
  }

  let state = onEdit(armExecutionObligations(emptyState(), [{
    id: "episode:runtime:preprocess", origin: "episode", category: "behavior", phase: "after-edit",
    description: "Exercise preprocess behavior after the latest edit.",
    command_alternatives: [["vitest", "preprocess.test.ts"]],
    expected: { success: true, output_includes: ["passed"] },
  }]), "src/preprocess.ts");
  state = onCommand(state, failingRun!.tool_input!.command!, failingRun!.tool_outcome);
  assert.equal(pendingExecutionObligations(state).length, 1, "an unobserved result cannot discharge an expected-success obligation");
  assert.equal(state.obligations[0]?.last_attempt?.outcome, "unknown");
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

test("does not retarget a normal write whose content contains patch markers", () => {
  const write = normalizeHookEvent({
    hook_event_name: "PreToolUse",
    tool_name: "Write",
    tool_input: {
      file_path: "src/actual.md",
      content: "Example patch syntax:\n*** Begin Patch\n*** Update File: src/other.ts\n*** End Patch\n",
    },
  }, "claude");
  assert.equal(write?.tool_name, "Write");
  assert.equal(write?.tool_input?.file_path, "src/actual.md");
});

test("Codex apply_patch lists every touched file with only its added lines", () => {
  const patch = [
    "*** Begin Patch",
    "*** Update File: src/other.ts",
    "@@ function a",
    " context eval(kept)",
    "-removed eval(old)",
    "+added one",
    "*** Add File: src/new.ts",
    "+export const x = 1;",
    "++counter;",
    "*** Delete File: src/gone.ts",
    "*** Update File: src/old/name.ts",
    "*** Move to: src/billing/name.ts",
    "@@",
    "-a",
    "+b",
    "*** End of File",
    "*** End Patch",
  ].join("\r\n");
  const edit = normalizeHookEvent({ hook_event_name: "PreToolUse", session_id: "t", tool_name: "apply_patch", tool_input: { input: patch } }, "codex");
  assert.equal(edit?.tool_input?.file_path, "src/other.ts", "the first path stays the single-file target");
  assert.equal(edit?.tool_input?.content, patch);
  assert.deepEqual(edit?.tool_input?.patch_files, [
    { path: "src/other.ts", action: "update", added_lines: ["added one"] },
    { path: "src/new.ts", action: "add", added_lines: ["export const x = 1;", "+counter;"] },
    { path: "src/gone.ts", action: "delete", added_lines: [] },
    { path: "src/old/name.ts", action: "update", moved_to: "src/billing/name.ts", added_lines: ["b"] },
  ]);
  assert.equal(parseApplyPatch("*** Begin Patch\n*** Update File: C:\\repo\\src\\a.ts\n@@\n+x\n*** End Patch\n")[0]?.path, "C:\\repo\\src\\a.ts", "paths are kept as written; the CLI normalizes them");
  const claude = normalizeHookEvent({ hook_event_name: "PreToolUse", tool_name: "Edit", tool_input: { file_path: "src/a.ts", new_string: "x" } }, "claude");
  assert.equal(claude?.tool_input?.patch_files, undefined, "other providers never carry patch_files");
});

// ---- end-to-end: the real `hunch hook --provider codex` against a temp repo ----
const hookCli = resolve("src/cli/index.ts");
function patchRepo(t: { after: (f: () => void) => void }, constraints: Constraint[], firmness = "strict"): string {
  const root = mkdtempSync(join(tmpdir(), "hunch-codex-patch-"));
  t.after(() => rmSync(root, { recursive: true, force: true }));
  execFileSync("git", ["init", "-q", root]);
  mkdirSync(join(root, ".hunch"));
  writeFileSync(join(root, ".gitignore"), ".hunch-cache/\n");
  writeFileSync(join(root, ".hunch", "config.json"), JSON.stringify({ firmness }));
  mkdirSync(join(root, "src", "billing"), { recursive: true });
  writeFileSync(join(root, "src", "other.ts"), "export const other = 1;\n");
  writeFileSync(join(root, "src", "billing", "charge.ts"), "export const charge = 1;\n");
  const store = new HunchStore(hunchPaths(root));
  store.json.ensureDirs();
  for (const c of constraints) store.json.put("constraints", c);
  store.reindex(); store.close();
  return root;
}
function codexHook(root: string, payload: Record<string, unknown>, env: Record<string, string> = { HUNCH_PIPELINE: "0" }) {
  const output = execFileSync(process.execPath, ["--import", tsxLoaderUrl(), hookCli, "hook", "--provider", "codex"], {
    cwd: root, env: { ...process.env, ...env },
    input: JSON.stringify({ cwd: root, session_id: "codex-session", turn_id: "turn-1", ...payload }), encoding: "utf8",
  }).trim();
  return output ? JSON.parse(output) : null;
}
const patchOf = (...lines: string[]) => ["*** Begin Patch", ...lines, "*** End Patch", ""].join("\n");
const preEdit = (root: string, patch: string) => codexHook(root, { hook_event_name: "PreToolUse", tool_name: "apply_patch", tool_input: { input: patch } });
const denialOf = (out: { hookSpecificOutput?: { permissionDecision?: string; permissionDecisionReason?: string } } | null): string | null =>
  out?.hookSpecificOutput?.permissionDecision === "deny" ? out.hookSpecificOutput.permissionDecisionReason ?? "" : null;

test("strict gate denies a multi-file patch when a later file hits a blocking invariant, naming that file", { timeout: 120_000 }, t => {
  const root = patchRepo(t, [mkConstraint({ id: "con_billing_guard", statement: "Billing is frozen", scope: ["src/billing/**"], severity: "blocking" })]);
  const reason = denialOf(preEdit(root, patchOf(
    "*** Update File: src/other.ts", "@@", "-export const other = 1;", "+export const other = 2;",
    "*** Update File: src/billing/charge.ts", "@@", "-export const charge = 1;", "+export const charge = 2;",
  )));
  assert.ok(reason, "the second file is gated, not only the first");
  assert.match(reason, /src\/billing\/charge\.ts/);
  assert.match(reason, /con_billing_guard/);
  assert.doesNotMatch(reason, /src\/other\.ts/, "a clean file is not named as denied");
  assert.equal(denialOf(preEdit(root, patchOf("*** Update File: src/other.ts", "@@", "-export const other = 1;", "+export const other = 2;"))), null);
});

test("strict gate evaluates a Move-to destination inside a guarded scope", { timeout: 120_000 }, t => {
  const root = patchRepo(t, [mkConstraint({ id: "con_billing_guard", statement: "Billing is frozen", scope: ["src/billing/**"], severity: "blocking" })]);
  const reason = denialOf(preEdit(root, patchOf("*** Update File: src/other.ts", "*** Move to: src/billing/other.ts", "@@", "-export const other = 1;", "+export const other = 3;")));
  assert.ok(reason, "moving a file into a guarded scope is an edit there");
  assert.match(reason, /src\/billing\/other\.ts/);
});

test("content-matched gate reads only added patch lines: removing a forbidden pattern is allowed, adding it is denied", { timeout: 120_000 }, t => {
  const root = patchRepo(t, [mkConstraint({ id: "con_no_eval", statement: "Never call eval", scope: ["src/**"], severity: "blocking", match: "\\beval\\(" })]);
  assert.equal(denialOf(preEdit(root, patchOf("*** Update File: src/other.ts", "@@", " const keep = eval(context);", "-export const other = eval('1');", "+export const other = 1;"))), null,
    "a patch that removes the pattern (and only keeps it as context) is allowed, as the same Edit would be");
  const reason = denialOf(preEdit(root, patchOf("*** Update File: src/other.ts", "@@", "-export const other = 1;", "+export const other = eval('1');")));
  assert.ok(reason, "a patch that adds the pattern is denied");
  assert.match(reason, /con_no_eval/);
  const both = denialOf(preEdit(root, patchOf(
    "*** Update File: src/other.ts", "@@", "+export const a = eval('1');",
    "*** Add File: src/billing/extra.ts", "+export const b = eval('2');",
  )));
  assert.ok(both);
  assert.match(both, /denied for 2 files \(src\/other\.ts, src\/billing\/extra\.ts\)/, "several denied files are all named");
});

test("absolute patch paths are normalized to repo-relative paths; paths outside the repo are skipped", { timeout: 120_000 }, t => {
  const root = patchRepo(t, [mkConstraint({ id: "con_billing_guard", statement: "Billing is frozen", scope: ["src/billing/**"], severity: "blocking" })]);
  const outside = mkdtempSync(join(tmpdir(), "hunch-codex-outside-"));
  t.after(() => rmSync(outside, { recursive: true, force: true }));
  // join() yields backslash paths on Windows (the shape Codex sends there) and POSIX paths elsewhere.
  const absolutes = [join(root, "src", "billing", "charge.ts")];
  if (process.platform === "win32") absolutes.push(join(root, "src", "billing", "charge.ts").replace(/\\/g, "/"));
  for (const abs of absolutes) {
    const reason = denialOf(preEdit(root, patchOf(`*** Update File: ${join(outside, "x.ts")}`, "@@", "+x", `*** Update File: ${abs}`, "@@", "+y")));
    assert.ok(reason, `absolute path ${abs} is gated`);
    assert.match(reason, /editing src\/billing\/charge\.ts would touch/);
  }
  assert.equal(preEdit(root, patchOf(`*** Update File: ${join(outside, "x.ts")}`, "@@", "+x")), null, "a patch touching only outside files says nothing");
});

test("PostToolUse records every file an apply_patch touched for the Stop gate", { timeout: 120_000 }, t => {
  const root = patchRepo(t, [], "advisory");
  const session = `codex-post-${process.pid}-${Date.now()}`;
  codexHook(root, {
    hook_event_name: "PostToolUse", session_id: session, tool_name: "apply_patch",
    tool_input: { input: patchOf(
      "*** Update File: src/other.ts", "@@", "+a",
      `*** Update File: ${join(root, "src", "billing", "charge.ts")}`, "@@", "+b",
      "*** Update File: src/old.ts", "*** Move to: src/renamed.ts", "@@", "+c",
    ) },
    tool_response: { output: "Success" },
  }, { HUNCH_PIPELINE: "1" });
  const state = loadPipelineState(session);
  assert.deepEqual([...state.editedFiles].sort(), ["src/billing/charge.ts", "src/old.ts", "src/other.ts", "src/renamed.ts"]);
});

test("PostToolUse skips files outside the repository — a scratch edit is not a product edit (#305)", { timeout: 120_000 }, t => {
  const root = patchRepo(t, [], "advisory");
  const outside = mkdtempSync(join(tmpdir(), "hunch-codex-scratch-"));
  t.after(() => rmSync(outside, { recursive: true, force: true }));
  const session = `codex-post-outside-${process.pid}-${Date.now()}`;
  codexHook(root, {
    hook_event_name: "PostToolUse", session_id: session, tool_name: "apply_patch",
    tool_input: { input: patchOf(
      `*** Update File: ${join(outside, "probe.mts")}`, "@@", "+a",
      "*** Update File: src/other.ts", "@@", "+b",
    ) },
    tool_response: { output: "Success" },
  }, { HUNCH_PIPELINE: "1" });
  assert.deepEqual([...loadPipelineState(session).editedFiles], ["src/other.ts"], "only the in-repo file is recorded for the Stop gate");
});
