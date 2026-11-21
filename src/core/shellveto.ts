/** The Veto Guard for writes that bypass the edit tools.
 *
 * The live Veto (hookpolicy.ts `vetoInScope`) tests the text an Edit/Write/MultiEdit
 * PROPOSES, before it lands. An agent that writes through the shell — a heredoc,
 * `sed -i`, a `python -c … open(p,'w')`, PowerShell `Set-Content` — never passes
 * through those tools, so a rejected approach written that way met no guard at all
 * (nuryel-bench, Windows: `localStorage` written past a human-confirmed tripwire).
 *
 * Shell commands can't be parsed for what they write; shellwrites.ts already
 * measures WHICH files a command changed. This module asks git what those files
 * GAINED against HEAD and runs the same Veto over those lines. It runs after the
 * write (the host can't be asked beforehand), so a hit tells the agent to revert,
 * and the Stop gate re-checks every file THIS session's shell commands wrote, so
 * such a write cannot survive the turn unflagged (a human's own uncommitted work is
 * never judged).
 *
 * Only ADDED lines count, minus lines the same diff removes (a moved or
 * re-indented line was already there): a file that already contains a rejected
 * pattern must not make every later edit of it a violation. Any failure yields no
 * hit — never an error and never a deny on a guess. */
import { execFileSync } from "node:child_process";
import { createHash } from "node:crypto";
import { existsSync, readdirSync, readFileSync, statSync } from "node:fs";
import { basename, dirname, join } from "node:path";
import type { HunchStore } from "../store/hunchStore.js";
import { pathMatchesGlob } from "./glob.js";
import { constraintInLines, forbidsCover, vetoInScope, type BlockingHit } from "./hookpolicy.js";
import { effectiveForbids } from "./constraintmatch.js";
import { isHumanConfirmed } from "./strictgate.js";
import { isInForce } from "./topics.js";

/** Bounds: a command that rewrote a vendored tree must not stall the hook. */
const MAX_FILES = 50;
/** A working file past this gains nothing (it fails open alone). */
const MAX_FILE_BYTES = 64_000_000;
/** A file new to HEAD is judged whole; past this size it is skipped. The base judged
 *  a staged new file through a diff capped at 8 MB of output, and an untracked one
 *  only up to 512 KB; 8 MB covers both. */
const MAX_NEW_FILE_BYTES = 8_000_000;
/** A screened hit is confirmed with at least this long, like the base's per-call timeout. */
const CONFIRM_FLOOR_MS = 3_000;
/** Output cap of one git call (cat-file carries whole blobs). */
const MAX_GIT_OUTPUT = 256_000_000;
/** Rename pairing reads at most this many deleted files, and this many bytes of them. */
const MAX_PAIR_PATHS = 200;
const MAX_PAIR_BYTES = 16_000_000;
/** Working bytes per cat-file batch; a bigger file goes alone. */
const BATCH_BYTES = 8_000_000;
const LFS_POINTER = "version https://git-lfs.github.com/spec/";
/** Wall-clock budget for one check; past it the check fails open (no hit). */
const DEFAULT_BUDGET_MS = 5_000;
/** HUNCH_SHELL_VETO_BUDGET_MS overrides it (a loaded CI box); read at call time. */
const budget = (): number => {
  const n = Number(process.env.HUNCH_SHELL_VETO_BUDGET_MS);
  return Number.isFinite(n) && n >= 1 ? Math.floor(n) : DEFAULT_BUDGET_MS;
};
/** Hunch's own state is written by the hook and the capture tools, never by the agent's change. */
const OWN_STATE = /^\.hunch(?:-cache)?\//;

const gitEnv = (): NodeJS.ProcessEnv => ({ ...process.env, GIT_OPTIONAL_LOCKS: "0", GIT_TERMINAL_PROMPT: "0" });

/** One git call, raw bytes out; `input` goes to stdin (never argv, so no length limit). */
function git(root: string, args: string[], deadline: number, input?: string): Buffer | null {
  const timeout = deadline - Date.now();
  if (timeout <= 0) return null;
  try {
    return execFileSync("git", ["-C", root, "-c", "core.quotePath=false", ...args], {
      input, timeout, maxBuffer: MAX_GIT_OUTPUT, stdio: [input === undefined ? "ignore" : "pipe", "pipe", "ignore"], env: gitEnv(),
    }) as Buffer;
  } catch {
    return null;
  }
}

/** Scopes of the tripwires that can BLOCK (in-force decision, human-confirmed
 *  tripwire); an empty scope means any file. None: nothing to check. */
export function blockingTripwireScopes(store: HunchStore): string[][] {
  const out: string[][] = [];
  for (const d of store.recs("decisions")) {
    if (!isInForce(d)) continue;
    for (const tw of d.rejected_tripwires ?? []) if (isHumanConfirmed(tw.provenance?.source)) out.push(tw.scope);
  }
  return out;
}

