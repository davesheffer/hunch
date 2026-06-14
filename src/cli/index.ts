#!/usr/bin/env node
/**
 * `brain` CLI (DESIGN.md §6). Subcommands:
 *   init      scaffold .brain/, install hook, write .mcp.json + CLAUDE.md + slash cmds
 *   index     parse repo -> symbol/dependency graph + components (no LLM)
 *   backfill  replay git history -> seed decisions (cold-start fix)
 *   sync      commit diff -> Claude/heuristic -> decision write-back (post-commit hook)
 *   query     FTS + graph query over the Brain
 *   why       decisions/bugs/constraints explaining a file/symbol
 *   fragile   ranked fragility report with evidence
 *   record-bug  capture a Bug from a (failing) test
 *   mcp       start the MCP server (Claude Code connects here)
 *   doctor    environment diagnostics
 */
import { Command } from "commander";
import { brainPaths, findRoot } from "../core/paths.js";
import { BrainStore } from "../store/brainStore.js";
import { indexRepo } from "../extractors/indexer.js";
import { syncCommit, recordFailure } from "../synthesis/synthesize.js";
import { selectProvider } from "../synthesis/provider.js";
import { isGitRepo, headSha, logSince } from "../extractors/git.js";
import { installPostCommitHook } from "../integrations/hooks.js";
import { updateClaudeMd } from "../integrations/claudemd.js";
import { writeMcpJson, writeSlashCommands } from "../integrations/scaffold.js";
import { resolveInvocation } from "./invocation.js";

const program = new Command();
program.name("brain").description("Engineering Memory OS — a git-native reasoning graph for your codebase.").version("0.1.0");

let openStore: BrainStore | null = null;
function storeFor(): { store: BrainStore; root: string } {
  const root = findRoot();
  const store = new BrainStore(brainPaths(root));
  openStore = store;
  return { store, root };
}

// ---- init -----------------------------------------------------------------
program
  .command("init")
  .description("Scaffold .brain/, index the repo, install the git hook, and wire up Claude Code.")
  .option("--no-index", "skip the initial repo index")
  .action((opts: { index: boolean }) => {
    const root = findRoot();
    const store = new BrainStore(brainPaths(root));
    openStore = store; // so the top-level error handler closes it on failure
    const inv = resolveInvocation();
    console.log(`🧠 Initializing Project Brain at ${root}`);

    store.json.ensureDirs();
    console.log("  ✓ .brain/ scaffolded");

    if (opts.index !== false) {
      const res = indexRepo(store, root);
      store.reindex();
      console.log(`  ✓ indexed ${res.files} files → ${res.symbols} symbols, ${res.edges} edges, ${res.components} components`);
      if (res.skipped) console.log(`  ⚠ ${res.skipped} file(s) could not be parsed (skipped)`);
    }

    if (isGitRepo(root)) {
      const h = installPostCommitHook(root, inv.shell);
      console.log(`  ✓ post-commit hook ${h.action} (${h.path})`);
    } else {
      console.log("  ⚠ not a git repo — skipped hook (run `git init` to enable the learning loop)");
    }

    const mcp = writeMcpJson(root, inv.mcp);
    console.log(`  ✓ wrote ${rel(root, mcp)} (registers the brain MCP server)`);
    const cmds = writeSlashCommands(root);
    console.log(`  ✓ wrote ${cmds.length} slash commands (/brain-why, /brain-fix, /brain-fragile)`);
    const cmd = updateClaudeMd(root, store);
    console.log(`  ✓ updated ${rel(root, cmd)} with ambient Brain context`);

    store.close();
    console.log("\nNext: make a commit (the hook captures a decision), then ask Claude Code \"why is X built this way?\"");
    console.log("Cold start? Seed from history:  brain backfill --since 90d");
  });

// ---- index ----------------------------------------------------------------
program
  .command("index")
  .description("Parse the repo into a symbol/dependency graph + components (deterministic, no LLM).")
  .action(() => {
    const { store, root } = storeFor();
    store.json.ensureDirs();
    const res = indexRepo(store, root);
    const { counts } = store.reindex();
    updateClaudeMd(root, store);
    console.log(`Indexed ${res.files} files:`);
    console.log(`  ${counts.symbols} symbols, ${counts.edges} edges, ${counts.components} components`);
    if (res.skipped) console.log(`  ⚠ ${res.skipped} file(s) could not be parsed (skipped)`);
    store.close();
  });

