/** Sibling-fix lessons: carry a fix made to one function over to the
 * same-shaped function it was never applied to.
 *
 * A constraint states the rule ("merge idempotently, never clobber"); the
 * concrete lesson lives in the commit that hardened ONE copy of a pattern. When
 * a near-identical function elsewhere never received that change, an agent
 * extending it inherits the old flaw while believing the rule is satisfied.
 *
 * Deterministic, no records required — git history is the evidence:
 *   1. parse the target file (tree-sitter) and pair each function with indexed
 *      functions whose NAME tokens and BODY tokens overlap (Jaccard),
 *   2. `git log -L` both functions; commits that substantively changed the
 *      sibling but never touched the target are the divergence,
 *   3. surface a pair only when at least one divergent commit is a fix, with
 *      the sibling's current body — its code and comments carry the lesson.
 *
 * Bounded like cochange.ts: few pairs, one wall-clock budget for all git calls,
 * a per-HEAD cache under .hunch-cache (an incomplete run is cached as no
 * answer), and any failure yields no lessons — never an error. */
import { execFileSync } from "node:child_process";
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { createHash } from "node:crypto";
import { join } from "node:path";
import { parseSource } from "../extractors/parse.js";
import { languageFor } from "../extractors/languages.js";

export interface SiblingCommit {
  sha: string;
  subject: string;
  fix: boolean;
  /** The commit's changed lines inside the sibling, in hunk order, `+`/`-` prefixed. */
  change: string[];
  /** Test files the same commit changed: the proof that came with the fix. */
  tests?: string[];
}
export interface SiblingLesson {
  symbol: string;
  file: string;
  line: number;
  sibling: string;
  siblingFile: string;
  siblingStart: number;
  siblingEnd: number;
  similarity: number;
  commits: SiblingCommit[];
}
export interface SiblingOptions {
  /** Candidate pairs whose history is inspected (best similarity first). */
  maxPairs?: number;
  /** Lessons returned. */
  maxLessons?: number;
  /** Per git call; each call is also capped by what is left of `budgetMs`. */
  timeoutMs?: number;
  /** Wall-clock budget for the whole computation; past it the result is incomplete. */
  budgetMs?: number;
  /** Cap on the no-index inventory scan (tests force truncation with it). */
  inventoryBudgetMs?: number;
  /** Set false to bypass the .hunch-cache read/write (tests). */
  cache?: boolean;
  /** Clock for the incomplete-run retry window (tests). */
  now?: number;
}
interface IndexedSymbol { file: string; name: string; kind: string }
interface FnRange { name: string; start: number; end: number; body: string }

const FN_KINDS = new Set(["function", "method"]);
const TEST_PATH = /(^|\/)(test|tests|__tests__|spec|fixtures?)\/|\.(test|spec)\.[a-z]+$/i;
const MIN_NAME_JACCARD = 0.5;
const MIN_BODY_OVERLAP = 0.5;
/** Mean of name and body similarity. Measured on this repo's own history:
 *  below 0.6 the pairs were mostly unrelated helpers sharing a verb. */
const MIN_SIMILARITY = 0.6;
const MIN_BODY_LINES = 3;
const MAX_COMMITS_SHOWN = 4;
/** Changed lines shown per commit: the change itself is the lesson, a subject
 *  like "feat(codex): …" rarely names the behaviour it fixed. */
const MAX_CHANGE_LINES = 12;
/** A fix commit's change is the lesson itself: capping it at 12 hid the second
 *  half of a two-commit fix (trap-310 v5 carried one commit, missed the other). */
const MAX_FIX_CHANGE_LINES = 32;
/** Bumped when the cached lesson shape changes. */
const CACHE_VERSION = 6;
/** Candidate files whose bodies are parsed (best name match first). */
const MAX_CANDIDATE_FILES = 8;
/** Words too common in code to count as shared shape. */
const STOP = new Set([
  "const", "let", "var", "return", "function", "if", "else", "for", "while", "new", "this", "true", "false",
  "null", "undefined", "typeof", "instanceof", "string", "number", "boolean", "void", "async", "await",
  "export", "import", "from", "def", "self", "none", "fn", "pub", "func", "err", "nil", "the", "and",
]);

