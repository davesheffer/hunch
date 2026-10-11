/**
 * The deterministic runbook draft (`hunch runbook <range> --task`): the commits and files
 * of a range that describe the work, without Hunch's own bookkeeping (issue #425). With
 * auto-commit on, a range interleaves capture commits (`hunch: capture …`) whose files are
 * the store (.hunch/**) and the grounding docs flushCapture regenerates beside it.
 *
 * Same notion of "Hunch-owned" as sync (src/synthesis/synthesize.ts) and the task report
 * (src/core/taskTouched.ts): the store is never the work; a grounding doc is Hunch's when
 * it changed alongside the store, and the work's when a human edited it on its own.
 */
import { HUNCH_COMMIT_SUBJECT, HUNCH_MANAGED_FILES } from "./taskTouched.js";

/** Grounding docs that are wholly generated (no user text): never the work. */
const FULLY_MANAGED = new Set([".cursor/rules/hunch.mdc", ".windsurf/rules/hunch.md"]);
const STORE_SEGMENTS = new Set([".hunch", ".hunch-cache"]);

const norm = (p: string): string => p.replace(/\\/g, "/").replace(/^\.\//, "");
const isStore = (p: string): boolean => norm(p).split("/").some((s) => STORE_SEGMENTS.has(s));

export function runbookDraft(commits: readonly { subject: string; files: readonly string[] }[], rangeFiles: readonly string[]): { steps: string[]; files: string[] } {
  const steps: string[] = [];
  const workDocs = new Set<string>(); // grounding docs a non-capture commit edited on its own
  for (const c of commits) {
    if (HUNCH_COMMIT_SUBJECT.test(c.subject)) continue;
    const files = c.files.map(norm);
    const touchesStore = files.some(isStore);
    const work = files.filter((f) => !isStore(f) && !FULLY_MANAGED.has(f) && !(touchesStore && HUNCH_MANAGED_FILES.has(f)));
    if (files.length && !work.length) continue; // only Hunch's own paths
    steps.push(c.subject);
    for (const f of work) if (HUNCH_MANAGED_FILES.has(f)) workDocs.add(f);
  }
  const files = rangeFiles.filter((raw) => {
    const f = norm(raw);
    if (isStore(f) || FULLY_MANAGED.has(f)) return false;
    return !HUNCH_MANAGED_FILES.has(f) || workDocs.has(f);
  });
  return { steps, files };
}
