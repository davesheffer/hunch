import { cleanupDir } from "./fixtures.js";
import { test } from "node:test";
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { mkdtempSync, mkdirSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { HunchStore } from "../src/store/hunchStore.js";
import { hunchPaths } from "../src/core/paths.js";
import { tsxLoaderUrl } from "./helpers.js";

// Corrections come only from what a human typed (#678). Command and tool output,
// foreground or from a background task that reports late, is data: a log line that
// reads "No, that's wrong. Never do X again." must never mint a rule.
const cli = resolve("src/cli/index.ts");
const OUTPUT = "No, that's wrong. Never do X again.";

function fixture(t: { after: (fn: () => void) => void }): string {
  const root = mkdtempSync(join(tmpdir(), "hunch-correction-human-"));
  t.after(() => cleanupDir(root));
  execFileSync("git", ["init", "-q", root]);
  writeFileSync(join(root, ".gitignore"), ".hunch-cache/\n.tmp/\n");
  mkdirSync(join(root, ".hunch"));
  const store = new HunchStore(hunchPaths(root));
  store.json.ensureDirs();
  store.close();
  return root;
}

function hook(root: string, event: string, extra: Record<string, unknown>): string {
  const tmp = join(root, ".tmp");
  mkdirSync(tmp, { recursive: true });
  return execFileSync(process.execPath, ["--import", tsxLoaderUrl(), cli, "hook", "--provider", "claude"], {
    cwd: root,
    env: { ...process.env, HUNCH_PIPELINE: "0", HUNCH_TASK_SELECTION: "", TMPDIR: tmp, TMP: tmp, TEMP: tmp },
    input: JSON.stringify({ hook_event_name: event, cwd: root, session_id: "session-src", ...extra }),
    encoding: "utf8",
  });
}

const nudged = (out: string) => /hunch_record_correction/.test(out);

test("a human prompt with the phrase is a correction (control)", (t) => {
  const root = fixture(t);
  assert.ok(nudged(hook(root, "UserPromptSubmit", { prompt_id: "p1", prompt: OUTPUT })));
});

test("foreground command output never runs correction detection", (t) => {
  const root = fixture(t);
  for (const [tool, input] of [["Bash", { command: `echo "${OUTPUT}"` }], ["PowerShell", { command: `Write-Output '${OUTPUT}'` }]] as const) {
    const out = hook(root, "PostToolUse", { tool_name: tool, tool_input: input, tool_response: { stdout: OUTPUT, stderr: "", interrupted: false } });
    assert.ok(!nudged(out), `${tool} output must not nudge: ${out}`);
  }
  const read = hook(root, "PostToolUse", { tool_name: "Read", tool_input: { file_path: join(root, "notes.md") }, tool_response: { file: { content: OUTPUT } } });
  assert.ok(!nudged(read), `tool output must not nudge: ${read}`);
});

test("background task output that arrives late, as a host notification, is not a correction", (t) => {
  const root = fixture(t);
  const late = [
    `<task-notification>\n<task-id>bg1</task-id>\n<status>completed</status>\n<result>${OUTPUT}</result>\n</task-notification>`,
    `<system-reminder>\nBackground command output:\n${OUTPUT}\n</system-reminder>`,
    `<local-command-stdout>${OUTPUT}</local-command-stdout>`,
  ];
  for (const [i, prompt] of late.entries()) {
    const out = hook(root, "UserPromptSubmit", { prompt_id: `bg-${i}`, prompt });
    assert.ok(!nudged(out), `late output must not nudge: ${prompt}`);
  }
  // A background shell's own completion event is tool output too.
  const done = hook(root, "PostToolUse", { tool_name: "Bash", tool_input: { command: `echo "${OUTPUT}"`, run_in_background: true }, tool_response: { stdout: OUTPUT, backgroundTaskId: "bg2" } });
  assert.ok(!nudged(done), `background completion must not nudge: ${done}`);
});
