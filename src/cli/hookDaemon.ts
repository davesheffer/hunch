/**
 * Opt-in hook daemon (HUNCH_HOOK_DAEMON=1): one warm process per (user, repository
 * root, build) runs the full `hook` handler, so a hook pays neither node's boot nor
 * the hook bundle's load. The client side is fail-open: any problem reaching the
 * daemon leaves the caller on today's in-process path, and a missing daemon is
 * started in the background after that hook has finished, never waited for.
 *
 * Requests run one at a time: a hook arriving while another runs is told "busy" and
 * runs in-process, as it would with no daemon. Each one gets the client's allow-listed
 * environment over a pristine snapshot, the client's cwd and a clean exit code; its
 * stdout and stderr (console.* included) are captured; everything is restored afterwards.
 *
 * Security: the endpoint lives in a per-user directory (POSIX: 0700, owned by the user,
 * not a symlink; Windows: the user's LOCALAPPDATA) and carries a random token in a 0600
 * file. The daemon proves it holds the token (HMAC over the client's nonce) before the
 * client sends the payload, and rejects any request without the token. It serves only the
 * repository root it was started for.
 */
import { createHash, createHmac, randomBytes, timingSafeEqual } from "node:crypto";
import { spawn } from "node:child_process";
import { appendFileSync, chmodSync, lstatSync, mkdirSync, readFileSync, realpathSync, renameSync, rmSync, statSync, writeFileSync } from "node:fs";
import { connect, createServer, type Server, type Socket } from "node:net";
import { homedir, tmpdir, userInfo } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { findRoot } from "../core/paths.js";
import { HUNCH_VERSION } from "../core/version.js";

const PROTOCOL = 3;
const CONNECT_BUDGET_MS = 50;
const HANDSHAKE_BUDGET_MS = 200;
const QUEUE_BUDGET_MS = 1000;
const GO_BUDGET_MS = 2000;
const FLUSH_BUDGET_MS = 2000;
/** Past every host's hook timeout (600s at most): its client is gone, and a daemon
 *  still stuck in that run exits so the next hook starts a fresh one. */
const RUN_DEADLINE_MS = 11 * 60_000;
const IDLE_EXIT_MS = 10 * 60_000;
const BUILD_POLL_MS = 5_000;
/** One start attempt per endpoint in this window: concurrent first hooks and a daemon
 *  that cannot start never turn into a spawn storm. */
const SPAWN_BACKOFF_MS = 15_000;
const MAX_MESSAGE_BYTES = 64 * 1024 * 1024;

/** Whether the opt-in switch is on. Env only: a config key would cost every hook a
 *  config read before it could even choose the path. */
export const hookDaemonEnabled = (env: NodeJS.ProcessEnv = process.env): boolean => env.HUNCH_HOOK_DAEMON === "1";

/** Environment a request carries. It replaces the daemon's own value of every
 *  matching name (absent in the request = absent for the request). TEMP/TMP/TMPDIR
 *  are mandatory: the hookcache and shell baseline live in os.tmpdir(). */
const ENV_PREFIXES = ["HUNCH_", "CLAUDE_", "GIT_", "LC_", "XDG_", "SSH_", "CODEX_", "VSCODE_"];
const ENV_NAMES = new Set([
  "TEMP", "TMP", "TMPDIR", "PATH", "PATHEXT", "HOME", "USERPROFILE", "HOMEDRIVE", "HOMEPATH",
  "APPDATA", "LOCALAPPDATA", "LANG", "LANGUAGE", "CI", "NO_UPDATE_NOTIFIER", "NODE_OPTIONS", "NODE_TEST_CONTEXT",
  "TERM", "NO_COLOR", "FORCE_COLOR", "COLUMNS", "TERM_PROGRAM", "COLORTERM", "CLAUDECODE", "COMSPEC",
]);
const envKey = (name: string): string => process.platform === "win32" ? name.toUpperCase() : name;
export const allowListed = (name: string): boolean => {
  const key = envKey(name);
  return ENV_NAMES.has(key) || ENV_PREFIXES.some((prefix) => key.startsWith(prefix));
};

