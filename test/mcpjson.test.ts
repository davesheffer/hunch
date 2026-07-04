/** writeMcpJson honors con_8460b6770f: merge idempotently, preserve other
 *  servers, and REFUSE to clobber an unparseable .mcp.json. */
import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, writeFileSync, readFileSync, rmSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { writeMcpJson } from "../src/integrations/scaffold.js";

const INV = { command: "node", args: ["/abs/dist/cli/index.js"] };

test("writeMcpJson merges into an existing config, preserving other servers; idempotent", () => {
  const root = mkdtempSync(join(tmpdir(), "hunch-mcpjson-"));
  try {
    writeFileSync(join(root, ".mcp.json"), JSON.stringify({ mcpServers: { other: { command: "x" } } }, null, 2));
    writeMcpJson(root, INV);
    const once = readFileSync(join(root, ".mcp.json"), "utf8");
    const json = JSON.parse(once);
    assert.ok(json.mcpServers.other, "user's other server survives");
    assert.deepEqual(json.mcpServers.hunch, { command: "node", args: ["/abs/dist/cli/index.js", "mcp"] });
    writeMcpJson(root, INV);
    assert.equal(readFileSync(join(root, ".mcp.json"), "utf8"), once, "re-run is byte-identical");
  } finally { rmSync(root, { recursive: true, force: true }); }
});

test("writeMcpJson REFUSES an unparseable .mcp.json — never clobbers (con_8460b6770f)", () => {
  const root = mkdtempSync(join(tmpdir(), "hunch-mcpjson-bad-"));
  try {
    const corrupt = "{ this is not json";
    writeFileSync(join(root, ".mcp.json"), corrupt);
    assert.throws(() => writeMcpJson(root, INV), /refusing to overwrite/);
    assert.equal(readFileSync(join(root, ".mcp.json"), "utf8"), corrupt, "corrupt file untouched");
    // a JSON array is parseable but not a config object — also refused
    writeFileSync(join(root, ".mcp.json"), "[1,2,3]");
    assert.throws(() => writeMcpJson(root, INV), /refusing to overwrite/);
    assert.equal(readFileSync(join(root, ".mcp.json"), "utf8"), "[1,2,3]");
    // an empty/whitespace file is fine — fresh write
    writeFileSync(join(root, ".mcp.json"), "  \n");
    writeMcpJson(root, INV);
    assert.ok(JSON.parse(readFileSync(join(root, ".mcp.json"), "utf8")).mcpServers.hunch);
  } finally { rmSync(root, { recursive: true, force: true }); }
});
