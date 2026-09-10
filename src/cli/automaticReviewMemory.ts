import type { Command } from "commander";
import { execFileSync } from "node:child_process";
import { existsSync, readFileSync, realpathSync, statSync } from "node:fs";
import { isAbsolute, relative, resolve } from "node:path";
import { canonicalHash } from "../constitution/canonical.js";
import { automateReviewMemory } from "../core/automaticReviewMemory.js";
import { prepareReviewMemory, validateReviewPacket } from "../core/reviewMemory.js";
import { writeFileAtomic } from "../core/io.js";
import type { Constraint } from "../core/types.js";
import { chooseReviewGenerator } from "./reviewMemoryProvider.js";
import { z } from "zod";

const cacheSchema = z.object({ schema: z.literal("hunch.review-memory-cache/1"), repository: z.string(),
  provider: z.string(), memory_hash: z.string(), entries: z.array(z.object({
    candidate_id: z.string(), evidence_hash: z.string(), file: z.string(),
    status: z.enum(["ready", "saved", "skipped", "review", "deferred"]), reason: z.string().max(4000),
    code_hash: z.string().optional(), rule_id: z.string().optional(), cached: z.boolean().optional(), retryable: z.boolean().optional(),
  })).max(10000),
});

export interface ReviewMemoryContext { root: string; existing: Constraint[] }

/** Only bounded tracked files inside this checkout may enter model context. */
export function readReviewCode(root: string, file: string): string {
  const base = realpathSync(root);
  const target = realpathSync(resolve(base, file));
  const rel = relative(base, target);
  if (!rel || rel === ".." || rel.startsWith("../") || rel.startsWith("..\\") || isAbsolute(rel)) {
    throw new Error("review file escapes checkout");
  }
  execFileSync("git", ["-C", base, "ls-files", "--error-unmatch", "--", file], { stdio: "pipe", timeout: 10000 });
  const stat = statSync(target);
  if (!stat.isFile() || stat.size > 64 * 1024) throw new Error("review file is not a bounded regular file");
  return readFileSync(target, "utf8");
}

