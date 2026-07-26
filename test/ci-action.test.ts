import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { ciWorkflowYaml, writeCiWorkflow } from "../src/integrations/ciAction.js";
import { HUNCH_PACKAGE_SPEC } from "../src/core/version.js";

test("CI scaffold pins an engine-compatible Hunch release and keeps public output private-safe", () => {
  const yaml = ciWorkflowYaml();
  assert.match(yaml, /ref: \$\{\{ github\.event\.pull_request\.head\.sha \}\}/);
  assert.match(yaml, /node-version: 22\.13\.0/);
  assert.ok(yaml.includes(`npm install -g ${HUNCH_PACKAGE_SPEC}`));
  assert.match(yaml, /HUNCH_PRIVATE_DIR: ""/);
  assert.match(yaml, /hunch check .*--strict .*--public-only/);
});

test("repository Hunch Guard uses the exact package release from the trusted PR base", () => {
  const yaml = readFileSync(new URL("../.github/workflows/hunch-guard.yml", import.meta.url), "utf8");
  const fetchBase = yaml.indexOf('git fetch --no-tags origin "+refs/heads/${{ github.base_ref }}:refs/remotes/origin/${{ github.base_ref }}"');
  const readBaseVersion = yaml.indexOf('git show "origin/${{ github.base_ref }}:package.json"');
  const installBaseVersion = yaml.indexOf('npm install -g "@davesheffer/hunch@$HUNCH_BASE_VERSION"');

  assert.ok(fetchBase >= 0, "the trusted PR base is fetched explicitly");
  assert.ok(readBaseVersion > fetchBase, "the version is read only after the trusted base is available");
  assert.ok(installBaseVersion > readBaseVersion, "the exact trusted-base version is installed");
  assert.match(yaml, /if \(!\/\^\\d\+\\\.\\d\+\\\.\\d\+/);
  assert.ok(!yaml.includes(`npm install -g ${HUNCH_PACKAGE_SPEC}`),
    "a release PR must not try to install its own unpublished candidate version");
});

test("CI scaffold is idempotent and never clobbers an existing workflow", () => {
  const root = mkdtempSync(join(tmpdir(), "hunch-ci-action-"));
  try {
    const first = writeCiWorkflow(root);
    assert.equal(first.action, "created");
    const generated = readFileSync(first.path, "utf8");

    writeFileSync(first.path, `${generated}\n# user edit\n`);
    const second = writeCiWorkflow(root);
    assert.equal(second.action, "exists");
    assert.match(readFileSync(second.path, "utf8"), /# user edit/);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});
