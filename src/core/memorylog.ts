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
import { HUNCH_COMMIT_SUBJECT, HUNCH_MANAGED_FILES } from "./taskTouched.js";

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
  /** `Hunch-Code-Branch` trailer: the code branch checked out at capture; null when
   *  absent (detached HEAD, overlay, or a commit older than the trailers). */
  codeBranch: string | null;
  /** `Hunch-Code-Head` trailer: the code commit the memory was captured against;
   *  null when absent or malformed. Unknown stays unknown, never guessed. */
  codeHead: string | null;
}

/** The record-header separator we ask `git log --format` to emit, so header lines
 *  are unambiguous against the name-status lines that follow each commit. */
export const MEMLOG_HEADER = "@@@";
/** Separates the subject from the code-link trailers. A subject may hold tabs; the
 *  unit separator follows it so a line without one (older canned input) still
 *  parses, as an unknown link. */
const LINK_SEP = "\x1f";
/** The `--format` string that pairs with {@link parseMemoryLog}. */
export const MEMLOG_FORMAT = `${MEMLOG_HEADER}%H\t%h\t%cI\t%s%x1f%(trailers:key=Hunch-Code-Branch,valueonly,separator=%x20)%x1f%(trailers:key=Hunch-Code-Head,valueonly,separator=%x20)`;

const ID_RE = /\/((?:dec|bug|con|cmp|pol|fnd|htask)_[A-Za-z0-9_-]+)\.json$/;
const SHA_RE = /^(?:[0-9a-f]{40}|[0-9a-f]{64})$/;

/** One trailer value, or null. Several values arrive space-joined; a ref name and a
 *  sha never contain a space, so a space means ambiguous or malformed. */
function linkValue(raw: string | undefined): string | null {
  const v = raw?.trim() ?? "";
  return v && !/\s/.test(v) ? v : null;
}

/** Parse `git log <MEMLOG_FORMAT> --name-status -- .hunch/` output into classified
 *  moves, newest first (git's order). `dir` is the memory directory's name as the paths
 *  spell it: `.hunch` in the code repo, whatever the overlay directory is called in its own. */
export function parseMemoryLog(raw: string, dir = ".hunch"): MemoryMove[] {
  const moves: MemoryMove[] = [];
  let cur: MemoryMove | null = null;
  for (const line of raw.split("\n")) {
    if (line.startsWith(MEMLOG_HEADER)) {
      if (cur) moves.push(classify(cur));
      // Split from the right: the two link fields are always last, and a subject
      // that itself holds a unit separator keeps it.
      const parts = line.slice(MEMLOG_HEADER.length).split(LINK_SEP);
      const linked = parts.length >= 3;
      const head = linked ? parts.pop() : undefined;
      const branch = linked ? parts.pop() : undefined;
      const f = parts.join(LINK_SEP).split("\t");
      const codeHead = linkValue(head);
      cur = {
        sha: f[0] ?? "", shortSha: f[1] ?? "", date: f[2] ?? "", subject: f.slice(3).join("\t"),
        kind: "edit", decisionIds: [], otherIds: [], added: 0, modified: 0, deleted: 0, files: [],
        codeBranch: linkValue(branch), codeHead: codeHead && SHA_RE.test(codeHead) ? codeHead : null,
      };
      continue;
    }
    if (!cur || !line.trim()) continue;
    addFile(cur, line, `${dir}/`);
  }
  if (cur) moves.push(classify(cur));
  return moves;
}

/** Count one name-status line ("A\tpath", "M\tpath", "D\tpath", or rename
 *  "R100\told\tnew") into the move when its path is under `memoryDir`. */
function addFile(m: MemoryMove, line: string, memoryDir: string): void {
  const parts = line.split("\t");
  const status = parts[0]?.[0];
  const path = parts[parts.length - 1];
  if (!path || !path.startsWith(memoryDir)) return;
  m.files.push(path);
  if (status === "A") m.added++;
  else if (status === "D") m.deleted++;
  else m.modified++;
  const id = ID_RE.exec(path)?.[1];
  if (id) (id.startsWith("dec_") ? m.decisionIds : m.otherIds).push(id);
}

// ---- feature-commit attribution (memory lane Phase 1, hunch-private#62) -------

/** One commit on a first-parent line, classified for attribution. */
export interface LineCommit {
  sha: string;
  shortSha: string;
  date: string;
  subject: string;
  parents: string[];
  /** a memory commit (a `Hunch-Code-Head` trailer or a `hunch:` subject) that changed
   *  nothing but memory and the generated grounding docs — the rule the capture-time
   *  code head uses (extractors/git.codeLinkTrailers). Anything else is code. */
  memoryOnly: boolean;
  /** the memory this commit changed, or null when it changed none. */
  move: MemoryMove | null;
}

