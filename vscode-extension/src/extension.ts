/**
 * Hunch — VS Code extension. ONE job: the memory loop, in the editor.
 *   • READ — "Why is this the way it is?": invariants in scope, shaping
 *     decisions, bug history, and blast radius for the active file (and the
 *     symbol under the cursor), plus a hover on symbols that carry signal and
 *     a status-bar count of the invariants guarding the file.
 *   • WRITE — one Capture… command (decision / invariant / bug). Decisions go
 *     through the same `hunch mcp` write path Claude Code uses; invariants and
 *     bugs delegate to the CLI. The extension never writes .hunch/ JSON itself.
 *   • FEEL — "Hunch: Journey", one read-only screen: the memory curve rising,
 *     catches earned, what the repo learned this week, one next action. The
 *     🧠 status item is its front door.
 *   • AGENTS — language-model tools (why / context / query) feed Copilot and
 *     friends invisibly.
 *   • MEMORY — a source-control-style "Hunch Memory" activity-bar view: a
 *     timeline of every move Hunch made (capture/adopt/supersede/prune), each
 *     one a click-to-diff popup and a right-click local revert, with Sync /
 *     Adopt / Approve-to-push title actions. Memory auto-commits in the
 *     background; this view is where it becomes visible + reversible.
 */
import * as vscode from "vscode";
import * as fs from "node:fs";
import * as nodePath from "node:path";
import {
  loadHunch, why, constraintsInScope, nearConstraints,
  symbolSignals, bugsForSymbol, type Hunch,
} from "./hunchData.js";
import { HunchHoverProvider } from "./providers.js";
import { runSearch } from "./search.js";
import { showJourney, resolveWikiGraph } from "./journey.js";
import { cliCommand, runHunchWithProgress } from "./cli.js";
import { registerLmTools } from "./lmTools.js";
import { HunchMcp } from "./mcpClient.js";
import { MemoryTreeProvider, openMove, revertMove, syncNow, adoptDrafts, approveAndPush, setFirmness, openPolicyCard, openEscalation, activatePolicy, demotePolicy, withdrawPolicy, retirePolicy, type MoveNode, type PolicyNode, type EscalationNode } from "./memoryView.js";

function workspaceRoot(): string | undefined {
  return vscode.workspace.workspaceFolders?.[0]?.uri.fsPath;
}

function relPath(file: string): string {
  const root = workspaceRoot();
  if (!root) return file;
  const prefix = root.endsWith(nodePath.sep) ? root : root + nodePath.sep;
  return file.startsWith(prefix) ? file.slice(prefix.length) : file;
}

/** A reload-on-demand cache so the providers share one parse of .hunch/
 *  instead of each re-reading from disk on every keystroke. */
class HunchCache {
  private cached: Hunch | null = null;
  private loaded = false;
  constructor(private root: string | undefined) {}
  reload(): Hunch | null {
    this.cached = this.root ? loadHunch(this.root) : null;
    this.loaded = true;
    return this.cached;
  }
  get(): Hunch | null {
    if (!this.loaded) this.reload();
    return this.cached;
  }
}

