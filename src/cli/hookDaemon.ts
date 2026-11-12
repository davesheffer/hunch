/**
 * Hook daemon (default on; HUNCH_HOOK_DAEMON=0 opts out): one warm process per (user, repository
 * root, build) runs the full `hook` handler, so a hook pays neither node's boot nor
 * the hook bundle's load. The client side is fail-open: any problem reaching the
 * daemon leaves the caller on today's in-process path, and a missing daemon is
 * started in the background after that hook has finished, never waited for.
 *
 * Requests run one at a time: a hook arriving while another runs sees the daemon's busy
 * marker (or is told "busy") and runs in-process, as it would with no daemon. Each one gets the client's allow-listed
 * environment over a pristine snapshot, the client's cwd and a clean exit code; its
 * stdout and stderr (console.* included) are captured; everything is restored afterwards.
 *
 * Security: the endpoint lives in a per-user directory (POSIX: 0700, owned by the user,
 * not a symlink; Windows: the user's LOCALAPPDATA) and carries a random token in a 0600
 * file. The daemon proves it holds the token (HMAC over the client's nonce) before the
 * client sends the payload, and drops any request without the token. It serves only the
 * repository root it was started for. A connection must send its hello within
 * HELLO_BUDGET_MS and HELLO_MAX_BYTES; the hello carries no secret, so a peer that can open
 * the endpoint may then send one request line (at most MAX_MESSAGE_BYTES, within
 * GO_BUDGET_MS), dropped unless it carries the token. Without the token a peer never takes
 * the run slot: at worst it pushes hooks onto the in-process path, never runs or sees one.
 *
 * A hook the daemon may already have run is never re-run: if the daemon dies after the
 * client's `go`, that hook is reported lost on stderr and exits 0, because running it again
 * could repeat its side effects (task records, captures).
 */
import { createHash, createHmac, randomBytes, timingSafeEqual } from "node:crypto";
import { spawn } from "node:child_process";
import { appendFileSync, chmodSync, linkSync, lstatSync, mkdirSync, readFileSync, realpathSync, renameSync, rmSync, statSync, writeFileSync } from "node:fs";
import { connect, createServer, type Server, type Socket } from "node:net";
import { homedir, tmpdir, userInfo } from "node:os";
import { isAbsolute, join, posix, resolve } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { findRoot } from "../core/paths.js";
import { hookSwitch } from "../core/hookSwitches.js";
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
/** What an unauthenticated connection may cost the daemon before it is dropped: a
 *  client sends its hello right after connecting, and it is under 100 bytes. */
const HELLO_BUDGET_MS = 500;
const HELLO_MAX_BYTES = 1024;
/** A busy marker this old is checked against the endpoint before it is believed: a daemon
 *  killed mid-run leaves its marker, and its pid may since belong to another process. */
const BUSY_VERIFY_MS = 5_000;

/** Whether the daemon is on: HUNCH_HOOK_DAEMON, then `.hunch/config.json` hooks.daemon,
 *  then on (src/core/hookSwitches.ts). The shim routes to the client unless the env says
 *  off; the client asks this with the root before contacting a daemon. */
export const hookDaemonEnabled = (env: NodeJS.ProcessEnv = process.env, root?: string): boolean => hookSwitch("daemon", root, env).value === true;

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
/** Thrown before the handler starts: the client may safely run the hook in-process. */
class NotRun extends Error {}
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

/** Windows: a per-user random secret mixed into the pipe name. Any local user can create
 *  names under \\.\pipe\, so a name derived only from public facts (user, root, build)
 *  could be squatted; the secret lives in the per-user LOCALAPPDATA dir. Published with
 *  link() so a concurrent reader never sees a half-written file. Null: none yet (`create`
 *  false) or unreadable. */
