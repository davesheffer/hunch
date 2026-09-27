// Runner layer for `hunch task benchmark`: stripped child environment, pinned Claude Code argv,
// one timed agent process with a process-tree timeout, and the fail-closed preflight.
// Design: bench/pilot5/GATE-A-HARNESS.md ("Runner", "Metrics").
import spawn from "cross-spawn";
import { execFileSync, spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import { appendFileSync, createWriteStream, existsSync, mkdirSync, readdirSync, readFileSync, writeFileSync } from "node:fs";
import { isAbsolute, join } from "node:path";
import { performance } from "node:perf_hooks";
import { finished } from "node:stream/promises";
import { parseTranscript } from "./transcript.js";
import type { AgentRunResult, RunnerConfig, RunnerIdentity } from "./types.js";

/** Exact keys that could route the child to a metered API or another account. */
export const FORBIDDEN_CHILD_ENV: readonly string[] = [
  "ANTHROPIC_API_KEY", "ANTHROPIC_AUTH_TOKEN", "ANTHROPIC_BASE_URL",
  "CLAUDE_CODE_USE_BEDROCK", "CLAUDE_CODE_USE_VERTEX", "CLAUDE_CODE_USE_FOUNDRY", "AWS_BEARER_TOKEN_BEDROCK",
  "OPENAI_API_KEY", "CURSOR_API_KEY", "GEMINI_API_KEY", "GOOGLE_API_KEY", "CLAUDECODE",
];

/** Compared upper-cased: Windows environment names are case-insensitive, so stricter is safer. */
export function isForbiddenChildEnvKey(key: string): boolean {
  const name = key.toUpperCase();
  if (FORBIDDEN_CHILD_ENV.includes(name)) return true;
  if (name.startsWith("HUNCH_")) return true;
  if (name.startsWith("GIT_") && name !== "GIT_EDITOR") return true;
  return name.startsWith("CLAUDE_") && name !== "CLAUDE_CODE_GIT_BASH_PATH";
}

/** The parent environment minus forbidden keys, then the arm's own `extra` (e.g. HUNCH_PRIVATE_DIR). */
export function strippedChildEnv(base: NodeJS.ProcessEnv, extra: Record<string, string> = {}): Record<string, string> {
  const env: Record<string, string> = {};
  for (const [key, value] of Object.entries(base)) {
    if (value !== undefined && !isForbiddenChildEnvKey(key)) env[key] = value;
  }
  return Object.assign(env, extra);
}

/** The prompt goes to stdin, never argv: `claude` is an npm .cmd shim on Windows and multi-line
 * argv through cmd.exe is unsafe. */
export function buildClaudeArgv(cfg: RunnerConfig, mcpConfigPath: string): string[] {
  const argv = [
    "-p", "--output-format", "stream-json", "--verbose", "--include-hook-events",
    "--setting-sources", "project", "--strict-mcp-config", "--mcp-config", mcpConfigPath,
    "--no-session-persistence", "--permission-mode", "bypassPermissions", "--model", cfg.model,
  ];
  if (cfg.effort !== null) argv.push("--effort", cfg.effort);
  return argv;
}

/** sha256 hex of the argv with every occurrence of each path (native and forward-slash form) as "<path>". */
export function sanitizedArgvHash(argv: string[], paths: string[]): string {
  const forms = [...new Set(paths.flatMap((path) => [path, path.replace(/\\/g, "/")]).filter(Boolean))]
    .sort((a, b) => b.length - a.length); // longest first, so a parent never splits a child path
  const sanitized = argv.map((arg) => forms.reduce((text, form) => text.split(form).join("<path>"), arg));
  return createHash("sha256").update(JSON.stringify(sanitized)).digest("hex");
}

export interface RunAgentOptions {
  cfg: RunnerConfig;
  prompt: string;
  cwd: string;
  mcpConfigPath: string;
  /** Used exactly; the caller has already stripped it. */
  env: Record<string, string>;
  timeoutMs: number;
  outDir: string;
}

/** Runs one agent to completion or timeout. Never rejects on child failure. */
export async function runAgent(opts: RunAgentOptions): Promise<AgentRunResult> {
  const { cfg } = opts;
  mkdirSync(opts.outDir, { recursive: true });
  const transcriptPath = join(opts.outDir, "transcript.jsonl");
  const stderrPath = join(opts.outDir, "stderr.txt");
  const transcript = createWriteStream(transcriptPath);
  const stderr = createWriteStream(stderrPath);
  const [command, args] = cfg.provider === "fixture"
    ? [process.execPath, [cfg.executable, opts.mcpConfigPath]]
    : [cfg.executable, buildClaudeArgv(cfg, opts.mcpConfigPath)];
  let timedOut = false;
  let spawnError: Error | undefined;
  let timer: NodeJS.Timeout | undefined;
  let reaped: Promise<void> | undefined;

  const started = performance.now();
  const exit = await new Promise<{ code: number | null; signal: string | null; elapsed: number }>((resolve) => {
    let settled = false;
    const settle = (code: number | null, signal: string | null) => {
      if (settled) return;
      settled = true;
      resolve({ code, signal, elapsed: performance.now() - started });
    };
    let child: ReturnType<typeof spawn>;
    try {
      child = spawn(command, args, {
        cwd: opts.cwd, env: opts.env, windowsHide: true, detached: process.platform !== "win32", stdio: ["pipe", "pipe", "pipe"],
      });
    } catch (error) {
      spawnError = error as Error;
      settle(null, null);
      return;
    }
    const killTree = (signal: NodeJS.Signals) => {
      if (!child.pid) return;
      try {
        if (process.platform === "win32") execFileSync("taskkill", ["/pid", String(child.pid), "/T", "/F"], { stdio: "ignore", timeout: 5000, windowsHide: true });
        else process.kill(-child.pid, signal);
      } catch { try { child.kill(signal); } catch { /* already gone */ } }
    };
    child.stdout?.pipe(transcript);
    child.stderr?.pipe(stderr);
    child.once("close", (code, signal) => settle(code, signal));
    child.once("error", (error) => {
      spawnError = error;
      if (child.pid === undefined) settle(null, null);
    });
    child.stdin?.on("error", () => {});
    child.stdin?.end(opts.prompt);
    timer = setTimeout(() => {
      timedOut = true;
      killTree("SIGTERM");
      // A leader can exit before its descendants: finish the group cleanup after the grace period.
      reaped = new Promise((done) => setTimeout(() => { killTree("SIGKILL"); done(); }, 1000));
    }, opts.timeoutMs);
  });
  clearTimeout(timer);
  if (reaped) await reaped;

  transcript.end();
  stderr.end();
  await Promise.all([finished(transcript), finished(stderr)]).catch(() => {});
  if (spawnError) appendFileSync(stderrPath, `runner: spawn error: ${spawnError.message}\n`);
  return {
    exit_code: exit.code,
    signal: exit.signal,
    timed_out: timedOut,
    agent_wall_clock_ms: exit.elapsed,
    transcript_path: transcriptPath,
    stderr_path: stderrPath,
    metrics: parseTranscript(readFileSync(transcriptPath, "utf8")),
  };
}

export interface PreflightCheck { id: string; ok: boolean; detail: string }
export interface PreflightResult { ok: boolean; identity: RunnerIdentity; checks: PreflightCheck[] }

/** Fails closed: any failed check yields ok:false, and no check throws. */
export async function preflight(cfg: RunnerConfig, opts: { workDir: string; probeTimeoutMs?: number }): Promise<PreflightResult> {
  const mcpConfigPath = join(opts.workDir, "probe-mcp.json");
  if (cfg.provider === "fixture") {
    return {
      ok: true,
      identity: {
        provider: "fixture", cli_version: "fixture", model_identity: null, model_identity_source: "unknown",
        sanitized_argv_hash: sanitizedArgvHash([cfg.executable, mcpConfigPath], [mcpConfigPath, opts.workDir, cfg.executable]),
      },
      checks: [{ id: "fixture", ok: true, detail: "fixture provider: no CLI preflight" }],
    };
  }

  const checks: PreflightCheck[] = [];
  const add = (id: string, ok: boolean, detail: string) => { checks.push({ id, ok, detail }); return ok; };
  const childEnv = strippedChildEnv(process.env);
  let cliVersion = "unknown";
  let reportedModel: string | null = null;

  let found: boolean;
  if (isAbsolute(cfg.executable)) {
    found = add("executable", existsSync(cfg.executable), existsSync(cfg.executable) ? cfg.executable : `not found: ${cfg.executable}`);
  } else {
    const which = spawnSync(process.platform === "win32" ? "where" : "which", [cfg.executable], { encoding: "utf8", windowsHide: true });
    const first = which.status === 0 ? (which.stdout ?? "").split(/\r?\n/).find((line) => line.trim()) : undefined;
    found = add("executable", first !== undefined, first?.trim() ?? `not on PATH: ${cfg.executable}`);
  }

  let versioned = false;
  if (found) {
    const version = spawn.sync(cfg.executable, ["--version"], { encoding: "utf8", windowsHide: true, env: childEnv, timeout: 30_000 });
    const line = version.status === 0 ? String(version.stdout ?? "").split(/\r?\n/).find((text) => text.trim())?.trim() : undefined;
    if (line) cliVersion = line;
    versioned = add("version", line !== undefined, line ?? `--version failed: ${version.error?.message ?? `exit ${version.status}`}`);
  } else add("version", false, "skipped: executable not found");

  const leaked = Object.keys(childEnv).filter(isForbiddenChildEnvKey);
  const envOk = add("stripped-env", leaked.length === 0, leaked.length ? `forbidden keys remain: ${leaked.join(", ")}` : "no forbidden keys");

  if (found && versioned && envOk) {
    try {
      const probeDir = join(opts.workDir, "probe");
      mkdirSync(probeDir, { recursive: true });
      if (readdirSync(probeDir).length) {
        add("probe", false, `probe directory is not empty: ${probeDir}`);
      } else {
        writeFileSync(mcpConfigPath, '{"mcpServers":{}}');
        const run = await runAgent({
          cfg, prompt: "Reply with exactly: OK", cwd: probeDir, mcpConfigPath, env: childEnv,
          timeoutMs: opts.probeTimeoutMs ?? 180_000, outDir: join(opts.workDir, "probe-run"),
        });
        reportedModel = run.metrics.init?.model ?? null;
        const ok = run.exit_code === 0 && !run.timed_out && run.metrics.init?.api_key_source === "none" && run.metrics.result?.is_error === false;
        add("probe", ok, `exit ${run.exit_code}, timed_out ${run.timed_out}, apiKeySource ${run.metrics.init?.api_key_source ?? "missing"}, `
          + `is_error ${run.metrics.result?.is_error ?? "missing"}; transcript ${run.transcript_path}`);
      }
    } catch (error) {
      add("probe", false, `probe failed: ${(error as Error).message}`);
    }
  } else add("probe", false, "skipped: an earlier check failed");

  return {
    ok: checks.every((check) => check.ok),
    identity: {
      provider: cfg.provider,
      cli_version: cliVersion,
      sanitized_argv_hash: sanitizedArgvHash(buildClaudeArgv(cfg, mcpConfigPath), [mcpConfigPath, opts.workDir]),
      model_identity: reportedModel ?? cfg.model,
      model_identity_source: reportedModel !== null ? "reported" : "configured",
    },
    checks,
  };
}
