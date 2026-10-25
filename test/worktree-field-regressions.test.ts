import { cleanupDir } from "./fixtures.js";
/**
 * 1.47.1 hotfix: bugs reported from field use of Hunch on an external repository,
 * one regression per bug. Every repository here is a temp repo under os.tmpdir(),
 * never a real checkout or worktree of this repo (con_38bf8aa397).
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import { execFileSync, spawnSync } from "node:child_process";
import { existsSync, mkdirSync, mkdtempSync, readdirSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, relative, resolve } from "node:path";
import { mkConstraint, tsxLoaderUrl } from "./helpers.js";
import { hunchPaths } from "../src/core/paths.js";
import { HunchStore } from "../src/store/hunchStore.js";
import { readTaskReport, startReportTask, summarizeTaskReport } from "../src/core/taskReport.js";
import { currentSource } from "../src/core/taskReportEvidence.js";
import { looksLikeCorrection } from "../src/core/correction.js";
import { isSelfLauncher } from "../src/integrations/probe.js";
import { inspectIntegrations } from "../src/integrations/health.js";
import { flushCapture, flushMemoryHome, flushStateWrite } from "../src/integrations/sync.js";
import { updateClaudeMd } from "../src/integrations/claudemd.js";
import { hunchDirHasChanges } from "../src/extractors/git.js";

const cli = resolve("src/cli/index.ts");
const gitEnv = { ...process.env, GIT_AUTHOR_NAME: "t", GIT_AUTHOR_EMAIL: "t@t", GIT_COMMITTER_NAME: "t", GIT_COMMITTER_EMAIL: "t@t" };
const git = (root: string, ...args: string[]): string => execFileSync("git", ["-C", root, ...args], { env: gitEnv, encoding: "utf8" }).trim();

/** A main checkout whose committed .hunch/ holds one blocking constraint on src/a.ts,
 *  plus a linked worktree of it (a sibling directory, the layout agents use). */
function repoWithWorktree(t: { after: (f: () => void) => void }): { base: string; main: string; wt: string } {
  const base = realpathSync(mkdtempSync(join(tmpdir(), "hunch-field-wt-")));
  t.after(() => cleanupDir(base));
  const main = join(base, "main");
  mkdirSync(join(main, "src"), { recursive: true });
  git(main, "init", "-q", "-b", "main");
  writeFileSync(join(main, ".gitignore"), ".hunch-cache/\n.hunch/local.json\n.tmp/\n");
  writeFileSync(join(main, "src", "a.ts"), "export const a = 1;\n");
  mkdirSync(join(main, ".hunch"));
  writeFileSync(join(main, ".hunch", "config.json"), JSON.stringify({ firmness: "advisory" }));
  const store = new HunchStore(hunchPaths(main));
  store.json.ensureDirs();
  store.json.put("constraints", mkConstraint({ id: "con_fieldwt", statement: "Module a must stay free of side effects", scope: ["src/a.ts"], severity: "blocking" }));
  store.reindex(); store.close();
  git(main, "add", "-A");
  git(main, "commit", "-q", "-m", "init");
  const wt = join(base, "wt");
  git(main, "worktree", "add", "-q", "-b", "side", wt);
  return { base, main, wt };
}

/** The hook as a host spawns it: process cwd is the MAIN checkout. */
function hook(processCwd: string, payload: Record<string, unknown>): string {
  const tmp = join(processCwd, ".tmp");
  mkdirSync(tmp, { recursive: true });
  return execFileSync(process.execPath, ["--import", tsxLoaderUrl(), cli, "hook", "--provider", "claude"], {
    cwd: processCwd, env: { ...process.env, HUNCH_PIPELINE: "0", TMPDIR: tmp, TMP: tmp, TEMP: tmp },
    input: JSON.stringify({ cwd: processCwd, session_id: `s-${Math.random().toString(36).slice(2)}`, ...payload }), encoding: "utf8",
  }).trim();
}

