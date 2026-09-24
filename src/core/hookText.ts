/** The UserPromptSubmit reminder `hunch hook` injects on every prompt. Lives in
 *  core so `hunch footprint` measures the exact text the hook sends. */
export const HOOK_REMINDER =
  "Hunch (engineering memory) is available for this repo. Before editing, call " +
  "hunch_check_constraints(scope) for do-not-break invariants and hunch_why(target) " +
  "for the rationale; use hunch_get_dependents for blast radius and hunch_bug_lineage " +
  "for prior root causes. After a non-trivial choice, record it with hunch_record_decision.";
