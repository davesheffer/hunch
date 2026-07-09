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
import "./preflight.js"; // MUST stay the first import — Node-version gate before node:sqlite loads
import { existsSync, readFileSync, writeFileSync, mkdirSync, realpathSync } from "node:fs";
import { execFileSync, spawnSync } from "node:child_process";
import { join, relative, dirname, basename, resolve, isAbsolute } from "node:path";
import { fileURLToPath } from "node:url";
import { Command } from "commander";
import { hunchPaths, hunchPathsForDir, findRoot, toPosixTarget } from "../core/paths.js";
import { writeFileAtomic } from "../core/io.js";
import { looksLikeCorrection, CORRECTION_NUDGE } from "../core/correction.js";
import { HUNCH_VERSION } from "../core/version.js";
import { HunchStore } from "../store/hunchStore.js";
import { JsonStore } from "../store/jsonStore.js";
import { selectEmbedder } from "../store/embedder.js";
import { indexRepo } from "../extractors/indexer.js";
import { syncCommit, recordFailure, captureTestRun } from "../synthesis/synthesize.js";
import { parseTestReport } from "../extractors/testreport.js";
import { selectProvider } from "../synthesis/provider.js";
import { isGitRepo, headSha, logSince, lastChangeDate, stagedFiles, commitFiles, asOfDate, stagedDiff, commitDiff, rangeFiles, rangeDiff, rangeSubjects, revExists, commitAndPushHunch, pullHunch, gitUntrackCached, gitCommonDir, isLinkedWorktree, mainWorktreeRoot } from "../extractors/git.js";
import { writeTeamConfig, ensureTeamOverlay, readTeamConfig } from "../integrations/team.js";
import { runbookId, decisionId } from "../core/ids.js";
import { deriveForbids, effectiveForbids } from "../core/constraintmatch.js";
import type { Runbook } from "../core/types.js";
import { extractInlineIntent } from "../extractors/comments.js";
import { renderText, renderMarkdown, renderImpact, reportFailsStrict, type CheckReport } from "../core/checkreport.js";
import { partitionReview, READY_MIN_GROUNDED, type ReviewItem } from "../core/reviewqueue.js";
import { installPostCommitHook, installPreCommitHook } from "../integrations/hooks.js";
import { ensureSharedOverlayPointer } from "../integrations/worktree.js";
import { flushCapture } from "../integrations/sync.js";
import { installMergeDriver } from "../integrations/mergeDriver.js";
import { ensureGitignore, ignoreHunchMemory, HUNCH_MEMORY_DIRS } from "../integrations/gitignore.js";
import { writeCiWorkflow } from "../integrations/ciAction.js";
import { updateClaudeMd } from "../integrations/claudemd.js";
import { writeMcpJson, writeSlashCommands, installClaudeHooks } from "../integrations/scaffold.js";
import { scaffoldProviders, regenerateGrounding, refreshExistingGrounding } from "../integrations/providers.js";
import { healClaudeConfigCaseSplit } from "../integrations/claudeConfig.js";
import { formatContext, formatStructure } from "../core/format.js";
import { readConfig, writeConfig, FIRMNESS_LEVELS, isFirmness, type Firmness } from "../core/config.js";
import { blockingInScope, vetoInScope, proposedEditLines } from "../core/hookpolicy.js";
import { injectionMode } from "../core/hookcache.js";
import {
  PIPELINE_LOOP,
  UNVERIFIED_NAG,
  loadPipelineState,
  onCommand,
  onEdit,
  onPrompt,
  onSkill,
  pipelineEnabled,
  savePipelineState,
  stopVerdict,
} from "../core/pipeline.js";
import { draftDuplicateOf } from "../core/dupdetect.js";
import { planAutoReview, planMutations, type AutoReviewPlan, type AutoReviewEntry } from "../core/autoreview.js";
import type { RelevanceVerdict, ExistingDecisionRef } from "../synthesis/provider.js";
import { loadGoldenSet, evaluateGraphLift } from "../eval/harness.js";
import { loadGuardCases, evalGuards, generateGuardCases } from "../eval/guards.js";
import { computeDrift } from "../core/drift.js";
import { generateWiki, wikiStatus, wikiPrompt, publicHome, privateHome, readWikiManifestAt, nowData, type WikiPack } from "../wiki/wiki.js";
import { adoptProsePrompt } from "../wiki/adopt.js";
import { topicCollisions, renderGrounding } from "../core/topics.js";
import { parseDocAnchors, renderDocGrounding } from "../core/docanchors.js";
import { compareCandidates } from "../core/compare.js";
import { checkConformance } from "../core/conformance.js";
import { draftTripwires, knownRepoDeps } from "../synthesis/tripwires.js";
import { constraintId } from "../core/ids.js";
import type { Constraint, Decision } from "../core/types.js";
import { readManifest, writeManifest, SCHEMA_VERSION } from "../core/migrate.js";
import { mergeHunchJson } from "../store/merge.js";
import { movePublicMemoryToPrivate } from "../store/privateMigrate.js";
import { ENTITY_KINDS } from "../core/types.js";
import { planCompaction } from "../store/compact.js";
import { resolveInvocation } from "./invocation.js";

