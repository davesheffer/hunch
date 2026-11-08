import assert from "node:assert/strict";
import { test } from "node:test";
import { spawn, spawnSync } from "node:child_process";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { connect } from "node:net";
import { cleanupDir } from "./fixtures.js";
import { createHash } from "node:crypto";
import { lineReader, proofFor } from "../src/cli/hookDaemon.js";
import { HunchStore } from "../src/store/hunchStore.js";
import { hunchPaths } from "../src/core/paths.js";
import { mkConstraint } from "./helpers.js";

// End-to-end through the built CLI (npm run build); skipped when dist/ is absent.
const cli = resolve("dist/cli/index.js");
const built = existsSync(cli) && existsSync(resolve("dist/cli/hook-client.bundle.js"));

function fixture(t: { after: (f: () => void) => void }) {
  const base = mkdtempSync(join(tmpdir(), "hunch-hd-"));
  const root = join(base, "repo");
  mkdirSync(join(root, ".hunch"), { recursive: true });
  spawnSync("git", ["init", "-q"], { cwd: root });
  const log = join(base, "daemon.log");
  const env = { ...process.env, HUNCH_HOOK_DAEMON: "1", HUNCH_HOOK_DAEMON_LOG: log, LOCALAPPDATA: join(base, "local"), TMPDIR: base, TEMP: base, TMP: base };
  t.after(() => {
    for (const pid of daemons(log)) { try { process.kill(pid); } catch { /* gone */ } }
    cleanupDir(base);
  });
  return { root, log, env, base };
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

test("first hook runs in-process and starts the daemon; the next is served with identical output", { skip: !built, timeout: 60_000 }, async (t) => {
  const f = fixture(t);
  const input = payload(f.root, "s1");
  const off = hook(f.root, { ...f.env, HUNCH_HOOK_DAEMON: "0" }, input);
  const first = hook(f.root, f.env, input);
  // Windows: no per-user pipe secret yet (only a daemon creates it); POSIX: no socket yet.
  assert.match(lines(f.log).join("\n"), /fallback (?:connect:ENOENT|secret)/);
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

test("the daemon rejects a request without its token", { skip: !built, timeout: 60_000 }, async (t) => {
  const f = fixture(t);
  hook(f.root, f.env, payload(f.root, "s3"));
  await until(() => daemons(f.log).length === 1);
  // Locate the endpoint through the client's own view: a served hook proves it exists.
  hook(f.root, f.env, payload(f.root, "s3"));
  const dirEnd = process.platform === "win32" ? join(f.base, "local", "hunch", "hook-daemon") : join(f.base, `hunch-${process.getuid?.()}`);
  const { readdirSync } = await import("node:fs");
  const tokenFile = readdirSync(dirEnd).find((n) => n.endsWith(".token"))!;
  const id = tokenFile.slice(0, -".token".length);
  // Windows: the pipe name also hashes a per-user secret, so it is not derivable from the token file name alone.
  const secret = process.platform === "win32" ? readFileSync(join(dirEnd, "pipe.secret"), "utf8").trim() : "";
  const pipe = createHash("sha256").update(`${secret}\0${id}`).digest("hex").slice(0, 32);
  const path = process.platform === "win32" ? String.raw`\\.\pipe\hunch-${pipe}` : join(dirEnd, `${id}.sock`);
  const token = readFileSync(join(dirEnd, tokenFile), "utf8").trim();
  const socket = connect(path);
  await new Promise<void>((ok, bad) => { socket.once("connect", ok); socket.once("error", bad); });
  const reader = lineReader(socket);
  const nonce = "ab".repeat(16);
  socket.write(`${JSON.stringify({ v: 3, hello: nonce })}\n`);
  assert.equal((await reader.next<{ proof: string }>(2000))?.proof, proofFor(token, nonce));
  socket.write(`${JSON.stringify({ v: 3, token: "wrong", buildId: "x", provider: "claude", cwd: f.root, root: f.root, env: {}, payload: "{}" })}\n`);
  assert.deepEqual(await reader.next(2000), { error: "rejected" });
  socket.destroy();
  writeFileSync(join(f.base, "done"), "");
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
