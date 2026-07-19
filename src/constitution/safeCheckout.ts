import { execFileSync } from "node:child_process";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

const TRANSFORM_ATTRIBUTES = ["filter", "working-tree-encoding", "ident", "eol", "text", "crlf", "merge"];
const MAX_ATTRIBUTE_BYTES = 64 * 1024 * 1024;

function nulFields(bytes: Buffer): Buffer[] {
  const fields: Buffer[] = [];
  let start = 0;
  for (let end = bytes.indexOf(0, start); end !== -1; end = bytes.indexOf(0, start)) {
    fields.push(bytes.subarray(start, end));
    start = end + 1;
  }
  if (start < bytes.length) fields.push(bytes.subarray(start));
  return fields;
}

/** Inspect the exact target tree plus repository-local info attributes without
 * checking it out. Any transform/merge driver could execute code or make the
 * worktree bytes diverge from the raw blobs bound by receipts, so fail closed.
 * LFS is allowed only when callers explicitly disable its smudge/process hooks. */
export function hasUnsafeCheckoutAttributes(
  root: string,
  commit: string,
  env: NodeJS.ProcessEnv,
  opts: { allowDisabledLfs?: boolean } = {},
): boolean {
  const session = mkdtempSync(join(tmpdir(), "hunch-attr-index-"));
  const index = join(session, "index");
  const exactEnv = { ...env, GIT_INDEX_FILE: index, GIT_NO_REPLACE_OBJECTS: "1", GIT_ATTR_NOSYSTEM: "1" };
  try {
    execFileSync("git", ["-C", root, "read-tree", commit], {
      env: exactEnv,
      timeout: 10_000,
      maxBuffer: MAX_ATTRIBUTE_BYTES,
      stdio: ["ignore", "ignore", "ignore"],
    });
    const paths = execFileSync("git", ["-C", root, "ls-files", "-z"], {
      env: exactEnv,
      timeout: 10_000,
      maxBuffer: MAX_ATTRIBUTE_BYTES,
      encoding: "buffer",
      stdio: ["ignore", "pipe", "ignore"],
    });
    if (!paths.length) return false;
    const raw = execFileSync("git", ["-C", root, "check-attr", "--cached", "-z", "--stdin", ...TRANSFORM_ATTRIBUTES], {
      env: exactEnv,
      input: paths,
      timeout: 10_000,
      maxBuffer: MAX_ATTRIBUTE_BYTES,
      encoding: "buffer",
      stdio: ["pipe", "pipe", "ignore"],
    });
    const fields = nulFields(raw);
    if (fields.length % 3 !== 0) return true;
    for (let index = 0; index < fields.length; index += 3) {
      const attribute = fields[index + 1]!.toString("utf8");
      const value = fields[index + 2]!.toString("utf8");
      if (!TRANSFORM_ATTRIBUTES.includes(attribute)) return true;
      if (value === "unspecified" || value === "unset") continue;
      if (opts.allowDisabledLfs && attribute === "filter" && value === "lfs") continue;
      return true;
    }
    return false;
  } catch {
    return true;
  } finally {
    rmSync(session, { recursive: true, force: true });
  }
}
