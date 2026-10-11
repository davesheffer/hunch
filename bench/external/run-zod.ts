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
 *   arm E — same snapshot + one bounded, pre-cutoff proven-work episode in the prompt
 *   arm X — arm E + observable execution obligations enforced by the shipped pipeline
 *   arm Q — arm X + one issue-derived executable red→green falsification probe
 *   arm R — arm E + the probe + one compact adjacent-regression obligation
 *   arm U — arm E + one contrastive red→green probe with negative controls
 *   arm T — arm U + a pre-edit two-hypothesis discriminator tournament
 *   arm W — arm U + independently red→green probes for uncovered axes
 *   arm Y — staged W: one contrast first, then consumer axes only once green
 *   arm Z — arm Y + consumer claims/falsifiers disclosed before editing
 *   arm H — arm Y + one bounded ownership-risk hint and scope budget
 *   arm I — arm H with the single owner inferred from pre-edit source text
 *
 * Score: for U/T/W/Y/Z/H/I, sealed issue-contract tests pass and the agent didn't touch
 * tests or probes. The fix's own test files remain a secondary exact-PR score.
 *
 *   npx tsx bench/external/run-zod.ts --dry-fix zod-5868     # plumbing, no model
 *   npx tsx bench/external/run-zod.ts --arms A,C --model claude-sonnet-5 \
 *     --memory /path/to/pre-cutoff/zod
 */
import { execFileSync, execSync, spawnSync } from "node:child_process";
import { mkdirSync, rmSync, writeFileSync, readFileSync, existsSync, readdirSync, cpSync } from "node:fs";
import { homedir, tmpdir } from "node:os";
import { dirname, join, resolve, sep } from "node:path";
import { benchmarkIntegrityPass, snapshotFiles, snapshotsEqual, type FileSnapshot } from "./file-integrity.js";
import {
  auditExecutableProbeContractAxes,
  compileAdaptiveContractAxisProbeClosure,
  compileContractAxisProbeClosure,
  compileContractAxisRiskHint,
  inferContractAxisRiskHint,
  rankContractAxisRiskOwners,
  loadPipelineState,
  pendingExecutionObligations,
  type ExecutableProbe,
  type ExecutionObligation,
  type ContractAxisOwnerInference,
  type ContractAxisRiskHint,
} from "../../src/core/pipeline.js";

const OUT_DIR = join(import.meta.dirname, "results");
const ISSUE_CONTRACT_DIR = join(import.meta.dirname, "contracts");

const argv = process.argv.slice(2);
const flag = (name: string, dflt: string): string => {
  const i = argv.indexOf(`--${name}`);
  return i >= 0 && argv[i + 1] ? argv[i + 1]! : dflt;
};
const ZOD = resolve(flag("zod", process.env.HUNCH_ZOD_BENCH_REPO ?? "../zod-bench"));
const HUNCH_REPO = resolve(flag("hunch", process.env.HUNCH_BENCH_REPO ?? process.cwd()));
const MEMORY_SOURCE = resolve(flag("memory", process.env.HUNCH_ZOD_MEMORY_REPO ?? ZOD));
const MODEL = flag("model", "claude-sonnet-5");
type Arm = "A" | "C" | "P" | "E" | "X" | "Q" | "R" | "U" | "T" | "W" | "Y" | "Z" | "H" | "I";
// A = bare, C = +cold hunch graph,
// P = shipped pipeline, E = bounded execution episode (no graph),
// X = episode + obligation controller, Q = X + executable falsification probe,
// R = episode + probe + exactly one compact adjacent-regression obligation,
// U = episode + contrastive probe, T = U + hypothesis tournament,
// W = U + independently falsifiable probes for uncovered contract axes.
// Y = one adaptive probe that defers those axes until the main contrast is green.
// Z = Y + non-executable consumer claims/falsifiers disclosed before editing.
// H = Y + one qualified consumer owner, without its command or contract prose.
// I = H with that owner inferred deterministically from pre-edit source.
const EPISODE_ARMS = new Set<Arm>(["E", "X", "Q", "R", "U", "T", "W", "Y", "Z", "H", "I"]);
const PIPELINE_ARMS = new Set<Arm>(["P", "X", "Q", "R", "U", "T", "W", "Y", "Z", "H", "I"]);
const CONTROLLER_ARMS = new Set<Arm>(["X", "Q", "R", "U", "T", "W", "Y", "Z", "H", "I"]);
const CONTRAST_ARMS = new Set<Arm>(["U", "T", "W", "Y", "Z", "H", "I"]);
const ADAPTIVE_ARMS = new Set<Arm>(["Y", "Z", "H", "I"]);
const ARMS = flag("arms", "A,C").split(",") as Arm[];
// --no-repro: the agent gets ONLY the issue text — no failing test handed over.
// The real regression tests are applied at SCORING time. This is diagnosis mode.
const NO_REPRO = argv.includes("--no-repro");
// --force-hunch: C arm must consult the frozen graph before investigating.
// This separates memory quality from ambient-instruction/tool-uptake quality.
const FORCE_HUNCH = argv.includes("--force-hunch");
const MAX_TURNS = Number(flag("max-turns", "50"));
const REPEATS = Number(flag("repeats", "1"));
const DRY_FIX = flag("dry-fix", "");
const DRY_PROBE = flag("dry-probe", "");
const DRY_CONTRACT = flag("dry-contract", "");
const DRY_OWNER = flag("dry-owner", "");
const ONLY = flag("only", "");
const RUN_ALL = argv.includes("--all");
const ASSIGNMENTS = new Set(flag("assignments", "").split(",").filter(Boolean));
const EPISODES_PATH = resolve(flag("episodes", join(import.meta.dirname, "zod-execution-episodes.json")));

// Bug-shaped subset (features/locales excluded); diverse areas of the library.
const DEFAULT_TASKS = ["zod-5842", "zod-5944", "zod-5937", "zod-5826", "zod-5868", "zod-5792", "zod-5296", "zod-5714"];

