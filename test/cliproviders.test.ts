import { test } from "node:test";
import assert from "node:assert/strict";
import {
  codexExecArgs,
  extractCodexText,
  safeModel,
  safeTimeout,
  safeMaxTokens,
  selectProvider,
  selectWorkers,
  OpenAICompatProvider,
  probeOllamaNumCtx,
  meteredHostsAllowed,
  __resetAvailabilityCacheForTests,
  type CommitInput,
} from "../src/synthesis/provider.js";
import { withInitiator } from "../src/synthesis/initiator.js";
import { createServer, type IncomingMessage, type ServerResponse } from "node:http";
import type { AddressInfo } from "node:net";

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

// A garbage timeout or max_tokens must never reach the abort timer or the request
// body (abort at once, never abort, or a corrupt payload): validate, else default.
test("safeTimeout passes valid positive values through", () => {
  assert.equal(safeTimeout("60000", 300000), 60000);
  assert.equal(safeTimeout("1", 300000), 1);
});

test("safeTimeout falls back for undefined, empty, zero, negative and non-numeric values", () => {
  for (const bad of [undefined, "", "0", "-5", "abc", "NaN", "Infinity"]) {
    assert.equal(safeTimeout(bad as string | undefined, 300000), 300000, String(bad));
  }
});

test("safeMaxTokens passes valid positive values through", () => {
  assert.equal(safeMaxTokens("512", 2048), 512);
  assert.equal(safeMaxTokens("1", 2048), 1);
});

test("safeMaxTokens falls back for undefined, empty, zero, negative and non-numeric values", () => {
  for (const bad of [undefined, "", "0", "-5", "abc", "NaN", "Infinity"]) {
    assert.equal(safeMaxTokens(bad as string | undefined, 2048), 2048, String(bad));
  }
});

/** Start a local fake HTTP endpoint; the handler gets the request, response and collected body. */
async function startFakeServer(
  handler: (req: IncomingMessage, res: ServerResponse, body: string) => void,
): Promise<{ url: string; close: () => Promise<void> }> {
  const server = createServer((req, res) => {
    let body = "";
    req.on("data", (chunk) => { body += chunk; });
    req.on("end", () => handler(req, res, body));
  });
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  const port = (server.address() as AddressInfo).port;
  return {
    url: `http://127.0.0.1:${port}`,
    close: () => new Promise<void>((resolve) => {
      server.close(() => resolve());
      server.closeAllConnections();
    }),
  };
}

/** A valid chat-completions reply whose content is a decision-draft JSON object. */
const decisionReply = (decision: string, context: string): string =>
  JSON.stringify({ choices: [{ message: { content: JSON.stringify({ decision, context, nontrivial: true }) } }] });

/** Env vars the openai-compat provider reads; tests snapshot and restore them. */
const COMPAT_ENV = [
  "HUNCH_SYNTH_BASE_URL",
  "HUNCH_SYNTH_MODEL",
  "HUNCH_SYNTH_API_KEY",
  "HUNCH_SYNTH_ALLOW_METERED",
  "HUNCH_SYNTH_MAX_TOKENS",
  "HUNCH_SYNTH_TIMEOUT_MS",
] as const;

/** Clear every openai-compat env var, returning a function that puts the originals back. */
function isolateCompatEnv(): () => void {
  const saved = new Map(COMPAT_ENV.map((key) => [key, process.env[key]] as const));
  for (const key of COMPAT_ENV) delete process.env[key];
  return () => {
    for (const [key, value] of saved) {
      if (value === undefined) delete process.env[key];
      else process.env[key] = value;
    }
  };
}

/** A small commit to draft from; its content is irrelevant to the fake endpoints. */
const sampleCommit = (): CommitInput => ({
  subject: "Switch the cache to an LRU policy",
  body: "",
  files: ["src/cache.ts"],
  diff: "--- a/src/cache.ts\n+++ b/src/cache.ts\n@@ -1 +1 @@\n-const policy = \"fifo\";\n+const policy = \"lru\";\n",
});

