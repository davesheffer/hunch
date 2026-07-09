/**
 * Draft triage — the human-judgment moment the extension exists to serve
 * (dec_df253f50b4: "build a review-queue UI inside the vscode extension").
 *
 * Approve / reject delegate to `hunch review --accept|--reject <id>` (atomic,
 * validated, reindexes + refreshes grounding). Editing a draft opens its JSON
 * file — the CLI owns the store, so we never mutate it here; the on-disk watcher
 * refreshes the tree once the CLI write lands.
 */
import * as vscode from "vscode";
import { runHunch, runHunchWithProgress } from "./cli.js";
import { decisionFilePath, type Decision, type Hunch, type ReviewItem } from "./hunchData.js";

const withPrivate = (args: string[], includePrivate: boolean) => includePrivate ? [args[0]!, "--private", ...args.slice(1)] : args;

/** Confirm a draft → accepted/human_confirmed (arms its tripwires). */
export async function acceptDraft(root: string, id: string, title: string, onDone: () => void, includePrivate = false): Promise<void> {
  const pick = await vscode.window.showInformationMessage(
    `Confirm this decision as accepted?\n\n${title}`,
    { modal: true, detail: "Promotes it to human-confirmed and arms any drafted tripwires (advisory → blocking). Delegates to `hunch review --accept`." },
    "Confirm",
  );
  if (pick !== "Confirm") return;
  const res = await runHunchWithProgress(root, withPrivate(["review", "--accept", id], includePrivate), "Hunch: confirming decision…");
  if (res.ok) {
    vscode.window.showInformationMessage(res.stdout.trim().split("\n").pop() || `Hunch: confirmed ${id}.`);
    onDone();
  }
}

/** Reject a draft → deleted from the store. */
export async function rejectDraft(root: string, id: string, title: string, onDone: () => void, includePrivate = false): Promise<void> {
  const pick = await vscode.window.showWarningMessage(
    `Reject and remove this draft?\n\n${title}`,
    { modal: true, detail: "Deletes the draft decision. Delegates to `hunch review --reject`. This cannot be undone from here." },
    "Reject",
  );
  if (pick !== "Reject") return;
  const res = await runHunchWithProgress(root, withPrivate(["review", "--reject", id], includePrivate), "Hunch: rejecting draft…");
  if (res.ok) {
    vscode.window.showInformationMessage(res.stdout.trim().split("\n").pop() || `Hunch: rejected ${id}.`);
    onDone();
  }
}

/** Batch-accept every Critic-verified, well-grounded draft (the "ready" group). */
export async function acceptVerified(root: string, readyCount: number, onDone: () => void, includePrivate = false): Promise<void> {
  if (readyCount === 0) return void vscode.window.showInformationMessage("Hunch: no Critic-verified drafts ready to confirm.");
  const pick = await vscode.window.showInformationMessage(
    `Confirm all ${readyCount} Critic-verified draft(s)?`,
    { modal: true, detail: "Batch-accepts every well-grounded, verified draft. Delegates to `hunch review --accept-verified`." },
    "Confirm all",
  );
  if (pick !== "Confirm all") return;
  const res = await runHunchWithProgress(root, withPrivate(["review", "--accept-verified"], includePrivate), "Hunch: confirming verified drafts…");
  if (res.ok) { vscode.window.showInformationMessage(res.stdout.trim().split("\n")[0] || "Hunch: verified drafts confirmed."); onDone(); }
}

/** Batch-reject drafts that near-duplicate an accepted record (deterministic hygiene). */
export async function rejectDuplicates(root: string, onDone: () => void, includePrivate = false): Promise<void> {
  const res = await runHunchWithProgress(root, withPrivate(["review", "--reject-duplicates"], includePrivate), "Hunch: rejecting duplicate drafts…");
  if (res.ok) { vscode.window.showInformationMessage(res.stdout.trim().split("\n").pop() || "Hunch: duplicates handled."); onDone(); }
}

