import { test } from "node:test";
import assert from "node:assert/strict";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { hookInjection, parseTranscript, transcriptCost } from "../src/benchmark/transcript.js";
import {
  buildClaudeArgv, isForbiddenChildEnvKey, preflight, runAgent, sanitizedArgvHash, strippedChildEnv,
} from "../src/benchmark/taskRunner.js";
import type { RunnerConfig } from "../src/benchmark/types.js";

const HTASK = "htask_0123456789abcdef01234567";
const line = (value: unknown) => JSON.stringify(value);
const tempDir = () => mkdtempSync(join(tmpdir(), "hunch-task-benchmark-runner-"));
const claudeCfg = (effort: string | null = null): RunnerConfig => ({
  schema: "hunch.benchmark-runner/1", provider: "claude", executable: "claude", model: "claude-opus-5-5", effort,
});
const fixtureCfg = (script: string): RunnerConfig => ({
  schema: "hunch.benchmark-runner/1", provider: "fixture", executable: script, model: "fixture-model", effort: null,
});

test("parseTranscript counts distinct calls and only Hunch-injected text", () => {
  const hunchText = `hunch says fnd_aaaaaaaaaa and ${HTASK}`;
  const transcript = [
    line({ type: "system", subtype: "init", model: "claude-opus-5-5[1m]", apiKeySource: "none",
      mcp_servers: [{ name: "hunch", status: "connected" }], tools: ["Read", "Grep", "mcp__hunch__hunch_context"],
      memory_paths: { auto: "/home/x/.claude/projects/-repo/memory/MEMORY.md" } }),
    line({ type: "system", subtype: "hook_started", hook_event: "SessionStart" }),
    line({ type: "system", subtype: "hook_response", hook_event: "SessionStart", exit_code: 0, outcome: "success", stderr: "",
      stdout: line({ hookSpecificOutput: { hookEventName: "SessionStart", additionalContext: "ctx dec_0123456789" }, systemMessage: "sys", reason: 5 }) + "\n" }),
    line({ type: "system", subtype: "hook_response", hook_event: "UserPromptSubmit", stdout: "  plain con_abcdef0123 \n" }),
    "",
    "{not json",
    line({ type: "assistant", message: { id: "msg_1", content: [{ type: "text", text: "looking" }] }, parent_tool_use_id: null }),
    line({ type: "assistant", message: { id: "msg_1", content: [{ type: "tool_use", id: "toolu_1", name: "Read", input: {} }] } }),
    line({ type: "assistant", message: { id: "msg_2", content: [
      { type: "tool_use", id: "toolu_2", name: "mcp__hunch__hunch_context", input: {} },
      { type: "tool_use", id: "toolu_3", name: "Grep", input: {} },
    ] } }),
    line({ type: "assistant", message: { id: "msg_2", content: [{ type: "tool_use", id: "toolu_2", name: "mcp__hunch__hunch_context", input: {} }] } }),
    line({ type: "user", message: { content: [{ type: "tool_result", tool_use_id: "toolu_1", content: "file mentions dec_ffffffffff" }] } }),
    line({ type: "user", message: { content: [{ type: "tool_result", tool_use_id: "toolu_2",
      content: [{ type: "text", text: hunchText }, { type: "image", source: {} }] }] } }),
    line({ type: "assistant", message: { id: "msg_3", content: [{ type: "tool_use", id: "toolu_4", name: "Glob", input: {} }] } }),
  ].join("\n");

  const metrics = parseTranscript(transcript);
  assert.deepEqual(metrics.init, {
    model: "claude-opus-5-5[1m]", api_key_source: "none", mcp_servers: ["hunch"], mcp_server_status: { hunch: "connected" },
    tool_names: ["Read", "Grep", "mcp__hunch__hunch_context"],
    memory_paths_auto: "/home/x/.claude/projects/-repo/memory/MEMORY.md", skills: null,
  });
  assert.equal(metrics.result, null);
  assert.equal(metrics.usage, null);
  assert.equal(metrics.model_usage, null);
  assert.equal(metrics.model_calls, 3);
  assert.equal(metrics.tool_calls, 4);
  assert.deepEqual(metrics.tool_histogram, { Read: 1, mcp__hunch__hunch_context: 1, Grep: 1, Glob: 1 });
  assert.equal(metrics.investigation_tool_calls, 3);
  assert.equal(metrics.hunch_tool_calls, 1);
  assert.equal(metrics.hook_events, 2);
  assert.deepEqual(metrics.hunch_dynamic_chars, {
    tool_results: hunchText.length,
    hooks: "ctx dec_0123456789".length + "sys".length + "plain con_abcdef0123".length,
  });
  assert.deepEqual(metrics.delivered_record_ids, ["con_abcdef0123", "dec_0123456789", "fnd_aaaaaaaaaa", HTASK]);
  assert.ok(!metrics.delivered_record_ids.includes("dec_ffffffffff"), "a non-Hunch Read result is not delivery");
});

