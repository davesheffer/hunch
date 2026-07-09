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
import { runHunchWithProgress } from "./cli.js";
import { decisionFilePath, type Decision, type ReviewItem } from "./hunchData.js";

/** Confirm a draft → accepted/human_confirmed (arms its tripwires). */
export async function acceptDraft(root: string, id: string, title: string, onDone: () => void): Promise<void> {
  const pick = await vscode.window.showInformationMessage(
    `Confirm this decision as accepted?\n\n${title}`,
    { modal: true, detail: "Promotes it to human-confirmed and arms any drafted tripwires (advisory → blocking). Delegates to `hunch review --accept`." },
    "Confirm",
  );
  if (pick !== "Confirm") return;
  const res = await runHunchWithProgress(root, ["review", "--accept", id], "Hunch: confirming decision…");
  if (res.ok) {
    vscode.window.showInformationMessage(res.stdout.trim().split("\n").pop() || `Hunch: confirmed ${id}.`);
    onDone();
  }
}

/** Reject a draft → deleted from the store. */
export async function rejectDraft(root: string, id: string, title: string, onDone: () => void): Promise<void> {
  const pick = await vscode.window.showWarningMessage(
    `Reject and remove this draft?\n\n${title}`,
    { modal: true, detail: "Deletes the draft decision. Delegates to `hunch review --reject`. This cannot be undone from here." },
    "Reject",
  );
  if (pick !== "Reject") return;
  const res = await runHunchWithProgress(root, ["review", "--reject", id], "Hunch: rejecting draft…");
  if (res.ok) {
    vscode.window.showInformationMessage(res.stdout.trim().split("\n").pop() || `Hunch: rejected ${id}.`);
    onDone();
  }
}

/** Batch-accept every Critic-verified, well-grounded draft (the "ready" group). */
export async function acceptVerified(root: string, readyCount: number, onDone: () => void): Promise<void> {
  if (readyCount === 0) return void vscode.window.showInformationMessage("Hunch: no Critic-verified drafts ready to confirm.");
  const pick = await vscode.window.showInformationMessage(
    `Confirm all ${readyCount} Critic-verified draft(s)?`,
    { modal: true, detail: "Batch-accepts every well-grounded, verified draft. Delegates to `hunch review --accept-verified`." },
    "Confirm all",
  );
  if (pick !== "Confirm all") return;
  const res = await runHunchWithProgress(root, ["review", "--accept-verified"], "Hunch: confirming verified drafts…");
  if (res.ok) { vscode.window.showInformationMessage(res.stdout.trim().split("\n")[0] || "Hunch: verified drafts confirmed."); onDone(); }
}

/** Batch-reject drafts that near-duplicate an accepted record (deterministic hygiene). */
export async function rejectDuplicates(root: string, onDone: () => void): Promise<void> {
  const res = await runHunchWithProgress(root, ["review", "--reject-duplicates"], "Hunch: rejecting duplicate drafts…");
  if (res.ok) { vscode.window.showInformationMessage(res.stdout.trim().split("\n").pop() || "Hunch: duplicates handled."); onDone(); }
}

/** Auto-review moved to a dedicated interactive surface — see reviewConsole.ts
 *  (the live Review Console: streams the harness judgment + per-card override).
 *  This module keeps the tree's single-draft accept/reject/edit actions. */

/** Open a draft's JSON file so the reviewer can edit it before confirming. */
export async function openDraftFile(root: string, id: string): Promise<void> {
  const uri = vscode.Uri.file(decisionFilePath(root, id));
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
