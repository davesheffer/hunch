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
 * and the Stop gate runs the same check over every dirty file so nothing written
 * by any route survives the turn unflagged.
 *
 * Only ADDED lines count, minus lines the same diff removes (a moved or
 * re-indented line was already there): a file that already contains a rejected
 * pattern must not make every later edit of it a violation. Any failure yields no
 * hit — never an error and never a deny on a guess. */
import { execFileSync } from "node:child_process";
import { readFileSync, statSync } from "node:fs";
import { join } from "node:path";
import type { HunchStore } from "../store/hunchStore.js";
import { vetoInScope, type BlockingHit } from "./hookpolicy.js";

/** Bounds: a command that rewrote a vendored tree must not stall the hook. */
const MAX_FILES = 50;
const MAX_FILE_BYTES = 512_000;
/** Hunch's own state is written by the hook and the capture tools, never by the agent's change. */
const OWN_STATE = /^\.hunch(?:-cache)?\//;

const gitEnv = (): NodeJS.ProcessEnv => ({ ...process.env, GIT_OPTIONAL_LOCKS: "0", GIT_TERMINAL_PROMPT: "0" });

function git(root: string, args: string[]): string | null {
  try {
    return execFileSync("git", ["-C", root, ...args], { encoding: "utf8", timeout: 3_000, maxBuffer: 8_000_000, stdio: ["ignore", "pipe", "ignore"], env: gitEnv() });
  } catch {
    return null;
  }
}

/** Lines `file` (repo-relative, POSIX) gains against HEAD. A tracked file gives its
 *  diff's `+` lines, less any line the same diff removes (compared trimmed, each
 *  removal cancelling one addition). An untracked file — or a repository with no
 *  commit yet — gives all of its lines. Unreadable or oversized: none. */
export function addedLinesSinceHead(root: string, file: string): string[] {
  if (OWN_STATE.test(file)) return [];
  const tracked = git(root, ["ls-files", "--error-unmatch", "--", file]) !== null && git(root, ["rev-parse", "--verify", "--quiet", "HEAD"]) !== null;
  if (!tracked) {
    try {
      const abs = join(root, file);
      if (!statSync(abs).isFile() || statSync(abs).size > MAX_FILE_BYTES) return [];
      return readFileSync(abs, "utf8").split(/\r?\n/);
    } catch {
      return [];
    }
  }
  const diff = git(root, ["diff", "--no-color", "--no-ext-diff", "--unified=0", "HEAD", "--", file]);
  if (!diff) return [];
  const added: string[] = [];
  const removed = new Map<string, number>();
  for (const line of diff.split(/\r?\n/)) {
    if (line.startsWith("+++") || line.startsWith("---")) continue;
    if (line.startsWith("+")) added.push(line.slice(1));
    else if (line.startsWith("-")) {
      const key = line.slice(1).trim();
      removed.set(key, (removed.get(key) ?? 0) + 1);
    }
  }
  return added.filter((line) => {
    const key = line.trim();
    const n = removed.get(key) ?? 0;
    if (!n) return true;
    removed.set(key, n - 1);
    return false;
  });
}

/** Repo-relative files that differ from HEAD (tracked changes and untracked files),
 *  excluding Hunch's own state. Null when git can't answer. */
export function dirtyFilesSinceHead(root: string): string[] | null {
  const raw = git(root, ["status", "--porcelain=v1", "-z", "--untracked-files=all"]);
  if (raw === null) return null;
  const out: string[] = [];
  const fields = raw.split("\u0000");
  for (let i = 0; i < fields.length; i++) {
    const entry = fields[i]!;
    if (entry.length < 4) continue;
    const status = entry.slice(0, 2);
    const path = entry.slice(3);
    if (status.includes("R") || status.includes("C")) i++;
    if (status.includes("D") || OWN_STATE.test(path)) continue;
    out.push(path);
  }
  return out;
}

/** The first blocking Veto hit among `files` (repo-relative), judged on the lines
 *  each gained against HEAD — the post-write counterpart of the pre-edit Veto. */
export function vetoForWrittenFiles(store: HunchStore, root: string, files: readonly string[]): { target: string; hit: BlockingHit } | null {
  for (const target of files.slice(0, MAX_FILES)) {
    if (OWN_STATE.test(target)) continue;
    const added = addedLinesSinceHead(root, target);
    if (!added.length) continue;
    const hit = vetoInScope(store, target, added);
    if (hit) return { target, hit };
  }
  return null;
}

/** The deny text for a shell write: the decision's own reason, plus what to do,
 *  since the write already happened. Like the pre-edit text, it names the decision
 *  and never the way around the guard. */
export function shellVetoReason(target: string, hit: BlockingHit, when: "write" | "stop"): string {
  const how = when === "write"
    ? `A shell command just wrote ${target}, outside the Edit/Write tools.`
    : `${target} still differs from HEAD with a rejected approach at the end of this turn.`;
  return `${how} ${hit.reason} Revert that change in ${target} before continuing.`;
}