/** HEAD's blob for each path (Hunch-root-relative), from ONE `git cat-file --batch`
 *  fed through stdin; `HEAD:./p` resolves against the Hunch root, not the toplevel.
 *  A path HEAD lacks (untracked, newly staged, no commit yet) maps to null. Null
 *  when git could not answer. */
function headBlobs(root: string, paths: readonly string[], deadline: number): Map<string, Buffer | null> | null {
  const out = new Map<string, Buffer | null>();
  if (!paths.length) return out;
  const raw = git(root, ["cat-file", "--batch"], deadline, paths.map((p) => `HEAD:./${p}\n`).join(""));
  if (raw === null) return null;
  let pos = 0;
  for (const p of paths) {
    const nl = raw.indexOf(0x0a, pos);
    if (nl < 0) return null;
    const header = raw.toString("utf8", pos, nl);
    pos = nl + 1;
    const m = /^[0-9a-f]+ (\w+) (\d+)$/.exec(header);
    if (!m) { out.set(p, null); continue; } // "<name> missing" (or ambiguous)
    const size = Number(m[2]);
    out.set(p, m[1] === "blob" ? raw.subarray(pos, pos + size) : null);
    pos += size + 1; // the content, then its newline
  }
  return out;
}

/** HEAD blob sizes for `paths` from one `git cat-file --batch-check` over stdin
 *  (missing paths absent). Null when git could not answer. */
function headSizes(root: string, paths: readonly string[], deadline: number): Map<string, number> | null {
  if (!paths.length) return new Map();
  const raw = git(root, ["cat-file", "--batch-check"], deadline, paths.map((p) => `HEAD:./${p}\n`).join(""));
  if (raw === null) return null;
  const out = new Map<string, number>();
  const lines = raw.toString("utf8").split("\n");
  paths.forEach((p, i) => { const m = /^[0-9a-f]+ blob (\d+)$/.exec(lines[i] ?? ""); if (m) out.set(p, Number(m[1])); });
  return out;
}

/** Binary by git's own rule: a NUL byte in the first 8000. */
const isBinary = (b: Buffer): boolean => b.subarray(0, 8000).includes(0);
const splitLines = (text: string): string[] => text.split(/\r?\n/);
/** The UTF-16 byte-order mark of `b`, if it counts: only when NULs follow (UTF-16
 *  text of ASCII-range code is full of them); FF FE ahead of plain ASCII is read as
 *  UTF-8, as the base diff did. */
function utf16Mark(b: Buffer): "le" | "be" | null {
  if (!isBinary(b.subarray(2))) return null;
  if (b[0] === 0xff && b[1] === 0xfe) return "le";
  if (b[0] === 0xfe && b[1] === 0xff) return "be";
  return null;
}
/** Text of a file's bytes: a UTF-16 (LE/BE) or UTF-8 byte-order mark is honored
 *  BEFORE the binary test (UTF-16 text is full of NULs); null for binary. */
function decodeText(b: Buffer): string | null {
  const mark = utf16Mark(b);
  if (mark === "le") return b.subarray(2).toString("utf16le");
  if (mark === "be") {
    const be = b.subarray(2, 2 + ((b.length - 2) & ~1));
    return Buffer.from(be).swap16().toString("utf16le");
  }
  if (b[0] === 0xef && b[1] === 0xbb && b[2] === 0xbf) return b.subarray(3).toString("utf8");
  return isBinary(b) ? null : b.toString("utf8");
}

/** UTF-16 with no byte-order mark, told by where the NULs fall in its first 8000
 *  bytes (ASCII-range code puts one in every high byte); null when it isn't. */
function bomlessUtf16(b: Buffer): string | null {
  const n = Math.min(b.length, 8000) & ~1;
  if (n < 2) return null;
  let odd = 0, even = 0;
  for (let i = 0; i < n; i++) if (b[i] === 0) (i & 1 ? odd++ : even++);
  const half = n / 2;
  if (odd >= half * 0.3 && even === 0) return b.subarray(0, b.length & ~1).toString("utf16le");
  if (even >= half * 0.3 && odd === 0) return Buffer.from(b.subarray(0, b.length & ~1)).swap16().toString("utf16le");
  return null;
}

/** Plain UTF-8 text: decodes as text and not through a UTF-16 mark. Anything else
 *  (UTF-16 with a mark, BOM-less UTF-16, a NUL byte) is an "encoded" file, which
 *  git's own diff may read differently from the screen (working-tree-encoding). */
const plainUtf8 = (b: Buffer): boolean => decodeText(b) !== null && utf16Mark(b) === null;

/** Lines of a file new to HEAD: byte-order marks honored, never judged binary. With
 *  NULs and no mark the encoding is unknown, so the screen takes both readings. */
