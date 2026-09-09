# The autonomy ladder

Hunch never switches enforcement on. Every rung below is promoted by evidence and by one explicit
human act, and every rung can be walked back without losing history. This page lists the two
ladders as they exist in code today, with the gate at each promotion. Nothing here is aspirational;
each claim names the file that enforces it.

## Ladder 1 — firmness: how hard the edit hook holds the line

`src/core/config.ts` defines four levels. The hook reads the level at run time, so a change takes
effect without a restart.

| firmness | what the pre-edit hook does | what it never does |
|---|---|---|
| `off` | emits nothing | — |
| `advisory` (default) | injects the relevant decisions, invariants, and bug history before the edit | block |
| `firm` | advisory, plus an explicit warning when the edited file sits in a blocking invariant's scope | block |
| `strict` | firm, plus a DENY when the edit hits a blocking invariant, directly or through blast radius | block on its own failure |

Two facts keep the top rung honest:

- **The hook cannot block on failure.** Any error or unrecognized input emits nothing and exits 0
  (`src/core/hookpolicy.ts`, constraint `con_03a0b94b2e`). Strict mode denies edits, never sessions.
- **Only a vouched invariant can deny.** `isStrictBlocker` in `src/core/strictgate.ts` requires
  blocking severity, a non-stale record, and either provenance confidence of at least 0.8 or a
  human-confirmed source. A rejected-alternative tripwire denies only when the tripwire itself is
  human-confirmed (`isVetoBlocker`); a model's self-score is never a licence to fail a commit.

**The human act that arms blocking.** `hunch review --accept <decision-id>` promotes a decision to
human-confirmed and confirms its tripwires (`src/cli/index.ts`, `acceptDecision`). Until then the
same records are advisory: shown, cited, never enforced. `hunch status` prints how many invariants
are armed and nudges toward `hunch firmness strict` only when there is something to arm.

```bash
hunch firmness strict          # the teeth are on for vouched invariants only
hunch review --accept dec_…    # vouch for one decision and its tripwires
hunch status                   # armed count, firmness, and what is still waiting on a human
```

## Ladder 2 — policy lifecycle: how a rule earns authority

A Constitution policy moves through the states in `src/constitution/schema.ts`
(`PolicyStateSchema`). The forward path and its gates:

| state | how it gets there | who or what gates the promotion |
|---|---|---|
| `observed` | evidence normalized from corrections, failures, or committed instructions (`hunch constitution ingest`) | nothing is minted yet |
| `drafted` → `compiled` | the compiler produces a machine-checkable assertion; ambiguous evidence becomes `uncompilable` instead | deterministic compiler |
| `validating` → `proposed` | a proof is attached (`proposeProvedPolicy`, `src/constitution/lifecycle.ts`); the proof must show a clean current baseline (P1 or better) and match the policy's current semantics hash | evidence harness, no authority |
| `active_advisory` | `hunch policy accept <id> --advisory --actor human:<id>` | a human actor only; machine and model identities are refused (`requireHuman`) |
| `active_blocking` | `hunch policy accept <id> --blocking --actor human:<id>` | the same human act, plus a P3 or better proof, every known-bad fixture caught, every known-good fixture satisfied, no failed mutation receipts, no unresolved history dispositions (`blockingEvidenceError`) |

Blocking authority is re-checked at evaluation time, not only at approval. `blockingProofError`
runs on every blocking evaluation and demotes a policy whose proof no longer matches the evaluator
version, the mutation engine version, the parent/exception composition, or the policy hash. A
hand-edited lifecycle flag without a current proof is a configuration error, never authority.

The way back down keeps history:

- `hunch policy withdraw <id>` returns an advisory policy to `proposed`, authority back to the human pool.
- `hunch policy demote <id>` drops a blocking policy to advisory immediately.
- `hunch policy retire <id>` is terminal. Withdrawal and retirement are deliberately separate
  (decision `dec_2f5a3261a4`).
- `stale`, `repaired`, `superseded`, and `rejected` are the remaining exits; each is an audited event.

Some sources cannot climb at all yet. A correction policy compiled by the MD-1a materializer
carries a source-currentness activation gate; while that gate reports `blocked`,
`activationGateError` refuses activation even for a human (`docs/cookbook.md`, section 5). The
original correction constraint keeps guarding in the meantime.

## What counts as readiness

Promotion criteria are reports, not opinions. `hunch_constitution_g2_readiness` and
`hunch_constitution_g3_readiness` (`src/constitution/g2.ts`, `g3.ts`) return a content-hashed
report with the policy evidence, the blockers, and one of two recommendations: `not_ready` or
`eligible_for_human_*_signoff`. Both reports carry `authority: none` and a hard-coded
`g2_passed: false` / `g3_passed: false`. A report can make a human eligible to sign; it cannot sign.

## Reading the two ladders together

Firmness decides whether the hook may deny an edit at all. The policy lifecycle decides which
rules have earned the right to be the reason. A repository at `strict` firmness with no
human-confirmed invariants and no active blocking policy denies nothing. A repository at
`advisory` firmness with a fully proved `active_blocking` policy still denies nothing at edit time;
that policy surfaces in `pre_commit`, CI, MCP, and CLI checks instead (`approvePolicy` sets the
surfaces per mode). Both conditions must hold for an edit to be refused, and each was set by a
person on the record.
