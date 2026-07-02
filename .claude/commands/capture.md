---
description: Capture an engineering decision into Hunch's graph via a grilling interview (topic, rationale, rejected alternatives)
---
Capture the decision for **$ARGUMENTS** into Hunch's graph.

1. Call `hunch_capture_decision(topic?, seed?)` — it returns the grilling protocol and a capture-session token.
2. Run the GRILLING LOOP: one focused question at a time. Push back on hand-wavy answers. Resolve every branch before committing — an unexamined decision poisons the graph.
3. Confirm the TOPIC anchor with me before committing. One topic per decision; if it spans two, split into two captures.
4. Capture REJECTED alternatives explicitly (what, and why not) — this is what makes the decision enforceable (Veto/drift check against it).
5. Commit with `hunch_record_decision`, passing `capture_token` (from step 1) and the confirmed `topic`. The artifact is the graph write, not prose.
6. On CONFLICT for the topic, do NOT auto-supersede — Hunch refuses and presents both; let me choose supersede (link) / split the topic / discard.
