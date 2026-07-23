import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, rmSync, truncateSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  createRepoFileReader,
  MAX_REPO_SOURCE_FILE_BYTES,
} from "../src/core/safeRepoFile.js";

test("createRepoFileReader checks the opened descriptor size before reading", () => {
  const root = mkdtempSync(join(tmpdir(), "hunch-safe-reader-size-"));
  try {
    const small = join(root, "small.ts");
    const oversized = join(root, "oversized.ts");
    writeFileSync(small, "export const answer = 42;\n");
    // Sparse allocation keeps the regression cheap while presenting the exact
    // oversized descriptor metadata a tracked/generated blob would have.
    writeFileSync(oversized, "");
    truncateSync(oversized, MAX_REPO_SOURCE_FILE_BYTES + 1);

    const readRepoFile = createRepoFileReader(root);
    assert.equal(readRepoFile(small), "export const answer = 42;\n");
    assert.equal(readRepoFile(oversized), null, "oversized descriptor is rejected before readFileSync");
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("createRepoFileReader validates an explicit byte ceiling", () => {
  const root = mkdtempSync(join(tmpdir(), "hunch-safe-reader-option-"));
  try {
    const file = join(root, "source.ts");
    writeFileSync(file, "1234");
    assert.equal(createRepoFileReader(root, { maxBytes: 3 })(file), null);
    assert.equal(createRepoFileReader(root, { maxBytes: 4 })(file), "1234");
    assert.throws(() => createRepoFileReader(root, { maxBytes: -1 }), /non-negative safe integer/);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});
