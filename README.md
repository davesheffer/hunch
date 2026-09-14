# Hunch

## A shared record for AI agents: what was decided, what happened, and what still needs doing.

[![npm version](https://img.shields.io/npm/v/@davesheffer/hunch?color=2742ff&label=npm)](https://www.npmjs.com/package/@davesheffer/hunch)
[![GitHub stars](https://img.shields.io/github/stars/davesheffer/hunch?color=2742ff&label=%E2%98%85%20star)](https://github.com/davesheffer/hunch)
[![license](https://img.shields.io/npm/l/@davesheffer/hunch?color=2742ff)](LICENSE)

A new agent session should not mean explaining the project all over again. A second agent should be able to check a recorded decision, see the evidence behind completed work, and find an outstanding commitment.

Hunch keeps that record in Git and makes the relevant parts available to your agents. It started with **engineering memory**: why code exists, which approach failed before, and which rules a change must preserve. It also ships a **state server** for sharing decisions, action records, and commitments across authorized organization, team, user, and repository scopes.

The goal is simple: agents working from the same maintained record, with sources they can inspect. Hunch supplies memory and checks; the assistant still does the work.

## Start with your coding assistant

Requires **Node 22.13+** and a Git repository.

```bash
npm i -g @davesheffer/hunch
cd your-repo
hunch init
hunch backfill --since 90d   # optional: draft memory from recent history
```

If the shell reports that `hunch` is not found, initialize without a global binary from the
repository directory: `npx -y @davesheffer/hunch@latest init`.

Reload your assistant, then ask:

> Why is this built this way, and what should I preserve when changing it?

`hunch init` indexes the code, configures supported assistant integrations, and adds memory instructions while preserving existing settings. For Codex hooks, review and trust the commands in `/hooks`, then start a new session. **Memory is advisory by default.** Blocking requires an explicitly trusted rule and strict enforcement.

Hunch works with Claude Code, Codex, Cursor, VS Code/Copilot, Windsurf, Antigravity, and other MCP clients. Automatic context and hook coverage vary by assistant; a connected MCP server alone does not prove they are running. [Check your integration](https://www.hunchmemory.com/docs#update).

## What you get today

| Need | How Hunch helps |
| --- | --- |
| Stop explaining old decisions | Saves decisions, rejected alternatives, bug history, corrections, and open findings with their sources. |
| Understand a change before making it | Connects memory to code symbols and dependencies; shows affected code and recorded architectural intent. |
| Keep agents informed across sessions | Delivers a focused brief for a task through MCP and supported lifecycle hooks. |
| Check the rules your team chose | Evaluates supported constraints and code relationships without a model in the blocking path. |
| See what happened during a task | Separates delivered memory, the agent's reported use, rule results, and observed command results in a contribution report. |
| Share project memory with teammates | Keeps repository memory in Git, with an optional dedicated private memory repository. |
| Share work state across agents | Serves authorized records through HTTP, MCP, the state CLI, and typed TypeScript and Python clients. |
| Inspect what the agents know | A read-only browser view shows current records, commitments, completed work and writer-supplied citations. |
| Keep access and conventions explicit | Optional per-record audiences, key-bound credentials and sourced conventions use the same state contract. |

For example, a team fixes a logout bug by keeping sessions on the server. Months later, an agent proposes removing that code. Hunch can surface the original reason and rejected alternative before the edit. A supported, trusted rule can flag the conflict; strict mode can block it. Recording the lesson and configuring the integration are what make this possible.

## Day-to-day

| Command | Use it for |
| --- | --- |
| `hunch context "<task>" --profile builder` | Get a focused brief before starting |
| `hunch why <file-or-symbol>` | Understand decisions and past bugs behind code |
| `hunch structure [target]` | Inspect indexed files and symbols |
| `hunch findings [scope]` | See known gaps that still need work |
| `hunch impact origin/main` | See what a branch could affect |
| `hunch check --working` | Check current changes against recorded rules |
| `hunch conform` | Check supported architectural relationships |
| `hunch now` | Read recent decisions and the recorded roadmap |
| `hunch doctor` | Diagnose setup and storage problems |

For enforcement after reviewing and trusting the relevant rules:

```bash
hunch firmness strict
hunch check --staged --strict
```

Generated notes, observed habits, and imported documents do not silently gain blocking authority.

## Update without losing your settings

From each repository that uses Hunch:

```bash
hunch update
```

If the shell reports that `hunch` is not found, run
`npx -y @davesheffer/hunch@latest update` from the repository instead.

Or ask your agent to **“update Hunch.”** The command installs the latest release, aligns configured integration pins, repairs known legacy launch commands, and refreshes Hunch instructions. It preserves unrelated settings and intentionally disabled hooks.

Installed interactive CLI commands can also show a cached update notice. At most once every 24 hours, a detached worker asks npm for the package's public `latest` version; hooks, MCP, CI, servers, the updater, non-interactive commands, and source checkouts skip that request. Set `HUNCH_NO_UPDATE_CHECK=1` or `NO_UPDATE_NOTIFIER=1` to disable it.

- A standalone npm project keeps Hunch in its existing dependency section at an exact version. Without a repository dependency, the global CLI is updated. Add `--global` to update both.
- For other package managers or workspaces, update the dependency with that package manager, then run `hunch integrations repair-pins`.
- Restart or reconnect active assistants. In Codex, open `/hooks` to review and trust changed commands, then start a new session. A changed version pin changes the command and requires renewed trust.

Verify the setup:

```bash
hunch integrations check
hunch integrations check --harness codex --probe --require mcp
hunch integrations check --harness codex --require context
```

The first command checks configuration. The probe starts a fresh MCP process and reads memory. The context check requires observed hook delivery on the expected version, so run it after the new assistant session begins. `--require` fails when the named capability is not verified; none of these checks proves that a model followed the advice.

## See what Hunch contributed

Task reports answer: what memory reached this task, what did the agent say it used, and what checks actually ran?

The normal agent instructions request a completion card with a link to a local evidence report. You can also inspect reports directly:

```bash
hunch task list
hunch report <task-id> --html
```

A delivered lesson, an agent's claim, and a passing test are different evidence. Hunch keeps them separate. Automatic presentation depends on the host following the task lifecycle; missing evidence stays unverified. [Read the reporting guide](https://github.com/davesheffer/hunch-private/blob/main/projects/hunch/docs/task-reports.md).

## Share one living repository memory with your team

One maintainer connects a dedicated private Git repository:

```bash
hunch shared --repo git@github.com:acme/project-hunch-memory.git
git add .gitignore .hunch/team.json
git commit -m "chore: connect shared Hunch memory"
git push
```

Teammates install Hunch, pull the code, and run `hunch init`. Normal Git access controls the shared repository. Credentials, local clone paths, and private overlays stay out of the committed pointer. Use `hunch shared --sync` to retry synchronization; add `--no-auto-commit` when captures should wait for explicit sync.

This shares a project's engineering memory. The state server below adds authenticated access across multiple scopes.

## Deterministic organizational state

A coding agent needs to know why a module exists. An operations agent may need to know whether a customer action was completed or who owes the next follow-up. Both need a maintained record they can check.

Hunch ships `hunch serve`: a self-hosted HTTP service for organization, team, user, and repository records. A configured identity determines which scopes an agent may access. Optional record audiences further restrict access; optional key-bound credentials require proof from the configured private key on each request.

Open `/operator` on your server to inspect current records, completed work and commitments in a read-only browser view. Writer-supplied citations can point to an exact summary field or text passage and its recorded sources. They show traceability; they do not prove that a source supports a claim.

Agents can use the same contract through MCP, `hunch state read|write|records|subscribe`, the `@davesheffer/hunch/state` TypeScript client, or the [Python client](https://github.com/davesheffer/hunch-private/blob/main/projects/hunch/docs/python-state-client.md). The Python package is built and tested from this repository; it is not yet published to PyPI. [Scoped conventions](https://github.com/davesheffer/hunch-private/blob/main/projects/hunch/docs/scoped-conventions.md) let a person record sourced user, team or organization preferences. Those preferences remain advisory and do not silently become blocking rules.

Records can describe decisions, action outcomes, commitments, entities, relationships, and summaries that name their dependencies. Actions retain their status, including unknown or unverified outcomes. Repeated writes have stable identities, conflicting current decisions are refused, and confirmed human records receive protections against agent overwrites. These are defined checks on structured records; Hunch cannot establish every fact in the outside world on its own.

This is what **deterministic state** means here: explicit rules govern the stored record, rather than having each agent reconstruct it from scratch. Git holds the durable data; SQLite is a rebuildable index. The server binds to loopback and requires deployment and agent integration by its operator. Hunch does not provide a managed CRM or email connector service.

[Set up and understand the state server](https://github.com/davesheffer/hunch-private/blob/main/projects/hunch/docs/deterministic-state.md) · [State contract and client reference](https://github.com/davesheffer/hunch-private/blob/main/projects/hunch/docs/nuryel-state-contract.md) · [Upgrade to 1.33](https://github.com/davesheffer/hunch-private/blob/main/projects/hunch/docs/upgrade-1.33.md)

### The vision, and what is still being tested

The vision is continuity across people, tools, and agents: an operations agent records a customer issue, a coding agent finds the relevant decision and fixes the cause, and the operations agent closes the commitment using evidence of the fix.

The underlying memory and state tools ship today. The broader claim—that different agents reliably use that shared state and avoid contradictory work—is still being measured in the Sofia pilot. Simulated results and a limited live pilot are not proof of that outcome across organizations. The [roadmap](ROADMAP.md) tracks the remaining acceptance gates.

**Hunch remains the product name.** The `nuryel.state/1` protocol and `nuryel_*` tool names are existing technical identifiers; a possible future rename is undecided.

## Project DNA: help the agent understand how the project works

Project DNA describes observed repository conventions: terminology, contribution habits, review expectations, and engineering patterns. Engineering memory records decisions and their reasons. Both can inform a task, but frequent behavior does not become policy.

```bash
hunch dna inspect
hunch dna context
hunch dna diff <older-ref> <newer-ref>
```

Profiles retain their revision, sources, confidence, and freshness. [Project DNA contract](https://github.com/davesheffer/hunch-private/blob/main/projects/hunch/docs/project-dna.md) · [Broader DNA vision](https://github.com/davesheffer/hunch-private/blob/main/projects/hunch/docs/project-dna-engine.md)

## Your data and your authority

- Repository use is local-first and needs no hosted Hunch account. Shared memory uses Git access; the optional state server uses configured identities and grants.
- `hunch private --repo <url>` keeps sensitive project reasoning in a private overlay. Public exports and CI should use public-only views.
- Drafting can use a selected coding-assistant subscription, a local endpoint, or the deterministic fallback. Public metered endpoints require explicit opt-in. [Synthesis and billing](https://www.hunchmemory.com/docs#synthesis).
- Agents keep responsibility for external actions and connector permissions. A stored record does not authorize an email, deployment, or CRM change.
- npm and editor releases use separate publication gates with package integrity and provenance checks.

## Learn more

- [Full documentation](https://www.hunchmemory.com/docs)
- [Copy-paste cookbook](https://www.hunchmemory.com/cookbook)
- [Task contribution reports](https://github.com/davesheffer/hunch-private/blob/main/projects/hunch/docs/task-reports.md)
- [Deterministic organizational state](https://github.com/davesheffer/hunch-private/blob/main/projects/hunch/docs/deterministic-state.md)
- [Project DNA](https://github.com/davesheffer/hunch-private/blob/main/projects/hunch/docs/project-dna.md)
- [Native change proof](https://github.com/davesheffer/hunch-private/blob/main/projects/hunch/docs/change-proof.md)
- [Engineering Landscape](https://github.com/davesheffer/hunch-private/blob/main/projects/hunch/docs/engineering-landscape.md)
- [Review memory](https://github.com/davesheffer/hunch-private/blob/main/projects/hunch/docs/review-memory.md)
- [Agent-origin handling](https://github.com/davesheffer/hunch-private/blob/main/projects/hunch/docs/agent-origin.md)
- [Autonomy ladder](https://github.com/davesheffer/hunch-private/blob/main/projects/hunch/docs/autonomy-ladder.md)
- [Autonomous development](https://github.com/davesheffer/hunch-private/blob/main/projects/hunch/docs/autonomous-development.md)
- [Changelog](CHANGELOG.md) · [Roadmap](ROADMAP.md)
- [VS Code extension](vscode-extension/README.md)
- [Architecture benchmark](bench/architectural-conformance.md)
- [Contributing](CONTRIBUTING.md)

Apache-2.0
