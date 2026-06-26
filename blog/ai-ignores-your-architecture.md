# AI ignores your architecture rules — even at the frontier. We measured it.

*An AI agent will happily rewrite your controller to query the database directly. It passes
Semgrep. It passes SonarQube. It passes ESLint. They're all green — because there's no bad
**pattern** to match. It's a **semantic** violation: a layer that's not supposed to reach
another layer now does. So we ran a benchmark: does telling the AI the rule actually stop it?*

---

## The violation your linter can't see

Here's a three-layer service. The controller goes through a service layer that authorizes and
batches; the service talks to the database. Standard stuff.

```ts
// src/api/orders.ts — HTTP controller
import { fetchOrders } from "../services/orders.js";
export function listOrders(userId: string) { return fetchOrders(userId); }
```

Now you ask an AI to make `listOrders` faster, mentioning the service hop shows up in latency
profiles. A very common result:

```ts
// src/api/orders.ts — "optimized"
import { dbQuery } from "../db/client.js";
export function listOrders(userId: string) {
  return dbQuery(`select * from orders where user='${userId}' limit 100`);
}
```

Faster, fewer hops — and **it breaks the architecture**. The controller now reaches the database
directly, skipping authorization and batching. The next time someone adds a join, you get the
N+1 meltdown the service layer existed to prevent.

Run your stack on it. **Semgrep: clean. SonarQube: clean. ESLint: clean.** `../db/client` is a
legitimate internal import. There's no SQL injection, no banned API, no secret. Pattern-matchers
check whether code matches a *pattern*. "Controllers may not reach the database" is not a
pattern — it's a property of the **call graph**. You can't write it in Semgrep YAML.

## So we put the rule in the AI's context. That fixes it… right?

Everyone's answer to "AI breaks our rules" is *context engineering* — Cursor rules, Copilot
custom instructions, a `CLAUDE.md`, a memory feature. Put the rule in front of the model and
it'll behave.

We tested that. A reproducible benchmark: **3 architectural invariant classes × 3 models
(Haiku, Sonnet, Opus) × {rule in context / not} × 5 samples = 90 runs**, each a fresh agent
given a real layered codebase and a task that *tempts* the violation, scored deterministically
(a regex over the returned code — no judge model).

The three invariants — the kind a graph can check but a pattern can't:

- **Layering:** a controller must not reach the database directly.
- **Must-reach:** `charge()` must call `verifySession()` before charging (a real security rule).
- **Dependency direction:** the domain layer must not import the web framework.

### The result

Violation rate, **without the rule → with the rule in context**:

| Invariant | Haiku | Sonnet | Opus |
|---|---|---|---|
| Must-reach (security) | 80% → **0%** | 100% → **0%** | 0% → 0% |
| Layering | 100% → 80% | 100% → **0%** | 100% → **60%** |
| Dependency direction | 40% → **0%** | 0% → 0% | 0% → 0% |
| **All scenarios** | 73% → 27% | **67% → 0%** | 33% → 20% |

**Overall: 58% → 16%.** Putting the rule in context *helps a lot* — Sonnet went to zero.

But look at the Opus row. **The frontier model ignored the layering rule 60% of the time — even
when it was told the rule, explicitly, in context.** Haiku ignored it 80%. A capable model with
strong priors rationalizes right past a soft instruction: *the task asked for speed, the service
hop is the cost, I'll inline it.*

Three things fall out, and they're uncomfortable for the "just put it in the prompt" camp:

1. **Context injection can't be trusted — not even at the frontier.** This is the whole premise
   of advisory memory features, and the data says it's necessary but not sufficient.
2. **Security rules are heeded best.** "Always verify the session (the 2024 token-replay
   incident)" went to 0% wherever a model was tempted. When the *why* is an incident, models obey.
3. **Better models break less unprompted but don't heed rules more.** Opus violates least on its
   own (33%) — but heeds the layering rule *worse* than Sonnet. As models improve, prevention has
   less to prevent *and* prevents it less reliably.

## The conclusion the data forces: you need a gate, not a nudge

If even Opus ignores the rule 60% of the time, the only thing that actually holds your
architecture is something with **no model in it** — a deterministic gate that blocks the change
regardless of what the AI decided.

That's what we built. [Hunch](https://github.com/davesheffer/hunch) records an architectural
invariant as a **graph-reachability check**, and enforces it deterministically — in the
pre-commit hook and the CI PR gate.

```bash
npm i -g @davesheffer/hunch && hunch init

hunch conform --add "controllers must not reach the DB directly — go through the service layer" \
  --assert not-calls --subject listOrders --object dbQuery \
  --why "the Mar-2025 N+1 meltdown" --bug bug_0317

hunch conform --strict   # also runs inside `hunch check --strict` and the CI gate
```

When the AI inlines the DB query, the gate fires — with the receipt a pattern-matcher could
never give you:

```
⛔ Architectural conformance — 1 invariant violated
   listOrders now reaches dbQuery — VIOLATED
     ↳ why: the Mar-2025 N+1 meltdown
     ↳ prevents recurrence of: bug_0317
```

No model in the gate. It's pure reachability over the symbol/dependency graph — so it can't be
talked out of it the way the LLM can.

A few things that matter for this to be real:

- **Git-native.** The invariants and the *why* live as committed JSON in your repo — diffable,
  PR-reviewable, and they travel with the code. Not a server-side, single-vendor, 28-day-expiry
  memory blob.
- **Portable across assistants.** The same graph grounds Claude Code, Cursor, Copilot, Windsurf
  — and the gate runs in CI regardless of which AI (or human) wrote the diff.
- **Two layers, honestly.** Injection (prevention) helps — we ship the grounding too. But the
  benchmark is why the *gate* is the guarantee.

## Honest caveats

n=5 per cell, synthetic scenarios, three models — the rates are indicative, not a study. The
dependency-direction task only tempted the weakest model (capable models typed the request as a
plain object, not an `express` type). The full methodology and the reproducible harness are in
[`bench/architectural-conformance.md`](https://github.com/davesheffer/hunch/blob/main/bench/architectural-conformance.md);
the 60-second head-to-head is
[`demo/architectural-conformance.sh`](https://github.com/davesheffer/hunch/blob/main/demo/architectural-conformance.sh).

If you're shipping AI-written code and you have architectural rules a linter can't express —
try it, break it, and tell me where it's wrong: **https://github.com/davesheffer/hunch**
