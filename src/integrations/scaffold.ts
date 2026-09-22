/**
 * Writes the two remaining Claude Code integration surfaces (DESIGN.md §7):
 *   - .mcp.json          → registers the `hunch` MCP server with Claude Code
 *   - .claude/commands/* → user-triggered slash commands for the §5 workflows
 */
import { readFileSync, existsSync, mkdirSync } from "node:fs";
import { writeFileAtomic } from "../core/io.js";
import { join, dirname } from "node:path";
import { isHunchHookCommand } from "./hookmatch.js";

export interface Invocation {
  command: string;
  args: string[]; // args BEFORE the subcommand (e.g. ["/abs/dist/cli/index.js"])
}

/** Merge a `hunch` server entry into .mcp.json, preserving other servers.
 *  A non-empty file we cannot parse THROWS instead of being silently replaced
 *  (con_8460b6770f — it may hold the user's other MCP servers); the caller
 *  degrades that to a warning. */
export function writeMcpJson(root: string, inv: Invocation): string {
  const file = join(root, ".mcp.json");
  let json: { mcpServers?: Record<string, unknown> } = {};
  if (existsSync(file)) {
    const raw = readFileSync(file, "utf8");
    if (raw.trim()) {
      try {
        const v = JSON.parse(raw);
        if (!v || typeof v !== "object" || Array.isArray(v)) throw new Error("not a JSON object");
        json = v as { mcpServers?: Record<string, unknown> };
      } catch (e) {
        throw new Error(`refusing to overwrite ${file}: could not parse it (${(e as Error).message}). Fix or remove it, then re-run.`);
      }
    }
  }
  const servers = json.mcpServers;
  if (servers !== undefined && (!servers || typeof servers !== "object" || Array.isArray(servers))) {
    throw new Error(`refusing to edit ${file}: mcpServers must be a JSON object when present; fix it, then re-run.`);
  }
  json.mcpServers = servers as Record<string, unknown> | undefined ?? {};
  json.mcpServers.hunch = { command: inv.command, args: [...inv.args, "mcp"] };
  // Atomic: .mcp.json holds the user's other servers — a torn write would leave
  // it unparseable, which this writer then refuses to touch (issue #43).
  writeFileAtomic(file, JSON.stringify(json, null, 2) + "\n");
  return file;
}

const WHY_CMD = `---
description: Explain why a file or symbol is the way it is, from Hunch
---
Use the \`hunch_why\` MCP tool on **$ARGUMENTS** (a file path or symbol name).

Then summarize, with citations:
- the **decisions** that shaped it (id + rationale),
- the **constraints** that must not break,
- the **bug history** behind it (root causes).

Cite record ids and their provenance/confidence. If Hunch returns nothing,
say so plainly and suggest running \`hunch index\` or \`hunch backfill\`.
`;

const FIX_CMD = `---
description: Fix a bug grounded in Hunch (past root causes, constraints, blast radius)
---
We are fixing: **$ARGUMENTS**

Follow the Hunch-grounded workflow (DESIGN §5) — do NOT skip the memory lookups:
1. \`hunch_bug_lineage("$ARGUMENTS")\` — has this class of bug happened before? what was the root cause and the fix?
2. Identify the suspect symbol/file, then \`hunch_get_dependents(<symbol>)\` to learn the blast radius.
3. \`hunch_check_constraints(<scope>)\` — list invariants you must preserve.
4. Propose a fix that honors past root causes AND constraints. Apply it and run the tests.
5. If the fix encodes a non-trivial choice, \`hunch_record_decision(...)\` so the next session is grounded in it.
`;

const FRAGILE_CMD = `---
description: Report the most fragile parts of this codebase, with evidence
---
Ask Hunch for the fragility ranking (run \`hunch fragile\` or query Hunch),
then produce a **fragility report with evidence**: the specific files/functions,
the bug history behind them, their churn and fan-in, and any missing guards.
Avoid generic advice — every claim must cite a Hunch record or metric.
`;

