# Autonomous development: readiness and the promotion ladder

Dated 2026-09-09. Written after a red team of the roadmap and of everything in this repository
that lets development run unattended. Observations carry the date they were made; later snapshots
are added, never substituted (the same practice as `docs/competitive-landscape.md`).

## Verdict

Not ready for full autonomy today. Ready for **staged autonomy** after one day of hygiene and one
hour of gate configuration, promoted rung by rung on measured numbers. This is the same rule the
product applies to its own policies (`docs/autonomy-ladder.md`): authority is promoted by evidence
and by one explicit human act, never switched on.

The reason is not code quality. The code is unusually clean for its size: zero real TODO/FIXME
markers in ~60,000 lines, zero `@ts-ignore`, zero skipped tests, intent-conformance 7/7, no open
escalations. The blockers are process state and gate configuration.

## Update — 2026-09-12

What changed since the red team, each with where it is verified:

- Required status checks on `main`: `ci` (Node 22 and 24), `hunch-guard`,
  `platform-matrix-safety` (macOS, Windows), with `enforce_admins` — configured 2026-09-09.
- `npm-publish` and `vscode-publish` environments each require reviewer `davesheffer`
  (`can_admins_bypass` is still `true`; undecided). Pushing a `v*` tag no longer publishes without
  an approval.
- `hunch drift --fail-on <kinds>` shipped in 1.32.2 and the release gate fails on `finding-stale`.
  The nine findings citing deleted Sofia files were re-recorded with their true location.
- The `.claude/pipeline/` prototype was removed in 1.32.2.
- Hook capabilities are verified from lifecycle events actually delivered (1.32.1); the
  qualification record holds live Claude and Codex runs.
- Memory hygiene is a standing agent obligation, not a checklist item: `con_039cee7367`.
- Gate 5 has a first live number: one user, scripted, 0 of 3 status replies unsourced after one
  read (2026-09-12). The two-user week needs a second participant and a shared task; the CRM
  credential was repaired on 2026-09-11.
- The loop stands at rung 1 of the ladder below. Rung 3's condition ("Gate 5 has a number") means
  the two-user number, not the single-user one.

The findings below are the 2026-09-09 snapshot and are kept as written.

## What the red team found (2026-09-09)

Attacks that landed, each with the evidence that landed it.

**Merge gates are softer than they look.**

- `required_status_checks` on `main` returns 404: neither `ci` nor `hunch-guard` is required. A red
  CI does not block a merge. `hunch-guard.yml:3` says "Make this a required check to enforce." It
  is not.
- The only hard merge gate is one approving review. There are eight open PRs, all CI-green, all
  unreviewed, three of them stacked on the same subsystem (`feat/entity-identity` →
  `feat/entity-merge` → `feat/replay-determinism`, 11/18/9 commits ahead). Review is the
  bottleneck; more autonomous authoring only lengthens that queue.
- The `npm-publish` and `vscode-publish` environments have no protection rules, no reviewers and
  `can_admins_bypass: true`. Pushing a `v*` tag publishes.
- The local `gh` token carries `repo` + `workflow` scope, so any unattended process on this
  machine can push, open and merge PRs, and edit workflow files.

**Hunch's own deterministic shell is not armed on Hunch.**

- Firmness is `strict`, but all six blocking-severity constraints carry
  `enforcement: advisory_v1`; both live policies are `active_advisory`; both local git hooks end in
  `|| true`. Nothing in the self-gate layer hard-blocks.
- `hunch integrations check` reports every capability on all six harnesses as `untested`,
  `advisory-only` or `unsupported`. The pre-edit hook that an autonomous loop would rely on has
  never been exercised against a real host from this checkout.
- The `.claude/pipeline/` stop-gate (verify-after-edit wall) is not referenced by
  `.claude/settings.json`. It is dead code.
- Semantic search is off, so retrieval is keyword-only.

**The memory a loop would read is partly wrong and partly empty.**

- `hunch now` lists zero proposed decisions. The public work queue is empty while the private
  overlay holds twenty proposals, fourteen of them from 2026-08-09, several already shipped (delivery
  receipts, budgets) but still marked proposed.
- `hunch drift` reports 28 finding-stale entries: nine live findings cite files that do not exist in
  this tree (`src/sofia-*.js`, `emulation/replay.mjs`, `src/service/*`, `.codex/hooks.json`). One
  finding's re-verify command cannot run. Drift exits 0, so no gate notices.
- The roadmap contradicts the code in five places (fixed in this revision: "not frozen yet",
  "planned" facets and verbs, three verbs instead of four, a status header one day behind its
  content, and `hunch experiment` / Constitution G2–G3 absent from the program status).

**The test suite is honest but expensive and host-sensitive.**

- One test carries a 12-minute timeout (`test/team-matrix-e2e.test.ts:265`); thirteen more exceed
  60 seconds; no wall-clock runtime is recorded anywhere. A loop with a short budget will kill the
  run and read the kill as a failure.
- `test/matrix-release-verification.test.ts:331` asserts the installed `node_modules` equals the
  lockfile projection. It fails after any `npm install`; only `npm ci` satisfies it. It failed on
  this machine today for that reason.
- Fifteen tests skip on Windows and twenty-two skip without symlink privilege, so green on one host
  is not green on another. A documented EBUSY/handle-lag flake class remains mitigated, not
  eliminated (`test/helpers.ts:92-94`).

**Conflict surface.** `src/cli/index.ts` is 5,896 lines and `src/mcp/server.ts` 2,806. Every new
command and every new tool lands in one of these two files. Two agents working in parallel collide
there on almost every run.

