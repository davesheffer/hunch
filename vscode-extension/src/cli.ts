/**
 * The single seam through which the extension shells out to the `hunch` CLI.
 * Every write (accept/reject a draft, record a constraint/bug) and every
 * on-demand read command (status, drift, conform, …) goes through here — the
 * extension NEVER writes .hunch/ JSON itself; the CLI owns atomic, validated
 * writes (con: "Delegate all writes to CLI; extension is a pure JSON reader").
 */
import * as vscode from "vscode";
import * as cp from "node:child_process";

export interface CliResult { ok: boolean; stdout: string; stderr: string; code: number | null; }

/** The configured CLI command (default `hunch`); set `hunch.cliPath` to relocate. */
export function cliCommand(): string {
  return vscode.workspace.getConfiguration("hunch").get("cliPath", "hunch");
}

/** Run `hunch <args...>` in `root`. argv form → no shell quoting pitfalls.
 *  Resolves (never rejects) so callers branch on `.ok`. */
export function runHunch(root: string, args: string[], timeoutMs = 120_000): Promise<CliResult> {
  return new Promise((resolve) => {
    cp.execFile(cliCommand(), args, { cwd: root, timeout: timeoutMs, maxBuffer: 8 * 1024 * 1024 }, (err, stdout, stderr) => {
      const code = err && typeof (err as { code?: unknown }).code === "number" ? (err as { code: number }).code : err ? 1 : 0;
      resolve({ ok: !err, stdout: stdout ?? "", stderr: stderr ?? "", code });
    });
  });
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
