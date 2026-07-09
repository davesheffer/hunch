/**
 * Language-model tools over the Hunch graph — zero-setup Copilot access.
 * Registered via the `languageModelTools` contribution (package.json), so any
 * chat agent in this window can call hunch-vscode_why / _context / _query
 * WITHOUT the user configuring the MCP server. Pure readers over the same
 * committed JSON the rest of the extension uses; they never shell out and
 * never write. (The MCP server stays the richer, cross-client surface.)
 */
import * as vscode from "vscode";
import {
  why, nearConstraints, constraintsInScope, searchAll, fragileSymbols,
  type Hunch,
} from "./hunchData.js";

type GetHunch = () => Hunch | null;

/** Normalize a model-supplied target (absolute/Windows/`./` paths) to the
 *  graph's workspace-relative POSIX form. */
function normTarget(target: string, root: string | undefined): string {
  let t = target.trim().replace(/\\/g, "/");
  if (root) {
    const r = root.replace(/\\/g, "/").replace(/\/$/, "") + "/";
    if (t.toLowerCase().startsWith(r.toLowerCase())) t = t.slice(r.length);
  }
  return t.replace(/^\.\//, "");
}

function text(s: string): vscode.LanguageModelToolResult {
  return new vscode.LanguageModelToolResult([new vscode.LanguageModelTextPart(s)]);
}

const NO_GRAPH = "No Hunch graph found: this workspace has no .hunch/ directory. Suggest the user run `hunch init` (npm i -g @davesheffer/hunch).";

/** Resolve a target that may be a symbol name rather than a file path. */
function fileForTarget(hunch: Hunch, target: string): { file: string; symbol?: string } {
  if (target.includes("/") || target.includes(".")) return { file: target };
  const sym = hunch.symbols.find((s) => s.name === target);
  return sym ? { file: sym.file, symbol: target } : { file: target };
}

function whyText(hunch: Hunch, rawTarget: string): string {
  const { file, symbol } = fileForTarget(hunch, rawTarget);
  const w = why(hunch, file);
  const near = nearConstraints(hunch, file);
  const lines: string[] = [`# Hunch memory for ${symbol ? `symbol \`${symbol}\` (${file})` : file}`];
  const section = (h: string, items: string[]): void => {
    if (items.length) lines.push(``, `## ${h}`, ...items.map((i) => `- ${i}`));
  };
  section("Invariants in scope (MUST NOT break)", w.constraints.map((c) =>
    `[${c.severity}] ${c.statement}${c.rationale ? ` — rationale: ${c.rationale}` : ""} (${c.id})`));
  section("Near-invariants (a guarded dependency is downstream)", near.map((n) =>
    `[${n.c.severity}] ${n.c.statement} — reached via ${n.via}`));
  section("Decisions that shaped this code", w.decisions.map((d) =>
    `[${d.status ?? "?"}] ${d.title}${d.decision ? ` — ${d.decision}` : ""}${d.alternatives_rejected?.length ? ` (REJECTED: ${d.alternatives_rejected.join("; ")})` : ""} (${d.id})`));
  section("Bug history (do not reintroduce)", w.bugs.map((b) =>
    `[${b.severity}/${b.status}] ${b.title}${b.root_cause ? ` — root cause: ${b.root_cause}` : ""} (${b.id})`));
  section("Blast radius (direct dependents)", w.dependents.map((d) => `${d.name} @ ${d.file}`));
  if (lines.length === 1) lines.push(``, `Nothing recorded for this target yet — the graph is still learning it. No invariants block an edit here.`);
  return lines.join("\n");
}

class WhyTool implements vscode.LanguageModelTool<{ target: string }> {
  constructor(private getHunch: GetHunch, private root: () => string | undefined) {}
  prepareInvocation(o: vscode.LanguageModelToolInvocationPrepareOptions<{ target: string }>): vscode.PreparedToolInvocation {
    return { invocationMessage: `Reading Hunch memory for ${o.input.target}` };
  }
  invoke(o: vscode.LanguageModelToolInvocationOptions<{ target: string }>): vscode.LanguageModelToolResult {
    const hunch = this.getHunch();
    if (!hunch) return text(NO_GRAPH);
    return text(whyText(hunch, normTarget(o.input.target, this.root())));
  }
}

class ContextTool implements vscode.LanguageModelTool<{ target: string }> {
  constructor(private getHunch: GetHunch, private root: () => string | undefined) {}
  prepareInvocation(o: vscode.LanguageModelToolInvocationPrepareOptions<{ target: string }>): vscode.PreparedToolInvocation {
    return { invocationMessage: `Assembling Hunch context for ${o.input.target}` };
  }
  invoke(o: vscode.LanguageModelToolInvocationOptions<{ target: string }>): vscode.LanguageModelToolResult {
    const hunch = this.getHunch();
    if (!hunch) return text(NO_GRAPH);
    const target = normTarget(o.input.target, this.root());
    // The pre-edit brief: why + the repo-wide fragility signal for this file.
    const fragile = fragileSymbols(hunch, 9999).filter((s) => s.file === target).slice(0, 5);
    let body = whyText(hunch, target);
    if (fragile.length) {
      body += `\n\n## Fragile symbols in this file (touch with care)\n` +
        fragile.map((s) => `- ${s.name} (score ${s.score}: ${s.evidence})`).join("\n");
    }
    return text(body);
  }
}

class QueryTool implements vscode.LanguageModelTool<{ query: string }> {
  constructor(private getHunch: GetHunch) {}
  prepareInvocation(o: vscode.LanguageModelToolInvocationPrepareOptions<{ query: string }>): vscode.PreparedToolInvocation {
    return { invocationMessage: `Searching Hunch memory: “${o.input.query}”` };
  }
  invoke(o: vscode.LanguageModelToolInvocationOptions<{ query: string }>): vscode.LanguageModelToolResult {
    const hunch = this.getHunch();
    if (!hunch) return text(NO_GRAPH);
    const hits = searchAll(hunch, o.input.query).slice(0, 15);
    if (!hits.length) return text(`No Hunch records match “${o.input.query}”.`);
    return text([
      `# Hunch records matching “${o.input.query}”`,
      ...hits.map((h) => `- [${h.kind}] ${h.label}${h.detail ? ` — ${h.detail}` : ""}${h.file ? ` (${h.file})` : ""} (${h.id})`),
    ].join("\n"));
  }
}

/** Register the three tools. Names MUST match the package.json contribution. */
export function registerLmTools(context: vscode.ExtensionContext, getHunch: GetHunch, root: () => string | undefined): void {
  context.subscriptions.push(
    vscode.lm.registerTool("hunch-vscode_why", new WhyTool(getHunch, root)),
    vscode.lm.registerTool("hunch-vscode_context", new ContextTool(getHunch, root)),
    vscode.lm.registerTool("hunch-vscode_query", new QueryTool(getHunch)),
  );
}
