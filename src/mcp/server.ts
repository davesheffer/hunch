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
import { revParse, asOfDate, revExists, lastChangeDate, rangeFiles, rangeDiff, commitFiles, commitDiff, stagedFiles, stagedDiff, workingFiles, workingDiff, pullHunch } from "../extractors/git.js";
import { flushCapture } from "../integrations/sync.js";
import { ensureTeamOverlay } from "../integrations/team.js";
import { formatContext, formatStructure } from "../core/format.js";
import type { Runbook } from "../core/types.js";
import { compareCandidates } from "../core/compare.js";
import { checkConformance } from "../core/conformance.js";
import { ConstitutionService } from "../constitution/service.js";
import { G2_RUNBOOK_CATEGORIES } from "../constitution/g2.js";
import { renderMarkdown, renderImpact, verdict } from "../core/checkreport.js";
import { nowData, wikiStatus, publicHome, readWikiManifestAt } from "../wiki/wiki.js";
import { HUNCH_VERSION } from "../core/version.js";
import { indexRepo } from "../extractors/indexer.js";
import type { Decision, Symbol } from "../core/types.js";
import { liveForTopic, historyForTopic, rejectedForTopic, captureConflicts } from "../core/topics.js";
import { pendingEscalations, policyEscalations, type Escalation } from "../core/escalations.js";
import { issueCaptureToken as issueToken, consumeCaptureToken as consumeToken } from "../core/capturetoken.js";
import { randomUUID } from "node:crypto";

type ToolResult = { content: Array<{ type: "text"; text: string }>; isError?: boolean };
const ok = (text: string): ToolResult => ({ content: [{ type: "text", text }] });
const err = (text: string): ToolResult => ({ content: [{ type: "text", text }], isError: true });

/** Honest auto-commit suffix: reports only what flushCapture ACTUALLY did. A skipped
 *  commit (backstop/lock/nothing staged) says nothing — the record is on disk and the
 *  next flush sweeps it up; claiming "auto-committed" there would be a lie. */
const flushNote = (flush: "pushed" | "committed" | null, home: "public" | "private", mode: string): string =>
  flush === "pushed" ? ` (committed + pushed to the ${mode === "shared" ? "shared team store" : "private repo"})`
    : flush === "committed"
      ? home === "private"
        ? " (committed to the overlay repo — push deferred: offline, no upstream, or merge conflict; the next capture or `hunch private --sync` retries)"
        : " (auto-committed to .hunch/ — rides your next push)"
      : "";

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

/** The interrogation protocol returned by hunch_capture_decision. With `deciding`,
 *  the choice is NOT yet made: the verdict loop runs first so the record's
 *  alternatives_rejected are attacks that actually ran — not post-hoc fiction. */
