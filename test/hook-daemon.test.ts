import assert from "node:assert/strict";
import { test } from "node:test";
import { spawn, spawnSync } from "node:child_process";
import { existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, readlinkSync, realpathSync, renameSync, rmSync, statSync, utimesSync, watch, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { connect, createServer, type Socket } from "node:net";
import { cleanupDir } from "./fixtures.js";
import { createHash } from "node:crypto";
import { lineReader, posixEndpointDir, proofFor } from "../src/cli/hookDaemon.js";
import { HunchStore } from "../src/store/hunchStore.js";
import { hunchPaths } from "../src/core/paths.js";
import { HUNCH_VERSION } from "../src/core/version.js";
import { mkConstraint } from "./helpers.js";

test("a socket path past sun_path falls back to /tmp; one that fits stays in TMPDIR", () => {
  const h = "0123456789abcdef0123456789abcdef";
  const macTmp = "/var/folders/y6/abcdefghijklmnopqrstuvwxyz0000gn/T";
  // macOS default TMPDIR fits (98 bytes); a temp dir nested under it does not (114).
  assert.equal(posixEndpointDir(macTmp, 501, h, "darwin"), `${macTmp}/hunch-501`);
  assert.equal(posixEndpointDir(`${macTmp}/hunch-hd-abcdef`, 501, h, "darwin"), "/tmp/hunch-501");
  // Linux allows 107 bytes, macOS/BSD 103: the boundary is exact on each.
  const tmpFor = (bytes: number) => `/${"x".repeat(bytes - `/hunch-1/${h}.sock`.length - 1)}`;
  assert.equal(posixEndpointDir(tmpFor(103), 1, h, "darwin"), `${tmpFor(103)}/hunch-1`);
  assert.equal(posixEndpointDir(tmpFor(104), 1, h, "darwin"), "/tmp/hunch-1");
  assert.equal(posixEndpointDir(tmpFor(107), 1, h, "linux"), `${tmpFor(107)}/hunch-1`);
  assert.equal(posixEndpointDir(tmpFor(108), 1, h, "linux"), "/tmp/hunch-1");
});

// End-to-end through the built CLI (npm run build); skipped when dist/ is absent.
const cli = resolve("dist/cli/index.js");
const built = existsSync(cli) && existsSync(resolve("dist/cli/hook-client.bundle.js"));

function fixture(t: { after: (f: () => void) => void }) {
  // macOS: a short base keeps the endpoint dir inside it (the /var/folders TMPDIR would push
  // the socket path past sun_path and onto the shared /tmp fallback).
  const base = mkdtempSync(join(process.platform === "darwin" ? "/tmp" : tmpdir(), "hunch-hd-"));
  const root = join(base, "repo");
  mkdirSync(join(root, ".hunch"), { recursive: true });
  spawnSync("git", ["init", "-q"], { cwd: root });
  const log = join(base, "daemon.log");
  const env = { ...process.env, HUNCH_HOOK_DAEMON: "1", HUNCH_HOOK_DAEMON_LOG: log, LOCALAPPDATA: join(base, "local"), TMPDIR: base, TEMP: base, TMP: base };
  // Daemons a test already saw exit: their pids may belong to other processes by now.
  const reaped = new Set<number>();
  t.after(() => {
    for (const pid of daemons(log)) { if (!reaped.has(pid)) { try { process.kill(pid); } catch { /* gone */ } } }
    cleanupDir(base);
  });
  return { root, log, env, base, reaped };
}
const lines = (log: string) => existsSync(log) ? readFileSync(log, "utf8").split("\n").filter(Boolean) : [];
const daemons = (log: string) => lines(log).filter((l) => l.endsWith(" listening")).map((l) => Number(l.split(" ")[1]));
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));
async function until(fn: () => boolean, ms = 15_000): Promise<void> {
  for (const end = Date.now() + ms; Date.now() < end; await sleep(50)) if (fn()) return;
  assert.fail("condition not reached");
}
const payload = (root: string, session: string) => JSON.stringify({ session_id: session, cwd: root, hook_event_name: "SessionStart", source: "startup" });
function hook(root: string, env: NodeJS.ProcessEnv, input: string) {
  const r = spawnSync(process.execPath, [cli, "hook"], { cwd: root, env, input, encoding: "utf8" });
  return { stdout: r.stdout, stderr: r.stderr, status: r.status };
}
const norm = (s: string) => s.replace(/htask_[0-9a-f]+|hocc_[0-9a-f]+/g, "ID");
/** The live daemon's endpoint and token, found through the fixture's endpoint dir. */
function endpointOf(base: string): { path: string; token: string } {
  const dirEnd = process.platform === "win32" ? join(base, "local", "hunch", "hook-daemon") : join(base, `hunch-${process.getuid?.()}`);
  const tokenFile = readdirSync(dirEnd).find((n) => n.endsWith(".token"))!;
  const id = tokenFile.slice(0, -".token".length);
  // Windows: the pipe name also hashes a per-user secret, so it is not derivable from the token file name alone.
  const secret = process.platform === "win32" ? readFileSync(join(dirEnd, "pipe.secret"), "utf8").trim() : "";
  const pipe = createHash("sha256").update(`${secret}\0${id}`).digest("hex").slice(0, 32);
  const path = process.platform === "win32" ? String.raw`\\.\pipe\hunch-${pipe}` : join(dirEnd, `${id}.sock`);
  return { path, token: readFileSync(join(dirEnd, tokenFile), "utf8").trim() };
}
async function handshake(path: string, token: string) {
  const socket = connect(path);
  await new Promise<void>((ok, bad) => { socket.once("connect", ok); socket.once("error", bad); });
  const reader = lineReader(socket);
  const nonce = "ab".repeat(16);
  socket.write(`${JSON.stringify({ v: 3, hello: nonce })}\n`);
  assert.equal((await reader.next<{ proof: string }>(2000))?.proof, proofFor(token, nonce));
  return { socket, reader };
}

