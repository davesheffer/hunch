/** Resolve a user-supplied argv into something `spawn` can run without a shell.
 *
 * On POSIX the argv is already right. On Windows, `spawn("npx", ...)` with
 * `shell: false` fails: the launcher is `npx.cmd`, and Node refuses to run
 * `.cmd`/`.bat` files directly. The verification runner used to swallow that
 * as `exit_code: null`, so every contribution card on Windows said "no
 * independent command result". This keeps `shell: false` for real
 * executables and only routes batch launchers through `cmd.exe`, with the
 * npm/npx launchers run as plain Node scripts (no shell at all). */
import { existsSync } from "node:fs";
import { posix, win32 } from "node:path";

export interface ResolvedSpawn {
  file: string;
  args: string[];
  /** Set when a batch launcher runs through cmd.exe and the line is pre-quoted. */
  windowsVerbatimArguments?: boolean;
  how: "direct" | "npm-cli" | "pathext" | "cmd-shim";
}

export interface SpawnResolveOptions {
  platform?: NodeJS.Platform;
  env?: NodeJS.ProcessEnv;
  execPath?: string;
  exists?: (path: string) => boolean;
}

/** Quote one argument for a `cmd.exe /d /v:off /s /c "<line>"` launch of a
 * batch file whose target program parses its command line with the MSVCRT
 * rules (Node, Python, most native tools).
 *
 * Two parsers read the line, and a batch shim that forwards `%*` makes cmd.exe
 * read it again, so the quoting must mean the same thing to both on every pass:
 *
 * - Every non-trivial argument is wrapped in quotes. An embedded quote becomes
 *   `""` (not `\"`): MSVCRT reads `""` inside a quoted argument as one literal
 *   quote, and cmd.exe sees two toggles, so its quote state never drifts from
 *   the argument boundaries and `& | < > ( ) ^` always stay inside quotes.
 *   A `\"` would look escaped to MSVCRT but end the quoted region for cmd.exe.
 * - Backslashes are literal except before a quote, so a run of backslashes that
 *   precedes an embedded or closing quote is doubled.
 * - `%` expands even inside quotes. It is emitted as `"^%"`: the quote closes,
 *   the caret escapes the percent outside quotes (cmd.exe removes the caret),
 *   and the quote reopens. MSVCRT joins the pieces back into one argument.
 *   Expansion of a forwarded `%*` is not rescanned, so a shim pass is safe too.
 *
 * A line break cannot be carried: cmd.exe ends the command at it and silently
 * drops the rest, so such an argument is refused rather than truncated. */
function quoteForCmd(arg: string): string {
  if (/[\r\n]/.test(arg)) throw new Error("a .cmd/.bat launcher cannot receive an argument containing a line break");
  if (arg !== "" && /^[A-Za-z0-9_\-.:/\\@+]+$/.test(arg)) return arg;
  let out = '"';
  let backslashes = 0;
  for (const ch of arg) {
    if (ch === "\\") { backslashes++; continue; }
    if (ch === '"') out += "\\".repeat(backslashes * 2) + '""';
    else if (ch === "%") out += "\\".repeat(backslashes * 2) + '"^%"';
    else out += "\\".repeat(backslashes) + ch;
    backslashes = 0;
  }
  return out + "\\".repeat(backslashes * 2) + '"';
}

export function resolveSpawnCommand(command: readonly string[], options: SpawnResolveOptions = {}): ResolvedSpawn {
  const platform = options.platform ?? process.platform;
  const [cmd = "", ...args] = command;
  if (platform !== "win32") return { file: cmd, args, how: "direct" };
  const env = options.env ?? process.env;
  const exists = options.exists ?? existsSync;
  const execPath = options.execPath ?? process.execPath;
  // Resolve Windows paths with Windows semantics even when the resolution is
  // exercised (tested) on another platform; the host's default `path` is POSIX there.
  const { join, dirname } = platform === "win32" ? win32 : posix;

  // npm / npx: run the CLI script with this same Node. No shim, no shell.
  if (/^(npm|npx)$/i.test(cmd)) {
    const script = join(dirname(execPath), "node_modules", "npm", "bin", `${cmd.toLowerCase()}-cli.js`);
    if (exists(script)) return { file: execPath, args: [script, ...args], how: "npm-cli" };
  }
  // A path or an explicit executable extension: spawn as given.
  if (/[\\/]/.test(cmd) || /\.(exe|com)$/i.test(cmd)) return { file: cmd, args, how: "direct" };

  const pathExt = (env.PATHEXT ?? ".COM;.EXE;.BAT;.CMD").split(";").map((e) => e.trim()).filter(Boolean);
  const dirs = (env.PATH ?? env.Path ?? "").split(";").map((d) => d.trim()).filter(Boolean);
  for (const dir of dirs) {
    for (const ext of ["", ...pathExt]) {
      const candidate = join(dir, cmd + ext);
      if (!exists(candidate)) continue;
      if (/\.(cmd|bat)$/i.test(candidate)) {
        const line = [candidate, ...args].map(quoteForCmd).join(" ");
        return { file: env.ComSpec ?? "cmd.exe", args: ["/d", "/v:off", "/s", "/c", `"${line}"`], windowsVerbatimArguments: true, how: "cmd-shim" };
      }
      if (ext === "" && !/\.(exe|com)$/i.test(candidate)) continue; // an extensionless file is not runnable on Windows
      return { file: candidate, args, how: "pathext" };
    }
  }
  return { file: cmd, args, how: "direct" };
}
