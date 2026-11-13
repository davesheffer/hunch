/**
 * `hunch spec-sync on|off|add <spec>|check` (design §1, §2, §6.4). Opt-in: nothing runs
 * until `.hunch/spec-sync.json` exists and is enabled. Config writes go through the
 * atomic writer; `check` exits 0 clean, 1 findings, 2 config error (SS-6.7, SS-7.3).
 */
import { spawnSync } from "node:child_process";
import { existsSync, readdirSync, readFileSync, statSync } from "node:fs";
import { basename, dirname, isAbsolute, relative, resolve } from "node:path";
import type { Command, CommanderError } from "commander";
import { writeFileAtomic } from "../core/io.js";
import { findRoot } from "../core/paths.js";
import { junitIsFresh, readJunitFile } from "../core/junit.js";
import {
  SPEC_SYNC_FILE, SpecSyncConfigError, clausePrefixes, computeFindings, editSpecSyncConfig, finding, loadSpecSyncConfig,
  matchesAny, normalizeGlob, normPath, parseLegacyHeader, underSpecsDir, validateSpecSyncConfig,
  type Finding, type JunitCase, type SpecEntry, type SpecInput, type SpecSyncConfig,
} from "../core/specsync.js";
import { testFileNames } from "../extractors/specsyncTests.js";

const MAX_SCAN_BYTES = 5 * 1024 * 1024;

function git(root: string, args: string[], input?: string): { ok: boolean; out: string; err: string } {
  const r = spawnSync("git", args, { cwd: root, encoding: "utf8", windowsHide: true, maxBuffer: 256 * 1024 * 1024, ...(input !== undefined ? { input } : {}) });
  return { ok: !r.error && r.status === 0, out: r.stdout ?? "", err: (r.stderr || r.error?.message || "").trim() };
}

/** Output of a git call that must succeed: a failed call is an error, never "no output". */
function gitOut(root: string, args: string[], input?: string): string {
  const r = git(root, args, input);
  if (!r.ok) throw new Error(`git ${args.join(" ")} failed${r.err ? `: ${r.err}` : ""}`);
  return r.out;
}

/** The empty tree's id in this repository's object format (SHA-1 or SHA-256). */
function emptyTree(root: string): string {
  const id = gitOut(root, ["hash-object", "-t", "tree", "--stdin"], "").trim();
  if (!id) throw new Error("git hash-object returned no id for the empty tree");
  return id;
}

function zList(out: string): string[] {
  return out.split("\0").filter(Boolean);
}

/** The directory holding `.hunch/`, located the way every other command does (a monorepo
 *  package with its own `.hunch/` is its own root). Git runs there with cwd-relative paths. */
function repoRoot(cwd = process.cwd()): string {
  return findRoot(cwd);
}

/** Tracked files that still exist plus untracked, non-ignored files, root-relative POSIX. */
function repoFiles(root: string): string[] {
  const tracked = zList(gitOut(root, ["ls-files", "-z"]));
  const untracked = zList(gitOut(root, ["ls-files", "-z", "--others", "--exclude-standard"]));
  // A trailing `/` is a directory entry (an untracked nested repository), never a file.
  return [...new Set([...tracked, ...untracked].map(normPath))].filter((f) => !f.endsWith("/") && existsSync(resolve(root, f))).sort();
}

function readText(root: string, file: string): string | null {
  try {
    const abs = resolve(root, file);
    if (statSync(abs).size > MAX_SCAN_BYTES) return null;
    return readFileSync(abs, "utf8");
  } catch {
    return null;
  }
}

/** Every error in a spec-sync command exits 2: a config error names the field (SS-7.3);
 *  anything unexpected (EISDIR on the config path, an unreadable file) says what failed. */
function configErrorExit(e: unknown): void {
  if (e instanceof SpecSyncConfigError) {
    console.error(e.field.startsWith("--") ? `spec-sync: ${e.field}: ${e.detail}` : `spec-sync: config error in ${SPEC_SYNC_FILE} at \`${e.field}\`: ${e.detail}`);
  } else {
    console.error(`spec-sync: error: ${e instanceof Error ? e.message : String(e)}`);
  }
  process.exitCode = 2;
}

function guarded<A extends unknown[]>(fn: (...args: A) => void): (...args: A) => void {
  return (...args) => {
    try {
      fn(...args);
    } catch (e) {
      configErrorExit(e);
    }
  };
}

// ---- SS-2.6: the config must be committed ----------------------------------

/** Re-include the config when a `.hunch/*`-style rule ignores it; when `.hunch/` itself
 *  is ignored (a `!` line cannot undo that), say how to add it anyway. */