const lruReply = () => decisionReply("Adopt LRU eviction for the cache", "FIFO evicted hot keys under load");

test("OpenAICompatProvider is unavailable until both the base URL and the model are configured", async () => {
  const restore = isolateCompatEnv();
  try {
    const provider = new OpenAICompatProvider();
    assert.equal(await provider.available(), false, "nothing configured");
    process.env.HUNCH_SYNTH_BASE_URL = "http://127.0.0.1:11434/v1";
    assert.equal(await provider.available(), false, "base URL without a model");
    delete process.env.HUNCH_SYNTH_BASE_URL;
    process.env.HUNCH_SYNTH_MODEL = "llama3";
    assert.equal(await provider.available(), false, "model without a base URL");
  } finally {
    restore();
  }
});

test("meteredHostsAllowed is true only when HUNCH_SYNTH_ALLOW_METERED=1", () => {
  assert.equal(meteredHostsAllowed({}), false);
  assert.equal(meteredHostsAllowed({ HUNCH_SYNTH_ALLOW_METERED: "true" }), false);
  assert.equal(meteredHostsAllowed({ HUNCH_SYNTH_ALLOW_METERED: "1" }), true);
});

test("known paid endpoints are refused without the metered opt-in, and accepted with it", async () => {
  const restore = isolateCompatEnv();
  try {
    process.env.HUNCH_SYNTH_MODEL = "gpt-4o-mini";
    const provider = new OpenAICompatProvider();
    for (const paid of ["https://api.openai.com/v1", "https://api.groq.com/openai/v1"]) {
      process.env.HUNCH_SYNTH_BASE_URL = paid;
      assert.equal(await provider.available(), false, paid);
      await assert.rejects(
        runAsOpenAi(() => provider.draftDecision(sampleCommit())),
        /refusing to call public remote/,
        paid,
      );
    }
    process.env.HUNCH_SYNTH_ALLOW_METERED = "1";
    assert.equal(await provider.available(), true);
  } finally {
    restore();
  }
});

test("every public remote fails closed even with an API key, until metered hosts are allowed", async () => {
  const restore = isolateCompatEnv();
  try {
    process.env.HUNCH_SYNTH_MODEL = "some-model";
    process.env.HUNCH_SYNTH_API_KEY = "sk-test-key";
    const provider = new OpenAICompatProvider();
    const publicRemotes = [
      "https://api.unlisted-llm-vendor.example.com/v1",
      "https://api.openai.com./v1",
      "https://llm.my-own-server.dev/v1",
    ];
    for (const remote of publicRemotes) {
      process.env.HUNCH_SYNTH_BASE_URL = remote;
      assert.equal(await provider.available(), false, remote);
    }
    process.env.HUNCH_SYNTH_ALLOW_METERED = "1";
    assert.equal(await provider.available(), true);
  } finally {
    restore();
  }
});

test("local and private-network endpoints are available without any metered opt-in", async () => {
  const restore = isolateCompatEnv();
  try {
    process.env.HUNCH_SYNTH_MODEL = "qwen2.5-coder";
    const provider = new OpenAICompatProvider();
    for (const local of [
      "http://localhost:11434/v1",
      "http://127.0.0.1:8000/v1",
      "http://10.1.2.3:8000/v1",
      "http://192.168.0.20:1234/v1",
      "http://gpubox:8080/v1",
      "http://inference.home.arpa:8080/v1",
      "http://[::1]:11434/v1",
      "http://[fd12:3456:789a::1]:8000/v1",
    ]) {
      process.env.HUNCH_SYNTH_BASE_URL = local;
      assert.equal(await provider.available(), true, local);
    }
  } finally {
    restore();
  }
});

