/** The real package version, read once from package.json at the package root —
 *  two dirs up from dist/<area>/ in the published tarball, and from src/<area>/ in
 *  dev. Shared by the CLI (`--version`) and the MCP server (serverInfo) so neither
 *  drifts from what npm shipped; a hardcoded literal silently lies (the MCP server
 *  reported 0.1.0 for every release until this). Falls back to "0.0.0" if unreadable. */
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";

export const HUNCH_VERSION: string = (() => {
  try {
    const pkgPath = join(dirname(fileURLToPath(import.meta.url)), "../../package.json");
    const v = (JSON.parse(readFileSync(pkgPath, "utf8")) as { version?: unknown }).version;
    return typeof v === "string" ? v : "0.0.0";
  } catch {
    return "0.0.0";
  }
})();
