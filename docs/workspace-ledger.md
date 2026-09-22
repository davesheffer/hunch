# Workspace ledger: branches and worktrees across machines

Status: **All three phases implemented (branch `claude/git-branches-worktrees-tracking-7v15a6`,
2026-09-17): the record kind, machine identity, the git snapshot with merged verdicts, cross-machine
sync through the overlay, the post-checkout hook, the ledger-read refresh, the
read-only `hunch_workspaces` tool, `/worktrees`, the `now` / `doctor` lines, `hunch workspaces
prune` (dry run / local-only `--apply`), and pull-request linkage from local commit subjects.**
Drafted 2026-09-17.

## The problem

One developer working on several machines (and a team working on many) accumulates branches and
worktrees nobody remembers. Answering the routine questions —

- which worktrees are open, and on which machine?
- which branches exist only on machine X and were never pushed?
- which branches are already merged (including squash-merged) and can be deleted?
- which worktree still has uncommitted work, so it must *not* be pruned?

— is today an agent conversation: `git worktree list`, `git branch -vv`, `git branch --merged`,
`git log`, a look at the PR list, and cross-referencing all of it, on *every* machine, *every*
time. It is slow, it burns tokens on deterministic work, and the answer is gone as soon as the
session ends. No machine can see another machine's worktrees at all.

Hunch already has the two things this needs: a git-native memory store that syncs between
machines through the private/shared overlay repository, and a set of git hooks that fire in the
regular code flow. The plan is to make each machine record its own workspace facts
deterministically, sync them through the overlay, and answer the questions above from memory
with one CLI command or one MCP tool call.

This is engineering memory, not the served state layer: no `hunch serve`, no daemon, no token.
It lives in the same flow as decisions and constraints.

## Design in one paragraph

Each machine writes **one record** per repository, `.hunch/workspaces/ws_<machine_id>.json`, into
the overlay store (private or shared), describing that machine's worktrees and local branches
with deterministic verdicts (pushed? ahead/behind? merged, and how?). The record is an
*observation* with an `observed_at` stamp and git evidence, never a claim of truth. Because each
machine owns exactly one file, syncing through the overlay never conflicts: no merge-driver
changes, no last-writer-wins. Snapshots refresh from git hooks and whenever an agent reads the
ledger, so it is maintained as a side effect of normal work. Queries read the union of all machines'
records and produce a compact table plus a recommended action per branch and worktree.

## What gets recorded

A new additive record kind, `workspaces` (registered in `ENTITY_KINDS` / `SCHEMAS` in
`src/core/types.ts`, one directory `.hunch/workspaces/`). Older builds ignore directories they do
not know, so existing graphs load unchanged and no `manifest.json` schema bump is needed.

The example below is a `publish: full` record; the default `branches` mode has no `path` fields.

```jsonc
{
  "schema": "hunch.workspace/1",
  "id": "ws_a1b2c3d4e5f6",              // derived from the machine id: one record per machine
  "machine": { "id": "mac_…", "label": "machine-7f3a", "platform": "darwin" },   // label is user-set; never the hostname by default
  "repository": "git-remote:sha256:801e…",      // stableRepositoryName(): a digest, never a URL or path
  "publish": "full",
  "observed_at": "2026-09-17T08:12:00Z",
  "fetched_at": "2026-09-17T07:58:00Z",  // mtime of FETCH_HEAD: when origin was last fetched here (or null)
  "default_branch": { "name": "main", "ref": "origin/main", "head": "8f3c…" },
  "worktrees": [
    { "id": "wt_3c9e1a70", "path": "/Users/dave/code/hunch",          "branch": "main",   "head": "8f3c…",
      "is_main": true,  "dirty": false, "locked": false, "prunable": false, "last_commit_at": "2026-09-16T…" },
    { "id": "wt_b41d02f9", "path": "/Users/dave/code/hunch-wt/feat-x", "branch": "feat/x", "head": "1a2b…",
      "is_main": false, "dirty": true,  "locked": false, "prunable": false, "last_commit_at": "2026-09-10T…" }
  ],
  "branches": [
    { "name": "feat/x",  "head": "1a2b…", "is_default": false, "upstream": "origin/feat/x",  "upstream_gone": false,
      "ahead": 2, "behind": 0,  "last_commit_at": "2026-09-10T…", "worktree": "wt_b41d02f9",
      "merged": { "status": "unmerged", "method": null, "evidence": ["not in origin/main@8f3c…; squash searched last 2000 commits"] } },
    { "name": "fix/old", "head": "9c9c…", "is_default": false, "upstream": "origin/fix/old", "upstream_gone": true,
      "ahead": null, "behind": null, "last_commit_at": "2026-07-02T…", "worktree": null,
      "merged": { "status": "merged", "method": "squash", "evidence": ["patch-id of 5e5e…..9c9c… equals origin/main commit d4d4…"] } }
  ],
  "provenance": { "source": "extracted", "confidence": 1, "evidence": ["git worktree list --porcelain", "git for-each-ref refs/heads/", "…"] }
}
```

