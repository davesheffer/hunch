/**
 * Hunch — VS Code extension. A reader over the committed .hunch/ JSON that
 * brings the Engineering Memory into the editor:
 *   • Activity-bar tree (invariants / decisions / bugs / fragility / components,
 *     plus stale records and bug-lineage chains).
 *   • In-editor signal: CodeLens, hover, Problems-panel diagnostics, and
 *     overview-ruler marks for the active file.
 *   • "Why is this file the way it is?" + context briefs, a component graph, and
 *     a fuzzy search across every record.
 *   • A status-bar invariant counter.
 *   • A write-path that delegates to the `hunch` CLI (record-constraint /
 *     record-bug) — the extension never writes .hunch/ JSON itself.
 * Pairs with Claude Code chat (which uses the hunch_* MCP tools).
 */
import * as vscode from "vscode";
import * as cp from "node:child_process";
import * as nodePath from "node:path";
import {
  loadHunch, why, constraintsInScope, nearConstraints, isStale, sevRank,
  staleRecords, lineageChains, symbolSignals, bugsForSymbol, fragileSymbols,
  reviewQueue, type Hunch, type Provenance, type LineageNode, type Bug, type ReviewItem,
} from "./hunchData.js";
import { HunchCodeLensProvider, HunchHoverProvider } from "./providers.js";
import { HunchDiagnostics } from "./diagnostics.js";
import { HunchDecorations } from "./decorations.js";
import { showGraph, refreshGraph } from "./graph.js";
import { runSearch } from "./search.js";
import { acceptDraft, rejectDraft, acceptVerified, rejectDuplicates, openDraftFile, draftBrief, autoReview } from "./review.js";
import { runCommandHub } from "./commands.js";
import { openChangeGate } from "./changeGate.js";
import { runHunchWithProgress } from "./cli.js";

function workspaceRoot(): string | undefined {
  return vscode.workspace.workspaceFolders?.[0]?.uri.fsPath;
}

function relPath(file: string): string {
  const root = workspaceRoot();
  if (!root) return file;
  const prefix = root.endsWith(nodePath.sep) ? root : root + nodePath.sep;
  return file.startsWith(prefix) ? file.slice(prefix.length) : file;
}

/** git author-date (ms) of the last commit touching a file; 0 if unknown. */
function lastChangeMs(root: string, file: string): number {
  try {
    const out = cp.execFileSync("git", ["log", "-1", "--format=%aI", "--", file], { cwd: root, encoding: "utf8", stdio: ["ignore", "pipe", "ignore"] }).trim();
    return out ? Date.parse(out) : 0;
  } catch {
    return 0;
  }
}