test("first hook runs in-process and starts the daemon; the next is served with identical output", { skip: !built, timeout: 60_000 }, async (t) => {
  const f = fixture(t);
  const input = payload(f.root, "s1");
  const off = hook(f.root, { ...f.env, HUNCH_HOOK_DAEMON: "0" }, input);
  const first = hook(f.root, f.env, input);
  // Windows: no per-user pipe secret yet (only a daemon creates it); POSIX: the fixture's
  // fresh TMPDIR has no endpoint dir yet.
  assert.match(lines(f.log).join("\n"), /fallback (?:connect:ENOENT|secret|dir)/);
  await until(() => daemons(f.log).length === 1);
  const second = hook(f.root, f.env, input);
  assert.ok(lines(f.log).some((l) => l.endsWith(" served")), lines(f.log).join("\n"));
  assert.equal(norm(second.stdout), norm(off.stdout));
  assert.equal(norm(first.stdout), norm(off.stdout));
  assert.equal(second.status, off.status);
  assert.equal(second.stderr, off.stderr);
});

test("concurrent first hooks start a single daemon", { skip: !built, timeout: 60_000 }, async (t) => {
  const f = fixture(t);
  const input = payload(f.root, "s2");
  await Promise.all([1, 2, 3, 4].map(() => new Promise<void>((done) => {
    const p = spawn(process.execPath, [cli, "hook"], { cwd: f.root, env: f.env, stdio: ["pipe", "ignore", "ignore"] });
    p.on("close", () => done());
    p.stdin.end(input);
  })));
  await until(() => daemons(f.log).length >= 1);
  await sleep(1500);
  assert.equal(lines(f.log).filter((l) => / spawn /.test(l)).length, 1);
  assert.equal(daemons(f.log).length, 1);
});

test("the daemon drops a request without its token", { skip: !built, timeout: 60_000 }, async (t) => {
  const f = fixture(t);
  hook(f.root, f.env, payload(f.root, "s3"));
  await until(() => daemons(f.log).length === 1);
  // Locate the endpoint through the client's own view: a served hook proves it exists.
  hook(f.root, f.env, payload(f.root, "s3"));
  const { path, token } = endpointOf(f.base);
  const { socket, reader } = await handshake(path, token);
  socket.write(`${JSON.stringify({ v: 3, token: "wrong", buildId: "x", provider: "claude", cwd: f.root, root: f.root, env: {}, payload: "{}" })}\n`);
  assert.equal(await reader.next(2000), null);
  socket.destroy();
  // The dropped peer cost nothing: the next hook is served.
  const served = lines(f.log).filter((l) => l.endsWith(" served")).length;
  hook(f.root, f.env, payload(f.root, "s3"));
  assert.equal(lines(f.log).filter((l) => l.endsWith(" served")).length, served + 1, lines(f.log).join("\n"));
});