const CAPTURE_CMD = `---
description: Capture an engineering decision into Hunch's graph via a grilling interview (topic, rationale, rejected alternatives)
---
Capture the decision for **$ARGUMENTS** into Hunch's graph.

1. Call \`hunch_capture_decision(topic?, seed?)\` — it returns the grilling protocol and a capture-session token.
2. Run the GRILLING LOOP: one focused question at a time. Push back on hand-wavy answers. Resolve every branch before committing — an unexamined decision poisons the graph.
3. Confirm the TOPIC anchor with me before committing. One topic per decision; if it spans two, split into two captures.
4. Capture REJECTED alternatives explicitly (what, and why not) — this is what makes the decision enforceable (Veto/drift check against it).
5. Commit with \`hunch_record_decision\`, passing \`capture_token\` (from step 1) and the confirmed \`topic\`. The artifact is the graph write, not prose. The token is not my signature: confirm the record in the client prompt if one appears; otherwise it stays agent testimony until I run the \`hunch review --confirm <id>\` command the response prints.
6. On CONFLICT for the topic, do NOT auto-supersede — Hunch refuses and presents both; let me choose supersede (link) / split the topic / discard.
`;

const WORKTREES_CMD = `---
description: Which worktrees and branches are open on which machine, what is merged and deletable — from Hunch's workspace ledger, not from git spelunking
---
Answer **$ARGUMENTS** (default: "what is open, and what can I delete?") from the workspace ledger.

1. Call \`hunch_workspaces(view: "branches")\` (and \`view: "inventory"\` for the worktree list). Do NOT run \`git branch\`, \`git worktree list\` or \`git log\` yourself — the tool already read this machine live and every other machine from memory.
2. Report the rows as they are: MACHINES, WORKTREE (dirty), UPSTREAM, MERGED (with its method) and the ACTION column. A verdict of \`unknown\` or a machine marked \`unverified\` is reported as such, never upgraded to a guess.
3. Recommend only what the ACTION column says. You never delete a branch or remove a worktree from this command; the human runs the printed git commands (or \`hunch workspaces prune\` when it ships) on the machine that holds them.
4. If a machine is missing or stale, say so: it has not run \`hunch workspaces snapshot\` (the post-checkout hook / MCP session start does this) or it is not sharing an overlay.
`;

const AUDIT_CMD = `---
description: Run an audit and record what it finds into Hunch as findings (observed gaps, no code change)
---
Audit **$ARGUMENTS** and record what you find into Hunch's graph.

1. Run the actual check (query/grep/script) — a finding needs EVIDENCE: the exact command you ran plus representative output. Never record a finding you didn't observe.
2. For each REAL gap: \`hunch_record_finding\` with title, observation, evidence, affected_files/affected_symbols, severity. It grounds future edits to those files automatically.
3. If the gap violates an existing invariant, link it via \`violates_constraint\`. If the RULE itself is unrecorded, capture the rule FIRST (\`hunch_record_correction\`), then link it.
4. If the audit is re-runnable, capture the procedure as a runbook and set \`method\` to its rb_* id — that makes the finding re-verifiable, not folklore.
5. Triage with me inline: open (default) / accepted-risk / scheduled. NEVER mark resolved without the fixing commit (\`resolved_commit\`).
6. Report: findings recorded (ids), what was checked and came back clean, and what stays unverified.
`;

const HEAL_CMD = `---
description: Reconcile docs/code with Hunch's decision graph (doc≠graph drift), never rewriting prose silently
---
Reconcile decision-grounding drift for **$ARGUMENTS** (or the whole repo).

1. Run \`hunch drift\` (or \`hunch heal\`) to list doc≠graph **anchor-stale** sections — a file still anchored to a superseded decision while a current one exists. Only explicit topic anchors fire; never a semantic guess.
2. For each, assume the DOC is stale first (Heal A). Propose an edit bringing the file to the CURRENT decision; show it as a diff and wait for my confirm. Never rewrite prose silently.
3. Only if I explicitly say "the DECISION is stale, not the doc" (Heal B): run /capture to record a superseding decision, then return to step 2 — the prose re-derives from the new decision as a separate confirm.
4. Report: healed (Heal A), superseded (Heal B), skipped. Never touch the graph except via an explicit Heal B capture.
`;

