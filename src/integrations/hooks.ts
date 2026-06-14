/**
 * Git post-commit hook installer (DESIGN.md §4 / §6). The hook fires the
 * learning loop after every commit. Loop-guarded via the BRAIN_SYNC env var, and
 * backgrounded so it never slows a commit down. Existing hooks are preserved —
 * we append a guarded block rather than clobbering.
 */
import { readFileSync, writeFileSync, existsSync, chmodSync, mkdirSync } from "node:fs";
import { join } from "node:path";
import { hooksDir } from "../extractors/git.js";

const MARK = "# >>> brain post-commit >>>";
const ENDMARK = "# <<< brain post-commit <<<";

function block(invocation: string): string {
  return [
    MARK,
    'if [ -z "$BRAIN_SYNC" ]; then',
    "  export BRAIN_SYNC=1",
    `  ( ${invocation} sync --from-hook --quiet >/dev/null 2>&1 || true ) &`,
    "fi",
    ENDMARK,
  ].join("\n");
}

export interface HookInstall {
  path: string;
  action: "created" | "appended" | "updated" | "unchanged";
}

export function installPostCommitHook(root: string, invocation: string): HookInstall {
  const dir = hooksDir(root);
  const abs = dir.startsWith("/") ? dir : join(root, dir);
  mkdirSync(abs, { recursive: true });
  const hookPath = join(abs, "post-commit");
  const blk = block(invocation);

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