test("a strict denial served by the daemon is the in-process denial", { skip: !built, timeout: 60_000 }, async (t) => {
  const f = fixture(t);
  mkdirSync(join(f.root, "src"));
  writeFileSync(join(f.root, "src", "config.ts"), "export const settings = {};\n");
  writeFileSync(join(f.root, ".hunch", "config.json"), JSON.stringify({ firmness: "strict" }));
  const store = new HunchStore(hunchPaths(f.root));
  store.json.ensureDirs();
  store.json.put("constraints", mkConstraint({ id: "con_daemon_deny", statement: "DAEMON_DENY_SENTINEL", scope: ["src/config.ts"], severity: "blocking" }));
  store.reindex(); store.close();
  hook(f.root, f.env, payload(f.root, "s4"));
  await until(() => daemons(f.log).length === 1);
  const edit = (session: string) => JSON.stringify({
    session_id: session, cwd: f.root, hook_event_name: "PreToolUse", tool_name: "Edit",
    tool_input: { file_path: join(f.root, "src", "config.ts"), old_string: "{}", new_string: "replace settings" },
  });
  const off = hook(f.root, { ...f.env, HUNCH_HOOK_DAEMON: "0" }, edit("s5"));
  const served = lines(f.log).filter((l) => l.endsWith(" served")).length;
  const on = hook(f.root, f.env, edit("s6"));
  assert.equal(lines(f.log).filter((l) => l.endsWith(" served")).length, served + 1, lines(f.log).join("\n"));
  const decision = (out: string) => (JSON.parse(out) as { hookSpecificOutput: { permissionDecision: string; permissionDecisionReason: string } }).hookSpecificOutput;
  assert.equal(decision(off.stdout).permissionDecision, "deny");
  assert.deepEqual(decision(on.stdout), decision(off.stdout));
  assert.equal(on.status, off.status);
});

test("a go arriving past the daemon's budget is answered not-run, so the client runs the hook in-process", { skip: !built, timeout: 60_000 }, async (t) => {
  const f = fixture(t);
  hook(f.root, f.env, payload(f.root, "s7"));
  await until(() => daemons(f.log).length === 1);
  hook(f.root, f.env, payload(f.root, "s7"));
  const { path, token } = endpointOf(f.base);
  const { socket, reader } = await handshake(path, token);
  const bundle = statSync(resolve("dist/cli/hook.bundle.js"));
  const buildId = `${HUNCH_VERSION}:${bundle.size}:${bundle.mtimeMs}`;
  socket.write(`${JSON.stringify({ v: 3, token, buildId, provider: "claude", cwd: f.root, root: f.root, env: {}, payload: payload(f.root, "s7") })}\n`);
  assert.deepEqual(await reader.next(2000), { ready: true });
  // No `go` within GO_BUDGET_MS (2s): the daemon answers not-run instead of dropping the socket.
  assert.deepEqual(await reader.next(5000), { error: "go", ran: false });
  socket.destroy();
  // The abandoned request released the daemon: the next hook is served again.
  const served = lines(f.log).filter((l) => l.endsWith(" served")).length;
  hook(f.root, f.env, payload(f.root, "s7"));
  assert.equal(lines(f.log).filter((l) => l.endsWith(" served")).length, served + 1, lines(f.log).join("\n"));
});

test("an idle daemon does not hold the repository dir (Windows: rename/remove would fail EBUSY)", { skip: !built, timeout: 60_000 }, async (t) => {
  const f = fixture(t);
  hook(f.root, f.env, payload(f.root, "s8"));
  await until(() => daemons(f.log).length === 1);
  const served = lines(f.log).filter((l) => l.endsWith(" served")).length;
  hook(f.root, f.env, payload(f.root, "s8"));
  assert.equal(lines(f.log).filter((l) => l.endsWith(" served")).length, served + 1, lines(f.log).join("\n"));
  // POSIX lets a busy dir be renamed, so there the cwd itself is the evidence (Linux only).
  if (process.platform === "linux") {
    const cwd = readlinkSync(`/proc/${daemons(f.log)[0]!}/cwd`), repo = realpathSync(f.root);
    assert.ok(cwd !== repo && !cwd.startsWith(`${repo}/`), `daemon cwd ${cwd} is inside ${repo}`);
  }
  renameSync(f.root, `${f.root}-moved`);
  // Still the same live daemon: the rename did not just outlast it.
  process.kill(daemons(f.log)[0]!, 0);
});

