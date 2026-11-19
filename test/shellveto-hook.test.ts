import { cleanupDir } from "./fixtures.js";
import { test } from "node:test";
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, realpathSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { tsxLoaderUrl } from "./helpers.js";
import { hunchPaths } from "../src/core/paths.js";
import { HunchStore } from "../src/store/hunchStore.js";
import { vetoForWrittenFiles } from "../src/core/shellveto.js";

// The shell-write Veto end to end, through the real `hook` CLI: what a session's
// shell command writes is judged, a human's uncommitted work never is.
const cli = resolve("src/cli/index.ts");
const LIST = "src/users/users-list.tsx";
const gitEnv = { ...process.env, GIT_AUTHOR_NAME: "t", GIT_AUTHOR_EMAIL: "t@t", GIT_COMMITTER_NAME: "t", GIT_COMMITTER_EMAIL: "t@t" };

/** A git repo whose Hunch root is `sub` below the toplevel ("" = the toplevel itself). */
function repo(t: { after: (f: () => void) => void }, opts: { firmness?: string; source?: string; sub?: string; defaultBudget?: boolean } = {}) {
  const top = realpathSync(mkdtempSync(join(tmpdir(), "hunch-shellveto-hook-")));
  t.after(() => cleanupDir(top));
  const root = opts.sub ? join(top, opts.sub) : top;
  const git = (...args: string[]) => execFileSync("git", ["-C", top, ...args], { env: gitEnv });
  git("init", "-q");
  mkdirSync(join(root, "src", "users"), { recursive: true });
  writeFileSync(join(top, ".gitignore"), ".tmp/\n.hunch-cache/\n");
  writeFileSync(join(root, LIST), "export const legacy = () => localStorage.getItem('legacy');\nexport const UsersList = () => null;\n");
  writeFileSync(join(root, "src", "users", "other.ts"), "export const o = 1;\n");
  git("add", "-A");
  git("commit", "-q", "-m", "init");
  const store = new HunchStore(hunchPaths(root));
  store.json.ensureDirs();
  store.json.put("decisions", {
    id: "dec_storage", title: "No browser storage for user data", status: "accepted", context: "",
    decision: "user preferences are saved on the server", consequences: [],
    alternatives_rejected: ["localStorage / sessionStorage"],
    rejected_tripwires: [{
      alternative: "localStorage / sessionStorage",
      scope: ["src/**"], forbids: { deps: [], symbols: [], patterns: ["\\b(localStorage|sessionStorage)\\b"] },
      provenance: { source: opts.source ?? "human_confirmed", confidence: 1, evidence: [] },
    }],
    related_components: [], related_files: [],
    supersedes: null, superseded_by: null, caused_by_bug: null, commit: null,
    valid_from: "2026-01-01T00:00:00Z", valid_to: null, retired: { symbols: [], deps: [] },
    provenance: { source: "human_confirmed", confidence: 1, evidence: [] }, date: "2026-01-01T00:00:00Z",
  } as never);
  store.reindex();
  store.close();
  writeFileSync(join(root, ".hunch", "config.json"), JSON.stringify({ firmness: opts.firmness ?? "strict" }));
  const tmp = join(top, ".tmp");
  mkdirSync(tmp, { recursive: true });
  const hook = (payload: Record<string, unknown>): Record<string, unknown> | null => {
    const env: NodeJS.ProcessEnv = { ...process.env, TMPDIR: tmp, TMP: tmp, TEMP: tmp, HUNCH_SHELL_VETO_BUDGET_MS: "30000" };
    if (opts.defaultBudget) delete env.HUNCH_SHELL_VETO_BUDGET_MS;
    delete env.HUNCH_PIPELINE;
    const out = execFileSync(process.execPath, ["--import", tsxLoaderUrl(), cli, "hook", "--provider", "claude"], {
      cwd: root, env, input: JSON.stringify({ cwd: root, session_id: "veto-s", prompt_id: "veto-p", ...payload }), encoding: "utf8",
    }).trim();
    return out ? JSON.parse(out) as Record<string, unknown> : null;
  };
  const prompt = () => hook({ hook_event_name: "UserPromptSubmit", prompt: "tidy the users list" });
  const bash = () => hook({ hook_event_name: "PostToolUse", tool_name: "Bash", tool_input: { command: "python fix.py" }, tool_response: { stdout: "" } });
  const stop = () => hook({ hook_event_name: "Stop", stop_hook_active: false });
  const vetoEvents = () => {
    const log = join(root, ".hunch", "events.log");
    return existsSync(log) ? readFileSync(log, "utf8").split("\n").filter((l) => l.includes("\"veto\"")).length : 0;
  };
  return { top, root, git, hook, prompt, bash, stop, vetoEvents };
}

