/** The UserPromptSubmit reminder `hunch hook` injects once per session (and with
 *  every correction). Lives in
 *  core so `hunch footprint` measures the exact text the hook sends. */
export const HOOK_REMINDER =
  "Hunch (engineering memory) is available for this repo. A task-linked prompt-hook brief satisfies this task's initial context step; otherwise ask for one hunch_context call with the task and known files before reading or editing. " +
  "Apply its constraints. Discovering another file does not require a second context brief; use hunch_check_constraints before editing uncovered scope. " +
  "Request hunch_context, hunch_why, hunch_get_dependents, or hunch_bug_lineage only for missing information or risk. " +
  "Record new reusable decisions and corrections; skip duplicate capture for routine implementation of existing decisions.";
