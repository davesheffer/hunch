/**
 * The curated command catalog behind the Hunch Console (console.ts) — the
 * human-driven CLI verbs that make sense interactively, with the metadata the
 * console needs for slash-autocomplete. Deliberately a CURATED subset:
 * setup + CI + plumbing (init, mcp, hook, ci, migrate, merge-driver, embed,
 * backfill, sync) are intentionally excluded — they aren't interactive.
 */

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

/** Strip ANSI SGR sequences so CLI color output renders cleanly in the webview.
 *  ESC is built from its code point to keep a raw control char out of the source. */
export function stripAnsi(s: string): string {
  return s.replace(new RegExp(String.fromCharCode(27) + "\[[0-9;]*m", "g"), "");
}
