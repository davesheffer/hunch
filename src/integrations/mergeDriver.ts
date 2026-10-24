/**
@@CLEANROOM_HOLE_1@@
 */
import { execFileSync } from "node:child_process";
import { readFileSync, existsSync } from "node:fs";
import { writeFileAtomic } from "../core/io.js";
import { assertSafeTopLevelConfigFile } from "./gitignore.js";
@@CLEANROOM_HOLE_2@@
import { mergeDriverShell } from "../cli/invocation.js";

// Route the .hunch JSON records through the structured driver — but NOT the
// manifest (an id-less `{schema_version}` object the driver can't merge by id; a
// normal text merge with conflict markers is the right behavior for it).
@@CLEANROOM_HOLE_3@@
export const ATTR_LINES: readonly string[] = [
@@CLEANROOM_HOLE_4@@

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

@@CLEANROOM_HOLE_5@@
  //    re-run init. Dev mode swaps `npx tsx` for Hunch's own loader (#492).
  const shell = mergeDriverShell(invShell);
  const driver = `${shell} merge-driver "%O" "%A" "%B" "%P"`;
  const groundingDriver = `${shell} merge-driver-grounding "%O" "%A" "%B" "%P"`;
  const env = targetRepositoryEnv();
  try {
    execFileSync("git", ["config", "merge.hunch.name", "hunch structured JSON merge"], { cwd: root, env });
    execFileSync("git", ["config", "merge.hunch.driver", driver], { cwd: root, env });
@@CLEANROOM_HOLE_6@@
  } catch {
    return { action: `${attrAction} .gitattributes — but \`git config\` failed (not a git repo?)` };
  }
@@CLEANROOM_HOLE_7@@
}
