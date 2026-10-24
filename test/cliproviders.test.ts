import { test } from "node:test";
import assert from "node:assert/strict";
@@CLEANROOM_HOLE_1@@
  codexExecArgs,
@@CLEANROOM_HOLE_2@@
import { withInitiator } from "../src/synthesis/initiator.js";
@@CLEANROOM_HOLE_3@@

// Provider tests use a local fake endpoint. Keep them independent of the host
// process's CODEX_THREAD_ID/HUNCH_INITIATOR while preserving the production
// rule that an operation must stay with its initiating provider.
const runAsOpenAi = <T>(work: () => T): T => withInitiator({ provider: "openai-compat", source: "explicit" }, work);

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

test("extractCodexText prefers the agent_message over reasoning and trailing events", () => {
  const jsonl = [
    '{"type":"item.completed","item":{"type":"reasoning","text":"REASONING (not the answer)"}}',
    '{"type":"item.completed","item":{"type":"agent_message","text":"THE ANSWER"}}',
    '{"type":"item.completed","item":{"type":"token_count","text":"123 tokens"}}',
  ].join("\n");
  assert.equal(extractCodexText(jsonl), "THE ANSWER");
});

test("Codex execution explicitly permits Hunch's neutral non-repository cwd", () => {
  assert.deepEqual(codexExecArgs(undefined), ["exec", "--json", "--skip-git-repo-check", "-"]);
  assert.deepEqual(codexExecArgs("gpt-5"), [
    "exec",
    "--json",
    "--skip-git-repo-check",
    "-m",
    "gpt-5",
    "-",
  ]);
});

// A HUNCH_*_MODEL env var is the only non-literal argv token reaching pexecIn's
// Windows cmd.exe line (shell:true). safeModel rejects whitespace/metachars so a
// poisoned env var can't smuggle a second command, falling back instead of crashing.
test("safeModel passes real model ids through unchanged", () => {
  for (const m of ["haiku", "claude-haiku-4-5-20251001", "anthropic/claude-opus", "gpt-4o-mini", "o4-mini"]) {
    assert.equal(safeModel(m, "haiku"), m);
  }
});

test("safeModel rejects shell-metachar / whitespace injection, returning the fallback", () => {
  for (const bad of ["haiku & evil.exe", "a|b", "x;y", "$(whoami)", "`id`", "a b", 'q"uote', "(sub)", ">out"]) {
    assert.equal(safeModel(bad, "haiku"), "haiku"); // string fallback
    assert.equal(safeModel(bad, undefined), undefined); // omit-flag fallback
  }
});