**Working-tree state.** Eleven local and nineteen remote branches are unmerged, including three
abandoned release lines; a release worktree lives in `/private/tmp` (OS-reapable); a `site/` stash
with +493/−110 is stranded.

Attacks that failed (the tested-safe surface): release publishing is OIDC-only with the token
scrubbed and the publish job isolated from the source tree; `hunch-guard` bootstraps the checker from
the base branch so a PR cannot choose its own judge; the kill criterion is falsifiable and stated
identically in the roadmap and the design doc; the boundary ("never in the request path") is an
enforced contract invariant; naming deferral is consistent across every document.

## The critical path nobody can automate

Gate 5 of the pilot needs a live Sofia and a live engineering agent on David's environment (real
CRM, real subscription CLI). The roadmap dated it "the week of 2026-09-08". No number exists in this
repository. Every other item below can be done by an agent; this one cannot. Schedule it first.

*2026-09-12:* the single-user leg was run by an agent on the live environment (see the update
above). What remains human-only is narrower: the CRM configuration on the second machine for the
two-user week (a second participant, not a machine), and one approved CRM comment for the approval → receipt leg.

## The promotion ladder for the development loop

Each rung names what the agent may do, the gate that holds it there, and the measured criterion
that promotes it. Promotion is one human act per rung. Demotion is immediate on any tripwire.

| Rung | Agent may | Gate | Promote when |
|---|---|---|---|
| 0 — propose | read the queue, write a plan as a `proposed` decision with a topic | nothing is written outside `.hunch/` | the plan survives one human read without correction, five times |
| 1 — author | branch, implement under fable-mode, run `npm ci && npm test`, open a PR whose body carries `hunch_merge_verdict` and `hunch_pr_impact` output | required checks (`ci` ×2, `hunch-guard`, `platform-matrix-safety`) + one human review; the agent never approves or merges | twenty merged PRs with revert rate 0 and change-request rate under 20 % |
| 2 — auto-merge, bounded class | enable GitHub auto-merge on PRs in a declared class only: docs, tests, memory captures, generated locale copies (dependency bumps stay outside until a semantic lockfile check exists) | the class is the path allowlist in `tooling/merge-class.mjs` (`--base origin/main --require-bounded` exits 1 outside it); wiring it into `hunch-guard` and enabling auto-merge are human acts; anything outside it needs rung 1 | twenty class merges with zero reverts |
| 3 — auto-merge, general | auto-merge any PR that passes required checks and `hunch_merge_verdict` PASS (not WARN) | WARN or BLOCK verdicts always wait for a human | only after Gate 5 of the pilot has a number, and only if a second reviewer identity exists |
| never | publish to npm or the marketplace, activate a policy, delete a branch someone else pushed, edit `.github/workflows/` | environment protection rules with a required reviewer | — |

## Readiness checklist, in order

Human-only actions are marked. Everything else an agent can do from this checkout.

1. **Hygiene (agent, half a day).** Commit the in-flight work in this tree as one PR. Land the
   three stacked `feat(state)` PRs in order (#154 → #155 → #153) and the three small ones (#121,
   #152, #156); decide #108 and #122. Remove the `/private/tmp` release worktree, delete the five
   `archive/bench-*` branches and the three abandoned release branches, apply or drop the `site/`
   stash. Run `npm ci` before any test run and record the suite's wall-clock time in this file.
2. **Gates (human, one hour) — done 2026-09-09 except the second identity.** Make `ci` (Node 22 and 24), `hunch-guard` and
   `platform-matrix-safety` required status checks on `main`. Add a required reviewer to the
   `npm-publish` and `vscode-publish` environments. Create a second identity (a GitHub App or a
   bot account with minimum scope) for agent-authored PRs, so author and approver are never the
   same account and the local `repo`+`workflow` token stops being the agent's credential.
3. **Memory hygiene (agent, two hours) — done 2026-09-12; now standing (`con_039cee7367`).** Re-record the nine findings that cite deleted files with
   their true location (the Sofia repository) or mark them stale. Run `hunch wiki --heal --private`
   and `hunch adopt-drafts`. Triage the twenty overlay proposals: shipped ones become accepted or
   superseded; live ones are re-recorded publicly with a topic so `hunch now` becomes the work
   queue. Make `hunch drift` fail on finding-stale in CI, not only on anchor drift.
4. **Arm the shell on itself (agent, one hour; one human confirmation) — partly done: hook capabilities verified from runtime evidence (1.32.1), `.claude/pipeline/` removed (1.32.2); `ci` enforcement of the six constraints and semantic search remain.** Run
   `hunch integrations check --harness claude --probe --require mcp,context,edit-blocking` and fix
   until `verified`. Either wire `.claude/pipeline/` into settings or delete it. Move the six
   human-confirmed blocking constraints from `advisory_v1` to `ci` enforcement so the guard fails
   the commit, not only the PR comment. Turn semantic search on.
5. **The loop (agent, once the above is green).** A scheduled headless session with one fixed
   template: read `hunch now`, take the top proposal, `hunch_context` on it, branch, implement,
   verify, open the PR with the receipts in the body, stop. Never self-merge. One task per run.
6. **Measure and promote (human, weekly).** Per PR: reverted or not, change requests, CI red on
   first push, time to merge. Promote a rung only on the numbers in the table. Record each
   promotion as a decision with the numbers as evidence.

## What this does not decide

Whether to keep releasing daily. Twelve releases in six days were driven by live-pilot defects,
which is the right reason. An autonomous loop must not cut releases; tags stay a human act.
