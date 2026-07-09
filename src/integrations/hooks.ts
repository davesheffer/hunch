/**
 * Git post-commit hook installer (DESIGN.md §4 / §6). The hook fires the
 * learning loop after every commit. Loop-guarded via the HUNCH_SYNC env var, and
 * backgrounded so it never slows a commit down. Existing hooks are preserved —
 * we append a guarded block rather than clobbering.
 */
import { readFileSync, writeFileSync, existsSync, chmodSync, mkdirSync } from "node:fs";
import { join, isAbsolute } from "node:path";
import { hooksDir } from "../extractors/git.js";

const MARK = "# >>> hunch post-commit >>>";
const ENDMARK = "# <<< hunch post-commit <<<";

function block(invocation: string, opts: { private?: boolean; commit?: boolean; localOnly?: boolean } = {}): string {
  // --private routes the auto-synthesized decision into the HUNCH_PRIVATE_DIR overlay
  // instead of the public repo. --commit (opt-in) also commits & pushes the repo the
  // decision landed in (the private store under --private, else this repo). The hook
  // script is local (.git/hooks/), never committed.
  const priv = opts.private ? " --private" : "";
  const commit = opts.commit ? " --commit" : "";
  return [
    MARK,
    'if [ -z "$HUNCH_SYNC" ]; then',
    "  export HUNCH_SYNC=1",
    // A split-private capture must not make a storage-private promise and then
    // ship the commit diff to a subscription CLI. Shared overlays are a separate
    // team policy, so only the explicit local-only mode forces deterministic.
    ...(opts.localOnly ? ["  export HUNCH_SYNTH_PROVIDER=deterministic"] : []),
    `  ( ${invocation} sync --from-hook --quiet${priv}${commit} >/dev/null 2>&1 || true ) &`,
    "fi",
    ENDMARK,
  ].join("\n");
}

export interface HookInstall {
  path: string;
  action: "created" | "appended" | "updated" | "unchanged";
}

export function installPostCommitHook(root: string, invocation: string, opts: { private?: boolean; commit?: boolean; localOnly?: boolean } = {}): HookInstall {
  const dir = hooksDir(root);
  // `git rev-parse --git-path hooks` returns a path relative to the repo in a
  // normal checkout, but an ABSOLUTE one inside a linked worktree (the shared
  // hooks dir). isAbsolute() handles both POSIX (/…) and Windows (C:\… / C:/…);
  // a bare startsWith("/") misfired on Windows worktrees → a doubled junk path.
  const abs = isAbsolute(dir) ? dir : join(root, dir);
  mkdirSync(abs, { recursive: true });
  const hookPath = join(abs, "post-commit");
  const blk = block(invocation, opts);

  if (!existsSync(hookPath)) {
    writeFileSync(hookPath, `#!/bin/sh\n${blk}\n`);
    chmodSync(hookPath, 0o755);
    return { path: hookPath, action: "created" };
  }

  const cur = readFileSync(hookPath, "utf8");
  if (cur.includes(MARK)) {
    // replace our managed block (invocation may have changed)
    const updated = cur.replace(new RegExp(`${escapeRe(MARK)}[\\s\\S]*?${escapeRe(ENDMARK)}`), blk);
    if (updated === cur) return { path: hookPath, action: "unchanged" };
    writeFileSync(hookPath, updated);
    chmodSync(hookPath, 0o755);
    return { path: hookPath, action: "updated" };
  }

  const appended = cur.endsWith("\n") ? `${cur}${blk}\n` : `${cur}\n${blk}\n`;
  writeFileSync(hookPath, appended);
  chmodSync(hookPath, 0o755);
  return { path: hookPath, action: "appended" };
}

function escapeRe(s: string): string {
  return s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

const PRE_MARK = "# >>> hunch pre-commit (constraint guard) >>>";
const PRE_END = "# <<< hunch pre-commit <<<";

/** Install a pre-commit constraint guard (DESIGN §4 enforcement). Advisory by
 *  default (prints invariants in scope, never blocks); pass strict to fail the
 *  commit — but even strict only fails on a DIRECT, high-confidence, non-stale
 *  blocking invariant (see strictgate.ts), so it's safe on a shared repo.
 *  Preserves any existing pre-commit hook. */
export function installPreCommitHook(root: string, invocation: string, strict = false): HookInstall {
  const dir = hooksDir(root);
  // `git rev-parse --git-path hooks` returns a path relative to the repo in a
  // normal checkout, but an ABSOLUTE one inside a linked worktree (the shared
  // hooks dir). isAbsolute() handles both POSIX (/…) and Windows (C:\… / C:/…);
  // a bare startsWith("/") misfired on Windows worktrees → a doubled junk path.
  const abs = isAbsolute(dir) ? dir : join(root, dir);
  mkdirSync(abs, { recursive: true });
  const hookPath = join(abs, "pre-commit");
  const cmd = `${invocation} check --staged${strict ? " --strict" : ""}`;
  const blk = [PRE_MARK, strict ? cmd : `${cmd} || true`, PRE_END].join("\n");

  if (!existsSync(hookPath)) {
    writeFileSync(hookPath, `#!/bin/sh\n${blk}\n`);
    chmodSync(hookPath, 0o755);
    return { path: hookPath, action: "created" };
  }
  const cur = readFileSync(hookPath, "utf8");
  if (cur.includes(PRE_MARK)) {
    const updated = cur.replace(new RegExp(`${escapeRe(PRE_MARK)}[\\s\\S]*?${escapeRe(PRE_END)}`), blk);
    if (updated === cur) return { path: hookPath, action: "unchanged" };
    writeFileSync(hookPath, updated);
    return { path: hookPath, action: "updated" };
  }
  writeFileSync(hookPath, cur.endsWith("\n") ? `${cur}${blk}\n` : `${cur}\n${blk}\n`);
  chmodSync(hookPath, 0o755);
  return { path: hookPath, action: "appended" };
}
