import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { ciWorkflowYaml, writeCiWorkflow } from "../src/integrations/ciAction.js";
import { HUNCH_VERSION } from "../src/core/version.js";

test("CI scaffold pins an engine-compatible Hunch release and keeps public output private-safe", () => {
  const yaml = ciWorkflowYaml();
  assert.match(yaml, /ref: \$\{\{ github\.event\.pull_request\.head\.sha \}\}/);
  assert.match(yaml, /node-version: 22\.13\.0/);
  assert.match(yaml, new RegExp(`npm install -g @davesheffer/hunch@${HUNCH_VERSION.replaceAll(".", "\\.")}`));
  assert.match(yaml, /HUNCH_PRIVATE_DIR: ""/);
  assert.match(yaml, /hunch check .*--strict .*--public-only/);
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
