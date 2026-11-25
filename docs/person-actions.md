# Person-only actions

Some rule actions are decisions a person makes. The `hunch` CLI enforces this itself, in `src/core/personGate.ts`, before it writes anything.

## Which commands need a person

- `hunch review --confirm <id>` and `hunch review --unconfirm <id>` (approve a draft, countersign a record, take it back)
- `hunch review --accept <id>`, `--accept-verified` and `--reject <id>`, and `hunch derive-rules --accept <id> --expect <hash>` (approve or reject a draft or queued proposal)
- `hunch challenge clear <id>`
- `hunch replace <old> --with <new>`
- `hunch retire-constraint <id>`
- `hunch remove`, `hunch restore`, `hunch edit` and `hunch link` when the target is a constraint (`con_*`). The CLI decides by resolving the record, not by how the id is spelled.
- `hunch record-constraint` when a rule with the same id already exists. Re-recording keeps the existing status, challenge, `retired_from` and source session/run. When no such rule exists and no person is verified, the rule is created as a `draft` with `agent_recorded` provenance; a person approves it with `hunch review --confirm <id>`.
- `hunch derive-rules --accept-changes` (gated per changed rule, before any write), `hunch derive-rules --drop`, `hunch review --reject-duplicates`, `--approve-import` and `--decline-import` need a person.
- `hunch new constraint`, `hunch derive-rules` and `hunch capture-comments` without a person write only a Draft with `agent_recorded` provenance; they never stamp `human_confirmed`. `hunch challenge <id>` on an already challenged rule is refused and keeps the first challenge.
- (older note) `hunch derive-rules --accept-changes` and `hunch capture-comments` rewrite rules from docs and comments. They keep the existing rule's status, challenge, `retired_from` and source session/run.
- MCP `hunch_review_imported_adr` needs the human's confirmation in the client prompt for `decline` as well as `approve`. Without it nothing is written and the agent is told to have the person run `hunch review --decline-import <id>`.
- `hunch test` (a promoted regression guard) and `hunch review-memory capture --apply` (and the automatic review-memory capture) write a `draft` unless a valid `HUNCH_PERSON_TOKEN` is supplied. They never prompt. A draft warns but never blocks, whatever its severity; a person approves it with `hunch review --confirm <id>`.
- MCP `hunch_record_correction` refuses to re-record an existing active (or challenged) rule: use `hunch_challenge`. A draft can still be re-recorded; a retired rule returns as a draft.
- `hunch record-constraint` by a person over an existing draft or retired rule keeps that status and now says so ("kept as draft: approve with `hunch review --confirm <id>`" or "kept retired").

Challenging a rule (`hunch challenge <id>`) is open to agents: it only flags a rule for review.

## Two ways to prove you are a person

1. **Terminal confirmation.** In an interactive terminal (stdin and stdout are both a TTY) the CLI asks you to type the rule id: `Type con_x to confirm: <action>`. Anything else refuses.
2. **Person token.** A trusted tool, such as the Nuryel control plane, sends the token in the `HUNCH_PERSON_TOKEN` environment variable. The CLI compares its sha256 with the hash in `~/.hunch/person-token.json` (constant-time). If `HUNCH_PERSON_TOKEN` is set and the check fails for any reason (no file, symlink, not a regular file, unreadable, wrong token) the action is refused and the CLI does not fall back to a terminal prompt.

## Creating the token

Run once, in your own terminal:

```
hunch person-token init            # first time
hunch person-token init --rotate   # replace it; the old token stops working
```

The command refuses without a terminal. It prints the token once; store it as Nuryel's `HUNCH_PERSON_TOKEN`. Only the hash is stored, in `~/.hunch/person-token.json` (`{"v":1,"sha256":"...","created":"..."}`, mode 0600, written atomically). It refuses to write through a symlinked file or `.hunch` directory. The store is read from the operating-system account home only (`os.userInfo().homedir`); `HOME`, `USERPROFILE` and `HUNCH_HOME` are ignored, so an agent cannot point the CLI at a token store it wrote itself. The CLI removes `HUNCH_PERSON_TOKEN` from its own environment at startup, so the programs it spawns never inherit it.

## Exit code 4

A refused person-only action exits with code **4** ("person required") and prints why on stderr. Nothing is changed: the check runs before any store write.

## Threat model

The gate is a guard against an agent acting by mistake with normal tools. It is not a security boundary against a determined program running as the same user. This stops agents acting through normal tools: an agent's shell has no terminal and no token, so the CLI refuses. It is not a defence against a deliberately hostile process running as the same user, which can read the token file's directory, edit the store files directly, or run its own code.

## The shell guard is advisory

The PreToolUse shell guard (`src/core/lifecycleShellGuard.ts`) still refuses these commands typed from an agent's shell, so the agent gets a clear message early. It matches command text and can be bypassed by scripts or indirection. The CLI gate above is the enforcement.

The UI (`hunch ui`) never holds the token: its spawned CLI runs without `HUNCH_PERSON_TOKEN`, so a person-only action from the page is refused (exit 4) and the page shows the exact command to run in your own terminal.
