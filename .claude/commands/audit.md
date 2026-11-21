---
disable-model-invocation: true
description: Run an audit and record what it finds into Hunch as findings (observed gaps, no code change)
---
Audit **$ARGUMENTS** and record what you find into Hunch's graph.

1. Run the actual check (query/grep/script) — a finding needs EVIDENCE: the exact command you ran plus representative output. Never record a finding you didn't observe.
2. For each REAL gap: `hunch_record_finding` with title, observation, evidence, affected_files/affected_symbols, severity. It grounds future edits to those files automatically.
3. If the gap violates an existing invariant, link it via `violates_constraint`. If the RULE itself is unrecorded, capture the rule FIRST (`hunch_record_correction`), then link it.
4. If the audit is re-runnable, capture the procedure as a runbook and set `method` to its rb_* id — that makes the finding re-verifiable, not folklore.
5. Triage with me inline: open (default) / accepted-risk / scheduled. NEVER mark resolved without the fixing commit (`resolved_commit`).
6. Report: findings recorded (ids), what was checked and came back clean, and what stays unverified.

<!-- hunch:generated — refreshed by hunch init; delete this line to take ownership -->
