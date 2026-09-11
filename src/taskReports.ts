/** Provider-neutral, local engine integration. The authorized harness owns
 * lifecycle and display; neither operation depends on model compliance. */
import { realpathSync } from "node:fs";
import { z } from "zod";
import { finishReportTask, listReportTasks, readTaskReport, readLessonHistory, recordReportClaim, recordTaskDelivery, reportHash, reportPresentationEnabled, startReportTask, type ReportClaim, type ReportRecord, type LessonReference } from "./core/taskReport.js";
import { reportSourceSnapshot, runReportCheck, runReportConformance } from "./core/taskReportEvidence.js";
import { renderTaskReport, writeTaskReportHtml } from "./core/taskReportRender.js";
import type { DeliveryEnvelope } from "./core/delivery.js";
import { hunchPaths } from "./core/paths.js";
import { HunchStore } from "./store/hunchStore.js";

export type { TaskReport, ReportTask, ReportClaim, ReportCheck, ReportConformance, ReportSave, ReportDurability, ReportRefusal, ReportRecord, TaskDelivery, LessonReference, LessonHistory } from "./core/taskReport.js";
export { TASK_REPORT_SCHEMA, TaskIdSchema } from "./core/taskReport.js";
export { renderTaskReport, renderTaskReportHtml } from "./core/taskReportRender.js";

const IdentitySchema = z.object({ task: z.string().min(1).max(1024), attempt: z.string().min(1).max(1024) }).strict();

/** Create this only after authorizing a local repository/worktree. A task ID is
 * a correlation reference, never an access token. Remote adapters must enforce
 * their own principal/partition boundary before reaching this local API. */
export function createTaskReporter(root: string) {
  const scope = realpathSync(root);
  const report = (taskId: string) => readTaskReport(scope, taskId, reportSourceSnapshot(scope).hash);
  return {
    /** Omit identity for a fresh task, or supply the harness's stable task AND
     * execution attempt for idempotent retries. Raw identities are not retained. */
    start(title: string, identity?: { task: string; attempt: string }) {
      const key = identity === undefined ? undefined : IdentitySchema.parse(identity);
      const id = key ? `htask_${reportHash([scope, "hunch.harness-task/1", key]).slice(7, 31)}` : undefined;
      return startReportTask(scope, title, id);
    },
    /** The caller supplies the exact envelope it issued plus snapshots of the
     * included revisions. Return the occurrence with the context to the agent.
     * Issuance alone does not prove the model applied or even attended to it. */
    delivered(taskId: string, envelope: DeliveryEnvelope, records: ReportRecord[], occurrenceId?: string) {
      return recordTaskDelivery(scope, taskId, envelope, records, occurrenceId);
    },
    applied(taskId: string, claim: ReportClaim) { return recordReportClaim(scope, taskId, claim); },
    /** Runs locally as argv, without a shell. Only use commands authorized by
     * the task owner. This API does not accept remote claimed-success receipts. */
    verify(taskId: string, command: string[], label: string, options?: Parameters<typeof runReportCheck>[5]) {
      return runReportCheck(scope, taskId, command, label, 120_000, options);
    },
    /** Hunch evaluates each delivered lesson's declared rule against the changed
     * files. Deterministic and local; the harness supplies no verdict. */
    conform(taskId: string) {
      const store = new HunchStore(hunchPaths(scope));
      try { return runReportConformance(scope, store, taskId); } finally { store.close(); }
    },
    finish(taskId: string, outcome: "completed" | "interrupted" = "completed") {
      if (outcome === "completed") { try { this.conform(taskId); } catch { /* the report's unknowns disclose it */ } }
      finishReportTask(scope, taskId, outcome);
      const result = report(taskId);
      return { report: result, contribution_card: reportPresentationEnabled(scope) ? renderTaskReport(result) : null };
    },
    report,
    history: () => listReportTasks(scope),
    lesson: (reference: LessonReference, options?: { limit?: number; before?: number }) => readLessonHistory(scope, reference, options),
    html: (taskId: string, publicOnly = false) => writeTaskReportHtml(scope, taskId, publicOnly),
  };
}
export type TaskReporter = ReturnType<typeof createTaskReporter>;
