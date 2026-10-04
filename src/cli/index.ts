#!/usr/bin/env node
import "./preflight.js"; // MUST precede any possible node:sqlite import.
import { HOOK_PROVIDERS } from "../core/agenthook.js";
import { normalizeInitiator } from "../synthesis/initiator.js";

async function run(): Promise<void> {
  const args = process.argv.slice(2);
  const provider = args.length === 1 && args[0] === "hook" ? "claude"
    : args.length === 3 && args[0] === "hook" && args[1] === "--provider"
      && (HOOK_PROVIDERS as readonly string[]).includes(args[2]!) ? args[2] : undefined;
  if (provider) {
    try {
      process.env.HUNCH_INITIATOR = ["claude", "cursor"].includes(provider)
        ? normalizeInitiator(provider) : "unknown";
      const { readStdin } = await import("./stdin.js");
      const { handleSimpleHook } = await import("./hookStartup.js");
      if (handleSimpleHook(await readStdin(), provider)) return;
    } catch {
      // The full hook retains its existing fail-open diagnostics. Its shared
      // stdin reader receives the identical payload, even after dispatch read it.
    }
  }
  await import("./main.js");
}

run().catch((e) => {
  console.error(`hunch: ${e instanceof Error ? e.message : String(e)}`);
  process.exitCode = 1;
});
