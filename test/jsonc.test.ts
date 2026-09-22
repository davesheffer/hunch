import { cleanupDir } from "./fixtures.js";
import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { parseJsonc } from "../src/core/jsonc.js";
import { writeCursorMcp } from "../src/integrations/providers.js";

for (const raw of ['{"value":1/* gap */2}', '{"value":tru/* gap */e}', '{} /* unclosed', '{"items":[,]}', '{"mcpServers":{,}}']) {
  test(`malformed JSONC is rejected and a config install preserves its bytes: ${raw}`, () => {
    const root = mkdtempSync(join(tmpdir(), "hunch-jsonc-invalid-"));
    try {
      const file = join(root, ".cursor", "mcp.json");
      mkdirSync(join(root, ".cursor")); writeFileSync(file, raw);
      assert.throws(() => parseJsonc(raw));
      assert.throws(() => writeCursorMcp(root, { command: "hunch", args: [] }), /refusing to overwrite/);
      assert.equal(readFileSync(file, "utf8"), raw);
    } finally { cleanupDir(root); }
  });
}

test("JSONC retains comments as whitespace, accepts trailing commas, and preserves comment-like strings", () => {
  assert.deepEqual(parseJsonc('{/*a*/"url":"https://example.test/*literal*/",/*b*/"items":[1,/*c*/2,],}//done'), {
    url: "https://example.test/*literal*/", items: [1, 2],
  });
});

test("a line comment ends at a carriage return", () => {
  assert.deepEqual(parseJsonc('{// comment\r"value":1}'), { value: 1 });
});