Field rules:

- **Machine identity** is a random 128-bit id generated once per machine and stored at the user
  level (`~/.config/hunch/machine.json`, mode `0600`, `XDG_CONFIG_HOME` / `%APPDATA%` aware), so
  every repository on the machine reports under the same id. It is *not* derived from hardware
  serials, MAC addresses or the hostname, so it identifies nothing outside Hunch. The label
  defaults to `machine-<first 4 hex of id>` and is set by the user (`hunch workspaces label
  "build-box"`); the hostname, OS username and home directory are never recorded. Per-repo
  `.hunch/local.json` is *not* used for this: a fresh clone must report as the same machine.
- **Paths** are stored absolute (a worktree path is meaningful only on its own machine) and only
  when `publish` is `full` (see Team mode); in `branches` mode a worktree is recorded as
  `{ "branch", "dirty", "locked" }` with no path. Every string field goes through the existing
  credential filters (`isCredentialFreeText` / `isCredentialFreeValue` in `src/core/provenance.ts`)
  and the record is rejected, not trimmed, if any field fails.
- **What is deliberately not recorded**: commit messages, diffs, file names, remote URLs, author
  emails, environment variables, the hostname. Branch names, commit SHAs and ISO dates are the
  only repository-derived content, and branch names must pass `git check-ref-format`.
