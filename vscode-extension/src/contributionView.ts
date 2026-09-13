/**
 * The "Contribution" view — one row per recent agent task in this repository,
 * newest first, showing what Hunch observed for it: lessons recalled, rules
 * held or violated, saves, denials, and the last independent check. Data comes
 * from `hunch task list --json` (the CLI owns the observation ledger; the
 * extension is a pure reader). Clicking a row opens its self-contained evidence
 * view in a webview. This is the host-neutral home for the card that Claude
 * Code otherwise prints through its Stop hook.
 */
import * as vscode from "vscode";
import * as fs from "node:fs";
import { runHunch } from "./cli.js";

/** Mirrors src/core/taskReport.TaskSummary (JSON consumer). */
export interface TaskSummary {
  task: { task_id: string; title: string; started_at: string; finished_at: string | null; state: "open" | "completed" | "interrupted" };
  deliveries: number;
  lessons: number;
  claims: number;
  saves: number;
  refusals: number;
  check: { label: string; state: "passed" | "failed" | "timed out" | "cancelled"; current: boolean } | null;
  violated: boolean;
  coverage: "no-delivery-observed" | "no-relevant-memory" | "delivered";
  empty: boolean;
  report_html: string | null;
  error: string | null;
}

function icon(s: TaskSummary): vscode.ThemeIcon {
  if (s.error) return new vscode.ThemeIcon("warning", new vscode.ThemeColor("notificationsWarningIcon.foreground"));
  if (s.violated || s.check?.state === "failed") return new vscode.ThemeIcon("error", new vscode.ThemeColor("notificationsErrorIcon.foreground"));
  if (s.refusals) return new vscode.ThemeIcon("shield", new vscode.ThemeColor("notificationsWarningIcon.foreground"));
  if (s.empty) return new vscode.ThemeIcon("circle-outline");
  if (s.check?.state === "passed") return new vscode.ThemeIcon("pass", new vscode.ThemeColor("testing.iconPassed"));
  if (s.task.state === "open") return new vscode.ThemeIcon("clock");
  return new vscode.ThemeIcon("book");
}

function describe(s: TaskSummary): string {
  if (s.error) return "ledger unavailable";
  if (s.empty) return "nothing observed";
  const parts: string[] = [];
  parts.push(s.lessons ? `${s.lessons} lesson${s.lessons === 1 ? "" : "s"}` : s.deliveries ? "delivered" : "no delivery");
  if (s.violated) parts.push("rule violated");
  else if (s.claims) parts.push(`${s.claims} applied`);
  if (s.saves) parts.push(`${s.saves} saved`);
  if (s.refusals) parts.push("denied");
  if (s.check) parts.push(`${s.check.state}${s.check.current ? "" : "*"}`);
  return parts.join(" · ");
}

export class TaskNode extends vscode.TreeItem {
  constructor(public readonly summary: TaskSummary) {
    super(summary.task.title, vscode.TreeItemCollapsibleState.None);
    const when = summary.task.started_at.slice(0, 16).replace("T", " ");
    this.description = `${when} · ${describe(summary)}`;
    this.iconPath = icon(summary);
    this.contextValue = "hunchTask";
    this.tooltip = new vscode.MarkdownString([
      `**${summary.task.title}** · \`${summary.task.task_id}\` · ${summary.task.state}`,
      "",
      summary.error ? `Ledger unavailable: ${summary.error}` : summary.empty
        ? "No task-linked delivery, check, save, or denial was observed. This does not establish that the agent did not use Hunch."
        : [
          `Deliveries: ${summary.deliveries} (${summary.lessons} distinct lesson${summary.lessons === 1 ? "" : "s"})`,
          `Applied: ${summary.claims} · Saved: ${summary.saves} · Denied: ${summary.refusals}${summary.violated ? " · **rule violated**" : ""}`,
          summary.check ? `Checked: ${summary.check.label} — ${summary.check.state}${summary.check.current ? "" : " (source changed since)"}` : "Checked: no independent command result recorded",
        ].join("  \n"),
      "",
      "_Click to open the evidence view (local, may contain private memory)._",
    ].join("\n"));
    this.command = { command: "hunch.contribution.open", title: "Open contribution evidence", arguments: [this] };
  }
}

export class ContributionTreeProvider implements vscode.TreeDataProvider<TaskNode> {
  private readonly _changed = new vscode.EventEmitter<void>();
  readonly onDidChangeTreeData = this._changed.event;
  private summaries: TaskSummary[] = [];
  private loaded = false;

  constructor(private readonly root: string | undefined) {}

  refresh(): void {
    void this.load().then(() => this._changed.fire());
  }

  private async load(): Promise<void> {
    this.loaded = true;
    if (!this.root) { this.summaries = []; return; }
    const res = await runHunch(this.root, ["task", "list", "--json"]);
    try { this.summaries = res.ok ? JSON.parse(res.stdout) as TaskSummary[] : []; } catch { this.summaries = []; }
  }

  getTreeItem(node: TaskNode): vscode.TreeItem { return node; }

  async getChildren(element?: TaskNode): Promise<TaskNode[]> {
    if (element) return [];
    if (!this.loaded) await this.load();
    return this.summaries.map((s) => new TaskNode(s));
  }
}

/** The evidence view is written by the CLI (self-contained HTML, no active
 * content) and shown in a webview so it never leaves the editor. */
export async function openTaskEvidence(root: string, node: TaskNode): Promise<void> {
  const res = await runHunch(root, ["report", node.summary.task.task_id, "--html"]);
  const file = node.summary.report_html ?? (res.ok ? res.stdout.trim().split("\n").find((l) => l.endsWith(".html")) ?? null : null);
  if (!file || !fs.existsSync(file)) {
    return void vscode.window.showWarningMessage(`Hunch: no evidence view for ${node.summary.task.task_id}${res.ok ? "" : ` — ${res.stderr.trim() || "report failed"}`}`);
  }
  const panel = vscode.window.createWebviewPanel("hunch.contribution", `Hunch · ${node.summary.task.title}`, vscode.ViewColumn.Beside, { enableScripts: false });
  panel.webview.html = fs.readFileSync(file, "utf8");
}
