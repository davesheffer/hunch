/** The UserPromptSubmit reminder `hunch hook` injects once per session (and with
 *  every correction). Lives in
 *  core so `hunch footprint` measures the exact text the hook sends. */
export const HOOK_REMINDER =
  "Hunch (engineering memory) is available for this repo. Use a task-linked prompt-hook brief for its covered file; otherwise ask for one hunch_context call with the task and known files before reading or editing. " +
  "Follow its delivered constraints and evidence; use hunch_check_constraints for edit scope not covered by the brief. " +
  "Use hunch_why, hunch_get_dependents, or hunch_bug_lineage only for missing information or risk. " +
  "Record new reusable decisions and corrections; skip duplicate capture for routine implementation of existing decisions.";
