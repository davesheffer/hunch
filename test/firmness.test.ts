import { cleanupDir } from "./fixtures.js";
import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, mkdirSync, writeFileSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { hunchPaths } from "../src/core/paths.js";
import { readConfig, writeConfig, DEFAULT_FIRMNESS } from "../src/core/config.js";
import { installClaudeHooks } from "../src/integrations/scaffold.js";
import { isHunchHookCommand } from "../src/integrations/hookmatch.js";
import { publishedMcpInvocation, shellInvocation } from "../src/cli/invocation.js";

function tmpRoot(): string {
  return mkdtempSync(join(tmpdir(), "hunch-firmness-"));
}

test("readConfig defaults to advisory when no config file exists", () => {
  const root = tmpRoot();
  try {
    assert.equal(readConfig(hunchPaths(root)).firmness, DEFAULT_FIRMNESS);
    assert.equal(DEFAULT_FIRMNESS, "advisory");
  } finally {
    cleanupDir(root);
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
    cleanupDir(root);
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
    assert.match(j.hooks.PostToolUseFailure[0].matcher, /Bash/);
    assert.equal(j.hooks.Stop[0].hooks[0].command, cmd);
    assert.equal(j.hooks.SubagentStart[0].hooks[0].command, cmd, "delegated agents get grounding");
    assert.equal(j.hooks.PreCompact[0].hooks[0].command, cmd, "compaction resets injection dedup");
  } finally {
    cleanupDir(root);
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
    cleanupDir(root);
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
    cleanupDir(root);
  }
});

test("installClaudeHooks replaces a legacy published npx entry during upgrade", () => {
  const root = tmpRoot();
  try {
    const file = join(root, ".claude", "settings.json");
    const legacy = 'npx -y --package=hunch-exact@npm:@davesheffer/hunch@1.17.0 hunch hook';
    mkdirSync(join(root, ".claude"), { recursive: true });
    writeFileSync(file, JSON.stringify({
      permissions: { allow: ["Bash(git commit *)"] },
      hooks: {
        PreToolUse: [{ matcher: "Edit|Write|MultiEdit", hooks: [{ type: "command", command: legacy }] }],
        UserPromptSubmit: [{ hooks: [{ type: "command", command: legacy }] }],
      },
    }, null, 2));

    const current = `${shellInvocation(publishedMcpInvocation())} hook`;
    installClaudeHooks(root, current);

    const j = JSON.parse(readFileSync(file, "utf8"));
    assert.deepEqual(j.permissions.allow, ["Bash(git commit *)"], "non-Hunch settings stay intact");
    assert.equal(j.hooks.PreToolUse.length, 1, "legacy PreToolUse entry is replaced, not duplicated");
    assert.equal(j.hooks.UserPromptSubmit.length, 1, "legacy prompt hook is replaced, not duplicated");
    assert.equal(j.hooks.PreToolUse[0].hooks[0].command, current);
    assert.equal(j.hooks.UserPromptSubmit[0].hooks[0].command, current);
    assert.match(current, /^npx -y --package=hunch-exact@npm:@davesheffer\/hunch@\d+\.\d+\.\d+ hunch hook$/);
  } finally {
    cleanupDir(root);
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
    cleanupDir(root);
  }
});

test("installClaudeHooks keeps the user's command out of a MIXED entry (issue #310)", () => {
  const root = tmpRoot();
  try {
    const file = join(root, ".claude", "settings.json");
    const stale = `"node" "/old/dist/cli/index.js" hook`;
    const mine = "/usr/local/bin/my-guard.sh";
    mkdirSync(join(root, ".claude"), { recursive: true });
    // One entry holding BOTH Hunch's hook and the user's own command.
    writeFileSync(file, JSON.stringify({
      hooks: {
        PreToolUse: [{
          matcher: "Edit|Write|MultiEdit",
          hooks: [{ type: "command", command: stale }, { type: "command", command: mine }],
        }],
      },
    }, null, 2));

    const cmd = `"node" "/new/dist/cli/index.js" hook`;
    installClaudeHooks(root, cmd);

    const j = JSON.parse(readFileSync(file, "utf8"));
    const all = j.hooks.PreToolUse.flatMap((e: { hooks: { command: string }[] }) => e.hooks.map((h) => h.command));
    assert.equal(all.filter((c: string) => c === mine).length, 1, "the user's command survives exactly once");
    assert.equal(all.filter((c: string) => c === cmd).length, 1, "Hunch's hook is present exactly once");
    assert.ok(!all.includes(stale), "the stale Hunch command is gone");
    const kept = j.hooks.PreToolUse.find((e: { hooks: { command: string }[] }) => e.hooks.some((h) => h.command === mine));
    assert.equal(kept.matcher, "Edit|Write|MultiEdit", "the user's entry keeps its matcher");
  } finally {
    cleanupDir(root);
  }
});

test("installClaudeHooks preserves a FOREIGN …/dist/cli/index.js hook (issue #310)", () => {
  const root = tmpRoot();
  try {
    const file = join(root, ".claude", "settings.json");
    const foreign = "node tools/lint/dist/cli/index.js hook";
    mkdirSync(join(root, ".claude"), { recursive: true });
    writeFileSync(file, JSON.stringify({
      hooks: { PreToolUse: [{ matcher: "Edit", hooks: [{ type: "command", command: foreign }] }] },
    }, null, 2));

    installClaudeHooks(root, `"node" "/abs/dist/cli/index.js" hook`);

    const j = JSON.parse(readFileSync(file, "utf8"));
    const all = j.hooks.PreToolUse.flatMap((e: { hooks: { command: string }[] }) => e.hooks.map((h) => h.command));
    assert.ok(all.includes(foreign), "an unrelated tool's index.js hook is not ours to delete");
    assert.equal(j.hooks.PreToolUse.length, 2, "Hunch entry added alongside the foreign one");
  } finally {
    cleanupDir(root);
  }
});

