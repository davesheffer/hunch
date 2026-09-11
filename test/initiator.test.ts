import { test } from "node:test";
import assert from "node:assert/strict";
import { currentInitiator, withInitiator, initiatorFromClient, initiatorChildEnv, assertInitiatorProvider } from "../src/synthesis/initiator.js";
import { resolveSynthesisProvider, selectWorkers, selectEnsemble, selectVerifier, type SynthProvider } from "../src/synthesis/provider.js";

function provider(name: string, available = true): SynthProvider {
  return { name, available: async () => available,
    draftDecision: async () => ({ title: name, context: "source", decision: "preserve source account", consequences: [], alternatives_rejected: [], confidence: 0.6, source: name }),
    draftBug: async () => { throw new Error("not used"); } };
}
const providers = [provider("claude-cli"), provider("codex-cli"), provider("kimi-cli"), provider("other-cli"), provider("deterministic")];

test("initiator overrides another configured account across normal, deep and verifier selection", async () => {
  for (const origin of ["claude-cli", "codex-cli", "kimi-cli", "other-cli"]) {
    await withInitiator({ provider: origin, source: "explicit" }, async () => {
      const opts = { providers, env: { HUNCH_SYNTH_PROVIDER: "claude-cli" } };
      const result = await resolveSynthesisProvider(opts);
      assert.equal(result.provider.name, origin);
      assert.equal(result.source, "initiator");
      assert.equal((await selectVerifier(opts))?.name, origin);
      assert.deepEqual((await selectWorkers(opts)).map(p => p.name), [origin]);
      const ensemble = await selectEnsemble({ ...opts, samples: 2 });
      const draft = await ensemble!.draftDecision({ subject: "s", body: "", files: [], diff: "" });
      assert.equal(draft.title, origin);
      assert.equal(draft.samples, 2);
    });
  }
});

test("offline override and missing initiating provider never launch another account", async () => {
  await withInitiator({ provider: "kimi-cli", source: "explicit" }, async () => {
    const disabled = await resolveSynthesisProvider({ providers, env: { HUNCH_SYNTH_PROVIDER: "deterministic" } });
    assert.equal(disabled.provider.name, "deterministic");
    const result = await resolveSynthesisProvider({ providers: [provider("claude-cli")], env: {} });
    assert.equal(result.provider.name, "deterministic");
    assert.equal(result.source, "unavailable-initiator");
    assert.deepEqual(await selectWorkers({ providers: [provider("claude-cli")], env: {} }), []);
  });
});

test("concurrent MCP origins stay isolated, including deferred child environment snapshots", async () => {
  const results = await Promise.all(["claude", "codex", "kimi"].map(name =>
    withInitiator(initiatorFromClient(name), async () => {
      await new Promise(resolve => setTimeout(resolve, 5));
      const selected = await resolveSynthesisProvider({ providers, env: { HUNCH_SYNTH_PROVIDER: "claude-cli" } });
      const child = initiatorChildEnv({ SAFE_CONFIG: "kept", CODEX_THREAD_ID: "server-host" });
      assert.equal(currentInitiator().provider, selected.provider.name);
      assert.equal(child.HUNCH_INITIATOR, selected.provider.name);
      assert.equal(child.SAFE_CONFIG, "kept");
      assert.throws(() => assertInitiatorProvider("wrong-cli"), /account switch/);
      return selected.provider.name;
    })));
  assert.deepEqual(results, ["claude-cli", "codex-cli", "kimi-cli"]);
});

test("unknown MCP clients cannot inherit the account of the server's launching shell", async () => {
  const origin = initiatorFromClient("Some editor");
  await withInitiator(origin, async () => {
    const result = await resolveSynthesisProvider({ providers,
      env: { CODEX_THREAD_ID: "launcher", HUNCH_SYNTH_PROVIDER: "claude-cli" } });
    assert.equal(result.provider.name, "deterministic");
    assert.equal(result.source, "unknown-initiator");
    assert.equal(initiatorChildEnv({}).HUNCH_INITIATOR, "unknown");
  });
});

test("an explicitly unknown background origin cannot bypass selection with a direct launch", () => {
  withInitiator({ provider: null, source: "unknown" }, () => {
    assert.throws(() => assertInitiatorProvider("codex-cli"), /Unknown initiating event/);
  });
});
