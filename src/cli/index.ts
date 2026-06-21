#!/usr/bin/env node
/**
 * `hunch` CLI (DESIGN.md §6). Subcommands:
 *   init      scaffold .hunch/, install hook, write .mcp.json + CLAUDE.md + slash cmds
 *   index     parse repo -> symbol/dependency graph + components (no LLM)
 *   backfill  replay git history -> seed decisions (cold-start fix)
 *   sync      commit diff -> Claude/heuristic -> decision write-back (post-commit hook)
 *   query     FTS + graph query over Hunch
 *   why       decisions/bugs/constraints explaining a file/symbol
 *   fragile   ranked fragility report with evidence
 *   record-bug  capture a Bug from a (failing) test
 *   test      run the suite, auto-capture failures as Bugs, resolve fixed ones
 *   mcp       start the MCP server (Claude Code connects here)
 *   doctor    environment diagnostics
 */
import { existsSync, readFileSync, writeFileSync } from "node:fs";
import { execFileSync, spawnSync } from "node:child_process";
import { join, relative } from "node:path";
import { Command } from "commander";
import { hunchPaths, findRoot, toPosixTarget } from "../core/paths.js";
import { looksLikeCorrection, CORRECTION_NUDGE } from "../core/correction.js";
import { HunchStore } from "../store/hunchStore.js";
import { selectEmbedder } from "../store/embedder.js";
import { indexRepo } from "../extractors/indexer.js";
import { syncCommit, recordFailure, captureTestRun } from "../synthesis/synthesize.js";
import { parseTestReport } from "../extractors/testreport.js";
import { selectProvider } from "../synthesis/provider.js";
import { isGitRepo, headSha, logSince, lastChangeDate, stagedFiles, commitFiles, asOfDate, stagedDiff, commitDiff, rangeFiles, rangeDiff, revExists } from "../extractors/git.js";
import { renderText, renderMarkdown, reportFailsStrict, type CheckReport } from "../core/checkreport.js";
import { installPostCommitHook, installPreCommitHook } from "../integrations/hooks.js";
import { installMergeDriver } from "../integrations/mergeDriver.js";
import { ensureGitignore } from "../integrations/gitignore.js";
import { writeCiWorkflow } from "../integrations/ciAction.js";
import { updateClaudeMd } from "../integrations/claudemd.js";
import { writeMcpJson, writeSlashCommands, installClaudeHooks } from "../integrations/scaffold.js";
import { scaffoldProviders } from "../integrations/providers.js";
import { healClaudeConfigCaseSplit } from "../integrations/claudeConfig.js";
import { formatContext } from "../core/format.js";
import { readConfig, writeConfig, FIRMNESS_LEVELS, isFirmness, type Firmness } from "../core/config.js";
import { blockingInScope } from "../core/hookpolicy.js";
import { constraintId } from "../core/ids.js";
import type { Constraint } from "../core/types.js";
import { readManifest, writeManifest, SCHEMA_VERSION } from "../core/migrate.js";
import { mergeHunchJson } from "../store/merge.js";
import { planCompaction } from "../store/compact.js";
import { resolveInvocation } from "./invocation.js";

const program = new Command();
program.name("hunch").description("Hunch — an Engineering Memory OS: a git-native reasoning graph for your codebase.").version("0.1.0");

let openStore: HunchStore | null = null;
function storeFor(): { store: HunchStore; root: string } {
  const root = findRoot();
  const store = new HunchStore(hunchPaths(root));
  openStore = store;
  return { store, root };
}

// ---- init -----------------------------------------------------------------
program
  .command("init")
  .description("Scaffold .hunch/, index the repo, install the git hook, and wire up your coding assistants (Claude Code, Cursor, VS Code, Windsurf, Codex).")
  .option("--no-index", "skip the initial repo index")
  .option("--no-enforce", "do not install the advisory pre-commit constraint guard")
  .option("--enforce-strict", "make the pre-commit guard FAIL the commit on a direct, high-confidence, non-stale blocking invariant")
  .option("--no-providers", "skip scaffolding non-Claude assistant configs (Cursor / VS Code / Codex / AGENTS.md)")
  .option("--no-agent-hooks", "skip installing the Claude Code agent hooks (.claude/settings.json)")
  .option("--firmness <level>", "agent-hook firmness: off | advisory | firm | strict")
  .action((opts: { index: boolean; enforce: boolean; enforceStrict?: boolean; providers: boolean; agentHooks: boolean; firmness?: string }) => {
    // Validate --firmness up front, before any side effects (indexing, git hooks,
    // .mcp.json) or opening the store — a bad value must not leave a half-init.
    if (opts.firmness !== undefined && !isFirmness(opts.firmness)) {
      return fail(`--firmness must be one of: ${FIRMNESS_LEVELS.join(", ")}`);
    }
    const root = findRoot();
    const paths = hunchPaths(root);
    const store = new HunchStore(paths);
    openStore = store; // so the top-level error handler closes it on failure
    const inv = resolveInvocation();
    console.log(`🧠 Initializing Hunch at ${root}`);

    store.json.ensureDirs(); // stamps the manifest at the current version when fresh
    console.log(`  ✓ .hunch/ scaffolded (schema v${readManifest(paths).schema_version})`);

    // Exclude the derived SQLite index BEFORE it's written, so the working tree
    // never goes dirty on the MCP server's index writes (which blocks branch
    // switches). The .hunch/*.json graph stays tracked.
    const gi = ensureGitignore(root);
    if (gi.action !== "unchanged") console.log(`  ✓ .gitignore ${gi.action} (Hunch runtime index excluded)`);

    if (opts.index !== false) {
      const res = indexRepo(store, root);
      store.reindex();
      console.log(`  ✓ indexed ${res.files} files → ${res.symbols} symbols, ${res.edges} edges, ${res.components} components`);
      if (res.skipped) console.log(`  ⚠ ${res.skipped} file(s) could not be parsed (skipped)`);
    }

    if (isGitRepo(root)) {
      const h = installPostCommitHook(root, inv.shell);
      console.log(`  ✓ post-commit hook ${h.action} (learning loop)`);
      const m = installMergeDriver(root, inv.shell);
      console.log(`  ✓ team merge driver ${m.action}`);
      // Auto-install the pre-commit guard by default (advisory: flags invariants
      // touched directly OR via blast radius, never blocks). Opt out with
      // --no-enforce; --enforce-strict makes blocking near/direct hits fail the commit.
      if (opts.enforce !== false || opts.enforceStrict) {
        const strict = !!opts.enforceStrict;
        const p = installPreCommitHook(root, inv.shell, strict);
        console.log(`  ✓ pre-commit constraint guard ${p.action} (${strict ? "strict — fails only on direct, high-confidence, non-stale blocking invariants" : "advisory — flags invariants in scope or blast radius"})`);
      }
    } else {
      console.log("  ⚠ not a git repo — skipped hooks (run `git init` to enable the learning loop)");
    }

    const mcp = writeMcpJson(root, inv.mcp);
    // .mcp.json is the CANONICAL registration: Claude Code resolves it by file path,
    // so it's immune to the Windows ~/.claude.json drive-letter case-split that a
    // global `claude mcp add` is prone to (see `hunch doctor`).
    console.log(`  ✓ wrote ${rel(root, mcp)} (registers the Hunch MCP server — canonical, path-keyed; prefer over a global \`claude mcp add\`)`);
    const cmds = writeSlashCommands(root);
    console.log(`  ✓ wrote ${cmds.length} slash commands (/hunch-why, /hunch-fix, /hunch-fragile)`);
    const cmd = updateClaudeMd(root, store);
    console.log(`  ✓ updated ${rel(root, cmd)} with ambient Hunch context`);

    // Firmness: stamp .hunch/config.json (default advisory) so `hunch hook` reads a
    // level even before the user runs `hunch firmness` (--firmness validated above).
    const firmness = writeConfig(paths, opts.firmness ? { firmness: opts.firmness as Firmness } : {}).firmness;

    // Agent hooks: ground the assistant in Hunch automatically (PreToolUse injects
    // context before edits; UserPromptSubmit reminds). Reads firmness at run time.
    if (opts.agentHooks !== false) {
      const a = installClaudeHooks(root, `${inv.shell} hook`);
      console.log(`  ✓ Claude Code agent hooks ${a.action} (firmness: ${firmness} — change with \`hunch firmness <level>\`)`);
    }

    // Multi-assistant compatibility: the MCP server is client-agnostic, so wire up
    // Cursor / VS Code (Copilot) / Codex / AGENTS.md to the same .hunch/ graph.
    if (opts.providers !== false) {
      const ps = scaffoldProviders(root, inv.mcp, store);
      const ok = ps.filter((p) => !p.error);
      const total = ok.reduce((a, p) => a + p.files.length, 0);
      console.log(`  ✓ wrote ${total} multi-assistant config file(s) → ${ok.map((p) => p.assistant).join(", ")}`);
      for (const p of ps) if (p.error) console.log(`  ⚠ skipped ${p.assistant}: ${p.error}`);
    }

    // Windows self-heal: if an earlier global `claude mcp add` left a drive-letter
    // case-split in ~/.claude.json, merge it so hunch resolves under either casing.
    // No-op (silent) off Windows.
    reportClaudeConfigHeal();

    store.close();
    console.log("\nNext: make a commit (the hook captures a decision), then ask your coding assistant \"why is X built this way?\"");
    console.log("Cold start? Seed from history:  hunch backfill --since 90d");
  });