const isVetoStop = (out: Record<string, unknown> | null) => out?.decision === "block" && /written by a shell command this session/.test(String(out.reason));

test("strict: a shell write adding a vetoed pattern blocks at PostToolUse; Stop blocks twice, then passes; logged once", t => {
  const r = repo(t);
  r.prompt();
  writeFileSync(join(r.root, "src", "users", "other.ts"), "export const o = localStorage.getItem('o');\n");
  const post = r.bash();
  assert.equal(post?.decision, "block");
  assert.match(String(post?.reason), /A shell command just wrote src\/users\/other\.ts/);
  assert.ok(isVetoStop(r.stop()), "first Stop holds the turn");
  assert.ok(isVetoStop(r.stop()), "second Stop holds the turn");
  assert.ok(!isVetoStop(r.stop()), "third Stop fails open");
  assert.equal(r.vetoEvents(), 1, "one violation, one file, one turn: one log line");
});

test("strict: a human's pre-existing uncommitted file with the pattern is never vetoed at Stop", t => {
  const r = repo(t);
  writeFileSync(join(r.root, "src", "users", "other.ts"), "export const o = sessionStorage.getItem('o');\n");
  writeFileSync(join(r.root, "src", "users", "human-new.ts"), "export const h = localStorage.getItem('h');\n");
  r.prompt();
  assert.equal(r.bash()?.decision, undefined, "the agent's command wrote nothing");
  assert.ok(!isVetoStop(r.stop()));
  assert.equal(r.vetoEvents(), 0);
});

test("strict: Veto Stop blocks do not spend the VERIFY gate's blocks", t => {
  const r = repo(t);
  r.prompt();
  writeFileSync(join(r.root, "src", "users", "other.ts"), "export const o = localStorage.getItem('o');\n");
  r.bash();
  writeFileSync(join(r.root, "src", "users", "edited.ts"), "export const e = 1;\n");
  r.hook({ hook_event_name: "PostToolUse", tool_name: "Write", tool_input: { file_path: join(r.root, "src", "users", "edited.ts"), content: "export const e = 1;\n" } });
  assert.ok(isVetoStop(r.stop()));
  assert.ok(isVetoStop(r.stop()));
  const verify = r.stop();
  assert.equal(verify?.decision, "block");
  assert.match(String(verify?.reason), /VERIFY unsatisfied/);
});

test("strict: git mv of a file that already held the pattern is no violation", t => {
  const r = repo(t);
  r.prompt();
  r.git("mv", LIST, "src/users/moved-list.tsx");
  assert.equal(r.bash()?.decision, undefined);
  assert.ok(!isVetoStop(r.stop()));
});

test("strict: a Hunch root in a subdirectory of the git repository still catches the write", t => {
  const r = repo(t, { sub: "pkg" });
  r.prompt();
  writeFileSync(join(r.root, "src", "users", "other.ts"), "export const o = localStorage.getItem('o');\n");
  const post = r.bash();
  assert.equal(post?.decision, "block");
  assert.match(String(post?.reason), /src\/users\/other\.ts/);
  assert.ok(isVetoStop(r.stop()));
});

test("no blocking tripwire (llm_draft only): no block, and no git process is spawned", t => {
  const r = repo(t, { source: "llm_draft" });
  r.prompt();
  writeFileSync(join(r.root, "src", "users", "other.ts"), "export const o = localStorage.getItem('o');\n");
  assert.notEqual(r.bash()?.decision, "block");
  assert.ok(!isVetoStop(r.stop()));
  const trace = join(r.top, ".tmp", "git-trace.log");
  const prior = process.env.GIT_TRACE;
  const store = new HunchStore(hunchPaths(r.root));
  try {
    process.env.GIT_TRACE = trace;
    assert.equal(vetoForWrittenFiles(store, r.root, ["src/users/other.ts"]), null);
    assert.ok(!existsSync(trace), "returned before any git spawn");
  } finally {
    if (prior === undefined) delete process.env.GIT_TRACE; else process.env.GIT_TRACE = prior;
    store.close();
  }
});

