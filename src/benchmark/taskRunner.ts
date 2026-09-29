// Runner layer for `hunch task benchmark`: stripped child environment, pinned Claude Code argv,
// one timed agent process with a process-tree timeout, and the fail-closed preflight.
// Design: bench/pilot5/GATE-A-HARNESS.md ("Runner", "Metrics").
import spawn from "cross-spawn";
import { execFileSync, spawnSync } from "node:child_process";
import { createHash, randomBytes } from "node:crypto";
import { appendFileSync, createWriteStream, type Dirent, existsSync, mkdirSync, readdirSync, readFileSync, writeFileSync } from "node:fs";
import { isAbsolute, join, relative } from "node:path";
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

/** Keys the harness itself sets in neutral user-config mode; the parent's values are still stripped. */
export const NEUTRAL_CHILD_ENV_KEYS: readonly string[] = ["CLAUDE_CONFIG_DIR", "CLAUDE_CODE_OAUTH_TOKEN"];

/** Neutral user-config env: the run's own empty config dir and the subscription token (never an API key). */
export function neutralChildEnv(configDir: string, token: string): Record<string, string> {
  return { CLAUDE_CONFIG_DIR: configDir, CLAUDE_CODE_OAUTH_TOKEN: token };
}

/** Forbidden keys in `env`, except a neutral key whose value is exactly what the harness set (compared upper-cased). */
export function leakedChildEnvKeys(env: Record<string, string>, harnessSet: Record<string, string> = {}): string[] {
  const set = new Map(Object.entries(harnessSet).map(([key, value]) => [key.toUpperCase(), value]));
  return Object.keys(env).filter((key) => isForbiddenChildEnvKey(key)
    && !(NEUTRAL_CHILD_ENV_KEYS.includes(key.toUpperCase()) && set.get(key.toUpperCase()) === env[key]));
}

export const REDACTED_TOKEN = "<redacted-oauth-token>";

export interface RedactionResult { count: number; failures: string[] }

/** `needleText` and, when it differs, its JSON-escaped form: the forms every redaction replaces. */
function redactionForms(needleText: string): string[] {
  const escaped = JSON.stringify(needleText).slice(1, -1);
  return [needleText, ...(escaped !== needleText ? [escaped] : [])];
}

/** `text` with every occurrence of `needleText` and of its JSON-escaped form replaced by `replacementText`. */
export function redactText(text: string, needleText: string, replacementText: string = REDACTED_TOKEN): string {
  if (!needleText) throw new Error("redactText: empty needle");
  return redactionForms(needleText).reduce((current, form) => current.split(form).join(replacementText), text);
}

/** Replaces every occurrence of `needle` and of its JSON-escaped form in every regular file under `dir` (symlinks not
 *  followed), in place, byte-wise, with `replacementText`. Never aborts the walk: an entry that cannot be read or
 *  written is listed in `failures` as its relative path and error code (never content). */
export function redactTokenInDir(dir: string, needleText: string, replacementText: string = REDACTED_TOKEN): RedactionResult {
  if (!needleText) throw new Error("redactTokenInDir: empty needle");
  const needles = redactionForms(needleText).map((text) => Buffer.from(text, "utf8"));
  const replacement = Buffer.from(replacementText, "utf8");
  const result: RedactionResult = { count: 0, failures: [] };
  const fail = (path: string, error: unknown) => {
    result.failures.push(`${relative(dir, path) || "."}: ${(error as NodeJS.ErrnoException).code ?? "error"}`);
  };
  const replaceAll = (bytes: Buffer, needle: Buffer): Buffer => {
    let at = bytes.indexOf(needle);
    if (at < 0) return bytes;
    const parts: Buffer[] = [];
    let from = 0;
    while (at >= 0) {
      parts.push(bytes.subarray(from, at), replacement);
      result.count++;
      from = at + needle.length;
      at = bytes.indexOf(needle, from);
    }
    parts.push(bytes.subarray(from));
    return Buffer.concat(parts);
  };
  const walk = (current: string) => {
    let entries: Dirent[];
    try { entries = readdirSync(current, { withFileTypes: true }); } catch (error) { fail(current, error); return; }
    for (const entry of entries) {
      const path = join(current, entry.name);
      if (entry.isDirectory()) { walk(path); continue; }
      if (!entry.isFile()) continue;
      try {
        const bytes = readFileSync(path);
        const redacted = needles.reduce(replaceAll, bytes);
        if (redacted !== bytes) writeFileSync(path, redacted);
      } catch (error) {
        fail(path, error);
      }
    }
  };
  if (existsSync(dir)) walk(dir);
  return result;
}

