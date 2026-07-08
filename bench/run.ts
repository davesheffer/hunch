/**
 * A/B/C benchmark: does the fable-mode skill and/or the Hunch graph make a
 * cheaper model converge faster and answer better on THIS repo?
 *
 *   arm A — bare model            (skills stripped, no MCP, CLAUDE.md hunch section stripped)
 *   arm B — + fable-mode skill    (skills kept, no MCP, CLAUDE.md hunch section stripped)
 *   arm C — + hunch MCP           (skills kept, .mcp.json wired to the published hunch, CLAUDE.md intact)
 *
 * Each run: fresh detached git worktree at a pinned commit, node_modules
 * junction from the main repo, optional bug re-introduction for fix tasks,
 * one headless `claude -p` session, then deterministic scoring:
 *   question tasks — checklist regex hits against the final answer
 *   fix tasks      — hidden test file passes AND was not modified
 *
 * Usage:
 *   npx tsx bench/run.ts --arms A,B,C --reps 2 --model claude-opus-4-8
 *   npx tsx bench/run.ts --smoke            # 1 cheap haiku run to verify plumbing
 *
 * Results land in bench/results/<stamp>.json + a printed markdown table.
 * Cost warning: 6 tasks x 3 arms x 2 reps = 36 sessions on your subscription.
 */
import { execSync } from "node:child_process";
import { mkdirSync, rmSync, rmdirSync, writeFileSync, readFileSync, existsSync, readdirSync } from "node:fs";
import { homedir, tmpdir } from "node:os";
import { join, resolve } from "node:path";

const REPO = resolve(import.meta.dirname, "..");
const RESULTS_DIR = join(REPO, "bench", "results");

// ---------------------------------------------------------------- arguments
const argv = process.argv.slice(2);
const flag = (name: string, dflt: string): string => {
  const i = argv.indexOf(`--${name}`);
  return i >= 0 && argv[i + 1] ? argv[i + 1]! : dflt;
};
const SMOKE = argv.includes("--smoke");
const MODEL = flag("model", SMOKE ? "claude-haiku-4-5-20251001" : "claude-opus-4-8");
const ARMS = (SMOKE ? "A" : flag("arms", "A,B,C")).split(",") as Array<"A" | "B" | "C">;
const REPS = SMOKE ? 1 : Number(flag("reps", "2"));
const MAX_TURNS = Number(flag("max-turns", SMOKE ? "8" : "40"));
const ONLY = flag("only", SMOKE ? "w1-collision-null" : "");

interface Task {
  id: string;
  kind: "question" | "fix";
  prompt: string;
  checklist?: string[];
  testFile?: string;
  revert?: string;
}
const TASKS: Task[] = (JSON.parse(readFileSync(join(REPO, "bench", "tasks.json"), "utf8")) as { tasks: Task[] }).tasks
  .filter((t) => !ONLY || t.id === ONLY);