export function ensureConfigNotIgnored(root: string): string[] {
  const check = () => {
    const r = git(root, ["check-ignore", "-z", "-v", "--stdin"], `${SPEC_SYNC_FILE}\0`);
    if (!r.ok) return null;
    const [source, line, pattern] = r.out.split("\0");
    return source && line && pattern && !pattern.startsWith("!") ? { source, line: Number(line), pattern } : null;
  };
  const rule = check();
  if (!rule) return [];
  const where = `${rule.source} line ${rule.line}: \`${rule.pattern}\``;
  const forceFix = `${SPEC_SYNC_FILE} is gitignored (${where}) and CI reads it: add it anyway with \`git add -f ${SPEC_SYNC_FILE}\` (a \`!\` line cannot re-include a file inside an ignored directory).`;
  if (git(root, ["check-ignore", "-q", "--", ".hunch"]).ok) return [forceFix];
  const src = resolve(root, rule.source);
  const rel = normPath(relative(root, src));
  const inRepo = !isAbsolute(rel) && !rel.startsWith("../") && !rel.startsWith(".git/") && basename(src) === ".gitignore";
  const target = inRepo ? src : resolve(root, ".gitignore");
  const fromDir = normPath(relative(dirname(target), resolve(root, SPEC_SYNC_FILE)));
  const line = dirname(target) === root ? `!${SPEC_SYNC_FILE}` : `!/${fromDir}`;
  const text = existsSync(target) ? readFileSync(target, "utf8") : "";
  writeFileAtomic(target, `${text}${text && !text.endsWith("\n") ? "\n" : ""}${line}\n`);
  const shown = normPath(relative(root, target));
  if (check()) return [forceFix];
  return [`${SPEC_SYNC_FILE} was gitignored (${where}): appended \`${line}\` to ${shown} so the config is committed (CI reads it).`];
}

// ---- on / off / add ---------------------------------------------------------

/** Legacy pilot headers in *.md files, as specs to import (SS-1.3). */
function legacyHeaders(root: string, files: string[]): { specs: SpecEntry[]; skipped: string[] } {
  const specs: SpecEntry[] = [];
  const skipped: string[] = [];
  for (const f of files.filter((p) => p.toLowerCase().endsWith(".md"))) {
    const text = readText(root, f);
    if (!text || !text.includes("spec-sync")) continue;
    const h = parseLegacyHeader(text);
    if (!h) continue;
    if (h.error) { skipped.push(`${f}: ${h.error}`); continue; }
    // Validate before import: an invalid glob is reported here, never written to the config.
    try {
      specs.push(validateSpecSyncConfig({ version: 1, specs: [{ id: h.id, path: f, code: h.code, tests: h.tests }] }).specs[0]!);
    } catch (e) {
      if (!(e instanceof SpecSyncConfigError)) throw e;
      skipped.push(`${f}: header ${e.field.replace(/^specs\[0\]\./, "")}: ${e.detail}`);
    }
  }
  return { specs, skipped };
}

function runOn(): void {
  const root = repoRoot();
  const legacy = legacyHeaders(root, repoFiles(root));
  const edit = editSpecSyncConfig(root, { enabled: true, addSpecs: legacy.specs });
  if (edit.created) console.log(`spec-sync: on — created ${SPEC_SYNC_FILE}.`);
  else if (edit.written) console.log(`spec-sync: on — updated ${SPEC_SYNC_FILE}.`);
  else console.log(`spec-sync: already on — ${SPEC_SYNC_FILE} unchanged.`);
  for (const s of edit.added) console.log(`  imported ${s.id} from the legacy header in ${s.path} (the spec file was not edited)`);
  for (const id of edit.kept) console.log(`  ${id} is already registered; its legacy header was not imported`);
  for (const s of legacy.skipped) console.log(`  legacy header not imported: ${s}`);
  for (const line of ensureConfigNotIgnored(root)) console.log(line);
}

function runOff(): void {
  const root = repoRoot();
  if (!existsSync(resolve(root, SPEC_SYNC_FILE))) {
    console.log(`spec-sync: not configured (${SPEC_SYNC_FILE} is absent); nothing to turn off.`);
    return;
  }
  const edit = editSpecSyncConfig(root, { enabled: false });
  console.log(edit.written ? `spec-sync: off — ${SPEC_SYNC_FILE} kept with enabled: false.` : "spec-sync: already off.");
}

const TEST_PATH = /(^|\/)(__tests__|tests?|spec)\/|[._-](test|spec)\.[^/]+$|(^|\/)test_[^/]+\.py$/i;

/** Whether a proposed entry validates as a config glob, so add never writes a config that
 *  check then refuses (a literal path such as `src/a{b/x.ts` is an unbalanced brace). */
function validGlob(glob: string, specPath: string): boolean {
  try {
    validateSpecSyncConfig({ version: 1, specs: [{ id: "X", path: specPath, code: [glob], tests: [] }] });
    return true;
  } catch (e) {
    if (e instanceof SpecSyncConfigError) return false;
    throw e;
  }
}

/** Code/test globs proposed from the repo paths a spec names (SS-2.4). A named path that
 *  is no valid glob is listed in `invalid`, never proposed. */
