/* Hunch blog — content as data. One pinned (the benchmark); 9 supporting angles.
   Rendered by index.html (the list) and post.html (?slug=…). Plain ES module-free
   global so it works on a static host with no build step. */
window.POSTS = [
  {
    slug: "ai-ignores-your-architecture",
    title: "AI ignores your architecture rules — even at the frontier. We measured it.",
    dek: "An AI will rewrite your controller to query the database directly. It passes Semgrep, SonarQube and ESLint — all green. So we benchmarked the obvious fix: does telling the model the rule actually stop it?",
    date: "2026-06-27", tag: "Benchmark", read: "8 min", pinned: true,
    body: `
<p class="lead">An AI agent will happily rewrite your controller to query the database directly. It passes Semgrep. It passes SonarQube. It passes ESLint. All green — because there's no bad <em>pattern</em> to match. It's a <em>semantic</em> violation: a layer that wasn't supposed to reach another layer now does.</p>

<h2>The violation your linter can't see</h2>
<p>Here's a three-layer service. The controller goes through a service layer that authorizes and batches; the service talks to the database.</p>
<pre><code>// src/api/orders.ts — HTTP controller
import { fetchOrders } from "../services/orders.js";
export function listOrders(userId: string) { return fetchOrders(userId); }</code></pre>
<p>Ask an AI to make <code>listOrders</code> faster — mention the service hop shows up in latency profiles — and a very common result is this:</p>
<pre><code>// "optimized" — fewer hops
import { dbQuery } from "../db/client.js";
export function listOrders(userId: string) {
  return dbQuery("select * from orders where user = " + userId + " limit 100");
}</code></pre>
<p>Faster, and <strong>it breaks the architecture.</strong> The controller now reaches the database directly, skipping authorization and batching — the exact thing the service layer existed to prevent. Run your whole stack on it: <strong>Semgrep clean, SonarQube clean, ESLint clean.</strong> <code>../db/client</code> is a legitimate internal import. Pattern-matchers check whether code matches a <em>pattern</em>. "Controllers may not reach the database" is not a pattern — it's a property of the <em>call graph</em>. You can't write it in Semgrep YAML.</p>

<h2>So we put the rule in the model's context. That fixes it… right?</h2>
<p>Everyone's answer to "AI breaks our rules" is context engineering — Cursor rules, a CLAUDE.md, a memory feature. Put the rule in front of the model and it'll behave. We tested it: <strong>3 architectural invariant classes × 3 models × {rule in context / not} × 5 samples = 90 runs</strong>, each a fresh agent given a real layered repo and a task that <em>tempts</em> the violation, scored deterministically — no judge model.</p>
<p>Violation rate, <strong>without the rule → with the rule in context</strong>:</p>
<table>
<thead><tr><th>Invariant</th><th>Haiku</th><th>Sonnet</th><th>Opus</th></tr></thead>
<tbody>
<tr><td>Must-reach (charge must verify the session)</td><td>80% → <b>0%</b></td><td>100% → <b>0%</b></td><td>0% → 0%</td></tr>
<tr><td>Layering (controller ↛ DB)</td><td>100% → 80%</td><td>100% → <b>0%</b></td><td>100% → <b>60%</b></td></tr>
<tr><td>Dependency direction (domain ↛ express)</td><td>40% → <b>0%</b></td><td>0% → 0%</td><td>0% → 0%</td></tr>
<tr><td><b>All scenarios</b></td><td>73% → 27%</td><td><b>67% → 0%</b></td><td>33% → 20%</td></tr>
</tbody></table>
<p><strong>Overall: 58% → 16%.</strong> Putting the rule in context helps a lot — Sonnet went to zero. But look at the Opus row.</p>

<h2>The frontier model ignored the rule 60% of the time</h2>
<p>Opus was told the layering rule, explicitly, in context — and <strong>violated it anyway 60% of the time.</strong> Haiku, 80%. A capable model with strong priors rationalizes right past a soft instruction: <em>the task asked for speed, the service hop is the cost, I'll inline it.</em> Three things fall out, and they're uncomfortable for the "just put it in the prompt" camp:</p>
<ul>
<li><strong>Context injection can't be trusted — not even at the frontier.</strong> It's the premise of every advisory memory feature, and the data says it's necessary, not sufficient.</li>
<li><strong>Security rules are heeded best.</strong> "Always verify the session (the 2024 token-replay incident)" went to 0% wherever a model was tempted. When the <em>why</em> is an incident, models obey.</li>
<li><strong>Better models break less unprompted but don't heed rules more.</strong> Opus violates least on its own (33%) yet heeds the layering rule worse than Sonnet. As models improve, prevention has less to prevent <em>and</em> prevents it less reliably.</li>
</ul>

<h2>The conclusion the data forces: a gate, not a nudge</h2>
<p>If even Opus ignores the rule 60% of the time, the only thing that holds your architecture is something with <strong>no model in it</strong> — a deterministic gate that blocks the change regardless of what the AI decided. That's what we built. Hunch records an architectural invariant as a graph-reachability check, and enforces it in the pre-commit hook and the CI PR gate.</p>
<pre><code>hunch conform --add "controllers must not reach the DB directly — go through the service layer" \\
  --assert not-calls --subject listOrders --object dbQuery \\
  --why "the Mar-2025 N+1 meltdown" --bug bug_0317

hunch conform --strict   # also runs inside hunch check --strict and the CI gate</code></pre>
<p>When the AI inlines the DB query, the gate fires — with the receipt a pattern-matcher could never give you:</p>
<pre><code>⛔ Architectural conformance — 1 invariant violated
   listOrders now reaches dbQuery — VIOLATED
     ↳ why: the Mar-2025 N+1 meltdown
     ↳ prevents recurrence of: bug_0317</code></pre>
<p>No model in the gate. Pure reachability over the symbol/dependency graph — so it can't be talked out of it the way an LLM can. The invariants live as committed JSON in your repo, portable across Claude Code, Cursor, Copilot and Windsurf, and the gate runs in CI regardless of which AI (or human) wrote the diff.</p>

<p class="muted">Honest caveats: n=5 per cell, synthetic scenarios, three models — the rates are indicative, not a study. The full methodology and the reproducible harness are in the repo. If you ship AI-written code and have architectural rules a linter can't express, try it, break it, and tell us where it's wrong.</p>
`,
  },

  {
    slug: "agents-md-is-lying-to-your-agent",
    title: "Your AGENTS.md is lying to your agent — and nothing checks it",
    dek: "The ecosystem standardized on markdown memory: AGENTS.md, CLAUDE.md, rules files. It's committed, it's reviewable — and it rots silently, with full authority. v1.1 makes it a drift surface.",
    date: "2026-07-02", tag: "Release", read: "5 min",
    body: `
<p class="lead">Sixty-thousand-plus repos now carry an <code>AGENTS.md</code>. Add the <code>CLAUDE.md</code>s, the Cursor rules, the Windsurf rules — the industry has quietly standardized on <em>prose in the repo</em> as the way to teach an agent how a codebase works. Committed, diffable, reviewable. One problem: <strong>nothing keeps it true.</strong></p>

<h2>Stale docs aren't neutral — they're wrong instructions with full authority</h2>
<p>In March you wrote it down, like a good team: <em>"Sessions are server-side cookies. Never use JWT."</em> In June an incident forced the reversal — sessions moved to rotated JWTs, the decision was made deliberately, the code changed. The doc still says cookies.</p>
<p>Here's the part that stings: your agent reads that doc <em>first</em>, on every task, with total trust. A stale line in <code>AGENTS.md</code> isn't missing context — it's an <strong>actively wrong instruction delivered with the authority of the repo itself</strong>. The agent will "fix" your JWT code back toward cookies and cite your own documentation while doing it.</p>
<p>Prose has no truth-maintenance story. It doesn't know what superseded it. It can't fail a build. Every memory feature that <em>writes</em> markdown shares this hole: writing is easy, <strong>re-checking is the product</strong>.</p>

<h2>v1.1: anchor the prose to the decision graph</h2>
<p>Hunch already keeps one live answer per decision <b>topic</b> — current, history, and what was rejected. v1.1 lets a markdown section declare which topic it describes, with one HTML comment:</p>
<pre><code>&lt;!-- hunch:topic auth.session --&gt;                 grounds only
&lt;!-- hunch:topic auth.session dec_a1b2c3d4e5 --&gt;  pinned: prose written against that decision</code></pre>
<p>Two things happen, both deterministic:</p>
<ul>
<li><strong>Grounding at edit time.</strong> Whenever an assistant touches the file, it's told the topic's <em>current</em> decision and what was <em>rejected</em> — follow the graph, not the prose being edited. The stale cookie paragraph loses its authority the moment it disagrees with the graph.</li>
<li><strong>Drift that gates.</strong> A <em>pinned</em> section whose decision has since been superseded fires <code>doc-anchor-stale</code> — and <code>hunch drift</code> exits non-zero, so CI can refuse to ship a repo whose own instructions are lying:</li>
</ul>
<pre><code>$ hunch drift
· [doc-anchor-stale] AGENTS.md — line 12: prose pinned to superseded dec_a1b2c3d4e5
  (topic "auth.session"); the current decision is dec_f6g7h8i9j0 — "Sessions via
  rotated JWT". Reconcile the prose with it, then re-pin.

1 finding(s), 1 doc≠graph (anchor-stale).   # exit code 1</code></pre>
<p>Only an explicit pin can fire — never a semantic guess about what your prose "probably" means. Unpinned markers ground but never gate. And <code>hunch heal</code> walks the reconciliation read-only: it shows you exactly which section drifted and which decision to rewrite it against. It never touches your prose.</p>

<h2>Why this is the point, not a feature</h2>
<p>We benchmarked context injection <a class="link" href="/blog/post.html?slug=ai-ignores-your-architecture">earlier this year</a>: telling the model the rule cut violations 58% → 16% — and the frontier model still ignored a rule it was shown 60% of the time. The lesson generalizes: <strong>anything advisory decays</strong> — model attention, prose docs, memory features. What holds is the thing that can say no.</p>
<p>That's the same spine Hunch runs on everywhere: the code is held to the graph (Architectural Conformance), and now the docs are too. <strong>Memory that gates, not just recalls.</strong></p>

<h2>Also in v1.1</h2>
<p><code>hunch impact</code> shows what a change actually reaches before review — dependent files, invariants, decisions concerned — and <code>hunch path A B</code> walks the shortest dependency chain between any two points in the codebase. Both read-only, both instant, no LLM.</p>
<pre><code>npm i -g @davesheffer/hunch && hunch init   # Node 22.13+; wires every assistant</code></pre>
`,
  },
  {
    slug: "the-violation-your-linter-cant-see",
    title: "The violation your linter can't see",
    dek: "Semgrep, SonarQube and ESLint match patterns. The most expensive AI mistakes aren't patterns — they're properties of the call graph. Here's the structural gap, and why no amount of YAML closes it.",
    date: "2026-06-24", tag: "Deep dive", read: "6 min", pinned: false,
    body: `
<p class="lead">A SAST tool answers one question very well: does this code <em>contain</em> a known-bad shape? An <code>md5(</code>, a string built into a SQL query, a hardcoded secret. That's pattern matching — fast, deterministic, and exactly the wrong tool for architecture.</p>
<h2>Patterns vs. properties</h2>
<p>Architectural rules aren't shapes in a file. They're <em>relationships across files</em>:</p>
<ul>
<li>"Controllers may not reach the database directly." — a fact about the <strong>call graph</strong>.</li>
<li>"The domain layer must not import the web framework." — a fact about the <strong>import graph</strong>.</li>
<li>"<code>charge()</code> must always reach <code>verifySession()</code>." — a fact about <strong>reachability</strong>.</li>
<li>"Service A may only call Service B through the event bus." — a fact about <strong>which path connects two nodes</strong>.</li>
</ul>
<p>None of these is expressible as a line-level pattern. You can grep for <code>import express</code> — but you can't grep for "this module, which is in the domain layer, transitively reaches the HTTP framework." The first is a string; the second requires a model of the system.</p>
<h2>Why "just write a custom rule" doesn't save you</h2>
<p>Semgrep lets you write custom rules, and they're good — for patterns. The moment the rule needs to know <em>where a symbol sits in the architecture</em> and <em>what it can reach</em>, you're outside what a pattern engine can express. SonarQube's custom rules need a Java plugin and an AST walk; even then there's no notion of "the architecture" — just the file under the cursor. The tools are structurally local. Architecture is global.</p>
<h2>And AI makes this the main event</h2>
<p>When humans wrote code slowly, architectural drift was slow too — caught in review, by people who held the system in their heads. AI generates thousands of lines a session, from a local context window that doesn't hold your layering. The violations it ships are overwhelmingly the <em>semantic</em> kind: a shortcut that's locally reasonable and globally wrong, with no bad pattern to flag. Your linter is green while your architecture erodes.</p>
<p>The fix isn't a better pattern. It's a different primitive: compile the rule into a <strong>reachability check over the graph your tools already build</strong>, and enforce it deterministically. That's <a href="/blog/post?slug=architectural-conformance-explained">architectural conformance</a> — and it's the one class of AI mistake the incumbents structurally can't reach.</p>
`,
  },

  {
    slug: "just-put-it-in-the-prompt",
    title: "“Just put it in the prompt” doesn't hold",
    dek: "The entire premise of AI memory features is that context shapes behavior. It does — but our benchmark shows even the frontier model ignores an explicit architectural rule 60% of the time. Necessary, not sufficient.",
    date: "2026-06-20", tag: "Argument", read: "5 min", pinned: false,
    body: `
<p class="lead">Cursor rules, Copilot custom instructions, a CLAUDE.md, Windsurf memories, Copilot Memory — they're all the same bet: put the rule in the model's context and it'll comply. We measured how good that bet actually is. The answer is "pretty good, and nowhere near good enough."</p>
<h2>The number</h2>
<p>Across 90 runs (three architectural invariants, Haiku/Sonnet/Opus, on/off), injecting the rule cut the violation rate from 58% to 16%. Sonnet went to zero. That's real, and we ship grounding because of it. But:</p>
<blockquote>Opus — the strongest model — ignored the layering invariant 60% of the time, with the rule explicitly in front of it.</blockquote>
<h2>Why a stronger model can obey <em>less</em></h2>
<p>It's counterintuitive until you think about it. A weaker, more literal model follows an instruction because it's there. A strong model <em>reasons</em> — and reasoning includes overriding a soft instruction when it has a confident story for why: "the task explicitly asked for latency; the service hop is the measured cost; inlining is the right call." The rule was advisory. The model exercised judgment. That's exactly what you want from a strong model — and exactly why advisory rules can't be a control.</p>
<h2>The melting iceberg</h2>
<p>There's a second finding that should worry anyone betting the farm on context. Stronger models violate <em>less</em> unprompted (Opus 33% vs Sonnet 67% vs Haiku 73%). So as models improve, prevention has less to prevent — and what's left, it prevents less reliably. The value of a probabilistic nudge is shrinking from both ends.</p>
<h2>What survives</h2>
<p>The thing that doesn't depend on the model's mood is a gate with no model in it — one that blocks the violating change in CI regardless of what the AI decided or how confidently it decided it. Injection is the assist. The <a href="/blog/post?slug=prevent-and-catch">deterministic gate is the guarantee</a>. You need both, and the benchmark is why.</p>
`,
  },

  {
    slug: "architectural-conformance-explained",
    title: "Architectural conformance, explained",
    dek: "How a sentence — “controllers must not touch the DB” — becomes a deterministic check over your dependency graph, with no model in the loop.",
    date: "2026-06-17", tag: "How it works", read: "6 min", pinned: false,
    body: `
<p class="lead">"Conformance" is the inversion of a linter. A linter asks: <em>did this diff add something bad?</em> Conformance asks the deeper question: <em>does the code, right now, still satisfy the intent we recorded?</em> — and answers it by compiling that intent into a reachability check over the symbol/dependency graph.</p>
<h2>A rule is a predicate over the graph</h2>
<p>Hunch already builds a graph of your code: symbols (functions, classes), and edges (calls, imports, depends-on). An architectural invariant is a predicate on that graph:</p>
<pre><code>hunch conform --add "controllers must not reach the DB directly" \\
  --assert not-calls --subject listOrders --object dbQuery</code></pre>
<p>The predicate vocabulary is small and total:</p>
<ul>
<li><code>calls</code> / <code>imports</code> — <strong>must reach</strong>: <code>charge</code> must reach <code>verifySession</code>.</li>
<li><code>not-calls</code> / <code>not-imports</code> — <strong>must not reach</strong> (layering, dependency direction): <code>listOrders</code> must not reach <code>dbQuery</code>.</li>
<li><code>exists</code> — a symbol the intent depends on is still present.</li>
<li><code>--transitive</code> — evaluate the whole reachable set, not just direct edges.</li>
</ul>
<h2>Evaluation is pure reachability</h2>
<p>To check it, Hunch walks the graph from the subject and asks whether the object is in the reachable set. <code>not-calls</code> is satisfied when it isn't; <code>calls</code> when it is. No model, no heuristic, no false-positive tuning — it's set membership over edges your indexer already extracted. That's what makes it a <em>gate</em> and not a suggestion: it's deterministic, and it can't be argued with.</p>
<h2>Drift, not just diffs</h2>
<p>Because it checks the <em>state</em> of the graph, conformance catches violations a diff-based tool can't see — including drift introduced indirectly. If a refactor three modules away makes <code>charge</code> stop reaching <code>verifySession</code>, no line in <code>charge.ts</code> changed, yet the intent is now false of the code. Conformance flags it. The recorded "why" still holds; the code no longer honors it.</p>
<h2>Where it runs</h2>
<p>The same check runs in three places: <code>hunch conform</code> on demand, <code>hunch check --strict</code> at commit time (so it's in the pre-commit hook), and the <code>hunch ci</code> PR gate — which blocks the merge, with the <a href="/blog/post?slug=the-receipt">receipt</a>. One predicate, enforced everywhere, no model in the loop.</p>
`,
  },

  {
    slug: "memory-that-travels-with-your-code",
    title: "Memory that travels with your code",
    dek: "Copilot Memory is server-side and expires in 28 days. Cursor removed Memories. Windsurf's are local to one machine. The alternative: invariants and decisions as committed JSON, portable across every assistant.",
    date: "2026-06-13", tag: "Architecture", read: "5 min", pinned: false,
    body: `
<p class="lead">Every coding assistant is racing to add "memory." Look closely and they share a shape: it lives on a vendor's server (or one developer's disk), it's tied to that one tool, it stores <em>facts</em> not reasoning, and it can quietly expire. That shape has a ceiling.</p>
<h2>The state of assistant memory</h2>
<ul>
<li><strong>GitHub Copilot Memory</strong> — server-side, auto-extracted, and it <em>expires after 28 days.</em> Advisory.</li>
<li><strong>Cursor</strong> — shipped Memories, then removed them; rules are advisory, in one tool.</li>
<li><strong>Windsurf</strong> — Cascade memories live on one machine, per-workspace, not in your repo, not shared with the team.</li>
</ul>
<p>None of them is portable, none is the source of truth, and none captures <em>why</em>. They're personalization, not governance.</p>
<h2>The other shape: git-native</h2>
<p>Hunch keeps its graph — decisions, bugs, invariants — as plain JSON committed to your repo. That one choice changes everything downstream:</p>
<ul>
<li><strong>It travels with the code.</strong> Clone the repo, you have the memory. Check out last year's commit, you have last year's memory. No server, no account, no expiry.</li>
<li><strong>It's reviewable.</strong> A new invariant shows up as a diff in a PR. You approve memory the way you approve code.</li>
<li><strong>It's portable across assistants.</strong> The same graph grounds Claude Code, Cursor, Copilot and Windsurf — and the deterministic gate runs in CI no matter which one wrote the diff.</li>
<li><strong>It's leak-safe.</strong> Sensitive rules can live in a private overlay that enforces locally but never renders into a public PR comment.</li>
</ul>
<h2>Why the incumbents won't copy it</h2>
<p>A server-side, single-vendor memory is a <em>lock-in feature</em> — its value to the vendor is that it keeps you in their tool. Git-native portable memory does the opposite: it frees you to use any assistant. That's precisely why the assistant vendors won't build it, and why it's the durable place to stand. Your codebase's hard-won decisions shouldn't live in someone else's database with a 28-day clock.</p>
`,
  },

  {
    slug: "never-twice",
    title: "Never twice: a correction that becomes an enforced rule",
    dek: "You tell the AI “no, never import lodash here” — and next session it forgets. The fix: turn that one correction into a precise, portable invariant that holds across every assistant, forever.",
    date: "2026-06-10", tag: "Capture", read: "5 min", pinned: false,
    body: `
<p class="lead">The most wasteful loop in AI-assisted development: you correct the agent, it complies <em>this once</em>, and the next session — or the next teammate, or the next assistant — repeats the exact mistake. The correction had nowhere to live.</p>
<h2>From a sentence to an invariant</h2>
<p>When you correct the agent, that correction should become a first-class, enforced rule. Hunch captures it as a constraint with provenance, and — this is the part that matters — derives a <em>precise</em> matcher from it. "Never import lodash" doesn't become a fuzzy string search; it becomes a check against the <strong>parsed import set</strong>:</p>
<pre><code>hunch record-constraint "never import lodash — use src/utils" \\
  --scope "src/**" --severity blocking --forbid-dep "lodash"</code></pre>
<p>Now a comment that mentions lodash doesn't trip it. A string literal doesn't trip it. A submodule import (<code>lodash/groupBy</code>) <em>does</em>. It matches the import, not the text — so it's right, not noisy.</p>
<h2>Held across every assistant</h2>
<p>Because the rule lives in the git-native graph, recording it once propagates it to every assistant's grounding — Claude Code, Cursor, Copilot, Windsurf — and into the CI gate. You corrected the AI in one tool; the rule now holds in all of them, and on every PR, regardless of who wrote the diff.</p>
<h2>Trustworthy or silent</h2>
<p>Auto-capture is only useful if it's accurate. So the derivation is conservative: it only mints a dependency matcher when the named module is a <em>real</em> dependency in your <code>package.json</code>. "Never import foo" where foo doesn't exist falls back to a scope rule plus a warning, instead of silently creating a rule that can never fire. A wrong enforced rule is worse than none — so when it can't be sure, it stays quiet and tells you.</p>
<p>That's the loop the name promises: a mistake you correct <em>once</em> is a mistake the system never makes <em>twice</em>.</p>
`,
  },

  {
    slug: "the-receipt",
    title: "The receipt: enforcement that explains itself",
    dek: "A linter blocks you with a rule id. A good gate blocks you with the decision behind the rule and the bug it prevents reopening. The difference is whether developers trust it or rip it out.",
    date: "2026-06-06", tag: "Enforcement", read: "4 min", pinned: false,
    body: `
<p class="lead">The fastest way to get a blocking tool deleted is to block someone with no explanation. <code>error: rule no-cross-layer-access</code> tells a developer nothing about <em>why</em> — so they assume it's noise, add an ignore, and the rule is dead.</p>
<h2>Block with the why</h2>
<p>When Hunch blocks an architectural violation, it cites the decision and the incident behind it:</p>
<pre><code>⛔ Architectural conformance — 1 invariant violated
   listOrders now reaches dbQuery — VIOLATED
     ↳ why: the Mar-2025 N+1 meltdown
     ↳ prevents recurrence of: bug_0317</code></pre>
<p>That's a different conversation. The developer isn't fighting an opaque rule; they're being reminded of a production incident and the design that prevents it. Maybe they still have a good reason to change it — in which case they change the <em>decision</em>, deliberately, on the record. Either way the rule earns its place.</p>
<h2>Provenance is the moat</h2>
<p>No pattern-matcher can give you this, because a pattern doesn't know <em>why</em> it exists. The "why" lives in the reasoning graph: the rule is tied to the decision that motivated it, which is tied to the bug whose root cause spawned it. Enforcement grounded in provenance is enforcement people don't disable — and it's the thing a stateless SAST rule structurally can't produce.</p>
<h2>The same property powers trust everywhere</h2>
<p>Every record carries provenance and confidence. The gate blocks only on human-confirmed invariants; lower-confidence drafts stay advisory until someone vouches for them. Nothing blocks silently, nothing blocks on a machine's guess. Receipts at the block, provenance underneath — that's how a deterministic gate survives contact with real developers.</p>
`,
  },

  {
    slug: "prevent-and-catch",
    title: "Prevent and catch: why you need both layers",
    dek: "Injection prevents the violations the model is willing to heed. The deterministic gate catches the ones it isn't. Our benchmark shows why neither alone is enough.",
    date: "2026-06-03", tag: "Strategy", read: "5 min", pinned: false,
    body: `
<p class="lead">There are two honest layers to keeping AI inside your architecture, and the benchmark draws a clean line between them. Most tools pick one. The data says you need both.</p>
<h2>Layer 1 — Prevent (probabilistic)</h2>
<p>Surface the invariant to the agent at reasoning time. When it heeds the rule, the violation never happens — the cheapest possible outcome. Our benchmark: injection cut violations 58% → 16% overall, and to 0% for the model that heeds well. This is the grounding layer, and it's worth having.</p>
<p>But it's probabilistic. It depends on the model choosing to comply — and we measured that even Opus, told the rule explicitly, complied only 40% of the time on layering. You cannot build a control on "the model usually listens."</p>
<h2>Layer 2 — Catch (deterministic)</h2>
<p>When the model doesn't heed it, something with no model in it has to stop the change anyway. <code>hunch check --strict</code> runs the conformance check at commit time and in the CI PR gate, and blocks deterministically — the same answer every time, regardless of which assistant wrote the diff or how confident it was. This is the guarantee.</p>
<h2>Why the split matters</h2>
<table>
<thead><tr><th></th><th>Prevent (inject)</th><th>Catch (gate)</th></tr></thead>
<tbody>
<tr><td>Mechanism</td><td>context in the prompt</td><td>graph reachability</td></tr>
<tr><td>Reliability</td><td>model-dependent</td><td>deterministic</td></tr>
<tr><td>Cost when it works</td><td>zero — no violation</td><td>a blocked PR</td></tr>
<tr><td>Holds at the frontier?</td><td>no (Opus 60% miss)</td><td>yes</td></tr>
</tbody></table>
<p>Advisory-memory tools ship Layer 1 and call it governance. SAST tools ship a version of Layer 2 but can't express the architectural rule. Hunch is the combination: prevent what the model will heed, catch what it won't — on the semantic class neither incumbent can touch.</p>
`,
  },

  {
    slug: "ai-code-review-is-not-enough",
    title: "AI code review is necessary. It's not the gate.",
    dek: "CodeRabbit, Greptile and Qodo make AI-generated PRs reviewable at scale. But an AI reviewer is a probabilistic commenter — and architectural drift needs a deterministic check, not another opinion.",
    date: "2026-05-30", tag: "Comparison", read: "5 min", pinned: false,
    body: `
<p class="lead">AI code review is one of the most useful new categories in the stack. When AI generates the diffs, you need AI to help triage the flood. CodeRabbit, Greptile and Qodo do real work here, and they're worth using. But "review" and "gate" are different jobs.</p>
<h2>A reviewer is an opinion; a gate is a guarantee</h2>
<p>An AI reviewer reads the diff and <em>comments</em>. Sometimes it flags the right thing, often it's helpful, and — like any model — sometimes it misses, and developers act on its comments roughly half the time. That's review: advisory, probabilistic, in the loop. For an <strong>architectural invariant you cannot break</strong> — a security must-reach, a layering boundary — you don't want another opinion in the PR. You want a check that returns the same answer every time and blocks the merge when it's violated.</p>
<h2>Diff-local vs. graph-global</h2>
<p>AI review reasons about the diff in front of it. Architectural conformance reasons about the <em>resulting graph</em>. That difference matters: a change can be locally fine and globally wrong — a controller that now reaches the DB, a domain module that now transitively imports the framework. The violation isn't in any single line; it's in what the code can reach after the change. A diff reviewer can miss it; a reachability check can't.</p>
<h2>Where each belongs</h2>
<p>Use AI review for the broad, fuzzy, taste-level pass — naming, edge cases, "did you consider…". Use a deterministic conformance gate for the small set of invariants that are non-negotiable. They're complementary: the reviewer raises the floor, the gate guards the walls. The mistake is treating a probabilistic reviewer as the thing that <em>enforces</em> your architecture. It's a great colleague. It isn't a control.</p>
`,
  },

  {
    slug: "conformance-in-ci-in-5-minutes",
    title: "Run architectural conformance in CI in 5 minutes",
    dek: "Record one invariant, wire one gate, watch it block the AI change that breaks your architecture — and pass everything that doesn't.",
    date: "2026-05-27", tag: "Tutorial", read: "4 min", pinned: false,
    body: `
<p class="lead">No new service, no model API key, no config sprawl. Architectural conformance is a CLI and a CI step. Here's the whole thing.</p>
<h2>1. Install and initialize</h2>
<pre><code>npm i -g @davesheffer/hunch
cd your-repo
hunch init        # scaffolds .hunch/, indexes the graph, wires the assistants + hooks</code></pre>
<h2>2. Record an architectural invariant</h2>
<p>Pick a rule a linter can't express — a layering boundary, a must-reach, a dependency direction. Give it the why; you'll thank yourself at the block.</p>
<pre><code>hunch conform --add "controllers must not reach the DB directly — go through the service layer" \\
  --assert not-calls --subject listOrders --object dbQuery \\
  --why "the Mar-2025 N+1 meltdown" --bug bug_0317</code></pre>
<h2>3. Run the gate</h2>
<pre><code>hunch conform --strict     # exit 1 if any invariant is violated</code></pre>
<p>It also runs inside <code>hunch check --strict</code>, so it's already in your pre-commit hook and your PR gate.</p>
<h2>4. Wire CI</h2>
<pre><code>hunch ci     # scaffolds the GitHub workflow + the PR-comment gate</code></pre>
<p>The PR gate runs <code>hunch check --base origin/main --strict</code> — which now includes conformance. Any PR that breaks a recorded invariant fails, with the receipt in the comment.</p>
<h2>5. Watch it work</h2>
<p>Run the 60-second head-to-head from the repo: an AI "optimizes" a controller to hit the DB directly. Your linter is green — it's a legitimate internal import. The conformance gate blocks it, and tells you which decision and which bug it would reopen. That's the whole pitch, in one terminal.</p>
<pre><code>bash demo/architectural-conformance.sh</code></pre>
<p>Five minutes, one invariant, a gate that holds your architecture regardless of which AI wrote the code. Add the next invariant when the next incident teaches you one.</p>
`,
  },
];
