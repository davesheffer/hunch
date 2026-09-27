// Validator step for `hunch task benchmark`: copies the task's validator into the run's repo and
// runs it under tsx's test runner with an isolated home, a process-tree timeout, and a log.
// Design: bench/pilot5/GATE-A-HARNESS.md ("Validation").
import { spawn, type ChildProcess } from "node:child_process";
import { createHash } from "node:crypto";
import { copyFileSync, createWriteStream, mkdirSync, readFileSync } from "node:fs";
import { basename, join } from "node:path";
import { performance } from "node:perf_hooks";
import { finished } from "node:stream/promises";
import { killProcessTree } from "./taskRunner.js";

export interface RunValidatorOptions {
  /** The run's working repo; the validator lands in `<repo>/test/<basename>`. */
  repo: string;
  validatorFile: string;
  /** Receives `validator.txt` and `validator-home/`. */
  runDir: string;
  timeoutMs: number;
  /** Already stripped by the caller; the home/config variables below are overridden. */
  env: Record<string, string>;
}

export interface ValidatorResult {
  exit_code: number | null;
  timed_out: boolean;
  validation_ms: number;
  sha256_of_copied_file: string;
}

/** Home/config variables pointed at `<runDir>/validator-home/<subdir>`. */
const VALIDATOR_HOME_DIRS: ReadonlyArray<readonly [string, string]> = [
  ["HOME", "home"], ["USERPROFILE", "home"], ["APPDATA", "appdata"], ["LOCALAPPDATA", "localappdata"],
  ["XDG_CONFIG_HOME", "xdg-config"], ["XDG_CACHE_HOME", "xdg-cache"],
];

/** Runs one validator to completion or timeout. Never rejects on child failure. */
export async function runValidator(opts: RunValidatorOptions): Promise<ValidatorResult> {
  const name = basename(opts.validatorFile);
  const testDir = join(opts.repo, "test");
  mkdirSync(testDir, { recursive: true });
  const copied = join(testDir, name);
  copyFileSync(opts.validatorFile, copied);
  const sha = createHash("sha256").update(readFileSync(copied)).digest("hex");

  mkdirSync(opts.runDir, { recursive: true });
  const homeRoot = join(opts.runDir, "validator-home");
  // Windows env keys are case-insensitive: drop any casing of an overridden key first.
  const overridden = new Set(VALIDATOR_HOME_DIRS.map(([key]) => key));
  const env: Record<string, string> = {};
  for (const [key, value] of Object.entries(opts.env)) {
    if (!overridden.has(process.platform === "win32" ? key.toUpperCase() : key)) env[key] = value;
  }
  for (const [key, subdir] of VALIDATOR_HOME_DIRS) {
    env[key] = join(homeRoot, subdir);
    mkdirSync(env[key], { recursive: true });
  }

  const log = createWriteStream(join(opts.runDir, "validator.txt"), { flags: "a" });
  let timedOut = false;
  let timer: NodeJS.Timeout | undefined;
  let reaped: Promise<void> | undefined;
  const started = performance.now();
  const exit = await new Promise<{ code: number | null; elapsed: number }>((resolve) => {
    let settled = false;
    const settle = (code: number | null) => {
      if (settled) return;
      settled = true;
      resolve({ code, elapsed: performance.now() - started });
    };
    let child: ChildProcess;
    try {
      child = spawn(process.execPath, [join("node_modules", "tsx", "dist", "cli.mjs"), "--test", `test/${name}`], {
        cwd: opts.repo, env, shell: false, windowsHide: true, detached: process.platform !== "win32", stdio: ["ignore", "pipe", "pipe"],
      });
    } catch (error) {
      log.write(`runner: spawn error: ${(error as Error).message}\n`);
      settle(null);
      return;
    }
    child.stdout?.pipe(log, { end: false });
    child.stderr?.pipe(log, { end: false });
    child.once("close", (code) => settle(code));
    child.once("error", (error) => {
      log.write(`runner: spawn error: ${error.message}\n`);
      if (child.pid === undefined) settle(null);
    });
    timer = setTimeout(() => {
      timedOut = true;
      if (child.pid) killProcessTree(child.pid, "SIGTERM");
      // A leader can exit before its descendants: finish the group cleanup after the grace period.
      reaped = new Promise((done) => setTimeout(() => { if (child.pid) killProcessTree(child.pid, "SIGKILL"); done(); }, 1000));
    }, opts.timeoutMs);
  });
  clearTimeout(timer);
  if (reaped) await reaped;

  log.end();
  await finished(log).catch(() => {});
  return { exit_code: exit.code, timed_out: timedOut, validation_ms: exit.elapsed, sha256_of_copied_file: sha };
}
