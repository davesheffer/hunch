/**
 * Team discovery for the shared memory store — the COMMITTED half of the resolution chain.
 * `.hunch/local.json` (gitignored, per-machine) says where THIS machine's overlay lives;
 * `.hunch/team.json` (committed, public) says where the TEAM's shared store lives, so a
 * fresh clone / a new teammate / a headless agent can auto-wire without being told.
 * Written ONLY by `hunch shared --repo <url>` — `hunch private` never publishes its URL.
 */
import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { spawnSync } from "node:child_process";
import { writeFileAtomic } from "../core/io.js";
import { hunchPaths, hunchPathsForDir } from "../core/paths.js";
import { mainWorktreeRoot } from "../extractors/git.js";
import { HunchStore } from "../store/hunchStore.js";
import { JsonStore } from "../store/jsonStore.js";
import { ensureSharedOverlayPointer } from "./worktree.js";

export interface TeamConfig {
  shared_repo: string;
}

/** The committed team pointer, or null. Tolerant — an invalid file reads as absent. */
export function readTeamConfig(root: string): TeamConfig | null {
  try {
    const file = join(hunchPaths(root).hunch, "team.json");
    if (!existsSync(file)) return null;
    const v = JSON.parse(readFileSync(file, "utf8")) as { shared_repo?: unknown };
    return typeof v.shared_repo === "string" && v.shared_repo.trim() ? { shared_repo: v.shared_repo.trim() } : null;
  } catch {
    return null;
  }
}

/** Publish the team's shared-store URL (atomic; committed with the repo). */
export function writeTeamConfig(root: string, cfg: TeamConfig): void {
  writeFileAtomic(join(hunchPaths(root).hunch, "team.json"), JSON.stringify(cfg, null, 2) + "\n");
}

/** Auto-wire this checkout to the team's shared store advertised in `.hunch/team.json`:
 *  clone it to the worktree-stable anchor, and register the gitignored local pointer +
 *  the git-common-dir pointer (mode "shared", auto-commit on) so every consumer — CLI,
 *  MCP server, hooks, all worktrees — resolves the same single source of truth.
 *  No-op (null) when an overlay is already configured, there's no team.json, or the
 *  clone fails (best-effort: never throws, never blocks startup). Returns the overlay
 *  hunch dir when wired. */
export function ensureTeamOverlay(root: string): string | null {
  try {
    if (process.env.HUNCH_PRIVATE_DIR?.trim()) return null; // explicit env wins
    const team = readTeamConfig(root);
    if (!team) return null;
    const probe = new HunchStore(hunchPaths(root));
    const configured = probe.privateDir;
    probe.close();
    if (configured && existsSync(configured)) return null; // already wired and alive

    const anchor = mainWorktreeRoot(root);
    const dest = join(anchor, ".hunch-private");
    if (!existsSync(dest)) {
      const r = spawnSync("git", ["clone", team.shared_repo, dest], { stdio: "ignore" });
      if (r.status !== 0) return null; // offline / no access — stay unwired, never crash
    }
    const hunchDir = join(dest, ".hunch");
    new JsonStore(hunchPathsForDir(hunchDir)).ensureDirs();
    // Merge into any existing local.json (con_8460b6770f): a per-machine autoCommit
    // opt-out must survive the auto-wiring; an unparseable file is left alone.
    const localFile = join(hunchPaths(root).hunch, "local.json");
    let existing: Record<string, unknown> = {};
    if (existsSync(localFile)) {
      try { existing = JSON.parse(readFileSync(localFile, "utf8")) as Record<string, unknown>; }
      catch { return null; } // refuse to clobber an unparseable config
    }
    const autoCommit = existing.autoCommit !== false;
    writeFileAtomic(localFile, JSON.stringify({ ...existing, privateDir: hunchDir, autoCommit, mode: "shared" }, null, 2) + "\n");
    ensureSharedOverlayPointer(root, hunchDir, autoCommit, "shared");
    return hunchDir;
  } catch {
    return null;
  }
}