function looseLines(b: Buffer): string[] {
  const text = decodeText(b);
  // A UTF-16 mark may be two stray bytes before plain ASCII: screen both readings.
  const marked = (b[0] === 0xff && b[1] === 0xfe) || (b[0] === 0xfe && b[1] === 0xff);
  if (text !== null) return marked ? [...splitLines(text), ...splitLines(b.toString("utf8"))] : splitLines(text);
  const utf16 = bomlessUtf16(b);
  return [...splitLines(b.toString("utf8")), ...(utf16 === null ? [] : splitLines(utf16))];
}

/** The SCREEN for a tracked file: every working line whose trimmed text occurs more
 *  often than in HEAD, every spelling of it included — a superset of what the
 *  base's diff could add, so a hit here is then confirmed by that exact measure. */
function surplusLines(work: readonly string[], old: readonly string[]): string[] {
  const count = new Map<string, number>();
  for (const l of work) { const k = l.trim(); count.set(k, (count.get(k) ?? 0) + 1); }
  for (const l of old) { const k = l.trim(); if (count.has(k)) count.set(k, count.get(k)! - 1); }
  return work.filter((l) => (count.get(l.trim()) ?? 0) > 0);
}

/** Exact-move pairing state shared by every chunk of one check: each deleted
 *  file excuses at most one new file across the whole check. */
export interface MovePairing {
  deleted: string[] | null; deletedOids: Map<string, string>; keys: Map<string, string>; consumed: Set<string>; fetched: number; bytes: number; newFiles: Set<string>; encoded: Set<string>; dirs: Map<string, Set<string> | null>; prefix?: string | null;
  /** Staged renames (`git mv`), new path -> source (Hunch-root-relative); read once per check. */
  renames?: Map<string, string> | null;
  /** New files judged against their staged rename source: the confirm diff names both. */
  renamed: Map<string, string>;
  /** Every new file excused or baselined as a move, new path -> source. */
  movedFrom: Map<string, string>;
  /** Read staged renames for every new file, even with no deletion on disk (the
   *  invariant check: a source path written again after `git mv` is still the move's source). */
  alwaysRenames?: boolean;
}
export const newMovePairing = (): MovePairing => ({ deleted: null, deletedOids: new Map(), keys: new Map(), consumed: new Set(), fetched: 0, bytes: 0, newFiles: new Set(), encoded: new Set(), dirs: new Map(), renamed: new Map(), movedFrom: new Map() });

/** Whether HEAD names no commit yet (`rev-parse -q --verify` exits 1); false when git
 *  could not answer at all (timeout, spawn failure). */
function unbornHead(root: string, deadline: number): boolean {
  const timeout = deadline - Date.now();
  if (timeout <= 0) return false;
  try {
    execFileSync("git", ["-C", root, "rev-parse", "-q", "--verify", "HEAD^{commit}"], { timeout, stdio: ["ignore", "ignore", "ignore"], env: gitEnv() });
    return false;
  } catch (e) {
    return (e as { status?: unknown }).status === 1;
  }
}

/** Staged renames from one `git diff --cached -M --name-status -z HEAD`: new -> source.
 *  With `copies`, also a staged copy of a file the index modified (`-C`): a file
 *  moved aside, then a new file staged at its old path, is a copy to git. */
function stagedRenames(root: string, deadline: number, copies = false): Map<string, string> | null {
  const raw = git(root, ["diff", "--cached", copies ? "-C" : "-M", "-z", "--name-status", "--relative", "HEAD"], deadline);
  // No commit yet: nothing can have been renamed. Told by exit status (1 = HEAD
  // does not resolve), never by a timeout or another failure.
  if (raw === null) return unbornHead(root, deadline) ? new Map() : null;
  const map = new Map<string, string>();
  const f = raw.toString("utf8").split("\u0000");
  for (let i = 0; i < f.length; i++) {
    // "R<score>\0<old>\0<new>\0" (and C for copies); every other status has one path.
    if (/^[RC]\d*$/.test(f[i]!)) {
      if (f[i + 1] && f[i + 2] && (f[i]![0] === "R" || (copies && !map.has(f[i + 2]!)))) map.set(f[i + 2]!, f[i + 1]!);
      i += 2;
    } else i++;
  }
  return map;
}

/** Whether `d` exists on disk with exactly this spelling (a case-insensitive FS
 *  answers existsSync for a case-only rename's old name). */
const existsExact = (pairing: MovePairing, root: string, d: string): boolean => {
  const dir = dirname(join(root, d));
  let names = pairing.dirs.get(dir);
  if (names === undefined) {
    // One readdir per parent directory for the whole check, not one per deleted path.
    try { names = new Set(readdirSync(dir)); } catch { names = null; }
    pairing.dirs.set(dir, names);
  }
  return names !== null && names.has(basename(d));
};
/** The git blob id of raw bytes, in the hash the repo's object ids use (by id length).
 *  Raw bytes, no clean filters: only the fallback when `git hash-object` can't answer. */
