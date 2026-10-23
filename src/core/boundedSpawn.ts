/** Run a child process under our own timer and kill its WHOLE tree on timeout
 * (issues #44, #489, #498).
 *
 * Node's `timeout` option on spawn/execFile/execFileSync/spawnSync kills only
 * the root process. On Windows that root is often a wrapper (cmd.exe for a
 * `.cmd` shim, or Git for Windows' `cmd\git.exe`), so the real worker (the
 * agent CLI, or `git.exe` / `git-remote-https.exe`) keeps running as an
 * orphan. Running `taskkill /T` afterwards is too late: the root is gone, so
 * the tree can no longer be reached by parent pid.
 *
 * Both forms here run the command under a small Node supervisor that owns the
 * deadline and kills the tree while the root still exists:
 * - Windows: `taskkill /pid <root> /T /F` runs to completion BEFORE the root
 *   is killed.
 * - POSIX: the descendants are found by walking a `ps -A -o pid=,ppid=`
 *   snapshot from the root, taken while the root is still alive. The tree gets
 *   SIGTERM first (git removes its ref/pack lock files on SIGTERM, not on
 *   SIGKILL), then SIGKILL for whatever is still alive after a short grace.
 *
 * The child is NOT detached: it stays in Hunch's process group, so a terminal
 * Ctrl-C still reaches it directly. The supervisor's timer is always cleared,
 * and a timeout is reported as a result (`timedOut`), never a hang.
 *
 * Cost: one extra Node startup (~30 ms) per call, so this is for network or
 * long-running commands, not hot local git calls. */
import { spawn, spawnSync } from "node:child_process";

const RESULT_SENTINEL = "\n__HUNCH_BOUNDED_SPAWN_RESULT__";
const DEFAULT_KILL_GRACE_MS = 1_500;

/** Plain-JS supervisor run as `node -e`. Reads a JSON spec on stdin, runs the
 *  command, forwards its stdout/stderr, and appends one sentinel line with the
 *  outcome to stderr. */
