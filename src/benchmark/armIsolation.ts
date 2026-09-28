// Arm isolation for `hunch task benchmark`: the rewritten target repository and
// each arm's exposure to Hunch, proven before the timer starts.
// Design: bench/pilot5/GATE-A-HARNESS.md, sections "Target repository" and "Arm exposure".
import { spawn, spawnSync, type ChildProcess, type SpawnSyncReturns } from "node:child_process";
import { createHash } from "node:crypto";
import { cpSync, existsSync, mkdirSync, readdirSync, readFileSync, rmSync, statSync, writeFileSync } from "node:fs";
import { basename, dirname, join, resolve } from "node:path";
import { pathToFileURL } from "node:url";
import crossSpawn from "cross-spawn";
import { writeFileAtomic } from "../core/io.js";
import {
  BENCHMARK_GIT_CONFIG,
  benchmarkChildEnv,
  benchmarkGit,
  benchmarkGitText,
  hashFileList,
  hashTree,
} from "./memorySnapshot.js";
import type { BenchmarkArm, ExposureProof, PreparedArm } from "./types.js";

const HUNCH_START = "<!-- HUNCH:START";
const HUNCH_END = "<!-- HUNCH:END -->";
const GENERATED_COMMAND_MARKER = "hunch:generated";
/** User-owned agent-surface dirs that can carry hand-written Hunch mentions the
 *  generated-command marker doesn't cover (skills, agents, Cursor/Codex rules). */
const AGENT_SURFACE_DIRS = [".claude/commands", ".claude/skills", ".claude/agents", ".cursor/rules", ".codex", ".agents"];
const HOOK_EVENTS_REQUIRED = ["SessionStart", "UserPromptSubmit", "PreToolUse"] as const;
const MAX_CHILD_OUTPUT = 256 * 1024 * 1024;
const AUDITED_CLI_TIMEOUT_MS = 30 * 60_000;
const RM_OPTIONS = { recursive: true, force: true, maxRetries: 10, retryDelay: 100 } as const;

export interface TaskBaseProof {
  tree_equal: boolean;
  hunch_history_empty: boolean;
  source_tree_sha256: string;
}

export interface TaskBase {
  base: string;
  head: string;
  proof: TaskBaseProof;
}

/** `<dest>/../<basename>.proof.json`: the map from starting commit to rewritten head. */
interface TaskBaseProofFile extends TaskBaseProof {
  schema: "hunch.benchmark-task-base/1";
  starting_commit: string;
  head: string;
}

type ExposureCheck = ExposureProof["checks"][number];

function sha256(data: string | Buffer): string {
  return createHash("sha256").update(data).digest("hex");
}

function isHunchPath(path: string): boolean {
  return path === ".hunch" || path.startsWith(".hunch/");
}

/** `git ls-tree -r -z` entries of `rev`, as byte-preserving latin1 strings. */
function treeEntries(repo: string, rev: string): string[] {
  return benchmarkGit(["-C", repo, "ls-tree", "-r", "-z", rev]).stdout.toString("latin1").split("\0").filter((e) => e !== "");
}

function entryPath(entry: string): string {
  return entry.slice(entry.indexOf("\t") + 1);
}

/** Hash of a listing in exactly the bytes `ls-tree -r -z` prints (NUL-terminated entries). */
function listingHash(entries: string[]): string {
  return sha256(Buffer.from(entries.map((e) => `${e}\0`).join(""), "latin1"));
}

function waitForExit(child: ChildProcess): Promise<number | null> {
  return new Promise((resolveExit, reject) => {
    child.on("error", reject);
    child.on("close", (code) => resolveExit(code));
  });
}

/** Stream `git fast-export` of the scratch repo (minus `.hunch/`) into
 *  `git fast-import` of dest: two processes joined by a pipe, no shell. */
