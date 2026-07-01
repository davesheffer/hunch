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
import { hunchPaths, findRoot, toPosixTarget } from "../core/paths.js";
import { HunchStore } from "../store/hunchStore.js";
import { selectEmbedder } from "../store/embedder.js";
import { decisionId } from "../core/ids.js";
import { buildCorrectionConstraint } from "../core/correction.js";
import { knownRepoDeps } from "../synthesis/tripwires.js";
import { refreshExistingGrounding } from "../integrations/providers.js";
import { revParse, asOfDate, revExists, lastChangeDate, rangeFiles, rangeDiff, commitFiles, commitDiff, stagedFiles, stagedDiff, commitAndPushHunch, pullHunch } from "../extractors/git.js";
import { formatContext } from "../core/format.js";
import type { Runbook } from "../core/types.js";
import { compareCandidates } from "../core/compare.js";
import { checkConformance } from "../core/conformance.js";
import { renderMarkdown, verdict } from "../core/checkreport.js";
import { HUNCH_VERSION } from "../core/version.js";
import type { Decision, Symbol } from "../core/types.js";
import { liveForTopic, historyForTopic, rejectedForTopic, captureConflicts } from "../core/topics.js";
import { issueCaptureToken as issueToken, consumeCaptureToken as consumeToken } from "../core/capturetoken.js";
import { randomUUID } from "node:crypto";

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

// Capture-session tokens live in src/core/capturetoken.ts (pure + testable). These
// thin wrappers bind the process clock and id source at the call site (§5 Stage 1).
const issueCaptureToken = (): string => issueToken(randomUUID, Date.now());
const consumeCaptureToken = (token: string | undefined): boolean => consumeToken(token, Date.now());

/** The interrogation protocol returned by hunch_capture_decision. */
function grillingProtocol(topic: string | undefined, token: string): string {
  return [
    "You are capturing an engineering decision into Hunch's graph. Run the GRILLING LOOP, then commit.",
    "",
    "RULES:",
    "1. Grill ONE focused question at a time. Push back on hand-wavy answers. Resolve every branch of the decision tree before committing — an unexamined decision poisons the graph.",
    `2. Confirm the TOPIC anchor with the human before committing${topic ? ` (proposed: "${topic}")` : ""}. Exactly one topic per decision; if it spans two, split into two captures.`,
    "3. Capture REJECTED alternatives explicitly — for each, what it was and why not. This is what makes the decision enforceable (Veto/drift check against it).",
    `4. Commit with hunch_record_decision, passing capture_token:"${token}" and the confirmed topic. The artifact is the graph write, not prose.`,
    "5. On CONFLICT with an existing live decision for the topic, do NOT auto-supersede — Hunch refuses and presents both; let the human choose to supersede (link), split the topic, or discard.",
    "",
    "Required before commit: topic, title, decision, context (the rationale/why), alternatives_rejected. Missing any → keep grilling.",
  ].join("\n");
}

/** Resolve a free-form target (symbol id / name / file path) to symbol records. */
function resolveSymbols(store: HunchStore, target: string): Symbol[] {
  target = toPosixTarget(target);
  const syms = store.json.loadAll("symbols");
  const byId = syms.find((s) => s.id === target);
  if (byId) return [byId];
  const byName = syms.filter((s) => s.name === target);
  if (byName.length) return byName;
  return syms.filter((s) => s.file === target || s.file.endsWith(target));
}

/** Resolve a target to canonical indexed file path(s) (for file-granular blast
 *  radius). Falls back to the literal target so direct-scope checks still run. */
function resolveFiles(store: HunchStore, target: string): string[] {
  const files = new Set(resolveSymbols(store, target).map((s) => s.file));
  return files.size ? [...files] : [toPosixTarget(target)];
}

