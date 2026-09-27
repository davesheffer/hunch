// PILOT5 hidden validator for davesheffer/hunch#268 (operation card).
// The issue: an agent that starts a task with `hunch_task start` and runs a
// passing suite through the returned `verification_argv` (no `--timeout`)
// records a timed-out, failed check once the suite exceeds the 120 s default.
// This validator does exactly that with a check that passes after 130 s and
// requires the check to be recorded as passed. It accepts either remedy the
// issue proposes for the budget: a larger default (15 min, the 6 h max, ...)
// or a `verification_argv` that carries its own `--timeout <n>`. It uses only
// surfaces the issue names (`hunch_task` start, `verification_argv`,
// `hunch task verify`, the `exit_code`/`timed_out` result fields), reached
// through the repository's own MCP entry point.
import assert from "node:assert/strict";
import { execFileSync, spawnSync } from "node:child_process";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StdioClientTransport } from "@modelcontextprotocol/sdk/client/stdio.js";

const TSX = join(process.cwd(), "node_modules/tsx/dist/cli.mjs");
const CLI = join(process.cwd(), "src/cli/index.ts");
const CHECK_SECONDS = 130; // past the old 120 s default; far inside any budget a real suite fits in

function childEnv(): Record<string, string> {
  const env: Record<string, string> = {};
  for (const [key, value] of Object.entries(process.env)) if (value !== undefined && !key.startsWith("HUNCH_")) env[key] = value;
  return { ...env, HUNCH_PRIVATE_DIR: "", HUNCH_SYNTH_PROVIDER: "deterministic" };
}

test("#268: a passing check longer than 120 s, run through verification_argv without --timeout, is recorded as passed", { timeout: 9 * 60_000 }, async t => {
  const root = mkdtempSync(join(tmpdir(), "pilot5-268-"));
  t.after(() => rmSync(root, { recursive: true, force: true, maxRetries: 10, retryDelay: 200 }));
  execFileSync("git", ["init", "-q", root]);
  mkdirSync(join(root, ".hunch"));
  mkdirSync(join(root, "src"));
  writeFileSync(join(root, ".gitignore"), ".hunch/\n.hunch-cache/\n");
  writeFileSync(join(root, "src", "index.js"), "export const ok = true;\n");
  const env = childEnv();

  const client = new Client({ name: "pilot5-268", version: "1.0.0" });
  let argv: string[];
  try {
    await client.connect(new StdioClientTransport({ command: process.execPath, args: [TSX, CLI, "mcp", "--root", root], cwd: root, env }));
    const started = await client.callTool({ name: "hunch_task", arguments: { action: "start", title: "Run the full suite" } });
    const text = (started.content as Array<{ type: string; text?: string }>).map(c => c.text ?? "").join("\n");
    assert.notEqual(started.isError, true, text);
    argv = (started.structuredContent as { verification_argv?: unknown } | undefined)?.verification_argv as string[];
    assert.ok(Array.isArray(argv) && argv.length > 0 && argv.every(a => typeof a === "string"), `hunch_task start returned no verification_argv:\n${text}`);
  } finally {
    await client.close();
  }

  const suite = [process.execPath, "-e", `setTimeout(() => process.exit(0), ${CHECK_SECONDS * 1000})`];
  const run = spawnSync(argv[0], [...argv.slice(1), ...suite], { cwd: root, env, encoding: "utf8", timeout: 8 * 60_000, windowsHide: true });
  const output = `${run.stdout ?? ""}\n${run.stderr ?? ""}`.trim().slice(-2000);
  assert.ok(!/"timed_out"\s*:\s*true/.test(run.stdout ?? ""), `a check that passes after ${CHECK_SECONDS} s was recorded as timed out by the default verification path:\n${output}`);
  assert.equal(run.status, 0, `a check that passes after ${CHECK_SECONDS} s must be recorded as passed through verification_argv (exit ${run.status}):\n${output}`);
  assert.match(run.stdout ?? "", /"exit_code"\s*:\s*0\b/, `the recorded result must carry the suite's exit code 0:\n${output}`);
});
