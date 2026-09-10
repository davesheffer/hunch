# Agent origin and provider routing

Hunch keeps agent work with the provider that initiated the operation. A Codex
request uses Codex, Claude uses Claude, and Kimi uses Kimi. The same binding applies
to synthesis, the Critic, repeated `--deep` samples, automatic review memory, and
child processes launched by the operation. Availability is not identity; installing
another CLI cannot redirect an event or enable cross-provider fan-out.

This binds the **provider and its locally configured authentication**, not a
verified human account ID. If the host agent uses a different account from its
local CLI, Hunch cannot prove they are the same. It never copies authentication
tokens between products or changes which account is logged into a CLI.

## Supplying the origin

An integration should pass origin explicitly with every invocation:

```sh
hunch --initiator codex sync --deep --verify
hunch --initiator claude backfill --since 7d
hunch --initiator kimi review-memory auto --repository OWNER/REPO --private
```

`HUNCH_INITIATOR=codex-cli` is the equivalent environment contract. Claude, Codex,
Cursor and Kimi short names are accepted. A known Codex session environment or
`CLAUDECODE=1` can identify direct CLI calls when no explicit origin is supplied.
Ambiguous markers are refused. Kimi, Cursor and other integrations should supply
the origin explicitly rather than relying on installation paths or login files.

MCP calls derive origin from the connected client's declared name, within a
request-local async context. Concurrent clients never share a mutable global
provider preference. An unidentified MCP client gets local deterministic behavior;
it does not inherit the account of the shell that started the server. Client names
are routing metadata, not authentication or authorization proof.

Git child processes receive a frozen `HUNCH_INITIATOR`, so detached post-commit
work inherits the originating event. Explicit experiment runner bindings that
conflict with a known origin are refused. Future durable job producers must carry
the same origin field when enqueuing work rather than redetect it at execution.

## Missing providers and offline work

If the initiating CLI is unavailable, normal synthesis uses the deterministic
local fallback and reports the unavailable origin. Tasks that require model output,
such as automatic review extraction, refuse or queue the failed analysis. They
never retry through another account. `HUNCH_SYNTH_PROVIDER=deterministic` remains an
explicit offline switch; private/local-only flows retain their existing protection.

For human terminal invocations with no agent origin, an explicitly chosen
`hunch provider NAME` or `HUNCH_SYNTH_PROVIDER` remains usable. Auto mode no longer
selects a provider solely because it is the only installed CLI. No global preference
can override a known initiating agent with a different account.

## Kimi and other CLIs

The built-in Kimi adapter uses `kimi acp`, the [documented ACP entry point](https://moonshotai.github.io/kimi-code/en/reference/kimi-acp).
It creates a fresh temporary session, supplies review/synthesis context over JSON-RPC,
collects assistant text, denies permission requests and refuses filesystem/terminal
RPCs. The CLI retains its own existing login. The executable must already be installed
and authenticated; Hunch does not perform an interactive login or install it.

Other tools can be described in an explicit local JSON file:

```json
[
  {
    "name": "my-agent",
    "command": "my-agent-cli",
    "args": ["acp"],
    "protocol": "acp",
    "probe_args": ["--version"],
    "timeout_ms": 120000
  }
]
```

```sh
hunch --initiator my-agent --cli-config /local/adapters.json sync --verify
```

`HUNCH_CLI_CONFIG` supplies the same explicit path. `protocol: "stdin"` supports
any configured CLI/wrapper that reads the whole prompt from stdin and writes its
response to stdout. Review extraction requires a single JSON object as the response.
Arguments are a static array; untrusted prompts never enter shell command arguments.
Adapters run in fresh temporary directories with bounded time/output. Their own
authentication and configured billing remain theirs; this is not an OS sandbox.
The config is executable local configuration, so Hunch never discovers it in a
repository automatically. Models cannot choose adapters from review content.