const blobId = (b: Buffer, oidLen: number): string =>
  createHash(oidLen === 64 ? "sha256" : "sha1").update(`blob ${b.length}\0`).update(b).digest("hex");

/** A file's content as compared for an exact move: its lines, CRLF-normalized, NOT trimmed (a re-indented move is a change). */
const contentKey = (lines: readonly string[]): string => lines.join("\n");
/** The exact-move key of raw bytes, one reading on both sides: marks honored, then
 *  BOM-less UTF-16, else the bytes themselves (a NUL file moves only byte for byte). */
const moveKey = (b: Buffer): string => {
  const text = decodeText(b) ?? bomlessUtf16(b);
  return text !== null ? "t:" + contentKey(splitLines(text)) : "b:" + b.toString("latin1");
};
const inScope = (file: string, scope: readonly string[]): boolean => !scope.length || scope.some((g) => pathMatchesGlob(file, g));

/** Lines each of `files` (Hunch-root-relative, POSIX) gains against HEAD: the
 *  SCREEN: every working line whose trimmed text occurs more often than in HEAD
 *  (all spellings of it) — a superset; vetoForWrittenFiles confirms a hit with the
 *  exact per-file diff measure. HEAD is read with `git cat-file --batch` over
 *  stdin, in batches of at most 8 MB of working files, smallest first; at most
 *  three git calls per batch (the deleted-path list, `--raw` so it carries blob ids,
 *  and one more batch only when a file is new to HEAD), plus one size call per check
 *  of several files. A file new to HEAD counts in full unless it is an EXACT move:
 *  its git blob id (as git would store it, line-ending and working-tree-encoding filters applied; one `git hash-object` call for the new files when deletions exist) equals a deleted file's (no content fetch), or
 *  its decoded lines (line endings and text encoding aside, not trimmed) equal one
 *  deleted file's (content compared for at most 200 deleted files and 16 MB); that
 *  deleted file lies in the scope of every blocking tripwire (`scopes`) whose scope
 *  covers the new one; each deleted file pairs with one new file at most. A deleted
 *  path counts as moved away unless its exact spelling exists on disk (a case-only
 *  rename). A file new to HEAD past 8 MB is skipped (the base judged one through an
 *  8 MB-capped diff). A tracked file that is NUL-laden on disk while HEAD holds text
 *  is read as BOM-less UTF-16 (LE or BE by NUL parity). A tracked file whose HEAD or
 *  working bytes are not plain UTF-8 (a UTF-16 mark, BOM-less UTF-16, a NUL byte),
 *  and a new unpaired file whose bytes are not, go into `pairing.encoded`: the caller
 *  asks git's own diff about them after the UTF-8 files; their screen lines stay in
 *  the result. Other binary, Git LFS pointer-to-pointer, oversized or unreadable
 *  files gain nothing; files the deadline left unread are absent (they fail open).
 *  Null when git could not answer at all. */