test("parseTranscript maps each MCP server to its init status and skips bare-string entries", () => {
  const metrics = parseTranscript(line({ type: "system", subtype: "init", model: "m", apiKeySource: "none", tools: [],
    mcp_servers: [{ name: "hunch", status: "connected" }, { name: "other", status: "failed" }, "legacy", { name: "nostatus" }] }));
  assert.deepEqual(metrics.init?.mcp_servers, ["hunch", "other", "legacy", "nostatus"]);
  assert.deepEqual(metrics.init?.mcp_server_status, { hunch: "connected", other: "failed" });

  const none = parseTranscript(line({ type: "system", subtype: "init", model: "m", apiKeySource: "none", tools: [] }));
  assert.deepEqual(none.init?.mcp_servers, []);
  assert.deepEqual(none.init?.mcp_server_status, {});
});

test("parseTranscript reads the init skills list, keeping only strings, and null when absent", () => {
  const metrics = parseTranscript(line({ type: "system", subtype: "init", model: "m", apiKeySource: "none", tools: [],
    skills: ["fable-mode", 7, "review"] }));
  assert.deepEqual(metrics.init?.skills, ["fable-mode", "review"]);
  assert.equal(parseTranscript(line({ type: "system", subtype: "init", model: "m", tools: [] })).init?.skills, null);
});

test("parseTranscript reads the result line and tolerates an empty transcript", () => {
  const modelUsage = { "claude-opus-5-5[1m]": { inputTokens: 2, outputTokens: 4 } };
  const metrics = parseTranscript(line({ type: "result", subtype: "success", is_error: false, num_turns: 3,
    usage: { input_tokens: 2, cache_creation_input_tokens: 8207, cache_read_input_tokens: 26225, output_tokens: 4 }, modelUsage }) + "\r\n");
  assert.deepEqual(metrics.result, { subtype: "success", is_error: false, num_turns: 3 });
  assert.deepEqual(metrics.usage, { input: 2, cache_creation: 8207, cache_read: 26225, output: 4 });
  assert.deepEqual(metrics.model_usage, modelUsage);
  assert.equal(metrics.init, null);

  const empty = parseTranscript("");
  assert.equal(empty.model_calls, 0);
  assert.equal(empty.tool_calls, 0);
  assert.deepEqual(empty.delivered_record_ids, []);
});

// hook_response shape from real PILOT5 transcripts: `output` carries the hook's stdout, JSON for the Hunch hook.
const hookResponse = (hook_event: string | undefined, output: string, hook_name = `${hook_event ?? "X"}:name`) =>
  line({ type: "system", subtype: "hook_response", hook_id: "h", hook_name, ...(hook_event ? { hook_event } : {}), output, stdout: output, stderr: "", exit_code: 0, outcome: "success" });
const contextOutput = (event: string, additionalContext: string, extra: Record<string, unknown> = {}) =>
  JSON.stringify({ hookSpecificOutput: { hookEventName: event, additionalContext }, ...extra });