test("B1: pre-edit grounding reaches a file in a sibling linked worktree when the hook runs at the main checkout", t => {
  const { main, wt } = repoWithWorktree(t);
  const out = hook(main, { hook_event_name: "PreToolUse", tool_name: "Edit", tool_input: { file_path: join(wt, "src", "a.ts"), old_string: "1", new_string: "2" } });
  assert.match(out, /Module a must stay free of side effects/, "the worktree's file is grounded against the worktree's memory, not dropped as outside the repo");
});

test("B1: a sibling worktree without .hunch/ says the edit is ungrounded instead of staying silent", t => {
  const { main, wt } = repoWithWorktree(t);
  rmSync(join(wt, ".hunch"), { recursive: true, force: true }); // rmSync-ok: simulates a worktree with no memory
  const out = hook(main, { hook_event_name: "PreToolUse", tool_name: "Edit", tool_input: { file_path: join(wt, "src", "a.ts"), old_string: "1", new_string: "2" } });
  assert.match(out, /linked worktree .* has no \.hunch\/ — this edit proceeds ungrounded/);
});

test("B1: a nested package .hunch/ inside the process checkout never displaces the process root's constraints", t => {
  const { main } = repoWithWorktree(t);
  mkdirSync(join(main, "src", ".hunch"));
  const out = hook(main, { hook_event_name: "PreToolUse", tool_name: "Edit", tool_input: { file_path: join(main, "src", "a.ts"), old_string: "1", new_string: "2" } });
  assert.match(out, /Module a must stay free of side effects/, "the root's blocking constraint still grounds the edit");
  assert.ok(!existsSync(join(main, "src", ".hunch-cache")), "no index is built for the nested directory");
});

test("B1: a file outside every worktree of the repository stays silent", t => {
  const { base, main } = repoWithWorktree(t);
  const scratch = join(base, "scratch.txt");
  const out = hook(main, { hook_event_name: "PreToolUse", tool_name: "Write", tool_input: { file_path: scratch, content: "x" } });
  assert.equal(out, "");
});

test("B1: SubagentStart in a sibling linked worktree is grounded and routed to that worktree", t => {
  const { main, wt } = repoWithWorktree(t);
  const out = hook(main, { hook_event_name: "SubagentStart", cwd: wt, agent_type: "general-purpose", agent_id: "agent-1" });
  assert.match(out, /delegated agent grounding/);
  assert.match(out, /Worktree routing: call hunch_context first with cwd/);
});

test("B2: task verify from a linked worktree finds the task the main checkout opened and runs the check in the worktree", t => {
  const { main, wt } = repoWithWorktree(t);
  const task = startReportTask(main, "field task");
  const run = spawnSync(process.execPath, ["--import", tsxLoaderUrl(), cli, "task", "verify", task.task_id, "--json", "--",
    process.execPath, "-e", "require('fs').writeFileSync('ran-here.txt', '')"], { cwd: wt, encoding: "utf8" });
  assert.equal(run.status, 0, run.stderr);
  assert.ok(existsSync(join(wt, "ran-here.txt")), "the command runs where the caller stands");
  assert.ok(!existsSync(join(main, "ran-here.txt")));
  assert.equal(readTaskReport(main, task.task_id).checks.length, 1, "the result is recorded on the task's own ledger");
  // The first command wrote a file (its own before/after differ); a read-only re-check is current.
  const again = spawnSync(process.execPath, ["--import", tsxLoaderUrl(), cli, "task", "verify", task.task_id, "--json", "--", process.execPath, "-e", "0"], { cwd: wt, encoding: "utf8" });
  assert.equal(again.status, 0, again.stderr);
  assert.equal(summarizeTaskReport(main, task.task_id, currentSource(main)).check?.current, true, "judged against the worktree it ran in, not reported as 'source changed'");
  writeFileSync(join(wt, "src", "a.ts"), "export const a = 2;\n");
  assert.equal(summarizeTaskReport(main, task.task_id, currentSource(main)).check?.current, false, "a later edit in that worktree still stales it");
  assert.equal(summarizeTaskReport(main, task.task_id, "sha256:" + "0".repeat(64)).check?.current, false, "a plain root hash never vouches for a check that ran elsewhere");
});