test("a file outside every tripwire scope never reaches git", t => {
  const r = repo(t);
  writeFileSync(join(r.root, "notes.md"), "localStorage\n");
  const trace = join(r.top, ".tmp", "git-trace-scope.log");
  const prior = process.env.GIT_TRACE;
  const store = new HunchStore(hunchPaths(r.root));
  try {
    process.env.GIT_TRACE = trace;
    assert.equal(vetoForWrittenFiles(store, r.root, ["notes.md"]), null);
    assert.ok(!existsSync(trace));
  } finally {
    if (prior === undefined) delete process.env.GIT_TRACE; else process.env.GIT_TRACE = prior;
    store.close();
  }
});

for (const firmness of ["advisory", "firm"]) {
  test(`${firmness}: a vetoed shell write never blocks`, t => {
    const r = repo(t, { firmness });
    r.prompt();
    writeFileSync(join(r.root, "src", "users", "other.ts"), "export const o = localStorage.getItem('o');\n");
    assert.notEqual(r.bash()?.decision, "block");
    assert.ok(!isVetoStop(r.stop()));
  });
}

test("strict, default budget: one command rewrites 50 tracked files, the violation in the largest → PostToolUse block", t => {
  const r = repo(t, { defaultBudget: true });
  const files = Array.from({ length: 50 }, (_, i) => join(r.root, "src", "users", `w${i}.ts`));
  files.forEach((f, i) => writeFileSync(f, `export const w = ${i};\n`.repeat(i + 1)));
  r.git("add", "-A"); r.git("commit", "-q", "-m", "w");
  r.prompt();
  files.forEach((f, i) => writeFileSync(f, `export const w = ${i + 1};\n`.repeat(i + 1)));
  writeFileSync(files[49]!, "export const w = 99;\n".repeat(60) + "const s = localStorage.getItem('s');\n");
  const post = r.bash();
  assert.equal(post?.decision, "block");
  assert.match(String(post?.reason), /src\/users\/w49\.ts/);
});

test("strict antigravity (no post-tool event): Stop judges every file that differs from HEAD", t => {
  const r = repo(t);
  const tmp = join(r.top, ".tmp");
  const ag = (payload: Record<string, unknown>): Record<string, unknown> | null => {
    const env: NodeJS.ProcessEnv = { ...process.env, TMPDIR: tmp, TMP: tmp, TEMP: tmp, HUNCH_SHELL_VETO_BUDGET_MS: "30000" };
    delete env.HUNCH_PIPELINE;
    const out = execFileSync(process.execPath, ["--import", tsxLoaderUrl(), cli, "hook", "--provider", "antigravity"], {
      cwd: r.root, env, input: JSON.stringify({ conversationId: "ag1", ...payload }), encoding: "utf8",
    }).trim();
    return out ? JSON.parse(out) as Record<string, unknown> : null;
  };
  ag({ invocationNum: 1 });
  writeFileSync(join(r.root, LIST), readFileSync(join(r.root, LIST), "utf8") + "const s = localStorage.getItem('s');\n");
  const stop = ag({ executionNum: 1 });
  assert.match(String(stop?.reason), /differs from HEAD with a rejected approach/);
  assert.match(String(stop?.reason), /REVERSE decision dec_storage/);
});

test("strict antigravity tree mode: 51 changed files, the violation in the first tracked one → Stop holds", t => {
  const r = repo(t, { defaultBudget: true });
  const tmp = join(r.top, ".tmp");
  const ag = (payload: Record<string, unknown>): Record<string, unknown> | null => {
    const env: NodeJS.ProcessEnv = { ...process.env, TMPDIR: tmp, TMP: tmp, TEMP: tmp };
    delete env.HUNCH_PIPELINE;
    delete env.HUNCH_SHELL_VETO_BUDGET_MS;
    const out = execFileSync(process.execPath, ["--import", tsxLoaderUrl(), cli, "hook", "--provider", "antigravity"], {
      cwd: r.root, env, input: JSON.stringify({ conversationId: "ag51", ...payload }), encoding: "utf8",
    }).trim();
    return out ? JSON.parse(out) as Record<string, unknown> : null;
  };
  const files = Array.from({ length: 51 }, (_, i) => join(r.root, "src", "users", `t${String(i).padStart(2, "0")}.ts`));
  for (const f of files) writeFileSync(f, "export const t = 1;\n");
  r.git("add", "-A"); r.git("commit", "-q", "-m", "t");
  ag({ invocationNum: 1 });
  for (const f of files) writeFileSync(f, "export const t = 2;\n");
  writeFileSync(files[0]!, "export const t = localStorage.getItem('t');\n");
  const stop = ag({ executionNum: 1 });
  assert.match(String(stop?.reason), /src\/users\/t00\.ts differs from HEAD with a rejected approach/);
});