test("parseTranscript counts injected hook additionalContext by event; Stop systemMessage, plain text and empty context never count", () => {
  const pre = "pre ctx \u{1F9E0} dec_0123456789"; // the emoji is one code point, two UTF-16 code units
  const transcript = [
    line({ type: "system", subtype: "init", session_id: "s" }),
    hookResponse("SessionStart", contextOutput("SessionStart", "session ctx")),
    hookResponse("PreToolUse", contextOutput("PreToolUse", pre, { systemMessage: "also shown" })),
    hookResponse("PreToolUse", "  " + contextOutput("PreToolUse", "second")),
    hookResponse("PostToolUse", contextOutput("PostToolUse", "post")),
    hookResponse("Stop", JSON.stringify({ systemMessage: "stop message, never counted" })),
    hookResponse("Stop", JSON.stringify({ decision: "block", reason: "not injected context" })),
    hookResponse("UserPromptSubmit", "plain text output, not JSON"),
    hookResponse("UserPromptSubmit", "{not json"),
    hookResponse("PostToolUse", contextOutput("PostToolUse", "")),
    hookResponse("PostToolUse", JSON.stringify({ hookSpecificOutput: { hookEventName: "PostToolUse" } })),
    hookResponse(undefined, contextOutput("SubagentStart", "from hookEventName")),
    hookResponse(undefined, JSON.stringify({ hookSpecificOutput: { additionalContext: "from hook_name" } }), "Notification"),
    line({ type: "system", subtype: "hook_response", hook_event: "PreToolUse" }),
  ].join("\n");
  const metrics = parseTranscript(transcript);
  assert.deepEqual(metrics.hook_injections, {
    by_event: {
      SessionStart: { injections: 1, chars: "session ctx".length },
      PreToolUse: { injections: 2, chars: [...pre].length + "second".length },
      PostToolUse: { injections: 1, chars: "post".length },
      SubagentStart: { injections: 1, chars: "from hookEventName".length },
      Notification: { injections: 1, chars: "from hook_name".length },
    },
    total: { injections: 6, chars: "session ctx".length + [...pre].length + "second".length + "post".length + "from hookEventName".length + "from hook_name".length },
  });
  assert.equal(metrics.hook_injections.by_event.PreToolUse!.chars, [...pre].length + "second".length, "chars are code points, not UTF-16 units");
  assert.equal(metrics.hook_events, 13, "every hook_response is still a hook event");
  assert.deepEqual(hookInjection({ output: contextOutput("PreToolUse", "x") }), { event: "PreToolUse", chars: 1 }, "falls back to hookEventName");
  assert.equal(hookInjection({ hook_event: "Stop", output: JSON.stringify({ systemMessage: "s" }) }), null);
  assert.equal(hookInjection({ hook_event: "PreToolUse", stdout: contextOutput("PreToolUse", "only in stdout") }), null, "only `output` is read");

  const cost = transcriptCost(metrics);
  assert.deepEqual(cost.hook_injections, metrics.hook_injections);
  assert.equal(cost.background_wakeups, 0);
  assert.equal(transcriptCost(null).hook_injections, null);
  assert.equal(transcriptCost(null).background_wakeups, null);
});

test("parseTranscript counts every init after the first as a background wake-up", () => {
  const init = line({ type: "system", subtype: "init", session_id: "s", tools: ["Read"] });
  const result = line({ type: "result", subtype: "success", is_error: false, usage: { input_tokens: 1, output_tokens: 1 } });
  assert.equal(parseTranscript("").background_wakeups, 0);
  assert.equal(parseTranscript(init).background_wakeups, 0);
  const woken = parseTranscript([init, result, line({ type: "system", subtype: "task_notification" }), init, result, init, result].join("\n"));
  assert.equal(woken.background_wakeups, 2);
  assert.equal(woken.result_events, 3);
  assert.deepEqual(woken.init?.tool_names, ["Read"], "the first init is still the one reported");
  assert.equal(parseTranscript([result, line({ type: "system", subtype: "hook_response", hook_event: "SessionStart" })].join("\n")).background_wakeups, 0);
});

// Shapes from real PILOT5 transcripts (CLI 2.1.280): a background-task notification re-invokes the session and
// emits a second result whose `usage` covers only that invocation, while `modelUsage` is session-cumulative and
// includes subagent models that never appear in `usage`.
const usage = (input: number, creation: number, read: number, output: number) =>
  ({ input_tokens: input, cache_creation_input_tokens: creation, cache_read_input_tokens: read, output_tokens: output });
const modelEntry = (input: number, creation: number, read: number, output: number) =>
  ({ inputTokens: input, cacheCreationInputTokens: creation, cacheReadInputTokens: read, outputTokens: output, costUSD: 0.1 });