// ---- index ----------------------------------------------------------------
program
  .command("index")
  .description("Parse the repo into a symbol/dependency graph + components (deterministic, no LLM).")
  .action(() => {
    const { store, root } = storeFor();
    store.json.ensureDirs();
    ensureGitignore(root); // keep the derived SQLite index out of git (idempotent)
    const res = indexRepo(store, root);
    const { counts } = store.reindex();
    updateClaudeMd(root, store);
    console.log(`Indexed ${res.files} files:`);
    console.log(`  ${counts.symbols} symbols, ${counts.edges} edges, ${counts.components} components`);
    if (res.skipped) console.log(`  ⚠ ${res.skipped} file(s) could not be parsed (skipped)`);
    store.close();
  });

// ---- backfill -------------------------------------------------------------
/** Run an async fn over items with at most `limit` in flight. A fixed pool of
 *  workers pulls from a shared cursor — no per-batch barrier, so a slow item
 *  never stalls the others. Used by backfill to overlap per-commit LLM spawns. */
async function mapPool<T>(items: T[], limit: number, fn: (item: T, index: number) => Promise<void>): Promise<void> {
  let next = 0;
  const worker = async (): Promise<void> => {
    while (next < items.length) {
      const i = next++;
      await fn(items[i]!, i);
    }
  };
  await Promise.all(Array.from({ length: Math.min(limit, items.length) }, () => worker()));
}

program
  .command("backfill")
  .description("Replay git history to seed decisions (cold-start fix).")
  .option("--since <spec>", "how far back, e.g. 90d", "90d")
  .option("--max <n>", "max commits to process", "40")
  .option("--concurrency <n>", "commits to synthesize in parallel (the LLM call is the bottleneck)", "4")
  .action(async (opts: { since: string; max: string; concurrency: string }) => {
    const { store, root } = storeFor();
    if (!isGitRepo(root)) return fail("backfill needs a git repo");
    store.json.ensureDirs();
    const commits = logSince(opts.since, root, Number(opts.max));
    const conc = Math.max(1, Math.min(16, Number(opts.concurrency) || 4));
    console.log(`Backfilling from ${commits.length} commit(s) since ${opts.since} (concurrency ${conc})…`);
    let written = 0, skipped = 0, llm = 0, heuristic = 0;
    // The per-commit cost is the Claude synthesis spawn; run several at once. Safe:
    // each commit drafts independently and writes its OWN decision file atomically,
    // and the store's JS-side reads/writes run synchronously between awaits (single
    // thread) — only the LLM spawns overlap. reindex() runs once, after the pool.
    await mapPool(commits, conc, async (sha) => {
      const r = await syncCommit(store, root, sha);
      if (r.status === "written") {
        written++;
        if (r.provider === "claude-cli") llm++; else heuristic++;
        process.stdout.write(`  ✓ ${sha.slice(0, 8)} ${r.decision?.title.slice(0, 64) ?? ""}\n`);
      } else skipped++;
    });
    store.reindex();
    updateClaudeMd(root, store);
    // Honest tally of where the tokens went: trivial commits are seeded by the
    // free deterministic heuristic, only substantive ones spend the LLM.
    console.log(`Done: ${written} decision(s) seeded (${llm} via LLM, ${heuristic} heuristic), ${skipped} skipped (trivial/non-code/already-captured).`);
    store.close();
  });