export function addedLinesSinceHead(root: string, files: readonly string[], deadline = Date.now() + budget(), scopes?: readonly string[][], pairing: MovePairing = newMovePairing()): Map<string, string[]> | null {
  const out = new Map<string, string[]>();
  // A path with a line break can't go through the batch's stdin: it fails open.
  const wanted = files.filter((f) => !OWN_STATE.test(f) && !/[\r\n]/.test(f));
  if (!wanted.length) return out;
  // Sizes now; contents only when the file's batch runs (a huge file read up
  // front would spend the budget before the small ones are judged).
  const work = new Map<string, { size: number }>();
  for (const file of wanted) {
    try {
      const st = statSync(join(root, file));
      if (!st.isFile() || st.size > MAX_FILE_BYTES) { out.set(file, []); continue; }
      work.set(file, { size: st.size });
    } catch { out.set(file, []); }
  }
  const raw = new Map<string, Buffer>();
  // Smallest first, in batches of at most BATCH_BYTES (a bigger file goes alone),
  // so one huge file cannot starve the small ones.
  // HEAD's side counts too: a huge file truncated on disk still ships its whole
  // old blob, so batches are sized by the larger of the two (one
  // `cat-file --batch-check` call; without it, the working size alone). A lone
  // file is its own batch whatever its size, so it skips that call.
  const headSize = work.size > 1 ? headSizes(root, [...work.keys()], deadline) : null;
  if (headSize) for (const [f, n] of headSize) { const w = work.get(f); if (w && n > w.size) w.size = n; }
  const order = [...work.keys()].sort((a, b) => work.get(a)!.size - work.get(b)!.size);
  const batches: string[][] = [];
  let size = Infinity;
  for (const f of order) {
    const n = work.get(f)!.size;
    if (size + n > BATCH_BYTES) { batches.push([]); size = 0; }
    batches[batches.length - 1]!.push(f);
    size += n;
  }
  const fresh: string[] = [];
  for (const [i, all] of batches.entries()) {
    if (Date.now() >= deadline) break;
    const batch: string[] = [];
    for (const file of all) {
      try { raw.set(file, readFileSync(join(root, file))); batch.push(file); } catch { out.set(file, []); }
    }
    if (!batch.length) continue;
    const blobs = headBlobs(root, batch, deadline);
    if (!blobs) { if (i === 0) return null; break; }
    for (const file of batch) {
      const blob = blobs.get(file) ?? null;
      // New to HEAD: read as text, NULs and all, as the base read an untracked file.
      if (blob === null) { fresh.push(file); continue; }
      // An LFS pointer on both sides: the base diff compared pointer to pointer. A
      // pointer replaced by real text (no LFS filter) is judged like any change.
      const isPointer = (b: Buffer) => b.subarray(0, LFS_POINTER.length).toString("utf8") === LFS_POINTER;
      if (isPointer(blob) && isPointer(raw.get(file)!)) { out.set(file, []); continue; }
      const old = decodeText(blob);
      // Binary by NUL while HEAD holds text: a BOM-less UTF-16 working tree
      // (working-tree-encoding), which the base diff converted.
      const now = decodeText(raw.get(file)!) ?? (old === null ? null : bomlessUtf16(raw.get(file)!));
      // Not plain UTF-8 on either side: git's own diff may read it differently (a
      // `diff` attribute, working-tree-encoding), so the caller asks git.
      if (!plainUtf8(blob) || !plainUtf8(raw.get(file)!)) pairing.encoded.add(file);
      out.set(file, now === null || old === null ? [] : surplusLines(splitLines(now), splitLines(old)));
    }
  }
  if (!fresh.length) return out;
  // Exact-move pairing; anything short of it counts the new file in full, as the base did.
  const covering = (f: string) => (scopes ?? [[]]).filter((s) => inScope(f, s));
  const eligible = (f: string, d: string) => covering(f).every((s) => inScope(d, s));
  if (pairing.deleted === null && Date.now() < deadline) {
    const rawList = git(root, ["diff", "-z", "--raw", "--no-abbrev", "--no-renames", "--diff-filter=D", "--relative", "HEAD"], deadline);
    pairing.deleted = [];
    if (rawList) {
      // -z raw records: ":<srcmode> <dstmode> <srcoid> <dstoid> D\0<path>\0".
      const tok = rawList.toString("utf8").split("\u0000");
      for (let k = 0; k + 1 < tok.length; k += 2) {
        const meta = tok[k]!.split(" "), d = tok[k + 1]!;
        // A path deleted from the index but still on disk (`git rm --cached`) was not moved.
        // Out of budget: the rest of the list can't excuse a move (a pure move past the cut counts in full).
        if (Date.now() >= deadline) break;
        if (!d || /[\r\n]/.test(d) || existsExact(pairing, root, d)) continue;
        pairing.deleted.push(d);
        if (meta[2]) pairing.deletedOids.set(d, meta[2]);
      }
    }
  }
  const deleted = pairing.deleted ?? [];
  const rest: string[] = [];
  const oidLen = (pairing.deletedOids.values().next().value ?? "").length;
  // Git's own id of each candidate, clean filters applied (autocrlf, eol,
  // working-tree-encoding), from ONE `git hash-object --stdin-paths` (hash only, no -w).
  const candidates = fresh.filter((f) => raw.get(f)!.length <= MAX_NEW_FILE_BYTES);
  const gitOids = new Map<string, string>();
  if (pairing.deletedOids.size > 0 && candidates.length && pairing.prefix === undefined && Date.now() < deadline) {
    // Git reads --stdin-paths against the worktree top, not the cwd: prefix the Hunch root's path.
    const pre = git(root, ["rev-parse", "--show-prefix"], deadline);
    pairing.prefix = pre === null ? null : pre.toString("utf8").replace(/\r?\n$/, "");
  }
  if (pairing.deletedOids.size > 0 && candidates.length && typeof pairing.prefix === "string" && Date.now() < deadline) {
    const pre = pairing.prefix;
    const res = git(root, ["hash-object", "--stdin-paths"], deadline, candidates.map((f) => pre + f).join("\n") + "\n");
    if (res) {
      const lines = res.toString("utf8").split("\n").filter((l) => l);
      if (lines.length === candidates.length) candidates.forEach((f, i) => gitOids.set(f, lines[i]!));
    }
  }
  for (const f of fresh) {
    // The base skipped a new file past this size; judging one whole is unbounded work.
    if (raw.get(f)!.length > MAX_NEW_FILE_BYTES) { out.set(f, []); continue; }
    pairing.newFiles.add(f);
    // Same id as a deleted blob: paired by id, with no content fetch or byte bound.
    // Git's filtered id, or the raw bytes' id (a HEAD blob committed with filters since changed).
    const ids = oidLen ? [gitOids.get(f), blobId(raw.get(f)!, oidLen)].filter((x): x is string => !!x) : [];
    const same = ids.length ? deleted.find((d) => ids.includes(pairing.deletedOids.get(d) ?? "") && eligible(f, d) && !pairing.consumed.has(d)) : undefined;
    if (same) { pairing.consumed.add(same); pairing.keys.delete(same); pairing.movedFrom.set(f, same); out.set(f, []); continue; }
    rest.push(f);
  }
  const needed = [...new Set(rest.flatMap((f) => deleted.filter((d) => eligible(f, d) && !pairing.keys.has(d) && !pairing.consumed.has(d))))]
    .slice(0, Math.max(0, MAX_PAIR_PATHS - pairing.fetched));
  const old = needed.length && Date.now() < deadline ? headBlobs(root, needed, deadline) : null;
  if (old) pairing.fetched += needed.length;
  for (const d of needed) {
    const blob = old?.get(d);
    if (!blob || (pairing.bytes += blob.length) > MAX_PAIR_BYTES) continue;
    pairing.keys.set(d, moveKey(blob));
  }
  // A staged rename (`git mv`) edited after the move: its source is the baseline, so
  // a line the source already held is not new. Same scope rule as an exact move: a
  // file moved in from outside a scope brings its lines in as new.
  // A moved-away source is on the deleted list, so with no deletion there is no
  // rename to look up (and no git call).
  const wantRenames = deleted.length > 0 || pairing.alwaysRenames === true;
  if (rest.length && wantRenames && pairing.renames === undefined && Date.now() < deadline) pairing.renames = stagedRenames(root, deadline, pairing.alwaysRenames === true);
  const srcOf = (f: string): string | undefined => {
    const s = pairing.renames?.get(f);
    return s && (pairing.alwaysRenames || deleted.includes(s)) && !pairing.consumed.has(s) && eligible(f, s) ? s : undefined;
  };
  const srcs = [...new Set(rest.map(srcOf).filter((s): s is string => !!s))];
  const srcBlobs = srcs.length && Date.now() < deadline ? headBlobs(root, srcs, deadline) : null;
  for (const f of rest) {
    const lines = looseLines(raw.get(f)!);
    // Keyed on one reading, as the deleted blob is; the screen keeps both readings.
    const key = pairing.keys.size > 0 ? moveKey(raw.get(f)!) : null;
    const match = key === null ? undefined : [...pairing.keys.keys()].find((d) => pairing.keys.get(d) === key && eligible(f, d) && !pairing.consumed.has(d));
    if (match) { pairing.keys.delete(match); pairing.consumed.add(match); pairing.movedFrom.set(f, match); out.set(f, []); continue; }
    const src = srcOf(f);
    const srcBlob = src ? srcBlobs?.get(src) : undefined;
    // Both sides must read as text (byte-order marks, then BOM-less UTF-16); else the
    // file counts in full, as any new file does.
    const old = src && srcBlob ? decodeText(srcBlob) ?? bomlessUtf16(srcBlob) : null;
    const now = old !== null ? decodeText(raw.get(f)!) ?? bomlessUtf16(raw.get(f)!) : null;
    if (src && srcBlob && old !== null && now !== null) {
      pairing.newFiles.delete(f);
      pairing.renamed.set(f, src);
      pairing.consumed.add(src);
      pairing.keys.delete(src);
      pairing.movedFrom.set(f, src);
      if (!plainUtf8(srcBlob) || !plainUtf8(raw.get(f)!)) pairing.encoded.add(f);
      out.set(f, surplusLines(splitLines(now), splitLines(old)));
      continue;
    }
    // The invariant check, when git could not say whether this file is a staged
    // rename (budget spent, git failed, source unread): unjudged, never a guess.
    // The Veto keeps the base's rule and counts the file in full.
    if (pairing.alwaysRenames && (pairing.renames == null || (src && !srcBlob))) continue;
    out.set(f, lines);
    if (!plainUtf8(raw.get(f)!)) pairing.encoded.add(f);
  }
  return out;
}

