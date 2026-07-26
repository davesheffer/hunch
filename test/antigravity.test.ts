import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, mkdirSync, writeFileSync, readFileSync, existsSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { writeAntigravityMcp, antigravityMcpFile } from "../src/integrations/providers.js";
import { publishedMcpInvocation } from "../src/cli/invocation.js";

const INV = publishedMcpInvocation();

test("antigravity: registers the hunch stdio server in the global config when installed", () => {
  const home = mkdtempSync(join(tmpdir(), "hunch-ag-"));
  try {
    mkdirSync(join(home, ".gemini", "antigravity"), { recursive: true });
    const file = writeAntigravityMcp(INV, home);
    assert.equal(file, join(home, ".gemini", "antigravity", "mcp_config.json"));
    const cfg = JSON.parse(readFileSync(file!, "utf8"));
    assert.deepEqual(cfg.mcpServers.hunch, { command: INV.command, args: [...INV.args, "mcp"] });
  } finally { rmSync(home, { recursive: true, force: true }); }
});

test("antigravity: merges idempotently, preserving other servers (con_8460b6770f)", () => {
  const home = mkdtempSync(join(tmpdir(), "hunch-ag-"));
  try {
    const dir = join(home, ".gemini", "antigravity");
    mkdirSync(dir, { recursive: true });
    writeFileSync(join(dir, "mcp_config.json"), JSON.stringify({ mcpServers: { github: { serverUrl: "https://x" } } }));
    writeAntigravityMcp(INV, home);
    writeAntigravityMcp(INV, home); // re-run = no-op merge
    const cfg = JSON.parse(readFileSync(join(dir, "mcp_config.json"), "utf8"));
    assert.ok(cfg.mcpServers.github, "existing server preserved");
    assert.ok(cfg.mcpServers.hunch, "hunch added");
    assert.equal(Object.keys(cfg.mcpServers).length, 2);
  } finally { rmSync(home, { recursive: true, force: true }); }
});

test("antigravity: not installed → null, never creates a global config", () => {
  const home = mkdtempSync(join(tmpdir(), "hunch-ag-"));
  try {
    assert.equal(antigravityMcpFile(home), null);
    assert.equal(writeAntigravityMcp(INV, home), null);
    assert.equal(existsSync(join(home, ".gemini")), false);
  } finally { rmSync(home, { recursive: true, force: true }); }
});

test("antigravity: adapts to the `config/` dir variant", () => {
  const home = mkdtempSync(join(tmpdir(), "hunch-ag-"));
  try {
    mkdirSync(join(home, ".gemini", "config"), { recursive: true });
    assert.equal(writeAntigravityMcp(INV, home), join(home, ".gemini", "config", "mcp_config.json"));
  } finally { rmSync(home, { recursive: true, force: true }); }
});
