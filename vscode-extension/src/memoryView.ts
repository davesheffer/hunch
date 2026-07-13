/**
 * The "Hunch Memory" activity-bar view — a Source-Control-style timeline of every
 * move Hunch made to the graph (capture / adopt / supersede / prune), newest first.
 *
 * Data comes from `hunch log --json` (the CLI owns git; the extension is a pure
 * reader). Clicking a move opens its `.hunch/` diff as a read-only popup; the
 * context menu reverts that single move LOCALLY (`hunch revert-move` → git revert,
 * never pushed). Title actions drive the seamless-but-inspectable flow: Sync now,
 * Adopt drafts, and Approve-to-push (the one outward step that needs a human).
 */
import * as vscode from "vscode";
import { runHunch, runHunchWithProgress } from "./cli.js";

/** One memory move — mirrors src/core/memorylog.MemoryMove (JSON consumer). */
export interface MemoryMove {
  sha: string;
  shortSha: string;
  date: string;
  subject: string;
  kind: "capture" | "adopt" | "supersede" | "prune" | "edit";
  decisionIds: string[];
  otherIds: string[];
  added: number;
  modified: number;
  deleted: number;
  files: string[];
}

const KIND_ICON: Record<MemoryMove["kind"], string> = {
  capture: "diff-added",
  adopt: "check",
  supersede: "sync",
  prune: "diff-removed",
  edit: "edit",
};
const KIND_LABEL: Record<MemoryMove["kind"], string> = {
  capture: "captured", adopt: "adopted", supersede: "superseded", prune: "pruned", edit: "edited",
};

export class MoveNode extends vscode.TreeItem {
  constructor(public readonly move: MemoryMove) {
    super(move.subject.replace(/^hunch:\s*/, ""), vscode.TreeItemCollapsibleState.None);
    const ids = [...move.decisionIds, ...move.otherIds];
    this.description = `${move.date.slice(0, 10)} · ${KIND_LABEL[move.kind]}${ids.length ? " · " + ids.slice(0, 2).join(",") : ""}`;
    this.iconPath = new vscode.ThemeIcon(KIND_ICON[move.kind]);
    this.contextValue = "hunchMove";
    this.tooltip = new vscode.MarkdownString(
      [
        `**${KIND_LABEL[move.kind]}** · \`${move.shortSha}\` · ${move.date.slice(0, 10)}`,
        ``,
        move.subject,
        ``,
        ids.length ? `Records: ${ids.map((i) => `\`${i}\``).join(" ")}` : "",
        `Files: +${move.added} ~${move.modified} −${move.deleted}`,
        ``,
        `_Click to see the diff · right-click to revert (local only)._`,
      ].join("\n"),
    );
    // Click → open the move's diff as a read-only popup.
    this.command = { command: "hunch.openMove", title: "Open memory move", arguments: [this] };
  }
}

export class MemoryTreeProvider implements vscode.TreeDataProvider<MoveNode> {
  private readonly _changed = new vscode.EventEmitter<void>();
  readonly onDidChangeTreeData = this._changed.event;
  private moves: MemoryMove[] = [];

  constructor(private readonly root: string | undefined) {}

  refresh(): void {
    void this.load().then(() => this._changed.fire());
  }

  private async load(): Promise<void> {
    if (!this.root) { this.moves = []; return; }
    const res = await runHunch(this.root, ["log", "--json", "-n", "150"]);
    if (!res.ok) { this.moves = []; return; }
    try { this.moves = JSON.parse(res.stdout) as MemoryMove[]; }
    catch { this.moves = []; }
  }

  getTreeItem(node: MoveNode): vscode.TreeItem { return node; }

  async getChildren(): Promise<MoveNode[]> {
    if (!this.moves.length) await this.load();
    return this.moves.map((m) => new MoveNode(m));
  }
}

/** Open a single move's `.hunch/` diff as a read-only popup (a diff-highlighted doc). */
export async function openMove(root: string, node: MoveNode): Promise<void> {
  const res = await runHunch(root, ["log", "--diff", node.move.sha]);
  const body = (res.stdout || res.stderr || "(no diff)").trim();
  const doc = await vscode.workspace.openTextDocument({ content: body, language: "diff" });
  await vscode.window.showTextDocument(doc, { preview: true, viewColumn: vscode.ViewColumn.Active });
}

/** Reject a move: git-revert that commit locally (never pushed). Confirms first. */
export async function revertMove(root: string, node: MoveNode, onDone: () => void): Promise<void> {
  const m = node.move;
  const pick = await vscode.window.showWarningMessage(
    `Revert this memory move?\n\n${m.subject}`,
    { modal: true, detail: `Creates a local git revert of ${m.shortSha}. Nothing is pushed. Delegates to \`hunch revert-move\`.` },
    "Revert move",
  );
  if (pick !== "Revert move") return;
  const res = await runHunchWithProgress(root, ["revert-move", m.sha], "Hunch: reverting memory move…");
  if (res.ok) {
    vscode.window.showInformationMessage(`Reverted ${m.shortSha} (local; not pushed).`);
    onDone();
  }
}

/** Sync now — re-derive memory from the latest commits (seamless, but on demand). */
export async function syncNow(root: string, onDone: () => void): Promise<void> {
  const res = await runHunchWithProgress(root, ["sync", "--commit", "--quiet"], "Hunch: syncing memory…");
  if (res.ok) onDone();
}

/** Adopt drafts — auto-trust any legacy un-vouched drafts as advisory memory. */
export async function adoptDrafts(root: string, onDone: () => void): Promise<void> {
  const res = await runHunchWithProgress(root, ["adopt-drafts"], "Hunch: adopting drafts…");
  if (res.ok) {
    vscode.window.showInformationMessage(res.stdout.trim().split("\n").pop() || "Hunch: drafts adopted.");
    onDone();
  }
}

/** Approve-to-push — the one outward step. Pushes the local memory commits to the
 *  remote after an explicit confirm (auto-commit stays local by design). */
export async function approveAndPush(root: string, onDone: () => void): Promise<void> {
  const pick = await vscode.window.showWarningMessage(
    "Push memory to the remote?",
    { modal: true, detail: "Hunch auto-commits memory LOCALLY; this publishes those commits to the git remote. Only do this when you're ready to share the memory." },
    "Push",
  );
  if (pick !== "Push") return;
  const res = await runHunchWithProgress(root, ["push"], "Hunch: pushing memory…");
  if (res.ok) { vscode.window.showInformationMessage("Hunch: memory pushed to the remote."); onDone(); }
}