test("malformed or unsupported base URLs leave the provider unavailable and fail the draft", async () => {
  const restore = isolateCompatEnv();
  try {
    process.env.HUNCH_SYNTH_MODEL = "qwen2.5-coder";
    const provider = new OpenAICompatProvider();
    for (const bad of [
      "just some words",
      "file:///etc/passwd",
      "ftp://127.0.0.1/v1",
      "http://user:secret@127.0.0.1:11434/v1",
      "http://127.0.0.1:11434/v1?key=abc",
    ]) {
      process.env.HUNCH_SYNTH_BASE_URL = bad;
      assert.equal(await provider.available(), false, bad);
    }
    process.env.HUNCH_SYNTH_BASE_URL = "not a url at all";
    await assert.rejects(
      runAsOpenAi(() => provider.draftDecision(sampleCommit())),
      /must be an http\(s\) base URL/,
    );
  } finally {
    restore();
  }
});

test("draftDecision still works against a local endpoint when metered hosts are allowed", async () => {
  const restore = isolateCompatEnv();
  const server = await startFakeServer((_req, res) => {
    res.setHeader("content-type", "application/json");
    res.end(lruReply());
  });
  try {
    process.env.HUNCH_SYNTH_ALLOW_METERED = "1";
    process.env.HUNCH_SYNTH_BASE_URL = `${server.url}/v1`;
    process.env.HUNCH_SYNTH_MODEL = "qwen2.5-coder";
    const draft = await runAsOpenAi(() => new OpenAICompatProvider().draftDecision(sampleCommit()));
    assert.ok(draft);
  } finally {
    await server.close();
    restore();
  }
});

test("draftDecision POSTs a JSON-mode chat completion and maps the first choice into the draft", async () => {
  const restore = isolateCompatEnv();
  let method: string | undefined;
  let path: string | undefined;
  let authorization: string | undefined;
  let sent: Record<string, unknown> = {};
  const server = await startFakeServer((req, res, body) => {
    method = req.method;
    path = req.url;
    authorization = req.headers.authorization;
    sent = JSON.parse(body) as Record<string, unknown>;
    res.setHeader("content-type", "application/json");
    res.end(lruReply());
  });
  try {
    process.env.HUNCH_SYNTH_BASE_URL = server.url;
    process.env.HUNCH_SYNTH_MODEL = "qwen2.5-coder:7b";
    const provider = new OpenAICompatProvider();
    assert.equal(await provider.available(), true);
    const draft = await runAsOpenAi(() => provider.draftDecision(sampleCommit()));
    assert.equal(draft.decision, "Adopt LRU eviction for the cache");
    assert.equal(method, "POST");
    assert.equal(path, "/chat/completions");
    assert.equal(sent.model, "qwen2.5-coder:7b");
    assert.deepEqual(sent.response_format, { type: "json_object" });
    assert.equal(sent.stream, false);
    assert.equal(sent.max_tokens, 2048);
    assert.ok(Array.isArray(sent.messages), "messages array is sent");
    assert.equal(authorization, undefined, "no API key → no Authorization header");
  } finally {
    await server.close();
    restore();
  }
});

test("draftProse sends no response_format and returns the reply text as-is", async () => {
  const restore = isolateCompatEnv();
  let format: unknown = "not captured";
  const server = await startFakeServer((_req, res, body) => {
    format = (JSON.parse(body) as { response_format?: unknown }).response_format;
    res.setHeader("content-type", "application/json");
    res.end(JSON.stringify({ choices: [{ message: { content: "The cache now evicts least-recently-used keys." } }] }));
  });
  try {
    process.env.HUNCH_SYNTH_BASE_URL = server.url;
    process.env.HUNCH_SYNTH_MODEL = "qwen2.5-coder";
    const prose = await runAsOpenAi(() => new OpenAICompatProvider().draftProse("Describe the cache."));
    assert.equal(format, undefined);
    assert.equal(prose, "The cache now evicts least-recently-used keys.");
  } finally {
    await server.close();
    restore();
  }
});