// ------------------------------------------------- bug re-introduction map
// Exact-string reverts of shipped fixes, applied to a fresh worktree so fix
// tasks have a real failing test with a real root cause.
const REVERTS: Record<string, Array<{ file: string; from: string; to: string }>> = {
  "guard-keying": [
    {
      file: "src/mcp/server.ts",
      from: `        // Where this write will actually land (see captureHome). Resolved BEFORE the
        // uniqueness guard: in unified ("shared") mode home is the overlay even when
        // private:false, so the guard must key its incumbent lookup on HOME, not on
        // the flag — keying on the flag let a shared-mode supersede of a public
        // incumbent pass the guard and then no-op the close (two live decisions).
        const home = store.captureHome(!!decision.private);
        // Decision-grounding uniqueness guard`,
      to: `        // Decision-grounding uniqueness guard`,
    },
    {
      file: "src/mcp/server.ts",
      from: `store.decisionInStore(decision.supersedes, home === "private")`,
      to: `store.decisionInStore(decision.supersedes, !!decision.private)`,
    },
    {
      file: "src/mcp/server.ts",
      from: "is not in the ${home} store this write lands in, so it can't be closed from here)",
      to: 'is not in the ${decision.private ? "private" : "public"} store, so it can\'t be closed from here)',
    },
    {
      file: "src/mcp/server.ts",
      from: `        // mode EVERY capture goes to the overlay; else the public store.
        if (home === "private") store.putPrivate("decisions", rec);`,
      to: `        // mode EVERY capture goes to the overlay; else the public store.
        const home = store.captureHome(!!decision.private);
        if (home === "private") store.putPrivate("decisions", rec);`,
    },
  ],
  "docanchor-dedupe": [
    {
      file: "src/core/docanchors.ts",
      from: `    // Scan ALL markers for this topic, not just the first: the topic dedupe must not
    // let an earlier unpinned marker swallow a later marker's stale-pin warning.
    const stalePin = anchors.find((x) => x.topic === a.topic && x.pin && x.pin !== current.id)?.pin;
    if (stalePin) {
      line += \`\\n    ⚠ this section is PINNED to \${stalePin}, which is no longer current — reconcile the prose with \${current.id}, then re-pin.\`;
    }`,
      to: `    if (a.pin && a.pin !== current.id) {
      line += \`\\n    ⚠ this section is PINNED to \${a.pin}, which is no longer current — reconcile the prose with \${current.id}, then re-pin.\`;
    }`,
    },
  ],
};

// ---------------------------------------------------------------- worktrees
const sh = (cmd: string, cwd = REPO): string => execSync(cmd, { cwd, encoding: "utf8", stdio: ["ignore", "pipe", "pipe"] });
const BASE = sh("git rev-parse HEAD").trim();

