# Launch copy — paste-ready

Canonical post: `blog/ai-ignores-your-architecture.md`. Publish it on your own domain first
(e.g. hunch-pi.vercel.app/blog), then point everything below at that URL. Lead with the
**finding**, not the tool. Best window: Tue–Thu, ~8–10am ET. Be in the comments for the first
2–3 hours — that's what decides HN/Reddit.

---

## 1. Hacker News  →  https://news.ycombinator.com/submit

**Option A — Show HN (recommended; links to the repo):**

> Title: `Show HN: Hunch – block the AI architecture violations your linter can't see`
> URL: `https://github.com/davesheffer/hunch`

**Option B — link the blog post:**

> Title: `AI ignores your architecture rules even at the frontier – we measured it (Opus: 60%)`
> URL: `<your blog URL>`

**First comment (post immediately after submitting, either option):**

> Author here. The thing that kicked this off: an AI "optimizing" a controller to query the DB
> directly. It passes Semgrep/SonarQube/ESLint clean — there's no bad *pattern*, it's a *semantic*
> violation (a layer reaching a layer it shouldn't). You can't express "controllers may not reach
> the DB" in Semgrep YAML; it's a property of the call graph.
>
> So I benchmarked the obvious fix — put the rule in the model's context. 90 runs, 3 invariant
> classes, Haiku/Sonnet/Opus, on/off. It helps a lot (58%→16% overall; Sonnet 67%→0%), but the
> finding that surprised me: **Opus ignored the layering rule 60% of the time even when told.**
> Context injection is necessary-not-sufficient — which is the case for a deterministic gate with
> no model in it.
>
> Hunch records the invariant as a graph-reachability check and enforces it in the pre-commit hook
> + CI, with a receipt (the decision + the bug it prevents). It's git-native (the rules live as
> committed JSON, portable across assistants), no model in the gate.
>
> Honest caveats: n=5/cell, synthetic scenarios, the dep-direction task only tempted the weak
> model. Harness + methodology are in the repo. Would genuinely like to be told where the
> reachability approach breaks.

---

## 2. Reddit

**r/ExperiencedDevs** (best fit — the architecture-governance crowd)  →  https://www.reddit.com/r/ExperiencedDevs/submit

> Title: `We measured whether AI follows architectural rules. Even Opus ignored "controllers can't touch the DB" 60% of the time.`
> Body: a 2–3 paragraph version of the blog (the violation that passes every linter → the
> benchmark table → "prevention isn't enough, you need a deterministic gate"), then the repo link
> at the end. Frame it as a finding to discuss, not a product. Reddit punishes ads; lead with the
> data and engage every comment.

Also worth it, same post adapted: **r/programming**, **r/devops**. (Skip language subs unless you
tailor the example to that language.)

---

## 3. X / Twitter  (thread; attach the benchmark table as an image)

> 1/ An AI agent will rewrite your controller to hit the DB directly. It passes Semgrep,
> SonarQube, ESLint — all green. There's no bad *pattern*. It's a *semantic* violation a
> pattern-matcher structurally can't see. So we measured the fix everyone reaches for. 🧵
>
> 2/ "Just put the rule in the model's context." We benchmarked it: 3 architectural invariant
> classes × Haiku/Sonnet/Opus × on/off × 5, scored deterministically. [attach table image]
>
> 3/ It helps — 58%→16% overall, Sonnet 67%→0%. But the kicker: **Opus ignored the layering rule
> 60% of the time even when told.** Context injection is necessary, not sufficient. Even at the
> frontier.
>
> 4/ So the only thing that holds your architecture is a gate with no model in it. We built it —
> the invariant compiles to a graph-reachability check, enforced in pre-commit + CI, with a
> receipt (the decision + the bug it prevents). Git-native, portable across assistants.
>
> 5/ Try it / break it: github.com/davesheffer/hunch · methodology + harness in the repo. Tell me
> where reachability falls short.

---

## 4. LinkedIn  (the staff-eng / eng-leader / AppSec buyer is here)

> We tested whether AI coding agents follow a team's architectural rules — the ones a linter can't
> express ("controllers must not reach the database directly", "charge must verify the session").
>
> 90 runs across Haiku, Sonnet, and Opus. Putting the rule in the model's context cut violations
> 58% → 16%. But the result worth sitting with: even Opus, told the rule explicitly, ignored it
> 60% of the time on the layering case.
>
> The takeaway for anyone shipping AI-generated code: prevention via prompts/memory helps, but it
> is not a control. The only thing that holds is a deterministic gate — no model in it — that
> blocks the change in CI regardless of what the AI decided. Full data + the open-source tool in
> the comments.

(Put the link in the first comment, not the post — LinkedIn throttles posts with outbound links.)

---

## 5. Syndicate + niche (canonical link back to your blog)

- **dev.to** and **Hashnode** — cross-post the full blog; set the canonical URL to your site.
- **Lobsters** (if you have an invite) — link the blog; tag `ai`, `practices`.
- **Newsletters — pitch the blog URL:** TLDR, Console.dev, The Changelog, Bytes (JS), Pointer.
  One pickup ≈ a HN front page in steady reach.
- **MCP ecosystem** — submit Hunch to `awesome-mcp-servers` and post in the MCP community; you're
  MCP-native and that's an exactly-targeted audience already wiring up AI assistants.
- **AI-coding tool communities** — Cursor / Claude Code / Continue Discords & forums, where the
  rules allow. Your pitch ("hold every assistant to your architecture from one git-native graph")
  lands hardest with people running 2–3 of them.

---

## The one thing that decides it

Most launches get crickets — the hook is the whole game, and yours is good: *a reproducible
benchmark showing AI ignores architecture rules even at the frontier, plus the deterministic gate
that catches it.* Lead with the data, make the table a shareable image, end with the 3-line
`hunch conform --add` and the demo. If HN or r/ExperiencedDevs bite, the rest follows.
