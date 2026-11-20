import { cleanupDir } from "./fixtures.js";
import { test } from "node:test";
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { hunchPaths } from "../src/core/paths.js";
import { HunchStore } from "../src/store/hunchStore.js";
import { LOCKS_FILE, fileSha, lockDenyReason, lockFor, lockProblemReason, lockablePath, readLocks, removeLock, setLock, verifyLocks } from "../src/core/locks.js";
import { tsxLoaderUrl } from "./helpers.js";

const cli = resolve("src/cli/index.ts");
const HLD = "docs/hld/payments.md";
const gitEnv = { ...process.env, GIT_AUTHOR_NAME: "t", GIT_AUTHOR_EMAIL: "t@t", GIT_COMMITTER_NAME: "t", GIT_COMMITTER_EMAIL: "t@t" };

function repo(t: { after: (f: () => void) => void }) {
  const root = realpathSync(mkdtempSync(join(tmpdir(), "hunch-locks-")));
  const git = (...args: string[]) => execFileSync("git", ["-C", root, ...args], { env: gitEnv });
  git("init", "-q");
  mkdirSync(join(root, "docs", "hld"), { recursive: true });
  mkdirSync(join(root, "src"), { recursive: true });
  writeFileSync(join(root, HLD), "# Payments HLD\n\nflowchart LR\n  api --> ledger\n");
  writeFileSync(join(root, "src", "app.ts"), "export const app = 1;\n");
  const store = new HunchStore(hunchPaths(root));
  store.json.ensureDirs();
  store.close();
  git("add", "-A");
  git("commit", "-q", "-m", "init");
  t.after(() => cleanupDir(root));
  return { root, git };
}

function lockAndCommit(root: string, git: (...a: string[]) => unknown) {
  setLock(root, HLD, { kind: "hld", approvedBy: "dave", at: "2026-11-17T10:00:00Z" });
  git("add", "-A");
  git("commit", "-q", "-m", "lock hld");
}

function runHook(root: string, payload: Record<string, unknown>) {
  const out = execFileSync(process.execPath, ["--import", tsxLoaderUrl(), cli, "hook", "--provider", "claude"], {
    cwd: root, env: { ...process.env, HUNCH_PIPELINE: "0", HUNCH_TASK_SELECTION: "" },
    input: JSON.stringify({ cwd: root, session_id: "s-lock", ...payload }), encoding: "utf8",
  }).trim();
  return out ? JSON.parse(out) : null;
}

test("setLock binds the exact bytes; verifyLocks reports a changed or deleted file", t => {
  const { root } = repo(t);
  const { lock, previous } = setLock(root, HLD, { kind: "hld", approvedBy: "dave" });
  assert.equal(previous, null);
  assert.equal(lock.sha256, fileSha(root, HLD));
  assert.deepEqual(verifyLocks(root), []);
  writeFileSync(join(root, HLD), "# Payments HLD\n\nflowchart LR\n  api --> cache\n");
  assert.deepEqual(verifyLocks(root).map((p) => p.kind), ["modified"]);
  rmSync(join(root, HLD));
  assert.deepEqual(verifyLocks(root).map((p) => p.kind), ["missing"]);
});

test("re-locking approves new bytes; unlocking removes the lock", t => {
  const { root } = repo(t);
  setLock(root, HLD, { kind: "hld", approvedBy: "dave" });
  writeFileSync(join(root, HLD), "# v2\n");
  const { previous } = setLock(root, HLD, { kind: "hld", approvedBy: "dave" });
  assert.ok(previous);
  assert.deepEqual(verifyLocks(root), []);
  assert.ok(removeLock(root, HLD));
  assert.equal(readLocks(root).locks.length, 0);
});

test("lockablePath refuses globs, escapes and Hunch's own state", () => {
  assert.equal(lockablePath("docs/hld/*.md"), null);
  assert.equal(lockablePath("../outside.md"), null);
  assert.equal(lockablePath(".hunch/locks.json"), null);
  assert.equal(lockablePath("./docs/hld/a.md"), "docs/hld/a.md");
});

test("a tampered registry is reported, never read as 'nothing locked'", t => {
  const { root } = repo(t);
  setLock(root, HLD, { kind: "hld", approvedBy: "dave" });
  writeFileSync(join(root, LOCKS_FILE), "{ not json");
  assert.equal(readLocks(root).corrupt, true);
  assert.deepEqual(verifyLocks(root).map((p) => p.kind), ["registry"]);
});

test("removing a committed lock in the working tree is caught (sinceHead)", t => {
  const { root, git } = repo(t);
  lockAndCommit(root, git);
  writeFileSync(join(root, LOCKS_FILE), JSON.stringify({ version: 1, locks: [] }));
  assert.deepEqual(verifyLocks(root, { sinceHead: true }).map((p) => [p.kind, p.path]), [["removed", HLD]]);
  assert.deepEqual(verifyLocks(root), []); // the plain byte check alone can't see it
});

