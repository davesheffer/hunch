import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { pathMatchesGlob } from "../src/core/glob.js";

const repoRoot = join(dirname(fileURLToPath(import.meta.url)), "..");

test("config-writer guard excludes local Git hook scripts without losing user-config coverage", () => {
  const constraint = JSON.parse(readFileSync(
    join(repoRoot, ".hunch", "constraints", "con_8460b6770f.json"),
    "utf8",
  )) as { scope: string[] };
  const covered = (file: string) => constraint.scope.some((glob) => pathMatchesGlob(file, glob));

  assert.equal(covered("src/integrations/hooks.ts"), false, "marker-merged local hook scripts are not provider config");
  for (const file of [
    "src/integrations/claudeConfig.ts",
    "src/integrations/claudemd.ts",
    "src/integrations/providers.ts",
    "src/integrations/scaffold.ts",
  ]) {
    assert.equal(covered(file), true, `${file} remains protected`);
  }
});
