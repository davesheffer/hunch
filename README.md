# Hunch

## Your repo remembers why.

[![npm version](https://img.shields.io/npm/v/@davesheffer/hunch?color=2742ff&label=npm)](https://www.npmjs.com/package/@davesheffer/hunch)
[![GitHub stars](https://img.shields.io/github/stars/davesheffer/hunch?color=2742ff&label=%E2%98%85%20star)](https://github.com/davesheffer/hunch)
[![license](https://img.shields.io/npm/l/@davesheffer/hunch?color=2742ff)](LICENSE)

Hunch is engineering memory for AI-assisted codebases. It records the decisions, constraints,
rejected approaches, and bug history behind your code, then gives every connected assistant the
relevant context before it makes a change.

Memory starts **advisory**. Nothing blocks until you explicitly trust a precise rule and choose
strict enforcement.

**Memory is the input. The product boundary is the receipt:** relevant evidence before an edit,
then a deterministic check of the change against the rules your team has explicitly trusted.

## Start in five minutes

Requires Node 22.13+ and a git repository.

```bash
npm i -g @davesheffer/hunch
cd your-repo
hunch init
hunch backfill --since 90d   # optional: seed memory from recent history
```

Reload your coding assistant, then ask:

> Why is this built this way?

`hunch init` indexes the repo, installs the local memory hooks, and connects supported assistants
to the same graph. It merges into existing configuration instead of replacing it.

## What Hunch gives you

- **Durable context** — decisions and corrections survive the chat session that produced them.
- **One memory for every assistant** — Claude Code, Cursor, Copilot, Windsurf, Antigravity, Codex,
  and any MCP client see the same evidence.
- **Change receipts** — review a working tree, commit, or branch against recorded intent and get a
  cited PASS / WARN / BLOCK result.
- **Bug lineage** — understand which old incident a line fixed before accidentally undoing it.
- **Code awareness** — TypeScript, JavaScript, and Python structure feed dependency, blast-radius,
  and redundancy checks. The reasoning layer works with any language.

The source of truth is readable JSON in `.hunch/`. A local SQLite index makes retrieval fast but
is always rebuildable.

## Day-to-day

Most memory work happens automatically after commits. These commands cover the common manual paths:

| Command | Use it for |
| --- | --- |
| `hunch why <file>` | Decisions, bugs, constraints, and blast radius behind a file |
| `hunch query "<question>"` | Search project memory |
| `hunch check --working` | Review all current changes against recorded intent |
| `hunch log` | See the memory timeline and its reversible moves |
| `hunch escalations` | See the rare decisions only a human can make |
| `hunch doctor` | Diagnose setup, provider, index, or private-overlay problems |

Corrections can become scoped rules, but captured memory cannot hard-block on its own. Enforcement is
deterministic and opt-in:

```bash
hunch firmness strict
hunch check --staged --strict
```

## Synthesis without surprise billing

Hunch can draft structured memory through:

- a selected Claude Code, Codex, or Cursor subscription CLI;
- an opt-in OpenAI-compatible local endpoint such as Ollama, vLLM, LM Studio, or llama.cpp; or
- the built-in deterministic fallback when no model is available.

When several subscription CLIs are installed, Hunch does not guess which plan to use:

```bash
hunch provider codex-cli
```

Local and private-network endpoints work without a billing flag. Every public remote requires the
explicit `HUNCH_SYNTH_ALLOW_METERED=1` opt-in, because Hunch cannot infer cost from a hostname.
See [Synthesis & billing](https://hunch-pi.vercel.app/docs#synthesis) for setup details.

## Local-first and portable

Hunch has no hosted memory service or telemetry. Your graph travels with git and speaks MCP, so it
is not tied to one editor or model provider.

Sensitive reasoning can live in a separate private overlay:

```bash
hunch private --repo git@github.com:you/project-memory.git
```

Local tools see the combined graph; public CI and committed documentation stay public-only.

## Learn more

- [Full documentation](https://hunch-pi.vercel.app/docs)
- [Copy-paste cookbook](https://hunch-pi.vercel.app/cookbook)
- [VS Code extension](vscode-extension/README.md)
- [Contributing](CONTRIBUTING.md)
- [Architecture benchmark](bench/architectural-conformance.md)
- [Competitive landscape (dated; re-verify before quoting)](docs/competitive-landscape.md)

Apache-2.0
