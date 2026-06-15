---
description: Fix a bug grounded in Hunch (past root causes, constraints, blast radius)
---
We are fixing: **$ARGUMENTS**

Follow the Hunch-grounded workflow (DESIGN §5) — do NOT skip the memory lookups:
1. `hunch_bug_lineage("$ARGUMENTS")` — has this class of bug happened before? what was the root cause and the fix?
2. Identify the suspect symbol/file, then `hunch_get_dependents(<symbol>)` to learn the blast radius.
3. `hunch_check_constraints(<scope>)` — list invariants you must preserve.
4. Propose a fix that honors past root causes AND constraints. Apply it and run the tests.
5. If the fix encodes a non-trivial choice, `hunch_record_decision(...)` so the next session is grounded in it.