test("B5: host notification turns and injected reminders never read as a human correction", () => {
  assert.equal(looksLikeCorrection("<task-notification>\n<result>Done. Note: never use the pay-per-token API here.</result>\n</task-notification>"), false);
  assert.equal(looksLikeCorrection("<system-reminder>You must always run the tests.</system-reminder>\nthanks, continue"), false);
  assert.equal(looksLikeCorrection("<system-reminder>context</system-reminder>\nno, that's wrong — revert that"), true, "the human's own words after a reminder still count");
  assert.equal(looksLikeCorrection("never use the pay-per-token API here"), true);
  assert.equal(looksLikeCorrection("<system-reminder>truncated host text\nno, that's wrong — revert that"), true, "an unclosed host tag never swallows the human's next lines");
  assert.equal(looksLikeCorrection("<browser_instruction># Browser automation\nYou must ALWAYS capture extra frames.</browser_instruction>continue from the saved handoff."), false, "the browser extension's standing instructions are host text");
});

test("B3: a role without Hunch's MCP tools is never told to call them", t => {
  const { main, wt } = repoWithWorktree(t);
  const role = "---\nname: scout\ntools: Read, Grep, Glob\n---\nRead-only lookup.\n";
  for (const root of [main, wt]) {
    mkdirSync(join(root, ".claude", "agents"), { recursive: true });
    writeFileSync(join(root, ".claude", "agents", "scout.md"), role);
  }
  const out = hook(main, { hook_event_name: "SubagentStart", cwd: wt, agent_type: "scout", agent_id: "agent-1" });
  assert.match(out, /Module a must stay free of side effects/, "the role is still grounded");
  assert.doesNotMatch(out, /Worktree routing|hunch_/, "a tool it cannot call is never named");
  const withTools = "---\nname: scout\ntools: Read, mcp__hunch__hunch_why\n---\n";
  writeFileSync(join(wt, ".claude", "agents", "scout.md"), withTools);
  writeFileSync(join(main, ".claude", "agents", "scout.md"), withTools);
  assert.match(hook(main, { hook_event_name: "SubagentStart", cwd: wt, agent_type: "scout", agent_id: "agent-2" }), /Worktree routing: call hunch_context first with cwd/);
});

test("B9: a launcher running this same Hunch build may be probed; any other node script may not", t => {
  const dir = realpathSync(mkdtempSync(join(tmpdir(), "hunch-field-launcher-")));
  t.after(() => cleanupDir(dir));
  const entry = join(dir, "dist", "cli", "index.js");
  mkdirSync(join(dir, "dist", "cli"), { recursive: true });
  writeFileSync(entry, "// fake build entry\n");
  const other = join(dir, "other.js");
  writeFileSync(other, "// not hunch\n");
  assert.equal(isSelfLauncher({ command: "node", args: [entry, "mcp"] }, entry), true);
  assert.equal(isSelfLauncher({ command: process.execPath, args: [entry, "mcp"] }, entry), true);
  assert.equal(isSelfLauncher({ command: "node", args: [other, "mcp"] }, entry), false);
  // Generated launchers name the build entry absolutely; a relative script resolves against the cwd.
  assert.equal(isSelfLauncher({ command: "node", args: [relative(process.cwd(), entry), "mcp"] }, entry), false);
  assert.equal(isSelfLauncher({ command: "node", args: [entry, "mcp", "--extra"] }, entry), false);
  assert.equal(isSelfLauncher({ command: "bash", args: [entry, "mcp"] }, entry), false);
  // A directory-qualified executable merely NAMED node (e.g. planted in a cloned repo) is never run.
  const planted = join(dir, "bin", process.platform === "win32" ? "node.exe" : "node");
  mkdirSync(join(dir, "bin"));
  writeFileSync(planted, "#!/bin/sh\necho pwned\n");
  assert.equal(isSelfLauncher({ command: planted, args: [entry, "mcp"] }, entry), false);
  assert.equal(isSelfLauncher({ command: "./bin/node", args: [entry, "mcp"] }, entry), false);
});