test("parseTranscript sums usage over every result event and takes subagents from the last cumulative modelUsage", () => {
  const transcript = [
    line({ type: "assistant", parent_tool_use_id: null, message: { id: "msg_1", usage: usage(1, 100, 0, 5), content: [
      { type: "tool_use", id: "toolu_1", name: "Agent", input: {} }] } }),
    // Subagent messages: the first is repeated per content block, the last seen usage wins.
    line({ type: "assistant", parent_tool_use_id: "toolu_1", message: { id: "msg_s1", usage: usage(1, 50, 0, 1), content: [{ type: "text", text: "a" }] } }),
    line({ type: "assistant", parent_tool_use_id: "toolu_1", message: { id: "msg_s1", usage: usage(1, 50, 0, 7), content: [
      { type: "tool_use", id: "toolu_s1", name: "Read", input: {} }] } }),
    line({ type: "assistant", parent_tool_use_id: "toolu_1", message: { id: "msg_s2", usage: usage(1, 0, 60, 2), content: [{ type: "text", text: "b" }] } }),
    line({ type: "assistant", parent_tool_use_id: null, message: { id: "msg_2", usage: usage(1, 10, 100, 5), content: [{ type: "text", text: "wait" }] } }),
    line({ type: "result", subtype: "success", is_error: false, num_turns: 2, usage: usage(2, 110, 100, 10),
      modelUsage: { main: modelEntry(2, 110, 100, 10), sub: modelEntry(2, 50, 60, 20) } }),
    line({ type: "assistant", parent_tool_use_id: null, message: { id: "msg_3", usage: usage(1, 5, 210, 3), content: [{ type: "text", text: "done" }] } }),
    line({ type: "result", subtype: "success", is_error: false, num_turns: 1, origin: { kind: "task-notification" }, usage: usage(1, 5, 210, 3),
      modelUsage: { main: modelEntry(3, 115, 310, 13), sub: modelEntry(2, 50, 60, 20) } }),
  ].join("\n");

  const metrics = parseTranscript(transcript);
  assert.equal(metrics.result_events, 2);
  assert.deepEqual(metrics.result, { subtype: "success", is_error: false, num_turns: 1 }, "the last result");
  assert.deepEqual(metrics.usage, { input: 3, cache_creation: 115, cache_read: 310, output: 13 }, "main loop: both invocations");
  assert.deepEqual(metrics.session_usage, { input: 5, cache_creation: 165, cache_read: 370, output: 33 }, "last modelUsage, all models");
  assert.deepEqual(metrics.streamed_usage, { main: { input: 428, output: 13 }, subagents: { input: 112, output: 9 } });
  assert.equal(metrics.model_calls, 5);
  assert.equal(metrics.main_model_calls, 3);
  assert.equal(metrics.subagent_model_calls, 2);

  const cost = transcriptCost(metrics);
  assert.equal(cost.token_measurement, "provider");
  assert.equal(cost.input_tokens, 540);
  assert.equal(cost.output_tokens, 33);
  assert.deepEqual(cost.input_token_parts, { input: 5, cache_creation: 165, cache_read: 370 });
  assert.equal(cost.main_input_tokens, 428);
  assert.equal(cost.main_output_tokens, 13);
  assert.equal(cost.subagent_input_tokens, 112);
  assert.equal(cost.subagent_output_tokens, 20);
  assert.equal(cost.result_events, 2);
  assert.equal(cost.input_tokens_lower_bound, null, "a run with a result has exact counts, not a bound");
  assert.equal(cost.model_calls, 5);
  assert.equal(cost.main_model_calls, 3);
  assert.equal(cost.subagent_model_calls, 2);
  assert.equal(cost.call_measurement, "parsed");
});