function pipeSecret(dir: string, create: boolean): string | null {
  const file = join(dir, "pipe.secret");
  const read = (): string | null => {
    try {
      const text = readFileSync(file, "utf8").trim();
      return /^[0-9a-f]{64}$/.test(text) ? text : null;
    } catch { return null; }
  };
  const existing = read();
  if (existing || !create) return existing;
  const temp = `${file}.${process.pid}`;
  try {
    writeFileSync(temp, randomBytes(32).toString("hex"), { mode: 0o600 });
    try { linkSync(temp, file); } catch { /* a concurrent daemon published first */ }
  } catch { /* unwritable: no daemon */ } finally {
    try { rmSync(temp, { force: true }); } catch { /* gone */ }
  }
  return read();
}

interface Endpoint { path: string; dir: string; id: string; token: string; spawned: string; busy: string }

/** The endpoint, its token file, the spawn marker and the busy marker for one (user, root,
 *  build). On Windows `path` is empty until the per-user pipe secret exists (only a daemon
 *  creates it). */
function endpointFor(root: string, build: string, createSecret = false): Endpoint {
  let user = "";
  try { user = userInfo().username; } catch { /* no passwd entry */ }
  const uid = process.getuid?.() ?? user;
  const h = createHash("sha256").update(`${user}\0${uid}\0${canonicalRoot(root)}\0${build}`).digest("hex").slice(0, 32);
  // A relative base would resolve differently in the client (repo cwd) and the daemon
  // (endpoint-dir cwd), so the two would never meet: such a base falls back to the default.
  if (process.platform === "win32") {
    const local = process.env.LOCALAPPDATA;
    const dir = join(local && isAbsolute(local) ? local : join(homedir(), "AppData", "Local"), "hunch", "hook-daemon");
    if (createSecret) { try { ensurePrivateDir(dir); } catch { /* pipeSecret then finds no dir */ } }
    const secret = pipeSecret(dir, createSecret);
    return { path: secret ? pipePath(secret, h) : "", dir, ...files(dir, h) };
  }
  const tmp = tmpdir();
  const dir = posixEndpointDir(isAbsolute(tmp) ? tmp : "/tmp", uid, h);
  return { path: join(dir, `${h}.sock`), dir, ...files(dir, h) };
}
const files = (dir: string, h: string) => ({ id: h, token: join(dir, `${h}.token`), spawned: join(dir, `${h}.spawn`), busy: join(dir, `${h}.busy`) });
const pipePath = (secret: string, h: string): string =>
  `\\\\.\\pipe\\hunch-${createHash("sha256").update(`${secret}\0${h}`).digest("hex").slice(0, 32)}`;

/** Whether the daemon is running a hook right now. It cannot answer a handshake while
 *  that hook does synchronous work, so a concurrent hook would spend its whole handshake
 *  budget only to be told "busy": the marker lets it go in-process at once. A marker left
 *  by a daemon that died (pid gone) or older than any run is ignored ("no"); one older than
 *  BUSY_VERIFY_MS is "verify": believed only if the endpoint still answers. */
function daemonBusy(file: string): "no" | "yes" | "verify" {
  try {
    const age = Date.now() - statSync(file).mtimeMs;
    if (age > RUN_DEADLINE_MS) return "no";
    const pid = Number(readFileSync(file, "utf8"));
    if (!Number.isInteger(pid) || pid <= 0) return "no";
    try { process.kill(pid, 0); } catch (e) { if ((e as NodeJS.ErrnoException).code !== "EPERM") return "no"; }
    return age > BUSY_VERIFY_MS ? "verify" : "yes";
  } catch {
    return "no";
  }
}

/** POSIX endpoint dir for socket `<h>.sock`. sun_path holds 104 bytes on macOS/BSD and
 *  108 on Linux, NUL included: a long TMPDIR (macOS /var/folders/…, a nested temp dir)
 *  makes bind fail and the daemon never start, so such a path falls back to /tmp — what
 *  tmpdir() already is on Linux. dirState still demands an owned, 0700, non-symlink dir. */
export function posixEndpointDir(tmp: string, uid: string | number, h: string, platform: NodeJS.Platform = process.platform): string {
  const dir = posix.join(tmp, `hunch-${uid}`);
  const max = platform === "linux" ? 107 : 103;
  return Buffer.byteLength(posix.join(dir, `${h}.sock`)) > max ? posix.join("/tmp", `hunch-${uid}`) : dir;
}

