// Gate A v5 precondition 1: recheck every transcript of an earlier gate's output with the confinement rule of a given
// harness checkout, using each run's own deny roots and commands, exactly as the harness's post-run check does
// (orchestrate.ts: armConfinement -> toolInputStrings -> isOutOfRepoAccess(value, denyRoots, [runDir], commands,
// home, !content, shell)).
//
// Usage (from any directory; tsx resolves the harness's TypeScript):
//   npx tsx gate-a5-confinement-replay.mts --out C:/bench-out/pilot5-gate-a4 --harness <feat/task-benchmark checkout>
//     [--expect-clear continuation-375/1-current-hunch]...   runs that must no longer flag (e.g. the DEVIATIONS (k) run)
//     [--explained <file.json>]    {"<task>/<run dir>": "reason"} for flags a human has read and explained
//     [--claude-home <dir>]        neutral mode's user config root (default <home>/.claude, as the harness)
//     [--home <dir>]               home directory used for ~ / $HOME tokens (default os.homedir(); use the run machine's)
//     [--report <file.json>]       where to write the full result (default <out>/confinement-replay-v5.json)
//
// Exit 0: zero unexplained flags and every --expect-clear run clear. Exit 1: otherwise. Exit 2: bad input.
// Read-only on <out> except for the report file.
import { existsSync, readdirSync, readFileSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { join, resolve } from "node:path";
import { pathToFileURL } from "node:url";
import { execFileSync } from "node:child_process";

function fail(msg: string): never {
  console.error(`gate-a5-confinement-replay: ${msg}`);
  process.exit(2);
}

const args = process.argv.slice(2);
const opt: { out?: string; harness?: string; explained?: string; claudeHome?: string; home?: string; report?: string; expectClear: string[] } = { expectClear: [] };
for (let i = 0; i < args.length; i++) {
  const key = args[i];
  const value = args[i + 1];
  if (value === undefined || value.startsWith("--")) fail(`${key} needs a value`);
  i++;
  if (key === "--out") opt.out = value;
  else if (key === "--harness") opt.harness = value;
  else if (key === "--explained") opt.explained = value;
  else if (key === "--claude-home") opt.claudeHome = value;
  else if (key === "--home") opt.home = value;
  else if (key === "--report") opt.report = value;
  else if (key === "--expect-clear") opt.expectClear.push(value.replace(/\\/g, "/"));
  else fail(`unknown option ${key}`);
}
if (!opt.out || !opt.harness) fail("--out and --harness are required");

const out = resolve(opt.out);
const harness = resolve(opt.harness);
const home = opt.home ?? homedir();
const orchestrateFile = join(harness, "src", "benchmark", "orchestrate.ts");
const transcriptFile = join(harness, "src", "benchmark", "transcript.ts");
if (!existsSync(orchestrateFile) || !existsSync(transcriptFile)) fail(`${harness} is not a harness checkout (no src/benchmark/orchestrate.ts)`);

const { armConfinement, isOutOfRepoAccess } = await import(pathToFileURL(orchestrateFile).href);
const { toolInputStrings } = await import(pathToFileURL(transcriptFile).href);
if (typeof armConfinement !== "function" || typeof isOutOfRepoAccess !== "function" || typeof toolInputStrings !== "function") {
  fail("the harness does not export armConfinement, isOutOfRepoAccess and toolInputStrings");
}

let harnessRevision = "unknown";
try {
  harnessRevision = execFileSync("git", ["-C", harness, "rev-parse", "HEAD"], { encoding: "utf8" }).trim();
  if (execFileSync("git", ["-C", harness, "status", "--porcelain", "--", "src"], { encoding: "utf8" }).trim()) harnessRevision += "+dirty";
} catch { /* not a git checkout: recorded as unknown */ }

const manifestPath = join(out, "manifest.json");
if (!existsSync(manifestPath)) fail(`${manifestPath} not found`);
const env = JSON.parse(readFileSync(manifestPath, "utf8"))?.environment;
if (!env || typeof env.source_repo !== "string" || typeof env.audited_root !== "string" || typeof env.controller_root !== "string") {
  fail(`${manifestPath} has no environment block with source_repo, audited_root and controller_root`);
}
const neutral = env.user_config === "neutral";
const roots = {
  sourceRepo: env.source_repo,
  privateRepo: env.private_repo ?? null,
  auditedRoot: env.audited_root,
  dietRoot: env.diet_root ?? null,
  controller: env.controller_root,
  out: env.output ?? out,
  userConfigRoot: neutral ? (opt.claudeHome ?? join(home, ".claude")) : null,
};

const explained: Record<string, string> = opt.explained ? JSON.parse(readFileSync(opt.explained, "utf8")) : {};

interface RunResult {
  run: string;
  arm: string;
  recorded_status: string | null;
  recorded_confinement_fail: boolean;
  flagged: boolean;
  offenders: string[];
  explanation: string | null;
}

const runsDir = join(out, "runs");
if (!existsSync(runsDir)) fail(`${runsDir} not found`);
const results: RunResult[] = [];
const skipped: string[] = [];
for (const task of readdirSync(runsDir, { withFileTypes: true }).filter((d) => d.isDirectory()).map((d) => d.name).sort()) {
  for (const runName of readdirSync(join(runsDir, task), { withFileTypes: true }).filter((d) => d.isDirectory()).map((d) => d.name).sort()) {
    const key = `${task}/${runName}`;
    const runDir = join(runsDir, task, runName);
    const transcript = join(runDir, "transcript.jsonl");
    // Run dirs are `<rep>-<arm>`, optionally with an `.interrupted-<n>` suffix; the arm decides the commands.
    const arm = /^\d+-(.+?)(?:\.interrupted-\d+)?$/.exec(runName)?.[1];
    if (!arm || !existsSync(transcript)) { skipped.push(`${key} (${!arm ? "unrecognised run dir name" : "no transcript.jsonl"})`); continue; }
    let recordedStatus: string | null = null;
    let recordedFail = false;
    const runJson = join(runDir, "run.json");
    if (existsSync(runJson)) {
      const run = JSON.parse(readFileSync(runJson, "utf8"));
      recordedStatus = run.status ?? null;
      recordedFail = (run.isolation_evidence ?? []).some((line: string) => line.startsWith("post no-out-of-repo-access: FAIL"));
    }
    const { denyRoots, commands } = armConfinement(arm, roots);
    const offenders = [...new Set((toolInputStrings(readFileSync(transcript, "utf8")) as Array<{ value: string; content: boolean; shell: boolean }>)
      .filter(({ value, content, shell }) => isOutOfRepoAccess(value, denyRoots, [runDir], commands, home, !content, shell))
      .map(({ value }) => value))];
    results.push({
      run: key, arm, recorded_status: recordedStatus, recorded_confinement_fail: recordedFail,
      flagged: offenders.length > 0, offenders, explanation: offenders.length ? (explained[key] ?? null) : null,
    });
  }
}

const unexplained = results.filter((r) => r.flagged && r.explanation === null);
const expectClear = opt.expectClear.map((key) => {
  const hit = results.find((r) => r.run === key);
  return { run: key, found: !!hit, clear: !!hit && !hit.flagged };
});
const pass = unexplained.length === 0 && expectClear.every((e) => e.clear);

const report = {
  schema: "hunch.gate-a5-confinement-replay/1",
  created_at: new Date().toISOString(),
  out, harness, harness_revision: harnessRevision, home, roots,
  runs_checked: results.length, skipped,
  recorded_flags: results.filter((r) => r.recorded_confinement_fail).length,
  replay_flags: results.filter((r) => r.flagged).length,
  unexplained_flags: unexplained.length,
  expect_clear: expectClear,
  verdict: pass ? "PASS" : "FAIL",
  runs: results,
};
const reportPath = resolve(opt.report ?? join(out, "confinement-replay-v5.json"));
writeFileSync(reportPath, JSON.stringify(report, null, 2) + "\n");

console.log(`harness ${harnessRevision}; ${results.length} run(s) checked, ${skipped.length} skipped`);
for (const r of results.filter((x) => x.flagged || x.recorded_confinement_fail)) {
  const now = r.flagged ? (r.explanation ? `FLAG (explained: ${r.explanation})` : "FLAG (unexplained)") : "clear";
  console.log(`  ${r.run}: recorded ${r.recorded_confinement_fail ? "FAIL" : "ok"} -> replay ${now}`);
  for (const s of r.offenders.slice(0, 3)) console.log(`    ${s.slice(0, 200)}`);
}
for (const e of expectClear) console.log(`  expect-clear ${e.run}: ${!e.found ? "NOT FOUND" : e.clear ? "clear" : "STILL FLAGGED"}`);
for (const s of skipped) console.log(`  skipped ${s}`);
console.log(`${report.verdict}: ${unexplained.length} unexplained flag(s); report ${reportPath}`);
process.exit(pass ? 0 : 1);
