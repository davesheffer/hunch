# HANDOFF — pick up at work (different machine)

Cross-machine resume note (this travels via git; the local `claude --continue` session and
`~/.claude` memory do NOT). Delete this file + branch once the docs pass is shipped.

## Where things stand
- **Shipped & live:** synthesis "inward orchestration" — v0.19.0 (Critic `--verify` + single-CLI
  self-consistency `--samples`), v0.19.1 (observable verify degradation + retry), v0.20.0 (segmented
  `hunch review` + `--accept-verified`). **npm latest = 0.20.0**, `main` clean.
- **Open task (this is it):** optimize the public presentation — README, npm metadata, GitHub repo
  metadata. A workflow already audited + fact-checked everything; the verified proposals are below.

## HARD RULE for all public copy: client-agnostic, NOT Claude-Code-only
Hunch works with **any MCP coding assistant — Claude Code, Cursor, Copilot, Windsurf, Codex — from one
shared `.hunch/` graph** (enforced invariant con_e04226bd05). Lead generic; list the five as examples.
The *current* npm/GitHub/README-hero strings all wrongly lead "exposed to Claude Code" — fix them.

## 1. README.md
**a) Add a "Review" subsection** at the TOP of the `## Enforcement` section — after the firmness intro
paragraph (ends `off → advisory → firm → strict`), BEFORE `### Never Twice`:

```markdown
### Review — where a draft becomes an enforceable record

Synthesis is generous on purpose; enforcement shouldn't be. `hunch review` is the gate in
between — the **capture → review → enforce** funnel. It **segments** the draft queue into
**ready to confirm** (Critic-verified *and* grounded ≥ threshold, best first) vs **need
scrutiny**, and surfaces what the Critic already did for you (e.g. *"Critic pruned 3
unsupported"* rejected-alternatives that would otherwise have armed tripwires):

​```bash
hunch review                    # triage the queue, segmented; accept/reject one at a time
hunch review --accept dec_…     # promote a draft → accepted/human_confirmed (arms its tripwires)
hunch review --accept-verified  # batch-accept the whole ready group (≥ --min-grounded, default 0.7)
​```

Confirming a draft is what **arms** its guards — `--accept-verified` reports how many
tripwires it lit. Nothing auto-enforces until it clears review, so the segmented queue is
how a generous write path turns into invariants you trust. → [docs](https://hunch-pi.vercel.app/docs#review)
```

**b) Fix the stale CLI count** (line ~105): change `the 22-command CLI` → `the CLI reference`
(drop the number so it never drifts again; the real count today is **26** user-facing commands).

**c) De-Claude the hero** (line ~10): "surfaced to Claude Code at reasoning time" → make it
"surfaced to your AI coding assistant (Claude Code, Cursor, Copilot, Windsurf, Codex)".

## 2. npm — package.json (apply the client-agnostic lead, then bump + publish)
- `description`: `Engineering Memory OS for AI coding assistants — a local-first, git-native graph of
  decisions, bugs & invariants over your codebase, served via MCP to Claude Code, Cursor, Copilot,
  Windsurf & Codex.`
- `keywords`: `["mcp","mcp-server","model-context-protocol","ai-coding","ai-coding-assistant","engineering-memory","code-memory","codebase-context","knowledge-graph","decision-graph","adr","architecture-decision-records","code-intelligence","claude-code","cursor","copilot","developer-tools","git-native","local-first","reasoning-graph"]`

## 3. GitHub — `gh repo edit` (immediate, no publish needed)
- `--description "Local-first engineering memory for AI coding assistants: a git-native graph of decisions,
  bugs & invariants (ADRs) over your codebase, served via MCP to Claude Code, Cursor, Copilot, Windsurf &
  Codex — so the AI stops re-deriving context and undoing intentional design. No SaaS."`
- topics (currently NONE): `engineering-memory mcp model-context-protocol ai-coding-assistant claude-code
  cursor github-copilot windsurf codex knowledge-graph code-intelligence developer-tools adr
  architecture-decision-records llm cli typescript git local-first code-context`
  (`gh repo edit --add-topic <each>`)

## 4. Ship
- `gh repo edit` for description + topics (instant).
- Commit README + package.json; push.
- Cut a **v0.20.1** docs release: `gh release create v0.20.1 --target main …` → CI `release.yml`
  publishes to npm with provenance (npm is NOT authed locally; it publishes via the GitHub Release).
  This is the ONLY way npmjs.com refreshes its README/metadata.

## Editing notes
- Editing `src/synthesis/**` is blocked by the repo's own strict edit-gate — drop `.hunch/config.json`
  `firmness` strict→firm, edit, restore strict. (Not needed for this docs-only task.)
- Full original proposals (incl. fact-check) were saved on the home machine at
  `~/.claude/projects/<this-project>/memory/_presentation-proposals.json` — not needed if you have this file.

## After this: synthesis runway (priority order)
1. **Bug ensembling** — extend the ensemble to `draftBug`, WITH the confidence-trap guardrail (cap a derived
   constraint's confidence < 0.8 so auto-capture can't arm a blocker). Real risk; needs the guard + a test.
2. **Stakes-tiered routing** — significance tiers → model map instead of fixed `haiku`.
3. **Quality-aware routing** — now unblocked: the segmented review yields accept/reject signal to learn
   which provider humans keep.
