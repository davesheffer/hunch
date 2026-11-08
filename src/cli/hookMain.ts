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
import { markerFor } from "./optOutGate.js";
import { trackedStore } from "./teamStore.js";

/** `{ provider }` only for exactly `hook`, `hook --provider X` or `hook --provider=X`
 *  (X non-empty); null sends the invocation through the full CLI. The shim in
 *  tooling/bundle-cli.mjs applies the same rule inline. */
export function fastHookArgs(args: string[]): { provider: string } | null {
  if (args[0] !== "hook") return null;
  if (args.length === 1) return { provider: "claude" };
  if (args.length === 3 && args[1] === "--provider" && args[2]) return { provider: args[2] };
  if (args.length === 2 && args[1]!.startsWith("--provider=") && args[1]!.length > "--provider=".length) {
    return { provider: args[1]!.slice("--provider=".length) };
  }
  return null;
}

async function main(provider: string): Promise<void> {
  // Same as the full CLI's global preAction for `hook` without --initiator.
  process.env.HUNCH_INITIATOR = ["claude", "cursor"].includes(provider) ? normalizeInitiator(provider) : "unknown";
  // Same as the opt-out gate for `hook`: an opted-out repository stays silent, exit 0.
  if (markerFor(process.cwd())) process.exit(0);
  await runHookCommand({ provider });
}

// Runs when loaded as the hook bundle. The guard makes importing this module
// (tests) inert unless the process really was launched as `hunch hook`.
const fast = fastHookArgs(process.argv.slice(2));
if (fast) {
  main(fast.provider).catch((e) => {
    try {
      trackedStore()?.close();
    } catch {
      /* ignore */
    }
    const msg = e instanceof Error ? e.message : String(e);
    console.error(`hunch: ${msg}`);
    process.exit(1);
  });
}
