/**
 * The memory-move timeline — the data behind `hunch log` and the VS Code "Hunch
 * Source Control" view. Every commit that touched `.hunch/` is one MOVE (a capture,
 * adoption, supersession, or prune), classified deterministically from git's own
 * name-status. Pure parsing — no LLM, no judgment — so the panel shows exactly what
 * git recorded and each move maps back to a real, revertable commit.
 *
 * The parser is split from the git shell-out (extractors/git.gitMemoryLog) so it is
 * unit-testable with canned `git log` output.
 */

export type MemoryMoveKind = "capture" | "adopt" | "supersede" | "prune" | "repair" | "edit";

/** One commit that changed the memory graph, ready to render as a timeline entry. */
export interface MemoryMove {
  sha: string;
  shortSha: string;
  /** committer date, ISO 8601. */
  date: string;
  subject: string;
  kind: MemoryMoveKind;
  /** decision ids (dec_*) this move touched — for the click-through popup. */
  decisionIds: string[];
  /** other record ids touched (bugs/constraints/components/policies). */
  otherIds: string[];
  added: number;
  modified: number;
  deleted: number;
  /** the `.hunch/` files this commit changed. */
  files: string[];
}

/** The record-header separator we ask `git log --format` to emit, so header lines
 *  are unambiguous against the name-status lines that follow each commit. */
export const MEMLOG_HEADER = "@@@";
/** The `--format` string that pairs with {@link parseMemoryLog}. */
export const MEMLOG_FORMAT = `${MEMLOG_HEADER}%H\t%h\t%cI\t%s`;

const ID_RE = /\/((?:dec|bug|con|cmp|pol)_[0-9a-f]+)\.json$/;

/** Parse `git log <MEMLOG_FORMAT> --name-status -- .hunch/` output into classified
 *  moves, newest first (git's order). */
export function parseMemoryLog(raw: string): MemoryMove[] {
  const moves: MemoryMove[] = [];
  let cur: MemoryMove | null = null;
  for (const line of raw.split("\n")) {
    if (line.startsWith(MEMLOG_HEADER)) {
      if (cur) moves.push(classify(cur));
      const f = line.slice(MEMLOG_HEADER.length).split("\t");
      cur = {
        sha: f[0] ?? "", shortSha: f[1] ?? "", date: f[2] ?? "", subject: f.slice(3).join("\t"),
        kind: "edit", decisionIds: [], otherIds: [], added: 0, modified: 0, deleted: 0, files: [],
      };
      continue;
    }
    if (!cur || !line.trim()) continue;
    // name-status: "A\tpath", "M\tpath", "D\tpath", or rename "R100\told\tnew".
    const parts = line.split("\t");
    const status = parts[0]?.[0];
    const path = parts[parts.length - 1];
    if (!path || !path.startsWith(".hunch/")) continue;
    cur.files.push(path);
    if (status === "A") cur.added++;
    else if (status === "D") cur.deleted++;
    else cur.modified++;
    const id = ID_RE.exec(path)?.[1];
    if (id) (id.startsWith("dec_") ? cur.decisionIds : cur.otherIds).push(id);
  }
  if (cur) moves.push(classify(cur));
  return moves;
}

/** Deterministic move kind from the subject + the add/modify/delete shape. */
function classify(m: MemoryMove): MemoryMove {
  const s = m.subject.toLowerCase();
  m.kind =
    /\brepair\b/.test(s) ? "repair"
    : /\badopt/.test(s) ? "adopt"
    : /supersed/.test(s) ? "supersede"
    : m.deleted > 0 && m.added === 0 && m.modified === 0 ? "prune"
    : m.added > 0 && m.modified === 0 && m.deleted === 0 ? "capture"
    : /\bcapture\b/.test(s) ? "capture"
    : "edit";
  return m;
}