// ---- backfill -------------------------------------------------------------
program
  .command("backfill")
  .description("Replay git history to seed decisions (cold-start fix).")
  .option("--since <spec>", "how far back, e.g. 90d", "90d")
  .option("--max <n>", "max commits to process", "40")
  .action(async (opts: { since: string; max: string }) => {
    const { store, root } = storeFor();
    if (!isGitRepo(root)) return fail("backfill needs a git repo");
    store.json.ensureDirs();
    const commits = logSince(opts.since, root, Number(opts.max));
    console.log(`Backfilling from ${commits.length} commit(s) since ${opts.since}…`);
    let written = 0, skipped = 0;
    for (const sha of commits) {
      const r = await syncCommit(store, root, sha);
      if (r.status === "written") {
        written++;
        process.stdout.write(`  ✓ ${sha.slice(0, 8)} ${r.decision?.title.slice(0, 64) ?? ""}\n`);
      } else skipped++;
    }
    store.reindex();
    updateClaudeMd(root, store);
    console.log(`Done: ${written} decisions seeded, ${skipped} skipped (trivial/non-code). Provider: ${(await selectProvider()).name}`);
    store.close();
  });

// ---- sync (post-commit hook) ----------------------------------------------
program
  .command("sync")
  .description("Capture a decision from a commit (run by the post-commit hook).")
  .argument("[sha]", "commit to sync (default: HEAD)")
  .option("--from-hook", "invoked by the git hook")
  .option("--quiet", "minimal output")
  .action(async (sha: string | undefined, opts: { fromHook?: boolean; quiet?: boolean }) => {
    const { store, root } = storeFor();
    if (!isGitRepo(root)) return opts.quiet ? undefined : fail("sync needs a git repo");
    store.json.ensureDirs();
    const r = await syncCommit(store, root, sha ?? headSha(root));
    if (r.status === "written") {
      store.reindex();
      // Don't rewrite CLAUDE.md from the hook — it would dirty the working tree
      // on every commit. `brain index`/`init` refresh it intentionally instead.
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
  .description("Full-text + graph search over the Brain.")
  .argument("<question...>", "what to search for")
  .action((parts: string[]) => {
    const { store } = storeFor();
    const q = parts.join(" ");
    const hits = store.search(q, 12);
    if (!hits.length) {
      console.log(`No matches for "${q}".`);
    } else {
      console.log(`Top matches for "${q}":\n`);
      for (const h of hits) console.log(`• [${h.kind}] ${h.ref} — ${h.title}\n    ${h.snippet}`);
    }
    store.close();
  });

// ---- why ------------------------------------------------------------------
program
  .command("why")
  .description("Explain why a file/symbol is the way it is (decisions, bugs, constraints).")
  .argument("<target>", "file path or symbol name")
  .action((target: string) => {
    const { store } = storeFor();
    const w = store.why(target);
    console.log(`Why "${target}":\n`);
    if (w.decisions.length) {
      console.log("DECISIONS:");
      for (const d of w.decisions) console.log(`  • ${d.id} [${d.status}] ${d.title}\n      ${d.decision} ⟨${d.provenance.source}, ${d.provenance.confidence}⟩`);
    }
    if (w.constraints.length) {
      console.log("CONSTRAINTS (must not break):");
      for (const c of w.constraints) console.log(`  • ${c.id} [${c.severity}] ${c.statement}`);
    }
    if (w.bugs.length) {
      console.log("BUG HISTORY:");
      for (const b of w.bugs) console.log(`  • ${b.id} [${b.status}] ${b.title} — ${b.root_cause}`);
    }
    if (!w.decisions.length && !w.constraints.length && !w.bugs.length) {
      console.log("(No recorded decisions/bugs/constraints yet. Try `brain backfill` or make a commit.)");
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

// ---- mcp ------------------------------------------------------------------
program
  .command("mcp")
  .description("Start the MCP server over stdio (Claude Code connects here).")
  .action(async () => {
    const { startServer } = await import("../mcp/server.js");
    await startServer(process.cwd());
  });

// ---- doctor ---------------------------------------------------------------
program
  .command("doctor")
  .description("Diagnose the environment (git, synthesis provider, index freshness).")
  .action(async () => {
    const { store, root } = storeFor();
    console.log(`Brain root: ${root}`);
    console.log(`git repo:   ${isGitRepo(root) ? "yes" : "no"}  ${isGitRepo(root) ? `(HEAD ${headSha(root).slice(0, 8)})` : ""}`);
    console.log(`synthesis:  ${(await selectProvider()).name}`);
    const c = store.reindex().counts;
    console.log(`brain:      ${c.symbols} symbols, ${c.edges} edges, ${c.components} components, ${c.decisions} decisions, ${c.bugs} bugs, ${c.constraints} constraints`);
    store.close();
  });

function rel(root: string, p: string): string {
  return p.startsWith(root) ? p.slice(root.length + 1) : p;
}
function dim(s: string): string {
  return `\x1b[2m${s}\x1b[0m`;
}
function fail(msg: string): void {
  console.error(`error: ${msg}`);
  process.exitCode = 1;
}

program.parseAsync().catch((e) => {
  try {
    openStore?.close();
  } catch {
    /* ignore */
  }
  console.error(`brain: ${e instanceof Error ? e.message : String(e)}`);
  process.exit(1);
});
