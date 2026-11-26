// Test-only preload (node --import): makes os.userInfo().homedir return HUNCH_TEST_PERSON_HOME so spawned CLIs
// read a fixture person-token store instead of the real home. Production code has no env seam for this.
import os from "node:os";
import { syncBuiltinESMExports } from "node:module";

const home = process.env.HUNCH_TEST_PERSON_HOME;
if (home) {
  const real = os.userInfo;
  os.userInfo = (opts) => ({ ...real.call(os, opts), homedir: home });
  syncBuiltinESMExports();
}
