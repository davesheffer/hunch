/**
 * Wires up the structured `.hunch/` git merge driver (store/merge.ts):
 *   - `.gitattributes` (committed) routes the .hunch JSON files through merge=hunch,
 *   - local git config maps merge=hunch to `hunch merge-driver …` (per clone, so
 *     each teammate runs `hunch init` to register it).
 */
import { execFileSync } from "node:child_process";
import { readFileSync, existsSync } from "node:fs";
import { join } from "node:path";
import { writeFileAtomic } from "../core/io.js";

// Route the .hunch JSON records through the structured driver — but NOT the
// manifest (an id-less `{schema_version}` object the driver can't merge by id; a
// normal text merge with conflict markers is the right behavior for it).
const ATTR_LINES = [".hunch/**/*.json merge=hunch", ".hunch/manifest.json merge=text"];

export function installMergeDriver(root: string, invShell: string): { action: string } {
  // 1. .gitattributes — committed, shared with the team so the routing travels.
  const attrPath = join(root, ".gitattributes");
  let text = existsSync(attrPath) ? readFileSync(attrPath, "utf8") : "";
  let attrAction = "present";
  for (const line of ATTR_LINES) {
    if (!text.split(/\r?\n/).some((l) => l.trim() === line)) {
      const sep = text && !text.endsWith("\n") ? "\n" : "";
      text += sep + line + "\n";
      attrAction = "written";
    }
  }
  if (attrAction === "written") writeFileAtomic(attrPath, text);

  // 2. Local git config — the driver definition is per-clone (it references this
  //    machine's node + cli path), so it is NOT committed; teammates re-run init.
  const driver = `${invShell} merge-driver "%O" "%A" "%B" "%P"`;
  try {
    execFileSync("git", ["config", "merge.hunch.name", "hunch structured JSON merge"], { cwd: root });
    execFileSync("git", ["config", "merge.hunch.driver", driver], { cwd: root });
  } catch {
    return { action: `${attrAction} .gitattributes — but \`git config\` failed (not a git repo?)` };
  }
  return { action: `${attrAction} .gitattributes + registered merge.hunch driver` };
}
