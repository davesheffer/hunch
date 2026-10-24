import { cleanupDir } from "./fixtures.js";
export { cleanupDir, tempDir, isolatedCliEnv } from "./fixtures.js";
@@CLEANROOM_HOLE_1@@
import { tmpdir } from "node:os";
import { join } from "node:path";
import { pathToFileURL } from "node:url";
import { hunchPaths } from "../src/core/paths.js";
import { HunchStore } from "../src/store/hunchStore.js";
@@CLEANROOM_HOLE_2@@

export function tempStore(): { store: HunchStore; root: string; cleanup: () => void } {
  const root = mkdtempSync(join(tmpdir(), "hunch-test-"));
  const store = new HunchStore(hunchPaths(root));
  store.json.ensureDirs();
  return { store, root, cleanup: () => { store.close(); cleanupDir(root); } };
}

@@CLEANROOM_HOLE_3@@
  return { store, root, cleanup: () => { store.close(); cleanupDir(root); } };
@@CLEANROOM_HOLE_4@@
export const prov = (c = 0.9): Provenance => extracted(c, []);
export const inf = (c = 0.5): Provenance => inferred(c, []);

@@CLEANROOM_HOLE_5@@
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