export function registerAutomaticReviewMemory(command: Command,
  context: (repository: string, privateOnly?: boolean) => ReviewMemoryContext,
  capture: (records: Constraint[], repository: string, privateOnly: boolean) => void,
  chooseProvider: (root: string, configFile?: string, initiator?: string) => Promise<{ name: string; draftProse(prompt: string): Promise<string>; providersUsed?: () => string[] }> = chooseReviewGenerator): void {
  command.command("auto").requiredOption("--repository <owner/repo>", "GitHub repository matching this checkout")
    .option("--from <file>", "use local comments JSON or a prepared packet instead of fetching GitHub")
    .option("--limit <count>", "maximum new threads to analyze per run (1..100)", "20")
    .option("--dry-run", "analyze and report without saving rules")
    .option("--retry", "reanalyze cached skipped/review cases; captured rules are still preserved")
    .option("--cli-config <file>", "explicit local JSON adapters for additional stdin or ACP CLIs")
    .option("--initiator <name>", "agent that initiated this run; binds model calls to that CLI/account")
    .option("--private", "save in the configured private overlay")
    .option("--public", "allow generated rules and source links into repository-visible memory")
    .option("--output <file>", "also write the JSON report atomically to this path")
    .description("Automatically select, draft, verify and save advisory rules; uncertain cases stay in the JSON report")
    .action(async (opts: { repository: string; from?: string; limit: string; dryRun?: boolean;
      private?: boolean; public?: boolean; output?: string; retry?: boolean; cliConfig?: string; initiator?: string }) => {
      // Validate identifiers before they can enter an external command.
      prepareReviewMemory(opts.repository, []);
      const limit = Number(opts.limit);
      if (!Number.isInteger(limit) || limit < 1 || limit > 100) throw new Error("--limit must be 1..100");
      if ((opts.private && opts.public) || (!opts.dryRun && !opts.private && !opts.public)) {
        throw new Error("auto requires exactly one of --private or --public, or --dry-run");
      }
      const { root, existing } = context(opts.repository, !!opts.private);
      const provider = await chooseProvider(root, opts.cliConfig ?? process.env.HUNCH_REVIEW_CLI_CONFIG, opts.initiator);
      let input: unknown;
      if (opts.from) {
        if (statSync(opts.from).size > 16 * 1024 * 1024) throw new Error("review input exceeds 16 MiB");
        input = JSON.parse(readFileSync(opts.from, "utf8"));
      } else {
        // Fetch whole history so an updated reply cannot lose its parent. The analysis itself is bounded.
        input = JSON.parse(execFileSync("gh", ["api", "--paginate", "--slurp",
          `repos/${opts.repository}/pulls/comments?per_page=100`], {
          cwd: root, encoding: "utf8", timeout: 120000, maxBuffer: 16 * 1024 * 1024, windowsHide: true,
        }));
      }
      const packet = Array.isArray(input) ? prepareReviewMemory(opts.repository, input) : validateReviewPacket(input);
      if (packet.repository.toLowerCase() !== opts.repository.toLowerCase()) throw new Error("packet repository mismatch");
      // Local derived cache lives in Git's worktree administration directory, never the source tree.
      const cacheFile = resolve(root, execFileSync("git", ["-C", root, "rev-parse", "--git-path", "hunch-review-memory.json"],
        { encoding: "utf8", timeout: 10000 }).trim());
      let previous;
      if (!opts.retry && existsSync(cacheFile)) {
        try {
          if (statSync(cacheFile).size > 16 * 1024 * 1024) throw new Error("oversized cache");
          const cache = cacheSchema.parse(JSON.parse(readFileSync(cacheFile, "utf8")));
          if (cache.repository === packet.repository && cache.provider === provider.name && cache.memory_hash === canonicalHash(existing)) previous = cache.entries;
        } catch { console.error("[review-memory] Ignoring invalid derived cache; rebuilding from evidence."); }
      }
      const report = await automateReviewMemory({ packet, existing, limit, provider: provider.name,
        previous,
        providersUsed: provider.providersUsed,
        now: new Date().toISOString(), readCurrent: file => readReviewCode(root, file),
        generate: prompt => provider.draftProse!(prompt),
        progress: (id, position) => console.error(`[review-memory] ${position}/${limit}: ${id}`),
      });
      if (!opts.dryRun && report.rules.length) {
        const memoryUnchanged = canonicalHash(context(opts.repository, !!opts.private).existing) === canonicalHash(existing);
        // Long model calls must not save a judgment against code that has since changed.
        for (const entry of report.entries.filter(e => e.status === "ready")) {
          let unchanged = false;
          try { unchanged = canonicalHash(readReviewCode(root, entry.file)) === entry.code_hash; } catch { /* withhold */ }
          if (!unchanged || !memoryUnchanged) {
            entry.status = "review"; entry.reason = "Code or memory changed during analysis; run again against current context.";
            entry.retryable = true;
          }
        }
        report.rules = report.rules.filter(r => report.entries.some(e => e.status === "ready" && e.rule_id === r.id));
        if (report.rules.length) capture(report.rules, packet.repository, !!opts.private);
        for (const entry of report.entries) if (entry.status === "ready") entry.status = "saved";
      }
      report.applied = !opts.dryRun;
      if (!opts.dryRun) writeFileAtomic(cacheFile, JSON.stringify({ schema: "hunch.review-memory-cache/1",
        repository: packet.repository, provider: provider.name,
        memory_hash: canonicalHash(context(opts.repository, !!opts.private).existing), entries: report.entries }, null, 2) + "\n");
      const output = JSON.stringify(report, null, 2);
      if (opts.output) writeFileAtomic(resolve(opts.output), output + "\n");
      console.log(output);
    });
}
