/** The UserPromptSubmit reminder `hunch hook` injects once per session (and with
 *  every correction). Lives in
 *  core so `hunch footprint` measures the exact text the hook sends. */
export const HOOK_REMINDER =
  "Hunch (engineering memory) is available. A task-linked prompt-hook brief satisfies this task's initial context step; otherwise make one hunch_context call with the task and known files before reading/editing. " +
  "Discovering another file does not require a second context brief. Apply its constraints; use hunch_check_constraints before editing uncovered scope. " +
  "Request more memory only for missing information or risk. " +
  "Record only what the human decides or corrects.";