const SUPERVISOR = `
const { spawn, execFile } = require("node:child_process");
const SENTINEL = ${JSON.stringify(RESULT_SENTINEL)};
const win = process.platform === "win32";
let raw = "";
process.stdin.setEncoding("utf8");
process.stdin.on("data", (d) => { raw += d; });
process.stdin.on("end", () => {
  const spec = JSON.parse(raw);
  const result = { status: null, signal: null, timedOut: false, overflowed: false, killSignal: null, error: null };
  let child = null, timer = null, finished = false, killing = false, bytes = 0, errBytes = 0;
  const finish = () => {
    if (finished) return;
    finished = true;
    if (timer) { clearTimeout(timer); timer = null; }
    if (child) {
      if (child.stdout) child.stdout.destroy();
      if (child.stderr) child.stderr.destroy();
      child.unref();
    }
    process.stderr.write(SENTINEL + JSON.stringify(result) + "\\n");
  };
  const rootGone = () => child.exitCode !== null || child.signalCode !== null;
  const alive = (pid) => {
    if (pid === child.pid) return !rootGone();
    try { process.kill(pid, 0); return true; } catch (e) { return false; }
  };
  // Every pid reachable from roots in a fresh ps snapshot (roots included).
  const tree = (roots, cb) => {
    execFile("ps", ["-A", "-o", "pid=,ppid="], { timeout: 2000, windowsHide: true }, (err, out) => {
      const kids = new Map();
      if (!err) for (const line of String(out).split("\\n")) {
        const f = line.trim().split(/\\s+/);
        if (f.length < 2) continue;
        const pid = Number(f[0]), ppid = Number(f[1]);
        if (!kids.has(ppid)) kids.set(ppid, []);
        kids.get(ppid).push(pid);
      }
      const seen = new Set(roots), stack = roots.slice();
      while (stack.length) {
        for (const c of kids.get(stack.pop()) || []) {
          if (c !== process.pid && !seen.has(c)) { seen.add(c); stack.push(c); }
        }
      }
      cb(Array.from(seen));
    });
  };
  const signalAll = (pids, sig) => {
    // Descendants first, the root last: the root stays alive (and the tree
    // reachable) for as long as possible.
    for (const pid of pids) {
      if (pid === child.pid) continue;
      try { process.kill(pid, sig); } catch (e) {}
    }
    try { child.kill(sig); } catch (e) {}
  };
  const killTree = () => {
    if (killing) return;
    killing = true;
    if (!child || !child.pid) return finish();
    if (win) {
      execFile("taskkill", ["/pid", String(child.pid), "/T", "/F"], { windowsHide: true, timeout: 10000 }, () => {
        try { child.kill("SIGKILL"); } catch (e) {}
        result.killSignal = "SIGKILL";
        finish();
      });
      return;
    }
    tree([child.pid], (pids) => {
      signalAll(pids, "SIGTERM");
      result.killSignal = "SIGTERM";
      const deadline = Date.now() + spec.killGraceMs;
      const poll = () => {
        const left = pids.filter(alive);
        if (left.length === 0) return finish();
        if (Date.now() < deadline) { setTimeout(poll, 50); return; }
        // Re-walk from the survivors: anything they spawned during the grace.
        tree(left, (rest) => {
          for (const pid of rest) { try { process.kill(pid, "SIGKILL"); } catch (e) {} }
          try { child.kill("SIGKILL"); } catch (e) {}
          result.killSignal = "SIGKILL";
          finish();
        });
      };
      poll();
    });
  };
  const hasInput = typeof spec.input === "string";
  try {
    child = spawn(spec.file, spec.args, {
      cwd: spec.cwd || undefined,
      env: spec.env || process.env,
      stdio: [hasInput ? "pipe" : "ignore", spec.stdout, "pipe"],
      shell: spec.shell === true,
      windowsHide: true,
    });
  } catch (e) {
    result.error = { code: e && e.code, message: String(e && e.message) };
    return finish();
  }
  if (spec.timeoutMs > 0) {
    timer = setTimeout(() => { timer = null; if (finished) return; result.timedOut = true; killTree(); }, spec.timeoutMs);
  }
  if (child.stdout) child.stdout.on("data", (c) => {
    if (killing) return;
    bytes += c.length;
    if (bytes > spec.maxBuffer) {
      result.overflowed = true;
      if (timer) { clearTimeout(timer); timer = null; }
      return killTree();
    }
    process.stdout.write(c);
  });
  child.stderr.on("data", (c) => {
    if (killing || errBytes > spec.maxBuffer) return;
    errBytes += c.length;
    process.stderr.write(c);
  });
  child.on("error", (e) => { if (killing) return; result.error = { code: e && e.code, message: String(e && e.message) }; finish(); });
  child.on("close", (code, signal) => {
    if (killing) return;
    result.status = code;
    result.signal = signal;
    finish();
  });
  if (hasInput) {
    child.stdin.on("error", () => {});
    child.stdin.end(spec.input);
  }
});
`;

export interface BoundedSpawnOptions {
  cwd?: string;
  env?: NodeJS.ProcessEnv;
  /** Written to the child's stdin, which is then closed. Omitted = no stdin. */
  input?: string;
  /** Supervisor deadline. Omitted or 0 = no deadline. */
  timeoutMs?: number;
  /** stdout bytes allowed before the tree is killed. Default 16 MB. */
  maxBuffer?: number;
  /** Launch through the platform shell (cmd.exe on Windows). `file` is then
   *  the whole command line and `args` should be empty. */
  shell?: boolean;
  /** POSIX: how long the tree gets after SIGTERM before SIGKILL. Default 1500. */
  killGraceMs?: number;
}

export interface BoundedSpawnResult {
  stdout: string;
  stderr: string;
  /** Exit status, or null when the child was killed or never started. */
  status: number | null;
  /** Signal that ended the child: its own exit signal, or on timeout/overflow
   *  the last signal the supervisor delivered to the tree. */
  signal: NodeJS.Signals | null;
  /** The supervisor's deadline fired and the process tree was killed. */
  timedOut: boolean;
  /** stdout exceeded maxBuffer and the process tree was killed. */
  overflowed: boolean;
  /** Spawn failure (e.g. ENOENT), or the supervisor itself failing. */
  error?: NodeJS.ErrnoException;
}

