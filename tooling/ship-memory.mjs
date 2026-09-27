#!/usr/bin/env node
// Memory shipper: lands this machine's memory-only commits on a protected main
// with no human in the loop. Hunch's hooks commit task records, findings and
// derived memory onto local `main`, which branch protection refuses by push. This
// pushes the unpushed range to memory/<host> (merged with origin/main first when
// local main has diverged, so GitHub never sees a conflict only a local merge driver
// resolves), opens (or refreshes) that branch's PR, and leaves the rest to CI:
// ci.yml's memory-only fast path and hunch-guard's merge-class auto-merge.
//
// It pushes NOTHING when any commit in the range touches a path outside the
// memory-only class, or when the publication scanner flags a record (a machine
// path, secret material, or this machine's private vocabulary): an automatic push
// must never be how private content reaches the public repo.
//
// Run in the background by a local post-commit hook. Usage:
//   node --import tsx tooling/ship-memory.mjs [--cwd dir] [--dry-run] [--wait]
// --wait keeps going until the PR merges, then fast-forwards local main when that
// is safe, and ships whatever was committed meanwhile.
import { execFileSync } from "node:child_process";
import { createHash } from "node:crypto";
import { closeSync, existsSync, openSync, readFileSync, rmSync, statSync, utimesSync, writeSync } from "node:fs";
import { hostname } from "node:os";
import { basename, dirname, join, resolve } from "node:path";
import process from "node:process";
import { setTimeout as sleep } from "node:timers/promises";
import { pathToFileURL } from "node:url";

import { classifyChange, GROUNDING_DOCS } from "./merge-class.mjs";
import { scanRecord } from "../src/core/publication.ts";

const LOCK_STALE_MS = 30 * 60_000;
// The holder renews its lock every poll, so a lock this old with a "live" owner is a
// recycled pid (Windows reuses them quickly), not a slow shipper.
const LOCK_HARD_MS = 2 * 60 * 60_000;
const WAIT_LIMIT_MS = 20 * 60_000;
const POLL_MS = 20_000;
const MERGE_TIMEOUT_MS = 10 * 60_000;
// A hung fetch, push or gh call would hold the lock forever; a blob past Node's 1 MiB
// default buffer would read as a failure and refuse a clean record. Replacement refs
// are off: every read would follow them, but a push sends the real objects, so the
// scan would read one history and publish another.
const EXEC = {
  encoding: "utf8",
  stdio: ["ignore", "pipe", "pipe"],
  timeout: 120_000,
  maxBuffer: 64 * 1024 * 1024,
  env: { ...process.env, GIT_NO_REPLACE_OBJECTS: "1" },
};

function gitRaw(cwd, args) {
  return execFileSync("git", args, { cwd, ...EXEC });
}

function git(cwd, args) {
  return gitRaw(cwd, args).trim();
}

/** Exit status of a git command that answers yes/no by status. A timeout or spawn
 *  failure has no status and throws: it is not an answer. */
function gitStatus(cwd, args) {
  try { gitRaw(cwd, args); return 0; }
  catch (error) { if (typeof error?.status === "number") return error.status; throw error; }
}

/** NUL-separated git output (-z): names exactly as stored, never quoted or trimmed. */
const nul = (text) => text.split("\0").filter(Boolean);

function tryGit(cwd, args) {
  try { return git(cwd, args); } catch { return null; }
}

function isAncestor(cwd, a, b) {
  const status = gitStatus(cwd, ["merge-base", "--is-ancestor", a, b]);
  if (status > 1) throw new Error(`git merge-base --is-ancestor ${a} ${b} exited ${status}`);
  return status === 0;
}

const SYNC_MESSAGE = "hunch: merge origin/main into local memory\n\nBuilt by tooling/ship-memory.mjs with this repository's merge drivers.";

