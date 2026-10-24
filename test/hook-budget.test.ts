import { cleanupDir } from "./fixtures.js";
/** Process-spawn budget for the hook hot paths (#473).
 *
 * The pre-edit hook once spent ~85% of its time in duplicated synchronous git
 * spawns — two per capture commit, ~83 per hook call — and nothing failed,
 * because nothing measured it. This test counts external git processes, not
 * wall time (wall time is noisy on CI), for ONE hook invocation over a store of
 * N decisions that are all anchored to the edited file and each carry a real
 * capture commit on the default branch.
 *
 * How spawns are counted: GIT_TRACE2_EVENT points at a DIRECTORY, so every git
 * process writes its own event file (named after its session id). A PATH shim
 * is not portable — Node's spawn on Windows resolves bare `git` to `.exe`/`.com`
 * only, so a `git.cmd` shim is silently bypassed. Trace2 is git's own
 * instrumentation, behaves identically on Windows and Linux, and survives every
 * env-rewriting spawn site in src/ (they all spread process.env). Only
 * top-level processes count: a git child spawned BY git (hooks, gc --auto)
 * carries a `parent/child` sid and is not a Hunch spawn.
 *
 * Two assertions per hook: (a) bounded growth — spawns(N=40) − spawns(N=10)
 * stays under a small constant, so the per-record cost is never a per-commit
 * git call; (b) an absolute ceiling for N=40 with ~30% headroom over today. */