export function buildServer(root: string): McpServer {
  const store = new HunchStore(hunchPaths(root));
  // Two-way sync (read side): pull the private overlay's remote on startup, so THIS machine's
  // session sees memory captured on other machines/worktrees before we index — making the
  // overlay genuinely one source of truth. Best-effort, leaves a clean tree, never blocks start.
  if (store.privateDir) {
    try { pullHunch(store.privateDir); } catch { /* offline / no remote — proceed with local */ }
  }
  // Ensure the SQLite index reflects the JSON source of truth on startup.
  try {
    store.reindex();
  } catch (e) {
    console.error("[hunch-mcp] reindex on startup failed:", (e as Error).message);
  }
  // Resolve the embedder ONCE for this long-lived process (never throws; null when
  // the optional model isn't installed). The model then loads lazily on the first
  // hunch_query and stays warm — and hybridSearch degrades to FTS until then.
  const embedderReady = selectEmbedder();

  const server = new McpServer({ name: "hunch", version: HUNCH_VERSION });

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
      const hits = await store.hybridSearch(query, QUERY_HITS, { embedder: await embedderReady });
      if (!hits.length) return ok(`No matches for "${query}".`);
      const lines = hits.map((h) => {
        const r = store.resolve(h.ref);
        return `• [${h.kind}] ${h.ref} — ${h.title}\n    ${h.snippet}${provLine(r?.record)}`;
      });
      return ok(`Top matches for "${query}":\n\n${lines.join("\n")}`);
    },
  );

  // -- hunch_runbook --------------------------------------------------------
  server.registerTool(
    "hunch_runbook",
    {
      title: "Find a runbook for a task",
      description:
        "Look up the proven 'how-to' (ordered steps + files) for a recurring task — runbook-SCOPED retrieval (searches within runbooks, not the whole graph). Use at the START of a task to reuse a known procedure instead of re-deriving it. Advisory.",
      inputSchema: { task: z.string().describe("The task/intent, e.g. 'add an MCP tool' or 'cut a release'.") },
    },
    async ({ task }): Promise<ToolResult> => {
      const hits = await store.searchRunbooks(task, 5, { embedder: await embedderReady });
      if (!hits.length) return ok(`No runbook for "${task}" yet. Capture one with: hunch runbook <base>..<head> --task "${task}"`);
      const lines = hits.map((h) => {
        const r = store.resolve(h.ref)?.record as Runbook | undefined;
        if (!r) return `• ${h.ref} — ${h.title}`;
        const steps = r.steps.length ? `\n    steps: ${r.steps.map((s, i) => `${i + 1}. ${s}`).join("  ")}` : "";
        const files = r.files.length ? `\n    files: ${r.files.slice(0, 8).join(", ")}` : "";
        return `• ${r.id} — ${r.task}${steps}${files}${provLine(r)}`;
      });
      return ok(`Runbooks for "${task}" (advisory — a proven 'how', refine to fit):\n\n${lines.join("\n\n")}`);
    },
  );

  // -- hunch_why ------------------------------------------------------------
  server.registerTool(
    "hunch_why",
    {
      title: "Explain why a file/symbol is the way it is",
      description:
        "Return the decisions, bugs, and constraints that explain a file path or symbol — the 'why' and the 'what must not break', with evidence. Pass `as_of` (a commit/tag/branch) to time-travel: see what was believed at that point in history.",
      inputSchema: {
        target: z.string().describe("A file path (e.g. src/auth/session.ts) or symbol name."),
        as_of: z.string().optional().describe("Time-travel ref: a commit sha, tag, or branch (e.g. v0.7.0). Omit for the current view."),
      },
    },
    async ({ target, as_of }): Promise<ToolResult> => {
      const asOf = as_of ? asOfDate(as_of, root) : undefined;
      if (as_of && !asOf) return err(`Could not resolve as_of "${as_of}" to a commit.`);
      const w = store.why(target, { asOf });
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

  // -- hunch_blast_radius (dependents + near-violations) --------------------
  server.registerTool(
    "hunch_blast_radius",
    {
      title: "Blast radius + near-violations for a file",
      description:
        "Given a file you're about to change, return its dependency blast radius (files whose code depends on it) AND any invariants reached THROUGH that radius — 'near-violations' you could break indirectly without touching their own scope. Call before editing a widely-depended-on file. Mirrors `hunch check --blast`.",
      inputSchema: { target: z.string().describe("A file path (e.g. src/auth/jwt.ts) or symbol.") },
    },
    async ({ target }): Promise<ToolResult> => {
      type Inv = ReturnType<HunchStore["checkConstraints"]>[number];
      const parts: string[] = [];
      for (const file of resolveFiles(store, target)) {
        const blast = store.blastRadiusFiles(file);
        const directIds = new Set(store.checkConstraints(file).map((c) => c.id));
        const near = new Map<string, { c: Inv; via: string }>();
        for (const b of blast) {
          for (const c of store.checkConstraints(b.file)) {
            if (directIds.has(c.id) || near.has(c.id)) continue;
            near.set(c.id, { c, via: `${b.file} (${b.via}, depth ${b.depth})` });
          }
        }
        const blastBody = blast.length
          ? `:\n${blast.slice(0, DEP_CAP).map((b) => `  • [depth ${b.depth}] ${b.file} (via ${b.via})`).join("\n")}${more(blast.length, DEP_CAP, "closest first")}`
          : "";
        const nearArr = [...near.values()];
        const nearBody = nearArr.length
          ? `\n  NEAR-VIOLATIONS (invariants reachable via this radius — review before editing):\n${nearArr.map((n) => `    ⚠ ${n.c.id} [${n.c.severity}] ${n.c.statement}\n        via ${n.via}`).join("\n")}`
          : "\n  No invariants in the blast radius.";
        parts.push(`${file} → ${blast.length} dependent file(s)${blastBody}${nearBody}`);
      }
      return ok(`Blast radius for "${target}":\n\n${parts.join("\n\n")}`);
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
        as_of: z.string().optional().describe("Time-travel ref (commit/tag/branch): assemble the slice as it stood then."),
      },
    },
    async ({ target, budget_tokens, as_of }): Promise<ToolResult> => {
      const asOf = as_of ? asOfDate(as_of, root) : undefined;
      if (as_of && !asOf) return err(`Could not resolve as_of "${as_of}" to a commit.`);
      return ok(formatContext(store.assembleContext(target, budget_tokens ?? 1500, { asOf })));
    },
  );

  // -- hunch_timeline (decision history) ------------------------------------
  server.registerTool(
    "hunch_timeline",
    {
      title: "The decision history for a file/symbol",
      description:
        "Time-travel: the decisions touching a file/symbol over time — what was believed, its valid-time window, and what superseded it. Use to understand how (and why) the design changed, and to avoid re-introducing a deliberately-retired approach.",
      inputSchema: { target: z.string().describe("A file path or symbol name.") },
    },
    async ({ target }): Promise<ToolResult> => {
      const tl = store.timeline(target);
      if (!tl.length) return ok(`No decision history for "${target}" yet.`);
      const lines = tl.map((d) => {
        const from = (d.valid_from ?? d.date).slice(0, 10);
        const window = d.valid_to ? `${from} → ${d.valid_to.slice(0, 10)}` : `${from} → now`;
        const sup = d.superseded_by ? ` (superseded by ${d.superseded_by})` : "";
        return `  • ${d.id} [${d.status}] (${window})${sup}\n      ${d.title}`;
      });
      return ok(`Decision timeline for "${target}" (newest first):\n${lines.join("\n")}`);
    },
  );

  // -- hunch_capture_decision (decision-grounding: the grilling front door) --
  server.registerTool(
    "hunch_capture_decision",
    {
      title: "Capture a decision (grilling interview)",
      description:
        "Start a decision-capture interview: returns the grilling protocol (interrogate ONE question at a time until the decision tree is resolved) plus a capture-session token. Grill the human, then commit via hunch_record_decision with the token + confirmed topic. Use for '/capture', 'record this decision', 'grill me on this'. The token proves the write is the tail of an interview, not a silent guess.",
      inputSchema: {
        topic: z.string().optional().describe("proposed topic anchor (confirm with the human before committing)"),
        seed: z.string().optional().describe("what the decision is about, to focus the first question"),
      },
    },
    async ({ topic, seed }): Promise<ToolResult> => {
      const token = issueCaptureToken();
      return ok(`${grillingProtocol(topic, token)}${seed ? `\n\nSeed: ${seed}` : ""}`);
    },
  );

  // -- hunch_current_decision (decision-grounding: current(topic)) ----------
  server.registerTool(
    "hunch_current_decision",
    {
      title: "Current decision for a topic",
      description:
        "Decision-grounding: return the single CURRENT (accepted, non-superseded) decision anchored to a topic — the authoritative answer a doc or diff is checked against, plus what it rejected. If a topic has NO current decision, or an unresolved collision (>1 live), it says so and injects nothing (fail-safe).",
      inputSchema: { topic: z.string().describe("the decision anchor, e.g. 'auth-transport'") },
    },
    async ({ topic }): Promise<ToolResult> => {
      const decs = store.recs("decisions");
      const live = liveForTopic(decs, topic);
      if (live.length === 0) return ok(`No current decision for topic "${topic}". (Un-anchored, or never captured.)`);
      if (live.length > 1) {
        const list = live.map((d) => `${d.id} ("${d.title}")`).join(", ");
        return ok(`Topic "${topic}" has an UNRESOLVED collision (${live.length} live decisions): ${list}.\nGrounding injects nothing until this is resolved — supersede one, or split the topic.`);
      }
      const d = live[0]!;
      const rejected = rejectedForTopic(decs, topic);
      const rej = rejected.length ? `\n    rejected: ${rejected.join("; ")}` : "";
      const hist = historyForTopic(decs, topic);
      const chain = hist.length > 1 ? `\n    history: ${hist.length} decisions on this topic (current is newest)` : "";
      return ok(`Current decision for "${topic}": ${d.id} — "${d.title}" (${d.status}).\n    ${d.decision}${rej}${chain}${provLine(d)}`);
    },
  );

  // -- hunch_record_decision (write-back) -----------------------------------
  server.registerTool(
    "hunch_record_decision",
    {
      title: "Record a decision (write-back)",
      description:
        "Persist a new Decision (ADR) into Hunch with provenance. Use after making a non-trivial design choice so future sessions are grounded in it. Set private:true to keep a SENSITIVE decision out of a (possibly public) repo — it is written to the HUNCH_PRIVATE_DIR overlay store and stays queryable locally, never committed here.",
      inputSchema: {
        decision: z.object({
          title: z.string(),
          context: z.string().optional(),
          decision: z.string().optional(),
          consequences: z.array(z.string()).optional(),
          alternatives_rejected: z.array(z.string()).optional(),
          related_files: z.array(z.string()).optional(),
          related_components: z.array(z.string()).optional(),
          topic: z.string().optional().describe("decision-grounding anchor — one topic per decision; enables doc≠graph drift detection for it. Omit to leave un-anchored."),
          status: z.enum(["proposed", "accepted", "rejected", "superseded"]).optional(),
          commit: z.string().optional(),
          supersedes: z.string().optional().describe("id of a decision this one replaces — closes its valid-time window (invalidate, don't delete)"),
          private: z.boolean().optional().describe("write into the PRIVATE overlay store (HUNCH_PRIVATE_DIR) instead of the committed repo — for sensitive decisions kept out of a public repo. Errors if no private store is configured."),
        }),
        capture_token: z.string().optional().describe("token from hunch_capture_decision — proves this write is the tail of a grilling interview. Omit only for a quick manual record (a deprecation nudge is returned)."),
      },
    },
    async ({ decision, capture_token }): Promise<ToolResult> => {
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
        // Public-only lookup; skip it for a private write so a private decision never
        // inherits fields from a same-id PUBLIC record (and vice-versa).
        const existing = decision.private ? undefined : store.json.get("decisions", id);
        const source = existing && existing.provenance.source.includes("llm_draft")
          ? "llm_draft+human_confirmed"
          : "human_confirmed";
        const now = new Date().toISOString();

        const rec: Decision = {
          id,
          title: decision.title,
          topic: decision.topic ?? existing?.topic ?? null,
          status: decision.status ?? "accepted",
          context: decision.context ?? existing?.context ?? "",
          decision: decision.decision ?? existing?.decision ?? "",
          consequences: decision.consequences ?? [],
          alternatives_rejected: decision.alternatives_rejected ?? [],
          rejected_tripwires: existing?.rejected_tripwires ?? [], // preserve confirmed tripwires across re-record
          related_components: decision.related_components ?? existing?.related_components ?? [],
          related_files: (decision.related_files ?? existing?.related_files ?? []).map(toPosixTarget),
          supersedes: decision.supersedes ?? existing?.supersedes ?? null,
          superseded_by: existing?.superseded_by ?? null,
          caused_by_bug: existing?.caused_by_bug ?? null,
          commit: decision.commit ?? existing?.commit ?? null,
          valid_from: existing?.valid_from ?? now,
          valid_to: existing?.valid_to ?? null,
          retired: existing?.retired ?? { symbols: [], deps: [] },
          provenance: { source, confidence: 0.95, evidence: (decision.related_files ?? existing?.provenance.evidence ?? []).map(toPosixTarget) },
          date: now,
        };
        // Decision-grounding uniqueness guard (§4 Enforcement): never create a SECOND
        // live decision for one topic. Exclude ONLY the incumbent this write will
        // actually close — one resolvable in the SAME store the write lands in. A
        // cross-store supersede (public write vs a private incumbent, or vice-versa)
        // would no-op and leave two live decisions, so it is treated as unresolved
        // (willClose=null) → the guard fires and refuses. Same-id re-record is allowed.
        if (rec.topic && rec.status === "accepted") {
          const willClose = decision.supersedes && store.decisionInStore(decision.supersedes, !!decision.private)
            ? decision.supersedes
            : null;
          const others = captureConflicts(store.recs("decisions"), rec.topic, id, willClose);
          if (others.length) {
            const list = others.map((d) => `${d.id} ("${d.title}")`).join(", ");
            const crossStore = decision.supersedes && !willClose
              ? ` (note: supersedes:"${decision.supersedes}" is not in the ${decision.private ? "private" : "public"} store, so it can't be closed from here)`
              : "";
            return err(
              `Topic "${rec.topic}" already has a live decision: ${list}.${crossStore} ` +
                `Hunch will not create a second current decision for one topic. Resolve it: ` +
                `re-record with supersedes:<id> to replace it (linked, same store), pick a distinct topic to split, or discard this capture.`,
            );
          }
        }
        // Route the write: private records go to the HUNCH_PRIVATE_DIR overlay (never
        // the committed repo); everything else to the public store. putPrivate throws
        // if no private store is configured, so "private" can't silently fall public.
        if (decision.private) store.putPrivate("decisions", rec);
        else store.json.put("decisions", rec);
        // Invalidate, don't delete: closing the superseded decision's valid-time window
        // (+ a supersedes edge) preserves the why-it-changed trail. Route the close to the
        // same store the new record landed in — a private decision supersedes within the
        // private overlay; a public one in the committed store. A private write never
        // mutates the public store.
        const superseded = decision.supersedes
          ? (decision.private ? store.supersedePrivate(decision.supersedes, rec) : store.supersede(decision.supersedes, rec))
          : null;
        store.reindex();
        // Auto-flush the private repo when configured (hunch private --auto-commit), so a
        // record made via MCP between public commits is committed+pushed immediately.
        let flushed = "";
        if (decision.private && store.privateAutoCommit && store.privateDir) {
          commitAndPushHunch(store.privateDir, `hunch: capture ${id}`);
          flushed = " (committed + pushed to the private repo)";
        }
        // Capture-session gate (staged deprecation, §9.3): a token proves an interview
        // preceded the write. No token still writes (non-breaking), but returns a nudge
        // toward /capture so the un-interviewed bypass is visible, not silent. A token
        // presented but unknown to THIS process (server restart/expiry) is not shamed.
        const gated = consumeCaptureToken(capture_token);
        const captureNote = gated
          ? " [via capture front door]"
          : capture_token
            ? ""
            : "\n\n⚠ Recorded WITHOUT a capture interview. Prefer /capture (hunch_capture_decision), which grills the decision to a resolved state before writing — the graph should hold a well-examined decision, not a guess. (A future major version will require a capture token here.)";
        const supNote = superseded ? ` Superseded ${superseded.id} (window closed at ${rec.valid_from}).` : "";
        const note = decision.commit && !fullSha ? ` (note: commit "${decision.commit}" could not be resolved — recorded as a standalone decision, not linked to a commit)` : "";
        const where = decision.private ? ` [PRIVATE overlay — not committed to this repo]${flushed}` : "";
        return ok(`Recorded decision ${id}: "${rec.title}" (status ${rec.status}, ${source}).${where}${supNote}${note}${captureNote}`);
      } catch (e) {
        return err(`Failed to record decision: ${(e as Error).message}`);
      }
    },
  );

  // -- hunch_record_correction (write-back: "Never Twice") ------------------
  server.registerTool(
    "hunch_record_correction",
    {
      title: "Capture a correction as an enforced constraint (Never Twice)",
      description:
        "When a human corrects the agent ('no, do it this way' / 'never call X here'), persist that correction as a first-class, SCOPED Constraint with provenance — so the pre-edit hook and the CI Constraint Guard hold EVERY assistant to it from now on, instead of it being forgotten next session. Writes to the shared .hunch/ graph (client-agnostic). Set severity:'blocking' only when the human said never/must; set applies_to_all:true only when the rule is genuinely repo-wide (otherwise it is scoped to scope_hint_file).",
      inputSchema: {
        rule: z.string().describe("The invariant in the human's words, e.g. \"never call the pay-per-token API here\"."),
        scope_hint_file: z.string().optional().describe("A file the correction was about; scopes the constraint to it (the conservative default)."),
        severity: z.enum(["advisory", "warning", "blocking"]).optional().describe("Default 'warning'. Use 'blocking' only for a hard never/must rule."),
        applies_to_all: z.boolean().optional().describe("True ONLY if the rule is genuinely repo-wide (scopes to **); required to make a repo-wide rule blocking."),
        type: z.enum(["security", "performance", "correctness", "architecture", "compliance"]).optional(),
        rationale: z.string().optional().describe("Why it must hold."),
        source_decision: z.string().optional().describe("id of a decision this correction derives from."),
        private: z.boolean().optional().describe("write into the PRIVATE overlay store (HUNCH_PRIVATE_DIR) instead of the committed repo — a sensitive rule enforced locally (pre-edit hook + local check) but never exposed in a public PR comment. Errors if no private store is configured."),
      },
    },
    async (input): Promise<ToolResult> => {
      try {
        if (!input.rule || !input.rule.trim()) return err("rule is required — state the invariant in plain words.");
        const rec = buildCorrectionConstraint({ ...input, knownDeps: knownRepoDeps(root) }, new Date().toISOString());
        // Private corrections go to the overlay (enforced locally via the merged read,
        // never rendered into the public CI comment, which is public-only by construction).
        const existing = input.private ? undefined : store.json.get("constraints", rec.id);
        if (input.private) store.putPrivate("constraints", rec);
        else store.json.put("constraints", rec);
        store.reindex();
        // Propagate the new rule to EVERY assistant's ambient grounding (Cursor/Copilot/
        // Windsurf/AGENTS.md/CLAUDE.md), so a correction captured in one assistant is held
        // by all of them. Public only — a private rule must never render into committed
        // grounding. Refresh-only: it never scaffolds a doc the project opted out of.
        if (!input.private) refreshExistingGrounding(root, store);
        let flushed = "";
        if (input.private && store.privateAutoCommit && store.privateDir) {
          commitAndPushHunch(store.privateDir, `hunch: capture ${rec.id}`);
          flushed = " (committed + pushed to the private repo)";
        }
        const enforce = rec.severity === "blocking"
          ? "blocks a DIRECT edit to its scope at strict firmness, and fails a PR whose diff touches that scope (CI guard); blast-radius hits and lower firmness stay advisory"
          : "flags violating edits and PRs (advisory)";
        const where = input.private ? ` [PRIVATE overlay — not committed to this repo]${flushed}` : "";
        return ok(`${existing ? "Updated" : "Recorded"} ${rec.severity} constraint ${rec.id}: "${rec.statement}" (scope: ${rec.scope.join(", ")}).${where} It now ${enforce}.`);
      } catch (e) {
        return err(`Failed to record correction: ${(e as Error).message}`);
      }
    },
  );

  // -- hunch_merge_verdict (Causal Merge Verdict — read-only, client-agnostic) --
  server.registerTool(
    "hunch_merge_verdict",
    {
      title: "Causal merge verdict: is this change safe against the recorded WHY?",
      description:
        "Before opening or merging a PR, replay a diff against engineering memory and return ONE verdict — BLOCK / WARN / PASS. For each invariant DIRECTLY in scope it cites WHY the guard exists (the decision that motivated it + the bug whose root cause spawned it); it also lists invariants reached via blast radius (near, advisory), any deliberately-retired code the diff re-introduces, and symbols the diff adds that are already defined elsewhere in the graph (possible re-implementation/sprawl, advisory). Deterministic, no LLM. Omit base AND commit to check STAGED changes; pass base (e.g. origin/main) for a PR range, or commit for a single commit. Call this before merging a widely-scoped change.",
      inputSchema: {
        base: z.string().optional().describe("Diff against this base ref (e.g. origin/main) — for a PR/branch."),
        commit: z.string().optional().describe("Diff a single commit (sha/ref). Omit base AND commit to check staged changes."),
      },
    },
    async ({ base, commit }): Promise<ToolResult> => {
      try {
        if (base && commit) return err("Pass at most one of base/commit (omit both to check staged changes).");
        if (base && !revExists(base, root)) return err(`base ref "${base}" does not resolve (in CI, fetch the base branch first).`);
        if (commit && !revExists(commit, root)) return err(`commit "${commit}" does not resolve.`);
        const files = commit ? commitFiles(commit, root) : base ? rangeFiles(base, root) : stagedFiles(root);
        const scope = commit ? `commit ${commit}` : base ? `${base}..HEAD` : "staged changes";
        if (!files.length) return ok(`VERDICT: ✅ PASS — no changed files in ${scope}.`);
        const diff = commit ? commitDiff(commit, root) : base ? rangeDiff(base, root) : stagedDiff(root);
        const report = store.buildCheckReport(files, diff, { strict: true, lastChange: (f) => lastChangeDate(f, root) });
        const v = verdict(report);
        const head = v === "block"
          ? "VERDICT: ⛔ BLOCK — this change breaks a recorded invariant or re-opens a known bug."
          : v === "warn"
            ? "VERDICT: ⚠ WARN — this change touches engineering memory; review the cited why below before merge."
            : "VERDICT: ✅ PASS — touches no recorded invariants and re-introduces nothing deliberately retired.";
        return ok(`${head}\n(scope: ${scope}, ${files.length} file(s))\n\n${renderMarkdown(report)}`);
      } catch (e) {
        return err(`Failed to compute merge verdict: ${(e as Error).message}`);
      }
    },
  );

  // -- hunch_compare --------------------------------------------------------
  server.registerTool(
    "hunch_compare",
    {
      title: "Rank candidate solutions by architectural fit",
      description:
        "Given several candidate branches/commits (e.g. N solutions to one task), replay each against engineering memory and RANK them best-fit first — the candidate that trips the fewest in-force invariants, reverses no decisions, and adds the least sprawl wins. Deterministic (the same merge-verdict per candidate, no LLM). Use to choose among multiple solutions before committing to one.",
      inputSchema: {
        candidates: z.array(z.string()).describe("Refs to compare — branches or commits, e.g. ['feat-a','feat-b','feat-c']."),
        base: z.string().optional().describe("Base to diff each candidate against (3-dot; default: main)."),
      },
    },
    async ({ candidates, base }): Promise<ToolResult> => {
      try {
        const b = base ?? "main";
        if (!candidates.length) return err("Pass at least one candidate ref.");
        if (!revExists(b, root)) return err(`base ref "${b}" does not resolve (in CI, fetch it first).`);
        const ranked = compareCandidates(store, root, b, candidates);
        const icon = (v: string) => (v === "pass" ? "✅" : v === "warn" ? "⚠" : "⛔");
        const lines = ranked.map((c, i) =>
          c.error
            ? `${i + 1}. ${c.ref} — ${c.error}`
            : `${i + 1}. ${icon(c.verdict)} ${c.ref} [${c.verdict}] — ${c.blocking} blocking · ${c.direct} direct · ${c.near} near · ${c.vetoes} veto · ${c.redundant} redundant (${c.files} files)`,
        );
        const best = ranked.find((c) => !c.error);
        return ok(`Candidates vs ${b}, best architectural fit first:\n\n${lines.join("\n")}${best ? `\n\nBest fit: ${best.ref}` : ""}`);
      } catch (e) {
        return err(`Failed to compare candidates: ${(e as Error).message}`);
      }
    },
  );

  // -- hunch_conformance ----------------------------------------------------
  server.registerTool(
    "hunch_conformance",
    {
      title: "Does the code still satisfy the recorded intent?",
      description:
        "Intent-conformance (the inversion of a normal guard): for every in-force decision carrying a conformance predicate, deterministically verify the CODE still satisfies its intent over the dependency graph — e.g. 'pay still reaches verifySession'. Returns the violations: intent the code has silently drifted away from, with NO diff required. Run before a refactor or merge to catch intent erosion a diff-only check can't see.",
      inputSchema: {},
    },
    async (): Promise<ToolResult> => {
      const results = checkConformance(store);
      if (!results.length) return ok("No conformance predicates recorded. Add a `conformance` predicate to a decision (e.g. {assert:'calls', subject:'pay', object:'verifySession'}) to prove the code honors its intent.");
      const violations = results.filter((r) => !r.satisfied);
      const lines = results.map((r) => `${r.satisfied ? "✅" : "⛔"} ${r.decision} "${r.title}" — ${r.assert} ${r.subject}${r.object ? ` → ${r.object}` : ""}: ${r.detail}`);
      const head = violations.length ? `⛔ ${violations.length} intent(s) the code no longer satisfies` : "✅ the code satisfies every recorded intent";
      return ok(`Intent-conformance (${results.length - violations.length}/${results.length} satisfied):\n\n${lines.join("\n")}\n\n${head}`);
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