/** Pids of live agent processes, so a signal handler can kill their trees before the harness exits. */
const liveChildren = new Set<number>();

/** Kills every live agent's process tree: SIGTERM, a short synchronous wait, then SIGKILL. Never throws. */
export function killLiveChildren(graceMs = 500): void {
  const pids = [...liveChildren];
  if (!pids.length) return;
  for (const pid of pids) killProcessTree(pid, "SIGTERM");
  Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, graceMs);
  for (const pid of pids) killProcessTree(pid, "SIGKILL");
  liveChildren.clear();
}

/** The last result event's `result` text in a stream-json transcript, or null. */
export function resultText(transcript: string): string | null {
  let text: string | null = null;
  for (const line of transcript.split(/\r?\n/)) {
    if (!line.trim()) continue;
    try {
      const event = JSON.parse(line) as { type?: unknown; result?: unknown };
      if (event.type === "result" && typeof event.result === "string") text = event.result;
    } catch { /* not JSON */ }
  }
  return text;
}

/** `USER=<value>` / `PROJECT=<value>` of the instructions-canaries probe reply; NONE and a missing line read as null. */
export function parseCanaryReply(text: string | null): { user: string | null; project: string | null } {
  const value = (name: string) => {
    const match = new RegExp(`\\b${name}\\s*[=:]\\s*\`?([A-Za-z0-9]+)`).exec(text ?? "");
    return match && match[1]!.toUpperCase() !== "NONE" ? match[1]! : null;
  };
  return { user: value("USER"), project: value("PROJECT") };
}

/** A YES/NO reply's answer (leading punctuation and case ignored), else null. */
export function parseYesNo(text: string | null): "YES" | "NO" | null {
  const match = /^\W*(YES|NO)\b/i.exec((text ?? "").trim());
  return match ? (match[1]!.toUpperCase() as "YES" | "NO") : null;
}

