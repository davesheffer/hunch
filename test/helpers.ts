import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { hunchPaths } from "../src/core/paths.js";
import { HunchStore } from "../src/store/hunchStore.js";
import { extracted, inferred, type Provenance } from "../src/core/types.js";

export function tempStore(): { store: HunchStore; root: string; cleanup: () => void } {
  const root = mkdtempSync(join(tmpdir(), "hunch-test-"));
  const store = new HunchStore(hunchPaths(root));
  store.json.ensureDirs();
  return { store, root, cleanup: () => { store.close(); rmSync(root, { recursive: true, force: true }); } };
}

export const prov = (c = 0.9): Provenance => extracted(c, []);
export const inf = (c = 0.5): Provenance => inferred(c, []);