/** Harness-driven auto-review. ALWAYS shows the dry-run plan first (delegates to
 *  `hunch auto-review`), then asks whether to apply it — a human sees exactly what
 *  would be confirmed/deleted before any mutation. `showOutput` renders the plan. */
export async function autoReview(root: string, showOutput: (title: string, body: string) => void, onDone: () => void, includePrivate = false): Promise<void> {
  const plan = await vscode.window.withProgress(
    { location: vscode.ProgressLocation.Notification, title: "Hunch: auto-review — judging drafts via the harness…" },
    () => runHunch(root, includePrivate ? ["auto-review", "--private"] : ["auto-review"], 600_000),
  );
  const body = stripAnsiText([plan.stdout, plan.stderr].filter((s) => s.trim()).join("\n")) || `(no output — exit ${plan.code})`;
  showOutput("auto-review (dry run)", body);
  if (!plan.ok) {
    vscode.window.showErrorMessage(`Hunch auto-review failed. ${(plan.stderr || `exit ${plan.code}`).trim().split("\n").slice(-2).join(" ")}`);
    return;
  }
  // Nothing to apply? (planner prints "apply 0 change(s)" / "No drafts").
  if (/apply 0 change|No drafts to auto-review/.test(body)) {
    vscode.window.showInformationMessage("Hunch auto-review: nothing to apply — see the plan.");
    return;
  }
  const pick = await vscode.window.showWarningMessage(
    "Apply this auto-review plan?",
    { modal: true, detail: "Confirms the verified + harness-relevant drafts and DELETES duplicates / harness-irrelevant ones. Everything else is kept for you. See the plan panel for the exact list." },
    "Apply plan",
  );
  if (pick !== "Apply plan") return;
  const res = await runHunchWithProgress(root, includePrivate ? ["auto-review", "--private", "--apply"] : ["auto-review", "--apply"], "Hunch: applying auto-review plan…");
  if (res.ok) {
    vscode.window.showInformationMessage(stripAnsiText(res.stdout).trim().split("\n").pop() || "Hunch: auto-review applied.");
    onDone();
  }
}

/** Local ANSI stripper (same as commands.stripAnsi; kept here to avoid a cycle). */
function stripAnsiText(s: string): string {
  return s.replace(new RegExp(String.fromCharCode(27) + "\\[[0-9;]*m", "g"), "");
}

/** Open a draft's JSON file so the reviewer can edit it before confirming. */
export async function openDraftFile(hunch: Hunch, id: string): Promise<void> {
  const uri = vscode.Uri.file(decisionFilePath(hunch, id));
  try {
    await vscode.commands.executeCommand("vscode.open", uri);
  } catch {
    vscode.window.showWarningMessage(`Hunch: could not open the draft file for ${id}.`);
  }
}

/** A read-only brief for one draft: its title, decision text, grounding telemetry,
 *  rejected alternatives, and what it touches — the context a reviewer needs. */
export function draftBrief(item: ReviewItem, show: (title: string, sections: Array<{ h: string; lines: string[] }>) => void): void {
  const d: Decision = item.d;
  const s = item.synth;
  const groundLine = [
    s.provider && `provider=${s.provider}`,
    s.grounded != null && `grounded=${s.grounded}`,
    s.agreement != null && `agreement=${s.agreement}`,
    s.pruned != null && `pruned=${s.pruned}`,
    s.verify && `verify=${s.verify}`,
  ].filter(Boolean).map(String);
  show(`🗳 Review draft: ${d.title}`, [
    { h: "Status", lines: [`${d.status ?? "?"} · ${d.provenance?.source ?? "?"} · confidence ${item.confidence}${item.vouched ? " · already human-vouched (roadmap intent)" : item.verified ? " · Critic-verified" : " · unverified — needs human eyes"}`] },
    { h: "🧭 Decision", lines: d.decision ? [d.decision] : [] },
    { h: "✂ Rejected alternatives", lines: d.alternatives_rejected ?? [] },
    { h: "🔬 Grounding telemetry", lines: groundLine.length ? groundLine : ["(no synth telemetry)"] },
    { h: "📄 Related files", lines: d.related_files ?? [] },
  ]);
}