async function pipeFastExport(scratch: string, dest: string): Promise<void> {
  const env = benchmarkChildEnv();
  const exporter = spawn("git", [
    ...BENCHMARK_GIT_CONFIG, "-C", scratch, "fast-export", "--signed-tags=strip", "--tag-of-filtered-object=drop",
    "refs/heads/start", "--", ".", ":(exclude).hunch",
  ], { env, stdio: ["ignore", "pipe", "pipe"], shell: false, windowsHide: true });
  const importer = spawn("git", [...BENCHMARK_GIT_CONFIG, "-C", dest, "fast-import", "--quiet"], {
    env, stdio: ["pipe", "ignore", "pipe"], shell: false, windowsHide: true,
  });
  let exportErr = "";
  let importErr = "";
  exporter.stderr!.on("data", (chunk: Buffer) => { exportErr += chunk.toString("utf8"); });
  importer.stderr!.on("data", (chunk: Buffer) => { importErr += chunk.toString("utf8"); });
  // A dead importer must not leave the exporter blocked on a full pipe; its
  // failure is reported through the exit codes below.
  importer.stdin!.on("error", () => exporter.kill());
  importer.on("close", (code) => { if (code !== 0) exporter.kill(); });
  exporter.stdout!.pipe(importer.stdin!);
  const [exportCode, importCode] = await Promise.all([waitForExit(exporter), waitForExit(importer)]);
  if (exportCode !== 0 || importCode !== 0) {
    throw new Error(`fast-export | fast-import failed (export exit ${exportCode}, import exit ${importCode}): ${`${exportErr}\n${importErr}`.trim()}`);
  }
}

function reuseTaskBase(dest: string, proofPath: string, startingCommit: string): TaskBase | null {
  if (!existsSync(proofPath) || !existsSync(dest)) return null;
  let record: Partial<TaskBaseProofFile>;
  try {
    record = JSON.parse(readFileSync(proofPath, "utf8")) as Partial<TaskBaseProofFile>;
  } catch {
    return null;
  }
  if (record.tree_equal !== true || record.hunch_history_empty !== true || record.starting_commit !== startingCommit
    || typeof record.head !== "string" || typeof record.source_tree_sha256 !== "string") return null;
  const head = benchmarkGit(["-C", dest, "rev-parse", "HEAD"], { allowFailure: true });
  if (head.status !== 0 || head.stdout.toString("utf8").trim() !== record.head) return null;
  return {
    base: dest,
    head: record.head,
    proof: { tree_equal: true, hunch_history_empty: true, source_tree_sha256: record.source_tree_sha256 },
  };
}

/**
 * Rebuild `startingCommit` into `dest` without `.hunch/` anywhere in its history
 * (a worktree of the source would expose future commits through `git log --all`,
 * and the starting commit's own `.hunch/` holds records written after the issue).
 * Proven by an equal tree listing (minus `.hunch/`) and an empty `.hunch` history;
 * the proof is written beside dest and a passing proof is reused on re-call.
 * Throws when the proof fails.
 */
export async function prepareTaskBase(opts: { sourceRepo: string; startingCommit: string; dest: string }): Promise<TaskBase> {
  const dest = resolve(opts.dest);
  const sourceRepo = resolve(opts.sourceRepo);
  const proofPath = join(dirname(dest), `${basename(dest)}.proof.json`);
  const startingCommit = benchmarkGitText(["-C", sourceRepo, "rev-parse", "--verify", `${opts.startingCommit}^{commit}`]);
  const reused = reuseTaskBase(dest, proofPath, startingCommit);
  if (reused) return reused;
  if (existsSync(dest)) throw new Error(`refusing to rebuild the task base into existing ${dest} without a passing proof; remove it first`);

  const scratch = `${dest}.src`;
  rmSync(scratch, RM_OPTIONS);
  try {
    benchmarkGit(["init", "-q", "--bare", scratch]);
    benchmarkGit(["-C", scratch, "fetch", "-q", "--no-tags", sourceRepo, `${startingCommit}:refs/heads/start`]);
    benchmarkGit(["init", "-q", dest]);
    await pipeFastExport(scratch, dest);
    benchmarkGit(["-C", dest, "checkout", "-q", "start"]);
  } finally {
    rmSync(scratch, RM_OPTIONS);
  }

  const source_tree_sha256 = listingHash(treeEntries(sourceRepo, startingCommit).filter((e) => !isHunchPath(entryPath(e))));
  const head = benchmarkGitText(["-C", dest, "rev-parse", "HEAD"]);
  const tree_equal = listingHash(treeEntries(dest, "HEAD")) === source_tree_sha256;
  const hunch_history_empty = benchmarkGitText(["-C", dest, "log", "--all", "--oneline", "--", ".hunch"]) === "";
  const record: TaskBaseProofFile = {
    schema: "hunch.benchmark-task-base/1",
    starting_commit: startingCommit,
    head,
    tree_equal,
    hunch_history_empty,
    source_tree_sha256,
  };
  writeFileAtomic(proofPath, JSON.stringify(record, null, 2) + "\n");
  if (!tree_equal || !hunch_history_empty) {
    throw new Error(`task base proof failed for ${startingCommit}: tree_equal=${tree_equal} hunch_history_empty=${hunch_history_empty} (see ${proofPath})`);
  }
  return { base: dest, head, proof: { tree_equal, hunch_history_empty, source_tree_sha256 } };
}

