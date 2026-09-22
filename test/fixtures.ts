import { mkdtempSync, realpathSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

/** A canonical fixture root, including macOS's symlinked os.tmpdir(). */
export function tempDir(prefix: string, parent = tmpdir()): string {
  return realpathSync(mkdtempSync(join(parent, prefix)));
}

/** Spawned fixture CLIs must not inherit the developer's assistant identity.
 * Tests that exercise a provider explicitly supply their stub in overrides. */
export function isolatedCliEnv(overrides: NodeJS.ProcessEnv = {}, inherited: NodeJS.ProcessEnv = process.env): NodeJS.ProcessEnv {
  const env = { ...inherited };
  for (const key of ["CLAUDECODE", "CODEX_THREAD_ID", "CODEX_SESSION_ID", "HUNCH_INITIATOR", "HUNCH_SYNTH_PROVIDER"]) delete env[key];
  return { ...env, HUNCH_SYNTH_PROVIDER: "deterministic", ...overrides };
}

/** Remove a fixture tree, riding out Windows handle lag.
 *
 *  A spawned CLI/MCP child (or a timeout-killed git child's sh/sleep grandchildren)
 *  can briefly outlive its parent and keep a handle on the fixture, so an immediate
 *  recursive delete races it and throws EPERM — in TEARDOWN, after the assertions
 *  already passed. That turns a green test red for reasons that have nothing to do
 *  with the behaviour under test, which is exactly how a suite stops signalling.
 *
 *  rmSync's own `maxRetries`/`retryDelay` were not enough here: the native
 *  tree-sitter/sqlite handles this repo loads can outlast a full second (see
 *  bug_ebusy_treesitter, the same class). Bounded blocking retry — 20 x 250ms, then
 *  RETHROW, so a persistent leak is still a real failure and never silently ignored. */
export function cleanupDir(dir: string): void {
  for (let attempt = 0; ; attempt++) {
    try {
      rmSync(dir, { recursive: true, force: true });
      return;
    } catch (error) {
      if (attempt >= 20) throw error;
      const until = Date.now() + 250;
      while (Date.now() < until) { /* sync wait — node:test has no async cleanup here */ }
    }
  }
}