/** `isHunchProviderHook` → {is, hunch, provider, hook}. */
export function nameTokens(name: string): Set<string> {
  return new Set(name.replace(/([a-z0-9])([A-Z])/g, "$1 $2").replace(/([A-Z]+)([A-Z][a-z])/g, "$1 $2")
    .toLowerCase().split(/[^a-z0-9]+/).filter(Boolean));
}

/** Identifier-ish tokens of a body's CODE, including those inside regex/string
 *  literals. Comment lines are dropped: a fix usually adds an explanation, and
 *  its prose would otherwise swamp the shared shape. */
export function codeTokens(text: string): Set<string> {
  const code = text.replace(/\/\*[\s\S]*?\*\//g, "").split(/\r?\n/)
    .filter((line) => !/^\s*(\/\/|#|--|\*)/.test(line)).join("\n");
  const out = new Set<string>();
  for (const word of code.match(/[A-Za-z_][A-Za-z0-9_]*/g) ?? []) {
    for (const t of nameTokens(word)) if (t.length > 2 && !STOP.has(t)) out.add(t);
  }
  return out;
}

/** Overlap coefficient: shared / smaller set. A hardened copy grows, so
 *  containment — not Jaccard — is what "same shape" means for bodies. */
export function overlap(a: ReadonlySet<string>, b: ReadonlySet<string>): number {
  if (!a.size || !b.size) return 0;
  let shared = 0;
  for (const x of a) if (b.has(x)) shared++;
  return shared / Math.min(a.size, b.size);
}

function mentions(body: string, name: string): boolean {
  const escaped = name.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
  return new RegExp(`(?<![A-Za-z0-9_$])${escaped}(?![A-Za-z0-9_$])`).test(body.slice(body.indexOf("\n") + 1));
}


export function jaccard(a: ReadonlySet<string>, b: ReadonlySet<string>): number {
  if (!a.size || !b.size) return 0;
  let shared = 0;
  for (const x of a) if (b.has(x)) shared++;
  return shared / (a.size + b.size - shared);
}

export function isFixSubject(subject: string): boolean {
  return /^(fix|hotfix|bugfix)\b|\b(fix(e[sd])?|bug|hotfix|regression)\b/i.test(subject);
}

export interface LineLogCommit {
  sha: string;
  subject: string;
  added: string[];
  removed: string[];
  /** Added and removed lines in hunk order, `+`/`-` prefixed. */
  diff: string[];
  /** Largest old/new line span of any hunk — how far git's range reached. */
  span: number;
  /** Every hunk starts from nothing (`@@ -0,0 …`): the function was created here. */
  created: boolean;
}

/** Parse `git log -L … --format=%x1eC %H%x1f%s` output. */
export function parseLineLog(output: string): LineLogCommit[] {
  const commits: LineLogCommit[] = [];
  for (const chunk of output.split("\x1e").slice(1)) {
    const nl = chunk.indexOf("\n");
    const head = nl < 0 ? chunk : chunk.slice(0, nl);
    const m = /^C ([0-9a-f]{40})\x1f(.*)$/.exec(head);
    if (!m) continue;
    const commit: LineLogCommit = { sha: m[1]!, subject: m[2]!.trim(), added: [], removed: [], diff: [], span: 0, created: false };
    let hunks = 0, fromNothing = 0;
    for (const line of (nl < 0 ? "" : chunk.slice(nl + 1)).split("\n")) {
      if (line.startsWith("+++") || line.startsWith("---")) continue;
      const hunk = /^@@ -\d+(?:,(\d+))? \+\d+(?:,(\d+))? @@/.exec(line);
      if (hunk) {
        commit.span = Math.max(commit.span, Number(hunk[1] ?? 1), Number(hunk[2] ?? 1));
        hunks++;
        if (hunk[1] === "0") fromNothing++;
        continue;
      }
      if (line.startsWith("+")) { commit.added.push(line.slice(1)); commit.diff.push(line); }
      else if (line.startsWith("-")) { commit.removed.push(line.slice(1)); commit.diff.push(line); }
    }
    commit.created = hunks > 0 && fromNothing === hunks;
    commits.push(commit);
  }
  return commits;
}

/** A commit whose removed and added lines differ only in whitespace/line
 *  endings (a reformat, a CRLF→LF sweep, a re-indent) changed nothing. */
export function isSubstantive(commit: LineLogCommit): boolean {
  const norm = (lines: string[]) => lines.map((l) => l.replace(/\s+/g, "")).filter(Boolean).sort().join("\n");
  return norm(commit.added) !== norm(commit.removed);
}

function gitEnv(): NodeJS.ProcessEnv {
  const env: NodeJS.ProcessEnv = {};
  for (const [k, v] of Object.entries(process.env)) if (!k.startsWith("GIT_")) env[k] = v;
  env.GIT_OPTIONAL_LOCKS = "0";
  env.GIT_TERMINAL_PROMPT = "0";
  return env;
}

/** One wall-clock deadline shared by every git call of a computation. A call
 *  that timed out or found the budget spent marks it `exhausted`. */
interface Budget { deadline: number; timeoutMs: number; exhausted: boolean }

function git(root: string, args: string[], env: NodeJS.ProcessEnv, budget: Budget): string | null {
  const ms = Math.min(budget.timeoutMs, budget.deadline - Date.now());
  if (ms <= 0) { budget.exhausted = true; return null; }
  try {
    return execFileSync("git", ["-C", root, ...args], {
      env, timeout: ms, encoding: "utf8", maxBuffer: 16_000_000, stdio: ["ignore", "pipe", "ignore"],
    });
  } catch (error) {
    const e = error as { signal?: unknown; code?: unknown };
    if (e.signal || e.code === "ETIMEDOUT") budget.exhausted = true;
    return null;
  }
}

/** Functions of one file AS COMMITTED at `rev` — `git log -L` line numbers
 *  refer to that content, not to an in-progress working-tree edit. */
function functionsAt(root: string, file: string, env: NodeJS.ProcessEnv, budget: Budget, rev = "HEAD"): FnRange[] {
  const source = git(root, ["show", `${rev}:${file}`], env, budget);
  return source == null ? [] : functionsIn(file, source);
}

function functionsIn(file: string, source: string): FnRange[] {
  const parsed = parseSource(file, source);
  if (!parsed) return [];
  // tree-sitter's node indices here are string offsets (parse.ts slices
  // bodyText the same way), so lines are counted on the string itself.
  const lineStarts = [0];
  for (let i = 0; i < source.length; i++) if (source.charCodeAt(i) === 10) lineStarts.push(i + 1);
  const lineAt = (index: number) => {
    let lo = 0, hi = lineStarts.length - 1;
    while (lo < hi) {
      const mid = (lo + hi + 1) >> 1;
      if (lineStarts[mid]! <= index) lo = mid; else hi = mid - 1;
    }
    return lo + 1;
  };
  const out: FnRange[] = [];
  for (const s of parsed.symbols) {
    if (!FN_KINDS.has(s.kind)) continue;
    const start = lineAt(s.startByte);
    const end = lineAt(Math.max(s.startByte, s.endByte - 1));
    if (end - start + 1 < MIN_BODY_LINES) continue;
    out.push({ name: s.name, start, end, body: source.slice(lineStarts[start - 1]!, s.endByte) });
  }
  return out;
}

const MAX_LOG_COMMITS = 40;
const MAX_REANCHORS = 3;
/** Wall-clock budget for the no-index function inventory (nearest files first). */
const INVENTORY_BUDGET_MS = 4_000;
/** Wall-clock budget for one whole computation. */
const TOTAL_BUDGET_MS = 5_000;
/** An incomplete run is retried after this long, at most this many times per HEAD. */
const INCOMPLETE_RETRY_MS = 60_000;
const MAX_INCOMPLETE_ATTEMPTS = 3;

/** The function's attributable history, newest first. Where git loses the
 *  range at a whole-file rewrite, the rewrite itself is skipped (its hunk says
 *  nothing about the function) and the walk RE-ANCHORS: the same-named function
 *  nearest the previous range is located in the rewrite's parent and followed
 *  from there. `lost` lists those rewrites: each DID touch the file, and may
 *  have changed the function too. */
function lineLog(root: string, file: string, fn: FnRange, env: NodeJS.ProcessEnv, budget: Budget): { commits: LineLogCommit[]; lost: string[] } | null {
  const out: LineLogCommit[] = [];
  const lost: string[] = [];
  let rev = "HEAD";
  let range: FnRange = fn;
  for (let anchor = 0; anchor <= MAX_REANCHORS && out.length < MAX_LOG_COMMITS; anchor++) {
    const raw = git(root, ["log", "--no-color", "-n", String(MAX_LOG_COMMITS), "--format=%x1eC %H%x1f%s", "-L", `${range.start},${range.end}:${file}`, rev], env, budget);
    if (raw == null) return null;
    const { kept, lostAt } = attributable(parseLineLog(raw), range.end - range.start + 1);
    out.push(...kept);
    if (!lostAt) break;
    lost.push(lostAt);
    const parent = `${lostAt}^`;
    const previous = range.start;
    const again = functionsAt(root, file, env, budget, parent).filter((f) => f.name === fn.name)
      .sort((a, b) => Math.abs(a.start - previous) - Math.abs(b.start - previous))[0];
    if (!again) break;
    rev = parent;
    range = again;
  }
  return { commits: out.slice(0, MAX_LOG_COMMITS), lost };
}

/** git follows a line range backwards only while it can map it. A whole-file
 *  rewrite (a line-ending sweep, a reformat) breaks the mapping: from that
 *  commit on, every hunk spans the whole file and nothing in it is attributable
 *  to the function. Keep the history before that commit and report where the
 *  mapping was lost. */
export function attributable(commits: readonly LineLogCommit[], fnLines: number): { kept: LineLogCommit[]; lostAt: string | null } {
  const limit = fnLines * 3 + 20;
  const kept: LineLogCommit[] = [];
  for (const c of commits) {
    if (c.span > limit) return { kept, lostAt: c.sha };
    kept.push(c);
  }
  return { kept, lostAt: null };
}

/** Path proximity: how many leading directories `p` shares with `target`. */
function proximityTo(target: string): (p: string) => number {
  const dir = (p: string) => p.split("/").slice(0, -1);
  const own = dir(target);
  return (p: string) => {
    const d = dir(p);
    let i = 0;
    while (i < d.length && i < own.length && d[i] === own[i]) i++;
    return i;
  };
}

/** First directory of a repo-relative path ("" at the root): a truncated
 *  inventory scanned nearest-first only serves targets in the same subtree. */
function scopeOf(target: string): string {
  return target.includes("/") ? target.split("/")[0]! : "";
}

interface InventoryCache { complete: boolean; scope: string; symbols: IndexedSymbol[] }

/** Function names per tracked source file when no symbol index exists yet (a
 *  fresh clone: the index is derived and gitignored). Files nearest the target
 *  are parsed first under a time budget; the result is cached per HEAD. */
function functionInventory(root: string, target: string, head: string, env: NodeJS.ProcessEnv, budget: Budget, scanMs: number): IndexedSymbol[] {
  const cacheDir = join(root, ".hunch-cache", "siblingfix");
  const cacheFile = join(cacheDir, `${head.slice(0, 12)}-inventory.json`);
  const scope = scopeOf(target);
  if (existsSync(cacheFile)) {
    try {
      const cached = JSON.parse(readFileSync(cacheFile, "utf8")) as InventoryCache;
      // A truncated scan holds the files nearest ITS target; elsewhere it would
      // miss the nearest siblings, so another subtree rescans.
      if (Array.isArray(cached.symbols) && (cached.complete || cached.scope === scope)) return cached.symbols;
    } catch { /* rebuild */ }
  }
  const listed = git(root, ["ls-files"], env, budget);
  if (listed == null) return [];
  const proximity = proximityTo(target);
  const files = listed.split("\n").filter((f) => f && f !== target && !TEST_PATH.test(f) && languageFor(f))
    .sort((a, b) => proximity(b) - proximity(a) || a.localeCompare(b));
  const deadline = Math.min(Date.now() + scanMs, budget.deadline);
  const out: IndexedSymbol[] = [];
  let complete = true;
  for (const f of files) {
    if (Date.now() >= deadline) { complete = false; break; }
    let source: string;
    try { source = readFileSync(join(root, f), "utf8"); } catch { continue; }
    if (source.length > 400_000) continue;
    for (const s of parseSource(f, source)?.symbols ?? []) if (FN_KINDS.has(s.kind)) out.push({ file: f, name: s.name, kind: s.kind });
  }
  // Cached even when the budget cut it short: the nearest files came first, and
  // re-scanning on every edit would charge a large repo the budget each time.
  try {
    mkdirSync(cacheDir, { recursive: true });
    writeFileSync(cacheFile, JSON.stringify({ complete, scope, symbols: out } satisfies InventoryCache));
  } catch { /* cache is a convenience */ }
  return out;
}

interface Pair { target: FnRange; sibling: FnRange; siblingFile: string; similarity: number }

/** Sibling-fix lessons for one repo-relative file. */
export function siblingLessonsFor(
  root: string,
  file: string,
  symbols: readonly IndexedSymbol[],
  options: SiblingOptions = {},
): SiblingLesson[] {
  const maxPairs = options.maxPairs ?? 4;
  const maxLessons = options.maxLessons ?? 2;
  const budget: Budget = { deadline: Date.now() + (options.budgetMs ?? TOTAL_BUDGET_MS), timeoutMs: options.timeoutMs ?? 2_000, exhausted: false };
  const target = file.replace(/\\/g, "/");
  if (TEST_PATH.test(target)) return [];
  const env = gitEnv();
  const head = git(root, ["rev-parse", "HEAD"], env, budget)?.trim();
  if (!head) return [];
  const cacheDir = join(root, ".hunch-cache", "siblingfix");
  const cacheFile = join(cacheDir, `${head.slice(0, 12)}-${createHash("sha256").update(`${CACHE_VERSION}\n${target}\n${maxPairs}\n${maxLessons}`).digest("hex").slice(0, 16)}.json`);
  const now = options.now ?? Date.now();
  let attempts = 0;
  if (options.cache !== false && existsSync(cacheFile)) {
    try {
      const cached = JSON.parse(readFileSync(cacheFile, "utf8")) as { complete: boolean; lessons: SiblingLesson[]; attempts?: number; at?: number };
      if (cached.complete) return cached.lessons;
      // An incomplete run is "no answer" for a while, not for the whole HEAD: a
      // momentarily loaded machine must not silence the lesson for good, and a
      // history that is always too slow stops being retried after a few tries.
      attempts = cached.attempts ?? MAX_INCOMPLETE_ATTEMPTS;
      if (attempts >= MAX_INCOMPLETE_ATTEMPTS || now - (cached.at ?? 0) < INCOMPLETE_RETRY_MS) return [];
    } catch { /* recompute */ }
  }
  const scanMs = Math.min(options.inventoryBudgetMs ?? INVENTORY_BUDGET_MS, budget.deadline - Date.now());
  const computed = computeLessons(root, target, head, symbols, env, budget, scanMs, maxPairs, maxLessons);
  const complete = computed.complete && !budget.exhausted;
  if (options.cache !== false) {
    try {
      mkdirSync(cacheDir, { recursive: true });
      writeFileSync(cacheFile, JSON.stringify(complete ? { complete, lessons: computed.lessons } : { complete, lessons: [], attempts: attempts + 1, at: now }));
    } catch { /* cache is a convenience */ }
  }
  // A git call that failed or timed out is not an answer.
  return complete ? computed.lessons : [];
}

function computeLessons(
  root: string,
  target: string,
  head: string,
  symbols: readonly IndexedSymbol[],
  env: NodeJS.ProcessEnv,
  budget: Budget,
  scanMs: number,
  maxPairs: number,
  maxLessons: number,
): { lessons: SiblingLesson[]; complete: boolean } {
  let complete = true;
  const own = functionsAt(root, target, env, budget);
  if (!own.length) return { lessons: [], complete };
  // Cheap retrieval by name shape; bodies are parsed only for files that hold
  // a candidate.
  // HEAD is scanned even when an index exists: a derived index can lag HEAD
  // or hold a partial subset, and a missing sibling means a missed lesson.
  // Indexed names only add candidates; bodies always come from HEAD.
  const inventory = [...functionInventory(root, target, head, env, budget, scanMs), ...symbols];
  const byFile = new Map<string, Set<string>>();
  const bestName = new Map<string, number>();
  for (const fn of own) {
    const tokens = nameTokens(fn.name);
    for (const s of inventory) {
      if (!FN_KINDS.has(s.kind) || TEST_PATH.test(s.file)) continue;
      if (s.file === target && s.name === fn.name) continue;
      const other = nameTokens(s.name);
      let shared = 0;
      for (const t of tokens) if (other.has(t)) shared++;
      const nameSim = jaccard(tokens, other);
      if (shared < 2 || nameSim < MIN_NAME_JACCARD) continue;
      const names = byFile.get(s.file) ?? new Set<string>();
      names.add(s.name);
      byFile.set(s.file, names);
      bestName.set(s.file, Math.max(bestName.get(s.file) ?? 0, nameSim));
    }
  }
  // Parsing is the cost: only the files with the closest-named candidates.
  const proximity = proximityTo(target);
  const candidateFiles = [...byFile.keys()]
    .sort((a, b) => bestName.get(b)! - bestName.get(a)! || proximity(b) - proximity(a) || a.localeCompare(b))
    .slice(0, MAX_CANDIDATE_FILES);
  const pairs: Pair[] = [];
  for (const siblingFile of candidateFiles) {
    if (budget.deadline <= Date.now()) return { lessons: [], complete: false };
    const names = byFile.get(siblingFile)!;
    const fns = siblingFile === target ? own : functionsAt(root, siblingFile, env, budget);
    for (const sibling of fns) {
      if (!names.has(sibling.name)) continue;
      for (const fn of own) {
        if (siblingFile === target && fn.name === sibling.name) continue;
        const nameSim = jaccard(nameTokens(fn.name), nameTokens(sibling.name));
        if (nameSim < MIN_NAME_JACCARD) continue;
        // A function that calls the other delegates to it; it is not a copy.
        if (mentions(fn.body, sibling.name) || mentions(sibling.body, fn.name)) continue;
        const bodySim = overlap(codeTokens(fn.body), codeTokens(sibling.body));
        if (bodySim < MIN_BODY_OVERLAP) continue;
        const similarity = Math.round(((nameSim + bodySim) / 2) * 100) / 100;
        if (similarity < MIN_SIMILARITY) continue;
        pairs.push({ target: fn, sibling, siblingFile, similarity });
      }
    }
  }
  pairs.sort((a, b) => b.similarity - a.similarity || a.siblingFile.localeCompare(b.siblingFile) || a.sibling.name.localeCompare(b.sibling.name));

  const lessons: SiblingLesson[] = [];
  const ownHistory = new Map<string, { touched: Set<string>; incomplete: boolean } | null>();
  for (const pair of pairs.slice(0, maxPairs)) {
    if (lessons.length >= maxLessons) break;
    if (budget.deadline <= Date.now()) { complete = false; break; }
    const key = `${pair.target.name}@${pair.target.start}`;
    if (!ownHistory.has(key)) {
      const log = lineLog(root, target, pair.target, env, budget);
      // A rewrite where tracking was lost touched the file: count it as touched.
      ownHistory.set(key, log ? { touched: new Set([...log.commits.map((c) => c.sha), ...log.lost]), incomplete: log.lost.length > 0 } : null);
    }
    const history = ownHistory.get(key);
    if (!history) { complete = false; continue; }
    const siblingLog = lineLog(root, pair.siblingFile, pair.sibling, env, budget);
    if (!siblingLog) { complete = false; continue; }
    // Divergence: substantive changes to the sibling that never touched the
    // target. Shared commits already carried their change to both copies.
    // The sibling's creation is not a change made to it.
    let divergent = siblingLog.commits.filter((c) => !history.touched.has(c.sha) && !c.created && isSubstantive(c));
    if (history.incomplete && divergent.length) {
      // The target's own walk lost tracking somewhere, so its history is not
      // exhaustive: a commit that modified the target file at all may have
      // carried the change there too.
      const modifiedTarget = new Set<string>();
      for (const c of divergent) {
        const files = git(root, ["show", "--no-color", "--name-only", "--format=", c.sha, "--", target], env, budget);
        if (files == null) { complete = false; break; }
        if (files.trim()) modifiedTarget.add(c.sha);
      }
      if (!complete) continue;
      divergent = divergent.filter((c) => !modifiedTarget.has(c.sha));
    }
    if (!divergent.some((c) => isFixSubject(c.subject))) continue;
    const commits = divergent.slice(0, MAX_COMMITS_SHOWN).map((c) => ({ sha: c.sha, subject: c.subject, fix: isFixSubject(c.subject), change: changeLines(c.diff, isFixSubject(c.subject)), tests: commitTests(root, c.sha, env, budget) }));
    lessons.push({
      symbol: pair.target.name,
      file: target,
      line: pair.target.start,
      sibling: pair.sibling.name,
      siblingFile: pair.siblingFile,
      siblingStart: pair.sibling.start,
      siblingEnd: pair.sibling.end,
      similarity: pair.similarity,
      commits,
    });
  }
  return { lessons, complete };
}

const MAX_TESTS_SHOWN = 2;
/** Test files a commit changed (best effort: a failed call just shows none). */
function commitTests(root: string, sha: string, env: NodeJS.ProcessEnv, budget: Budget): string[] {
  const files = git(root, ["show", "--no-color", "--name-only", "--format=", sha], env, budget);
  return (files ?? "").split("\n").map((f) => f.trim()).filter((f) => f && TEST_PATH.test(f)).slice(0, MAX_TESTS_SHOWN);
}


/** Stable identity for hook dedupe: which fixes were surfaced, not the wording. */
export function siblingLessonsIdentity(lessons: readonly SiblingLesson[]): string {
  return lessons.map((l) => `${l.symbol}~${l.siblingFile}:${l.sibling}@${l.commits.map((c) => c.sha.slice(0, 12)).join(",")}`).join(";");
}

/** A commit's diff inside the function, blank-only lines dropped, capped
 *  (a fix commit gets the larger cap). */
export function changeLines(diff: readonly string[], fix = false): string[] {
  const max = fix ? MAX_FIX_CHANGE_LINES : MAX_CHANGE_LINES;
  const lines = diff.filter((l) => l.slice(1).trim()).map((l) => l.replace(/\s+$/, ""));
  return lines.length > max ? [...lines.slice(0, max), `  … ${lines.length - max} more changed line(s)`] : lines;
}

const CUT = /^\s*… (\d+) more changed line\(s\)$/;

/** A capped change, rendered: the cut marker moves out of the diff fence and
 *  says how to read the rest, so a truncated fix is fetched, not skipped. */
function renderChange(c: SiblingCommit, siblingFile: string): string[] {
  if (!c.change.length) return [];
  const last = c.change.at(-1)!;
  const cut = CUT.exec(last);
  const shown = cut ? c.change.slice(0, -1) : c.change;
  return [
    "  ```diff", ...shown.map((line) => `  ${line}`), "  ```",
    ...(cut ? [`  ${cut[1]} more changed line(s) not shown are part of this change; read them before carrying it: git show ${c.sha.slice(0, 8)} -- ${siblingFile}`] : []),
  ];
}

export const SIBLING_HEADING = "## ⚠ Fix not carried to this function";

/** Callers of each lesson's function, by lesson symbol: names of functions in
 *  the same working-tree file whose body calls it. */
export type SiblingCallers = ReadonlyMap<string, readonly string[]>;

/** Written to be acted on, not skimmed: an agent reads "possible, heuristic,
 *  elsewhere" as out of scope and moves on (trap-310: three deliveries, zero
 *  follow-ups). So the lesson says what this copy lacks, which code here runs
 *  through it, and asks for an explicit outcome. It stays advisory: "does not
 *  apply, because …" is always an accepted answer. */
/** A blocking invariant whose scope covers the lesson's file. */
export interface SiblingInvariant { id: string; statement: string }

/** "Pre-existing" and "outside this task" are how an agent that agrees with the
 *  lesson still leaves it (trap-310 v4: gap confirmed, reported, not fixed).
 *  The change in hand runs through the copy, so only "cannot reach it" or
 *  "already handled" count as not applying. */
export const NOT_A_REASON = "\"Pre-existing\" or \"outside this task\" does not count: the change you are making runs through this copy, so leaving it ships the gap again inside your change.";

export function renderSiblingLessons(lessons: readonly SiblingLesson[], callers: SiblingCallers = new Map(), invariants: readonly SiblingInvariant[] = []): string {
  if (!lessons.length) return "";
  const blocks = lessons.map((l) => {
    const via = callers.get(l.symbol) ?? [];
    const tests = [...new Set(l.commits.flatMap((c) => c.tests ?? []))];
    return [
      `- \`${l.symbol}\` (${l.file}:${l.line}) has the same shape as \`${l.sibling}\` (${l.siblingFile}:${l.siblingStart}, similarity ${l.similarity}). The sibling was later changed; git shows this copy never received the change:`,
      ...l.commits.flatMap((c) => [`  ${c.sha.slice(0, 8)} ${c.subject}`, ...renderChange(c, l.siblingFile)]),
      ...(l.commits.length > 1 ? [`  All ${l.commits.length} commits above are part of what this copy lacks; carrying one of them leaves the rest of the gap.`] : []),
      ...(tests.length ? [`  The fix came with tests in ${tests.join(", ")}; the same input against \`${l.symbol}\` needs its own test.`] : []),
      ...(via.length ? [`  In this file ${via.slice(0, 3).map((v) => `\`${v}\``).join(", ")} call${via.length === 1 ? "s" : ""} \`${l.symbol}\`, so a change here runs through the copy that lacks it.`] : []),
      ...(invariants.length ? [`  This file is covered by blocking invariant${invariants.length === 1 ? "" : "s"} ${invariants.slice(0, 2).map((c) => `${c.id} ("${c.statement.length > 140 ? `${c.statement.slice(0, 139)}…` : c.statement}")`).join("; ")}: if the gap is real, it violates ${invariants.length === 1 ? "it" : "them"}.`] : []),
      `  Treat this as part of the task. If the input the sibling now handles can reach \`${l.symbol}\`, carry the change and a test for it. It does not apply only if that input cannot reach \`${l.symbol}\` or is already handled another way; then say which, in your final answer. ${NOT_A_REASON} Full history: git log -L ${l.siblingStart},${l.siblingEnd}:${l.siblingFile}`,
    ].join("\n");
  });
  return `${SIBLING_HEADING}\nMatched by code shape and git history, so check before copying: the change may already be present in another form.\n${blocks.join("\n")}`;
}

/** The working-tree function named `symbol` in `file` (never HEAD: the agent's
 *  own edits are what the reminder has to see). */
function workingFunctions(root: string, file: string): FnRange[] {
  try {
    return functionsIn(file, readFileSync(join(root, file), "utf8"));
  } catch {
    return [];
  }
}

/** Hash of the function's current body, or null when it cannot be found. A
 *  changed hash means the agent touched the function after the lesson. */
export function functionBodyHash(root: string, file: string, symbol: string): string | null {
  const fn = workingFunctions(root, file).find((f) => f.name === symbol);
  return fn ? createHash("sha256").update(fn.body).digest("hex").slice(0, 16) : null;
}

function callersIn(fns: readonly FnRange[], symbol: string): string[] {
  return [...new Set(fns.filter((f) => f.name !== symbol && mentions(f.body, symbol)).map((f) => f.name))];
}

export interface SiblingGrounding { text: string; identity: string; lessons: SiblingLesson[]; callers: SiblingCallers }
/** Grounding-path entry: the rendered block plus its dedupe identity for one
 *  repo-relative file. Never throws — a parser load failure or a git error
 *  means no sibling lessons, not a failed edit hook. */
export function siblingGrounding(root: string, file: string, symbols: readonly IndexedSymbol[], invariants: readonly SiblingInvariant[] = []): SiblingGrounding {
  const none: SiblingGrounding = { text: "", identity: "", lessons: [], callers: new Map() };
  try {
    if (!existsSync(join(root, file))) return none;
    const lessons = siblingLessonsFor(root, file, symbols);
    if (!lessons.length) return none;
    const fns = workingFunctions(root, file);
    const callers = new Map(lessons.map((l) => [l.symbol, callersIn(fns, l.symbol)]));
    return { text: renderSiblingLessons(lessons, callers, invariants), identity: siblingLessonsIdentity(lessons), lessons, callers };
  } catch {
    return none;
  }
}