/** Hunch-root-relative files that differ from HEAD (tracked changes, staged or
 *  not, and untracked files), never deletions or Hunch's own state. The Stop
 *  check's input on a host with no post-tool event to say what the shell wrote.
 *  Null when git can't answer. */
export function filesChangedSinceHead(root: string, deadline = Date.now() + Math.max(budget(), CONFIRM_FLOOR_MS)): string[] | null {
  const tracked = git(root, ["diff", "-z", "--name-only", "--no-renames", "--diff-filter=d", "--relative", "HEAD"], deadline);
  const untracked = git(root, ["ls-files", "-z", "--others", "--exclude-standard"], deadline);
  if (untracked === null) return null;
  // No commit yet: every indexed file is new too.
  const cached = tracked === null ? git(root, ["ls-files", "-z", "--cached"], deadline) : null;
  const all = (tracked ?? cached)?.toString("utf8").split("\u0000").concat(untracked.toString("utf8").split("\u0000")) ?? untracked.toString("utf8").split("\u0000");
  return [...new Set(all.filter((p) => p && !OWN_STATE.test(p)))];
}

/** The base's exact measure of what `file` gained against HEAD: its own
 *  `git diff`, `+` lines less `-` lines (trimmed, each removal cancelling one
 *  addition). Null when git could not answer, or could not measure the file as
 *  text: then the screen's own reading stands (it decodes byte-order marks and
 *  reads a file new to HEAD whole): an untracked file the diff can't see, a
 *  "Binary files differ" diff (UTF-16 with a mark, a staged file with a NUL),
 *  or a path the diff calls deleted while it is still on disk (`git rm --cached`). */
