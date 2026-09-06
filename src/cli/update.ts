import { spawnSync } from "node:child_process";
import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import type { Command } from "commander";
import { findRoot } from "../core/paths.js";

const PACKAGE = "@davesheffer/hunch";
type Run = (args: string[], capture?: boolean) => string;
export interface UpdateOptions { global?: boolean; dryRun?: boolean }

/** Arguments come only from fixed commands and a validated registry version.
 * Windows needs the shell to resolve npm.cmd; cwd is never interpolated. */
export function runNpm(root: string, args: string[], capture = false): string {
  if (args.some(arg => !/^[a-zA-Z0-9@/_.=+:-]+$/.test(arg))) throw new Error("unsafe npm argument");
  const windows = process.platform === "win32";
  const result = spawnSync(windows ? `npm ${args.join(" ")}` : "npm", windows ? [] : args, {
    cwd: root, shell: windows, windowsHide: true,
    encoding: "utf8", stdio: capture ? ["ignore", "pipe", "pipe"] : "inherit",
  });
  if (result.error) throw result.error;
  if (result.status !== 0) throw new Error(`npm ${args.join(" ")} failed (${result.status ?? result.signal})${result.stderr ? `: ${result.stderr.trim()}` : ""}`);
  return result.stdout ?? "";
}

/** Fresh child execution is essential: the currently running CLI still has the
 * old modules loaded after npm replaces its installation. */
export function updateHunch(root: string, opts: UpdateOptions = {}, run: Run = (args, capture) => runNpm(root, args, capture), log: (line: string) => void = console.log): void {
  const file = join(root, "package.json");
  const manifest = existsSync(file) ? JSON.parse(readFileSync(file, "utf8")) : {};
  if (!manifest || typeof manifest !== "object" || Array.isArray(manifest)) throw new Error("package.json must contain an object");
  if (manifest.name === PACKAGE) throw new Error("Run hunch update in a consumer repository, not Hunch's own source checkout.");
  const sections = ["dependencies", "devDependencies", "optionalDependencies"] as const;
  const declared = sections.filter(section => {
    const deps = manifest[section];
    if (deps !== undefined && (!deps || typeof deps !== "object" || Array.isArray(deps))) throw new Error(`invalid ${section} in package.json`);
    return deps && Object.hasOwn(deps, PACKAGE);
  });
  if (declared.length > 1) throw new Error("Hunch is declared in multiple dependency sections; resolve the duplicate before updating.");
  if (declared.length && (manifest.workspaces || (manifest.packageManager && !/^npm@/.test(manifest.packageManager)) || ["pnpm-lock.yaml", "yarn.lock", "bun.lock", "bun.lockb"].some(name => existsSync(join(root, name))))) {
    throw new Error("Automatic dependency updates currently support standalone npm projects. Update Hunch to an exact version with your package manager, then run hunch integrations repair-pins.");
  }
  const version: unknown = JSON.parse(run(["view", `${PACKAGE}@latest`, "version", "--json"], true));
  if (typeof version !== "string" || !/^\d+\.\d+\.\d+(?:-[0-9A-Za-z.-]+)?(?:\+[0-9A-Za-z.-]+)?$/.test(version)) throw new Error("npm returned an invalid Hunch version");
  const spec = `${PACKAGE}@${version}`;
  const commands: string[][] = [];
  if (declared.length) {
    const flag = { dependencies: "--save-prod", devDependencies: "--save-dev", optionalDependencies: "--save-optional" }[declared[0]!];
    commands.push(["install", flag, "--save-exact", spec]);
  }
  if (!declared.length || opts.global) commands.push(["install", "--global", spec]);
  // The alias prevents npm exec from substituting a stale local hunch binary.
  commands.push(["exec", "--yes", `--package=hunch-exact@npm:${spec}`, "--", "hunch", "integrations", "repair-pins"]);
  log(`${opts.dryRun ? "Preview" : "Updating"}: Hunch ${version} for ${root}`);
  for (const args of commands) {
    log(`npm ${args.join(" ")}`);
    if (!opts.dryRun) run(args);
  }
  if (!opts.dryRun) log("Hunch updated; repository integration check passed. Restart or reconnect active harnesses to load the new MCP version.");
}

export function registerUpdateCommand(program: Command): void {
  program.command("update")
    .description("Update Hunch to latest and repair all configured harness pins in this repository")
    .option("--global", "also update the global CLI when a repository dependency exists")
    .option("--dry-run", "resolve latest and print commands without changing files")
    .action((opts: UpdateOptions) => updateHunch(findRoot(), opts));
}
