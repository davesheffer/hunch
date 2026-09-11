import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { z } from "zod";
import { fileURLToPath } from "node:url";
import { TaskIdSchema, ReportClaimSchema, LessonReferenceSchema, finishReportTask, listReportTasks, readTaskReport, readLessonHistory, recordReportClaim, reportPresentationEnabled, startReportTask } from "../core/taskReport.js";
import { reportSourceSnapshot, runReportConformance } from "../core/taskReportEvidence.js";
import { renderTaskReport, writeTaskReportHtml } from "../core/taskReportRender.js";
import type { HunchStore } from "../store/hunchStore.js";

function applicationReferences(report: ReturnType<typeof readTaskReport>) {
  return report.deliveries.flatMap(d => d.records.map(r => ({ occurrence_id: d.occurrence_id, record_id: r.record_id, content_hash: r.content_hash, title: r.title }))).slice(-100);
}

/** Reuse the MCP server's installation, not a potentially stale global binary.
 * Structured argv is authoritative; the shell hint uses literal quoting. */
function verificationLauncher(): { argv: string[]; shell: string } {
  const dev = import.meta.url.endsWith(".ts");
  const entry = fileURLToPath(new URL(`../cli/index.${dev ? "ts" : "js"}`, import.meta.url));
  const argv = [process.execPath, ...(dev ? ["--import", fileURLToPath(import.meta.resolve("tsx"))] : []), entry];
  const quote = (s: string) => process.platform === "win32" ? `'${s.replace(/'/g, "''")}'` : `'${s.replace(/'/g, "'\\''")}'`;
  return { argv, shell: `${process.platform === "win32" ? "& " : ""}${argv.map(quote).join(" ")}` };
}

export function registerTaskReportTools(server: McpServer, getRoot: () => string, getStore: () => HunchStore): void {
  server.registerTool("hunch_task", {
    title: "Start or finish a task's contribution report",
    description: "Start once per user task; pass the returned task_id to hunch_context. Finish before your final response and include the returned concise contribution card, without asking the user. Applications are explicitly agent-reported and must name an exact delivered occurrence and record hash. Completion never implies successful verification. Not for storing decisions or claiming tests passed; use the CLI task verify wrapper for observed command results.",
    inputSchema: {
      action: z.enum(["start", "finish"]), task_id: TaskIdSchema.optional(),
      title: z.string().min(1).max(200).optional(),
      outcome: z.enum(["completed", "interrupted"]).optional(),
      applications: z.array(ReportClaimSchema).max(20).optional(),
      cwd: z.string().optional().describe("Actual repository/worktree directory for this task."),
    },
  }, async ({ action, task_id, title, outcome, applications }) => {
    try {
      const root = getRoot();
      if (action === "start") {
        if (!title || applications?.length || outcome) throw new Error("start requires a short task title and no completion evidence");
        const task = startReportTask(root, title, task_id);
        const launcher = verificationLauncher();
        return { content: [{ type: "text" as const, text: `Task ${task.task_id} · ${task.state}. Pass task_id to every hunch_context and decision/correction/finding capture call. Before the final response, finish with hunch_task and include its contribution card. For checks use this exact installation (the global hunch binary may be stale): ${launcher.shell} task verify ${task.task_id} -- <command> [arguments].` }], structuredContent: { task, verification_argv: [...launcher.argv, "task", "verify", task.task_id, "--"] } };
      }
      if (!task_id) throw new Error("finish requires the exact task_id");
      for (const claim of applications ?? []) recordReportClaim(root, task_id, claim);
      // Hunch's own rule evaluation of the delivered lessons; the agent submits
      // no verdict. Failure is disclosed by the report and never blocks finish.
      if ((outcome ?? "completed") === "completed") { try { runReportConformance(root, getStore(), task_id); } catch { /* unknowns disclose it */ } }
      finishReportTask(root, task_id, outcome ?? "completed");
      const report = readTaskReport(root, task_id, reportSourceSnapshot(root).hash);
      const show = reportPresentationEnabled(root);
      let file: string | null = null;
      try { file = writeTaskReportHtml(root, task_id); } catch { /* retained report remains inspectable through MCP */ }
      const card = file ? renderTaskReport(report).replace(/^Evidence .*$/m, `Evidence  [Open local report](<${file}>)`) : renderTaskReport(report);
      return { content: [{ type: "text" as const, text: show ? card : "Task report retained. Automatic presentation is disabled; omit the contribution card from the final response." }], structuredContent: { ...report, presentation_enabled: show, contribution_card: show ? card : null, report_path: file } as unknown as Record<string, unknown> };
    } catch (error) {
      const message = `Task report unavailable: ${(error as Error).message}`;
      // Some hosts show structuredContent instead of text blocks. Return exact
      // recovery references there as well; never ask an agent to invent a hash.
      let references: ReturnType<typeof applicationReferences> = [];
      if (task_id) { try { references = applicationReferences(readTaskReport(getRoot(), task_id)); } catch {} }
      return { isError: true, content: [{ type: "text" as const, text: message }], structuredContent: { error: message, application_references: references, recovery: "For a real application, copy an exact reference and add the action you took. Do not replace receipt prefixes or substitute a scope hash. For full evidence call hunch_report with the exact task ID." } };
    }
  });
  server.registerTool("hunch_report", {
    title: "Inspect the evidence for Hunch's contribution to a task",
    description: "Read task reports: exact delivered memory, agent-reported applications, observed command results and explicit unknowns. Supply lesson for exact revision history across tasks. With neither task_id nor lesson, lists recent tasks without guessing which is yours. html writes a local private evidence view. Not a causal impact score, public export, or authority to execute verification commands.",
    inputSchema: { task_id: TaskIdSchema.optional(), lesson: LessonReferenceSchema.optional().describe("Exact kind and record_id, optionally content_hash, to inspect retained appearances across tasks. Partial indexing requires refreshing before pagination."), before: z.number().int().positive().optional(), html: z.boolean().optional(), cwd: z.string().optional() },
  }, async ({ task_id, lesson, before, html }) => {
    try {
      const root = getRoot();
      if (lesson) {
        if (task_id || html) throw new Error("choose lesson history or a task report, not both");
        const history = readLessonHistory(root, lesson, { before });
        return { content: [{ type: "text" as const, text: JSON.stringify(history) }], structuredContent: history as unknown as Record<string, unknown> };
      }
      if (before !== undefined) throw new Error("before requires a lesson reference");
      if (!task_id) {
        if (html) throw new Error("html requires an exact task_id");
        const tasks = listReportTasks(root);
        return { content: [{ type: "text" as const, text: tasks.length ? tasks.map(t => `${t.task_id} · ${t.state} · ${t.title}`).join("\n") : "No task reports yet. Start with hunch_task." }], structuredContent: { tasks } };
      }
      const report = readTaskReport(root, task_id, reportSourceSnapshot(root).hash);
      const file = html ? writeTaskReportHtml(root, task_id) : null;
      return { content: [{ type: "text" as const, text: `${renderTaskReport(report)}${file ? `\nLocal evidence view: ${file}` : ""}` }], structuredContent: { ...report, application_references: applicationReferences(report), contribution_card: renderTaskReport(report), report_path: file } as unknown as Record<string, unknown> };
    } catch (error) { return { isError: true, content: [{ type: "text" as const, text: `Invalid: ${(error as Error).message}` }] }; }
  });
}