test("transcriptCost: no result is unavailable with a streamed lower bound; missing or inconsistent modelUsage is never guessed", () => {
  const streamedOnly = parseTranscript([
    line({ type: "assistant", parent_tool_use_id: null, message: { id: "msg_1", usage: usage(1, 100, 0, 5), content: [] } }),
    line({ type: "assistant", parent_tool_use_id: "toolu_1", message: { id: "msg_s1", usage: usage(1, 0, 40, 2), content: [] } }),
  ].join("\n"));
  const timedOut = transcriptCost(streamedOnly);
  assert.equal(timedOut.token_measurement, "unavailable");
  assert.equal(timedOut.input_tokens, null);
  assert.equal(timedOut.main_input_tokens, null);
  assert.equal(timedOut.subagent_input_tokens, null);
  assert.equal(timedOut.result_events, 0);
  assert.equal(timedOut.input_tokens_lower_bound, 142);
  assert.equal(timedOut.output_tokens_lower_bound, 7);
  assert.equal(timedOut.model_calls, 2);

  const noModelUsage = transcriptCost(parseTranscript(line({ type: "result", subtype: "success", is_error: false, usage: usage(1, 2, 3, 4) })));
  assert.equal(noModelUsage.token_measurement, "provider");
  assert.equal(noModelUsage.input_tokens, 6, "without modelUsage the session is the main loop");
  assert.equal(noModelUsage.main_input_tokens, 6);
  assert.equal(noModelUsage.subagent_input_tokens, null, "subagent share unknown, not 0");

  const subagentsWithoutModelUsage = transcriptCost(parseTranscript([
    line({ type: "assistant", parent_tool_use_id: "toolu_1", message: { id: "msg_s1", usage: usage(1, 0, 40, 2), content: [] } }),
    line({ type: "result", subtype: "success", is_error: false, usage: usage(1, 2, 3, 4) }),
  ].join("\n")));
  assert.equal(subagentsWithoutModelUsage.token_measurement, "unavailable", "a main-only total is not a session total when subagents ran");
  assert.equal(subagentsWithoutModelUsage.input_tokens, null);
  assert.equal(subagentsWithoutModelUsage.main_input_tokens, 6);

  const laterWithout = transcriptCost(parseTranscript([
    line({ type: "result", subtype: "success", is_error: false, usage: usage(1, 2, 3, 4), modelUsage: { main: modelEntry(1, 2, 3, 4), sub: modelEntry(0, 0, 10, 1) } }),
    line({ type: "result", subtype: "success", is_error: false, usage: usage(0, 0, 5, 1) }),
  ].join("\n")));
  // The earlier cumulative modelUsage (16) predates the second invocation, so it is not reused; no subagent streamed,
  // so the session is the main loop over both invocations.
  assert.equal(laterWithout.input_tokens, 11, "a stale earlier modelUsage is not the session total");
  assert.equal(laterWithout.main_input_tokens, 11);
  assert.equal(laterWithout.subagent_input_tokens, null);

  const inconsistent = transcriptCost(parseTranscript(line({ type: "result", subtype: "success", is_error: false,
    usage: usage(1, 2, 3, 4), modelUsage: { main: modelEntry(1, 1, 1, 4) } })));
  assert.equal(inconsistent.token_measurement, "unavailable", "models summing below the main loop are not a number");
  assert.equal(inconsistent.input_tokens, null);
  assert.equal(inconsistent.main_input_tokens, 6);
  assert.equal(inconsistent.subagent_input_tokens, null);

  const none = transcriptCost(null);
  assert.equal(none.token_measurement, "unavailable");
  assert.equal(none.call_measurement, "unavailable");
  assert.equal(none.input_tokens_lower_bound, null);
  assert.equal(none.model_calls, null);
});

test("strippedChildEnv removes routing, Hunch, Git and Claude keys and applies extra", () => {
  const base: NodeJS.ProcessEnv = {
    ANTHROPIC_API_KEY: "k", ANTHROPIC_AUTH_TOKEN: "t", ANTHROPIC_BASE_URL: "u", CLAUDE_CODE_USE_BEDROCK: "1",
    CLAUDE_CODE_USE_VERTEX: "1", CLAUDE_CODE_USE_FOUNDRY: "1", AWS_BEARER_TOKEN_BEDROCK: "b", OPENAI_API_KEY: "o",
    CURSOR_API_KEY: "c", GEMINI_API_KEY: "g", GOOGLE_API_KEY: "g", HUNCH_PRIVATE_DIR: "/leak", HUNCH_INITIATOR: "claude",
    GIT_DIR: "/g", GIT_CONFIG_COUNT: "2", GIT_EDITOR: "vim", CLAUDECODE: "1", CLAUDE_CODE_ENTRYPOINT: "cli",
    CLAUDE_CONFIG_DIR: "/c", CLAUDE_CODE_GIT_BASH_PATH: "C:/bash.exe", PATH: "/bin", UNSET: undefined,
  };
  const env = strippedChildEnv(base, { HUNCH_PRIVATE_DIR: "/arm" });
  assert.deepEqual(env, { GIT_EDITOR: "vim", CLAUDE_CODE_GIT_BASH_PATH: "C:/bash.exe", PATH: "/bin", HUNCH_PRIVATE_DIR: "/arm" });
  assert.deepEqual(Object.keys(strippedChildEnv(base)).filter(isForbiddenChildEnvKey), []);
  assert.equal(isForbiddenChildEnvKey("anthropic_api_key"), true);
  assert.equal(isForbiddenChildEnvKey("GIT_EDITOR"), false);
  assert.equal(isForbiddenChildEnvKey("PATH"), false);
});