/** A reload-on-demand cache so the many providers share one parse of .hunch/
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
// Tree view
// ---------------------------------------------------------------------------
type Cmd = { command: string; args: unknown[] };
type Node =
  | { kind: "group"; label: string; key: string; description?: string; contextValue?: string }
  | { kind: "leaf"; label: string; description?: string; tooltip?: string; file?: string; cmd?: Cmd; contextValue?: string; draftId?: string; icon?: string }
  | { kind: "tree"; label: string; description?: string; tooltip?: string; file?: string; children: Node[]; contextValue?: string };

class HunchTree implements vscode.TreeDataProvider<Node> {
  private _onDidChange = new vscode.EventEmitter<void>();
  readonly onDidChangeTreeData = this._onDidChange.event;
  constructor(private cache: HunchCache) {}

  refresh(): void { this._onDidChange.fire(); }

  getTreeItem(n: Node): vscode.TreeItem {
    if (n.kind === "group") {
      const expanded = n.key === "review" || n.key === "review.ready";
      const item = new vscode.TreeItem(n.label, expanded ? vscode.TreeItemCollapsibleState.Expanded : vscode.TreeItemCollapsibleState.Collapsed);
      item.iconPath = new vscode.ThemeIcon(GROUP_ICONS[n.key] ?? "circle-outline");
      item.description = n.description;
      if (n.contextValue) item.contextValue = n.contextValue;
      return item;
    }
    const collapsible = n.kind === "tree" && n.children.length
      ? vscode.TreeItemCollapsibleState.Collapsed
      : vscode.TreeItemCollapsibleState.None;
    const item = new vscode.TreeItem(n.label, collapsible);
    item.description = n.description;
    item.tooltip = n.tooltip ?? n.label;
    if (n.kind === "leaf" && n.icon) item.iconPath = new vscode.ThemeIcon(n.icon);
    if (n.contextValue) item.contextValue = n.contextValue;
    if (n.file) {
      item.command = { command: "vscode.open", title: "Open", arguments: [vscode.Uri.file(n.file)] };
      item.resourceUri = vscode.Uri.file(n.file);
    } else if (n.kind === "leaf" && n.cmd) {
      item.command = { command: n.cmd.command, title: "", arguments: n.cmd.args };
    }
    return item;
  }

  getChildren(node?: Node): Node[] {
    const b = this.cache.get();
    if (!b) return node ? [] : [{ kind: "leaf", label: "No .hunch/ found — run `hunch init`" }];
    if (node?.kind === "tree") return node.children;
    if (!node) {
      const stale = staleRecords(b, (f) => lastChangeMs(b.root, f));
      const chains = lineageChains(b);
      const rq = reviewQueue(b);
      const pending = rq.ready.length + rq.scrutiny.length;
      return [
        ...(b.overlay ? [{ kind: "leaf" as const, label: b.overlay.mode === "shared" ? "Shared memory" : "Private memory", description: b.overlay.state === "active" ? "local overlay included" : "⚠ overlay unavailable", tooltip: b.overlay.state === "active" ? "This local editor view includes overlay memory. It is never posted by public CI." : "The configured private/shared overlay directory is unavailable. Run `hunch doctor` to repair the pointer.", icon: b.overlay.state === "active" ? "lock" : "warning" }] : []),
        ...(pending ? [{ kind: "group" as const, label: `Review queue (${pending})`, key: "review", contextValue: "hunch.reviewQueue" }] : []),
        { kind: "group", label: `Invariants (${b.constraints.length})`, key: "constraints" },
        { kind: "group", label: `Decisions (${b.decisions.length})`, key: "decisions" },
        { kind: "group", label: `Bugs (${b.bugs.length})`, key: "bugs" },
        ...(chains.length ? [{ kind: "group" as const, label: `Bug lineage (${chains.length})`, key: "lineage" }] : []),
        { kind: "group", label: `Fragile symbols`, key: "fragile" },
        { kind: "group", label: `Components (${b.components.length})`, key: "components" },
        ...(stale.length ? [{ kind: "group" as const, label: `Stale records (${stale.length})`, key: "stale" }] : []),
      ];
    }
    if (node.kind !== "group") return [];
    const root = b.root;
    switch (node.key) {
      case "review": {
        const rq = reviewQueue(b);
        const groups: Node[] = [];
        if (rq.ready.length) groups.push({ kind: "group", label: `Ready to confirm (${rq.ready.length})`, key: "review.ready", contextValue: "hunch.reviewReady" });
        if (rq.scrutiny.length) groups.push({ kind: "group", label: `Needs scrutiny (${rq.scrutiny.length})`, key: "review.scrutiny" });
        return groups;
      }
      case "review.ready":
        return reviewQueue(b).ready.map((it) => draftLeaf(it));
      case "review.scrutiny":
        return reviewQueue(b).scrutiny.map((it) => draftLeaf(it));
      case "constraints":
        return [...b.constraints].sort((x, y) => sevRank(y.severity) - sevRank(x.severity)).map((c) => ({
          kind: "leaf", label: `[${c.severity}] ${c.statement}`,
          description: prov(c.provenance) + (isStale(c, (f) => lastChangeMs(root, f)) ? " ⚠stale" : ""),
          tooltip: `${c.id}\nscope: ${(c.scope ?? []).join(", ")}\n${c.rationale ?? ""}`,
          cmd: { command: "hunch.revealScope", args: [c.scope ?? []] },
        }));
      case "decisions":
        return b.decisions.map((d) => ({
          kind: "leaf", label: `[${d.status}] ${d.title}`,
          description: prov(d.provenance) + (isStale(d, (f) => lastChangeMs(root, f)) ? " ⚠stale" : ""),
          tooltip: `${d.id}\n${d.decision ?? ""}`,
          file: firstFile(root, d.related_files),
        }));
      case "bugs":
        return b.bugs.map((bug) => bugLeaf(root, bug));
      case "lineage":
        return lineageChains(b).map((n) => lineageNode(root, n));
      case "fragile":
        return fragileLeaves(b, root);
      case "components":
        return b.components.map((c) => ({
          kind: "leaf", label: c.name,
          description: (c.fragility ? `fragility ${c.fragility}` : "") + ` ${(c.paths ?? []).join(", ")}`,
          tooltip: `${c.id}\n${c.responsibility ?? ""}`,
        }));
      case "stale":
        return staleRecords(b, (f) => lastChangeMs(root, f)).map((s) => ({
          kind: "leaf", label: `${STALE_ICON[s.kind]} ${s.label}`, description: s.kind,
          tooltip: `${s.id}\nguarded file changed since last verification`,
          file: s.file ? absFile(root, s.file) : undefined,
        }));
      default:
        return [];
    }
  }
}

const GROUP_ICONS: Record<string, string> = {
  review: "checklist", "review.ready": "pass", "review.scrutiny": "eye",
  constraints: "shield", decisions: "lightbulb", bugs: "bug", lineage: "history",
  fragile: "flame", components: "package", stale: "warning",
};
const STALE_ICON: Record<string, string> = { constraint: "⛔", decision: "🧭", bug: "🐞", component: "📦" };

/** One draft in the review queue. Clicking opens a read-only brief; inline
 *  ✓/✗/edit actions (contextValue "hunch.draft") delegate to the CLI. */