/** The longest trimmed line (>= 30 chars) of a user CLAUDE.md, the user-instructions-absent probe's needle. */
export function distinctiveLine(text: string): string | null {
  const line = text.split(/\r?\n/).map((part) => part.trim()).reduce((best, part) => (part.length > best.length ? part : best), "");
  return line.length >= 30 ? line : null;
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

/**
 * Kills a process and its descendants: `taskkill /T /F` on Windows, the process group on POSIX
 * (the leader must have been spawned detached). Falls back to the single pid; never throws.
 */
export function killProcessTree(pid: number, signal: NodeJS.Signals = "SIGTERM"): void {
  try {
    if (process.platform === "win32") execFileSync("taskkill", ["/pid", String(pid), "/T", "/F"], { stdio: "ignore", timeout: 5000, windowsHide: true });
    else process.kill(-pid, signal);
  } catch { try { process.kill(pid, signal); } catch { /* already gone */ } }
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
    let pid: number | undefined;
    const settle = (code: number | null, signal: string | null) => {
      if (settled) return;
      settled = true;
      if (pid !== undefined) liveChildren.delete(pid);
      resolve({ code, signal, elapsed: performance.now() - started });
    };
    let child: ReturnType<typeof spawn>;
    try {
      child = spawn(command, args, {
        cwd: opts.cwd, env: opts.env, windowsHide: true, detached: process.platform !== "win32", stdio: ["pipe", "pipe", "pipe"],
      });
      pid = child.pid;
      if (pid !== undefined) liveChildren.add(pid);
    } catch (error) {
      spawnError = error as Error;
      settle(null, null);
      return;
    }
    const killTree = (signal: NodeJS.Signals) => {
      if (child.pid) killProcessTree(child.pid, signal);
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

/** Neutral user-config preflight input: the token (never recorded) and the real user CLAUDE.md to probe against. */
export interface PreflightNeutral { token: string; userInstructionsFile: string }

/** Fails closed: any failed check yields ok:false, and no check throws. With `neutral`, every probe runs under its own
 *  empty config dir and the token, and the instructions-canaries and user-instructions-absent probes are added. */
export async function preflight(
  cfg: RunnerConfig, opts: { workDir: string; probeTimeoutMs?: number; neutral?: PreflightNeutral },
): Promise<PreflightResult> {
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
  const neutral = opts.neutral ?? null;
  const probeConfigDir = join(opts.workDir, "probe-config");
  const harnessEnv = neutral ? neutralChildEnv(probeConfigDir, neutral.token) : {};
  const childEnv = strippedChildEnv(process.env, harnessEnv);
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

  const leaked = leakedChildEnvKeys(childEnv, harnessEnv);
  const envOk = add("stripped-env", leaked.length === 0, leaked.length ? `forbidden keys remain: ${leaked.join(", ")}` : "no forbidden keys");
  let probeInit: AgentRunResult["metrics"]["init"] = null;

  if (found && versioned && envOk) {
    try {
      const probeDir = join(opts.workDir, "probe");
      mkdirSync(probeDir, { recursive: true });
      if (neutral) mkdirSync(probeConfigDir, { recursive: true });
      if (readdirSync(probeDir).length) {
        add("probe", false, `probe directory is not empty: ${probeDir}`);
      } else if (neutral && readdirSync(probeConfigDir).length) {
        add("probe", false, `probe config directory is not empty: ${probeConfigDir}`);
      } else {
        writeFileSync(mcpConfigPath, '{"mcpServers":{}}');
        const run = await runAgent({
          cfg, prompt: "Reply with exactly: OK", cwd: probeDir, mcpConfigPath, env: childEnv,
          timeoutMs: opts.probeTimeoutMs ?? 180_000, outDir: join(opts.workDir, "probe-run"),
        });
        probeInit = run.metrics.init;
        reportedModel = run.metrics.init?.model ?? null;
        const ok = run.exit_code === 0 && !run.timed_out && run.metrics.init?.api_key_source === "none" && run.metrics.result?.is_error === false;
        add("probe", ok, `exit ${run.exit_code}, timed_out ${run.timed_out}, apiKeySource ${run.metrics.init?.api_key_source ?? "missing"}, `
          + `is_error ${run.metrics.result?.is_error ?? "missing"}; transcript ${run.transcript_path}`);
      }
    } catch (error) {
      add("probe", false, `probe failed: ${(error as Error).message}`);
    }
  } else add("probe", false, "skipped: an earlier check failed");

  const probeMcpServers = probeInit?.mcp_servers ?? null;
  add("probe-mcp-empty", probeMcpServers !== null && probeMcpServers.length === 0,
    probeMcpServers !== null
      ? `${probeMcpServers.length} MCP server(s)${probeMcpServers.length ? `: ${probeMcpServers.join(", ")}` : ""}`
      : "no probe init event");
  const probeMcpTools = probeInit?.tool_names.filter((name) => name.startsWith("mcp__")) ?? null;
  add("probe-no-mcp-tools", probeMcpTools !== null && probeMcpTools.length === 0,
    probeMcpTools !== null ? (probeMcpTools.length ? probeMcpTools.join(", ") : "no mcp__ tool") : "no probe init event");

  if (neutral) {
    const probeOk = checks.find((check) => check.id === "probe")?.ok === true;
    /** One probe in `<workDir>/<name>/` with its own empty cwd and config dir; the reply is the last result text. */
    const neutralProbe = async (name: string, prompt: string, setup: (cwd: string, configDir: string) => void) => {
      const cwd = join(opts.workDir, name, "cwd");
      const configDir = join(opts.workDir, name, "config");
      for (const dir of [cwd, configDir]) {
        mkdirSync(dir, { recursive: true });
        if (readdirSync(dir).length) throw new Error(`${name} directory is not empty: ${dir}`);
      }
      setup(cwd, configDir);
      const run = await runAgent({
        cfg, prompt, cwd, mcpConfigPath, env: strippedChildEnv(process.env, neutralChildEnv(configDir, neutral.token)),
        timeoutMs: opts.probeTimeoutMs ?? 180_000, outDir: join(opts.workDir, name, "run"),
      });
      const ok = run.exit_code === 0 && !run.timed_out && run.metrics.result?.is_error === false;
      return { ok, reply: resultText(readFileSync(run.transcript_path, "utf8")),
        detail: `exit ${run.exit_code}, timed_out ${run.timed_out}, is_error ${run.metrics.result?.is_error ?? "missing"}` };
    };

    if (!probeOk) add("instructions-canaries", false, "skipped: the probe failed");
    else {
      try {
        const userCanary = randomBytes(8).toString("hex");
        const projectCanary = randomBytes(8).toString("hex");
        const probe = await neutralProbe("instructions-canaries",
          "Your instructions may contain a line \"Benchmark user canary: <value>\" and a line \"Benchmark project canary: <value>\". "
          + "Reply with exactly two lines and nothing else: USER=<the user canary value or NONE> and PROJECT=<the project canary value or NONE>",
          (cwd, configDir) => {
            writeFileSync(join(configDir, "CLAUDE.md"), `Benchmark user canary: ${userCanary}\n`);
            writeFileSync(join(cwd, "CLAUDE.md"), `Benchmark project canary: ${projectCanary}\n`);
          });
        const seen = parseCanaryReply(probe.reply);
        const shown = (value: string | null) => (value ?? "NONE").slice(0, 40);
        add("instructions-canaries", probe.ok && seen.user === userCanary && seen.project === projectCanary,
          `${probe.detail}; USER ${seen.user === userCanary ? "match" : `mismatch (${shown(seen.user)})`}, `
          + `PROJECT ${seen.project === projectCanary ? "match" : `mismatch (${shown(seen.project)})`}`);
      } catch (error) {
        add("instructions-canaries", false, `probe failed: ${(error as Error).message}`);
      }
    }

    try {
      const line = existsSync(neutral.userInstructionsFile) ? distinctiveLine(readFileSync(neutral.userInstructionsFile, "utf8")) : null;
      if (!existsSync(neutral.userInstructionsFile)) add("user-instructions-absent", true, "no user CLAUDE.md");
      else if (line === null) add("user-instructions-absent", true, "no line of 30+ characters in user CLAUDE.md");
      else if (!probeOk) add("user-instructions-absent", false, "skipped: the probe failed");
      else {
        const hash = createHash("sha256").update(line).digest("hex").slice(0, 12);
        // The probe dir holds the user's line: scrub it however the probe ends (the signal sweep removes the dir).
        let scrub: RedactionResult = { count: 0, failures: [] };
        let probe: Awaited<ReturnType<typeof neutralProbe>>;
        try {
          probe = await neutralProbe("user-instructions-absent",
            `Does this exact line appear anywhere in your instructions or context? Reply YES or NO only. Line: ${line}`, () => {});
        } finally {
          scrub = redactTokenInDir(join(opts.workDir, "user-instructions-absent"), line, "<redacted-user-line>");
        }
        const answer = parseYesNo(probe.reply);
        add("user-instructions-absent", probe.ok && answer === "NO" && scrub.failures.length === 0,
          `line hash ${hash}; ${probe.detail}; answer ${answer ?? "unparsed"}`
          + (scrub.failures.length ? `; line redaction failed: ${scrub.failures.join(", ")}` : ""));
      }
    } catch (error) {
      add("user-instructions-absent", false, `probe failed: ${(error as Error).message}`);
    }

    try {
      const scrub = redactTokenInDir(opts.workDir, neutral.token);
      add("token-redaction", scrub.failures.length === 0,
        `token_redactions: ${scrub.count}${scrub.failures.length ? `; failures: ${scrub.failures.join(", ")}` : ""}`);
    } catch (error) {
      add("token-redaction", false, `redaction failed: ${(error as Error).message}`);
    }
    for (const check of checks) check.detail = redactText(check.detail, neutral.token);
  }

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