/** The code commit memory is attributed to, without the line bookkeeping. */
export interface FeatureCommit {
  sha: string;
  shortSha: string;
  date: string;
  subject: string;
}

/** The memory that led to one feature commit. */
export interface FeatureGroup {
  /** the feature commit; null for memory after the line's last code commit. */
  commit: FeatureCommit | null;
  /** the default-branch commit that carries `commit` (its merge commit, squash commit,
   *  or rebased copy); null when it has not landed or git cannot say which. */
  landed: string | null;
  /** newest first. */
  moves: MemoryMove[];
}

/** `git log --first-parent --name-status` format that pairs with {@link parseLine}.
 *  The subject comes last so a stray unit separator inside it stays in the subject. */
export const LINE_FORMAT = "%x1e%H%x1f%h%x1f%cI%x1f%P%x1f%(trailers:key=Hunch-Code-Branch,valueonly,separator=%x20)%x1f%(trailers:key=Hunch-Code-Head,valueonly,separator=%x20)%x1f%s";

/** Parse {@link LINE_FORMAT} output, newest first. `prefix` is the project's path
 *  inside the repository (`rev-parse --show-prefix`); `memoryDir` the memory
 *  directory's toplevel-relative path, e.g. ".hunch/". */
export function parseLine(raw: string, prefix: string, memoryDir: string): LineCommit[] {
  const isMemoryFile = (file: string): boolean =>
    file.startsWith(memoryDir) || (file.startsWith(prefix) && HUNCH_MANAGED_FILES.has(file.slice(prefix.length)));
  const out: LineCommit[] = [];
  for (const entry of raw.split("\x1e").slice(1)) {
    const [header = "", ...body] = entry.split("\n");
    const [sha = "", shortSha = "", date = "", parents = "", branch = "", head = "", ...subject] = header.split("\x1f");
    if (!SHA_RE.test(sha)) continue;
    const codeHead = linkValue(head);
    const move: MemoryMove = {
      sha, shortSha, date, subject: subject.join("\x1f"), kind: "edit", decisionIds: [], otherIds: [],
      added: 0, modified: 0, deleted: 0, files: [],
      codeBranch: linkValue(branch), codeHead: codeHead && SHA_RE.test(codeHead) ? codeHead : null,
    };
    // Every path of the commit decides memory-only; a rename names two.
    const paths: string[] = [];
    for (const line of body) {
      if (!line.trim()) continue;
      paths.push(...line.split("\t").slice(1));
      addFile(move, line, memoryDir);
    }
    const memoryCommit = head.trim() !== "" || HUNCH_COMMIT_SUBJECT.test(move.subject);
    out.push({
      sha, shortSha, date, subject: move.subject,
      parents: parents.split(" ").filter(Boolean),
      memoryOnly: memoryCommit && paths.every(isMemoryFile),
      move: move.files.length ? classify(move) : null,
    });
  }
  return out;
}

/** Attribute a first-parent line's memory to feature commits. `line` is newest first,
 *  as git emits it. Memory belongs to the next code commit above it; a non-merge code
 *  commit that itself changed memory owns that change too. A merge commit's own memory
 *  diff is what the other side brought in, already attributed on that side, so it is
 *  not counted here. Memory above the last code commit trails with `commit: null`.
 *  Only commits that carry memory are returned, newest first; `landed` is left null
 *  for the caller, who knows how the line reached the default branch.
 *
 *  A merge that `ownsMemory` rejects is transparent: it is skipped like a memory-only
 *  commit, so pending memory passes through to the next code commit above it. A merge
 *  of main into a feature branch is not a feature commit, and memory captured before
 *  it was made for the commit that follows. Only a merge on the default branch's own
 *  line (the commit that landed a branch) owns, hence the default. */
export function attributeLine(line: readonly LineCommit[], ownsMemory: (c: LineCommit) => boolean = () => true): FeatureGroup[] {
  const groups: FeatureGroup[] = [];
  let pending: MemoryMove[] = [];
  for (let i = line.length - 1; i >= 0; i--) {
    const c = line[i]!;
    if (c.memoryOnly) {
      if (c.move) pending.unshift(c.move);
      continue;
    }
    if (c.parents.length >= 2 && !ownsMemory(c)) continue;
    const own = c.move && c.parents.length < 2 ? [c.move] : [];
    if (own.length || pending.length) {
      groups.unshift({ commit: { sha: c.sha, shortSha: c.shortSha, date: c.date, subject: c.subject }, landed: null, moves: [...own, ...pending] });
    }
    pending = [];
  }
  if (pending.length) groups.unshift({ commit: null, landed: null, moves: pending });
  return groups;
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