interface Task {
  id: string; pr: number; fixSha: string; mergedAt: string;
  issueTitle: string; issueBody: string; testFiles: string[]; srcFiles: string[];
}
interface Suite { cutoff: string; tasks: Task[] }
interface HypothesisTournament {
  decision_path: string;
  artifact: { path: string; content: string };
  obligation: ExecutionObligation;
}
interface ExecutionEpisode {
  id: string;
  commits: string[];
  text: string;
  obligations?: ExecutionObligation[];
  probes?: ExecutableProbe[];
  compact_regression?: ExecutionObligation;
  contrastive_probe?: ExecutableProbe;
  contract_axis_probes?: ExecutableProbe[];
  contract_axis_risk_hint?: { probe_id: string; owner: string };
  tournament?: HypothesisTournament;
  /** False when the authentic fix intentionally changes a pre-fix test expectation. */
  pre_fix_validation_compatible?: boolean;
}
interface ExecutionEpisodeSuite {
  cutoff: string;
  mode?: "fixed" | "task-relative";
  episodes: Record<string, ExecutionEpisode>;
}
const SUITE = JSON.parse(readFileSync(join(import.meta.dirname, "zod-tasks.json"), "utf8")) as Suite;
const EPISODES = ARMS.some((arm) => EPISODE_ARMS.has(arm)) || Boolean(DRY_OWNER)
  ? JSON.parse(readFileSync(EPISODES_PATH, "utf8")) as ExecutionEpisodeSuite
  : { cutoff: SUITE.cutoff, episodes: {} };
const ALL = SUITE.tasks;
const selectedIds = new Set((ONLY || DRY_FIX || DRY_PROBE || DRY_CONTRACT || DRY_OWNER).split(",").filter(Boolean));
const TASKS = ALL.filter((t) => selectedIds.size ? selectedIds.has(t.id) : RUN_ALL || DEFAULT_TASKS.includes(t.id));