/** The commit to ship for `local`: itself when it already descends from `remoteBase`
 *  (or is behind it), else a merge of `remoteBase` into it. GitHub tests a PR by
 *  merging without this repository's merge drivers, so a record both sides wrote (a
 *  task record a feature branch merged while a hook also committed it on main) is an
 *  add/add conflict there even though `merge=hunch` resolves it here, and a conflicting
 *  PR gets no Actions run and never auto-merges. The merge is built off the working
 *  tree with the local drivers and dated from its parents, so the same pair always
 *  yields the same commit. A merge that adds nothing to `remoteBase` is "absorbed": a
 *  PR without a diff is not memory-only and would never merge. */
export function syncTip({ cwd, local = "refs/heads/main", remoteBase = "refs/remotes/origin/main", timeoutMs = MERGE_TIMEOUT_MS }) {
  const tip = git(cwd, ["rev-parse", "--verify", `${local}^{commit}`]);
  const base = git(cwd, ["rev-parse", "--verify", `${remoteBase}^{commit}`]);
  if (isAncestor(cwd, base, tip) || isAncestor(cwd, tip, base)) return { status: "direct", tip, local: tip, base, conflicts: [] };
  let out;
  // Each conflicted record runs a merge driver, which may be a cold `npx tsx` start.
  try { out = execFileSync("git", ["merge-tree", "--write-tree", "--name-only", "--no-messages", "-z", tip, base], { cwd, ...EXEC, timeout: timeoutMs }); }
  catch (error) {
    if (error?.code === "ETIMEDOUT") return { status: "timeout", tip: null, local: tip, base, conflicts: [] };
    // 1 is "conflicts"; anything else is not an answer.
    if (error?.status !== 1) throw error;
    return { status: "conflict", tip: null, local: tip, base, conflicts: [...new Set(nul(String(error.stdout ?? "")).slice(1))] };
  }
  const [tree] = nul(out);
  if (tree === git(cwd, ["rev-parse", "--verify", `${base}^{tree}`])) return { status: "absorbed", tip: null, local: tip, base, conflicts: [] };
  const date = `@${Math.max(...[tip, base].map((c) => Number(git(cwd, ["log", "-1", "--format=%ct", c]))))} +0000`;
  const env = { ...EXEC.env, GIT_AUTHOR_DATE: date, GIT_COMMITTER_DATE: date };
  const merge = execFileSync("git", ["commit-tree", tree, "-p", tip, "-p", base, "-m", SYNC_MESSAGE], { cwd, ...EXEC, env }).trim();
  return { status: "merged", tip: merge, local: tip, base, conflicts: [] };
}

/** A stable per-machine label that does not publish the machine's name: the branch,
 *  PR title and body are public, and a hostname is the same class of detail as the
 *  machine paths the scanner refuses. */
export function hostLabel(host = hostname()) {
  return `host-${createHash("sha256").update(host.toLowerCase()).digest("hex").slice(0, 10)}`;
}

export function memoryBranch(host = hostname()) {
  return `memory/${hostLabel(host)}`;
}

/** Every string a JSON record carries, keys included, with the path that holds it.
 *  scanRecord reads vocabulary from top-level prose fields only; a private term in
 *  `evidence[]` or a nested field publishes all the same. */
function stringsOf(node, path, out) {
  if (typeof node === "string") { out.push({ field: path, text: node }); return out; }
  if (!node || typeof node !== "object") return out;
  if (Array.isArray(node)) { node.forEach((v, i) => stringsOf(v, `${path}[${i}]`, out)); return out; }
  for (const [k, v] of Object.entries(node)) {
    const at = path === "$" ? k : `${path}.${k}`;
    out.push({ field: `${at} (key)`, text: k });
    stringsOf(v, at, out);
  }
  return out;
}

