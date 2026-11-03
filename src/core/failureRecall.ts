/**
 * Failure-time recall: when a check fails, say so only if this exact failure
 * has been seen before. Always-on injection at a red test is net negative, so a
 * miss emits nothing. A hit is deterministic, never a similarity guess: the
 * failing test's own bug id (`hunch test` seeds one bug per test name), or a bug
 * whose title or symptom quotes the full test name.
 */
import { parseTestReport } from "../extractors/testreport.js";
import { bugId } from "./ids.js";
import type { Bug } from "./types.js";

/** Shorter names ("works", "parses input") match too much prose to count as a quote. */
const MIN_QUOTED_NAME = 16;
const MAX_RECALLED = 3;

export interface FailureRecall { text: string; bugs: string[] }

export function recallFailures(output: string, bugs: readonly Bug[], alreadyRecalled: readonly string[] = []): FailureRecall {
  const report = parseTestReport(output);
  if (!report.failures.length) return { text: "", bugs: [] };
  const skip = new Set(alreadyRecalled);
  const byId = new Map(bugs.map((b) => [b.id, b]));
  const hits: { test: string; bug: Bug }[] = [];
  for (const failure of report.failures) {
    const own = byId.get(bugId(failure.test));
    const quoted = failure.test.length >= MIN_QUOTED_NAME
      ? bugs.filter((b) => b !== own && `${b.title}\n${b.symptom}`.includes(failure.test)) : [];
    for (const bug of own ? [own, ...quoted] : quoted) {
      if (skip.has(bug.id)) continue;
      skip.add(bug.id);
      hits.push({ test: failure.test, bug });
    }
  }
  if (!hits.length) return { text: "", bugs: [] };
  const shown = hits.slice(0, MAX_RECALLED);
  const lines = shown.map(({ test, bug }) => {
    const fix = bug.lineage.fixed_commit ? `; fixed in ${bug.lineage.fixed_commit.slice(0, 8)}` : "";
    const cause = bug.root_cause.trim() ? ` Root cause: ${clip(bug.root_cause)}` : "";
    return `- "${clip(test, 120)}" matches ${bug.id} "${clip(bug.title, 120)}" (${bug.status}${fix}).${cause}`;
  });
  const more = hits.length > shown.length ? `\n(${hits.length - shown.length} more; hunch_bug_lineage has them.)` : "";
  return {
    text: `Hunch: this failure has been seen before. Check the recorded cause before debugging from scratch; hunch_bug_lineage(<bug id>) has the full history.\n${lines.join("\n")}${more}`,
    bugs: shown.map((h) => h.bug.id),
  };
}

function clip(text: string, max = 240): string {
  const flat = text.replace(/\s+/g, " ").trim();
  return flat.length > max ? `${flat.slice(0, max - 1)}…` : flat;
}
