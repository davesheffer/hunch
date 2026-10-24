import { cleanupDir } from "./fixtures.js";
import { mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import assert from "node:assert/strict";
import { test, type TestContext } from "node:test";
import { withInitiator } from "../src/synthesis/initiator.js";
import { __resetAvailabilityCacheForTests, resolveSynthesisProvider } from "../src/synthesis/provider.js";

function fixture(t: TestContext): string {
  const root = mkdtempSync(join(tmpdir(), "hunch-provider-config-"));
  const path = process.env.PATH;
  // Prevent availability probes from finding any installed assistant CLI.
  process.env.PATH = root;
  __resetAvailabilityCacheForTests();
  t.after(() => {
    if (path === undefined) delete process.env.PATH; else process.env.PATH = path;
    __resetAvailabilityCacheForTests();
    cleanupDir(root);
  });
  return root;
}

for (const source of ["cliConfig", "HUNCH_CLI_CONFIG", "HUNCH_REVIEW_CLI_CONFIG"] as const) {
  for (const [name, contents] of [
    ["missing", undefined],
    ["malformed", '{"token":"PRIVATE_CONFIG_SENTINEL"'],
    ["invalid adapter", '[{"name":"custom","command":"PRIVATE_CONFIG_SENTINEL"}]'],
  ] as const) {
    test(`${source}: ${name} config falls back without disclosing config data`, async (t) => {
      const root = fixture(t), config = join(root, "adapters.json");
      if (contents !== undefined) writeFileSync(config, contents);
      const warnings = t.mock.method(console, "warn", () => {});
      const opts = source === "cliConfig" ? { cliConfig: config, env: {} }
        : { env: { [source]: config } };

      const selected = await withInitiator({ provider: "custom", source: "explicit" },
        () => resolveSynthesisProvider(opts));

      assert.equal(selected.provider.name, "deterministic");
      assert.equal(selected.source, "unavailable-initiator");
      assert.equal(selected.initiator, "custom");
      const draft = await selected.provider.draftDecision({ subject: "fix: handle invalid config", body: "", files: [], diff: "" });
      assert.equal(draft.source, "inferred");
      assert.equal(draft.title, "fix: handle invalid config");
      assert.equal(warnings.mock.callCount(), 1);
      const warning = warnings.mock.calls[0]!.arguments.join(" ");
      assert.match(warning, /CLI adapter config.*deterministic/i);
      assert.ok(!warning.includes("PRIVATE_CONFIG_SENTINEL"));
      assert.ok(!warning.includes(config));
      if (contents !== undefined) assert.equal(readFileSync(config, "utf8"), contents);
    });
  }
}

test("valid custom CLI config still resolves the initiating adapter", async (t) => {
  const root = fixture(t), config = join(root, "adapters.json");
  writeFileSync(config, JSON.stringify([{
    name: "custom", command: process.execPath, args: [], protocol: "stdin", probe_args: ["--version"],
  }]));
  const warnings = t.mock.method(console, "warn", () => {});
  const selected = await withInitiator({ provider: "custom", source: "explicit" },
    () => resolveSynthesisProvider({ cliConfig: config, env: {} }));

  assert.equal(selected.provider.name, "custom");
  assert.equal(selected.source, "initiator");
  assert.equal(warnings.mock.callCount(), 0);
});

test("explicit offline mode ignores invalid custom CLI config without warning", async (t) => {
  const root = fixture(t), config = join(root, "missing.json");
  const warnings = t.mock.method(console, "warn", () => {});
  const selected = await withInitiator({ provider: "custom", source: "explicit" },
    () => resolveSynthesisProvider({ cliConfig: config, env: { HUNCH_SYNTH_PROVIDER: "deterministic" } }));

  assert.equal(selected.provider.name, "deterministic");
  assert.equal(selected.source, "environment");
  assert.equal(warnings.mock.callCount(), 0);
});
