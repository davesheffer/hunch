/**
 * Hook-only entry (bundled to dist/cli/hook.bundle.js by tooling/bundle-cli.mjs).
 * Every agent hook is a fresh process; this skips Commander and every other
 * command's imports. It MUST NOT import ./index.js, commander, or ../constitution
 * (test/bundle-cli.test.ts walks the closure). Only the exact `hook` invocations
 * recognised by fastHookArgs run here; everything else uses the full CLI.
 */
import "./preflight.js"; // MUST stay the first import — Node-version gate before node:sqlite loads
import { normalizeInitiator } from "../synthesis/initiator.js";
import { runHookCommand } from "./hookCommand.js";
import { fastHookArgs } from "./hookArgs.js";
import { runHookDaemon, runHookDaemonHost } from "./hookDaemon.js";
import { markerFor } from "./optOutGate.js";
import { clearTrackedStore, trackedStore } from "./teamStore.js";

/** Same as the full CLI's global preAction for `hook` without --initiator; false for an
 *  opted-out repository, which stays silent (the caller exits 0). */
function prepare(provider: string): boolean {
  process.env.HUNCH_INITIATOR = ["claude", "cursor"].includes(provider) ? normalizeInitiator(provider) : "unknown";
  return !markerFor(process.cwd());
}

export { fastHookArgs };

/** Set by the daemon client (hookClient.ts) when it already read the hook's stdin. */
const HANDED_INPUT = Symbol.for("hunch.hook.input");

/** The hook's stdin (a TTY has none), unless the daemon client already consumed it. */
function readInput(): Promise<string> {
  return new Promise((resolve) => {
    const handed = (globalThis as Record<symbol, unknown>)[HANDED_INPUT];
    if (typeof handed === "string") return resolve(handed);
    if (process.stdin.isTTY) return resolve("");
    let data = "";
    process.stdin.setEncoding("utf8");
    process.stdin.on("data", (c) => (data += c));
    process.stdin.on("end", () => resolve(data));
    process.stdin.on("error", () => resolve(data));
  });
}

function failed(e: unknown): void {
  try {
    trackedStore()?.close();
  } catch {
    /* ignore */
  }
  const msg = e instanceof Error ? e.message : String(e);
  console.error(`hunch: ${msg}`);
}

async function main(provider: string): Promise<void> {
  if (!prepare(provider)) process.exit(0);
  await runHookCommand({ provider }, readInput);
}

/** What the daemon runs per request: `main` minus the process exits, with the same failure output. */
async function serve(provider: string, payload: string): Promise<void> {
  try {
    if (!prepare(provider)) return;
    await runHookCommand({ provider }, async () => payload);
  } catch (e) {
    failed(e);
    process.exitCode = 1;
  } finally {
    // A store the handler left open (an error path) must not outlive its request.
    try { trackedStore()?.close(); } catch { /* already closed */ }
    clearTrackedStore();
  }
}

// Runs when loaded as the hook bundle. The guard makes importing this module
// (tests) inert unless the process really was launched as `hunch hook`.
const argv = process.argv.slice(2);
const fast = fastHookArgs(argv);
if (fast) {
  main(fast.provider).catch((e) => {
    failed(e);
    process.exit(1);
  });
} else if (argv.length === 2 && argv[0] === "hook-daemon") {
  // Hidden entries of the hook daemon (default on; hookSwitches.ts) (hookDaemon.ts), started by a hook.
  runHookDaemon(argv[1]!, serve).catch(() => process.exit(0));
} else if (argv.length === 2 && argv[0] === "hook-daemon-host") {
  runHookDaemonHost(argv[1]!);
}
