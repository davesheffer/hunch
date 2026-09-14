# Upgrade to Hunch 1.33

Version 1.33 adds a browser view of shared state, exact field citations, record audiences,
scoped conventions, state commands, optional key-bound authentication and a repository-built
Python client. Existing engineering memory and ordinary partition-wide bearer access remain
supported. There is no automatic policy activation or scheduled development agent.

The state hashing helper now refuses an own object key named `__proto__`, which the legacy
encoding silently omitted. Other canonical bytes and valid record identities are unchanged.
Derived content is an exact string, so JSON text containing that name remains supported.
Callers hashing arbitrary objects must rename the reserved key or encode their payload as text.

## Repository users

Run `hunch update` in each repository to install the published 1.33 release. Use
`hunch update --global` when updating a global CLI alongside a repository dependency. The updater
preserves unrelated settings and disabled hooks and aligns configured launchers to the published
version.

Reconnect active MCP sessions. For Codex, review changed commands in `/hooks`, trust the
commands you intend to use, and start a new session. `hunch integrations check` distinguishes
configured integrations from lifecycle events actually observed; a configuration check alone
does not prove hooks fired.

## Shared-state operators

1. Keep a backup of the partition's committed data and configuration using your normal private
   backup process. Keep tokens and private signing keys out of Git.
2. Upgrade and restart **every server serving the partition** before enabling new access
   controls. Verify the new capabilities on each instance. Restart clients and re-read held state.
3. Open `/operator` on the server and connect with an existing authorized identity. The view is
   read-only. An unknown or observed result retains that status, and activity is retained history,
   not a complete inventory.
4. Enable [record visibility](record-visibility.md) only in a dedicated partition home. The first
   restricted write installs a durable capability requirement before writing protected data.
   Old 1.32.7/1.32.8 state readers, including already-running servers, refuse subsequent state
   operations. Do not remove that marker to force a downgrade. Restore a compatible pre-feature
   backup if rollback is needed; preserve the newer history separately.
5. For [key-bound identities](key-bound-principals.md), configure the exact public HTTPS origin,
   the principal's public key and private shared replay-state directory. Upgrade all serving
   processes first: old servers must not remain available with bearer-only behavior. Keep the
   signing key in the client. Test rotation and revocation on the deployed topology. An already
   admitted request may finish after revocation.

| Client or reader | What to check |
| --- | --- |
| Existing repository MCP integrations | Updated launcher, a fresh session and observed hook delivery |
| Older state clients | Capability negotiation before using new features; protected partitions require a compatible reader |
| State CLI | Token via environment or private file; no token argument in shell history |
| TypeScript | `@davesheffer/hunch/state`; Node signing helper in `@davesheffer/hunch/state-proof` |
| Python | Python 3.11+, repository install; optional `proof` extra for request signing; not a PyPI release |
| Filesystem or Git access | Trusted-owner access; record visibility does not encrypt files or restrict a repository owner |

## Qualification and remaining acceptance

The implementation is covered by contract, transport, browser, upgrade and platform checks.
The [frozen recall evaluation](state-recall-evaluation.md) uses a synthetic corpus and a pinned
local embedding model; its result is not a production-corpus accuracy claim. Python wheel tests
are not evidence of an independent external consumer.

Codex CLI 0.154.0 in VS Code's integrated terminal has completed the native normal-work
contribution-card rehearsal. Two observed repository-user sessions, the Sofia two-user pilot week
and any explicit human policy decisions still remain in the [roadmap](../ROADMAP.md); the
[external acceptance operator runbook](external-acceptance-runbook.md) defines the two human-run
procedures and their evidence. The product name remains Hunch.