test("HUNCH_SYNTH_API_KEY is sent as a Bearer Authorization header", async () => {
  const restore = isolateCompatEnv();
  let authorization: string | undefined;
  const server = await startFakeServer((req, res) => {
    authorization = req.headers.authorization;
    res.setHeader("content-type", "application/json");
    res.end(lruReply());
  });
  try {
    process.env.HUNCH_SYNTH_BASE_URL = server.url;
    process.env.HUNCH_SYNTH_MODEL = "qwen2.5-coder";
    process.env.HUNCH_SYNTH_API_KEY = "local-secret-123";
    await runAsOpenAi(() => new OpenAICompatProvider().draftDecision(sampleCommit()));
    assert.equal(authorization, "Bearer local-secret-123");
  } finally {
    await server.close();
    restore();
  }
});

test("HUNCH_SYNTH_MAX_TOKENS overrides the max_tokens sent to the endpoint", async () => {
  const restore = isolateCompatEnv();
  let maxTokens: unknown;
  const server = await startFakeServer((_req, res, body) => {
    maxTokens = (JSON.parse(body) as { max_tokens?: unknown }).max_tokens;
    res.setHeader("content-type", "application/json");
    res.end(lruReply());
  });
  try {
    process.env.HUNCH_SYNTH_BASE_URL = server.url;
    process.env.HUNCH_SYNTH_MODEL = "qwen2.5-coder";
    process.env.HUNCH_SYNTH_MAX_TOKENS = "512";
    await runAsOpenAi(() => new OpenAICompatProvider().draftDecision(sampleCommit()));
    assert.equal(maxTokens, 512);
  } finally {
    await server.close();
    restore();
  }
});

// Callers fall back to the deterministic provider on a throw, so a non-2xx reply
// must reject (naming the status) rather than yield an empty draft.
test("an HTTP 500 from the endpoint rejects with the status in the message", async () => {
  const restore = isolateCompatEnv();
  const server = await startFakeServer((_req, res) => {
    res.statusCode = 500;
    res.end("internal failure");
  });
  try {
    process.env.HUNCH_SYNTH_BASE_URL = server.url;
    process.env.HUNCH_SYNTH_MODEL = "qwen2.5-coder";
    await assert.rejects(
      runAsOpenAi(() => new OpenAICompatProvider().draftDecision(sampleCommit())),
      /500/,
    );
  } finally {
    await server.close();
    restore();
  }
});

test("a reply slower than HUNCH_SYNTH_TIMEOUT_MS aborts the draft", async () => {
  const restore = isolateCompatEnv();
  const server = await startFakeServer((_req, res) => {
    setTimeout(() => {
      res.setHeader("content-type", "application/json");
      res.end(lruReply());
    }, 500);
  });
  try {
    process.env.HUNCH_SYNTH_BASE_URL = server.url;
    process.env.HUNCH_SYNTH_MODEL = "qwen2.5-coder";
    process.env.HUNCH_SYNTH_TIMEOUT_MS = "50";
    await assert.rejects(runAsOpenAi(() => new OpenAICompatProvider().draftDecision(sampleCommit())));
  } finally {
    await server.close();
    restore();
  }
});

test("probeOllamaNumCtx returns null when the model's parameters already set num_ctx", async () => {
  const server = await startFakeServer((_req, res) => {
    res.setHeader("content-type", "application/json");
    res.end(JSON.stringify({ parameters: 'num_ctx                        16384\nstop                           "<|im_end|>"' }));
  });
  try {
    assert.equal(await probeOllamaNumCtx(server.url, "hunch-synth"), null);
  } finally {
    await server.close();
  }
});

test("probeOllamaNumCtx warns truthfully when the model does not pin num_ctx", async () => {
  const server = await startFakeServer((_req, res) => {
    res.setHeader("content-type", "application/json");
    res.end(JSON.stringify({ parameters: 'stop                           "<|im_end|>"' }));
  });
  try {
    const warning = await probeOllamaNumCtx(server.url, "qwen2.5-coder:latest");
    assert.ok(warning?.includes("does not pin num_ctx"), `expected an unpinned-context warning, got: ${warning}`);
    assert.ok(!warning?.includes("4096"), `must not guess the server's effective context: ${warning}`);
  } finally {
    await server.close();
  }
});

