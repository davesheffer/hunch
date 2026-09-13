# Hunch Guard review path (candidate)

The required `Hunch Guard` workflow remains the source of the ordinary blocking
check. This candidate adds a separately named `workflow_dispatch` path for the
solo maintainer to review one narrowly defined failure: a direct scope blocker
whose recorded scope is stale. It publishes `hunch-guard-review` on the exact
PR head SHA; it does not edit branch protection or replace the required check.

The dispatch must be made from `main` and supplies the PR number, full head and
base SHAs, a guard run id, a canonical report hash, a human reason, and an
explicit authorization boolean. The supplied `base_sha` must be the current
`refs/heads/main` commit, which is checked independently of the PR API's
possibly stale `base.sha`. The verifier binds all of those values to the live
open PR, the configured maintainer's GitHub numeric id and login, and the
trusted evaluator receipt. A report is reviewable only when its failure class is
exactly `direct_scope_blocker`. Policy failures, executable behavior policy
failures, conformance failures, vetoes, regressions, unknown results, incomplete
evaluation, and infrastructure errors are always refused.

The evaluator package name is fixed by the review policy, while its version is
read from the checked-out trusted `package.json` at dispatch time. The producer
does the same in its trusted checkout. This keeps a release bump from silently
leaving a permanent old version in the policy; a report from another evaluator
version is refused.

The producer's separate finalizer is the only job with `statuses:write`. It
validates the bounded producer artifact and rechecks the live PR before posting
`hunch-guard-review` for ordinary pass or failure results. A failed direct-scope
result remains failure until the separately authorized review workflow publishes
the success status; other failure classes stay failure.

Before building the synthetic repository, the producer also requires the live
main commit to be an ancestor of the PR head. A branch behind main receives a
non-reviewable `stale_base` receipt, so newly added main files cannot be
misread as deletions from the PR.

The workflow checks out only the default branch and treats the downloaded guard
report as data. It never checks out a PR, installs a PR package, runs a PR script,
or invokes Hunch against a PR worktree. The receipt producer must therefore be a
trusted-base `workflow_run` run with a machine-readable `hunch-guard-report`
artifact whose `workflow_sha` equals the trusted producer run's default-branch `head_sha`; the requested PR `base_sha` is bound separately. The companion
`Hunch Guard Review Producer (candidate)` now creates that artifact from a
synthetic repository: it archives the exact base and PR trees, restores only the
base `.hunch` memory, and invokes the trusted evaluator with `--base`, SARIF, and
`--public-only`. It never checks out or executes PR code. The producer rejects
active executable-behavior policies before evaluation, so those policies remain
non-waivable rather than being silently skipped.

The current required `pull_request` guard does not satisfy that provenance
contract, by design. The candidate consumer reads only the companion producer's
bounded artifact and refuses reports from the current guard rather than granting
an unsafe exception.

[GitHub's workflow syntax documentation](https://docs.github.com/en/actions/reference/workflows-and-actions/workflow-syntax#onworkflow_dispatch)
says `workflow_dispatch` runs only when the workflow exists on the default
branch, and [GitHub's security guidance](https://docs.github.com/en/actions/reference/security/securely-using-pull_request_target)
warns that privileged `pull_request_target` workflows must not execute untrusted
code. The candidate follows both constraints. [GitHub's commit-status API](https://docs.github.com/en/rest/commits/statuses#create-a-commit-status)
permits a user with push access to set a status on a specified commit SHA; the
status context is separate from the existing Hunch Guard check. A one-time
branch-protection migration to require this context belongs to live qualification
after a trusted receipt producer exists; it is intentionally not part of this
candidate.

Run the focused verifier tests with:

```sh
npx tsx --test test/hunch-guard-review.test.ts
```

Qualification-only ordinary-pass fixture.
