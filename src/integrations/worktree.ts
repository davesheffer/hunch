/**
 * Worktree wiring — make a repo's private-overlay memory seamless across every git
 * worktree (v0.32+). A worktree's gitignored `.hunch/local.json` pointer doesn't exist
 * in a fresh checkout, so we register the overlay at the SHARED git common dir
 * (`git rev-parse --git-common-dir`), which every linked worktree resolves identically.
 */
import { existsSync, readFileSync, mkdirSync } from "node:fs";
import { join, resolve } from "node:path";
import { gitCommonDir } from "../extractors/git.js";
import { writeFileAtomic } from "../core/io.js";

/** Register the resolved private overlay at the shared git common dir, so every worktree
 *  of this repo auto-discovers the same memory. Idempotent (writes only when missing or
 *  changed). Stored ABSOLUTE — a worktree resolves relative paths from its OWN root.
 *  Returns true once the shared pointer is in place (memory is worktree-shared), false when
 *  there's no overlay configured or no git common dir. Reused by `init`/`worktree`/`private`. */
export function ensureSharedOverlayPointer(root: string, overlayDir: string | undefined, autoCommit: boolean): boolean {
  const common = overlayDir ? gitCommonDir(root) : "";
  if (!common || !overlayDir) return false;
  const file = join(common, "hunch", "local.json");
  const want = JSON.stringify({ privateDir: resolve(overlayDir), autoCommit }, null, 2) + "\n";
  try {
    if (!(existsSync(file) && readFileSync(file, "utf8") === want)) {
      mkdirSync(join(common, "hunch"), { recursive: true });
      writeFileAtomic(file, want);
    }
    return true;
  } catch {
    return false;
  }
}