test("the hook that starts a daemon leaves the repository free at once (Windows: rename would fail EBUSY)", { skip: !built, timeout: 60_000 }, async (t) => {
  const f = fixture(t);
  hook(f.root, f.env, payload(f.root, "s19"));
  // The daemon is booting right now: it must not have the repository as its cwd.
  renameSync(f.root, `${f.root}-moved`);
  await until(() => daemons(f.log).length === 1);
});

const endpointDir = (base: string) => process.platform === "win32" ? join(base, "local", "hunch", "hook-daemon") : join(base, `hunch-${process.getuid?.()}`);
/** The endpoint's file-name hash, from its token file. */
const endpointId = (base: string) => readdirSync(endpointDir(base)).find((n) => n.endsWith(".token"))!.slice(0, -".token".length);
const servedCount = (log: string) => lines(log).filter((l) => l.endsWith(" served")).length;
const alive = (pid: number) => { try { process.kill(pid, 0); return true; } catch { return false; } };
/** A hook run without blocking this process, so an in-test server can answer it. */
function hookAsync(root: string, env: NodeJS.ProcessEnv, input: string): Promise<{ stdout: string; stderr: string; status: number | null }> {
  return new Promise((done) => {
    const p = spawn(process.execPath, [cli, "hook"], { cwd: root, env });
    let stdout = "", stderr = "";
    p.stdout.on("data", (c) => (stdout += c));
    p.stderr.on("data", (c) => (stderr += c));
    p.on("close", (status) => done({ stdout, stderr, status }));
    p.stdin.end(input);
  });
}
/** A served daemon, its endpoint, and the in-process output for `input`. */
async function liveDaemon(t: { after: (f: () => void) => void }, session: string) {
  const f = fixture(t);
  const input = payload(f.root, session);
  const off = hook(f.root, { ...f.env, HUNCH_HOOK_DAEMON: "0" }, input);
  hook(f.root, f.env, input);
  await until(() => daemons(f.log).length === 1);
  hook(f.root, f.env, input);
  assert.equal(servedCount(f.log), 1, lines(f.log).join("\n"));
  return { ...f, input, off, pid: daemons(f.log)[0]!, ...endpointOf(f.base) };
}

test("a daemon that lost its socket path exits without unlinking its successor's", { skip: !built || process.platform === "win32", timeout: 60_000 }, async (t) => {
  const d = await liveDaemon(t, "s9");
  // A temp cleaner removes the socket; the next hook starts a successor right away.
  rmSync(d.path);
  rmSync(join(endpointDir(d.base), `${endpointId(d.base)}.spawn`));
  hook(d.root, d.env, d.input);
  await until(() => daemons(d.log).length === 2);
  // The first daemon notices it no longer owns the path and exits...
  await until(() => !alive(d.pid));
  d.reaped.add(d.pid);
  // ...leaving the successor's socket in place: hooks are still served.
  hook(d.root, d.env, d.input);
  assert.equal(servedCount(d.log), 2, lines(d.log).join("\n"));
});

test("a hook arriving while the daemon runs one goes in-process without a handshake", { skip: !built, timeout: 60_000 }, async (t) => {
  const d = await liveDaemon(t, "s10");
  const busy = join(endpointDir(d.base), `${endpointId(d.base)}.busy`);
  writeFileSync(busy, String(d.pid));
  const out = hook(d.root, d.env, d.input);
  assert.ok(lines(d.log).some((l) => l.endsWith(" fallback busy")), lines(d.log).join("\n"));
  assert.equal(servedCount(d.log), 1);
  assert.equal(norm(out.stdout), norm(d.off.stdout));
  // A marker naming no live process is ignored.
  writeFileSync(busy, "2147483646");
  hook(d.root, d.env, d.input);
  assert.equal(servedCount(d.log), 2, lines(d.log).join("\n"));
  // An old marker left while the daemon idles (its removal failed) names a live process: the
  // idle daemon clears it at its next poll, so it never holds hooks off for long.
  writeFileSync(busy, String(process.pid));
  const old = new Date(Date.now() - 6000);
  utimesSync(busy, old, old);
  await until(() => !existsSync(busy), 8000);
  hook(d.root, d.env, d.input);
  assert.equal(servedCount(d.log), 3, lines(d.log).join("\n"));
});

