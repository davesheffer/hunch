/* Hunch blog — content as data. One pinned (the benchmark); 9 supporting angles.
   Rendered by index.html (the list) and post.html (?slug=…). Plain ES module-free
   global so it works on a static host with no build step. */
window.POSTS = [
  {
    slug: "change-gate-private-workflows",
    title: "Hunch 1.5: give every code change a memory — before it ships",
    dek: "The new Change Gate brings the same deterministic pre-flight to the CLI, MCP, and VS Code. Private overlays keep sensitive reasoning local. One workflow, whichever agent is writing the code.",
    date: "2026-07-09", tag: "Release", read: "7 min", pinned: true,
    cover: {
      src: "/assets/change-gate-release.png",
      alt: "A luminous green safe path crosses a dark dependency graph and passes through a precise red architectural gate."
    },
    body: `
<p class="lead">AI is fast enough to make a locally sensible change before anyone has asked the one question that matters: <strong>what does this codebase already know about this part of the system?</strong> Hunch 1.5 puts that question directly in the working loop — before the edit, at review, and before a commit can leave the machine.</p>

<h2>One pre-flight, wherever the change starts</h2>
<p>The new <strong>Change Gate</strong> is a focused pre-flight: select a working diff or target, see the decisions, constraints, blast radius, and relevant bug history, then choose the next move with the receipt in view. It is available from the CLI, MCP, and VS Code instead of being a ritual tied to one assistant.</p>
<p>That distinction matters. Your architecture is not a Claude rule, a Cursor setting, or a Copilot prompt. The decision graph lives with the repository; the gate asks the same question no matter which tool — or person — produced the change.</p>
<pre><code># inspect the current work before a commit
hunch check --working --strict --blast

# use the same graph through your MCP client or the VS Code Change Gate</code></pre>

<h2>A gate is not a prompt</h2>
<p>Context helps. But a remembered rule is still advisory until the workflow can test it. Hunch turns the durable parts of engineering judgment into deterministic checks: a forbidden dependency stays forbidden, a controller cannot cross into the database layer, and a critical call path continues to reach the verification it needs.</p>
<p>The point is not to make a model less creative. It is to let it move quickly inside boundaries that are explicit, reviewable, and explainable when they fire.</p>

<h2>Private means a separate home, not a label</h2>
<p>A lot of the most valuable engineering context is not ready for a public repository: a production incident, a customer-specific rule, a security investigation, or an unfinished migration plan. In private-overlay mode, those records live in a separate local store. The local workflow can read them and enforce them; the public graph and public CI do not receive them.</p>
<figure class="inline-art">
  <img src="/assets/private-overlay-release.png" alt="Nested translucent layers protect a private local vault while a separate code graph continues outside." loading="lazy" />
  <figcaption>One repository workflow; a clear boundary between shared memory and local-only reasoning.</figcaption>
</figure>
<p>Explicit private capture uses deterministic local synthesis, and private review actions stay in the overlay. The CI workflow is configured public-only. That makes the privacy boundary operational, not a promise hidden in a settings panel.</p>

<h2>Make the next correction durable</h2>
<p>When a review catches a real mistake, record the why once: a decision, a bug, or a constraint. Hunch carries that evidence forward to the next relevant change and can enforce the parts that are precise enough to test. The goal is modest but consequential: do not pay for the same lesson twice.</p>
<pre><code>npm i -g @davesheffer/hunch
cd your-repo
hunch init

# begin advisory; make a constraint strict only when it has earned trust</code></pre>

<h2>The workflow stays yours</h2>
<p>Hunch remains git-native, MCP-native, and agent-agnostic. Use it with VS Code, a terminal, or any MCP-capable assistant. Keep shared truth in the repository. Keep private truth in the overlay you control. Let deterministic checks decide what must hold — not whichever model happens to be in the editor today.</p>
`,
  },
  {
    slug: "skills-are-never-read",
    title: "We installed an agent skill in 20 sessions. It was read zero times.",
    dek: "A benchmark on real zod bugs found our carefully-written rigor skill had no effect — because no model ever opened it. Forcing delivery flipped hard bugs from FAIL to PASS. So we moved delivery into hooks the model can't ignore, and the gate promptly blocked its own author.",
    date: "2026-07-08", tag: "Benchmark", read: "9 min", pinned: false,
    body: `
<p class="lead">We wrote a five-gate rigor protocol as an agent skill — evidence before edits, verify before claiming, attack your own conclusion. Then we benchmarked it on real bugs from zod's history and got the most boring result possible: <strong>zero effect</strong>. Pass rates identical with and without the skill, 21 of 21 pairs. The interesting part is why.</p>

<h2>The setup</h2>
<p>Eight real bugs mined from zod's git history, each checked out at the commit the bug lived at. The agent gets the issue text only — no failing test handed over (the maintainers' regression tests are applied at <em>scoring</em> time; the agent never sees them). One headless session per cell, across Haiku, Sonnet, Opus and Fable, with and without the skill installed. PASS means the agent's fix makes the maintainers' own held-out tests pass, without touching test files.</p>

<h2>The null result, explained by transcripts</h2>
<p>The skill arm matched the bare arm exactly on every completed pair. Before concluding "skills don't help," we grepped the session transcripts for actual <code>Skill</code> invocations:</p>
<p><strong>0 of 20 sessions ever read the skill.</strong> Not "read it and ignored it" — never opened it. The description was polite prose ("guidance for rigorous execution…"), and models under-trigger skills exactly the way Anthropic's own authoring docs warn. We hadn't benchmarked the skill's content. We'd benchmarked a closed book on a shelf.</p>

<h2>Forcing delivery: the content works</h2>
<p>Same skill, one new line in the prompt: <em>"First invoke the fable-mode skill and follow it strictly."</em> Then we re-ran only the cells where the bare model <strong>failed</strong>:</p>
<table>
<thead><tr><th>cell (task zod-5937)</th><th>skill read?</th><th>result</th></tr></thead>
<tbody>
<tr><td>Opus, bare</td><td>—</td><td>FAIL</td></tr>
<tr><td>Opus, skill installed</td><td>no</td><td>FAIL</td></tr>
<tr><td>Opus, skill forced</td><td><strong>yes</strong></td><td><strong>PASS</strong></td></tr>
<tr><td>Haiku, bare</td><td>—</td><td>FAIL</td></tr>
<tr><td>Haiku, skill forced</td><td><strong>yes</strong></td><td><strong>PASS</strong></td></tr>
</tbody>
</table>
<p>Every pass in the experiment has a transcript-verified skill read; every fail has none. Haiku with the skill solved a bug that bare Opus couldn't — the content is worth roughly a model tier on hard diagnosis. <strong>Delivery, not content, was the whole problem.</strong></p>

<h2>Two fixes, one lesson</h2>
<p>Fix one: rewrite the skill's description from polite to pushy — "MANDATORY before diagnosing any bug — invoke FIRST, do not skip because the task looks simple." That alone got Opus to read it organically and pass. <strong>Haiku still ignored it.</strong> Weaker models don't take hints; they need delivery they can't decline.</p>
<p>Fix two is the product conclusion: move delivery into hooks. The operating loop is injected at session start, a <code>PostToolUse</code> hook records observable facts — which product files were edited, whether a verify-shaped command ran afterwards — and a <code>Stop</code> hook refuses to end the turn while edits stay unverified. Facts, not claims: the gate never asks the model whether it verified; it checks whether a verifying command actually ran. Max two blocks per turn, so a broken gate degrades to advisory instead of trapping anyone. Shipped in Hunch v1.4.</p>

<h2>The gate blocked its own author, twice</h2>
<p>Within hours of wiring it up, the stop-gate blocked the very session that built it — correctly the first time (site edits with no check run), and <em>incorrectly</em> the second: it didn't recognize a bespoke <code>node -e</code> assertion as verification and nagged verified work. That false-negative class is how gates die — users disable what annoys them. v1.4.1 widens credit: generic runners count, and any command that names an edited file counts as checking the thing that changed.</p>

<h2>The task nobody could pass — until one session looked up</h2>
<p>One task failed for every model, every arm — eleven attempts. Root-cause diagnosis was correct <em>every time</em>; the fixes just chose different semantics than the maintainers did (throw on both operands vs. throw on the receiver and preserve the incoming schema's refinements). We'd written it off as spec-guessing.</p>
<p>Then the strongest model, running with the pipeline, passed it on attempt twelve — by doing what the loop's evidence gate demands and nobody else did: it went looking, found the upstream issue and the merged PR, and replicated the maintainers' exact fix. The information was public all along. Eleven sessions stopped at the local code and guessed; one treated "has upstream already resolved this?" as evidence-gathering. (Fair caveat: in a historical benchmark the answer key is public by construction — a <code>--no-web</code> arm would measure pure diagnosis. In real work, checking the upstream tracker is precisely what you want your agent to do.)</p>
<p>Also honest: the pipeline did <em>not</em> lift Opus past that task. Rigor scaffolding compounds with model capability; it doesn't substitute for it.</p>

<h2>What we'd tell anyone shipping agent skills</h2>
<ul>
<li><strong>Check delivery before content.</strong> Grep transcripts for actual invocations. "Installed" and "read" are different universes.</li>
<li><strong>Write pushy descriptions.</strong> Trigger conditions, imperatives, "do not skip." Works on Opus-class; measured insufficient for Haiku-class.</li>
<li><strong>For guarantees, use hooks.</strong> Skills fire on model judgment; hooks fire on events. Anything that must happen belongs in a hook.</li>
<li><strong>Gate on observable facts.</strong> Commands that ran, files that changed, exit codes. Never on the model's own account of its diligence.</li>
<li><strong>Budget the gate's false negatives.</strong> An enforcement mechanism that nags verified work gets disabled — credit every legitimate form of checking.</li>
</ul>

<h2>Try it</h2>
<pre><code>npm i -g @davesheffer/hunch
cd your-repo && hunch init   # advisory by default — nothing blocks until you say so</code></pre>
<p>The bench harnesses are in the repo (<code>bench/</code>) — mine your own task set, and check your transcripts before trusting any arm labeled "with skill."</p>
`,
  },
  {
    slug: "agent-audits-its-own-memory",
    title: "We let the AI audit its own memory tool. It was using 4 of 19 tools.",
    dek: "Two weeks of an agent doing real feature work inside Hunch, then an honest self-audit: where did it fall back to grep, and why? The findings shipped as v1.3.0 — Recall@10 90→100% on a committed golden set, grounding cost cut ~100× on repeats.",
    date: "2026-07-05", tag: "Dogfood", read: "6 min", pinned: false,
    body: `
<p class="lead">Hunch's whole pitch is that an assistant grounded in your decision graph makes better changes. So we asked the uncomfortable question: is the assistant actually <em>using</em> the graph? We put an agent inside Hunch for two weeks of real feature work, then asked it to audit its own experience — honestly. The answer shipped as v1.3.0.</p>

<h2>The audit nobody runs</h2>
<p>Every memory product measures recall benchmarks. Almost nobody measures the thing that decides whether memory matters at all: <strong>does the agent reach for the right tool at the right moment, or does it fall back to grep?</strong></p>
<p>After two weeks of an agent building real features in this repo — the wiki, the specs ledger, doc adoption — we asked it to review its own tool usage. The honest count: <strong>4 of 19 <code>hunch_*</code> tools used.</strong> Not because the data was missing. The graph had the answers. The entry points whiffed at the moment of decision.</p>

<h2>What it filed — every finding has a decision id in the committed graph</h2>
<p><strong>1. The grounding tax.</strong> The pre-edit hook injects the relevant decisions before every file edit — the best grounding the agent had worked with, its words — and it injected the <em>same</em> 10–16KB block on every edit to the same file. Twenty-plus times per session. The cost of being grounded was competing with the work (<code>dec_7cce5bcd8a</code>).</p>
<p><strong>2. The task-shaped entry point shrugged at task-shaped input.</strong> <code>hunch_context("improve retrieval ranking")</code> returned <em>empty</em> — while the graph held a decision literally titled that, one search away (<code>dec_39bc7c8bee</code>).</p>
<p><strong>3. Ranking lost to keyword luck.</strong> A runbook written minutes earlier ranked below an old one for its own trigger phrase. When ranking misses, agents grep — the exact failure the graph exists to prevent (<code>dec_e622668785</code>).</p>
<p><strong>4. The gate blocked its own honest edits.</strong> Scope-only blocking rules denied <em>every</em> edit in guarded directories, including invariant-preserving ones (<code>dec_57e3dcca52</code>, <code>dec_5141920439</code>).</p>

<h2>What shipped, with numbers</h2>
<ul>
<li><strong>Injections dedupe per session</strong> — full context once, a one-line delta on identical repeats (≈100× smaller). Any record change re-sends the full block; the deny path never dedupes. Sessions now <em>open</em> with an orientation: recent decisions, live roadmap.</li>
<li><strong><code>hunch_context</code> falls back to search</strong> on task phrases, and the tool list agents see is grouped by <em>moment</em> (orient → design → edit → commit → after) — the full surface, not 9 of 19.</li>
<li><strong>Retrieval ranks by what the graph knows</strong> — live beats superseded, human-vouched beats drafted, recent beats ancient, with bounded floors so history dims but never vanishes. A query that only matches a <em>superseded</em> decision surfaces the topic's <strong>current</strong> decision right above it. Measured on a committed golden set: <strong>Recall@10 90% → 100%, MRR +14%</strong> — and that eval now gates every retrieval change in CI. No model in the ranking path.</li>
<li><strong>Every blocking rule is content-matched</strong> — the gate denies the edit that actually re-introduces the violation, not every edit near it. The flow-shaped invariant that resists text matching became conformance predicates: <code>hunch conform</code> <em>proves</em> the JSON store never reads through SQLite, on every run.</li>
<li><strong>Duplicate drafts die before the LLM is called.</strong> Record a decision, commit the code — the post-commit hook used to re-draft the same content as review-queue noise (7 of 14 queued drafts, measured). Now a recent human-confirmed decision covering the commit's files skips the draft, with a named receipt.</li>
</ul>

<h2>The part we didn't expect</h2>
<p>Halfway through, the eval gate flagged a regression — in <em>our own golden set</em>. A test case expected a decision we had <strong>superseded that same day</strong>. Golden sets rot exactly like docs do. The fix was the discipline the product preaches: expectations follow the supersession chain, and topic-chain promotion means even a stale query surfaces the current truth.</p>
<p>Every finding was recorded as a <em>proposed</em> decision — which put it on the roadmap (<code>hunch now</code> renders live proposed decisions; ship one and it leaves by itself). Two weeks later the roadmap had emptied itself through supersessions. The v1.3.0 changelog is the first we've written where <strong>every claim resolves to a decision id</strong> in the committed graph.</p>

<h2>Try the loop</h2>
<pre><code>npm i -g @davesheffer/hunch
cd your-repo && hunch init   # advisory by default — nothing blocks until you say so
hunch now                    # what happened + what's next, from the graph</code></pre>
<p>The audit prompt that started this is one your own assistant can answer today: <em>"what's missing for you to work from the graph instead of grepping?"</em> Ask it. Record what it says as proposed decisions. Watch your roadmap write itself.</p>
`,
  },
  {
    slug: "ai-ignores-your-architecture",
    title: "AI ignores your architecture rules — even at the frontier. We measured it.",
    dek: "An AI will rewrite your controller to query the database directly. It passes Semgrep, SonarQube and ESLint — all green. So we benchmarked the obvious fix: does telling the model the rule actually stop it?",
    date: "2026-06-27", tag: "Benchmark", read: "8 min", pinned: false,
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
<p>We benchmarked context injection <a class="link" href="/blog/post?slug=ai-ignores-your-architecture">earlier this year</a>: telling the model the rule cut violations 58% → 16% — and the frontier model still ignored a rule it was shown 60% of the time. The lesson generalizes: <strong>anything advisory decays</strong> — model attention, prose docs, memory features. What holds is the thing that can say no.</p>
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
