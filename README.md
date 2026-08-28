# Hunch

## Give your AI coding assistant the missing story behind your code.

[![npm version](https://img.shields.io/npm/v/@davesheffer/hunch?color=2742ff&label=npm)](https://www.npmjs.com/package/@davesheffer/hunch)
[![GitHub stars](https://img.shields.io/github/stars/davesheffer/hunch?color=2742ff&label=%E2%98%85%20star)](https://github.com/davesheffer/hunch)
[![license](https://img.shields.io/npm/l/@davesheffer/hunch?color=2742ff)](LICENSE)

Git remembers what changed. Chat history disappears. A future Claude, Cursor, Codex, or Copilot
session can read your code, but it usually does not know why your team chose this design, which
alternative failed, or which old bug a strange-looking line prevents.

**Hunch is project memory for the AI coding tools you already use.** It saves decisions, bug fixes,
rejected approaches, and important rules. Before an assistant changes code, Hunch brings back the
relevant reasons. After the change, it can check whether the work conflicts with a rule your team
explicitly trusts.

### A simple example

Your team once moved login sessions to the server so stolen tokens could be disabled immediately.
Months later, an AI assistant sees the extra code and proposes a “simpler” token-only design. Hunch
shows the assistant why the server-side design exists and which security bug it prevents—before the
edit happens.

That means less time repeating old explanations, fewer old mistakes returning, and the same project
context across every coding assistant.

Hunch is **not another AI model** and it does not replace your coding assistant. It is the memory and
safety layer behind it. Memory is advisory by default; nothing blocks work unless you deliberately
turn on strict checks for a precise rule.

## Start in five minutes

Requires Node 22.13+ and a git repository.

```bash
npm i -g @davesheffer/hunch
cd your-repo
hunch init
hunch backfill --since 90d   # optional: seed memory from recent history
```

Reload your coding assistant, then ask a normal question:

> Why is this built this way?

Hunch answers from your project's saved history and shows where the answer came from. `hunch init`
indexes the repo, installs local hooks, and connects supported assistants without replacing their
existing configuration.

## What Hunch gives you

- **A memory that outlives chat** — decisions and corrections are still available next week, next
  year, and in a different assistant.
- **One shared story** — Claude Code, Cursor, Copilot, Windsurf, Antigravity, Codex, and any MCP
  client get the same project context.
- **Warnings with reasons** — review a change against trusted project rules and see exactly why it
  passes, needs attention, or should be blocked.
- **Past bugs stay useful** — see which old incident a piece of code fixed before accidentally
  undoing it.
- **Understands how code connects** — for TypeScript, JavaScript, Python, Go, PHP, YAML, and Helm, Hunch
  can see what calls or depends on the code you are about to change. Its memory works with any
  language.
- **Works with existing decision documents** — import your architecture decision records into
  Hunch, or export Hunch decisions back to a standard format other tools can read. Imported ADRs
  start as useful advisory memory; during normal work your assistant asks you to approve or decline
  one exact ADR at a time. Silence never grants authority, and changed ADR text is asked again.

The source of truth is readable JSON in `.hunch/`. A local SQLite index makes retrieval fast but
is always rebuildable.

## What improved in v1.19

Hunch now gives developers a better, shorter list of code to inspect when they describe a problem.
In a 12-problem test on unfamiliar code, it found the changed piece of code in 6 cases instead of 3
and found the correct file in 10 cases instead of 8. In a separate test, it kept the same five
successful finds while reducing the average number of named code items to inspect—such as functions
or classes—from 18.9 to 11.

| What the test measured | Before | v1.19 | Result |
| --- | ---: | ---: | ---: |
| Problems where Hunch found the changed code | 3/12 | 6/12 | 2× as many in this test |
| Problems where Hunch found the correct file | 8/12 | 10/12 | 2 more correct files |
| Pieces of code inspected for the same five finds | 18.9 average | 11 average | 41.9% less to inspect |

These are small, controlled tests—not a promise that Hunch is twice as accurate everywhere. Hunch
also refuses to pretend it knows the exact fix when the evidence only shows where to investigate.
The detailed receipts live in [`bench/external/results`](bench/external/results).

See the public [roadmap](ROADMAP.md) for what is next and what is deliberately out of scope.

## Common tasks

Most memory work happens automatically after commits. These commands cover the common manual paths:

| Command | Use it for |
| --- | --- |
| `hunch why <file>` | Explain why a file is built this way and what could be affected by changing it |
| `hunch query "<question>"` | Search project memory |
| `hunch context "<task>" --profile reviewer` | Get a bounded builder, reviewer, or architect view without changing enforcement |
| `hunch change-id <base> [head]` | Bind a branch and its exact squash merge to the same content-based change ID |
| `hunch check --working` | Check current changes against the decisions and rules your team trusts |
| `hunch log` | See what Hunch remembered and undo a memory change if needed |
| `hunch escalations` | See the rare questions that need a human answer |
| `hunch review` | Answer the current imported-ADR approve/decline question from the terminal |
| `hunch doctor` | Diagnose setup problems |

<details>
<summary><strong>Advanced: problem shortlisting and evidence receipts</strong></summary>

These tools help researchers and maintainers investigate where a described behavior may live. They
show uncertainty instead of claiming to know the exact fix.

| Command | Use it for |
| --- | --- |
| `hunch shortlist --issue "..."` | Build a bounded list of files and named code items to inspect |
| `hunch evidence-map receipt.json` | Add observed execution evidence without guessing the exact owner |

`hunch evidence-map` accepts a bounded JSON receipt containing a red target, a distinct green
control, optional execution counts, and optional intervention outcomes. It reports target-only and
shared execution plus behavior-sensitive files. It does not run the probes, edit the repository, or
claim that behaviorally influential code owns the correction. Use `--json` for the machine-readable
map; MCP clients can submit the same receipt through `hunch_evidence_map`.

`hunch shortlist --evidence` attaches authenticated observations to the relevant candidates but does
not reorder them. Three fresh transfer experiments failed to prove that execution or intervention
influence identifies the correction owner, so the production path converts that result into a hard
safeguard: no candidate is promoted or displaced by evidence. JSON output still includes a
deterministic receipt and the explicit `exact_owner_enabled: false` policy.

Every shortlist also preserves its flat top five and adds a deterministic hierarchical inspection
view anchored to those files: at most five files, two semantic declaration families per file, and
three declarations per family. On a preregistered 12-case fresh transfer, the preserved union found
6/12 changed declarations versus 3/12 for the flat top five (**+25 percentage points**, three
rescues), while correct-file coverage improved from 8/12 to 10/12. The view averaged 18.8 unique
declarations and never exceeded 24. This promotes the clusters as a supplemental diagnostic, not as
a top-five accuracy claim; exact-owner output and per-case confidence remain disabled. JSON output
includes the deterministic cluster receipt and the transfer calibration.

The default output also turns those clusters into a progressive inspection queue. It preserves the
flat shortlist, adds only the strongest members of already-selected semantic families, stops at ten
when the behavior is explained, and permits one final fallback declaration before reporting
uncertainty. Development replay retained all 21/36 combined hits from the full cluster view while
reducing the hard inspection ceiling to 11 from an average of 19.8 declarations (44% less). On a
separate preregistered 12-case ArkType transfer it retained all 5 full-cluster hits with zero losses
and reduced mean inspection from 18.9 declarations to 11 (41.9% less). It found no additional fresh
hit, so the queue is retained as an efficiency advisory rather than promoted as an accuracy gain.

Follow-up optimization attempts stay out of production. Replacing cluster slots with same-file
declarations produced four development rescues but also three losses. Appending two same-file slots
removed those development losses, but a second blind 12-case ArkType transfer produced 3/12 hits for
both the existing and expanded plans, with zero rescues. Product-source filtering lost one prior hit,
one-hop relationship expansion added none, and evidence/causal rerankers also failed their frozen
transfer gates. The receipts remain in `bench/external/results`; rejected mechanisms cannot silently
change the production ordering.

</details>

Corrections can become scoped rules, but captured memory cannot hard-block on its own. Enforcement is
deterministic and opt-in:

```bash
hunch firmness strict
hunch check --staged --strict
```

## Share the same memory with your team

For a team, Hunch can keep everyone’s decisions, corrections, and rules in one private Git
repository, separate from the code repository. Hunch does not host it. Create a private repository
that every teammate can access, install Hunch on team machines and CI, then have one maintainer run:

```bash
npm i -g @davesheffer/hunch@1.19.0
hunch shared --repo git@github.com:acme/project-hunch-memory.git
git add .gitignore .hunch/team.json
git commit -m "chore: connect shared Hunch memory"
git push
```

Use a credential-free URL in the command; keep tokens in your Git credential helper or use SSH.
If this project already publishes memory in `.hunch/` and you want to move it into the dedicated
repo, add `--migrate`, review the reported untrack/ignore changes, and follow the commit instructions
printed by Hunch. Omit `--migrate` for a new setup.

After the pointer commit lands, teammates need Hunch installed and Git access to the memory repo:

```bash
npm i -g @davesheffer/hunch@1.19.0
git pull
hunch init
hunch doctor
```

`hunch init` validates and connects an ignored local clone of the memory repo. Memory-reading and
writing CLI operations attempt a bounded refresh at startup; connected MCP sessions check for new
team memory at each tool-request boundary and rebuild their local index only when the JSON changed.
New captures route to that repo and are committed and synchronized automatically by default. If a
push cannot complete, a later capture or `hunch shared --sync` retries it.

The committed `.hunch/team.json` contains only the credential-free memory-repo locator and canonical
branch. The ignored `.hunch/local.json` contains local paths and preferences, not credentials;
authentication stays in SSH or the normal Git credential helper. Shared memory records,
`.hunch/local.json`, and `.hunch-private/` stay out of code history. Use
`hunch check --base origin/main --strict --public-only --format markdown` for output that may be
posted publicly; omit `--public-only` for an internal check that should enforce team memory.
`HUNCH_PRIVATE_DIR` remains an explicit process-level override for CI and portability. When it
redirects a repo away from `.hunch/local.json` or bypasses an advertised team store, CLI and MCP
startup warn on stderr and `hunch doctor` labels the effective source.

For a correction that Hunch can express as a deterministic policy, create and inspect its
proof-backed proposal:

```bash
hunch policy upgrade-correction con_...
hunch policy card pol_...
```

The upgrade creates evidence, a plan, and a proof but leaves the policy proposed with
`authority: none`. A proved policy still requires explicit, audited human acceptance before it can
become advisory or blocking; Hunch never grants that authority automatically.

Need to pause or roll back without deleting memory?

```bash
hunch firmness off
hunch shared --repo git@github.com:acme/project-hunch-memory.git --no-auto-commit
# Later, publish any pending local memory explicitly:
hunch shared --sync
```

The first command turns off agent-hook enforcement; the second keeps shared reads and local captures
but stops automatic memory commits and pushes. As a team-coordinated rollback, revert the setup
commit to stop discovery after teammates pull the revert. Existing machines retain their ignored
local overlay until they are deliberately disconnected; do not delete the memory repo as part of a
rollback. For this rollout, reinstall the previous published package with
`npm i -g @davesheffer/hunch@1.16.0`; the release receipt resolves and records the verified rollback
target from the npm registry instead of trusting Git tags. Pause enforcement first as shown above,
and keep every team client on the same release before resuming Matrix policy workflows.

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

## Releases you can trace to source

Hunch releases are built and tested without publication credentials. The resulting npm tarball or
VSIX is content-addressed, carried unchanged into a minimal publisher, and checked again against the
registry after publication. The npm path also runs native, atomic-write, and Matrix safety checks on
Windows and macOS and verifies provenance back to the exact source tag.

The editor companion is published from an exact `vscode-v*` tag to
[Open VSX](https://open-vsx.org/extension/davesheffer/hunch-vscode). The workflow verifies the
downloaded public VSIX has the same digest as the credential-free release candidate.

## Learn more

- [Full documentation](https://hunch-pi.vercel.app/docs)
- [Copy-paste cookbook](https://hunch-pi.vercel.app/cookbook)
- [VS Code extension guide](vscode-extension/README.md)
- [Contributing](CONTRIBUTING.md)
- [Architecture benchmark](bench/architectural-conformance.md)
- [Engineering Landscape Graph and ORC boundary](docs/engineering-landscape.md)
- [ORC outcome/experience protocol](docs/outcome-experience-protocol.md)
- [Competitive landscape (dated; re-verify before quoting)](docs/competitive-landscape.md)

Apache-2.0
