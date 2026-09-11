import { lstatSync, realpathSync } from "node:fs";
import { join } from "node:path";

/** Report paths are local to this physical worktree. Existing symlinks and
 * hard-linked files are refused; never follow a cache pointer into another scope. */
export function assertReportPath(root: string, ...parts: string[]): string {
  let path = realpathSync(root);
  for (const part of parts) {
    if (!/^[A-Za-z0-9._-]+$/.test(part) || part === "." || part === "..") throw new Error("invalid local report path component");
    path = join(path, part);
    try {
      const stat = lstatSync(path);
      if (stat.isSymbolicLink() || (stat.isFile() && stat.nlink > 1)) throw new Error("report path must not follow symlinks or hard links");
    } catch (error) { if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error; }
  }
  return path;
}
