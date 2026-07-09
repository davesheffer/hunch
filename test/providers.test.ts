import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync, writeFileSync, mkdirSync } from "node:fs";
import { join } from "node:path";
import { tempStore } from "./helpers.js";
import { scaffoldProviders, writeCursorMcp, writeVscodeMcp, writeCodexConfig, writeWindsurfMcp, writeAntigravityWorkspaceMcp } from "../src/integrations/providers.js";

const inv = { command: "C:\\Program Files\\nodejs\\node.exe", args: ["C:\\repo\\dist\\cli\\index.js"] };

test("scaffoldProviders writes MCP config + grounding for every assistant", () => {
  const { store, root, cleanup } = tempStore();
  try {
    scaffoldProviders(root, inv, store, { home: root });

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
    const cursorHooks = JSON.parse(readFileSync(join(root, ".cursor/hooks.json"), "utf8"));
    assert.equal(cursorHooks.version, 1);
    assert.match(cursorHooks.hooks.preToolUse[0].command, /hook.*--provider.*cursor/);

    const vscodeHooks = JSON.parse(readFileSync(join(root, ".github/hooks/hunch.json"), "utf8"));
    assert.match(vscodeHooks.hooks.PreToolUse[0].command, /hook.*--provider.*vscode/);
    assert.ok(vscodeHooks.hooks.Stop, "VS Code gets the delivery stop gate");

    const windsurf = JSON.parse(readFileSync(join(root, ".windsurf/mcp_config.json"), "utf8"));
    assert.equal(windsurf.mcpServers.hunch.command, inv.command);
    assert.deepEqual(windsurf.mcpServers.hunch.args, [...inv.args, "mcp"]);
    const wrule = readFileSync(join(root, ".windsurf/rules/hunch.md"), "utf8");
    assert.match(wrule, /trigger: always_on/);
    assert.match(wrule, /hunch_check_constraints/);
    const windsurfHooks = JSON.parse(readFileSync(join(root, ".windsurf/hooks.json"), "utf8"));
    assert.match(windsurfHooks.hooks.pre_write_code[0].command, /hook.*--provider.*windsurf/);

    const antigravity = JSON.parse(readFileSync(join(root, ".agents/mcp_config.json"), "utf8"));
    assert.equal(antigravity.mcpServers.hunch.command, inv.command);
    const antigravityHooks = JSON.parse(readFileSync(join(root, ".agents/hooks.json"), "utf8"));
    assert.match(antigravityHooks.hunch.PreInvocation[0].command, /hook.*--provider.*antigravity/);
    assert.match(antigravityHooks.hunch.PreToolUse[0].matcher, /write_to_file/);
  } finally { cleanup(); }
});

test("workspace Antigravity MCP config MERGES and lifecycle hooks preserve foreign entries", () => {
  const { root, store, cleanup } = tempStore();
  try {
    mkdirSync(join(root, ".agents"), { recursive: true });
    writeFileSync(join(root, ".agents/mcp_config.json"), JSON.stringify({ mcpServers: { other: { command: "x" } } }));
    mkdirSync(join(root, ".cursor"), { recursive: true });
    writeFileSync(join(root, ".cursor/hooks.json"), JSON.stringify({ version: 1, hooks: { stop: [{ command: "./keep-me" }] } }));
    writeAntigravityWorkspaceMcp(root, inv);
    scaffoldProviders(root, inv, store, { home: root });

    const mcp = JSON.parse(readFileSync(join(root, ".agents/mcp_config.json"), "utf8"));
    assert.ok(mcp.mcpServers.other, "foreign Antigravity server preserved");
    assert.ok(mcp.mcpServers.hunch, "Hunch server added");
    const cursor = JSON.parse(readFileSync(join(root, ".cursor/hooks.json"), "utf8"));
    assert.ok(cursor.hooks.stop.some((entry: { command: string }) => entry.command === "./keep-me"), "foreign Cursor hook preserved");
    assert.equal(cursor.hooks.stop.filter((entry: { command: string }) => /--provider.*cursor/.test(entry.command)).length, 1, "one managed Cursor hook");
  } finally { cleanup(); }
});

test("writeWindsurfMcp MERGES and refuses to clobber an unparseable config", () => {
  const { store, root, cleanup } = tempStore();
  try {
    mkdirSync(join(root, ".windsurf"), { recursive: true });
    writeFileSync(join(root, ".windsurf/mcp_config.json"), JSON.stringify({ mcpServers: { other: { command: "x" } } }));
    writeWindsurfMcp(root, inv);
    const cfg = JSON.parse(readFileSync(join(root, ".windsurf/mcp_config.json"), "utf8"));
    assert.ok(cfg.mcpServers.other, "pre-existing server preserved");
    assert.ok(cfg.mcpServers.hunch, "hunch added");

    writeFileSync(join(root, ".windsurf/mcp_config.json"), "{ not json");
    assert.throws(() => writeWindsurfMcp(root, inv), /refusing to overwrite/);
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

test("writeVscodeMcp strips JSONC trailing commas WITHOUT corrupting string values", () => {
  const { root, cleanup } = tempStore();
  try {
    mkdirSync(join(root, ".vscode"), { recursive: true });
    // trailing commas (JSONC) + a value literally containing ",]" — the exact trap
    // a blanket /,(\s*[}\]])/ regex would corrupt.
    writeFileSync(join(root, ".vscode/mcp.json"), `{\n  "servers": {\n    "other": { "type": "stdio", "command": "c", "args": ["a,]"], },\n  },\n}`);
    writeVscodeMcp(root, inv);
    const j = JSON.parse(readFileSync(join(root, ".vscode/mcp.json"), "utf8"));
    assert.deepEqual(j.servers.other.args, ["a,]"], "comma inside string value preserved");
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
    const ps = scaffoldProviders(root, inv, store, { home: root });
    const vscode = ps.find((p) => p.assistant.startsWith("VS Code"))!;
    assert.ok(vscode.error, "VS Code reported an error");
    const vscodeHooks = JSON.parse(readFileSync(join(root, ".github/hooks/hunch.json"), "utf8"));
    assert.match(vscodeHooks.hooks.PreToolUse[0].command, /--provider.*vscode/, "a broken MCP file does not suppress VS Code lifecycle hooks");
    assert.ok(ps.find((p) => p.assistant === "Codex CLI")?.files.length, "other assistants still scaffolded");
  } finally { cleanup(); }
});

test("scaffolders are idempotent — re-running adds no duplicates", () => {
  const { store, root, cleanup } = tempStore();
  try {
    scaffoldProviders(root, inv, store, { home: root });
    scaffoldProviders(root, inv, store, { home: root });

    const vscode = JSON.parse(readFileSync(join(root, ".vscode/mcp.json"), "utf8"));
    assert.equal(Object.keys(vscode.servers).length, 1);

    const codex = readFileSync(join(root, ".codex/config.toml"), "utf8");
    assert.equal((codex.match(/\[mcp_servers\.hunch\]/g) ?? []).length, 1, "one codex block");

    const agents = readFileSync(join(root, "AGENTS.md"), "utf8");
    assert.equal((agents.match(/HUNCH:START/g) ?? []).length, 1, "one grounding section");
  } finally { cleanup(); }
});
