/** The launcher that runs `hunch task verify` from THIS installation, not a
 * potentially stale global binary. Core, not mcp: the prompt hook prints the
 * command inline (so the model needs no hunch_task start call just to learn it)
 * and a hook must never pull in the MCP SDK. */
import { fileURLToPath, pathToFileURL } from "node:url";

/** Structured argv is authoritative; the shell hint uses literal quoting, and
 * `note` disambiguates it where one platform has two incompatible shells. */
export function verificationLauncher(): { argv: string[]; shell: string; note: string } {
  return verificationLauncherFor(import.meta.url, (specifier) => import.meta.resolve(specifier));
}

/** `metaUrl` is the module running (a `.ts` source checkout needs the tsx
 * loader; a published `.js` build needs nothing) and `resolve` is that
 * module's `import.meta.resolve`. Callers in sibling directories (src/core,
 * src/mcp) resolve the same `../cli/index.{ts|js}`, but each must pass ITS OWN
 * import.meta so the dev/published discrimination stays honest. The loader is
 * resolved ONLY on the source path: `import.meta.resolve` throws for a package
 * that is not installed, and `tsx` is a devDependency absent from every
 * published install (#261). `platform` defaults to the running one and exists so
 * the Windows quoting branch is testable from any machine. */
export function verificationLauncherFor(metaUrl: string, resolve: (specifier: string) => string, platform: NodeJS.Platform = process.platform): { argv: string[]; shell: string; note: string } {
  const dev = metaUrl.endsWith(".ts");
  const entry = fileURLToPath(new URL(`../cli/index.${dev ? "ts" : "js"}`, metaUrl));
  // `--import` takes a URL. Converting the resolved loader to a path made Node on
  // Windows reject it ("Received protocol 'c:'"), so every verification launched
  // from a source checkout there failed before running and cards showed no check.
  const loader = dev ? resolve("tsx") : null;
  const argv = [process.execPath, ...(loader ? ["--import", loader.startsWith("file:") ? loader : pathToFileURL(loader).href] : []), entry];
  const win = platform === "win32";
  const quote = (s: string) => win ? `'${s.replace(/'/g, "''")}'` : `'${s.replace(/'/g, "'\\''")}'`;
  // Windows hosts run either PowerShell or a POSIX shell (Git Bash), and the
  // call operator that PowerShell needs is a syntax error in the other. The hint
  // is quoted for PowerShell and says how to use it in the other; the structured
  // argv stays the unambiguous form.
  const note = win ? ` (PowerShell form; in a POSIX shell such as Git Bash drop the leading "& ")` : "";
  return { argv, shell: `${win ? "& " : ""}${argv.map(quote).join(" ")}`, note };
}
