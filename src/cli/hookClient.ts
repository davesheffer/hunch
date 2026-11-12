/**
 * Hook entry used instead of the hook bundle unless HUNCH_HOOK_DAEMON is off (chosen by the
 * shim in tooling/bundle-cli.mjs). Bundled alone as dist/cli/hook-client.bundle.js: it
 * loads neither the hook handler nor the store, so a hook served by the warm daemon pays
 * only node's boot and this small module. Anything that keeps the daemon from answering
 * hands the very same stdin to the full hook bundle, i.e. today's in-process path.
 * MUST NOT import the hook handler (hookCommand/hookMain) statically.
 */
import "./preflight.js"; // MUST stay the first import — Node-version gate
import { fastHookArgs } from "./hookArgs.js";
import { hookDaemonEnabled, tryHookDaemon } from "./hookDaemon.js";
import { findRoot, realpathNorm } from "../core/paths.js";
import { markerFor } from "./optOutGate.js";

/** Same hand-over key hookMain.ts reads. */
const HANDED_INPUT = Symbol.for("hunch.hook.input");

function readInput(): Promise<string> {
  return new Promise((resolve) => {
    let data = "";
    process.stdin.setEncoding("utf8");
    process.stdin.on("data", (c) => (data += c));
    process.stdin.on("end", () => resolve(data));
    process.stdin.on("error", () => resolve(data));
  });
}

async function run(): Promise<void> {
  const fast = fastHookArgs(process.argv.slice(2));
  if (fast && !process.stdin.isTTY) {
    try {
      // An opted-out repository stays silent with no daemon started for it.
      if (markerFor(process.cwd())) process.exit(0);
      const input = await readInput();
      (globalThis as Record<symbol, unknown>)[HANDED_INPUT] = input;
      // `.hunch/config.json` hooks.daemon: false keeps this repository in-process.
      if (hookDaemonEnabled(process.env, findRoot(realpathNorm(process.cwd()))) && await tryHookDaemon(fast.provider, input)) return;
    } catch {
      // Fall through to the in-process handler, which reports its own failures.
    }
  }
  // A variable specifier: tsc has no such file, and esbuild must leave it as a runtime import.
  const handler = "./hook.bundle.js";
  await import(handler);
}

run().catch((e) => {
  console.error(`hunch: ${e instanceof Error ? e.message : String(e)}`);
  process.exit(1);
});