/** Trailing newline run (`\n` or `\r\n` units) of `s`. */
function trailingNewlines(s: string): string {
  let i = s.length;
  while (i > 0 && s[i - 1] === "\n") {
    i--;
    if (i > 0 && s[i - 1] === "\r") i--;
  }
  return s.slice(i);
}

/** Leading newline run (`\n` or `\r\n` units) of `s`. */
function leadingNewlines(s: string): string {
  let i = 0;
  for (;;) {
    if (s[i] === "\n") i++;
    else if (s[i] === "\r" && s[i + 1] === "\n") i += 2;
    else break;
  }
  return s.slice(0, i);
}

/** Remove every HUNCH:START … HUNCH:END block, whole lines inclusive. A run of 3+
 *  newlines created at a cut collapses to exactly 2 (in the file's own EOL); every
 *  other byte is unchanged. Operates on latin1 text so arbitrary bytes round-trip. */
export function removeHunchBlocks(text: string): string {
  let out = text;
  for (let start = out.indexOf(HUNCH_START); start !== -1; start = out.indexOf(HUNCH_START)) {
    const end = out.indexOf(HUNCH_END, start);
    if (end === -1) throw new Error(`unterminated ${HUNCH_START} block (no ${HUNCH_END})`);
    const lineStart = out.lastIndexOf("\n", start - 1) + 1;
    const newline = out.indexOf("\n", end + HUNCH_END.length);
    const lineEnd = newline === -1 ? out.length : newline + 1;
    const before = out.slice(0, lineStart);
    const after = out.slice(lineEnd);
    const beforeRun = trailingNewlines(before);
    const afterRun = leadingNewlines(after);
    const run = beforeRun + afterRun;
    if (run.split("\n").length - 1 >= 3) {
      const eol = run.includes("\r\n") ? "\r\n" : "\n";
      out = before.slice(0, before.length - beforeRun.length) + eol + eol + after.slice(afterRun.length);
    } else {
      out = before + after;
    }
  }
  return out;
}

/** Tracked text files containing a HUNCH:START marker (repo-relative). */
function markerFiles(repo: string): string[] {
  const grep = benchmarkGit(["-C", repo, "grep", "-I", "-l", "-z", "-F", HUNCH_START], { allowFailure: true });
  if (grep.status !== 0 && grep.status !== 1) throw new Error(`git grep failed in ${repo} (exit ${grep.status}): ${grep.stderr.trim()}`);
  return grep.stdout.toString("utf8").split("\0").filter((p) => p !== "");
}

/** `.claude/commands/*.md` files carrying the generated-command marker (repo-relative). */
function generatedCommandFiles(repo: string): string[] {
  const dir = join(repo, ".claude", "commands");
  if (!existsSync(dir)) return [];
  return readdirSync(dir, { withFileTypes: true })
    .filter((e) => e.isFile() && e.name.endsWith(".md") && readFileSync(join(dir, e.name), "utf8").includes(GENERATED_COMMAND_MARKER))
    .map((e) => `.claude/commands/${e.name}`)
    .sort();
}

/** Repo-relative (forward-slash) paths of every file under `dir`, recursing. */
function listFilesUnder(dir: string): string[] {
  if (!existsSync(dir)) return [];
  const out: string[] = [];
  for (const entry of readdirSync(dir, { withFileTypes: true })) {
    const abs = join(dir, entry.name);
    if (entry.isDirectory()) out.push(...listFilesUnder(abs));
    else if (entry.isFile()) out.push(abs);
  }
  return out;
}

