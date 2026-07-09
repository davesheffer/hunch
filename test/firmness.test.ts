import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, mkdirSync, writeFileSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { hunchPaths } from "../src/core/paths.js";
import { readConfig, writeConfig, DEFAULT_FIRMNESS } from "../src/core/config.js";
import { installClaudeHooks } from "../src/integrations/scaffold.js";

function tmpRoot(): string {
  return mkdtempSync(join(tmpdir(), "hunch-firmness-"));
}

test("readConfig defaults to advisory when no config file exists", () => {
  const root = tmpRoot();
  try {
    assert.equal(readConfig(hunchPaths(root)).firmness, DEFAULT_FIRMNESS);
    assert.equal(DEFAULT_FIRMNESS, "advisory");
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("writeConfig round-trips a level; an unknown on-disk value falls back to default", () => {
  const root = tmpRoot();
  const paths = hunchPaths(root);
  try {
    assert.equal(writeConfig(paths, { firmness: "strict" }).firmness, "strict");
    assert.equal(readConfig(paths).firmness, "strict");
    // A corrupt/unknown firmness must not crash — degrade to the default.
    writeFileSync(paths.config, JSON.stringify({ firmness: "nonsense" }));
    assert.equal(readConfig(paths).firmness, DEFAULT_FIRMNESS);
    // Unparseable JSON also degrades rather than throwing (hook must never break an edit).
    writeFileSync(paths.config, "{not json");
    assert.equal(readConfig(paths).firmness, DEFAULT_FIRMNESS);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("installClaudeHooks writes the full lifecycle hook set", () => {
  const root = tmpRoot();
  try {
    const cmd = `"node" "/abs/dist/cli/index.js" hook`;
    const r = installClaudeHooks(root, cmd);
    assert.equal(r.action, "created");
    const j = JSON.parse(readFileSync(join(root, ".claude", "settings.json"), "utf8"));
    assert.equal(j.hooks.PreToolUse[0].matcher, "Edit|Write|MultiEdit");
    assert.equal(j.hooks.PreToolUse[0].hooks[0].command, cmd);
    assert.equal(j.hooks.UserPromptSubmit[0].hooks[0].command, cmd);
    assert.ok(j.hooks.UserPromptSubmit[0].matcher === undefined, "UserPromptSubmit has no matcher");
    assert.equal(j.hooks.SessionStart[0].hooks[0].command, cmd);
    assert.match(j.hooks.PostToolUse[0].matcher, /Bash/);
    assert.equal(j.hooks.Stop[0].hooks[0].command, cmd);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("installClaudeHooks is idempotent — re-running with the same command changes nothing", () => {
  const root = tmpRoot();
  try {
    const cmd = `"node" "/abs/dist/cli/index.js" hook`;
    installClaudeHooks(root, cmd);
    const second = installClaudeHooks(root, cmd);
    assert.equal(second.action, "unchanged");
    const j = JSON.parse(readFileSync(join(root, ".claude", "settings.json"), "utf8"));
    assert.equal(j.hooks.PreToolUse.length, 1, "no duplicate PreToolUse entry");
    assert.equal(j.hooks.UserPromptSubmit.length, 1, "no duplicate UserPromptSubmit entry");
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("installClaudeHooks replaces a stale Hunch entry after a folder rename (no duplication)", () => {
  const root = tmpRoot();
  try {
    installClaudeHooks(root, `"node" "/old/brain/dist/cli/index.js" hook`);
    const renamed = `"node" "/new/hunch/dist/cli/index.js" hook`;
    const r = installClaudeHooks(root, renamed);
    assert.equal(r.action, "updated");
    const j = JSON.parse(readFileSync(join(root, ".claude", "settings.json"), "utf8"));
    assert.equal(j.hooks.PreToolUse.length, 1, "old path entry replaced, not appended");
    assert.equal(j.hooks.PreToolUse[0].hooks[0].command, renamed);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("installClaudeHooks preserves foreign hooks and other settings", () => {
  const root = tmpRoot();
  try {
    const file = join(root, ".claude", "settings.json");
    // seed a user file with an unrelated hook + a top-level setting
    const seed = {
      model: "opus",
      hooks: { PreToolUse: [{ matcher: "Bash", hooks: [{ type: "command", command: "/usr/local/bin/guard.sh" }] }] },
    };
    mkdirSync(join(root, ".claude"), { recursive: true });
    writeFileSync(file, JSON.stringify(seed, null, 2));
    installClaudeHooks(root, `"node" "/abs/dist/cli/index.js" hook`);
    const j = JSON.parse(readFileSync(file, "utf8"));
    assert.equal(j.model, "opus", "top-level setting preserved");
    const cmds = j.hooks.PreToolUse.map((e: { hooks: { command: string }[] }) => e.hooks[0].command);
    assert.ok(cmds.includes("/usr/local/bin/guard.sh"), "foreign Bash hook preserved");
    assert.equal(j.hooks.PreToolUse.length, 2, "Hunch entry added alongside the foreign one");
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("installClaudeHooks refuses to clobber an unparseable settings.json", () => {
  const root = tmpRoot();
  try {
    mkdirSync(join(root, ".claude"), { recursive: true });
    writeFileSync(join(root, ".claude", "settings.json"), "{ this is not json");
    assert.throws(() => installClaudeHooks(root, `"node" "/x/index.js" hook`), /refusing to overwrite/);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});