// ---- sync (post-commit hook) ----------------------------------------------
program
  .command("sync")
  .description("Capture a decision from a commit (run by the post-commit hook).")
  .argument("[sha]", "commit to sync (default: HEAD)")
  .option("--from-hook", "invoked by the git hook")
  .option("--quiet", "minimal output")
  .option("--force", "re-synthesize even if a decision already exists for the commit")
  .action(async (sha: string | undefined, opts: { fromHook?: boolean; quiet?: boolean; force?: boolean }) => {
    const { store, root } = storeFor();
    if (!isGitRepo(root)) return opts.quiet ? undefined : fail("sync needs a git repo");
    store.json.ensureDirs();
    const r = await syncCommit(store, root, sha ?? headSha(root), { force: opts.force });
    if (r.status === "written") {
      store.reindex();
      // Don't rewrite CLAUDE.md from the hook — it would dirty the working tree
      // on every commit. `hunch index`/`init` refresh it intentionally instead.
      if (!opts.fromHook) updateClaudeMd(root, store);
      if (!opts.quiet) console.log(`✓ captured decision ${r.decision?.id} via ${r.provider}: "${r.decision?.title}"`);
    } else if (!opts.quiet) {
      console.log(`· skipped: ${r.reason}`);
    }
    store.close();
  });

// ---- query ----------------------------------------------------------------
program
  .command("query")
  .description("Full-text + graph search over Hunch (add --semantic for embeddings-backed recall).")
  .argument("<question...>", "what to search for")
  .option("--semantic", "blend in local semantic search (requires `hunch embed`)")
  .action(async (parts: string[], opts: { semantic?: boolean }) => {
    const { store } = storeFor();
    store.reindex(); // reflect any out-of-band JSON edits before searching
    const q = parts.join(" ");
    let hits;
    let how = "";
    if (opts.semantic) {
      // Same gate hybridSearch uses internally (store.semanticReady), so the flag's
      // messaging can't drift from what actually runs. If unusable, say so and use FTS
      // rather than silently returning identical keyword results under the flag.
      const emb = await selectEmbedder();
      if (!store.semanticReady(emb)) {
        console.log("· semantic search isn't enabled yet — run `hunch embed` (using keyword search for now).\n");
        hits = store.search(q, 12);
      } else {
        hits = await store.hybridSearch(q, 12, { embedder: emb });
        how = " (semantic + keyword)";
      }
    } else {
      hits = store.search(q, 12);
    }
    if (!hits.length) {
      console.log(`No matches for "${q}".`);
    } else {
      console.log(`Top matches for "${q}"${how}:\n`);
      for (const h of hits) console.log(`• [${h.kind}] ${h.ref} — ${h.title}\n    ${h.snippet}`);
    }
    store.close();
  });

// ---- embed (opt-in semantic search) ---------------------------------------
program
  .command("embed")
  .description("Generate local embeddings for semantic search (opt-in; needs @huggingface/transformers).")
  .option("--batch <n>", "embedding batch size", "32")
  .action(async (opts: { batch: string }) => {
    const { store } = storeFor();
    const embedder = await selectEmbedder();
    if (!embedder) {
      console.log("Semantic search needs a local embedding model, which isn't installed.");
      console.log("  Enable it:  npm i -g @huggingface/transformers   (then re-run `hunch embed`)");
      console.log("  Until then, `hunch query` uses fast keyword (FTS) search — no setup needed.");
      store.close();
      return; // not an error: the lean install simply doesn't have semantic search
    }
    store.json.ensureDirs();
    store.reindex(); // make `search` + doc hashes current before embedding
    const stats = store.embeddingStats(embedder.id);
    const todo = stats.total - stats.embedded;
    if (todo === 0) {
      console.log(`✓ All ${stats.total} doc(s) already embedded (model ${embedder.id}). Nothing to do.`);
      store.close();
      return;
    }
    process.stdout.write(`Embedding ${todo} doc(s) with ${embedder.id} (first run downloads the model ~90MB, one time)…\n`);
    try {
      const res = await store.embedAll(embedder, {
        batch: Number(opts.batch),
        onProgress: (done, total) => process.stdout.write(`\r  ${done}/${total} embedded   `),
      });
      process.stdout.write("\n");
      console.log(`✓ embedded ${res.embedded} doc(s) (${res.skipped} already current). Model: ${embedder.id}.`);
      console.log(`  Try:  hunch query --semantic "<question>"   — the MCP server uses it automatically.`);
    } catch (e) {
      // The availability probe (createRequire.resolve) can succeed while the
      // runtime ESM import/model load fails — e.g. the package is only
      // resolvable via NODE_PATH, or a native backend is missing. Degrade with
      // an actionable hint instead of a stack trace; queries stay on keyword search.
      process.stdout.write("\n");
      console.log("Semantic model is present but failed to load — staying on keyword (FTS) search.");
      console.log(`  reason: ${(e as Error).message.split("\n")[0]}`);
      console.log("  Install @huggingface/transformers where hunch actually runs (a global `hunch` needs a global install; running from source needs it in the repo's node_modules).");
    }
    store.close();
  });

// ---- why ------------------------------------------------------------------
program
  .command("why")
  .description("Explain why a file/symbol is the way it is (decisions, bugs, constraints).")
  .argument("<target>", "file path or symbol name")
  .option("--as-of <ref>", "time-travel: what was believed as of a commit/tag/branch (e.g. v0.7.0, HEAD~5)")
  .action((target: string, opts: { asOf?: string }) => {
    const { store, root } = storeFor();
    const asOf = opts.asOf ? asOfDate(opts.asOf, root) : undefined;
    if (opts.asOf && !asOf) return fail(`could not resolve --as-of "${opts.asOf}" to a commit (need a git repo and a valid ref)`);
    const w = store.why(target, { asOf });
    const staleIds = new Set(store.staleness((f) => lastChangeDate(f, root)).map((s) => s.id));
    const drift = (id: string) => (staleIds.has(id) ? " ⚠STALE" : "");
    console.log(asOf ? `Why "${target}" (as of ${opts.asOf} — ${asOf.slice(0, 10)}):\n` : `Why "${target}":\n`);
    if (w.decisions.length) {
      console.log("DECISIONS:");
      for (const d of w.decisions) console.log(`  • ${d.id} [${d.status}]${drift(d.id)} ${d.title}\n      ${d.decision} ⟨${d.provenance.source}, ${d.provenance.confidence}⟩`);
    }
    if (w.constraints.length) {
      console.log("CONSTRAINTS (must not break):");
      for (const c of w.constraints) console.log(`  • ${c.id} [${c.severity}]${drift(c.id)} ${c.statement}`);
    }
    if (w.bugs.length) {
      console.log("BUG HISTORY:");
      for (const b of w.bugs) console.log(`  • ${b.id} [${b.status}] ${b.title} — ${b.root_cause}`);
    }
    if (!w.decisions.length && !w.constraints.length && !w.bugs.length) {
      console.log("(No recorded decisions/bugs/constraints yet. Try `hunch backfill` or make a commit.)");
    }
    if (w.symbols.length) console.log(`\nSYMBOLS: ${w.symbols.map((s) => `${s.name} [fan-in ${s.metrics.fan_in}, churn ${s.metrics.churn_90d}]`).join(", ")}`);
    store.close();
  });