if (!Number.isSafeInteger(REPEATS) || REPEATS < 1) throw new Error(`--repeats must be a positive integer, got ${REPEATS}`);
if (selectedIds.size && TASKS.length !== selectedIds.size) {
  const found = new Set(TASKS.map((task) => task.id));
  throw new Error(`unknown task(s): ${[...selectedIds].filter((id) => !found.has(id)).join(", ")}`);
}
for (const assignment of ASSIGNMENTS) {
  if (!/^[^:]+:\d+:[ACSPEXQRUTWYZHI]$/.test(assignment)) throw new Error(`invalid --assignments entry: ${assignment}`);
}
if (ARMS.some((arm) => EPISODE_ARMS.has(arm)) && (EPISODES.mode ?? "fixed") === "fixed" && EPISODES.cutoff !== SUITE.cutoff) {
  throw new Error(`episode cutoff ${EPISODES.cutoff} does not match benchmark cutoff ${SUITE.cutoff}`);
}
for (const task of TASKS) {
  if (ARMS.some((arm) => EPISODE_ARMS.has(arm)) && !EPISODES.episodes[task.id]) throw new Error(`episode arm has no execution episode for ${task.id}`);
  if (ARMS.includes("X") && !EPISODES.episodes[task.id]?.obligations?.length) throw new Error(`arm X has no execution obligations for ${task.id}`);
  if (ARMS.includes("Q") && !EPISODES.episodes[task.id]?.obligations?.length) throw new Error(`arm Q has no execution obligations for ${task.id}`);
  if (ARMS.includes("Q") && !EPISODES.episodes[task.id]?.probes?.length) throw new Error(`arm Q has no executable probe for ${task.id}`);
  if (ARMS.includes("R") && !EPISODES.episodes[task.id]?.probes?.length) throw new Error(`arm R has no executable probe for ${task.id}`);
  if (ARMS.includes("R") && !EPISODES.episodes[task.id]?.compact_regression) throw new Error(`arm R has no compact regression for ${task.id}`);
  if (ARMS.some((arm) => CONTRAST_ARMS.has(arm)) && !EPISODES.episodes[task.id]?.contrastive_probe) throw new Error(`contrastive arm has no probe for ${task.id}`);
  if (ARMS.includes("T") && !EPISODES.episodes[task.id]?.tournament) throw new Error(`arm T has no hypothesis tournament for ${task.id}`);
  if ((ARMS.includes("W") || ARMS.some((arm) => ADAPTIVE_ARMS.has(arm))) && !EPISODES.episodes[task.id]?.contract_axis_probes?.length) throw new Error(`axis-closure arm has no contrast-qualified probes for ${task.id}`);
  if (ARMS.some((arm) => ADAPTIVE_ARMS.has(arm))) {
    const episode = EPISODES.episodes[task.id]!;
    const adaptive = compileAdaptiveContractAxisProbeClosure(
      episode.contrastive_probe,
      episode.obligations ?? [],
      episode.contract_axis_probes ?? [],
    );
    if (!adaptive.probe) throw new Error(`adaptive arm cannot compile a closure for ${task.id}`);
  }
  if (ARMS.includes("H")) {
    const episode = EPISODES.episodes[task.id]!;
    const closure = compileContractAxisProbeClosure(
      episode.contrastive_probe,
      episode.obligations ?? [],
      episode.contract_axis_probes ?? [],
    );
    if (!compileContractAxisRiskHint(closure, episode.contract_axis_risk_hint)) {
      throw new Error(`arm H has no qualified bounded ownership hint for ${task.id}`);
    }
  }
  if (NO_REPRO && ARMS.some((arm) => arm === "X" || arm === "Q" || arm === "R")
    && EPISODES.episodes[task.id]?.pre_fix_validation_compatible === false) {
    throw new Error(`issue-only controller invalid for ${task.id}: the authentic fix intentionally changes a prescribed pre-fix validation expectation`);
  }
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

function makeAttempt(name: string, arm: Arm, task: Task): AttemptDirs {
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
  if (PIPELINE_ARMS.has(arm)) {
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

function runTests(task: Task, dir: string, typecheck = false): TestRun {
  // repo-relative paths from the worktree ROOT: zod's vitest workspace globs
  // ("packages/*") resolve against cwd, so a package-dir run finds no projects
  const result = spawnSync("npx", ["vitest", ...(typecheck ? ["--typecheck"] : []), "run", ...task.testFiles], {
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

function materializeProbeArtifacts(dir: string, probes: ExecutableProbe[]): string[] {
  const paths: string[] = [];
  for (const probe of probes) {
    if (!probe.artifact) continue;
    const target = resolve(dir, probe.artifact.path);
    if (!target.startsWith(`${resolve(dir)}${sep}`)) throw new Error(`probe artifact escapes checkout: ${probe.artifact.path}`);
    mkdirSync(dirname(target), { recursive: true });
    writeFileSync(target, probe.artifact.content);
    paths.push(probe.artifact.path);
  }
  return paths;
}

function materializeTournamentArtifact(dir: string, tournament?: HypothesisTournament): string[] {
  if (!tournament) return [];
  if (!/^\.hunch-probes\/[A-Za-z0-9._/-]+$/.test(tournament.artifact.path)) {
    throw new Error(`invalid tournament artifact path: ${tournament.artifact.path}`);
  }
  const target = resolve(dir, tournament.artifact.path);
  if (!target.startsWith(`${resolve(dir)}${sep}`)) throw new Error(`tournament artifact escapes checkout: ${tournament.artifact.path}`);
  mkdirSync(dirname(target), { recursive: true });
  writeFileSync(target, tournament.artifact.content);
  return [tournament.artifact.path];
}

function readTournamentDecision(dir: string, tournament?: HypothesisTournament): unknown {
  if (!tournament || !/^\.hunch\/[A-Za-z0-9._/-]+\.json$/.test(tournament.decision_path)) return null;
  const target = resolve(dir, tournament.decision_path);
  if (!target.startsWith(`${resolve(dir)}${sep}`) || !existsSync(target)) return null;
  try {
    const raw = readFileSync(target, "utf8");
    if (raw.length > 12_000) return { invalid: "decision artifact exceeded 12 KB" };
    return JSON.parse(raw) as unknown;
  } catch {
    return { invalid: "decision artifact was not valid JSON" };
  }
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
  issueContractPass: boolean | null;
  issueContractInfrastructureFailure: boolean;
  issueContractOutput: string | null;
}

function runIssueContract(task: Task, dir: string): TestRun | null {
  const source = join(ISSUE_CONTRACT_DIR, `${task.id}.issue-contract.test.ts`);
  if (!existsSync(source)) return null;
  const typecheck = readFileSync(source, "utf8").includes("HUNCH_ISSUE_CONTRACT_TYPECHECK");
  const relative = `packages/zod/src/v4/classic/tests/hunch-${task.id}-issue-contract.test.ts`;
  const target = join(dir, relative);
  cpSync(source, target);
  try {
    return runTests({ ...task, testFiles: [relative] }, dir, typecheck);
  } finally {
    rmSync(target, { force: true });
  }
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
  // Independently authored, issue-derived contracts run before the upstream
  // merged-PR tests are installed, so unrelated changes bundled into that PR
  // cannot contaminate the behavioral accuracy score.
  const issueContract = runIssueContract(task, attempt.scorer);
  // Ground-truth tests are installed only in the scorer, after the agent exits.
  copyFromTrustedRevision(task.fixSha, task.testFiles, attempt.scorer);
  const test = runTests(task, attempt.scorer);
  return {
    pass: test.pass && (NO_REPRO || testUntouched),
    testsPass: test.pass,
    testUntouched,
    testInfrastructureFailure: test.infrastructureFailure || Boolean(issueContract?.infrastructureFailure),
    testOutput: test.output,
    scoredSourceFiles,
    issueContractPass: issueContract?.pass ?? null,
    issueContractInfrastructureFailure: issueContract?.infrastructureFailure ?? false,
    issueContractOutput: issueContract?.output ?? null,
  };
}

function prompt(task: Task, arm: Arm, inferredRiskHint: ContractAxisRiskHint | null = null): string {
  const episode = EPISODES.episodes[task.id];
  const axisClosure = episode?.contrastive_probe
    ? compileContractAxisProbeClosure(episode.contrastive_probe, episode.obligations ?? [], episode.contract_axis_probes ?? [])
    : null;
  const adaptiveClosure = episode?.contrastive_probe
    ? compileAdaptiveContractAxisProbeClosure(episode.contrastive_probe, episode.obligations ?? [], episode.contract_axis_probes ?? [])
    : null;
  const riskHint = arm === "I"
    ? inferredRiskHint
    : axisClosure && episode
      ? compileContractAxisRiskHint(axisClosure, episode.contract_axis_risk_hint)
      : null;
  const repro = NO_REPRO
    ? `No reproduction is provided — diagnose from the report alone. Write your own repro if it helps (grading runs the project's own test suite afterwards).`
    : `Failing regression tests already exist — reproduce from the repo root with:  npx vitest run ${task.testFiles.join(" ")}`;
  return [
    ...(FORCE_HUNCH && arm === "C" ? [`First call hunch_context for this bug and use the relevant engineering memory while diagnosing it.`, ``] : []),
    ...(EPISODE_ARMS.has(arm) ? [
      `Use the following proven-work episode as bounded historical evidence. It predates this task and is not the answer. First check its applicability against the current code and tests; preserve its stated invariants and reject it where the current evidence differs.`,
      ``,
      `## Proven work episode: ${EPISODES.episodes[task.id]!.id}`,
      ``,
      EPISODES.episodes[task.id]!.text,
      ``,
      `## Current task`,
      ``,
    ] : []),
    ...(arm === "X" || arm === "Q" ? [
      `The Hunch Execution Controller is armed for this episode. Its observable obligations are injected at session start and checked again when you try to finish. After-edit proofs reset after every later product edit. A matching command is not proof by itself: the hook must observe the expected successful result and any required output markers after your final edit.`,
      ``,
    ] : []),
    ...(arm === "Q" ? [
      `Hunch has also compiled the public issue reproduction into one executable falsification probe. Run its exact baseline command before editing and preserve the observed red result. After the final source edit, run the same command again and make it green. Treat the probe as one narrow invariant, not as permission to skip the broader controller obligations.`,
      ``,
    ] : []),
    ...(arm === "R" ? [
      `Hunch Q-lite is armed with exactly three receipts: reproduce the issue with the exact probe before editing, turn that same probe green after the final source edit, then run one compact adjacent-regression command. It intentionally omits the broader controller checklist and repeated proof dimensions.`,
      `Run the regression command exactly after the final edit: ${episodeCompactRegressionCommand(EPISODES.episodes[task.id]!)}`,
      `A narrow green probe is not sufficient if this neighboring regression contract fails.`,
      ``,
    ] : []),
    ...(CONTRAST_ARMS.has(arm) && !ADAPTIVE_ARMS.has(arm) ? [
      `Hunch has compiled the issue and its stated boundaries into one contrastive probe. Run this exact command before editing and preserve the red result: ${EPISODES.episodes[task.id]!.contrastive_probe!.command}`,
      `After the final source edit, run the same command and make it green. Green requires both the target behavior and the negative controls; a patch that fixes the example by globally weakening an adjacent abstraction must stay red.`,
      ``,
    ] : []),
    ...(arm === "W" && axisClosure ? [
      `Hunch audited that contrast against the episode's promised consumer contracts. Covered axes: ${axisClosure.covered.join(", ") || "none"}. The following uncovered axes have independently qualified red-before/green-after probes: ${axisClosure.probes.map((probe) => probe.category).join(", ") || "none"}.`,
      ...axisClosure.probes.map((probe) => `Run [${probe.category}] before any product edit and preserve its red result, then rerun it after the final edit and make it green: ${probe.command}`),
      `All axis probes and the main contrast must be green together. A neighboring test that was already green is not evidence for an uncovered axis.`,
      ``,
    ] : []),
    ...(arm === "Z" && adaptiveClosure?.probe ? [
      `Before editing, design against these qualified missing consumer contracts. Their executable commands remain staged and will not run until the main behavior is green:`,
      ...adaptiveClosure.disclosures.map((disclosure) => `[${disclosure.category}] Claim: ${disclosure.claim} Falsifier: ${disclosure.falsifier}`),
      ``,
    ] : []),
    ...((arm === "H" || arm === "I") && riskHint ? [
      `Hunch flags one planning risk: the highest-risk deferred consumer is [${riskHint.category}], and its likely existing source owner is ${riskHint.owner}.`,
      `This is a scope boundary, not an instruction to implement that consumer now. Make the smallest main fix and leave design room for this owner. Do not create new abstractions, add tests, or edit extra product surfaces preemptively; touch the named owner only when the main fix itself requires it or the staged probe later names that axis red.`,
      `Reserve the adaptive command as the final action after your last product edit. Any later product or test edit invalidates that receipt and requires the same command again.`,
      ``,
    ] : []),
    ...(ADAPTIVE_ARMS.has(arm) && adaptiveClosure?.probe ? [
      `Hunch has staged the contrast and its missing consumer contracts into one adaptive probe. Run this exact command before editing and preserve the red main result: ${adaptiveClosure.probe.command}`,
      `While the main behavior is red, the probe deliberately reports axes=skipped. After the final source edit, run the same command again. Only after the main behavior is green will it execute the independently qualified ${adaptiveClosure.probes.map((probe) => probe.category).join(", ")} consumer checks.`,
      `Finish only when the adaptive probe reports state=green stage=closed failed=none. If it reports stage=axes, fix only the named red consumer and rerun the same command.`,
      ``,
    ] : []),
    ...(arm === "T" ? [
      `Before any product edit, run a two-hypothesis tournament followed by a contract-closure audit. Investigate and write ${EPISODES.episodes[task.id]!.tournament!.decision_path} as JSON with this shape:`,
      `{"candidates":[{"id":"A","mechanism":"causal mechanism","surfaces":["source surface"],"falsifier":"what would disprove it"},{"id":"B","mechanism":"materially different ownership claim","surfaces":["different source surface"],"falsifier":"what would disprove it"}],"chosen":"A or B","discriminator":{"command":"command actually run","result":"observed result","why_it_separates":"why this evidence favors one candidate"},"evidence":"code/test evidence for the choice","rejected_reason":"why the losing candidate should not own the fix","contract_audit":{"analogue":{"surface":"nearest existing specialized analogue","similarity":"relevant shared convention","difference":"boundary that must remain different"},"contracts":[{"kind":"runtime","surface":"affected runtime surface","invariant":"required invariant","check":"planned check"},{"kind":"static","surface":"affected type surface","invariant":"required invariant","check":"planned check"},{"kind":"public-api","surface":"affected identity/export surface","invariant":"required invariant or evidence it is not applicable","check":"planned check"},{"kind":"downstream","surface":"affected consumer/serialization surface","invariant":"required invariant or evidence it is not applicable","check":"planned check"}],"nonlocal_risk":"most likely behavior outside the direct reproduction to regress"}}`,
      `The candidates must make materially different ownership claims and name different source surfaces. Run the discriminator command you record. If the chosen fix gives one composition a contract different from its generic abstraction, inspect the nearest existing specialized analogue and decide from repository evidence whether that difference is represented by a subtype, constructor, export, trait, or only local metadata. The four audit entries must be concrete; use evidence-backed not-applicable entries rather than silently omitting a contract domain. Then validate the decision exactly with: ${episodeTournamentCommand(EPISODES.episodes[task.id]!)}`,
      `Do not edit product source until both the contrastive red baseline and tournament receipt are satisfied.`,
      ``,
    ] : []),
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

function episodeCompactRegressionCommand(episode: ExecutionEpisode): string {
  return episode.compact_regression?.command_alternatives[0]?.join(" ") ?? "";
}

function episodeTournamentCommand(episode: ExecutionEpisode): string {
  return episode.tournament?.obligation.command_alternatives[0]?.join(" ") ?? "";
}

function runClaude(dir: string, p: string, arm: Arm, episode?: ExecutionEpisode): { result: string; numTurns: number; sessionId: string | null; durationMs: number } {
  const t0 = Date.now();
  const axisClosure = episode?.contrastive_probe
    ? compileContractAxisProbeClosure(episode.contrastive_probe, episode.obligations ?? [], episode.contract_axis_probes ?? [])
    : null;
  const adaptiveClosure = episode?.contrastive_probe
    ? compileAdaptiveContractAxisProbeClosure(episode.contrastive_probe, episode.obligations ?? [], episode.contract_axis_probes ?? [])
    : null;
  const mcp = existsSync(join(dir, ".mcp.json")) ? ` --mcp-config .mcp.json` : "";
  const cmd = `claude -p --model ${MODEL} --output-format json --permission-mode bypassPermissions --max-turns ${MAX_TURNS} --setting-sources project --settings .claude/benchmark-sealed-settings.json --disallowedTools WebFetch WebSearch${mcp} --strict-mcp-config`;
  let out = "";
  try {
    out = execSync(cmd, {
      cwd: dir,
      input: p,
      encoding: "utf8",
      env: {
        ...process.env,
        NPM_CONFIG_OFFLINE: "true",
        COREPACK_ENABLE_NETWORK: "0",
        ...(arm === "X" || arm === "Q" ? { HUNCH_EXECUTION_OBLIGATIONS: JSON.stringify(episode?.obligations ?? []) } : {}),
        ...(arm === "R" ? { HUNCH_EXECUTION_OBLIGATIONS: JSON.stringify(episode?.compact_regression ? [episode.compact_regression] : []) } : {}),
        ...(arm === "T" ? { HUNCH_EXECUTION_OBLIGATIONS: JSON.stringify(episode?.tournament ? [episode.tournament.obligation] : []) } : {}),
        ...(arm === "Q" || arm === "R" ? { HUNCH_EXECUTABLE_PROBES: JSON.stringify(episode?.probes ?? []) } : {}),
        ...(CONTRAST_ARMS.has(arm) ? {
          HUNCH_EXECUTABLE_PROBES: JSON.stringify([
            ...(ADAPTIVE_ARMS.has(arm) ? (adaptiveClosure?.probe ? [adaptiveClosure.probe] : []) : episode?.contrastive_probe ? [episode.contrastive_probe] : []),
            ...(arm === "W" ? axisClosure?.probes ?? [] : []),
          ]),
        } : {}),
      },
      maxBuffer: 64 * 1024 * 1024,
      timeout: 45 * 60 * 1000,
    });
  } catch (e) { out = String((e as { stdout?: string }).stdout ?? ""); }
  let parsed: { result?: string; session_id?: string; num_turns?: number } = {};
  try { parsed = JSON.parse(out); } catch { parsed = { result: out }; }
  return { result: parsed.result ?? "", numTurns: parsed.num_turns ?? -1, sessionId: parsed.session_id ?? null, durationMs: Date.now() - t0 };
}

function isInfrastructureFailure(run: { result: string }): boolean {
  return /^(?:API Error:|Not logged in\b|Authentication failed\b|You've hit your limit\b|Claude usage limit\b)/i.test(run.result.trim());
}

interface HunchStats {
  calls: number;
  contextCalls: number;
  delivered: number;
  hypotheses: number;
  supplements: number;
  deliveredSupplements: number;
  staleOmitted: number;
  actionabilityOmitted: number;
  abstentions: number;
  abstainedRecords: number;
}

function hunchStats(sessionId: string | null): HunchStats {
  const stats: HunchStats = {
    calls: 0,
    contextCalls: 0,
    delivered: 0,
    hypotheses: 0,
    supplements: 0,
    deliveredSupplements: 0,
    staleOmitted: 0,
    actionabilityOmitted: 0,
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
              hypotheses?: unknown[];
              supplements?: Array<{ delivered?: boolean }>;
              omitted?: Array<{ reason?: string }>;
              abstention?: { active?: boolean; withheld?: number };
            };
            stats.delivered += parsed.delivered?.length ?? 0;
            stats.hypotheses += parsed.hypotheses?.length ?? 0;
            stats.supplements += parsed.supplements?.length ?? 0;
            stats.deliveredSupplements += parsed.supplements?.filter((item) => item.delivered).length ?? 0;
            stats.staleOmitted += parsed.omitted?.filter((item) => item.reason === "stale-provenance").length ?? 0;
            stats.actionabilityOmitted += parsed.omitted?.filter((item) => item.reason === "actionability-cap").length ?? 0;
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

function assertEpisodeProvenance(attempt: AttemptDirs, episode: ExecutionEpisode): void {
  const missing = episode.commits.filter((commit) => !/^[0-9a-f]{7,64}$/i.test(commit)
    || !gitObjectExists(attempt.agent, commit)
    || spawnSync("git", ["merge-base", "--is-ancestor", commit, "HEAD"], { cwd: attempt.agent }).status !== 0);
  if (missing.length) {
    throw new Error(`execution episode ${episode.id} has unreachable provenance commit(s): ${missing.join(", ")}`);
  }
  const tooNew = (EPISODES.mode ?? "fixed") === "task-relative" ? [] : episode.commits.filter((commit) => {
    const timestamp = execFileSync("git", ["show", "-s", "--format=%cI", commit], {
      cwd: attempt.agent,
      encoding: "utf8",
    }).trim();
    return !timestamp || Date.parse(timestamp) > Date.parse(`${EPISODES.cutoff}T23:59:59Z`);
  });
  if (tooNew.length) throw new Error(`execution episode ${episode.id} crosses the cutoff: ${tooNew.join(", ")}`);
}

function runTrustedProbe(dir: string, probe: ExecutableProbe): { success: boolean; output: string } {
  const result = spawnSync(probe.command, {
    cwd: dir,
    shell: true,
    encoding: "utf8",
    env: { ...process.env, NPM_CONFIG_OFFLINE: "true", COREPACK_ENABLE_NETWORK: "0" },
    maxBuffer: 16 * 1024 * 1024,
    timeout: 5 * 60 * 1000,
  });
  return { success: result.status === 0, output: `${result.stdout ?? ""}${result.stderr ?? ""}`.trim() };
}

function trustedProbeExpectation(
  observed: { success: boolean; output: string },
  expected: ExecutableProbe["expected_before"],
): boolean {
  const output = observed.output.toLowerCase();
  return observed.success === expected.success
    && (expected.output_includes ?? []).every((marker) => output.includes(marker.toLowerCase()))
    && (expected.output_excludes ?? []).every((marker) => !output.includes(marker.toLowerCase()));
}

function trustedRiskHintOwnerExists(dir: string, hint: { owner: string }): boolean {
  const [path, symbol] = hint.owner.split("::");
  if (!path) return false;
  const target = resolve(dir, path);
  if (!target.startsWith(`${resolve(dir)}${sep}`) || !existsSync(target)) return false;
  return !symbol || readFileSync(target, "utf8").includes(symbol);
}

function preEditOwnerSources(dir: string): Array<{ path: string; content: string }> {
  const files = execFileSync("git", ["ls-files"], { cwd: dir, encoding: "utf8" })
    .split("\n")
    .map((path) => path.trim())
    .filter((path) => /\.[cm]?tsx?$/.test(path)
      && !/(?:^|\/)(?:tests?|__tests__)(?:\/|$)|\.test\.[cm]?tsx?$/.test(path));
  return files.slice(0, 4_000).flatMap((path) => {
    try {
      const content = readFileSync(join(dir, path), "utf8");
      return content.length <= 1_000_000 ? [{ path, content }] : [];
    } catch { return []; }
  });
}

function inferEpisodeRiskHint(dir: string, episode: ExecutionEpisode): ContractAxisOwnerInference | null {
  if (!episode.contrastive_probe) return null;
  const closure = compileContractAxisProbeClosure(
    episode.contrastive_probe,
    episode.obligations ?? [],
    episode.contract_axis_probes ?? [],
  );
  return inferContractAxisRiskHint(closure, preEditOwnerSources(dir));
}

// ------------------------------------------------------------------- main
if (DRY_OWNER) {
  const task = TASKS[0];
  if (!task) throw new Error(`--dry-owner: unknown task "${DRY_OWNER}"`);
  const episode = EPISODES.episodes[task.id];
  if (!episode?.contrastive_probe) throw new Error(`--dry-owner: no contrastive probe for ${task.id}`);
  const attempt = makeAttempt(`dry-owner-${task.id}`, "U", task);
  try {
    const closure = compileContractAxisProbeClosure(
      episode.contrastive_probe,
      episode.obligations ?? [],
      episode.contract_axis_probes ?? [],
    );
    const sources = preEditOwnerSources(attempt.agent);
    const ranking = rankContractAxisRiskOwners(closure, sources);
    const inference = inferContractAxisRiskHint(closure, sources);
    console.log(JSON.stringify({ task: task.id, inference, ranking }, null, 2));
    process.exitCode = inference && trustedRiskHintOwnerExists(attempt.agent, inference.hint) ? 0 : 1;
  } finally {
    dropAttempt(attempt);
  }
  process.exit();
}

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

if (DRY_PROBE) {
  const task = TASKS[0];
  if (!task) throw new Error(`--dry-probe: unknown task "${DRY_PROBE}"`);
  const episode = EPISODES.episodes[task.id];
  const probe = episode?.contrastive_probe;
  if (!probe) throw new Error(`--dry-probe: no contrastive probe for ${task.id}`);
  const axisClosure = compileContractAxisProbeClosure(probe, episode?.obligations ?? [], episode?.contract_axis_probes ?? []);
  const adaptiveClosure = compileAdaptiveContractAxisProbeClosure(probe, episode?.obligations ?? [], episode?.contract_axis_probes ?? []);
  const riskHint = compileContractAxisRiskHint(axisClosure, episode?.contract_axis_risk_hint);
  const probes = [
    probe,
    ...((ARMS.includes("W") || ARMS.some((arm) => ADAPTIVE_ARMS.has(arm))) ? axisClosure.probes : []),
    ...(ARMS.some((arm) => ADAPTIVE_ARMS.has(arm)) && adaptiveClosure.probe ? [adaptiveClosure.probe] : []),
  ];
  const attempt = makeAttempt(`dry-probe-${task.id}`, "U", task);
  try {
    materializeProbeArtifacts(attempt.agent, probes);
    const manualOwnerValid = ARMS.includes("H")
      ? Boolean(riskHint && trustedRiskHintOwnerExists(attempt.agent, riskHint))
      : null;
    const automaticInference = ARMS.includes("I") ? inferEpisodeRiskHint(attempt.agent, episode!) : null;
    const automaticOwnerValid = ARMS.includes("I")
      ? Boolean(automaticInference && trustedRiskHintOwnerExists(attempt.agent, automaticInference.hint))
      : null;
    const before = probes.map((candidate) => runTrustedProbe(attempt.agent, candidate));
    copyFromTrustedRevision(task.fixSha, task.srcFiles, attempt.agent);
    const after = probes.map((candidate) => runTrustedProbe(attempt.agent, candidate));
    let valid = true;
    if (ARMS.includes("H")) {
      console.log(`${task.id} ownership hint ${manualOwnerValid ? "PASS" : "FAIL"}: ${riskHint?.category ?? "missing"} ${riskHint?.owner ?? "missing"}`);
      valid &&= Boolean(manualOwnerValid);
    }
    if (ARMS.includes("I")) {
      console.log(`${task.id} inferred ownership hint ${automaticOwnerValid ? "PASS" : "FAIL"}: ${automaticInference?.hint.category ?? "missing"} ${automaticInference?.hint.owner ?? "missing"} anchor=${automaticInference?.anchor ?? "missing"} score=${automaticInference?.score ?? 0}`);
      valid &&= Boolean(automaticOwnerValid);
    }
    for (const [index, candidate] of probes.entries()) {
      const beforeValid = trustedProbeExpectation(before[index]!, candidate.expected_before);
      const afterValid = trustedProbeExpectation(after[index]!, candidate.expected_after);
      console.log(`${task.id} ${candidate.id} baseline ${beforeValid ? "PASS" : "FAIL"}: ${before[index]!.output}`);
      console.log(`${task.id} ${candidate.id} authentic fix ${afterValid ? "PASS" : "FAIL"}: ${after[index]!.output}`);
      valid &&= beforeValid && afterValid;
    }
    process.exitCode = valid ? 0 : 1;
  } finally {
    dropAttempt(attempt);
  }
  process.exit();
}

if (DRY_CONTRACT) {
  const task = TASKS[0];
  if (!task) throw new Error(`--dry-contract: unknown task "${DRY_CONTRACT}"`);
  const attempt = makeAttempt(`dry-contract-${task.id}`, "A", task);
  try {
    const before = runIssueContract(task, attempt.scorer);
    if (!before) throw new Error(`--dry-contract: no issue contract for ${task.id}`);
    copyFromTrustedRevision(task.fixSha, task.srcFiles, attempt.scorer);
    const after = runIssueContract(task, attempt.scorer)!;
    console.log(`${task.id} contract pre-fix ${before.pass ? "PASS (BAD — no bite)" : "FAIL (good)"}`);
    console.log(`${task.id} contract authentic fix ${after.pass ? "PASS (good)" : "FAIL (bad contract)"}`);
    if (!before.pass && before.output) console.log(`pre-fix contract tail:\n${before.output.slice(-2_000)}`);
    if (!after.pass && after.output) console.log(`post-fix contract tail:\n${after.output.slice(-2_000)}`);
    process.exitCode = !before.pass && after.pass && !before.infrastructureFailure && !after.infrastructureFailure ? 0 : 1;
  } finally {
    dropAttempt(attempt);
  }
  process.exit();
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
        if (EPISODE_ARMS.has(arm)) assertEpisodeProvenance(attempt, EPISODES.episodes[task.id]!);
        const episode = EPISODES.episodes[task.id];
        const contractAxisAudit = episode?.contrastive_probe
          ? auditExecutableProbeContractAxes(episode.contrastive_probe, episode.obligations ?? [])
          : null;
        const contractAxisClosure = episode?.contrastive_probe
          ? compileContractAxisProbeClosure(episode.contrastive_probe, episode.obligations ?? [], episode.contract_axis_probes ?? [])
          : null;
        const adaptiveContractAxisClosure = episode?.contrastive_probe
          ? compileAdaptiveContractAxisProbeClosure(episode.contrastive_probe, episode.obligations ?? [], episode.contract_axis_probes ?? [])
          : null;
        const adaptiveRiskHint = contractAxisClosure
          ? compileContractAxisRiskHint(contractAxisClosure, episode?.contract_axis_risk_hint)
          : null;
        const automaticRiskInference = arm === "I" ? inferEpisodeRiskHint(dir, episode!) : null;
        if (arm === "H" && (!adaptiveRiskHint || !trustedRiskHintOwnerExists(dir, adaptiveRiskHint))) {
          throw new Error(`arm H ownership hint is not grounded in the sealed pre-fix checkout for ${task.id}`);
        }
        if (arm === "I" && (!automaticRiskInference || !trustedRiskHintOwnerExists(dir, automaticRiskInference.hint))) {
          throw new Error(`arm I cannot infer a grounded owner from the sealed pre-fix checkout for ${task.id}`);
        }
        const probePaths = arm === "Q" || arm === "R"
          ? materializeProbeArtifacts(dir, episode?.probes ?? [])
          : CONTRAST_ARMS.has(arm)
            ? materializeProbeArtifacts(dir, [
              ...(episode?.contrastive_probe ? [episode.contrastive_probe] : []),
              ...((arm === "W" || ADAPTIVE_ARMS.has(arm)) ? contractAxisClosure?.probes ?? [] : []),
              ...(ADAPTIVE_ARMS.has(arm) && adaptiveContractAxisClosure?.probe ? [adaptiveContractAxisClosure.probe] : []),
            ])
            : [];
        const tournamentPaths = arm === "T" ? materializeTournamentArtifact(dir, episode?.tournament) : [];
        const probeBaseline = snapshotFiles([...probePaths, ...tournamentPaths], dir);
        const testBaseline = snapshotFiles(task.testFiles, dir);
        const workspaceBaseline = new Set(changedFiles(dir));
        const run = runClaude(dir, prompt(task, arm, automaticRiskInference?.hint ?? null), arm, episode);
        const tournamentDecision = arm === "T" ? readTournamentDecision(dir, episode?.tournament) : null;
        const agentChangedFiles = changedFiles(dir).filter((file) => !workspaceBaseline.has(file));
        const s = scoreFix(task, attempt, testBaseline, agentChangedFiles);
        const probeUntouched = snapshotsEqual(probeBaseline, dir);
        const usesIssueContract = CONTRAST_ARMS.has(arm);
        const primaryTestsPass = usesIssueContract && s.issueContractPass !== null ? s.issueContractPass : s.testsPass;
        const integrityPass = benchmarkIntegrityPass(NO_REPRO, s.testUntouched, probeUntouched);
        const hunch = hunchStats(run.sessionId);
        const controller = run.sessionId && CONTROLLER_ARMS.has(arm) ? loadPipelineState(run.sessionId) : null;
        const controllerPending = controller ? pendingExecutionObligations(controller) : [];
        const controllerComplete = !controller || controllerPending.length === 0;
        const scoredPass = primaryTestsPass && integrityPass && controllerComplete;
        const controllerResolution = !controller
          ? null
          : controllerPending.length === 0
            ? "resolved"
            : run.numTurns >= MAX_TURNS
              ? "exhausted-unresolved"
              : "stopped-unresolved";
        const infrastructureFailure = isInfrastructureFailure(run) || s.testInfrastructureFailure;
        rows.push({
          task: task.id, repeat: repeat + 1, arm, armOrder: armOrder.join(","), model: MODEL,
          fixSha: task.fixSha, preFixSha: attempt.preFixSha, mergedAt: task.mergedAt,
          score: scoredPass ? "PASS" : `FAIL(primary=${primaryTestsPass},upstream=${s.testsPass},testIntegrityRequired=${!NO_REPRO},untouched=${s.testUntouched},probeUntouched=${probeUntouched},controllerComplete=${controllerComplete})`,
          scoreNum: scoredPass ? 1 : 0,
          issueContractAccuracyNum: s.issueContractPass === null ? null : s.issueContractPass && probeUntouched ? 1 : 0,
          sourceAccuracyNum: s.testsPass && probeUntouched ? 1 : 0,
          testsPass: s.testsPass, testUntouched: s.testUntouched,
          testIntegrityRequired: !NO_REPRO,
          integrityPass,
          primaryTestsPass,
          issueContractPass: s.issueContractPass,
          issueContractInfrastructureFailure: s.issueContractInfrastructureFailure,
          issueContractOutput: s.issueContractOutput,
          probeUntouched,
          testInfrastructureFailure: s.testInfrastructureFailure,
          testOutput: s.testOutput, scoredSourceFiles: s.scoredSourceFiles,
          turns: run.numTurns, hunchCalls: hunch.calls, hunchContextCalls: hunch.contextCalls,
          hunchDelivered: hunch.delivered, hunchHypotheses: hunch.hypotheses, hunchSupplements: hunch.supplements,
          hunchSupplementsDelivered: hunch.deliveredSupplements,
          hunchStaleOmitted: hunch.staleOmitted,
          hunchActionabilityOmitted: hunch.actionabilityOmitted,
          hunchAbstentions: hunch.abstentions,
          hunchAbstainedRecords: hunch.abstainedRecords,
          executionEpisodeId: EPISODE_ARMS.has(arm) ? episode!.id : null,
          executionEpisodeCommits: EPISODE_ARMS.has(arm) ? episode!.commits : [],
          executionEpisodeChars: EPISODE_ARMS.has(arm) ? [...episode!.text].length : 0,
          contractAxisAudit: CONTRAST_ARMS.has(arm) ? contractAxisAudit : null,
          contractAxisProbes: arm === "W" || ADAPTIVE_ARMS.has(arm) ? contractAxisClosure?.probes.map((probe) => probe.id) ?? [] : [],
          adaptiveContractProbe: ADAPTIVE_ARMS.has(arm) ? adaptiveContractAxisClosure?.probe?.id ?? null : null,
          adaptiveConsumerDisclosures: arm === "Z" ? adaptiveContractAxisClosure?.disclosures ?? [] : [],
          adaptiveRiskHint: arm === "H" ? adaptiveRiskHint : arm === "I" ? automaticRiskInference?.hint ?? null : null,
          adaptiveRiskInference: arm === "I" ? automaticRiskInference : null,
          tournamentDecision,
          controllerObligations: controller?.obligations.length ?? 0,
          controllerSatisfied: controller ? controller.obligations.length - controllerPending.length : 0,
          controllerPending: controllerPending.map((item) => item.id),
          controllerBlocks: controller?.blocks ?? 0,
          controllerActivity: controller?.proofActivity ?? 0,
          controllerReminders: controller?.proofReminders ?? 0,
          controllerComplete: controller ? controllerComplete : null,
          controllerResolution,
          controllerProtocolPass: controller ? scoredPass && controllerPending.length === 0 : null,
          controllerEvidence: controller?.obligations.filter((item) => item.status === "satisfied").map((item) => ({
            id: item.id,
            command: item.satisfied_by,
            outcome: item.last_attempt?.outcome,
            expectationMet: item.last_attempt?.expectation_met,
          })) ?? [],
          controllerProbes: controller?.obligations.filter((item) => item.probe).map((item) => ({
            id: item.probe!.id,
            stage: item.probe!.stage,
            status: item.status,
            outcome: item.last_attempt?.outcome ?? null,
            expectationMet: item.last_attempt?.expectation_met ?? false,
          })) ?? [],
          controllerPendingAttempts: controllerPending.map((item) => ({ id: item.id, attempt: item.last_attempt ?? null })),
          durationMs: run.durationMs,
          valid: !infrastructureFailure, infrastructureFailure,
          sessionId: run.sessionId, agentChangedFiles, answer: run.result.slice(0, 3000),
        });
        console.log(`${infrastructureFailure ? "INFRA" : scoredPass ? "PASS" : "FAIL"}  ${run.numTurns} turns, ${hunch.calls} hunch calls, ${hunch.hypotheses} hypotheses, ${hunch.abstentions} abstention(s), ${(run.durationMs / 1000).toFixed(0)}s`);
        if (controllerResolution && controllerResolution !== "resolved") {
          console.log(`  ↳ controller ${controllerResolution}: ${controllerPending.length} expected result(s) remain unproved after ${controller?.proofReminders ?? 0} mid-flight reminder(s)`);
        }
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
        episodeSource: ARMS.some((arm) => EPISODE_ARMS.has(arm)) ? EPISODES_PATH : null,
        episodeCutoff: ARMS.some((arm) => EPISODE_ARMS.has(arm)) ? EPISODES.cutoff : null,
        episodeMode: ARMS.some((arm) => EPISODE_ARMS.has(arm)) ? EPISODES.mode ?? "fixed" : null,
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