const program = new Command();
program.name("hunch").description("Hunch — an Engineering Memory OS: a git-native reasoning graph for your codebase.").version(HUNCH_VERSION);

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
  .option("--private-sync", "post-commit synthesis writes captured decisions into the overlay repo (HUNCH_PRIVATE_DIR), never the public store")
  .option("--shared-sync", "alias of --private-sync (for teams using one shared overlay repo for any code repo)")
  .option("--no-auto-commit", "DON'T auto-commit captures (default: ON in every mode — the overlay repo is committed+pushed; the public .hunch/ is committed only and rides your next push)")
  .action((opts: { index: boolean; enforce: boolean; enforceStrict?: boolean; providers: boolean; agentHooks: boolean; firmness?: string; privateSync?: boolean; sharedSync?: boolean; autoCommit: boolean }) => {
    // Validate --firmness up front, before any side effects (indexing, git hooks,
    // .mcp.json) or opening the store — a bad value must not leave a half-init.
    if (opts.firmness !== undefined && !isFirmness(opts.firmness)) {
      return fail(`--firmness must be one of: ${FIRMNESS_LEVELS.join(", ")}`);
    }
    const root = findRoot();
    const paths = hunchPaths(root);
    // Team auto-discovery FIRST: a committed .hunch/team.json advertises the shared
    // store — a fresh clone wires itself to it before anything reads memory, so every
    // teammate/agent resolves the same single source of truth with zero manual setup.
    const teamWired = ensureTeamOverlay(root);
    const store = new HunchStore(paths);
    openStore = store; // so the top-level error handler closes it on failure
    const inv = resolveInvocation();
    console.log(`🧠 Initializing Hunch at ${root}`);

    store.json.ensureDirs(); // stamps the manifest at the current version when fresh
    console.log(`  ✓ .hunch/ scaffolded (schema v${readManifest(paths).schema_version})`);
    if (teamWired) console.log(`  ✓ connected to the team's shared memory store (from .hunch/team.json) → ${teamWired}`);

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

    // Auto-commit is ON by default in every mode; --no-auto-commit persists the opt-out in
    // the gitignored local.json (merge — never clobber an existing overlay pointer).
    if (opts.autoCommit === false) {
      const localFile = join(paths.hunch, "local.json");
      let existing: Record<string, unknown> = {};
      try { existing = JSON.parse(readFileSync(localFile, "utf8")) as Record<string, unknown>; } catch { /* absent/invalid → fresh */ }
      writeFileAtomic(localFile, JSON.stringify({ ...existing, autoCommit: false }, null, 2) + "\n");
      console.log("  ✓ auto-commit OFF (captures stay uncommitted; commit .hunch/ yourself)");
    }

    if (isGitRepo(root)) {
      const syncToOverlay = !!(opts.privateSync || opts.sharedSync);
      const h = installPostCommitHook(root, inv.shell, { private: syncToOverlay, commit: opts.autoCommit });
      console.log(`  ✓ post-commit hook ${h.action} (learning loop)${syncToOverlay ? " — syncs to the shared overlay" : ""}${opts.autoCommit ? " — auto-commit on" : ""}`);
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

    // .mcp.json is the CANONICAL registration: Claude Code resolves it by file path,
    // so it's immune to the Windows ~/.claude.json drive-letter case-split that a
    // global `claude mcp add` is prone to (see `hunch doctor`). An unparseable
    // existing file is refused (con_8460b6770f) — warn and continue, never clobber.
    try {
      const mcp = writeMcpJson(root, inv.mcp);
      console.log(`  ✓ wrote ${rel(root, mcp)} (registers the Hunch MCP server — canonical, path-keyed; prefer over a global \`claude mcp add\`)`);
    } catch (e) {
      console.log(`  ⚠ skipped .mcp.json: ${(e as Error).message}`);
    }
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

    // Worktree-seamless: register any configured overlay at the git common dir so EVERY
    // worktree of this repo auto-discovers it (also backfills pre-0.32 single-worktree setups),
    // and note when we're initializing inside a linked worktree (memory is shared, not separate).
    if (ensureSharedOverlayPointer(root, store.privateDir, store.privateAutoCommit, store.mode === "shared" ? "shared" : "private")) {
      console.log(`  ✓ private overlay registered at the git common dir — shared by every worktree of this repo`);
    }
    if (isLinkedWorktree(root)) {
      console.log(`  ✓ linked worktree — sharing the repo's hooks + memory (no separate setup needed)`);
    }

    store.close();
    console.log("\nNext: make a commit (the hook captures a decision), then ask your coding assistant \"why is X built this way?\"");
    console.log("Cold start? Seed from history:  hunch backfill --since 90d");
    console.log("\n⭐ If Hunch earns its keep, a star helps others find it → https://github.com/davesheffer/hunch");
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
    // Self-heal grounding: pick up generator fixes (param names) + fresh counts in every
    // assistant doc the project already has — no manual re-init. Refresh-only (no scaffold).
    const healed = refreshExistingGrounding(root, store);
    console.log(`Indexed ${res.files} files:`);
    console.log(`  ${counts.symbols} symbols, ${counts.edges} edges, ${counts.components} components`);
    if (healed.length) console.log(`  grounding refreshed: ${healed.join(", ")}`);
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

/** Parse a `--samples` flag into a finite positive count, or undefined so the ensemble
 *  uses its default depth. A typo'd value (`--samples abc`) must NOT become NaN — that
 *  would silently collapse --deep to the deterministic fallback. */
function parseSamples(v: string | undefined): number | undefined {
  const n = Number(v);
  return v != null && Number.isFinite(n) && n > 0 ? Math.trunc(n) : undefined;
}

program
  .command("backfill")
  .description("Replay git history to seed decisions (cold-start fix).")
  .option("--since <spec>", "how far back, e.g. 90d", "90d")
  .option("--max <n>", "max commits to process", "40")
  .option("--concurrency <n>", "commits to synthesize in parallel (the LLM call is the bottleneck)", "4")
  .option("--deep", "Deep Synthesis: ensemble every available subscription CLI per commit and reconcile their drafts (slower, higher-quality; advisory)")
  .option("--verify", "Critic pass: audit each draft against its commit, prune unsupported alternatives/consequences, down-weight weak grounding (extra subscription call; advisory)")
  .option("--samples <n>", "self-consistency depth when only one CLI is installed: sample it n times per commit and reconcile (default 2 under --deep)")
  .action(async (opts: { since: string; max: string; concurrency: string; deep?: boolean; verify?: boolean; samples?: string }) => {
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
    const samples = parseSamples(opts.samples);
    await mapPool(commits, conc, async (sha) => {
      const r = await syncCommit(store, root, sha, { deep: opts.deep, verify: opts.verify, samples });
      if (r.status === "written") {
        written++;
        // Any non-deterministic provider (claude/codex/cursor/ensemble) is an LLM draft.
        if (r.provider && r.provider !== "deterministic") llm++; else heuristic++;
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
  .option("--private", "write the synthesized decision into the configured overlay (HUNCH_PRIVATE_DIR), not the public store")
  .option("--overlay", "alias of --private")
  .option("--commit", "after a capture, also git add+commit the repo the decision landed in (default: follows auto-commit, ON unless opted out) — the overlay is also pushed; the public .hunch/ rides your next push")
  .option("--no-commit", "skip the auto-commit for this capture even when auto-commit is on")
  .option("--deep", "Deep Synthesis: ensemble every available subscription CLI and reconcile their drafts (agreement-weighted, advisory). Slower; subscription-only")
  .option("--verify", "Critic pass: audit the draft against its commit, prune unsupported alternatives/consequences, down-weight weak grounding (extra subscription call; advisory)")
  .option("--samples <n>", "self-consistency depth when only one CLI is installed: sample it n times and reconcile (default 2 under --deep)")
  .action(async (sha: string | undefined, opts: { fromHook?: boolean; quiet?: boolean; force?: boolean; private?: boolean; overlay?: boolean; commit?: boolean; deep?: boolean; verify?: boolean; samples?: string }) => {
    const { store, root } = storeFor();
    if (!isGitRepo(root)) return opts.quiet ? undefined : fail("sync needs a git repo");
    // In unified ("shared") mode every capture routes to the overlay — the sync path
    // must agree with captureHome so all writers home records identically.
    const toOverlay = !!(opts.private || opts.overlay || store.unified);
    if (toOverlay && !store.hasPrivate) { store.close(); return opts.quiet ? undefined : fail("--private/--overlay needs HUNCH_PRIVATE_DIR set to an overlay store"); }
    store.json.ensureDirs();
    const r = await syncCommit(store, root, sha ?? headSha(root), { force: opts.force, private: toOverlay, deep: opts.deep, verify: opts.verify, samples: parseSamples(opts.samples) });
    if (r.status === "written") {
      store.reindex();
      // Don't rewrite grounding from the hook — it would dirty the working tree on
      // every commit. Off the hook (manual `hunch sync`), self-heal ALL existing
      // grounding docs (param-name fixes + fresh counts), not just CLAUDE.md.
      if (!opts.fromHook) {
        const healed = refreshExistingGrounding(root, store);
        if (healed.length && !opts.quiet) console.log(`  ↳ grounding refreshed: ${healed.join(", ")}`);
      }
      // Persist the captured decision in the repo it landed in (private store under
      // --private, else this repo). ON by default (follows auto-commit; --no-commit or
      // `--no-auto-commit` at setup opts out). Best-effort — a non-repo dir / offline push
      // just no-ops. Stage ONLY the hunch dir (never sweep unrelated working-tree
      // changes), and set HUNCH_SYNC=1 so the commit we create can't re-trigger this
      // hook (no recursion). The overlay is pushed; the public .hunch/ is committed
      // WITHOUT pushing — auto-pushing the user's code branch would publish their
      // unpushed commits (bug_overlay_clobber lineage).
      const doCommit = opts.commit ?? store.autoCommit;
      const commitTarget = doCommit ? (toOverlay ? store.privateDir : hunchPaths(root).hunch) : undefined;
      if (commitTarget) {
        commitAndPushHunch(commitTarget, `hunch: capture ${r.decision?.id ?? "decision"}`, { push: toOverlay });
        if (!opts.quiet) console.log(`  ↳ committed ${toOverlay ? "+ pushed " : ""}${r.decision?.id} (${commitTarget}${toOverlay ? "" : " — rides your next push"})`);
      }
      if (!opts.quiet) console.log(`✓ captured decision ${r.decision?.id} via ${r.provider}: "${r.decision?.title}"`);
    } else if (!opts.quiet) {
      console.log(`· skipped: ${r.reason}`);
    }
    store.close();
  });

// ---- private (one-command setup for the private memory overlay) ------------
type OverlaySetupOpts = { repo?: string; hook: boolean; autoCommit?: boolean; sync?: boolean; migrate?: boolean };

function configureOverlay(dir: string | undefined, opts: OverlaySetupOpts, mode: "private" | "shared"): void {
  const root = findRoot();
  const paths = hunchPaths(root);
  const commandName = mode === "private" ? "private" : "shared";

  if (opts.sync) {
    const s = new HunchStore(hunchPaths(root));
    const target = s.privateDir;
    s.close();
    if (!target) return fail(`no overlay configured — run \`hunch ${commandName}\` first`);
    commitAndPushHunch(target, "hunch: sync overlay memory");
    console.log(`✓ flushed overlay store → ${target}`);
    return;
  }

  // 1) resolve the overlay store's hunch dir (holds decisions/, bugs/, …)
  let hunchDir: string;
  // Anchor the default store at the MAIN worktree root: a linked worktree can be
  // `git worktree remove`d, which would take the store (and every other worktree's
  // absolute pointer to it) down with it. An explicit [dir] still resolves from here.
  const anchor = mainWorktreeRoot(root);
  if (opts.repo) {
    const dest = join(anchor, ".hunch-private");
    if (!existsSync(dest)) {
      const r = spawnSync("git", ["clone", opts.repo, dest], { stdio: "inherit" });
      if (r.status !== 0) return fail(`git clone failed for ${opts.repo}`);
    } else {
      // NEVER silently ignore --repo when the store dir already exists: same remote →
      // freshen; no remote → attach + converge; different remote → refuse loudly.
      const cur = spawnSync("git", ["-C", dest, "remote", "get-url", "origin"], { encoding: "utf8" });
      const existingUrl = cur.status === 0 ? cur.stdout.trim() : "";
      if (existingUrl === opts.repo) {
        pullHunch(join(dest, ".hunch"));
        console.log(`  · ${dest} already tracks ${opts.repo} — pulled the latest memory`);
      } else if (!existingUrl) {
        if (!isGitRepo(dest)) spawnSync("git", ["init", "-q", dest], { stdio: "ignore" });
        spawnSync("git", ["-C", dest, "remote", "add", "origin", opts.repo], { stdio: "ignore" });
        spawnSync("git", ["-C", dest, "fetch", "-q", "origin"], { stdio: "ignore" });
        spawnSync("git", ["-C", dest, "merge", "-q", "--no-edit", "--allow-unrelated-histories", "FETCH_HEAD"], { stdio: "ignore" });
        spawnSync("git", ["-C", dest, "push", "-q", "-u", "origin", "HEAD"], { stdio: "ignore" });
        console.log(`  · attached the existing local store ${dest} to ${opts.repo} (merged + pushed, best-effort)`);
      } else {
        return fail(
          `${dest} already tracks a DIFFERENT remote:\n    current: ${existingUrl}\n    requested: ${opts.repo}\n` +
          `Refusing to silently re-point your memory. Move that directory aside, or pass an explicit dir: \`hunch ${commandName} <dir> --repo <url>\`.`,
        );
      }
    }
    hunchDir = join(dest, ".hunch");
  } else {
    hunchDir = dir ? resolve(root, dir) : join(anchor, ".hunch-private", ".hunch");
  }

  // 2) create the layout (decisions/, manifest, …) so it's queryable immediately
  new JsonStore(hunchPathsForDir(hunchDir)).ensureDirs();
  const inv = resolveInvocation();
  // Install the structured merge driver IN the overlay repo so concurrent captures from
  // multiple machines/worktrees merge by RECORD ID (no manual conflict resolution) when the
  // two-way auto-sync pulls before pushing. The overlay repo root is the parent of its .hunch.
  const overlayRoot = hunchPathsForDir(hunchDir).root;
  // CRITICAL (bug_overlay_clobber): with --auto-commit, the overlay MUST be its own git repo.
  // Otherwise the post-commit auto-commit (commitAndPushHunch) runs `git -C overlayDir …` which
  // walks UP to the PROJECT repo and can commit memory over your code. Initialize a standalone
  // repo when one isn't there (a local repo with no remote just accumulates commits — safe).
  if (opts.autoCommit && !isGitRepo(overlayRoot)) {
    spawnSync("git", ["init", "-q", overlayRoot], { stdio: "ignore" });
  }
  if (isGitRepo(overlayRoot)) installMergeDriver(overlayRoot, inv.shell);

  // 3) record the path in a GITIGNORED local config — auto-detected, no env var, and
  //    the MCP server picks it up too. Atomic write (con_902759b3dc) since it's under .hunch/.
  mkdirSync(paths.hunch, { recursive: true }); // tolerate a repo where `hunch init` hasn't run yet
  // Store a repo-relative POSIX path when the store lives INSIDE the repo (portable +
  // OS-clean — survives a repo move, resolves the same on any OS); an absolute path for
  // a store elsewhere on disk. Resolution (env || local.json) re-resolves against root.
  const rel = relative(root, hunchDir);
  const stored = rel && !rel.startsWith("..") && !isAbsolute(rel) ? toPosixTarget(rel) : hunchDir;
  writeFileAtomic(join(paths.hunch, "local.json"), JSON.stringify({ privateDir: stored, autoCommit: !!opts.autoCommit, mode }, null, 2) + "\n");
  ensureGitignore(root); // keeps .hunch/local.json + .hunch-private/ out of git

  // SHARED mode with a remote: publish the store's URL in a COMMITTED team.json, so a
  // fresh clone / new teammate / headless agent auto-connects on `hunch init` (or MCP
  // server start) — everyone resolves the same single source of truth. Private mode
  // never publishes its URL.
  let teamNote = "";
  if (mode === "shared" && opts.repo) {
    writeTeamConfig(root, { shared_repo: opts.repo });
    teamNote = "  ✓ published .hunch/team.json (commit it) — teammates, worktrees, and agents auto-connect\n";
  }

  // Also register the overlay at the SHARED git common dir, so EVERY worktree of this repo
  // (current + future, any branch) auto-discovers the same memory with zero per-worktree
  // setup. Stored ABSOLUTE — a linked worktree resolves relative paths from its OWN root, so
  // only an absolute path survives the move. Lives under .git/ (never tracked; nothing to ignore).
  let worktreeNote = "";
  if (ensureSharedOverlayPointer(root, hunchDir, !!opts.autoCommit, mode)) {
    worktreeNote = "  ✓ registered in the git common dir — shared by every worktree of this repo, on any branch\n";
  }

  // 4) route post-commit synthesis to the overlay (local hook, never committed)
  let hookNote = "";
  if (opts.hook && isGitRepo(root)) {
    const h = installPostCommitHook(root, inv.shell, { private: true, commit: opts.autoCommit });
    hookNote = `  ✓ post-commit hook ${h.action} — captured decisions route here${opts.autoCommit ? " (auto-commit+push on)" : ""}\n`;
  }

  // 5) one-time migration: MOVE existing public memory INTO the overlay, then make
  //    THIS repo code-only. Records are absorbed (union by id) BEFORE the public
  //    store is emptied, so an interrupted run never loses memory.
  let migrateNote = "";
  if (opts.migrate) {
    const pub = new JsonStore(paths);
    const priv = new JsonStore(hunchPathsForDir(hunchDir));
    const res = movePublicMemoryToPrivate(pub, priv);
    for (const kind of ENTITY_KINDS) pub.dropAll(kind); // public store now empty on disk
    if (isGitRepo(root)) gitUntrackCached(root, HUNCH_MEMORY_DIRS); // stop publishing it
    ignoreHunchMemory(root);
    const gstore = new HunchStore(paths); // public store is empty → grounding shows no memory
    const grounding = regenerateGrounding(root, gstore);
    gstore.close();
    commitAndPushHunch(hunchDir, "hunch: absorb public memory into private overlay"); // durable
    const breakdown = Object.entries(res.moved).map(([k, n]) => `${n} ${k}`).join(", ") || "0 records";
    migrateNote =
      `  ✓ migrated public memory → overlay (${breakdown}); public store emptied\n` +
      `  ✓ untracked + gitignored the .hunch memory tree — this repo is now CODE-ONLY\n` +
      `  ✓ regenerated ${grounding.length} grounding file(s) (CLAUDE.md, AGENTS.md, …) — no public memory shown\n` +
      `  ✓ committed + pushed the private overlay (best-effort)\n` +
      `  next: review, then commit the PUBLIC repo:\n` +
      `      git add -A && git commit -m "chore: move engineering memory to a private overlay" && git push\n`;
  }

  const lead = mode === "private"
    ? `✓ private overlay enabled → ${hunchDir}\n`
    : `✓ shared overlay enabled → ${hunchDir}\n`;
  const tail = mode === "private"
    ? "  record sensitive items with private:true (hunch_record_decision / hunch_record_correction)\n  override per-shell with HUNCH_PRIVATE_DIR; CI / public PR comments stay public-only."
    : "  UNIFIED: every capture (decisions, bugs, constraints, runbooks) routes HERE — one source of truth\n  across branches, worktrees, teammates, and agents. Override per-shell with HUNCH_PRIVATE_DIR if needed.";
  console.log(
    lead +
    "  ✓ recorded in .hunch/local.json (gitignored) — auto-detected, no env var or shell-profile edit\n" +
    worktreeNote +
    teamNote +
    hookNote +
    migrateNote +
    tail,
  );
}

program
  .command("private [dir]")
  .description("Enable a PRIVATE memory overlay — sensitive decisions/bugs/constraints kept in a separate location, unioned into local queries, never committed here. Writes a gitignored .hunch/local.json so it's auto-detected (no env var needed).")
  .option("--repo <url>", "clone a private git repo to use as the store (into ./.hunch-private)")
  .option("--no-hook", "don't switch the post-commit hook to private sync")
  .option("--no-auto-commit", "DON'T auto commit+push the overlay after each capture (default: ON — fully automated two-way sync, never push by hand)")
  .option("--sync", "flush the configured private store now (git add+commit+push) — catches records made via MCP between commits")
  .option("--migrate", "ONE-TIME: move this repo's EXISTING public .hunch memory into the overlay, then make the public repo code-only — untrack + gitignore the memory tree and regenerate grounding so no memory is published here")
  .action((dir: string | undefined, opts: OverlaySetupOpts) => configureOverlay(dir, opts, "private"));

program
  .command("shared [dir]")
  .description("Enable a SHARED memory overlay repo for this project (works for any repo: private or public). Memory stays in one location, shared across teammates, branches, and worktrees.")
  .option("--repo <url>", "clone a git repo to use as the shared memory store (into ./.hunch-private)")
  .option("--no-hook", "don't switch the post-commit hook to overlay sync")
  .option("--no-auto-commit", "DON'T auto commit+push the overlay after each capture (default: ON — fully automated two-way sync)")
  .option("--sync", "flush the configured overlay store now (git add+commit+push)")
  .action((dir: string | undefined, opts: OverlaySetupOpts) => configureOverlay(dir, opts, "shared"));

// ---- worktree (one-command worktree wired into Hunch) ----------------------
program
  .command("worktree <path>")
  .description("Create a git worktree already wired into Hunch — it shares this repo's memory overlay, with zero per-worktree setup.")
  .option("-b, --branch <name>", "create the worktree on a NEW branch")
  .option("--no-share", "don't register the overlay at the git common dir (the worktree won't see private memory)")
  .option("--no-index", "don't build the new worktree's code graph (skip if you'll index later)")
  .action((path: string, opts: { branch?: string; share: boolean; index: boolean }) => {
    const root = findRoot();
    if (!isGitRepo(root)) return fail("`hunch worktree` needs a git repo");
    const dest = resolve(root, path);
    if (existsSync(dest)) return fail(`path already exists: ${dest}`);
    // 1) create the worktree (on a new branch if asked, else a checkout of HEAD)
    const r = spawnSync("git", ["-C", root, "worktree", "add", ...(opts.branch ? ["-b", opts.branch] : []), dest], { stdio: "inherit" });
    if (r.status !== 0) return fail("git worktree add failed");
    // 2) register the overlay at the SHARED git common dir so the new worktree (and every
    //    other) auto-discovers the same memory — also backfills pre-0.32 single-worktree setups.
    const store = new HunchStore(hunchPaths(root));
    const overlay = store.privateDir;
    const autoCommit = store.privateAutoCommit;
    store.close();
    let shareNote: string;
    if (!opts.share) {
      shareNote = `  · --no-share — the worktree will NOT see private memory`;
    } else if (overlay && ensureSharedOverlayPointer(root, overlay, autoCommit)) {
      shareNote = `  ✓ memory shared via the git common dir — this worktree sees the same decisions / bugs / constraints`;
    } else if (overlay) {
      shareNote = `  · could not register the shared overlay pointer (no git common dir?)`;
    } else {
      shareNote = `  · no overlay configured — run \`hunch shared\` (or \`hunch private\`) to share memory across worktrees`;
    }
    // 3) build the new worktree's CODE GRAPH (symbols/edges → blast-radius / dependents).
    //    Indexed IN-PROCESS (uses THIS install's tree-sitter, so the worktree needs no
    //    node_modules) and ONLY when the graph isn't already committed in the checkout —
    //    re-parsing a normal repo would just dirty its tracked .hunch/*.json. Writes the
    //    derived (gitignored) index, never the working tree.
    let indexNote = "";
    if (opts.index !== false) {
      const wstore = new HunchStore(hunchPaths(dest));
      wstore.json.ensureDirs();
      if (wstore.json.loadAll("symbols").length === 0) {
        const res = indexRepo(wstore, dest);
        wstore.reindex();
        indexNote = `\n  ✓ indexed ${res.files} file(s) → ${res.symbols} symbols — blast-radius ready (code graph isn't committed here)`;
      } else {
        wstore.reindex(); // committed graph already in the checkout → just build the derived SQLite
        indexNote = `\n  ✓ code graph present in the checkout — blast-radius ready`;
      }
      wstore.close();
    }
    console.log(
      `✓ worktree created → ${dest}${opts.branch ? ` (new branch ${opts.branch})` : ""}\n` +
      `${shareNote}${indexNote}\n` +
      `  hooks + MCP server are shared (worktree-aware) — open your assistant in the new worktree to start.\n` +
      `  (needs \`hunch\` installed globally; a worktree has no node_modules of its own)`,
    );
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

// ---- eval (retrieval quality; measures the graph-stream lift) --------------
program
  .command("eval")
  .description("Measure quality over a golden set: retrieval (Recall@k, MRR) or, with --guards, ENFORCEMENT (block/warn/pass precision & recall).")
  .option("--file <path>", "golden set JSON — retrieval: [{ query, expected }]; guards: [{ name, files, expect }]")
  .option("--guards", "score the GUARDS instead of retrieval: did the gate block the bad changes and pass the good ones?")
  .option("--generate", "with --guards: scaffold a starter golden set from the live graph (and run it)")
  .option("--k <n>", "top-k cutoff", "10")
  .option("--semantic", "also blend the semantic stream (requires `hunch embed`; default is deterministic FTS + graph)")
  .option("--kind <kind>", "restrict scoring to one record kind (e.g. runbooks) — scoped retrieval")
  .action(async (opts: { file?: string; guards?: boolean; generate?: boolean; k: string; semantic?: boolean; kind?: string }) => {
    const { store } = storeFor();
    store.reindex(); // reflect any out-of-band JSON edits before scoring

    // ── Guard eval: did the gate BLOCK the bad changes and PASS the good ones? Runs each
    //    case through the SAME buildCheckReport → verdict path the live guards use. ──
    if (opts.guards) {
      if (!opts.generate && !opts.file) { store.close(); return fail("guard eval needs --file <golden.json> or --generate"); }
      let gcases;
      try {
        gcases = opts.generate ? generateGuardCases(store) : loadGuardCases(readFileSync(opts.file!, "utf8"));
      } catch (e) {
        store.close();
        return fail(`guard eval: ${(e as Error).message}`);
      }
      if (!gcases.length) { store.close(); return fail("no guard cases — `--generate` needs vouched blocking constraints in the graph, or pass --file"); }
      if (opts.generate && opts.file) writeFileAtomic(opts.file, JSON.stringify(gcases, null, 2) + "\n");
      const r = evalGuards(store, gcases);
      const pct = (n: number, d: number) => (d ? `${((n / d) * 100).toFixed(0)}%` : "—");
      console.log(`Guard eval over ${r.total} case(s) — does the gate catch bad changes and stay quiet on good ones?\n`);
      console.log(`  CAUGHT          ${r.surfaced}/${r.shouldSurface} changes to guarded code surfaced   (${pct(r.surfaced, r.shouldSurface)})  — nothing slips silently through`);
      console.log(`     └ of those   ${r.hardBlocked} hard-block the merge, ${r.surfaced - r.hardBlocked} warn   — stale/low-confidence rules warn; re-verify to harden`);
      console.log(`  FALSE-POSITIVE  ${r.falsePositives}/${r.shouldPass} unrelated changes flagged           (${pct(r.falsePositives, r.shouldPass)} — lower is safer to enable)`);
      console.log(`  ACCURACY        ${(r.accuracy * 100).toFixed(0)}% exact verdict match\n`);
      const wrong = r.perCase.filter((p) => !p.ok);
      if (wrong.length) {
        console.log(`  ${wrong.length} mismatch(es) to review (relabel a generated case, or fix a guard):`);
        for (const w of wrong.slice(0, 12)) console.log(`    · ${w.name} — expected ${w.expect}, got ${w.got}`);
      } else {
        console.log(`  ✓ every case matched its expected verdict.`);
      }
      store.close();
      return;
    }

    // ── Retrieval eval (default) ──
    if (!opts.file) { store.close(); return fail("retrieval eval needs --file <golden.json> (or use --guards)"); }
    let cases;
    try {
      cases = loadGoldenSet(readFileSync(opts.file!, "utf8"));
    } catch (e) {
      store.close();
      return fail(`could not load golden set: ${(e as Error).message}`);
    }
    if (!cases.length) { store.close(); return fail("golden set is empty"); }
    const k = Math.max(1, parseInt(opts.k, 10) || 10);
    // Default is deterministic (FTS + graph, no model). --semantic only adds the
    // semantic leg when embeddings actually exist; otherwise it's still FTS + graph.
    const embedder = opts.semantic ? await selectEmbedder() : undefined;
    const lift = await evaluateGraphLift(store, cases, { k, embedder, kind: opts.kind });
    const pct = (x: number) => `${(x * 100).toFixed(1)}%`;
    const dpt = (x: number) => `${x >= 0 ? "+" : ""}${(x * 100).toFixed(1)}pt`;
    const dnum = (x: number) => `${x >= 0 ? "+" : ""}${x.toFixed(3)}`;
    console.log(`Eval over ${cases.length} case(s), k=${k}${opts.semantic ? " (semantic + graph + FTS)" : " (FTS + graph)"}\n`);
    console.log(`                Recall@${k}    MRR      hit-rate`);
    console.log(`  graph OFF     ${pct(lift.off.recallAtK).padStart(7)}    ${lift.off.mrr.toFixed(3)}    ${pct(lift.off.hitRate)}`);
    console.log(`  graph ON      ${pct(lift.on.recallAtK).padStart(7)}    ${lift.on.mrr.toFixed(3)}    ${pct(lift.on.hitRate)}`);
    console.log(`  graph LIFT    ${dpt(lift.recallDelta).padStart(7)}    ${dnum(lift.mrrDelta)}`);
    const misses = lift.on.perCase.filter((c) => c.found === 0);
    if (misses.length) {
      console.log(`\n  ${misses.length} case(s) with no expected hit — curate or tune:`);
      for (const m of misses.slice(0, 10)) console.log(`    · "${m.query}"`);
    }
    store.close();
  });

// ---- runbook (distill reusable "how" from a commit range; roadmap #5) ------
program
  .command("runbook")
  .description("Capture a runbook (the 'how' of a recurring task) from a commit range, or --find one. Advisory.")
  .argument("[range]", "commit range for capture: <base>..<head>, or <base> (→ <base>..HEAD)")
  .option("--task <task>", "the recurring task this runbook answers (capture mode)")
  .option("--find <query>", "look up the runbooks that best match a task/intent (scoped retrieval)")
  .option("--semantic", "use semantic retrieval for --find (requires `hunch embed`)")
  .option("--private", "capture into the private overlay (HUNCH_PRIVATE_DIR), not the committed repo")
  .action(async (range: string | undefined, opts: { task?: string; find?: string; semantic?: boolean; private?: boolean }) => {
    const { store, root } = storeFor();
    // Lookup mode: scoped runbook retrieval (search within runbooks, not the whole graph).
    if (opts.find) {
      store.reindex(); // reflect out-of-band JSON edits before searching (mirrors `hunch query`)
      const emb = opts.semantic ? await selectEmbedder() : undefined;
      const hits = await store.searchRunbooks(opts.find, 5, { embedder: emb });
      if (!hits.length) console.log(`No runbook matches "${opts.find}".`);
      else { console.log(`Runbooks for "${opts.find}":\n`); for (const h of hits) console.log(`• ${h.ref} — ${h.title}\n    ${h.snippet}`); }
      store.close();
      return;
    }
    // Capture mode.
    if (!range || !opts.task) { store.close(); return fail("capture needs a <range> and --task (or use --find <query> to look up)"); }
    if (opts.private && !store.hasPrivate) { store.close(); return fail("--private needs HUNCH_PRIVATE_DIR set to a private store"); }
    const [base, head = "HEAD"] = range.split("..");
    if (!base || !revExists(base, root)) { store.close(); return fail(`base ref "${base ?? ""}" not found (range: ${range})`); }
    const steps = rangeSubjects(base, root, head);
    const files = rangeFiles(base, root, head);
    if (!steps.length && !files.length) { store.close(); return fail(`no commits or changes in range ${range}`); }
    const now = new Date().toISOString();
    const rec: Runbook = {
      id: runbookId(opts.task),
      task: opts.task,
      trigger: [opts.task],
      steps, // already oldest-first (chronological procedure)
      files,
      gotchas: [],
      outcome: "",
      source_range: range,
      valid_from: now,
      valid_to: null,
      // Deterministic draft (commit subjects + changed files); advisory, low-confidence.
      // Refine steps/gotchas by hand. LLM enrichment is a later tier.
      provenance: { source: "extracted", confidence: 0.5, evidence: [range] },
      date: now,
    };
    store.putCapture("runbooks", rec, opts.private);
    store.reindex();
    console.log(`✓ runbook ${rec.id} — "${rec.task}"  (${rec.steps.length} steps, ${rec.files.length} files)${opts.private ? " [private overlay]" : ""}`);
    console.log(dim("  advisory, deterministic draft — refine the steps/gotchas; surfaced via `hunch query` and MCP."));
    store.close();
  });

// ---- capture-comments (inline intent → graph; addendum #2) ----------------
program
  .command("capture-comments")
  .description("Capture inline intent comments into the graph: `hunch-why:` → a decision, `hunch-rule:` → a file-scoped constraint. Deterministic + idempotent.")
  .option("--private", "write captured records into the private overlay (HUNCH_PRIVATE_DIR)")
  .action((opts: { private?: boolean }) => {
    const { store, root } = storeFor();
    if (opts.private && !store.hasPrivate) { store.close(); return fail("--private needs HUNCH_PRIVATE_DIR set to a private store"); }
    const intents = extractInlineIntent(root);
    const now = new Date().toISOString();
    let dec = 0, con = 0;
    for (const it of intents) {
      const ev = [`${it.file}:${it.line}`];
      if (it.kind === "why") {
        const id = decisionId(`inline:${it.file}:${it.text}`);
        const prev = store.recs("decisions").find((d) => d.id === id); // preserve window for idempotent re-capture
        const rec: Decision = {
          id, title: it.text, topic: prev?.topic ?? null, status: "accepted",
          context: `Captured from an inline hunch-why comment (${it.file}:${it.line}).`,
          decision: it.text, consequences: [], alternatives_rejected: [], rejected_tripwires: [],
          related_components: [], related_files: [it.file], supersedes: null, superseded_by: null,
          caused_by_bug: null, commit: null, valid_from: prev?.valid_from ?? now, valid_to: null,
          retired: { symbols: [], deps: [] },
          provenance: { source: "human_confirmed", confidence: 0.9, evidence: ev }, date: prev?.date ?? now,
        };
        store.putCapture("decisions", rec, opts.private);
        dec++;
      } else {
        const id = constraintId(`inline:${it.file}:${it.text}`);
        const prev = store.recs("constraints").find((c) => c.id === id);
        const rec: Constraint = {
          id, type: "correctness", statement: it.text, scope: [it.file],
          // Advisory by default — an inline rule never auto-blocks a build; raise severity
          // deliberately if you want enforcement. Keeps day-one zero false-positive rage.
          severity: "warning", enforcement: "advisory_v1", match: null, forbids: null,
          rationale: `Captured from an inline hunch-rule comment (${it.file}:${it.line}).`,
          source_decision: null, violations: [], status: "active",
          valid_from: prev?.valid_from ?? now, valid_to: null,
          provenance: { source: "human_confirmed", confidence: 0.9, evidence: ev },
        };
        store.putCapture("constraints", rec, opts.private);
        con++;
      }
    }
    store.reindex();
    if (dec || con) flushCapture(store, hunchPaths(root).hunch, !!opts.private, `hunch: capture ${dec + con} inline intent(s)`);
    if (!intents.length) console.log("No `hunch-why:` / `hunch-rule:` comments found.");
    else console.log(`✓ captured ${dec} decision(s) + ${con} constraint(s) from inline comments${opts.private ? " [private overlay]" : ""}`);
    store.close();
  });

// ---- conform (Architectural Conformance: does the code still satisfy recorded intent) ----
program
  .command("conform")
  .description("Architectural Conformance: prove the code still SATISFIES each recorded architectural invariant (deterministic, over the graph) — the semantic rules pattern-SAST can't express: layering, must-reach, dependency direction. Catches AI changes that pass a linter but break the architecture.")
  .option("--strict", "exit non-zero if any invariant is violated (use as a CI gate)")
  .option("--add <title>", "record an architectural invariant instead of checking, e.g. --add \"controllers never touch the DB directly\"")
  .option("--assert <kind>", "calls | not-calls | imports | not-imports | exists  (with --add)")
  .option("--subject <sym>", "the symbol/file:name the invariant is about  (with --add)")
  .option("--object <sym>", "the symbol it must reach (calls/imports) or must NOT reach (not-calls/not-imports)  (with --add)")
  .option("--transitive", "evaluate reachability transitively, not just direct edges  (with --add)")
  .option("--why <text>", "why it holds — the rationale, surfaced in the block receipt  (with --add)")
  .option("--bug <id>", "the bug id this invariant prevents recurring — surfaced in the receipt  (with --add)")
  .action((opts: { strict?: boolean; add?: string; assert?: string; subject?: string; object?: string; transitive?: boolean; why?: string; bug?: string }) => {
    const { store, root } = storeFor();
    if (opts.add) {
      const ASSERTS = ["calls", "not-calls", "imports", "not-imports", "exists"];
      if (!opts.assert || !ASSERTS.includes(opts.assert)) return fail(`--assert must be one of: ${ASSERTS.join(", ")}`);
      if (!opts.subject) return fail("--subject is required with --add");
      if (opts.assert !== "exists" && !opts.object) return fail(`--object is required for --assert ${opts.assert}`);
      store.json.ensureDirs();
      const now = new Date().toISOString();
      const arrow = opts.assert.startsWith("not-") ? "↛" : "→";
      const d = store.putCapture("decisions", {
        id: decisionId(`conform:${opts.add}:${opts.subject}:${opts.object ?? ""}`),
        title: opts.add,
        status: "accepted",
        context: opts.why ?? "",
        decision: `Architectural invariant: ${opts.subject} ${opts.assert}${opts.object ? ` ${opts.object}` : ""}.`,
        caused_by_bug: opts.bug ?? null,
        conformance: [{ assert: opts.assert, subject: opts.subject, object: opts.assert === "exists" ? undefined : opts.object, transitive: !!opts.transitive }],
        provenance: { source: "human_confirmed", confidence: 1, evidence: [], last_verified: now },
        date: now,
        valid_from: now,
      } as never);
      store.reindex();
      refreshExistingGrounding(root, store); // the invariant reaches every assistant's grounding
      console.log(`✓ recorded architectural invariant ${d.id}: "${opts.add}"`);
      console.log(`  ${opts.subject} ${arrow} ${opts.object ?? ""}${opts.transitive ? " (transitive)" : ""}   [${opts.assert}]`);
      console.log(`  enforce on every change:  hunch conform --strict   (wire into CI alongside hunch ci)`);
      store.close();
      return;
    }
    store.reindex();
    const results = checkConformance(store);
    if (!results.length) {
      console.log("No architectural invariants recorded yet.");
      console.log(dim('  Record one:  hunch conform --add "controllers never touch the DB directly" --assert not-calls --subject OrdersController --object dbQuery'));
      store.close();
      return;
    }
    const violations = results.filter((r) => !r.satisfied);
    console.log(`Architectural conformance: ${results.length - violations.length}/${results.length} invariants satisfied\n`);
    for (const r of results) {
      console.log(`  ${r.satisfied ? "✅" : "⛔"} ${r.decision} — "${r.title}"`);
      console.log(`     ${r.assert} ${r.subject}${r.object ? ` → ${r.object}` : ""}: ${r.detail}`);
      if (!r.satisfied) {
        // The receipt — WHY this invariant exists, which pattern-SAST can't tell you.
        const dec = store.json.get("decisions", r.decision);
        if (dec?.context) console.log(`       ↳ why: ${dec.context}`);
        if (dec?.caused_by_bug) console.log(`       ↳ prevents recurrence of: ${dec.caused_by_bug}`);
      }
    }
    if (violations.length) {
      console.log(`\n⛔ ${violations.length} architectural invariant(s) the code no longer satisfies — an AI change drifted from the recorded architecture.`);
      if (opts.strict) process.exitCode = 1;
    } else {
      console.log(`\n✅ the code satisfies every recorded architectural invariant.`);
    }
    store.close();
  });

// ---- compare (rank N candidate solutions by architectural fit) ------------
program
  .command("compare")
  .description("Rank candidate branches/commits by how well each fits the architecture — deterministic merge-verdict over the graph (the 'evaluate 5 solutions' check).")
  .argument("<candidates...>", "refs to compare (branches or commits), e.g. feat-a feat-b feat-c")
  .option("--base <ref>", "base to diff each candidate against (3-dot, since merge-base)", "main")
  .action((candidates: string[], opts: { base: string }) => {
    const { store, root } = storeFor();
    if (!isGitRepo(root)) { store.close(); return fail("compare needs a git repo"); }
    if (!revExists(opts.base, root)) { store.close(); return fail(`base ref "${opts.base}" not found (pass --base <ref>)`); }
    store.reindex();
    const ranked = compareCandidates(store, root, opts.base, candidates);
    const icon = (v: string) => (v === "pass" ? "✅" : v === "warn" ? "⚠️ " : "⛔");
    console.log(`Candidates vs ${opts.base} — best architectural fit first:\n`);
    ranked.forEach((c, i) => {
      if (c.error) { console.log(`  ${i + 1}. ${c.ref} — ${c.error}`); return; }
      const best = i === 0 ? dim("  ← best fit") : "";
      console.log(`  ${i + 1}. ${icon(c.verdict)} ${c.ref}  [${c.verdict}]  ${c.blocking} blocking · ${c.direct} direct · ${c.near} near · ${c.vetoes} veto · ${c.redundant} redundant  (${c.files} files)${best}`);
    });
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
  .option("--forbid-dep <names>", "comma-sep imports that BREAK the rule (parsed-import precise; e.g. lodash) — blocks the real violation, immune to staleness")
  .option("--forbid-symbol <names>", "comma-sep identifier names that break the rule")
  .option("--match <regex>", "textual line regex (lint-grade last resort; prefer --forbid-dep/--forbid-symbol)")
  .action((statement: string, opts: { scope: string; severity: string; type: string; rationale: string; sourceDecision?: string; enforcement: string; match?: string; forbidDep?: string; forbidSymbol?: string }) => {
    const SEV = ["advisory", "warning", "blocking"];
    if (!SEV.includes(opts.severity)) return fail(`--severity must be one of: ${SEV.join(", ")}`);
    const { store, root } = storeFor();
    store.json.ensureDirs();
    const scope = opts.scope.split(",").map((s) => toPosixTarget(s.trim())).filter(Boolean);
    const csv = (s?: string) => (s ? s.split(",").map((x) => x.trim()).filter(Boolean) : []);
    const deps = csv(opts.forbidDep), symbols = csv(opts.forbidSymbol);
    // Explicit matcher if given; else best-effort derive a dep from the statement so the
    // common "never import X" rule is precise + staleness-immune by default, not scope-only.
    let forbids = deps.length || symbols.length ? { deps, symbols, patterns: [] as string[] } : null;
    let derived = false;
    if (!forbids && !opts.match) {
      const deps = knownRepoDeps(root);
      forbids = deriveForbids(statement, deps.length ? deps : undefined);
      derived = !!forbids;
    }
    const c = store.putCapture("constraints", {
      id: constraintId(statement),
      type: opts.type,
      statement,
      scope,
      severity: opts.severity,
      enforcement: opts.enforcement,
      match: opts.match ?? null,
      forbids,
      rationale: opts.rationale,
      source_decision: opts.sourceDecision ?? null,
      violations: [],
      status: "active",
      valid_from: new Date().toISOString(),
      valid_to: null,
      provenance: { source: "human_confirmed", confidence: 1, evidence: [], last_verified: new Date().toISOString() },
    } as Constraint);
    store.reindex();
    refreshExistingGrounding(root, store); // keep EVERY assistant's grounding current, not just CLAUDE.md
    console.log(`✓ recorded ${c.severity} constraint ${c.id}: "${c.statement}" (scope: ${scope.join(", ") || "repo"})`);
    if (derived && c.forbids?.deps.length) console.log(`  ↳ matcher: forbids import of ${c.forbids.deps.join(", ")} (precise, immune to staleness)`);
    if (c.severity === "blocking" && !effectiveForbids(c)) {
      // The default path's sharp edge: a scope-only blocking rule fails OPEN once any
      // file in scope is committed after today (staleness). Point the user at the fix.
      console.log(`  ⚠ scope-only — this will downgrade to advisory once a file in scope is changed after today.`);
      console.log(`    To block the actual violation across the file's life, add  --forbid-dep <pkg>  (or --forbid-symbol / --match).`);
    }
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
  .description("Flag changes that touch a do-not-break invariant — the local guardrail AND the CI/PR Constraint Guard. Also flags (advisory) symbols you add that already exist elsewhere — possible re-implementation/sprawl.")
  .option("--staged", "check git staged files (default)")
  .option("--commit <sha>", "check a specific commit's files")
  .option("--base <ref>", "check a PR/branch: files changed vs <ref> (e.g. origin/main) — for CI")
  .option("--strict", "exit non-zero ONLY on a direct, high-confidence, non-stale blocking invariant (near/stale/low-confidence stay advisory)")
  .option("--format <fmt>", "output: text (default) | markdown (a PR comment)", "text")
  .option("--blast", "also print the dependency blast radius of the changed files")
  .option("--public-only", "exclude the private overlay (HUNCH_PRIVATE_DIR) from the report — use for any output that may be posted publicly (the CI PR comment passes this)")
  .action((opts: { staged?: boolean; commit?: string; base?: string; strict?: boolean; format?: string; blast?: boolean; publicOnly?: boolean }) => {
    const sources = [opts.commit && "--commit", opts.base && "--base", opts.staged && "--staged"].filter(Boolean);
    if (sources.length > 1) return fail(`pick one of --staged / --commit / --base (got ${sources.join(", ")})`);
    const markdown = opts.format === "markdown";
    const emptyReport: CheckReport = { fileCount: 0, strict: !!opts.strict, direct: [], near: [], regressions: [], vetoes: [], redundant: [], strictBlockers: 0, regBlocking: 0, vetoBlocking: 0 };

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
    // code) + REDUNDANT (adds a symbol already defined elsewhere — advisory) + the
    // hardened strict gate + causal `why` citations — all assembled by the shared
    // store.buildCheckReport (also used by the hunch_merge_verdict tool).
    const diff = opts.commit ? commitDiff(opts.commit, root) : opts.base ? rangeDiff(opts.base, root) : stagedDiff(root);
    const report: CheckReport = store.buildCheckReport(files, diff, {
      strict: !!opts.strict,
      lastChange: (f) => lastChangeDate(f, root),
      publicOnly: !!opts.publicOnly,
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

    // ARCHITECTURAL CONFORMANCE: does the RESULTING code still satisfy every recorded
    // architectural invariant? This is graph-reachability, not a diff — so it catches semantic
    // violations a pattern-matcher / SAST can't express (a controller that now reaches the DB
    // directly). It must run over the CHANGED code, so re-parse the working tree first — but
    // ONLY when conformance predicates exist (zero cost on repos that don't use them). The
    // gate cases (--staged / --base / --commit HEAD) all have the working tree AT the change.
    // Surfaced always; gates the commit/PR under --strict, with the receipt of the why.
    const hasConformance = store.recs("decisions").some((d) => (d.conformance?.length ?? 0) > 0);
    if (hasConformance) {
      indexRepo(store, root, { churn: false }); // refresh the symbol/dep graph from the working tree
      store.reindex();
    }
    const confViolations = hasConformance ? checkConformance(store).filter((c) => !c.satisfied) : [];
    if (confViolations.length) {
      if (markdown) {
        console.log(`\n### ⛔ Architectural conformance — ${confViolations.length} invariant(s) violated\n`);
        for (const c of confViolations) {
          const dec = store.json.get("decisions", c.decision);
          const why = dec?.context ? ` · _why: ${dec.context}_` : "";
          const bug = dec?.caused_by_bug ? ` · prevents recurrence of \`${dec.caused_by_bug}\`` : "";
          console.log(`- ⛔ **${c.detail}** — \`${c.decision}\` "${c.title}"${why}${bug}`);
        }
      } else {
        console.log(`\n⛔ Architectural conformance — ${confViolations.length} invariant(s) the code no longer satisfies (an AI change drifted from the architecture):`);
        for (const c of confViolations) {
          const dec = store.json.get("decisions", c.decision);
          console.log(`   ${c.detail}  (${c.decision} "${c.title}")`);
          if (dec?.context) console.log(`     ↳ why: ${dec.context}`);
          if (dec?.caused_by_bug) console.log(`     ↳ prevents recurrence of: ${dec.caused_by_bug}`);
        }
        console.log(`   The semantic invariant a linter can't see — run \`hunch conform\` for the full picture.`);
      }
    }

    if (reportFailsStrict(report) || (!!opts.strict && confViolations.length > 0)) process.exitCode = 1;
    store.close();
  });

// ---- veto (the rejected-alternative class, in isolation) ------------------
const vetoCmd = program
  .command("veto")
  .description("Decision Guard: flag changes that REVERSE a decision — re-introducing an approach an in-force decision rejected (the rejected-alternatives class, on its own).")
  .option("--staged", "check git staged files (default)")
  .option("--commit <sha>", "check a specific commit's files")
  .option("--base <ref>", "check a PR/branch: files changed vs <ref> (e.g. origin/main)")
  .option("--strict", "exit non-zero on a human-confirmed, in-force, non-stale veto")
  .option("--format <fmt>", "output: text (default) | markdown", "text")
  .action((opts: { staged?: boolean; commit?: string; base?: string; strict?: boolean; format?: string }) => {
    const sources = [opts.commit && "--commit", opts.base && "--base", opts.staged && "--staged"].filter(Boolean);
    if (sources.length > 1) return fail(`pick one of --staged / --commit / --base (got ${sources.join(", ")})`);
    const markdown = opts.format === "markdown";
    const { store, root } = storeFor();
    if (opts.base && !revExists(opts.base, root)) {
      store.close();
      return fail(`--base ref "${opts.base}" does not resolve. In CI, fetch the base branch first (git fetch origin <branch>).`);
    }
    store.reindex();
    const files = opts.commit ? commitFiles(opts.commit, root)
      : opts.base ? rangeFiles(opts.base, root)
      : stagedFiles(root);
    if (!files.length) {
      console.log("No changed files to check.");
      store.close();
      return;
    }
    const diff = opts.commit ? commitDiff(opts.commit, root) : opts.base ? rangeDiff(opts.base, root) : stagedDiff(root);
    const full = store.buildCheckReport(files, diff, { strict: !!opts.strict, lastChange: (f) => lastChangeDate(f, root) });
    if (!full.vetoes.length) {
      console.log(`✓ ${files.length} changed file(s) reverse no decision you rejected.`);
      store.close();
      return;
    }
    // Render ONLY the veto class — zero the other sections so the shared renderer
    // shows just the rejected-alternative reversals (the rest is `hunch check`).
    const vetoOnly: CheckReport = { ...full, direct: [], near: [], regressions: [], redundant: [], strictBlockers: 0, regBlocking: 0 };
    console.log(markdown ? renderMarkdown(vetoOnly) : renderText(vetoOnly));
    if (reportFailsStrict(vetoOnly)) process.exitCode = 1;
    store.close();
  });

vetoCmd
  .command("backfill")
  .description("Draft machine-checkable tripwires for existing rejected alternatives. Drafts are ADVISORY — confirm with `hunch review --accept <id>` to enable blocking.")
  .action(() => {
    const { store, root } = storeFor();
    const knownDeps = knownRepoDeps(root);
    let drafted = 0;
    let touched = 0;
    for (const d of store.json.loadAll("decisions")) {
      if (d.superseded_by || d.status === "superseded") continue;
      if (!d.alternatives_rejected.length) continue;
      if ((d.rejected_tripwires?.length ?? 0) > 0) continue; // never clobber existing tripwires
      const tws = draftTripwires(d.alternatives_rejected, d.related_files, knownDeps);
      store.putWhereItLives("decisions", { ...d, rejected_tripwires: tws });
      drafted += tws.length;
      touched++;
    }
    store.reindex();
    if (!touched) {
      console.log("✓ Nothing to backfill — every in-force decision with rejected alternatives already has tripwires.");
    } else {
      console.log(`✓ Drafted ${drafted} tripwire(s) across ${touched} decision(s) — all ADVISORY (llm_draft).`);
      console.log("  They warn but never block until confirmed. Confirm a decision's tripwires:");
      console.log("  hunch review --accept <decision-id>");
    }
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
  .action(async (target: string, opts: { budget: string; asOf?: string }) => {
    const { store, root } = storeFor();
    const asOf = opts.asOf ? asOfDate(opts.asOf, root) : undefined;
    if (opts.asOf && !asOf) return fail(`could not resolve --as-of "${opts.asOf}" to a commit`);
    store.reindex(); // reflect any out-of-band JSON edits before assembling
    const ctx = store.assembleContext(target, Number(opts.budget), { asOf });
    // A task PHRASE ("improve retrieval ranking") resolves no file/symbol target and
    // used to come back empty while the graph held the answer one FTS query away —
    // the task-shaped entry point must not whiff on task-shaped input. Fall back to
    // search so the caller always leaves with the closest graph matches.
    const empty = !ctx.constraints.length && !ctx.decisions.length && !ctx.bugs.length && !ctx.blast_radius.length;
    if (empty && !asOf) {
      const hits = store.search(target, 8);
      if (hits.length) {
        console.log(`No file/symbol resolves for "${target}" — closest graph matches instead:\n`);
        for (const h of hits) console.log(`• ${h.ref} — ${h.title}\n    ${h.snippet}`);
        console.log(`\n(For a file/symbol brief use a concrete target; for free-text this is what \`hunch query\` returns.)`);
        store.close();
        return;
      }
    }
    process.stdout.write(formatContext(ctx));
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

// ---- status (enforcement readiness at a glance) ---------------------------
program
  .command("status")
  .description("Enforcement readiness at a glance: what's enforcing, what's waiting to confirm, what went stale.")
  .action(() => {
    const { store, root } = storeFor();
    const firmness = readConfig(hunchPaths(root)).firmness;
    const vouchedSrc = (s?: string) => !!s && (s.includes("human_confirmed") || s === "derived");
    const blocking = store.recs("constraints").filter((c) => c.status === "active" && c.severity === "blocking" && vouchedSrc(c.provenance?.source));
    const precise = blocking.filter((c) => !!effectiveForbids(c));
    const scopeOnly = blocking.filter((c) => !effectiveForbids(c));
    const drafts = store.json.loadAll("decisions").filter((d) => d.status === "proposed" || d.provenance.confidence < 0.6);
    const { ready, scrutiny } = partitionReview(drafts, READY_MIN_GROUNDED);
    const stale = store.staleness((f) => lastChangeDate(f, root)).filter((s) => s.kind === "constraint");

    const fnote: Record<string, string> = {
      off: "not enforcing — `hunch firmness advisory` to start",
      advisory: "surfaces context to the agent; never blocks",
      firm: "surfaces + warns on a violating edit",
      strict: "edit-time DENY + CI guard — the teeth are on",
    };
    console.log(`\nHunch — enforcement status (${root.split("/").pop()})\n`);
    console.log(`  firmness: ${firmness}   ← ${fnote[firmness] ?? ""}\n`);
    console.log(`  ✓ ARMED        ${blocking.length} confirmed blocking invariant(s) — held against every assistant`);
    if (blocking.length) {
      console.log(`       ${precise.length} precise (block the actual violation, immune to staleness)`);
      console.log(`       ${scopeOnly.length} scope-only (relax to advisory once the file changes)${scopeOnly.length ? "  → harden with --forbid-dep" : ""}`);
    }
    if (ready.length || scrutiny.length) {
      console.log(`\n  ⏳ TO CONFIRM   ${ready.length} ready · ${scrutiny.length} need scrutiny   → hunch review${ready.length ? " --accept-verified" : ""}`);
    }
    if (stale.length) {
      console.log(`\n  ♻ STALE        ${stale.length} rule(s) whose guarded code moved since last verified   → re-confirm to keep the teeth`);
    }
    if (firmness !== "strict" && precise.length) {
      console.log(`\n  ⚡ ${precise.length} precise rule(s) are armed but firmness is "${firmness}" — set \`hunch firmness strict\` to hard-block them.`);
    }
    console.log("");
    store.close();
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
        session_id?: string;
        tool_name?: string;
        tool_input?: { file_path?: string; new_string?: string; content?: string; edits?: Array<{ new_string?: string }>; command?: string; skill?: string };
        prompt?: string;
      };
      const root = findRoot();
      const paths = hunchPaths(root);
      const firmness = readConfig(paths).firmness;
      if (firmness === "off") return;

      // Verification pipeline (delivery enforced, not hoped for — see core/pipeline.ts).
      // PostToolUse records facts; Stop gates on them. Both are pipeline-only events,
      // handled before the grounding dispatch below.
      if (evt.hook_event_name === "PostToolUse" && evt.session_id && pipelineEnabled()) {
        let st = loadPipelineState(evt.session_id);
        if (/^(Edit|Write|MultiEdit)$/.test(evt.tool_name ?? "")) {
          const p = evt.tool_input?.file_path;
          if (p) st = onEdit(st, toRepoRel(root, p));
        } else if (evt.tool_name === "Bash" || evt.tool_name === "PowerShell") {
          st = onCommand(st, String(evt.tool_input?.command ?? ""));
        } else if (evt.tool_name === "Skill") {
          st = onSkill(st, String(evt.tool_input?.skill ?? ""));
        }
        savePipelineState(evt.session_id, st);
        return;
      }
      if (evt.hook_event_name === "Stop" && evt.session_id && pipelineEnabled()) {
        const st = loadPipelineState(evt.session_id);
        const verdict = stopVerdict(st, firmness);
        if (verdict.block) {
          savePipelineState(evt.session_id, verdict.state);
          process.stdout.write(JSON.stringify({ decision: "block", reason: verdict.reason }));
        }
        return;
      }

      if (evt.hook_event_name === "UserPromptSubmit") {
        // When the prompt reads like a correction ("no / that's wrong / never X"),
        // nudge the agent to PERSIST it as an enforced constraint (Never Twice) —
        // not just obey it this once and forget it next session.
        let text = looksLikeCorrection(evt.prompt) ? `${HOOK_REMINDER}\n\n${CORRECTION_NUDGE}` : HOOK_REMINDER;
        // Pipeline turn bookkeeping (fresh block budget) + the one nag that must
        // repeat: edits from an earlier turn still unverified.
        if (evt.session_id && pipelineEnabled()) {
          const st = onPrompt(loadPipelineState(evt.session_id));
          savePipelineState(evt.session_id, st);
          if (!st.verifyAfterEdit) text += `\n\n${UNVERIFIED_NAG}`;
        }
        // Once per session is enough for the availability reminder — repeating it
        // every prompt burns context for zero information. A correction nudge has
        // different content, so it always comes through (dec_244397d920).
        if (injectionMode(evt.session_id, "prompt-reminder", text) === "delta") return;
        emitContext("UserPromptSubmit", text);
        return;
      }
      if (evt.hook_event_name === "SessionStart") {
        // Orientation at the moment it matters: what just happened + what's next,
        // straight from the graph — the agent sits down already knowing where it
        // is instead of pulling (or worse, grepping) for it. Cheap reads only
        // (no reindex, no drift walk); public store only — session transcripts
        // travel further than a terminal. Union view: `hunch now --private`.
        const s = new HunchStore(paths);
        try {
          const decisions = s.json.loadAll("decisions");
          const { recent, roadmap, pendingReview } = nowData(decisions, 3);
          if (!decisions.length) {
            // Fresh graph: nothing to orient on, but the operating loop still ships.
            if (pipelineEnabled()) emitContext("SessionStart", PIPELINE_LOOP);
            return;
          }
          const L: string[] = [];
          L.push(`🧠 Hunch orientation — ${decisions.length} decision(s) in the graph.`);
          if (recent.length) {
            L.push("Recent:");
            for (const r of recent) L.push(`  ${r.date} [${r.status}] ${r.title} (${r.id})`);
          }
          if (roadmap.length) {
            L.push(`Roadmap (${roadmap.length} live proposed): ${roadmap.slice(0, 3).map((r) => r.title).join(" · ")}${roadmap.length > 3 ? " · …" : ""}`);
          }
          if (pendingReview > 0) L.push(`${pendingReview} auto-draft(s) awaiting \`hunch review\`.`);
          L.push("Orient further: hunch_context(task) · hunch_structure() · `hunch now`.");
          // The operating loop rides session start — guaranteed delivery, once
          // (the zod bench showed ambient skills are read in ~0% of sessions).
          if (pipelineEnabled()) L.push("", PIPELINE_LOOP);
          emitContext("SessionStart", L.join("\n"));
        } finally {
          s.close();
        }
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
        // The lines this edit would ADD — so a content-matched invariant denies only
        // when the edit actually trips it (not on every edit in scope), and the Veto
        // Guard can test the proposed text. Covers Edit/Write/MultiEdit.
        const proposedLines = proposedEditLines(evt.tool_input);
        const deny = blockingInScope(store, target, proposedLines);
        if (deny) {
          emitDeny(deny.reason);
          return;
        }
        // Veto Guard (live): the proposed edit text re-introduces an approach an
        // in-force decision REJECTED. The agent self-corrects before staging;
        // only human-confirmed tripwires deny.
        const vetoDeny = proposedLines.length ? vetoInScope(store, target, proposedLines) : null;
        if (vetoDeny) {
          emitDeny(vetoDeny.reason);
          return;
        }
      }

      // advisory / firm / strict(non-blocking): inject the relevant Hunch slice.
      // Decision-grounding for PROSE (doc≠graph): a markdown target that declares
      // <!-- hunch:topic … --> anchors gets each topic's CURRENT decision — the
      // graph outranks the prose being edited, and a stale pin is called out inline.
      let docGround = "";
      if (/\.(md|mdx)$/i.test(target)) {
        try {
          docGround = renderDocGrounding(parseDocAnchors(readFileSync(abs, "utf8")), store.recs("decisions"));
        } catch { /* unreadable / not yet created — no doc grounding */ }
      }
      const ctx = store.assembleContext(target);
      // Regression Guard (edit-time grounding): what an in-force decision retired
      // from this file. No diff exists yet, so this is context — "don't re-add X" —
      // not a block; the commit-time `hunch check` does the actual gating.
      const retired = store.retiredForFile(target).filter((r) => r.symbols.length || r.deps.length);
      const hasContent =
        ctx.constraints.length || ctx.decisions.length || ctx.bugs.length || ctx.blast_radius.length || retired.length || docGround;
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
      // Decision-grounding (§3): for topic-anchored decisions governing this file, state
      // the current decision assertively (graph over any stale doc) + what it rejected.
      const grounding = renderGrounding(ctx.decisions);
      if (grounding) text += `\n\n${grounding}`;
      if (docGround) text += `\n\n${docGround}`;
      // Identical grounding already shown this session → one-line delta instead of
      // the full 10-16KB block. Any record change re-sends the full text; the
      // strict-gate deny path above never routes through this (dec_244397d920).
      if (injectionMode(evt.session_id, `pre:${target}`, text) === "delta") {
        emitContext(
          "PreToolUse",
          `Hunch grounding for ${target}: unchanged this session (${ctx.decisions.length} decision(s), ${ctx.constraints.length} invariant(s) shown earlier — still current; hunch_why("${target}") to re-expand).`,
        );
        return;
      }
      emitContext("PreToolUse", text);
    } catch {
      // swallow — never block an edit on a hook failure
    } finally {
      store?.close();
    }
  });

// ---- review (curate loop) -------------------------------------------------
/** Promote a draft to accepted/human-confirmed and CONFIRM its drafted tripwires —
 *  this is how the Veto Guard goes advisory → blocking ("confirm rides hunch review";
 *  dec_a466655539). Returns the new source tag and how many tripwires can now actually
 *  block (non-empty forbids) so bulk enforcement is never silent. */
function acceptDecision(store: HunchStore, d: Decision): { source: string; armed: number } {
  const source = d.provenance.source.includes("llm_draft") ? "llm_draft+human_confirmed" : "human_confirmed";
  const now = new Date().toISOString();
  const confirmedTws = (d.rejected_tripwires ?? []).map((tw) => ({
    ...tw,
    provenance: {
      ...tw.provenance,
      source: tw.provenance.source.includes("human_confirmed")
        ? tw.provenance.source
        : tw.provenance.source.includes("llm_draft")
          ? "llm_draft+human_confirmed"
          : "human_confirmed",
      last_verified: now,
    },
  }));
  store.putWhereItLives("decisions", { ...d, status: "accepted", rejected_tripwires: confirmedTws, provenance: { ...d.provenance, source, confidence: 0.95, last_verified: now } });
  const armed = confirmedTws.filter((tw) => tw.forbids.deps.length || tw.forbids.symbols.length || tw.forbids.patterns.length).length;
  return { source, armed };
}

/** Print one draft for the review listing: id/status/source/confidence, the Critic's
 *  prune count (its visible value), the title, a decision snippet, and the raw synth line. */
function printReviewItem(it: ReviewItem): void {
  const { d, synth } = it;
  const pruneNote = synth.pruned ? `  · Critic pruned ${synth.pruned} unsupported` : "";
  const synthLine = synth.raw ? `\n      ↳ ${synth.raw}` : "";
  console.log(`  ${d.id} [${d.status}, ${d.provenance.source} ${d.provenance.confidence}]${pruneNote}\n      ${d.title}\n      ${d.decision.slice(0, 120)}${synthLine}`);
}

program
  .command("review")
  .description("Triage drafts: segmented list, accept/reject one, or batch-accept Critic-verified drafts.")
  .option("--accept <id>", "promote a decision to accepted/human-confirmed (confirms its tripwires)")
  .option("--reject <id>", "delete a draft decision")
  .option("--accept-verified", "batch-accept every Critic-verified, well-grounded draft (>= --min-grounded)")
  .option("--reject-duplicates", "batch-reject drafts that near-duplicate an accepted record (deterministic term+file similarity — hygiene, not judgment)")
  .option("--min-grounded <n>", "grounded-ness threshold for the ready group / --accept-verified", String(READY_MIN_GROUNDED))
  .action((opts: { accept?: string; reject?: string; acceptVerified?: boolean; rejectDuplicates?: boolean; minGrounded?: string }) => {
    const { store, root } = storeFor();
    const minGrounded = Number.isFinite(Number(opts.minGrounded)) ? Number(opts.minGrounded) : READY_MIN_GROUNDED;
    if (opts.accept) {
      const d = store.json.get("decisions", opts.accept);
      if (!d) { store.close(); return fail(`decision ${opts.accept} not found`); }
      const { source, armed } = acceptDecision(store, d);
      store.reindex();
      refreshExistingGrounding(root, store); // confirming a rule must reach EVERY assistant's grounding
      console.log(`✓ accepted ${opts.accept} (now ${source}, confidence 0.95${armed ? `, ${armed} tripwire(s) now blocking` : ""})`);
    } else if (opts.reject) {
      const ok2 = store.json.delete("decisions", opts.reject);
      store.reindex();
      console.log(ok2 ? `✓ rejected and removed ${opts.reject}` : `decision ${opts.reject} not found`);
    } else if (opts.rejectDuplicates) {
      // Deterministic hygiene, not a trust decision (dec_a466655539 stays intact):
      // only drafts, only against ACCEPTED records, conservative threshold.
      const all = store.json.loadAll("decisions");
      const drafts = all.filter((d) => d.status === "proposed" && !d.provenance.source.includes("human_confirmed"));
      const dupes = drafts
        .map((d) => ({ d, m: draftDuplicateOf(d, all) }))
        .filter((x): x is { d: Decision; m: NonNullable<ReturnType<typeof draftDuplicateOf>> } => !!x.m);
      if (!dupes.length) {
        console.log("✓ No near-duplicate drafts.");
      } else {
        let removed = 0;
        for (const { d, m } of dupes) {
          if (store.json.delete("decisions", d.id)) removed++;
          console.log(`  ✗ ${d.id} — "${d.title}"\n      duplicate of ${m.of.id} — "${m.of.title}" (${Math.round(m.score * 100)}%)`);
        }
        store.reindex();
        console.log(`\n✓ Rejected ${removed} duplicate draft(s). Accepted records untouched.`);
      }
    } else if (opts.acceptVerified) {
      // Batch path: only Critic-verified, well-grounded drafts qualify — still the
      // human-driven accept gate (the operator runs this), just over a safe subset.
      const proposed = store.json.loadAll("decisions").filter((d) => d.status === "proposed");
      const { ready } = partitionReview(proposed, minGrounded);
      if (!ready.length) {
        console.log(`✓ No Critic-verified drafts at grounded ≥ ${minGrounded} to batch-accept.`);
      } else {
        let armedTotal = 0;
        for (const it of ready) armedTotal += acceptDecision(store, it.d).armed;
        store.reindex();
        refreshExistingGrounding(root, store); // batch-confirm must reach EVERY assistant's grounding
        console.log(`✓ accepted ${ready.length} verified draft(s); ${armedTotal} tripwire(s) now blocking.`);
        for (const it of ready) console.log(`   ${it.d.id}  grounded=${it.synth.grounded ?? "?"}  ${it.d.title}`);
      }
    } else {
      const drafts = store.json.loadAll("decisions").filter((d) => d.status === "proposed" || d.provenance.confidence < 0.6);
      const { ready, scrutiny } = partitionReview(drafts, minGrounded);
      if (!ready.length && !scrutiny.length) {
        console.log("✓ No low-confidence drafts to review.");
      } else {
        if (ready.length) {
          console.log(`✓ ${ready.length} ready to confirm — Critic-verified, grounded ≥ ${minGrounded} (best first):\n`);
          for (const it of ready) printReviewItem(it);
          console.log(`\n   Batch-confirm all: hunch review --accept-verified\n`);
        }
        if (scrutiny.length) {
          console.log(`⚠ ${scrutiny.length} need scrutiny — unverified / low-grounded (lowest confidence first):\n`);
          const all = store.json.loadAll("decisions");
          let dupCount = 0;
          for (const it of scrutiny) {
            printReviewItem(it);
            const m = draftDuplicateOf(it.d, all);
            if (m) { dupCount++; console.log(`      ⚠ likely DUPLICATE of ${m.of.id} — "${m.of.title}" (${Math.round(m.score * 100)}%)`); }
          }
          if (dupCount) console.log(`\n   Batch-reject the ${dupCount} duplicate(s): hunch review --reject-duplicates`);
        }
        console.log(`\nAccept: hunch review --accept <id>   Reject: hunch review --reject <id>`);
      }
    }
    store.close();
  });

// ---- auto-review (harness-driven triage) ----------------------------------
/** One line per plan entry. */
function printAutoEntry(e: AutoReviewEntry): void {
  console.log(`  ${e.d.id}  ${e.d.title.slice(0, 66)}\n      ${dim(e.reason)}`);
}

program
  .command("auto-review")
  .description("Harness-driven draft triage: delegate relevance to the coding-assistant CLI, then dedup, auto-confirm the verified+relevant, and delete duplicates/irrelevant. Dry-run unless --apply.")
  .option("--apply", "execute the plan (accept/delete). Without it, print the plan and change nothing.")
  .option("--min-grounded <n>", "grounded-ness threshold for the auto-accept gate", String(READY_MIN_GROUNDED))
  .option("--min-reject-confidence <n>", "minimum harness confidence to DELETE an irrelevant draft (else kept for a human)", "0.7")
  .option("--no-llm", "skip the harness judgment (dedup + grounding only — no relevance deletion)")
  .action(async (opts: { apply?: boolean; minGrounded?: string; minRejectConfidence?: string; llm?: boolean }) => {
    const { store, root } = storeFor();
    try {
      const minGrounded = Number.isFinite(Number(opts.minGrounded)) ? Number(opts.minGrounded) : READY_MIN_GROUNDED;
      const minRejectConfidence = Number.isFinite(Number(opts.minRejectConfidence)) ? Number(opts.minRejectConfidence) : 0.7;
      const all = store.json.loadAll("decisions");
      // Same draft set `hunch review` / `hunch status` triage.
      const drafts = all.filter((d) => d.status === "proposed" || d.provenance.confidence < 0.6);
      if (!drafts.length) { console.log("✓ No drafts to auto-review."); return; }

      // Delegate relevance to the harness (subscription CLI) — feature-detected,
      // and any per-draft failure degrades to "not judged" (kept for a human).
      const verdicts = new Map<string, RelevanceVerdict>();
      if (opts.llm !== false) {
        const provider = await selectProvider();
        if (provider.judgeDraft) {
          // The candidate pool for duplicate_of / restatement: the LIVE, vouched records.
          const existing: ExistingDecisionRef[] = all
            .filter((d) => d.provenance.source.includes("human_confirmed") && d.status !== "superseded" && d.status !== "rejected")
            .map((d) => ({ id: d.id, title: d.title, decision: d.decision }));
          console.log(`Judging ${drafts.length} draft(s) via ${provider.name} (subscription)…`);
          for (const d of drafts) {
            try {
              verdicts.set(d.id, await provider.judgeDraft(d, existing.filter((e) => e.id !== d.id)));
            } catch {
              /* transient / unparseable — leave unjudged, planner keeps it for a human */
            }
          }
        } else {
          console.log(dim("No subscription CLI available — relevance judgment skipped (dedup + grounding only)."));
        }
      }

      const plan = planAutoReview(drafts, all, verdicts, { minGrounded, minRejectConfidence });
      printAutoReviewPlan(plan);

      if (!opts.apply) {
        const n = planMutations(plan);
        console.log(`\n${dim(`Dry run — nothing changed. Re-run with --apply to ${n ? `apply ${n} change(s)` : "confirm (no changes)"}.`)}`);
        return;
      }

      // Apply: accept the verified+relevant, delete duplicates + irrelevant.
      let accepted = 0, deleted = 0, armedTotal = 0;
      for (const e of plan.accept) { armedTotal += acceptDecision(store, e.d).armed; accepted++; }
      for (const e of [...plan.rejectDuplicate, ...plan.rejectIrrelevant]) { if (store.json.delete("decisions", e.d.id)) deleted++; }
      if (accepted || deleted) {
        store.reindex();
        if (accepted) refreshExistingGrounding(root, store); // confirmations must reach every assistant's grounding
      }
      console.log(`\n✓ auto-review applied: ${accepted} accepted${armedTotal ? ` (${armedTotal} tripwire(s) now blocking)` : ""}, ${deleted} deleted, ${plan.keep.length} kept for review.`);
    } finally {
      store.close();
    }
  });

/** Print the four buckets of an auto-review plan (skipping empty ones). */
function printAutoReviewPlan(plan: AutoReviewPlan): void {
  if (plan.accept.length) { console.log(`\n✓ ACCEPT — verified, grounded, harness-relevant (${plan.accept.length}):`); plan.accept.forEach(printAutoEntry); }
  if (plan.rejectDuplicate.length) { console.log(`\n✗ DELETE (duplicate) — restates an accepted record (${plan.rejectDuplicate.length}):`); plan.rejectDuplicate.forEach(printAutoEntry); }
  if (plan.rejectIrrelevant.length) { console.log(`\n✗ DELETE (irrelevant) — harness judged not worth keeping (${plan.rejectIrrelevant.length}):`); plan.rejectIrrelevant.forEach(printAutoEntry); }
  if (plan.keep.length) { console.log(`\n⏳ KEEP for human review (${plan.keep.length}):`); plan.keep.forEach(printAutoEntry); }
}

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

// ---- reconcile-topics (decision-grounding §4 Enforcement) -----------------
program
  .command("reconcile-topics")
  .description("Find topics with more than one live decision (the invariant a git merge can violate) and surface them for human resolution. Exits non-zero if any collision exists — wire into a post-merge hook or CI.")
  .action(() => {
    const { store } = storeFor();
    try {
      const collisions = topicCollisions(store.recs("decisions"));
      if (collisions.size === 0) {
        console.log("✓ No topic collisions — every topic has at most one live decision.");
        return;
      }
      console.error(`⚠ ${collisions.size} topic(s) have more than one live decision — the graph cannot say which is current. Resolve each (supersede one, or split the topic):\n`);
      for (const [topic, decs] of collisions) {
        console.error(`  topic "${topic}":`);
        for (const d of decs) console.error(`    - ${d.id} — "${d.title}" (${d.status})`);
      }
      console.error(`\nResolve: re-record one with supersedes:<other-id> to link it over the other, or give one a distinct topic to split.`);
      process.exitCode = 1;
    } finally {
      store.close();
    }
  });

// ---- drift (doc≠graph detector; advisory + CI-gateable) -------------------
program
  .command("drift")
  .description("Detect memory drift: dead refs, dangling supersedes, stale 'proposed' docs, doc≠graph anchor-stale (a file still anchored to a superseded decision), and markdown sections whose <!-- hunch:topic … dec_id --> pin points at a superseded or missing decision (AGENTS.md/CLAUDE.md as a drift surface). Exits non-zero on any anchor-stale drift or topic collision — the doc≠graph gate.")
  .action(() => {
    const { store, root } = storeFor();
    try {
      const { findings } = computeDrift(store, root);
      const collisions = topicCollisions(store.recs("decisions"));
      if (!findings.length && collisions.size === 0) {
        console.log("✓ No drift — memory is in sync with the code/docs.");
        return;
      }
      for (const f of findings.slice(0, 50)) console.log(`· [${f.kind}] ${f.id} — ${f.detail}`);
      for (const [topic, decs] of collisions) console.log(`· [topic-collision] "${topic}" has ${decs.length} live decisions: ${decs.map((d) => d.id).join(", ")} — run \`hunch reconcile-topics\``);
      const anchor = findings.filter((f) => f.kind === "anchor-stale" || f.kind === "doc-anchor-stale").length;
      console.log(`\n${findings.length} finding(s)${anchor ? `, ${anchor} doc≠graph (anchor-stale)` : ""}${collisions.size ? `, ${collisions.size} topic-collision(s)` : ""}.`);
      if (anchor || collisions.size) process.exitCode = 1;
    } finally {
      store.close();
    }
  });

// ---- path (shortest dependency chain) --------------------------------------
program
  .command("path")
  .description("Shortest dependency path between two symbols/files/components — 'how does A reach B?'. Walks call/import/dependency/contains edges in either direction. Read-only.")
  .argument("<from>", "symbol id/name or file path")
  .argument("<to>", "symbol id/name or file path")
  .option("--max-depth <n>", "maximum hops to search", "8")
  .action((from: string, to: string, opts: { maxDepth: string }) => {
    const { store } = storeFor();
    try {
      store.reindex(); // reflect out-of-band JSON edits before walking the graph
      const A = store.resolveNodeIds(from);
      const B = store.resolveNodeIds(to);
      if (!A.length) return fail(`"${from}" resolves to no indexed symbol/component (run \`hunch index\`?).`);
      if (!B.length) return fail(`"${to}" resolves to no indexed symbol/component.`);
      let best: Array<{ id: string; via: string }> | null = null;
      for (const a of A.slice(0, 4)) {
        for (const b of B.slice(0, 4)) {
          const p = store.shortestPath(a, b, Number(opts.maxDepth) || 8);
          if (p && (!best || p.length < best.length)) best = p;
        }
      }
      if (!best) {
        console.log(`No path between "${from}" and "${to}" within ${opts.maxDepth} hop(s).`);
        process.exitCode = 1;
        return;
      }
      const last = best.length - 1;
      console.log(`${last} hop(s):`);
      best.forEach((n, i) => console.log(`  ${i === 0 ? "┌" : i === last ? "└" : "├"} ${n.via}${n.via === n.id ? "" : `  (${n.id})`}`));
    } finally {
      store.close();
    }
  });

// ---- structure (graph-served orientation — the anti-grep) -------------------
program
  .command("structure")
  .description("The indexed shape of the repo, a directory, a file, or a symbol — orient from the graph instead of grep rounds. No target: repo map. Read-only.")
  .argument("[target]", "a directory, file path, or exact symbol name (omit for the repo map)")
  .action((target: string | undefined) => {
    const { store } = storeFor();
    try {
      store.reindex(); // reflect out-of-band JSON edits before reading the graph
      console.log(formatStructure(store.structure(target)));
    } finally {
      store.close();
    }
  });

// ---- impact (PR impact — read-only, advisory) ------------------------------
program
  .command("impact")
  .description("PR impact: the dependency + memory surface of a change — dependent files reached, invariants direct/near, and the decisions concerned. Read-only, advisory (gating is `hunch check`). Omit base and --commit to inspect staged changes.")
  .argument("[base]", "diff against this base ref (e.g. origin/main) for a branch/PR")
  .option("--commit <sha>", "impact of a single commit")
  .action((base: string | undefined, opts: { commit?: string }) => {
    const { store, root } = storeFor();
    try {
      if (base && opts.commit) return fail("Pass at most one of [base] / --commit.");
      if (base && !revExists(base, root)) return fail(`base ref "${base}" does not resolve.`);
      if (opts.commit && !revExists(opts.commit, root)) return fail(`commit "${opts.commit}" does not resolve.`);
      store.reindex(); // reflect out-of-band JSON edits before reading the graph
      const files = opts.commit ? commitFiles(opts.commit, root) : base ? rangeFiles(base, root) : stagedFiles(root);
      const scope = opts.commit ? `commit ${opts.commit}` : base ? `${base}..HEAD` : "staged changes";
      if (!files.length) {
        console.log(`No changed files in ${scope}.`);
        return;
      }
      const diff = opts.commit ? commitDiff(opts.commit, root) : base ? rangeDiff(base, root) : stagedDiff(root);
      console.log(renderImpact(store.prImpact(files, diff), scope));
    } finally {
      store.close();
    }
  });

// ---- wiki (generated component wiki — a derived VIEW of the graph) ----------
program
  .command("wiki")
  .description("Generate a component wiki from the graph — pages are a derived VIEW (the graph stays the source of truth), pinned with hunch:topic anchors and freshness-hashed into a wiki-manifest. Stale pages surface as wiki-stale in `hunch drift`; --heal regenerates ONLY those. Prose via a subscription CLI when available; deterministic template otherwise. Default: PUBLIC-store records only, written to <repo>/wiki/. With --private: the FULL graph (overlay included), written into the private overlay repo — never committed here.")
  .option("--dir <dir>", "output directory (default: wiki/, or the manifest's dir once adopted)")
  .option("--heal", "regenerate only new/stale pages (manifest hash mismatch) and remove orphans")
  .option("--check", "report stale pages and exit non-zero (CI gate); writes nothing")
  .option("--no-llm", "skip LLM prose; deterministic template pages only")
  .option("--prose-heal", "also LLM-rewrite each adopted copy's reconciled overview (subscription; the deterministic corrections always remain)")
  .option("--private", "render the FULL graph (private overlay included) and write the wiki into the OVERLAY repo — nothing lands in this repo")
  .action(async (opts: { dir?: string; heal?: boolean; check?: boolean; llm?: boolean; proseHeal?: boolean; private?: boolean }) => {
    const { store, root } = storeFor();
    try {
      store.reindex(); // reflect out-of-band JSON edits before reading the graph
      // The home pairs source with destination: overlay-inclusive reads may only
      // ever land in the overlay repo (a committed public page is a leak surface).
      const home = opts.private ? privateHome(store, opts.dir) : publicHome(root, opts.dir);
      if (!home) return fail("no private overlay configured — run `hunch private` (or `hunch shared`) first.");
      // A union-fed wiki must never land inside the public work tree: refuse the
      // degenerate overlay layout where the overlay's parent IS this repo's root.
      if (home.kind === "private" && resolve(home.pagesRoot) === resolve(root)) {
        return fail("the private overlay resolves directly under this repo's root — a private wiki here would land in the committed tree. Point the overlay at its own directory (e.g. .hunch-private/.hunch) and re-run.");
      }
      const manifest = readWikiManifestAt(home.manifestPath);
      // A wiki lives where its manifest says; a different --dir would strand the
      // old directory (its pages aren't orphans — their components are live).
      if (manifest && opts.dir && manifest.dir !== opts.dir) {
        return fail(`wiki already adopted at "${manifest.dir}/" — omit --dir (or delete ${manifest.dir}/ and the wiki manifest first, then re-run with --dir ${opts.dir}).`);
      }
      // CI-safe: checking a repo that never adopted a wiki is a no-op, not a failure.
      if (opts.check && !manifest) {
        console.log("✓ No wiki adopted here (no wiki manifest) — nothing to check.");
        return;
      }
      const status = wikiStatus(store, home, root);
      const healHint = `hunch wiki --heal${home.kind === "private" ? " --private" : ""}`;

      if (opts.check) {
        const stale = status.entries.filter((e) => e.state !== "fresh");
        const staleAdoptions = status.adoptions.filter((a) => a.state !== "fresh");
        const specsStale = status.specs.state !== "fresh";
        const indexStale = status.index.state !== "fresh";
        const orphanCount = status.orphans.length + status.adoptionOrphans.length;
        if (!stale.length && !staleAdoptions.length && !specsStale && !indexStale && !orphanCount) {
          console.log(`✓ Wiki is fresh — ${status.entries.length + status.adoptions.length + 2} page(s) match the graph and the doc ledger.`);
          return;
        }
        for (const e of stale) console.log(`· ${e.page} — ${e.state === "new" ? "no page generated yet" : e.reason}`);
        for (const a of staleAdoptions) console.log(`· ${a.page} — ${a.state === "new" ? `stale doc "${a.doc.rel}" awaits adoption` : `adopted copy of "${a.doc.rel}" out of date`}`);
        if (specsStale) console.log(`· ${status.specs.page} — the repo's doc freshness snapshot changed`);
        if (indexStale) console.log(`· ${status.index.page} — the index's inputs moved`);
        for (const p of status.adoptionOrphans) console.log(`· ${p} — original healed or removed; copy retires`);
        for (const p of status.orphans) console.log(`· ${p} — no current artifact claims this page`);
        console.log(`\n${stale.length + staleAdoptions.length + (specsStale ? 1 : 0) + (indexStale ? 1 : 0) + orphanCount} stale page(s) — run \`${healHint}\`.`);
        process.exitCode = 1;
        return;
      }

      // An empty graph still needs --heal reachable for orphan/adoption cleanup —
      // only a plain generate demands components (a broken drift↔heal loop
      // otherwise: drift says "remove with --heal", --heal refuses to run).
      if (!status.entries.length && !opts.heal) return fail("no active components in the graph — run `hunch index` first.");

      // Prose is optional garnish on the deterministic skeleton: subscription CLI
      // only (same rule as synthesis), feature-detected, and any failure degrades
      // to a template page — generation never depends on a model being present.
      if (opts.proseHeal && opts.llm === false) return fail("--prose-heal needs the LLM — drop --no-llm.");
      let prose: ((pack: WikiPack, excerpts: string) => Promise<string | null>) | undefined;
      let adoptionProse: ((doc: Parameters<typeof adoptProsePrompt>[0], content: string) => Promise<string | null>) | undefined;
      if (opts.llm !== false) {
        const provider = await selectProvider();
        if (provider.draftProse) {
          console.log(`Prose via ${provider.name} (subscription); the drift-bearing skeleton stays deterministic.`);
          prose = (pack, excerpts) => provider.draftProse!(wikiPrompt(pack, excerpts));
          if (opts.proseHeal) adoptionProse = (doc, content) => provider.draftProse!(adoptProsePrompt(doc, content, status.decisions));
        } else {
          console.log(`No subscription CLI available — deterministic template pages${opts.proseHeal ? " (prose-heal skipped)" : ""}.`);
        }
      }

      const res = await generateWiki(store, root, home, {
        now: new Date().toISOString(),
        only: opts.heal ? "stale" : "all",
        prose,
        adoptionProse,
        log: (l) => console.log(l),
      });
      if (!res.written.length && !res.removed.length) {
        console.log(`✓ Nothing to regenerate — ${res.unchanged} page(s) already fresh.`);
        return;
      }
      const dest = home.kind === "private" ? `${join(home.pagesRoot, home.dir)} (private overlay repo — NOT committed here)` : `${home.dir}/`;
      console.log(
        `\n✓ ${res.written.length} page(s) written${res.removed.length ? `, ${res.removed.length} orphan(s) removed` : ""}${res.unchanged ? `, ${res.unchanged} fresh page(s) untouched` : ""} → ${dest}`,
      );
      // Committed grounding docs advertise the PUBLIC wiki only — they must not
      // reveal that (or what) a private overlay wiki exists.
      if (home.kind === "public") refreshExistingGrounding(root, store);
    } finally {
      store.close();
    }
  });

// ---- now (the hot view: recent activity + roadmap) --------------------------
program
  .command("now")
  .description("The hot view — last decisions recorded (any status) and the ROADMAP: every live PROPOSED decision. Record what's next as a proposed decision; shipping it (accept/supersede) removes it here automatically. Same data as the wiki's now.md page. Read-only.")
  .option("--private", "include the private overlay (union) — local terminal output only")
  .option("--recent <n>", "how many recent decisions to show", "10")
  .action((opts: { private?: boolean; recent: string }) => {
    const { store } = storeFor();
    try {
      if (opts.private && !store.hasPrivate) return fail("no private overlay configured — run `hunch private` (or `hunch shared`) first.");
      const decisions = opts.private ? store.recs("decisions") : store.json.loadAll("decisions");
      const { recent, roadmap, pendingReview } = nowData(decisions, Number(opts.recent) || 10);
      console.log(`🔥 Recent (${recent.length})${opts.private ? " — union incl. private overlay; do not paste publicly" : ""}:`);
      for (const r of recent) console.log(`  ${r.date}  [${r.status}] ${r.title}  (${r.id}${r.topic ? `, ${r.topic}` : ""})`);
      console.log(`\n🗺 Roadmap — live proposed decisions (${roadmap.length}):`);
      if (!roadmap.length) console.log("  (empty — record what's next as a PROPOSED decision via /capture and it appears here)");
      for (const r of roadmap) console.log(`  • ${r.title}  (${r.id}${r.topic ? `, ${r.topic}` : ""}, since ${r.date})\n      ${r.note}`);
      if (pendingReview > 0) console.log(`\n  (${pendingReview} auto-drafted proposal(s) awaiting review — \`hunch review\`)`);
    } finally {
      store.close();
    }
  });

// ---- heal (decision-grounded drift reconciliation front door) -------------
program
  .command("heal")
  .description("Drift reconciliation front door: every `hunch drift` finding with its next action — doc≠graph anchor-stale (reconcile toward the current decision), dead refs, dangling supersedes, stale 'proposed' docs. Read-only — proposes, never rewrites. Escalate to /capture only if the DECISION (not the doc) is stale.")
  .action(() => {
    const { store, root } = storeFor();
    try {
      const findings = computeDrift(store, root).findings;
      if (!findings.length) {
        console.log("✓ No drift to heal — memory matches the code and docs.");
        return;
      }
      // Every drift kind heals here — `hunch drift` reporting N findings while heal
      // says "nothing to heal" reads as a broken loop (bug_drift_heal_asymmetry).
      const kind = (k: string) => findings.filter((f) => f.kind === k);
      const anchor = kind("anchor-stale");
      if (anchor.length) {
        console.log(`${anchor.length} anchored section(s) drifted from the graph (doc≠graph):\n`);
        for (const f of anchor) console.log(`· ${f.detail}`);
        console.log(`\nHeal A (doc stale): edit each file to match its CURRENT decision — a prose fix.`);
        console.log(`Heal B (decision stale): only if the DECISION is wrong now, run /capture (hunch_capture_decision) to supersede it, then re-derive the doc.\n`);
      }
      const docAnchor = [...kind("doc-anchor-stale"), ...kind("doc-anchor-dangling")];
      if (docAnchor.length) {
        console.log(`${docAnchor.length} markdown section(s) drifted from the graph (prose≠graph):\n`);
        for (const f of docAnchor) console.log(`· ${f.id} — ${f.detail}`);
        console.log(`\nHeal: edit the prose to match the CURRENT decision, then update the pin in the <!-- hunch:topic … --> marker to its id. If the DECISION is what's wrong, run /capture to supersede it first.\n`);
      }
      const dead = kind("dead-ref");
      if (dead.length) {
        console.log(`${dead.length} dead reference(s) — an in-force decision points at a file that no longer exists:\n`);
        for (const f of dead) console.log(`· ${f.id} — ${f.detail}`);
        console.log(`\nHeal: update the decision's related_files to the file's new location — or supersede the decision if it no longer applies.\n`);
      }
      const dangling = kind("supersede");
      if (dangling.length) {
        console.log(`${dangling.length} dangling supersede(s) — the old decision was never properly closed:\n`);
        for (const f of dangling) console.log(`· ${f.id} — ${f.detail}`);
        console.log(`\nHeal: run \`hunch supersede <old> --by <new>\` to close the window and link them.\n`);
      }
      const docStale = kind("doc-stale");
      if (docStale.length) {
        console.log(`${docStale.length} stale doc(s) — still marked proposed/not-implemented but the code shipped:\n`);
        for (const f of docStale) console.log(`· ${f.id} — ${f.detail}`);
        console.log(`\nHeal: update the doc's status marker to match reality.\n`);
      }
      const wikiStale = kind("wiki-stale");
      if (wikiStale.length) {
        console.log(`${wikiStale.length} generated wiki page(s) drifted from the graph:\n`);
        for (const f of wikiStale) console.log(`· ${f.id} — ${f.detail}`);
        console.log(`\nHeal: run \`hunch wiki --heal\` — regenerates only the stale pages (the wiki is a derived view; never edit it by hand).\n`);
      }
      console.log(`Hunch never rewrites prose for you; this is a read-only reconciliation report.`);
    } finally {
      store.close();
    }
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
      refreshExistingGrounding(root, store); // removing records must reach EVERY assistant's grounding
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
    // Overlay status speaks the TRUE mode, and a dead pointer is a loud finding, not a
    // silent empty store: the JSON reader degrades to [] when the target dir is missing,
    // so this is the one place the loss is visible.
    if (store.privateDir && !existsSync(store.privateDir)) {
      console.log(`overlay:    ⛔ POINTER IS DEAD → ${store.privateDir} does not exist — shared/private memory is NOT being read.`);
      console.log(`            fix: re-run \`hunch ${store.mode === "shared" ? "shared" : "private"} --repo <url>\` (or restore the directory); the pointer lives in .hunch/local.json / the git common dir`);
    } else if (store.privateDir) {
      console.log(store.mode === "shared"
        ? `shared:     on → ${store.privateDir} (UNIFIED — every capture routes here; one source of truth across branches, worktrees, teammates, agents)`
        : `private:    on → ${store.privateDir} (local overlay — unioned into queries; never committed or posted publicly)`);
    } else {
      const team = readTeamConfig(root);
      console.log(team
        ? `overlay:    off, but .hunch/team.json advertises the team store (${team.shared_repo}) — run \`hunch init\` to auto-connect`
        : dim(`private:    off — run \`hunch shared\` (or \`hunch private\`) to use one overlay repo across teammates/worktrees (or set HUNCH_PRIVATE_DIR)`));
    }
    // Worktree posture: linked worktrees share ONE memory via the git common dir. Only
    // surfaced in a linked worktree (no noise in a normal single checkout), so a
    // "memory missing here" symptom has an obvious cause + fix.
    if (isLinkedWorktree(root)) {
      const common = gitCommonDir(root);
      const sharedPtr = !!common && existsSync(join(common, "hunch", "local.json"));
      console.log(store.privateDir
        ? `worktree:   linked — sharing the repo's memory${sharedPtr ? " via the git common dir" : ""}`
        : dim(`worktree:   linked, but no overlay resolved here — run \`hunch shared\` (or \`hunch private\`) once (any worktree) so all worktrees share it`));
    }
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
    // Memory drift: deterministic, advisory smoke detector for memory that has
    // fallen out of sync with the code/docs (dead file refs, dangling supersedes,
    // docs still marked "proposed"). Never blocks; never auto-fixes.
    const drift = computeDrift(store, root);
    if (drift.findings.length) {
      console.log(`drift:      ⚠ ${drift.findings.length} finding(s) — memory may be out of sync with the code:`);
      for (const f of drift.findings.slice(0, 20)) console.log(`              · [${f.kind}] ${f.id} — ${f.detail}`);
      if (drift.findings.length > 20) console.log(dim(`              … and ${drift.findings.length - 20} more`));
    } else {
      console.log(`drift:      ✓ no stale refs, dangling supersedes, or stale "proposed" docs`);
    }
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
/** realpath a path even if it doesn't exist yet (a new file an agent is about to
 *  Write): resolve the longest existing ancestor, then re-append the missing tail.
 *  Idempotent on already-resolved paths. */
function realpathNorm(p: string): string {
  try {
    return realpathSync.native(p);
  } catch {
    const parent = dirname(p);
    if (parent === p) return p; // hit the root; nothing more to resolve
    return join(realpathNorm(parent), basename(p));
  }
}

/** Repo-relative POSIX path. BOTH ends are realpath-normalized first: on macOS
 *  `process.cwd()` (hence findRoot) resolves /var→/private/var, but a hook event's
 *  file_path arrives UN-resolved — so a naive relative() yields a bogus "../" path
 *  under any symlinked root (/var, /tmp, symlinked $HOME) and the caller treats the
 *  file as outside the repo, silently dropping all context (dec_e0a36efbf5). */
function toRepoRel(root: string, abs: string): string {
  return relative(realpathNorm(root), realpathNorm(abs)).split("\\").join("/");
}

function emitContext(event: "PreToolUse" | "UserPromptSubmit" | "SessionStart", text: string): void {
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
