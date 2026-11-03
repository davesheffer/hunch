/**
 * Failure-time recall: when a check fails, say so only if this exact failure
 * has been seen before. Always-on injection at a red test is net negative, so a
 * miss emits nothing. A hit is deterministic, never a similarity guess: the
 * failing test's own bug id (`hunch test` seeds one bug per test name), or a bug
 * whose title is the test name or whose title or symptom quotes it ("", '', ``).
 */
import { parseTestReport } from "../extractors/testreport.js";
import { bugId } from "./ids.js";
import type { Bug } from "./types.js";

/** Shorter names ("works", "parses input") match too much prose to count as a quote. */
const MIN_QUOTED_NAME = 16;
const MAX_RECALLED = 3;

export interface FailureRecall { text: string; bugs: string[] }

/** A bare substring of prose is not a quote: "returns an empty array" is inside many titles. */
function quotes(bug: Bug, name: string): boolean {
  if (bug.title.trim() === name) return true;
  const prose = `${bug.title}\n${bug.symptom}`;
  return [`"${name}"`, `'${name}'`, `\`${name}\``].some((q) => prose.includes(q));
}

/** `bugs` may be a loader so a failed command that is not a test run never opens the store. */
export function recallFailures(output: string, bugs: readonly Bug[] | (() => readonly Bug[]),
  alreadyRecalled: readonly string[] = []): FailureRecall {
  const report = parseTestReport(output);
  if (!report.failures.length) return { text: "", bugs: [] };
  const all = typeof bugs === "function" ? bugs() : bugs;
  const skip = new Set(alreadyRecalled);
  const byId = new Map(all.map((b) => [b.id, b]));
  const hits: { test: string; bug: Bug }[] = [];
  for (const failure of report.failures) {
    const own = byId.get(bugId(failure.test));
    const quoted = failure.test.length >= MIN_QUOTED_NAME
      ? all.filter((b) => b !== own && quotes(b, failure.test)) : [];
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
  const rest = hits.slice(MAX_RECALLED).map((h) => h.bug.id);
  const more = rest.length ? `\n(${rest.length} more: ${rest.join(", ")}; hunch_bug_lineage has them.)` : "";
  return {
    text: `Hunch: this failure has been seen before. Check the recorded cause before debugging from scratch; hunch_bug_lineage(<bug id>) has the full history.\n${lines.join("\n")}${more}`,
    // Named overflow counts as recalled too, so it does not resurface as new.
    bugs: hits.map((h) => h.bug.id),
  };
}

function clip(text: string, max = 240): string {
  const flat = text.replace(/\s+/g, " ").trim();
  return flat.length > max ? `${flat.slice(0, max - 1)}…` : flat;
}
