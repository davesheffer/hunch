/**
 * Wires up two independent git merge drivers:
 *   - `merge=hunch` — the structured `.hunch/` JSON driver (store/merge.ts):
 *     resolves concurrent edits by record id.
 *   - `merge=hunch-grounding` — the generated grounding docs (core/groundingMerge.ts):
 *     auto-resolves a hard conflict confined to the record-counts sentence,
 *     leaving any other conflict untouched (dec_ba5b0dfa22).
 * Both routes live in `.gitattributes` (committed, travels with the repo);
 * both drivers are registered in LOCAL git config only (per-clone, since each
 * references this machine's node + cli path — teammates re-run `hunch init`).
 */
import { execFileSync } from "node:child_process";
import { readFileSync, existsSync } from "node:fs";
import { writeFileAtomic } from "../core/io.js";
import { assertSafeTopLevelConfigFile } from "./gitignore.js";

// Route the .hunch JSON records through the structured driver — but NOT the
// manifest (an id-less `{schema_version}` object the driver can't merge by id; a
// normal text merge with conflict markers is the right behavior for it).
//
// The five generated grounding docs get the OTHER driver — narrower in scope
// (it only ever touches a hard conflict confined to the counts sentence).
const GROUNDING_DOCS = ["CLAUDE.md", "AGENTS.md", ".github/copilot-instructions.md", ".cursor/rules/hunch.mdc", ".windsurf/rules/hunch.md"];
const ATTR_LINES = [
  ".hunch/**/*.json merge=hunch",
  ".hunch/manifest.json merge=text",
  ...GROUNDING_DOCS.map((f) => `${f} merge=hunch-grounding`),
];

function targetRepositoryEnv(): NodeJS.ProcessEnv {
  const env = { ...process.env };
  for (const key of [
    "GIT_ALTERNATE_OBJECT_DIRECTORIES", "GIT_CONFIG", "GIT_CONFIG_PARAMETERS", "GIT_CONFIG_COUNT",
    "GIT_OBJECT_DIRECTORY", "GIT_DIR", "GIT_WORK_TREE", "GIT_IMPLICIT_WORK_TREE", "GIT_GRAFT_FILE",
    "GIT_INDEX_FILE", "GIT_NO_REPLACE_OBJECTS", "GIT_REPLACE_REF_BASE", "GIT_PREFIX",
    "GIT_INTERNAL_SUPER_PREFIX", "GIT_SHALLOW_FILE", "GIT_COMMON_DIR",
  ]) delete env[key];
  for (const key of Object.keys(env)) {
    if (/^GIT_CONFIG_(?:KEY|VALUE)_\d+$/.test(key)) delete env[key];
  }
  return env;
}

export function installMergeDriver(root: string, invShell: string): { action: string } {
  // 1. .gitattributes — committed, shared with the team so the routing travels.
  const attrPath = assertSafeTopLevelConfigFile(root, ".gitattributes");
  let text = existsSync(attrPath) ? readFileSync(attrPath, "utf8") : "";
  let attrAction = "present";
  for (const line of ATTR_LINES) {
    if (!text.split(/\r?\n/).some((l) => l.trim() === line)) {
      const sep = text && !text.endsWith("\n") ? "\n" : "";
      text += sep + line + "\n";
      attrAction = "written";
    }
  }
  if (attrAction === "written") {
    assertSafeTopLevelConfigFile(root, ".gitattributes");
    writeFileAtomic(attrPath, text);
  }

  // 2. Local git config — the driver definitions are per-clone (they reference
  //    this machine's node + cli path), so they are NOT committed; teammates
  //    re-run init.
  const driver = `${invShell} merge-driver "%O" "%A" "%B" "%P"`;
  const groundingDriver = `${invShell} merge-driver-grounding "%O" "%A" "%B" "%P"`;
  const env = targetRepositoryEnv();
  try {
    execFileSync("git", ["config", "merge.hunch.name", "hunch structured JSON merge"], { cwd: root, env });
    execFileSync("git", ["config", "merge.hunch.driver", driver], { cwd: root, env });
    execFileSync("git", ["config", "merge.hunch-grounding.name", "hunch grounding-counts merge"], { cwd: root, env });
    execFileSync("git", ["config", "merge.hunch-grounding.driver", groundingDriver], { cwd: root, env });
  } catch {
    return { action: `${attrAction} .gitattributes — but \`git config\` failed (not a git repo?)` };
  }
  return { action: `${attrAction} .gitattributes + registered merge.hunch + merge.hunch-grounding drivers` };
}
