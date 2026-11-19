import { cleanupDir } from "./fixtures.js";
import { test } from "node:test";
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { hunchPaths, realpathNorm } from "../src/core/paths.js";
import { HunchStore } from "../src/store/hunchStore.js";
import { LOCKS_FILE, fileSha, headLocks, isRegistryPath, lockChangesSince, lockDenyReason, lockFor, lockProblemReason, lockSnapshot, lockStillBad, lockablePath, readHeadLocks, readLocks, removeLock, setLock, verifyLocks } from "../src/core/locks.js";
import { onPrompt, emptyState } from "../src/core/pipeline.js";
import { randomUUID } from "node:crypto";
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

function runHook(root: string, payload: Record<string, unknown>, opts: { pipeline?: boolean; provider?: string } = {}) {
  const out = execFileSync(process.execPath, ["--import", tsxLoaderUrl(), cli, "hook", "--provider", opts.provider ?? "claude"], {
    cwd: root, env: { ...process.env, HUNCH_PIPELINE: opts.pipeline ? "1" : "0", HUNCH_TASK_SELECTION: "" },
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
  assert.ok(lockFor(root, [lock], `./${HLD}`));
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

test("content hash is EOL-stable: a CRLF checkout of an LF-approved file still matches", t => {
  const { root } = repo(t);
  setLock(root, HLD, { kind: "hld", approvedBy: "dave" });
  const lf = readFileSync(join(root, HLD), "utf8");
  writeFileSync(join(root, HLD), lf.replace(/\n/g, "\r\n"));
  assert.deepEqual(verifyLocks(root), []);
  writeFileSync(join(root, HLD), lf.replace(/\n/g, "\r\n").replace("ledger", "cache"));
  assert.deepEqual(verifyLocks(root).map((p) => p.kind), ["modified"]);
});

test("path canonicalization: equivalent spellings of a locked path are all locked", t => {
  const { root } = repo(t);
  const { lock } = setLock(root, HLD, { kind: "hld", approvedBy: "dave" });
  for (const p of ["docs/hld/../hld/payments.md", "docs//hld/payments.md", "docs/./hld/payments.md", join(root, "docs", "x", "..", "hld", "payments.md")]) {
    assert.ok(lockFor(root, [lock], p), p);
  }
  if (process.platform === "win32") assert.ok(lockFor(root, [lock], "docs\\hld\\payments.md"));
  if (process.platform === "win32" || process.platform === "darwin") {
    assert.ok(lockFor(root, [lock], "Docs/HLD/Payments.md"));
    assert.ok(isRegistryPath(root, ".HUNCH/Locks.json"));
  }
  assert.equal(lockFor(root, [lock], "../outside/docs/hld/payments.md"), undefined);
  assert.ok(isRegistryPath(root, `./.hunch/../${LOCKS_FILE}`));
});

test("hook: a relative '..' Edit and a case-variant apply_patch on a locked file are denied", t => {
  const { root, git } = repo(t);
  lockAndCommit(root, git);
  const edit = runHook(root, { hook_event_name: "PreToolUse", tool_name: "Edit", tool_input: { file_path: "docs/hld/../hld/payments.md", old_string: "ledger", new_string: "cache" } });
  assert.equal(edit?.hookSpecificOutput?.permissionDecision, "deny");
  if (process.platform === "win32" || process.platform === "darwin") {
    const patch = "*** Begin Patch\n*** Update File: Docs/HLD/Payments.md\n@@\n-  api --> ledger\n+  api --> cache\n*** End Patch\n";
    const out = runHook(root, { hook_event_name: "PreToolUse", tool_name: "apply_patch", tool_input: { input: patch } }, { provider: "codex" });
    assert.equal(out?.hookSpecificOutput?.permissionDecision, "deny");
    assert.match(out.hookSpecificOutput.permissionDecisionReason, /locked HLD/);
  }
});

test("hook: a corrupt registry fails closed (HEAD locks protected, or every edit refused)", t => {
  const { root, git } = repo(t);
  lockAndCommit(root, git);
  writeFileSync(join(root, LOCKS_FILE), "{ broken");
  const hld = runHook(root, { hook_event_name: "PreToolUse", tool_name: "Edit", tool_input: { file_path: join(root, HLD), old_string: "ledger", new_string: "cache" } });
  assert.equal(hld?.hookSpecificOutput?.permissionDecision, "deny");
  const reg = runHook(root, { hook_event_name: "PreToolUse", tool_name: "Write", tool_input: { file_path: join(root, LOCKS_FILE), content: "{}" } });
  assert.equal(reg?.hookSpecificOutput?.permissionDecision, "deny");
  const other = runHook(root, { hook_event_name: "PreToolUse", tool_name: "Edit", tool_input: { file_path: join(root, "src", "app.ts"), old_string: "1", new_string: "2" } });
  assert.notEqual(other?.hookSpecificOutput?.permissionDecision, "deny");
  // No registry committed at HEAD: every edit is refused.
  const fresh = repo(t);
  writeFileSync(join(fresh.root, LOCKS_FILE), "{ broken");
  const any = runHook(fresh.root, { hook_event_name: "PreToolUse", tool_name: "Edit", tool_input: { file_path: join(fresh.root, "src", "app.ts"), old_string: "1", new_string: "2" } });
  assert.equal(any?.hookSpecificOutput?.permissionDecision, "deny");
  assert.match(any.hookSpecificOutput.permissionDecisionReason, /corrupt[\s\S]*git checkout -- \.hunch\/locks\.json/);
});

test("lockSnapshot/lockChangesSince: registry changes and new problems only; registry advice never says git checkout", t => {
  const { root } = repo(t);
  assert.deepEqual(lockSnapshot(root), { v: 2, root: realpathNorm(root), registry: "absent", locks: [], files: {}, headDiff: [], committed: [] });
  setLock(root, HLD, { kind: "hld", approvedBy: "dave" });
  const before = lockSnapshot(root);
  assert.deepEqual(lockChangesSince(root, before), []);
  // Forge: rewrite the HLD and re-approve it in one go.
  writeFileSync(join(root, HLD), "# forged\n");
  setLock(root, HLD, { kind: "hld", approvedBy: "agent" });
  const changes = lockChangesSince(root, before);
  // The forged file is checked against the locks approved before the command.
  assert.deepEqual(changes.map((p) => p.kind), ["modified"]);
  const reason = lockProblemReason([{ kind: "removed", path: HLD }], "write");
  assert.match(reason, /removed or changed/);
  assert.match(reason, /do not try to restore the registry yourself/);
  assert.doesNotMatch(reason, /git checkout/);
  // A pre-existing problem is not re-blamed; a new one is.
  writeFileSync(join(root, HLD), "# drifted\n");
  assert.deepEqual(lockChangesSince(root, lockSnapshot(root)).filter((p) => p.path === HLD), []);
  setLock(root, "src/app.ts", { kind: "doc", approvedBy: "dave" });
  const two = lockSnapshot(root);
  writeFileSync(join(root, "src", "app.ts"), "x\n");
  assert.deepEqual(lockChangesSince(root, two).map((p) => [p.kind, p.path]), [["modified", "src/app.ts"]]);
});

test("headLocks reads the committed registry for a Hunch root nested in a larger repo", t => {
  const top = realpathSync(mkdtempSync(join(tmpdir(), "hunch-locks-nested-")));
  t.after(() => cleanupDir(top));
  const git = (...args: string[]) => execFileSync("git", ["-C", top, ...args], { env: gitEnv });
  git("init", "-q");
  const root = join(top, "pkg");
  mkdirSync(join(root, "docs", "hld"), { recursive: true });
  writeFileSync(join(root, HLD), "# hld\n");
  setLock(root, HLD, { kind: "hld", approvedBy: "dave" });
  git("add", "-A");
  git("commit", "-q", "-m", "nested");
  assert.deepEqual(headLocks(root)?.map((l) => l.path), [HLD]);
  writeFileSync(join(root, LOCKS_FILE), JSON.stringify({ version: 1, locks: [] }));
  assert.deepEqual(verifyLocks(root, { sinceHead: true }).map((p) => p.kind), ["removed"]);
});

test("hook (pipeline): forge + rewrite + commit inside ONE shell command is the documented gap (as in the base)", t => {
  const { root, git } = repo(t);
  lockAndCommit(root, git);
  const session = `s-lock-${randomUUID()}`;
  runHook(root, { session_id: session, hook_event_name: "PreToolUse", tool_name: "Bash", tool_input: { command: "x" } }, { pipeline: true });
  writeFileSync(join(root, HLD), "# forged\n");
  setLock(root, HLD, { kind: "hld", approvedBy: "dave" });
  git("add", "-A");
  git("commit", "-q", "-m", "forge");
  assert.deepEqual(verifyLocks(root, { sinceHead: true }), []);
  // Accepted gap: once the forged registry is committed, HEAD itself carries it, so nothing
  // here can tell it from a human's commit. Review .hunch/locks.json diffs in PR / CI.
  const out = runHook(root, { session_id: session, hook_event_name: "PostToolUse", tool_name: "Bash", tool_input: { command: "x" }, tool_response: { stdout: "" } }, { pipeline: true });
  assert.notEqual(out?.decision, "block");
});

test("hook (pipeline): a forged registry + rewritten file WITHOUT a commit is blocked", t => {
  const { root, git } = repo(t);
  lockAndCommit(root, git);
  const session = `s-lock-${randomUUID()}`;
  runHook(root, { session_id: session, hook_event_name: "PreToolUse", tool_name: "Bash", tool_input: { command: "x" } }, { pipeline: true });
  writeFileSync(join(root, HLD), "# forged\n");
  setLock(root, HLD, { kind: "hld", approvedBy: "dave" });
  const out = runHook(root, { session_id: session, hook_event_name: "PostToolUse", tool_name: "Bash", tool_input: { command: "x" }, tool_response: { stdout: "" } }, { pipeline: true });
  assert.equal(out?.decision, "block");
  assert.match(out.reason, /removed or changed in/);
});

test("hook (pipeline): a human re-lock before the turn is not blamed; a later registry change is, on its own Stop budget", t => {
  const { root, git } = repo(t);
  lockAndCommit(root, git);
  // The human re-approves new bytes in a terminal between turns, uncommitted.
  writeFileSync(join(root, HLD), "# v2 approved\n");
  setLock(root, HLD, { kind: "hld", approvedBy: "dave" });
  assert.equal(verifyLocks(root, { sinceHead: true }).length, 1); // a HEAD baseline would blame it
  const session = `s-lock-${randomUUID()}`;
  runHook(root, { session_id: session, hook_event_name: "UserPromptSubmit", prompt: "go" }, { pipeline: true });
  assert.doesNotMatch(JSON.stringify(runHook(root, { session_id: session, hook_event_name: "Stop" }, { pipeline: true }) ?? {}), /locked files/);
  const editInput = { file_path: join(root, "src", "app.ts"), old_string: "1", new_string: "2" };
  const clean = runHook(root, { session_id: session, hook_event_name: "PostToolUse", tool_name: "Edit", tool_input: editInput, tool_response: {} }, { pipeline: true });
  assert.notEqual(clean?.decision, "block");
  // The registry changes behind the edit tools' back: an edit-tool PostToolUse reports file
  // problems only (shell PostToolUse and Stop own registry changes).
  writeFileSync(join(root, LOCKS_FILE), JSON.stringify({ version: 1, locks: [] }));
  const edit = runHook(root, { session_id: session, hook_event_name: "PostToolUse", tool_name: "Edit", tool_input: editInput, tool_response: {} }, { pipeline: true });
  assert.notEqual(edit?.decision, "block");
  // Stop blocks twice from lockBlocks, then fails open.
  for (let i = 0; i < 2; i++) assert.match(JSON.stringify(runHook(root, { session_id: session, hook_event_name: "Stop" }, { pipeline: true }) ?? {}), /locked files/);
  assert.doesNotMatch(JSON.stringify(runHook(root, { session_id: session, hook_event_name: "Stop" }, { pipeline: true }) ?? {}), /locked files/);
});

test("lockBlocks is its own Stop budget and resets every turn", () => {
  const st = onPrompt({ ...emptyState(), blocks: 1, lockBlocks: 2 });
  assert.equal(st.lockBlocks, 0);
  assert.equal(st.blocks, 0);
});

test("cli: lock with unchanged bytes but a different --kind or --note is an update, not 'nothing to do'", t => {
  const { root, git } = repo(t);
  lockAndCommit(root, git);
  const run = (...args: string[]) => {
    try {
      return execFileSync(process.execPath, ["--import", tsxLoaderUrl(), cli, ...args], { cwd: root, encoding: "utf8", stdio: ["ignore", "pipe", "pipe"] });
    } catch (e) {
      const err = e as { stdout: string; stderr: string };
      return `${err.stdout}${err.stderr}`;
    }
  };
  assert.match(run("lock", HLD, "--reviewed-by", "dave", "--kind", "hld"), /nothing to do/);
  const kind = run("lock", HLD, "--reviewed-by", "dave", "--kind", "diagram");
  assert.doesNotMatch(kind, /nothing to do/);
  assert.match(kind, /interactive terminal/);
  assert.doesNotMatch(run("lock", HLD, "--reviewed-by", "dave", "--note", "new note"), /nothing to do/);
});

function bashPre(root: string, session: string, agent?: string) {
  return runHook(root, { session_id: session, ...(agent ? { agent_id: agent } : {}), hook_event_name: "PreToolUse", tool_name: "Bash", tool_input: { command: "x" } }, { pipeline: true });
}
function bashPost(root: string, session: string, agent?: string) {
  return runHook(root, { session_id: session, ...(agent ? { agent_id: agent } : {}), hook_event_name: "PostToolUse", tool_name: "Bash", tool_input: { command: "x" }, tool_response: { stdout: "" } }, { pipeline: true });
}

test("lockChangesSince: an already-drifted locked file that changes again is reported; untouched drift is not", t => {
  const { root, git } = repo(t);
  lockAndCommit(root, git);
  writeFileSync(join(root, HLD), "# drifted before\n");
  const before = lockSnapshot(root);
  assert.deepEqual(lockChangesSince(root, before), []);
  writeFileSync(join(root, HLD), "# drifted again\n");
  assert.deepEqual(lockChangesSince(root, before).map((p) => [p.kind, p.path]), [["modified", HLD]]);
});

test("lockChangesSince: after a corrupted registry, a rewrite of the HLD is checked against the approved locks", t => {
  const { root, git } = repo(t);
  lockAndCommit(root, git);
  const a = lockSnapshot(root);
  writeFileSync(join(root, LOCKS_FILE), "{ broken");
  assert.deepEqual(lockChangesSince(root, a).map((p) => p.kind), ["registry"]);
  const b = lockSnapshot(root);
  assert.equal(b.registry, "corrupt");
  writeFileSync(join(root, HLD), "# rewritten\n");
  assert.deepEqual(lockChangesSince(root, b).map((p) => [p.kind, p.path]), [["modified", HLD]]);
});

test("hook: a deleted registry does not switch file checks off; PreToolUse still protects HEAD's locks", t => {
  const { root, git } = repo(t);
  lockAndCommit(root, git);
  const session = `s-lock-${randomUUID()}`;
  runHook(root, { session_id: session, hook_event_name: "UserPromptSubmit", prompt: "go" }, { pipeline: true });
  bashPre(root, session);
  rmSync(join(root, LOCKS_FILE));
  assert.equal(bashPost(root, session)?.decision, "block");
  bashPre(root, session);
  writeFileSync(join(root, HLD), "# rewritten\n");
  const out = bashPost(root, session);
  assert.equal(out?.decision, "block");
  assert.match(out.reason, /docs\/hld\/payments\.md/);
  const edit = runHook(root, { session_id: session, hook_event_name: "PreToolUse", tool_name: "Edit", tool_input: { file_path: join(root, HLD), old_string: "x", new_string: "y" } }, { pipeline: true });
  assert.equal(edit?.hookSpecificOutput?.permissionDecision, "deny");
});

test("hook: an edit in another checkout with no locks is not measured against this checkout's turn baseline", t => {
  const { root, git } = repo(t);
  lockAndCommit(root, git);
  const other = repo(t);
  const session = `s-lock-${randomUUID()}`;
  runHook(root, { session_id: session, hook_event_name: "UserPromptSubmit", prompt: "go" }, { pipeline: true });
  const out = runHook(other.root, { session_id: session, cwd: other.root, hook_event_name: "PostToolUse", tool_name: "Edit", tool_input: { file_path: join(other.root, "src", "app.ts"), old_string: "1", new_string: "2" }, tool_response: {} }, { pipeline: true });
  assert.notEqual(out?.decision, "block");
});

test("lockChangesSince: a CRLF re-checkout of the same registry is not a registry change", t => {
  const { root, git } = repo(t);
  lockAndCommit(root, git);
  const before = lockSnapshot(root);
  writeFileSync(join(root, LOCKS_FILE), readFileSync(join(root, LOCKS_FILE), "utf8").replace(/\n/g, "\r\n"));
  assert.deepEqual(lockChangesSince(root, before), []);
});

test("hook: '..', apply_patch '..' and cwd-relative apply_patch spellings of a locked file or the registry are denied", t => {
  const { root, git } = repo(t);
  lockAndCommit(root, git);
  const dir = root.split(/[\\/]/).pop()!;
  const deny = (o: unknown) => assert.equal((o as { hookSpecificOutput?: { permissionDecision?: string } })?.hookSpecificOutput?.permissionDecision, "deny");
  for (const target of [HLD, LOCKS_FILE]) {
    deny(runHook(root, { hook_event_name: "PreToolUse", tool_name: "Edit", tool_input: { file_path: `../${dir}/${target}`, old_string: "a", new_string: "b" } }));
    const up = `*** Begin Patch\n*** Update File: ../${dir}/${target}\n@@\n-a\n+b\n*** End Patch\n`;
    deny(runHook(root, { hook_event_name: "PreToolUse", tool_name: "apply_patch", tool_input: { input: up } }, { provider: "codex" }));
  }
  const sub = `*** Begin Patch\n*** Update File: hld/payments.md\n@@\n-a\n+b\n*** End Patch\n`;
  deny(runHook(root, { cwd: join(root, "docs"), hook_event_name: "PreToolUse", tool_name: "apply_patch", tool_input: { input: sub } }, { provider: "codex" }));
  const reg = `*** Begin Patch\n*** Update File: locks.json\n@@\n-a\n+b\n*** End Patch\n`;
  deny(runHook(root, { cwd: join(root, ".hunch"), hook_event_name: "PreToolUse", tool_name: "apply_patch", tool_input: { input: reg } }, { provider: "codex" }));
});

test("cli: lock without --kind keeps the existing lock's kind (unchanged ADR → nothing to do)", t => {
  const { root, git } = repo(t);
  setLock(root, HLD, { kind: "adr", approvedBy: "dave", at: "2026-11-17T10:00:00Z" });
  git("add", "-A");
  git("commit", "-q", "-m", "lock adr");
  const out = (() => {
    try {
      return execFileSync(process.execPath, ["--import", tsxLoaderUrl(), cli, "lock", HLD, "--reviewed-by", "dave"], { cwd: root, encoding: "utf8", stdio: ["ignore", "pipe", "pipe"] });
    } catch (e) {
      const err = e as { stdout: string; stderr: string };
      return `${err.stdout}${err.stderr}`;
    }
  })();
  assert.match(out, /nothing to do/);
});

test("hook: concurrent agents keep their own pre-command snapshot", t => {
  const { root, git } = repo(t);
  lockAndCommit(root, git);
  const session = `s-lock-${randomUUID()}`;
  bashPre(root, session, "agent-a");
  writeFileSync(join(root, HLD), "# rewritten by A\n");
  bashPre(root, session, "agent-b");
  const out = bashPost(root, session, "agent-a");
  assert.equal(out?.decision, "block");
  assert.match(out.reason, /docs\/hld\/payments\.md/);
});

// ---- round 3: judged against HEAD like the base; no git-arrival exemption ----

const BLOCKED = /human-approved locked files/;
const ORDERS = "docs/hld/orders.md";

/** A teammate clone of `root` (root's "origin"); the teammate commits a lock on ORDERS (and, optionally, re-approves the HLD). */
function teammate(t: { after: (f: () => void) => void }, root: string, git: (...a: string[]) => unknown, opts: { reapproveHld?: boolean } = {}) {
  const dir = realpathSync(mkdtempSync(join(tmpdir(), "hunch-locks-mate-")));
  t.after(() => cleanupDir(dir));
  execFileSync("git", ["clone", "-q", root, dir], { env: gitEnv });
  const mg = (...args: string[]) => execFileSync("git", ["-C", dir, ...args], { env: gitEnv });
  mg("config", "core.autocrlf", "false");
  writeFileSync(join(dir, ORDERS), "# Orders\n");
  setLock(dir, ORDERS, { kind: "hld", approvedBy: "ann", at: "2026-11-18T10:00:00Z" });
  if (opts.reapproveHld) {
    writeFileSync(join(dir, HLD), "# Payments HLD v2 (ann)\n");
    setLock(dir, HLD, { kind: "hld", approvedBy: "ann", at: "2026-11-18T11:00:00Z" });
  }
  mg("add", "-A");
  mg("commit", "-q", "-m", "ann locks");
  git("remote", "add", "origin", dir);
  const branch = execFileSync("git", ["-C", dir, "branch", "--show-current"], { encoding: "utf8" }).trim();
  return { dir, branch };
}

/** One turn through the real hook: prompt, shell Pre, `act`, shell Post, Stop. */
function hookTurn(root: string, act: () => void, session = `s-lock-${randomUUID()}`) {
  runHook(root, { session_id: session, hook_event_name: "UserPromptSubmit", prompt: "go" }, { pipeline: true });
  bashPre(root, session);
  act();
  const post = bashPost(root, session);
  const stop = runHook(root, { session_id: session, hook_event_name: "Stop" }, { pipeline: true });
  return { post: post?.decision === "block" && BLOCKED.test(String(post.reason)), stop: BLOCKED.test(JSON.stringify(stop ?? {})), session };
}

test("hook: git pull --no-rebase (merge) bringing a teammate's lock is not blamed (shell PostToolUse and Stop)", t => {
  const { root, git } = repo(t);
  lockAndCommit(root, git);
  const { branch } = teammate(t, root, git);
  writeFileSync(join(root, "src", "app.ts"), "export const app = 2;\n");
  git("add", "-A");
  git("commit", "-q", "-m", "local unpushed");
  const r = hookTurn(root, () => git("pull", "--no-rebase", "--no-edit", "origin", branch));
  assert.ok(readLocks(root).locks.some((l) => l.path === ORDERS));
  assert.deepEqual([r.post, r.stop], [false, false]);
});

test("hook: git pull --rebase with a local unpushed commit bringing a teammate's lock is not blamed", t => {
  const { root, git } = repo(t);
  lockAndCommit(root, git);
  const { branch } = teammate(t, root, git);
  writeFileSync(join(root, "src", "app.ts"), "export const app = 2;\n");
  git("add", "-A");
  git("commit", "-q", "-m", "local unpushed");
  const r = hookTurn(root, () => git("pull", "--rebase", "origin", branch));
  assert.ok(readLocks(root).locks.some((l) => l.path === ORDERS));
  assert.deepEqual([r.post, r.stop], [false, false]);
});

test("lockChangesSince: a local-only checkout of a branch carrying a human-committed lock is not blamed", t => {
  const { root, git } = repo(t);
  lockAndCommit(root, git);
  const main = execFileSync("git", ["-C", root, "branch", "--show-current"], { encoding: "utf8" }).trim();
  git("checkout", "-q", "-b", "other");
  writeFileSync(join(root, ORDERS), "# Orders\n");
  setLock(root, ORDERS, { kind: "hld", approvedBy: "ann", at: "2026-11-18T10:00:00Z" });
  git("add", "-A");
  git("commit", "-q", "-m", "ann locks orders");
  git("checkout", "-q", main);
  const before = lockSnapshot(root);
  git("checkout", "-q", "other");
  assert.deepEqual(lockChangesSince(root, before), []);
});

test("lockChangesSince: a fast-forward pull with a teammate's lock does not blame the human's untouched drift", t => {
  const { root, git } = repo(t);
  lockAndCommit(root, git);
  const { branch } = teammate(t, root, git);
  writeFileSync(join(root, HLD), "# human mid-edit, not re-locked\n");
  const before = lockSnapshot(root);
  git("pull", "--ff-only", "origin", branch);
  assert.ok(readLocks(root).locks.some((l) => l.path === ORDERS));
  assert.deepEqual(lockChangesSince(root, before), []);
});

test("lockChangesSince: a teammate's re-approval (new sha + new content) arriving by pull is not blamed", t => {
  const { root, git } = repo(t);
  lockAndCommit(root, git);
  const { branch } = teammate(t, root, git, { reapproveHld: true });
  const before = lockSnapshot(root);
  git("pull", "--ff-only", "origin", branch);
  assert.equal(fileSha(root, HLD), readLocks(root).locks.find((l) => l.path === HLD)?.sha256);
  assert.deepEqual(lockChangesSince(root, before), []);
});

test("lockChangesSince: forge + commit in one command is the documented gap; forge without a commit is blocked", t => {
  const { root, git } = repo(t);
  lockAndCommit(root, git);
  const before = lockSnapshot(root);
  writeFileSync(join(root, HLD), "# forged\n");
  setLock(root, HLD, { kind: "hld", approvedBy: "agent" });
  assert.deepEqual(lockChangesSince(root, before).map((p) => p.kind).sort(), ["modified", "removed"]);
  git("add", "-A");
  git("commit", "-q", "-m", "forge");
  // Accepted gap (see the header of core/locks.ts): HEAD now carries the forgery, so a
  // hook cannot tell it from a human's commit. CI / PR review of .hunch/locks.json catches it.
  assert.deepEqual(lockChangesSince(root, before), []);
});

test("lockChangesSince: a human's uncommitted re-lock before the turn is not blamed; the agent changing that entry is", t => {
  const { root, git } = repo(t);
  lockAndCommit(root, git);
  writeFileSync(join(root, HLD), "# v2 approved\n");
  setLock(root, HLD, { kind: "hld", approvedBy: "dave" });
  const before = lockSnapshot(root);
  assert.equal(before.headDiff.length, 1);
  assert.deepEqual(lockChangesSince(root, before), []);
  // The agent re-points the same entry (new bytes + new approval): new key, reported.
  writeFileSync(join(root, HLD), "# v3 by the agent\n");
  setLock(root, HLD, { kind: "hld", approvedBy: "agent" });
  assert.deepEqual(lockChangesSince(root, before).map((p) => p.kind).sort(), ["modified", "removed"]);
  // Re-pointing only the kind is a new key too.
  writeFileSync(join(root, HLD), "# v2 approved\n");
  setLock(root, HLD, { kind: "adr", approvedBy: "dave" });
  assert.deepEqual(lockChangesSince(root, before).map((p) => p.kind), ["removed"]);
});

test("lockChangesSince: deleted or corrupted registry followed by an HLD rewrite is reported", t => {
  const { root, git } = repo(t);
  lockAndCommit(root, git);
  const before = lockSnapshot(root);
  rmSync(join(root, LOCKS_FILE));
  writeFileSync(join(root, HLD), "# rewritten\n");
  assert.deepEqual(lockChangesSince(root, before).map((p) => [p.kind, p.path]).sort(), [["modified", HLD], ["removed", HLD]]);
  git("checkout", "--", LOCKS_FILE);
  writeFileSync(join(root, LOCKS_FILE), "{ broken");
  assert.deepEqual(lockChangesSince(root, before).map((p) => [p.kind, p.path]).sort(), [["modified", HLD], ["registry", LOCKS_FILE]]);
});

test("lockChangesSince: no registry at snapshot and none now means no problems", t => {
  const { root } = repo(t);
  const before = lockSnapshot(root);
  assert.deepEqual(lockChangesSince(root, before), []);
  assert.deepEqual(lockStillBad(root, []), []);
});

test("hook (pipeline): an agent's drift reported in turn 1 still blocks Stop in turn 2 until restored", t => {
  const { root, git } = repo(t);
  lockAndCommit(root, git);
  const session = `s-lock-${randomUUID()}`;
  const turn1 = hookTurn(root, () => writeFileSync(join(root, HLD), "# rewritten by the agent\n"), session);
  assert.deepEqual([turn1.post, turn1.stop], [true, true]);
  // Turn 2: the drifted tree is now this turn's baseline, yet the blamed path stays held.
  runHook(root, { session_id: session, hook_event_name: "UserPromptSubmit", prompt: "continue" }, { pipeline: true });
  assert.match(JSON.stringify(runHook(root, { session_id: session, hook_event_name: "Stop" }, { pipeline: true }) ?? {}), BLOCKED);
  git("checkout", "--", HLD);
  runHook(root, { session_id: session, hook_event_name: "UserPromptSubmit", prompt: "again" }, { pipeline: true });
  assert.doesNotMatch(JSON.stringify(runHook(root, { session_id: session, hook_event_name: "Stop" }, { pipeline: true }) ?? {}), BLOCKED);
});

test("hook: no git spawn for the lock check on an edit-tool PostToolUse in a repo without locks.json", t => {
  const traced = (root: string) => {
    const trace = join(root, "..", `trace-${randomUUID()}.json`);
    t.after(() => rmSync(trace, { force: true }));
    const session = `s-lock-${randomUUID()}`;
    runHook(root, { session_id: session, hook_event_name: "UserPromptSubmit", prompt: "go" }, { pipeline: true });
    const old = process.env.GIT_TRACE2_EVENT;
    process.env.GIT_TRACE2_EVENT = trace;
    try {
      runHook(root, { session_id: session, hook_event_name: "PostToolUse", tool_name: "Edit", tool_input: { file_path: join(root, "src", "app.ts"), old_string: "1", new_string: "2" }, tool_response: {} }, { pipeline: true });
    } finally {
      if (old === undefined) delete process.env.GIT_TRACE2_EVENT; else process.env.GIT_TRACE2_EVENT = old;
    }
    return readFileSync(trace, { encoding: "utf8", flag: "a+" }).split("\n").filter((l) => l.includes('"event":"start"') && l.includes("locks.json")).length;
  };
  const plain = repo(t);
  assert.equal(traced(plain.root), 0);
  // Control: with a registry the same event does consult HEAD, so the trace can see it.
  const locked = repo(t);
  lockAndCommit(locked.root, locked.git);
  assert.ok(traced(locked.root) >= 1);
});

test("a lock on a file named '..notes.md' (in-repo, two leading dots) is found and its edit denied", t => {
  const { root, git } = repo(t);
  writeFileSync(join(root, "..notes.md"), "# notes\n");
  setLock(root, "..notes.md", { kind: "doc", approvedBy: "dave" });
  git("add", "-A");
  git("commit", "-q", "-m", "lock notes");
  assert.ok(lockFor(root, readLocks(root).locks, "..notes.md"));
  const out = runHook(root, { hook_event_name: "PreToolUse", tool_name: "Edit", tool_input: { file_path: join(root, "..notes.md"), old_string: "n", new_string: "m" } });
  assert.equal(out?.hookSpecificOutput?.permissionDecision, "deny");
});

/** `main` holds an older unlocked draft; `design` commits the approved doc + its lock. */
function designBranch(root: string, git: (...a: string[]) => unknown) {
  const main = execFileSync("git", ["-C", root, "branch", "--show-current"], { encoding: "utf8" }).trim();
  git("checkout", "-q", "-b", "design");
  writeFileSync(join(root, HLD), "# Payments HLD (approved)\n");
  lockAndCommit(root, git);
  return main;
}

test("lockChangesSince: checking out a branch that predates a committed lock is not blamed", t => {
  const { root, git } = repo(t);
  const main = designBranch(root, git);
  const before = lockSnapshot(root);
  assert.deepEqual(before.committed, [HLD]);
  git("checkout", "-q", main);
  assert.deepEqual(lockChangesSince(root, before), []);
});

test("hook: checking out a branch that predates a committed lock blocks neither PostToolUse(Bash) nor Stop", t => {
  const { root, git } = repo(t);
  const main = designBranch(root, git);
  const r = hookTurn(root, () => git("checkout", "-q", main));
  assert.deepEqual([r.post, r.stop], [false, false]);
});

test("lockChangesSince: checking out a branch without the locked file is not blamed", t => {
  const { root, git } = repo(t);
  const main = execFileSync("git", ["-C", root, "branch", "--show-current"], { encoding: "utf8" }).trim();
  git("checkout", "-q", "-b", "bare");
  git("rm", "-q", HLD);
  git("commit", "-q", "-m", "no hld");
  git("checkout", "-q", main);
  designBranch(root, git);
  const before = lockSnapshot(root);
  git("checkout", "-q", "bare");
  assert.deepEqual(lockChangesSince(root, before), []);
});

test("lockChangesSince: a fast-forward pull of a teammate's unlock + edit is not blamed", t => {
  const { root, git } = repo(t);
  lockAndCommit(root, git);
  const dir = realpathSync(mkdtempSync(join(tmpdir(), "hunch-locks-mate-")));
  t.after(() => cleanupDir(dir));
  execFileSync("git", ["clone", "-q", root, dir], { env: gitEnv });
  const mg = (...args: string[]) => execFileSync("git", ["-C", dir, ...args], { env: gitEnv });
  mg("config", "core.autocrlf", "false");
  removeLock(dir, HLD);
  writeFileSync(join(dir, HLD), "# Payments HLD rewritten after unlock (ann)\n");
  mg("add", "-A");
  mg("commit", "-q", "-m", "ann unlocks + edits");
  git("remote", "add", "origin", dir);
  const branch = execFileSync("git", ["-C", dir, "branch", "--show-current"], { encoding: "utf8" }).trim();
  const before = lockSnapshot(root);
  git("pull", "-q", "--ff-only", "origin", branch);
  assert.deepEqual(lockChangesSince(root, before), []);
});

test("lockChangesSince: an UNCOMMITTED human lock still catches the agent checking out old bytes", t => {
  const { root, git } = repo(t);
  writeFileSync(join(root, HLD), "# Payments HLD v2\n");
  git("add", "-A");
  git("commit", "-q", "-m", "v2");
  setLock(root, HLD, { kind: "hld", approvedBy: "dave" });
  const before = lockSnapshot(root);
  assert.deepEqual(before.committed, []);
  git("checkout", "HEAD~1", "--", HLD);
  assert.deepEqual(lockChangesSince(root, before).map((p) => `${p.kind}:${p.path}`), [`modified:${HLD}`]);
});

test("lockChangesSince: a failed HEAD read fails open for a teammate's pulled re-approval", t => {
  const { root, git } = repo(t);
  lockAndCommit(root, git);
  const { branch } = teammate(t, root, git, { reapproveHld: true });
  const before = lockSnapshot(root);
  git("pull", "-q", "--ff-only", "origin", branch);
  const path = process.env.PATH;
  process.env.PATH = "";
  try {
    assert.equal(readHeadLocks(root).status, "failed");
    assert.deepEqual(lockChangesSince(root, before), []);
    assert.deepEqual(lockStillBad(root, [HLD]), []);
  } finally {
    process.env.PATH = path;
  }
  assert.equal(readHeadLocks(root).status, "ok");
});
