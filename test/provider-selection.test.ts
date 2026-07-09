import { mkdtempSync, mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import assert from "node:assert/strict";
import { test } from "node:test";
import {
  readSynthesisPreference,
  resolveSynthesisProvider,
  selectVerifier,
  writeSynthesisPreference,
  type BugDraft,
  type CommitInput,
  type DecisionDraft,
  type FailureInput,
  type SynthProvider,
} from "../src/synthesis/provider.js";

function fakeProvider(name: string, available: boolean): SynthProvider {
  return {
    name,
    async available() { return available; },
    async draftDecision(_input: CommitInput): Promise<DecisionDraft> { throw new Error("not used in selection tests"); },
    async draftBug(_input: FailureInput): Promise<BugDraft> { throw new Error("not used in selection tests"); },
  };
}

function registry(available: Partial<Record<"claude-cli" | "codex-cli" | "cursor-agent", boolean>>): SynthProvider[] {
  return [
    fakeProvider("claude-cli", !!available["claude-cli"]),
    fakeProvider("codex-cli", !!available["codex-cli"]),
    fakeProvider("cursor-agent", !!available["cursor-agent"]),
    fakeProvider("deterministic", true),
  ];
}

function tempRoot(): string {
  const root = mkdtempSync(join(tmpdir(), "hunch-provider-selection-"));
  mkdirSync(join(root, ".hunch"));
  return root;
}

test("auto mode never guesses between multiple subscription CLIs", async () => {
  const root = tempRoot();
  try {
    const providers = registry({ "claude-cli": true, "codex-cli": true });
    const result = await resolveSynthesisProvider({ root, providers, env: {} });
    assert.equal(result.provider.name, "deterministic");
    assert.equal(result.source, "ambiguous");
    assert.equal((await selectVerifier({ root, providers, env: {} })), null);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("auto mode uses the only available subscription CLI", async () => {
  const root = tempRoot();
  try {
    const providers = registry({ "codex-cli": true });
    const result = await resolveSynthesisProvider({ root, providers, env: {} });
    assert.equal(result.provider.name, "codex-cli");
    assert.equal(result.source, "single-available");
    assert.equal((await selectVerifier({ root, providers, env: {} }))?.name, "codex-cli");
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("an explicit environment override wins over the local user preference", async () => {
  const root = tempRoot();
  try {
    writeSynthesisPreference(root, "claude-cli");
    const result = await resolveSynthesisProvider({
      root,
      providers: registry({ "claude-cli": true, "codex-cli": true }),
      env: { HUNCH_SYNTH_PROVIDER: "codex-cli" },
    });
    assert.equal(result.provider.name, "codex-cli");
    assert.equal(result.source, "environment");
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("local preference is gitignored state and preserves existing local settings", async () => {
  const root = tempRoot();
  try {
    const file = join(root, ".hunch", "local.json");
    writeFileSync(file, JSON.stringify({ privateDir: "/private/memory", autoCommit: false }) + "\n");
    writeSynthesisPreference(root, "cursor-agent");
    assert.equal(readSynthesisPreference(root), "cursor-agent");
    assert.deepEqual(JSON.parse(readFileSync(file, "utf8")), {
      privateDir: "/private/memory",
      autoCommit: false,
      synthProvider: "cursor-agent",
    });
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("setting a provider never overwrites malformed local configuration", () => {
  const root = tempRoot();
  try {
    const file = join(root, ".hunch", "local.json");
    writeFileSync(file, "{not-json");
    assert.throws(() => writeSynthesisPreference(root, "codex-cli"), /refusing to overwrite malformed/);
    assert.equal(readFileSync(file, "utf8"), "{not-json");
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});
