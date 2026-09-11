import type { Command } from "commander";
import { readFileSync, statSync } from "node:fs";
import { prepareReviewMemory, compileReviewRules, validateReviewPacket } from "../core/reviewMemory.js";
import type { Constraint } from "../core/types.js";
import { registerAutomaticReviewMemory, type ReviewMemoryContext } from "./automaticReviewMemory.js";

function readJson(file: string): unknown {
  if (statSync(file).size > 16 * 1024 * 1024) throw new Error("review input exceeds 16 MiB");
  return JSON.parse(readFileSync(file, "utf8"));
}

export function registerReviewMemoryCommands(program: Command,
  capture: (records: Constraint[], repository: string, privateOnly: boolean) => void,
  context: (repository: string, privateOnly?: boolean) => ReviewMemoryContext): void {
  const command = program.command("review-memory").description("Turn sourced PR review threads into scoped review rules");
  registerAutomaticReviewMemory(command, context, capture);
  command.command("prepare").requiredOption("--from <file>", "GitHub REST review comments JSON")
    .requiredOption("--repository <owner/repo>", "repository that owns every comment")
    .description("Print a deterministic evidence packet; no rules are activated")
    .action((opts: { from: string; repository: string }) => {
      console.log(JSON.stringify(prepareReviewMemory(opts.repository, readJson(opts.from)), null, 2));
    });
  command.command("capture").requiredOption("--from <file>", "prepared evidence packet")
    .requiredOption("--rules <file>", "explicit selections: candidate_id, evidence_hash, rule, check")
    .option("--apply", "persist the previewed rules as advisory constraints")
    .option("--private", "keep rules and source links in the configured private overlay")
    .option("--public", "allow rules and source links into repository-visible memory")
    .description("Preview selected rules; --apply records them without blocking authority")
    .action((opts: { from: string; rules: string; apply?: boolean; private?: boolean; public?: boolean }) => {
      if (opts.apply && !!opts.private === !!opts.public) throw new Error("--apply requires exactly one of --private or --public");
      const packet = validateReviewPacket(readJson(opts.from));
      const records = compileReviewRules(packet, readJson(opts.rules), new Date().toISOString());
      if (opts.apply) capture(records, packet.repository, !!opts.private);
      console.log(JSON.stringify({ applied: !!opts.apply, authority: "advisory", rules: records }, null, 2));
    });
}
