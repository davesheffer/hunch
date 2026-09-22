import { test } from "node:test";
import assert from "node:assert/strict";
import { realpathSync, symlinkSync } from "node:fs";
import { join } from "node:path";
import { detectInitiator } from "../src/synthesis/initiator.js";
import { cleanupDir, isolatedCliEnv, tempDir } from "./helpers.js";

test("fixture CLI environment drops every inherited initiator and preserves explicit fixture choices", () => {
  const inherited = { CLAUDECODE: "1", CODEX_THREAD_ID: "thread", CODEX_SESSION_ID: "session", HUNCH_INITIATOR: "claude-cli", HUNCH_SYNTH_PROVIDER: "claude-cli", PATH: "fixture-bin" };
  const env = isolatedCliEnv({ HUNCH_SYNTH_PROVIDER: "codex-cli" }, inherited);
  assert.deepEqual(detectInitiator(env), { provider: null, source: "unknown" });
  assert.equal(env.HUNCH_SYNTH_PROVIDER, "codex-cli");
  assert.equal(env.PATH, inherited.PATH);
  assert.equal(isolatedCliEnv({}, inherited).HUNCH_SYNTH_PROVIDER, "deterministic");
  assert.equal(inherited.HUNCH_INITIATOR, "claude-cli", "never mutate the host environment");
});

test("fixture roots resolve a symlinked temporary parent before git reports their paths", () => {
  const root = tempDir("hunch-canonical-fixture-");
  try {
    const alias = join(root, "alias");
    symlinkSync(root, alias, process.platform === "win32" ? "junction" : "dir");
    const child = tempDir("child-", alias);
    assert.equal(child, realpathSync(child));
    assert.ok(child.startsWith(root));
    assert.ok(!child.includes("alias"));
  } finally { cleanupDir(root); }
});
