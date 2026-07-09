/**
 * "Run Hunch Command…" — a graphical hub over the human-driven CLI verbs, so a
 * user can drive Hunch from the editor instead of a terminal. Deliberately a
 * CURATED subset: read/inspect/check/heal commands that make sense interactively.
 * Setup + CI + plumbing (init, mcp, hook, ci, migrate, merge-driver, embed,
 * backfill, sync) are intentionally excluded — they aren't interactive.
 *
 * Each command shells out through the shared CLI seam and renders stdout in a
 * self-contained webview (ANSI stripped) — the extension writes nothing itself.
 */
import * as vscode from "vscode";
import { runHunch } from "./cli.js";

export interface HunchCommandDef {
  /** argv passed to the CLI (first element is the subcommand). */
  args: string[];
  /** QuickPick label. */
  label: string;
  /** QuickPick detail line. */
  detail: string;
  /** true → prompt the user for a free-text argument appended to args. */
  arg?: { prompt: string; placeHolder?: string };
}

/** The curated, interactive command surface. Ordered by how often you'd reach
 *  for it: orient → inspect → check → maintain. */
export const HUNCH_COMMANDS: HunchCommandDef[] = [
  { args: ["now"], label: "$(pulse) Now — recent decisions + roadmap", detail: "The hot view: last decisions and every live proposed decision (the roadmap)." },
  { args: ["status"], label: "$(dashboard) Status — enforcement readiness", detail: "What's enforcing, what's waiting to confirm, what went stale." },
  { args: ["doctor"], label: "$(pulse) Doctor — diagnose environment", detail: "git, synthesis provider, index freshness." },
  { args: ["fragile"], label: "$(flame) Fragile — ranked fragility report", detail: "The most fragile symbols, with evidence." },
  { args: ["stale"], label: "$(warning) Stale — drifted records", detail: "Decisions/constraints whose files changed after they were last verified." },
  { args: ["drift"], label: "$(git-compare) Drift — memory + doc≠graph drift", detail: "Dead refs, dangling supersedes, anchor-stale docs. Exits non-zero on a gate hit." },
  { args: ["check"], label: "$(shield) Check — invariants hit by your changes", detail: "The local guardrail: changes touching a do-not-break invariant (+ sprawl)." },
  { args: ["conform"], label: "$(verified) Conform — code still satisfies intent?", detail: "Architectural Conformance over the graph (layering, must-reach, direction)." },
  { args: ["impact"], label: "$(radio-tower) Impact — memory surface of a change", detail: "Dependent files, invariants direct/near, decisions concerned (staged diff)." },
  { args: ["query"], label: "$(search) Query — full-text + graph search", detail: "Search the graph.", arg: { prompt: "What to search for", placeHolder: "why is synthesis on the subscription" } },
  { args: ["why"], label: "$(question) Why — explain a file/symbol", detail: "Decisions, bugs, constraints for a target.", arg: { prompt: "File path or symbol", placeHolder: "src/synthesis/provider.ts" } },
  { args: ["timeline"], label: "$(history) Timeline — decision history for a target", detail: "What was believed, and when/why it changed.", arg: { prompt: "File path or symbol", placeHolder: "src/store/db.ts" } },
  { args: ["heal"], label: "$(wrench) Heal — doc↔graph reconciliation", detail: "Every drift finding with its next action. Read-only — proposes, never rewrites." },
  { args: ["reconcile-topics"], label: "$(git-merge) Reconcile topics — >1 live per topic", detail: "Surface topic collisions a merge can introduce." },
  { args: ["review"], label: "$(checklist) Review — segmented draft list", detail: "The full triage list (ready / needs scrutiny). Approve/reject from the tree." },
  { args: ["auto-review"], label: "$(sparkle) Auto-review (dry run) — harness triage plan", detail: "Delegate relevance to the harness; print the accept/delete/keep plan. Changes nothing (dry run)." },
];

/** Open the QuickPick, run the chosen command (prompting for its arg if any),
 *  and render output. `onWrite` fires after commands that may mutate the store. */
export async function runCommandHub(root: string, showOutput: (title: string, body: string) => void, onWrite: () => void): Promise<void> {
  const items = HUNCH_COMMANDS.map((c) => ({ label: c.label, detail: c.detail, def: c }));
  const pick = await vscode.window.showQuickPick(items, { title: "Run Hunch Command", placeHolder: "Pick a Hunch command to run", matchOnDetail: true });
  if (!pick) return;
  const def = pick.def;
  const args = [...def.args];
  if (def.arg) {
    const v = await vscode.window.showInputBox({ title: def.label.replace(/\$\([^)]*\)\s*/, ""), prompt: def.arg.prompt, placeHolder: def.arg.placeHolder });
    if (v === undefined) return; // cancelled
    if (v.trim()) args.push(...v.trim().split(/\s+/));
  }
  const title = `hunch ${args.join(" ")}`;
  const res = await vscode.window.withProgress(
    { location: vscode.ProgressLocation.Notification, title: `Hunch: running \`${title}\`…` },
    () => runHunch(root, args),
  );
  const body = stripAnsi([res.stdout, res.stderr].filter((s) => s.trim()).join("\n")) || `(no output — exit ${res.code})`;
  showOutput(title, body);
  onWrite();
}

/** Strip ANSI SGR sequences so CLI color output renders cleanly in the webview.
 *  ESC is built from its code point to keep a raw control char out of the source. */
export function stripAnsi(s: string): string {
  return s.replace(new RegExp(String.fromCharCode(27) + "\[[0-9;]*m", "g"), "");
}