type Env = Record<string, string>;
interface HookRequest { v: number; buildId: string; provider: string; cwd: string; root: string; env: Env; token: string; payload: string }
interface HookReply { stdout: string; stderr: string; exitCode: number }
/** What the daemon runs for one request: the same function the in-process path runs.
 *  It owns the per-request reset (core/hookMemo.ts) and closing whatever it opened. */
export type HookHandler = (provider: string, payload: string) => Promise<void>;

const bundleEntry = (): string => fileURLToPath(new URL("./hook.bundle.js", import.meta.url));

/** Package version plus the size and mtime of dist/cli/hook.bundle.js: a rebuilt CLI
 *  never talks to a daemon running the old build. Null (no daemon) when unreadable,
 *  which is also the case for a source checkout run without a build. */
function buildId(): string | null {
  try {
    const st = statSync(bundleEntry());
    return `${HUNCH_VERSION}:${st.size}:${st.mtimeMs}`;
  } catch {
    return null;
  }
}

function canonicalRoot(root: string): string {
  let real = root;
  try { real = realpathSync.native(root); } catch { /* not there yet: the lexical root */ }
  return process.platform === "win32" ? real.toLowerCase() : real;
}

/** The endpoint, its token file and the spawn marker for one (user, root, build). */
function endpointFor(root: string, build: string): { path: string; dir: string; token: string; spawned: string } {
  let user = "";
  try { user = userInfo().username; } catch { /* no passwd entry */ }
  const uid = process.getuid?.() ?? user;
  const h = createHash("sha256").update(`${user}\0${uid}\0${canonicalRoot(root)}\0${build}`).digest("hex").slice(0, 32);
  if (process.platform === "win32") {
    const dir = join(process.env.LOCALAPPDATA || join(homedir(), "AppData", "Local"), "hunch", "hook-daemon");
    return { path: `\\\\.\\pipe\\hunch-${h}`, dir, token: join(dir, `${h}.token`), spawned: join(dir, `${h}.spawn`) };
  }
  const dir = join(tmpdir(), `hunch-${uid}`);
  return { path: join(dir, `${h}.sock`), dir, token: join(dir, `${h}.token`), spawned: join(dir, `${h}.spawn`) };
}

function ensurePrivateDir(dir: string): void {
  mkdirSync(dir, { recursive: true, mode: 0o700 });
  if (process.platform !== "win32") chmodSync(dir, 0o700);
}

/** Diagnostics only, and only when HUNCH_HOOK_DAEMON_LOG names a file. */
function debugLog(line: string): void {
  const file = process.env.HUNCH_HOOK_DAEMON_LOG;
  if (!file) return;
  try { appendFileSync(file, `${new Date().toISOString()} ${process.pid} ${line}\n`); } catch { /* diagnostics only */ }
}

/** Hex HMAC-SHA256 of `nonce` keyed by the daemon token: a server proves it read the token file. */
export function proofFor(token: string, nonce: string): string {
  return createHmac("sha256", token).update(nonce).digest("hex");
}

/** POSIX: the endpoint dir must be ours alone (a real dir, not a symlink, no group/other bits). */
function dirState(dir: string): "ok" | "missing" | "bad" {
  if (process.platform === "win32") return "ok";
  try {
    const st = lstatSync(dir);
    return st.isDirectory() && !st.isSymbolicLink() && st.uid === process.getuid?.() && (st.mode & 0o077) === 0 ? "ok" : "bad";
  } catch (e) {
    return (e as NodeJS.ErrnoException).code === "ENOENT" ? "missing" : "bad";
  }
}

/** Sequential newline-terminated JSON messages from one socket; leftover bytes stay
 *  buffered for the next call. `next` gives null on close/overflow/garbage/timeout. */