export interface ClaudeHookInstall {
  path: string;
  action: "created" | "updated" | "unchanged";
}

interface HookEntry {
  matcher?: string;
  hooks?: Array<{ type?: string; command?: string }>;
}

/** Strip Hunch's own commands out of one settings.json hook entry, matching with
 *  the SAME anchored rule the provider writers use (isHunchHookCommand, issue
 *  #41) so an unrelated tool that merely shares our layout — `node
 *  tools/lint/dist/cli/index.js hook` — is never classified as ours. Claude
 *  Code's hooks carry no `--provider`, hence the bare-tail variant.
 *
 *  Filtering per COMMAND rather than per entry is what keeps a MIXED entry (our
 *  hook and the user's own command side by side) intact: the entry survives with
 *  its matcher and the user's remaining commands in order, and is dropped only
 *  when nothing of the user's is left. Dropping the whole entry deleted user
 *  hooks (con_8460b6770f, issue #310). */
function withoutHunchCommands(entry: HookEntry, hookCmd: string): HookEntry | null {
  const hooks = entry.hooks;
  if (!Array.isArray(hooks)) return entry;
  // The command being installed is ours by definition, whatever shape a future
  // launcher takes — so a re-run stays idempotent even if the matcher lags it.
  const kept = hooks.filter((h) => !(typeof h?.command === "string" && (h.command === hookCmd || isHunchHookCommand(h.command, false))));
  if (kept.length === hooks.length) return entry;
  return kept.length ? { ...entry, hooks: kept } : null;
}

/**
 * Install the Claude Code AGENT hooks into `.claude/settings.json` so the agent
 * is grounded in Hunch automatically (not by remembering to call the tools):
 *   - PreToolUse (Edit|Write|MultiEdit) → inject the relevant Hunch slice before
 *     an edit, and (at strict firmness) deny edits that hit a blocking invariant.
 *   - UserPromptSubmit → remind the agent to consult Hunch.
 * Both invoke `hunch hook`, which reads the firmness level from .hunch/config.json
 * at run time — so changing firmness needs no settings.json edit. We own only our
 * commands (matched by isHunchHookCommand): other hooks and settings are preserved, and a
 * non-empty file we cannot parse THROWS rather than clobbering the user's config.
 */
