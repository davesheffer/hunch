import { execFileSync } from "node:child_process";
import { mkdirSync, mkdtempSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { isAbsolute, join, resolve } from "node:path";
import { readTeamConfig, trustTeamStore } from "../src/integrations/team.js";

/** A canonical fixture root, including macOS symlinks and Windows 8.3 aliases. */
export function tempDir(prefix: string, parent = tmpdir()): string {
  return realpathSync.native(mkdtempSync(join(parent, prefix)));
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

/** Record the local consent a teammate gives with `hunch shared --trust`, into the
 *  config dir of `env` (a fixture actor's isolated home), for the team.json at `root`.
 *  An unsafe advertised URL is left untrusted, exactly as the CLI would refuse it. */
export function trustTeamStoreAs(env: NodeJS.ProcessEnv, root: string): void {
  const keys = ["XDG_CONFIG_HOME", "APPDATA", "HOME", "USERPROFILE"] as const;
  const saved = keys.map((key) => [key, process.env[key]] as const);
  if (!env.XDG_CONFIG_HOME) throw new Error("trustTeamStoreAs needs an env with an isolated XDG_CONFIG_HOME");
  try {
    for (const key of keys) {
      if (env[key] === undefined) delete process.env[key];
      else process.env[key] = env[key];
    }
    const team = readTeamConfig(root);
    if (team) trustTeamStore(root, team);
  } finally {
    for (const [key, value] of saved) {
      if (value === undefined) delete process.env[key];
      else process.env[key] = value;
    }
  }
}

/** Wire a private overlay the way `hunch private` does: the per-worktree
 *  `.hunch/local.json` exactly as given, plus the pointer this machine's setup
 *  registers in the git common dir (absolute path). A per-worktree pointer alone is
 *  checkout content and is ignored, so `root` must already be a Git repository. */
export function writeLocalPointer(root: string, config: { privateDir: string; autoCommit?: boolean; mode?: "private" | "shared"; [key: string]: unknown }): void {
  mkdirSync(join(root, ".hunch"), { recursive: true });
  writeFileSync(join(root, ".hunch", "local.json"), `${JSON.stringify(config, null, 2)}\n`);
  const raw = execFileSync("git", ["rev-parse", "--git-common-dir"], { cwd: root, encoding: "utf8", stdio: ["ignore", "pipe", "pipe"] }).trim();
  const common = isAbsolute(raw) ? raw : resolve(root, raw);
  mkdirSync(join(common, "hunch"), { recursive: true });
  const registered: Record<string, unknown> = { privateDir: resolve(root, config.privateDir) };
  if (config.autoCommit !== undefined) registered.autoCommit = config.autoCommit;
  if (config.mode !== undefined) registered.mode = config.mode;
  writeFileSync(join(common, "hunch", "local.json"), `${JSON.stringify(registered, null, 2)}\n`);
}