/** True when `rel`'s path or file content matches /hunch/i. */
function matchesHunch(repo: string, rel: string): boolean {
  if (/hunch/i.test(rel)) return true;
  try {
    return /hunch/i.test(readFileSync(join(repo, rel), "utf8"));
  } catch {
    return false;
  }
}

/** Tracked files under the agent-surface dirs whose path or content matches
 *  /hunch/i (repo-relative, sorted) — deleted in the no-hunch arm. */
function trackedAgentSurfaceHunchFiles(repo: string): string[] {
  const tracked = benchmarkGit(["-C", repo, "ls-files", "-z", "--", ...AGENT_SURFACE_DIRS]).stdout.toString("utf8")
    .split("\0").filter((p) => p !== "");
  return tracked.filter((rel) => matchesHunch(repo, rel)).sort();
}

/** Every file (tracked or not) under the agent-surface dirs whose path or content
 *  matches /hunch/i (repo-relative, sorted) — the no-hunch exposure check. */
function agentSurfaceHunchFiles(repo: string): string[] {
  const offenders: string[] = [];
  for (const dir of AGENT_SURFACE_DIRS) {
    for (const abs of listFilesUnder(join(repo, dir))) {
      const rel = abs.slice(repo.length + 1).replace(/\\/g, "/");
      if (matchesHunch(repo, rel)) offenders.push(rel);
    }
  }
  return offenders.sort();
}

function stripHunchExposure(repo: string): void {
  for (const rel of markerFiles(repo)) {
    const file = join(repo, rel);
    writeFileSync(file, Buffer.from(removeHunchBlocks(readFileSync(file).toString("latin1")), "latin1"));
  }
  for (const rel of generatedCommandFiles(repo)) rmSync(join(repo, rel), { force: true });
  for (const rel of trackedAgentSurfaceHunchFiles(repo)) rmSync(join(repo, rel), { force: true });
  if (existsSync(join(repo, ".hunch"))) throw new Error(`no-hunch arm: ${join(repo, ".hunch")} exists in the rewritten base`);
}

/** Characters (code points) of every HUNCH:START … HUNCH:END block in `file`; 0 when absent. */
function hunchBlockChars(file: string): number {
  if (!existsSync(file)) return 0;
  const text = readFileSync(file, "utf8");
  let chars = 0;
  for (let start = text.indexOf(HUNCH_START); start !== -1;) {
    const end = text.indexOf(HUNCH_END, start);
    const stop = end === -1 ? text.length : end + HUNCH_END.length;
    chars += [...text.slice(start, stop)].length;
    start = text.indexOf(HUNCH_START, stop);
  }
  return chars;
}

/** The private part lives outside the repository, one copy per run, so a hook or
 *  MCP write during a run can never alter the frozen snapshot. */
function mountPrivateSnapshot(privateDir: string, runDir: string): string {
  const mounted = join(runDir, "private", ".hunch");
  if (resolve(privateDir) !== resolve(mounted)) cpSync(privateDir, mounted, { recursive: true });
  return mounted;
}

function childFailure(run: SpawnSyncReturns<string>): string {
  return (run.error?.message ?? String(run.stderr ?? "")).trim();
}

/** `mcp.tools_list` chars from `hunch footprint --json`, or why it is unavailable. */
function toolsListChars(run: SpawnSyncReturns<string>): { chars: number } | { error: string } {
  if (run.error || run.status !== 0) return { error: `footprint --json exit ${run.status}: ${childFailure(run)}` };
  try {
    const parsed = JSON.parse(String(run.stdout)) as { surfaces?: Array<{ id?: unknown; chars?: unknown }> };
    const surface = Array.isArray(parsed.surfaces) ? parsed.surfaces.find((s) => s?.id === "mcp.tools_list") : undefined;
    if (surface && typeof surface.chars === "number") return { chars: surface.chars };
    return { error: "footprint --json has no mcp.tools_list surface" };
  } catch (error) {
    return { error: `footprint --json is not JSON: ${(error as Error).message}` };
  }
}

function runNpmCi(repo: string, env: Record<string, string>): void {
  const run = crossSpawn.sync("npm", ["ci", "--no-audit", "--no-fund"], {
    cwd: repo, env: benchmarkChildEnv(env), encoding: "utf8", maxBuffer: MAX_CHILD_OUTPUT, windowsHide: true,
  });
  if (run.error || run.status !== 0) {
    throw new Error(`npm ci failed in ${repo} (exit ${run.status}): ${(run.error?.message ?? String(run.stderr ?? "")).trim()}`);
  }
}

