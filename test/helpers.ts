import { cleanupDir } from "./fixtures.js";
export { cleanupDir, tempDir, isolatedCliEnv } from "./fixtures.js";
import { mkdirSync, mkdtempSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { pathToFileURL } from "node:url";
import { hunchPaths } from "../src/core/paths.js";
import { HunchStore } from "../src/store/hunchStore.js";
import { indexRepo } from "../src/extractors/indexer.js";
import { extracted, inferred, type Constraint, type Provenance, type Symbol } from "../src/core/types.js";

export function tempStore(): { store: HunchStore; root: string; cleanup: () => void } {
  const root = mkdtempSync(join(tmpdir(), "hunch-test-"));
  const store = new HunchStore(hunchPaths(root));
  store.json.ensureDirs();
  return { store, root, cleanup: () => { store.close(); cleanupDir(root); } };
}

/** Minimal repo for the `"."` root component (issue #34): several root-level
 *  files (indexed output is sorted) plus one nested file. */
export function seedRootLevelFileFixture(root: string): void {
  writeFileSync(join(root, "config.ts"), "export function loadConfig() { return {}; }\n");
  writeFileSync(join(root, "settings.ts"), "export function loadSettings() { return {}; }\n");
  mkdirSync(join(root, "src", "auth"), { recursive: true });
  writeFileSync(join(root, "src", "auth", "session.ts"), "export function verifySession(t) { return t; }\n");
}

/** A store populated by the REAL indexer (not hand-put records) from a repo that
 *  `seed` lays out in a fresh temp dir. */
export function indexedFixtureStore(seed: (root: string) => void): { store: HunchStore; root: string; cleanup: () => void } {
  const root = mkdtempSync(join(tmpdir(), "hunch-idx-"));
  seed(root);
  const store = new HunchStore(hunchPaths(root));
  store.json.ensureDirs();
  indexRepo(store, root, { churn: false });
  store.reindex();
  return { store, root, cleanup: () => { store.close(); cleanupDir(root); } };
}

export const prov = (c = 0.9): Provenance => extracted(c, []);
export const inf = (c = 0.5): Provenance => inferred(c, []);

export function mkConstraint(over: Partial<Constraint> & { id: string }): Constraint {
  return {
    type: "correctness",
    statement: "x",
    scope: ["src/auth/**"],
    severity: "warning",
    enforcement: "advisory_v1",
    match: null,
    forbids: null,
    rationale: "",
    source_decision: null,
    violations: [],
    status: "active",
    valid_from: undefined,
    valid_to: null,
    provenance: { source: "human_confirmed", confidence: 1, evidence: [] },
    ...over,
  };
}

/** Minimal indexed-symbol fixture: id, file and name are what path tests care about. */
export function mkSymbol(id: string, file: string, name: string, over: Partial<Symbol> = {}): Symbol {
  return {
    id,
    file,
    name,
    kind: "function",
    signature_hash: "",
    calls: [],
    called_by: [],
    metrics: { loc: 10, churn_90d: 0, bug_count: 0, fan_in: 0, fan_out: 0 },
    last_changed: "",
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
    cleanupDir(dir);
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

/** `--import` needs a URL. Under `node --import tsx` import.meta.resolve returns
 * one, but under the `tsx --test` runner on Windows it returns a bare path, and
 * Node then rejects the `c:` scheme; every CLI-spawning test failed locally. */
export function tsxLoaderUrl(): string {
  const spec = import.meta.resolve("tsx");
  return spec.startsWith("file:") ? spec : pathToFileURL(spec).href;
}