function draftLeaf(it: ReviewItem): Node {
  const g = it.synth.grounded != null ? `grounded ${it.synth.grounded}` : `conf ${it.confidence}`;
  const tag = it.vouched ? "roadmap" : it.verified ? "verified" : "unverified";
  return {
    kind: "leaf",
    label: it.d.title,
    description: `${tag} · ${g}`,
    tooltip: `${it.d.id} [${it.d.status}, ${it.d.provenance?.source ?? "?"}]\n${(it.d.decision ?? "").slice(0, 200)}`,
    icon: it.vouched ? "milestone" : it.verified ? "verified" : "question",
    contextValue: "hunch.draft",
    draftId: it.d.id,
    cmd: { command: "hunch.reviewDraft", args: [it.d.id] },
  };
}

function bugLeaf(root: string, bug: Bug): Node {
  const l = bug.lineage;
  const marks = [
    bug.status === "fixed" ? "✓fixed" : "",
    l?.recurrence_of ? "↻recurrence" : "",
    l?.spawned_constraint ? "⛔→constraint" : "",
  ].filter(Boolean).join(" ");
  const lineage = l
    ? `\nlineage: introduced=${l.introduced_commit ?? "?"} fixed=${l.fixed_commit ?? "—"} recurrence_of=${l.recurrence_of ?? "—"} → constraint=${l.spawned_constraint ?? "—"}`
    : "";
  return {
    kind: "leaf", label: `[${bug.severity}/${bug.status}] ${bug.title}`,
    description: `${prov(bug.provenance)}${marks ? "  " + marks : ""}`,
    tooltip: `${bug.id}\nsymptom: ${bug.symptom ?? ""}\nroot cause: ${bug.root_cause ?? ""}${lineage}`,
    file: firstFile(root, bug.affected_files),
  };
}

function lineageNode(root: string, n: LineageNode): Node {
  const b = n.bug;
  const children = n.recurrences.map((r) => lineageNode(root, r));
  return {
    kind: "tree",
    label: `${b.title}`,
    description: `[${b.severity}/${b.status}]${n.recurrences.length ? `  ↻${n.recurrences.length}` : ""}`,
    tooltip: `${b.id}\nroot cause: ${b.root_cause ?? ""}`,
    file: firstFile(root, b.affected_files),
    children,
  };
}