// ---- fragile --------------------------------------------------------------
program
  .command("fragile")
  .description("Ranked fragility report with evidence.")
  .option("--limit <n>", "how many", "15")
  .action((opts: { limit: string }) => {
    const { store } = storeFor();
    const nodes = store.fragility(Number(opts.limit));
    if (!nodes.length) {
      console.log("No fragility signal yet (index the repo and accumulate bug history first).");
    } else {
      console.log("Most fragile symbols (fragility = bugs × churn × centrality):\n");
      for (const n of nodes) console.log(`  ${n.score.toFixed(2)}  ${n.name}  ${dim(n.file)}\n         ${n.evidence.join(" · ") || "—"}`);
    }
    store.close();
  });

// ---- record-bug -----------------------------------------------------------
program
  .command("record-bug")
  .description("Capture a Bug from a failing test (symptom + suspect ranking).")
  .requiredOption("--test <id>", "failing test id/name")
  .requiredOption("--message <msg>", "failure message / stack")
  .action(async (opts: { test: string; message: string }) => {
    const { store, root } = storeFor();
    store.json.ensureDirs();
    const r = await recordFailure(store, root, { test: opts.test, message: opts.message });
    store.reindex();
    console.log(`✓ recorded bug ${r.bug.id} via ${r.provider}: "${r.bug.title}"`);
    if (r.bug.lineage.recurrence_of) console.log(`  ↳ recurrence of ${r.bug.lineage.recurrence_of}`);
    if (r.constraint) console.log(`  ↳ promoted constraint ${r.constraint.id} [${r.constraint.severity}]: ${r.constraint.statement}`);
    store.close();
  });

// ---- record-constraint (human-authored invariant) -------------------------
program
  .command("record-constraint")
  .description("Record an invariant the codebase must not break — what `hunch check` and the strict agent hook enforce.")
  .argument("<statement>", 'the invariant, e.g. "vectors are derived, never the source of truth"')
  .option("--scope <globs>", "comma-separated path/glob(s) it applies to (e.g. src/store/**)", "")
  .option("--severity <s>", "advisory | warning | blocking", "warning")
  .option("--type <t>", "security | performance | correctness | architecture | compliance", "correctness")
  .option("--rationale <text>", "why it must hold", "")
  .option("--source-decision <id>", "decision id this derives from")
  .option("--enforcement <e>", "advisory_v1 | ci | manual", "advisory_v1")
  .action((statement: string, opts: { scope: string; severity: string; type: string; rationale: string; sourceDecision?: string; enforcement: string }) => {
    const SEV = ["advisory", "warning", "blocking"];
    if (!SEV.includes(opts.severity)) return fail(`--severity must be one of: ${SEV.join(", ")}`);
    const { store, root } = storeFor();
    store.json.ensureDirs();
    const scope = opts.scope.split(",").map((s) => toPosixTarget(s.trim())).filter(Boolean);
    const c = store.json.put("constraints", {
      id: constraintId(statement),
      type: opts.type,
      statement,
      scope,
      severity: opts.severity,
      enforcement: opts.enforcement,
      rationale: opts.rationale,
      source_decision: opts.sourceDecision ?? null,
      violations: [],
      status: "active",
      valid_from: new Date().toISOString(),
      valid_to: null,
      provenance: { source: "human_confirmed", confidence: 1, evidence: [], last_verified: new Date().toISOString() },
    } as Constraint);
    store.reindex();
    updateClaudeMd(root, store);
    console.log(`✓ recorded ${c.severity} constraint ${c.id}: "${c.statement}" (scope: ${scope.join(", ") || "repo"})`);
    store.close();
  });

// ---- test (failure-learning loop) -----------------------------------------
program
  .command("test")
  .description("Run the test suite; capture failures as Bugs (suspects + recurrence → Constraints), mark passing tests' bugs fixed.")
  .argument("[cmd...]", "test command to run (default: `npm test`)")
  .option("--dry-run", "show what would be captured without writing")
  .action(async (cmd: string[], opts: { dryRun?: boolean }) => {
    const { store, root } = storeFor();
    store.json.ensureDirs();
    // Run as a shell string (not argv) so the npm/test-runner shim resolves on
    // Windows and avoids Node's DEP0190 args+shell warning — same lesson as the
    // claude CLI fix. The command is operator-supplied, so a shell is expected.
    const cmdStr = cmd.length ? cmd.join(" ") : "npm test";
    console.log(`▶ running: ${cmdStr}\n`);
    const run = spawnSync(cmdStr, {
      cwd: root,
      shell: true,
      encoding: "utf8",
      maxBuffer: 64 * 1024 * 1024,
      windowsHide: true,
    });
    const output = `${run.stdout ?? ""}\n${run.stderr ?? ""}`;
    const report = parseTestReport(output);

    if (opts.dryRun) {
      const willFallback = !report.recognized && run.status !== 0;
      const n = willFallback ? 1 : report.failures.length;
      console.log(`DRY RUN — exit ${run.status}, ${report.passed.length} passed, ${n} failure(s)${willFallback ? " (fallback: output not TAP/spec)" : ""}:`);
      for (const f of report.failures) console.log(`  ✗ ${f.test}`);
      if (willFallback) console.log(`  ✗ ${cmdStr} (whole-suite)`);
      store.close();
      return;
    }

    const cap = await captureTestRun(store, root, { report, status: run.status, cmd: cmdStr, output });
    for (const { bug, constraint } of cap.results) {
      if (constraint) console.log(`  ⚠ ${bug.id} "${bug.title}" → promoted constraint ${constraint.id} [${constraint.severity}]`);
      else console.log(`  ✗ ${bug.id} "${bug.title}" [${bug.severity}]${bug.lineage.recurrence_of ? ` ↳ recurrence of ${bug.lineage.recurrence_of}` : ""}`);
    }
    for (const b of cap.fixed) console.log(`  ✓ ${b.id} "${b.title}" → fixed (test passing)`);

    store.reindex();
    store.close();
    const recurrences = cap.results.filter((r) => r.bug.lineage.recurrence_of).length;
    const promoted = cap.results.filter((r) => r.constraint).length;
    console.log(
      `\n${run.status === 0 ? "✓ suite passed" : "✗ suite failed"} — ` +
      `${cap.results.length} bug(s) captured (${recurrences} recurrence, ${promoted} constraint), ${cap.fixed.length} resolved.`,
    );
    if (run.status !== 0) process.exitCode = 1; // preserve CI semantics
  });

