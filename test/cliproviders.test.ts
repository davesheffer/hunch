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

test("OpenAICompatProvider.available() is false unless BOTH HUNCH_SYNTH_BASE_URL and HUNCH_SYNTH_MODEL are set", async () => {
  delete process.env.HUNCH_SYNTH_BASE_URL;
  delete process.env.HUNCH_SYNTH_MODEL;
  assert.equal(await new OpenAICompatProvider().available(), false);
  process.env.HUNCH_SYNTH_BASE_URL = "http://127.0.0.1:1/v1";
  try {
    assert.equal(await new OpenAICompatProvider().available(), false);
  } finally {
    delete process.env.HUNCH_SYNTH_BASE_URL;
  }
  process.env.HUNCH_SYNTH_MODEL = "m";
  try {
    assert.equal(await new OpenAICompatProvider().available(), false);
  } finally {
    delete process.env.HUNCH_SYNTH_MODEL;
  }
});

test("meteredHostsAllowed is true only when HUNCH_SYNTH_ALLOW_METERED=1", () => {
  assert.equal(meteredHostsAllowed({}), false);
  assert.equal(meteredHostsAllowed({ HUNCH_SYNTH_ALLOW_METERED: "true" }), false);
  assert.equal(meteredHostsAllowed({ HUNCH_SYNTH_ALLOW_METERED: "1" }), true);
});

test("OpenAICompatProvider refuses public remotes in both availability and execution unless explicitly allowed", async () => {
  process.env.HUNCH_SYNTH_MODEL = "gpt-4o-mini";
  delete process.env.HUNCH_SYNTH_ALLOW_METERED;
  try {
    for (const baseUrl of ["https://api.openai.com/v1", "https://api.groq.com/openai/v1"]) {
      process.env.HUNCH_SYNTH_BASE_URL = baseUrl;
      const provider = new OpenAICompatProvider();
      assert.equal(await provider.available(), false, `${baseUrl} blocked by default`);
      await assert.rejects(
        runAsOpenAi(() => provider.draftDecision({ subject: "s", body: "", files: [], diff: "" })),
        /refusing to call public remote/,
      );
    }

    process.env.HUNCH_SYNTH_ALLOW_METERED = "1";
    assert.equal(await new OpenAICompatProvider().available(), true, "the explicit opt-in allows a public remote");
  } finally {
    delete process.env.HUNCH_SYNTH_BASE_URL;
    delete process.env.HUNCH_SYNTH_MODEL;
    delete process.env.HUNCH_SYNTH_ALLOW_METERED;
  }
});

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
  delete process.env.HUNCH_SYNTH_ALLOW_METERED;
  try {
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
    await assert.rejects(
      runAsOpenAi(() => new OpenAICompatProvider().draftDecision({ subject: "s", body: "", files: [], diff: "" })),
      /must be an http\(s\) base URL/,
    );
  } finally {
    delete process.env.HUNCH_SYNTH_BASE_URL;
    delete process.env.HUNCH_SYNTH_MODEL;
  }
});

test("OpenAICompatProvider.draftDecision permits a metered host when HUNCH_SYNTH_ALLOW_METERED=1", async () => {
  const server = await startFakeServer((_req, res) => {
    res.setHeader("content-type", "application/json");
    res.end(decisionReply("use a hosted model", "opted in"));
  });
  process.env.HUNCH_SYNTH_BASE_URL = server.url;
  process.env.HUNCH_SYNTH_MODEL = "m";
  process.env.HUNCH_SYNTH_ALLOW_METERED = "1";
  try {
    const draft = await runAsOpenAi(() => new OpenAICompatProvider().draftDecision({ subject: "s", body: "", files: [], diff: "" }));
    assert.ok(draft);
  } finally {
    delete process.env.HUNCH_SYNTH_BASE_URL;
    delete process.env.HUNCH_SYNTH_MODEL;
    delete process.env.HUNCH_SYNTH_ALLOW_METERED;
    await server.close();
  }
});

