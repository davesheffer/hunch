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

/** Resolve a bounded set of concrete prompt files; never retain task prose. */
function promptContextTargets(root: string, prompt: string | undefined, limit = 4): string[] {
  if (!prompt) return [];
  const targets = new Set<string>();
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
      targets.add(canonical.split(sep).join("/"));
      if (targets.size >= limit) break;
    } catch { /* another prompt path may be a safe file */ }
  }
  return [...targets];
}

/** Compatibility helper for callers asking for the first safe prompt file. */
export function promptContextTarget(root: string, prompt: string | undefined): string | null {
  return promptContextTargets(root, prompt, 1)[0] ?? null;
}

/** One task-linked file brief, with constraints for other explicitly named files. */
export function promptContextBrief(root: string, store: HunchStore, provider: HookProvider, event: HunchHookInput): string | null {
  if (event.hook_event_name !== "UserPromptSubmit" || event.agent_id || isNotificationPrompt(event.prompt)) return null;
  const cwd = nativeHookCwd(root, provider, event);
  const taskId = cwd && hookReportTaskId(root, provider, event);
  if (!cwd || !taskId || !event.session_id) return null;
  // Team discovery/consent/freshness belong to the validated MCP/CLI route.
  // A passive prompt must never declare public-only memory sufficient for a
  // checkout advertising team memory. Explicit overlays retain their contract.
  if (!process.env.HUNCH_PRIVATE_DIR?.trim() && existsSync(join(cwd, ".hunch", "team.json"))) return null;
  const targets = promptContextTargets(cwd, event.prompt);
  const target = targets[0];
  if (!target) return null;
  try {
    const ctx = store.assembleContext(target, 1000);
    const globalConstraints = [
      ...store.why("").constraints,
      // why("") omits literal empty scopes; those are repo-wide too.
      ...store.recs("constraints").filter((item) => item.scope.length === 0 && item.status !== "retired"),
    ].filter((item) => item.status !== "retired" && item.valid_to == null);
    const required = new Map(targets.map((file) => [file, [...globalConstraints, ...store.checkConstraints(file)]
      .filter((item) => item.status !== "retired" && item.valid_to == null)]));
    ctx.constraints = [...new Map([
      ...ctx.constraints,
      ...[...required.values()].flat(),
    ].map((item) => [item.id, item])).values()];
    const envelope = buildDeliveryEnvelope(ctx, {
      root: cwd,
      constraintTargets: targets,
      symbols: store.recs("symbols"),
      components: store.recs("components"),
      decisionCorpus: store.recs("decisions"),
      graphLists: false,
    });
    // An ID proves delivery, not complete instructions. The actual emitted
    // statement and scope must be unabridged too; clipped/omitted rules still
    // require a manual lookup. Reading the rendered text also fails closed if
    // the delivery format changes or its final budget pass truncates a line.
    const deliveredConstraints = new Set(envelope.delivered.filter((item) => item.kind === "constraints").map((item) => item.record_id));
    const lines = envelope.text.split("\n");
    const flat = (value: string): string => value.replace(/\s+/g, " ").trim();
    const completeConstraints = new Set(ctx.constraints.filter((item) => deliveredConstraints.has(item.id)
      && lines.some((line) => line.startsWith(`- ${item.id} | constraint/${item.severity} | ${flat(item.statement)} | scope ${flat(item.scope.join(", ") || "repo")} | `)))
      .map((item) => item.id));
    const covered = targets.filter((file) => required.get(file)!.every((item) => completeConstraints.has(item.id)));
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
    return `Hunch task-linked prompt-hook brief for ${target} (task ${taskId} · occurrence ${occurrence}). This satisfies this task's initial context step.\nConstraint coverage is complete for: ${covered.length ? covered.join(", ") : "none"}. Apply these constraints without another lookup for those files; check hunch_check_constraints before editing uncovered scope or after memory changes. Discovering another file alone does not require another hunch_context call. Request further context only for missing information or risk, with this task ID and concrete evidence.\n\n${envelope.text}`;
  } catch { return null; }
}