// ---- stale (drift detection) ----------------------------------------------
program
  .command("stale")
  .description("List decisions/constraints whose files changed after they were last verified (drift).")
  .option("--resync", "re-synthesize stale decisions from their commit via the LLM (drift repair)")
  .action(async (opts: { resync?: boolean }) => {
    const { store, root } = storeFor();
    const stale = store.staleness((f) => lastChangeDate(f, root));
    if (!stale.length) {
      console.log("✓ No drift detected — every verified decision/constraint is current.");
      store.close();
      return;
    }
    if (!opts.resync) {
      console.log(`⚠ ${stale.length} record(s) may be stale (a file in scope changed after last verification):\n`);
      for (const s of stale) {
        console.log(`  ${s.kind} ${s.id}\n      verified ${s.last_verified.slice(0, 10)} · changed ${s.changed_at.slice(0, 10)} · ${s.files.join(", ")}`);
      }
      console.log(`\nRepair: hunch stale --resync  (re-synthesize from commits)  ·  or  hunch review --accept <id>`);
      store.close();
      return;
    }
    // --resync: regenerate each stale DECISION from its commit. Constraints have no
    // commit to replay, so they're reported as needing manual review instead.
    let resynced = 0, skipped = 0;
    for (const s of stale) {
      if (!s.kind.startsWith("decision")) { skipped++; console.log(`  · ${s.kind} ${s.id} — manual (no commit to replay)`); continue; }
      const d = store.json.get("decisions", s.id);
      if (!d?.commit) { skipped++; console.log(`  · ${s.id} — skipped (no source commit)`); continue; }
      const r = await syncCommit(store, root, d.commit, { force: true });
      if (r.status === "written") { resynced++; console.log(`  ↻ ${s.id} ← ${d.commit.slice(0, 8)} (${r.provider})`); }
      else { skipped++; console.log(`  · ${s.id} — skipped: ${r.reason}`); }
    }
    store.reindex();
    store.close();
    console.log(`\n✓ re-synthesized ${resynced} stale decision(s), ${skipped} left for manual review.`);
  });

// ---- check (constraint enforcement) ---------------------------------------
program
  .command("check")
  .description("Flag changes that touch a do-not-break invariant — the local guardrail AND the CI/PR Constraint Guard.")
  .option("--staged", "check git staged files (default)")
  .option("--commit <sha>", "check a specific commit's files")
  .option("--base <ref>", "check a PR/branch: files changed vs <ref> (e.g. origin/main) — for CI")
  .option("--strict", "exit non-zero ONLY on a direct, high-confidence, non-stale blocking invariant (near/stale/low-confidence stay advisory)")
  .option("--format <fmt>", "output: text (default) | markdown (a PR comment)", "text")
  .option("--blast", "also print the dependency blast radius of the changed files")
  .action((opts: { staged?: boolean; commit?: string; base?: string; strict?: boolean; format?: string; blast?: boolean }) => {
    const sources = [opts.commit && "--commit", opts.base && "--base", opts.staged && "--staged"].filter(Boolean);
    if (sources.length > 1) return fail(`pick one of --staged / --commit / --base (got ${sources.join(", ")})`);
    const markdown = opts.format === "markdown";
    const emptyReport: CheckReport = { fileCount: 0, strict: !!opts.strict, direct: [], near: [], regressions: [], strictBlockers: 0, regBlocking: 0 };

    const { store, root } = storeFor();
    // Fail loudly on an unresolvable --base (e.g. CI forgot to fetch the base
    // branch) — otherwise the diff is empty and the guard passes vacuously.
    if (opts.base && !revExists(opts.base, root)) {
      store.close();
      return fail(`--base ref "${opts.base}" does not resolve. In CI, fetch the base branch first (git fetch origin <branch>).`);
    }
    store.reindex(); // blast radius walks the edge graph — make the index current
    const files = opts.commit ? commitFiles(opts.commit, root)
      : opts.base ? rangeFiles(opts.base, root)
      : stagedFiles(root);
    if (!files.length) {
      console.log(markdown ? renderMarkdown(emptyReport) : "No changed files to check.");
      store.close();
      return;
    }
    // DIRECT (scope match) + NEAR (blast radius) + REGRESSION (re-added retired
    // code) + the hardened strict gate + causal `why` citations — all assembled by
    // the shared store.buildCheckReport (also used by the hunch_merge_verdict tool).
    const diff = opts.commit ? commitDiff(opts.commit, root) : opts.base ? rangeDiff(opts.base, root) : stagedDiff(root);
    const report: CheckReport = store.buildCheckReport(files, diff, {
      strict: !!opts.strict,
      lastChange: (f) => lastChangeDate(f, root),
    });

    if (opts.blast && !markdown) {
      console.log(`Blast radius of ${files.length} changed file(s):`);
      for (const f of files) {
        const b = store.blastRadiusFiles(f);
        const list = b.length ? `: ${b.slice(0, 8).map((x) => x.file).join(", ")}${b.length > 8 ? " …" : ""}` : "";
        console.log(`  ${f} → ${b.length} dependent file(s)${list}`);
      }
      console.log("");
    }

    console.log(markdown ? renderMarkdown(report) : renderText(report));
    if (reportFailsStrict(report)) process.exitCode = 1;
    store.close();
  });

// ---- ci (scaffold the CI Constraint Guard) --------------------------------
program
  .command("ci")
  .description("Scaffold the CI Constraint Guard: a GitHub Action that runs `hunch check` on PRs, comments the result, and fails on a blocking invariant.")
  .action(() => {
    const root = findRoot();
    const r = writeCiWorkflow(root);
    if (r.action === "created") {
      console.log(`✓ wrote ${rel(root, r.path)}`);
      console.log("  Runs on every PR: comments the affected invariants/decisions and fails on a direct,");
      console.log("  high-confidence, non-stale blocking invariant. Commit it, then (optionally) make");
      console.log('  "Hunch Guard" a required status check in branch protection to enforce on merge.');
    } else {
      console.log(`· ${rel(root, r.path)} already exists — left untouched. Delete it to regenerate.`);
    }
  });

// ---- context (surgical retrieval) -----------------------------------------
program
  .command("context")
  .description("Assemble the minimal relevant Hunch slice for a task on a file/symbol.")
  .argument("<target>", "file path or symbol")
  .option("--budget <n>", "rough token budget", "1500")
  .option("--as-of <ref>", "time-travel: assemble the slice as it stood at a commit/tag/branch")
  .action((target: string, opts: { budget: string; asOf?: string }) => {
    const { store, root } = storeFor();
    const asOf = opts.asOf ? asOfDate(opts.asOf, root) : undefined;
    if (opts.asOf && !asOf) return fail(`could not resolve --as-of "${opts.asOf}" to a commit`);
    store.reindex(); // reflect any out-of-band JSON edits before assembling
    process.stdout.write(formatContext(store.assembleContext(target, Number(opts.budget), { asOf })));
    store.close();
  });