export function installClaudeHooks(root: string, hookCmd: string): ClaudeHookInstall {
  const file = join(root, ".claude", "settings.json");
  const existed = existsSync(file);
  let json: { hooks?: Record<string, HookEntry[]>; [k: string]: unknown } = {};
  let before = "";
  if (existed) {
    before = readFileSync(file, "utf8");
    if (before.trim()) {
      try {
        const v = JSON.parse(before);
        if (!v || typeof v !== "object" || Array.isArray(v)) throw new Error("not a JSON object");
        json = v;
      } catch (e) {
        throw new Error(`refusing to overwrite ${file}: could not parse it (${(e as Error).message}). Fix or remove it, then re-run.`);
      }
    }
  }
  const hooks = json.hooks;
  if (hooks !== undefined && (!hooks || typeof hooks !== "object" || Array.isArray(hooks))) {
    throw new Error(`refusing to edit ${file}: hooks must be a JSON object when present; fix it, then re-run.`);
  }
  json.hooks = hooks as Record<string, HookEntry[]> | undefined ?? {};
  for (const event of ["PreToolUse", "UserPromptSubmit", "SessionStart", "SubagentStart", "PreCompact", "PostToolUse", "PostToolUseFailure", "Stop"]) {
    const existing = json.hooks[event];
    if (existing !== undefined && !Array.isArray(existing)) {
      throw new Error(`refusing to edit ${file}: hooks.${event} must be an array when present; fix it, then re-run.`);
    }
  }
  const keep = (arr?: HookEntry[]) =>
    (Array.isArray(arr) ? arr.map((entry) => withoutHunchCommands(entry, hookCmd)).filter((e): e is HookEntry => e !== null) : []);

  json.hooks.PreToolUse = [
    ...keep(json.hooks.PreToolUse),
    { matcher: "Edit|Write|MultiEdit", hooks: [{ type: "command", command: hookCmd }] },
  ];
  json.hooks.UserPromptSubmit = [
    ...keep(json.hooks.UserPromptSubmit),
    { hooks: [{ type: "command", command: hookCmd }] },
  ];
  // Orientation at session start: recent decisions + the live roadmap, injected
  // once, so the agent begins already knowing where the work stands.
  json.hooks.SessionStart = [
    ...keep(json.hooks.SessionStart),
    { hooks: [{ type: "command", command: hookCmd }] },
  ];
  // Delegated agents start with no session grounding (orientation never fired
  // inside them); compaction summarizes injected grounding away while the dedup
  // map still says "delivered". These two events keep delivery alive across the
  // whole session lifecycle, not just its first context window.
  json.hooks.SubagentStart = [
    ...keep(json.hooks.SubagentStart),
    { hooks: [{ type: "command", command: hookCmd }] },
  ];
  json.hooks.PreCompact = [
    ...keep(json.hooks.PreCompact),
    { hooks: [{ type: "command", command: hookCmd }] },
  ];
  // Verification pipeline (core/pipeline.ts): PostToolUse records observable
  // facts (edits, verify commands); Stop refuses to end a turn with unverified
  // product edits at firm/strict firmness. Delivery is enforced, not hoped for.
  json.hooks.PostToolUse = [
    ...keep(json.hooks.PostToolUse),
    { matcher: "Edit|Write|MultiEdit|Bash|PowerShell|Skill", hooks: [{ type: "command", command: hookCmd }] },
  ];
  // Modern Claude Code separates failed tools from PostToolUse. Observe that
  // event too so a failed test cannot be mistaken for a completed proof.
  json.hooks.PostToolUseFailure = [
    ...keep(json.hooks.PostToolUseFailure),
    { matcher: "Bash|PowerShell", hooks: [{ type: "command", command: hookCmd }] },
  ];
  json.hooks.Stop = [
    ...keep(json.hooks.Stop),
    { hooks: [{ type: "command", command: hookCmd }] },
  ];

  const next = JSON.stringify(json, null, 2) + "\n";
  if (existed && before === next) return { path: file, action: "unchanged" };
  mkdirSync(dirname(file), { recursive: true });
  writeFileAtomic(file, next);
  return { path: file, action: existed ? "updated" : "created" };
}

/** Ownership marker for generated slash commands: its presence means Hunch may
 *  refresh the file; deleting the line hands the file to the user for good. */
const CMD_MARKER = "<!-- hunch:generated — refreshed by hunch init; delete this line to take ownership -->";

export function writeSlashCommands(root: string): { written: string[]; skipped: string[] } {
  const dir = join(root, ".claude", "commands");
  mkdirSync(dir, { recursive: true });
  const written: string[] = [];
  const skipped: string[] = [];
  const files: Array<[string, string]> = [
    ["hunch-why.md", WHY_CMD],
    ["hunch-fix.md", FIX_CMD],
    ["hunch-fragile.md", FRAGILE_CMD],
    ["capture.md", CAPTURE_CMD],
    ["heal.md", HEAL_CMD],
    ["audit.md", AUDIT_CMD],
    ["worktrees.md", WORKTREES_CMD],
  ];
  for (const [name, body] of files) {
    const p = join(dir, name);
    // Generic names (capture/heal/audit) are plausibly the USER'S OWN commands;
    // hunch-prefixed names are namespaced ours. Overwrite an existing file only
    // when it carries the ownership marker or the hunch- namespace — never
    // silently replace user content (issue #42). Pre-marker Hunch installs skip
    // once and report; re-adopt by deleting the file and re-running init.
    if (existsSync(p) && !name.startsWith("hunch-") && !readFileSync(p, "utf8").includes("hunch:generated")) {
      skipped.push(p);
      continue;
    }
    writeFileAtomic(p, `${body}\n${CMD_MARKER}\n`);
    written.push(p);
  }
  return { written, skipped };
}