test("B10: the configured-MCP hint names the full probe command for its harness", t => {
  const root = realpathSync(mkdtempSync(join(tmpdir(), "hunch-field-health-")));
  t.after(() => cleanupDir(root));
  writeFileSync(join(root, ".mcp.json"), JSON.stringify({ mcpServers: { hunch: { command: "npx", args: ["-y", "--package=hunch-exact@npm:@davesheffer/hunch@1.0.0", "hunch", "mcp"] } } }));
  const report = inspectIntegrations(root, "claude");
  assert.match(report.harnesses[0]!.capabilities.mcp.detail, /hunch integrations check --probe --harness claude/);
});

test("B11: a capture never auto-commits onto the default branch; a feature branch and the explicit opt-in still commit", t => {
  const root = realpathSync(mkdtempSync(join(tmpdir(), "hunch-field-commit-")));
  t.after(() => cleanupDir(root));
  git(root, "init", "-q", "-b", "main");
  writeFileSync(join(root, ".gitignore"), ".hunch-cache/\n.hunch/local.json\n");
  writeFileSync(join(root, "README.md"), "x\n");
  git(root, "add", "-A");
  git(root, "commit", "-q", "-m", "init");
  const commits = () => Number(git(root, "rev-list", "--count", "HEAD"));
  const capture = (id: string): ReturnType<typeof flushCapture> => {
    const store = new HunchStore(hunchPaths(root));
    try {
      store.json.ensureDirs();
      store.json.put("constraints", mkConstraint({ id, statement: `rule ${id}`, scope: ["src/**"] }));
      return flushCapture(store, hunchPaths(root).hunch, false, `hunch: capture ${id}`);
    } finally { store.close(); }
  };
  const previous = process.env.HUNCH_AUTO_COMMIT_DEFAULT_BRANCH;
  delete process.env.HUNCH_AUTO_COMMIT_DEFAULT_BRANCH;
  t.after(() => { if (previous === undefined) delete process.env.HUNCH_AUTO_COMMIT_DEFAULT_BRANCH; else process.env.HUNCH_AUTO_COMMIT_DEFAULT_BRANCH = previous; });

  assert.equal(capture("con_onmain"), "held", "on main the capture is not committed, and the caller is told why");
  assert.equal(commits(), 1);
  assert.ok(existsSync(join(root, ".hunch", "constraints", "con_onmain.json")), "the record stays on disk");
  // Every other public memory flush (policy plan, bug, supersede, …) stages all of .hunch/:
  // it must hold too, or it sweeps the held capture onto main.
  const pump = new HunchStore(hunchPaths(root));
  try {
    assert.equal(flushMemoryHome(pump, hunchPaths(root).hunch, "public", "hunch: plan policy pol_x"), "held");
  } finally { pump.close(); }
  assert.equal(commits(), 1, "a later public memory flush does not commit the held capture on main");

  writeFileSync(join(root, ".hunch", "local.json"), JSON.stringify({ autoCommitDefaultBranch: true }));
  assert.equal(capture("con_optin"), "committed", "the per-machine opt-in restores commits on main");
  assert.equal(commits(), 2);
  rmSync(join(root, ".hunch", "local.json"));
  process.env.HUNCH_AUTO_COMMIT_DEFAULT_BRANCH = "1";
  assert.equal(capture("con_envoptin"), "committed", "HUNCH_AUTO_COMMIT_DEFAULT_BRANCH=1 restores commits on main too");
  delete process.env.HUNCH_AUTO_COMMIT_DEFAULT_BRANCH;
  assert.equal(commits(), 3);

  // A state-contract write (hunch serve / nuryel_write) serves a data repo on main: it still commits.
  const store = new HunchStore(hunchPaths(root));
  try {
    store.json.put("constraints", mkConstraint({ id: "con_state", statement: "rule state", scope: ["src/**"] }));
    assert.equal(flushStateWrite(store, hunchPaths(root).hunch, false, "nuryel: write con_state"), "committed");
  } finally { store.close(); }
  assert.equal(commits(), 4);

  git(root, "checkout", "-q", "-b", "feat/x");
  assert.equal(capture("con_onfeature"), "committed", "a feature branch commits as before");
  assert.equal(commits(), 5);
});

