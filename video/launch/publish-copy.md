# Publish copy

Replace `{{YOUTUBE_URL}}` only after the unlisted upload passes desktop and
mobile review. Recheck community rules immediately before posting.

## YouTube

### Title

**I gave coding agents memory of the bugs they must not repeat**

### Description

AI coding tools can read your code. Hunch gives them the decisions, rejected
approaches, and bug history behind it—then checks a change deterministically
when your team explicitly opts into a precise rule.

Try Hunch: https://github.com/davesheffer/hunch
Documentation: https://hunch-pi.vercel.app/

In this demo, an assistant tries to remove a service-layer “hop.” The edit looks
clean, but the layer exists because direct database access previously skipped
authorization and batching. Hunch returns that reason before the edit, then
shows one opt-in change receipt with the causal evidence attached.

Hunch is local-first, Apache-2.0, and works with Claude Code, Cursor, Copilot,
Codex, Windsurf, Antigravity, and MCP clients. Project memory remains readable
JSON in Git; the enforcement path is deterministic and does not call a model.

```bash
npm i -g @davesheffer/hunch
cd your-repo
hunch init
hunch backfill --since 90d
```

Chapters:

```text
00:00 The reason coding agents cannot see
00:18 Save the engineering story once
00:34 Return it before the edit
00:49 The opt-in deterministic check
01:04 Recovery and a passing receipt
01:14 Shared project memory
```

Hunch v1.20.0 was used for this recording. The example is deterministic and
reproducible from the public `video/` kit in the repository.

#opensource #aicoding #mcp

### Pinned comment

What is one project rule you keep explaining to coding agents or new teammates?
If you try Hunch, tell me which repository and assistant you used and whether
the returned history was actually useful. A star is appreciated only if the
tool earns it: https://github.com/davesheffer/hunch

## LinkedIn

An AI refactor can pass tests and still reintroduce a failure your team already
fixed.

I built a 90-second demonstration around a small example: an orders route goes
through a service layer because direct database access once skipped
authorization and batching. Months later, that layer looks like unnecessary
abstraction, so a coding assistant proposes removing it.

Hunch brings the original decision and incident back before the edit. Memory is
advisory by default. If the team explicitly trusts one precise rule, the same
project can also produce a deterministic change receipt with the reason
attached—without asking a model to decide the gate.

The memory is readable JSON in Git and works across Claude, Cursor, Copilot,
Codex, Windsurf, Antigravity, and MCP clients.

Watch: {{YOUTUBE_URL}}
Code: https://github.com/davesheffer/hunch

What architectural rule or old bug do you find yourself explaining repeatedly?

#opensource #aicoding #developertools

## Show HN

### Title

**Show HN: Hunch – Git-native project memory and deterministic change checks**

### Text

Hi HN — I built Hunch because coding agents can inspect current code but often
cannot see the incident, rejected design, or team decision that explains why
the code has its current shape.

Hunch stores that engineering history as readable JSON in Git and exposes the
relevant slice to Claude, Cursor, Copilot, Codex, Windsurf, Antigravity, and MCP
clients. It can capture decisions from commits, import ADRs, answer questions
such as “why is this built this way?”, and show bug lineage and blast radius.

Memory is advisory by default. A captured statement never silently becomes an
enforced rule. If a human explicitly accepts a precise constraint, Hunch can
evaluate a working tree or branch deterministically and return a cited PASS,
WARN, or BLOCK receipt. No model runs in that gate.

The demo shows a route whose service layer exists because direct DB access once
skipped authorization and batching. An agent sees the extra hop as removable;
Hunch returns the old reason before the edit and can catch the same violation
afterward when strict checks were deliberately enabled.

There is no Hunch account or hosted memory service. It is Apache-2.0, requires
Node 22.13+, and can be tried locally:

```bash
npm i -g @davesheffer/hunch
cd any-git-repo
hunch init
hunch backfill --since 90d
```

Repository: https://github.com/davesheffer/hunch
90-second demo: {{YOUTUBE_URL}}

I would especially value criticism of the authority boundary: what evidence
would you require before allowing remembered engineering intent to warn or
block a code change?

## Community post

### Suggested title

**I built a local project memory so coding agents can see why a strange-looking boundary exists**

### Text

I kept running into a specific problem with coding assistants: they could read
the current implementation, but not the incident or rejected design that made
the implementation necessary.

I built an open-source tool called Hunch to keep that history as readable JSON
in Git and return the relevant slice before an edit. It works across coding
assistants rather than keeping memory inside one chat product.

The 90-second demo uses an orders route whose service layer prevents a previously
observed auth/batching failure. The assistant proposes removing the “extra”
hop; Hunch returns the original reason. I also show the optional deterministic
change check, but installation is advisory and never silently enables blocking.

Demo: {{YOUTUBE_URL}}
Source: https://github.com/davesheffer/hunch

I am looking for technical feedback, especially from people who maintain ADRs,
agent instruction files, or architecture tests. What would make this useful—or
unsafe—in your workflow?

### Posting rule

Use this only after reading the community's current self-promotion rules. Adapt
the title and explanation to an existing discussion, post in one community at a
time, answer every good-faith question, and do not ask for votes or paste the
same launch text across multiple communities.
