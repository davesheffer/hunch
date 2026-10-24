import test from "node:test";
import assert from "node:assert/strict";
import { createServer } from "node:http";
import type { AddressInfo } from "node:net";
import { synthesisStatusLines, maybeWarnOllamaContext } from "../src/cli/invocation.js";
import type { ProviderResolution, ProviderStatus, SynthProvider } from "../src/synthesis/provider.js";

function resolution(
  name: string,
  source: ProviderResolution["source"],
  statuses: ProviderStatus[],
  preference: ProviderResolution["preference"] = "auto",
): ProviderResolution {
  return { provider: { name } as unknown as SynthProvider, source, preference, statuses };
}

const st = (name: string, subscription: string | null, available = true): ProviderStatus =>
  ({ name, label: name, subscription, available }) as ProviderStatus;

const DIM = (s: string) => `\x1b[2m${s}\x1b[0m`;

test("synthesisStatusLines: subscription CLI names the subscription", () => {
  const r = resolution("claude-cli", "single-available", [st("claude-cli", "Claude subscription")]);
  assert.deepEqual(synthesisStatusLines(r, {}), [
    "            ↳ LLM synthesis uses your Claude subscription; provider API credentials are not used.",
  ]);
});

test("synthesisStatusLines: openai-compat is not reported as 'no assistant CLI found'", () => {
  const r = resolution("openai-compat", "environment", [st("openai-compat", null)]);
  const lines = synthesisStatusLines(r, {
    HUNCH_SYNTH_BASE_URL: "http://localhost:11434/v1",
    HUNCH_SYNTH_MODEL: "qwen2.5-coder:1.5b",
  });
  assert.deepEqual(lines, [
    "            ↳ LLM synthesis via local/self-hosted endpoint http://localhost:11434/v1 (model: qwen2.5-coder:1.5b) (no API key)",
  ]);
  assert.ok(!lines.join("\n").includes("no assistant CLI found"));
});

test("synthesisStatusLines: openai-compat notes a configured API key", () => {
  const r = resolution("openai-compat", "environment", [st("openai-compat", null)]);
  const lines = synthesisStatusLines(r, {
    HUNCH_SYNTH_BASE_URL: "http://localhost:11434/v1",
    HUNCH_SYNTH_MODEL: "qwen2.5-coder:1.5b",
    HUNCH_SYNTH_API_KEY: "k",
  });
  assert.deepEqual(lines, [
    "            ↳ LLM synthesis via local/self-hosted endpoint http://localhost:11434/v1 (model: qwen2.5-coder:1.5b) (HUNCH_SYNTH_API_KEY set)",
  ]);
});

test("synthesisStatusLines: openai-compat treats an empty HUNCH_SYNTH_BASE_URL / HUNCH_SYNTH_MODEL as unset", () => {
  const r = resolution("openai-compat", "environment", [st("openai-compat", null)]);
  const lines = synthesisStatusLines(r, { HUNCH_SYNTH_BASE_URL: "", HUNCH_SYNTH_MODEL: "" });
  assert.deepEqual(lines, [
    "            ↳ LLM synthesis via local/self-hosted endpoint (unset) (model: (unset)) (no API key)",
  ]);
});

test("synthesisStatusLines: ambiguous lists the candidates and how to choose", () => {
  const r = resolution("deterministic", "ambiguous", [
    st("claude-cli", "Claude subscription"),
    st("codex-cli", "ChatGPT subscription"),
    st("deterministic", null),
  ]);
  const lines = synthesisStatusLines(r, {});
  assert.ok(lines[0].includes("claude-cli, codex-cli"), lines[0]);
  assert.ok(lines[1].includes("hunch provider claude-cli") && lines[1].includes("hunch provider codex-cli"), lines[1]);
});

test("synthesisStatusLines: unavailable preference names the selected provider", () => {
  const r = resolution("deterministic", "unavailable-preference", [st("deterministic", null)], "codex-cli");
  assert.deepEqual(synthesisStatusLines(r, {}), [
    DIM("            ↳ codex-cli was selected but is unavailable; using the offline heuristic."),
  ]);
});

test("synthesisStatusLines: no CLI found falls back to the two advisory lines", () => {
  const r = resolution("deterministic", "none", [st("deterministic", null)]);
  assert.deepEqual(synthesisStatusLines(r, {}), [
    DIM("            ↳ no assistant CLI found — synthesis uses the offline heuristic (advisory, low-confidence)."),
    DIM("              install or log into Claude Code, Codex, or Cursor; then select one with `hunch provider <name>`."),
  ]);
});

test("maybeWarnOllamaContext: null for every non-openai-compat provider", async () => {
  for (const name of ["claude-cli", "codex-cli", "cursor-agent", "deterministic", "ensemble"]) {
    assert.equal(await maybeWarnOllamaContext(name, {}), null, name);
  }
});

test("maybeWarnOllamaContext: warns when the Ollama model does not pin num_ctx", async () => {
  const server = createServer((_req, res) => {
    res.setHeader("content-type", "application/json");
    res.end(JSON.stringify({ parameters: "" }));
  });
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  const port = (server.address() as AddressInfo).port;
  try {
    const warning = await maybeWarnOllamaContext("openai-compat", {
      HUNCH_SYNTH_BASE_URL: `http://127.0.0.1:${port}`,
      HUNCH_SYNTH_MODEL: "m",
    });
    assert.ok(warning?.includes("does not pin num_ctx"), `expected an unpinned-context warning, got: ${warning}`);
    assert.ok(!warning?.includes("4096"), `must not guess the server's effective context: ${warning}`);
  } finally {
    await new Promise<void>((resolve) => server.close(() => resolve()));
  }
});
