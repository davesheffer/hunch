import type { Command } from "commander";
import { existsSync, mkdirSync, readFileSync } from "node:fs";
import { findRoot } from "../core/paths.js";
import { writeFileAtomic } from "../core/io.js";
import { finishReportTask, forgetReportTask, listReportTasks, listTaskSummaries, pruneReportHistory, readTaskReport, readLessonHistory, renderTaskStatusLine, startReportTask, summarizeTaskReport, taskReportStats, type TaskSummary } from "../core/taskReport.js";
import { promptTaskId } from "../core/taskReportHook.js";
import { DEFAULT_CHECK_TIMEOUT_MS, MAX_CHECK_TIMEOUT_MS, reportSourceSnapshot, runReportCheck, runReportConformance } from "../core/taskReportEvidence.js";
import { renderTaskReport, writeTaskReportHtml } from "../core/taskReportRender.js";
import { assertReportPath } from "../core/taskReportPaths.js";
import { publicTaskReport } from "../core/taskReportPublic.js";
import { mergeDurableTaskSummaries, persistTaskRecord } from "../core/taskRecord.js";
import { evaluateTaskRanking, renderRankEval } from "../core/taskRankEval.js";
import { rankingStatusLine, refreshRankEval, resolveTaskRankingMode } from "../core/taskRankingMode.js";
import { taskRecordStats } from "../core/taskRecordStats.js";
import type { HunchStore } from "../store/hunchStore.js";
import { registerTaskBenchmarkCommand } from "./taskBenchmark.js";