interface AuditedScaffold {
  installClaudeHooks?: (root: string, hookCmd: string) => unknown;
  writeSlashCommands?: (root: string) => unknown;
}

export interface PrepareArmOptions {
  base: string;
  arm: BenchmarkArm;
  runDir: string;
  /** Node executable for the audited CLI, hook and MCP server (default: this process). */
  nodePath?: string;
  /** The stripped child environment; GIT_* and HUNCH_* are removed again for setup commands. */
  env: Record<string, string>;
  /** Frozen snapshot dirs and the hashes recorded for them in snapshot.json. */
  snapshot?: { publicDir: string; privateDir: string | null; publicSha256: string; privateSha256: string | null };
  /** The Hunch checkout the arm installs from: the audited root for current-hunch, the diet root for diet-hunch. */
  audited?: { root: string };
  npmCi?: boolean;
}

/**
 * Clone the rewritten base into `<runDir>/repo` and expose exactly one arm:
 * `no-hunch` strips every Hunch marker block and generated command; `current-hunch`
 * mounts the memory snapshot and installs hooks, commands, grounding and index
 * from the audited dist; `diet-hunch` does exactly the same from the diet root (passed
 * as `audited`). One `bench: arm setup` commit leaves a clean tree, and the
 * exposure proof is taken before the caller starts any timer.
 */
