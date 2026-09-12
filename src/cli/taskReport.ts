import type { Command } from "commander";
import { existsSync, mkdirSync, readFileSync } from "node:fs";
import { findRoot } from "../core/paths.js";
import { writeFileAtomic } from "../core/io.js";
import { finishReportTask, forgetReportTask, listReportTasks, pruneReportHistory, readTaskReport, readLessonHistory, startReportTask } from "../core/taskReport.js";
import { DEFAULT_CHECK_TIMEOUT_MS, MAX_CHECK_TIMEOUT_MS, reportSourceSnapshot, runReportCheck, runReportConformance } from "../core/taskReportEvidence.js";
import { renderTaskReport, writeTaskReportHtml } from "../core/taskReportRender.js";
import { assertReportPath } from "../core/taskReportPaths.js";
import { publicTaskReport } from "../core/taskReportPublic.js";
import type { HunchStore } from "../store/hunchStore.js";

export function registerTaskReportCommands(program: Command, openStore: () => { store: HunchStore; root: string }): void {
  const task = program.command("task").description("Record an explicit task lifecycle for Hunch contribution reports");
  task.command("start <title>").option("--id <id>", "retry an exact existing task identity")
    .action((title: string, opts: { id?: string }) => console.log(JSON.stringify(startReportTask(findRoot(), title, opts.id), null, 2)));
  task.command("conform <id>").description("Evaluate each delivered lesson's declared rule against the changed files; Hunch computes the verdict, never the agent")
    .action((id: string) => {
      const { store, root } = openStore();
      try { console.log(JSON.stringify(runReportConformance(root, store, id), null, 2)); } finally { store.close(); }
    });
  task.command("finish <id>").option("--interrupted", "record interruption instead of completion")
    .action((id: string, opts: { interrupted?: boolean }) => {
      const root = findRoot();
      // Rule evaluation is Hunch's own observation; its failure is disclosed by
      // the report's unknowns and never blocks closing the task.
      if (!opts.interrupted) {
        try { const opened = openStore(); try { runReportConformance(opened.root, opened.store, id); } finally { opened.store.close(); } } catch { /* disclosed as unverified */ }
      }
      finishReportTask(root, id, opts.interrupted ? "interrupted" : "completed");
      console.log(renderTaskReport(readTaskReport(root, id, reportSourceSnapshot(root).hash)));
    });
  task.command("forget <id>").description("Delete this closed task's local observations and generated report; retains project memory")
    .action((id: string) => { forgetReportTask(findRoot(), id); console.log("Task report history removed; project memory retained."); });
  task.command("prune").description("Delete local report history for tasks closed more than the retention period ago")
    .option("--days <days>", "retention period in days", "90")
    .action((opts: { days: string }) => console.log(`Removed ${pruneReportHistory(findRoot(), Number(opts.days))} expired task report(s).`));
  task.command("presentation <mode>").description("Enable or disable automatic contribution cards; observations and memory remain available")
    .action((mode: string) => {
      if (mode !== "on" && mode !== "off") throw new Error("presentation must be on or off");
      const root = findRoot(), directory = assertReportPath(root, ".hunch"), file = assertReportPath(root, ".hunch", "local.json");
      const existing: unknown = existsSync(file) ? JSON.parse(readFileSync(file, "utf8")) : {};
      if (!existing || typeof existing !== "object" || Array.isArray(existing)) throw new Error("local.json must be an object; refusing to replace it");
      mkdirSync(directory, { recursive: true });
      writeFileAtomic(file, JSON.stringify({ ...existing, reportPresentation: mode === "on" }, null, 2) + "\n");
      console.log(`Automatic contribution cards ${mode}; task evidence remains available with hunch report.`);
    });
  task.command("verify <id> <command...>").description("Explicitly run a verification command and retain its result/hash, never raw output; use -- before the command")
    .option("--label <label>", "short name of the check", "Verification command")
    .option("--timeout <seconds>", `seconds before the command tree is stopped and recorded as timed out (max ${MAX_CHECK_TIMEOUT_MS / 1000})`, String(DEFAULT_CHECK_TIMEOUT_MS / 1000))
    .option("--json", "emit only the result JSON, suppressing live command output")
    .action(async (id: string, command: string[], opts: { label: string; timeout: string; json?: boolean }) => {
      const seconds = Number(opts.timeout);
      if (!Number.isInteger(seconds) || seconds < 1 || seconds * 1000 > MAX_CHECK_TIMEOUT_MS) throw new Error(`--timeout must be a whole number of seconds between 1 and ${MAX_CHECK_TIMEOUT_MS / 1000}`);
      const controller = new AbortController();
      let signalExit = 0;
      const interrupt = () => { signalExit = 130; controller.abort(); };
      const terminate = () => { signalExit = 143; controller.abort(); };
      process.on("SIGINT", interrupt); process.on("SIGTERM", terminate);
      try {
        const result = await runReportCheck(findRoot(), id, command, opts.label, seconds * 1000, {
          signal: controller.signal,
          onStdout: opts.json ? undefined : chunk => { process.stdout.write(chunk); },
          onStderr: opts.json ? undefined : chunk => { process.stderr.write(chunk); },
        });
        console.log(JSON.stringify(result, null, 2));
        if (signalExit || result.exit_code !== 0 || result.timed_out || result.cancelled) process.exitCode = signalExit || 1;
      } finally {
        process.removeListener("SIGINT", interrupt); process.removeListener("SIGTERM", terminate);
      }
    });
  program.command("report [id]").description("Inspect task-scoped memory delivery and independently observed command results")
    .option("--lesson <record-id>", "inspect retained appearances of this exact lesson across tasks")
    .option("--kind <kind>", "record kind for --lesson, for example constraints or decisions")
    .option("--revision <hash>", "restrict lesson history to one exact content hash")
    .option("--before <cursor>", "continue a fully indexed lesson history page")
    .option("--json", "machine-readable report")
    .option("--html", "write a self-contained private/local evidence view under .hunch-cache/reports")
    .option("--public-only", "export only exact revisions present in the public store, omitting task prose and execution details")
    .action((id: string | undefined, opts: { json?: boolean; html?: boolean; publicOnly?: boolean; lesson?: string; kind?: string; revision?: string; before?: string }) => {
      const root = findRoot();
      if (opts.lesson) {
        if (id || opts.html || opts.publicOnly || !opts.kind) throw new Error("lesson history requires --kind and cannot combine a task ID, --html or --public-only");
        console.log(JSON.stringify(readLessonHistory(root, { record_id: opts.lesson, kind: opts.kind, content_hash: opts.revision }, { before: opts.before === undefined ? undefined : Number(opts.before) }), null, 2));
        return;
      }
      if (opts.kind || opts.revision || opts.before) throw new Error("--kind, --revision and --before require --lesson");
      if (opts.json && opts.html) throw new Error("choose --json or --html");
      if (!id) {
        if (opts.html || opts.publicOnly) throw new Error("export requires an explicit task ID");
        const tasks = listReportTasks(root);
        console.log(opts.json ? JSON.stringify(tasks, null, 2) : tasks.length ? tasks.map(t => `${t.task_id} · ${t.state} · ${t.title.replace(/[\u0000-\u001f\u007f-\u009f]/g, " ")}`).join("\n") : "No task reports yet. Reconnect the agent after updating Hunch; task lifecycle calls create reports.");
        return;
      }
      if (opts.html) { console.log(writeTaskReportHtml(root, id, opts.publicOnly)); return; }
      if (opts.publicOnly) { console.log(JSON.stringify(publicTaskReport(root, id), null, 2)); return; }
      const report = readTaskReport(root, id, reportSourceSnapshot(root).hash);
      console.log(opts.json ? JSON.stringify(report, null, 2) : renderTaskReport(report));
    });
}