// ---------------------------------------------------------------------------
// The brief: one webview answering "why is this the way it is?"
// ---------------------------------------------------------------------------
function esc(s: string): string {
  return s.replace(/[&<>]/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;" }[c]!));
}

function showBrief(title: string, sections: Array<{ h: string; lines: string[] }>): void {
  const panel = vscode.window.createWebviewPanel("hunchBrief", title, vscode.ViewColumn.Beside, {});
  const body = sections
    .filter((s) => s.lines.length)
    .map((s) => `<h3>${esc(s.h)}</h3><ul>${s.lines.map((l) => `<li>${esc(l)}</li>`).join("")}</ul>`)
    .join("");
  panel.webview.html = `<!DOCTYPE html><html><head><meta charset="utf-8"><style>
    body{font-family:var(--vscode-font-family);padding:0 16px;color:var(--vscode-foreground)}
    h2{border-bottom:1px solid var(--vscode-panel-border)} h3{margin-top:1.2em}
    li{margin:.3em 0;line-height:1.4} code{color:var(--vscode-textPreformat-foreground)}
  </style></head><body><h2>${esc(title)}</h2>${body || "<p><em>Hunch has nothing recorded for this yet — it is still learning this file.</em></p>"}</body></html>`;
}

/** The file brief — plus a symbol section when the cursor sits on a symbol
 *  Hunch has signal for, so one command answers both questions. */
function whyBrief(hunch: Hunch, file: string, symbol?: string): void {
  const w = why(hunch, file);
  const near = nearConstraints(hunch, file);
  const sections: Array<{ h: string; lines: string[] }> = [];
  if (symbol) {
    const sig = symbolSignals(hunch, file).get(symbol);
    const bugs = bugsForSymbol(hunch, file, symbol);
    if (sig || bugs.length) {
      sections.push(
        { h: `🔎 \`${symbol}\` — signal`, lines: sig ? [sig.evidence] : [] },
        { h: `🐞 \`${symbol}\` — bug history`, lines: bugs.map((b) => `[${b.severity}/${b.status}] ${b.title} — root cause: ${b.root_cause ?? ""}`) },
      );
    }
  }
  sections.push(
    { h: "⛔ Invariants (must not break)", lines: w.constraints.map((c) => `[${c.severity}] ${c.statement}  (${c.id})`) },
    { h: "⚠ Near-invariants (a guarded dependency)", lines: near.map((n) => `[${n.c.severity}] ${n.c.statement}  ·  via ${relPath(n.via)}`) },
    { h: "🧭 Decisions", lines: w.decisions.map((d) => `[${d.status}] ${d.title} — ${d.decision ?? ""}`) },
    { h: "🐞 Bug history", lines: w.bugs.map((b) => `[${b.severity}] ${b.title} — root cause: ${b.root_cause ?? ""}`) },
    { h: "💥 Blast radius (dependents)", lines: w.dependents.map((d) => `${d.name} @ ${relPath(d.file)}`) },
  );
  showBrief(symbol ? `🧠 Why: ${symbol}  ·  ${relPath(file)}` : `🧠 Why: ${relPath(file)}`, sections);
}

// ---------------------------------------------------------------------------
// Status bar: how many invariants guard the active file.
// ---------------------------------------------------------------------------
function updateStatusBar(item: vscode.StatusBarItem, cache: HunchCache): void {
  const cfg = vscode.workspace.getConfiguration("hunch");
  const editor = vscode.window.activeTextEditor;
  if (!cfg.get("statusBar.enabled", true) || !editor) {
    item.hide();
    return;
  }
  const hunch = cache.get();
  if (!hunch) {
    item.hide();
    return;
  }
  const file = relPath(editor.document.uri.fsPath);
  const cons = constraintsInScope(hunch, file);
  const near = nearConstraints(hunch, file);
  if (!cons.length && !near.length) {
    item.text = "$(shield) Hunch";
    item.tooltip = "No invariants for this file";
  } else {
    const blocking = cons.filter((c) => c.severity === "blocking").length;
    const nearSuffix = near.length ? ` +${near.length} near` : "";
    item.text = `$(shield)${blocking ? "$(warning)" : ""} ${cons.length} invariant${cons.length === 1 ? "" : "s"}${nearSuffix}`;
    const md = new vscode.MarkdownString(
      [
        ...cons.map((c) => `- **[${c.severity}]** ${c.statement}`),
        ...near.map((n) => `- ⚠ _near_ **[${n.c.severity}]** ${n.c.statement}`),
      ].join("\n"),
    );
    item.tooltip = md;
  }
  item.command = "hunch.why";
  item.show();
}

// ---------------------------------------------------------------------------
// Capture… — the single write path (decision / invariant / bug).
// ---------------------------------------------------------------------------
/** Ask before a split-private workspace writes a record. Shared mode already homes
 * every capture in its overlay, while a split-private workspace needs an explicit
 * choice so a sensitive lesson is never silently committed to the code repo. */
async function choosePrivateWrite(cache: HunchCache, kind: string): Promise<boolean | undefined> {
  const overlay = cache.get()?.overlay;
  if (overlay?.state !== "active" || overlay.mode !== "private") return false;
  const pick = await vscode.window.showQuickPick([
    { label: "Private overlay", description: `Keep this ${kind} local; deterministic synthesis only`, private: true },
    { label: "Public memory", description: `Commit this ${kind} with the repository`, private: false },
  ], { title: `Store this ${kind} in…`, placeHolder: "Private is recommended for sensitive workflow details" });
  return pick?.private;
}

async function captureDecision(mcp: HunchMcp, cache: HunchCache, onDone: () => void): Promise<void> {
  const title = await vscode.window.showInputBox({ title: "Capture decision", prompt: "What did you decide? (one line)", placeHolder: "Vectors are a derived layer, never the source of truth" });
  if (!title) return;
  const decision = await vscode.window.showInputBox({ title: "Capture decision — substance", prompt: "The decision itself: what holds from now on" });
  if (!decision) return;
  const context = await vscode.window.showInputBox({ title: "Capture decision — why (optional)", prompt: "What forced the choice; what was rejected" }) ?? "";
  const isPrivate = await choosePrivateWrite(cache, "decision");
  if (isPrivate === undefined) return;
  try {
    await vscode.window.withProgress({ location: vscode.ProgressLocation.Notification, title: "Hunch: recording decision…" }, () =>
      mcp.call("hunch_record_decision", { decision: { title, decision, ...(context.trim() ? { context } : {}), status: "accepted", ...(isPrivate ? { private: true } : {}) } }));
    vscode.window.showInformationMessage(`Hunch: decision recorded — “${title}”`);
    cache.reload();
    onDone();
  } catch (e) {
    vscode.window.showErrorMessage(`Hunch: could not record the decision — ${e instanceof Error ? e.message : String(e)}`);
  }
}

async function captureInvariant(root: string, cache: HunchCache, onDone: () => void): Promise<void> {
  const activeFile = vscode.window.activeTextEditor ? relPath(vscode.window.activeTextEditor.document.uri.fsPath) : "";
  const statement = await vscode.window.showInputBox({ title: "Capture invariant", prompt: "The invariant the codebase must not break", placeHolder: "vectors are derived, never the source of truth" });
  if (!statement) return;
  const scope = await vscode.window.showInputBox({ title: "Capture invariant — scope", prompt: "Comma-separated path/glob(s)", value: activeFile });
  if (scope === undefined) return;
  const severity = await vscode.window.showQuickPick(["warning", "blocking", "advisory"], { title: "Capture invariant — severity" });
  if (!severity) return;
  const rationale = await vscode.window.showInputBox({ title: "Capture invariant — rationale (optional)", prompt: "Why it must hold" }) ?? "";
  const isPrivate = await choosePrivateWrite(cache, "invariant");
  if (isPrivate === undefined) return;
  const args = ["record-constraint", statement, "--severity", severity];
  if (scope.trim()) args.push("--scope", scope.trim());
  if (rationale.trim()) args.push("--rationale", rationale.trim());
  if (isPrivate) args.push("--private");
  const res = await runHunchWithProgress(root, args, "Hunch: recording invariant…");
  if (res.ok) {
    vscode.window.showInformationMessage((res.stdout.trim().split("\n").pop()) || "Hunch: invariant recorded.");
    cache.reload();
    onDone();
  }
}

async function captureBug(root: string, cache: HunchCache, onDone: () => void): Promise<void> {
  const test = await vscode.window.showInputBox({ title: "Capture bug", prompt: "Failing test id / name", placeHolder: "auth.test.ts > rejects expired token" });
  if (!test) return;
  const message = await vscode.window.showInputBox({ title: "Capture bug — failure", prompt: "Failure message / stack" });
  if (!message) return;
  const isPrivate = await choosePrivateWrite(cache, "bug");
  if (isPrivate === undefined) return;
  const args = ["record-bug", "--test", test, "--message", message];
  if (isPrivate) args.push("--private");
  const res = await runHunchWithProgress(root, args, "Hunch: recording bug…");
  if (res.ok) { vscode.window.showInformationMessage(res.stdout.trim().split("\n").pop() || "Hunch: bug recorded."); cache.reload(); onDone(); }
}

async function capture(root: string, mcp: HunchMcp, cache: HunchCache, onDone: () => void): Promise<void> {
  const pick = await vscode.window.showQuickPick([
    { label: "$(lightbulb) Decision", description: "What you decided and why — the default", capture: "decision" },
    { label: "$(shield) Invariant", description: "A rule the codebase must not break", capture: "invariant" },
    { label: "$(bug) Bug", description: "A failure worth remembering (root cause, never-twice)", capture: "bug" },
  ], { title: "Capture into engineering memory", placeHolder: "What kind of memory is this?" });
  if (!pick) return;
  if (pick.capture === "decision") return captureDecision(mcp, cache, onDone);
  if (pick.capture === "invariant") return captureInvariant(root, cache, onDone);
  return captureBug(root, cache, onDone);
}

// ---------------------------------------------------------------------------
// Activation
// ---------------------------------------------------------------------------
export function activate(context: vscode.ExtensionContext): void {
  const root = workspaceRoot();
  const cache = new HunchCache(root);
  cache.reload();

  const status = vscode.window.createStatusBarItem(vscode.StatusBarAlignment.Right, 100);
  context.subscriptions.push(status);
  // The Journey front door: the repo's memory count, always visible, one click
  // from the story. Shares hunch.statusBar.enabled with the invariant counter.
  const journeyStatus = vscode.window.createStatusBarItem(vscode.StatusBarAlignment.Right, 99);
  context.subscriptions.push(journeyStatus);
  const updateJourneyStatus = (): void => {
    const h = cache.get();
    if (!h || !vscode.workspace.getConfiguration("hunch").get("statusBar.enabled", true)) return void journeyStatus.hide();
    journeyStatus.text = `🧠 ${h.decisions.length}`;
    journeyStatus.tooltip = `Engineering memory: ${h.decisions.length} decisions · ${h.constraints.length} invariants — open the Journey`;
    journeyStatus.command = "hunch.journey";
    journeyStatus.show();
  };

  const mcp = root ? new HunchMcp(root) : null;
  if (mcp) context.subscriptions.push({ dispose: () => mcp.dispose() });

  // The "Hunch Memory" activity-bar view: a source-control-style timeline of every
  // memory move (capture/adopt/supersede/prune), each reviewable + revertable.
  const memoryTree = new MemoryTreeProvider(root);
  context.subscriptions.push(vscode.window.createTreeView("hunch.memory", { treeDataProvider: memoryTree }));

  const hover = new HunchHoverProvider(() => cache.get(), relPath);
  const SELECTOR: vscode.DocumentSelector = [
    { language: "typescript" }, { language: "javascript" }, { language: "typescriptreact" },
    { language: "javascriptreact" }, { language: "python" }, { language: "go" }, { language: "rust" },
  ];
  context.subscriptions.push(vscode.languages.registerHoverProvider(SELECTOR, hover));
  registerLmTools(context, () => cache.get(), () => root);

  const refreshAll = () => {
    cache.reload();
    updateStatusBar(status, cache);
    updateJourneyStatus();
    memoryTree.refresh();
  };

  const cursorSymbol = (): string | undefined => {
    const ed = vscode.window.activeTextEditor;
    const wr = ed?.document.getWordRangeAtPosition(ed.selection.active);
    return wr ? ed!.document.getText(wr) : undefined;
  };
  const withHunch = (fn: (b: Hunch, file: string) => void) => {
    const file = vscode.window.activeTextEditor?.document.uri.fsPath;
    const hunch = cache.get();
    if (!hunch) return void vscode.window.showWarningMessage("No Hunch graph (.hunch/) found — run `hunch init`.");
    if (!file) return void vscode.window.showWarningMessage("Open a file first.");
    fn(hunch, relPath(file));
  };

  context.subscriptions.push(
    vscode.commands.registerCommand("hunch.why", () => withHunch((b, f) => whyBrief(b, f, cursorSymbol()))),
    // Kept as the hover deep-link target; hidden from the command palette.
    vscode.commands.registerCommand("hunch.whySymbol", (name?: string) =>
      withHunch((b, f) => whyBrief(b, f, name ?? cursorSymbol())),
    ),
    vscode.commands.registerCommand("hunch.search", () => {
      const h = cache.get();
      if (!h || !root) return void vscode.window.showWarningMessage("No Hunch graph (.hunch/) found.");
      runSearch(h, root);
    }),
    vscode.commands.registerCommand("hunch.capture", () => {
      if (!root || !mcp) return void vscode.window.showWarningMessage("No workspace folder open.");
      void capture(root, mcp, cache, refreshAll);
    }),
    vscode.commands.registerCommand("hunch.journey", () => {
      const h = cache.get();
      if (!h || !root) return void vscode.window.showWarningMessage("No Hunch graph (.hunch/) found — run `hunch init`.");
      void showJourney(root, h);
    }),
    // Journey door: draft triage stays in the CLI — this just opens it there.
    vscode.commands.registerCommand("hunch.reviewInTerminal", () => {
      if (!root) return;
      const term = vscode.window.createTerminal({ name: "hunch review", cwd: root });
      term.show();
      term.sendText(`${cliCommand()} review`, true);
    }),
    // Journey door: the wiki's interactive memory graph, in the browser (the
    // full-window edition; Journey embeds the same data inline). The private
    // overlay wiki wins when it has one; otherwise the public wiki; otherwise
    // say how to generate it.
    vscode.commands.registerCommand("hunch.memoryGraph", () => {
      if (!root) return void vscode.window.showWarningMessage("No workspace folder open.");
      const overlay = cache.get()?.overlay;
      const wiki = resolveWikiGraph(root, overlay);
      if (!wiki) {
        return void vscode.window.showInformationMessage(
          `No memory graph generated yet — run \`${cliCommand()} wiki${overlay?.state === "active" ? " --private" : ""}\` first.`);
      }
      void vscode.env.openExternal(vscode.Uri.file(wiki.graphHtmlPath));
    }),
    // --- Hunch Memory view (source-control-style timeline) -----------------
    vscode.commands.registerCommand("hunch.memory.refresh", () => memoryTree.refresh()),
    vscode.commands.registerCommand("hunch.openMove", (node?: MoveNode) => { if (root && node) void openMove(root, node); }),
    vscode.commands.registerCommand("hunch.revertMove", (node?: MoveNode) => { if (root && node) void revertMove(root, node, refreshAll); }),
    vscode.commands.registerCommand("hunch.memory.sync", () => { if (root) void syncNow(root, refreshAll); }),
    vscode.commands.registerCommand("hunch.memory.adopt", () => { if (root) void adoptDrafts(root, refreshAll); }),
    vscode.commands.registerCommand("hunch.memory.push", () => { if (root) void approveAndPush(root, refreshAll); }),
    vscode.commands.registerCommand("hunch.memory.strictness", () => { if (root) void setFirmness(root, refreshAll); }),
    // --- Constitution section (Phase 4: inline vouch from the panel) --------
    vscode.commands.registerCommand("hunch.openPolicyCard", (node?: PolicyNode) => { if (root && node) void openPolicyCard(root, node); }),
    vscode.commands.registerCommand("hunch.openEscalation", (node?: EscalationNode) => { if (node) void openEscalation(node); }),
    vscode.commands.registerCommand("hunch.activatePolicy", (node?: PolicyNode) => { if (root && node) void activatePolicy(root, node, refreshAll); }),
    vscode.commands.registerCommand("hunch.demotePolicy", (node?: PolicyNode) => { if (root && node) void demotePolicy(root, node, refreshAll); }),
    vscode.commands.registerCommand("hunch.withdrawPolicy", (node?: PolicyNode) => { if (root && node) void withdrawPolicy(root, node, refreshAll); }),
    vscode.commands.registerCommand("hunch.retirePolicy", (node?: PolicyNode) => { if (root && node) void retirePolicy(root, node, refreshAll); }),
  );

  // live refresh when the Hunch changes on disk (incl. the private overlay)
  if (root) {
    const watcher = vscode.workspace.createFileSystemWatcher(new vscode.RelativePattern(root, ".hunch/**/*.json"));
    watcher.onDidChange(refreshAll);
    watcher.onDidCreate(refreshAll);
    watcher.onDidDelete(refreshAll);
    context.subscriptions.push(watcher);
  }
  const overlay = cache.get()?.overlay;
  if (overlay?.state === "active") {
    const overlayWatcher = vscode.workspace.createFileSystemWatcher(new vscode.RelativePattern(overlay.dir, "**/*.json"));
    overlayWatcher.onDidChange(refreshAll);
    overlayWatcher.onDidCreate(refreshAll);
    overlayWatcher.onDidDelete(refreshAll);
    context.subscriptions.push(overlayWatcher);
  }

  context.subscriptions.push(
    vscode.window.onDidChangeActiveTextEditor(() => updateStatusBar(status, cache)),
    vscode.workspace.onDidSaveTextDocument(() => updateStatusBar(status, cache)),
  );
  updateStatusBar(status, cache);
  updateJourneyStatus();
}

export function deactivate(): void {
  /* subscriptions disposed by VS Code */
}
