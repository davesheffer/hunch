/**
 * Warm-memory cost benchmark: does Hunch make a real task in THIS repo cheaper
 * when the graph holds the memory that existed at the time?
 *
 * Each task is a merged PR that closed a GitHub issue. The agent works in a
 * sealed clone holding history only through the PR's base (the fix commit is
 * unreachable), with the PR's own test files dropped in and failing.
 *
 *   arm A — no Hunch: .hunch/, .mcp.json, hooks, Hunch commands and the
 *           HUNCH:START..END grounding blocks removed
 *   arm C — Hunch: the repo exactly as committed at the base (graph + block +
 *           hooks + MCP), repointed at a frozen copy of the current Hunch build
 *
 * Score = the PR's tests pass, typecheck passes, the test files are untouched.
 * Primary outcome = cost (USD, tokens), turns, wall time per task.
 *
 *   npx tsx bench/warm/run.ts prepare 338,345,...   # mine + validate tasks (no model)
 *   npx tsx bench/warm/run.ts run --only 338 --reps 1                  # smoke
 *   npx tsx bench/warm/run.ts run --reps 3 --model claude-sonnet-5     # full
 *   npx tsx bench/warm/run.ts report bench/warm/results/<stamp>.json
 */
import { execFileSync, spawn, spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import { cpSync, existsSync, mkdirSync, readdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { homedir, tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";

const REPO = resolve(import.meta.dirname, "..", "..");
const HERE = import.meta.dirname;
const TASKS_PATH = join(HERE, "tasks.json");
const RESULTS_DIR = join(HERE, "results");
const WORK = join(tmpdir(), "hunch-warm");
const TEMPLATES = join(WORK, "templates");
const FROZEN = join(WORK, "_hunch"); // frozen current Hunch build used by arm C
const AGENT_GH = join(homedir(), ".hunch", "agent-gh");

const argv = process.argv.slice(2);
const cmd = argv[0];
const flag = (name: string, dflt: string): string => {
  const i = argv.indexOf(`--${name}`);
  return i >= 0 && argv[i + 1] ? argv[i + 1]! : dflt;
};

interface Task {
  id: string; pr: number; issue: number; base: string; merge: string;
  issueTitle: string; issueBody: string; issueCreatedAt: string; mergedAt: string;
  testFiles: string[]; srcFiles: string[]; srcLines: number;
  memoryHits: number; // .hunch records at base naming one of the fixed src files (covariate)
}

const git = (cwd: string, ...a: string[]): string =>
  execFileSync("git", a, { cwd, encoding: "utf8", maxBuffer: 1 << 28, stdio: ["ignore", "pipe", "pipe"] }).trim();
const sha = (s: string): string => createHash("sha256").update(s).digest("hex").slice(0, 16);

// ------------------------------------------------------------ sealed clones
function templateDir(t: Pick<Task, "id">): string { return join(TEMPLATES, t.id); }

/** One sealed clone per task: history through base only, dependencies cloned in. */
function buildTemplate(t: Pick<Task, "id" | "base" | "merge">): string {
  const dir = templateDir(t);
  if (existsSync(`${dir}.sealed`)) return dir;
  rmSync(dir, { recursive: true, force: true });
  mkdirSync(dir, { recursive: true });
  git(dir, "init", "-q");
  git(dir, "fetch", "-q", "--no-tags", REPO, t.base);
  git(dir, "checkout", "-q", "--detach", "FETCH_HEAD");
  git(dir, "config", "user.email", "bench@example.invalid");
  git(dir, "config", "user.name", "bench");
  if (git(dir, "rev-parse", "HEAD") !== t.base) throw new Error(`${t.id}: sealed checkout is not the base`);
  if (spawnSync("git", ["cat-file", "-e", `${t.merge}^{commit}`], { cwd: dir }).status === 0) throw new Error(`${t.id}: fix commit leaked into the sealed clone`);
  execFileSync("cp", ["-Rc", join(REPO, "node_modules"), join(dir, "node_modules")]); // APFS clone
  writeFileSync(`${dir}.sealed`, t.base);
  return dir;
}

function freezeHunch(): void {
  if (existsSync(join(FROZEN, "dist", "cli", "index.js"))) return;
  mkdirSync(FROZEN, { recursive: true });
  for (const p of ["dist", "node_modules", "package.json"]) execFileSync("cp", ["-Rc", join(REPO, p), join(FROZEN, p)]);
}

function copyFromMerge(t: Task, dir: string, files: string[]): void {
  for (const f of files) {
    const body = execFileSync("git", ["show", `${t.merge}:${f}`], { cwd: REPO, maxBuffer: 1 << 28 });
    mkdirSync(dirname(join(dir, f)), { recursive: true });
    writeFileSync(join(dir, f), body);
  }
}

/** The single-file test command as it existed at the base: tooling/run-tests.mjs
 * landed on 2026-09-23; older bases ran `tsx --test` (package.json "test"). */
function testCommand(dir: string): { argv: string[]; shown: string } {
  return existsSync(join(dir, "tooling", "run-tests.mjs"))
    ? { argv: ["tooling/run-tests.mjs"], shown: "node tooling/run-tests.mjs <file>" }
    : { argv: [join("node_modules", "tsx", "dist", "cli.mjs"), "--test"], shown: "npx tsx --test <file>" };
}

function runTests(dir: string, files: string[]): { pass: boolean; tail: string } {
  const r = spawnSync(process.execPath, [...testCommand(dir).argv, ...files], { cwd: dir, encoding: "utf8", timeout: 15 * 60_000, maxBuffer: 1 << 26 });
  const tail = `${r.stdout ?? ""}${r.stderr ?? ""}`.slice(-1500);
  // a runner that cannot even load is a harness fault, never a red/green signal
  if (/code: 'MODULE_NOT_FOUND',\s*requireStack: \[\]/.test(tail)) throw new Error(`test runner failed to load in ${dir}: ${tail.slice(-300)}`);
  return { pass: r.status === 0, tail };
}

/** Non-blocking child run, so concurrent sessions never wait on each other's event loop. */
function spawnAsync(cmd: string, args: string[], opts: { cwd: string; input?: string; timeoutMs: number; env?: NodeJS.ProcessEnv }): Promise<{ status: number | null; stdout: string; stderr: string }> {
  return new Promise((done) => {
    const c = spawn(cmd, args, { cwd: opts.cwd, env: opts.env ?? process.env, stdio: ["pipe", "pipe", "pipe"] });
    let stdout = "", stderr = "";
    c.stdout.on("data", (d) => { stdout += d; });
    c.stderr.on("data", (d) => { stderr += d; if (stderr.length > 1 << 20) stderr = stderr.slice(-(1 << 19)); });
    const kill = setTimeout(() => c.kill("SIGKILL"), opts.timeoutMs);
    c.on("close", (status) => { clearTimeout(kill); done({ status, stdout, stderr }); });
    c.stdin.end(opts.input ?? "");
  });
}

async function runTestsAsync(dir: string, files: string[]): Promise<{ pass: boolean; tail: string }> {
  const r = await spawnAsync(process.execPath, [...testCommand(dir).argv, ...files], { cwd: dir, timeoutMs: 15 * 60_000 });
  return { pass: r.status === 0, tail: `${r.stdout}${r.stderr}`.slice(-1500) };
}

async function typecheckAsync(dir: string): Promise<boolean> {
  return (await spawnAsync(process.execPath, [join(dir, "node_modules", "typescript", "bin", "tsc"), "--noEmit"], { cwd: dir, timeoutMs: 10 * 60_000 })).status === 0;
}

function typecheck(dir: string): boolean {
  return spawnSync(process.execPath, [join(dir, "node_modules", "typescript", "bin", "tsc"), "--noEmit"], { cwd: dir, timeout: 10 * 60_000 }).status === 0;
}

// ------------------------------------------------------------------ prepare
function prepare(prs: number[]): void {
  const tasks: Task[] = existsSync(TASKS_PATH) ? JSON.parse(readFileSync(TASKS_PATH, "utf8")).tasks : [];
  for (const pr of prs) {
    try { prepareOne(pr, tasks); } catch (e) { console.log(`pr${pr}: error ${String(e).split("\n")[0].slice(0, 200)}`); }
  }
}

function prepareOne(pr: number, tasks: Task[]): void {
  {
    const id = `pr${pr}`;
    if (tasks.some((t) => t.id === id)) { console.log(`${id}: already prepared`); return; }
    const line = git(REPO, "log", "--first-parent", "main", "--merges", "--format=%H %P|%cI", `--grep=pull request #${pr} `).split("\n")[0];
    if (!line) { console.log(`${id}: no merge commit`); return; }
    const [shas, mergedAt] = line.split("|");
    const [merge, base] = shas!.split(" ") as [string, string];
    const files = git(REPO, "diff", "--name-only", base, merge).split("\n").filter(Boolean);
    const testFiles = files.filter((f) => /^test\/.*\.test\.ts$/.test(f));
    const srcFiles = files.filter((f) => /^src\/.*\.ts$/.test(f));
    const stat = git(REPO, "diff", "--shortstat", base, merge, "--", "src");
    const srcLines = [...stat.matchAll(/(\d+) (?:insertion|deletion)/g)].reduce((a, m) => a + Number(m[1]), 0);
    const prJson = JSON.parse(execFileSync(AGENT_GH, ["pr", "view", String(pr), "--json", "closingIssuesReferences"], { encoding: "utf8", stdio: ["ignore", "pipe", "ignore"] }));
    const issue = prJson.closingIssuesReferences?.[0]?.number as number | undefined;
    if (!issue) { console.log(`${id}: no linked issue`); return; }
    const iss = JSON.parse(execFileSync(AGENT_GH, ["issue", "view", String(issue), "--json", "title,body,createdAt"], { encoding: "utf8", stdio: ["ignore", "pipe", "ignore"] }));
    if (Date.parse(iss.createdAt) > Date.parse(mergedAt!)) { console.log(`${id}: issue filed after merge`); return; }
    const t: Task = { id, pr, issue, base, merge, mergedAt: mergedAt!, issueTitle: iss.title, issueBody: iss.body, issueCreatedAt: iss.createdAt, testFiles, srcFiles, srcLines, memoryHits: 0 };

    const tpl = buildTemplate(t);
    // red: the PR's tests on the base tree
    const probe = join(WORK, "probe", id);
    rmSync(probe, { recursive: true, force: true });
    mkdirSync(dirname(probe), { recursive: true });
    execFileSync("cp", ["-Rc", tpl, probe]);
    copyFromMerge(t, probe, testFiles);
    const red = runTests(probe, testFiles);
    // green: the whole PR (minus graph/docs churn) applied
    copyFromMerge(t, probe, files.filter((f) => !f.startsWith(".hunch/") && spawnSync("git", ["cat-file", "-e", `${merge}:${f}`], { cwd: REPO }).status === 0));
    const green = runTests(probe, testFiles);
    rmSync(probe, { recursive: true, force: true });
    // covariate: how much recorded memory at base names the files this fix touched
    const hunchDir = join(tpl, ".hunch");
    let hits = 0;
    for (const kind of ["decisions", "bugs", "constraints", "findings"]) {
      const d = join(hunchDir, kind);
      if (!existsSync(d)) continue;
      for (const f of readdirSync(d)) {
        const body = readFileSync(join(d, f), "utf8");
        if (srcFiles.some((s) => body.includes(s))) hits++;
      }
    }
    t.memoryHits = hits;
    const ok = !red.pass && green.pass;
    console.log(`${id} (#${issue}, ${srcLines} src lines, memory=${hits}): red=${red.pass ? "PASS(bad)" : "fail"} green=${green.pass ? "pass" : "FAIL(bad)"} → ${ok ? "VALID" : "rejected"}`);
    if (!ok) { if (!green.pass) console.log(green.tail.split("\n").slice(-8).join("\n")); return; }
    tasks.push(t);
    writeFileSync(TASKS_PATH, JSON.stringify({ note: "Warm-memory tasks: merged PRs that closed an issue; see run.ts", tasks }, null, 2) + "\n");
  }
}

// ---------------------------------------------------------------- arm shaping
const HUNCH_BLOCK = /<!-- HUNCH:START[\s\S]*?<!-- HUNCH:END -->\n?/g;
const NPX_HUNCH = /npx -y (?:--package=\S+ hunch|@davesheffer\/hunch(?:@\S+)?)/g;

function shapeArm(dir: string, arm: "A" | "C"): void {
  if (arm === "A") {
    rmSync(join(dir, ".hunch"), { recursive: true, force: true });
    rmSync(join(dir, ".mcp.json"), { force: true });
    rmSync(join(dir, ".claude", "settings.json"), { force: true }); // every hook in it is Hunch's
    const cmds = join(dir, ".claude", "commands");
    for (const c of ["audit", "capture", "heal", "hunch-fix", "hunch-fragile", "hunch-why"]) rmSync(join(cmds, `${c}.md`), { force: true });
    for (const f of ["CLAUDE.md", "AGENTS.md"]) {
      const p = join(dir, f);
      if (existsSync(p)) writeFileSync(p, readFileSync(p, "utf8").replace(HUNCH_BLOCK, ""));
    }
    // commit the stripped tree so the agent's `git status` is identical in shape to arm C
    git(dir, "add", "-A");
    git(dir, "commit", "-q", "--no-verify", "-m", "bench: baseline tree");
    return;
  }
  const node = `"${process.execPath}" "${join(FROZEN, "dist", "cli", "index.js")}"`;
  writeFileSync(join(dir, ".mcp.json"), JSON.stringify({ mcpServers: { hunch: { command: process.execPath, args: [join(FROZEN, "dist", "cli", "index.js"), "mcp"] } } }, null, 2));
  // .claude/settings.json is gitignored here, so no base carries hooks: install the
  // exact hook set `hunch init` 1.42.0 wrote to the live checkout (arm-c-settings.json)
  const hooks = readFileSync(join(HERE, "arm-c-settings.json"), "utf8").replace(NPX_HUNCH, node.replace(/"/g, '\\"'));
  if (!hooks.includes(FROZEN)) throw new Error("arm C hooks were not repointed at the frozen build");
  mkdirSync(join(dir, ".claude"), { recursive: true });
  writeFileSync(join(dir, ".claude", "settings.json"), hooks);
  git(dir, "add", "-A");
  git(dir, "commit", "-q", "--allow-empty", "--no-verify", "-m", "bench: hunch tree");
}

function sealedSettings(dir: string): string {
  const denied = [
    join(homedir(), "Documents", "GitHub"), // the live repo, the private overlay, every other clone
    join(homedir(), ".claude", "projects"), // prior transcripts
    join(homedir(), ".hunch"),
    join(homedir(), ".npm"), // npx cache holds published (future) Hunch builds
    FROZEN,
    TEMPLATES,
  ];
  const s = {
    permissions: { deny: ["WebFetch", "WebSearch", ...denied.map((d) => `Read(${d}/**)`)] },
    sandbox: {
      enabled: true, failIfUnavailable: true, autoAllowBashIfSandboxed: true, allowUnsandboxedCommands: false,
      filesystem: { denyRead: denied },
      network: { deniedDomains: ["*"] },
    },
  };
  const p = join(dir, "..", "sealed-settings.json");
  writeFileSync(p, JSON.stringify(s, null, 2));
  return p;
}

function prompt(t: Task, dir: string): string {
  return [
    `A GitHub issue was filed against this repository. Resolve it by fixing the source code.`,
    ``,
    `This is an offline snapshot: do not use the network, gh, or git remotes.`,
    `Tests describing the fix are already in the working tree and currently fail: ${t.testFiles.join(", ")}.`,
    `Make them pass without modifying those test files. Run one test file with \`${testCommand(dir).shown}\`; typecheck with \`npm run typecheck\`.`,
    `When you are done, reply with a short summary of the root cause and the change.`,
    ``,
    `## Issue #${t.issue}: ${t.issueTitle}`,
    ``,
    t.issueBody,
  ].join("\n");
}

// ------------------------------------------------------------------ one run
interface ClaudeOut {
  result?: string; session_id?: string; num_turns?: number; total_cost_usd?: number; duration_ms?: number; is_error?: boolean; subtype?: string;
  usage?: { input_tokens?: number; output_tokens?: number; cache_creation_input_tokens?: number; cache_read_input_tokens?: number };
}

/** A `.hunch` path component — not `mcp.hunch_context` or other identifiers. */
const HUNCH_PATH = /(?:^|[\s"'`/=(:])\.hunch(?:[/"'`\s)]|$)/;

/** Tool-call tally, plus whether any tool input touched .hunch/ (arm A can still reach it via git history). */
function toolTally(sessionId: string | undefined): Record<string, number> {
  if (!sessionId) return {};
  const projects = join(homedir(), ".claude", "projects");
  for (const d of readdirSync(projects)) {
    const p = join(projects, d, `${sessionId}.jsonl`);
    if (!existsSync(p)) continue;
    const tally: Record<string, number> = {};
    for (const line of readFileSync(p, "utf8").split("\n")) {
      try {
        const j = JSON.parse(line);
        if (j.type !== "assistant") continue;
        for (const c of j.message?.content ?? []) {
          if (c.type !== "tool_use") continue;
          tally[c.name] = (tally[c.name] ?? 0) + 1;
          if (HUNCH_PATH.test(JSON.stringify(c.input ?? {}))) tally["~touched .hunch"] = (tally["~touched .hunch"] ?? 0) + 1;
        }
      } catch { /* partial line */ }
    }
    return tally;
  }
  return {};
}

async function runOne(t: Task, arm: "A" | "C", rep: number, model: string, maxTurns: number): Promise<Record<string, unknown>> {
  const root = join(WORK, "runs", `${t.id}-${arm}-${rep}-${Date.now()}`);
  const dir = join(root, "repo");
  mkdirSync(root, { recursive: true });
  execFileSync("cp", ["-Rc", buildTemplate(t), dir]);
  shapeArm(dir, arm);
  copyFromMerge(t, dir, t.testFiles);
  const testHash = sha(t.testFiles.map((f) => readFileSync(join(dir, f), "utf8")).join("\0"));
  const settings = sealedSettings(dir);
  const args = ["-p", "--model", model, "--output-format", "json", "--permission-mode", "bypassPermissions", "--max-turns", String(maxTurns),
    "--setting-sources", "project", "--settings", settings, "--disallowedTools", "WebFetch", "WebSearch", "--strict-mcp-config",
    ...(arm === "C" ? ["--mcp-config", join(dir, ".mcp.json")] : [])];
  const t0 = Date.now();
  const r = await spawnAsync("claude", args, { cwd: dir, input: prompt(t, dir), timeoutMs: 90 * 60_000, env: { ...process.env, NPM_CONFIG_OFFLINE: "true" } });
  const wallMs = Date.now() - t0;
  let out: ClaudeOut = {};
  try { out = JSON.parse(r.stdout); } catch { out = { result: `${r.stdout}${r.stderr}`.slice(-2000), is_error: true }; }
  const infra = /^(?:API Error:|Not logged in|Authentication failed|You've hit your limit|Claude usage limit)/i.test((out.result ?? "").trim())
    || (!out.session_id && r.status !== 0);

  // score on the agent's tree with the PR's tests restored
  const touched = sha(t.testFiles.map((f) => existsSync(join(dir, f)) ? readFileSync(join(dir, f), "utf8") : "").join("\0")) !== testHash;
  copyFromMerge(t, dir, t.testFiles);
  const tests = infra ? { pass: false, tail: "" } : await runTestsAsync(dir, t.testFiles);
  const tc = infra ? false : await typecheckAsync(dir);
  const tools = toolTally(out.session_id);
  const u = out.usage ?? {};
  const row = {
    task: t.id, arm, rep, model, infra,
    pass: tests.pass && tc && !touched, testsPass: tests.pass, typecheck: tc, testsTouched: touched,
    costUsd: out.total_cost_usd ?? null, turns: out.num_turns ?? null, wallMs, apiMs: out.duration_ms ?? null,
    inputTokens: u.input_tokens ?? null, outputTokens: u.output_tokens ?? null,
    cacheWriteTokens: u.cache_creation_input_tokens ?? null, cacheReadTokens: u.cache_read_input_tokens ?? null,
    toolCalls: Object.entries(tools).filter(([k]) => !k.startsWith("~")).reduce((a, [, v]) => a + v, 0),
    touchedHunchDir: tools["~touched .hunch"] ?? 0,
    hunchCalls: Object.entries(tools).filter(([k]) => k.startsWith("mcp__hunch__")).reduce((a, [, v]) => a + v, 0),
    tools, subtype: out.subtype ?? null, sessionId: out.session_id ?? null,
    answer: (out.result ?? "").slice(0, 3000), testTail: tests.pass ? "" : tests.tail.slice(-600),
  };
  if (!process.env.BENCH_KEEP) rmSync(root, { recursive: true, force: true });
  return row;
}

// ------------------------------------------------------------------ report
const mean = (xs: number[]): number => xs.length ? xs.reduce((a, b) => a + b, 0) / xs.length : NaN;
const median = (xs: number[]): number => { const s = [...xs].sort((a, b) => a - b); const m = s.length >> 1; return s.length ? (s.length % 2 ? s[m]! : (s[m - 1]! + s[m]!) / 2) : NaN; };

/** Paired by task: per-task mean of each arm, then bootstrap the mean of per-task C/A ratios. */
function report(rows: Array<Record<string, any>>): string {
  const valid = rows.filter((r) => !r.infra);
  const tasks = [...new Set(valid.map((r) => r.task as string))];
  const lines: string[] = [];
  const by = (task: string, arm: string) => valid.filter((r) => r.task === task && r.arm === arm);
  lines.push(`| task | memory | A pass | C pass | A $ | C $ | A turns | C turns | A min | C min | C hunch calls |`, `|---|---:|---:|---:|---:|---:|---:|---:|---:|---:|---:|`);
  const ratios: Record<string, number[]> = { cost: [], turns: [], wall: [] };
  for (const task of tasks) {
    const a = by(task, "A"), c = by(task, "C");
    const m = (xs: any[], k: string) => mean(xs.map((r) => Number(r[k])).filter(Number.isFinite));
    const memory = valid.find((r) => r.task === task)?.memoryHits ?? "";
    lines.push(`| ${task} | ${memory} | ${a.filter((r) => r.pass).length}/${a.length} | ${c.filter((r) => r.pass).length}/${c.length} | ${m(a, "costUsd").toFixed(2)} | ${m(c, "costUsd").toFixed(2)} | ${m(a, "turns").toFixed(1)} | ${m(c, "turns").toFixed(1)} | ${(m(a, "wallMs") / 60000).toFixed(1)} | ${(m(c, "wallMs") / 60000).toFixed(1)} | ${m(c, "hunchCalls").toFixed(1)} |`);
    if (a.length && c.length) {
      ratios.cost!.push(m(c, "costUsd") / m(a, "costUsd"));
      ratios.turns!.push(m(c, "turns") / m(a, "turns"));
      ratios.wall!.push(m(c, "wallMs") / m(a, "wallMs"));
    }
  }
  const boot = (xs: number[]): [number, number] => {
    if (xs.length < 2) return [NaN, NaN];
    let seed = 42; const rnd = () => ((seed = (seed * 1103515245 + 12345) % 2 ** 31) / 2 ** 31);
    const ms = Array.from({ length: 5000 }, () => mean(xs.map(() => xs[Math.floor(rnd() * xs.length)]!))).sort((a, b) => a - b);
    return [ms[125]!, ms[4875]!];
  };
  lines.push("", `Paired over ${ratios.cost!.length} tasks (C ÷ A, per-task means; <1.00 means Hunch is cheaper/faster):`);
  for (const k of ["cost", "turns", "wall"]) {
    const xs = ratios[k]!; const [lo, hi] = boot(xs);
    lines.push(`- ${k}: mean ratio ${mean(xs).toFixed(2)} (95% bootstrap CI ${lo.toFixed(2)}–${hi.toFixed(2)}), median ${median(xs).toFixed(2)}`);
  }
  const pa = valid.filter((r) => r.arm === "A"), pc = valid.filter((r) => r.arm === "C");
  lines.push(`- pass rate: A ${pa.filter((r) => r.pass).length}/${pa.length}, C ${pc.filter((r) => r.pass).length}/${pc.length}`);
  lines.push(`- total spend: A $${mean(pa.map((r) => r.costUsd)).toFixed(2)}/run, C $${mean(pc.map((r) => r.costUsd)).toFixed(2)}/run; infra-excluded rows: ${rows.length - valid.length}`);
  const capped = (xs: any[]) => xs.filter((r) => r.subtype === "error_max_turns").length;
  lines.push(`- hit the turn cap (censored): A ${capped(pa)}/${pa.length}, C ${capped(pc)}/${pc.length}; arm A runs touching a .hunch path: ${pa.filter((r) => r.touchedHunchDir > 0).length}`);
  return lines.join("\n");
}

// -------------------------------------------------------------------- main
if (cmd === "prepare") {
  prepare((argv[1] ?? "").split(",").filter(Boolean).map(Number));
} else if (cmd === "run") {
  const all: Task[] = JSON.parse(readFileSync(TASKS_PATH, "utf8")).tasks;
  const only = flag("only", "").split(",").filter(Boolean).map((s) => (s.startsWith("pr") ? s : `pr${s}`));
  const tasks = only.length ? all.filter((t) => only.includes(t.id)) : all;
  const reps = Number(flag("reps", "3"));
  const model = flag("model", "claude-sonnet-5");
  const maxTurns = Number(flag("max-turns", "150"));
  const arms = flag("arms", "A,C").split(",") as Array<"A" | "C">;
  freezeHunch();
  mkdirSync(RESULTS_DIR, { recursive: true });
  const out = flag("out", join(RESULTS_DIR, `${new Date().toISOString().replace(/[:.]/g, "-")}.json`));
  const rows: Array<Record<string, unknown>> = existsSync(out) ? JSON.parse(readFileSync(out, "utf8")).rows : [];
  console.log(`warm bench: model=${model} arms=${arms} reps=${reps} tasks=${tasks.map((t) => t.id)} → ${out}`);
  const concurrency = Number(flag("concurrency", "1"));
  // rep-major, arm order alternating, so drift over hours hits both arms alike; with
  // --concurrency N the queue is drained in that order by N workers (wall time is then
  // measured under shared load — cost and turns are unaffected)
  const queue: Array<{ t: Task; arm: "A" | "C"; rep: number }> = [];
  for (let rep = 1; rep <= reps; rep++) {
    for (const [i, t] of tasks.entries()) {
      for (const arm of (i + rep) % 2 ? [...arms].reverse() : arms) {
        if (!rows.some((r) => r.task === t.id && r.arm === arm && r.rep === rep && !r.infra)) queue.push({ t, arm, rep }); // resumable
      }
    }
  }
  let stop = false;
  const worker = async () => {
    for (let job = queue.shift(); job && !stop; job = queue.shift()) {
      const { t, arm, rep } = job;
      console.log(`▶ ${t.id} ${arm} rep${rep} started`);
      const row: Record<string, any> = { ...(await runOne(t, arm, rep, model, maxTurns)), memoryHits: t.memoryHits, concurrency };
      rows.push(row);
      writeFileSync(out, JSON.stringify({ model, rows }, null, 2));
      console.log(`■ ${t.id} ${arm} rep${rep} ` + (row.infra ? `INFRA: ${String(row.answer).slice(0, 120)}` : `${row.pass ? "PASS" : "fail"} $${Number(row.costUsd).toFixed(2)} ${row.turns}t ${(Number(row.wallMs) / 60000).toFixed(1)}m hunch=${row.hunchCalls} ${row.subtype}`));
      if (row.infra && /limit/i.test(String(row.answer))) { stop = true; console.log("usage limit hit — draining; rerun with --out to resume"); }
    }
  };
  await Promise.all(Array.from({ length: concurrency }, worker));
  console.log(`\n${queue.length} queued jobs left${stop ? " (stopped on usage limit)" : ""}\n` + report(rows as Array<Record<string, any>>));
  if (stop) process.exit(3);
} else if (cmd === "report") {
  console.log(report(JSON.parse(readFileSync(argv[1]!, "utf8")).rows));
} else {
  console.log("usage: run.ts prepare <pr,pr,...> | run [--only ..] [--reps n] [--model m] [--out f] | report <results.json>");
}
