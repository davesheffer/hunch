/**
 * `hunch ui` history: every commit that changed a decision, rule, bug or finding, read from
 * git in each home that holds them (the code repo's `.hunch/`, and the private overlay repo
 * when there is one). Read-only, and nothing is inferred: a move is what git recorded, and
 * "pushed" means a remote-tracking branch has the commit.
 */
import { realpathSync } from "node:fs";
import { basename, dirname } from "node:path";
import { parseMemoryLog, type MemoryMoveKind } from "../core/memorylog.js";
import { gitMemoryLog, gitUnpushedMemoryShas } from "../extractors/git.js";
import type { MemoryHome } from "../integrations/sync.js";

/** The record directories the Memory page shows; task, workspace and index commits are not memory moves. */
const RECORD_DIRS = ["decisions", "constraints", "bugs", "findings"] as const;

export interface HistorySource {
  home: MemoryHome;
  /** The memory directory itself (`<root>/.hunch`, or the overlay's). Its parent is the repo it commits to. */
  hunchDir: string;
  /** The repo's GitHub page, for commit links; null when it is not on GitHub. */
  webUrl: string | null;
}

export interface HistoryEntry {
  sha: string;
  shortSha: string;
  date: string;
  subject: string;
  kind: MemoryMoveKind;
  home: MemoryHome;
  /** A remote-tracking branch has this commit. */
  pushed: boolean;
  /** The commit on GitHub; null until it is pushed, or when the repo is not on GitHub. */
  url: string | null;
  /** The memories it changed; title null when the record is gone from the store. */
  memories: { id: string; title: string | null; components: string[] }[];
}

/** The overlay may be a symlink to its own repo; git must run where the commits are. */
function physical(dir: string): string {
  try { return realpathSync(dir); } catch { return dir; }
}

/** Newest first across homes, at most `limit`. With `id`, only that record's own commits.
 *  `id` must already be a plain record id: it is placed into a git pathspec. */
export function memoryHistory(sources: readonly HistorySource[], opts: { limit: number; id?: string }, titles: ReadonlyMap<string, string>, components: ReadonlyMap<string, readonly string[]> = new Map()): HistoryEntry[] {
  const out: HistoryEntry[] = [];
  for (const src of sources) {
    const dir = physical(src.hunchDir);
    const repo = dirname(dir), name = basename(dir);
    const specs = opts.id ? [`:(glob)${name}/*/${opts.id}.json`] : RECORD_DIRS.map((d) => `${name}/${d}/`);
    const moves = parseMemoryLog(gitMemoryLog(repo, opts.limit, specs), name);
    if (!moves.length) continue;
    const unpushed = gitUnpushedMemoryShas(repo, opts.limit, specs);
    for (const m of moves) {
      const pushed = !unpushed.has(m.sha);
      out.push({
        sha: m.sha, shortSha: m.shortSha, date: m.date, subject: m.subject, kind: m.kind, home: src.home, pushed,
        url: pushed && src.webUrl ? `${src.webUrl}/commit/${m.sha}` : null,
        memories: [...new Set([...m.decisionIds, ...m.otherIds])].map((id) => ({ id, title: titles.get(id) ?? null, components: [...(components.get(id) ?? [])] })),
      });
    }
  }
  return out.sort((a, b) => Date.parse(b.date) - Date.parse(a.date)).slice(0, opts.limit);
}
