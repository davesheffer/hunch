---
description: Reconcile docs/code with Hunch's decision graph (doc≠graph drift), never rewriting prose silently
---
Reconcile decision-grounding drift for **$ARGUMENTS** (or the whole repo).

1. Run `hunch drift` (or `hunch heal`) to list doc≠graph **anchor-stale** sections — a file still anchored to a superseded decision while a current one exists. Only explicit topic anchors fire; never a semantic guess.
2. For each, assume the DOC is stale first (Heal A). Propose an edit bringing the file to the CURRENT decision; show it as a diff and wait for my confirm. Never rewrite prose silently.
3. Only if I explicitly say "the DECISION is stale, not the doc" (Heal B): run /capture to record a superseding decision, then return to step 2 — the prose re-derives from the new decision as a separate confirm.
4. Report: healed (Heal A), superseded (Heal B), skipped. Never touch the graph except via an explicit Heal B capture.