test("an old busy marker whose daemon was killed mid-run (pid since reused) does not block a new daemon", { skip: !built, timeout: 60_000 }, async (t) => {
  const d = await liveDaemon(t, "s16");
  process.kill(d.pid);
  await until(() => !alive(d.pid));
  d.reaped.add(d.pid);
  const dir = endpointDir(d.base), id = endpointId(d.base);
  rmSync(join(dir, `${id}.spawn`), { force: true });
  // The marker's pid now names a live, unrelated process (this one).
  const busy = join(dir, `${id}.busy`);
  writeFileSync(busy, String(process.pid));
  const old = new Date(Date.now() - 6000);
  utimesSync(busy, old, old);
  hook(d.root, d.env, d.input);
  assert.match(lines(d.log).join("\n"), /fallback connect:(?:ENOENT|ECONNREFUSED)/);
  await until(() => daemons(d.log).length === 2);
  hook(d.root, d.env, d.input);
  assert.equal(servedCount(d.log), 2, lines(d.log).join("\n"));
});

test("the daemon marks itself busy while it runs a hook, and clears the mark after", { skip: !built, timeout: 60_000 }, async (t) => {
  const d = await liveDaemon(t, "s17");
  const name = `${endpointId(d.base)}.busy`;
  const seen: string[] = [];
  const watcher = watch(endpointDir(d.base), (_event, file) => { if (file) seen.push(String(file)); });
  t.after(() => watcher.close());
  const bundle = statSync(resolve("dist/cli/hook.bundle.js"));
  const buildId = `${HUNCH_VERSION}:${bundle.size}:${bundle.mtimeMs}`;
  // A watcher may start a moment late (macOS FSEvents): a few runs give it the chance.
  for (let run = 0; run < 5 && !seen.includes(name); run++) {
    const { socket, reader } = await handshake(d.path, d.token);
    socket.write(`${JSON.stringify({ v: 3, token: d.token, buildId, provider: "claude", cwd: d.root, root: d.root, env: {}, payload: d.input })}\n`);
    assert.deepEqual(await reader.next(2000), { ready: true });
    socket.write(`${JSON.stringify({ go: true })}\n`);
    const reply = await reader.next<{ exitCode: number }>(30_000);
    socket.destroy();
    assert.equal(reply?.exitCode, 0);
    await sleep(300);
  }
  assert.ok(seen.includes(name), `no ${name} event in ${JSON.stringify(seen)}`);
  assert.ok(!existsSync(join(endpointDir(d.base), name)));
});

test("a daemon whose pipe secret was replaced exits; its successor serves", { skip: !built || process.platform !== "win32", timeout: 60_000 }, async (t) => {
  const d = await liveDaemon(t, "s18");
  const dir = endpointDir(d.base);
  // The per-user secret is gone (a profile cleaner): the next hook finds no pipe and starts
  // a daemon on a fresh secret's pipe, which shares the old daemon's token file.
  rmSync(join(dir, "pipe.secret"));
  rmSync(join(dir, `${endpointId(d.base)}.spawn`));
  hook(d.root, d.env, d.input);
  await until(() => daemons(d.log).length === 2);
  await until(() => !alive(d.pid));
  d.reaped.add(d.pid);
  // No token rewrite war: every hook is served from here on.
  const before = servedCount(d.log);
  for (let i = 0; i < 4; i++) hook(d.root, d.env, d.input);
  assert.equal(servedCount(d.log), before + 4, lines(d.log).join("\n"));
});

test("an unauthenticated connection is dropped within the hello budget, an oversized hello at once", { skip: !built, timeout: 60_000 }, async (t) => {
  const d = await liveDaemon(t, "s11");
  const closedAfter = async (send?: string): Promise<number> => {
    const socket = connect(d.path);
    socket.on("error", () => { /* reset by the daemon */ });
    await new Promise<void>((ok) => socket.once("connect", () => ok()));
    const started = Date.now();
    if (send) socket.write(send);
    await new Promise<void>((ok) => socket.once("close", () => ok()));
    return Date.now() - started;
  };
  const silent = await closedAfter();
  assert.ok(silent < 1500, `silent connection held ${silent}ms`);
  const oversized = await closedAfter("x".repeat(4096));
  assert.ok(oversized < silent, `oversized hello held ${oversized}ms, a silent one ${silent}ms`);
  hook(d.root, d.env, d.input);
  assert.equal(servedCount(d.log), 2, lines(d.log).join("\n"));
});

