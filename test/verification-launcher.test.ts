import { test } from "node:test";
import assert from "node:assert/strict";
import { verificationLauncherFor } from "../src/mcp/taskReportTools.js";
import { verificationLauncher, verificationLauncherFor as fromCore } from "../src/core/verifyLauncher.js";

test("the verification launcher never resolves tsx on the published path, where it is not installed (#261)", () => {
  const missing = (specifier: string): string => { throw Object.assign(new Error(`Cannot find package '${specifier}'`), { code: "ERR_MODULE_NOT_FOUND" }); };
  // A published install: dist/mcp/taskReportTools.js, no devDependencies.
  const dist = verificationLauncherFor(new URL("../dist/mcp/taskReportTools.js", import.meta.url).href, missing);
  assert.equal(dist.argv[0], process.execPath);
  assert.ok(!dist.argv.includes("--import"), "a dist launch passes no loader");
  assert.match(dist.argv.at(-1)!, /dist[\\/]cli[\\/]index\.js$/);
  assert.equal(dist.argv.length, 2);
  // A source checkout: the loader is resolved and passed as a file URL.
  const src = verificationLauncherFor(new URL("../src/mcp/taskReportTools.ts", import.meta.url).href, () => "file:///tools/tsx/dist/loader.mjs");
  assert.deepEqual(src.argv.slice(1, 3), ["--import", "file:///tools/tsx/dist/loader.mjs"]);
  assert.match(src.argv.at(-1)!, /src[\\/]cli[\\/]index\.ts$/);
  // A source checkout whose resolver returns a path still gets a URL.
  const fromPath = verificationLauncherFor(new URL("../src/mcp/taskReportTools.ts", import.meta.url).href, () => process.platform === "win32" ? "C:\\tools\\tsx\\loader.mjs" : "/tools/tsx/loader.mjs");
  assert.match(fromPath.argv[2]!, /^file:\/\/\//);
});

test("the launcher lives in core (no MCP SDK on the hook path) and the mcp re-export resolves the same entry", () => {
  // src/core and src/mcp are siblings, so `../cli/index.ts` is the same file from
  // either — but each caller must pass its OWN import.meta, which is what the
  // core wrapper does. The prompt hook prints this command inline.
  const resolve = (s: string) => import.meta.resolve(s);
  const core = fromCore(new URL("../src/core/verifyLauncher.ts", import.meta.url).href, resolve);
  const mcp = verificationLauncherFor(new URL("../src/mcp/taskReportTools.ts", import.meta.url).href, resolve);
  assert.deepEqual(core.argv, mcp.argv, "core and the mcp re-export launch the identical CLI entry");
  assert.deepEqual(verificationLauncher().argv, core.argv, "the no-argument core wrapper passes its own import.meta");
  assert.match(core.argv.at(-1)!, /src[\\/]cli[\\/]index\.ts$/);
});

test("the inline shell hint is quoted for the running platform and always maps onto argv", () => {
  // The prompt hook prints `launcher.shell`, so its quoting must be usable as
  // typed. Both branches exist in one function keyed on process.platform; assert
  // the branch for this platform plus the argv form that holds on either.
  const launcher = verificationLauncher();
  assert.deepEqual(launcher.argv.slice(0, 1), [process.execPath]);
  // Every argv element appears in the hint, in order, and each is quoted.
  for (const part of launcher.argv) assert.ok(launcher.shell.includes(part), `${part} missing from the shell hint`);
  if (process.platform === "win32") {
    assert.ok(launcher.shell.startsWith("& '"), "PowerShell needs the call operator before a quoted path");
  } else {
    assert.ok(launcher.shell.startsWith("'"), "POSIX quoting starts at the first argument");
    assert.doesNotMatch(launcher.shell, /^&/);
  }
  // Independently recompute the expected hint from argv rather than counting
  // quotes, which a path containing an apostrophe would break.
  const posixQuoted = launcher.argv.map(a => `'${a.replace(/'/g, "'\\''")}'`).join(" ");
  const winQuoted = `& ${launcher.argv.map(a => `'${a.replace(/'/g, "''")}'`).join(" ")}`;
  assert.equal(launcher.shell, process.platform === "win32" ? winQuoted : posixQuoted, "the hint is exactly argv under this platform's quoting");
});

test("the Windows hint is PowerShell-quoted and says how to use it in a POSIX shell, and the POSIX hint needs no note", () => {
  const resolve = () => "file:///tools/tsx/loader.mjs";
  const meta = new URL("../src/core/verifyLauncher.ts", import.meta.url).href;
  const win = fromCore(meta, resolve, "win32");
  assert.ok(win.shell.startsWith("& '"), "PowerShell needs the call operator before a quoted path");
  // PowerShell escapes a single quote by doubling it, never with a backslash.
  assert.equal(win.shell, `& ${win.argv.map(a => `'${a.replace(/'/g, "''")}'`).join(" ")}`);
  assert.doesNotMatch(win.shell, /'\\''/);
  assert.ok(win.note.length > 0, "the win32 hint must disambiguate PowerShell from Git Bash");
  assert.match(win.note, /Git Bash/);
  assert.ok(win.note.includes('drop the leading "& "'), "the note says exactly what to remove");
  const posix = fromCore(meta, resolve, "linux");
  assert.ok(posix.shell.startsWith("'"), "POSIX quoting starts at the first argument");
  assert.doesNotMatch(posix.shell, /^&/);
  assert.equal(posix.shell, posix.argv.map(a => `'${a.replace(/'/g, "'\\''")}'`).join(" "));
  assert.equal(posix.note, "", "no note where only one shell form applies");
  assert.deepEqual(win.argv, posix.argv, "only the hint varies by platform; argv is the same");
});
