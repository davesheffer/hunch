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
import * as os from "node:os";
import { runHunch, runHunchWithProgress } from "./cli.js";

/** One memory move — mirrors src/core/memorylog.MemoryMove (JSON consumer). */
export interface MemoryMove {
  sha: string;
  shortSha: string;
  date: string;
  subject: string;
  kind: "capture" | "adopt" | "supersede" | "prune" | "repair" | "edit";
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
  repair: "tools",
  edit: "edit",
};
const KIND_LABEL: Record<MemoryMove["kind"], string> = {
  capture: "captured", adopt: "adopted", supersede: "superseded", prune: "pruned", repair: "repaired", edit: "edited",
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

/** One inline escalation — mirrors core/escalations.Escalation (JSON consumer). */
export interface EscalationEntry {
  kind: string;
  topic: string;
  question: string;
  detail: string;
  resolution: string;
}

/** One Constitution policy — mirrors `hunch policy list --json` (JSON consumer). */
export interface PolicyEntry {
  id: string;
  state: string;
  severity: string;
  statement: string;
  authority: { actor?: string } | null;
  proof: string | null;
  data_class: string;
}

export class EscalationNode extends vscode.TreeItem {
  constructor(public readonly entry: EscalationEntry) {
    super(entry.question, vscode.TreeItemCollapsibleState.None);
    this.iconPath = new vscode.ThemeIcon("question", new vscode.ThemeColor("notificationsWarningIcon.foreground"));
    this.contextValue = "hunchEscalation";
    this.tooltip = new vscode.MarkdownString([`**${entry.kind}**`, "", entry.detail, "", `→ ${entry.resolution}`].join("\n"));
    this.command = { command: "hunch.openEscalation", title: "Open escalation", arguments: [this] };
  }
}

const POLICY_ICON: Record<string, string> = {
  active_blocking: "shield", active_advisory: "verified", proposed: "law",
  compiled: "beaker", validating: "beaker", demoted: "arrow-down", retired: "archive",
};

export class PolicyNode extends vscode.TreeItem {
  constructor(public readonly policy: PolicyEntry) {
    super(policy.statement.length > 80 ? policy.statement.slice(0, 79) + "…" : policy.statement, vscode.TreeItemCollapsibleState.None);
    this.description = `${policy.state} · ${policy.severity}${policy.authority?.actor ? ` · ${policy.authority.actor}` : ""}${policy.data_class !== "public" ? " · private" : ""}`;
    this.iconPath = new vscode.ThemeIcon(POLICY_ICON[policy.state] ?? "circle-outline");
    this.contextValue = policy.state === "proposed" ? "hunchPolicyProposed"
      : policy.state === "active_blocking" ? "hunchPolicyBlocking"
      : policy.state === "active_advisory" ? "hunchPolicyAdvisory" : "hunchPolicy";
    this.tooltip = new vscode.MarkdownString([
      `**${policy.id}** · ${policy.state} · ${policy.severity}`,
      "", policy.statement, "",
      policy.proof ? `Proof: \`${policy.proof}\`` : "_No proof yet._",
      policy.authority?.actor ? `Authority: ${policy.authority.actor}` : "Authority: none — a human click here IS the vouch.",
      "", "_Click for the proof card._",
    ].join("\n"));
    this.command = { command: "hunch.openPolicyCard", title: "Open proof card", arguments: [this] };
  }
}

class GroupNode extends vscode.TreeItem {
  constructor(label: string, icon: string, public readonly group: "escalations" | "policies") {
    super(label, group === "escalations" ? vscode.TreeItemCollapsibleState.Expanded : vscode.TreeItemCollapsibleState.Collapsed);
    this.iconPath = new vscode.ThemeIcon(icon);
    this.contextValue = `hunchGroup.${group}`;
  }
}

type Node = MoveNode | EscalationNode | PolicyNode | GroupNode;

export class MemoryTreeProvider implements vscode.TreeDataProvider<Node> {
  private readonly _changed = new vscode.EventEmitter<void>();
  readonly onDidChangeTreeData = this._changed.event;
  private moves: MemoryMove[] = [];
  private escalations: EscalationEntry[] = [];
  private policies: PolicyEntry[] = [];
  private loaded = false;

  constructor(private readonly root: string | undefined) {}

  refresh(): void {
    void this.load().then(() => this._changed.fire());
  }

  private async load(): Promise<void> {
    this.loaded = true;
    if (!this.root) { this.moves = []; this.escalations = []; this.policies = []; return; }
    // Three independent reads; each degrades to empty on failure (a broken policy
    // store must not take the timeline down, and vice versa).
    const [log, esc, pol] = await Promise.all([
      runHunch(this.root, ["log", "--json", "-n", "150"]),
      runHunch(this.root, ["escalations", "--json"]),
      runHunch(this.root, ["policy", "list", "--json"]),
    ]);
    try { this.moves = log.ok ? JSON.parse(log.stdout) as MemoryMove[] : []; } catch { this.moves = []; }
    // escalations exits non-zero when entries exist (by design) — parse regardless.
    try { this.escalations = JSON.parse(esc.stdout) as EscalationEntry[]; } catch { this.escalations = []; }
    try { this.policies = pol.ok ? JSON.parse(pol.stdout) as PolicyEntry[] : []; } catch { this.policies = []; }
  }

  getTreeItem(node: Node): vscode.TreeItem { return node; }

  async getChildren(element?: Node): Promise<Node[]> {
    if (!element) {
      if (!this.loaded) await this.load();
      const roots: Node[] = [];
      if (this.escalations.length) roots.push(new GroupNode(`⚖ Needs your decision (${this.escalations.length})`, "issues", "escalations"));
      if (this.policies.length) roots.push(new GroupNode(`🏛 Constitution (${this.policies.length})`, "law", "policies"));
      return [...roots, ...this.moves.map((m) => new MoveNode(m))];
    }
    if (element instanceof GroupNode) {
      return element.group === "escalations"
        ? this.escalations.map((e) => new EscalationNode(e))
        : this.policies.map((p) => new PolicyNode(p));
    }
    return [];
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

/** Open one policy's deterministic proof card as a read-only popup. */
export async function openPolicyCard(root: string, node: PolicyNode): Promise<void> {
  const res = await runHunch(root, ["policy", "card", node.policy.id]);
  const body = (res.stdout || res.stderr || "(no card)").trim();
  const doc = await vscode.workspace.openTextDocument({ content: body, language: "markdown" });
  await vscode.window.showTextDocument(doc, { preview: true, viewColumn: vscode.ViewColumn.Active });
}

/** Open one escalation as a read-only popup: the question, its receipt, the verbs. */
export async function openEscalation(node: EscalationNode): Promise<void> {
  const e = node.entry;
  const doc = await vscode.workspace.openTextDocument({
    content: [`⚖ ${e.question}`, "", e.detail, "", `Resolution: ${e.resolution}`].join("\n"),
    language: "markdown",
  });
  await vscode.window.showTextDocument(doc, { preview: true, viewColumn: vscode.ViewColumn.Active });
}

/** The explicit human actor for authority-bearing panel actions. */
function panelActor(): string {
  return `human:${os.userInfo().username || "vscode"}`;
}

/** Activate a proposed policy — THE inline vouch. A modal states exactly what the
 *  click grants; blocking is called out in its own words. Delegates to the CLI. */
export async function activatePolicy(root: string, node: PolicyNode, onDone: () => void): Promise<void> {
  const p = node.policy;
  const pick = await vscode.window.showWarningMessage(
    `Activate this rule?\n\n${p.statement.slice(0, 160)}`,
    { modal: true, detail: `Your click is the human authority (recorded as ${panelActor()}). Advisory = surfaces, never blocks. Blocking = can fail edits/commits/CI — requires the P3 proof this policy carries. Inspect the proof card first if you haven't.` },
    "Activate advisory", "Activate BLOCKING",
  );
  if (!pick) return;
  const mode = pick === "Activate BLOCKING" ? "--blocking" : "--advisory";
  const res = await runHunchWithProgress(root, ["policy", "accept", p.id, mode, "--actor", panelActor()], "Hunch: activating policy…");
  if (res.ok) { vscode.window.showInformationMessage(res.stdout.trim().split("\n").pop() || `Activated ${p.id}.`); onDone(); }
}

/** Withdraw an active advisory policy to proposed — authority returns to the human
 *  pool and the rule re-enters the ⚖ escalation loop (the reversible retirement). */
export async function withdrawPolicy(root: string, node: PolicyNode, onDone: () => void): Promise<void> {
  const p = node.policy;
  const reason = await vscode.window.showInputBox({
    title: "Withdraw to proposed", prompt: "One sentence: why is this rule losing its advisory authority?",
    placeHolder: "e.g. scope changed after the store refactor",
  });
  if (!reason?.trim()) return;
  const res = await runHunchWithProgress(root, ["policy", "withdraw", p.id, "--actor", panelActor(), "--reason", reason.trim()], "Hunch: withdrawing policy…");
  if (res.ok) { vscode.window.showInformationMessage(`Withdrawn — ${p.id} is proposed again (it will re-ask in escalations).`); onDone(); }
}

/** Permanently retire a policy — it stops surfacing anywhere; history stays. */
export async function retirePolicy(root: string, node: PolicyNode, onDone: () => void): Promise<void> {
  const p = node.policy;
  const reason = await vscode.window.showInputBox({
    title: "Retire rule permanently", prompt: "One sentence: why is this rule done for good? (History is kept; it stops surfacing everywhere.)",
    placeHolder: "e.g. the module it guarded was deleted",
  });
  if (!reason?.trim()) return;
  const res = await runHunchWithProgress(root, ["policy", "retire", p.id, "--actor", panelActor(), "--reason", reason.trim()], "Hunch: retiring policy…");
  if (res.ok) { vscode.window.showInformationMessage(`Retired ${p.id}; window closed, history retained.`); onDone(); }
}

/** Demote an active blocking policy to advisory (never erases history). */
export async function demotePolicy(root: string, node: PolicyNode, onDone: () => void): Promise<void> {
  const p = node.policy;
  const pick = await vscode.window.showWarningMessage(
    `Demote this BLOCKING rule to advisory?\n\n${p.statement.slice(0, 160)}`,
    { modal: true, detail: `It stops failing edits/commits immediately but keeps surfacing as advisory. History is preserved (audited demotion by ${panelActor()}).` },
    "Demote to advisory",
  );
  if (pick !== "Demote to advisory") return;
  const res = await runHunchWithProgress(root, ["policy", "demote", p.id, "--actor", panelActor()], "Hunch: demoting policy…");
  if (res.ok) { vscode.window.showInformationMessage(res.stdout.trim().split("\n").pop() || `Demoted ${p.id}.`); onDone(); }
}

/** The strictness switch — how firmly the pre-edit gate enforces memory. Reads the
 *  current level (`hunch firmness --json`), offers the four levels, and sets it. */
export async function setFirmness(root: string, onDone: () => void): Promise<void> {
  const res = await runHunch(root, ["firmness", "--json"]);
  let current = "advisory";
  let levels = ["off", "advisory", "firm", "strict"];
  try { const j = JSON.parse(res.stdout) as { firmness?: string; levels?: string[] }; current = j.firmness ?? current; levels = j.levels ?? levels; }
  catch { /* CLI missing/old — fall back to the built-in defaults */ }
  const descr: Record<string, string> = {
    off: "hooks do nothing",
    advisory: "surface memory, never block (default)",
    firm: "block on a direct, high-confidence invariant",
    strict: "block on any in-scope blocking invariant",
  };
  const items = levels.map((l) => ({ label: `${l === current ? "$(check) " : "$(blank) "}${l}`, description: descr[l] ?? "", level: l }));
  const pick = await vscode.window.showQuickPick(items, {
    title: `Hunch strictness — now: ${current}`,
    placeHolder: "How firmly should the pre-edit gate enforce memory?",
  });
  if (!pick || pick.level === current) return;
  const set = await runHunchWithProgress(root, ["firmness", pick.level], "Hunch: setting strictness…");
  if (set.ok) { vscode.window.showInformationMessage(`Hunch strictness → ${pick.level}.`); onDone(); }
}
