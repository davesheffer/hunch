# Field Trial 001 — MCP TypeScript SDK

**Date:** 2026-08-31  
**Target:** `modelcontextprotocol/typescript-sdk`  
**Pinned target revision:** `70de0c8b569b0d664a56b90be2f141d1d1645880`  
**Purpose:** dogfood Project DNA against a high-signal external repository and measure whether accumulated repository context produces better contribution decisions than issue-by-issue agent work.

## What this run demonstrated

The first useful result was not a code edit. It was avoiding bad edits.

Seventeen plausible targets were screened. Fourteen already had active PR coverage, two were claimed in issue comments despite being unassigned, and one old open issue was already fixed in current source. No duplicate implementation was started.

Examples:

- `#1960` looked like a good-first-issue but already had multiple active fixes.
- `#2723` was already covered by `#2724`.
- `#2739` had no PR but a contributor had explicitly asked to take it.
- `#2730` had no PR but was similarly claimed in comments.
- `#579` remained open, but current `StdioClientTransport.close()` already performs stdin close → wait → SIGTERM → wait → SIGKILL, so implementing the issue text would have recreated solved work.

This establishes a repository-native rule for future runs:

> **Unassigned is not equivalent to available. Open is not equivalent to unresolved.** Check comments, active PR references, and current source before acting.

That rule is evidence-backed and should be treated as Project DNA/currentness guidance, not as a universal GitHub assumption.

## Candidate derived from repository history

Reading PR `#2724` exposed a deliberately scoped-out lifecycle defect:

> after `remove()`, the registration key binding still holds the last live key, so a later `update({ name })` can resurrect the removed handle.

The PR author explicitly identified the pre-existing tool-path behavior and left it out to keep `#2724` focused. Credit belongs to **@YatsukBogdan1** for that observation.

A repository-wide issue/PR search found no separate tracking for the follow-up.

Current `packages/server/src/server/mcp.ts` shows the same lifecycle shape across:

- `RegisteredTool` — registry key `name`
- `RegisteredPrompt` — registry key `name`
- `RegisteredResourceTemplate` — registry key `name`
- `RegisteredResource` — registry key `uri`

The expected invariant for a focused follow-up is:

> `remove()` is terminal for the registration represented by that handle. Later `update()`, `enable()`, `disable()`, or repeated `remove()` calls must not silently create a registry entry again or emit `list_changed` when the registry did not change.

## Ready-to-submit upstream issue

### Title

`Removed registration handles can be resurrected by update() after remove()`

### Body

A registration handle remains capable of re-inserting itself into the server registry after `remove()`.

For example, a tool can be removed, disappear from `tools/list`, and then be made live again by calling `update({ name: ... })` on the same removed handle. The same lifecycle problem applies to prompts, resources, and resource templates using their registry key (`name` or `uri`).

This is a focused follow-up to the review note in `#2724`. Credit to @YatsukBogdan1 for explicitly calling out the pre-existing tool-path behavior there; `#2724` intentionally keeps its scope to rename bookkeeping.

```ts
import { Client, InMemoryTransport } from '@modelcontextprotocol/client';
import { McpServer } from '@modelcontextprotocol/server';
import { expect, test } from 'vitest';

test('removed tool handle cannot resurrect itself', async () => {
    const server = new McpServer({ name: 'repro', version: '0.0.0' });
    const client = new Client({ name: 'repro', version: '0.0.0' });

    const tool = server.registerTool('first', {}, async () => ({
        content: [{ type: 'text', text: 'still alive' }]
    }));

    const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
    await Promise.all([client.connect(clientTransport), server.connect(serverTransport)]);

    tool.remove();
    expect((await client.listTools()).tools.map(t => t.name)).toEqual([]);

    tool.update({ name: 'second' });

    // Current behavior: ['second']
    expect((await client.listTools()).tools.map(t => t.name)).toEqual([]);
});
```

On the tool path, `remove()` delegates to `update({ name: null })`. The update closure deletes `_registeredTools[name]`, but the captured `name` binding remains the last live key. A later `update({ name: 'second' })` therefore takes the normal rename path and inserts the detached handle back into `_registeredTools`.

The same lifecycle shape exists for `RegisteredTool`, `RegisteredPrompt`, `RegisteredResourceTemplate`, and `RegisteredResource`.

`#2724` makes the current registry key mutable for prompts/resources/templates so repeated renames and `remove()` work correctly; it deliberately does not make removal terminal, so this issue remains after that change as well.

Expected behavior: `remove()` should be terminal for the registration represented by that handle. Subsequent mutations should not silently re-register it. The narrow implementation could track detached/removed state and make later mutations a no-op, or consistently throw if maintainers prefer a stricter contract.

Suggested regression coverage per primitive:

1. register;
2. remove;
3. confirm the relevant list is empty;
4. update with a new registry key;
5. confirm the list remains empty and the new key is not callable/readable;
6. confirm post-removal mutation does not emit a misleading additional `list_changed` notification.

## Repository DNA captured in this run

### Contribution culture

Observed from `CONTRIBUTING.md` and live issue traffic:

- Significant changes should be discussed first; straightforward focused bug fixes can proceed with tests.
- Contributors are expected to comment before taking issue work.
- Small, atomic PRs are preferred.
- Tests and the repository's validation commands are part of the contribution, not optional cleanup.

### Currentness discipline

Issue state alone is weak evidence. Before acting, combine:

1. issue state and labels;
2. issue comments/claim signals;
3. active PR references;
4. current implementation at a pinned revision.

### Branch/version topology

The repository maintains modern `main`/v2 work alongside `v1.x`; fixes may require separate backports rather than one broad cross-version patch. Treat that as a task-specific decision rather than silently modifying both lines.

## Benchmark baseline

This run starts the evidence series with screening/currentness metrics:

| Metric | Trial 001 |
| --- | ---: |
| Candidate issues inspected | 17 |
| Active-PR overlaps avoided | 14 |
| Comment-claimed issues respected | 2 |
| Stale open issues caught by source verification | 1 |
| Duplicate implementations started | 0 |
| Untracked follow-up candidates derived from prior scope/history | 1 |
| Human steering needed after execution started | 0 |

Code-edit metrics remain intentionally blank until the repository is writable from the connected account: time-to-first-correct-edit, files inspected during implementation, failing-first test count, test failures, and review interventions.

## Execution boundary

An upstream issue creation attempt returned `403 Resource not accessible by integration`. The authenticated GitHub account has full write access to Hunch, but no writable `davesheffer/typescript-sdk` fork is currently installed/available to the connector.

That permission boundary is recorded as part of the trial rather than bypassed. The next execution step is to make a writable fork available and then implement the focused lifecycle regression from that fork.

## Why this is a useful Hunch test

A fresh agent optimized for "find an open issue and fix it" would have repeatedly selected already-covered work. Project DNA/currentness changed the action selection itself:

- it avoided duplicated implementation;
- distinguished issue metadata from actual repository state;
- respected local contribution norms;
- reused a prior PR's scope boundary;
- derived the next contribution from repository history rather than from a generic issue label.

That is the behavior this field-trial series should measure across later contributions: not merely whether an agent can write code, but whether accumulated repository knowledge makes it behave like a returning contributor.
