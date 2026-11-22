import { cleanupDir } from "./fixtures.js";
import { test } from "node:test";
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { mkdirSync, mkdtempSync, realpathSync, renameSync, rmSync, utimesSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { mkConstraint, tsxLoaderUrl } from "./helpers.js";
import { hunchPaths } from "../src/core/paths.js";
import { HunchStore } from "../src/store/hunchStore.js";
import { refreshShellBaseline, shellWrittenFiles } from "../src/core/shellwrites.js";
import { constraintForWrittenFiles } from "../src/core/shellveto.js";

function repo(t: { after: (f: () => void) => void }): string {
  // Real path: the hook keys baselines by the root it resolves (macOS tmpdir is a /private symlink).
  const root = realpathSync(mkdtempSync(join(tmpdir(), "hunch-shellwrites-")));
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
/** A write the fingerprint can see even inside one clock tick. */
function write(path: string, text: string, secondsAhead: number): void {
  writeFileSync(path, text);
  const at = new Date(Date.now() + secondsAhead * 1000);
  utimesSync(path, at, at);
}
const session = () => `shellwrites-${process.pid}-${Math.random().toString(36).slice(2)}`;

test("without a baseline nothing is attributed; the first observation becomes the baseline", t => {
  const root = repo(t);
  const s = session();
  write(join(root, "src", "a.ts"), "export const a = 2;\n", 1);
  assert.deepEqual(shellWrittenFiles(root, s), [], "an earlier edit is not this command's write");
  write(join(root, "src", "b.ts"), "export const b = 2;\n", 2);
  assert.deepEqual(shellWrittenFiles(root, s), ["src/b.ts"]);
});

test("a command's writes are the dirty files whose fingerprint moved: new, modified again, untracked", t => {
  const root = repo(t);
  const s = session();
  write(join(root, "src", "a.ts"), "export const a = 2;\n", 1); // dirty before the prompt
  refreshShellBaseline(root, s);
  assert.deepEqual(shellWrittenFiles(root, s), [], "a read-only command wrote nothing");
  write(join(root, "src", "a.ts"), "export const a = 3;\n", 2); // already-dirty file written again
  write(join(root, "src", "b.ts"), "export const b = 2;\n", 2);
  write(join(root, "src", "new.ts"), "export const n = 1;\n", 2);
  assert.deepEqual(shellWrittenFiles(root, s), ["src/a.ts", "src/b.ts", "src/new.ts"]);
  assert.deepEqual(shellWrittenFiles(root, s), [], "the baseline moved forward");
});

test("Hunch's own state, deletions and reverts are not writes to ground", t => {
  const root = repo(t);
  const s = session();
  write(join(root, "src", "b.ts"), "export const b = 2;\n", 1);
  refreshShellBaseline(root, s);
  mkdirSync(join(root, ".hunch", "tasks"), { recursive: true });
  write(join(root, ".hunch", "tasks", "t.json"), "{}", 2);
  rmSync(join(root, "src", "a.ts"));
  execFileSync("git", ["-C", root, "checkout", "-q", "--", "src/b.ts"]);
  assert.deepEqual(shellWrittenFiles(root, s), []);
});

test("a renamed file is reported at its new path", t => {
  const root = repo(t);
  const s = session();
  refreshShellBaseline(root, s);
  execFileSync("git", ["-C", root, "mv", "src/a.ts", "src/renamed.ts"]);
  assert.deepEqual(shellWrittenFiles(root, s), ["src/renamed.ts"]);
});

test("outside a git repository or without a session, nothing is reported and nothing throws", t => {
  const dir = mkdtempSync(join(tmpdir(), "hunch-shellwrites-nogit-"));
  t.after(() => cleanupDir(dir));
  refreshShellBaseline(dir, "s");
  assert.deepEqual(shellWrittenFiles(dir, "s"), []);
  const root = repo(t);
  assert.deepEqual(shellWrittenFiles(root, undefined), []);
  renameSync(join(root, "src"), join(root, "gone"));
  assert.doesNotThrow(() => shellWrittenFiles(root, "s"));
});

test("concurrent subagents keep separate baselines: one agent's write is not the other's", t => {
  const root = repo(t);
  const s = session();
  refreshShellBaseline(root, s, "agent-one");
  refreshShellBaseline(root, s, "agent-two");
  write(join(root, "src", "a.ts"), "export const a = 2;\n", 1); // agent-one's sed -i runs
  // agent-two's Read lands before agent-one's shell hook: with one shared
  // baseline it would absorb the write and agent-one would get no grounding.
  refreshShellBaseline(root, s, "agent-two");
  assert.deepEqual(shellWrittenFiles(root, s, "agent-one"), ["src/a.ts"]);
  // agent-two's read-only command is not credited with agent-one's write.
  assert.deepEqual(shellWrittenFiles(root, s, "agent-two"), []);
  write(join(root, "src", "b.ts"), "export const b = 2;\n", 2);
  assert.deepEqual(shellWrittenFiles(root, s, "agent-two"), ["src/b.ts"]);
  // No agent id keeps its own (session) baseline: none was taken yet.
  assert.deepEqual(shellWrittenFiles(root, s), []);
});

test("a subagent's start baseline grounds its first shell write", t => {
  const root = repo(t);
  const s = session();
  refreshShellBaseline(root, s); // the prompt's baseline carries no agent id
  refreshShellBaseline(root, s, "agent-new"); // SubagentStart
  write(join(root, "src", "a.ts"), "export const a = 2;\n", 1); // its first tool call: a shell write
  assert.deepEqual(shellWrittenFiles(root, s, "agent-new"), ["src/a.ts"]);
});

// ---- end-to-end: the real `hunch hook` SubagentStart path ----
const hookCli = resolve("src/cli/index.ts");
function subagentStart(root: string, payload: Record<string, unknown>): void {
  execFileSync(process.execPath, ["--import", tsxLoaderUrl(), hookCli, "hook", "--provider", "claude"], {
    cwd: root, env: { ...process.env, HUNCH_PIPELINE: "0" },
    input: JSON.stringify({ hook_event_name: "SubagentStart", cwd: root, agent_type: "general-purpose", ...payload }), encoding: "utf8",
  });
}

test("the SubagentStart hook takes the new agent's baseline, and never the session's without an agent id", t => {
  const root = repo(t);
  mkdirSync(join(root, ".hunch"));
  const s = session();
  subagentStart(root, { session_id: s, agent_id: "agent-cli" });
  write(join(root, "src", "a.ts"), "export const a = 2;\n", 1);
  assert.deepEqual(shellWrittenFiles(root, s, "agent-cli"), ["src/a.ts"], "the hook took this agent's baseline");
  // A parent write not yet grounded must survive a SubagentStart with no agent id.
  refreshShellBaseline(root, s);
  write(join(root, "src", "b.ts"), "export const b = 2;\n", 2);
  subagentStart(root, { session_id: s });
  assert.deepEqual(shellWrittenFiles(root, s), ["src/b.ts"]);
});

// ---- end-to-end: the shell tool's own PreToolUse and PostToolUse ----
function hook(root: string, payload: Record<string, unknown>): string {
  return execFileSync(process.execPath, ["--import", tsxLoaderUrl(), hookCli, "hook", "--provider", "claude"], {
    cwd: root, env: { ...process.env, HUNCH_PIPELINE: "0" },
    input: JSON.stringify({ cwd: root, tool_name: "Bash", tool_input: { command: "ls" }, ...payload }), encoding: "utf8",
  });
}

test("a file written before the shell command started is not blamed on it", t => {
  const root = repo(t);
  mkdirSync(join(root, ".hunch"));
  const s = session();
  refreshShellBaseline(root, s); // the prompt
  write(join(root, "src", "a.ts"), "export const a = 2;\n", 1); // a parallel tool or another process
  hook(root, { hook_event_name: "PreToolUse", session_id: s });
  assert.deepEqual(shellWrittenFiles(root, s), [], "a read-only command wrote nothing");
  hook(root, { hook_event_name: "PreToolUse", session_id: s, agent_id: "agent-x" });
  write(join(root, "src", "b.ts"), "export const b = 2;\n", 2);
  assert.deepEqual(shellWrittenFiles(root, s, "agent-x"), ["src/b.ts"], "a subagent's command is measured from its own start");
});

test("a shell write grounds once: the same file written again by another command stays silent", t => {
  const root = repo(t);
  mkdirSync(join(root, ".hunch"));
  writeFileSync(join(root, ".hunch", "config.json"), JSON.stringify({ firmness: "advisory" }));
  const store = new HunchStore(hunchPaths(root));
  store.json.ensureDirs();
  store.json.put("constraints", mkConstraint({ id: "con_shellrepeat", statement: "Keep module a free of side effects", scope: ["src/a.ts"], severity: "blocking" }));
  store.reindex(); store.close();
  const s = session();
  const run = (text: string, ahead: number): string => {
    hook(root, { hook_event_name: "PreToolUse", session_id: s });
    write(join(root, "src", "a.ts"), text, ahead);
    return hook(root, { hook_event_name: "PostToolUse", session_id: s });
  };
  assert.match(run("export const a = 2;\n", 1), /this shell command wrote src\/a\.ts/);
  assert.doesNotMatch(run("export const a = 3;\n", 2), /this shell command wrote/, "the same grounding is not served twice");
});

test("a git-redirecting environment (GIT_DIR, GIT_WORK_TREE, GIT_PREFIX) still reports a shell write at the root", t => {
  // The root looks like a toplevel (a .git dir with HEAD) but the environment points git
  // at an OUTER work tree: porcelain paths are then "pkg/src/a.ts", and only the
  // rev-parse --show-prefix branch strips "pkg/".
  const outer = repo(t);
  const root = join(outer, "pkg");
  mkdirSync(join(root, "src"), { recursive: true });
  writeFileSync(join(root, "src", "a.ts"), "export const a = 1;\n");
  execFileSync("git", ["-C", outer, "add", "-A"]);
  execFileSync("git", ["-C", outer, "-c", "user.name=t", "-c", "user.email=t@t", "commit", "-q", "-m", "pkg"]);
  mkdirSync(join(root, ".git"));
  writeFileSync(join(root, ".git", "HEAD"), "ref: refs/heads/main\n");
  const prior = { dir: process.env.GIT_DIR, tree: process.env.GIT_WORK_TREE, prefix: process.env.GIT_PREFIX };
  const restore = (name: string, v: string | undefined) => { if (v === undefined) delete process.env[name]; else process.env[name] = v; };
  t.after(() => { restore("GIT_DIR", prior.dir); restore("GIT_WORK_TREE", prior.tree); restore("GIT_PREFIX", prior.prefix); });
  process.env.GIT_DIR = join(outer, ".git");
  process.env.GIT_WORK_TREE = outer;
  process.env.GIT_PREFIX = "pkg/";
  const s = session();
  refreshShellBaseline(root, s);
  write(join(root, "src", "a.ts"), "export const a = 2;\n", 3);
  assert.deepEqual(shellWrittenFiles(root, s), ["src/a.ts"]);
});

// ---- a shell write that breaks a content-matched BLOCKING invariant ----
function lodashRepo(t: { after: (f: () => void) => void }, firmness: string): string {
  const root = repo(t);
  mkdirSync(join(root, ".hunch"));
  writeFileSync(join(root, ".hunch", "config.json"), JSON.stringify({ firmness }));
  const store = new HunchStore(hunchPaths(root));
  store.json.ensureDirs();
  store.json.put("constraints", mkConstraint({ id: "con_nolodash", statement: "never use lodash", scope: ["**/*.ts"], severity: "blocking", forbids: { deps: ["lodash"], symbols: [], patterns: [] } }));
  store.reindex(); store.close();
  return root;
}
function shellRun(root: string, s: string, path: string, text: string, ahead: number): string {
  hook(root, { hook_event_name: "PreToolUse", session_id: s });
  mkdirSync(join(path, ".."), { recursive: true });
  write(path, text, ahead);
  return hook(root, { hook_event_name: "PostToolUse", session_id: s });
}

test("strict: a shell command that writes a forbidden import is blocked back to the model, naming the invariant", t => {
  const root = lodashRepo(t, "strict");
  const s = session();
  const out = JSON.parse(shellRun(root, s, join(root, "src", "app", "x.ts"), 'import _ from "lodash";\n', 1));
  assert.equal(out.decision, "block");
  assert.match(out.reason, /src\/app\/x\.ts/);
  assert.match(out.reason, /never use lodash/);
  assert.match(out.reason, /con_nolodash/);
  assert.match(out.reason, /\+import lodash/);
});

test("strict: every shell write of a forbidden import blocks, even after the file's grounding was served", t => {
  const root = lodashRepo(t, "strict");
  const s = session();
  assert.equal(JSON.parse(shellRun(root, s, join(root, "src", "a.ts"), 'import _ from "lodash";\nexport const a = 2;\n', 1)).decision, "block");
  assert.equal(JSON.parse(shellRun(root, s, join(root, "src", "a.ts"), 'import _ from "lodash/groupBy";\nexport const a = 3;\n', 2)).decision, "block");
});

test("strict: a shell write that keeps the invariant is not blocked", t => {
  const root = lodashRepo(t, "strict");
  const s = session();
  const raw = shellRun(root, s, join(root, "src", "a.ts"), '// we avoid "lodash" here\nexport const a = 2;\n', 1);
  assert.doesNotMatch(raw, /"decision":"block"/);
});

test("strict: a forbidden import already committed is not blamed on an unrelated shell write", t => {
  const root = lodashRepo(t, "strict");
  writeFileSync(join(root, "src", "b.ts"), 'import _ from "lodash";\nexport const b = 1;\n');
  execFileSync("git", ["-C", root, "-c", "user.name=t", "-c", "user.email=t@t", "commit", "-qam", "legacy"]);
  const s = session();
  const raw = shellRun(root, s, join(root, "src", "b.ts"), 'import _ from "lodash";\nexport const b = 2;\n', 1);
  assert.doesNotMatch(raw, /"decision":"block"/);
});

test("advisory: a shell write of a forbidden import is reported as a violation, not blocked", t => {
  const root = lodashRepo(t, "advisory");
  const s = session();
  const raw = shellRun(root, s, join(root, "src", "a.ts"), 'import _ from "lodash";\n', 1);
  assert.doesNotMatch(raw, /"decision":"block"/);
  const out = JSON.parse(raw);
  assert.match(out.hookSpecificOutput.additionalContext, /break a BLOCKING invariant[\s\S]*never use lodash/);
});

test("strict: a git mv of a glob-named route file ([id].ts) with a committed forbidden import is not blamed on the move", t => {
  const root = lodashRepo(t, "strict");
  writeFileSync(join(root, "src", "[id].ts"), 'import _ from "lodash";\nexport const b = 1;\n');
  execFileSync("git", ["-C", root, "add", "-A"]);
  execFileSync("git", ["-C", root, "-c", "user.name=t", "-c", "user.email=t@t", "commit", "-qm", "route"]);
  const s = session();
  hook(root, { hook_event_name: "PreToolUse", session_id: s });
  mkdirSync(join(root, "src", "old"));
  execFileSync("git", ["-C", root, "mv", "src/[id].ts", "src/old/[id].ts"]);
  const at = new Date(Date.now() + 2000);
  utimesSync(join(root, "src", "old", "[id].ts"), at, at);
  const raw = hook(root, { hook_event_name: "PostToolUse", session_id: s });
  assert.doesNotMatch(raw, /"decision":"block"/);
});

test("strict: a git mv of a file with a committed forbidden import is not blamed on the move", t => {
  const root = lodashRepo(t, "strict");
  writeFileSync(join(root, "src", "b.ts"), 'import _ from "lodash";\nexport const b = 1;\n');
  execFileSync("git", ["-C", root, "-c", "user.name=t", "-c", "user.email=t@t", "commit", "-qam", "legacy"]);
  const s = session();
  hook(root, { hook_event_name: "PreToolUse", session_id: s });
  mkdirSync(join(root, "src", "old"));
  execFileSync("git", ["-C", root, "mv", "src/b.ts", "src/old/b.ts"]);
  const at = new Date(Date.now() + 2000);
  utimesSync(join(root, "src", "old", "b.ts"), at, at);
  const raw = hook(root, { hook_event_name: "PostToolUse", session_id: s });
  assert.doesNotMatch(raw, /"decision":"block"/);
});

function subRootRepo(t: { after: (f: () => void) => void }): { top: string; root: string } {
  const top = repo(t);
  const root = join(top, "pkg");
  mkdirSync(join(root, "src", "legacy"), { recursive: true });
  mkdirSync(join(top, "other"));
  writeFileSync(join(root, "src", "a.ts"), "export const a = 1;\n");
  writeFileSync(join(root, "src", "legacy", "b.ts"), 'import _ from "lodash";\nexport const b = 1;\n');
  writeFileSync(join(top, "other", "c.ts"), 'import _ from "lodash";\nexport const c = 1;\n');
  mkdirSync(join(root, ".hunch"));
  writeFileSync(join(root, ".hunch", "config.json"), JSON.stringify({ firmness: "strict" }));
  const store = new HunchStore(hunchPaths(root));
  store.json.ensureDirs();
  store.json.put("constraints", mkConstraint({ id: "con_nolodash", statement: "never use lodash", scope: ["**/*.ts"], severity: "blocking", forbids: { deps: ["lodash"], symbols: [], patterns: [] } }));
  store.reindex(); store.close();
  execFileSync("git", ["-C", top, "add", "-A"]);
  execFileSync("git", ["-C", top, "-c", "user.name=t", "-c", "user.email=t@t", "commit", "-qm", "pkg"]);
  execFileSync("git", ["-C", top, "config", "diff.relative", "true"]);
  return { top, root };
}

test("strict: a git mv inside a sub-root with diff.relative=true is not blamed on the move", t => {
  const { top, root } = subRootRepo(t);
  const s = session();
  hook(root, { hook_event_name: "PreToolUse", session_id: s });
  execFileSync("git", ["-C", top, "mv", "pkg/src/legacy/b.ts", "pkg/src/b2.ts"]);
  const at = new Date(Date.now() + 2000);
  utimesSync(join(root, "src", "b2.ts"), at, at);
  const raw = hook(root, { hook_event_name: "PostToolUse", session_id: s });
  assert.doesNotMatch(raw, /"decision":"block"/);
});

test("strict: a file moved into the Hunch root from outside it brings its forbidden import in as new", t => {
  const { top, root } = subRootRepo(t);
  const s = session();
  hook(root, { hook_event_name: "PreToolUse", session_id: s });
  execFileSync("git", ["-C", top, "mv", "other/c.ts", "pkg/src/c.ts"]);
  const at = new Date(Date.now() + 2000);
  utimesSync(join(root, "src", "c.ts"), at, at);
  const out = JSON.parse(hook(root, { hook_event_name: "PostToolUse", session_id: s }));
  assert.equal(out.decision, "block");
});

test("strict: a git mv then an unrelated edit is judged against the rename source, not as a new file", t => {
  const root = lodashRepo(t, "strict");
  writeFileSync(join(root, "src", "b.ts"), 'import _ from "lodash";\nexport const b = 1;\nexport const c = 2;\nexport const d = 3;\n');
  execFileSync("git", ["-C", root, "-c", "user.name=t", "-c", "user.email=t@t", "commit", "-qam", "legacy"]);
  const s = session();
  hook(root, { hook_event_name: "PreToolUse", session_id: s });
  mkdirSync(join(root, "src", "old"));
  execFileSync("git", ["-C", root, "mv", "src/b.ts", "src/old/b.ts"]);
  write(join(root, "src", "old", "b.ts"), 'import _ from "lodash";\nexport const b = 10;\nexport const c = 2;\nexport const d = 3;\n', 2);
  const raw = hook(root, { hook_event_name: "PostToolUse", session_id: s });
  assert.doesNotMatch(raw, /"decision":"block"/);
});

test("strict: a pure git mv into a second rule's scope is not blamed on the first rule's committed import", t => {
  const root = lodashRepo(t, "strict");
  const store = new HunchStore(hunchPaths(root));
  store.json.put("constraints", mkConstraint({ id: "con_noaxios", statement: "never use axios", scope: ["src/api/**"], severity: "blocking", forbids: { deps: ["axios"], symbols: [], patterns: [] } }));
  store.reindex(); store.close();
  mkdirSync(join(root, "src", "util"));
  writeFileSync(join(root, "src", "util", "x.ts"), 'import _ from "lodash";\nexport const x = 1;\n');
  execFileSync("git", ["-C", root, "add", "-A"]);
  execFileSync("git", ["-C", root, "-c", "user.name=t", "-c", "user.email=t@t", "commit", "-qm", "legacy"]);
  const s = session();
  hook(root, { hook_event_name: "PreToolUse", session_id: s });
  mkdirSync(join(root, "src", "api"));
  execFileSync("git", ["-C", root, "mv", "src/util/x.ts", "src/api/x.ts"]);
  const at = new Date(Date.now() + 2000);
  utimesSync(join(root, "src", "api", "x.ts"), at, at);
  assert.doesNotMatch(hook(root, { hook_event_name: "PostToolUse", session_id: s }), /"decision":"block"/);
});

test("strict: moving a legacy file aside and writing a clean file at its old path blames neither", t => {
  const root = lodashRepo(t, "strict");
  writeFileSync(join(root, "src", "b.ts"), 'import _ from "lodash";\nexport const b = 1;\n');
  execFileSync("git", ["-C", root, "-c", "user.name=t", "-c", "user.email=t@t", "commit", "-qam", "legacy"]);
  const s = session();
  hook(root, { hook_event_name: "PreToolUse", session_id: s });
  mkdirSync(join(root, "src", "legacy"));
  execFileSync("git", ["-C", root, "mv", "src/b.ts", "src/legacy/b.ts"]);
  const at = new Date(Date.now() + 2000);
  utimesSync(join(root, "src", "legacy", "b.ts"), at, at);
  write(join(root, "src", "b.ts"), "export const b = 2;\n", 2);
  assert.doesNotMatch(hook(root, { hook_event_name: "PostToolUse", session_id: s }), /"decision":"block"/);
});

test("strict: a legacy file moved aside, replaced and then staged (git add -A) is still judged against its source", t => {
  const root = lodashRepo(t, "strict");
  writeFileSync(join(root, "src", "b.ts"), 'import _ from "lodash";\nexport const b = 1;\n');
  execFileSync("git", ["-C", root, "add", "-A"]);
  execFileSync("git", ["-C", root, "-c", "user.name=t", "-c", "user.email=t@t", "commit", "-qm", "legacy"]);
  mkdirSync(join(root, "src", "legacy"));
  execFileSync("git", ["-C", root, "mv", "src/b.ts", "src/legacy/b.ts"]);
  writeFileSync(join(root, "src", "b.ts"), "export const b = 2;\n");
  execFileSync("git", ["-C", root, "add", "-A"]);
  const store = new HunchStore(hunchPaths(root));
  t.after(() => store.close());
  assert.equal(constraintForWrittenFiles(store, root, ["src/b.ts", "src/legacy/b.ts"]), null);
  // The staged copy baselines only what its source held: a line added to it still breaks the rule.
  writeFileSync(join(root, "src", "legacy", "b.ts"), 'import _ from "lodash";\nimport q from "lodash/fp";\nexport const b = 1;\n');
  execFileSync("git", ["-C", root, "add", "-A"]);
  assert.equal(constraintForWrittenFiles(store, root, ["src/b.ts", "src/legacy/b.ts"])?.target, "src/legacy/b.ts");
});

test("strict: a staged copy of a file that still holds a forbidden import brings it in as new", t => {
  const root = lodashRepo(t, "strict");
  writeFileSync(join(root, "src", "b.ts"), 'import _ from "lodash";\nexport const b = 1;\nexport const c = 2;\nexport const d = 3;\n');
  execFileSync("git", ["-C", root, "add", "-A"]);
  execFileSync("git", ["-C", root, "-c", "user.name=t", "-c", "user.email=t@t", "commit", "-qm", "legacy"]);
  const store = new HunchStore(hunchPaths(root));
  t.after(() => store.close());
  // An exact copy, its source edited too: git calls it a copy (C100).
  writeFileSync(join(root, "src", "new.ts"), 'import _ from "lodash";\nexport const b = 1;\nexport const c = 2;\nexport const d = 3;\n');
  writeFileSync(join(root, "src", "b.ts"), 'import _ from "lodash";\nexport const b = 1;\nexport const c = 2;\nexport const d = 3;\nexport const e = 4;\n');
  execFileSync("git", ["-C", root, "add", "-A"]);
  assert.match(execFileSync("git", ["-C", root, "diff", "--cached", "-C", "--name-status", "HEAD"], { encoding: "utf8" }), /^C\d+\tsrc\/b\.ts\tsrc\/new\.ts$/m);
  assert.equal(constraintForWrittenFiles(store, root, ["src/b.ts", "src/new.ts"])?.target, "src/new.ts");
});

test("a file moved aside is not blamed when its rewritten source still breaks only a different rule", t => {
  const root = lodashRepo(t, "strict");
  const setup = new HunchStore(hunchPaths(root));
  setup.json.put("constraints", mkConstraint({ id: "con_noaxios", statement: "never use axios", scope: ["src/api/**"], severity: "blocking", forbids: { deps: ["axios"], symbols: [], patterns: [] } }));
  setup.reindex(); setup.close();
  const store = new HunchStore(hunchPaths(root));
  t.after(() => store.close());
  mkdirSync(join(root, "src", "api"), { recursive: true });
  writeFileSync(join(root, "src", "api", "b.ts"), 'import _ from "lodash";\nimport ax from "axios";\nexport const b = 1;\n');
  execFileSync("git", ["-C", root, "add", "-A"]);
  execFileSync("git", ["-C", root, "-c", "user.name=t", "-c", "user.email=t@t", "commit", "-qm", "legacy"]);
  mkdirSync(join(root, "src", "legacy"));
  execFileSync("git", ["-C", root, "mv", "src/api/b.ts", "src/legacy/b.ts"]);
  writeFileSync(join(root, "src", "api", "b.ts"), 'import ax from "axios";\nexport const b = 2;\n');
  execFileSync("git", ["-C", root, "add", "-A"]);
  assert.equal(constraintForWrittenFiles(store, root, ["src/api/b.ts", "src/legacy/b.ts"]), null);
});

/** The hook with the pipeline on (the Stop gate needs it), its session state in `tmp`. */
function pipelineHook(root: string, tmp: string, provider: string, payload: Record<string, unknown>, defaultBudget = false): Record<string, unknown> | null {
  const env: NodeJS.ProcessEnv = { ...process.env, TMPDIR: tmp, TMP: tmp, TEMP: tmp, HUNCH_SHELL_VETO_BUDGET_MS: "30000" };
  delete env.HUNCH_PIPELINE;
  if (defaultBudget) delete env.HUNCH_SHELL_VETO_BUDGET_MS;
  const out = execFileSync(process.execPath, ["--import", tsxLoaderUrl(), hookCli, "hook", "--provider", provider], {
    cwd: root, env, input: JSON.stringify({ cwd: root, ...payload }), encoding: "utf8",
  }).trim();
  return out ? JSON.parse(out) as Record<string, unknown> : null;
}
function stateDir(t: { after: (f: () => void) => void }): string {
  const tmp = realpathSync(mkdtempSync(join(tmpdir(), "hunch-shellwrites-state-")));
  t.after(() => cleanupDir(tmp));
  return tmp;
}

test("strict: the Stop gate holds the turn while a shell-written forbidden import is still in the tree", t => {
  const root = lodashRepo(t, "strict");
  const tmp = stateDir(t);
  const s = session();
  const run = (payload: Record<string, unknown>) => pipelineHook(root, tmp, "claude", { session_id: s, prompt_id: "p1", tool_name: "Bash", tool_input: { command: "ls" }, ...payload });
  run({ hook_event_name: "PreToolUse" });
  write(join(root, "src", "a.ts"), 'import _ from "lodash";\nexport const a = 2;\n', 1);
  assert.equal(run({ hook_event_name: "PostToolUse" })?.decision, "block");
  const stop = run({ hook_event_name: "Stop", stop_hook_active: false });
  assert.equal(stop?.decision, "block");
  assert.match(String(stop?.reason), /src\/a\.ts, written by a shell command this session, still holds a broken blocking invariant/);
  assert.match(String(stop?.reason), /never use lodash/);
  // Reverted: the turn may end.
  write(join(root, "src", "a.ts"), "export const a = 1;\n", 2);
  assert.notEqual(run({ hook_event_name: "Stop", stop_hook_active: false })?.decision, "block");
});

test("strict antigravity (no post-tool event): the tree-mode Stop gate catches a forbidden import at the default budget", t => {
  const root = lodashRepo(t, "strict");
  const tmp = stateDir(t);
  const run = (payload: Record<string, unknown>) => pipelineHook(root, tmp, "antigravity", { conversationId: "ag-lodash", ...payload }, true);
  run({ invocationNum: 1 });
  writeFileSync(join(root, "src", "a.ts"), 'import _ from "lodash";\nexport const a = 2;\n');
  const stop = run({ executionNum: 1 });
  assert.match(String(stop?.reason), /src\/a\.ts differs from HEAD with a broken blocking invariant/);
  assert.match(String(stop?.reason), /never use lodash/);
});

test("the invariant block text tells the model what to do once, without a contradicting revert order", t => {
  const root = lodashRepo(t, "strict");
  const out = JSON.parse(shellRun(root, session(), join(root, "src", "x.ts"), 'import _ from "lodash";\n', 1));
  assert.equal(out.decision, "block");
  assert.match(out.reason, /if you did not add them, ask the user\./);
  assert.doesNotMatch(out.reason, /Revert that change/);
});

test("a git-redirecting environment gives the invariant check no verdict (another repository's HEAD is not this write's baseline)", t => {
  const root = lodashRepo(t, "strict");
  const other = repo(t);
  writeFileSync(join(root, "src", "b.ts"), 'import _ from "lodash";\nexport const b = 1;\n');
  const store = new HunchStore(hunchPaths(root));
  t.after(() => store.close());
  assert.equal(constraintForWrittenFiles(store, root, ["src/b.ts"])?.target, "src/b.ts");
  const prior = process.env.GIT_DIR;
  t.after(() => { if (prior === undefined) delete process.env.GIT_DIR; else process.env.GIT_DIR = prior; });
  process.env.GIT_DIR = join(other, ".git");
  assert.equal(constraintForWrittenFiles(store, root, ["src/b.ts"]), null);
});

test("strict: a file moved into a rule's scope brings that rule's forbidden import in as new", t => {
  const root = lodashRepo(t, "strict");
  const store = new HunchStore(hunchPaths(root));
  store.json.put("constraints", mkConstraint({ id: "con_noaxios", statement: "never use axios", scope: ["src/api/**"], severity: "blocking", forbids: { deps: ["axios"], symbols: [], patterns: [] } }));
  store.reindex(); store.close();
  mkdirSync(join(root, "src", "util"));
  writeFileSync(join(root, "src", "util", "y.ts"), 'import axios from "axios";\nexport const y = 1;\n');
  execFileSync("git", ["-C", root, "add", "-A"]);
  execFileSync("git", ["-C", root, "-c", "user.name=t", "-c", "user.email=t@t", "commit", "-qm", "legacy"]);
  const s = session();
  hook(root, { hook_event_name: "PreToolUse", session_id: s });
  mkdirSync(join(root, "src", "api"));
  execFileSync("git", ["-C", root, "mv", "src/util/y.ts", "src/api/y.ts"]);
  const at = new Date(Date.now() + 2000);
  utimesSync(join(root, "src", "api", "y.ts"), at, at);
  const out = JSON.parse(hook(root, { hook_event_name: "PostToolUse", session_id: s }));
  assert.equal(out.decision, "block");
  assert.match(out.reason, /con_noaxios/);
});

test("strict: a git mv that also appends a forbidden import still blocks the added line", t => {
  const root = lodashRepo(t, "strict");
  writeFileSync(join(root, "src", "[id].ts"), 'import _ from "lodash";\nexport const b = 1;\n');
  execFileSync("git", ["-C", root, "add", "-A"]);
  execFileSync("git", ["-C", root, "-c", "user.name=t", "-c", "user.email=t@t", "commit", "-qm", "route"]);
  const s = session();
  hook(root, { hook_event_name: "PreToolUse", session_id: s });
  mkdirSync(join(root, "src", "old"));
  execFileSync("git", ["-C", root, "mv", "src/[id].ts", "src/old/[id].ts"]);
  write(join(root, "src", "old", "[id].ts"), 'import _ from "lodash";\nexport const b = 1;\nimport g from "lodash/groupBy";\n', 2);
  const out = JSON.parse(hook(root, { hook_event_name: "PostToolUse", session_id: s }));
  assert.equal(out.decision, "block");
});

test("strict: in a repository with no commit yet, a shell write of a forbidden import blocks", t => {
  const root = realpathSync(mkdtempSync(join(tmpdir(), "hunch-shellwrites-")));
  t.after(() => cleanupDir(root));
  execFileSync("git", ["-C", root, "init", "-q"]);
  mkdirSync(join(root, ".hunch"));
  writeFileSync(join(root, ".hunch", "config.json"), JSON.stringify({ firmness: "strict" }));
  const store = new HunchStore(hunchPaths(root));
  store.json.ensureDirs();
  store.json.put("constraints", mkConstraint({ id: "con_nolodash", statement: "never use lodash", scope: ["**/*.ts"], severity: "blocking", forbids: { deps: ["lodash"], symbols: [], patterns: [] } }));
  store.reindex(); store.close();
  const out = JSON.parse(shellRun(root, session(), join(root, "src", "x.ts"), 'import _ from "lodash";\n', 1));
  assert.equal(out.decision, "block");
});

test("strict: a BOM added or dropped by a rewrite does not make a committed forbidden import new", t => {
  const root = lodashRepo(t, "strict");
  writeFileSync(join(root, "src", "b.ts"), "\uFEFF" + 'import _ from "lodash";\nexport const b = 1;\n');
  execFileSync("git", ["-C", root, "-c", "user.name=t", "-c", "user.email=t@t", "commit", "-qam", "bom"]);
  const raw = shellRun(root, session(), join(root, "src", "b.ts"), 'import _ from "lodash";\nexport const b = 2;\n', 1);
  assert.doesNotMatch(raw, /"decision":"block"/);
});
