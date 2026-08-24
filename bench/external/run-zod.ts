/**
 * Time-split benchmark on zod (external repo, cold graph): the .hunch graph was
 * backfilled ONLY from commits before the cutoff; every task is a real
 * post-cutoff issue whose merged fix supplies the regression tests. Each agent
 * runs in a future-free repository containing authentic history only through
 * the pre-fix commit. Outbound network access is denied, and a separate clean
 * checkout grades the agent's source changes.
 *
 *   arm A — bare model in a pristine zod snapshot at the pre-fix commit
 *   arm C — same snapshot + the cutoff .hunch graph + hunch MCP + CLAUDE.md block
 *
 * Score: the fix's own test files (applied from the real fix commit) pass, and
 * the agent didn't touch them.
 *
 *   npx tsx bench/external/run-zod.ts --dry-fix zod-5868     # plumbing, no model
 *   npx tsx bench/external/run-zod.ts --arms A,C --model claude-sonnet-5 \
 *     --memory /path/to/pre-cutoff/zod
 */
import { execFileSync, execSync, spawnSync } from "node:child_process";
import { mkdirSync, rmSync, writeFileSync, readFileSync, existsSync, readdirSync, cpSync } from "node:fs";
import { homedir, tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { snapshotFiles, snapshotsEqual, type FileSnapshot } from "./file-integrity.js";

const OUT_DIR = join(import.meta.dirname, "results");

const argv = process.argv.slice(2);
const flag = (name: string, dflt: string): string => {
  const i = argv.indexOf(`--${name}`);
  return i >= 0 && argv[i + 1] ? argv[i + 1]! : dflt;
};
const ZOD = resolve(flag("zod", process.env.HUNCH_ZOD_BENCH_REPO ?? "../zod-bench"));
const HUNCH_REPO = resolve(flag("hunch", process.env.HUNCH_BENCH_REPO ?? process.cwd()));
const MEMORY_SOURCE = resolve(flag("memory", process.env.HUNCH_ZOD_MEMORY_REPO ?? ZOD));
const MODEL = flag("model", "claude-sonnet-5");
// A = bare, C = +cold hunch graph, S = +fable-mode skill (no graph)
const ARMS = flag("arms", "A,C").split(",") as Array<"A" | "C" | "S" | "P">;
// --no-repro: the agent gets ONLY the issue text — no failing test handed over.
// The real regression tests are applied at SCORING time. This is diagnosis mode.
const NO_REPRO = argv.includes("--no-repro");
// --force-hunch: C arm must consult the frozen graph before investigating.
// This separates memory quality from ambient-instruction/tool-uptake quality.
const FORCE_HUNCH = argv.includes("--force-hunch");
// --force-skill: S arm's prompt names the skill explicitly — separates
// "content doesn't help" from "model never reads it" (measured: 20/20 S
// sessions never invoked fable-mode unprompted).
const FORCE_SKILL = argv.includes("--force-skill");
const MAX_TURNS = Number(flag("max-turns", "50"));
const REPEATS = Number(flag("repeats", "1"));
const DRY_FIX = flag("dry-fix", "");
const ONLY = flag("only", "");
const RUN_ALL = argv.includes("--all");
const ASSIGNMENTS = new Set(flag("assignments", "").split(",").filter(Boolean));

// Bug-shaped subset (features/locales excluded); diverse areas of the library.
const DEFAULT_TASKS = ["zod-5842", "zod-5944", "zod-5937", "zod-5826", "zod-5868", "zod-5792", "zod-5296", "zod-5714"];

interface Task {
  id: string; pr: number; fixSha: string; mergedAt: string;
  issueTitle: string; issueBody: string; testFiles: string[]; srcFiles: string[];
}
interface Suite { cutoff: string; tasks: Task[] }
const SUITE = JSON.parse(readFileSync(join(import.meta.dirname, "zod-tasks.json"), "utf8")) as Suite;
const ALL = SUITE.tasks;
const selectedIds = new Set((ONLY || DRY_FIX).split(",").filter(Boolean));
const TASKS = ALL.filter((t) => selectedIds.size ? selectedIds.has(t.id) : RUN_ALL || DEFAULT_TASKS.includes(t.id));

if (!Number.isSafeInteger(REPEATS) || REPEATS < 1) throw new Error(`--repeats must be a positive integer, got ${REPEATS}`);
if (selectedIds.size && TASKS.length !== selectedIds.size) {
  const found = new Set(TASKS.map((task) => task.id));
  throw new Error(`unknown task(s): ${[...selectedIds].filter((id) => !found.has(id)).join(", ")}`);
}
for (const assignment of ASSIGNMENTS) {
  if (!/^[^:]+:\d+:[ACSP]$/.test(assignment)) throw new Error(`invalid --assignments entry: ${assignment}`);
}

const sh = (cmd: string, cwd = ZOD): string => execSync(cmd, { cwd, encoding: "utf8", stdio: ["ignore", "pipe", "pipe"] });

const BENCH_ROOT = join(tmpdir(), `zod-bench-isolated-${process.pid}`);

function copyFromTrustedRevision(revision: string, files: string[], destination: string): void {
  for (const file of files) {
    const content = execFileSync("git", ["show", `${revision}:${file}`], {
      cwd: ZOD,
      encoding: "buffer",
      maxBuffer: 64 * 1024 * 1024,
    });
    const target = join(destination, file);
    mkdirSync(dirname(target), { recursive: true });
    writeFileSync(target, content);
  }
}

interface AttemptDirs { root: string; agent: string; scorer: string; preFixSha: string }

function installDependencies(dir: string): void {
  execSync("corepack pnpm install --frozen-lockfile --prefer-offline", {
    cwd: dir,
    stdio: "ignore",
    timeout: 10 * 60 * 1000,
  });
}

function gitObjectExists(dir: string, revision: string): boolean {
  return spawnSync("git", ["cat-file", "-e", `${revision}^{commit}`], { cwd: dir }).status === 0;
}

function makeAttempt(name: string, arm: "A" | "C" | "S" | "P", task: Task): AttemptDirs {
  const root = join(BENCH_ROOT, name);
  const source = join(root, "trusted-source.git");
  const agent = join(root, "agent");
  const scorer = join(root, "scorer");
  const preFixSha = sh(`git rev-parse ${task.fixSha}~1`).trim();
  rmSync(root, { recursive: true, force: true });
  mkdirSync(root, { recursive: true });

  // Push exactly one ref into a new bare repository. Git transfers only objects
  // reachable from the pre-fix commit: authentic ancestry is retained for Hunch
  // provenance checks, while the fix commit and every later object are absent.
  execFileSync("git", ["init", "--bare", "--quiet", source]);
  execFileSync("git", ["push", "--quiet", source, `${preFixSha}:refs/heads/main`], { cwd: ZOD });
  for (const destination of [agent, scorer]) {
    execFileSync("git", ["clone", "--quiet", "--no-local", "--single-branch", "--branch", "main", source, destination]);
    execFileSync("git", ["remote", "remove", "origin"], { cwd: destination });
    const actual = execFileSync("git", ["rev-parse", "HEAD"], { cwd: destination, encoding: "utf8" }).trim();
    if (actual !== preFixSha) throw new Error(`sealed checkout mismatch: expected ${preFixSha}, got ${actual}`);
    if (gitObjectExists(destination, task.fixSha)) throw new Error(`future fix object leaked into ${destination}`);
    installDependencies(destination);
  }
  rmSync(source, { recursive: true, force: true });

  // the real fix's regression tests, applied on top of the buggy tree —
  // unless diagnosis mode, where they stay hidden until scoring
  if (!NO_REPRO) copyFromTrustedRevision(task.fixSha, task.testFiles, agent);

  if (arm === "S") {
    cpSync(join(HUNCH_REPO, ".claude", "skills", "fable-mode"), join(agent, ".claude", "skills", "fable-mode"), { recursive: true });
  }
  if (arm === "C") {
    cpSync(join(MEMORY_SOURCE, ".hunch"), join(agent, ".hunch"), { recursive: true });
    if (existsSync(join(MEMORY_SOURCE, "CLAUDE.md"))) cpSync(join(MEMORY_SOURCE, "CLAUDE.md"), join(agent, "CLAUDE.md"));
    writeFileSync(join(agent, ".mcp.json"), JSON.stringify({
      mcpServers: {
        hunch: {
          command: process.execPath,
          args: [join(HUNCH_REPO, "dist", "cli", "index.js"), "mcp"],
        },
      },
    }, null, 2));
  }
  if (arm === "P") {
    // the SHIPPED verification pipeline (v1.4.1+): hunch init writes the agent
    // hooks into the worktree's .claude/settings.json; --setting-sources project
    // loads them headlessly. firm = stop-gate on. No skill, no graph — pipeline only.
    execSync(`"${process.execPath}" "${join(HUNCH_REPO, "dist", "cli", "index.js")}" init --firmness firm --no-index --no-enforce --no-providers`, {
      cwd: agent, stdio: "ignore", timeout: 5 * 60 * 1000,
    });
  }
  // This settings file is passed explicitly to Claude. Read-tool denies keep
  // the trusted source clone and prior transcripts out of reach; sandbox denies
  // cover Bash and every subprocess it launches.
  const sealedSettings = {
    permissions: {
      deny: [
        "WebFetch",
        "WebSearch",
        `Read(${ZOD}/**)`,
        `Read(${MEMORY_SOURCE}/**)`,
        `Read(${scorer}/**)`,
        `Read(${join(homedir(), ".claude", "projects")}/**)`,
      ],
    },
    sandbox: {
      enabled: true,
      failIfUnavailable: true,
      autoAllowBashIfSandboxed: true,
      allowUnsandboxedCommands: false,
      filesystem: {
        denyRead: [ZOD, MEMORY_SOURCE, scorer, join(homedir(), ".claude", "projects")],
      },
      network: {
        deniedDomains: ["*"],
      },
    },
  };
  const settingsPath = join(agent, ".claude", "benchmark-sealed-settings.json");
  mkdirSync(dirname(settingsPath), { recursive: true });
  writeFileSync(settingsPath, JSON.stringify(sealedSettings, null, 2));
  return { root, agent, scorer, preFixSha };
}

function dropAttempt(attempt: AttemptDirs): void {
  rmSync(attempt.root, { recursive: true, force: true });
}

interface TestRun { pass: boolean; infrastructureFailure: boolean; output: string }

function runTests(task: Task, dir: string): TestRun {
  // repo-relative paths from the worktree ROOT: zod's vitest workspace globs
  // ("packages/*") resolve against cwd, so a package-dir run finds no projects
  const result = spawnSync("npx", ["vitest", "run", ...task.testFiles], {
    cwd: dir,
    encoding: "utf8",
    env: { ...process.env, CI: "true" },
    maxBuffer: 64 * 1024 * 1024,
    timeout: 10 * 60 * 1000,
  });
  const output = `${result.stdout ?? ""}${result.stderr ?? ""}`.slice(-20_000);
  return {
    pass: result.status === 0,
    infrastructureFailure: Boolean(result.error),
    output: result.error ? `${result.error.message}\n${output}`.trim() : output.trim(),
  };
}

function changedFiles(dir: string): string[] {
  const tracked = sh("git diff --name-only HEAD", dir).split("\n");
  const untracked = sh("git ls-files --others --exclude-standard", dir).split("\n");
  return [...new Set([...tracked, ...untracked].map((path) => path.trim()).filter(Boolean))].sort();
}

function isSourceChange(path: string): boolean {
  return path.startsWith("packages/zod/src/")
    && !path.includes("/tests/")
    && !/\.test\.[cm]?[jt]sx?$/.test(path);
}

function copyAgentSourceChanges(files: string[], agent: string, scorer: string): string[] {
  const sourceFiles = files.filter(isSourceChange);
  for (const file of sourceFiles) {
    const from = join(agent, file);
    const to = join(scorer, file);
    if (existsSync(from)) {
      mkdirSync(dirname(to), { recursive: true });
      cpSync(from, to);
    } else {
      rmSync(to, { force: true });
    }
  }
  return sourceFiles;
}

interface Score {
  pass: boolean; testsPass: boolean; testUntouched: boolean;
  testInfrastructureFailure: boolean; testOutput: string; scoredSourceFiles: string[];
}

function scoreFix(
  task: Task,
  attempt: AttemptDirs,
  testBaseline: FileSnapshot[],
  agentChangedFiles: string[],
): Score {
  // Check this BEFORE hidden tests are installed: otherwise checkout would
  // erase an agent's test edits and create a false "untouched" result.
  const testUntouched = snapshotsEqual(testBaseline, attempt.agent);
  const scoredSourceFiles = copyAgentSourceChanges(agentChangedFiles, attempt.agent, attempt.scorer);
  // Ground-truth tests are installed only in the scorer, after the agent exits.
  copyFromTrustedRevision(task.fixSha, task.testFiles, attempt.scorer);
  const test = runTests(task, attempt.scorer);
  return {
    pass: test.pass && testUntouched,
    testsPass: test.pass,
    testUntouched,
    testInfrastructureFailure: test.infrastructureFailure,
    testOutput: test.output,
    scoredSourceFiles,
  };
}

function prompt(task: Task, arm: "A" | "C" | "S" | "P"): string {
  const repro = NO_REPRO
    ? `No reproduction is provided — diagnose from the report alone. Write your own repro if it helps (grading runs the project's own test suite afterwards).`
    : `Failing regression tests already exist — reproduce from the repo root with:  npx vitest run ${task.testFiles.join(" ")}`;
  return [
    ...(FORCE_HUNCH && arm === "C" ? [`First call hunch_context for this bug and use the relevant engineering memory while diagnosing it.`, ``] : []),
    ...(FORCE_SKILL ? [`First invoke the fable-mode skill (Skill tool) and follow its protocol strictly throughout this task.`, ``] : []),
    `This is a sealed offline benchmark snapshot. Use only the files and tools in this checkout. Do not use the network, GitHub, gh, curl, WebFetch, WebSearch, or search for later commits or pull requests.`,
    `A user filed this bug against zod (the library in packages/zod). Diagnose the root cause and fix it in the SOURCE code.`,
    repro,
    `Run validation commands synchronously; do not start background jobs. For local tests use npx vitest run <test-path>; do not use pnpm vitest because this environment is intentionally offline.`,
    `Do NOT modify existing test files. Fix the root cause, not the symptom.`,
    ``,
    `## Issue: ${task.issueTitle}`,
    ``,
    task.issueBody,
  ].join("\n");
}

function runClaude(dir: string, p: string): { result: string; numTurns: number; sessionId: string | null; durationMs: number } {
  const t0 = Date.now();
  const mcp = existsSync(join(dir, ".mcp.json")) ? ` --mcp-config .mcp.json` : "";
  const cmd = `claude -p --model ${MODEL} --output-format json --permission-mode bypassPermissions --max-turns ${MAX_TURNS} --setting-sources project --settings .claude/benchmark-sealed-settings.json --disallowedTools WebFetch WebSearch${mcp} --strict-mcp-config`;
  let out = "";
  try {
    out = execSync(cmd, {
      cwd: dir,
      input: p,
      encoding: "utf8",
      env: { ...process.env, NPM_CONFIG_OFFLINE: "true", COREPACK_ENABLE_NETWORK: "0" },
      maxBuffer: 64 * 1024 * 1024,
      timeout: 45 * 60 * 1000,
    });
  } catch (e) { out = String((e as { stdout?: string }).stdout ?? ""); }
  let parsed: { result?: string; session_id?: string; num_turns?: number } = {};
  try { parsed = JSON.parse(out); } catch { parsed = { result: out }; }
  return { result: parsed.result ?? "", numTurns: parsed.num_turns ?? -1, sessionId: parsed.session_id ?? null, durationMs: Date.now() - t0 };
}

function isInfrastructureFailure(run: { result: string }): boolean {
  return /^API Error:/i.test(run.result.trim());
}

interface HunchStats {
  calls: number;
  contextCalls: number;
  delivered: number;
  supplements: number;
  deliveredSupplements: number;
  staleOmitted: number;
  abstentions: number;
  abstainedRecords: number;
}

function hunchStats(sessionId: string | null): HunchStats {
  const stats: HunchStats = {
    calls: 0,
    contextCalls: 0,
    delivered: 0,
    supplements: 0,
    deliveredSupplements: 0,
    staleOmitted: 0,
    abstentions: 0,
    abstainedRecords: 0,
  };
  if (!sessionId) return stats;
  const projects = join(homedir(), ".claude", "projects");
  try {
    for (const d of readdirSync(projects)) {
      const p = join(projects, d, `${sessionId}.jsonl`);
      if (!existsSync(p)) continue;
      const hunchIds = new Set<string>();
      for (const line of readFileSync(p, "utf8").split("\n")) {
        if (!line.trim()) continue;
        let event: { message?: { content?: Array<Record<string, unknown>> } };
        try { event = JSON.parse(line) as typeof event; } catch { continue; }
        for (const content of event.message?.content ?? []) {
          if (content.type === "tool_use" && typeof content.name === "string" && content.name.includes("mcp__hunch")) {
            stats.calls++;
            if (content.name.endsWith("hunch_context")) stats.contextCalls++;
            if (typeof content.id === "string") hunchIds.add(content.id);
          }
          if (content.type !== "tool_result" || typeof content.tool_use_id !== "string" || !hunchIds.has(content.tool_use_id)) continue;
          const raw = typeof content.content === "string" ? content.content : JSON.stringify(content.content ?? "");
          try {
            const parsed = JSON.parse(raw) as {
              delivered?: unknown[];
              supplements?: Array<{ delivered?: boolean }>;
              omitted?: Array<{ reason?: string }>;
              abstention?: { active?: boolean; withheld?: number };
            };
            stats.delivered += parsed.delivered?.length ?? 0;
            stats.supplements += parsed.supplements?.length ?? 0;
            stats.deliveredSupplements += parsed.supplements?.filter((item) => item.delivered).length ?? 0;
            stats.staleOmitted += parsed.omitted?.filter((item) => item.reason === "stale-provenance").length ?? 0;
            if (parsed.abstention?.active) {
              stats.abstentions++;
              stats.abstainedRecords += parsed.abstention.withheld ?? 0;
            }
          } catch { /* a non-context Hunch result need not be JSON */ }
        }
      }
      return stats;
    }
  } catch { /* transcript unavailable */ }
  return stats;
}

function memoryDecisionCommits(): string[] {
  if (!ARMS.includes("C")) return [];
  const database = join(MEMORY_SOURCE, ".hunch", "hunch.sqlite");
  const output = execFileSync("sqlite3", ["-cmd", ".timeout 30000", database, `select distinct "commit" from decisions where "commit" is not null and "commit" != '';`], {
    encoding: "utf8",
  });
  return output.split("\n").map((value) => value.trim()).filter(Boolean);
}

function assertMemoryProvenance(attempt: AttemptDirs, commits: string[]): void {
  const missing = commits.filter((commit) => !gitObjectExists(attempt.agent, commit)
    || spawnSync("git", ["merge-base", "--is-ancestor", commit, "HEAD"], { cwd: attempt.agent }).status !== 0);
  if (missing.length) {
    throw new Error(`treatment checkout rejects ${missing.length}/${commits.length} memory provenance commits; first missing: ${missing[0]}`);
  }
}

// ------------------------------------------------------------------- main
if (DRY_FIX) {
  const task = TASKS[0];
  if (!task) throw new Error(`--dry-fix: unknown task "${DRY_FIX}"`);
  const attempt = makeAttempt(`dry-${task.id}`, "A", task);
  copyFromTrustedRevision(task.fixSha, task.testFiles, attempt.scorer);
  const before = runTests(task, attempt.scorer);
  console.log(`${task.id}: applied regression tests ${before.pass ? "PASS pre-fix (BAD — no bite)" : "FAIL pre-fix (good)"}`);
  // sanity: the real fix makes them pass
  copyFromTrustedRevision(task.fixSha, task.srcFiles, attempt.scorer);
  const after = runTests(task, attempt.scorer);
  console.log(`${task.id}: real fix applied → tests ${after.pass ? "PASS (good — ground truth verified)" : "STILL FAIL (bad task, drop it)"}`);
  if (!before.pass && before.output) console.log(`pre-fix test tail:\n${before.output.slice(-2_000)}`);
  if (!after.pass && after.output) console.log(`post-fix test tail:\n${after.output.slice(-2_000)}`);
  dropAttempt(attempt);
  process.exit(before.pass || !after.pass || before.infrastructureFailure || after.infrastructureFailure ? 1 : 0);
}

if (!existsSync(join(ZOD, ".git"))) throw new Error(`--zod must name a Git checkout: ${ZOD}`);
if (!existsSync(join(HUNCH_REPO, "dist", "cli", "index.js"))) throw new Error(`Hunch is not built at ${HUNCH_REPO}; run npm run build first`);
if (ARMS.includes("C") && !existsSync(join(MEMORY_SOURCE, ".hunch"))) {
  throw new Error(`arm C needs a pre-cutoff .hunch graph; pass --memory <checkout>: ${MEMORY_SOURCE}`);
}
const provenanceCommits = memoryDecisionCommits();
let memoryProvenanceVerified = !ARMS.includes("C");

console.log(`zod bench: model=${MODEL} arms=${ARMS.join(",")} repeats=${REPEATS} tasks=${TASKS.map((t) => t.id).join(",")}`);
console.log(`zod checkout: ${ZOD}`);
console.log(`hunch checkout: ${HUNCH_REPO}`);
if (ARMS.includes("C")) console.log(`memory snapshot: ${MEMORY_SOURCE}`);
mkdirSync(OUT_DIR, { recursive: true });
const stamp = `${new Date().toISOString().replace(/[:.]/g, "-")}-p${process.pid}`;
const rows: Array<Record<string, unknown>> = [];

for (const [taskIndex, task] of TASKS.entries()) {
  for (let repeat = 0; repeat < REPEATS; repeat++) {
    // Alternate treatment order to avoid making every C run systematically
    // later than its control. With repeats, each task sees both orders.
    const armOrder = (taskIndex + repeat) % 2 === 0 ? ARMS : [...ARMS].reverse();
    for (const arm of armOrder) {
      const assignment = `${task.id}:${repeat + 1}:${arm}`;
      if (ASSIGNMENTS.size && !ASSIGNMENTS.has(assignment)) continue;
      const name = `${task.id}-r${repeat + 1}-${arm}-${MODEL.replace(/[^a-z0-9]/gi, "")}`;
      process.stdout.write(`▶ ${name} … `);
      const attempt = makeAttempt(name, arm, task);
      const dir = attempt.agent;
      try {
        if (arm === "C" && !memoryProvenanceVerified) {
          assertMemoryProvenance(attempt, provenanceCommits);
          memoryProvenanceVerified = true;
          console.log(`\n  ↳ provenance: ${provenanceCommits.length}/${provenanceCommits.length} memory commits reachable`);
          process.stdout.write(`  ↳ ${name} … `);
        }
        const testBaseline = snapshotFiles(task.testFiles, dir);
        const workspaceBaseline = new Set(changedFiles(dir));
        const run = runClaude(dir, prompt(task, arm));
        const agentChangedFiles = changedFiles(dir).filter((file) => !workspaceBaseline.has(file));
        const s = scoreFix(task, attempt, testBaseline, agentChangedFiles);
        const hunch = hunchStats(run.sessionId);
        const infrastructureFailure = isInfrastructureFailure(run) || s.testInfrastructureFailure;
        rows.push({
          task: task.id, repeat: repeat + 1, arm, armOrder: armOrder.join(","), model: MODEL,
          fixSha: task.fixSha, preFixSha: attempt.preFixSha, mergedAt: task.mergedAt,
          score: s.pass ? "PASS" : `FAIL(tests=${s.testsPass},untouched=${s.testUntouched})`,
          scoreNum: s.pass ? 1 : 0, sourceAccuracyNum: s.testsPass ? 1 : 0,
          testsPass: s.testsPass, testUntouched: s.testUntouched,
          testInfrastructureFailure: s.testInfrastructureFailure,
          testOutput: s.testOutput, scoredSourceFiles: s.scoredSourceFiles,
          turns: run.numTurns, hunchCalls: hunch.calls, hunchContextCalls: hunch.contextCalls,
          hunchDelivered: hunch.delivered, hunchSupplements: hunch.supplements,
          hunchSupplementsDelivered: hunch.deliveredSupplements,
          hunchStaleOmitted: hunch.staleOmitted,
          hunchAbstentions: hunch.abstentions,
          hunchAbstainedRecords: hunch.abstainedRecords,
          durationMs: run.durationMs,
          valid: !infrastructureFailure, infrastructureFailure,
          sessionId: run.sessionId, agentChangedFiles, answer: run.result.slice(0, 3000),
        });
        console.log(`${infrastructureFailure ? "INFRA" : s.pass ? "PASS" : "FAIL"}  ${run.numTurns} turns, ${hunch.calls} hunch calls, ${hunch.delivered} decisions, ${hunch.abstentions} abstention(s), ${(run.durationMs / 1000).toFixed(0)}s`);
      } finally { dropAttempt(attempt); }
      writeFileSync(join(OUT_DIR, `${stamp}.json`), JSON.stringify({
        model: MODEL,
        zodRepo: ZOD,
        zodHead: sh("git rev-parse HEAD"),
        hunchRepo: HUNCH_REPO,
        hunchHead: sh("git rev-parse HEAD", HUNCH_REPO),
        memorySource: ARMS.includes("C") ? MEMORY_SOURCE : null,
        memoryHead: ARMS.includes("C") ? sh("git rev-parse HEAD", MEMORY_SOURCE) : null,
        memoryCutoff: ARMS.includes("C") ? SUITE.cutoff : null,
        memoryCodeHead: ARMS.includes("C")
          ? sh(`git rev-list -1 --before="${SUITE.cutoff}T23:59:59Z" HEAD`, MEMORY_SOURCE)
          : null,
        noRepro: NO_REPRO,
        forceHunch: FORCE_HUNCH,
        isolatedSnapshot: false,
        futureFreeHistory: true,
        historyThroughPreFixOnly: true,
        memoryProvenanceVerified,
        memoryProvenanceCommits: provenanceCommits.length,
        isolatedScoring: true,
        networkPolicy: "deny-all",
        webToolsDenied: true,
        repeats: REPEATS,
        rows,
      }, null, 2));
    }
  }
}

console.log(`\n| task | ${ARMS.map((a) => `${a}`).join(" | ")} |`);
console.log(`|---${ARMS.map(() => "|---").join("")}|`);
for (const task of TASKS) {
  const cells = ARMS.map((arm) => {
    const armRows = rows.filter((x) => x.task === task.id && x.arm === arm);
    return armRows.length
      ? `${armRows.reduce((sum, row) => sum + Number(row.scoreNum), 0)}/${armRows.length}`
      : "-";
  });
  console.log(`| ${task.id} | ${cells.join(" | ")} |`);
}
console.log(`\nresults: bench/external/results/${stamp}.json`);