test("reasons say what is locked and that a human changes it; they never name a bypass", t => {
  const { root } = repo(t);
  const { lock } = setLock(root, HLD, { kind: "hld", approvedBy: "dave", at: "2026-11-17T10:00:00Z" });
  const deny = lockDenyReason(HLD, lock);
  assert.match(deny, /docs\/hld\/payments\.md is a locked HLD, approved by dave on 2026-11-17/);
  assert.match(deny, /ask a human/);
  assert.doesNotMatch(deny, /hunch (un)?lock/);
  assert.match(lockDenyReason(LOCKS_FILE, undefined), /registry/);
  const write = lockProblemReason([{ kind: "modified", path: HLD, lock }], "write");
  assert.match(write, /git checkout -- <path>/);
  assert.doesNotMatch(write, /hunch (un)?lock/);
  assert.ok(lockFor([lock], `./${HLD}`));
});

test("hook: an Edit/Write on a locked file or on the registry is denied", t => {
  const { root, git } = repo(t);
  lockAndCommit(root, git);
  const edit = runHook(root, { hook_event_name: "PreToolUse", tool_name: "Edit", tool_input: { file_path: join(root, HLD), old_string: "ledger", new_string: "cache" } });
  assert.equal(edit?.hookSpecificOutput?.permissionDecision, "deny");
  assert.match(edit.hookSpecificOutput.permissionDecisionReason, /locked HLD/);
  const reg = runHook(root, { hook_event_name: "PreToolUse", tool_name: "Write", tool_input: { file_path: join(root, LOCKS_FILE), content: "{}" } });
  assert.equal(reg?.hookSpecificOutput?.permissionDecision, "deny");
  const other = runHook(root, { hook_event_name: "PreToolUse", tool_name: "Edit", tool_input: { file_path: join(root, "src", "app.ts"), old_string: "1", new_string: "2" } });
  assert.notEqual(other?.hookSpecificOutput?.permissionDecision, "deny");
  assert.match(readFileSync(join(root, ".hunch", "events.log"), "utf8"), /"kind":"lock"/);
});

test("hook: a shell command that changed a locked file is blocked right after it ran", t => {
  const { root, git } = repo(t);
  lockAndCommit(root, git);
  writeFileSync(join(root, HLD), "# rewritten by sed\n");
  const out = runHook(root, { hook_event_name: "PostToolUse", tool_name: "Bash", tool_input: { command: "sed -i s/ledger/cache/ docs/hld/payments.md" }, tool_response: { stdout: "" } });
  assert.equal(out?.decision, "block");
  assert.match(out.reason, /changed human-approved locked files/);
  assert.match(out.reason, /docs\/hld\/payments\.md/);
});

test("hook: a clean shell command is not blocked", t => {
  const { root, git } = repo(t);
  lockAndCommit(root, git);
  const out = runHook(root, { hook_event_name: "PostToolUse", tool_name: "Bash", tool_input: { command: "ls" }, tool_response: { stdout: "" } });
  assert.notEqual(out?.decision, "block");
});

test("cli: lock refuses without an interactive terminal; locks --check fails on a changed file", t => {
  const { root, git } = repo(t);
  const run = (...args: string[]) => {
    try {
      return { code: 0, out: execFileSync(process.execPath, ["--import", tsxLoaderUrl(), cli, ...args], { cwd: root, encoding: "utf8", stdio: ["ignore", "pipe", "pipe"] }) };
    } catch (e) {
      const err = e as { status: number; stdout: string; stderr: string };
      return { code: err.status, out: `${err.stdout}${err.stderr}` };
    }
  };
  const lock = run("lock", HLD, "--reviewed-by", "agent", "--kind", "diagram", "--note", "v2 approved");
  assert.notEqual(lock.code, 0);
  assert.match(lock.out, /interactive terminal/);
  assert.equal(readLocks(root).locks.length, 0);
  lockAndCommit(root, git);
  assert.equal(run("unlock", HLD, "--reviewed-by", "agent").code !== 0, true);
  assert.equal(readLocks(root).locks.length, 1);
  assert.equal(run("locks", "--check").code, 0);
  const listed = JSON.parse(run("locks", "--json").out) as { locks: Array<{ path: string; kind: string }> };
  assert.deepEqual(listed.locks.map((l) => [l.path, l.kind]), [[HLD, "hld"]]);
  writeFileSync(join(root, HLD), "# changed\n");
  const check = run("locks", "--check");
  assert.equal(check.code, 1);
  assert.match(check.out, /MODIFIED/);
});
