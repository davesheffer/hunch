/**
 * The vscode-free core of the extension's CLI seam — extracted so the G3
 * adapter-conformance fixture can execute the EXACT code path the panel uses
 * (arg quoting, the Windows npm-shim spawn strategy, result shaping) from a plain
 * node:test, without a VS Code host. Certification doctrine: labels are not
 * evidence — only running this real seam is (dec_ce86ca9cec).
 *
 * cli.ts wraps this with the vscode-only concerns (config lookup, PATH probing,
 * progress UI). Behavior here must stay byte-compatible with what the panel runs.
 */
import * as cp from "node:child_process";

export interface CliResult { ok: boolean; stdout: string; stderr: string; code: number | null; }

/** Quote one arg for cmd.exe. Bare when safe; else wrap in double quotes and escape
 *  embedded quotes (\"), matching the existing record-* command quoting. */
export function winQuote(a: string): string {
  return /[\s"&|<>^()%!,;]/.test(a) ? `"${a.replace(/"/g, '\\"')}"` : a;
}

/** Run `<command> <args...>` in `root`. Resolves (never rejects) so callers branch
 *  on `.ok`.
 *
 *  Windows: npm installs `hunch` as a `.cmd`/`.ps1` shim, NOT a native exe. Node ≥18.20
 *  refuses to spawn such a shim via execFile WITHOUT a shell (CVE-2024-27980 hardening) —
 *  it fails ENOENT with empty stdout. So on Windows we run through cmd.exe with each arg
 *  quoted ourselves (shell:true would concatenate them unescaped — DEP0190). Elsewhere
 *  the argv form is safe and shell-free. */
export function runHunchWith(command: string, root: string, args: string[], timeoutMs = 120_000): Promise<CliResult> {
  const opts = { cwd: root, timeout: timeoutMs, maxBuffer: 8 * 1024 * 1024 };
  const settle = (resolve: (r: CliResult) => void) => (err: cp.ExecException | cp.ExecFileException | null, stdout: string, stderr: string) => {
    const code = err && typeof (err as { code?: unknown }).code === "number" ? (err as { code: number }).code : err ? 1 : 0;
    resolve({ ok: !err, stdout: stdout ?? "", stderr: stderr ?? "", code });
  };
  return new Promise((resolve) => {
    if (process.platform === "win32") {
      cp.exec([command, ...args].map(winQuote).join(" "), opts, settle(resolve));
    } else {
      cp.execFile(command, args, opts, settle(resolve));
    }
  });
}