export function registerTaskReportCommands(program: Command, openStore: () => { store: HunchStore; root: string }): void {
  const task = program.command("task").description("Record an explicit task lifecycle for Hunch contribution reports");
  registerTaskBenchmarkCommand(task);
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
      // The finished task becomes graph memory (.hunch/tasks/) through the normal
      // capture path. A failed write is disclosed, never a reason to lose the card.
      let graph = "";
      try {
        const opened = openStore();
        try {
          const saved = persistTaskRecord(opened.root, opened.store, id);
          graph = saved
            ? `\nGraph     ${saved.changed ? "saved" : "already saved"} as ${saved.record.id} (${saved.home}${saved.flushed ? `, ${saved.flushed}` : ""})`
            : "\nGraph     nothing to keep (no observation, or task records disabled)";
        } finally { opened.store.close(); }
      } catch (error) { graph = `\nGraph     not saved: ${(error as Error).message}`; }
      console.log(renderTaskReport(readTaskReport(root, id, reportSourceSnapshot(root).hash)) + graph);
    });
  task.command("list").description("Recent tasks observed in this repository with what Hunch delivered, saved, guarded, and checked")
    .option("--limit <n>", "how many recent tasks (max 30)", "30")
    .option("--json", "machine-readable summaries (consumed by the VS Code Contribution view)")
    .action((opts: { limit: string; json?: boolean }) => {
      const root = findRoot();
      const limit = Number(opts.limit) || 30;
      let summaries = listTaskSummaries(root, limit, reportSourceSnapshot(root).hash);
      // Graph records (this machine's or a teammate's) join the local ledger view.
      try {
        const opened = openStore();
        try { summaries = mergeDurableTaskSummaries(opened.store, summaries, limit); } finally { opened.store.close(); }
      } catch { /* ledger-only view when the store is unavailable */ }
      if (opts.json) { console.log(JSON.stringify(summaries, null, 2)); return; }
      if (!summaries.length) { console.log("No task activity observed yet."); return; }
      for (const s of summaries) console.log(`${s.task.started_at.slice(0, 16).replace("T", " ")}  ${s.task.task_id}  ${s.task.state.padEnd(11)} ${renderTaskStatusLine(s) || "nothing observed"}${s.durable ? `  [graph: ${s.durable.home}${s.task.episode ? ` as ${s.task.episode}` : ""}]` : ""}${s.task.continues && !s.durable ? `  (continues ${s.task.continues})` : ""}`);
    });
  task.command("stats").description("Adherence over a window: how many prompts Hunch reached (delivery), checked, saved, or guarded — from the ledger, never from agent claims")
    .option("--days <days>", "window in days", "7")
    .option("--json", "machine-readable")
    .action((opts: { days: string; json?: boolean }) => {
      const stats = taskReportStats(findRoot(), Number(opts.days) || 7);
      if (opts.json) { console.log(JSON.stringify(stats, null, 2)); return; }
      const pct = (n: number) => stats.tasks ? `${Math.round((n / stats.tasks) * 100)}%` : "–";
      console.log(`Hunch adherence, last ${Number(opts.days) || 7} day(s): ${stats.tasks} task(s), ${stats.completed} completed`);
      console.log(`  reached by memory (delivery)  ${stats.with_delivery}  ${pct(stats.with_delivery)}`);
      console.log(`  independent check recorded    ${stats.with_check}  ${pct(stats.with_check)}`);
      console.log(`  application claimed by agent  ${stats.with_claim}  ${pct(stats.with_claim)}`);
      console.log(`  memory saved                  ${stats.with_save}  ${pct(stats.with_save)}`);
      console.log(`  edit denied                   ${stats.with_refusal}  ${pct(stats.with_refusal)}`);
      console.log(`  nothing observed              ${stats.empty}  ${pct(stats.empty)}`);
      // Graph-record proxies (dec_66925aa0ee): do agents redo verified work, or repeat a violation?
      try {
        const opened = openStore();
        try {
          const rs = taskRecordStats(opened.store.recs("tasks"));
          const rate = (r: number | null, n: number) => r === null ? "–" : `${Math.round(r * 100)}% of ${n}`;
          console.log(`Graph task records: ${rs.records}`);
          console.log(`  re-verified an earlier check (24h)  ${rate(rs.reverification_rate, rs.reverify_candidates)}`);
          console.log(`  repeated an earlier violation       ${rate(rs.repeat_violation_rate, rs.violation_candidates)}`);
          console.log(`  ${rankingStatusLine(resolveTaskRankingMode(opened.root, opened.store))}`);
        } finally { opened.store.close(); }
      } catch { /* no store: ledger stats only */ }
    });
  task.command("rank-eval").description("Offline leave-one-out check of task-record ranking against 'latest 3 on the file' (Hit@5, MRR, paired bootstrap CI); the pre-registered metric behind dec_66925aa0ee")
    .option("--since <days>", "only task records finished in the last N days", "365")
    .option("--split <fraction>", "evaluate the newest fraction of cases (temporal split)", "0.3")
    .option("--json", "machine-readable report")
    .action((opts: { since: string; split: string; json?: boolean }) => {
      const { store } = openStore();
      try {
        const cutoff = Date.now() - (Number(opts.since) || 365) * 86_400_000;
        const records = store.recs("tasks").filter((r) => (Date.parse(r.finished_at) || 0) >= cutoff);
        const report = evaluateTaskRanking(records, { split: Math.min(1, Math.max(0.05, Number(opts.split) || 0.3)) });
        // Keep the automatic cache current too, so delivery and `hunch now` agree with what was just printed.
        refreshRankEval(findRoot(), store, { force: true });
        console.log(opts.json ? JSON.stringify(report, null, 2) : renderRankEval(report));
      } finally { store.close(); }
    });
  task.command("status").description("One line for a terminal status line: the current prompt's task when Claude Code's status-line JSON arrives on stdin, otherwise the most recent task here")
    .option("--json", "machine-readable summary")
    .action(async (opts: { json?: boolean }) => {
      const input = process.stdin.isTTY ? "" : await readStdinText();
      let root = findRoot();
      let taskId: string | null = null;
      try {
        const host = input.trim() ? JSON.parse(input) as { cwd?: string; session_id?: string; prompt_id?: string; workspace?: { current_dir?: string } } : {};
        const dir = host.workspace?.current_dir ?? host.cwd;
        if (dir) root = findRoot(dir);
        if (host.session_id && host.prompt_id) taskId = promptTaskId(root, host.session_id, host.prompt_id);
      } catch { /* a malformed host payload falls back to the most recent task */ }
      let summary: TaskSummary | null = null;
      try {
        const snapshot = reportSourceSnapshot(root).hash;
        summary = taskId ? summarizeTaskReport(root, taskId, snapshot) : listTaskSummaries(root, 1, snapshot)[0] ?? null;
      } catch { summary = null; }
      if (opts.json) { console.log(JSON.stringify(summary)); return; }
      const line = renderTaskStatusLine(summary);
      if (line) console.log(line);
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
      let report: ReturnType<typeof readTaskReport>;
      try { report = readTaskReport(root, id, reportSourceSnapshot(root).hash); }
      catch (error) {
        // Not in this machine's ledger: the graph record (if any) is what remains.
        const opened = openStore();
        try {
          const record = opened.store.getRec("tasks", id);
          if (!record) throw error;
          console.log(opts.json ? JSON.stringify(record, null, 2) : `Task ${record.id} · ${record.state} · ${record.title}\nGraph record only (no local observation ledger for it here): ${record.lessons.length} lesson(s), ${record.applied.length} applied, ${record.saved.length} saved, ${record.checks.length} check(s), ${record.refusals} denied. Files: ${record.files.join(", ") || "none recorded"}.`);
          return;
        } finally { opened.store.close(); }
      }
      console.log(opts.json ? JSON.stringify(report, null, 2) : renderTaskReport(report));
    });
}

function readStdinText(): Promise<string> {
  return new Promise(resolve => {
    let data = "";
    const done = () => resolve(data);
    process.stdin.setEncoding("utf8");
    process.stdin.on("data", chunk => { data += chunk; });
    process.stdin.on("end", done);
    process.stdin.on("error", done);
    // A host that opened stdin but never writes must not hang the status line.
    setTimeout(done, 1500).unref();
  });
}
