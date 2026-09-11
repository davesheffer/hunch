# Automatic review memory: Infection trial

On 2026-09-10, the new automatic command analyzed three complete historical
threads against an isolated checkout of `infection/infection` at
`bd7e49f8763e811e29eccf2b5cd2d09cf9de29d7`. Codex initiated the run and all model
calls stayed with `codex-cli`. No `rules.json` or handwritten rules were supplied.

- A deferred factory-builder proposal was skipped: the discussion did not establish a durable rule.
- A regression discussion produced an advisory rule preserving initial-test command output at suite start.
- A filesystem-injection discussion produced an advisory rule requiring the injected filesystem without a constructed fallback.

Both rules were persisted and delivered for their respective files. An unrelated
file received neither. A second run performed zero model analyses and created no
duplicates, while retaining the skipped thread's cached disposition.

The [inspectable JSON report](infection-automatic-review-memory-trial.json) contains
the generated wording/checks, source links, evidence/code hashes, provider identity,
initial run, replay, and verification outcomes. The clone used `autoCommit:false`;
no upstream Infection changes or messages were made.

This is a small **preselected** sample: the two prior manual trial cases plus one
deferred proposal. It demonstrates the automatic plumbing and an actual model
selection, not precision/recall or reduced bug rates. PHP tests were not run. The
Kimi ACP transport was verified with a protocol fixture; no logged-in Kimi was
available on this machine.