// ---- timeline -------------------------------------------------------------
program
  .command("timeline")
  .description("Time-travel: the decision history for a file/symbol — what was believed, and when/why it changed.")
  .argument("<target>", "file path or symbol name")
  .action((target: string) => {
    const { store } = storeFor();
    const tl = store.timeline(target);
    if (!tl.length) {
      console.log(`No decision history for "${target}" yet.`);
    } else {
      console.log(`Decision timeline for "${target}" (newest first):\n`);
      for (const d of tl) {
        const from = (d.valid_from ?? d.date).slice(0, 10);
        const window = d.valid_to ? `${from} → ${d.valid_to.slice(0, 10)}` : `${from} → now`;
        const sup = d.superseded_by ? ` ↦ superseded by ${d.superseded_by}` : "";
        console.log(`  • ${d.id} [${d.status}] (${window})${sup}\n      ${d.title}`);
      }
    }
    store.close();
  });

// ---- supersede ------------------------------------------------------------
program
  .command("supersede")
  .description("Mark one decision as replaced by another: closes the old one's valid-time window (invalidate, don't delete).")
  .argument("<old>", "decision id being replaced")
  .requiredOption("--by <new>", "decision id that supersedes it")
  .action((oldId: string, opts: { by: string }) => {
    const { store } = storeFor();
    const by = store.json.get("decisions", opts.by);
    if (!by) { store.close(); return fail(`--by decision "${opts.by}" not found`); }
    const closed = store.supersede(oldId, by);
    if (!closed) { store.close(); return fail(`decision "${oldId}" not found (or same as --by)`); }
    store.reindex();
    console.log(`✓ ${oldId} superseded by ${opts.by} — window closed at ${closed.valid_to?.slice(0, 10)}.`);
    store.close();
  });

// ---- firmness (agent-hook enforcement level) ------------------------------
program
  .command("firmness")
  .description("Get or set how firmly the Claude Code agent hook enforces Hunch before edits.")
  .argument("[level]", "off | advisory | firm | strict (omit to print the current level)")
  .action((level: string | undefined) => {
    const paths = hunchPaths(findRoot());
    if (!level) {
      console.log(`firmness: ${readConfig(paths).firmness}`);
      console.log(`levels:   ${FIRMNESS_LEVELS.join(" | ")}  (set with: hunch firmness <level>)`);
      return;
    }
    if (!isFirmness(level)) {
      return fail(`firmness must be one of: ${FIRMNESS_LEVELS.join(", ")}`);
    }
    const next = writeConfig(paths, { firmness: level }).firmness;
    console.log(`✓ firmness set to ${next} (takes effect on the next edit — no Claude Code restart needed).`);
  });

// ---- hook (Claude Code agent-hook handler) --------------------------------
program
  .command("hook")
  .description("Claude Code hook handler: inject relevant Hunch context before edits (and, at strict firmness, deny edits that hit a blocking invariant). Reads the hook event JSON on stdin.")
  .action(async () => {
    // A hook MUST NEVER break the agent: on ANY error or unrecognized input we
    // emit nothing and exit 0 (the action defers to Claude Code's normal flow).
    let store: HunchStore | null = null;
    try {
      const evt = JSON.parse(await readStdin()) as {
        hook_event_name?: string;
        tool_input?: { file_path?: string };
        prompt?: string;
      };
      const root = findRoot();
      const paths = hunchPaths(root);
      const firmness = readConfig(paths).firmness;
      if (firmness === "off") return;

      if (evt.hook_event_name === "UserPromptSubmit") {
        // When the prompt reads like a correction ("no / that's wrong / never X"),
        // nudge the agent to PERSIST it as an enforced constraint (Never Twice) —
        // not just obey it this once and forget it next session.
        const text = looksLikeCorrection(evt.prompt) ? `${HOOK_REMINDER}\n\n${CORRECTION_NUDGE}` : HOOK_REMINDER;
        emitContext("UserPromptSubmit", text);
        return;
      }
      if (evt.hook_event_name !== "PreToolUse") return;

      const abs = evt.tool_input?.file_path;
      if (!abs) return;
      const target = toRepoRel(root, abs);
      // Outside the repo (".." prefix) or on another drive (absolute, e.g. "D:/…")
      // → nothing for Hunch to say.
      if (!target || target.startsWith("..") || /^[a-zA-Z]:/.test(target)) return;

      store = new HunchStore(paths);

      // strict: refuse an edit that hits a BLOCKING invariant (direct OR via blast
      // radius), feeding the invariant statement back as the refusal reason. Reindex
      // first so the blast radius reflects uncommitted edges — strict opts into the
      // cost for correctness. Advisory/firm skip it: the hook fires on every edit,
      // and decisions/constraints don't change between commits, so the committed
      // index is good enough for grounding.
      if (firmness === "strict") {
        store.reindex();
        const deny = blockingInScope(store, target);
        if (deny) {
          emitDeny(deny.reason);
          return;
        }
      }

      // advisory / firm / strict(non-blocking): inject the relevant Hunch slice.
      const ctx = store.assembleContext(target);
      // Regression Guard (edit-time grounding): what an in-force decision retired
      // from this file. No diff exists yet, so this is context — "don't re-add X" —
      // not a block; the commit-time `hunch check` does the actual gating.
      const retired = store.retiredForFile(target).filter((r) => r.symbols.length || r.deps.length);
      const hasContent =
        ctx.constraints.length || ctx.decisions.length || ctx.bugs.length || ctx.blast_radius.length || retired.length;
      if (!hasContent) return; // no noise on files Hunch hasn't learned yet
      let text = formatContext(ctx).trim();
      if (firmness !== "advisory" && ctx.constraints.length) {
        const names = ctx.constraints.map((c) => `[${c.severity}] ${c.statement}`).join("; ");
        text += `\n\n⚠ This file is in scope of ${ctx.constraints.length} invariant(s): ${names}. Preserve them.`;
      }
      if (retired.length) {
        const items = retired.map((r) => `${[...r.symbols, ...r.deps].join(", ")} (${r.decision})`).join("; ");
        text += `\n\n⚠ Deliberately RETIRED from this file — do not re-introduce without cause: ${items}.`;
      }
      emitContext("PreToolUse", text);
    } catch {
      // swallow — never block an edit on a hook failure
    } finally {
      store?.close();
    }
  });