test("safeModel returns the fallback when the env var is unset", () => {
  assert.equal(safeModel(undefined, "haiku"), "haiku");
  assert.equal(safeModel(undefined, undefined), undefined);
  assert.equal(safeModel("", "haiku"), "haiku"); // empty string → fallback
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
@@CLEANROOM_HOLE_4@@
test("OpenAICompatProvider refuses public remotes in both availability and execution unless explicitly allowed", async () => {
@@CLEANROOM_HOLE_5@@
  delete process.env.HUNCH_SYNTH_ALLOW_METERED;
@@CLEANROOM_HOLE_6@@
    for (const baseUrl of ["https://api.openai.com/v1", "https://api.groq.com/openai/v1"]) {
      process.env.HUNCH_SYNTH_BASE_URL = baseUrl;
      const provider = new OpenAICompatProvider();
      assert.equal(await provider.available(), false, `${baseUrl} blocked by default`);
      await assert.rejects(
        runAsOpenAi(() => provider.draftDecision({ subject: "s", body: "", files: [], diff: "" })),
        /refusing to call public remote/,
      );
    }
@@CLEANROOM_HOLE_7@@
test("OpenAICompatProvider.available() requires explicit opt-in for any public remote endpoint", async () => {
  process.env.HUNCH_SYNTH_MODEL = "llama-3.3-70b-versatile";
  process.env.HUNCH_SYNTH_API_KEY = "paid-provider-key";
  delete process.env.HUNCH_SYNTH_ALLOW_METERED;
  try {
    for (const baseUrl of [
      "https://api.groq.com/openai/v1", // an unlisted paid provider
      "https://api.openai.com./v1", // fully-qualified trailing dot is the same public host
      "https://my-llm.example.com/v1", // public self-hosted still needs deliberate trust
    ]) {
      process.env.HUNCH_SYNTH_BASE_URL = baseUrl;
      assert.equal(await new OpenAICompatProvider().available(), false, `${baseUrl} must fail closed`);
    }

    process.env.HUNCH_SYNTH_ALLOW_METERED = "1";
    assert.equal(await new OpenAICompatProvider().available(), true, "the named opt-in authorizes a public remote");
  } finally {
    delete process.env.HUNCH_SYNTH_BASE_URL;
    delete process.env.HUNCH_SYNTH_MODEL;
    delete process.env.HUNCH_SYNTH_API_KEY;
    delete process.env.HUNCH_SYNTH_ALLOW_METERED;
  }
});

test("OpenAICompatProvider.available() accepts local/LAN endpoints without the metered opt-in", async () => {
  process.env.HUNCH_SYNTH_MODEL = "m";
@@CLEANROOM_HOLE_8@@
    for (const baseUrl of [
      "http://localhost:11434/v1",
      "http://127.0.0.1:11434/v1",
      "http://10.0.0.8:8000/v1",
      "http://192.168.1.8:8000/v1",
      "http://ollama:11434/v1",
      "http://model.home.arpa:11434/v1",
      "http://[::1]:11434/v1",
      "http://[fd00::8]:8000/v1",
    ]) {
      process.env.HUNCH_SYNTH_BASE_URL = baseUrl;
      assert.equal(await new OpenAICompatProvider().available(), true, baseUrl);
    }
  } finally {
    delete process.env.HUNCH_SYNTH_BASE_URL;
    delete process.env.HUNCH_SYNTH_MODEL;
  }
});

test("OpenAICompatProvider.available() rejects malformed and non-HTTP base URLs", async () => {
  process.env.HUNCH_SYNTH_MODEL = "m";
  try {
    for (const baseUrl of ["not a url", "file:///tmp/model", "ftp://localhost/model", "http://user:pass@localhost:11434/v1", "http://localhost:11434/v1?token=secret"]) {
      process.env.HUNCH_SYNTH_BASE_URL = baseUrl;
      assert.equal(await new OpenAICompatProvider().available(), false, baseUrl);
    }
    process.env.HUNCH_SYNTH_BASE_URL = "not a url";
@@CLEANROOM_HOLE_9@@
      runAsOpenAi(() => new OpenAICompatProvider().draftDecision({ subject: "s", body: "", files: [], diff: "" })),
      /must be an http\(s\) base URL/,
@@CLEANROOM_HOLE_10@@
    const draft = await runAsOpenAi(() => new OpenAICompatProvider().draftDecision({ subject: "s", body: "", files: [], diff: "" }));
@@CLEANROOM_HOLE_11@@
    const draft = await runAsOpenAi(() => provider.draftDecision({ subject: "feat: x", body: "", files: ["a.py"], diff: "+def a(): pass" }));
@@CLEANROOM_HOLE_12@@
test("OpenAICompatProvider.draftProse requests free-form text instead of JSON mode", async () => {
  let responseFormat: unknown = "not observed";
  const server = await startFakeServer((_req, res, body) => {
    responseFormat = (JSON.parse(body) as Record<string, unknown>).response_format;
    res.setHeader("content-type", "application/json");
    res.end(JSON.stringify({ choices: [{ message: { content: "A grounded Markdown overview." } }] }));
  });
  process.env.HUNCH_SYNTH_BASE_URL = server.url;
  process.env.HUNCH_SYNTH_MODEL = "m";
  try {
    const prose = await runAsOpenAi(() => new OpenAICompatProvider().draftProse("Write one Markdown paragraph."));
    assert.equal(responseFormat, undefined, "free-form prose must not be constrained to a JSON object");
    assert.equal(prose, "A grounded Markdown overview.");
  } finally {
    delete process.env.HUNCH_SYNTH_BASE_URL;
    delete process.env.HUNCH_SYNTH_MODEL;
    await server.close();
  }
});

@@CLEANROOM_HOLE_13@@
    await runAsOpenAi(() => new OpenAICompatProvider().draftDecision({ subject: "s", body: "", files: [], diff: "" }));
@@CLEANROOM_HOLE_14@@
    await runAsOpenAi(() => new OpenAICompatProvider().draftDecision({ subject: "s", body: "", files: [], diff: "" }));
@@CLEANROOM_HOLE_15@@
      runAsOpenAi(() => new OpenAICompatProvider().draftDecision({ subject: "s", body: "", files: [], diff: "" })),
@@CLEANROOM_HOLE_16@@
    await assert.rejects(runAsOpenAi(() => new OpenAICompatProvider().draftDecision({ subject: "s", body: "", files: [], diff: "" })));
@@CLEANROOM_HOLE_17@@
test("probeOllamaNumCtx warns truthfully when the model does not pin num_ctx", async () => {
@@CLEANROOM_HOLE_18@@
    assert.ok(warning?.includes("does not pin num_ctx"), `expected an unpinned-context warning, got: ${warning}`);
    assert.ok(!warning?.includes("4096"), `must not guess the server's effective context: ${warning}`);
@@CLEANROOM_HOLE_19@@
    const p = await runAsOpenAi(() => selectProvider());
@@CLEANROOM_HOLE_20@@
    const p = await runAsOpenAi(() => selectProvider());
@@CLEANROOM_HOLE_21@@
test("selectWorkers stays with the explicitly selected local endpoint", async () => {
@@CLEANROOM_HOLE_22@@
    const workers = await selectWorkers({ env: { HUNCH_SYNTH_PROVIDER: "openai-compat" } });
    assert.deepEqual(workers.map(w => w.name), ["openai-compat"]);
@@CLEANROOM_HOLE_23@@