test("B11: a public flush on the default branch with nothing to carry is not reported as held", t => {
  const root = realpathSync(mkdtempSync(join(tmpdir(), "hunch-field-clean-")));
  t.after(() => cleanupDir(root));
  git(root, "init", "-q", "-b", "main");
  // A hand-rolled .gitignore that does not list .hunch/local.json: the per-machine file is
  // never staged by a public memory commit, so it is not something to carry either.
  writeFileSync(join(root, ".gitignore"), ".hunch-cache/\n.hunch/hunch.sqlite*\n.hunch/events.log\n");
  const seed = new HunchStore(hunchPaths(root));
  try {
    seed.json.ensureDirs();
    seed.json.put("constraints", mkConstraint({ id: "con_clean", statement: "rule clean", scope: ["src/**"] }));
  } finally { seed.close(); }
  git(root, "add", "-A");
  git(root, "commit", "-q", "-m", "init with memory");
  const previous = process.env.HUNCH_AUTO_COMMIT_DEFAULT_BRANCH;
  delete process.env.HUNCH_AUTO_COMMIT_DEFAULT_BRANCH;
  t.after(() => { if (previous === undefined) delete process.env.HUNCH_AUTO_COMMIT_DEFAULT_BRANCH; else process.env.HUNCH_AUTO_COMMIT_DEFAULT_BRANCH = previous; });

  assert.equal(git(root, "status", "--porcelain"), "", "fixture sanity: the tree is clean");
  // A derived artifact the commit never stages (a crash-left write lock) is not something to carry.
  writeFileSync(join(root, ".hunch", "write.lock"), "stale\n");
  writeFileSync(join(root, ".hunch", "local.json"), JSON.stringify({ autoCommit: true }) + "\n");
  const store = new HunchStore(hunchPaths(root));
  try {
    assert.equal(flushMemoryHome(store, hunchPaths(root).hunch, "public", "hunch: stamp schema"), null, "a clean .hunch/ leaves nothing for the next commit, so nothing is held");
    store.json.put("constraints", mkConstraint({ id: "con_dirty", statement: "rule dirty", scope: ["src/**"] }));
    // A git hook exports a relative GIT_DIR; resolved from .hunch/ it names no repository.
    const previousGitDir = process.env.GIT_DIR;
    process.env.GIT_DIR = ".git";
    try {
      assert.equal(hunchDirHasChanges(hunchPaths(root).hunch), true, "an inherited hook GIT_DIR does not hide the change");
    } finally { if (previousGitDir === undefined) delete process.env.GIT_DIR; else process.env.GIT_DIR = previousGitDir; }
    assert.equal(flushMemoryHome(store, hunchPaths(root).hunch, "public", "hunch: capture con_dirty"), "held");
  } finally { store.close(); }
});

