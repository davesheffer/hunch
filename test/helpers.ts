import { mkdtempSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { hunchPaths } from "../src/core/paths.js";
import { HunchStore } from "../src/store/hunchStore.js";
import { extracted, inferred, type Constraint, type Provenance } from "../src/core/types.js";

export function tempStore(): { store: HunchStore; root: string; cleanup: () => void } {
  const root = mkdtempSync(join(tmpdir(), "hunch-test-"));
  const store = new HunchStore(hunchPaths(root));
  store.json.ensureDirs();
  return { store, root, cleanup: () => { store.close(); rmSync(root, { recursive: true, force: true }); } };
}

export const prov = (c = 0.9): Provenance => extracted(c, []);
export const inf = (c = 0.5): Provenance => inferred(c, []);

export function mkConstraint(over: Partial<Constraint> & { id: string }): Constraint {
  return {
    type: "correctness", statement: "x", scope: ["src/auth/**"], severity: "warning",
    enforcement: "advisory_v1", match: null, forbids: null, rationale: "", source_decision: null,
    violations: [], status: "active", valid_from: undefined, valid_to: null,
    provenance: { source: "human_confirmed", confidence: 1, evidence: [] },
    ...over,
  };
}

/** Can this process create symlinks? Windows restricts symlink creation to
 *  elevated processes unless Developer Mode is on, so the symlink-hardening
 *  tests probe ONCE and skip honestly instead of dying in setup with EPERM.
 *  The guards under test stay fully exercised on POSIX and on CI. */
let symlinkCapability: boolean | undefined;
export function canSymlink(): boolean {
  if (symlinkCapability !== undefined) return symlinkCapability;
  const dir = mkdtempSync(join(tmpdir(), "hunch-symlink-probe-"));
  try {
    writeFileSync(join(dir, "t.txt"), "");
    symlinkSync(join(dir, "t.txt"), join(dir, "l.txt"), "file");
    symlinkCapability = true;
  } catch {
    symlinkCapability = false;
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
  return symlinkCapability;
}

/** `skip` option for tests that MUST create symlinks: false when available,
 *  else the reason string node:test prints. */
export const SYMLINK_SKIP: boolean | string =
  canSymlink() ? false : "symlink creation unavailable (Windows without Developer Mode/elevation)";

/** A path git will hand to `sh -c` (receive-pack/upload-pack overrides, filter
 *  commands, hook scripts, paths embedded in fixture shell scripts). Windows
 *  backslashes are eaten as sh escapes ("C:\\Users\\…" → "C:Users…"); the
 *  forward-slash spelling works in every sh, including Git-for-Windows. */
export const shPath = (p: string): string => p.replace(/\\/g, "/");

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
