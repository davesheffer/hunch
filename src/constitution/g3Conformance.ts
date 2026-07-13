import { spawnSync } from "node:child_process";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { pathToFileURL } from "node:url";
import { canonicalHash } from "./canonical.js";
import type { G3Plan, AdapterConformanceReceipt } from "./g3.js";
import { compileAdapterConformanceReceipt } from "./g3.js";
import { NODE_TEST_REPORTER_SOURCE, exactNodeTestPattern, nodeTestIsolationFlag, nodeTestReporterEvents } from "./nodeTestEvidence.js";

export const G3_CONFORMANCE_CLIENTS = ["ci", "cli", "mcp"] as const;
export const G3_CONFORMANCE_TEST = {
  file: "test/behavior-workspace.test.ts",
  name: "CLI, MCP, and check share one non-blocking working-snapshot receipt without public leakage",
} as const;

/** The certifiable client profiles. Each maps a HUMAN-SELECTED client set to the
 *  ONE executable fixture that exercises every named surface end-to-end and
 *  asserts receipt equality + zero private leaks. The vscode profile executes the
 *  extension's real spawn seam (vscode-extension/src/spawnCore.ts) against an
 *  npm-style shim — naming a client never certifies it; only its fixture does. */
export const G3_CONFORMANCE_PROFILES = [
  { clients: G3_CONFORMANCE_CLIENTS, test: G3_CONFORMANCE_TEST },
  {
    clients: ["ci", "cli", "mcp", "vscode"] as const,
    test: {
      file: "test/behavior-workspace.test.ts",
      name: "CLI, MCP, check, and the VS Code seam share one non-blocking working-snapshot receipt without public leakage",
    } as const,
  },
] as const;

export function g3ConformanceSourceHash(root: string): string {
  return canonicalHash(readFileSync(join(root, G3_CONFORMANCE_TEST.file), "utf8"));
}

function sameClients(left: readonly string[], right: readonly string[]): boolean {
  return canonicalHash([...left].sort()) === canonicalHash([...right].sort());
}

/** Execute the real end-to-end fixture matching the plan's human-selected client
 * profile. Unsupported client sets return an error receipt rather than being
 * silently treated as equivalent to a certified profile. */
export function executeG3AdapterConformance(
  root: string,
  plan: G3Plan,
  opts: { timeoutMs?: number; now?: string; supersedes?: string | null } = {},
): AdapterConformanceReceipt {
  const timeoutMs = opts.timeoutMs ?? 180_000;
  if (!Number.isInteger(timeoutMs) || timeoutMs < 1 || timeoutMs > 300_000) throw new Error("G3 conformance timeout must be a positive integer no greater than 300000");
  const sourceHash = g3ConformanceSourceHash(root);
  const isolationFlag = nodeTestIsolationFlag();
  const profile = G3_CONFORMANCE_PROFILES.find((candidate) => sameClients(plan.clients, candidate.clients));
  if (!profile) {
    return compileAdapterConformanceReceipt({
      plan_id: plan.id,
      clients: plan.clients,
      test: { ...G3_CONFORMANCE_TEST, source_hash: sourceHash },
      runner: { name: "node-test-tsx", isolation_flag: isolationFlag },
      result: "error",
      exit_code: null,
      selected_event: null,
      verdict_agreement: null,
      confirmed_private_leaks: null,
      error_code: "unsupported-client-profile",
      log_hash: canonicalHash({ supported: G3_CONFORMANCE_PROFILES.map((candidate) => candidate.clients), selected: plan.clients }),
      supersedes: opts.supersedes ?? null,
    }, { now: opts.now });
  }
  const selectedTest = profile.test;

  const session = mkdtempSync(join(tmpdir(), "hunch-g3-conformance-"));
  const reporter = join(session, "reporter.mjs");
  writeFileSync(reporter, NODE_TEST_REPORTER_SOURCE);
  const tsx = join(root, "node_modules/tsx/dist/cli.mjs");
  const env: NodeJS.ProcessEnv = {};
  for (const key of ["PATH", "SystemRoot", "WINDIR", "TMPDIR", "TMP", "TEMP"]) {
    if (process.env[key]) env[key] = process.env[key];
  }
  Object.assign(env, {
    HOME: session,
    HUNCH_PRIVATE_DIR: "",
    HUNCH_SYNTH_PROVIDER: "deterministic",
    CI: "1",
    NO_COLOR: "1",
    FORCE_COLOR: "0",
  });
  const run = spawnSync(process.execPath, [
    tsx,
    "--test",
    isolationFlag,
    `--test-name-pattern=${exactNodeTestPattern(selectedTest.name)}`,
    `--test-reporter=${pathToFileURL(reporter).href}`,
    "--test-reporter-destination=stdout",
    selectedTest.file,
  ], {
    cwd: root,
    env,
    encoding: "utf8",
    timeout: timeoutMs,
    maxBuffer: 20 * 1024 * 1024,
    stdio: ["ignore", "pipe", "pipe"],
    shell: false,
  });
  rmSync(session, { recursive: true, force: true });
  const stdout = run.stdout ?? "";
  const stderr = run.stderr ?? "";
  const events = nodeTestReporterEvents(stdout).filter((event) => event.name === selectedTest.name && !event.skip && !event.todo);
  const selectedEvent = events.length === 1 ? (events[0]!.type === "test:pass" ? "passed" as const : "failed" as const) : null;
  let result: AdapterConformanceReceipt["result"] = "error";
  let errorCode: string | undefined;
  if (run.error) errorCode = (run.error as NodeJS.ErrnoException).code === "ETIMEDOUT" ? "timeout" : "runner-failed";
  else if (run.signal) errorCode = "runner-signaled";
  else if (events.length === 0) errorCode = "selected-test-not-executed";
  else if (events.length > 1) errorCode = "selected-test-ambiguous";
  else if (selectedEvent === "passed" && run.status === 0) result = "passed";
  else if (selectedEvent === "failed" && run.status !== 0) result = "failed";
  else errorCode = "runner-outcome-inconsistent";
  return compileAdapterConformanceReceipt({
    plan_id: plan.id,
    clients: plan.clients,
    test: { ...selectedTest, source_hash: sourceHash },
    runner: { name: "node-test-tsx", isolation_flag: isolationFlag },
    result,
    exit_code: run.status ?? null,
    selected_event: selectedEvent,
    verdict_agreement: result === "passed" ? 1 : null,
    confirmed_private_leaks: result === "passed" ? 0 : null,
    ...(errorCode ? { error_code: errorCode } : {}),
    log_hash: canonicalHash({ stdout, stderr }),
    supersedes: opts.supersedes ?? null,
  }, { now: opts.now });
}