export async function prepareArm(opts: PrepareArmOptions): Promise<PreparedArm> {
  if (opts.arm !== "no-hunch" && opts.arm !== "current-hunch" && opts.arm !== "diet-hunch") {
    throw new Error(`arm ${opts.arm} is not supported by prepareArm yet`);
  }
  const runDir = resolve(opts.runDir);
  const repo = join(runDir, "repo");
  const nodePath = opts.nodePath ?? process.execPath;
  mkdirSync(runDir, { recursive: true });
  benchmarkGit(["clone", "-q", "--no-local", "--no-tags", resolve(opts.base), repo]);
  benchmarkGit(["-C", repo, "remote", "remove", "origin"]);
  const hooksDir = join(runDir, "empty-hooks");
  mkdirSync(hooksDir, { recursive: true });
  const config: Array<[string, string]> = [
    ["core.hooksPath", hooksDir],
    ["user.name", "hunch-benchmark"],
    ["user.email", "benchmark@hunch.invalid"],
    ["commit.gpgsign", "false"],
  ];
  for (const [key, value] of config) benchmarkGit(["-C", repo, "config", key, value]);

  const staticChars: Record<string, number> = {};
  const setupChecks: ExposureCheck[] = [];
  let armEnv: Record<string, string> = {};
  let mcpConfig: { mcpServers: Record<string, unknown> } = { mcpServers: {} };
  let hookCmd: string | undefined;

  if (opts.arm === "no-hunch") {
    stripHunchExposure(repo);
  } else {
    if (!opts.snapshot || !opts.audited) throw new Error(`the ${opts.arm} arm needs a memory snapshot and an audited Hunch root`);
    const auditedRoot = resolve(opts.audited.root);
    const auditedCli = join(auditedRoot, "dist", "cli", "index.js");
    hookCmd = `"${nodePath}" "${auditedCli}" hook`;
    const { publicDir, privateDir, publicSha256, privateSha256 } = opts.snapshot;
    cpSync(publicDir, join(repo, ".hunch"), { recursive: true });
    // Checked before any audited writer runs: `hunch index` legitimately rewrites components/.
    const frozen = hashTree(publicDir);
    const mounted = hashTree(join(repo, ".hunch"));
    setupChecks.push({
      id: "snapshot-hash-match",
      ok: frozen.sha256 === publicSha256 && mounted.sha256 === publicSha256,
      detail: `snapshot dir ${frozen.sha256} (${frozen.files} files), mounted .hunch ${mounted.sha256} (${mounted.files} files) vs frozen ${publicSha256}`,
    });
    if (privateDir) {
      const privateMount = mountPrivateSnapshot(privateDir, runDir);
      armEnv = { HUNCH_PRIVATE_DIR: privateMount };
      const mountedPrivate = hashTree(privateMount);
      setupChecks.push({
        id: "private-snapshot-hash-match",
        ok: mountedPrivate.sha256 === privateSha256,
        detail: `mounted private ${mountedPrivate.sha256} (${mountedPrivate.files} files) vs frozen ${privateSha256 ?? "none"}`,
      });
    }

    const scaffold = await import(pathToFileURL(join(auditedRoot, "dist", "integrations", "scaffold.js")).href) as AuditedScaffold;
    if (typeof scaffold.installClaudeHooks !== "function" || typeof scaffold.writeSlashCommands !== "function") {
      throw new Error(`audited ${auditedRoot} does not export installClaudeHooks and writeSlashCommands from dist/integrations/scaffold.js`);
    }
    scaffold.installClaudeHooks(repo, hookCmd);
    scaffold.writeSlashCommands(repo);

    const cliEnv = benchmarkChildEnv(opts.env, armEnv);
    const cli = (args: string[]): SpawnSyncReturns<string> => spawnSync(nodePath, [auditedCli, ...args], {
      cwd: repo, env: cliEnv, encoding: "utf8", maxBuffer: MAX_CHILD_OUTPUT, timeout: AUDITED_CLI_TIMEOUT_MS, shell: false, windowsHide: true,
    });
    for (const args of [["grounding", "--refresh"], ["index"]]) {
      const run = cli(args);
      if (run.error || run.status !== 0) throw new Error(`audited hunch ${args.join(" ")} failed (exit ${run.status}): ${childFailure(run)}`);
    }
    const toolsList = toolsListChars(cli(["footprint", "--json"]));
    if ("chars" in toolsList) staticChars.tools_list = toolsList.chars;
    setupChecks.push({
      id: "footprint-tools-list",
      ok: "chars" in toolsList,
      detail: "chars" in toolsList ? `mcp.tools_list ${toolsList.chars} chars` : toolsList.error,
    });
    mcpConfig = { mcpServers: { hunch: { type: "stdio", command: nodePath, args: [auditedCli, "mcp", "--root", repo], env: armEnv } } };
    // A `hunch init` user has a repo .mcp.json; without one the audited SessionStart hook injects an
    // "integration needs attention" warning. The child still loads only mcp.json (--strict-mcp-config).
    writeFileAtomic(join(repo, ".mcp.json"), JSON.stringify(mcpConfig, null, 2) + "\n");
  }
  staticChars.grounding_claude_md = hunchBlockChars(join(repo, "CLAUDE.md"));
  staticChars.grounding_agents_md = hunchBlockChars(join(repo, "AGENTS.md"));

  benchmarkGit(["-C", repo, "add", "-A"]);
  benchmarkGit(["-C", repo, "commit", "-q", "--allow-empty", "-m", "bench: arm setup"]);
  if (opts.npmCi ?? true) runNpmCi(repo, opts.env);

  const mcpConfigPath = join(runDir, "mcp.json");
  writeFileAtomic(mcpConfigPath, JSON.stringify(mcpConfig, null, 2) + "\n");
  const exposure = proveExposure({ arm: opts.arm, repo, mcpConfigPath, env: { ...opts.env, ...armEnv }, hookCmd });
  if (opts.arm !== "no-hunch") exposure.memory_snapshot_sha256 = opts.snapshot?.publicSha256 ?? null;
  if (setupChecks.length) {
    exposure.checks.push(...setupChecks);
    exposure.ok = exposure.checks.every((c) => c.ok);
  }
  return { arm: opts.arm, repo, mcp_config_path: mcpConfigPath, env: armEnv, static_hunch_chars: staticChars, exposure };
}

function readJsonObject(file: string): { value: Record<string, unknown> | null; error: string | null } {
  if (!existsSync(file)) return { value: null, error: null };
  try {
    const parsed = JSON.parse(readFileSync(file, "utf8")) as unknown;
    if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) return { value: null, error: "not a JSON object" };
    return { value: parsed as Record<string, unknown>, error: null };
  } catch (error) {
    return { value: null, error: (error as Error).message };
  }
}

/** Every hook command string under one settings.json hooks event. */
function hookCommands(entries: unknown): string[] {
  if (!Array.isArray(entries)) return [];
  return entries.flatMap((entry) => {
    const hooks = (entry as { hooks?: unknown } | null)?.hooks;
    return Array.isArray(hooks) ? hooks.map((h) => (h as { command?: unknown } | null)?.command).filter((c): c is string => typeof c === "string") : [];
  });
}