test("OpenAICompatProvider.draftDecision POSTs {baseUrl}/chat/completions with model/messages/response_format and maps choices[0].message.content", async () => {
  const seen: { method?: string; path?: string; auth?: string; body?: Record<string, any> } = {};
  const server = await startFakeServer((req, res, body) => {
    seen.method = req.method;
    seen.path = req.url;
    seen.auth = req.headers.authorization;
    seen.body = JSON.parse(body);
    res.setHeader("content-type", "application/json");
    res.end(decisionReply("use a local model", "self-hosted"));
  });
  process.env.HUNCH_SYNTH_BASE_URL = server.url;
  process.env.HUNCH_SYNTH_MODEL = "qwen2.5:7b";
  delete process.env.HUNCH_SYNTH_API_KEY;
  try {
    const provider = new OpenAICompatProvider();
    assert.equal(await provider.available(), true);
    const draft = await runAsOpenAi(() => provider.draftDecision({ subject: "feat: x", body: "", files: ["a.py"], diff: "+def a(): pass" }));
    assert.equal(draft.decision, "use a local model");
    assert.equal(seen.method, "POST");
    assert.equal(seen.path, "/chat/completions");
    assert.equal(seen.body?.model, "qwen2.5:7b");
    assert.equal(seen.body?.response_format.type, "json_object");
    assert.equal(seen.body?.stream, false);
    assert.equal(seen.body?.max_tokens, 2048);
    assert.ok(Array.isArray(seen.body?.messages));
    assert.equal(seen.auth, undefined);
  } finally {
    delete process.env.HUNCH_SYNTH_BASE_URL;
    delete process.env.HUNCH_SYNTH_MODEL;
    await server.close();
  }
});

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

test("OpenAICompatProvider sends a Bearer Authorization header only when HUNCH_SYNTH_API_KEY is set", async () => {
  let auth: string | undefined;
  const server = await startFakeServer((req, res) => {
    auth = req.headers.authorization;
    res.setHeader("content-type", "application/json");
    res.end(decisionReply("d", "c"));
  });
  process.env.HUNCH_SYNTH_BASE_URL = server.url;
  process.env.HUNCH_SYNTH_MODEL = "m";
  process.env.HUNCH_SYNTH_API_KEY = "sk-local-123";
  try {
    await runAsOpenAi(() => new OpenAICompatProvider().draftDecision({ subject: "s", body: "", files: [], diff: "" }));
    assert.equal(auth, "Bearer sk-local-123");
  } finally {
    delete process.env.HUNCH_SYNTH_BASE_URL;
    delete process.env.HUNCH_SYNTH_MODEL;
    delete process.env.HUNCH_SYNTH_API_KEY;
    await server.close();
  }
});

test("OpenAICompatProvider.draftDecision honors HUNCH_SYNTH_MAX_TOKENS", async () => {
  let maxTokens: unknown;
  const server = await startFakeServer((_req, res, body) => {
    maxTokens = (JSON.parse(body) as Record<string, unknown>).max_tokens;
    res.setHeader("content-type", "application/json");
    res.end(decisionReply("d", "c"));
  });
  process.env.HUNCH_SYNTH_BASE_URL = server.url;
  process.env.HUNCH_SYNTH_MODEL = "m";
  process.env.HUNCH_SYNTH_MAX_TOKENS = "512";
  try {
    await runAsOpenAi(() => new OpenAICompatProvider().draftDecision({ subject: "s", body: "", files: [], diff: "" }));
    assert.equal(maxTokens, 512);
  } finally {
    delete process.env.HUNCH_SYNTH_BASE_URL;
    delete process.env.HUNCH_SYNTH_MODEL;
    delete process.env.HUNCH_SYNTH_MAX_TOKENS;
    await server.close();
  }
});

test("OpenAICompatProvider.draftDecision throws on a non-2xx response (caller falls back to deterministic)", async () => {
  const server = await startFakeServer((_req, res) => {
    res.statusCode = 500;
    res.end("internal error");
  });
  process.env.HUNCH_SYNTH_BASE_URL = server.url;
  process.env.HUNCH_SYNTH_MODEL = "m";
  try {
    await assert.rejects(
      runAsOpenAi(() => new OpenAICompatProvider().draftDecision({ subject: "s", body: "", files: [], diff: "" })),
      /500/,
    );
  } finally {
    delete process.env.HUNCH_SYNTH_BASE_URL;
    delete process.env.HUNCH_SYNTH_MODEL;
    await server.close();
  }
});

test("OpenAICompatProvider.draftDecision rejects when the endpoint exceeds HUNCH_SYNTH_TIMEOUT_MS", async () => {
  const server = await startFakeServer((_req, res) => {
    setTimeout(() => {
      res.setHeader("content-type", "application/json");
      res.end(decisionReply("d", "c"));
    }, 500);
  });
  process.env.HUNCH_SYNTH_BASE_URL = server.url;
  process.env.HUNCH_SYNTH_MODEL = "m";
  process.env.HUNCH_SYNTH_TIMEOUT_MS = "50";
  try {
    await assert.rejects(runAsOpenAi(() => new OpenAICompatProvider().draftDecision({ subject: "s", body: "", files: [], diff: "" })));
  } finally {
    delete process.env.HUNCH_SYNTH_BASE_URL;
    delete process.env.HUNCH_SYNTH_MODEL;
    delete process.env.HUNCH_SYNTH_TIMEOUT_MS;
    await server.close();
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