function confirmLines(root: string, file: string, isNew: boolean, deadline: number, src?: string): string[] | null {
  // A staged rename's source is named too: git pairs the two (or shows the source
  // deleted), and its removed lines cancel the ones the move carried over.
  const diff = git(root, ["--literal-pathspecs", "diff", "--no-color", "--no-ext-diff", "--src-prefix=a/", "--dst-prefix=b/", "-M", "--unified=0", "--relative", "HEAD", "--", ...(src ? [src] : []), file], deadline);
  if (diff === null) return null;
  const text = diff.toString("utf8");
  if (!text.trim()) return isNew ? null : [];
  const added: string[] = [];
  const removed = new Map<string, number>();
  let inHeader = false;
  // The section for `file` itself (the source's own section is a deletion by design).
  let own = false;
  for (const line of text.split(/\r?\n/)) {
    if (line.startsWith("diff --git ")) { inHeader = true; own = !src || line.endsWith(` b/${file}`); continue; }
    if (inHeader && (line.startsWith("Binary files ") || (own && line.startsWith("deleted file mode") && existsSync(join(root, file))))) return null;
    if (inHeader) { if (line.startsWith("@@")) inHeader = false; continue; }
    if (line.startsWith("+")) added.push(line.slice(1));
    else if (line.startsWith("-")) { const k = line.slice(1).trim(); removed.set(k, (removed.get(k) ?? 0) + 1); }
  }
  return added.filter((l) => {
    const k = l.trim();
    const n = removed.get(k) ?? 0;
    if (!n) return true;
    removed.set(k, n - 1);
    return false;
  });
}

/** The first blocking Veto hit among `files` (Hunch-root-relative), judged on the
 *  lines each gained against HEAD — the post-write counterpart of the pre-edit
 *  Veto. No blocking tripwire, no file in a tripwire's scope, or the budget spent:
 *  no hit, and no git process for the first two. */
export function vetoForWrittenFiles(store: HunchStore, root: string, files: readonly string[], budgetMs = budget(), opts: { newestFirst?: boolean } = {}): { target: string; hit: BlockingHit } | null {
  // The budget covers git and file work only: a large graph's cold decision load
  // must not spend it before git runs.
  const scopes = blockingTripwireScopes(store);
  const deadline = Date.now() + budgetMs;
  if (!scopes.length) return null;
  const inScope = files.filter((f) => !OWN_STATE.test(f) && scopes.some((s) => !s.length || s.some((g) => pathMatchesGlob(f, g))));
  return judgeWrittenFiles(root, inScope, scopes, (target, lines) => vetoInScope(store, target, lines), deadline, opts);
}

/** Scopes of the content-matched BLOCKING invariants (forbidden deps, symbols,
 *  patterns): the only ones a write's text can break. */
export function blockingForbidScopes(store: HunchStore): string[][] {
  return store.recs("constraints").filter((c) => c.status !== "retired" && c.severity === "blocking" && !!effectiveForbids(c)).map((c) => c.scope);
}

/** The first content-matched blocking invariant broken by what `files` gained
 *  against HEAD (the invariant twin of vetoForWrittenFiles, same screen, confirm
 *  and bounds). A file is read only when such an invariant covers it, and goes to
 *  git only when its whole text breaks one: a subset of its lines cannot break a
 *  rule its whole text keeps, so most shell writes cost no git process. */