/** Scan one blob as it would publish: every string, structural kinds and the whole
 *  vocabulary alike. JSON is scanned by unescaped string, never raw text (the encoding
 *  doubles backslashes, so a raw `C:\\Users\\x` would slip the machine-path rule): by
 *  parsed value, and by every string literal in the file, since parsing drops bytes
 *  that still publish (a duplicate key keeps only its last value). Valid JSON has no
 *  quote outside a string, so the literal match tokenizes exactly.
 *
 *  A vocabulary hit also carries `window`: the exact match with 40 characters either
 *  side. Its excerpt is for the log (whitespace collapsed, clipped at 120), so two
 *  different matches can share one; the window cannot. */
export function scanBlob(path, text, vocabulary) {
  let strings = [{ field: "$", text }];
  if (path.startsWith(".hunch/") && path.endsWith(".json")) {
    let record;
    try { record = JSON.parse(text); } catch { return [{ kind: "unparseable-json", field: "$", excerpt: "" }]; }
    const literals = stringLiterals(text).map((literal) => ({ field: "$raw", text: literal }));
    strings = [...stringsOf(record, "$", []), ...literals];
  }
  const hits = [];
  for (const s of strings) {
    for (const level of unescapedLevels(s.text)) for (const hit of scanRecord({ title: level })) hits.push({ ...hit, field: s.field });
    for (const re of vocabulary) {
      for (const m of s.text.matchAll(re)) {
        const window = s.text.slice(Math.max(0, m.index - 40), m.index + m[0].length + 40);
        hits.push({ kind: "market-vocabulary", field: s.field, excerpt: clipExcerpt(window), window });
      }
    }
  }
  return hits;
}

/** Every string literal in a JSON text that JSON.parse accepted, decoded. A plain
 *  scan, not a regex: V8's regex backtracking overflows on a literal of a few MiB. */
function stringLiterals(text) {
  const out = [];
  for (let start = text.indexOf('"'); start !== -1; start = text.indexOf('"', start)) {
    let end = start + 1;
    while (end < text.length && text[end] !== '"') end += text[end] === "\\" ? 2 : 1;
    if (end >= text.length) throw new Error("unterminated string literal");
    out.push(JSON.parse(text.slice(start, end + 1)));
    start = end + 1;
  }
  return out;
}

/** The text with each doubled backslash halved (and PHP-style `\/` unescaped),
 *  repeatedly, until none is left. A record often quotes a JSON payload, whose
 *  `C:\\Users\\x` sits one encoding level deeper than the record's own, and markdown
 *  or a commit message quotes it as is; the structural rules need single separators,
 *  so they run on every level. Each pass that changes the text shortens it, so this
 *  ends. */