function grillingProtocol(topic: string | undefined, token: string, deciding = false): string {
  const verdict = [
    "The decision is NOT yet made — run the VERDICT LOOP first (one question at a time), then the grilling rules below.",
    "",
    "VERDICT LOOP:",
    "A. SPLIT — one separable call per verdict, one topic per call. If the ask bundles several decisions, split and run each.",
    "B. CANDIDATES — elicit at least TWO real options (include do-nothing when sane). One candidate = anchoring; keep asking.",
    "C. ATTACK — attack each candidate from INDEPENDENT lenses: product, technical, strategy, economics, and self-consistency (does it contradict a recorded decision or constraint? cite dec_/con_ ids). Every attack cites evidence observed this session; no evidence → mark it plausible and weigh it less.",
    "D. CONVERGE — two or more independent landing attacks kill a candidate. Keep the FAILED attacks too — they are the tested-safe surface; fold them into context. No convergence → prefer the candidate whose failure is REVERSIBLE.",
    "E. TRIPWIRES — for each rejected candidate, ask what future evidence would make it right after all; embed it in the rejected alternative ('rejected X — revisit if Y').",
    "",
    "",
  ].join("\n");
  return (deciding ? verdict : "") + [
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

/** Deterministic quality nudge for a freshly recorded ACCEPTED decision: an
 *  unattacked record (no rejected alternatives) or rejections without a
 *  "revisit if" flip condition get ONE advisory line — never a gate. */
function qualityNudge(rec: Decision): string {
  if (rec.status !== "accepted") return "";
  if (!rec.alternatives_rejected.length) {
    return `\n\n△ Unattacked record: no alternatives_rejected. The graph can only veto what was explicitly rejected — next time run hunch_capture_decision(deciding:true) so rejections come from attacks that actually ran.`;
  }
  if (!rec.alternatives_rejected.some((a) => /revisit if/i.test(a))) {
    return `\n\n△ Tip: none of the ${rec.alternatives_rejected.length} rejected alternative(s) carries a "revisit if …" flip condition — embed one per rejection so a future session knows when the call expires.`;
  }
  return "";
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
  // Team auto-discovery: a committed .hunch/team.json advertises the shared store — a
  // fresh clone (a new teammate, a headless agent, a CI workflow) wires itself BEFORE the
  // store is constructed, so every consumer resolves the same single source of truth.
  // Best-effort: offline / no team.json → proceed exactly as before.
  try { ensureTeamOverlay(root); } catch { /* never block server start */ }
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
        "Given a file, symbol, or task phrase you're about to work on, return the MINIMAL relevant memory — invariants to preserve, decisions explaining the design, bug history not to reintroduce, and the blast radius — as a compact brief. Call this FIRST when starting work on something. A task phrase that resolves to no file/symbol falls back to the closest graph matches.",
      inputSchema: {
        target: z.string().describe("A file path, symbol, or task phrase you're about to work on."),
        budget_tokens: z.number().optional().describe("Rough token budget for the brief (default 1500)."),
        as_of: z.string().optional().describe("Time-travel ref (commit/tag/branch): assemble the slice as it stood then."),
      },
    },
    async ({ target, budget_tokens, as_of }): Promise<ToolResult> => {
      const asOf = as_of ? asOfDate(as_of, root) : undefined;
      if (as_of && !asOf) return err(`Could not resolve as_of "${as_of}" to a commit.`);
      const ctx = store.assembleContext(target, budget_tokens ?? 1500, { asOf });
      // Task-phrase input ("improve retrieval ranking") resolves no file/symbol and
      // used to return an empty brief while the graph held the answer — fall back to
      // FTS so the assistant always leaves with the closest matches, not a shrug.
      const empty = !ctx.constraints.length && !ctx.decisions.length && !ctx.bugs.length && !ctx.blast_radius.length;
      if (empty && !asOf) {
        const hits = store.search(target, 8);
        if (hits.length) {
          const lines = hits.map((h) => `• ${h.ref} — ${h.title}\n    ${h.snippet}`);
          return ok(
            `No file/symbol resolves for "${target}" — closest graph matches instead:\n\n${lines.join("\n")}\n\n(For a file/symbol brief pass a concrete target; free-text goes through the same search as hunch_query.)`,
          );
        }
      }
      return ok(formatContext(ctx));
    },
  );

  // -- hunch_now (the hot view: recent activity + roadmap) --------------------
  // PUBLIC store only, per dec_29eff08c69's jurisdiction rule: an assistant may
  // paste this anywhere, so it must be publishable by construction. Union view
  // stays behind `hunch now --private` on the local terminal.
  server.registerTool(
    "hunch_now",
    {
      title: "Recent activity + the roadmap (the hot view)",
      description:
        "What just happened and what's next, straight from the graph: the last N decisions (any status — a supersession IS activity) and the ROADMAP (every live human-vouched PROPOSED decision). Call at session start to orient, or before planning what to work on. Same data as the wiki's now.md. Public store only.",
      inputSchema: {
        recent_limit: z.number().optional().describe("How many recent decisions to include (default 10)."),
      },
    },
    async ({ recent_limit }): Promise<ToolResult> => {
      const { recent, roadmap, pendingReview } = nowData(store.json.loadAll("decisions"), recent_limit ?? 10);
      const L: string[] = [`🔥 Recent (${recent.length}):`];
      for (const r of recent) L.push(`  ${r.date} [${r.status}] ${r.title} (${r.id}${r.topic ? `, ${r.topic}` : ""})`);
      L.push("", `🗺 Roadmap — live proposed decisions (${roadmap.length}):`);
      if (!roadmap.length) L.push("  (empty — record intent as a PROPOSED decision and it appears here)");
      for (const r of roadmap) L.push(`  • ${r.title} (${r.id}${r.topic ? `, ${r.topic}` : ""}, since ${r.date})\n      ${r.note}`);
      if (pendingReview > 0) L.push("", `${pendingReview} legacy un-vouched draft(s) — \`hunch adopt-drafts\` auto-trusts them as advisory (new captures land trusted automatically).`);
      const escalations = pendingEscalations(store.json.loadAll("decisions"));
      if (escalations.length) {
        L.push("", `⚖ ${escalations.length} decision(s) need the human's call — ASK inline (never queue): ${escalations.map((e) => e.question).join(" · ")}`);
      }
      return ok(L.join("\n"));
    },
  );

  // -- hunch_escalations (the inline "ask the human" surface) -----------------
  // Captured memory auto-trusts; this returns ONLY what the graph can't resolve
  // itself, framed as questions to raise in conversation: topic conflicts, plus the
  // Constitution's human moments (a candidate awaiting review, a proposed policy
  // whose activation is a human call — §59.5.3). Public store only — same
  // jurisdiction rule as hunch_now (an assistant may paste it). Client-agnostic
  // (con_e04226bd05): no Claude-specific behavior.
  server.registerTool(
    "hunch_escalations",
    {
      title: "Decisions the human must make now (ask inline, not a queue)",
      description:
        "The rare decisions the graph cannot resolve on its own — surfaced so you ASK THE USER in the prompt at the moment, then act. Auto-captured memory is trusted automatically and never appears here; this returns topic conflicts (>1 live decision for one topic) and Constitution human moments (candidate policies awaiting review, proposed policies awaiting an activation decision). Normally empty. Raise each question with the user; do NOT decide it for them — an entry is a question, never an approval. Public store only.",
      inputSchema: {},
    },
    async (): Promise<ToolResult> => {
      const items: Escalation[] = pendingEscalations(store.json.loadAll("decisions"));
      try {
        items.push(...policyEscalations(new ConstitutionService(store, root).list({ publicOnly: true }).map((p) => ({ ...p, last_action: p.audit.at(-1)?.action ?? null }))));
      } catch { /* constitution unavailable — memory escalations still surface */ }
      if (!items.length) return ok("✓ Nothing needs a human decision — memory is auto-trusted and self-consistent.");
      const L = [`${items.length} decision(s) need the human's call — ask each inline, don't decide it for them:`, ""];
      for (const e of items) {
        L.push(`⚖ ${e.question}`);
        L.push(`   ${e.detail}`);
        L.push(`   → ${e.resolution}`, "");
      }
      return ok(L.join("\n"));
    },
  );

  // -- hunch_wiki_status (generated-wiki freshness) ---------------------------
  server.registerTool(
    "hunch_wiki_status",
    {
      title: "Freshness of the generated wiki (public home)",
      description:
        "Which generated wiki pages are fresh vs stale (graph moved, source doc changed, hand-edited), plus the specs ledger's doc grades. Call before trusting wiki pages or when deciding whether `hunch wiki --heal` is needed. Public home only — the private overlay wiki is a local concern.",
      inputSchema: {},
    },
    async (): Promise<ToolResult> => {
      const home = publicHome(root);
      if (!readWikiManifestAt(home.manifestPath)) return ok("No wiki adopted in this repo (no wiki manifest). Generate one with `hunch wiki`.");
      const s = wikiStatus(store, home, root);
      const stale = [...s.entries.filter((e) => e.state !== "fresh").map((e) => `${e.page} — ${e.reason || e.state}`),
        ...(s.specs.state !== "fresh" ? [`${s.specs.page} — doc grade snapshot moved`] : []),
        ...(s.now.state !== "fresh" ? [`${s.now.page} — activity/roadmap moved`] : []),
        ...(s.index.state !== "fresh" ? [`${s.index.page} — index inputs moved`] : []),
        ...s.adoptions.filter((a) => a.state !== "fresh").map((a) => `${a.page} — adopted copy of ${a.doc.rel} (${a.state})`)];
      const grades = { grounded: s.docs.filter((d) => d.status === "grounded").length, stale: s.docs.filter((d) => d.status === "stale").length, unverified: s.docs.filter((d) => d.status === "unverified").length };
      const head = `Wiki "${home.dir}/": ${s.entries.length} component page(s), ${s.adoptions.length} adopted doc(s). Docs graded: ${grades.grounded} grounded / ${grades.stale} stale / ${grades.unverified} unverified.`;
      if (!stale.length && !s.orphans.length && !s.adoptionOrphans.length) return ok(`${head}\n✓ Everything fresh.`);
      const orphans = [...s.orphans, ...s.adoptionOrphans].map((p) => `${p} — orphaned (heal removes it)`);
      return ok(`${head}\n${[...stale, ...orphans].map((l) => `· ${l}`).join("\n")}\nHeal: \`hunch wiki --heal\`.`);
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
        deciding: z.boolean().optional().describe("the choice is NOT yet made — prepend the verdict loop (candidates → evidenced attacks → convergence → tripwires) so alternatives_rejected come from attacks that actually ran, then grill and record as usual"),
      },
    },
    async ({ topic, seed, deciding }): Promise<ToolResult> => {
      const token = issueCaptureToken();
      return ok(`${grillingProtocol(topic, token, !!deciding)}${seed ? `\n\nSeed: ${seed}` : ""}`);
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

        // Preserve the ADR lineage from the SAME home this write will use. A private
        // re-record must retain its own optional fields, but must never inherit a
        // same-id public record (and vice versa).
        const home = store.captureHome(!!decision.private);
        const existing = home === "private" ? store.getPrivateRec("decisions", id) : store.json.get("decisions", id);
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
        // Where this write will actually land (see captureHome). Resolved BEFORE the
        // uniqueness guard: in unified ("shared") mode home is the overlay even when
        // private:false, so the guard must key its incumbent lookup on HOME, not on
        // the flag — keying on the flag let a shared-mode supersede of a public
        // incumbent pass the guard and then no-op the close (two live decisions).
        // Decision-grounding uniqueness guard (§4 Enforcement): never create a SECOND
        // live decision for one topic. Exclude ONLY the incumbent this write will
        // actually close — one resolvable in the SAME store the write lands in. A
        // cross-store supersede (the incumbent lives where this write can't close it)
        // would no-op and leave two live decisions, so it is treated as unresolved
        // (willClose=null) → the guard fires and refuses. Same-id re-record is allowed.
        if (rec.topic && rec.status === "accepted") {
          const willClose = decision.supersedes && store.decisionInStore(decision.supersedes, home === "private")
            ? decision.supersedes
            : null;
          const others = captureConflicts(store.recs("decisions"), rec.topic, id, willClose);
          if (others.length) {
            const list = others.map((d) => `${d.id} ("${d.title}")`).join(", ");
            const crossStore = decision.supersedes && !willClose
              ? ` (note: supersedes:"${decision.supersedes}" is not in the ${home} store this write lands in, so it can't be closed from here)`
              : "";
            return err(
              `Topic "${rec.topic}" already has a live decision: ${list}.${crossStore} ` +
                `Hunch will not create a second current decision for one topic. Resolve it: ` +
                `re-record with supersedes:<id> to replace it (linked, same store), pick a distinct topic to split, or discard this capture.`,
            );
          }
        }
        // Route the write to its ONE home: an explicit private:true goes to the overlay
        // (putPrivate throws rather than silently falling public); in unified ("shared")
        // mode EVERY capture goes to the overlay; else the public store.
        if (home === "private") store.putPrivate("decisions", rec);
        else store.json.put("decisions", rec);
        // Invalidate, don't delete: closing the superseded decision's valid-time window
        // (+ a supersedes edge) preserves the why-it-changed trail. Route the close to the
        // same store the new record landed in — a private decision supersedes within the
        // private overlay; a public one in the committed store. A private write never
        // mutates the public store.
        const superseded = decision.supersedes
          ? (home === "private" ? store.supersedePrivate(decision.supersedes, rec) : store.supersede(decision.supersedes, rec))
          : null;
        store.reindex();
        // Auto-flush the store the record landed in (on by default in every mode): a private
        // record commits+pushes its overlay repo; a public one commits .hunch/ in THIS repo
        // (commit only — it rides the user's next push, never auto-pushing their code branch).
        const flush = flushCapture(store, hunchPaths(root).hunch, !!decision.private, `hunch: capture ${id}`);
        const flushed = flushNote(flush, home, store.mode);
        // Capture-session gate (staged deprecation, §9.3): a token proves an interview
        // preceded the write. No token still writes (non-breaking), but returns a nudge
        // toward /capture so the un-interviewed bypass is visible, not silent. A token
        // presented but unknown to THIS process (server restart/expiry) is not shamed.
        const gated = consumeCaptureToken(capture_token);
        const captureNote = gated
          ? " [via capture front door]"
          : capture_token
            ? ""
            : `\n\n⚠ Recorded WITHOUT a capture interview — the record stands, but harden it NOW in one exchange instead of switching flows: answer the first grilling question directly — "What alternative did you seriously consider and reject for '${rec.title.slice(0, 60)}', and what breaks if a future session re-introduces it?" — then fold the answer into alternatives_rejected via hunch_record_decision(supersedes: ${id}) or start the full interview with hunch_capture_decision. (A future major version will require a capture token here.)`;
        // Quality nudge only when the untokened deprecation nudge isn't already
        // grilling — one advisory voice per response, never two.
        const quality = gated || capture_token ? qualityNudge(rec) : "";
        const supNote = superseded ? ` Superseded ${superseded.id} (window closed at ${rec.valid_from}).` : "";
        const note = decision.commit && !fullSha ? ` (note: commit "${decision.commit}" could not be resolved — recorded as a standalone decision, not linked to a commit)` : "";
        const where = decision.private
          ? ` [PRIVATE overlay — not committed to this repo]${flushed}`
          : home === "private" ? ` [SHARED store — one source of truth for the whole team]${flushed}` : flushed;
        return ok(`Recorded decision ${id}: "${rec.title}" (status ${rec.status}, ${source}).${where}${supNote}${note}${captureNote}${quality}`);
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
        const home = store.captureHome(!!input.private);
        const existing = home === "private" ? store.getPrivateRec("constraints", rec.id) : store.json.get("constraints", rec.id);
        if (home === "private") store.putPrivate("constraints", rec);
        else store.json.put("constraints", rec);
        store.reindex();
        // Propagate the new rule to EVERY assistant's ambient grounding (Cursor/Copilot/
        // Windsurf/AGENTS.md/CLAUDE.md), so a correction captured in one assistant is held
        // by all of them. Public only — a private rule must never render into committed
        // grounding. Refresh-only: it never scaffolds a doc the project opted out of.
        if (home === "public") refreshExistingGrounding(root, store); // overlay rules never render into committed grounding
        const flush = flushCapture(store, hunchPaths(root).hunch, !!input.private, `hunch: capture ${rec.id}`);
        const flushed = flushNote(flush, home, store.mode);
        const enforce = rec.severity === "blocking"
          ? "blocks a DIRECT edit to its scope at strict firmness, and fails a PR whose diff touches that scope (CI guard); blast-radius hits and lower firmness stay advisory"
          : "flags violating edits and PRs (advisory)";
        const where = input.private
          ? ` [PRIVATE overlay — not committed to this repo]${flushed}`
          : home === "private" ? ` [SHARED store — one source of truth for the whole team]${flushed}` : flushed;
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
        "Before opening or merging a PR, replay a diff against engineering memory and return ONE verdict — BLOCK / WARN / PASS. For each invariant DIRECTLY in scope it cites WHY the guard exists (the decision that motivated it + the bug whose root cause spawned it); it also lists invariants reached via blast radius (near, advisory), any deliberately-retired code the diff re-introduces, and symbols the diff adds that are already defined elsewhere in the graph (possible re-implementation/sprawl, advisory). Deterministic, no LLM. Omit base, commit, and working to check STAGED changes; pass working:true for all local changes, base (e.g. origin/main) for a PR range, or commit for a single commit. Call this before merging a widely-scoped change.",
      inputSchema: {
        base: z.string().optional().describe("Diff against this base ref (e.g. origin/main) — for a PR/branch."),
        commit: z.string().optional().describe("Diff a single commit (sha/ref). Omit base AND commit to check staged changes."),
        working: z.boolean().optional().describe("Include all working-tree changes vs HEAD (staged, unstaged, and untracked files)."),
      },
    },
    async ({ base, commit, working }): Promise<ToolResult> => {
      try {
        if ([base, commit, working].filter(Boolean).length > 1) return err("Pass at most one of base/commit/working (omit all to check staged changes).");
        if (base && !revExists(base, root)) return err(`base ref "${base}" does not resolve (in CI, fetch the base branch first).`);
        if (commit && !revExists(commit, root)) return err(`commit "${commit}" does not resolve.`);
        const files = commit ? commitFiles(commit, root) : base ? rangeFiles(base, root) : working ? workingFiles(root) : stagedFiles(root);
        const scope = commit ? `commit ${commit}` : base ? `${base}..HEAD` : working ? "working changes" : "staged changes";
        if (!files.length) return ok(`VERDICT: ✅ PASS — no changed files in ${scope}.`);
        const diff = commit ? commitDiff(commit, root) : base ? rangeDiff(base, root) : working ? workingDiff(root) : stagedDiff(root);
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

  // -- hunch_structure (graph-served orientation — the anti-grep) ------------
  server.registerTool(
    "hunch_structure",
    {
      title: "The indexed shape of the repo / a dir / a file / a symbol",
      description:
        "Orient WITHOUT grep/glob rounds: the graph already holds the repo's structure. No target → repo map (components + directories by symbol weight). A directory → its files with their symbols. A file → its outline (symbols, fan-in/out, callers). An exact symbol name → its definition site(s) with one-hop neighbors. Call this FIRST when exploring unfamiliar code — it tells you exactly which file to read, instead of searching for it.",
      inputSchema: {
        target: z.string().optional().describe("A directory, file path, or exact symbol name. Omit for the repo map."),
      },
    },
    async ({ target }): Promise<ToolResult> => ok(formatStructure(store.structure(target))),
  );

  // -- hunch_pr_impact (read-only impact surface — advisory, never gates) ----
  server.registerTool(
    "hunch_pr_impact",
    {
      title: "PR impact: the dependency + memory surface of a change",
      description:
        "Given a change (staged, working tree, a branch vs base, or a single commit), return its IMPACT SURFACE: the files whose code transitively depends on the changed files, the invariants directly in scope and those reached via blast radius, and the recorded decisions concerning the touched files. Read-only and advisory — use hunch_merge_verdict for the gate. Call before review to know what a PR can break and which recorded intent it touches. Omit base, commit, and working for staged changes.",
      inputSchema: {
        base: z.string().optional().describe("Diff against this base ref (e.g. origin/main) — for a PR/branch."),
        commit: z.string().optional().describe("Impact of a single commit (sha/ref). Omit base AND commit for staged changes."),
        working: z.boolean().optional().describe("Include all working-tree changes vs HEAD (staged, unstaged, and untracked files)."),
      },
    },
    async ({ base, commit, working }): Promise<ToolResult> => {
      try {
        if ([base, commit, working].filter(Boolean).length > 1) return err("Pass at most one of base/commit/working (omit all for staged changes).");
        if (base && !revExists(base, root)) return err(`base ref "${base}" does not resolve (in CI, fetch the base branch first).`);
        if (commit && !revExists(commit, root)) return err(`commit "${commit}" does not resolve.`);
        const files = commit ? commitFiles(commit, root) : base ? rangeFiles(base, root) : working ? workingFiles(root) : stagedFiles(root);
        const scope = commit ? `commit ${commit}` : base ? `${base}..HEAD` : working ? "working changes" : "staged changes";
        if (!files.length) return ok(`No changed files in ${scope}.`);
        const diff = commit ? commitDiff(commit, root) : base ? rangeDiff(base, root) : working ? workingDiff(root) : stagedDiff(root);
        return ok(renderImpact(store.prImpact(files, diff), scope));
      } catch (e) {
        return err(`Failed to compute impact: ${(e as Error).message}`);
      }
    },
  );

  // -- hunch_path (shortest dependency chain) --------------------------------
  server.registerTool(
    "hunch_path",
    {
      title: "Shortest dependency path between two nodes",
      description:
        "How does A reach B? Returns the shortest chain of call/import/dependency/contains edges connecting two symbols, files, or components — walked in either direction. Use to understand coupling before a refactor, to verify the actual route behind a must-reach invariant, or to explain why editing A shows up in B's blast radius. Deterministic, read-only.",
      inputSchema: {
        from: z.string().describe("Start: a symbol id/name or file path."),
        to: z.string().describe("End: a symbol id/name or file path."),
        max_depth: z.number().optional().describe("Maximum hops to search (default 8)."),
      },
    },
    async ({ from, to, max_depth }): Promise<ToolResult> => {
      const A = store.resolveNodeIds(from);
      const B = store.resolveNodeIds(to);
      if (!A.length) return err(`"${from}" resolves to no indexed symbol/component (is the repo indexed?).`);
      if (!B.length) return err(`"${to}" resolves to no indexed symbol/component.`);
      let best: Array<{ id: string; via: string }> | null = null;
      for (const a of A.slice(0, 4)) {
        for (const b of B.slice(0, 4)) {
          const p = store.shortestPath(a, b, max_depth ?? 8);
          if (p && (!best || p.length < best.length)) best = p;
        }
      }
      if (!best) return ok(`No path between "${from}" and "${to}" within ${max_depth ?? 8} hop(s) — they are not connected in the indexed graph.`);
      const chain = best.map((n, i) => `  ${i === 0 ? "┌" : i === best!.length - 1 ? "└" : "├"} ${n.via}`).join("\n");
      return ok(`${best.length - 1} hop(s) from "${from}" to "${to}":\n${chain}`);
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

  // -- Hunch Constitution (read-first, agent-neutral Policy IR) ------------
  server.registerTool(
    "hunch_policy_candidates",
    {
      title: "List Constitution policy candidates",
      description:
        "List compiled/proposed deterministic Policy IR candidates. Read-only; candidates carry no authority and cannot block. Uses the same Git-native policy store for every MCP client.",
      inputSchema: {
        public_only: z.boolean().optional().describe("Exclude the private overlay from this response."),
      },
    },
    async ({ public_only }): Promise<ToolResult> => {
      try {
        const service = new ConstitutionService(store, root);
        const candidates = service.list({ publicOnly: public_only }).filter((p) => p.state === "compiled" || p.state === "validating" || p.state === "proposed");
        if (!candidates.length) return ok("No Constitution policy candidates.");
        return ok(JSON.stringify(candidates.map((p) => ({ id: p.id, state: p.state, statement: p.statement, proof: p.proof, data_class: p.data_class })), null, 2));
      } catch (e) {
        return err(`Failed to list policy candidates: ${(e as Error).message}`);
      }
    },
  );

  server.registerTool(
    "hunch_policy_plan",
    {
      title: "Generate or inspect a Constitution proof plan",
      description:
        "Return the canonical Git-native ProofPlan for a policy candidate: immutable source/current commits, known-good/bad corpus, mutation operators, expectations, and budgets. Planning executes no replay, model, test, or authority transition.",
      inputSchema: {
        policy_id: z.string().describe("Policy id (pol_*)."),
        public_only: z.boolean().optional().describe("Exclude private-overlay policy and evidence records."),
      },
    },
    async ({ policy_id, public_only }): Promise<ToolResult> => {
      try {
        return ok(JSON.stringify(new ConstitutionService(store, root).plan(policy_id, { publicOnly: public_only }), null, 2));
      } catch (e) {
        return err(`Failed to generate policy proof plan: ${(e as Error).message}`);
      }
    },
  );

  server.registerTool(
    "hunch_policy_card",
    {
      title: "Inspect a Constitution proof card",
      description:
        "Return the deterministic proof-card view for a policy: exact assertion/scope, raw evidence vector, uncertainty, blocking readiness, authority, limitations, and next actions. Read-only and grants no authority.",
      inputSchema: {
        policy_id: z.string().describe("Policy id (pol_*)."),
        public_only: z.boolean().optional().describe("Exclude private-overlay policy and proof records."),
      },
    },
    async ({ policy_id, public_only }): Promise<ToolResult> => {
      try {
        return ok(JSON.stringify(new ConstitutionService(store, root).card(policy_id, { publicOnly: public_only }), null, 2));
      } catch (e) {
        return err(`Failed to build policy proof card: ${(e as Error).message}`);
      }
    },
  );

  server.registerTool(
    "hunch_policy_shadow",
    {
      title: "Inspect Constitution shadow precision",
      description:
        "Return the append-only shadow evaluation ledger, current human dispositions, raw precision counts, unknown/error rate, thresholds, and P4-review recommendation for one policy. Read-only: it never records a sample, changes lifecycle, activates, warns, or blocks.",
      inputSchema: {
        policy_id: z.string().describe("Policy id (pol_*)."),
        public_only: z.boolean().optional().describe("Exclude private-overlay shadow records."),
      },
    },
    async ({ policy_id, public_only }): Promise<ToolResult> => {
      try {
        return ok(JSON.stringify(new ConstitutionService(store, root).shadowReport(policy_id, {}, { publicOnly: public_only }), null, 2));
      } catch (e) {
        return err(`Failed to inspect policy shadow precision: ${(e as Error).message}`);
      }
    },
  );

  server.registerTool(
    "hunch_policy_proof",
    {
      title: "Inspect a Constitution policy proof",
      description:
        "Return the full content-addressed proof artifact for a policy. Read-only; exposes baseline, mutations, proof class, artifact hashes, and limitations without changing authority.",
      inputSchema: {
        policy_id: z.string().describe("Policy id (pol_*)."),
        public_only: z.boolean().optional().describe("Exclude the private overlay from this response."),
      },
    },
    async ({ policy_id, public_only }): Promise<ToolResult> => {
      try {
        const service = new ConstitutionService(store, root);
        const policy = service.get(policy_id, { publicOnly: public_only });
        if (!policy.proof) return ok(`Policy ${policy_id} has no proof yet.`);
        return ok(JSON.stringify(service.proof(policy.proof, { publicOnly: public_only }), null, 2));
      } catch (e) {
        return err(`Failed to read policy proof: ${(e as Error).message}`);
      }
    },
  );

  server.registerTool(
    "hunch_policy_evaluate",
    {
      title: "Evaluate Constitution policy",
      description:
        "Evaluate one or all deterministic Policy IR records and return canonical neutral receipts (satisfied, violated, not_applicable, unknown, error). This is the same evaluator used by CLI and strict CI; models never decide the verdict.",
      inputSchema: {
        policy_id: z.string().optional().describe("Optional policy id; omit for all policies."),
        active_only: z.boolean().optional().describe("Evaluate only active advisory/blocking policies."),
        public_only: z.boolean().optional().describe("Exclude private-overlay policies and graph records."),
        workspace: z.enum(["staged", "working"]).optional().describe("For executable-behavior policies, evaluate the staged index or complete working snapshot in a disposable checkout."),
        commit: z.string().optional().describe("For executable-behavior policies, evaluate an exact commit ref instead of the current committed HEAD."),
      },
    },
    async ({ policy_id, active_only, public_only, workspace, commit }): Promise<ToolResult> => {
      try {
        if (workspace && commit) throw new Error("choose either workspace or commit for executable-behavior evaluation");
        if (commit && !revExists(commit, root)) throw new Error(`commit ref ${JSON.stringify(commit)} does not resolve`);
        indexRepo(store, root, { churn: false });
        store.reindex();
        const behavior = workspace ? { workspace }
          : commit ? { commit: revParse(commit, root) }
            : undefined;
        const receipts = new ConstitutionService(store, root)
          .evaluate({ id: policy_id, activeOnly: active_only, publicOnly: public_only, behavior })
          .map((r) => r.evaluation);
        return ok(JSON.stringify(receipts, null, 2));
      } catch (e) {
        return err(`Failed to evaluate policy: ${(e as Error).message}`);
      }
    },
  );

  server.registerTool(
    "hunch_constitution_g2_readiness",
    {
      title: "Inspect Constitution G2 readiness",
      description:
        "Return the exact private G2 dogfood evidence packet: human-selected policies, bound proof/corpus/shadow evidence, operational runbook rehearsals, and blockers. Read-only; it never creates evidence, signs off G2, activates policy, warns, or blocks.",
      inputSchema: {},
    },
    async (): Promise<ToolResult> => {
      try {
        return ok(JSON.stringify(new ConstitutionService(store, root).g2Readiness(), null, 2));
      } catch (e) {
        return err(`Failed to inspect G2 readiness: ${(e as Error).message}`);
      }
    },
  );

  server.registerTool(
    "hunch_constitution_g3_readiness",
    {
      title: "Inspect Constitution G3 readiness",
      description:
        "Return the exact private G3 advisory packet: human-selected policies and clients, immutable experiment preregistrations, proof-card comprehension/review measurements, executable adapter conformance, scorecard, and blockers. Read-only; it never records evidence, activates policy, or signs off G3.",
      inputSchema: {},
    },
    async (): Promise<ToolResult> => {
      try {
        return ok(JSON.stringify(new ConstitutionService(store, root).g3Readiness(), null, 2));
      } catch (e) {
        return err(`Failed to inspect G3 readiness: ${(e as Error).message}`);
      }
    },
  );

  server.registerTool(
    "hunch_constitution_g2_shadow_queue",
    {
      title: "Review unclassified G2 shadow violations",
      description:
        "Return a bounded private queue of exact-current-proof G2 shadow violations that still require human classification. Read-only; it never records an observation or disposition, changes lifecycle, grants authority, warns, or blocks.",
      inputSchema: {
        limit: z.number().int().min(1).max(100).optional().describe("Maximum queue items to return (default 20)."),
      },
    },
    async ({ limit }): Promise<ToolResult> => {
      try {
        return ok(JSON.stringify(new ConstitutionService(store, root).g2ShadowQueue(limit ?? 20), null, 2));
      } catch (e) {
        return err(`Failed to inspect the G2 shadow queue: ${(e as Error).message}`);
      }
    },
  );

  server.registerTool(
    "hunch_constitution_g2_operational_drill",
    {
      title: "Execute one exact G2 operational drill",
      description:
        "Execute the selected private G2 runbook's exact safety regression and return a content-addressed hash-only receipt. Diagnostic only: it writes no rehearsal or shadow evidence, grants no authority, and never signs off G2.",
      inputSchema: {
        category: z.enum(G2_RUNBOOK_CATEGORIES).describe("Exact operational category selected by the current private G2 plan."),
      },
    },
    async ({ category }): Promise<ToolResult> => {
      try {
        return ok(JSON.stringify(new ConstitutionService(store, root).g2OperationalDrill(category), null, 2));
      } catch (e) {
        return err(`Failed to execute the G2 operational drill: ${(e as Error).message}`);
      }
    },
  );

  server.registerTool(
    "hunch_constitution_g2_candidates",
    {
      title: "Review potential G2 dogfood candidates",
      description:
        "Return a bounded private review packet of exact structural candidates from fix-labeled git history, including the current append-only human selection/rejection when present. Read-only: proposed before/after corpus refs are not replayed evidence, and the tool creates no attestation, policy, proof, corpus, authority, warning, or block.",
      inputSchema: {
        since: z.string().min(1).max(100).optional().describe("Git history window (default 180d)."),
        max_commits: z.number().int().min(1).max(200).optional().describe("Maximum fix-labeled commits to inspect (default 100)."),
        limit: z.number().int().min(1).max(100).optional().describe("Maximum ranked candidates to return (default 30)."),
      },
    },
    async ({ since, max_commits, limit }): Promise<ToolResult> => {
      try {
        return ok(JSON.stringify(new ConstitutionService(store, root).g2CandidateReview({
          since: since ?? "180d",
          maxCommits: max_commits ?? 100,
          limit: limit ?? 30,
        }), null, 2));
      } catch (e) {
        return err(`Failed to inspect G2 candidates: ${(e as Error).message}`);
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

  server.registerTool(
    "hunch_constitution_g2_behavior_candidates",
    {
      title: "Review executable G2 behavior candidates",
      description:
        "Derive a bounded private review packet from human-grounded rejected structural proxies and newly added literal node:test cases in their exact fixing commits. Read-only: candidates remain unselected and create no policy, corpus, proof, authority, warning, or block.",
      inputSchema: {
        decision_id: z.string().regex(/^dec_[A-Za-z0-9_-]+$/).optional().describe("Exact current human-confirmed decision to use as the direct behavior grounding batch."),
        since: z.string().min(1).max(100).optional().describe("Git history window (default 180d)."),
        max_commits: z.number().int().min(1).max(200).optional().describe("Maximum fix-labeled commits to inspect (default 100)."),
        limit: z.number().int().min(1).max(100).optional().describe("Maximum behavior candidates to return (default 30)."),
      },
    },
    async ({ decision_id, since, max_commits, limit }): Promise<ToolResult> => {
      try {
        return ok(JSON.stringify(new ConstitutionService(store, root).g2BehaviorCandidateReview({
          since: since ?? "180d",
          maxCommits: max_commits ?? 100,
          limit: limit ?? 30,
          decisionId: decision_id,
        }), null, 2));
      } catch (e) {
        return err(`Failed to inspect G2 behavior candidates: ${(e as Error).message}`);
      }
    },
  );

  server.registerTool(
    "hunch_constitution_g2_behavior_replay",
    {
      title: "Replay one G2 behavior candidate",
      description:
        "Execute one exact behavior candidate without a shell in disposable known-bad and known-good worktrees, transplanting the hash-bound known-good test file into both. Diagnostic only: writes no Constitution artifact and grants no policy or G2 authority.",
      inputSchema: {
        candidate_id: z.string().regex(/^g2behavior_[a-f0-9]{10}$/),
        review_hash: z.string().regex(/^sha1:[a-f0-9]{40}$/),
        decision_id: z.string().regex(/^dec_[A-Za-z0-9_-]+$/).optional().describe("Exact decision batch used by the reviewed candidate."),
        since: z.string().min(1).max(100).optional().describe("Git history window used by the exact review packet (default 180d)."),
        max_commits: z.number().int().min(1).max(200).optional().describe("Fix-commit bound used by the exact review packet (default 100)."),
        limit: z.number().int().min(1).max(100).optional().describe("Item limit used by the exact review packet (default 30)."),
        timeout_ms: z.number().int().min(1).max(120000).optional().describe("Per-leg execution timeout (default 30000ms)."),
      },
    },
    async ({ candidate_id, review_hash, decision_id, since, max_commits, limit, timeout_ms }): Promise<ToolResult> => {
      try {
        return ok(JSON.stringify(new ConstitutionService(store, root).g2BehaviorCandidateReplay(candidate_id, review_hash, {
          since: since ?? "180d",
          maxCommits: max_commits ?? 100,
          limit: limit ?? 30,
          decisionId: decision_id,
          timeoutMs: timeout_ms ?? 30_000,
        }), null, 2));
      } catch (e) {
        return err(`Failed to replay G2 behavior candidate: ${(e as Error).message}`);
      }
    },
  );

  server.registerTool(
    "hunch_constitution_g2_behavior_materialization",
    {
      title: "Assess selected G2 behavior materialization",
      description:
        "Bind the complete current private behavior review and exact selected attestations, then report whether their durable meanings are expressible by the supported Policy IR. Read-only and fail-closed: unsupported behavior creates no policy, corpus, plan, proof, authority, warning, or block.",
      inputSchema: {
        decision_id: z.string().regex(/^dec_[A-Za-z0-9_-]+$/).optional().describe("Exact decision batch to assess."),
        since: z.string().min(1).max(100).optional().describe("Git history window used by the exact review packet (default 180d)."),
        max_commits: z.number().int().min(1).max(200).optional().describe("Fix-commit bound used by the exact review packet (default 100)."),
        limit: z.number().int().min(1).max(100).optional().describe("Item limit used by the exact review packet (default 30)."),
      },
    },
    async ({ decision_id, since, max_commits, limit }): Promise<ToolResult> => {
      try {
        return ok(JSON.stringify(new ConstitutionService(store, root).g2BehaviorMaterializationAssessment({
          since: since ?? "180d",
          maxCommits: max_commits ?? 100,
          limit: limit ?? 30,
          decisionId: decision_id,
        }), null, 2));
      } catch (e) {
        return err(`Failed to assess G2 behavior materialization: ${(e as Error).message}`);
      }
    },
  );

  server.registerTool(
    "hunch_constitution_g2_behavior_policy_materialize",
    {
      title: "Materialize selected G2 behavior policies",
      description:
        "Materialize every current exact selected behavior attestation into a separate private Policy IR v2 proposal, exact corpus and plan, and P3 executable proof. Writes private non-authoritative artifacts only; activation remains a separate explicit human action.",
      inputSchema: {
        decision_id: z.string().regex(/^dec_[A-Za-z0-9_-]+$/).optional().describe("Exact decision batch to materialize."),
        since: z.string().min(1).max(100).optional().describe("Git history window used by the complete exact review packet (default 180d)."),
        max_commits: z.number().int().min(1).max(200).optional().describe("Fix-commit bound used by the exact review packet (default 100)."),
        limit: z.number().int().min(1).max(100).optional().describe("Item limit used by the exact review packet (default 30)."),
        allow_install_scripts: z.array(z.string().min(1).max(214)).max(20).optional().describe("Exact dependency package names allowed to run lifecycle scripts while provisioning snapshots."),
        dependency_timeout_ms: z.number().int().min(1).max(900000).optional().describe("Timeout for each exact dependency snapshot operation (default 300000ms)."),
      },
    },
    async ({ decision_id, since, max_commits, limit, allow_install_scripts, dependency_timeout_ms }): Promise<ToolResult> => {
      try {
        return ok(JSON.stringify(new ConstitutionService(store, root).g2BehaviorPolicyMaterialize({
          since: since ?? "180d",
          maxCommits: max_commits ?? 100,
          limit: limit ?? 30,
          decisionId: decision_id,
          allowInstallScripts: allow_install_scripts ?? [],
          dependencyTimeoutMs: dependency_timeout_ms ?? 300_000,
        }), null, 2));
      } catch (e) {
        return err(`Failed to materialize G2 behavior policies: ${(e as Error).message}`);
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
