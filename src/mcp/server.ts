/**
 * MCP server — the structured two-way API into the Hunch (DESIGN.md §7 / App. A).
 * Exposes read tools (query/why/bug_lineage/check_constraints/get_dependents) and
 * a write tool (record_decision). Registered with Claude Code via .mcp.json.
 *
 * STDIO PROTOCOL RULE: stdout carries JSON-RPC — never console.log here. All
 * diagnostics go to stderr.
 */
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { z } from "zod";
import { hunchPaths, findRoot } from "../core/paths.js";
import { HunchStore } from "../store/hunchStore.js";
import { decisionId } from "../core/ids.js";
import { revParse } from "../extractors/git.js";
import { formatContext } from "../core/format.js";
import type { Decision, Symbol } from "../core/types.js";

type ToolResult = { content: Array<{ type: "text"; text: string }>; isError?: boolean };
const ok = (text: string): ToolResult => ({ content: [{ type: "text", text }] });
const err = (text: string): ToolResult => ({ content: [{ type: "text", text }], isError: true });

// Read-side token budgets: every tool result is injected into a Claude Code
// session, so an uncapped list pollutes the context window. Cap each list to its
// highest-signal head (records are pre-sorted by severity/confidence) and tell the
// caller what was withheld rather than truncating silently.
const WHY_CAP = 6; // per record-type in hunch_why
const DEP_CAP = 25; // dependents in hunch_get_dependents
const QUERY_HITS = 8; // hunch_query matches (was 12)
const SEV_CONSTRAINT: Record<string, number> = { blocking: 3, warning: 2, advisory: 1 };
const SEV_BUG: Record<string, number> = { critical: 4, high: 3, medium: 2, low: 1 };
const more = (total: number, cap: number, hint = ""): string =>
  total > cap ? `\n  …(+${total - cap} more${hint ? ` — ${hint}` : ""})` : "";

/** Resolve a free-form target (symbol id / name / file path) to symbol records. */
function resolveSymbols(store: HunchStore, target: string): Symbol[] {
  const syms = store.json.loadAll("symbols");
  const byId = syms.find((s) => s.id === target);
  if (byId) return [byId];
  const byName = syms.filter((s) => s.name === target);
  if (byName.length) return byName;
  return syms.filter((s) => s.file === target || s.file.endsWith(target));
}