import { test } from "node:test";
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { mkdirSync, mkdtempSync, readdirSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { HunchStore } from "../src/store/hunchStore.js";
import { hunchPaths } from "../src/core/paths.js";
import { DecisionSchema } from "../src/core/types.js";
import { tsxLoaderUrl } from "./helpers.js";

const cli = resolve("src/cli/index.ts");

function git(root: string, ...args: string[]): string {
  return execFileSync("git", ["-c", "commit.gpgsign=false", ...args], { cwd: root, encoding: "utf8" }).trim();
}

/** A repo on `main` whose store holds `n` accepted decisions, every one anchored
 *  to src/config.ts and carrying its own capture commit reachable from main. */
function fixture(t: { after: (f: () => void) => void }, n: number): string {
  const root = mkdtempSync(join(tmpdir(), `hunch-hook-budget-${n}-`));
  t.after(() => cleanupDir(root));
  git(root, "init", "-q", "-b", "main");
  git(root, "config", "user.email", "test@example.com");
  git(root, "config", "user.name", "Test Human");
  mkdirSync(join(root, "src"), { recursive: true });
  writeFileSync(join(root, ".gitignore"), ".hunch-cache/\n");
  writeFileSync(join(root, "src", "config.ts"), "export const settings = {};\n");
  git(root, "add", "-A");
  git(root, "commit", "-q", "-m", "initial");
  const commits: string[] = [];
  for (let i = 0; i < n; i++) {
    git(root, "commit", "-q", "--allow-empty", "-m", `capture ${i}`);
    commits.push(git(root, "rev-parse", "HEAD"));
  }
  const store = new HunchStore(hunchPaths(root));
  store.json.ensureDirs();
  commits.forEach((commit, i) => {
    store.json.put("decisions", DecisionSchema.parse({
      id: `dec_budget_${String(i).padStart(3, "0")}`,
      title: `Merge settings rule ${i}`,
      status: "accepted",
      decision: `Settings merge rule number ${i} for the config loader.`,
      date: "2026-09-11",
      commit,
      related_files: ["src/config.ts"],
      provenance: { source: "human_confirmed", confidence: 1, evidence: [] },
    }));
  });
  store.reindex();
  store.close();
  return root;
}

let sessionSeq = 0;
const sessionId = () => `hunch-budget-${process.pid}-${Date.now()}-${sessionSeq++}`;

/** The git subcommand of a traced argv, skipping global options and their values. */
function gitVerb(argv: string[]): string {
  for (let i = 1; i < argv.length; i++) {
    const arg = argv[i]!;
    if (arg === "-c" || arg === "-C" || arg === "--git-dir" || arg === "--work-tree") { i++; continue; }
    if (!arg.startsWith("-")) return arg;
  }
  return "?";
}

/** Run ONE hook invocation and return the top-level git processes it started. */
function countHookGitSpawns(root: string, payload: Record<string, unknown>): { total: number; byCommand: Record<string, number> } {
  const traceDir = mkdtempSync(join(tmpdir(), "hunch-hook-budget-trace-"));
  try {
    const env: NodeJS.ProcessEnv = { ...process.env, HUNCH_PIPELINE: "0", HUNCH_TASK_SELECTION: "", GIT_TRACE2_EVENT: traceDir };
    // This test may itself run under a traced git (or a git hook): drop inherited trace parentage.
    for (const key of Object.keys(env)) if (key.startsWith("GIT_TRACE2_") && key !== "GIT_TRACE2_EVENT") delete env[key];
    execFileSync(process.execPath, ["--import", tsxLoaderUrl(), cli, "hook", "--provider", "claude"], {
      cwd: root,
      env,
      input: JSON.stringify({ cwd: root, session_id: sessionId(), prompt_id: "prompt-budget", turn_id: "turn-1", ...payload }),
      encoding: "utf8",
    });
    const byCommand: Record<string, number> = {};
    let total = 0;
    for (const file of readdirSync(traceDir)) {
      const lines = readFileSync(join(traceDir, file), "utf8").split("\n").filter(Boolean);
      let sid = "";
      let argv: string[] = [];
      for (const line of lines) {
        try {
          const event = JSON.parse(line) as { event?: string; sid?: string; argv?: string[] };
          sid ||= event.sid ?? "";
          if (event.event === "start" && Array.isArray(event.argv)) argv = event.argv;
        } catch { /* a torn line never hides the process: its file still counts below */ }
      }
      if (sid.includes("/")) continue; // spawned by git itself, not by Hunch
      total++;
      byCommand[gitVerb(argv)] = (byCommand[gitVerb(argv)] ?? 0) + 1;
    }
    return { total, byCommand };
  } finally {
    cleanupDir(traceDir);
  }
}

const preEdit = (root: string) => ({
  hook_event_name: "PreToolUse", tool_name: "Edit",
  tool_input: { file_path: join(root, "src", "config.ts"), new_string: "merge settings" },
});
const promptSubmit = () => ({ hook_event_name: "UserPromptSubmit", prompt: "merge the settings in src/config.ts" });

const SMALL = 10;
const LARGE = 40;

/** Budgets, in top-level git processes per hook call.
 *  growth  — allowed spawns(N=40) − spawns(N=10): a documented constant, NOT 30×k.
 *            A few spawns of slack lets a fixed-cost probe be added without
 *            touching this file; anything per-record blows it immediately.
 *  ceiling — absolute cap at N=40, ~30% over the count measured 2026-10-22
 *            (pre-edit 84, prompt 3) so a regression on top of today fails.
 *  growthTodo — set while the CURRENT code is known to exceed `growth`. */
const GROWTH_CONSTANT = 4;
const HOOKS: { name: string; payload: (root: string) => Record<string, unknown>; ceiling: number; growthTodo?: string }[] = [
  {
    name: "PreToolUse (pre-edit)", payload: preEdit, ceiling: 110,
    // Measured 2026-10-22: N=10 → 24, N=40 → 84 (rev-parse 42, merge-base 40):
    // each hook call is a FRESH process, so the #473 memo never helped and every
    // capture commit cost `rev-parse --verify` + `merge-base --is-ancestor`.
    // #485 batches them into one `cat-file --batch-check` + one `rev-list`.
  },
  { name: "UserPromptSubmit", payload: promptSubmit, ceiling: 4 },
];

for (const hook of HOOKS) {
  test(`hook budget: ${hook.name} git spawns stay bounded as capture commits grow`, { timeout: 120_000 }, async t => {
    const smallRoot = fixture(t, SMALL);
    const small = countHookGitSpawns(smallRoot, hook.payload(smallRoot));
    const largeRoot = fixture(t, LARGE);
    const large = countHookGitSpawns(largeRoot, hook.payload(largeRoot));
    const growth = large.total - small.total;
    const report = [
      `${hook.name}: N=${SMALL} -> ${small.total} git spawns ${JSON.stringify(small.byCommand)}`,
      `${hook.name}: N=${LARGE} -> ${large.total} git spawns ${JSON.stringify(large.byCommand)}`,
      `${hook.name}: growth ${growth} (budget ${GROWTH_CONSTANT}), N=${LARGE} ceiling ${hook.ceiling}`,
    ];
    for (const line of report) {
      t.diagnostic(line);
      console.log(`[hook-budget] ${line}`);
    }
    // A zero count means the trace never reached git — the measurement, not the code, is broken.
    assert.ok(small.total > 0 && large.total > 0, "GIT_TRACE2_EVENT captured no git process; the spawn counter is blind");

    await t.test(`N=${LARGE} stays under the absolute ceiling of ${hook.ceiling}`, () => {
      assert.ok(large.total <= hook.ceiling, `${large.total} git spawns at N=${LARGE} > ceiling ${hook.ceiling}\n${report.join("\n")}`);
    });
    await t.test(`N=${SMALL}→${LARGE} growth stays within ${GROWTH_CONSTANT} spawns`, hook.growthTodo ? { todo: hook.growthTodo } : {}, () => {
      assert.ok(growth <= GROWTH_CONSTANT, `git spawns grew by ${growth} for ${LARGE - SMALL} more capture commits (budget ${GROWTH_CONSTANT}): per-record git calls\n${report.join("\n")}`);
    });
  });
}