test("buildClaudeArgv pins the flags, keeps the prompt out of argv, and adds effort only when set", () => {
  const argv = buildClaudeArgv(claudeCfg(), "/tmp/mcp.json");
  assert.deepEqual(argv, [
    "-p", "--output-format", "stream-json", "--verbose", "--include-hook-events", "--setting-sources", "project",
    "--strict-mcp-config", "--mcp-config", "/tmp/mcp.json", "--no-session-persistence", "--permission-mode",
    "bypassPermissions", "--model", "claude-opus-5-5",
  ]);
  assert.ok(!argv.includes("--effort"));
  assert.deepEqual(buildClaudeArgv(claudeCfg("high"), "/tmp/mcp.json").slice(-2), ["--effort", "high"]);
});

test("sanitizedArgvHash is stable across temp paths and sensitive to flags", () => {
  const [a, b] = [tempDir(), tempDir()];
  try {
    const hashFor = (dir: string, cfg = claudeCfg("high")) => {
      const mcp = join(dir, "probe-mcp.json");
      return sanitizedArgvHash(buildClaudeArgv(cfg, mcp), [mcp, dir]);
    };
    assert.match(hashFor(a), /^[0-9a-f]{64}$/);
    assert.equal(hashFor(a), hashFor(b));
    assert.notEqual(hashFor(a), hashFor(a, claudeCfg(null)));
    const mcp = join(a, "probe-mcp.json");
    assert.equal(sanitizedArgvHash(buildClaudeArgv(claudeCfg("high"), mcp.replace(/\\/g, "/")), [mcp, a]), hashFor(b));
  } finally {
    rmSync(a, { recursive: true, force: true });
    rmSync(b, { recursive: true, force: true });
  }
});

