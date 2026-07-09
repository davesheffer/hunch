/**
 * Surfaces Hunch invariants for the active file into the Problems panel as
 * diagnostics — so an invariant you might break is visible while you edit, not
 * only when you open the tree. File-scoped (constraints have no line ranges),
 * so all marks sit on the first line. Read-only: never edits the document.
 */
import * as vscode from "vscode";
import { constraintsInScope, nearConstraints, type Hunch } from "./hunchData.js";

type GetHunch = () => Hunch | null;
type RelPath = (file: string) => string;

const SEV: Record<string, vscode.DiagnosticSeverity> = {
  blocking: vscode.DiagnosticSeverity.Warning,
  warning: vscode.DiagnosticSeverity.Information,
};

export class HunchDiagnostics {
  private col = vscode.languages.createDiagnosticCollection("hunch");
  constructor(private getHunch: GetHunch, private rel: RelPath) {}

  update(editor: vscode.TextEditor | undefined): void {
    if (!editor) return;
    const cfg = vscode.workspace.getConfiguration("hunch");
    const uri = editor.document.uri;
    if (!cfg.get("diagnostics.enabled", true)) { this.col.delete(uri); return; }
    const hunch = this.getHunch();
    if (!hunch) { this.col.delete(uri); return; }

    const file = this.rel(uri.fsPath);
    const firstLine = new vscode.Range(0, 0, 0, Number.MAX_SAFE_INTEGER);
    const diags: vscode.Diagnostic[] = [];

    for (const c of constraintsInScope(hunch, file)) {
      const d = new vscode.Diagnostic(firstLine, `⛔ Invariant [${c.severity}]: ${c.statement}`, SEV[c.severity ?? ""] ?? vscode.DiagnosticSeverity.Information);
      d.source = "Hunch";
      d.code = c.id;
      diags.push(d);
    }
    for (const { c, via } of nearConstraints(hunch, file)) {
      const d = new vscode.Diagnostic(firstLine, `⚠ Near-invariant [${c.severity}]: ${c.statement} — reached via ${via}`, vscode.DiagnosticSeverity.Hint);
      d.source = "Hunch";
      d.code = c.id;
      diags.push(d);
    }
    this.col.set(uri, diags);
  }

  clearClosed(uri: vscode.Uri): void { this.col.delete(uri); }
  dispose(): void { this.col.dispose(); }
}

/** Quick actions on the Hunch diagnostics so the Problems entries aren't inert:
 *  open the full brief for the file, reveal the invariant's scope on disk, or
 *  jump to the constraint's record JSON. */
export class HunchCodeActionProvider implements vscode.CodeActionProvider {
  static readonly metadata: vscode.CodeActionProviderMetadata = {
    providedCodeActionKinds: [vscode.CodeActionKind.QuickFix],
  };
  constructor(private getHunch: GetHunch, private recordFile: (kind: "constraints", id: string) => string) {}

  provideCodeActions(_doc: vscode.TextDocument, _range: vscode.Range | vscode.Selection, ctx: vscode.CodeActionContext): vscode.CodeAction[] {
    const ours = ctx.diagnostics.filter((d) => d.source === "Hunch");
    if (!ours.length) return [];
    const hunch = this.getHunch();
    const actions: vscode.CodeAction[] = [];

    const brief = new vscode.CodeAction("Hunch: open the full brief for this file", vscode.CodeActionKind.QuickFix);
    brief.command = { command: "hunch.why", title: "Open Hunch brief" };
    brief.diagnostics = [ours[0]!];
    actions.push(brief);

    for (const d of ours) {
      const c = hunch?.constraints.find((x) => x.id === d.code);
      if (!c) continue;
      if (c.scope?.length) {
        const reveal = new vscode.CodeAction(`Hunch: reveal invariant scope (${c.scope.join(", ")})`, vscode.CodeActionKind.QuickFix);
        reveal.command = { command: "hunch.revealScope", title: "Reveal scope", arguments: [c.scope] };
        reveal.diagnostics = [d];
        actions.push(reveal);
      }
      const open = new vscode.CodeAction(`Hunch: open record ${c.id}`, vscode.CodeActionKind.QuickFix);
      open.command = { command: "vscode.open", title: "Open record", arguments: [vscode.Uri.file(this.recordFile("constraints", c.id))] };
      open.diagnostics = [d];
      actions.push(open);
    }
    return actions;
  }
}
