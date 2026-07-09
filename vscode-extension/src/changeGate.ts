/**
 * Change Gate — the daily Hunch loop.
 *
 * This is deliberately provider- and agent-agnostic: it runs the local Hunch
 * CLI against a git diff, renders deterministic evidence, and copies a plain
 * evidence bundle for *any* coding assistant or human reviewer. No model calls,
 * API keys, agent-specific prompt format, or cloud service are involved.
 */
import * as vscode from "vscode";
import { runHunch, type CliResult } from "./cli.js";
import { stripAnsi } from "./commands.js";

type Scope = { label: string; description: string; args: string[]; impactArgs: string[]; title: string };

const esc = (s: string) => s.replace(/[&<>]/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;" }[c]!));

function classifyGateResult(result: CliResult, body: string): { kind: "pass" | "warn" | "block" | "empty" | "error"; title: string; detail: string } {
  if (!result.ok && !/Architectural conformance|Directly touches|Re-introduces/.test(body)) {
    return { kind: "error", title: "Could not review this change", detail: "The local Hunch CLI did not return a usable review." };
  }
  if (/No changed files to check\./.test(body)) {
    return { kind: "empty", title: "Nothing to review", detail: "Choose staged files or compare your branch against a base." };
  }
  if (!result.ok) {
    return { kind: "block", title: "BLOCK", detail: "A confirmed, blocking invariant or architectural conformance check failed." };
  }
  if (/^✓ .*touch no recorded invariants/m.test(body)) {
    return { kind: "pass", title: "PASS", detail: "This diff does not touch recorded engineering memory." };
  }
  return { kind: "warn", title: "WARN", detail: "This diff touches recorded engineering memory. Review the receipt before merge." };
}

async function chooseScope(): Promise<Scope | undefined> {
  const choice = await vscode.window.showQuickPick([
    {
      label: "$(edit) Review working changes",
      description: "Staged, unstaged, and untracked edits vs HEAD",
      args: ["check", "--working", "--strict", "--blast"],
      impactArgs: ["impact", "--working"],
      title: "Working changes",
    },
    {
      label: "$(git-staged) Review staged changes",
      description: "Pre-commit check of what is staged now",
      args: ["check", "--staged", "--strict", "--blast"],
      impactArgs: ["impact"],
      title: "Staged changes",
    },
    {
      label: "$(git-branch) Review current branch against a base",
      description: "Pre-PR check of this branch's changes",
      args: [], impactArgs: [], title: "",
    },
  ], { title: "Hunch Change Gate", placeHolder: "What should Hunch review?" });
  if (!choice) return undefined;
  if (choice.args.length) return choice;
  const base = await vscode.window.showQuickPick([
    { label: "origin/main", description: "Recommended when your remote main is available" },
    { label: "main", description: "Use the local main branch" },
    { label: "Enter another ref…", description: "Tag, branch, or commit reference" },
  ], { title: "Compare current branch against" });
  if (!base) return undefined;
  const ref = base.label === "Enter another ref…"
    ? await vscode.window.showInputBox({ title: "Base ref", placeHolder: "origin/main" })
    : base.label;
  if (!ref?.trim()) return undefined;
  return {
    label: `Review current branch against ${ref.trim()}`,
    description: "Pre-PR architectural review",
    args: ["check", "--base", ref.trim(), "--strict", "--blast"],
    impactArgs: ["impact", ref.trim()],
    title: `Current branch vs ${ref.trim()}`,
  };
}

/** Open the review surface. Writes are intentionally limited to an explicit
 * “Teach Hunch” handoff; the review itself is a pure local read. */
export async function openChangeGate(
  root: string,
  hasPrivateMemory: boolean,
  onTeach: () => void,
  showOutput: (title: string, body: string) => void,
): Promise<void> {
  const scope = await chooseScope();
  if (!scope) return;
  const result = await vscode.window.withProgress(
    { location: vscode.ProgressLocation.Notification, title: `Hunch: reviewing ${scope.title.toLowerCase()}…` },
    () => runHunch(root, scope.args, 180_000),
  );
  const body = stripAnsi([result.stdout, result.stderr].filter((x) => x.trim()).join("\n")) || `(no output — exit ${result.code})`;
  const v = classifyGateResult(result, body);
  const panel = vscode.window.createWebviewPanel("hunchChangeGate", `Hunch Change Gate — ${v.title}`, vscode.ViewColumn.Beside, { enableScripts: true });
  const copyBundle = `HUNCH CHANGE GATE — ${v.title}\nScope: ${scope.title}\n${v.detail}\n\n${body}`;
  const privacyNote = hasPrivateMemory
    ? "This local verdict includes private/shared overlay memory. Use “Copy public evidence” before sharing outside this machine."
    : "The gate runs local Hunch + git analysis only. The evidence bundle works with any human reviewer or coding agent; Hunch does not require a specific provider.";
  panel.webview.html = `<!doctype html><html><head><meta charset="utf-8"><style>
    :root{--green:#4d8b70;--paper:#f7f9f7;--ink:#1c201e;--muted:#66706b;--line:#d9dedb;--warn:#a86c2e;--block:#b4543e}
    body{margin:0;padding:26px;font-family:var(--vscode-font-family,system-ui);background:var(--vscode-editor-background,var(--paper));color:var(--vscode-editor-foreground,var(--ink));line-height:1.5}
    .meta{font:500 11px var(--vscode-editor-font-family,monospace);letter-spacing:.08em;text-transform:uppercase;color:var(--vscode-descriptionForeground,var(--muted))}
    h1{font-size:30px;letter-spacing:-.045em;margin:9px 0 6px}.pass{color:var(--green)}.warn{color:var(--warn)}.block,.error{color:var(--block)}.empty{color:var(--muted)}
    p{max-width:720px;color:var(--vscode-descriptionForeground,var(--muted));margin:0 0 20px}.actions{display:flex;gap:8px;flex-wrap:wrap;margin:20px 0}button{border:1px solid var(--vscode-button-border,var(--line));border-radius:6px;padding:8px 11px;background:var(--vscode-button-background,#2c523f);color:var(--vscode-button-foreground,#fff);font:500 12px var(--vscode-font-family);cursor:pointer}button.secondary{background:transparent;color:var(--vscode-foreground,var(--ink))}button:hover{filter:brightness(1.08)}
    .receipt{border:1px solid var(--vscode-panel-border,var(--line));border-radius:9px;overflow:hidden}.receipt h2{font-size:12px;letter-spacing:.04em;text-transform:uppercase;margin:0;padding:10px 13px;border-bottom:1px solid var(--vscode-panel-border,var(--line));color:var(--vscode-descriptionForeground,var(--muted))}pre{white-space:pre-wrap;word-break:break-word;margin:0;padding:15px;font:12px/1.65 var(--vscode-editor-font-family,monospace);max-height:58vh;overflow:auto}
    .note{font-size:12px;margin-top:16px;color:var(--vscode-descriptionForeground,var(--muted))}code{font-family:var(--vscode-editor-font-family,monospace)}
  </style></head><body><div class="meta">Deterministic local review · ${esc(scope.title)}</div><h1 class="${v.kind}">${esc(v.title)}</h1><p>${esc(v.detail)}</p><div class="actions"><button data-action="copy">Copy evidence bundle</button>${hasPrivateMemory ? '<button class="secondary" data-action="copy-public">Copy public evidence</button>' : ''}<button class="secondary" data-action="impact">Show impact map</button><button class="secondary" data-action="teach">Teach Hunch</button></div><div class="receipt"><h2>Evidence receipt</h2><pre>${esc(body)}</pre></div><p class="note">${esc(privacyNote)}</p><script>const vscode=acquireVsCodeApi();document.querySelectorAll('button').forEach(b=>b.addEventListener('click',()=>vscode.postMessage({action:b.dataset.action})));</script></body></html>`;
  panel.webview.onDidReceiveMessage(async (message: { action?: string }) => {
    if (message.action === "copy") {
      if (hasPrivateMemory) {
        const confirmation = await vscode.window.showWarningMessage("This local evidence may contain private Hunch records. Copy it anyway?", { modal: true }, "Copy local evidence");
        if (confirmation !== "Copy local evidence") return;
      }
      await vscode.env.clipboard.writeText(copyBundle);
      void vscode.window.showInformationMessage("Hunch Change Gate: evidence bundle copied.");
    } else if (message.action === "copy-public") {
      const publicResult = await vscode.window.withProgress({ location: vscode.ProgressLocation.Notification, title: "Hunch: preparing public-only evidence…" }, () => runHunch(root, [...scope.args, "--public-only"], 180_000));
      const publicBody = stripAnsi([publicResult.stdout, publicResult.stderr].filter((x) => x.trim()).join("\n")) || `(no output — exit ${publicResult.code})`;
      const publicVerdict = classifyGateResult(publicResult, publicBody);
      await vscode.env.clipboard.writeText(`HUNCH CHANGE GATE — ${publicVerdict.title}\nScope: ${scope.title}\n${publicVerdict.detail}\n\n${publicBody}`);
      void vscode.window.showInformationMessage("Hunch Change Gate: public-only evidence copied.");
    } else if (message.action === "impact") {
      const impact = await vscode.window.withProgress({ location: vscode.ProgressLocation.Notification, title: "Hunch: mapping change impact…" }, () => runHunch(root, scope.impactArgs, 180_000));
      showOutput(`Impact — ${scope.title}`, stripAnsi([impact.stdout, impact.stderr].filter((x) => x.trim()).join("\n")) || `(no output — exit ${impact.code})`);
    } else if (message.action === "teach") {
      onTeach();
    }
  });
}
