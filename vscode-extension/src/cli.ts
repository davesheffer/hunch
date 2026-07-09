/**
 * The single seam through which the extension shells out to the `hunch` CLI.
 * Every write (accept/reject a draft, record a constraint/bug) and every
 * on-demand read command (status, drift, conform, …) goes through here — the
 * extension NEVER writes .hunch/ JSON itself; the CLI owns atomic, validated
 * writes (con: "Delegate all writes to CLI; extension is a pure JSON reader").
 */
import * as vscode from "vscode";
import * as cp from "node:child_process";
import * as fs from "node:fs";
import * as nodePath from "node:path";

export interface CliResult { ok: boolean; stdout: string; stderr: string; code: number | null; }

let resolved: string | undefined; // probe once per session

/** The configured CLI command (default `hunch`); set `hunch.cliPath` to relocate.
 *
 *  GUI-launched VS Code often lacks the shell's PATH (npm's global bin dir in
 *  particular), which surfaced as "every command exits 1 with no output". So when
 *  the setting is the bare default, probe the standard npm global locations once
 *  and pin the first hit; a user-set value is always respected verbatim. */
export function cliCommand(): string {
  const cfg = vscode.workspace.getConfiguration("hunch").get("cliPath", "hunch");
  if (cfg !== "hunch") return cfg;           // explicit setting wins, verbatim
  if (resolved) return resolved;
  const home = process.env.HOME ?? process.env.USERPROFILE ?? "";
  const candidates = process.platform === "win32"
    ? [nodePath.join(process.env.APPDATA ?? "", "npm", "hunch.cmd")]
    : ["/usr/local/bin/hunch", "/opt/homebrew/bin/hunch", nodePath.join(home, ".npm-global", "bin", "hunch")];
  resolved = candidates.find((c) => c && fs.existsSync(c)) ?? "hunch";
  return resolved;
}

/** Quote one arg for cmd.exe. Bare when safe; else wrap in double quotes and escape
 *  embedded quotes (\"), matching the existing record-* command quoting. */
export function winQuote(a: string): string {
  return /[\s"&|<>^()%!,;]/.test(a) ? `"${a.replace(/"/g, '\\"')}"` : a;
}

/** Run `hunch <args...>` in `root`. Resolves (never rejects) so callers branch on `.ok`.
 *
 *  Windows: npm installs `hunch` as a `.cmd`/`.ps1` shim, NOT a native exe. Node ≥18.20
 *  refuses to spawn such a shim via execFile WITHOUT a shell (CVE-2024-27980 hardening) —
 *  it fails ENOENT with empty stdout, which surfaced as "every extension command exits 1
 *  with no output". So on Windows we run through cmd.exe with each arg quoted ourselves
 *  (shell:true would concatenate them unescaped — DEP0190). Elsewhere the argv form is
 *  safe and shell-free. */
export function runHunch(root: string, args: string[], timeoutMs = 120_000): Promise<CliResult> {
  const opts = { cwd: root, timeout: timeoutMs, maxBuffer: 8 * 1024 * 1024 };
  const settle = (resolve: (r: CliResult) => void) => (err: cp.ExecException | cp.ExecFileException | null, stdout: string, stderr: string) => {
    const code = err && typeof (err as { code?: unknown }).code === "number" ? (err as { code: number }).code : err ? 1 : 0;
    resolve({ ok: !err, stdout: stdout ?? "", stderr: stderr ?? "", code });
  };
  return new Promise((resolve) => {
    if (process.platform === "win32") {
      cp.exec([cliCommand(), ...args].map(winQuote).join(" "), opts, settle(resolve));
    } else {
      cp.execFile(cliCommand(), args, opts, settle(resolve));
    }
  });
}

/** A running CLI process: the buffered result plus a kill switch (the console's
 *  Stop button). `result` resolves (never rejects) exactly like `runHunch`. */
export interface HunchProc { result: Promise<CliResult>; kill(): void; }

/** Run `hunch <args...>` and STREAM stdout line-by-line via `onLine` as it lands —
 *  the seam behind the live Review Console and the Hunch Console. Returns the
 *  process handle so the caller can cancel; `result` resolves (never rejects)
 *  with the full buffered output once the process exits.
 *
 *  Windows: same npm `.cmd` shim problem as `runHunch` — we can't spawn the shim via
 *  argv without a shell (Node ≥18.20 CVE-2024-27980 hardening). So on Windows we build
 *  the command line ourselves (each arg winQuote'd) and spawn it as a single string
 *  under `shell:true`; passing NO separate args array avoids the DEP0190 warning that
 *  `shell:true` + args triggers. Elsewhere the shell-free argv form is used. */
export function spawnHunchProc(
  root: string,
  args: string[],
  onLine: (line: string) => void,
  timeoutMs = 900_000,
): HunchProc {
  let kill: () => void = () => { /* not started yet */ };
  const result = new Promise<CliResult>((resolve) => {
    const child = process.platform === "win32"
      ? cp.spawn([cliCommand(), ...args].map(winQuote).join(" "), { cwd: root, shell: true })
      : cp.spawn(cliCommand(), args, { cwd: root });
    kill = () => { try { child.kill(); } catch { /* already gone */ } };

    let out = "", err = "", buf = "", settled = false;
    const timer = setTimeout(kill, timeoutMs);
    const settle = (code: number | null, ok: boolean): void => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      if (buf.trim()) onLine(buf); // flush a trailing partial line
      resolve({ ok, stdout: out, stderr: err, code });
    };

    child.stdout?.setEncoding("utf8");
    child.stdout?.on("data", (chunk: string) => {
      out += chunk;
      buf += chunk;
      let nl: number;
      while ((nl = buf.indexOf("\n")) >= 0) {
        const line = buf.slice(0, nl).replace(/\r$/, "");
        buf = buf.slice(nl + 1);
        if (line.length) onLine(line);
      }
    });
    child.stderr?.setEncoding("utf8");
    child.stderr?.on("data", (chunk: string) => { err += chunk; });
    child.on("error", () => settle(1, false));
    child.on("close", (code) => settle(code, code === 0));
  });
  return { result, kill: () => kill() };
}

/** Buffered convenience wrapper over `spawnHunchProc` (no cancel handle). */
export function spawnHunch(
  root: string,
  args: string[],
  onLine: (line: string) => void,
  timeoutMs = 900_000,
): Promise<CliResult> {
  return spawnHunchProc(root, args, onLine, timeoutMs).result;
}

/** Run a command under a notification-area progress spinner. Surfaces a helpful
 *  error (pointing at `hunch.cliPath`) when the CLI can't be found or fails. */
export async function runHunchWithProgress(root: string, args: string[], title: string): Promise<CliResult> {
  return vscode.window.withProgress({ location: vscode.ProgressLocation.Notification, title }, async () => {
    const res = await runHunch(root, args);
    if (!res.ok) {
      const detail = (res.stderr || res.stdout || `exit ${res.code}`).trim().split("\n").slice(-3).join("\n");
      vscode.window.showErrorMessage(`Hunch CLI failed (${cliCommand()} ${args[0]}). ${detail}. Set "hunch.cliPath" if the CLI isn't on PATH.`);
    }
    return res;
  });
}