function fragileLeaves(b: Hunch, root: string): Node[] {
  return fragileSymbols(b).map((s) => ({
    kind: "leaf", label: `${s.score.toFixed(2)}  ${s.name}`,
    description: s.evidence, tooltip: `${s.name} @ ${s.file}\n${s.evidence}`,
    file: absFile(root, s.file),
  }));
}

function prov(p?: Provenance): string {
  if (!p) return "";
  return `${p.source ?? "?"} ${p.confidence ?? "?"}`;
}
function firstFile(root: string, files?: string[]): string | undefined {
  return files && files.length ? absFile(root, files[0]!) : undefined;
}
function absFile(root: string, f: string): string {
  return nodePath.isAbsolute(f) ? f : nodePath.join(root, f);
}

// ---------------------------------------------------------------------------
// Webview brief (why / context)
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

/** Render CLI output (from the command hub) in a self-contained webview. */
function showOutput(title: string, body: string): void {
  const panel = vscode.window.createWebviewPanel("hunchOutput", `Hunch — ${title}`, vscode.ViewColumn.Beside, {});
  panel.webview.html = `<!DOCTYPE html><html><head><meta charset="utf-8"><style>
    body{font-family:var(--vscode-editor-font-family,monospace);padding:8px 16px;color:var(--vscode-foreground);background:var(--vscode-editor-background)}
    h2{font-family:var(--vscode-font-family);border-bottom:1px solid var(--vscode-panel-border);font-size:14px}
    pre{white-space:pre-wrap;word-break:break-word;font-size:12px;line-height:1.45}
  </style></head><body><h2><code>${esc(title)}</code></h2><pre>${esc(body)}</pre></body></html>`;
}

/** Resolve a draft id from either a raw id (command arg) or a tree Node (context menu). */
function draftIdOf(x?: string | Node): string | undefined {
  if (typeof x === "string") return x;
  if (x && x.kind === "leaf") return x.draftId;
  return undefined;
}

/** The current title of a draft (for confirmation dialogs), or its id as a fallback. */
function titleOf(cache: HunchCache, id: string): string {
  return cache.get()?.decisions.find((d) => d.id === id)?.title ?? id;
}

function whyBrief(hunch: Hunch, file: string): void {
  const w = why(hunch, file);
  const near = nearConstraints(hunch, file);
  showBrief(`🧠 Why: ${relPath(file)}`, [
    { h: "⛔ Invariants (must not break)", lines: w.constraints.map((c) => `[${c.severity}] ${c.statement}  (${c.id})`) },
    { h: "⚠ Near-invariants (a guarded dependency)", lines: near.map((n) => `[${n.c.severity}] ${n.c.statement}  ·  via ${relPath(n.via)}`) },
    { h: "🧭 Decisions", lines: w.decisions.map((d) => `[${d.status}] ${d.title} — ${d.decision ?? ""}`) },
    { h: "🐞 Bug history", lines: w.bugs.map((b) => `[${b.severity}] ${b.title} — root cause: ${b.root_cause ?? ""}`) },
    { h: "💥 Blast radius (dependents)", lines: w.dependents.map((d) => `${d.name} @ ${relPath(d.file)}`) },
  ]);
}

function symbolBrief(hunch: Hunch, file: string, name: string): void {
  const bugs = bugsForSymbol(hunch, file, name);
  const sig = symbolSignals(hunch, file).get(name);
  showBrief(`🧠 Why: ${name}  ·  ${relPath(file)}`, [
    { h: "🔎 Signal", lines: sig ? [sig.evidence] : [] },
    { h: "🐞 Bug history", lines: bugs.map((b) => `[${b.severity}/${b.status}] ${b.title} — root cause: ${b.root_cause ?? ""}`) },
    { h: "⛔ Invariants in scope (file)", lines: constraintsInScope(hunch, file).map((c) => `[${c.severity}] ${c.statement}`) },
  ]);
}

// ---------------------------------------------------------------------------
// Status bar
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
// Write-path: delegate to the `hunch` CLI (never write .hunch/ JSON directly).
// ---------------------------------------------------------------------------
/** Ask before a split-private workspace writes a record. Shared mode already homes
 * every capture in its overlay, while a split-private workspace needs an explicit
 * choice so a sensitive lesson is never silently committed to the code repo. */