function unescapedLevels(text) {
  const levels = [text];
  for (;;) {
    const next = levels.at(-1).replace(/\\\\/g, "\\").replace(/\\\//g, "/");
    if (next === levels.at(-1)) return levels;
    levels.push(next);
  }
}

/** publication.ts's excerpt shape, for the log only. */
const clipExcerpt = (s) => {
  const flat = s.replace(/\s+/g, " ").trim();
  return flat.length > 120 ? `${flat.slice(0, 120)}…` : flat;
};

/** The publication vocabulary, strictly. publication.ts degrades a missing or broken
 *  list to "no vocabulary" because a capture must never fail on it; here the list is
 *  the last gate before a public push, so a file that exists but cannot be read
 *  refuses instead. The gitignored local list lives only in the primary checkout, so
 *  a shipper started from a linked worktree reads it there too. */
export function loadShipVocabulary(cwd) {
  const common = resolve(cwd, git(cwd, ["rev-parse", "--git-common-dir"]));
  const dirs = new Set([resolve(cwd, ".hunch")]);
  if (basename(common) === ".git") dirs.add(resolve(dirname(common), ".hunch"));
  const patterns = [];
  const broken = [];
  for (const dir of dirs) {
    for (const name of ["publication.json", "publication.local.json"]) {
      const file = join(dir, name);
      // Only "no such file" is absent. existsSync answers false for any error (a
      // permission denied, a symlink loop), and a list it cannot see is not no list.
      let raw;
      try { raw = readFileSync(file, "utf8"); }
      catch (error) { if (error?.code !== "ENOENT") broken.push(file); continue; }
      try {
        const list = JSON.parse(raw)?.vocabulary;
        if (!Array.isArray(list) || list.some((p) => typeof p !== "string")) throw new Error("no vocabulary list");
        for (const p of list) patterns.push(new RegExp(p, "gi"));
      } catch { broken.push(file); }
    }
  }
  return { patterns, broken };
}

/** Decide what to ship from `local` onto `remoteBase`, without touching the remote.
 *  Paths are every commit's own paths (so a commit that adds and a later one that
 *  removes a source file still refuses; a merge lists what differs from every parent)
 *  plus the net diff from the merge base (so a local merge cannot carry content no
 *  single commit shows). The scan reads every commit's blobs, path names and message,
 *  not just the tip: the branch publishes history, so a secret one commit adds and
 *  the next redacts ships. */
export function planShip({ cwd, local = "refs/heads/main", remoteBase = "refs/remotes/origin/main" }) {
  // Grafts rewrite parentage for every read, as replacement refs do, and no variable
  // turns them off; the scan could walk a history that is not the one pushed.
  // --git-path answers GIT_GRAFT_FILE too, resolved as git resolves it.
  const grafts = resolve(cwd, git(cwd, ["rev-parse", "--git-path", "info/grafts"]));
  let graftsFile = true;
  try { statSync(grafts); } catch (error) { if (error?.code !== "ENOENT") throw error; graftsFile = false; }
  if (graftsFile) throw new Error(`a grafts file is in use (${grafts}); ship by hand`);
  const tip = git(cwd, ["rev-parse", "--verify", `${local}^{commit}`]);
  const base = git(cwd, ["rev-parse", "--verify", `${remoteBase}^{commit}`]);
  const commits = git(cwd, ["rev-list", "--reverse", `${base}..${tip}`]).split("\n").filter(Boolean);
  const empty = { tip, base, commits, paths: [], outside: [], hits: [] };
  if (!commits.length) return { status: "nothing", ...empty };
  // -c, not --cc: --cc drops a merged path whose every hunk matches some parent.
  const touched = commits.map((sha) => ({ sha, paths: nul(gitRaw(cwd, ["diff-tree", "-c", "--root", "--no-commit-id", "--name-only", "-z", "-r", "--no-renames", sha])) }));
  const verdict = classifyChange([
    ...touched.flatMap((t) => t.paths),
    ...nul(gitRaw(cwd, ["diff", "--no-renames", "--name-only", "-z", `${base}...${tip}`])),
  ]);
  if (!verdict.files.length) return { status: "nothing", ...empty };
  const paths = verdict.files.map((f) => f.path);
  if (!verdict.memory_only) {
    const outside = verdict.files.filter((f) => f.group !== "memory" && !GROUNDING_DOCS.includes(f.path)).map((f) => f.path);
    return { status: "refused-outside", ...empty, paths, outside };
  }
  const { patterns: vocabulary, broken } = loadShipVocabulary(cwd);
  if (broken.length) return { status: "refused-publication", ...empty, paths, hits: broken.map((file) => ({ file, kind: "unreadable-vocabulary", field: "$", excerpt: "" })) };
  const hits = [];
  const seen = new Set();
  const add = (hit) => {
    const key = JSON.stringify([hit.file, hit.kind, hit.excerpt]);
    if (!seen.has(key)) { seen.add(key); hits.push(hit); }
  };
  // Refusing cannot un-publish what origin/main already holds, and refusing it would
  // wedge every later memory commit behind a routine rewrite (a supersede, a status
  // flip) of an already-public record. So a vocabulary hit whose exact window (the
  // match and 40 characters either side) the same path's base blob already carries is
  // not new. Structural hits are never excused: a secret's excerpt is redacted to a
  // prefix two secrets can share.
  const basePaths = new Set(nul(gitRaw(cwd, ["ls-tree", "-r", "-z", "--full-tree", "--name-only", base])));
  const publishedCache = new Map();
  const published = (path) => {
    if (!publishedCache.has(path)) {
      let windows = new Set();
      if (basePaths.has(path)) {
        try { windows = new Set(scanBlob(path, gitRaw(cwd, ["cat-file", "blob", `${base}:${path}`]), vocabulary).filter((h) => h.window !== undefined).map((h) => h.window)); }
        catch { /* an unreadable base excuses nothing */ }
      }
      publishedCache.set(path, windows);
    }
    return publishedCache.get(path);
  };
  for (const { sha, paths: changed } of touched) {
    const [commit, ...message] = git(cwd, ["log", "-1", "--format=%h%n%B", sha]).split("\n");
    for (const { window, ...hit } of scanBlob("", message.join("\n"), vocabulary)) add({ file: `commit ${commit} message`, commit, ...hit, field: "$" });
    // One listing says which changed paths this commit's tree still holds; one it
    // lacks was deleted here. Any other failure to read a blob refuses: a gate that
    // skips what it could not read is open.
    const present = new Set(nul(gitRaw(cwd, ["ls-tree", "-r", "-z", "--full-tree", "--name-only", sha])));
    for (const path of changed) {
      if (!basePaths.has(path)) for (const { window, ...hit } of scanBlob("", path, vocabulary)) add({ file: path, commit, ...hit, field: "path" });
      if (!present.has(path)) continue;
      let text;
      try { text = gitRaw(cwd, ["cat-file", "blob", `${sha}:${path}`]); }
      catch { add({ file: path, commit, kind: "unreadable", field: "$", excerpt: "" }); continue; }
      const already = published(path);
      for (const { window, ...hit } of scanBlob(path, text, vocabulary)) if (window === undefined || !already.has(window)) add({ file: path, commit, ...hit });
    }
  }
  return { status: hits.length ? "refused-publication" : "ship", ...empty, paths, hits };
}

function lockOwner(file) {
  try { return Number.parseInt(readFileSync(file, "utf8").split(" ")[0], 10); } catch { return NaN; }
}

function alive(pid) {
  if (!Number.isInteger(pid) || pid <= 0) return false;
  try { process.kill(pid, 0); return true; }
  catch (error) { return error?.code === "EPERM"; } // exists, just not ours to signal
}

/** Take a per-repository lock in the common git dir (shared by worktrees). A stale
 *  lock is reclaimed when its owner is gone, or when it is so old that its "live"
 *  owner can only be a recycled pid: the holder renews it every poll. */
export function acquireLock(cwd, now = Date.now()) {
  const file = join(resolve(cwd, git(cwd, ["rev-parse", "--git-common-dir"])), "hunch-ship-memory.lock");
  const mine = `${process.pid} `;
  for (let attempt = 0; attempt < 2; attempt++) {
    try {
      const fd = openSync(file, "wx");
      writeSync(fd, `${mine}${new Date(now).toISOString()}\n`);
      closeSync(fd);
      // Only our own lock: a successor that reclaimed it must keep it.
      const ours = () => { try { return readFileSync(file, "utf8").startsWith(mine); } catch { return false; } };
      const release = () => { if (ours()) rmSync(file, { force: true }); };
      // Renewed every poll, so only a dead or recycled owner's lock ever ages.
      release.renew = (at = new Date()) => { if (ours()) utimesSync(file, at, at); };
      return release;
    } catch (error) {
      if (error?.code !== "EEXIST") throw error;
      let age = 0;
      try { age = now - statSync(file).mtimeMs; } catch { continue; }
      if (age < LOCK_STALE_MS || (age < LOCK_HARD_MS && alive(lockOwner(file)))) return null;
      rmSync(file, { force: true });
    }
  }
  return null;
}

function gh(cwd, args) {
  return execFileSync("gh", args, { cwd, ...EXEC }).trim();
}

function openPr(cwd, branch) {
  const list = JSON.parse(gh(cwd, ["pr", "list", "--head", branch, "--state", "open", "--json", "number,url"]) || "[]");
  return list[0] ?? null;
}

/** A memory PR a human closed unmerged is a decision, not a failure to retry. Any
 *  later tip that still carries its commits would re-publish them (the hooks commit
 *  to main all the time), so the shipper holds until those commits leave local main
 *  or reach origin/main by some other route. Its commits, not its head: a head the
 *  shipper merged origin/main into never becomes an ancestor of a later tip, but the
 *  local commits under it do. */
export function heldByClosedPr(cwd, prs, tip, base) {
  const count = (...args) => Number(git(cwd, ["rev-list", "--count", ...args]));
  for (const pr of prs) {
    if (pr.mergedAt) continue;
    // An oid that is not one is a parse failure, not an answer.
    const head = String(pr.headRefOid ?? "").toLowerCase();
    if (!/^(?:[0-9a-f]{40}|[0-9a-f]{64})$/.test(head)) throw new Error(`closed PR #${pr.number} has no usable head oid`);
    if (!Number.isSafeInteger(pr.number) || pr.number <= 0) throw new Error(`closed PR has no usable number: ${pr.number}`);
    // Absent locally is not an answer: a shipper-built merge head sits on no local
    // branch, so gc can prune it while the commits under it are still on main. GitHub
    // keeps every PR's head; fetch it and pin it so the hold cannot be lost again.
    let present = gitStatus(cwd, ["cat-file", "-e", head]);
    if (present === 1) {
      const pin = `refs/hunch/closed-pr/${pr.number}`;
      tryGit(cwd, ["fetch", "--quiet", "--no-tags", "origin", `+refs/pull/${pr.number}/head:${pin}`]);
      present = gitStatus(cwd, ["cat-file", "-e", head]);
      // GitHub also serves a reachable commit by oid, whatever its pull ref says now.
      if (present === 1 && tryGit(cwd, ["fetch", "--quiet", "--no-tags", "origin", head]) !== null) {
        present = gitStatus(cwd, ["cat-file", "-e", head]);
        if (present === 0) git(cwd, ["update-ref", pin, head]);
      }
      if (present === 1) throw new Error(`closed PR #${pr.number}: its head ${head} cannot be fetched; drop its commits from main, or fetch that commit and pin it as ${pin}`);
    }
    if (present !== 0) throw new Error(`git cat-file -e ${head} exited ${present}`);
    const own = count(head, "--not", base);
    if (own && count(head, "--not", base, tip) < own) return pr;
  }
  return null;
}

function closedPrs(cwd, branch) {
  return JSON.parse(gh(cwd, ["pr", "list", "--head", branch, "--state", "closed", "--limit", "500", "--json", "number,headRefOid,mergedAt"]) || "[]");
}

/** One line of check states for the log; never throws, since it only reports. */
function checksSummary(cwd, branch) {
  try {
    let out;
    // `gh pr checks` exits non-zero while checks are pending or failing; its stdout still lists them.
    try { out = gh(cwd, ["pr", "checks", branch]); } catch (error) { out = String(error?.stdout ?? "").trim(); }
    const counts = {};
    for (const line of out.split("\n")) {
      const state = line.split("\t")[1]?.trim();
      if (state) counts[state] = (counts[state] ?? 0) + 1;
    }
    const parts = Object.entries(counts).map(([state, n]) => `${n} ${state}`);
    return parts.length ? `checks: ${parts.join(", ")}` : null;
  } catch { return null; }
}

function ensurePr(cwd, branch, plan) {
  const existing = openPr(cwd, branch);
  if (existing) return existing;
  const subjects = plan.commits.map((sha) => `- ${git(cwd, ["log", "-1", "--format=%h %s", sha])}`);
  const body = [
    `Memory-only commits from \`${hostLabel()}\`, shipped by \`tooling/ship-memory.mjs\`.`,
    "",
    "Every path is inside the memory-only class and passed the publication scanner, so CI runs the memory fast path and merge-class queues auto-merge.",
    "",
    ...subjects.slice(0, 50),
    ...(subjects.length > 50 ? [`- … ${subjects.length - 50} more`] : []),
  ].join("\n");
  const url = gh(cwd, ["pr", "create", "--base", "main", "--head", branch, "--title", `hunch: memory sync from ${hostLabel()}`, "--body", body]);
  return { number: null, url };
}

/** True when an operation in some worktree will write main when it finishes: a rebase
 *  of main (which detaches HEAD, so no worktree reports main checked out), or a merge,
 *  cherry-pick or revert stopped in main's own checkout. Moving main under either
 *  loses work when the operation completes. */
function mainInFlight(worktrees) {
  for (const fields of worktrees) {
    if (fields.some((f) => f.startsWith("prunable"))) continue; // its directory is gone
    const gitDir = tryGit(fields[0].replace(/^worktree /, ""), ["rev-parse", "--absolute-git-dir"]);
    if (!gitDir) return true; // cannot tell: assume it may
    for (const op of ["rebase-merge", "rebase-apply"]) {
      let head = null;
      try { head = readFileSync(join(gitDir, op, "head-name"), "utf8").trim(); } catch {}
      if (head === "refs/heads/main") return true;
    }
    if (fields.includes("branch refs/heads/main") && ["MERGE_HEAD", "CHERRY_PICK_HEAD", "REVERT_HEAD"].some((f) => existsSync(join(gitDir, f)))) return true;
  }
  return false;
}

/** Fast-forward local main to origin/main when nothing can be lost: main must be an
 *  ancestor, no worktree may be mid-operation on main, and a worktree that has main
 *  checked out must have no tracked changes. */
export function fastForwardMain(cwd) {
  const tip = tryGit(cwd, ["rev-parse", "--verify", "refs/heads/main"]);
  const remote = tryGit(cwd, ["rev-parse", "--verify", "refs/remotes/origin/main"]);
  if (!tip || !remote || tip === remote) return "current";
  if (tryGit(cwd, ["merge-base", "--is-ancestor", tip, remote]) === null) return "diverged";
  const worktrees = git(cwd, ["worktree", "list", "--porcelain"]).split(/\n\n+/).map((block) => block.split("\n"));
  if (mainInFlight(worktrees)) return "blocked";
  const holder = worktrees.find((fields) => fields.includes("branch refs/heads/main"));
  if (!holder) {
    git(cwd, ["update-ref", "refs/heads/main", remote, tip]);
    return "fast-forwarded";
  }
  const dir = holder[0].replace(/^worktree /, "");
  if (git(dir, ["status", "--porcelain", "--untracked-files=no"])) return "dirty";
  return tryGit(dir, ["merge", "--ff-only", "--quiet", remote]) === null ? "blocked" : "fast-forwarded";
}

function log(message) {
  process.stdout.write(`[ship-memory ${new Date().toISOString()}] ${message}\n`);
}

function fetchMain(cwd) {
  git(cwd, ["fetch", "--quiet", "--no-tags", "origin", "+refs/heads/main:refs/remotes/origin/main"]);
}

export async function main(argv = process.argv.slice(2)) {
  const opts = { cwd: process.cwd(), dryRun: false, wait: false };
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a === "--cwd") opts.cwd = argv[++i];
    else if (a === "--dry-run") opts.dryRun = true;
    else if (a === "--wait") opts.wait = true;
    else throw new Error(`unknown argument: ${a}`);
  }
  const cwd = git(opts.cwd, ["rev-parse", "--show-toplevel"]);
  const release = opts.dryRun ? () => {} : acquireLock(cwd);
  if (!release) { log("another shipper holds the lock; a --wait holder ships new commits before it exits, otherwise the next commit does"); return 0; }
  try {
    const branch = memoryBranch();
    const deadline = Date.now() + WAIT_LIMIT_MS;
    let shippedTip = null;
    let synced = null;
    for (;;) {
      release.renew?.();
      fetchMain(cwd);
      const local = git(cwd, ["rev-parse", "--verify", "refs/heads/main^{commit}"]);
      const base = git(cwd, ["rev-parse", "--verify", "refs/remotes/origin/main^{commit}"]);
      // Building the merge runs the merge drivers; a poll rebuilds it only when a side moved.
      if (synced?.local !== local || synced?.base !== base) synced = syncTip({ cwd, local, remoteBase: base });
      const pushed = shippedTip ? `this tip was not pushed; ${shippedTip.slice(0, 7)} stays pushed` : "nothing was pushed";
      if (synced.status === "conflict") {
        log(`refused: local main conflicts with origin/main on ${synced.conflicts.length} path(s) even with this repository's merge drivers: ${synced.conflicts.join(", ")} — merge origin/main into main by hand; ${pushed}`);
        return 6;
      }
      if (synced.status === "timeout") {
        log(`refused: the merge drivers did not merge origin/main into local main within ${MERGE_TIMEOUT_MS / 60_000} min — merge it by hand; ${pushed}`);
        return 6;
      }
      const plan = synced.status === "absorbed" ? { status: "nothing" } : planShip({ cwd, local: synced.tip, remoteBase: base });
      if (plan.status === "nothing") {
        if (!opts.dryRun) log(`nothing to ship; local main ${fastForwardMain(cwd)}`);
        else log("nothing to ship");
        return 0;
      }
      if (plan.status === "refused-outside") {
        log(`refused: ${plan.outside.length} path(s) outside the memory-only class — ship these by a reviewed PR: ${plan.outside.join(", ")}; ${pushed}`);
        return 3;
      }
      if (plan.status === "refused-publication") {
        for (const hit of plan.hits) log(`refused: ${hit.kind} in ${hit.file} at ${hit.field}${hit.excerpt ? ` (${hit.excerpt})` : ""}`);
        log(`move the flagged record to the private overlay or fix it; ${pushed}`);
        return 4;
      }
      if (opts.dryRun) { log(`would push ${plan.commits.length} commit(s) (${plan.paths.length} path(s)) to ${branch}`); return 0; }
      if (plan.tip !== shippedTip) {
        const closed = heldByClosedPr(cwd, closedPrs(cwd, branch), plan.tip, plan.base);
        if (closed) { log(`refused: PR #${closed.number} was closed without merging and local main still carries its commits; drop them from main or ship by hand`); return 5; }
        git(cwd, ["push", "--quiet", "--force", "origin", `${plan.tip}:refs/heads/${branch}`]);
        const pr = ensurePr(cwd, branch, plan);
        log(`pushed ${plan.commits.length} commit(s) to ${branch}: ${pr.url}`);
        shippedTip = plan.tip;
      }
      if (!opts.wait) return 0;
      if (Date.now() > deadline) {
        const checks = checksSummary(cwd, branch);
        log(`stopped waiting; the PR auto-merges on its own when green${checks ? ` (${checks})` : ""}`);
        return 0;
      }
      await sleep(POLL_MS);
    }
  } finally {
    release();
  }
}

if (process.argv[1] && import.meta.url === pathToFileURL(resolve(process.argv[1])).href) {
  main().then((code) => process.exit(code), (error) => {
    process.stderr.write(`ship-memory: ${error instanceof Error ? error.message : String(error)}\n`);
    process.exit(1);
  });
}
