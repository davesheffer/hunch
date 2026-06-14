import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { brainPaths } from "../src/core/paths.js";
import { BrainStore } from "../src/store/brainStore.js";
import { extracted, inferred, type Provenance } from "../src/core/types.js";

export function tempStore(): { store: BrainStore; root: string; cleanup: () => void } {
  const root = mkdtempSync(join(tmpdir(), "brain-test-"));
  const store = new BrainStore(brainPaths(root));
  store.json.ensureDirs();
  return { store, root, cleanup: () => { store.close(); rmSync(root, { recursive: true, force: true }); } };
}

export const prov = (c = 0.9): Provenance => extracted(c, []);
export const inf = (c = 0.5): Provenance => inferred(c, []);
