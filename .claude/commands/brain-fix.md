---
description: Fix a bug grounded in the Project Brain (past root causes, constraints, blast radius)
---
We are fixing: **$ARGUMENTS**

Follow the Brain-grounded workflow (DESIGN §5) — do NOT skip the memory lookups:
1. `brain_bug_lineage("$ARGUMENTS")` — has this class of bug happened before? what was the root cause and the fix?
2. Identify the suspect symbol/file, then `brain_get_dependents(<symbol>)` to learn the blast radius.
3. `brain_check_constraints(<scope>)` — list invariants you must preserve.
4. Propose a fix that honors past root causes AND constraints. Apply it and run the tests.
5. If the fix encodes a non-trivial choice, `brain_record_decision(...)` so the next session is grounded in it.