async function choosePrivateWrite(cache: HunchCache, kind: "bug" | "constraint"): Promise<boolean | undefined> {
  const overlay = cache.get()?.overlay;
  if (overlay?.state !== "active" || overlay.mode !== "private") return false;
  const pick = await vscode.window.showQuickPick([
    { label: "Private overlay", description: `Keep this ${kind} local; deterministic synthesis only`, private: true },
    { label: "Public memory", description: `Commit this ${kind} with the repository`, private: false },
  ], { title: `Store this ${kind} in…`, placeHolder: "Private is recommended for sensitive workflow details" });
  return pick?.private;
}

async function recordConstraint(root: string, cache: HunchCache, onDone: () => void): Promise<void> {
  const activeFile = vscode.window.activeTextEditor ? relPath(vscode.window.activeTextEditor.document.uri.fsPath) : "";
  const statement = await vscode.window.showInputBox({ title: "Record invariant", prompt: "The invariant the codebase must not break", placeHolder: "vectors are derived, never the source of truth" });
  if (!statement) return;
  const scope = await vscode.window.showInputBox({ title: "Record invariant — scope", prompt: "Comma-separated path/glob(s)", value: activeFile });
  if (scope === undefined) return;
  const severity = await vscode.window.showQuickPick(["warning", "blocking", "advisory"], { title: "Record invariant — severity" });
  if (!severity) return;
  const rationale = await vscode.window.showInputBox({ title: "Record invariant — rationale (optional)", prompt: "Why it must hold" }) ?? "";
  const isPrivate = await choosePrivateWrite(cache, "constraint");
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

async function recordBug(root: string, cache: HunchCache, onDone: () => void): Promise<void> {
  const test = await vscode.window.showInputBox({ title: "Record bug", prompt: "Failing test id / name", placeHolder: "auth.test.ts > rejects expired token" });
  if (!test) return;
  const message = await vscode.window.showInputBox({ title: "Record bug — failure", prompt: "Failure message / stack" });
  if (!message) return;
  const isPrivate = await choosePrivateWrite(cache, "bug");
  if (isPrivate === undefined) return;
  const args = ["record-bug", "--test", test, "--message", message];
  if (isPrivate) args.push("--private");
  const res = await runHunchWithProgress(root, args, "Hunch: recording bug…");
  if (res.ok) { vscode.window.showInformationMessage(res.stdout.trim().split("\n").pop() || "Hunch: bug recorded."); cache.reload(); onDone(); }
}

// ---------------------------------------------------------------------------
// reveal a constraint's scope on disk
// ---------------------------------------------------------------------------
async function revealScope(root: string, scopes: string[]): Promise<void> {
  for (const g of scopes) {
    const concrete = g.replace(/[\\/]?\*\*.*$/, "").replace(/\*.*$/, "").replace(/\/$/, "");
    if (!concrete) continue;
    const uri = vscode.Uri.file(nodePath.join(root, concrete));
    try {
      const stat = await vscode.workspace.fs.stat(uri);
      if (stat.type & vscode.FileType.Directory) await vscode.commands.executeCommand("revealInExplorer", uri);
      else await vscode.commands.executeCommand("vscode.open", uri);
      return;
    } catch {
      /* try next scope */
    }
  }
  vscode.window.showInformationMessage(`Hunch: no on-disk path for scope ${scopes.join(", ") || "(repo)"}.`);
}

// ---------------------------------------------------------------------------
// Activation
// ---------------------------------------------------------------------------
export function activate(context: vscode.ExtensionContext): void {
  const root = workspaceRoot();
  const cache = new HunchCache(root);
  cache.reload();

  const tree = new HunchTree(cache);
  context.subscriptions.push(vscode.window.registerTreeDataProvider("hunch.tree", tree));

  const status = vscode.window.createStatusBarItem(vscode.StatusBarAlignment.Right, 100);
  context.subscriptions.push(status);

  const codeLens = new HunchCodeLensProvider(() => cache.get(), relPath);
  const hover = new HunchHoverProvider(() => cache.get(), relPath);
  const diagnostics = new HunchDiagnostics(() => cache.get(), relPath);
  const decorations = new HunchDecorations(() => cache.get(), relPath);
  context.subscriptions.push(diagnostics, decorations);

  const SELECTOR: vscode.DocumentSelector = [
    { language: "typescript" }, { language: "javascript" }, { language: "typescriptreact" },
    { language: "javascriptreact" }, { language: "python" }, { language: "go" }, { language: "rust" },
  ];
  context.subscriptions.push(
    vscode.languages.registerCodeLensProvider(SELECTOR, codeLens),
    vscode.languages.registerHoverProvider(SELECTOR, hover),
  );

  const refreshActive = () => {
    const ed = vscode.window.activeTextEditor;
    updateStatusBar(status, cache);
    diagnostics.update(ed);
    void decorations.update(ed);
  };
  let overlayWatcher: vscode.FileSystemWatcher | undefined;
  let watchedOverlay = "";
  const syncOverlayWatcher = () => {
    const overlay = cache.get()?.overlay;
    const next = overlay?.state === "active" ? overlay.dir : "";
    if (next === watchedOverlay) return;
    overlayWatcher?.dispose();
    overlayWatcher = undefined;
    watchedOverlay = next;
    if (!next) return;
    overlayWatcher = vscode.workspace.createFileSystemWatcher(new vscode.RelativePattern(next, "**/*.json"));
    overlayWatcher.onDidChange(refreshAll);
    overlayWatcher.onDidCreate(refreshAll);
    overlayWatcher.onDidDelete(refreshAll);
    context.subscriptions.push(overlayWatcher);
  };
  const refreshAll = () => {
    cache.reload();
    syncOverlayWatcher();
    tree.refresh();
    codeLens.refresh();
    refreshActive();
    const h = cache.get();
    if (h) refreshGraph(h);
  };

  const activeFile = (): string | undefined => vscode.window.activeTextEditor?.document.uri.fsPath;
  const withHunch = (fn: (b: Hunch, file: string) => void) => {
    const file = activeFile();
    const hunch = cache.get();
    if (!hunch) return void vscode.window.showWarningMessage("No Hunch graph (.hunch/) found — run `hunch init`.");
    if (!file) return void vscode.window.showWarningMessage("Open a file first.");
    fn(hunch, relPath(file));
  };

  context.subscriptions.push(
    vscode.commands.registerCommand("hunch.refresh", refreshAll),
    vscode.commands.registerCommand("hunch.why", () => withHunch((b, f) => whyBrief(b, f))),
    vscode.commands.registerCommand("hunch.context", () =>
      withHunch((b, f) => {
        const w = why(b, f);
        showBrief(`🧠 Context: ${f}`, [
          { h: "⛔ Invariants", lines: w.constraints.map((c) => `[${c.severity}] ${c.statement}`) },
          { h: "🧭 Decisions", lines: w.decisions.map((d) => d.title) },
          { h: "🐞 Bugs", lines: w.bugs.map((bug) => bug.title) },
          { h: "💥 Blast radius", lines: w.dependents.map((d) => `${d.name} @ ${relPath(d.file)}`) },
        ]);
      }),
    ),
    vscode.commands.registerCommand("hunch.changeGate", () => {
      if (!root) return void vscode.window.showWarningMessage("No workspace folder open.");
      void openChangeGate(root, !!cache.get()?.overlay && cache.get()?.overlay?.state === "active", () => void vscode.commands.executeCommand("hunch.recordConstraint"), showOutput);
    }),
    vscode.commands.registerCommand("hunch.whySymbol", (name?: string) =>
      withHunch((b, f) => {
        let sym = name;
        if (!sym) {
          const ed = vscode.window.activeTextEditor;
          const wr = ed?.document.getWordRangeAtPosition(ed.selection.active);
          sym = wr ? ed!.document.getText(wr) : undefined;
        }
        if (!sym) return void vscode.window.showInformationMessage("Place the cursor on a symbol first.");
        symbolBrief(b, f, sym);
      }),
    ),
    vscode.commands.registerCommand("hunch.search", () => {
      const h = cache.get();
      if (!h || !root) return void vscode.window.showWarningMessage("No Hunch graph (.hunch/) found.");
      runSearch(h, root);
    }),
    vscode.commands.registerCommand("hunch.graph", () => {
      const h = cache.get();
      if (!h || !root) return void vscode.window.showWarningMessage("No Hunch graph (.hunch/) found.");
      showGraph(h, root);
    }),
    vscode.commands.registerCommand("hunch.revealScope", (scopes: string[]) => {
      if (root) void revealScope(root, scopes ?? []);
    }),
    vscode.commands.registerCommand("hunch.recordConstraint", () => {
      if (root) void recordConstraint(root, cache, refreshAll);
    }),
    vscode.commands.registerCommand("hunch.recordBug", () => {
      if (root) void recordBug(root, cache, refreshAll);
    }),
    // --- review queue: draft triage (delegates writes to the CLI) ----------
    vscode.commands.registerCommand("hunch.reviewDraft", (idOrNode?: string | Node) => {
      const id = draftIdOf(idOrNode);
      const h = cache.get();
      if (!h || !id) return;
      const it = [...reviewQueue(h).ready, ...reviewQueue(h).scrutiny].find((x) => x.d.id === id);
      if (it) draftBrief(it, showBrief);
    }),
    vscode.commands.registerCommand("hunch.acceptDraft", (node?: Node) => {
      const id = draftIdOf(node); if (root && id) void acceptDraft(root, id, titleOf(cache, id), refreshAll, cache.get()?.overlay?.state === "active");
    }),
    vscode.commands.registerCommand("hunch.rejectDraft", (node?: Node) => {
      const id = draftIdOf(node); if (root && id) void rejectDraft(root, id, titleOf(cache, id), refreshAll, cache.get()?.overlay?.state === "active");
    }),
    vscode.commands.registerCommand("hunch.editDraft", (node?: Node) => {
      const id = draftIdOf(node); const h = cache.get(); if (h && id) void openDraftFile(h, id);
    }),
    vscode.commands.registerCommand("hunch.acceptVerified", () => {
      const h = cache.get();
      if (root && h) void acceptVerified(root, reviewQueue(h).ready.length, refreshAll, h.overlay?.state === "active");
    }),
    vscode.commands.registerCommand("hunch.rejectDuplicates", () => {
      if (root) void rejectDuplicates(root, refreshAll, cache.get()?.overlay?.state === "active");
    }),
    vscode.commands.registerCommand("hunch.autoReview", () => {
      if (root) void autoReview(root, showOutput, refreshAll, cache.get()?.overlay?.state === "active");
    }),
    // --- command hub: drive the CLI from a GUI -----------------------------
    vscode.commands.registerCommand("hunch.runCommand", () => {
      if (!root) return void vscode.window.showWarningMessage("No workspace folder open.");
      void runCommandHub(root, showOutput, refreshAll);
    }),
  );

  // live refresh when the Hunch changes on disk
  if (root) {
    const watcher = vscode.workspace.createFileSystemWatcher(new vscode.RelativePattern(root, ".hunch/**/*.json"));
    watcher.onDidChange(refreshAll);
    watcher.onDidCreate(refreshAll);
    watcher.onDidDelete(refreshAll);
    context.subscriptions.push(watcher);
  }

  // keep in-editor signal in sync with the active editor / edits
  let editTimer: ReturnType<typeof setTimeout> | undefined;
  context.subscriptions.push(
    vscode.window.onDidChangeActiveTextEditor(() => refreshActive()),
    vscode.workspace.onDidSaveTextDocument(() => refreshActive()),
    vscode.workspace.onDidChangeTextDocument((e) => {
      if (e.document !== vscode.window.activeTextEditor?.document) return;
      if (editTimer) clearTimeout(editTimer);
      editTimer = setTimeout(() => void decorations.update(vscode.window.activeTextEditor), 400);
    }),
    vscode.workspace.onDidCloseTextDocument((doc) => diagnostics.clearClosed(doc.uri)),
  );

  syncOverlayWatcher();
  refreshActive();
}

export function deactivate(): void {
  /* subscriptions disposed by VS Code */
}
