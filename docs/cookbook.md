# Hunch Cookbook

Practical recipes for running Hunch day to day. Each recipe is copy-paste-able and states what you should observe when it works.

> **Languages:** deep code-structure parsing covers TypeScript, JavaScript, and Python
> (one `LanguageSpec` registry entry per language). The "why" layer — decisions, bugs,
> rules — works for any language, since it reads your commits and diffs.

---

## 1. First install on a repo

```bash
npm i -g @davesheffer/hunch
cd your-repo
hunch init --firmness advisory     # start gentle; raise later
git commit --allow-empty -m "hunch: first capture"
```

**Observe:** `.hunch/` appears (git-tracked JSON), `.claude/settings.json` gains five hook events (`PreToolUse`, `UserPromptSubmit`, `SessionStart`, `PostToolUse`, `Stop`), and your next assistant session opens with a 🧠 orientation block.

Cold start on an old repo:

```bash
hunch backfill --since 90d
```

---

## 2. Choose an enforcement level

| firmness | pre-edit grounding | blocking invariants deny edits | verification stop-gate |
|---|---|---|---|
| `off` | — | — | — |
| `advisory` | ✔ | — | nag only |
| `firm` | ✔ | — | ✔ blocks unverified turn-end |
| `strict` | ✔ | ✔ | ✔ |

```bash
hunch firmness firm
```

No restart needed — the hook reads firmness at run time.

---

## 3. The verification pipeline (v1.4.0+)

The operating loop — **scope → evidence → change → verify → attack → report** — is injected at session start and *enforced* at turn end. Facts, not claims: the `PostToolUse` hook records which product files were edited and whether a verify-shaped command (test / build / typecheck / plan) ran afterwards. At `firm`/`strict`, the `Stop` hook refuses to end a turn with unverified product edits (max twice per turn, so a broken gate can never trap you).

**Why it exists (measured, 2026-07-08):** instruction skills installed as files were read in **0/20** benchmark sessions — and pass rates were identical to having no skill at all. When the same content was guaranteed-delivered, hard-bug diagnosis flipped FAIL→PASS on every discriminating cell (Opus and Haiku both). Delivery, not content, is the bottleneck; hooks are the only delivery mechanism the model can't ignore.

Escape hatches:

```bash
HUNCH_PIPELINE=0        # kill switch, per env
hunch firmness advisory # keep grounding, drop the gate
```

Docs and `.claude/` / `.hunch/` edits never arm the gate.

---

## 4. Capture a decision that will survive the session

After any non-trivial choice:

```
/capture           # grilling interview: topic, rationale, rejected alternatives
```

Or mid-flow: `hunch_capture_decision(topic)` → answer the questions → `hunch_record_decision(...)` with the returned token.

**Observe:** the decision shows in `hunch now`, and editing a file it governs injects it — including what was **rejected**, so the next session doesn't re-litigate it.

---

## 5. Turn a human correction into a proof-backed proposal

When you catch the assistant doing something it must never do again:

```
hunch_record_correction({ rule, scope_hint_file, severity: "blocking" })
```

For a supported deterministic correction, use the returned constraint id to produce a reviewable
policy packet:

```bash
hunch policy upgrade-correction <constraint-id>
hunch policy card <policy-id>
```

**Observe:** the upgrade writes evidence, a proof plan, a proof, and a **proposed** policy. It reports
`authority: none` and does not activate anything. In v1.9 the proposal's source-currentness gate is
mechanically blocked, so even a human cannot activate this correction policy yet. The original
correction guard remains available throughout. Other proved policy types still require explicit,
audited human acceptance before they can become advisory or blocking.

---

## 6. Keep docs honest (doc≠graph)

Anchor a doc to a topic:

```markdown
<!-- hunch:topic auth.session-storage -->
```

Then:

```bash
hunch drift              # CI-gateable: stale anchors fail
hunch heal               # guided reconciliation — never rewrites prose silently
hunch reconcile-topics   # after merges: enforce one live decision per topic
```

---

## 7. Wire CI

```bash
hunch ci                 # constraint guard on the diff
hunch drift              # doc anchors still current
hunch reconcile-topics   # merge didn't create two live decisions on one topic
```

All exit non-zero on violation.

---

## 8. Make an instruction skill actually fire

Measured: models under-trigger skills badly (0/20 sessions read an installed skill whose description was polite prose). If you ship a skill:

1. Write the `description` as a **pushy trigger**: "MANDATORY before X — invoke FIRST, do not skip because the task looks simple." This alone took Opus from never-reads to reads-and-passes.
2. Weaker models (Haiku-class) ignore even pushy descriptions — for them, name the skill in the prompt or inject the content via hooks (recipe 3 is exactly this, productized).
3. Never claim a skill "doesn't help" without checking the transcript for an actual `Skill` invocation — availability ≠ delivery.

---

## 9. Benchmark your own setup

The repo ships harnesses under `bench/`:

```bash
npx tsx bench/run.ts --arms A,C --model claude-sonnet-5          # this repo's tasks
npx tsx bench/external/run-zod.ts --arms A,S --no-repro          # foreign-code diagnosis
npx tsx bench/external/run-zod.ts --arms S --force-skill --only zod-5937   # skill content, delivery guaranteed
```