export function constraintForWrittenFiles(store: HunchStore, root: string, files: readonly string[], budgetMs = budget(), opts: { newestFirst?: boolean } = {}): { target: string; hit: BlockingHit } | null {
  // A git-redirecting environment points git at another repository's HEAD or
  // index: what it calls new is not what this write added. No verdict.
  if (process.env.GIT_DIR || process.env.GIT_WORK_TREE || process.env.GIT_INDEX_FILE) return null;
  const scopes = blockingForbidScopes(store);
  const deadline = Date.now() + budgetMs;
  if (!scopes.length) return null;
  const judge =(target: string, lines: string[]): BlockingHit | null => constraintInLines(store, target, lines);
  const tripped = files.filter((f) => {
    if (OWN_STATE.test(f) || /[\r\n]/.test(f) || Date.now() >= deadline || !forbidsCover(store, f)) return false;
    try {
      const st = statSync(join(root, f));
      if (!st.isFile() || st.size > MAX_FILE_BYTES) return false;
      return judge(f, looseLines(readFileSync(join(root, f)))) !== null;
    } catch { return false; }
  });
  // Any move pairs (one scope covering everything), and is judged per rule: a rule
  // that covered the source judges only what the file gained against it; a rule
  // that covers only the new path sees the moved text in full.
  const pairing: MovePairing = { ...newMovePairing(), alwaysRenames: true };
  const hit = judgeWrittenFiles(root, tripped, [[]], judge, deadline, opts, pairing);
  if (hit) return hit;
  for (const [target, src] of pairing.movedFrom) {
    try {
      const before = new Set(store.checkConstraints(src).map((c) => c.id));
      const moved = constraintInLines(store, target, looseLines(readFileSync(join(root, target))), (c) => !before.has(c.id));
      if (moved) return { target, hit: moved };
    } catch { /* unreadable: no verdict */ }
  }
  return null;
}

/** Judge `candidates` (already in scope) on the lines each gained against HEAD:
 *  screen, then confirm a hit with the exact per-file diff. */
function judgeWrittenFiles(root: string, inScope: readonly string[], scopes: readonly string[][], judge: (target: string, lines: string[]) => BlockingHit | null, deadline: number, opts: { newestFirst?: boolean }, pairing: MovePairing = newMovePairing()): { target: string; hit: BlockingHit } | null {
  // Every candidate is judged, a chunk at a time, until the budget runs out; the
  // session's list goes newest first.
  const candidates = opts.newestFirst ? [...inScope].reverse() : inScope;
  // Encoded files (not plain UTF-8), judged after every UTF-8 file, with their screen lines.
  const encoded = new Map<string, string[]>();
  for (let i = 0; i < candidates.length && Date.now() < deadline; i += MAX_FILES) {
    const chunk = candidates.slice(i, i + MAX_FILES);
    const added = addedLinesSinceHead(root, chunk, deadline, scopes, pairing);
    // Git failed this chunk: files already gathered for git's own diff are still asked.
    if (!added) { if (encoded.size) break; return null; }
    // Files measured before the deadline are judged; the rest fail open.
    for (const target of chunk) {
      const lines = added.get(target);
      if (pairing.encoded.has(target)) { encoded.set(target, lines ?? []); continue; }
      if (!lines?.length) continue;
      // One file the judge cannot take (a pathological size) skips alone.
      let hit: BlockingHit | null = null;
      try { hit = judge(target, lines); } catch { continue; }
      if (!hit) continue;
      // CONFIRM the screened hit with the base's exact measure; a hit already
      // screened is not lost to the budget, and a failed confirm keeps it.
      const confirmed = confirmLines(root, target, pairing.newFiles.has(target), Math.max(deadline, Date.now() + CONFIRM_FLOOR_MS), pairing.renamed.get(target));
      if (confirmed === null) return { target, hit };
      let exact: BlockingHit | null = null;
      try { exact = confirmed.length ? judge(target, confirmed) : null; } catch { exact = null; }
      if (exact) return { target, hit: exact };
    }
  }
  // An encoded file: git's own text diff when it has one (authoritative), else the
  // decoded screen reading; with the budget spent, the screen reading stands.
  for (const [target, screen] of encoded) {
    const g = Date.now() < deadline ? confirmLines(root, target, pairing.newFiles.has(target), deadline, pairing.renamed.get(target)) : null;
    const lines = g !== null ? g : screen;
    if (!lines.length) continue;
    let hit: BlockingHit | null = null;
    try { hit = judge(target, lines); } catch { continue; }
    if (hit) return { target, hit };
  }
  return null;
}

/** The deny text for a shell write: the decision's own reason, plus what to do,
 *  since the write already happened. Like the pre-edit text, it names the decision
 *  and never the way around the guard. */
export function shellVetoReason(target: string, hit: BlockingHit, when: "write" | "stop" | "tree"): string {
  const what = hit.event.kind === "constraint" ? "a broken blocking invariant" : "a rejected approach";
  const how = when === "write"
    ? `A shell command just wrote ${target}, outside the Edit/Write tools.`
    : when === "tree" ? `${target} differs from HEAD with ${what} at the end of this turn.`
    : `${target}, written by a shell command this session, still holds ${what} at the end of this turn.`;
  return `${how} ${hit.reason} Revert that change in ${target} before continuing.`;
}