export function lineReader(socket: Socket): { next<T>(ms?: number): Promise<T | null> } {
  let buf = "";
  let ended = false;
  let waiter: ((line: string | null) => void) | null = null;
  const pump = (): void => {
    if (!waiter) return;
    const end = buf.indexOf("\n");
    let line: string | null;
    if (end >= 0) { line = buf.slice(0, end); buf = buf.slice(end + 1); } else if (ended) line = null; else return;
    const w = waiter;
    waiter = null;
    w(line);
  };
  const stop = (): void => { ended = true; pump(); };
  socket.setEncoding("utf8");
  socket.on("data", (chunk: string) => {
    buf += chunk;
    if (buf.length > MAX_MESSAGE_BYTES) { buf = ""; socket.destroy(); stop(); } else pump();
  });
  socket.on("end", stop);
  socket.on("close", stop);
  socket.on("error", stop);
  return {
    next<T>(ms?: number): Promise<T | null> {
      return new Promise((resolve) => {
        const timer = ms === undefined ? undefined : setTimeout(() => { waiter = null; resolve(null); }, ms);
        waiter = (line) => {
          if (timer) clearTimeout(timer);
          if (line === null) return resolve(null);
          try { resolve(JSON.parse(line) as T); } catch { resolve(null); }
        };
        pump();
      });
    },
  };
}

// ---- client ------------------------------------------------------------------

function connectWithin(path: string, ms: number): Promise<{ socket?: Socket; code?: string }> {
  return new Promise((resolve) => {
    const socket = connect(path);
    const timer = setTimeout(() => { socket.destroy(); resolve({ code: "TIMEOUT" }); }, ms);
    socket.once("connect", () => { clearTimeout(timer); resolve({ socket }); });
    socket.once("error", (e: NodeJS.ErrnoException) => { clearTimeout(timer); resolve({ code: e.code ?? "ERROR" }); });
  });
}

/** `hook-daemon-host <root>` (Windows): a detached start has no console, so every
 *  console child the daemon runs (git.exe) would open a new console window, visible
 *  and slow. This console-less host runs the daemon with CREATE_NO_WINDOW (windowsHide,
 *  no inherited stdio): one hidden console its children inherit. The daemon sits in the
 *  host's kill-on-close job, so the two live and die together. */
export function runHookDaemonHost(root: string): void {
  const child = spawn(process.execPath, [bundleEntry(), "hook-daemon", root], { cwd: root, stdio: "ignore", windowsHide: true });
  child.on("exit", (code) => process.exit(code ?? 0));
  child.on("error", () => process.exit(0));
}

/** Claim the one start attempt per backoff window. The marker is created exclusively,
 *  so of any number of concurrent first hooks exactly one wins; a marker older than the
 *  window (the daemon never came up, or died) is replaced. */
function claimSpawn(spawned: string): boolean {
  for (let attempt = 0; attempt < 2; attempt++) {
    try {
      writeFileSync(spawned, String(process.pid), { mode: 0o600, flag: "wx" });
      return true;
    } catch (e) {
      if ((e as NodeJS.ErrnoException).code !== "EEXIST") return false;
      try {
        if (Date.now() - statSync(spawned).mtimeMs < SPAWN_BACKOFF_MS) return false;
        rmSync(spawned, { force: true });
      } catch { return false; }
    }
  }
  return false;
}

/** Start a daemon for `root` in the background, once this hook process is done: the
 *  hook itself runs in-process meanwhile and the daemon's boot never competes with it. */
function spawnDaemonAfterExit(root: string, endpoint: { dir: string; spawned: string }): void {
  process.once("exit", () => {
    try {
      ensurePrivateDir(endpoint.dir);
      if (dirState(endpoint.dir) !== "ok" || !claimSpawn(endpoint.spawned)) return;
      const entry = process.platform === "win32" ? "hook-daemon-host" : "hook-daemon";
      const child = spawn(process.execPath, [bundleEntry(), entry, root], {
        cwd: root, detached: true, stdio: "ignore", windowsHide: true,
      });
      child.on("error", () => { /* fail-open: the in-process path already ran */ });
      child.unref();
      debugLog(`spawn ${root}`);
    } catch { /* fail-open */ }
  });
}

/** Run this hook through the daemon. True when its reply was written out; false
 *  means the caller runs the in-process handler, exactly as with no daemon. Never throws. */
export async function tryHookDaemon(provider: string, payload: string): Promise<boolean> {
  try {
    return await attempt(provider, payload);
  } catch (e) {
    debugLog(`client error ${e instanceof Error ? e.message : String(e)}`);
    return false;
  }
}