interface SupervisorOutcome {
  status: number | null;
  signal: NodeJS.Signals | null;
  timedOut: boolean;
  overflowed: boolean;
  killSignal: NodeJS.Signals | null;
  error: { code?: string; message: string } | null;
}

function supervisorRequest(file: string, args: string[], opts: BoundedSpawnOptions & { stdout?: "pipe" | "ignore" | "inherit" }) {
  const maxBuffer = opts.maxBuffer ?? 16 * 1024 * 1024;
  const spec = JSON.stringify({
    file, args,
    cwd: opts.cwd ?? null,
    env: opts.env ?? process.env,
    input: opts.input ?? null,
    timeoutMs: opts.timeoutMs && opts.timeoutMs > 0 ? opts.timeoutMs : 0,
    killGraceMs: opts.killGraceMs ?? DEFAULT_KILL_GRACE_MS,
    maxBuffer,
    shell: opts.shell === true,
    stdout: opts.stdout ?? "pipe",
  });
  // The supervisor itself must not inherit user NODE_OPTIONS (loaders, --inspect).
  const env: NodeJS.ProcessEnv = { ...process.env, ELECTRON_RUN_AS_NODE: "1" };
  delete env.NODE_OPTIONS;
  // Backstop only, if the supervisor itself wedges: its own timer is the real bound.
  const backstopMs = opts.timeoutMs && opts.timeoutMs > 0 ? opts.timeoutMs + (opts.killGraceMs ?? DEFAULT_KILL_GRACE_MS) + 15_000 : undefined;
  return { spec, env, maxBuffer, backstopMs };
}

function toResult(stdout: string, rawErr: string, failure: { error?: Error; status: number | null; signal: NodeJS.Signals | null }): BoundedSpawnResult {
  const at = rawErr.lastIndexOf(RESULT_SENTINEL);
  const stderr = at >= 0 ? rawErr.slice(0, at) : rawErr;
  let outcome: SupervisorOutcome | null = null;
  if (at >= 0) {
    try { outcome = JSON.parse(rawErr.slice(at + RESULT_SENTINEL.length).trim()) as SupervisorOutcome; } catch { outcome = null; }
  }
  const result: BoundedSpawnResult = { stdout, stderr, status: null, signal: null, timedOut: false, overflowed: false };
  if (!outcome) {
    const error = new Error(`bounded spawn supervisor ${failure.error ? `failed: ${failure.error.message}` : `exited ${failure.status ?? failure.signal} without a result`}`) as NodeJS.ErrnoException;
    error.code = (failure.error as NodeJS.ErrnoException | undefined)?.code ?? "ESUPERVISOR";
    result.error = error;
    result.signal = failure.signal;
    return result;
  }
  if (outcome.error) {
    const error = new Error(outcome.error.message) as NodeJS.ErrnoException;
    if (outcome.error.code) error.code = outcome.error.code;
    result.error = error;
  }
  result.timedOut = outcome.timedOut;
  result.overflowed = outcome.overflowed;
  result.status = outcome.status;
  result.signal = outcome.killSignal ?? outcome.signal;
  return result;
}