// ---- review (curate loop) -------------------------------------------------
program
  .command("review")
  .description("Triage low-confidence drafts: list, accept (promote), or reject.")
  .option("--accept <id>", "promote a decision to accepted/human-confirmed")
  .option("--reject <id>", "delete a draft decision")
  .action((opts: { accept?: string; reject?: string }) => {
    const { store, root } = storeFor();
    if (opts.accept) {
      const d = store.json.get("decisions", opts.accept);
      if (!d) return fail(`decision ${opts.accept} not found`);
      const source = d.provenance.source.includes("llm_draft") ? "llm_draft+human_confirmed" : "human_confirmed";
      store.json.put("decisions", { ...d, status: "accepted", provenance: { ...d.provenance, source, confidence: 0.95, last_verified: new Date().toISOString() } });
      store.reindex();
      updateClaudeMd(root, store);
      console.log(`✓ accepted ${opts.accept} (now ${source}, confidence 0.95)`);
    } else if (opts.reject) {
      const ok2 = store.json.delete("decisions", opts.reject);
      store.reindex();
      console.log(ok2 ? `✓ rejected and removed ${opts.reject}` : `decision ${opts.reject} not found`);
    } else {
      const drafts = store.json.loadAll("decisions")
        .filter((d) => d.status === "proposed" || d.provenance.confidence < 0.6)
        .sort((a, b) => a.provenance.confidence - b.provenance.confidence);
      if (!drafts.length) {
        console.log("✓ No low-confidence drafts to review.");
      } else {
        console.log(`${drafts.length} draft(s) awaiting review (lowest confidence first):\n`);
        for (const d of drafts) {
          console.log(`  ${d.id} [${d.status}, ${d.provenance.source} ${d.provenance.confidence}]\n      ${d.title}\n      ${d.decision.slice(0, 120)}`);
        }
        console.log(`\nAccept:  hunch review --accept <id>\nReject:  hunch review --reject <id>`);
      }
    }
    store.close();
  });

// ---- mcp ------------------------------------------------------------------
program
  .command("mcp")
  .description("Start the MCP server over stdio (Claude Code connects here).")
  .action(async () => {
    const { startServer } = await import("../mcp/server.js");
    await startServer(process.cwd());
  });

// ---- migrate (schema versioning) ------------------------------------------
program
  .command("migrate")
  .description("Upgrade .hunch/ records to the current schema version and stamp the manifest.")
  .action(() => {
    const root = findRoot();
    const paths = hunchPaths(root);
    const store = new HunchStore(paths);
    openStore = store;
    const from = readManifest(paths).schema_version;
    if (from > SCHEMA_VERSION) {
      store.close();
      return fail(`.hunch/ is schema v${from}, newer than this hunch (v${SCHEMA_VERSION}). Upgrade hunch.`);
    }
    if (from === SCHEMA_VERSION) {
      writeManifest(paths, SCHEMA_VERSION); // record the version even if the manifest was absent
      console.log(`✓ Already at schema v${SCHEMA_VERSION} — nothing to migrate.`);
      store.close();
      return;
    }
    const res = store.json.persistMigration();
    writeManifest(paths, SCHEMA_VERSION);
    store.reindex();
    console.log(`✓ Migrated v${from} → v${SCHEMA_VERSION}: ${res.migrated} record(s) upgraded.`);
    if (res.skipped) {
      console.warn(`⚠ ${res.skipped} record(s) could NOT be migrated and will no longer load. They are preserved on disk in their old shape under .hunch/ for manual recovery.`);
    }
    store.close();
  });

// ---- compact (bound Hunch growth) -----------------------------------------
program
  .command("compact")
  .description("Prune low-value auto-captured records (rejected/superseded/stale drafts, resolved low-confidence bugs).")
  .option("--apply", "actually delete (default: dry-run preview)")
  .option("--max-age <days>", "minimum age in days for stale-draft pruning", "180")
  .option("--min-confidence <n>", "confidence below which a draft is prunable", "0.35")
  .action((opts: { apply?: boolean; maxAge: string; minConfidence: string }) => {
    const { store, root } = storeFor();
    const plan = planCompaction(
      { decisions: store.json.loadAll("decisions"), bugs: store.json.loadAll("bugs"), constraints: store.json.loadAll("constraints") },
      { now: Date.now(), maxAgeDays: Number(opts.maxAge), minConfidence: Number(opts.minConfidence) },
    );
    if (!plan.remove.length) {
      console.log(`✓ Nothing to compact (${plan.considered} record(s) considered; accepted/open/referenced records are always kept).`);
      store.close();
      return;
    }
    console.log(`${plan.remove.length} of ${plan.considered} record(s) ${opts.apply ? "removed" : "would be removed"}:\n`);
    for (const c of plan.remove) console.log(`  ${opts.apply ? "✗" : "·"} [${c.kind}] ${c.id}  ${c.title}\n      ${c.reason}`);
    if (opts.apply) {
      let removed = 0;
      for (const c of plan.remove) if (store.json.delete(c.kind, c.id)) removed++;
      store.reindex();
      updateClaudeMd(root, store);
      console.log(`\n✓ Removed ${removed} record(s).`);
    } else {
      console.log(`\nDry run — re-run with --apply to delete. Accepted/human-confirmed, open bugs, constraints, and referenced records are never removed.`);
    }
    store.close();
  });

// ---- merge-driver (internal; git invokes this) ----------------------------
program
  .command("merge-driver")
  .description("(internal) git merge driver for .hunch JSON — resolves concurrent edits by record id.")
  .argument("<base>", "%O — common ancestor")
  .argument("<ours>", "%A — current branch (also the OUTPUT file)")
  .argument("<theirs>", "%B — other branch")
  .argument("[path]", "%P — pathname being merged")
  .action((base: string, ours: string, theirs: string) => {
    const read = (p: string) => (existsSync(p) ? readFileSync(p, "utf8") : "");
    const res = mergeHunchJson(read(base), read(ours), read(theirs));
    if (!res.conflict) {
      writeFileSync(ours, res.text); // %A is the merge output git reads back
      return;
    }
    // Couldn't structurally merge (corrupt JSON / id-less / id divergence). Fall
    // back to git's own 3-way text merge so %A gets STANDARD conflict markers —
    // never silently leave `ours` and hide `theirs`. `git merge-file -p` prints the
    // marked result to stdout and exits non-zero when markers remain.
    const lf = (s: string) => s.replace(/\r\n/g, "\n"); // match the LF the structured path emits
    try {
      const merged = execFileSync("git", ["merge-file", "-p", "--diff3", "-L", "ours", "-L", "base", "-L", "theirs", ours, base, theirs], { encoding: "utf8", maxBuffer: 64 * 1024 * 1024 });
      writeFileSync(ours, lf(merged)); // clean text merge → resolved
    } catch (e) {
      const err = e as { stdout?: string | Buffer; status?: number };
      const out = typeof err.stdout === "string" ? err.stdout : err.stdout?.toString();
      if (out != null) writeFileSync(ours, lf(out)); // marked result; else leave ours
      process.exitCode = 1; // conflict markers remain → block the commit for review
    }
  });

