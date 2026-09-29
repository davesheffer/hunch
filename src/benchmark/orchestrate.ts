// Orchestrator for `hunch task benchmark`: controller/audited/suite checks, preflight, per-task
// base + memory snapshot, the hashed manifest, the seeded sequential schedule with resume, and
// the report. Pure of Commander; the CLI in src/cli/taskBenchmark.ts only parses flags.
// Design: bench/pilot5/GATE-A-HARNESS.md ("Schedule", "Validation", "Output", "Runner", "Metrics").
import spawn from "cross-spawn";
import { createHash } from "node:crypto";
import { appendFileSync, type Dirent, existsSync, lstatSync, mkdirSync, readdirSync, readFileSync, realpathSync, renameSync, rmSync, statSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { basename, dirname, isAbsolute, join, relative, resolve, sep } from "node:path";
import { fileURLToPath } from "node:url";
import { writeFileAtomic } from "../core/io.js";
import { buildBenchmarkReport, renderBenchmarkMarkdown } from "../core/taskSavings.js";
import { gitNullDevice } from "../extractors/git.js";
import { prepareArm, prepareTaskBase, repoStateFingerprint } from "./armIsolation.js";
import { benchmarkGit, benchmarkGitText, buildMemorySnapshot, type MemorySnapshot } from "./memorySnapshot.js";
import { armOrder, canonicalJson, manifestSha256, needsTieBreak } from "./schedule.js";
import { killLiveChildren, neutralChildEnv, preflight, redactText, redactTokenInDir, runAgent, strippedChildEnv } from "./taskRunner.js";
import { parseTranscript, recordIdsIn, toolInputStrings, transcriptCost } from "./transcript.js";
import type { AgentRunResult, BenchmarkArm, BenchmarkSuite, EfficiencyRun, PreparedArm, RunnerConfig, RunnerIdentity, SuiteTask, TaskCost } from "./types.js";
import { runValidator, type ValidatorResult } from "./validate.js";

export type BenchmarkExitCode = 0 | 1 | 2 | 3;

export interface RunBenchmarkOptions {
  suite: string;
  /** Two or three distinct arms. Two: the first is the baseline, the second the treatment. Three: each Hunch arm
   *  is compared with no-hunch, and diet-hunch also with current-hunch. */
  arms: string[];
  /** True only when the user passed --arms (vs. the CLI default); gates the --report-only mismatch check. */
  armsExplicit?: boolean;
  runs: number;
  seed: string;
  /** Required unless `reportOnly`. */
  runnerConfig?: string;
  output: string;
  /** Required unless `reportOnly`. */
  sourceRepo?: string;
  /** Default "origin/main". */
  mainRef?: string;
  /** Required unless `reportOnly`. */
  privateRepo?: string;
  /** Default "main". */
  privateRef?: string;
  /** Required unless `reportOnly`. */
  audited?: string;
  /** The diet-hunch arm's Hunch checkout, checked like `audited`. Required iff `arms` includes diet-hunch (unless
   *  `reportOnly`); refused otherwise. */
  dietRoot?: string;
  tasks?: string[] | null;
  prepareOnly?: boolean;
  reportOnly?: boolean;
  /** With `reportOnly`: recount token and call fields from each run's transcript.jsonl with this harness's parser
   *  instead of trusting run.json (which stays untouched as evidence); the report names the recount revision. */
  recount?: boolean;
  /** Fixture provider only. */
  noNpmCi?: boolean;
  /** Fixture provider only. */
  allowDirtyController?: boolean;
  /** Subscription token file (`claude setup-token`) for neutral user config: each run gets its own empty
   *  CLAUDE_CONFIG_DIR. Required for the claude provider unless `inheritUserConfig`. Its path and content are never recorded. */
  oauthTokenFile?: string;
  /** Version 1 behaviour: the child inherits the user's Claude Code configuration. Exclusive with `oauthTokenFile`. */
  inheritUserConfig?: boolean;
  /** Test seam; default `~/.claude/CLAUDE.md`. */
  userInstructionsFile?: string;
  /** Test seam; default `~/.claude` (Claude Code's per-cwd auto memory lives under its `projects/`). */
  claudeHome?: string;
  log?: (line: string) => void;
}

export interface RunBenchmarkResult {
  exitCode: BenchmarkExitCode;
  manifestPath: string | null;
  reportPath: string | null;
}

const MANIFEST_SCHEMA = "hunch.context-efficiency-manifest/1";
const SUITE_SCHEMA = "hunch.context-efficiency-suite/1";
const RUNNER_SCHEMA = "hunch.benchmark-runner/1";
const SUPPORTED_ARMS: readonly BenchmarkArm[] = ["no-hunch", "current-hunch", "diet-hunch"];
const HUNCH_START = "<!-- HUNCH:START";
const HUNCH_END = "<!-- HUNCH:END -->";

/** Expected refusal: logged, mapped to an exit code, never a stack trace. */
class Stop extends Error {
  constructor(readonly exitCode: BenchmarkExitCode, message: string) { super(message); }
}

interface Manifest {
  schema: typeof MANIFEST_SCHEMA;
  suite_id: string;
  suite_hash: string;
  harness_revision: string;
  audited: { revision: string; version: string };
  /** Only when diet-hunch is an arm (absent, it leaves a two-arm manifest hash unchanged). */
  diet?: { revision: string; version: string; cli_sha256: string };
  seed: string;
  arms: BenchmarkArm[];
  runs: number;
  runner_config: RunnerConfig;
  runner_identity: RunnerIdentity;
  user_instructions_sha256: string | null;
  /** Only in neutral mode (absent, an inherited-config manifest hashes as in version 1). Never the token or its path. */
  user_config?: "neutral" | "inherited";
  oauth_token?: "present" | "absent";
  node_version: string;
  platform: string;
  tasks: Array<{
    id: string;
    starting_commit: string;
    base_head: string;
    validator_sha256: string;
    snapshot: {
      cutoff_at: string;
      public: { revision: string; sha256: string; files: number; starting_commit: string | null };
      private: { revision: string; sha256: string; files: number } | null;
    };
  }>;
}

interface ManifestFile {
  manifest_sha256: string;
  manifest: Manifest;
  environment: Record<string, unknown>;
}

function sha256(data: string | Buffer): string {
  return createHash("sha256").update(data).digest("hex");
}

function readJson(file: string, what: string): unknown {
  try {
    return JSON.parse(readFileSync(file, "utf8")) as unknown;
  } catch (error) {
    throw new Stop(1, `cannot read ${what} ${file}: ${(error as Error).message}`);
  }
}

/** The first directory upward from this module whose package.json names the Hunch package. */
function controllerRoot(): string {
  let dir = dirname(fileURLToPath(import.meta.url));
  for (;;) {
    const pkg = join(dir, "package.json");
    if (existsSync(pkg)) {
      try {
        if ((JSON.parse(readFileSync(pkg, "utf8")) as { name?: unknown }).name === "@davesheffer/hunch") return dir;
      } catch { /* keep walking */ }
    }
    const parent = dirname(dir);
    if (parent === dir) throw new Stop(1, "controller root not found: no package.json named @davesheffer/hunch above this module");
    dir = parent;
  }
}

function gitStatus(repo: string): string {
  return benchmarkGit(["-C", repo, "status", "--porcelain"]).stdout.toString("utf8").trim();
}

/** `--arms`: two or three distinct supported arms. `--diet-root`: refused unless diet-hunch is an arm, and then
 *  required unless `reportOnly` (which, like `--audited`, never touches a checkout). */
export function parseArms(arms: string[], dietRoot: string | null = null, reportOnly = false): BenchmarkArm[] {
  if ((arms.length !== 2 && arms.length !== 3) || new Set(arms).size !== arms.length
    || !arms.every((arm) => (SUPPORTED_ARMS as readonly string[]).includes(arm))) {
    throw new Stop(1, `--arms needs two or three distinct arms from ${SUPPORTED_ARMS.join(", ")}; got ${arms.join(",") || "(none)"}`);
  }
  const diet = arms.includes("diet-hunch");
  if (!diet && dietRoot) throw new Stop(1, "--diet-root is only accepted when --arms includes diet-hunch");
  if (diet && !dietRoot && !reportOnly) throw new Stop(1, "--arms includes diet-hunch, which needs --diet-root");
  return arms as BenchmarkArm[];
}

/** The Hunch checkouts the confinement check knows about, plus the other deny roots. */
export interface ConfinementRoots {
  sourceRepo: string;
  privateRepo: string | null;
  auditedRoot: string;
  dietRoot: string | null;
  controller: string;
  out: string;
  /** Neutral user-config mode only: the user-level Claude Code config dir (`~/.claude`), denied to every arm. */
  userConfigRoot?: string | null;
}

/** Deny roots and invocation allowance of one arm's no-out-of-repo-access check. Every arm is denied both Hunch
 *  checkouts; a Hunch arm may invoke only its own checkout's `dist/cli/index.js`, no-hunch none. */
export function armConfinement(arm: BenchmarkArm, roots: ConfinementRoots): { denyRoots: string[]; commands: string[] } {
  const denyRoots = [roots.sourceRepo, roots.privateRepo, roots.auditedRoot, roots.dietRoot, roots.controller, roots.out, roots.userConfigRoot]
    .filter((p): p is string => typeof p === "string");
  const own = arm === "current-hunch" ? roots.auditedRoot : arm === "diet-hunch" ? roots.dietRoot : null;
  return { denyRoots, commands: own === null ? [] : [join(own, "dist", "cli", "index.js")] };
}

/** `path` resolved (canonical case included) through symlinks up to its nearest present ancestor, the missing tail
 *  appended as given; null when that ancestor cannot be resolved (a dangling symlink). */
function realpathNearest(path: string): string | null {
  let head = resolve(path);
  const tail: string[] = [];
  for (;;) {
    try { lstatSync(head); break; } catch { /* missing: step up */ }
    const parent = dirname(head);
    if (parent === head) return resolve(path);
    tail.unshift(basename(head));
    head = parent;
  }
  try { return join(realpathSync.native(head), ...tail); } catch { return null; }
}

/** True when `child` is `root` or below it (case-insensitive on Windows); neither path has to exist. `either` (the
 *  refusal direction) accepts a match as given or through symlinks; `resolved` (the acceptance direction) requires the
 *  match through symlinks, so a link inside `root` pointing out of it, or a dangling one, does not count. */
export function isInsidePath(child: string, root: string, mode: "either" | "resolved" = "either"): boolean {
  const inside = (c: string, r: string) => {
    const fold = (path: string) => (process.platform === "win32" ? path.toLowerCase() : path);
    const rel = relative(fold(r), fold(c));
    return rel === "" || (rel !== ".." && !rel.startsWith(`..${sep}`) && !isAbsolute(rel));
  };
  const realChild = realpathNearest(child);
  const realRoot = realpathNearest(root);
  const resolvedMatch = realChild !== null && realRoot !== null && inside(realChild, realRoot);
  return mode === "resolved" ? resolvedMatch : resolvedMatch || inside(resolve(child), resolve(root));
}

/** Reads and validates `--oauth-token-file`. Refusals never include the path or the content. */
export function readOauthTokenFile(file: string, harnessRoots: Array<string | null>): string {
  if (!isAbsolute(file)) throw new Stop(1, "--oauth-token-file must be an absolute path");
  let dir: string;
  try {
    if (!statSync(file).isFile()) throw new Error("not a file");
    dir = dirname(realpathSync(file));
  } catch {
    throw new Stop(1, "--oauth-token-file does not name an existing, accessible file");
  }
  // Fail closed: only git's own "not a git repository" answer counts as outside every repository.
  const inside = benchmarkGit(["-c", "safe.directory=*", "-C", dir, "rev-parse", "--is-inside-work-tree"], { allowFailure: true });
  if (inside.status === 0 || !/not a git repository/i.test(inside.stderr)) {
    throw new Stop(1, "--oauth-token-file is inside a git work tree (or git could not tell); keep it outside every repository");
  }
  if (harnessRoots.some((root) => root !== null && (isInsidePath(dir, root) || isInsidePath(dirname(resolve(file)), root)))) {
    throw new Stop(1, "--oauth-token-file is under a benchmark root (source, controller, private, audited, diet or output)");
  }
  let token: string;
  try { token = readFileSync(file, "utf8").trim(); } catch { throw new Stop(1, "--oauth-token-file could not be read"); }
  if (!token) throw new Stop(1, "--oauth-token-file is empty");
  if (/\s/.test(token)) throw new Stop(1, "--oauth-token-file must hold a single token on one line with no whitespace");
  if (!/^[A-Za-z0-9._-]+$/.test(token)) throw new Stop(1, "--oauth-token-file must hold a single token of letters, digits, '.', '_' or '-'");
  return token;
}

/** Neutral mode: the child's token may sit in a run repo's git objects (compressed, so the literal redaction pass
 *  cannot see them); every run repo's .git is removed. Returns the failures (relative path + error code). */
function removeRunRepoGit(runDir: string): string | null {
  const git = join(runDir, "repo", ".git");
  try {
    if (existsSync(git)) rmSync(git, { recursive: true, force: true });
    return null;
  } catch (error) {
    return `${join("repo", ".git")}: ${(error as NodeJS.ErrnoException).code ?? "error"}`;
  }
}

/** `repo-changes.patch`: the run repo's tracked and untracked (non-ignored) changes against `baseHead`, staged into a
 *  temporary index seeded from `baseHead` (so tracked-but-ignored files are not reported deleted) and leaving the run's
 *  own index untouched. Global and system git config are off, so the runner's excludes, attributes and diff prefixes
 *  cannot drop or reshape content; prefixes are pinned and content forced textual against the repo's own config. */
export function writeRepoChangesPatch(runDir: string, baseHead: string): void {
  const repo = join(runDir, "repo");
  const index = join(runDir, "repo-changes.index");
  try {
    const extraEnv = { GIT_INDEX_FILE: index, GIT_CONFIG_GLOBAL: gitNullDevice(), GIT_CONFIG_NOSYSTEM: "1" };
    benchmarkGit(["-C", repo, "read-tree", baseHead], { extraEnv });
    benchmarkGit(["-C", repo, "add", "-A"], { extraEnv });
    const diff = benchmarkGit(["-C", repo, "-c", "diff.noprefix=false", "-c", "diff.mnemonicPrefix=false", "diff", "--cached",
      "--no-ext-diff", "--no-color", "--no-textconv", "--text", baseHead], { extraEnv });
    writeFileSync(join(runDir, "repo-changes.patch"), diff.stdout);
  } finally {
    rmSync(index, { force: true });
  }
}

/** Neutral-mode sweep: removes every `preflight/<n>/user-instructions-absent` dir, which holds a line of the user's
 *  instructions until its probe scrubs it (an interrupted probe never does). Returns the failures (relative path + code). */
export function removePreflightUserLineDirs(out: string): string[] {
  const failures: string[] = [];
  const preflightRoot = join(out, "preflight");
  let entries: Dirent[];
  try { entries = readdirSync(preflightRoot, { withFileTypes: true }); } catch { return failures; }
  for (const entry of entries) {
    if (!entry.isDirectory()) continue;
    const dir = join(preflightRoot, entry.name, "user-instructions-absent");
    try {
      rmSync(dir, { recursive: true, force: true });
    } catch (error) {
      failures.push(`${relative(out, dir)}: ${(error as NodeJS.ErrnoException).code ?? "error"}`);
    }
  }
  return failures;
}

/** Startup sweep for neutral mode: removes `runs/<task>/<run>/repo/.git` everywhere (interrupted dirs included). */
function removeAllRunRepoGits(out: string): string[] {
  const failures: string[] = [];
  const runs = join(out, "runs");
  if (!existsSync(runs)) return failures;
  for (const taskDir of readdirSync(runs, { withFileTypes: true })) {
    if (!taskDir.isDirectory()) continue;
    for (const runDir of readdirSync(join(runs, taskDir.name), { withFileTypes: true })) {
      if (!runDir.isDirectory()) continue;
      const failure = removeRunRepoGit(join(runs, taskDir.name, runDir.name));
      if (failure) failures.push(`${taskDir.name}/${runDir.name}/${failure}`);
    }
  }
  return failures;
}

/** A Hunch checkout an arm installs from: built dist/cli/index.js, clean tree, HEAD revision, package.json version. */
function checkHunchRoot(root: string, label: string): { revision: string; version: string } {
  if (!existsSync(join(root, "dist", "cli", "index.js"))) throw new Stop(1, `${label} ${root} has no dist/cli/index.js; build it first`);
  const revision = benchmarkGitText(["-C", root, "rev-parse", "HEAD"]);
  if (gitStatus(root)) throw new Stop(1, `${label} ${root} has uncommitted changes`);
  const version = (readJson(join(root, "package.json"), `${label} package.json`) as { version?: unknown }).version;
  if (typeof version !== "string") throw new Stop(1, `${label} ${root}/package.json has no version`);
  return { revision, version };
}

function loadSuite(suitePath: string, filter: string[] | null | undefined): { suite: BenchmarkSuite; selected: BenchmarkSuite; suiteHash: string } {
  let raw: Buffer;
  try { raw = readFileSync(suitePath); } catch (error) { throw new Stop(1, `cannot read suite ${suitePath}: ${(error as Error).message}`); }
  const suiteHash = sha256(raw);
  let suite: BenchmarkSuite;
  try { suite = JSON.parse(raw.toString("utf8")) as BenchmarkSuite; } catch (error) { throw new Stop(1, `suite ${suitePath} is not JSON: ${(error as Error).message}`); }
  if (suite?.schema !== SUITE_SCHEMA) throw new Stop(1, `suite schema must be ${SUITE_SCHEMA}, got ${String(suite?.schema)}`);
  if (!Array.isArray(suite.tasks) || suite.tasks.length === 0) throw new Stop(1, "suite has no tasks");
  const ids = suite.tasks.map((task) => task.id);
  const duplicate = ids.find((id, index) => ids.indexOf(id) !== index);
  if (duplicate !== undefined) throw new Stop(1, `suite task id ${duplicate} is not unique`);
  for (const task of suite.tasks) {
    const file = resolve(dirname(suitePath), task.validator.file);
    let actual: string;
    try { actual = sha256(readFileSync(file)); } catch (error) { throw new Stop(1, `validator for ${task.id} unreadable: ${(error as Error).message}`); }
    if (actual !== task.validator.sha256) throw new Stop(1, `validator ${file} sha256 ${actual} != suite ${task.validator.sha256} (task ${task.id})`);
  }
  let tasks = suite.tasks;
  if (filter && filter.length) {
    const unknown = filter.filter((id) => !ids.includes(id));
    if (unknown.length) throw new Stop(1, `--tasks names unknown task id(s): ${unknown.join(", ")}`);
    tasks = suite.tasks.filter((task) => filter.includes(task.id));
  }
  return { suite, selected: { ...suite, tasks }, suiteHash };
}

function loadRunnerConfig(file: string): RunnerConfig {
  const cfg = readJson(file, "runner config") as Partial<RunnerConfig> | null;
  if (!cfg || cfg.schema !== RUNNER_SCHEMA) throw new Stop(1, `runner config schema must be ${RUNNER_SCHEMA}`);
  if (cfg.provider !== "claude" && cfg.provider !== "fixture") throw new Stop(1, `runner config provider must be claude or fixture, got ${String(cfg.provider)}`);
  if (typeof cfg.executable !== "string" || !cfg.executable) throw new Stop(1, "runner config executable must be a non-empty string");
  if (typeof cfg.model !== "string") throw new Stop(1, "runner config model must be a string");
  if (cfg.effort !== null && typeof cfg.effort !== "string") throw new Stop(1, "runner config effort must be a string or null");
  // A fixture script path is relative to the config file; the agent runs with the run repo as cwd.
  const executable = cfg.provider === "fixture" ? resolve(dirname(file), cfg.executable) : cfg.executable;
  return { schema: RUNNER_SCHEMA, provider: cfg.provider, executable, model: cfg.model, effort: cfg.effort ?? null };
}

/** Text of every HUNCH:START … HUNCH:END block in `file` (empty when absent). */
function hunchBlockText(file: string): string {
  if (!existsSync(file)) return "";
  const text = readFileSync(file, "utf8");
  const pieces: string[] = [];
  for (let start = text.indexOf(HUNCH_START); start !== -1;) {
    const end = text.indexOf(HUNCH_END, start);
    const stop = end === -1 ? text.length : end + HUNCH_END.length;
    pieces.push(text.slice(start, stop));
    start = text.indexOf(HUNCH_START, stop);
  }
  return pieces.join("\n");
}

function firstDifferingKey(a: Record<string, unknown>, b: Record<string, unknown>): string | null {
  const keys = [...new Set([...Object.keys(a), ...Object.keys(b)])].sort();
  return keys.find((key) => canonicalJson(a[key] ?? null) !== canonicalJson(b[key] ?? null)) ?? null;
}

/** backslash -> forward slash, lowercase, MSYS drive paths (/c/…) -> c:/…, no trailing slash. */
function normalizeForMatch(path: string): string {
  const slashed = path.replace(/\\/g, "/").toLowerCase().replace(/(^|[\s"'`=(;])\/([a-z])\//g, "$1$2:/");
  return slashed.endsWith("/") ? slashed.slice(0, -1) : slashed;
}

/** A path mention ends at end of text, a separator, or shell/quote punctuation (so `…/hunch` does not match `…/hunch-bench-out`). */
const PATH_END = "(?=$|[/\\s\"'`;:)|&<>,])";

function pathPattern(path: string): RegExp {
  return new RegExp(normalizeForMatch(path).replace(/[.*+?^${}()|[\]\\]/g, "\\$&") + PATH_END, "g");
}

/** A command mention is dropped only when it is being invoked: optional closing quote, whitespace, then a subcommand
 *  word or a flag. A bare mention stays denied: it cannot be told apart from naming the file (a Read of the entrypoint). */
const COMMAND_END = "(?=[\"'`]?\\s+-{0,2}[a-z])";

function commandPattern(path: string): RegExp {
  return new RegExp(normalizeForMatch(path).replace(/[.*+?^${}()|[\]\\]/g, "\\$&") + COMMAND_END, "g");
}

/** A node executable as one shell word of normalized text: `node`/`node.exe` or a path ending in `/node` or
 *  `/node.exe`, single-quoted, double-quoted without `$` or a backtick, or unquoted without shell metacharacters. */
const NODE_WORD = `(?:'(?:[^'\\n]*/)?node(?:\\.exe)?'|"(?:[^"$\`\\n]*/)?node(?:\\.exe)?"|(?:[^\\s'"$\`;&|<>()]*/)?node(?:\\.exe)?)`;

/** Drive letters of normalized text (`c:/…`, MSYS `/c/…` at a path start) masked to `#`, for counting a variable's
 *  mentions only: `H='c:/…/node.exe'; C='…'` names drive `c`, not variable `C` (PILOT5 Gate A v3, repeated-bug-360
 *  rep 1 current-hunch). A letter behind `$`, `{`, `%` or `!` (`$c:/x`, `${c:-x}`, cmd's `%c:/=\%`, `!c:/…`) is a
 *  reference and stays. */
function maskDriveLetters(text: string): string {
  return text.replace(/(?<![$\{%!a-z0-9_-])[a-z](?=:\/)/g, "#").replace(/(?<=(?:^|[\s"'=(;:])\/)[a-z](?=\/)/g, "#");
}

/**
 * `N='<…>/node.exe'; "$N" "$H" …` — on Windows the Hunch hook prints node's full path, and agents keep it in
 * a variable too. Every double-quoted `"$N"`/`"${N}"` reads as `node` when the text keeps N a node executable:
 * N is assigned a NODE_WORD before any other mention, and outside those assignments (their paths may hold the name,
 * as `NODE=…/nodejs/node.exe` does) every mention is that quoted expansion. Any other mention (`N=cat`, `read N`,
 * `N+=x`, `for N in …`, `${N%x}`, an unquoted `$N`) leaves the text as is. The rewrite keeps the quotes, so a path
 * glued to it still ends at PATH_END, and assignments are never removed, so a deny root inside one still matches.
 */
function nodeVarsAsNode(rest: string): string {
  const assign = new RegExp(`(?<=^|[\\s;&|(])(?:export\\s+)?([a-z_][a-z0-9_]*)=${NODE_WORD}(?=$|[\\s;&|)])`, "g");
  const firstAssigned = new Map<string, number>();
  for (const match of rest.matchAll(assign)) if (!firstAssigned.has(match[1]!)) firstAssigned.set(match[1]!, match.index);
  const others = maskDriveLetters(rest.replace(assign, (mention) => " ".repeat(mention.length)));
  for (const [name, at] of firstAssigned) {
    const expansion = new RegExp(`"\\$(?:${name}|\\{${name}\\})"`, "g");
    const words = [...others.matchAll(new RegExp(`(?<![a-z0-9_-])${name}(?![a-z0-9_])`, "g"))].map((match) => match.index);
    if (words.length > 0 && at < words[0]! && words.length === [...others.matchAll(expansion)].length) rest = rest.replace(expansion, '"node"');
  }
  return rest;
}

/**
 * `H='<path>'; node "$H" …` — the audited entrypoint assigned to a shell variable and invoked through
 * it (`export` and quotes optional; the assignment must sit at a command boundary). Dropped only when,
 * outside its assignments of this path, the name occurs at least once and solely as an invocation:
 * `$NAME`/`${NAME}` as the command word after a boundary (start, `;`, `&`, `|`, or a newline that is
 * not a `\` continuation), optionally behind a NODE_WORD as that command word, quote optional,
 * then a subcommand or flag on the same line. Any other occurrence of the name as a word (`cat "$H"`,
 * `grep node "$H"`, `arr=("$H")`, `G="$H" bash -c …`, `${H%x}`, `process.env.H`, `printenv H`)
 * leaves the assignment denied: the path is then not provably only-invoked. A `-NAME` flag (`-h`) is
 * not a reference. The text is lowercased, so `$h` counts against `H` (stricter, never looser).
 * Assignments are dropped at their own match positions, never by a literal text search.
 */
function dropInvokedVarAssignment(rest: string, path: string): string {
  const escaped = normalizeForMatch(path).replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
  const assign = new RegExp(`(?<=^|[\\s;&|(])(?:export\\s+)?([a-z_][a-z0-9_]*)=(["'])?${escaped}\\2(?=$|[\\s;&|)])`, "g");
  const others = maskDriveLetters(rest.replace(assign, " "));
  const invokedOnly = new Set<string>();
  for (const match of rest.matchAll(assign)) {
    const name = match[1]!;
    const word = new RegExp(`(?<![a-z0-9_-])${name}(?![a-z0-9_])`, "g");
    // `\` normalizes to `/`, so a continuation newline reads `/\n` and is no boundary; `>&`, `<&`, `>|` are
    // redirections (`echo x >& "$H"` overwrites the entrypoint), not command separators.
    const invocation = new RegExp(`(?<=(?:^|;|(?<![<>])[&|]|(?<!/)\\n)\\s*(?:${NODE_WORD}\\s+)?["']?)\\$(?:${name}|\\{${name}\\})(?![a-z0-9_])(?=["']?[ \\t]+-{0,2}[a-z])`, "g");
    const invocations = [...others.matchAll(invocation)].length;
    if (invocations > 0 && [...others.matchAll(word)].length === invocations) invokedOnly.add(name);
  }
  return rest.replace(assign, (mention, name: string) => (invokedOnly.has(name) ? " " : mention));
}

/** `~`, `$HOME`, `${HOME}`, `$env:USERPROFILE`, `%USERPROFILE%` at the start of a path mention -> the normalized home dir. */
const HOME_TOKEN = /(^|[\s"'`=(;])(~|\$home|\$\{home\}|\$env:userprofile|%userprofile%)(?=\/)/g;

/**
 * True when a tool-input string reaches outside the run's own directory: after home-directory
 * tokens (`~`, `$HOME`, `${HOME}`, `$env:USERPROFILE`, `%USERPROFILE%`) are rewritten to the real
 * home dir, every mention of an `allowed` path (a path prefix, e.g. the run's own `runDir`) is
 * dropped, and every mention of a `commands` path (an executable entrypoint, e.g. the audited CLI,
 * dropped only where it is being invoked, not merely named) is dropped, it still names one of the
 * deny roots (source repo, private overlay, audited checkout, controller, `<out>`), or it contains
 * a directory-traversal run ("../../../" etc., tolerating repeated separators and "./" segments).
 * `traversal: false` skips the traversal rule for file content (an Edit/Write body's relative imports).
 */
export function isOutOfRepoAccess(
  value: string,
  denyRoots: string[],
  allowed: string | string[],
  commands: string[] = [],
  home: string = homedir(),
  traversal = true,
): boolean {
  if (traversal && /(?:\.\.[\\/]+(?:\.[\\/]+)*){3}/.test(value)) return true;
  let rest = normalizeForMatch(value).replace(HOME_TOKEN, (_, prefix) => `${prefix}${normalizeForMatch(home)}`);
  for (const path of Array.isArray(allowed) ? allowed : [allowed]) rest = rest.replace(pathPattern(path), " ");
  if (commands.length) rest = nodeVarsAsNode(rest);
  for (const path of commands) {
    rest = rest.replace(commandPattern(path), " ");
    rest = dropInvokedVarAssignment(rest, path);
  }
  return denyRoots.some((root) => pathPattern(root).test(rest));
}

function freeSuffix(path: string, label: string): string {
  for (let n = 1; ; n++) {
    const candidate = `${path}${label}${n}`;
    if (!existsSync(candidate)) return candidate;
  }
}

interface RunContext {
  out: string;
  suitePath: string;
  suite: BenchmarkSuite;
  suiteHash: string;
  manifest: Manifest;
  manifestSha: string;
  cfg: RunnerConfig;
  sourceRepo: string;
  controller: string;
  privateRepo: string | null;
  auditedRoot: string;
  dietRoot: string | null;
  noNpmCi: boolean;
  snapshots: Map<string, MemorySnapshot>;
  claudeHome: string;
  /** Neutral user-config mode iff non-null; never written anywhere. */
  oauthToken: string | null;
  userConfigRoot: string | null;
  log: (line: string) => void;
}

/** One scheduled run. Returns the run (fresh or resumed) or `stop` for the CLI-version exit. */
async function executeRun(ctx: RunContext, task: SuiteTask, rep: number, arm: BenchmarkArm): Promise<EfficiencyRun | "stop"> {
  const runDir = join(ctx.out, "runs", task.id, `${rep}-${arm}`);
  const runJson = join(runDir, "run.json");
  if (existsSync(runJson)) {
    const existing = readJson(runJson, "run.json") as EfficiencyRun;
    if (existing.manifest_sha256 !== ctx.manifestSha) {
      throw new Stop(2, `${runJson} was written under manifest ${existing.manifest_sha256}, not ${ctx.manifestSha}`);
    }
    ctx.log(`skip ${task.id} rep=${rep} arm=${arm}: run.json present`);
    return existing;
  }
  if (existsSync(runDir)) {
    if (ctx.oauthToken !== null) {
      const failures = [removeRunRepoGit(runDir), ...redactTokenInDir(runDir, ctx.oauthToken).failures].filter((f): f is string => f !== null);
      if (failures.length) ctx.log(`warning: interrupted run ${runDir} not fully scrubbed: ${failures.join(", ")}`);
    }
    const moved = freeSuffix(runDir, ".interrupted-");
    renameSync(runDir, moved);
    ctx.log(`interrupted run ${runDir} moved to ${moved}`);
  }

  const fingerprintPaths = [ctx.sourceRepo, ctx.controller, ctx.privateRepo, ctx.auditedRoot, ctx.dietRoot].filter((p): p is string => p !== null);
  const before = repoStateFingerprint(fingerprintPaths);
  const isolation: string[] = [];
  const validation: string[] = [];
  // Claude Code keeps auto memory per cwd; a rerun after an .interrupted rename reuses this repo path.
  // Neutral mode: auto memory lives in the run's own config dir, so there is nothing to move.
  const autoMemoryDir = join(ctx.claudeHome, "projects", join(runDir, "repo").replace(/[^A-Za-z0-9]/g, "-"));
  if (ctx.oauthToken === null && existsSync(autoMemoryDir)) {
    const moved = freeSuffix(autoMemoryDir, ".bench-stale-");
    renameSync(autoMemoryDir, moved);
    isolation.push(`auto-memory dir ${autoMemoryDir} moved to ${moved}`);
  }
  const snapshot = ctx.snapshots.get(task.id)!;
  const snapshotDir = join(ctx.out, "snapshots", task.id);
  let prepared: PreparedArm | null = null;
  let invalid = false;
  try {
    prepared = await prepareArm({
      base: join(ctx.out, "bases", task.id), arm, runDir, env: strippedChildEnv(process.env), npmCi: !ctx.noNpmCi,
      ...(arm !== "no-hunch" ? {
        snapshot: {
          publicDir: join(snapshotDir, "public"),
          privateDir: snapshot.private ? join(snapshotDir, "private") : null,
          publicSha256: snapshot.public.sha256,
          privateSha256: snapshot.private?.sha256 ?? null,
        },
        audited: { root: arm === "diet-hunch" ? ctx.dietRoot! : ctx.auditedRoot },
      } : {}),
    });
  } catch (error) {
    invalid = true;
    isolation.push(`prepareArm failed: ${(error as Error).message}`);
  }
  let setupIds: string[] = [];
  if (prepared) {
    setupIds = recordIdsIn([hunchBlockText(join(prepared.repo, "CLAUDE.md")), hunchBlockText(join(prepared.repo, "AGENTS.md"))].join("\n"));
    writeFileAtomic(join(runDir, "exposure.json"), JSON.stringify(prepared.exposure, null, 2) + "\n");
    for (const check of prepared.exposure.checks) isolation.push(`setup ${check.id}: ${check.ok ? "ok" : "FAIL"} (${check.detail})`);
    if (!prepared.exposure.ok) invalid = true;
  }

  let agent: AgentRunResult | null = null;
  let validator: ValidatorResult | null = null;
  let outOfRepoBreach = false;
  const configDir = ctx.oauthToken !== null ? join(runDir, "claude-config") : null;
  if (prepared && !invalid && configDir !== null) {
    mkdirSync(configDir, { recursive: true });
    if (readdirSync(configDir).length) {
      invalid = true;
      isolation.push(`setup claude-config: FAIL (${configDir} is not empty)`);
    }
  }
  try {
    if (prepared && !invalid) {
      const neutralEnv = configDir !== null ? neutralChildEnv(configDir, ctx.oauthToken!) : {};
      const agentEnv = strippedChildEnv(process.env, { DISABLE_AUTOUPDATER: "1", ...prepared.env, ...neutralEnv });
      if (ctx.cfg.provider === "claude") {
        const probe = spawn.sync(ctx.cfg.executable, ["--version"], { encoding: "utf8", windowsHide: true, env: agentEnv, timeout: 30_000 });
        const version = String(probe.stdout ?? "").split(/\r?\n/).find((line) => line.trim())?.trim() ?? null;
        if (version !== ctx.manifest.runner_identity.cli_version) {
          ctx.log(`claude --version is ${version ?? "(none)"} but the manifest pins ${ctx.manifest.runner_identity.cli_version}; stopping the schedule`);
          return "stop";
        }
      }
      agent = await runAgent({
        cfg: ctx.cfg, prompt: task.prompt, cwd: prepared.repo, mcpConfigPath: prepared.mcp_config_path,
        env: agentEnv, timeoutMs: ctx.suite.timeout_ms, outDir: runDir,
      });
      const init = agent.metrics.init;
      const post: Array<[string, boolean, string]> = [];
      if (!init) post.push(["init-present", false, "transcript has no init event"]);
      else if (arm !== "no-hunch") {
        const servers = init.mcp_servers;
        post.push(
          ["mcp-servers-exactly-hunch", servers.length === 1 && servers[0] === "hunch", `${servers.length} MCP server(s)${servers.length ? `: ${servers.join(", ")}` : ""}`],
          ["mcp-hunch-connected", init.mcp_server_status.hunch === "connected", `hunch status ${init.mcp_server_status.hunch ?? "missing"}`],
          // The audited SessionStart hook always emits, so a real current-hunch run must observe it.
          ["hunch-hooks-observed", agent.metrics.hook_events >= 1 && agent.metrics.hunch_dynamic_chars.hooks > 0,
            `${agent.metrics.hook_events} hook event(s), ${agent.metrics.hunch_dynamic_chars.hooks} hook char(s)`],
        );
      } else {
        const hunchTools = init.tool_names.filter((name) => name.startsWith("mcp__hunch__"));
        post.push(
          ["mcp-servers-empty", init.mcp_servers.length === 0, `${init.mcp_servers.length} MCP server(s)${init.mcp_servers.length ? `: ${init.mcp_servers.join(", ")}` : ""}`],
          ["hunch-tools-absent", hunchTools.length === 0, hunchTools.length ? hunchTools.join(", ") : "no mcp__hunch__ tool"],
          ["hunch-tool-calls-zero", agent.metrics.hunch_tool_calls === 0, `${agent.metrics.hunch_tool_calls} hunch tool call(s)`],
          ["hunch-hook-output-zero", agent.metrics.hunch_dynamic_chars.hooks === 0, `${agent.metrics.hunch_dynamic_chars.hooks} hook chars`],
        );
      }
      if (configDir !== null) {
        const auto = init?.memory_paths_auto ?? null;
        post.push(["auto-memory-in-config-dir", auto !== null && isInsidePath(auto, configDir, "resolved"), `auto memory ${auto ?? "missing"}`]);
      }
      // The audited UserPromptSubmit hook tells the agent to run checks through `<node> <audited>/dist/cli/index.js task verify`.
      const { denyRoots, commands } = armConfinement(arm, ctx);
      const offenders = [...new Set(toolInputStrings(readFileSync(agent.transcript_path, "utf8"))
        .filter(({ value, content }) => isOutOfRepoAccess(value, denyRoots, [runDir], commands, homedir(), !content))
        .map(({ value }) => value))];
      outOfRepoBreach = offenders.length > 0;
      post.push(["no-out-of-repo-access", !outOfRepoBreach, outOfRepoBreach
        ? `offending string(s): ${offenders.slice(0, 5).map((s) => s.slice(0, 200)).join(" | ")}`
        : "no out-of-repo access in tool inputs"]);

      for (const [id, ok, detail] of post) {
        isolation.push(`post ${id}: ${ok ? "ok" : "FAIL"} (${detail})`);
        if (!ok) invalid = true;
      }
      isolation.push(`auto-memory-path: ${init?.memory_paths_auto ?? "missing"}`);
      if (!invalid) {
        validator = await runValidator({
          repo: prepared.repo, validatorFile: resolve(dirname(ctx.suitePath), task.validator.file), runDir,
          timeoutMs: ctx.suite.validator_timeout_ms, env: strippedChildEnv(process.env, { DISABLE_AUTOUPDATER: "1" }),
        });
      }
    }
  } finally {
    if (ctx.oauthToken !== null) {
      // Nothing after this point reads the run repo's git (the validator has run; fingerprints cover harness repos only).
      // prepareArm can throw after the clone: the .git goes whenever it exists, the patch only for a prepared arm.
      if (existsSync(join(runDir, "repo", ".git"))) {
        if (prepared) {
          try {
            writeRepoChangesPatch(runDir, ctx.manifest.tasks.find((t) => t.id === task.id)?.base_head ?? "HEAD");
          } catch (error) {
            isolation.push(`repo-changes.patch not written: ${(error as Error).message.split("\n")[0]}`);
          }
        }
        const failure = removeRunRepoGit(runDir);
        if (failure) {
          invalid = true;
          isolation.push(`repo/.git removal failed: ${failure}`);
        } else isolation.push("repo/.git removed (neutral mode)");
      }
      try {
        const scrub = redactTokenInDir(runDir, ctx.oauthToken);
        isolation.push(`token_redactions: ${scrub.count}`);
        if (scrub.failures.length) {
          invalid = true;
          isolation.push(`token redaction failed for: ${scrub.failures.join(", ")}`);
        }
      } catch (error) {
        invalid = true;
        isolation.push(`token redaction failed: ${(error as Error).message}`);
      }
    }
  }

  const validatorId = `${task.id}:${task.validator.sha256.slice(0, 12)}`;
  if (validator) {
    validation.push(`validator ${validatorId}: exit ${validator.exit_code}, timed_out ${validator.timed_out}, copied sha256 ${validator.sha256_of_copied_file}`);
  } else validation.push(`validator ${validatorId}: skipped (${prepared ? "invalid exposure" : "arm setup failed"})`);

  const after = repoStateFingerprint(fingerprintPaths);
  const changed = fingerprintPaths.filter((path) => before[path]?.head !== after[path]?.head || before[path]?.status !== after[path]?.status);
  if (changed.length) isolation.push(`isolation breach: HEAD or git status changed in ${changed.join(", ")}`);

  const status: EfficiencyRun["status"] = changed.length || outOfRepoBreach ? "isolation_breach"
    : invalid || !agent ? "invalid_exposure"
      : agent.timed_out ? "timed_out"
        : agent.exit_code !== 0 || agent.metrics.result?.is_error !== false ? "agent_error"
          : "completed";
  const passed = validator !== null && validator.exit_code === 0 && !validator.timed_out;
  const success = status === "completed" && passed;

  const staticChars = Object.values(prepared?.static_hunch_chars ?? {}).reduce((sum, chars) => sum + chars, 0);
  const dynamic = agent?.metrics.hunch_dynamic_chars ?? { tool_results: 0, hooks: 0 };
  const agentMs = agent?.agent_wall_clock_ms ?? 0;
  const validationMs = validator?.validation_ms ?? 0;
  const cost: TaskCost = {
    ...transcriptCost(agent?.metrics ?? null),
    hunch_context_estimated_tokens: Math.ceil((staticChars + dynamic.tool_results + dynamic.hooks) / 4),
    memory_processing_tokens: null,
    agent_wall_clock_ms: agentMs,
    validation_ms: validationMs,
    total_wall_clock_ms: agentMs + validationMs,
  };
  const selected = [...new Set([...(agent?.metrics.delivered_record_ids ?? []), ...setupIds])].sort();
  const eligible = new Set(task.memory.eligible_record_ids);
  const hunchArm = arm !== "no-hunch";
  const run: EfficiencyRun = {
    schema: "hunch.context-efficiency-run/1",
    task_id: task.id,
    arm,
    run_index: rep,
    suite_hash: ctx.suiteHash,
    harness_revision: ctx.manifest.harness_revision,
    audited_hunch_revision: arm === "current-hunch" ? ctx.manifest.audited.revision : arm === "diet-hunch" ? ctx.manifest.diet?.revision ?? null : null,
    arm_order_seed: ctx.manifest.seed,
    repository_revision: task.starting_commit,
    memory_revision: hunchArm ? snapshot.public.sha256 : null,
    runner: ctx.manifest.runner_identity,
    cache_state: "cold",
    evidence_kind: ctx.cfg.provider === "claude" ? "product" : "fixture",
    success,
    status,
    quality: { outcome: validator ? (passed ? "passed" : "failed") : "unavailable", validator_id: validatorId },
    cost,
    replay_packet_id: null,
    selected_memory_ids: selected,
    delivered_eligible_ids: selected.filter((id) => eligible.has(id)),
    isolation_evidence: isolation,
    validation_evidence: validation,
    manifest_sha256: ctx.manifestSha,
  };
  const runText = JSON.stringify(run, null, 2) + "\n";
  writeFileAtomic(runJson, ctx.oauthToken !== null ? redactText(runText, ctx.oauthToken) : runText);
  const line = `${task.id} rep=${rep} arm=${arm} status=${status} success=${success} agent_s=${(agentMs / 1000).toFixed(1)} validator_exit=${validator?.exit_code ?? "-"}`;
  ctx.log(line);
  appendFileSync(join(ctx.out, "progress.log"), line + "\n");
  return run;
}

/** The report's pairs: two arms as given (baseline first); three arms put no-hunch as the baseline, current-hunch as
 *  the treatment and diet-hunch as a further treatment. */
function reportPairs(arms: BenchmarkArm[]): { baseline: BenchmarkArm; treatment: BenchmarkArm; extra_treatments: BenchmarkArm[] } {
  if (arms.length === 2) return { baseline: arms[0]!, treatment: arms[1]!, extra_treatments: [] };
  const [treatment, ...extra] = SUPPORTED_ARMS.filter((arm) => arm !== "no-hunch" && arms.includes(arm));
  return { baseline: "no-hunch", treatment: treatment!, extra_treatments: extra };
}

/** report.json + report.md over every run.json under the manifest. With `recountRevision`, each run's token and
 *  call fields come from its transcript.jsonl (parsed now) instead of run.json; run.json is never rewritten. */
function writeReport(
  out: string, suite: BenchmarkSuite, manifestSha: string, arms: BenchmarkArm[], log: (line: string) => void,
  recountRevision: string | null = null,
): string {
  const runsDir = join(out, "runs");
  const runs: EfficiencyRun[] = [];
  const taskIds = new Set(suite.tasks.map((task) => task.id));
  let recounted = 0;
  if (existsSync(runsDir)) {
    for (const taskDir of readdirSync(runsDir, { withFileTypes: true })) {
      if (!taskDir.isDirectory()) continue;
      for (const runDir of readdirSync(join(runsDir, taskDir.name), { withFileTypes: true })) {
        const file = join(runsDir, taskDir.name, runDir.name, "run.json");
        if (!runDir.isDirectory() || !existsSync(file)) continue;
        let run = readJson(file, "run.json") as EfficiencyRun;
        if (run.manifest_sha256 !== manifestSha) { log(`warning: skipping ${file}: manifest ${run.manifest_sha256} != ${manifestSha}`); continue; }
        if (!taskIds.has(run.task_id)) { log(`warning: skipping ${file}: task ${run.task_id} is not selected`); continue; }
        const transcript = join(runsDir, taskDir.name, runDir.name, "transcript.jsonl");
        if (recountRevision !== null && existsSync(transcript)) {
          run = { ...run, cost: { ...run.cost, ...transcriptCost(parseTranscript(readFileSync(transcript, "utf8"))) } };
          recounted++;
        } else if (recountRevision !== null) log(`recount: ${taskDir.name}/${runDir.name} has no transcript.jsonl; keeping its recorded fields`);
        runs.push(run);
      }
    }
  }
  const order = new Map(suite.tasks.map((task, index) => [task.id, index]));
  runs.sort((x, y) => order.get(x.task_id)! - order.get(y.task_id)! || x.run_index - y.run_index || x.arm.localeCompare(y.arm));
  if (recountRevision !== null) log(`recount: token and call fields of ${recounted} of ${runs.length} run(s) recounted from transcript.jsonl`);
  const report = buildBenchmarkReport(suite, runs, {
    ...reportPairs(arms), manifest_sha256: manifestSha, generated_at: new Date().toISOString(),
    token_source: recountRevision === null
      ? { kind: "recorded" }
      : { kind: "recounted", harness_revision: recountRevision, recounted_runs: recounted, runs: runs.length },
  });
  writeFileAtomic(join(out, "report.json"), JSON.stringify(report, null, 2) + "\n");
  const reportPath = join(out, "report.md");
  writeFileAtomic(reportPath, renderBenchmarkMarkdown(report));
  log(`report: ${runs.length} run(s) -> ${reportPath}`);
  return reportPath;
}

export async function runBenchmark(opts: RunBenchmarkOptions): Promise<RunBenchmarkResult> {
  process.env.DISABLE_AUTOUPDATER = "1";
  const log = opts.log ?? ((line: string) => console.log(line));
  const out = resolve(opts.output);
  const manifestPath = join(out, "manifest.json");
  let manifestWritten: string | null = null;
  let removeSignalHandlers: (() => void) | null = null;
  try {
    const arms = parseArms(opts.arms, opts.dietRoot ?? null, !!opts.reportOnly);
    if (!Number.isInteger(opts.runs) || opts.runs < 1) throw new Stop(1, `--runs must be an integer >= 1, got ${opts.runs}`);
    const suitePath = resolve(opts.suite);
    const { selected, suiteHash } = loadSuite(suitePath, opts.tasks);
    if (opts.recount && !opts.reportOnly) throw new Stop(1, "--recount only applies with --report-only");

    if (opts.reportOnly) {
      if (!existsSync(manifestPath)) throw new Stop(1, `--report-only needs an existing ${manifestPath}`);
      const file = readJson(manifestPath, "manifest") as ManifestFile;
      if (file.manifest?.suite_hash !== suiteHash) {
        throw new Stop(2, `suite hash ${suiteHash} != manifest suite_hash ${String(file.manifest?.suite_hash)}`);
      }
      const manifestArms = file.manifest.arms;
      if (opts.armsExplicit && (arms.length !== manifestArms.length || arms.some((arm, i) => arm !== manifestArms[i]))) {
        throw new Stop(1, `--arms ${arms.join(",")} != manifest arms ${manifestArms.join(",")}`);
      }
      const inManifest = new Set((file.manifest.tasks ?? []).map((task) => task.id));
      const suite = { ...selected, tasks: selected.tasks.filter((task) => inManifest.has(task.id)) };
      let recountRevision: string | null = null;
      if (opts.recount) {
        const controller = controllerRoot();
        recountRevision = benchmarkGitText(["-C", controller, "rev-parse", "HEAD"]) + (gitStatus(controller) ? "+dirty" : "");
      }
      return { exitCode: 0, manifestPath, reportPath: writeReport(out, suite, file.manifest_sha256, manifestArms, log, recountRevision) };
    }

    const missing = (["runnerConfig", "sourceRepo", "privateRepo", "audited"] as const).filter((key) => !opts[key]);
    if (missing.length) throw new Stop(1, `missing required option(s): ${missing.join(", ")}`);
    const runnerConfigPath = resolve(opts.runnerConfig!);
    const cfg = loadRunnerConfig(runnerConfigPath);
    if ((opts.noNpmCi || opts.allowDirtyController) && cfg.provider !== "fixture") {
      throw new Stop(1, "--no-npm-ci and --allow-dirty-controller are only accepted with the fixture provider");
    }
    if (opts.oauthTokenFile && opts.inheritUserConfig) throw new Stop(1, "--oauth-token-file and --inherit-user-config are exclusive");
    if (!opts.oauthTokenFile && !opts.inheritUserConfig && cfg.provider === "claude") {
      throw new Stop(1, "the claude provider needs --oauth-token-file <path> (a `claude setup-token` subscription token), "
        + "or --inherit-user-config to reproduce version 1");
    }
    const sourceRepo = resolve(opts.sourceRepo!);
    const privateRepo: string | null = resolve(opts.privateRepo!);
    const privateRef = opts.privateRef ?? "main";
    const mainRef = opts.mainRef ?? "origin/main";

    const controller = controllerRoot();
    const harnessRevision = benchmarkGitText(["-C", controller, "rev-parse", "HEAD"]);
    if (gitStatus(controller) && !opts.allowDirtyController) {
      throw new Stop(1, `controller ${controller} has uncommitted changes; commit them (the manifest pins harness_revision ${harnessRevision})`);
    }

    const auditedRoot = resolve(opts.audited!);
    const audited = checkHunchRoot(auditedRoot, "audited");
    const dietRoot = arms.includes("diet-hunch") ? resolve(opts.dietRoot!) : null;
    const dietHunch = dietRoot === null ? null : checkHunchRoot(dietRoot, "diet");
    let diet: { revision: string; version: string; cli_sha256: string } | null = null;
    if (dietRoot !== null && dietHunch !== null) {
      // The diet arm must install a distinct build, or it measures the audited Hunch twice.
      const sameRoot = process.platform === "win32" ? dietRoot.toLowerCase() === auditedRoot.toLowerCase() : dietRoot === auditedRoot;
      if (sameRoot) throw new Stop(1, `diet root ${dietRoot} is the audited root; the diet arm needs its own checkout`);
      if (dietHunch.revision === audited.revision) throw new Stop(1, `diet ${dietRoot} is at the audited revision ${audited.revision}; it cannot contain the diet`);
      const dietCli = sha256(readFileSync(join(dietRoot, "dist", "cli", "index.js")));
      if (dietCli === sha256(readFileSync(join(auditedRoot, "dist", "cli", "index.js")))) {
        throw new Stop(1, `diet build ${join(dietRoot, "dist", "cli", "index.js")} is identical to the audited build, so it cannot contain the diet; rebuild it`);
      }
      diet = { ...dietHunch, cli_sha256: dietCli };
    }

    const oauthToken = opts.oauthTokenFile
      ? readOauthTokenFile(opts.oauthTokenFile, [sourceRepo, controller, privateRepo, auditedRoot, dietRoot, out])
      : null;
    if (oauthToken !== null) {
      // Earlier crashed runs and killed preflight probes may have left the token behind.
      const sweep = () => {
        const gitFailures = [...removeAllRunRepoGits(out), ...removePreflightUserLineDirs(out)];
        const scrub = redactTokenInDir(out, oauthToken);
        log(`token sweep over ${out}: ${scrub.count} redaction(s)`);
        const failures = [...gitFailures, ...scrub.failures];
        if (failures.length) log(`warning: token sweep could not scrub: ${failures.join(", ")}`);
      };
      if (existsSync(out)) sweep();
      const onSignal = (code: number) => () => {
        killLiveChildren();
        try { sweep(); } catch { /* exiting anyway */ }
        process.exit(code);
      };
      const onInt = onSignal(130);
      const onTerm = onSignal(143);
      process.on("SIGINT", onInt);
      process.on("SIGTERM", onTerm);
      removeSignalHandlers = () => { process.off("SIGINT", onInt); process.off("SIGTERM", onTerm); };
    }
    const instructionsFile = opts.userInstructionsFile ?? join(homedir(), ".claude", "CLAUDE.md");
    const claudeHome = opts.claudeHome ?? join(homedir(), ".claude");

    let n = 1;
    while (existsSync(join(out, "preflight", String(n)))) n++;
    const preflightDir = join(out, "preflight", String(n));
    mkdirSync(preflightDir, { recursive: true });
    const pre = await preflight(cfg, {
      workDir: preflightDir, ...(oauthToken !== null ? { neutral: { token: oauthToken, userInstructionsFile: instructionsFile } } : {}),
    });
    writeFileAtomic(join(out, "preflight", `${n}.json`), JSON.stringify(pre, null, 2) + "\n");
    if (!pre.ok) {
      throw new Stop(1, `preflight failed (${join(out, "preflight", `${n}.json`)}): ${pre.checks.filter((c) => !c.ok).map((c) => `${c.id}: ${c.detail}`).join("; ")}`);
    }
    let userInstructionsSha: string | null = null;
    if (existsSync(instructionsFile)) {
      const bytes = readFileSync(instructionsFile);
      if (/hunch/i.test(bytes.toString("utf8"))) throw new Stop(1, `user instructions ${instructionsFile} mention Hunch; both arms would see them`);
      userInstructionsSha = sha256(bytes);
    }

    const bases = new Map<string, string>();
    const snapshots = new Map<string, MemorySnapshot>();
    for (const task of selected.tasks) {
      try {
        const base = await prepareTaskBase({ sourceRepo, startingCommit: task.starting_commit, dest: join(out, "bases", task.id) });
        bases.set(task.id, base.head);
        snapshots.set(task.id, buildMemorySnapshot({
          sourceRepo, sourceRef: mainRef, startingCommit: task.starting_commit, privateRepo, privateRef,
          cutoffIso: task.memory.cutoff_at, dest: join(out, "snapshots", task.id),
        }));
      } catch (error) {
        throw new Stop(1, `prepare ${task.id} failed: ${(error as Error).message}`);
      }
      log(`prepared ${task.id}: base ${bases.get(task.id)}, snapshot ${snapshots.get(task.id)!.public.sha256}`);
    }

    const manifest: Manifest = {
      schema: MANIFEST_SCHEMA,
      suite_id: selected.id,
      suite_hash: suiteHash,
      harness_revision: harnessRevision,
      audited,
      ...(diet ? { diet } : {}),
      seed: opts.seed,
      arms,
      runs: opts.runs,
      runner_config: { ...cfg, executable: isAbsolute(cfg.executable) ? basename(cfg.executable) : cfg.executable },
      runner_identity: {
        provider: pre.identity.provider, cli_version: pre.identity.cli_version, sanitized_argv_hash: pre.identity.sanitized_argv_hash,
        model_identity: pre.identity.model_identity, model_identity_source: pre.identity.model_identity_source,
      },
      user_instructions_sha256: userInstructionsSha,
      ...(oauthToken !== null ? { user_config: "neutral" as const, oauth_token: "present" as const } : {}),
      node_version: process.version,
      platform: process.platform,
      tasks: selected.tasks.map((task) => {
        const snap = snapshots.get(task.id)!;
        return {
          id: task.id,
          starting_commit: task.starting_commit,
          base_head: bases.get(task.id)!,
          validator_sha256: task.validator.sha256,
          snapshot: {
            cutoff_at: snap.cutoff_at,
            public: { revision: snap.public.revision, sha256: snap.public.sha256, files: snap.public.files, starting_commit: snap.public.starting_commit ?? null },
            private: snap.private ? { revision: snap.private.revision, sha256: snap.private.sha256, files: snap.private.files } : null,
          },
        };
      }),
    };
    const manifestSha = manifestSha256(manifest);
    if (existsSync(manifestPath)) {
      const existing = readJson(manifestPath, "manifest") as ManifestFile;
      if (existing.manifest_sha256 !== manifestSha) {
        const key = firstDifferingKey((existing.manifest ?? {}) as unknown as Record<string, unknown>, manifest as unknown as Record<string, unknown>);
        throw new Stop(2, `manifest mismatch in ${out}: existing ${existing.manifest_sha256}, this invocation ${manifestSha}; `
          + `first differing key: ${key ?? "(none)"}. A different --tasks selection changes the task list: use its own --output.`);
      }
      log(`resuming under manifest ${manifestSha}`);
    } else {
      mkdirSync(out, { recursive: true });
      const file: ManifestFile = {
        manifest_sha256: manifestSha,
        manifest,
        environment: {
          output: out, suite_path: suitePath, source_repo: sourceRepo, main_ref: mainRef, private_repo: privateRepo,
          private_ref: privateRef, audited_root: auditedRoot, ...(dietRoot ? { diet_root: dietRoot } : {}),
          controller_root: controller, tasks_filter: opts.tasks ?? null,
          user_config: oauthToken !== null ? "neutral" : "inherited", oauth_token: oauthToken !== null ? "present" : "absent",
          created_at: new Date().toISOString(),
        },
      };
      writeFileAtomic(manifestPath, JSON.stringify(file, null, 2) + "\n");
      log(`manifest ${manifestSha} -> ${manifestPath}`);
    }
    manifestWritten = manifestPath;
    if (opts.prepareOnly) return { exitCode: 0, manifestPath, reportPath: null };

    const ctx: RunContext = {
      out, suitePath, suite: selected, suiteHash, manifest, manifestSha, cfg, sourceRepo, controller, privateRepo, auditedRoot, dietRoot,
      noNpmCi: !!opts.noNpmCi, snapshots, claudeHome, oauthToken, userConfigRoot: oauthToken !== null ? claudeHome : null, log,
    };
    for (const task of selected.tasks) {
      const taskRuns: EfficiencyRun[] = [];
      const reps = Array.from({ length: opts.runs }, (_, index) => index + 1);
      for (let index = 0; index < reps.length; index++) {
        const rep = reps[index]!;
        for (const arm of armOrder(opts.seed, task.id, rep, arms)) {
          const run = await executeRun(ctx, task, rep, arm);
          if (run === "stop") return { exitCode: 3, manifestPath, reportPath: null };
          taskRuns.push(run);
        }
        if (rep === opts.runs && needsTieBreak(taskRuns, arms, opts.runs)) {
          log(`${task.id}: arms disagree on success across reps; adding tie-break rep ${opts.runs + 1}`);
          reps.push(opts.runs + 1);
        }
      }
    }
    return { exitCode: 0, manifestPath, reportPath: writeReport(out, selected, manifestSha, arms, log) };
  } catch (error) {
    if (error instanceof Stop) {
      log(`hunch task benchmark: ${error.message}`);
      return { exitCode: error.exitCode, manifestPath: manifestWritten, reportPath: null };
    }
    log(`hunch task benchmark: ${(error as Error).stack ?? String(error)}`);
    return { exitCode: 1, manifestPath: manifestWritten, reportPath: null };
  } finally {
    removeSignalHandlers?.();
  }
}