function mcpServers(mcpConfigPath: string): { servers: Record<string, unknown> | null; error: string | null } {
  const { value, error } = readJsonObject(mcpConfigPath);
  if (!value) return { servers: null, error: error ?? "missing" };
  const servers = value.mcpServers;
  if (!servers || typeof servers !== "object" || Array.isArray(servers)) return { servers: null, error: "mcpServers is not an object" };
  return { servers: servers as Record<string, unknown>, error: null };
}

/** Hash of the tracked `.hunch/` files at HEAD, in the snapshot's hashTree format. */
function trackedHunchHash(repo: string): { sha256: string; files: number } {
  const tracked = benchmarkGit(["-C", repo, "ls-files", "-z", "--", ".hunch"]).stdout.toString("utf8")
    .split("\0").filter((p) => p.startsWith(".hunch/")).map((p) => p.slice(".hunch/".length));
  return hashFileList(join(repo, ".hunch"), tracked);
}

/** Deterministic checks that the arm exposes exactly what it should, taken
 *  before the timer. `env` is the child's environment (only key names are read). */
export function proveExposure(p: {
  arm: BenchmarkArm;
  repo: string;
  mcpConfigPath: string;
  env: Record<string, string>;
  hookCmd?: string;
}): ExposureProof {
  const checks: ExposureCheck[] = [];
  const check = (id: string, ok: boolean, detail: string) => checks.push({ id, ok, detail });
  const status = benchmarkGit(["-C", p.repo, "status", "--porcelain", "--untracked-files=normal"]).stdout.toString("utf8").trim();
  const settings = readJsonObject(join(p.repo, ".claude", "settings.json"));
  const hooks = settings.value?.hooks && typeof settings.value.hooks === "object" && !Array.isArray(settings.value.hooks)
    ? settings.value.hooks as Record<string, unknown>
    : {};
  const { servers, error: mcpError } = mcpServers(p.mcpConfigPath);
  let postSetupHunchSha256: string | null = null;

  if (p.arm === "no-hunch") {
    const markers = markerFiles(p.repo);
    check("markers-absent", markers.length === 0, markers.length ? `HUNCH:START in ${markers.join(", ")}` : "no HUNCH:START marker in tracked files");
    const commands = generatedCommandFiles(p.repo);
    check("generated-commands-absent", commands.length === 0, commands.length ? `generated commands: ${commands.join(", ")}` : "no hunch:generated command");
    check("hunch-dir-absent", !existsSync(join(p.repo, ".hunch")), existsSync(join(p.repo, ".hunch")) ? ".hunch/ exists" : "no .hunch/");
    const history = benchmarkGitText(["-C", p.repo, "log", "--all", "--oneline", "--", ".hunch"]);
    check("hunch-history-empty", history === "", history ? `.hunch history: ${history.split("\n").length} commit(s)` : "no .hunch history");
    const serverNames = servers ? Object.keys(servers) : [];
    check("mcp-empty", !!servers && serverNames.length === 0, servers ? `${serverNames.length} MCP server(s)${serverNames.length ? `: ${serverNames.join(", ")}` : ""}` : `mcp config unreadable: ${mcpError}`);
    check("repo-mcp-json-absent", !existsSync(join(p.repo, ".mcp.json")), existsSync(join(p.repo, ".mcp.json")) ? ".mcp.json present" : "no .mcp.json");
    const hunchHooks = Object.entries(hooks).flatMap(([event, entries]) => hookCommands(entries).filter((c) => /hunch/i.test(c)).map(() => event));
    const hooksOk = !settings.error && hunchHooks.length === 0;
    check("hooks-absent", hooksOk, settings.error
      ? `.claude/settings.json unreadable: ${settings.error}`
      : settings.value ? (hunchHooks.length ? `hunch hook commands on ${[...new Set(hunchHooks)].join(", ")}` : "no hunch hook command") : "no .claude/settings.json");
    const hunchKeys = Object.keys(p.env).filter((k) => k.toUpperCase().startsWith("HUNCH_"));
    check("env-clean", hunchKeys.length === 0, hunchKeys.length ? `HUNCH_* keys: ${hunchKeys.join(", ")}` : "no HUNCH_* key");
    const surfaceOffenders = agentSurfaceHunchFiles(p.repo);
    check("agent-surfaces-clean", surfaceOffenders.length === 0, surfaceOffenders.length
      ? `hunch-matching agent surface files: ${surfaceOffenders.join(", ")}`
      : "no hunch-matching file under agent surface dirs");
  } else {
    const hunchDir = join(p.repo, ".hunch");
    const present = existsSync(hunchDir) && statSync(hunchDir).isDirectory();
    check("hunch-dir-present", present, present ? ".hunch/ present" : "no .hunch/ directory");
    postSetupHunchSha256 = trackedHunchHash(p.repo).sha256;
    const hunch = servers?.hunch as { command?: unknown; args?: unknown } | undefined;
    const args = Array.isArray(hunch?.args) ? hunch.args.filter((a): a is string => typeof a === "string") : [];
    const rootArg = args[args.indexOf("--root") + 1];
    const serverOk = !!servers && Object.keys(servers).length === 1 && !!hunch && typeof hunch.command === "string"
      && args.includes("mcp") && args.includes("--root") && rootArg !== undefined && resolve(rootArg) === resolve(p.repo);
    check("mcp-hunch-server", serverOk, servers ? `servers: ${Object.keys(servers).join(", ") || "none"}; hunch args: ${JSON.stringify(args)}` : `mcp config unreadable: ${mcpError}`);
    const repoMcp = readJsonObject(join(p.repo, ".mcp.json"));
    const repoServers = repoMcp.value?.mcpServers as Record<string, unknown> | undefined;
    const repoMcpOk = !!repoServers && Object.keys(repoServers).length === 1 && !!hunch
      && JSON.stringify(repoServers.hunch) === JSON.stringify(hunch);
    check("repo-mcp-json-matches", repoMcpOk, repoMcp.error
      ? `.mcp.json unreadable: ${repoMcp.error}`
      : repoMcp.value ? (repoMcpOk ? ".mcp.json has the same single hunch server as the child MCP config" : ".mcp.json differs from the child MCP config") : "no .mcp.json");
    const missing = HOOK_EVENTS_REQUIRED.filter((event) => !p.hookCmd || !hookCommands(hooks[event]).includes(p.hookCmd));
    check("hooks-installed", !settings.error && !!settings.value && missing.length === 0,
      settings.error ? `.claude/settings.json unreadable: ${settings.error}` : missing.length ? `hook command missing on ${missing.join(", ")}` : `hook command on ${HOOK_EVENTS_REQUIRED.join(", ")}`);
    const claudeMd = join(p.repo, "CLAUDE.md");
    const grounded = existsSync(claudeMd) && readFileSync(claudeMd, "utf8").includes(HUNCH_START);
    check("grounding-present", grounded, grounded ? "CLAUDE.md has a HUNCH block" : "CLAUDE.md has no HUNCH block");
  }
  check("worktree-clean", status === "", status ? `git status: ${status.split("\n").length} entr(ies)` : "clean");
  return { arm: p.arm, ok: checks.every((c) => c.ok), checks, memory_snapshot_sha256: null, post_setup_hunch_sha256: postSetupHunchSha256 };
}

/** HEAD and `git status --porcelain` per path (both null when not a repository),
 *  taken before and after each run to detect writes outside the run directory. */
export function repoStateFingerprint(paths: string[]): Record<string, { head: string | null; status: string | null }> {
  const out: Record<string, { head: string | null; status: string | null }> = {};
  for (const path of paths) {
    const inside = existsSync(path)
      ? benchmarkGit(["-C", path, "rev-parse", "--is-inside-work-tree"], { allowFailure: true })
      : null;
    if (!inside || inside.status !== 0) {
      out[path] = { head: null, status: null };
      continue;
    }
    const head = benchmarkGit(["-C", path, "rev-parse", "--verify", "-q", "HEAD"], { allowFailure: true });
    const status = benchmarkGit(["-C", path, "status", "--porcelain", "--untracked-files=normal"], { allowFailure: true });
    out[path] = {
      head: head.status === 0 ? head.stdout.toString("utf8").trim() : null,
      status: status.status === 0 ? status.stdout.toString("utf8") : null,
    };
  }
  return out;
}
