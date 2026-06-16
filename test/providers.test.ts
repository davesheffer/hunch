import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync, writeFileSync, mkdirSync } from "node:fs";
import { join } from "node:path";
import { tempStore } from "./helpers.js";
import { scaffoldProviders, writeCursorMcp, writeVscodeMcp, writeCodexConfig } from "../src/integrations/providers.js";

const inv = { command: "C:\\Program Files\\nodejs\\node.exe", args: ["C:\\repo\\dist\\cli\\index.js"] };

test("scaffoldProviders writes MCP config + grounding for every assistant", () => {
  const { store, root, cleanup } = tempStore();
  try {
    scaffoldProviders(root, inv, store);

    const cursor = JSON.parse(readFileSync(join(root, ".cursor/mcp.json"), "utf8"));
    assert.equal(cursor.mcpServers.hunch.command, inv.command);
    assert.deepEqual(cursor.mcpServers.hunch.args, [...inv.args, "mcp"]);

    const vscode = JSON.parse(readFileSync(join(root, ".vscode/mcp.json"), "utf8"));
    assert.equal(vscode.servers.hunch.type, "stdio", "VS Code requires explicit stdio type");
    assert.equal(vscode.servers.hunch.command, inv.command);

    const codex = readFileSync(join(root, ".codex/config.toml"), "utf8");
    assert.match(codex, /\[mcp_servers\.hunch\]/);
    assert.match(codex, /command = '.*node\.exe'/); // literal string, backslashes unescaped
    assert.match(codex, /'mcp'/);

    const agents = readFileSync(join(root, "AGENTS.md"), "utf8");
    assert.match(agents, /Hunch/);
    assert.match(agents, /hunch_check_constraints/);

    const copilot = readFileSync(join(root, ".github/copilot-instructions.md"), "utf8");
    assert.match(copilot, /hunch_why/);

    const rule = readFileSync(join(root, ".cursor/rules/hunch.mdc"), "utf8");
    assert.match(rule, /alwaysApply: true/);
  } finally { cleanup(); }
});

test("MCP writers MERGE — other servers and user TOML are preserved", () => {
  const { store, root, cleanup } = tempStore();
  try {
    mkdirSync(join(root, ".cursor"), { recursive: true });
    writeFileSync(join(root, ".cursor/mcp.json"), JSON.stringify({ mcpServers: { other: { command: "x" } } }));
    mkdirSync(join(root, ".codex"), { recursive: true });
    writeFileSync(join(root, ".codex/config.toml"), "model = 'gpt-5'\n");

    writeCursorMcp(root, inv);
    writeCodexConfig(root, inv);

    const cursor = JSON.parse(readFileSync(join(root, ".cursor/mcp.json"), "utf8"));
    assert.ok(cursor.mcpServers.other, "pre-existing server preserved");
    assert.ok(cursor.mcpServers.hunch, "hunch added");

    const codex = readFileSync(join(root, ".codex/config.toml"), "utf8");
    assert.match(codex, /model = 'gpt-5'/, "user TOML preserved");
    assert.match(codex, /\[mcp_servers\.hunch\]/, "hunch block added");
  } finally { cleanup(); }
});

test("writeVscodeMcp tolerates JSONC (comments) and preserves other servers", () => {
  const { root, cleanup } = tempStore();
  try {
    mkdirSync(join(root, ".vscode"), { recursive: true });
    writeFileSync(join(root, ".vscode/mcp.json"), `{\n  // team servers\n  "servers": { "other": { "type": "stdio", "command": "x" } },\n}`);
    writeVscodeMcp(root, inv);
    const j = JSON.parse(readFileSync(join(root, ".vscode/mcp.json"), "utf8"));
    assert.ok(j.servers.other, "comment-bearing config not clobbered");
    assert.ok(j.servers.hunch);
  } finally { cleanup(); }
});

test("writeVscodeMcp REFUSES to overwrite an unparseable config (no data loss)", () => {
  const { root, cleanup } = tempStore();
  try {
    mkdirSync(join(root, ".vscode"), { recursive: true });
    const broken = `{ "servers": { "other": INVALID`;
    writeFileSync(join(root, ".vscode/mcp.json"), broken);
    assert.throws(() => writeVscodeMcp(root, inv), /refusing to overwrite/);
    assert.equal(readFileSync(join(root, ".vscode/mcp.json"), "utf8"), broken, "left untouched");
  } finally { cleanup(); }
});

test("writeCodexConfig refuses to create a duplicate [mcp_servers.hunch] table", () => {
  const { root, cleanup } = tempStore();
  try {
    mkdirSync(join(root, ".codex"), { recursive: true });
    writeFileSync(join(root, ".codex/config.toml"), "[mcp_servers.hunch]\ncommand = 'old'\n");
    assert.throws(() => writeCodexConfig(root, inv), /already defines \[mcp_servers\.hunch\]/);
  } finally { cleanup(); }
});

test("scaffoldProviders isolates a failing assistant as a warning, not a crash", () => {
  const { store, root, cleanup } = tempStore();
  try {
    mkdirSync(join(root, ".vscode"), { recursive: true });
    writeFileSync(join(root, ".vscode/mcp.json"), "{ broken");
    const ps = scaffoldProviders(root, inv, store);
    const vscode = ps.find((p) => p.assistant.startsWith("VS Code"))!;
    assert.ok(vscode.error, "VS Code reported an error");
    assert.ok(ps.find((p) => p.assistant === "Codex CLI")?.files.length, "other assistants still scaffolded");
  } finally { cleanup(); }
});

test("scaffolders are idempotent — re-running adds no duplicates", () => {
  const { store, root, cleanup } = tempStore();
  try {
    scaffoldProviders(root, inv, store);
    scaffoldProviders(root, inv, store);

    const vscode = JSON.parse(readFileSync(join(root, ".vscode/mcp.json"), "utf8"));
    assert.equal(Object.keys(vscode.servers).length, 1);

    const codex = readFileSync(join(root, ".codex/config.toml"), "utf8");
    assert.equal((codex.match(/\[mcp_servers\.hunch\]/g) ?? []).length, 1, "one codex block");

    const agents = readFileSync(join(root, "AGENTS.md"), "utf8");
    assert.equal((agents.match(/HUNCH:START/g) ?? []).length, 1, "one grounding section");
  } finally { cleanup(); }
});