test("runAgent writes the prompt to stdin, records the transcript and times the run", async () => {
  const dir = tempDir();
  try {
    const script = join(dir, "fixture-agent.mjs");
    writeFileSync(script, `
import { writeFileSync } from "node:fs";
let input = "";
process.stdin.setEncoding("utf8");
process.stdin.on("data", (chunk) => { input += chunk; });
process.stdin.on("end", () => {
  writeFileSync("agent-output.txt", JSON.stringify({ prompt: input, mcp: process.argv[2] }));
  const out = (value) => process.stdout.write(JSON.stringify(value) + "\\n");
  out({ type: "system", subtype: "init", model: "fixture-model", apiKeySource: "none", mcp_servers: [], tools: ["Read"] });
  out({ type: "assistant", message: { id: "msg_1", content: [{ type: "tool_use", id: "toolu_1", name: "Read", input: {} }] } });
  out({ type: "result", subtype: "success", is_error: false, num_turns: 1,
    usage: { input_tokens: 1, cache_creation_input_tokens: 2, cache_read_input_tokens: 3, output_tokens: 4 } });
  process.stderr.write("fixture stderr\\n");
  setTimeout(() => process.exit(0), 20);
});
`);
    const work = join(dir, "work");
    const out = join(dir, "out", "run-1");
    const mcp = join(dir, "mcp.json");
    const prompt = "Fix the bug\n\nline two with \"quotes\" & <angles>";
    mkdirSync(work);
    const run = await runAgent({ cfg: fixtureCfg(script), prompt, cwd: work, mcpConfigPath: mcp, env: strippedChildEnv(process.env), timeoutMs: 30_000, outDir: out });

    assert.equal(run.exit_code, 0);
    assert.equal(run.signal, null);
    assert.equal(run.timed_out, false);
    assert.ok(run.agent_wall_clock_ms > 0);
    assert.equal(run.transcript_path, join(out, "transcript.jsonl"));
    assert.equal(readFileSync(run.stderr_path, "utf8"), "fixture stderr\n");
    assert.equal(run.metrics.init?.model, "fixture-model");
    assert.equal(run.metrics.init?.api_key_source, "none");
    assert.equal(run.metrics.model_calls, 1);
    assert.equal(run.metrics.tool_calls, 1);
    assert.equal(run.metrics.investigation_tool_calls, 1);
    assert.deepEqual(run.metrics.usage, { input: 1, cache_creation: 2, cache_read: 3, output: 4 });
    assert.equal(run.metrics.result?.is_error, false);
    const written = join(work, "agent-output.txt");
    assert.ok(existsSync(written));
    assert.deepEqual(JSON.parse(readFileSync(written, "utf8")), { prompt, mcp });
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("runAgent kills the whole process tree on timeout", async () => {
  const dir = tempDir();
  let grandchild: number | undefined;
  const alive = (pid: number) => { try { process.kill(pid, 0); return true; } catch { return false; } };
  try {
    const script = join(dir, "fixture-hang.mjs");
    writeFileSync(script, `
import { spawn } from "node:child_process";
import { writeFileSync } from "node:fs";
// Windows: detached escapes libuv's kill-on-close job object, so only a /T tree kill reaches it.
// POSIX: not detached, so it stays in the leader's process group.
const child = spawn(process.execPath, ["-e", "setInterval(()=>{},1000)"], { stdio: "ignore", windowsHide: true, detached: process.platform === "win32" });
writeFileSync("grandchild.pid", String(child.pid));
setInterval(() => {}, 1000);
`);
    const run = await runAgent({ cfg: fixtureCfg(script), prompt: "hang", cwd: dir, mcpConfigPath: join(dir, "mcp.json"),
      env: strippedChildEnv(process.env), timeoutMs: 1500, outDir: join(dir, "out") });
    assert.equal(run.timed_out, true);
    assert.ok(run.agent_wall_clock_ms >= 1400, `wall clock ${run.agent_wall_clock_ms}`);
    grandchild = Number(readFileSync(join(dir, "grandchild.pid"), "utf8"));
    assert.ok(Number.isInteger(grandchild) && grandchild > 0);
    const deadline = Date.now() + 5000;
    while (alive(grandchild) && Date.now() < deadline) await new Promise((done) => setTimeout(done, 100));
    assert.equal(alive(grandchild), false, "grandchild survived the timeout");
  } finally {
    if (grandchild !== undefined && alive(grandchild)) try { process.kill(grandchild); } catch { /* gone */ }
    rmSync(dir, { recursive: true, force: true });
  }
});

test("preflight accepts the fixture provider and fails closed for a missing CLI", async () => {
  const dir = tempDir();
  try {
    const fixture = await preflight(fixtureCfg(join(dir, "fixture.mjs")), { workDir: dir });
    assert.equal(fixture.ok, true);
    assert.deepEqual({ ...fixture.identity, sanitized_argv_hash: undefined }, {
      provider: "fixture", cli_version: "fixture", model_identity: null, model_identity_source: "unknown", sanitized_argv_hash: undefined,
    });
    assert.match(fixture.identity.sanitized_argv_hash, /^[0-9a-f]{64}$/);

    const missing = await preflight({ ...claudeCfg(), executable: "definitely-not-a-cli-xyz" }, { workDir: join(dir, "claude") });
    assert.equal(missing.ok, false);
    assert.equal(missing.checks.find((check) => check.id === "executable")?.ok, false);
    assert.equal(missing.checks.find((check) => check.id === "probe")?.ok, false);
    assert.equal(missing.checks.find((check) => check.id === "stripped-env")?.ok, true);
    assert.equal(missing.identity.model_identity, "claude-opus-5-5");
    assert.equal(missing.identity.model_identity_source, "configured");
    assert.equal(existsSync(join(dir, "claude", "probe")), false, "no probe after a failed check");
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});
