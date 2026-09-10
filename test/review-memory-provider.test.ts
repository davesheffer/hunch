import { test } from "node:test";
import assert from "node:assert/strict";
import { boundReviewGenerator, reviewInitiator } from "../src/cli/reviewMemoryProvider.js";

test("explicit initiator binds Claude, Codex, Kimi and arbitrary configured CLIs", () => {
  for (const [input, expected] of [["claude", "claude-cli"], ["codex", "codex-cli"], ["kimi", "kimi-cli"], ["my-agent", "my-agent"]]) {
    assert.equal(reviewInitiator(input, { CODEX_THREAD_ID: "other-host" }), expected);
  }
  assert.equal(reviewInitiator(undefined, { HUNCH_REVIEW_INITIATOR: "kimi", CODEX_THREAD_ID: "host" }), "kimi-cli");
});

test("only unambiguous live harness identity is detected, not installed tools or preferences", () => {
  assert.equal(reviewInitiator(undefined, { CODEX_THREAD_ID: "session" }), "codex-cli");
  assert.equal(reviewInitiator(undefined, { CLAUDECODE: "1" }), "claude-cli");
  assert.throws(() => reviewInitiator(undefined, { HUNCH_SYNTH_PROVIDER: "claude-cli" }), /unknown or ambiguous/);
  assert.throws(() => reviewInitiator(undefined, { CODEX_THREAD_ID: "session", CLAUDECODE: "1" }), /ambiguous/);
  for (const name of ["auto", "available", "deterministic", "x;echo"]) assert.throws(() => reviewInitiator(name, {}));
});

test("failed or malformed initiator responses never select a different provider", async () => {
  for (const draftProse of [async () => { throw new Error("unavailable"); }, async () => "not JSON"]) {
    const generator = boundReviewGenerator({ name: "kimi-cli", draftProse });
    await assert.rejects(generator.draftProse("data"));
    assert.deepEqual(generator.providersUsed(), []);
  }
});

test("provider identity is retained in telemetry", async () => {
  const generator = boundReviewGenerator({ name: "my-agent", draftProse: async () => '{"action":"review"}' });
  assert.equal(JSON.parse(await generator.draftProse("data")).action, "review");
  assert.equal(generator.name, "my-agent");
  assert.deepEqual(generator.providersUsed(), ["my-agent"]);
});