async function attempt(provider: string, payload: string): Promise<boolean> {
  const build = buildId();
  if (!build) return false;
  const root = findRoot();
  const endpoint = endpointFor(root, build);
  const fallback = (reason: string): false => {
    debugLog(`fallback ${reason}`);
    return false;
  };
  const dir = dirState(endpoint.dir);
  if (dir !== "ok") {
    if (dir === "missing") spawnDaemonAfterExit(root, endpoint);
    return fallback("dir");
  }
  const { socket, code } = await connectWithin(endpoint.path, CONNECT_BUDGET_MS);
  if (!socket) {
    if (code === "ENOENT" || code === "ECONNREFUSED") spawnDaemonAfterExit(root, endpoint);
    return fallback(`connect:${code}`);
  }
  let token: string;
  try { token = readFileSync(endpoint.token, "utf8").trim(); } catch { socket.destroy(); return fallback("token"); }
  const reader = lineReader(socket);
  // The server must prove it holds the token before the payload is sent to it.
  const nonce = randomBytes(16).toString("hex");
  socket.write(`${JSON.stringify({ v: PROTOCOL, hello: nonce })}\n`);
  const hello = await reader.next<{ proof?: unknown }>(HANDSHAKE_BUDGET_MS);
  if (!hello) { socket.destroy(); return fallback("handshake"); }
  const want = Buffer.from(proofFor(token, nonce)), got = Buffer.from(typeof hello.proof === "string" ? hello.proof : "");
  if (want.length !== got.length || !timingSafeEqual(want, got)) { socket.destroy(); return fallback("proof"); }
  const env: Env = {};
  for (const [name, value] of Object.entries(process.env)) if (value !== undefined && allowListed(name)) env[name] = value;
  const request: HookRequest = { v: PROTOCOL, buildId: build, provider, cwd: process.cwd(), root, env, token, payload };
  socket.write(`${JSON.stringify(request)}\n`);
  const ready = await reader.next<{ ready?: boolean; error?: string }>(QUEUE_BUDGET_MS);
  if (!ready || ready.ready !== true) { socket.destroy(); return fallback(`queue:${ready?.error ?? "none"}`); }
  // Past `go` the daemon runs the hook: never fall back (it would run twice), never time out.
  socket.write(`${JSON.stringify({ go: true })}\n`);
  const reply = await reader.next<HookReply & { error?: string }>();
  socket.destroy();
  if (!reply || reply.error !== undefined || typeof reply.stdout !== "string" || typeof reply.stderr !== "string"
    || !Number.isInteger(reply.exitCode)) {
    process.stderr.write("hunch: hook daemon lost the reply\n");
    debugLog(`lost reply:${reply?.error ?? "malformed"}`);
    return true;
  }
  if (reply.stdout) process.stdout.write(reply.stdout);
  if (reply.stderr) process.stderr.write(reply.stderr);
  if (reply.exitCode !== 0) process.exitCode = reply.exitCode;
  debugLog("served");
  return true;
}

// ---- daemon ------------------------------------------------------------------

/** Make process.env exactly `target` (Windows names compare case-insensitively). */
function setEnv(target: Env): void {
  const keep = new Set(Object.keys(target).map(envKey));
  for (const name of Object.keys(process.env)) if (!keep.has(envKey(name))) delete process.env[name];
  for (const [name, value] of Object.entries(target)) if (process.env[name] !== value) process.env[name] = value;
}

function requestEnv(pristine: Env, requested: Env): Env {
  const env: Env = {};
  for (const [name, value] of Object.entries(pristine)) if (!allowListed(name)) env[name] = value;
  for (const [name, value] of Object.entries(requested)) if (allowListed(name) && typeof value === "string") env[name] = value;
  return env;
}

function sameToken(a: string, b: string): boolean {
  const x = Buffer.from(a), y = Buffer.from(b);
  return x.length === y.length && timingSafeEqual(x, y);
}

function listen(server: Server, path: string): Promise<boolean> {
  return new Promise((resolve) => {
    // EADDRINUSE is the single-instance bind lost; any other error is no daemon either.
    server.once("error", () => resolve(false));
    server.listen(path, () => resolve(true));
  });
}

