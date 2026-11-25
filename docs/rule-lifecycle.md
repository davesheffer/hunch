# Rule lifecycle

A rule (constraint) has a life cycle: an agent can propose it, a person approves it, anyone can challenge it, and it can be replaced or retired. This page describes the states, the commands, the data shapes and the local check log.

## States

```
Draft -> Active -> (Challenged) -> Retired
```

| State | Meaning | Effect in hooks |
| --- | --- | --- |
| Draft | Proposed, not yet approved by a person. | Warns, never blocks. |
| Active | Approved by a person. | Enforced as written (blocking, warning or advisory). |
| Challenged | An agent or person disputes it; it stays Active underneath. | Keeps blocking until a person clears or retires it. |
| Retired | Removed or replaced. | Not enforced. Kept for history. |

A challenge cannot lift a block. Only a person can end it.

## Commands

| Action | Who | Command |
| --- | --- | --- |
| Approve a Draft | person | `hunch review --confirm <id>` |
| Challenge | any agent or person | MCP `hunch_challenge`, or `hunch challenge <id> --reason "<why>"` |
| Clear a challenge | person only | `hunch challenge clear <id> --reason "<why>"` |
| Replace | person | `hunch replace <old> --with <new> --reason "<why>"` |
| Retire | person | `hunch remove <id> --reason "<why>"` |
| List rules | anyone | `hunch rules [--json]` |
| Show one rule | anyone | `hunch rule show <id> [--json]` |

A reason is recorded with every challenge, clear, replace and retire.

### Who may do what

The person gate is a guard against agents acting by mistake with normal tools, not a defence against a determined process running as the same user. Newly gated: `derive-rules --accept-changes`, `--drop`, `review --reject-duplicates`, `--approve-import`, `--decline-import`. Without a person, `new constraint`, `derive-rules` and `capture-comments` write only Drafts with `agent_recorded` provenance. Each rule records `source_session` and `source_run` in the rule log. An existing challenge is kept: challenging again is refused.

Also gated: MCP `hunch_review_imported_adr` (decline needs the human's confirmation like approve), `hunch test` promotion and `review-memory capture --apply` (drafts without a person token), and MCP `hunch_record_correction` over an existing active rule (refused; use `hunch_challenge`).

An agent has exactly one lifecycle tool over MCP: `hunch_challenge`. No MCP tool clears a challenge, approves a Draft, retires a rule or replaces one. `hunch_record_correction` with `supersedes` does not retire the old rule either: it opens a challenge on each superseded rule (reason "superseded by <new id>", logged like `hunch_challenge`) and the old rule stays enforced until a person runs `hunch replace`. An agent that re-records a retired rule gets a Draft back, never an Active rule. `nuryel_write` on the constraints facet keeps an existing rule's status, challenge and source fields, and creates a new rule as a Draft. The CLI enforces the person-only commands itself: `hunch review --confirm`, `--unconfirm`, `--accept`, `--accept-verified` and `--reject`, `hunch challenge clear`, `hunch replace`, `hunch retire-constraint`, `hunch derive-rules --accept`, `hunch record-constraint`, and `hunch remove`, `restore`, `edit` and `link` on a rule. Each one asks a person to type the rule id in a terminal, or accepts a registered person token (`HUNCH_PERSON_TOKEN`, set up with `hunch person-token init`; the Nuryel control plane sends it on a person's click). With neither it prints "Only a person can ..." and exits 4 before writing anything. A rule recorded with `hunch record-constraint` without a person becomes a Draft with `agent_recorded` provenance, and an existing rule keeps its status and challenge. Setup, the full command list and the limits of this check are in [person-actions.md](person-actions.md). The hook's PreToolUse Bash guard still denies these commands by command text as an early warning; it is best-effort (a script can bypass it), and the CLI check is the enforcement. Restoring a removed rule returns it to the state it had before removal, so a Draft never becomes Active without a person.

## Source linking

