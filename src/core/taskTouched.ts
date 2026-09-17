/** Files the repository shows as worked on while a task was open.
 *
 * The pre-edit hook only sees edits made through an instrumented editor tool.
 * Work done from a shell (patch scripts, rebases, release commits) never
 * produced a delivery, so the task record had no file anchor for it and the
 * ranking could not relate the task to later work on the same files. Two
 * sources fill that gap, both bounded and fail-open (an error yields nothing,
 * never a failed finish):
 *  - commits authored by the configured git user whose commit time falls in
 *    the task window (merges excluded);
 *  - working-tree changes (modified, added, untracked) whose mtime falls in it,
 *    unless the caller knows another session shared the checkout (`workingTree:
 *    false`): mtimes cannot say whose edit it was, commits can.
 * Hunch's own work never counts as the task's: memory and cache paths, commits
 * Hunch makes (`hunch:` subjects — captures, task records, repairs), and the
 * grounding files a capture rewrites (CLAUDE.md, AGENTS.md, the host rule
 * files) when they merely changed in the working tree; a user commit that
 * edits one of those files still counts, as does a delivery that named it.
 * Deleted paths are skipped: nothing dates the deletion. Commit dates get one
 * second of slack (git keeps seconds); working-tree mtimes get none before
 * the start. */
import { execFileSync } from "node:child_process";
import { statSync } from "node:fs";
import { join } from "node:path";

const EXCLUDED_SEGMENTS = new Set([".hunch", ".hunch-cache", ".git"]);
/** Files Hunch regenerates on every capture (src/integrations/providers.ts,
 * claudemd.ts): a fresh mtime on them is the capture, not the task's work. */
export const HUNCH_MANAGED_FILES: ReadonlySet<string> = new Set(["CLAUDE.md", "AGENTS.md", ".cursor/rules/hunch.mdc", ".github/copilot-instructions.md", ".windsurf/rules/hunch.md"]);
/** Commit subjects Hunch writes itself. */
const HUNCH_COMMIT_SUBJECT = /^hunch:/i;

function gitDate(ms: number): string {
  // Second resolution, a format every git accepts.
  return `${new Date(ms).toISOString().slice(0, 19).replace("T", " ")} +0000`;
}

export function gitTouchedFiles(root: string, startedAt: string, finishedAt: string | null, options: { limit?: number; timeoutMs?: number; now?: number; workingTree?: boolean } = {}): string[] {
  const limit = Math.max(1, options.limit ?? 64);
  const timeout = options.timeoutMs ?? 3_000;
  const since = Date.parse(startedAt);
  if (!Number.isFinite(since)) return [];
  const until = finishedAt ? Date.parse(finishedAt) : (options.now ?? Date.now());
  if (!Number.isFinite(until) || until < since) return [];
  // One second of slack on each side: git dates and some filesystems are second-granular.
  const from = since - 1_000, to = until + 1_000;
  const env: NodeJS.ProcessEnv = { ...process.env, GIT_OPTIONAL_LOCKS: "0" };
  for (const key of Object.keys(env)) if (key.startsWith("GIT_") && key !== "GIT_OPTIONAL_LOCKS") delete env[key];
  const run = (args: string[]): string => execFileSync("git", ["-C", root, "-c", "core.quotePath=false", ...args], { env, encoding: "utf8", timeout, maxBuffer: 4_000_000, stdio: ["ignore", "pipe", "ignore"] });
  const out = new Set<string>();
  const normalize = (raw: string): string => raw.trim().replace(/\\/g, "/").replace(/^\.\//, "");
  const keep = (raw: string): void => {
    const path = normalize(raw);
    if (!path || path.split("/").some((segment) => EXCLUDED_SEGMENTS.has(segment))) return;
    out.add(path);
  };
  try {
    const email = run(["config", "--get", "user.email"]).trim();
    if (email) {
      // One record per commit: a separator, the subject, then the paths.
      const log = run(["log", "--no-merges", "-n", "50", `--since=${gitDate(from)}`, `--until=${gitDate(to)}`, `--author=${email}`, "--format=%x1e%s", "--name-only"]);
      for (const block of log.split("\x1e")) {
        const [subject = "", ...paths] = block.split("\n");
        if (HUNCH_COMMIT_SUBJECT.test(subject.trim())) continue;
        for (const line of paths) keep(line);
      }
    }
  } catch { /* no commits, no git user, or no git: the working tree may still say something */ }
  if (options.workingTree === false) return [...out].sort().slice(0, limit);
  try {
    const entries = run(["status", "--porcelain=v1", "-z", "--untracked-files=all"]).split("\0").filter(Boolean);
    for (let i = 0; i < entries.length; i++) {
      const entry = entries[i]!;
      const code = entry.slice(0, 2), path = entry.slice(3);
      // A rename or copy is followed by its original path as a separate entry.
      if (code[0] === "R" || code[0] === "C") i++;
      if (code.includes("D") || !path || HUNCH_MANAGED_FILES.has(normalize(path))) continue;
      try {
        const mtime = statSync(join(root, path)).mtimeMs;
        if (mtime >= since && mtime <= to) keep(path);
      } catch { /* vanished between status and stat */ }
    }
  } catch { /* not a git worktree or status failed: nothing to add */ }
  return [...out].sort().slice(0, limit);
}