// ---- doctor ---------------------------------------------------------------
program
  .command("doctor")
  .description("Diagnose the environment (git, synthesis provider, index freshness).")
  .action(async () => {
    const { store, root } = storeFor();
    console.log(`Hunch root: ${root}`);
    console.log(`git repo:   ${isGitRepo(root) ? "yes" : "no"}  ${isGitRepo(root) ? `(HEAD ${headSha(root).slice(0, 8)})` : ""}`);
    const onDisk = readManifest(hunchPaths(root)).schema_version;
    const schemaNote = onDisk === SCHEMA_VERSION ? "" : onDisk > SCHEMA_VERSION ? `  ⚠ newer than this Hunch (v${SCHEMA_VERSION}) — upgrade hunch` : `  ⚠ run \`hunch migrate\``;
    console.log(`schema:     v${onDisk} (hunch v${SCHEMA_VERSION})${schemaNote}`);
    const provider = await selectProvider();
    console.log(`synthesis:  ${provider.name}`);
    // Synthesis is billed to the user's SUBSCRIPTION via a coding-assistant CLI,
    // never a pay-per-token API key. Surface which one — or what's missing.
    const SUB: Record<string, { label: string; strip?: string }> = {
      "claude-cli": { label: "Claude subscription (claude CLI)", strip: "ANTHROPIC_API_KEY" },
      "codex-cli": { label: "ChatGPT subscription (codex CLI)", strip: "OPENAI_API_KEY" },
      "cursor-agent": { label: "Cursor subscription (cursor-agent CLI)" },
    };
    const sub = SUB[provider.name];
    if (sub) {
      const hadKey = sub.strip && !!process.env[sub.strip];
      console.log(`            ↳ LLM synthesis billed to your ${sub.label}` +
        (hadKey ? ` (${sub.strip} in env is stripped — never billed to the API)` : ``));
    } else {
      console.log(dim(`            ↳ no assistant CLI found — synthesis uses the offline heuristic (advisory, low-confidence)`));
      console.log(dim(`              for full synthesis install one: Claude Code (\`claude /login\`), Codex (\`codex login\`), or Cursor (\`cursor-agent login\`)`));
    }
    const c = store.reindex().counts;
    console.log(`hunch:      ${c.symbols} symbols, ${c.edges} edges, ${c.components} components, ${c.decisions} decisions, ${c.bugs} bugs, ${c.constraints} constraints`);
    // Semantic search is opt-in and local. Report availability + coverage without
    // loading the model (selectEmbedder only probes; embeddingStats just counts rows).
    const emb = await selectEmbedder();
    if (emb) {
      const cov = store.embeddingStats(emb.id);
      const hint = cov.embedded === 0 ? "  ⚠ run `hunch embed`" : cov.embedded < cov.total ? "  ⚠ stale — re-run `hunch embed`" : "";
      console.log(`semantic:   ${emb.id} — ${cov.embedded}/${cov.total} docs embedded${hint}`);
    } else {
      console.log(dim(`semantic:   off (keyword search only) — enable: npm i -g @huggingface/transformers && hunch embed`));
    }
    // Windows: detect/heal the Claude Code ~/.claude.json drive-letter case-split
    // that silently hides the hunch_* MCP tools. No-op (silent) off Windows.
    reportClaudeConfigHeal();
    store.close();
  });

function rel(root: string, p: string): string {
  return p.startsWith(root) ? p.slice(root.length + 1) : p;
}

/** Run the Windows ~/.claude.json drive-letter case-split heal and print what it
 *  did. Silent + no-op off Windows. A parse refusal is surfaced as a warning, never
 *  thrown out of doctor/init (those commands must still complete). */
function reportClaudeConfigHeal(): void {
  let res;
  try {
    res = healClaudeConfigCaseSplit();
  } catch (e) {
    console.log(`  ⚠ Claude config: ${(e as Error).message}`);
    return;
  }
  if (!res.applicable) return; // non-Windows: the case-split bug can't occur
  if (!res.changed) {
    console.log(dim(`Claude config: no drive-letter project split (${res.file})`));
    return;
  }
  for (const g of res.groups) {
    console.log(`✓ healed Claude Code project case-split: mirrored [${g.servers.join(", ")}] across ${g.casings.join("  ·  ")}`);
  }
  console.log(dim(`  ↳ backup: ${res.backup}`));
}
function dim(s: string): string {
  return `\x1b[2m${s}\x1b[0m`;
}
function fail(msg: string): void {
  console.error(`error: ${msg}`);
  process.exitCode = 1;
}

// --- agent-hook helpers (used by `hunch hook`) -----------------------------

const HOOK_REMINDER =
  "Hunch (engineering memory) is available for this repo. Before editing, call " +
  "hunch_check_constraints(scope) for do-not-break invariants and hunch_why(target) " +
  "for the rationale; use hunch_get_dependents for blast radius and hunch_bug_lineage " +
  "for prior root causes. After a non-trivial choice, record it with hunch_record_decision.";

/** Read all of stdin (the hook event JSON). A TTY (no piped input) resolves to ""
 *  so an accidental interactive `hunch hook` exits cleanly instead of hanging. */
function readStdin(): Promise<string> {
  return new Promise((resolve) => {
    if (process.stdin.isTTY) return resolve("");
    let data = "";
    process.stdin.setEncoding("utf8");
    process.stdin.on("data", (c) => (data += c));
    process.stdin.on("end", () => resolve(data));
    process.stdin.on("error", () => resolve(data));
  });
}

/** Absolute edit path → repo-relative, forward-slash (constraint scopes are
 *  forward-slash globs even on Windows). */
function toRepoRel(root: string, abs: string): string {
  return relative(root, abs).split("\\").join("/");
}

function emitContext(event: "PreToolUse" | "UserPromptSubmit", text: string): void {
  process.stdout.write(JSON.stringify({ hookSpecificOutput: { hookEventName: event, additionalContext: text } }));
}
function emitDeny(reason: string): void {
  process.stdout.write(
    JSON.stringify({
      hookSpecificOutput: { hookEventName: "PreToolUse", permissionDecision: "deny", permissionDecisionReason: reason },
    }),
  );
}

program.parseAsync().catch((e) => {
  try {
    openStore?.close();
  } catch {
    /* ignore */
  }
  console.error(`hunch: ${e instanceof Error ? e.message : String(e)}`);
  process.exit(1);
});