export function proposeGlobs(specText: string, specPath: string, files: readonly string[]): { code: string[]; tests: string[]; unknown: string[]; invalid: string[] } {
  const code = new Set<string>();
  const tests = new Set<string>();
  const unknown = new Set<string>();
  const invalid = new Set<string>();
  const fileSet = new Set(files);
  for (const m of specText.matchAll(/(?<![\w./*{}-])((?:\.?[\w*{},.-]+\/)+[\w*{},.-]+)/g)) {
    const p = m[1]!.replace(/[.,]+$/, "").replace(/^\.\//, "");
    if (!p || p === specPath || /^https?:|^\/\//.test(p)) continue;
    let glob: string | null = null;
    try {
      if (fileSet.has(p)) glob = p;
      else if (/[*?{]/.test(p) && files.some((f) => matchesAny(f, [p]))) glob = p;
      else if (files.some((f) => f.startsWith(`${p.replace(/\/+$/, "")}/`))) glob = `${p.replace(/\/+$/, "")}/**`;
    } catch {
      glob = null; // an invalid glob named in prose is not proposed
    }
    if (!glob) { unknown.add(p); continue; }
    if (!validGlob(glob, specPath)) { invalid.add(glob); continue; }
    (TEST_PATH.test(glob) ? tests : code).add(glob);
  }
  return { code: [...code].sort(), tests: [...tests].sort(), unknown: [...unknown].sort(), invalid: [...invalid].sort() };
}

function runAdd(specArg: string): void {
  const root = repoRoot();
  const asGiven = normPath(relative(root, resolve(process.cwd(), specArg)));
  const files = repoFiles(root);
  // The stored path is the repository's exact entry: a case-insensitive filesystem must
  // not let `Docs/X.md` be registered for `docs/x.md` (check matches paths exactly).
  const folded = files.filter((f) => f.toLowerCase() === asGiven.toLowerCase());
  const rel = files.includes(asGiven) ? asGiven : folded.length === 1 ? folded[0]! : null;
  const text = rel === null ? null : readText(root, rel);
  if (rel === null || text === null) {
    console.error(`spec-sync: cannot read spec ${specArg}: not a tracked or untracked file inside this repository${folded.length > 1 ? ` (several paths differ only in case: ${folded.join(", ")})` : ""}`);
    process.exitCode = 2;
    return;
  }
  const prefixes = clausePrefixes(text, rel);
  if (!prefixes.length) {
    console.error(`spec-sync: ${rel} has no clause markers like [ID-1.1]; add them first, then run add again`);
    process.exitCode = 2;
    return;
  }
  const id = prefixes[0]!.prefix;
  if (prefixes.length > 1) console.log(`  note: ${rel} uses several clause prefixes (${prefixes.map((p) => `${p.prefix}×${p.count}`).join(", ")}); registering ${id}`);
  const proposed = proposeGlobs(text, rel, files);
  const spec: SpecEntry = { id, path: rel, code: proposed.code, tests: proposed.tests };
  const edit = editSpecSyncConfig(root, { addSpecs: [spec] });
  if (edit.kept.length) {
    console.log(`spec-sync: ${id} is already registered in ${SPEC_SYNC_FILE}; left unchanged.`);
    return;
  }
  console.log(`spec-sync: registered ${id} → ${rel}${edit.created ? ` (created ${SPEC_SYNC_FILE})` : ""}`);
  console.log(`  code:  ${spec.code.length ? spec.code.join(", ") : "(none found — edit the config)"}`);
  console.log(`  tests: ${spec.tests.length ? spec.tests.join(", ") : "(none found — edit the config)"}`);
  if (proposed.unknown.length) console.log(`  paths named in the spec but not found: ${proposed.unknown.join(", ")}`);
  if (proposed.invalid.length) console.log(`  not proposed (not a valid glob; add by hand if needed): ${proposed.invalid.join(", ")}`);
  if (edit.created) for (const line of ensureConfigNotIgnored(root)) console.log(line);
}

// ---- check (SS-6.7) ---------------------------------------------------------

function defaultBaseRef(root: string): string | null {
  const head = git(root, ["symbolic-ref", "-q", "refs/remotes/origin/HEAD"]);
  // A dangling origin/HEAD (its target never fetched) is not a default branch.
  if (head.ok && head.out.trim() && git(root, ["rev-parse", "--verify", "-q", "--end-of-options", `${head.out.trim()}^{commit}`]).ok) return head.out.trim();
  for (const ref of ["origin/main", "origin/master", "main", "master"]) {
    if (git(root, ["rev-parse", "--verify", "-q", "--end-of-options", `${ref}^{commit}`]).ok) return ref;
  }
  return null;
}

/** The commit `check` diffs against: merge-base of base and HEAD (SS-6.7). Never a silent
 *  fallback: no resolvable default branch (a shallow CI checkout) is an error. */
function resolveBase(root: string, base?: string): { commit: string; label: string; empty: boolean } {
  if (base !== undefined && (base.startsWith("-") || !base.trim())) throw new SpecSyncConfigError("--base", `"${base}" is not a ref (a value starting with "-" is refused)`);
  const hasHead = git(root, ["rev-parse", "--verify", "-q", "HEAD^{commit}"]).ok;
  if (!hasHead) {
    if (base) throw new SpecSyncConfigError("--base", `cannot resolve "${base}": this repository has no commits`);
    return { commit: emptyTree(root), label: "(no commits)", empty: true };
  }
  const ref = base ?? defaultBaseRef(root);
  if (!ref) throw new SpecSyncConfigError("--base", "no default branch found (origin/HEAD, origin/main, origin/master, main, master); pass --base <ref>, or fetch the default branch (a shallow CI checkout has none)");
  const sha = git(root, ["rev-parse", "--verify", "-q", "--end-of-options", `${ref}^{commit}`]);
  if (!sha.ok || !sha.out.trim()) throw new SpecSyncConfigError("--base", `cannot resolve "${ref}" to a commit`);
  const mb = git(root, ["merge-base", sha.out.trim(), "HEAD"]);
  if (!mb.ok || !mb.out.trim()) throw new SpecSyncConfigError("--base", `cannot find a merge-base between "${ref}" and HEAD (fetch more history?)`);
  return { commit: mb.out.trim(), label: ref, empty: false };
}

interface BaseDiff { changed: Set<string>; added: Set<string>; renamedFrom: Map<string, string> }

/** Paths changed from base through the working tree, those added, and renames
 *  (new → old) (SS-5.1). Paths are relative to `root`. */
function diffFromBase(root: string, base: string): BaseDiff {
  const d: BaseDiff = { changed: new Set(), added: new Set(), renamedFrom: new Map() };
  const parts = zList(gitOut(root, ["diff", "--relative", "--name-status", "-z", "-M", base]));
  for (let i = 0; i < parts.length; i++) {
    const status = parts[i]!;
    if (status[0] === "R" || status[0] === "C") {
      const from = normPath(parts[++i]!);
      const to = normPath(parts[++i]!);
      if (status[0] === "R") { d.changed.add(from); d.renamedFrom.set(to, from); }
      d.changed.add(to);
      if (status[0] === "C") d.added.add(to);
      continue;
    }
    const file = normPath(parts[++i] ?? "");
    if (!file) continue;
    d.changed.add(file);
    if (status[0] === "A") d.added.add(file);
  }
  for (const f of zList(gitOut(root, ["ls-files", "-z", "--others", "--exclude-standard"])).map(normPath)) {
    if (f.endsWith("/")) continue;
    d.changed.add(f);
    d.added.add(f);
  }
  return d;
}

/** Expand a glob against the filesystem (JUnit reports are usually gitignored, so git's
 *  file list never shows them). Walks only below the glob's literal directory prefix. */
function expandFsGlob(root: string, glob: string): string[] {
  const g = normalizeGlob(glob);
  if (!/[*?{]/.test(g)) return [g];
  const literal = g.slice(0, g.search(/[*?{]/));
  const dir = literal.includes("/") ? literal.slice(0, literal.lastIndexOf("/")) : "";
  const out: string[] = [];
  const walk = (rel: string, depth: number): void => {
    if (depth > 12 || out.length > 1000) return;
    let entries;
    try { entries = readdirSync(resolve(root, rel || "."), { withFileTypes: true }); } catch { return; }
    for (const e of entries) {
      if (e.name === ".git" || e.name === "node_modules") continue;
      const p = rel ? `${rel}/${e.name}` : e.name;
      if (e.isDirectory()) walk(p, depth + 1);
      else if (e.isFile() && matchesAny(p, [g])) out.push(p);
    }
  };
  walk(dir, 0);
  return out.sort();
}

function newestMtime(root: string, files: readonly string[]): number {
  let newest = 0;
  for (const f of files) {
    try { newest = Math.max(newest, statSync(resolve(root, f)).mtimeMs); } catch { /* deleted */ }
  }
  return newest;
}

/** Deleted paths with their commit's committer time (ms, rounded up to the end of that
 *  second) from `git log --diff-filter=D --name-only --format=%x01%ct -z` output:
 *  "\x01<ct>" NUL "\n<path>" NUL "<path>" NUL … per commit. Fails closed: anything before
 *  the first header, or a header with text in front of it (a signature that
 *  log.showSignature printed, say), is an error, never a path dated 0. */
export function parseDeletionLog(out: string): { path: string; ms: number }[] {
  const found: { path: string; ms: number }[] = [];
  let ms: number | null = null;
  let afterHeader = false;
  for (const tok of zList(out)) {
    if (tok.startsWith("\x01")) {
      const ct = Number(tok.slice(1).trim());
      if (!/^\d+$/.test(tok.slice(1).trim()) || !Number.isFinite(ct)) throw new Error(`git log returned an unreadable commit time "${tok.slice(1)}"`);
      ms = ct * 1000 + 999; // 1 s resolution: assume the end of the second
      afterHeader = true;
      continue;
    }
    if (ms === null || tok.includes("\x01")) throw new Error(`git log returned unexpected output before a commit header: ${JSON.stringify(tok.slice(0, 80))}`);
    found.push({ path: afterHeader ? tok.replace(/^\n/, "") : tok, ms });
    afterHeader = false;
  }
  return found;
}

/** A reflog time (unix seconds) in ms, at the end of that second, so a move in the report's
 *  own second counts as after it: stale, never wrongly fresh. */
const reflogMs = (s: string) => Number(s) * 1000 + 999;

/** When each move (entries newest first) happened at the latest, never earlier than any older
 *  move, so one entry dated back (GIT_COMMITTER_DATE) can never date a later move before an
 *  earlier one. An entry timed before an older entry is provably dated back: it is dated at
 *  the next newer move instead, and the newest such entry at `top` (when the reflog was last
 *  written, at the latest). Non-increasing, newest first. */
export function moveTimes(ms: readonly number[], top: number): number[] {
  const older = new Array<number>(ms.length + 1).fill(0); // older[i]: latest time of entries i..
  for (let i = ms.length - 1; i >= 0; i--) older[i] = Math.max(older[i + 1]!, ms[i]!);
  const out = new Array<number>(ms.length);
  for (let i = 0; i < ms.length; i++) {
    const back = ms[i]! < older[i + 1]!;
    out[i] = back ? (i === 0 ? Math.max(older[0]!, top) : out[i - 1]!) : older[i]!;
  }
  return out;
}

/** Entries of a raw files-backend reflog (`<old> <new> <ident> <unix> <tz>\t<message>`),
 *  newest first. An unreadable line is an error, never skipped. */
export function parseRawReflog(text: string): { old: string; new: string; ms: number }[] {
  return text.split("\n").filter((l) => l.trim() !== "").map((l) => {
    // Git strips "<" and ">" from the name and email, so the first ">" closes the email.
    const m = /^([0-9a-f]{40}|[0-9a-f]{64}) ([0-9a-f]{40}|[0-9a-f]{64}) [^>\n]*> (\d+) [+-]\d{4}(?:\t|\r?$)/.exec(l);
    if (!m) throw new Error(`HEAD's reflog has an unreadable line ${JSON.stringify(l.slice(0, 80))}`);
    return { old: m[1]!, new: m[2]!, ms: reflogMs(m[3]!) };
  }).reverse();
}

/** HEAD's reflog file (files ref backend) with its mtime (last append) and birth time (0 where
 *  the filesystem has none); null when there is none (reftable, or reflogs turned off): the
 *  caller then reads the reflog through `git log -g`. */
function rawHeadReflog(root: string): { entries: { old: string; new: string; ms: number }[]; mtime: number; birth: number } | null {
  const file = resolve(root, gitOut(root, ["rev-parse", "--git-path", "logs/HEAD"]).trim());
  let text: string;
  let st: { mtimeMs: number; birthtimeMs: number };
  try { st = statSync(file); text = readFileSync(file, "utf8"); } catch (e) {
    if ((e as NodeJS.ErrnoException).code === "ENOENT") return null;
    throw e;
  }
  return { entries: parseRawReflog(text), mtime: st.mtimeMs, birth: st.birthtimeMs };
}

/** HEAD's reflog through git (any ref backend), newest first: the tree HEAD moved to and
 *  when. Bounded; empty without a reflog. A failed call or an unreadable line is an error,
 *  never "no reflog". */
function headReflog(root: string): { tree: string; ms: number }[] {
  const out = gitOut(root, ["log", "-g", "-n", "5000", "--no-show-signature", "--format=%T %gd", "--date=unix", "HEAD", "--"]);
  return out.split("\n").filter((l) => l.trim() !== "").map((l) => {
    const m = /^([0-9a-f]{40}|[0-9a-f]{64}) HEAD@\{(\d+)\}$/.exec(l.trim());
    if (!m) throw new Error(`git log -g returned an unreadable reflog line ${JSON.stringify(l.slice(0, 80))}`);
    return { tree: m[1]!, ms: reflogMs(m[2]!) };
  });
}

/** Each commit's tree, null for a commit git cannot read (its object is gone), from one
 *  `git cat-file --batch-check` call. Output that does not answer every commit in order is
 *  an error. */
function commitTrees(root: string, commits: readonly string[]): Map<string, string | null> {
  const trees = new Map<string, string | null>();
  if (!commits.length) return trees;
  const lines = gitOut(root, ["cat-file", "--batch-check=%(objectname) %(objecttype)"], commits.map((c) => `${c}^{tree}\n`).join("")).split("\n");
  if (lines.at(-1) === "") lines.pop();
  if (lines.length !== commits.length) throw new Error(`git cat-file --batch-check answered ${lines.length} of ${commits.length} commits`);
  commits.forEach((c, i) => {
    const l = lines[i]!.trim();
    const m = /^([0-9a-f]{40}|[0-9a-f]{64}) tree$/.exec(l);
    if (m) trees.set(c, m[1]!);
    else if (l === `${c}^{tree} missing`) trees.set(c, null);
    else throw new Error(`git cat-file --batch-check returned ${JSON.stringify(l.slice(0, 80))} for ${c.slice(0, 12)}`);
  });
  return trees;
}

/** Deleted paths per tree pair from `git diff-tree --stdin -r --name-only -z` fed "<old> <new>"
 *  lines: git echoes each pair as "<old> <new>\n", then the pair's paths, NUL-terminated. Git
 *  skips a pair it cannot read silently (exit 0, no header), so every header is checked in
 *  order and a missing or unexpected one is an error, never "nothing deleted". A path with a
 *  newline could pass for the next header, so it is an error too. */
export function parseTreePairDeletions(out: string, pairs: readonly (readonly [string, string])[]): string[][] {
  const found: string[][] = [];
  let pos = 0;
  for (let i = 0; i < pairs.length; i++) {
    const header = `${pairs[i]![0]} ${pairs[i]![1]}\n`;
    if (!out.startsWith(header, pos)) throw new Error(`git diff-tree --stdin did not answer for ${pairs[i]![0].slice(0, 12)}..${pairs[i]![1].slice(0, 12)}`);
    pos += header.length;
    const next = i + 1 < pairs.length ? `${pairs[i + 1]![0]} ${pairs[i + 1]![1]}\n` : null;
    const paths: string[] = [];
    while (pos < out.length && !(next !== null && out.startsWith(next, pos))) {
      const end = out.indexOf("\0", pos);
      if (end < 0) throw new Error("git diff-tree --stdin returned an unterminated path");
      const path = out.slice(pos, end);
      if (path.includes("\n")) throw new Error("git diff-tree --stdin returned a path with a newline");
      paths.push(path);
      pos = end + 1;
    }
    found.push(paths);
  }
  if (pos !== out.length) throw new Error("git diff-tree --stdin returned output after the last pair");
  return found;
}

/** Committed deletions that reached the work tree after `since` (the oldest JUnit report's
 *  mtime, ms), however HEAD got there (a commit on the branch, merging or fast-forwarding the
 *  base in, a checkout, a rebase or reset). Each HEAD move is a step from the tree before it
 *  to the tree it reached, dated at the move (raised to every older move's time, so one move
 *  dated back cannot hide an earlier one), and a path a step deleted is dated at that step,
 *  so one report goes stale only from moves after it. With a reflog file (files backend),
 *  every entry names both ends of its own move, so an entry gone from the middle (expired, or
 *  its commit pruned) leaves a gap that is itself a step: from where the older entry ended to
 *  where the newer one began, dated at the newer one. HEAD away from the last entry is a step
 *  dated Infinity. Without a reflog file (reftable), `git log -g` gives only the tree each
 *  move reached, so each step runs from the next older entry. One git diff-tree call takes
 *  every step, whatever the reflog's length. A path a step deleted that is on disk and listed
 *  now (a reset that recommits it) is left out: its mtime already says when it last changed.
 *  Returns null without a reflog (the caller then dates base..HEAD by commit time);
 *  otherwise the latest move that cannot be read (its commit is gone, no older entry under
 *  `git log -g`, git could not diff it, or the reflog file was rewritten after `since` by
 *  git reflog expire or git gc, which can drop moves without a gap), 0 for none: every
 *  spec's inputs count as changed then, stale until the report is regenerated, never
 *  wrongly fresh. */
function reflogDeletions(root: string, since: number, onDisk: ReadonlySet<string>, note: (file: string, ms: number) => void): number | null {
  let unknown = 0;
  const steps = new Map<string, number>(); // "<old tree> <new tree>" -> latest move with that step
  const step = (a: string, b: string, ms: number) => {
    if (a === b) return;
    const key = `${a} ${b}`;
    steps.set(key, Math.max(steps.get(key) ?? 0, ms));
  };
  const raw = rawHeadReflog(root);
  if (raw) {
    const { entries, mtime, birth } = raw;
    // Git appends to the file as HEAD moves and replaces it only to drop entries (git reflog
    // expire, git gc), which can drop moves without leaving a gap: a file born after the
    // report makes every input count as changed (a new repository's first commit after the
    // report too: the file is born with it). Without a birth time (0) this is not seen.
    const rewritten = birth > 0 && birth >= since ? birth : 0;
    if (!entries.length) return rewritten || null;
    unknown = rewritten;
    const dated = moveTimes(entries.map((e) => e.ms), mtime);
    const head = gitOut(root, ["rev-parse", "--verify", "HEAD^{commit}"]).trim();
    const zero = /^0+$/; // no commit: an orphan checkout, the first commit, a branch rename
    // Where HEAD was before entry i: its old end, or for an entry from no commit, the newest
    // older entry's commit (an orphan commit replaces that tree), "" for none (first commit).
    const before = (i: number): string => {
      if (!zero.test(entries[i]!.old)) return entries[i]!.old;
      for (let j = i + 1; j < entries.length; j++) if (!zero.test(entries[j]!.new)) return entries[j]!.new;
      return "";
    };
    const moves: [string, string, number][] = []; // commit steps
    if (entries[0]!.new !== head) moves.push([entries[0]!.new, head, Infinity]);
    for (let i = 0; i < entries.length && dated[i]! >= since; i++) {
      const e = entries[i]!;
      const older = entries[i + 1];
      moves.push([before(i), e.new, dated[i]!]);
      if (older && !zero.test(e.old) && older.new !== e.old) moves.push([older.new, e.old, dated[i]!]);
    }
    const live = moves.filter(([a, b]) => a !== b && a !== "" && !zero.test(a) && !zero.test(b));
    const trees = commitTrees(root, [...new Set(live.flatMap(([a, b]) => [a, b]))]);
    for (const [a, b, ms] of live) {
      const ta = trees.get(a), tb = trees.get(b);
      if (!ta || !tb) unknown = Math.max(unknown, ms);
      else step(ta, tb, ms);
    }
  } else {
    const entries = headReflog(root);
    if (!entries.length) return null;
    const dated = moveTimes(entries.map((e) => e.ms), Infinity);
    for (let i = 0; i < entries.length && dated[i]! >= since; i++) {
      const old = entries[i + 1];
      if (!old) { unknown = Math.max(unknown, dated[i]!); break; }
      step(old.tree, entries[i]!.tree, dated[i]!);
    }
  }
  if (!steps.size) return unknown;
  const pairs = [...steps.keys()].map((k) => k.split(" ") as [string, string]);
  const d = git(root, ["diff-tree", "--stdin", "-r", "--no-renames", "--relative", "--name-only", "--diff-filter=D", "-z"], pairs.map(([a, b]) => `${a} ${b}\n`).join(""));
  let deleted: string[][] | null = null;
  try { if (d.ok) deleted = parseTreePairDeletions(d.out, pairs); } catch { /* unknown below */ }
  if (!deleted) return Math.max(unknown, ...steps.values());
  pairs.forEach(([a, b], i) => {
    const ms = steps.get(`${a} ${b}`)!;
    for (const f of deleted[i]!) if (!onDisk.has(normPath(f))) note(f, ms);
  });
  return unknown;
}

/** When each path under `root` was last deleted (ms), for JUnit freshness against reports
 *  no older than `since` (null: no report exists, nothing to date), plus `all`: a time after
 *  which every input counts as changed, 0 for none (see reflogDeletions). `files` are the
 *  paths on disk whose mtimes already count. A committed deletion counts when it reached the
 *  work tree, found from HEAD's reflog; without a reflog, each deletion committed in
 *  base..HEAD (renames count as deleting the old path, a file added and deleted on the branch
 *  too) dates by its commit's committer time. A deletion not yet committed (gone from HEAD to
 *  the index, from HEAD or the index to the working tree) is Infinity, so a report is stale
 *  until the deletion is committed and the report regenerated. An untracked file created and
 *  removed again, or a staged new file stashed away, leaves no trace in HEAD's history and
 *  cannot be dated. */
function deletionTimes(root: string, base: { commit: string; empty: boolean }, since: number | null, files: readonly string[]): { times: Map<string, number>; all: number } {
  const times = new Map<string, number>();
  const note = (file: string, ms: number) => {
    const f = normPath(file);
    if (f) times.set(f, Math.max(times.get(f) ?? 0, ms));
  };
  // Index vs working tree: needs no commit (a file staged as new, then removed).
  for (const f of zList(gitOut(root, ["diff", "--no-renames", "--relative", "--name-only", "--diff-filter=D", "-z"]))) note(f, Infinity);
  if (base.empty || since === null) return { times, all: 0 }; // no commits, or no report to date against
  let all = reflogDeletions(root, since, new Set(files), note);
  if (all === null) {
    all = 0;
    const committed = parseDeletionLog(gitOut(root, ["log", "--no-show-signature", "--no-renames", "--relative", "--diff-filter=D", "--name-only", "--format=%x01%ct", "-z", `${base.commit}..HEAD`, "--"]));
    for (const { path, ms } of committed) note(path, ms);
  }
  for (const cached of [false, true]) {
    const args = ["diff", ...(cached ? ["--cached"] : []), "--no-renames", "--relative", "--name-only", "--diff-filter=D", "-z", "HEAD"];
    for (const f of zList(gitOut(root, args))) note(f, Infinity);
  }
  return { times, all };
}

/** The JUnit report paths the config's globs match on disk. */
function junitReportPaths(root: string, config: SpecSyncConfig): string[] {
  return [...new Set(config.junit.flatMap((j) => expandFsGlob(root, j)))];
}

/** The oldest mtime (ms) among report files that exist; null when none does. */
function oldestReportMtime(root: string, reports: readonly string[]): number | null {
  let oldest: number | null = null;
  for (const f of reports) {
    try { const m = statSync(resolve(root, f)).mtimeMs; oldest = oldest === null ? m : Math.min(oldest, m); } catch { /* missing */ }
  }
  return oldest;
}

/** Fresh JUnit cases per spec id, plus junit findings (SS-4.7 – SS-4.9). */
function readJunit(root: string, config: SpecSyncConfig, reports: readonly string[], files: readonly string[], deleted: { times: ReadonlyMap<string, number>; all: number }, requireJunit: boolean): { perSpec: Map<string, JunitCase[]>; findings: Finding[] } {
  const perSpec = new Map<string, JunitCase[]>();
  const findings: Finding[] = [];
  if (requireJunit && !config.junit.length) findings.push(finding("junit-skipped", "junit", "--require-junit: no JUnit report is configured (`junit` in the config)", undefined, true));
  if (config.junit.length && !reports.length && requireJunit) findings.push(finding("junit-skipped", config.junit.join(", "), "--require-junit: no JUnit report matches the configured globs", undefined, true));
  // Freshness inputs: the spec's tests and code, never a report itself (SS-4.7), plus the
  // time of every deletion of a path in those globs (see deletionTimes).
  const inSpec = (s: SpecEntry, f: string) => (matchesAny(f, s.tests) || matchesAny(f, s.code)) && !matchesAny(f, config.junit);
  const inputs = new Map(config.specs.map((s) => [s.id, Math.max(
    newestMtime(root, files.filter((f) => inSpec(s, f))),
    deleted.all,
    ...[...deleted.times].filter(([f]) => inSpec(s, f)).map(([, ms]) => ms),
  )]));
  const stale = new Map<string, string[]>();
  for (const report of reports) {
    const r = readJunitFile(resolve(root, report));
    if (!r.ok) {
      if (r.reason !== "missing" || requireJunit) findings.push(finding("junit-skipped", report, `JUnit report ${report} skipped: ${r.detail}`, undefined, requireJunit));
      continue;
    }
    for (const spec of config.specs) {
      if (junitIsFresh(r.mtimeMs, inputs.get(spec.id) ?? 0)) perSpec.set(spec.id, [...(perSpec.get(spec.id) ?? []), ...r.cases]);
      else stale.set(spec.id, [...(stale.get(spec.id) ?? []), report]);
    }
  }
  // A stale report matters only for a spec no fresh report covers. Without --require-junit
  // it is still reported, as info (exit unchanged).
  for (const [id, stales] of stale) {
    if (perSpec.has(id)) continue;
    for (const report of stales) findings.push(finding("junit-skipped", report, `JUnit report ${report} is older than ${id}'s newest test or code file, or a deletion of one (stale)`, id, requireJunit));
  }
  return { perSpec, findings };
}

/** The spec's text at base, following a rename. Null only when the spec is new on this
 *  branch; any other failed lookup is an error, never a silent "the spec changed" (SS-5.4). */
function specAtBase(root: string, base: { commit: string; empty: boolean }, path: string, diff: BaseDiff, field: string): string | null {
  if (base.empty) return null;
  const { commit } = base;
  const basePath = diff.renamedFrom.get(path) ?? path;
  const listed = git(root, ["ls-tree", "-z", "--name-only", commit, "--", basePath]);
  if (!listed.ok) throw new SpecSyncConfigError(field, `cannot list ${basePath} at base ${commit.slice(0, 12)}`);
  if (!zList(listed.out).map(normPath).includes(basePath)) {
    if (diff.added.has(path)) return null;
    throw new SpecSyncConfigError(field, `${basePath} is neither at base ${commit.slice(0, 12)} nor added since (check the path's case)`);
  }
  const shown = git(root, ["show", `${commit}:./${basePath}`]);
  if (!shown.ok) throw new SpecSyncConfigError(field, `cannot read ${basePath} at base ${commit.slice(0, 12)}`);
  return shown.out;
}

export interface CheckResult { base: string; findings: Finding[]; specs: ReturnType<typeof computeFindings>["summary"] }

/** Run the full check; throws SpecSyncConfigError on a config problem. Null when off. */
export function runCheck(root: string, opts: { base?: string; requireJunit?: boolean }): CheckResult | null {
  const config = loadSpecSyncConfig(root);
  if (!config || !config.enabled) return null;
  const inside = git(root, ["rev-parse", "--is-inside-work-tree"]);
  if (!inside.ok || inside.out.trim() !== "true") throw new Error(`${root} is not inside a git work tree; spec-sync check diffs against git history`);
  const base = resolveBase(root, opts.base);
  const files = repoFiles(root);
  const fileSet = new Set(files);
  const diff = diffFromBase(root, base.commit);
  const reports = junitReportPaths(root, config);
  const junit = readJunit(root, config, reports, files, deletionTimes(root, base, oldestReportMtime(root, reports), files), !!opts.requireJunit);
  const specs: SpecInput[] = config.specs.map((spec, i) => {
    const field = `specs[${i}].path`;
    // Exact and case-sensitive: a case-insensitive filesystem must not paper over a mismatch.
    if (!fileSet.has(spec.path)) throw new SpecSyncConfigError(field, `no file at exactly "${spec.path}" (paths are case-sensitive and repo-relative)`);
    const text = readText(root, spec.path);
    if (text === null) throw new SpecSyncConfigError(field, `cannot read ${spec.path}`);
    return { spec, text, baseText: specAtBase(root, base, spec.path, diff, field), junit: junit.perSpec.get(spec.id) ?? null };
  });
  const allTests = config.specs.flatMap((s) => s.tests);
  const tests = files.filter((f) => matchesAny(f, allTests)).flatMap((f) => {
    const text = readText(root, f);
    return text === null ? [] : [testFileNames(f, text, config.testNamePatterns)];
  });
  const specsDirFiles = config.specsDir.length
    ? files.filter((f) => underSpecsDir(f, config.specsDir)).filter((f) => {
      const text = readText(root, f);
      return !!text && clausePrefixes(text, f).length > 0;
    })
    : [];
  const { findings, summary } = computeFindings({ config, specs, tests, changed: diff.changed, added: diff.added, specsDirFiles, junitFindings: junit.findings });
  return { base: base.label, findings, specs: summary };
}

function printCheck(result: CheckResult): void {
  for (const s of result.specs) console.log(`spec-sync ${s.path} [${s.id}]: ${s.clauses} clause(s) (${s.manual} manual), ${s.tested} tested`);
  const blocking = result.findings.filter((f) => f.blocking);
  for (const f of result.findings) console.log(`  ${f.blocking ? "✗" : "·"} [${f.code}] ${f.message}`);
  if (!result.findings.length) console.log(`✓ spec-sync: specs, tests and code are in step (base ${result.base}).`);
  else console.log(`\n${blocking.length} finding(s)${result.findings.length - blocking.length ? `, ${result.findings.length - blocking.length} info` : ""} (base ${result.base}). Decide per finding: intended change (update the clause and its tests) or a bug (fix the code). Never rewrite a spec to match a bug.`);
}

function runCheckCommand(opts: { base?: string; requireJunit?: boolean; json?: boolean }): void {
  const result = runCheck(repoRoot(), opts);
  if (!result) {
    if (opts.json) console.log(JSON.stringify({ enabled: false, findings: [] }));
    else console.log(`spec-sync: off (${SPEC_SYNC_FILE} absent or enabled: false); nothing to check.`);
    return;
  }
  if (opts.json) console.log(JSON.stringify({ enabled: true, ...result }, null, 2));
  else printCheck(result);
  if (result.findings.some((f) => f.blocking)) process.exitCode = 1;
}

export function registerSpecSyncCommand(program: Command): void {
  const cmd = program
    .command("spec-sync")
    .description("Keep specs, tests and code in step (opt-in via .hunch/spec-sync.json): on | off | add <spec> | check")
    // A usage error (unknown option or subcommand, missing argument) exits 2 like a config
    // error, never 1 (which means findings); help exits 0. Set before the subcommands so
    // they inherit it.
    .exitOverride((err: CommanderError) => process.exit(err.exitCode === 0 ? 0 : 2));
  cmd.command("on").description("Enable spec-sync: create or enable .hunch/spec-sync.json (idempotent; imports legacy <!-- spec-sync … --> headers)").action(guarded(runOn));
  cmd.command("off").description("Disable spec-sync (sets enabled: false; never deletes the config)").action(guarded(runOff));
  cmd.command("add <spec-path>").description("Register a spec: prefix from its clause ids, code/tests globs proposed from paths it names").action(guarded((spec: string) => runAdd(spec)));
  cmd
    .command("check")
    .description("Check every registered spec against the diff from base. Exit 0 clean, 1 findings, 2 config error.")
    .option("--base <ref>", "diff base (default: merge-base with the default branch)")
    .option("--require-junit", "treat a missing or stale JUnit report as a finding (CI)")
    .option("--json", "machine-readable output")
    .action(guarded((opts: { base?: string; requireJunit?: boolean; json?: boolean }) => runCheckCommand(opts)));
}
