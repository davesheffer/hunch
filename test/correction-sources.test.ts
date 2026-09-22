import { cleanupDir } from "./fixtures.js";
import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { collectCorrectionStageSources } from "../src/extractors/correctionSources.js";

test("correction source collection includes production PHP and excludes test PHP", () => {
  const root = mkdtempSync(join(tmpdir(), "hunch-correction-php-"));
  try {
    mkdirSync(join(root, "src"), { recursive: true });
    mkdirSync(join(root, "tests"), { recursive: true });
    writeFileSync(join(root, "src/Matcher.php"), "<?php final class Matcher {}\n");
    writeFileSync(join(root, "tests/MatcherTest.php"), "<?php final class MatcherTest {}\n");
    writeFileSync(join(root, "src/helper.ts"), "export function helper() {}\n");
    const collection = collectCorrectionStageSources(root, "source matcher policy");
    assert.deepEqual(collection.sources.map(({ path }) => path).sort(), ["src/Matcher.php", "src/helper.ts"]);
    assert.equal(collection.files_read, 2);
    assert.equal(collection.files_skipped, 0);
  } finally {
    cleanupDir(root);
  }
});
