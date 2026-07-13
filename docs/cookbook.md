# Hunch Cookbook

Practical recipes for running Hunch day to day. Each recipe is copy-paste-able and states what you should observe when it works.

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

## 5. Turn a human correction into a permanent rule

When you catch the assistant doing something it must never do again:

```
hunch_record_correction({ rule, scope_hint_file, severity: "blocking" })
```

**Observe:** at `strict`, an edit that violates the rule is denied with the rule quoted back. Never Twice.

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

## 10. Private overlay (public repo, private memory)

```bash
hunch init --private-sync   # captures go to HUNCH_PRIVATE_DIR overlay, never the public store
hunch private               # point a clone at the overlay
```

**Observe:** `hunch_*` tools see the union; the public repo carries only what you curate.

## 11. The self-running memory loop (v1.8.0+)

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
