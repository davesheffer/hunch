import { existsSync, lstatSync, realpathSync } from "node:fs";
import { isAbsolute, join, relative, resolve, sep } from "node:path";
import type { HookProvider, HunchHookInput } from "./agenthook.js";
import { buildDeliveryEnvelope } from "./delivery.js";
import { armExecutionObligations, loadPipelineState, pipelineEnabled, savePipelineState } from "./pipeline.js";
import { isCredentialFreeValue, SENSITIVE_METADATA_KEY } from "./provenance.js";
import { recordServed } from "./served.js";
import { promptPaths } from "./taskSelection.js";
import { snapshotDeliveredRecords } from "./taskReportEvidence.js";
import { recordTaskDelivery } from "./taskReport.js";
import { hookReportTaskId, isNotificationPrompt, nativeHookCwd } from "./taskReportHook.js";
import type { HunchStore } from "../store/hunchStore.js";

/** Resolve only a concrete file named in the prompt; never retain task prose. */
export function promptContextTarget(root: string, prompt: string | undefined): string | null {
  if (!prompt) return null;
  for (const candidate of promptPaths(prompt)) {
    const segments = candidate.split("/");
    if (isAbsolute(candidate) || /^[a-z]:/i.test(candidate)
      || segments.some((part) => !part || part === "." || part === ".." || part.startsWith(".")
        || /config[-_]secret/i.test(part) || SENSITIVE_METADATA_KEY.test(part)
        || /^(?:credentials?|password|passwd|secret|token|api[-_]?key|private[-_]?key)(?:[._-]|$)/i.test(part)
        || /\.(?:pem|key|p12|pfx)$/i.test(part))
      || !isCredentialFreeValue(candidate)) continue;
    const abs = resolve(root, candidate);
    const rel = relative(root, abs);
    if (!rel || rel === ".." || rel.startsWith(`..${sep}`) || isAbsolute(rel)) continue;
    try {
      let path = root;
      for (const [index, part] of segments.entries()) {
        path = join(path, part);
        const stat = lstatSync(path);
        if (stat.isSymbolicLink()) throw new Error("symlink path");
        if (index === segments.length - 1) {
          if (!stat.isFile()) throw new Error("not a file");
        } else if (!stat.isDirectory()) throw new Error("not a directory");
      }
      // native realpath resolves filesystem casing as well as aliases. Plain
      // realpathSync retains input casing on macOS, which misses exact scopes.
      const canonical = relative(realpathSync.native(root), realpathSync.native(abs));
      if (!canonical || canonical === ".." || canonical.startsWith(`..${sep}`) || isAbsolute(canonical)) continue;
      return canonical.split(sep).join("/");
    } catch { /* another prompt path may be a safe file */ }
  }
  return null;
}

/** A native prompt's confirmed, task-linked first context for one file. */
export function promptContextBrief(root: string, store: HunchStore, provider: HookProvider, event: HunchHookInput): string | null {
  if (event.hook_event_name !== "UserPromptSubmit" || event.agent_id || isNotificationPrompt(event.prompt)) return null;
  const cwd = nativeHookCwd(root, provider, event);
  const taskId = cwd && hookReportTaskId(root, provider, event);
  if (!cwd || !taskId || !event.session_id) return null;
  // Team discovery/consent/freshness belong to the validated MCP/CLI route.
  // A passive prompt must never declare public-only memory sufficient for a
  // checkout advertising team memory. Explicit overlays retain their contract.
  if (!process.env.HUNCH_PRIVATE_DIR?.trim() && existsSync(join(cwd, ".hunch", "team.json"))) return null;
  const target = promptContextTarget(cwd, event.prompt);
  if (!target) return null;
  try {
    const ctx = store.assembleContext(target, 1000);
    ctx.constraints = [...new Map([
      ...ctx.constraints,
      ...store.why("").constraints,
      // why("") omits literal empty scopes; those are repo-wide too.
      ...store.recs("constraints").filter((item) => item.scope.length === 0),
    ].map((item) => [item.id, item])).values()];
    const envelope = buildDeliveryEnvelope(ctx, {
      root: cwd,
      symbols: store.recs("symbols"),
      components: store.recs("components"),
      decisionCorpus: store.recs("decisions"),
      graphLists: false,
    });
    const snapshots = snapshotDeliveredRecords(store, envelope);
    if (pipelineEnabled()) {
      // This automatic file slice cannot retire obligations from a prior task
      // brief. Only an explicit refreshed context can replace memory obligations.
      const state = armExecutionObligations(loadPipelineState(event.session_id), envelope.obligations);
      savePipelineState(event.session_id, state);
      const armed = loadPipelineState(event.session_id);
      if (envelope.obligations.some((item) => !armed.obligations.some((saved) => saved.id === item.id))) return null;
    }
    const occurrence = recordTaskDelivery(cwd, taskId, envelope, snapshots, undefined, target);
    recordServed(cwd, envelope.delivered.map((item) => ({
      event: "served", kind: item.kind, record_id: item.record_id, target,
      rank: item.rank, delivery_reason: item.delivery_reason, provenance_status: item.provenance_status,
      token_cost: item.token_cost, delivery_profile: envelope.profile, ranking_policy: envelope.ranking_policy,
    })));
    return `Hunch task-linked prompt-hook brief for ${target} (task ${taskId} · occurrence ${occurrence}). This satisfies first context for this file. Apply its constraints; call hunch_check_constraints for edit scope not covered by this brief before editing. Request hunch_context with this task ID and concrete evidence only if more context is needed.\n\n${envelope.text}`;
  } catch { return null; }
}