- **Merged verdicts** are deterministic, computed on the machine that has the objects:
  - `ancestry` — `git merge-base --is-ancestor <head> <default remote head>`, unless the head lies on
    the default branch's first-parent history: such a branch has no commits of its own (freshly
    created, or fast-forwarded in) and is reported as `no-commits`, never offered for deletion;
  - `squash` — the patch-id of the branch's whole diff since merge-base equals the patch-id of one
    commit on the default branch **after the branch's merge base** (the same `git patch-id --stable`
    signal `changeIdentity.ts` uses). A matching commit that is an ancestor of the merge base is the
    branch's own history, so a reland (revert of a revert) or a value flipped back is not merged —
    the same `base..default` set `git cherry` compares against;
  - `rebase` — every commit on the branch has a patch-equivalent commit among the searched
    default-branch commits after the merge base, i.e. it was rebased or cherry-picked in (computed against the
    same one-time patch-id map as `squash`, not with `git cherry`, whose cost grows with the
    default branch's history for every branch checked);
  - the squash/rebase search covers the last 2000 default-branch commits; when that history
    cannot be read (too large, git failed) the verdict says `search unavailable` rather than
    claiming a search that did not happen. A record holds at most 4096 branches and 512
    worktrees, newest first; anything omitted, and any branch name git would refuse as an
    argument, is counted in the record's provenance instead of silently dropped;
  - `upstream_gone` alone is *not* a merged verdict (a branch can be deleted remotely without
    merging); it is reported as its own signal.
  - `unknown` when the default branch is not present locally or git failed (never collapsed into
    `unmerged` — the same "false ≠ error" rule `CommitRepairStatus` exists to enforce).
- **Dirty** is `git status --porcelain --untracked-files=all` non-empty in that worktree (explicit,
  so `status.showUntrackedFiles=no` cannot hide an untracked file); **locked** comes from
  `git worktree list --porcelain`. Both gate pruning.
- **Freshness**: a record older than `workspaces.stale_after` (default 7 days) is reported as
  *unverified* in every query — the machine may be off, or the hook may not be installed. The
  data is still shown; the verdict is labeled.

Nothing here requires an LLM. Synthesis is untouched (`con_2ce3f2a547`).

## When the record refreshes (the regular code flow)

Snapshots are cheap (a handful of git commands, no network) and idempotent: a snapshot that
produces the same content hash as the stored record writes nothing and commits nothing.

| Trigger | Where it plugs in | Notes |
| --- | --- | --- |
| `git checkout` / `git switch` / `git worktree add` | **post-checkout** managed block in `src/integrations/hooks.ts` (shipped), installed by `hunch init`, `hunch private` / `hunch shared`, and self-healed by `hunch index` like post-merge | fires only for branch checkouts (`$3 = 1`), never for file checkouts |
| `git commit` | **nothing, deliberately** | a commit changes `HEAD`, not which branches and worktrees exist; snapshotting per commit would add git work (up to a patch-id walk) to the most frequent operation there is, and its backgrounded child outliving `git commit` held a Windows clone directory open and broke an unrelated test's teardown |
| An agent calls `hunch_workspaces` | `src/mcp/server.ts` (shipped): the read publishes the observation it just took, in the server process, through the ordinary capture path — no timer and no child process, so nothing can outlive the session or hold the repository directory open (a detached child did, and broke an unrelated Windows test's teardown); `HUNCH_WORKSPACE_REFRESH=0` makes the call read-only | the machines that ASK about the ledger are the machines visible in it; a host with no git hooks yet still reports, and a session nobody asks never writes |
| `hunch worktree <path>` | existing command in `src/cli/index.ts` (shipped) | snapshot after the worktree is created |
| `hunch workspaces snapshot [--fetch] [--dry-run] [--quiet]` | manual / CI / cron (shipped) | `--fetch` runs `git fetch --prune` first; the default never touches the network. A snapshot whose content is unchanged and whose stored record is under a day old writes nothing |

The snapshot is written to the overlay through the existing capture funnel
(`flushPrivate` in `src/integrations/sync.ts`), so it auto-commits and pushes exactly like a
private decision does, and other machines receive it on their next overlay pull. In `public`
mode (no overlay configured) the record is written to the repo-tracked `.hunch/` **only if**
`workspaces.publish_public: true`; the default is to skip with a one-line `doctor` hint, because
committing per-machine paths into the code repository is rarely wanted.

A snapshot bound for the PUBLIC `.hunch/` is a commit on the checked-out code branch, so it
**defers** (`deferred`, reason `git-operation-in-progress` or `detached-head`) whenever git is
replaying history — rebase, merge, cherry-pick, revert, bisect — or HEAD is detached: `git rebase`
itself fires post-checkout, and an untracked `ws_*.json` appearing mid-rebase makes
`git rebase --continue` abort. Nothing is lost; the next branch checkout or ledger read records
the machine. A private overlay is its own repository, so overlay snapshots never defer.

Hook cost guard: the hook runs the snapshot in the background (`&`, the same shell pattern the
post-commit capture line uses — nothing is detach-spawned any more) and skips the write when the
stored record is younger than one day and its content is unchanged, so `git checkout` latency is
unaffected.

## The queries

All queries read every `ws_*` record visible in the store (this machine's plus every synced one)
and never shell out to git on another machine's behalf. Output is deliberately compact: one line
per worktree/branch, so an agent spends tens of tokens, not thousands.

### `hunch workspaces` — the inventory (shipped)

This machine is always read **live** from git (its paths shown, never stored); other machines
come from their stored records, whose WORKTREE column reads `yes` in the default `branches`
publish mode.

```
MACHINE           WORKTREE                     BRANCH     DIRTY  LAST COMMIT  SEEN
build-box (this)  /home/dave/code/hunch        main       -      1d ago       live
build-box (this)  /home/dave/code/hunch-wt/x   feat/x     yes    7d ago       live
machine-9f2c      yes                          main       -      1d ago       9d ago (unverified)
machine-9f2c      yes                          fix/old    -      77d ago      9d ago (unverified)
```

Flags: `--machine <label>`, `--branch <name>`, `--fetch`, `--json`. Companions: `hunch
workspaces label [label]` (show/set this machine's label, warns when it equals the hostname or
username) and `hunch workspaces forget <machine>` (drop a retired machine's overlay record; a
record committed into this repo's `.hunch/` under `publish_public` is refused with the manual
`git rm .hunch/workspaces/<id>.json` recipe instead).

### `hunch branches` — the verdicts (shipped)

```
BRANCH        MACHINES            WORKTREE        UPSTREAM        MERGED          ACTION
feat/x        dave-mbp            dave-mbp        ahead 2         no              keep (dirty worktree on dave-mbp)
fix/old       dave-mbp,dave-desk  dave-desk       gone            yes (squash)    delete local on dave-mbp; prune worktree on dave-desk
spike/y       dave-desk           -               never pushed    unknown         review: unpushed, 41d idle, dave-desk unverified
```

Flags: `--merged`, `--stale <days>`, `--unpushed`, `--machine <label>`, `--fetch`, `--json`.
Ahead/behind is measured against the branch's own upstream; "merged" is measured against the
default branch. When two machines hold the same branch at different heads the row says so
(`review: local heads differ …`) instead of recommending a delete.

The `ACTION` column is a recommendation computed from the same rules everywhere:

| Condition | Recommendation |
| --- | --- |
| merged (ancestry or squash) and no dirty/locked worktree anywhere | delete local branch on each machine that has it; prune its worktree |
| merged but a worktree on it is dirty | keep; name the machine and worktree |
| unmerged, no upstream, idle > `stale_after` | review: unpushed work, possibly lost if the machine is retired |
| unmerged, upstream ahead/behind | keep (a dirty worktree is named: `keep; dirty worktree on X`) |
| machine record unverified | any action is suffixed `(unverified)` and never auto-applied |

### `hunch workspaces prune` (shipped)

The dry run (default) prints the exact `git branch -d -- <name>` / `git worktree remove -- <path>`
commands **per machine**, each with the verdict evidence that justifies it, and lists the
merged branches it deliberately leaves alone with the reason (checked out in the main worktree,
dirty, locked, path missing). `--apply` executes only the commands for *this* machine, and before executing it
re-runs the snapshot and acts on that **fresh local result, never on a stored record**: a branch
is deleted only when the live verdict is `merged` with evidence tied to the same `head` sha, and
a worktree is removed only when it is clean and unlocked right now. It uses `git branch -d`
(never `-D`) and `git worktree remove` (never `--force`), so git itself refuses anything
unmerged or dirty as a second line of defense. Because `git branch -d` cannot see a squash or
rebase merge once the upstream is gone or unset, the plan runs git's own `-d` precondition first
(the head must be an ancestor of its upstream when one resolves, otherwise of the main worktree's
`HEAD`); a step it would refuse is skipped whole — the worktree is not removed — and reported
("squash-merged: git branch -d would refuse (not merged into HEAD); delete manually after checking"). Ignored files
(`.env`, `node_modules/`), which `git worktree remove` deletes without asking, are not a refusal
but are named (bounded list plus count) in the plan and in the confirmation. Every token of a
printed command is shell-quoted, and the record schema refuses control characters and newlines
in stored paths and evidence. `--apply` asks for interactive confirmation
listing every command; in a non-TTY it refuses unless `--yes` is passed explicitly. Commands for
other machines are printed, never executed — and `--apply` never deletes remote branches.
Deleting somebody else's unmerged work is exactly the irreversible action Hunch should not take
unattended, mirroring the `repair-provenance --apply` posture in `src/integrations/hooks.ts`.

### MCP (shipped)

One **read-only** tool, `hunch_workspaces(view: "inventory" | "branches", machine?, branch?,
merged_only?)`, returning the same table as text and the rows as `structuredContent`. It is in
the everyday tool group (a grounding read, not a specialist state tool). There is no MCP write or
prune surface: an agent can *see* what is prunable but can only act through the CLI, where the
confirmation above applies. Its description tells the agent to call it *instead of* running git
inventory commands.

### Existing surfaces (shipped)

- `hunch now` and `hunch_now` gain one line from **stored** records only (no git, so the hot
  view stays fast): `🗂 Workspaces in memory: 3 machine(s) (1 unverified) · 7 worktree(s) (2 dirty)
  · 12 branch(es), 4 deletable`. The public view reads the public store; `--private` the union.
- `hunch doctor` reports this machine's label (warning when it equals the hostname or username),
  whether its record is in memory and when, how many other machines are, and whether the
  post-checkout hook is installed.
- `hunch init` scaffolds a `/worktrees` slash command next to `/capture` and `/heal`
  (`src/integrations/scaffold.ts`): call `hunch_workspaces`, report the rows as they are, never
  run git inventory commands, never delete.

## Team mode

With `hunch shared --repo <url>`, every teammate's machine record lands in the same overlay, so
`hunch branches` answers "who has a worktree on `feat/x`, and is it dirty?" for the whole team.
Two knobs in `.hunch/config.json` under `workspaces`:

- `publish: "full" | "branches" | "off"` — **default `branches`** everywhere: label + branch +
  verdicts + dirty/locked flags, no paths. `full` (paths included) is an explicit opt-in a solo
  developer may choose for a private overlay; `off` disables the record entirely. The default is
  the same in private and shared mode so that switching an overlay from private to shared never
  starts publishing data that was previously local.
- `stale_after: "7d"`.

Machine labels are user-chosen and should not embed personal data; `doctor` warns when a label
equals the hostname or the OS username. `hunch workspaces forget <machine>` removes a retired
machine's record from the overlay (a normal, revertable memory move in `hunch log`). It REFUSES
a record living in the repo-tracked `.hunch/` (`publish_public`): Hunch publication is additive
and never stages a tracked deletion, so deleting the file would strand `D
.hunch/workspaces/<id>.json` and wedge every later auto-commit. The command prints the manual
recipe — `git rm .hunch/workspaces/<id>.json` then a commit — which the human runs as an
ordinary reviewable change.

## Security and privacy

This section is written for a security reviewer. It states the threat model, what leaves a
machine, and the control for each risk. Every control is a testable statement; Phase 1 ships the
tests named in the last column.

### What leaves the machine, and where it goes

- A workspace record leaves the machine **only** through the overlay repository the organization
  already configured for Hunch memory (`hunch private` / `hunch shared --repo <url>`) — a git
  remote under the organization's control, pushed with the developer's own git credentials over
  the transport git already uses. There is no Hunch-operated service, no telemetry, no third
  party, and no new network endpoint. With no overlay configured, nothing leaves the machine.
- In the default `publish: branches` mode the record contains: a random machine id, a user-set
  label, the OS platform name, the privacy-safe repository label (`stableRepositoryName`: a
  SHA-256 of the canonical fetch remote — never a URL or a path),
  branch names, commit SHAs, ISO timestamps, ahead/behind counts, dirty/locked booleans and the
  merged verdicts. Nothing else. Paths are added only under an explicit `publish: full`.
- The snapshot never reads the network. `--fetch` is an explicit opt-in and runs `git fetch
  --prune` with fixed arguments against the repository's existing remote only.

### Threat model and controls

| Risk | Control | Verified by |
| --- | --- | --- |
| Crafted `ws_*.json` in a cloned public `.hunch/` or a shared overlay (attacker-controlled input read automatically) | Strict Zod schema (`.strict()`, bounded lengths, regex-validated ids, `check-ref-format`-validated branch names), the existing per-record size cap (`MAX_JSON_RECORD_BYTES`) and the same symlink / FIFO / hard-link refusals `readTeamConfig` applies. An invalid record is skipped and reported by `doctor`; it is never partially applied. | schema fuzz tests; malformed/oversized/symlinked record fixtures |
| A stored record steering a destructive action (e.g. a record claiming a branch is merged) | Stored records are **display-only**. `prune --apply` re-computes the verdict from live git on this machine and acts on that only; it never reads `merged` from a record. Paths from *other* machines' records are never passed to any command. | test: a forged "merged" record must not cause a delete |
| Command injection through branch names / paths | git is invoked with `execFileSync` and a fixed argv (no shell). No branch or worktree *name* is ever a git argument: the snapshot passes only literals, refs it built from a fixed candidate list (after `--end-of-options`), and 40/64-hex SHAs validated by regex; worktree paths are used only as the working directory. A branch name git would refuse as an argument is skipped and counted, never recorded. Paths used by `--apply` come from `git worktree list --porcelain` on this machine, never from a record. | schema tests with hostile names (`--upload-pack=…`, `-D`, spaces, newlines); a live `refs/heads/-dash` fixture |
| Git hook executing untrusted content | The post-checkout / post-commit blocks call the pinned `hunch` invocation with a constant argument list (`workspaces snapshot --quiet`); no argument is derived from repository content. Hook blocks are the same managed-block mechanism `hunch init` already uses, install only when the user runs `hunch init`, and are inspectable in `.git/hooks`. | hook-content snapshot test |
| Unattended destructive action | `--apply` is CLI-only, local-machine-only, `git branch -d` / `git worktree remove` without force flags, requires interactive confirmation or an explicit `--yes`, and never touches remote branches. The MCP tool is read-only. Nothing runs on another machine. | tests for each refusal path |
| Secret leakage into memory | Every string field passes the existing credential filters; remote URLs, commit messages, diffs, file names, author emails and environment variables are not recorded at all. A record that fails the filter is rejected, not trimmed. | credential fixtures rejected |
| Personal data | No hostname, OS username, home directory, hardware id or MAC address is recorded. Default label is `machine-<4 hex>`; `doctor` warns on a hostname/username label. `hunch workspaces forget <machine>` deletes a machine's overlay record (a `publish_public` record in the repo-tracked `.hunch/` is refused with a `git rm .hunch/workspaces/<id>.json` recipe, since an additive pump cannot stage the deletion); the overlay's git history is the organization's own repository, subject to its retention. | field-level tests |
| Impersonation in a shared overlay (a teammate writing a record under another machine id) | Records carry no authority: they never gate a write, a merge or a delete, so a forged record can at most mislabel a row. The overlay's git commit author remains the audit trail. | documented; no code path grants trust to a record |
| Supply chain | No new runtime dependency. Node built-ins and git only. | `package.json` diff |
| Availability / performance | Hook snapshot is backgrounded, skips when the record is < 60 s old, is bounded to a fixed set of git commands with timeouts (the `timeout: 5_000` pattern in `src/extractors/git.ts`), and a failure never blocks the checkout or commit. | hook latency test |

### What a reviewer can inspect

- `src/extractors/workspaces.ts` — the complete list of git commands the snapshot runs, each
  with a fixed argv.
- `src/core/types.ts` `WorkspaceSchema` — every field that can exist in a record; the schema is
  `.strict()`, so nothing else can be stored.
- `src/integrations/hooks.ts` — the exact hook text installed.
- `hunch workspaces snapshot --dry-run --json` — prints what *would* be written, so a reviewer
  can see the record for their own machine before enabling publication.

## Phases

Each phase ships on its own, is tested under `test/`, and does not require the next.

**Phase 1 — single machine, local truth (implemented).** Record kind + strict Zod schema
(`src/core/workspace.ts`, registered in `src/core/types.ts`; no migration needed — the kind is
additive); machine identity (`src/core/machine.ts`); snapshot extractor
(`src/extractors/workspaces.ts`: worktree list, branch list, upstream state, ancestry / squash /
rebase verdicts, dirty/locked); `hunch workspaces [list|snapshot|label|forget]` and `hunch
branches`. `snapshot` already routes through the capture funnel, so with an overlay configured
the record is committed and pushed there today; without one it writes nothing unless
`workspaces.publish_public` is set. `test/workspaces.test.ts` builds throwaway repos with real
worktrees, merge / squash / rebase merges, a deleted upstream and a never-pushed branch, and
runs the hostile-input, forged-record, symlink, credential-filter and live-wins-over-stored
cases from the security table. Exit criterion: on one machine, the three questions
in "The problem" are answered by one command with no LLM and no network.

**Phase 2 — cross-machine (implemented).** One shared code path
(`src/integrations/workspaceLedger.ts`) records a snapshot through the capture funnel and reads
the ledger for every surface; refresh triggers (post-checkout block, the `hunch_workspaces`
read-time publish, `hunch worktree`; never post-commit); freshness labeling; union query across `ws_*` records; the read-only
`hunch_workspaces` tool; `/worktrees`; `now` / `doctor` lines. `test/workspace-ledger.test.ts`
drives a real post-checkout hook end to end (branch checkout records, file checkout does not),
the record/read path against a real overlay repo, the tool through an in-memory MCP client with a
forged record for this machine that must not be read, the read-time publish and its opt-out, the scaffold, and
`hunch worktree` / `doctor` / `now` through the CLI.

**Phase 3 — safe cleanup (implemented).** `hunch workspaces prune [--apply] [--yes]` with the
local-only, evidence-bound rules above (`planPrune` / `pruneRefusal` in `src/core/workspace.ts`
are pure and tested against every refusal; `applyPrune` in `src/integrations/workspaceLedger.ts`
runs fixed-argv git with `--`, no force flags, and re-snapshots afterwards so other machines see
the change). PR linkage: a merged branch carries `merged.pr` when the LOCAL merge commit
subject reads `Merge pull request #N from owner/<branch>` or the squash commit subject ends in
`(#N)` — the subjects GitHub/GitLab write — matched in JS, never fetched from a forge, never a
branch name in a git argument. `publish` privacy modes shipped in Phase 1.

Deliberately **out of scope**: executing any command on another machine, deleting remote
branches, a background daemon, and any use of `hunch serve` — the ledger must work for a
developer whose only Hunch surface is the CLI and the MCP tools in their editor.

## Decisions to confirm before Phase 1

1. **Machine id at user level (`~/.config/hunch/machine.json`), not per repo.** Recommended: yes —
   the whole point is that all clones on a machine report as one machine. Random, never
   hardware-derived.
2. **`publish: branches` (no paths) as the default in every mode.** Recommended: yes — paths
   are an explicit opt-in, so a private overlay later shared with a team never leaks a layout
   that was recorded under a different expectation.
3. **Snapshot never fetches by default.** Recommended: yes — hooks must stay offline-safe and
   fast; `--fetch` and `hunch workspaces snapshot --fetch` in a daily cron are the opt-ins. The
   `fetched_at` field tells the reader how fresh the `behind` / `upstream_gone` signals are.
4. **`--apply` scope.** Recommended: local machine only, live-verdict only, `-d` / no force,
   clean and unlocked only, interactive confirmation (or explicit `--yes`). No MCP write path.