test("probeOllamaNumCtx returns null (never throws) on a non-2xx response, a missing parameters field, or an unreachable endpoint", async () => {
  const failing = await startFakeServer((_req, res) => {
    res.statusCode = 500;
    res.end("nope");
  });
  const noParams = await startFakeServer((_req, res) => {
    res.setHeader("content-type", "application/json");
    res.end(JSON.stringify({ modelfile: "FROM x" }));
  });
  try {
    assert.equal(await probeOllamaNumCtx(failing.url, "m"), null);
    assert.equal(await probeOllamaNumCtx(noParams.url, "m"), null);
    assert.equal(await probeOllamaNumCtx("http://127.0.0.1:1", "m"), null);
  } finally {
    await failing.close();
    await noParams.close();
  }
});

test("probeOllamaNumCtx strips a trailing /v1 from the base URL before hitting /api/show", async () => {
  let path: string | undefined;
  const server = await startFakeServer((req, res) => {
    path = req.url;
    res.setHeader("content-type", "application/json");
    res.end(JSON.stringify({ parameters: "" }));
  });
  try {
    await probeOllamaNumCtx(`${server.url}/v1`, "m");
    assert.equal(path, "/api/show");
  } finally {
    await server.close();
  }
});

test("selectProvider does not pick openai-compat when its env vars are unset (default behavior unchanged)", async () => {
  __resetAvailabilityCacheForTests();
  delete process.env.HUNCH_SYNTH_PROVIDER;
  delete process.env.HUNCH_SYNTH_BASE_URL;
  delete process.env.HUNCH_SYNTH_MODEL;
  assert.notEqual((await selectProvider()).name, "openai-compat");
});

test("selectProvider resolves openai-compat when forced and BASE_URL+MODEL are set", async () => {
  __resetAvailabilityCacheForTests();
  // Unreachable on purpose: availability checks only the env vars, not reachability.
  process.env.HUNCH_SYNTH_BASE_URL = "http://127.0.0.1:1/v1";
  process.env.HUNCH_SYNTH_MODEL = "m";
  process.env.HUNCH_SYNTH_PROVIDER = "openai-compat";
  try {
    const p = await runAsOpenAi(() => selectProvider());
    assert.equal(p.name, "openai-compat");
  } finally {
    delete process.env.HUNCH_SYNTH_BASE_URL;
    delete process.env.HUNCH_SYNTH_MODEL;
    delete process.env.HUNCH_SYNTH_PROVIDER;
    __resetAvailabilityCacheForTests();
  }
});

test("HUNCH_SYNTH_PROVIDER=ollama is accepted as an alias for openai-compat", async () => {
  __resetAvailabilityCacheForTests();
  process.env.HUNCH_SYNTH_BASE_URL = "http://127.0.0.1:1/v1";
  process.env.HUNCH_SYNTH_MODEL = "m";
  process.env.HUNCH_SYNTH_PROVIDER = "ollama";
  try {
    const p = await runAsOpenAi(() => selectProvider());
    assert.equal(p.name, "openai-compat");
  } finally {
    delete process.env.HUNCH_SYNTH_BASE_URL;
    delete process.env.HUNCH_SYNTH_MODEL;
    delete process.env.HUNCH_SYNTH_PROVIDER;
    __resetAvailabilityCacheForTests();
  }
});

test("selectWorkers stays with the explicitly selected local endpoint", async () => {
  __resetAvailabilityCacheForTests();
  process.env.HUNCH_SYNTH_BASE_URL = "http://127.0.0.1:1/v1";
  process.env.HUNCH_SYNTH_MODEL = "m";
  try {
    const workers = await selectWorkers({ env: { HUNCH_SYNTH_PROVIDER: "openai-compat" } });
    assert.deepEqual(workers.map(w => w.name), ["openai-compat"]);
  } finally {
    delete process.env.HUNCH_SYNTH_BASE_URL;
    delete process.env.HUNCH_SYNTH_MODEL;
    __resetAvailabilityCacheForTests();
  }
});
