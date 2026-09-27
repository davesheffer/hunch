// PILOT5 hidden validator for davesheffer/hunch#314 (convention card).
// Derived from the fix's regression tests in test/providers.test.ts, made
// solution-agnostic: the issue allows either a comment-preserving edit or a
// refusal, so each case accepts EITHER an untouched file (refusal, thrown or
// returned) OR a merged file that still carries every user comment.
// Uses only APIs that exist at the starting commit.
import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync, writeFileSync, mkdirSync } from "node:fs";
import { dirname, join } from "node:path";
import { tempStore } from "./helpers.js";
import { writeVscodeMcp, writeCursorHooks } from "../src/integrations/providers.js";
import { parseJsonc } from "../src/core/jsonc.js";

const inv = { command: "C:\\Program Files\\nodejs\\node.exe", args: ["C:\\repo\\dist\\cli\\index.js"] };

function runWriter(write: () => unknown): void {
  try { write(); } catch { /* a refusal may throw; the file state decides */ }
}

test("writeVscodeMcp never erases line comments in an existing JSONC config", () => {
  const { root, cleanup } = tempStore();
  try {
    const file = join(root, ".vscode/mcp.json");
    mkdirSync(dirname(file), { recursive: true });
    const before = `{\n  // team servers: token comes from the vault\n  "servers": { "other": { "type": "stdio", "command": "x" } },\n}`;
    writeFileSync(file, before);
    runWriter(() => writeVscodeMcp(root, inv));
    const after = readFileSync(file, "utf8");
    if (after === before) return; // refused: file untouched
    assert.ok(after.includes("// team servers: token comes from the vault"), `comment erased:\n${after}`);
    const j = parseJsonc(after) as { servers: Record<string, unknown> };
    assert.ok(j.servers.other, "other server preserved");
    assert.ok(j.servers.hunch, "hunch server added");
  } finally { cleanup(); }
});

test("writeCursorHooks never erases block comments in an existing JSONC config", () => {
  const { root, cleanup } = tempStore();
  try {
    const file = join(root, ".cursor/hooks.json");
    mkdirSync(dirname(file), { recursive: true });
    const before = `{\n  /* Keep this hook until the migration ends. */\n  "hooks": { "sessionStart": [{ "command": "node other.js" }] }\n}`;
    writeFileSync(file, before);
    runWriter(() => writeCursorHooks(root, inv));
    const after = readFileSync(file, "utf8");
    if (after === before) return; // refused: file untouched
    assert.ok(after.includes("/* Keep this hook until the migration ends. */"), `comment erased:\n${after}`);
    const j = parseJsonc(after) as { hooks: { sessionStart: Array<{ command: string }> } };
    const cmds = j.hooks.sessionStart.map((h) => h.command);
    assert.ok(cmds.includes("node other.js"), "foreign hook preserved");
    assert.ok(cmds.length >= 2, "hunch hook added");
  } finally { cleanup(); }
});

test("comment-looking text inside JSON strings still merges normally", () => {
  const { root, cleanup } = tempStore();
  try {
    const file = join(root, ".vscode/mcp.json");
    mkdirSync(dirname(file), { recursive: true });
    writeFileSync(file, JSON.stringify({ servers: { other: { command: "https://example.test/a/*literal*/", args: ['say "//" now'] } } }));
    writeVscodeMcp(root, inv);
    const result = parseJsonc(readFileSync(file, "utf8")) as { servers: Record<string, { command?: string; args?: string[] }> };
    assert.equal(result.servers.other.command, "https://example.test/a/*literal*/");
    assert.deepEqual(result.servers.other.args, ['say "//" now']);
    assert.ok(result.servers.hunch);
  } finally { cleanup(); }
});
