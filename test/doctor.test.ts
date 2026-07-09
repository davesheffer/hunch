import { test } from "node:test";
import assert from "node:assert/strict";
import { synthesisStatusLines } from "../src/cli/invocation.js";
import type { ProviderResolution, ProviderStatus, SynthProvider } from "../src/synthesis/provider.js";

function resolution(
  providerName: string,
  source: ProviderResolution["source"],
  statuses: ProviderStatus[],
  preference = "auto",
): ProviderResolution {
  return {
    provider: { name: providerName } as SynthProvider,
    source,
    preference: preference as ProviderResolution["preference"],
    statuses,
  };
}

test("synthesisStatusLines: a subscription CLI reports its subscription", () => {
  const r = resolution("claude-cli", "single-available", [
    { name: "claude-cli", label: "Claude Code", subscription: "Claude subscription", available: true },
  ]);
  assert.deepEqual(synthesisStatusLines(r, {}), [
    "            ↳ LLM synthesis uses your Claude subscription; provider API credentials are not used.",
  ]);
});

// Regression for issue #8/#9: openai-compat has no `subscription` (it isn't one),
// so it must NOT fall through to the "no assistant CLI found" branch the way any
// other subscription-less status would — that was the original bug.
test("synthesisStatusLines: openai-compat reports the configured endpoint/model, not 'no assistant CLI found'", () => {
  const r = resolution("openai-compat", "environment", [
    { name: "openai-compat", label: "Self-hosted / local model", subscription: null, available: true },
  ]);
  const lines = synthesisStatusLines(r, {
    HUNCH_SYNTH_BASE_URL: "http://localhost:11434/v1",
    HUNCH_SYNTH_MODEL: "qwen2.5-coder:1.5b",
  });
  assert.deepEqual(lines, [
    "            ↳ LLM synthesis via local/self-hosted endpoint http://localhost:11434/v1 (model: qwen2.5-coder:1.5b) (no API key)",
  ]);
  assert.ok(!lines.join("\n").includes("no assistant CLI found"), "must not claim no assistant CLI was found");
});

test("synthesisStatusLines: openai-compat notes when HUNCH_SYNTH_API_KEY is set", () => {
  const r = resolution("openai-compat", "environment", [
    { name: "openai-compat", label: "Self-hosted / local model", subscription: null, available: true },
  ]);
  const lines = synthesisStatusLines(r, {
    HUNCH_SYNTH_BASE_URL: "http://localhost:11434/v1",
    HUNCH_SYNTH_MODEL: "qwen2.5-coder:1.5b",
    HUNCH_SYNTH_API_KEY: "sk-local",
  });
  assert.deepEqual(lines, [
    "            ↳ LLM synthesis via local/self-hosted endpoint http://localhost:11434/v1 (model: qwen2.5-coder:1.5b) (HUNCH_SYNTH_API_KEY set)",
  ]);
});

test("synthesisStatusLines: ambiguous source lists the available candidates and how to choose", () => {
  const r = resolution("deterministic", "ambiguous", [
    { name: "claude-cli", label: "Claude Code", subscription: "Claude subscription", available: true },
    { name: "codex-cli", label: "Codex", subscription: "ChatGPT subscription", available: true },
    { name: "deterministic", label: "Deterministic local fallback", subscription: null, available: true },
  ]);
  const lines = synthesisStatusLines(r, {});
  assert.ok(lines[0]!.includes("claude-cli, codex-cli"), `expected both candidates listed: ${lines[0]}`);
  assert.ok(lines[1]!.includes("hunch provider claude-cli") && lines[1]!.includes("hunch provider codex-cli"));
});

test("synthesisStatusLines: unavailable-preference source names the preference and falls back", () => {
  const r = resolution("deterministic", "unavailable-preference", [
    { name: "deterministic", label: "Deterministic local fallback", subscription: null, available: true },
  ], "codex-cli");
  assert.deepEqual(synthesisStatusLines(r, {}), [
    "\x1b[2m            ↳ codex-cli was selected but is unavailable; using the offline heuristic.\x1b[0m",
  ]);
});

// Regression guard: the no-CLI-available fallback message stays unchanged.
test("synthesisStatusLines: no assistant CLI available keeps the offline-heuristic message", () => {
  const r = resolution("deterministic", "none", [
    { name: "deterministic", label: "Deterministic local fallback", subscription: null, available: true },
  ]);
  const expected = [
    "\x1b[2m            ↳ no assistant CLI found — synthesis uses the offline heuristic (advisory, low-confidence).\x1b[0m",
    "\x1b[2m              install or log into Claude Code, Codex, or Cursor; then select one with `hunch provider <name>`.\x1b[0m",
  ];
  assert.deepEqual(synthesisStatusLines(r, {}), expected);
});
