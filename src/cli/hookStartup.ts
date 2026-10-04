import { hookProvider, normalizeHookEvent } from "../core/agenthook.js";
import { readConfig } from "../core/config.js";
import { recordHookObservation } from "../core/hookObservations.js";
import { findRoot, hunchPaths } from "../core/paths.js";
import { loadPipelineState, pipelineEnabled, savePipelineState } from "../core/pipeline.js";
import { refreshShellBaseline } from "../core/shellwrites.js";

/** Only events requiring delivery evidence and ordinary bookkeeping are handled
 * here. Decide eligibility before any mutation; the full handler owns grounding,
 * policy, shell outcomes, edit/skill facts and every lifecycle event. */
export function handleSimpleHook(input: string, providerName: string): boolean {
  const provider = hookProvider(providerName);
  if (!provider) return true;
  let raw: unknown;
  try { raw = JSON.parse(input); } catch { return true; }
  const evt = normalizeHookEvent(raw, provider);
  if (!evt) return true;
  const pre = evt.hook_event_name === "PreToolUse"
    && !evt.tool_input?.file_path && !evt.tool_input?.patch_files?.length;
  const post = (evt.hook_event_name === "PostToolUse" || evt.hook_event_name === "PostToolUseFailure")
    && !/^(Bash|PowerShell|Edit|Write|MultiEdit|Skill)$/.test(evt.tool_name ?? "");
  if (!pre && !post) return false;

  const root = findRoot();
  recordHookObservation(root, provider, evt.hook_event_name, evt.tool_outcome?.status);
  if (readConfig(hunchPaths(root)).firmness === "off") return true;
  if (post || evt.tool_name === "Bash" || evt.tool_name === "PowerShell") {
    refreshShellBaseline(root, evt.session_id, evt.agent_id);
  }
  if (post && evt.session_id && pipelineEnabled()) {
    savePipelineState(evt.session_id, loadPipelineState(evt.session_id));
  }
  return true;
}
