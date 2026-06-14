/**
 * Writes the two remaining Claude Code integration surfaces (DESIGN.md §7):
 *   - .mcp.json          → registers the `brain` MCP server with Claude Code
 *   - .claude/commands/* → user-triggered slash commands for the §5 workflows
 */
import { readFileSync, writeFileSync, existsSync, mkdirSync } from "node:fs";
import { join } from "node:path";

export interface Invocation {
  command: string;
  args: string[]; // args BEFORE the subcommand (e.g. ["/abs/dist/cli/index.js"])
}

/** Merge a `brain` server entry into .mcp.json, preserving other servers. */
export function writeMcpJson(root: string, inv: Invocation): string {
  const file = join(root, ".mcp.json");
  let json: { mcpServers?: Record<string, unknown> } = {};
  if (existsSync(file)) {
    try {
      json = JSON.parse(readFileSync(file, "utf8"));
    } catch {
      json = {};
    }
  }
  json.mcpServers = json.mcpServers ?? {};
  json.mcpServers.brain = { command: inv.command, args: [...inv.args, "mcp"] };
  writeFileSync(file, JSON.stringify(json, null, 2) + "\n");
  return file;
}

const WHY_CMD = `---
description: Explain why a file or symbol is the way it is, from the Project Brain
---
Use the \`brain_why\` MCP tool on **$ARGUMENTS** (a file path or symbol name).

Then summarize, with citations:
- the **decisions** that shaped it (id + rationale),
- the **constraints** that must not break,
- the **bug history** behind it (root causes).

Cite record ids and their provenance/confidence. If the Brain returns nothing,
say so plainly and suggest running \`brain index\` or \`brain backfill\`.
`;

const FIX_CMD = `---
description: Fix a bug grounded in the Project Brain (past root causes, constraints, blast radius)
---
We are fixing: **$ARGUMENTS**

Follow the Brain-grounded workflow (DESIGN §5) — do NOT skip the memory lookups:
1. \`brain_bug_lineage("$ARGUMENTS")\` — has this class of bug happened before? what was the root cause and the fix?
2. Identify the suspect symbol/file, then \`brain_get_dependents(<symbol>)\` to learn the blast radius.
3. \`brain_check_constraints(<scope>)\` — list invariants you must preserve.
4. Propose a fix that honors past root causes AND constraints. Apply it and run the tests.
5. If the fix encodes a non-trivial choice, \`brain_record_decision(...)\` so the next session is grounded in it.
`;

const FRAGILE_CMD = `---
description: Report the most fragile parts of this codebase, with evidence
---
Ask the Brain for the fragility ranking (run \`brain fragile\` or query the Brain),
then produce a **fragility report with evidence**: the specific files/functions,
the bug history behind them, their churn and fan-in, and any missing guards.
Avoid generic advice — every claim must cite a Brain record or metric.
`;

export function writeSlashCommands(root: string): string[] {
  const dir = join(root, ".claude", "commands");
  mkdirSync(dir, { recursive: true });
  const written: string[] = [];
  const files: Array<[string, string]> = [
    ["brain-why.md", WHY_CMD],
    ["brain-fix.md", FIX_CMD],
    ["brain-fragile.md", FRAGILE_CMD],
  ];
  for (const [name, body] of files) {
    const p = join(dir, name);
    writeFileSync(p, body);
    written.push(p);
  }
  return written;
}