export function buildServer(root: string): McpServer {
  const store = new HunchStore(hunchPaths(root));
  // Ensure the SQLite index reflects the JSON source of truth on startup.
  try {
    store.reindex();
  } catch (e) {
    console.error("[hunch-mcp] reindex on startup failed:", (e as Error).message);
  }

  const server = new McpServer({ name: "hunch", version: "0.1.0" });

  // -- hunch_query ----------------------------------------------------------
  server.registerTool(
    "hunch_query",
    {
      title: "Query Hunch",
      description:
        "Full-text + graph search across the engineering memory (decisions, bugs, constraints, components, symbols). Returns ranked records with provenance. Use this to ask 'why' questions about the codebase.",
      inputSchema: { query: z.string().describe("A natural-language question or keywords.") },
    },
    async ({ query }): Promise<ToolResult> => {
      const hits = store.search(query, QUERY_HITS);
      if (!hits.length) return ok(`No matches for "${query}".`);
      const lines = hits.map((h) => {
        const r = store.resolve(h.ref);
        return `• [${h.kind}] ${h.ref} — ${h.title}\n    ${h.snippet}${provLine(r?.record)}`;
      });
      return ok(`Top matches for "${query}":\n\n${lines.join("\n")}`);
    },
  );

  // -- hunch_why ------------------------------------------------------------
  server.registerTool(
    "hunch_why",
    {
      title: "Explain why a file/symbol is the way it is",
      description:
        "Return the decisions, bugs, and constraints that explain a file path or symbol — the 'why' and the 'what must not break', with evidence.",
      inputSchema: { target: z.string().describe("A file path (e.g. src/auth/session.ts) or symbol name.") },
    },
    async ({ target }): Promise<ToolResult> => {
      const w = store.why(target);
      // Highest-signal first, then cap: invariants by severity, decisions by
      // confidence, bugs by severity — so a hot file's trim drops the tail, not
      // the records that matter most.
      const decisions = [...w.decisions].sort((a, b) => (b.provenance.confidence ?? 0) - (a.provenance.confidence ?? 0));
      const constraints = [...w.constraints].sort((a, b) => (SEV_CONSTRAINT[b.severity] ?? 0) - (SEV_CONSTRAINT[a.severity] ?? 0));
      const bugs = [...w.bugs].sort((a, b) => (SEV_BUG[b.severity] ?? 0) - (SEV_BUG[a.severity] ?? 0));
      const parts: string[] = [`Why for "${target}":`];
      if (decisions.length)
        parts.push(`\nDECISIONS:\n${decisions.slice(0, WHY_CAP).map((d) => `  • ${d.id} [${d.status}] ${d.title}\n      ${d.decision}${provLine(d)}`).join("\n")}${more(decisions.length, WHY_CAP, "narrow the target")}`);
      if (constraints.length)
        parts.push(`\nCONSTRAINTS (must not break):\n${constraints.slice(0, WHY_CAP).map((c) => `  • ${c.id} [${c.severity}] ${c.statement}${provLine(c)}`).join("\n")}${more(constraints.length, WHY_CAP)}`);
      if (bugs.length)
        parts.push(`\nBUG HISTORY:\n${bugs.slice(0, WHY_CAP).map((b) => `  • ${b.id} [${b.status}/${b.severity}] ${b.title}\n      root cause: ${b.root_cause}${provLine(b)}`).join("\n")}${more(bugs.length, WHY_CAP)}`);
      if (w.components.length) parts.push(`\nCOMPONENTS: ${w.components.map((c) => `${c.name} (${c.id})`).join(", ")}`);
      if (w.symbols.length) parts.push(`\nSYMBOLS: ${w.symbols.slice(0, WHY_CAP * 2).map((s) => `${s.name} [fan-in ${s.metrics.fan_in}, churn ${s.metrics.churn_90d}]`).join(", ")}${more(w.symbols.length, WHY_CAP * 2)}`);
      if (parts.length === 1) parts.push("\n(No recorded decisions/bugs/constraints yet for this target.)");
      return ok(parts.join("\n"));
    },
  );

  // -- hunch_bug_lineage ----------------------------------------------------
  server.registerTool(
    "hunch_bug_lineage",
    {
      title: "Find related bugs and their lineage",
      description:
        "Given a symptom description or a symbol, return matching bugs with their lineage (introduced → fixed → recurrence) so the agent doesn't re-discover past root causes.",
      inputSchema: { symptom_or_symbol: z.string().describe("A symptom description or a symbol/file.") },
    },
    async ({ symptom_or_symbol }): Promise<ToolResult> => {
      const bugs = store.bugLineage(symptom_or_symbol);
      if (!bugs.length) return ok(`No matching bugs for "${symptom_or_symbol}".`);
      const lines = bugs.map((b) => {
        const l = b.lineage;
        return `• ${b.id} [${b.status}/${b.severity}] ${b.title}\n    symptom: ${b.symptom}\n    root cause: ${b.root_cause}\n    lineage: introduced=${l.introduced_commit ?? "?"} fixed=${l.fixed_commit ?? "?"} recurrence_of=${l.recurrence_of ?? "—"} → decision=${l.spawned_decision ?? "—"} constraint=${l.spawned_constraint ?? "—"}${provLine(b)}`;
      });
      return ok(`Bugs related to "${symptom_or_symbol}":\n\n${lines.join("\n")}`);
    },
  );

  // -- hunch_check_constraints ---------------------------------------------
  server.registerTool(
    "hunch_check_constraints",
    {
      title: "Check invariants in scope",
      description:
        "Return constraints whose scope matches a glob/path, sorted by severity. Call this BEFORE editing code to avoid breaking intentional invariants.",
      inputSchema: { scope: z.string().describe("A path or glob, e.g. src/auth/** or src/auth/session.ts") },
    },
    async ({ scope }): Promise<ToolResult> => {
      const cons = store.checkConstraints(scope);
      if (!cons.length) return ok(`No constraints in scope "${scope}".`);
      const lines = cons.map((c) => `• ${c.id} [${c.severity}/${c.enforcement}] ${c.statement}\n    rationale: ${c.rationale}${provLine(c)}`);
      return ok(`Constraints affecting "${scope}":\n\n${lines.join("\n")}`);
    },
  );

  // -- hunch_get_dependents -------------------------------------------------
  server.registerTool(
    "hunch_get_dependents",
    {
      title: "Blast radius (transitive dependents)",
      description:
        "Return everything that transitively depends on a symbol/component (callers + dependent components) so a change's blast radius is known before editing.",
      inputSchema: { symbol: z.string().describe("A symbol id, symbol name, or file path.") },
    },
    async ({ symbol }): Promise<ToolResult> => {
      const matches = resolveSymbols(store, symbol);
      const ids = matches.length ? matches.map((s) => s.id) : [symbol];
      const all = new Map<string, { id: string; depth: number; via: string }>();
      for (const id of ids) for (const d of store.getDependents(id)) if (!all.has(d.id)) all.set(d.id, d);
      const deps = [...all.values()].sort((a, b) => a.depth - b.depth);
      if (!deps.length) return ok(`Nothing depends on "${symbol}" (leaf node, or not indexed).`);
      // Nearest dependents first (sorted by depth); cap the tail so a high-fan-in
      // symbol can't flood the session context.
      const lines = deps.slice(0, DEP_CAP).map((d) => `  • [depth ${d.depth}] ${d.via} (${d.id})`);
      return ok(`Blast radius of "${symbol}" — ${deps.length} dependent(s):\n${lines.join("\n")}${more(deps.length, DEP_CAP, "closest shown first")}`);
    },
  );

  // -- hunch_context (surgical retrieval) -----------------------------------
  server.registerTool(
    "hunch_context",
    {
      title: "Assemble the minimal relevant Hunch slice for a task",
      description:
        "Given a file or symbol you're about to work on, return the MINIMAL relevant memory — invariants to preserve, decisions explaining the design, bug history not to reintroduce, and the blast radius — as a compact brief. Call this FIRST when starting work on something.",
      inputSchema: {
        target: z.string().describe("A file path or symbol you're about to edit."),
        budget_tokens: z.number().optional().describe("Rough token budget for the brief (default 1500)."),
      },
    },
    async ({ target, budget_tokens }): Promise<ToolResult> => {
      return ok(formatContext(store.assembleContext(target, budget_tokens ?? 1500)));
    },
  );

  // -- hunch_record_decision (write-back) -----------------------------------
  server.registerTool(
    "hunch_record_decision",
    {
      title: "Record a decision (write-back)",
      description:
        "Persist a new Decision (ADR) into Hunch with provenance. Use after making a non-trivial design choice so future sessions are grounded in it.",
      inputSchema: {
        decision: z.object({
          title: z.string(),
          context: z.string().optional(),
          decision: z.string().optional(),
          consequences: z.array(z.string()).optional(),
          alternatives_rejected: z.array(z.string()).optional(),
          related_files: z.array(z.string()).optional(),
          related_components: z.array(z.string()).optional(),
          status: z.enum(["proposed", "accepted", "rejected", "superseded"]).optional(),
          commit: z.string().optional(),
        }),
      },
    },
    async ({ decision }): Promise<ToolResult> => {
      try {
        // Commit-keyed on the CANONICAL full sha (resolved via git rev-parse), so a
        // human passing the short sha they see in `commit` produces the SAME id as
        // the auto-sync path (which keys on the full sha) — UPGRADING the auto-draft
        // instead of duplicating it. If the ref can't be resolved to a real full
        // sha, fall back to the title/manual namespace so we never key on a raw,
        // unverified string that could collide with (or orphan) a real commit id.
        const resolved = decision.commit ? revParse(decision.commit, root) : null;
        const fullSha = resolved && /^[0-9a-f]{40}$/.test(resolved) ? resolved : null;
        const id = fullSha ? decisionId(fullSha) : decisionId(`manual:${decision.title}`);

        // Preserve the ADR lineage: upgrading an auto-draft yields the composite
        // provenance the design specifies.
        const existing = store.json.get("decisions", id);
        const source = existing && existing.provenance.source.includes("llm_draft")
          ? "llm_draft+human_confirmed"
          : "human_confirmed";

        const rec: Decision = {
          id,
          title: decision.title,
          status: decision.status ?? "accepted",
          context: decision.context ?? existing?.context ?? "",
          decision: decision.decision ?? existing?.decision ?? "",
          consequences: decision.consequences ?? [],
          alternatives_rejected: decision.alternatives_rejected ?? [],
          related_components: decision.related_components ?? existing?.related_components ?? [],
          related_files: decision.related_files ?? existing?.related_files ?? [],
          supersedes: existing?.supersedes ?? null,
          caused_by_bug: existing?.caused_by_bug ?? null,
          commit: decision.commit ?? existing?.commit ?? null,
          provenance: { source, confidence: 0.95, evidence: decision.related_files ?? existing?.provenance.evidence ?? [] },
          date: new Date().toISOString(),
        };
        store.json.put("decisions", rec);
        store.reindex();
        const note = decision.commit && !fullSha ? ` (note: commit "${decision.commit}" could not be resolved — recorded as a standalone decision, not linked to a commit)` : "";
        return ok(`Recorded decision ${id}: "${rec.title}" (status ${rec.status}, ${source}).${note}`);
      } catch (e) {
        return err(`Failed to record decision: ${(e as Error).message}`);
      }
    },
  );

  return server;
}

function provLine(record: unknown): string {
  const p = (record as { provenance?: { source?: string; confidence?: number; last_verified?: string } } | undefined)?.provenance;
  if (!p) return "";
  const v = p.last_verified ? `, verified ${p.last_verified.slice(0, 10)}` : "";
  return `\n      ⟨${p.source ?? "?"}, confidence ${p.confidence ?? "?"}${v}⟩`;
}

/** Start the stdio server (called by `hunch mcp`). */
export async function startServer(cwd: string = process.cwd()): Promise<void> {
  const root = findRoot(cwd);
  const server = buildServer(root);
  const transport = new StdioServerTransport();
  await server.connect(transport);
  console.error(`[hunch-mcp] serving Hunch at ${root} over stdio`);
}