test("installClaudeHooks stays idempotent for the UNQUOTED source command shellInvocation writes (issue #310)", () => {
  // Since v1.21.1 init writes `${agentHookShell} hook`, and shellInvocation leaves a
  // safe POSIX path bare — so the real source-install command has no quotes at all.
  for (const inv of [
    { command: "/usr/local/bin/node", args: ["/Users/me/hunch/dist/cli/index.js"] },
    { command: "npx", args: ["tsx", "/Users/me/hunch/src/cli/index.ts"] },
    { command: "/usr/local/bin/node", args: ["/Users/my name/hunch/dist/cli/index.js"] },
  ]) {
    const root = tmpRoot();
    try {
      const cmd = `${shellInvocation(inv)} hook`;
      installClaudeHooks(root, cmd);
      assert.equal(installClaudeHooks(root, cmd).action, "unchanged", cmd);
      // Upgrade to the published launcher: the source hook is replaced, not kept beside it.
      installClaudeHooks(root, `${shellInvocation(publishedMcpInvocation())} hook`);
      const j = JSON.parse(readFileSync(join(root, ".claude", "settings.json"), "utf8"));
      for (const [event, entries] of Object.entries(j.hooks as Record<string, { hooks: unknown[] }[]>)) {
        assert.equal(entries.flatMap((e) => e.hooks).length, 1, `${event}: exactly one Hunch command after upgrade from ${cmd}`);
      }
    } finally {
      cleanupDir(root);
    }
  }
});

test("the Claude Code hook matcher covers every shape init has written and nothing chained or look-alike (issue #310)", () => {
  const ours = [
    `"/usr/local/bin/node" "/Users/me/hunch/dist/cli/index.js" hook`, // ≤ v1.21.0: every token quoted
    `"/usr/local/bin/node" "/usr/local/lib/node_modules/@davesheffer/hunch/dist/cli/index.js" hook`,
    `npx tsx "/Users/me/hunch/src/cli/index.ts" hook`,
    `"C:\\nodejs\\node.exe" "C:\\src\\hunch\\dist\\cli\\index.js" hook`,
    `npx -y --package=hunch-exact@npm:@davesheffer/hunch@1.39.2 hunch hook`,
    `npx -y --package=@davesheffer/hunch hunch hook`,
    `/usr/local/bin/node /Users/me/hunch/dist/cli/index.js hook`, // ≥ v1.21.1: safe tokens bare
    `npx tsx /Users/me/hunch/src/cli/index.ts hook`,
    `/usr/local/bin/node "/Users/my name/hunch/dist/cli/index.js" hook`,
  ];
  const foreign = [
    `node tools/lint/dist/cli/index.js hook`,
    `node "tools/lint/dist/cli/index.js" hook`,
    `./mine.sh; npx -y --package=hunch-exact@npm:@davesheffer/hunch@1.22.0 hunch hook`,
    `./mine.sh && /usr/local/bin/node /Users/me/hunch/dist/cli/index.js hook`,
    `./scripts/notify.sh --about @davesheffer/hunch hook`,
    `node node_modules/@davesheffer/hunch-plugin/bin.js hook`,
    `echo @davesheffer/hunch is cool && ./my-git hook`,
    `node ./hook/index.js`,
  ];
  for (const command of ours) assert.equal(isHunchHookCommand(command, false), true, `ours: ${command}`);
  for (const command of foreign) assert.equal(isHunchHookCommand(command, false), false, `foreign: ${command}`);
});

test("installClaudeHooks keeps a user command that CHAINS the Hunch hook (issue #310)", () => {
  const root = tmpRoot();
  try {
    const file = join(root, ".claude", "settings.json");
    const chained = "./mine.sh; npx -y --package=hunch-exact@npm:@davesheffer/hunch@1.22.0 hunch hook";
    mkdirSync(join(root, ".claude"), { recursive: true });
    writeFileSync(file, JSON.stringify({ hooks: { Stop: [{ hooks: [{ type: "command", command: chained }] }] } }, null, 2));
    installClaudeHooks(root, `${shellInvocation(publishedMcpInvocation())} hook`);
    const j = JSON.parse(readFileSync(file, "utf8"));
    const all = j.hooks.Stop.flatMap((e: { hooks: { command: string }[] }) => e.hooks.map((h) => h.command));
    assert.ok(all.includes(chained), "a command the user wrote around ours is theirs, not ours to delete");
  } finally {
    cleanupDir(root);
  }
});

test("installClaudeHooks refuses to clobber an unparseable settings.json", () => {
  const root = tmpRoot();
  try {
    mkdirSync(join(root, ".claude"), { recursive: true });
    writeFileSync(join(root, ".claude", "settings.json"), "{ this is not json");
    assert.throws(() => installClaudeHooks(root, `"node" "/x/index.js" hook`), /refusing to overwrite/);
  } finally {
    cleanupDir(root);
  }
});
