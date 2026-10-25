import { readFileSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";

/** Whether a delegated agent can call Hunch's MCP tools. A named role defined in
 *  `.claude/agents/<type>.md` (project first, then user) with a `tools:` list that
 *  names no `mcp__hunch` tool and no wildcard cannot: telling it to call
 *  hunch_why only costs it a failed lookup. Built-in and unknown types inherit
 *  the parent's tools. */
export function roleHasHunchTools(root: string, agentType: string, home = homedir()): boolean {
  const type = agentType.trim();
  if (!type || !/^[\w.-]+$/.test(type)) return true;
  for (const dir of [join(root, ".claude", "agents"), join(home, ".claude", "agents")]) {
    let text: string;
    try { text = readFileSync(join(dir, `${type}.md`), "utf8"); } catch { continue; }
    const front = /^---\r?\n([\s\S]*?)\r?\n---/.exec(text)?.[1];
    if (!front) return true;
    const tools = /^tools:[ \t]*(.*(?:\r?\n[ \t]+-.*)*)/m.exec(front)?.[1];
    if (tools === undefined || !tools.trim()) return true;
    return /\*|mcp__hunch/.test(tools);
  }
  return true;
}
