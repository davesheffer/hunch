import { test } from "node:test";
import assert from "node:assert/strict";
import { extractCodexText, selectProvider } from "../src/synthesis/provider.js";

test("extractCodexText returns the LAST assistant text from codex --json JSONL", () => {
  const jsonl = [
    '{"type":"thread.started"}',
    '{"type":"item.completed","item":{"type":"reasoning","text":"thinking out loud"}}',
    '{"type":"item.completed","item":{"type":"agent_message","text":"FINAL ANSWER"}}',
    '{"type":"turn.completed"}',
  ].join("\n");
  assert.equal(extractCodexText(jsonl), "FINAL ANSWER");
});

test("extractCodexText tolerates partial/garbage lines and trailing CRLF", () => {
  const out = 'noise\r\n{"item":{"text":"one"}}\r\nnot json {\r\n{"text":"two"}\r\n';
  assert.equal(extractCodexText(out), "two");
});

test("extractCodexText falls back to raw output when there are no JSON events", () => {
  assert.equal(extractCodexText("plain final answer"), "plain final answer");
});

test("selectProvider never throws and resolves to some provider when one is forced-unavailable", async () => {
  process.env.HUNCH_SYNTH_PROVIDER = "codex-cli"; // not installed here → must fall through
  try {
    const p = await selectProvider();
    assert.ok(p.name, "resolved to a provider");
  } finally {
    delete process.env.HUNCH_SYNTH_PROVIDER;
  }
});

test("HUNCH_SYNTH_PROVIDER=deterministic forces the offline heuristic", async () => {
  process.env.HUNCH_SYNTH_PROVIDER = "deterministic";
  try {
    assert.equal((await selectProvider()).name, "deterministic");
  } finally {
    delete process.env.HUNCH_SYNTH_PROVIDER;
  }
});