Rules learned the hard way: use `--no-repro` (diagnosis mode) or everything ceilings at PASS; drop tasks that fail for *every* arm (they usually measure spec-guessing, not diagnosis); verify skill invocations in transcripts before comparing arms.

---

## 10. Connect the team-memory Matrix

Create a dedicated private Git repository for memory. It must be different from every code-repo
remote, and the URL committed into the code repository must not contain credentials.

On one maintainer machine:

```bash
npm i -g @davesheffer/hunch@1.9.0
hunch shared --repo git@github.com:acme/project-hunch-memory.git
git add .gitignore .hunch/team.json
git commit -m "chore: connect shared Hunch memory"
git push
```

Add `--migrate` to the `hunch shared` command only when moving existing public `.hunch/` memory
into the dedicated store. Review the reported untrack/ignore changes and follow the commit command
Hunch prints. On every teammate machine:

```bash
npm i -g @davesheffer/hunch@1.9.0
git pull
hunch init
hunch doctor
```

**Observe:** the code repo commits `.hunch/team.json`; credentials remain in SSH or the Git
credential helper. Each machine gets an ignored `.hunch-private/` clone and `.hunch/local.json`
pointer. CLI memory operations refresh at startup, MCP tools refresh at request boundaries, and new
captures commit and synchronize through the memory repo automatically.

For a coordinated pause or rollback that preserves every memory record:

```bash
hunch firmness off
hunch shared --repo git@github.com:acme/project-hunch-memory.git --no-auto-commit
npm i -g @davesheffer/hunch@1.8.3
```

Revert the `.hunch/team.json` setup commit only if new clones must stop discovering the Matrix. Do
not delete the memory repo or local overlay; after upgrading again, `hunch shared --sync` publishes
pending local memory. Version 1.8.3 rejects v1.9's source-gated correction-policy IR instead of
silently bypassing it, so pause enforcement first and upgrade every client to v1.9 before resuming
Matrix policy workflows.

## 11. Private overlay (public repo, private memory)

```bash
hunch init --private-sync   # captures go to HUNCH_PRIVATE_DIR overlay, never the public store
hunch private               # point a clone at the overlay
```

**Observe:** `hunch_*` tools see the union; the public repo carries only what you curate.

## 12. The self-running memory loop (v1.8.0+)

Nothing to manage. Capture happens on every commit, memory lands trusted-advisory
immediately, and renames heal their own bindings:

```bash
hunch log                    # every memory move: capture · adopt · supersede · prune · repair
hunch log --diff <sha>       # what one move changed
hunch revert-move <sha>      # undo one move (local git revert, never pushed)
hunch escalations            # the decisions only YOU can make — normally empty
hunch adopt-drafts           # one-time: clear a legacy draft backlog into advisory memory
hunch push                   # the one deliberate outward step (memory auto-commits locally)
```

**Observe:** after a commit that renames a file, `hunch log` shows a 🔧 repair move —
the bindings healed themselves; nothing went stale. In VS Code, the **Hunch Memory**
panel is the same spine with click-to-diff, one-click revert, and the inline
activate / demote / withdraw / retire authority actions.

**Rule of the loop:** advisory is automatic; *blocking* is always one explicit human
click, and a repaired rule asks once for a fresh proof before it can block again.

---

## 13. Self-hosted / local models (Ollama, vLLM, LM Studio) via openai-compat

```bash
HUNCH_SYNTH_PROVIDER=ollama                          # alias for openai-compat
HUNCH_SYNTH_BASE_URL=http://localhost:11434/v1
HUNCH_SYNTH_MODEL=qwen2.5-coder:latest
# optional:
HUNCH_SYNTH_API_KEY=...          # only if your endpoint requires one
HUNCH_SYNTH_TIMEOUT_MS=300000    # default 300000 (5 min)
HUNCH_SYNTH_MAX_TOKENS=2048      # default 2048 — caps OUTPUT length
```

Ollama's effective context can come from the model, server configuration, or VRAM-based defaults. Long commit diffs can be silently truncated when that context is too small. `hunch doctor` and `hunch backfill` warn when the selected model does not pin `num_ctx`; for predictable synthesis, pin it once at the model level:

```
FROM qwen2.5-coder:latest
PARAMETER num_ctx 16384
```

```bash
ollama create hunch-synth -f Modelfile
```

Then point `HUNCH_SYNTH_MODEL` at `hunch-synth` instead of the base model.

**Observe:** `hunch doctor` no longer prints the context warning once `num_ctx` is set; `hunch backfill`'s drafts stop hallucinating from truncated diffs.

**Public remotes are refused by default.** A hostname denylist cannot keep pace with every paid OpenAI-compatible provider, so Hunch fails closed: localhost, private/link-local IPs, and conventional LAN names work directly; every public remote requires `HUNCH_SYNTH_ALLOW_METERED=1`. Set it only when the endpoint is deliberately trusted and any billing is understood. Publicly hosted self-managed endpoints use the same explicit flag because billing cannot be inferred safely from a hostname.
