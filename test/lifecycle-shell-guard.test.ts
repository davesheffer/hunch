import { cleanupDir } from "./fixtures.js";
import { test } from "node:test";
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { mkdtempSync, realpathSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { refusedLifecycleCommand } from "../src/core/lifecycleShellGuard.js";
import { tsxLoaderUrl } from "./helpers.js";

const refused = [
  "hunch challenge clear con_x --reason y",
  "npx hunch challenge clear con_x --reason y",
  "npx @davesheffer/hunch challenge clear con_x --reason y",
  "npx --yes @davesheffer/hunch replace con_a con_b",
  "hunch replace con_a --with con_b",
  "hunch review --confirm",
  "hunch review dec_1 --confirm --note x",
  "node dist/cli/index.js replace con_a con_b",
  "node ./node_modules/@davesheffer/hunch/dist/cli/index.js challenge clear con_x",
  "npx tsx src/cli/index.ts review --confirm",
  "node --import tsx src/cli/index.ts replace a b",
  "cd x && hunch replace a b",
  "ls; hunch challenge clear con_x --reason y",
  "echo hi | hunch review --confirm",
  "bash -c \"hunch challenge clear con_x --reason y\"",
  "sh -c 'cd /tmp && npx hunch replace a b'",
  "HUNCH_X=1 hunch replace a b",
  "echo a\nhunch replace a b",
  "hunch review --unconfirm con_x",
  "hunch edit con_x --text y",
  "hunch link con_x --add-file a.ts",
  'hunch record-constraint "never import lodash"',
  "\\.node_modules\\.bin\\hunch.cmd replace a b",
  "node C:\\x\\hunch\\dist\\cli\\index.js replace a b",
  "node ./node_modules/@davesheffer/hunch/dist/cli/index.bundle.js replace a b",
];
const allowed = [
  "hunch rules",
  "hunch rule show con_x",
  "hunch challenge con_x --reason too broad",
  "hunch review",
  "hunch review dec_1",
  "echo \"hunch replace\"",
  "grep replace file.txt",
  "echo hunch challenge clear",
  "bash -c \"echo hunch replace\"",
  "node scripts/build.js replace",
  "npm test",
  "cat > notes.md <<EOF\nhunch replace con_1 con_2\nEOF",
  "node ../other/dist/cli/index.js replace a b",
  "hunch remove dec_1 --reason x",
  'hunch challenge con_1 --reason "clear is wrong"',
  'grep "hunch replace" README.md',
  "hunch rules --json",
  "hunch rule show con_1",
  "hunch edit dec_1 --text y",
  "hunch link dec_1 --feature f",
];

for (const c of refused) test(`refuses: ${JSON.stringify(c)}`, () => {
  const r = refusedLifecycleCommand(c);
  assert.ok(r, c);
  assert.match(r!, /^Only a person can approve a draft, clear a challenge, replace, retire, edit or re-link a rule\. Ask the user to run: /);
});
for (const c of allowed) test(`allows: ${JSON.stringify(c)}`, () => assert.equal(refusedLifecycleCommand(c), null));

test("hook entry point: denies a shell challenge clear, allows hunch rules", (t) => {
  const root = realpathSync(mkdtempSync(join(tmpdir(), "hunch-shellguard-")));
  t.after(() => cleanupDir(root));
  const run = (command: string) => execFileSync(process.execPath, ["--import", tsxLoaderUrl(), resolve("src/cli/index.ts"), "hook", "--provider", "claude"], {
    cwd: root, encoding: "utf8",
    input: JSON.stringify({ cwd: root, session_id: "s1", hook_event_name: "PreToolUse", tool_name: "Bash", tool_input: { command } }),
  }).trim();
  const denied = run("npx hunch challenge clear con_x --reason y");
  assert.equal(JSON.parse(denied).hookSpecificOutput.permissionDecision, "deny");
  assert.match(denied, /Ask the user to run/);
  assert.doesNotMatch(run("hunch rules"), /deny/);
});