/** Async bounded run. Always resolves; inspect `timedOut` / `error` / `status`. */
export function boundedSpawn(file: string, args: string[], opts: BoundedSpawnOptions = {}): Promise<BoundedSpawnResult> {
  const { spec, env, maxBuffer, backstopMs } = supervisorRequest(file, args, opts);
  return new Promise((resolve) => {
    const out: Buffer[] = [];
    const err: Buffer[] = [];
    let outLen = 0;
    let backstop: NodeJS.Timeout | null = null;
    let settled = false;
    const supervisor = spawn(process.execPath, ["-e", SUPERVISOR], { env, stdio: ["pipe", "pipe", "pipe"], windowsHide: true });
    const settle = (failure: { error?: Error; status: number | null; signal: NodeJS.Signals | null }): void => {
      if (settled) return;
      settled = true;
      if (backstop) { clearTimeout(backstop); backstop = null; }
      resolve(toResult(Buffer.concat(out).toString("utf8"), Buffer.concat(err).toString("utf8"), failure));
    };
    if (backstopMs) backstop = setTimeout(() => { backstop = null; supervisor.kill("SIGKILL"); }, backstopMs);
    supervisor.stdout.on("data", (d: Buffer) => { if (outLen <= maxBuffer) { out.push(d); outLen += d.length; } });
    supervisor.stderr.on("data", (d: Buffer) => { err.push(d); });
    supervisor.on("error", (error) => settle({ error, status: null, signal: null }));
    supervisor.on("close", (status, signal) => settle({ status, signal }));
    supervisor.stdin.on("error", () => { /* supervisor died early; close reports it */ });
    supervisor.stdin.end(spec);
  });
}

export interface BoundedSpawnSyncOptions extends Omit<BoundedSpawnOptions, "timeoutMs"> {
  /** Supervisor deadline (required: this helper exists to bound the call). */
  timeout: number;
  /** stdout: captured ("pipe", the default), discarded, or written straight to
   *  an open file descriptor. */
  stdout?: "pipe" | "ignore" | number;
}

/** Synchronous bounded run, spawnSync-shaped: never throws. */
export function boundedSpawnSync(file: string, args: string[], opts: BoundedSpawnSyncOptions): BoundedSpawnResult {
  const stdoutMode = opts.stdout ?? "pipe";
  const { spec, env, maxBuffer, backstopMs } = supervisorRequest(file, args, {
    ...opts,
    timeoutMs: opts.timeout,
    maxBuffer: opts.maxBuffer ?? 64 * 1024 * 1024,
    stdout: typeof stdoutMode === "number" ? "inherit" : stdoutMode,
  });
  const run = spawnSync(process.execPath, ["-e", SUPERVISOR], {
    input: spec,
    stdio: ["pipe", typeof stdoutMode === "number" ? stdoutMode : "pipe", "pipe"],
    env,
    windowsHide: true,
    maxBuffer: maxBuffer * 2 + 1024 * 1024,
    timeout: backstopMs,
  });
  return toResult(run.stdout ? run.stdout.toString("utf8") : "", run.stderr ? run.stderr.toString("utf8") : "", run);
}

/** Error thrown by boundedExecFileSync, shaped like execFileSync's: `code`
 *  ETIMEDOUT / ENOBUFS / ENOENT, or `status` + `signal` for a failed exit. */
export interface BoundedExecError extends Error {
  code?: string;
  status?: number | null;
  signal?: NodeJS.Signals | null;
  stdout: string;
  stderr: string;
}

/** Synchronous bounded exec: returns stdout (utf8) on exit 0, throws a
 *  BoundedExecError otherwise. On timeout the error carries
 *  `code: "ETIMEDOUT"` and the signal actually delivered to the tree. */
export function boundedExecFileSync(file: string, args: string[], opts: BoundedSpawnSyncOptions): string {
  const r = boundedSpawnSync(file, args, opts);
  const fail = (message: string, fields: Partial<BoundedExecError>): never => {
    const error = new Error(message) as BoundedExecError;
    Object.assign(error, { stdout: r.stdout, stderr: r.stderr, status: r.status, signal: r.signal }, fields);
    throw error;
  };
  if (r.timedOut) return fail(`${file} timed out after ${opts.timeout}ms`, { code: "ETIMEDOUT" });
  if (r.overflowed) return fail(`${file}: stdout exceeded maxBuffer`, { code: "ENOBUFS" });
  if (r.error) return fail(`${file}: ${r.error.message}`, { code: r.error.code ?? "ESPAWN" });
  if (r.status !== 0) return fail(`${file} exited ${r.status ?? r.signal}`, {});
  return r.stdout;
}