/** `hook-daemon <root>`: serve full-handler hooks for one repository root until idle,
 *  a rebuild, or a lost single-instance bind. `handle` is the in-process hook handler. */
export async function runHookDaemon(root: string, handle: HookHandler): Promise<void> {
  const build = buildId();
  if (!build) return;
  const endpoint = endpointFor(root, build);
  const served = canonicalRoot(root);
  const pristineEnv: Env = {};
  for (const [name, value] of Object.entries(process.env)) if (value !== undefined) pristineEnv[name] = value;
  const pristineCwd = process.cwd();

  try { ensurePrivateDir(endpoint.dir); } catch { return; }
  if (dirState(endpoint.dir) !== "ok") return;
  const token = randomBytes(32).toString("hex");
  let queue: Promise<unknown> = Promise.resolve();
  let idle: NodeJS.Timeout | undefined;
  let closing = false;
  let pending = 0;
  let stopped: Promise<void> | undefined;
  let crash: ((error: string) => void) | undefined;

  const execute = async (request: HookRequest): Promise<HookReply> => {
    const stdout: string[] = [], stderr: string[] = [];
    const capture = (sink: string[]) => ((chunk: string | Uint8Array, encoding?: unknown, callback?: unknown): boolean => {
      sink.push(typeof chunk === "string" ? chunk : Buffer.from(chunk).toString(typeof encoding === "string" ? encoding as BufferEncoding : "utf8"));
      const done = typeof encoding === "function" ? encoding : callback;
      if (typeof done === "function") queueMicrotask(() => (done as () => void)());
      return true;
    }) as typeof process.stdout.write;
    const writeOut = process.stdout.write, writeErr = process.stderr.write;
    let exitCode = 0;
    setEnv(requestEnv(pristineEnv, request.env));
    try {
      process.chdir(request.cwd);
      process.exitCode = undefined;
      process.stdout.write = capture(stdout);
      process.stderr.write = capture(stderr);
      const crashed = new Promise<string>((resolve) => { crash = resolve; });
      const fatal = await Promise.race([handle(request.provider, request.payload).then(() => undefined), crashed]);
      if (fatal !== undefined) { stderr.push(`${fatal}\n`); process.exitCode = 1; }
      exitCode = Number(process.exitCode ?? 0) || 0;
    } finally {
      crash = undefined;
      process.stdout.write = writeOut;
      process.stderr.write = writeErr;
      process.exitCode = undefined;
      setEnv(pristineEnv);
      try { process.chdir(pristineCwd); } catch { /* the next request sets its own */ }
    }
    return { stdout: stdout.join(""), stderr: stderr.join(""), exitCode };
  };

  /** Stop accepting, let the running request finish and answer the queued ones "closing", then exit. */
  const shutdown = (): Promise<void> => {
    if (stopped) return stopped;
    closing = true;
    server.close();
    stopped = (async () => {
      do { await queue; } while (pending > 0);
      try { if (readFileSync(endpoint.token, "utf8").trim() === token) rmSync(endpoint.token, { force: true }); } catch { /* gone */ }
      process.exit(0);
    })();
    return stopped;
  };
  const touch = (): void => {
    if (idle) clearTimeout(idle);
    idle = setTimeout(() => { if (pending > 0) touch(); else void shutdown(); }, IDLE_EXIT_MS);
  };
  const onFatal = (kind: string) => (e: unknown): void => {
    const text = e instanceof Error ? (e.stack ?? e.message) : String(e);
    debugLog(`${kind} ${text}`);
    crash?.(`hunch: ${kind}: ${text}`);
    void shutdown();
  };
  process.on("uncaughtException", onFatal("uncaughtException"));
  process.on("unhandledRejection", onFatal("unhandledRejection"));

  /** One queued request: announce `ready`, run only once the client answers `go`. */
  const serve = async (socket: Socket, reader: ReturnType<typeof lineReader>, request: HookRequest): Promise<void> => {
    try {
      if (closing || socket.destroyed) {
        if (!socket.destroyed) socket.end(`${JSON.stringify({ error: "closing" })}\n`);
        return;
      }
      socket.write(`${JSON.stringify({ ready: true })}\n`);
      const go = await reader.next<{ go?: boolean }>(GO_BUDGET_MS);
      if (!go || go.go !== true) { socket.destroy(); return; }
      let reply: HookReply | { error: string };
      const started = Date.now();
      const watchdog = setTimeout(() => { debugLog(`stuck ${RUN_DEADLINE_MS}ms`); process.exit(1); }, RUN_DEADLINE_MS);
      try { reply = await execute(request); } catch (e) { reply = { error: `run:${e instanceof Error ? e.message : String(e)}` }; }
      finally { clearTimeout(watchdog); }
      debugLog(`run ${Date.now() - started}ms`);
      // A shutdown waits for this: the reply is flushed before the process may exit.
      if (!socket.destroyed) await new Promise<void>((resolve) => {
        const timer = setTimeout(resolve, FLUSH_BUDGET_MS);
        socket.end(`${JSON.stringify(reply)}\n`, () => { clearTimeout(timer); resolve(); });
      });
    } finally {
      pending--;
      touch();
    }
  };

  /** The repository root a hook run from `cwd` belongs to, or null when `cwd` is not usable. */
  const rootOf = (cwd: string): string | null => {
    try { return canonicalRoot(findRoot(cwd)); } catch { return null; }
  };

  const server = createServer((socket) => {
    socket.on("error", () => { /* the client gave up; it runs in-process */ });
    const reader = lineReader(socket);
    void (async () => {
      const hello = await reader.next<{ v?: number; hello?: unknown }>(GO_BUDGET_MS);
      if (!hello || hello.v !== PROTOCOL || typeof hello.hello !== "string" || !/^[0-9a-f]{32}$/.test(hello.hello)) {
        socket.destroy();
        return;
      }
      socket.write(`${JSON.stringify({ proof: proofFor(token, hello.hello) })}\n`);
      const request = await reader.next<HookRequest>(GO_BUDGET_MS);
      if (!request || request.v !== PROTOCOL || typeof request.token !== "string" || !sameToken(request.token, token)) {
        socket.end(`${JSON.stringify({ error: "rejected" })}\n`);
        return;
      }
      if (request.buildId !== build) {
        socket.end(`${JSON.stringify({ error: "build" })}\n`);
        void shutdown();
        return;
      }
      if (typeof request.provider !== "string" || typeof request.cwd !== "string" || typeof request.payload !== "string"
        || !request.env || typeof request.env !== "object") {
        socket.end(`${JSON.stringify({ error: "malformed" })}\n`);
        return;
      }
      // Only the root this daemon was started for: a request from anywhere else runs in-process.
      if (rootOf(request.cwd) !== served) {
        socket.end(`${JSON.stringify({ error: "root" })}\n`);
        return;
      }
      if (closing) { socket.end(`${JSON.stringify({ error: "closing" })}\n`); return; }
      // Concurrent hooks (parallel tool calls) and a stuck run cost only the handshake.
      if (pending > 0) { socket.end(`${JSON.stringify({ error: "busy" })}\n`); return; }
      pending++;
      touch();
      queue = queue.then(() => serve(socket, reader, request)).catch(() => {});
    })();
  });

  if (!await listen(server, endpoint.path)) {
    // POSIX keeps a dead daemon's socket file; take it over only if nobody answers.
    if (process.platform === "win32") return process.exit(0);
    const probe = await connectWithin(endpoint.path, 200);
    if (probe.socket) { probe.socket.destroy(); return process.exit(0); }
    if (probe.code !== "ECONNREFUSED") return process.exit(0);
    rmSync(endpoint.path, { force: true });
    if (!await listen(server, endpoint.path)) return process.exit(0);
  }
  if (process.platform !== "win32") chmodSync(endpoint.path, 0o600);
  const temp = `${endpoint.token}.${process.pid}`;
  writeFileSync(temp, token, { mode: 0o600 });
  renameSync(temp, endpoint.token);
  debugLog("listening");
  touch();
  setInterval(() => { if (buildId() !== build) void shutdown(); }, BUILD_POLL_MS).unref();
}
