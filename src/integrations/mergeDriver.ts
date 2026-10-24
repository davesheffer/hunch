/**
 * Wires up two independent git merge drivers:
 *  - `merge=hunch`: the structured `.hunch/` JSON driver (store/merge.ts), which
 *    resolves concurrent edits by record id;
 *  - `merge=hunch-grounding`: the generated grounding docs driver
 *    (core/groundingMerge.ts), which auto-resolves only a hard conflict confined
 *    to the record-counts sentence.
 * Both routes live in the committed `.gitattributes`. Both drivers are
 * registered only in local, per-clone git config, because each references this
 * machine's node and CLI path; teammates re-run `hunch init`.
 */
import { execFileSync } from "node:child_process";
import { readFileSync, existsSync } from "node:fs";
import { writeFileAtomic } from "../core/io.js";
import { assertSafeTopLevelConfigFile } from "./gitignore.js";
import { GROUNDING_DOC_PATHS } from "./providers.js";
import { mergeDriverShell } from "../cli/invocation.js";

// Route the .hunch JSON records through the structured driver — but NOT the
// manifest (an id-less `{schema_version}` object the driver can't merge by id; a
// normal text merge with conflict markers is the right behavior for it).
// The five generated grounding docs go to the other driver, which is narrower:
// it only ever touches a hard conflict confined to the counts sentence.
export const ATTR_LINES: readonly string[] = [
  ".hunch/**/*.json merge=hunch",
  ".hunch/manifest.json merge=text",
  ...GROUNDING_DOC_PATHS.map((p) => `${p} merge=hunch-grounding`),
];

export function targetRepositoryEnv(): NodeJS.ProcessEnv {
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

  // 2. The driver definitions go into local git config. They are per-clone (they
  //    reference this machine's node and CLI path), so they are never committed; teammates
  //    re-run init. Dev mode swaps `npx tsx` for Hunch's own loader (#492).
  const shell = mergeDriverShell(invShell);
  const driver = `${shell} merge-driver "%O" "%A" "%B" "%P"`;
  const groundingDriver = `${shell} merge-driver-grounding "%O" "%A" "%B" "%P"`;
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
