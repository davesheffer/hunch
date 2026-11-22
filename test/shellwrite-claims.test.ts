import { cleanupDir } from "./fixtures.js";
import { test } from "node:test";
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { mkdirSync, mkdtempSync, realpathSync, utimesSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { mkConstraint, tsxLoaderUrl } from "./helpers.js";
import { hunchPaths } from "../src/core/paths.js";
import { HunchStore } from "../src/store/hunchStore.js";
import { claimedByOthers, noteEditedFiles, refreshShellBaseline, shellWrittenFiles } from "../src/core/shellwrites.js";

// Two sessions share one checkout. A file the other session wrote through its edit
// tools while this session's shell command ran is not grounded as "this command
// wrote it" — but it is still a written file for the Veto and the Stop gate, since
// the command may have written it too before the other edit landed.

function repo(t: { after: (f: () => void) => void }): string {
  const root = realpathSync(mkdtempSync(join(tmpdir(), "hunch-shellclaims-")));
  t.after(() => cleanupDir(root));
  const git = (...args: string[]) => execFileSync("git", ["-C", root, ...args], { env: { ...process.env, GIT_AUTHOR_NAME: "t", GIT_AUTHOR_EMAIL: "t@t", GIT_COMMITTER_NAME: "t", GIT_COMMITTER_EMAIL: "t@t" } });
  git("init", "-q");
  mkdirSync(join(root, "src"));
  writeFileSync(join(root, "src", "a.ts"), "export const a = 1;\n");
  writeFileSync(join(root, "src", "b.ts"), "export const b = 1;\n");
  git("add", "-A");
  git("commit", "-q", "-m", "init");
  return root;
}
function write(path: string, text: string, secondsAhead: number): void {
  writeFileSync(path, text);
  const at = new Date(Date.now() + secondsAhead * 1000);
  utimesSync(path, at, at);
}
const session = () => `shellclaims-${process.pid}-${Math.random().toString(36).slice(2)}`;
const ground = (root: string, s: string, agent?: string) => {
  const written = shellWrittenFiles(root, s, agent);
  const others = claimedByOthers(root, s, agent, written);
  return { written, grounded: written.filter((f) => !others.has(f)) };
};

test("another session's edit during this session's command is enforced but not grounded as this command's", t => {
  const root = repo(t);
  const mine = session();
  const other = session();
  refreshShellBaseline(root, mine);
  write(join(root, "src", "a.ts"), "export const a = 2;\n", 1);
  noteEditedFiles(root, other, undefined, ["src/a.ts"]);
  write(join(root, "src", "b.ts"), "export const b = 2;\n", 2);
  assert.deepEqual(ground(root, mine), { written: ["src/a.ts", "src/b.ts"], grounded: ["src/b.ts"] });
});

test("this command's write that another session then edits stays a written file", t => {
  // The command writes a.ts and keeps running; the other session edits a.ts; the command ends.
  const root = repo(t);
  const mine = session();
  const other = session();
  refreshShellBaseline(root, mine);
  write(join(root, "src", "a.ts"), "import x from 'forbidden';\n", 1);
  write(join(root, "src", "a.ts"), "import x from 'forbidden';\nexport const a = 2;\n", 2);
  noteEditedFiles(root, other, undefined, ["src/a.ts"]);
  assert.deepEqual(ground(root, mine).written, ["src/a.ts"], "the Veto and Stop gate still judge it");
});

test("a claimed file changed again after the claim is grounded", t => {
  const root = repo(t);
  const mine = session();
  const other = session();
  refreshShellBaseline(root, mine);
  write(join(root, "src", "a.ts"), "export const a = 2;\n", 1);
  noteEditedFiles(root, other, undefined, ["src/a.ts"]);
  write(join(root, "src", "a.ts"), "export const a = 33;\n", 2);
  assert.deepEqual(ground(root, mine).grounded, ["src/a.ts"]);
});

test("a failed edit claims nothing", t => {
  const root = repo(t);
  const mine = session();
  const other = session();
  refreshShellBaseline(root, mine);
  write(join(root, "src", "a.ts"), "export const a = 2;\n", 1);
  noteEditedFiles(root, other, undefined, ["src/a.ts"], false);
  assert.deepEqual(ground(root, mine).grounded, ["src/a.ts"]);
});

test("a subagent is another observer; an agent's own claim never hides its own write", t => {
  const root = repo(t);
  const mine = session();
  refreshShellBaseline(root, mine);
  write(join(root, "src", "a.ts"), "export const a = 2;\n", 1);
  noteEditedFiles(root, mine, "agent-1", ["src/a.ts"]);
  assert.deepEqual(ground(root, mine), { written: ["src/a.ts"], grounded: [] });
  write(join(root, "src", "b.ts"), "export const b = 2;\n", 2);
  noteEditedFiles(root, mine, undefined, ["src/b.ts"]);
  refreshShellBaseline(root, mine);
  write(join(root, "src", "b.ts"), "export const b = 3;\n", 3);
  assert.deepEqual(ground(root, mine).grounded, ["src/b.ts"]);
});

test("a shell result claims nothing: overlapping commands both ground a shared write", t => {
  const root = repo(t);
  const a = session();
  const b = session();
  refreshShellBaseline(root, a);
  refreshShellBaseline(root, b);
  write(join(root, "src", "a.ts"), "export const a = 2;\n", 1);
  assert.deepEqual(ground(root, b).grounded, ["src/a.ts"]);
  assert.deepEqual(ground(root, a).grounded, ["src/a.ts"], "b finishing first must not take a's write");
});

test("sessions that spell the root differently share claims (Windows drive case)", { skip: process.platform !== "win32" }, t => {
  const root = repo(t);
  const mine = session();
  const other = session();
  const flip = (r: string) => (r[0] === r[0]!.toUpperCase() ? r[0]!.toLowerCase() : r[0]!.toUpperCase()) + r.slice(1);
  refreshShellBaseline(root, mine);
  write(join(root, "src", "a.ts"), "export const a = 2;\n", 1);
  noteEditedFiles(flip(root), other, undefined, ["src/a.ts"]);
  assert.deepEqual(ground(root, mine).grounded, []);
  // One observer under two spellings stays one owner: its own claim hides nothing from itself.
  write(join(root, "src", "b.ts"), "export const b = 2;\n", 2);
  noteEditedFiles(flip(root), mine, undefined, ["src/b.ts"]);
  assert.deepEqual(claimedByOthers(root, mine, undefined, ["src/b.ts"]).size, 0);
});

// Real `hunch hook` CLI wiring: the PostToolUse shell path must ground only files no
// other observer claimed, while enforcement still judges every written file.

function hookRepo(t: { after: (f: () => void) => void }, firmness: string): string {
  const root = repo(t);
  mkdirSync(join(root, ".hunch"), { recursive: true });
  writeFileSync(join(root, ".hunch", "config.json"), JSON.stringify({ firmness }));
  const store = new HunchStore(hunchPaths(root));
  store.json.ensureDirs();
  store.json.put("constraints", mkConstraint({ id: "con_nolodash", statement: "never use lodash", scope: ["**/*.ts"], severity: "blocking", forbids: { deps: ["lodash"], symbols: [], patterns: [] } }));
  store.reindex();
  store.close();
  return root;
}
const hookCli = resolve("src/cli/index.ts");
function hook(root: string, payload: Record<string, unknown>): string {
  return execFileSync(process.execPath, ["--import", tsxLoaderUrl(), hookCli, "hook", "--provider", "claude"], {
    cwd: root, env: { ...process.env, HUNCH_PIPELINE: "0" },
    input: JSON.stringify({ cwd: root, tool_name: "Bash", tool_input: { command: "ls" }, ...payload }), encoding: "utf8",
  });
}
const editEvt = (root: string, s: string, rel: string, extra: Record<string, unknown> = {}) => ({
  hook_event_name: "PostToolUse", session_id: s, tool_name: "Edit",
  tool_input: { file_path: join(root, rel), old_string: "1", new_string: "2" },
  tool_response: { filePath: join(root, rel), oldString: "1", newString: "2" }, ...extra });

test("hook: another session's Edit during my command is not grounded as mine; my own write is", t => {
  const root = hookRepo(t, "advisory");
  const mine = session();
  const other = session();
  hook(root, { hook_event_name: "PreToolUse", session_id: mine });
  write(join(root, "src", "a.ts"), "export const a = 2;\n", 1);
  hook(root, editEvt(root, other, "src/a.ts"));
  write(join(root, "src", "b.ts"), "export const b = 2;\n", 2);
  const out = hook(root, { hook_event_name: "PostToolUse", session_id: mine });
  assert.match(out, /this shell command wrote src\/b\.ts\./);
  assert.doesNotMatch(out, /src\/a\.ts/);
});

test("hook: strict mode still blocks my forbidden shell write after another session claims the file", t => {
  const root = hookRepo(t, "strict");
  const mine = session();
  const other = session();
  hook(root, { hook_event_name: "PreToolUse", session_id: mine });
  write(join(root, "src", "a.ts"), 'import _ from "lodash";\nexport const a = 2;\n', 1);
  hook(root, editEvt(root, other, "src/a.ts"));
  const out = hook(root, { hook_event_name: "PostToolUse", session_id: mine });
  assert.equal(JSON.parse(out).decision, "block");
});

test("hook: another session's failed Edit (PostToolUseFailure) claims nothing, so my write is grounded", t => {
  const root = hookRepo(t, "advisory");
  const mine = session();
  const other = session();
  hook(root, { hook_event_name: "PreToolUse", session_id: mine });
  write(join(root, "src", "a.ts"), "export const a = 2;\n", 1);
  hook(root, editEvt(root, other, "src/a.ts", { hook_event_name: "PostToolUseFailure", tool_response: undefined, error: "File has been modified since read" }));
  const out = hook(root, { hook_event_name: "PostToolUse", session_id: mine });
  assert.match(out, /this shell command wrote src\/a\.ts\./);
});