/** Kill the daemon and serve its endpoint with a scripted fake that passes the handshake. */
async function fakeDaemon(t: { after: (f: () => void) => void }, d: { pid: number; path: string; token: string; reaped: Set<number> },
  afterRequest: (socket: Socket, reader: ReturnType<typeof lineReader>) => Promise<void>): Promise<void> {
  process.kill(d.pid);
  await until(() => !alive(d.pid));
  d.reaped.add(d.pid);
  if (process.platform !== "win32") rmSync(d.path, { force: true });
  const server = createServer((socket) => {
    socket.on("error", () => { /* the client gave up */ });
    const reader = lineReader(socket);
    void (async () => {
      const hello = await reader.next<{ hello: string }>(2000);
      if (!hello) return void socket.destroy();
      socket.write(`${JSON.stringify({ proof: proofFor(d.token, hello.hello) })}\n`);
      if (!await reader.next(2000)) return void socket.destroy();
      await afterRequest(socket, reader);
    })();
  });
  // Windows frees a dead process's pipe name a moment after the process is gone.
  for (const end = Date.now() + 10_000; ; await sleep(100)) {
    const code = await new Promise<string | null>((ok) => {
      server.once("error", (e: NodeJS.ErrnoException) => ok(e.code ?? "error"));
      server.listen(d.path, () => ok(null));
    });
    if (code === null) break;
    if (code !== "EADDRINUSE" || Date.now() > end) assert.fail(`fake daemon listen ${code}`);
  }
  t.after(() => { server.close(); });
}

test("a not-run answer after go makes the client run the hook in-process", { skip: !built, timeout: 60_000 }, async (t) => {
  const d = await liveDaemon(t, "s12");
  await fakeDaemon(t, d, async (socket, reader) => {
    socket.write(`${JSON.stringify({ ready: true })}\n`);
    await reader.next(2000);
    socket.end(`${JSON.stringify({ error: "go", ran: false })}\n`);
  });
  const out = await hookAsync(d.root, d.env, d.input);
  assert.ok(lines(d.log).some((l) => l.endsWith(" fallback notrun:go")), lines(d.log).join("\n"));
  assert.equal(norm(out.stdout), norm(d.off.stdout));
  assert.equal(out.status, d.off.status);
});

test("a daemon of another build makes the client run the hook in-process", { skip: !built, timeout: 60_000 }, async (t) => {
  const d = await liveDaemon(t, "s13");
  await fakeDaemon(t, d, async (socket) => { socket.end(`${JSON.stringify({ error: "build" })}\n`); });
  const out = await hookAsync(d.root, d.env, d.input);
  assert.ok(lines(d.log).some((l) => l.endsWith(" fallback queue:build")), lines(d.log).join("\n"));
  assert.equal(norm(out.stdout), norm(d.off.stdout));
});

test("a daemon lost after go is reported, never re-run in-process", { skip: !built, timeout: 60_000 }, async (t) => {
  const d = await liveDaemon(t, "s14");
  await fakeDaemon(t, d, async (socket, reader) => {
    socket.write(`${JSON.stringify({ ready: true })}\n`);
    await reader.next(2000);
    socket.destroy();
  });
  const out = await hookAsync(d.root, d.env, d.input);
  // The hook may already have run there: running it again could repeat its side effects.
  assert.equal(out.stdout, "");
  assert.match(out.stderr, /hook daemon lost the reply/);
  assert.equal(out.status, 0);
});

test("a relative NODE_OPTIONS preload does not keep the daemon from starting", { skip: !built, timeout: 60_000 }, async (t) => {
  const f = fixture(t);
  writeFileSync(join(f.root, "preload.cjs"), "");
  const env = { ...f.env, NODE_OPTIONS: [process.env.NODE_OPTIONS, "--require ./preload.cjs"].filter(Boolean).join(" ") };
  const input = payload(f.root, "s15");
  hook(f.root, env, input);
  await until(() => daemons(f.log).length === 1);
  hook(f.root, env, input);
  assert.equal(servedCount(f.log), 1, lines(f.log).join("\n"));
});