test("B11: the post-commit `hunch sync` holds its public capture commit on the default branch; a feature branch and a hand-typed --commit still commit", t => {
  const root = realpathSync(mkdtempSync(join(tmpdir(), "hunch-field-sync-")));
  t.after(() => cleanupDir(root));
  git(root, "init", "-q", "-b", "main");
  writeFileSync(join(root, ".gitignore"), ".hunch-cache/\n.hunch/local.json\n");
  mkdirSync(join(root, "src"));
  writeFileSync(join(root, "src", "cache.ts"), "export const size = 10;\n");
  writeFileSync(join(root, "CLAUDE.md"), "# project\n");
  const seed = new HunchStore(hunchPaths(root));
  try {
    seed.json.ensureDirs();
    updateClaudeMd(root, seed);
  } finally { seed.close(); }
  git(root, "add", "-A");
  git(root, "commit", "-q", "-m", "init");
  const env: NodeJS.ProcessEnv = { ...gitEnv, HUNCH_PRIVATE_DIR: "", HUNCH_SYNTH_PROVIDER: "deterministic" };
  delete env.HUNCH_AUTO_COMMIT_DEFAULT_BRANCH;
  const commits = () => Number(git(root, "rev-list", "--count", "HEAD"));
  const decisions = () => existsSync(join(root, ".hunch", "decisions")) ? readdirSync(join(root, ".hunch", "decisions")).filter((n) => n.endsWith(".json")).length : 0;
  const change = (n: number) => {
    writeFileSync(join(root, "src", "cache.ts"), `export const size = ${n};\nexport function evict(keys: string[]): string[] { return keys.slice(${n}); }\n`);
    git(root, "add", "src");
    git(root, "commit", "-q", "-m", `feat(cache): bound the cache at ${n} entries`, "-m", `Evict the oldest keys past ${n} so memory stays flat under load.`);
  };
  const sync = (...args: string[]) => {
    const run = spawnSync(process.execPath, ["--import", tsxLoaderUrl(), cli, "sync", "HEAD", ...args], { cwd: root, env, encoding: "utf8" });
    assert.equal(run.status, 0, run.stderr);
    return run.stdout;
  };

  // Exactly what the installed post-commit hook runs (its --commit is the installed default).
  change(20);
  sync("--from-hook", "--quiet", "--commit");
  assert.equal(decisions(), 1, "the capture is written");
  assert.equal(commits(), 2, "no hunch commit lands on main");
  assert.equal(git(root, "status", "--porcelain", "--", "CLAUDE.md"), "", "held: tracked grounding stays at HEAD, so `git commit -a` cannot commit counts without their record");
  change(30);
  assert.match(sync(), /not auto-committed: the default branch is checked out/, "a manual sync on main says why");
  assert.equal(commits(), 3);
  assert.equal(decisions(), 2);

  change(40);
  sync("--commit");
  assert.equal(commits(), 5, "a hand-typed --commit still commits on main");

  git(root, "checkout", "-q", "-b", "feat/x");
  change(50);
  sync("--from-hook", "--quiet", "--commit");
  assert.equal(commits(), 7, "a feature branch commits as before");
  assert.equal(git(root, "status", "--porcelain", "--", ".hunch/decisions"), "", "the held records rode the feature-branch commit");
  assert.equal(git(root, "status", "--porcelain", "--", "CLAUDE.md"), "", "with their refreshed grounding");
});

test("B12: a worktree edit grounded at the main checkout records its delivery on the prompt's task", t => {
  const { main, wt } = repoWithWorktree(t);
  const ids = { session_id: "s-b12", prompt_id: "p-b12" };
  const open = hook(main, { ...ids, hook_event_name: "UserPromptSubmit", prompt: "please edit a.ts" });
  const taskId = /htask_[a-z0-9]+/.exec(open)?.[0];
  assert.ok(taskId, `the prompt opened a task: ${open}`);
  const out = hook(main, { ...ids, hook_event_name: "PreToolUse", tool_name: "Edit", tool_input: { file_path: join(wt, "src", "a.ts"), old_string: "1", new_string: "2" } });
  assert.match(out, /Module a must stay free of side effects/, "grounding still comes from the worktree's store");
  assert.match(out, new RegExp(`Hunch task ${taskId} · delivery`));
  const deliveries = readTaskReport(main, taskId).deliveries;
  assert.ok(deliveries.some((d) => d.records.some((r) => r.record_id === "con_fieldwt")), "the main ledger's task has the delivery");
});