A rule records where it came from: `source_session` is the hook `session_id` of the agent session that proposed it, and `source_run` comes from the `HUNCH_RUN_ID` environment variable when the agent was started by a runner. Both are optional and are identifiers only.

## Local rule-check log

Each rule check appends one line to `.hunch/local/rule-checks.jsonl`. The file is git-ignored and never leaves the machine: it is not synced, exported or sent to any server. Each line is a JSON object with `kind` (`check`, `challenge` or `challenge_clear`), `at`, `rule_id`, `verdict` (allowed, warned, blocked; a denied edit logs blocked for every enforced rule in scope), `status` (the rule's state at the time), `file` (repo-relative path), `tool` (the agent tool that triggered the check), `session_id` and `run_id`. A `challenge` or `challenge_clear` line carries `reason` instead of `verdict`; both the MCP tool and the CLI (`hunch challenge`, `hunch challenge clear`) write it. At 4 MiB the log is renamed to `rule-checks.jsonl.1` (replacing any older one) and a new file starts. A symlinked `.hunch`, `.hunch/local` or log file is refused. It never holds code, file contents or prompts.

## JSON shapes

`hunch rules --json` prints an array of rule summaries:

```json
[{ "id": "con_...", "statement": "...", "severity": "blocking", "scope": ["src/**"], "status": "active", "challenge": null, "source_decision": null, "source_session": null, "source_run": null, "why": null, "superseded_by": null, "valid_from": "...", "valid_to": null }]
```

`status` is the display state: `draft`, `active`, `challenged` or `retired`. `challenge` is one object (`reason`, `by_session`, `by_run`, `at`) or `null`; there is no history. `superseded_by` is read from the retired rule's rationale text ("Superseded by con_..."), not from a separate link field. `hunch rule show <id> --json` prints the same fields plus `why_detail` (the source decision's `id`, `title`, `rationale` and `rejected` options) or `null`. Treat the exact field list as that of the schema version you run; unknown fields should be ignored by readers.

`hunch review --json` `rules[]` and `hunch why <file> --json` `constraints[]` use a smaller rule reference shape, not the full `hunch rules --json` item: `id`, `statement`, `severity`, `scope`, `status` (the stored status), `displayState` (`draft`, `active`, `challenged` or `retired`), `challenge` and `source_decision`; `why` adds `stale`. Read `rules --json` for `source_session`, `source_run`, `why` and `superseded_by`.

`hunch review --json` prints the review queue:

```json
{ "minGrounded": 0.5, "imported": [DECISION], "ready": [DECISION + { "grounded": 0, "pruned": 0, "critic": null }], "scrutiny": [same as ready], "rules": [RULE] }
```

where DECISION is `{ "id", "title", "decision", "status", "source", "confidence" }` and RULE is a rule summary as in `hunch rules --json`.

`hunch why <target> --json` prints one of three shapes. By record id: `{ "target", "kind", "record", "displayState"? }` (`displayState` only for a rule), or `{ "target", "record": null }` when nothing matches. By file or symbol: `{ "target", "decisions": [DECISION + { "stale" }], "constraints": [RULE + { "stale" }], "bugs": [{ "id", "title", "status", "root_cause" }], "symbols": [{ "name", "fan_in", "churn_90d" }] }`.

## Data format: schema v4

- The `status` enum gains `"draft"`.
- Rules gain the lifecycle fields: `source_session`, `source_run` and `challenge`. Retirement and replacement stay in `valid_to` and the rationale text.
- `schema_version` becomes 4. `hunch migrate` migrates in place.
- Existing rules stay Active. Nothing existing becomes Draft or starts warning instead of blocking.
- Readers of `.hunch/` JSON that switch on `status` must accept `"draft"`. The first write of a Draft, a challenge or a session/run link raises a v3 manifest to v4, so an older build warns that the store is newer and skips the v4-only records it cannot parse. (A manifest older than v3 is left alone until `hunch migrate`, so no earlier migration is skipped.) Agent-recorded corrections are now written as Drafts: a team mixing older and newer builds must upgrade together.