function makeWorktree(name: string, arm: "A" | "B" | "C", task: Task): string {
  const dir = join(tmpdir(), "hunch-bench", name);
  rmSync(dir, { recursive: true, force: true });
  mkdirSync(join(tmpdir(), "hunch-bench"), { recursive: true });
  sh(`git worktree add --detach "${dir}" ${BASE}`);
  // node_modules junction so tests run without an npm ci per worktree
  execSync(`cmd /c mklink /J "${join(dir, "node_modules")}" "${join(REPO, "node_modules")}"`, { stdio: "ignore" });

  // arm shaping
  if (arm === "A") rmSync(join(dir, ".claude", "skills"), { recursive: true, force: true });
  if (arm !== "C") {
    // strip the Hunch section from CLAUDE.md so bare arms aren't steered toward tools they don't have
    const cm = join(dir, "CLAUDE.md");
    const text = readFileSync(cm, "utf8").replace(/## 🧠 Hunch[\s\S]*?_Hunch updates itself[^\n]*\n/, "");
    writeFileSync(cm, text);
  }
  if (arm === "C") {
    writeFileSync(
      join(dir, ".mcp.json"),
      JSON.stringify({ mcpServers: { hunch: { command: "npx", args: ["-y", "@davesheffer/hunch@latest", "mcp"] } } }, null, 2),
    );
  }

  // bug re-introduction for fix tasks (LF-normalized: checkouts may be CRLF)
  for (const r of REVERTS[task.revert ?? ""] ?? []) {
    const p = join(dir, r.file);
    const src = readFileSync(p, "utf8").replace(/\r\n/g, "\n");
    if (!src.includes(r.from)) throw new Error(`revert anchor not found in ${r.file} (base moved?): ${r.from.slice(0, 60)}`);
    writeFileSync(p, src.replace(r.from, r.to));
  }
  return dir;
}

function dropWorktree(dir: string): void {
  // junction: rmdirSync removes the link itself, never the target node_modules
  try { rmdirSync(join(dir, "node_modules")); } catch { /* absent */ }
  try { sh(`git worktree remove --force "${dir}"`); } catch { /* leave for git worktree prune */ }
}

// ------------------------------------------------------------ claude runner
interface RunResult {
  result: string;
  sessionId: string | null;
  numTurns: number;
  costUsd: number | null;
  durationMs: number;
  toolCalls: Record<string, number>;
}

function runClaude(dir: string, prompt: string): RunResult {
  const t0 = Date.now();
  let out = "";
  // Prompt rides STDIN (shell concatenation of args mangles quoted prose on
  // Windows); --setting-sources project keeps the operator's user-level
  // plugins/skills/hooks out of every arm — the repo files ARE the arm.
  // MCP is explicit + strict: arm C's .mcp.json is loaded by flag (headless does
  // not auto-trust project MCP), and strict mode blocks the operator's personal
  // MCP servers from leaking into ANY arm.
  const mcp = existsSync(join(dir, ".mcp.json")) ? ` --mcp-config .mcp.json` : "";
  const cmd = `claude -p --model ${MODEL} --output-format json --permission-mode bypassPermissions --max-turns ${MAX_TURNS} --setting-sources project${mcp} --strict-mcp-config`;
  try {
    out = execSync(cmd, { cwd: dir, input: prompt, encoding: "utf8", maxBuffer: 64 * 1024 * 1024, timeout: 30 * 60 * 1000 });
  } catch (e) {
    out = String((e as { stdout?: string }).stdout ?? "");
  }
  const durationMs = Date.now() - t0;
  let parsed: { result?: string; session_id?: string; num_turns?: number; total_cost_usd?: number } = {};
  try { parsed = JSON.parse(out); } catch { parsed = { result: out }; }
  const sessionId = parsed.session_id ?? null;
  return {
    result: parsed.result ?? "",
    sessionId,
    numTurns: parsed.num_turns ?? -1,
    costUsd: parsed.total_cost_usd ?? null,
    durationMs,
    toolCalls: sessionId ? countToolCalls(sessionId) : {},
  };
}

/** Tally tool_use blocks from the session transcript (the same JSONL the harness writes). */
function countToolCalls(sessionId: string): Record<string, number> {
  const projects = join(homedir(), ".claude", "projects");
  let file: string | null = null;
  try {
    for (const d of readdirSync(projects)) {
      const p = join(projects, d, `${sessionId}.jsonl`);
      if (existsSync(p)) { file = p; break; }
    }
  } catch { return {}; }
  if (!file) return {};
  const tally: Record<string, number> = {};
  for (const line of readFileSync(file, "utf8").split("\n")) {
    if (!line.trim()) continue;
    try {
      const j = JSON.parse(line) as { type?: string; message?: { content?: Array<{ type?: string; name?: string }> } };
      if (j.type !== "assistant") continue;
      for (const c of j.message?.content ?? []) {
        if (c.type === "tool_use" && c.name) tally[c.name] = (tally[c.name] ?? 0) + 1;
      }
    } catch { /* partial line */ }
  }
  return tally;
}

// ---------------------------------------------------------------- scoring
function scoreQuestion(task: Task, answer: string): { score: number; max: number; misses: string[] } {
  const misses: string[] = [];
  let hits = 0;
  for (const c of task.checklist ?? []) {
    if (new RegExp(c, "i").test(answer)) hits++;
    else misses.push(c);
  }
  return { score: hits, max: task.checklist?.length ?? 0, misses };
}

function scoreFix(task: Task, dir: string): { pass: boolean; testsPass: boolean; testUntouched: boolean } {
  let testsPass = false;
  try {
    execSync(`npx tsx --test ${task.testFile}`, { cwd: dir, stdio: "ignore", timeout: 5 * 60 * 1000 });
    testsPass = true;
  } catch { testsPass = false; }
  const changed = sh("git diff --name-only", dir).split("\n").map((s) => s.trim());
  const testUntouched = !changed.includes(task.testFile!.replace(/\\/g, "/"));
  return { pass: testsPass && testUntouched, testsPass, testUntouched };
}

// ------------------------------------------------------------------- main
// --dry-fix <taskId>: build the worktree, re-introduce the bug, prove the hidden
// test FAILS, clean up. No model session — plumbing check only.
const DRY_FIX = flag("dry-fix", "");
if (DRY_FIX) {
  const task = TASKS.find((t) => t.id === DRY_FIX && t.kind === "fix");
  if (!task) throw new Error(`--dry-fix: unknown fix task "${DRY_FIX}"`);
  const dir = makeWorktree(`dryfix-${task.id}`, "A", task);
  const s = scoreFix(task, dir);
  console.log(`${task.id}: reverted bug makes ${task.testFile} ${s.testsPass ? "PASS (BAD — revert didn't bite)" : "FAIL (good — task is real)"}`);
  dropWorktree(dir); // before exit — finally does not run past process.exit
  process.exit(s.testsPass ? 1 : 0);
}

console.log(`bench: model=${MODEL} arms=${ARMS.join(",")} reps=${REPS} tasks=${TASKS.map((t) => t.id).join(",")} base=${BASE.slice(0, 7)}`);
mkdirSync(RESULTS_DIR, { recursive: true });
const stamp = new Date().toISOString().replace(/[:.]/g, "-");
const rows: Array<Record<string, unknown>> = [];

for (const task of TASKS) {
  for (const arm of ARMS) {
    for (let rep = 1; rep <= REPS; rep++) {
      const name = `${task.id}-${arm}-${rep}`;
      process.stdout.write(`▶ ${name} … `);
      const dir = makeWorktree(name, arm, task);
      try {
        const run = runClaude(dir, task.prompt);
        const totalTools = Object.values(run.toolCalls).reduce((a, b) => a + b, 0);
        const hunchTools = Object.entries(run.toolCalls).filter(([k]) => k.includes("hunch")).reduce((a, [, v]) => a + v, 0);
        const row: Record<string, unknown> = {
          task: task.id, arm, rep, model: MODEL,
          turns: run.numTurns, durationMs: run.durationMs, costUsd: run.costUsd,
          toolCalls: totalTools, hunchCalls: hunchTools, tools: run.toolCalls,
        };
        if (task.kind === "question") {
          const s = scoreQuestion(task, run.result);
          Object.assign(row, { score: `${s.score}/${s.max}`, scoreNum: s.score / Math.max(1, s.max), misses: s.misses });
        } else {
          const s = scoreFix(task, dir);
          Object.assign(row, { score: s.pass ? "PASS" : `FAIL(tests=${s.testsPass},untouched=${s.testUntouched})`, scoreNum: s.pass ? 1 : 0 });
        }
        row.answer = run.result.slice(0, 4000);
        rows.push(row);
        console.log(`${row.score}  ${run.numTurns} turns, ${totalTools} tool calls, ${(run.durationMs / 1000).toFixed(0)}s`);
      } finally {
        dropWorktree(dir);
      }
      writeFileSync(join(RESULTS_DIR, `${stamp}.json`), JSON.stringify({ model: MODEL, base: BASE, rows }, null, 2));
    }
  }
}

// summary table: mean score + mean turns per task x arm
console.log(`\n| task | ${ARMS.map((a) => `${a} score | ${a} turns`).join(" | ")} |`);
console.log(`|---${ARMS.map(() => "|---|---").join("")}|`);
for (const task of TASKS) {
  const cells = ARMS.map((arm) => {
    const rs = rows.filter((r) => r.task === task.id && r.arm === arm);
    const mean = (k: string): string => rs.length ? (rs.reduce((a, r) => a + Number(r[k] ?? 0), 0) / rs.length).toFixed(2) : "-";
    return `${mean("scoreNum")} | ${mean("turns")}`;
  });
  console.log(`| ${task.id} | ${cells.join(" | ")} |`);
}
console.log(`\nresults: bench/results/${stamp}.json`);