function ensurePrivateDir(dir: string): void {
  if (mkdirSync(dir, { recursive: true, mode: 0o700 }) !== undefined || process.platform === "win32") return;
  // Pre-existing: tighten it only when it is a real directory we own. chmod follows a
  // symlink, so one planted at this path must never be chmodded (dirState rejects it).
  const st = lstatSync(dir);
  if (st.isDirectory() && !st.isSymbolicLink() && st.uid === process.getuid?.()) chmodSync(dir, 0o700);
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
 *  buffered for the next call. `next` gives null on close/overflow/garbage/timeout.
 *  A message longer than `maxBytes` (UTF-8 bytes, settable between messages) drops the
 *  connection. Each byte is scanned once: a large request costs linear time. */
export function lineReader(socket: Socket, maxBytes = MAX_MESSAGE_BYTES): { next<T>(ms?: number): Promise<T | null>; maxBytes: number } {
  let partial: Buffer[] = [];
  let size = 0;
  const lines: string[] = [];
  let ended = false;
  let waiter: ((line: string | null) => void) | null = null;
  const pump = (): void => {
    if (!waiter) return;
    let line: string | null;
    if (lines.length) line = lines.shift()!; else if (ended) line = null; else return;
    const w = waiter;
    waiter = null;
    w(line);
  };
  const stop = (): void => { ended = true; pump(); };
  const overflow = (): void => { partial = []; size = 0; lines.length = 0; socket.destroy(); stop(); };
  socket.on("data", (chunk: Buffer | string) => {
    if (ended) return;
    let data = typeof chunk === "string" ? Buffer.from(chunk) : chunk;
    for (let at = data.indexOf(0x0a); at >= 0; at = data.indexOf(0x0a)) {
      if (size + at > reader.maxBytes) return overflow();
      partial.push(data.subarray(0, at));
      lines.push(Buffer.concat(partial, size + at).toString("utf8"));
      partial = [];
      size = 0;
      data = data.subarray(at + 1);
    }
    if (data.length) {
      size += data.length;
      if (size > reader.maxBytes) return overflow();
      partial.push(data);
    }
    pump();
  });
  socket.on("end", stop);
  socket.on("close", stop);
  socket.on("error", stop);
  const reader = {
    maxBytes,
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
  return reader;
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
 *  host's kill-on-close job, so the two live and die together. The client starts the
 *  host in the endpoint dir, so neither ever holds the repository as its cwd. */
export function runHookDaemonHost(root: string): void {
  const child = spawn(process.execPath, [bundleEntry(), "hook-daemon", root], { stdio: "ignore", windowsHide: true });
  child.on("exit", (code) => process.exit(code ?? 0));
  child.on("error", () => process.exit(0));
}

const PRELOAD_FLAGS = new Set(["--require", "-r", "--import", "--loader", "--experimental-loader"]);

/** NODE_OPTIONS with every relative preload (`--require ./x`, `--import=./y`, ...) made absolute
 *  against `cwd`. The daemon boots in its endpoint dir, never the repository (Windows: a process
 *  whose cwd is the repository keeps it from being renamed or removed), yet a relative preload
 *  must resolve as it does for an in-process hook. The value is returned unchanged unless a
 *  preload was rewritten. Parsing follows node's: whitespace separates, double quotes group,
 *  and a backslash escapes the next character only inside quotes. */
export function anchorNodeOptions(options: string, cwd: string): string {
  const tokens: string[] = [];
  let token: string | null = null, quoted = false;
  for (let i = 0; i < options.length; i++) {
    const c = options[i]!;
    if (quoted && c === "\\" && i + 1 < options.length) { token = (token ?? "") + options[++i]; continue; }
    if (c === '"') { quoted = !quoted; token = token ?? ""; continue; }
    if (!quoted && /\s/.test(c)) { if (token !== null) tokens.push(token); token = null; continue; }
    token = (token ?? "") + c;
  }
  if (token !== null) tokens.push(token);
  const anchor = (flag: string, value: string): string => {
    if (!/^\.\.?[\\/]/.test(value)) return value;
    const abs = resolve(cwd, value);
    return flag === "--require" || flag === "-r" ? abs : pathToFileURL(abs).href;
  };
  let changed = false;
  const out = tokens.map((t, i) => {
    const prev = tokens[i - 1];
    let next = t;
    if (prev !== undefined && PRELOAD_FLAGS.has(prev)) next = anchor(prev, t);
    else {
      const eq = t.indexOf("=");
      if (eq > 0 && PRELOAD_FLAGS.has(t.slice(0, eq))) next = `${t.slice(0, eq)}=${anchor(t.slice(0, eq), t.slice(eq + 1))}`;
    }
    if (next !== t) changed = true;
    return next;
  });
  if (!changed) return options;
  return out.map((t) => (t === "" || /[\s"\\]/.test(t) ? `"${t.replace(/[\\"]/g, "\\$&")}"` : t)).join(" ");
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
      // Started in its endpoint dir, never this hook's cwd (Windows: even a booting process
      // would hold the repository against rename/remove). What resolves against the hook's
      // cwd (a relative diagnostics log, relative preloads) is pinned to it first.
      let here = endpoint.dir;
      try { here = process.cwd(); } catch { /* the hook's cwd is gone: nothing relative resolves */ }
      const env: NodeJS.ProcessEnv = { ...process.env };
      if (env.HUNCH_HOOK_DAEMON_LOG) env.HUNCH_HOOK_DAEMON_LOG = resolve(here, env.HUNCH_HOOK_DAEMON_LOG);
      if (env.NODE_OPTIONS) env.NODE_OPTIONS = anchorNodeOptions(env.NODE_OPTIONS, here);
      const child = spawn(process.execPath, [bundleEntry(), entry, root], {
        cwd: endpoint.dir, detached: true, stdio: "ignore", windowsHide: true, env,
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
  if (!endpoint.path) {
    spawnDaemonAfterExit(root, endpoint);
    return fallback("secret");
  }
  const busy = daemonBusy(endpoint.busy);
  if (busy === "yes") return fallback("busy");
  const { socket, code } = await connectWithin(endpoint.path, CONNECT_BUDGET_MS);
  if (!socket) {
    // Nobody there (a busy marker's daemon included: it died mid-run): start one.
    if (code === "ENOENT" || code === "ECONNREFUSED") spawnDaemonAfterExit(root, endpoint);
    return fallback(`connect:${code}`);
  }
  // A long run is still a run: the endpoint answered, so the marker's daemon is alive.
  if (busy === "verify") { socket.destroy(); return fallback("busy"); }
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
  const reply = await reader.next<HookReply & { error?: string; ran?: boolean }>();
  socket.destroy();
  // The daemon could not even start this hook (its cwd is gone): nothing ran, so run it here.
  if (reply?.ran === false) return fallback(`notrun:${reply.error ?? ""}`);
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
    server.once("error", (e: NodeJS.ErrnoException) => { debugLog(`listen ${e.code ?? "error"}`); resolve(false); });
    server.listen(path, () => resolve(true));
  });
}

/** `hook-daemon <root>`: serve full-handler hooks for one repository root until idle,
 *  a rebuild, or a lost single-instance bind. `handle` is the in-process hook handler. */
export async function runHookDaemon(root: string, handle: HookHandler): Promise<void> {
  const build = buildId();
  if (!build) return;
  const endpoint = endpointFor(root, build, true);
  if (!endpoint.path) return;
  const served = canonicalRoot(root);
  const pristineEnv: Env = {};
  for (const [name, value] of Object.entries(process.env)) if (value !== undefined) pristineEnv[name] = value;
  // Workers the handler spawns (sibling-warm) re-run `process.argv[1]` with a hidden
  // command the hook bundle this daemon runs from does not route: point it at the CLI
  // entry beside the bundle, as in a hook process.
  process.argv[1] = fileURLToPath(new URL("./index.js", import.meta.url));

  try { ensurePrivateDir(endpoint.dir); } catch { return; }
  if (dirState(endpoint.dir) !== "ok") return;
  // Between requests the daemon sits in its endpoint dir, never in a repository it would
  // keep busy (Windows: rename/remove fails while a process has it as cwd).
  const pristineCwd = endpoint.dir;
  try { process.chdir(pristineCwd); } catch { return; }
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
    try { process.chdir(request.cwd); } catch (e) { throw new NotRun(e instanceof Error ? e.message : String(e)); }
    setEnv(requestEnv(pristineEnv, request.env));
    try {
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

  /** Whether clients still reach this daemon at the shared endpoint. POSIX: the socket
   *  file this daemon published, by identity. Closing a server makes libuv unlink the path
   *  it was bound to, and another daemon may have published its own socket at the shared
   *  path since (a racing start, or one started after a temp cleaner removed ours): so the
   *  server is bound to a private name, moved into place, and the shared path is unlinked
   *  only while it is still this very socket. Windows: the pipe name still derives from the
   *  current per-user secret; once that is gone or replaced, clients look for (and start) a
   *  daemon on another pipe, which shares this one's token file. */
  let bound: { dev: number; ino: number } | undefined;
  const owned = (): boolean => {
    if (process.platform === "win32") {
      const secret = pipeSecret(endpoint.dir, false);
      return secret !== null && pipePath(secret, endpoint.id) === endpoint.path;
    }
    try {
      const st = lstatSync(endpoint.path);
      return bound !== undefined && st.isSocket() && st.dev === bound.dev && st.ino === bound.ino;
    } catch { return false; }
  };
  const writeToken = (): void => {
    const temp = `${endpoint.token}.${process.pid}`;
    writeFileSync(temp, token, { mode: 0o600 });
    renameSync(temp, endpoint.token);
  };

  /** Stop accepting, let the running request finish and answer the queued ones "closing", then exit. */
  const shutdown = (): Promise<void> => {
    if (stopped) return stopped;
    closing = true;
    // Still listening here, so no starting daemon can take the path over in between: its
    // probe would reach this one and it would exit.
    if (process.platform !== "win32" && owned()) { try { rmSync(endpoint.path, { force: true }); } catch { /* gone */ } }
    server.close();
    stopped = (async () => {
      do { await queue; } while (pending > 0);
      // A successor's token written between the read and the rm is rewritten at its next poll.
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

  /** A request's final line. A shutdown waits for the request, so the line is flushed
   *  (or FLUSH_BUDGET_MS passes) before the process may exit. */
  const finish = (socket: Socket, message: unknown): Promise<void> => socket.destroyed ? Promise.resolve() : new Promise<void>((resolve) => {
    const timer = setTimeout(resolve, FLUSH_BUDGET_MS);
    socket.end(`${JSON.stringify(message)}\n`, () => { clearTimeout(timer); resolve(); });
  });

  /** One queued request: announce `ready`, run only once the client answers `go`. */
  const serve = async (socket: Socket, reader: ReturnType<typeof lineReader>, request: HookRequest): Promise<void> => {
    try {
      if (closing || socket.destroyed) {
        if (!socket.destroyed) socket.end(`${JSON.stringify({ error: "closing" })}\n`);
        return;
      }
      socket.write(`${JSON.stringify({ ready: true })}\n`);
      const go = await reader.next<{ go?: boolean }>(GO_BUDGET_MS);
      // A late `go` already left the client past its fallback point: dropping the socket
      // would skip the hook (a strict deny included). Nothing ran, so it runs in-process.
      if (!go || go.go !== true) {
        await finish(socket, { error: "go", ran: false });
        return;
      }
      let reply: HookReply | { error: string; ran?: false };
      const started = Date.now();
      const watchdog = setTimeout(() => { debugLog(`stuck ${RUN_DEADLINE_MS}ms`); process.exit(1); }, RUN_DEADLINE_MS);
      const mark = String(process.pid);
      try { writeFileSync(endpoint.busy, mark, { mode: 0o600 }); } catch { /* clients then wait for the handshake */ }
      try { reply = await execute(request); } catch (e) {
        reply = { error: `run:${e instanceof Error ? e.message : String(e)}`, ...(e instanceof NotRun ? { ran: false as const } : {}) };
      }
      finally {
        clearTimeout(watchdog);
        // Only our own: a successor that took the endpoint over may be running a hook now.
        try { if (readFileSync(endpoint.busy, "utf8") === mark) rmSync(endpoint.busy, { force: true }); } catch { /* ignored once stale */ }
      }
      debugLog(`run ${Date.now() - started}ms`);
      await finish(socket, reply);
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
    // Until its hello a connection costs at most HELLO_BUDGET_MS and HELLO_MAX_BYTES (the
    // client sends nothing else before the proof); then one request line, dropped without
    // the token. Only an authenticated request enters the queue.
    const reader = lineReader(socket, HELLO_MAX_BYTES);
    void (async () => {
      const hello = await reader.next<{ v?: number; hello?: unknown }>(HELLO_BUDGET_MS);
      if (!hello || hello.v !== PROTOCOL || typeof hello.hello !== "string" || !/^[0-9a-f]{32}$/.test(hello.hello)) {
        socket.destroy();
        return;
      }
      reader.maxBytes = MAX_MESSAGE_BYTES;
      socket.write(`${JSON.stringify({ proof: proofFor(token, hello.hello) })}\n`);
      const request = await reader.next<HookRequest>(GO_BUDGET_MS);
      if (!request || request.v !== PROTOCOL || typeof request.token !== "string" || !sameToken(request.token, token)) {
        socket.destroy();
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

  if (process.platform === "win32") {
    // A pipe name is single-instance: losing the bind means another daemon serves it.
    if (!await listen(server, endpoint.path)) return process.exit(0);
  } else {
    // Bound to a private name (no longer than the shared one, for sun_path), then moved
    // over the shared path: only when nobody answers there (none yet, or a dead daemon's file).
    const own = join(endpoint.dir, `${randomBytes(8).toString("hex")}.sock`);
    if (!await listen(server, own)) return process.exit(0);
    try {
      chmodSync(own, 0o600);
      const st = lstatSync(own);
      bound = { dev: st.dev, ino: st.ino };
    } catch { server.close(); return process.exit(0); }
    const probe = await connectWithin(endpoint.path, 200);
    probe.socket?.destroy();
    if (probe.socket || (probe.code !== "ENOENT" && probe.code !== "ECONNREFUSED")) { server.close(); return process.exit(0); }
    // Two daemons starting at once can both get here; the later rename wins and the
    // other, no longer owning the path, exits at its next poll without unlinking it.
    try { renameSync(own, endpoint.path); } catch { server.close(); return process.exit(0); }
  }
  writeToken();
  // This daemon now owns the endpoint: any marker is a predecessor's (dead, or unreachable).
  try { rmSync(endpoint.busy, { force: true }); } catch { /* clients also verify an old one */ }
  debugLog("listening");
  touch();
  // A rebuilt CLI, or the shared endpoint no longer this daemon's (see owned): clients can
  // no longer reach it, so it exits and the next hook starts a fresh one. A token file
  // removed (a temp cleaner) or overwritten by a daemon that lost the path is rewritten.
  setInterval(() => {
    // Shutting down: the endpoint may already be a successor's, token included.
    if (closing) return;
    if (buildId() !== build || !owned()) return void shutdown();
    // A marker left while nothing runs here (its removal failed, or a predecessor's) would keep
    // clients in-process for as long as its pid lives: once clients verify it, it goes.
    if (pending === 0) {
      try { if (Date.now() - statSync(endpoint.busy).mtimeMs > BUSY_VERIFY_MS) rmSync(endpoint.busy, { force: true }); } catch { /* none */ }
    }
    let current = "";
    try { current = readFileSync(endpoint.token, "utf8").trim(); } catch { /* gone */ }
    if (current !== token) { try { writeToken(); } catch { void shutdown(); } }
  }, BUILD_POLL_MS).unref();
}
