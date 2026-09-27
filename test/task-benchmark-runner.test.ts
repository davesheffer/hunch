import { test } from "node:test";
import assert from "node:assert/strict";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { parseTranscript } from "../src/benchmark/transcript.js";
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
      mcp_servers: [{ name: "hunch", status: "connected" }], tools: ["Read", "Grep", "mcp__hunch__hunch_context"] }),
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
    model: "claude-opus-5-5[1m]", api_key_source: "none", mcp_servers: ["hunch"], tool_names: ["Read", "Grep", "mcp__hunch__hunch_context"],
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
