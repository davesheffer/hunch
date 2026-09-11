# Review memory

Turn historical GitHub inline review threads into file-scoped checks for future
coding agents. Importing comments does not make them rules. You select a thread,
write the reusable invariant and describe how to verify it, or let the automatic
flow propose, verify and save advisory rules for you.

## Automatic flow

From the matching repository checkout, the initiating agent runs:

```sh
hunch review-memory auto --repository OWNER/REPO --initiator codex --private --output /local/review-report.json
```

Use the actual initiating agent (`claude`, `codex`, `kimi`, or a configured CLI).
Recognized live harness metadata can supply it automatically. The command follows
Hunch's [general origin routing policy](agent-origin.md); it never switches accounts
if that provider fails. `--public` explicitly allows repository-visible rules instead
of private storage. Private storage does not mean model-free analysis: the chosen
initiating CLI processes the supplied review/code context.

The command fetches complete GitHub review comments through authenticated `gh`.
Use `--from comments.json` or `--from review-packet.json` to use a local export.
No `rules.json` or per-rule approval is needed. `--dry-run` analyzes without saving
rules or the local analysis checkpoint. `--limit 20` is the default model-analysis
bound, with a maximum of 100; newest updated threads are considered first.

For each new thread, Hunch reads the current tracked file, asks the initiating
provider for a reusable rule and an observable check, validates exact supporting
quotes, and performs a separate skeptical model pass against the full thread,
current file, and relevant existing constraints. It saves only proposals that pass
every check, through the same advisory Constraint store used by manual capture.
The check is a description for future verification, not a command Hunch executes.

The JSON report contains `saved` (or `ready` for dry runs), `skipped`, `review`, and
`deferred` entries with reasons, evidence/code hashes, provider identity, and saved
rules. A local derived checkpoint in Git's worktree administration directory avoids
repeating unchanged skipped/review outcomes; `--retry` requests another analysis.
Changed context invalidates cached analysis. Existing captured rules are never
overwritten or revived, even with `--retry`; changes require explicit rule review.
Failed analyses remain retryable. The report can contain sensitive derived text;
keep it outside version control for private repositories.

Limits: model judgments are fallible, semantic conflict detection is not a proof,
and two passes may share the same model's mistakes. A matching quote proves provenance,
not correctness. Files over 64 KiB, unavailable/untracked files, and evidence over
120 KiB are withheld rather than truncated. The importer still caps the full export
at 10,000 comments / 16 MiB. This command runs when invoked; it does not install a
scheduler or a background GitHub watcher.

## Manual flow

The manual flow uses local GitHub REST exports. It does not fetch reviews,
infer a reviewer's seniority, or treat a resolved thread as proof that its advice
is still correct. It excludes bot comments and refuses incomplete human threads.

## Prepare evidence

Export review comments from the intended repository using your authenticated
GitHub CLI (read only):

```sh
gh api --paginate --slurp repos/OWNER/REPO/pulls/comments > reviews.json
hunch review-memory prepare --repository OWNER/REPO --from reviews.json > review-packet.json
```

The packet retains author, text, file, commit, timestamps and source URL, with a
hash for each thread. It is untrusted evidence with no enforcement authority.
Keep these exports outside version control, especially for private repositories.
The importer accepts up to 10,000 comments / 16 MiB; narrow the GitHub export by
date if necessary. Keep all comments of each selected thread in the export.

Read a candidate and its replies, inspect the current code, and create a separate
`rules.json`. Copy the actual `candidate_id` and `evidence_hash` from the packet:

```json
[
  {
    "candidate_id": "review_123",
    "evidence_hash": "COPY_THE_EXACT_HASH_FROM_THE_PACKET",
    "rule": "Missing tenant context must return an error.",
    "check": "Exercise a request without tenant context and assert an error response."
  }
]
```

Do not paste a comment wholesale as a rule: a suggestion may have been rejected,
superseded by a reply, or fixed only for that specific change. The explicit check
must identify observable behavior. It is text for a reviewer, not a shell command
that Hunch executes. No LLM or paid API is used by these commands.

## Preview and capture

Run from the matching repository checkout:

```sh
hunch review-memory capture --from review-packet.json --rules rules.json
hunch review-memory capture --from review-packet.json --rules rules.json --apply --private
```

`--private` requires a configured private overlay. Use `--public` instead only
when the rule, check and source links may enter repository-visible memory.
Existing Hunch shared-home routing and auto-commit settings still apply.
Preview never writes memory. A stale hash, foreign repository, missing file or
existing rule ID is refused; existing rules are not overwritten or revived.
If a disk write fails midway through a batch, inspect the reported constraints
and retry only those that were not persisted.

Captured rules use the existing Constraint store and remain non-blocking
`agent_recorded` testimony. They contain the explicit invariant, a check in the
rationale, and links/hashes of the source evidence. No raw comment body is copied
into ambient instructions. No regex or executable matcher is inferred. Blocking
authority still requires Hunch's existing human capture/countersign flow.

## Use during bug fixes, including Sofia

The coding agent handling a bug calls `hunch_check_constraints` for the affected
file, or `hunch_context` when orienting. Rules use the existing grounding and
pre-edit delivery; there is no separate Sofia rule database. The full constraint
includes the review check and evidence links. For example:

```text
hunch_check_constraints({ scope: "src/auth.ts" })
```

Have the agent run the relevant check and report its actual result. A review
finding needs a reproduced failure or an explicit violated requirement; optional
improvements should stay separate. This feature does not execute tests, make CRM
changes, or add an automatic Sofia bug-fixing worker.
