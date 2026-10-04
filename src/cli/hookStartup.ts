import { hookProvider, normalizeHookEvent } from "../core/agenthook.js";
import { readConfig } from "../core/config.js";
import { recordHookObservation } from "../core/hookObservations.js";
import { findRoot, hunchPaths } from "../core/paths.js";
import { loadPipelineState, onCommand, pipelineEnabled, proofCheckpoint, savePipelineState } from "../core/pipeline.js";
import { inspectShellWrites, refreshShellBaseline } from "../core/shellwrites.js";

/** Only events requiring delivery evidence and ordinary bookkeeping are handled
 * here. Decide eligibility before any mutation; the full handler owns grounding,
 * policy output, edit/skill facts and every lifecycle event. */
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
  const shellPost = (evt.hook_event_name === "PostToolUse" || evt.hook_event_name === "PostToolUseFailure")
    && /^(Bash|PowerShell)$/.test(evt.tool_name ?? "");
  if (!pre && !post && !shellPost) return false;

  const root = findRoot();
  const off = readConfig(hunchPaths(root)).firmness === "off";
  let inspection: ReturnType<typeof inspectShellWrites> = null;
  let checkpoint: ReturnType<typeof proofCheckpoint> | null = null;
  if (shellPost && !off) {
    inspection = inspectShellWrites(root, evt.session_id, evt.agent_id);
    if (!inspection || inspection.written.length) return false;
    if (evt.session_id) {
      const before = loadPipelineState(evt.session_id);
      // Every stored lesson belongs to the full handler, even if already reminded.
      if (before.lessons.length) return false;
      if (pipelineEnabled()) {
        const command = String(evt.tool_input?.command ?? "");
        checkpoint = proofCheckpoint(before, onCommand(before, command, evt.tool_outcome), { kind: "command", command });
        if (checkpoint.reminder) return false;
      }
    }
  }
  recordHookObservation(root, provider, evt.hook_event_name, evt.tool_outcome?.status);
  if (off) return true;
  if (shellPost) {
    inspection!.advance();
    if (checkpoint && evt.session_id) savePipelineState(evt.session_id, checkpoint.state);
    return true;
  }
  if (post || evt.tool_name === "Bash" || evt.tool_name === "PowerShell") {
    refreshShellBaseline(root, evt.session_id, evt.agent_id);
  }
  if (post && evt.session_id && pipelineEnabled()) {
    savePipelineState(evt.session_id, loadPipelineState(evt.session_id));
  }
  return true;
}
