/**
 * Fast, fail-safe Claude Code agent hooks. Every lifecycle hook used to run
 * `npx -y --package=… hunch hook`; npx alone costs seconds per call (3-4 s
 * measured on Windows), paid on every prompt, edit and tool call.
 *
 * The hook command is now a self-contained `node -e` bootstrap
 * (claudeHookLauncherCommand). It runs the committed launcher
 * `.claude/hunch-hook-launch.cjs` (next to settings.json, outside the .hunch/
 * memory store, whose auto-commit accepts only memory JSON) when CLAUDE_PROJECT_DIR is set and that file carries
 * the ownership marker; in every other case (variable unset, file missing,
 * unreadable, markerless, or throwing on load) it runs the pinned npx command
 * itself. So a clone that lacks the launcher is slow, never broken. The bootstrap
 * text avoids every character bash, POSIX sh, PowerShell 5.1 or cmd would expand
 * inside double quotes ($, backtick, !, %, backslash, double quote), so one string
 * behaves the same in all four.
 *
 * The launcher keeps the exact-version pin (a committed config must never run a
 * floating release): it looks for an installed @davesheffer/hunch whose
 * package.json version EQUALS the pin, reading files only: npx's own cache first,
 * then real (not symlinked, so not `npm link`ed) project and global node_modules
 * installs. The fast path therefore trusts any real install of that exact version;
 * a same-version local tarball install would run in-process (accepted). On a hit it runs that CLI entry in this process (stdin, args and exit code
 * are the CLI's own); on a miss, or a load error before the CLI read stdin, it
 * runs the same pinned npx fallback as the bootstrap.
 *
 * npx is run as `<node> <npm's npx-cli.js>` found next to process.execPath, with
 * no shell; only when that file is absent does it fall back to `npx` through the
 * shell, as one command string, with NoDefaultCurrentDirectoryInExePath set so
 * cmd.exe never picks up an npx from the working directory.
 */
import { existsSync, lstatSync, mkdirSync, readFileSync, rmSync } from "node:fs";
import { dirname, join } from "node:path";
import { writeFileAtomic } from "../core/io.js";
import { HUNCH_PACKAGE_NAME, HUNCH_VERSION } from "../core/version.js";

/** Repo-relative path of the launcher. */
export const HOOK_LAUNCHER_FILE = ".claude/hunch-hook-launch.cjs";
/** Where shape 1 kept it; a marker-owned file there is removed on re-init and uninstall. */
export const LEGACY_HOOK_LAUNCHER_FILE = ".hunch/hook-launch.cjs";

/** Ownership marker: present means Hunch may rewrite the file and the bootstrap may run it. */
export const HOOK_LAUNCHER_MARKER = "hunch:hook-launcher";

const npxSpec = (version: string) => `hunch-exact@npm:${HUNCH_PACKAGE_NAME}@${version}`;

/** The pinned-npx fallback, shared by the bootstrap and the launcher. Expects
 *  `e` (process.env), `P` (path), `F` (fs) and `a` (the hook args) in scope.
 *  HUNCH_HOOK_NPX_CLI names an npx-cli.js to use instead of npm's own. */
function npxFallbackJs(version: string): string {
  return "var N=P.dirname(process.execPath),c=e.HUNCH_HOOK_NPX_CLI||[P.join(N,'node_modules','npm','bin','npx-cli.js'),P.join(N,'..','lib','node_modules','npm','bin','npx-cli.js')].filter(F.existsSync)[0],"
    + `A=['-y','--package=${npxSpec(version)}','hunch'].concat(a),C=require('child_process'),`
    + "r=c?C.spawnSync(process.execPath,[c].concat(A),{stdio:'inherit',windowsHide:true}):C.spawnSync('npx '+A.join(' '),{stdio:'inherit',shell:true,windowsHide:true,env:Object.assign({},e,{NoDefaultCurrentDirectoryInExePath:'1'})});"
    + "process.exitCode=r.status==null?1:r.status;";
}

/** Shape 1 of the `node -e` program (launcher under .hunch/). Frozen: matched only. */
function hookBootstrapV1(version: string): string {
  return "(function(){var e=process.env,P=require('path'),F=require('fs'),a=process.argv.slice(1),d=e.CLAUDE_PROJECT_DIR,o=0;"
    + `try{var L=P.join(d,'.hunch','hook-launch.cjs');if(d&&F.readFileSync(L,'utf8').indexOf('${HOOK_LAUNCHER_MARKER}')>=0){process.argv=[process.argv[0],L].concat(a);o=1;require(L)}}catch(x){o=o?2:0}`
    + `if(o<1){${npxFallbackJs(version)}}else if(o>1){process.stderr.write('hunch hook launcher failed to load; using npx'+String.fromCharCode(10));${npxFallbackJs(version)}}})()`;
}

/** The `node -e` program the hook command runs (shape 2: the launcher in .claude/),
 *  wrapped in a function so it leaks no globals into the CLI it may load in-process. */
export function hookBootstrap(version: string = HUNCH_VERSION): string {
  return hookBootstrapV1(version).replace("P.join(d,'.hunch','hook-launch.cjs')", "P.join(d,'.claude','hunch-hook-launch.cjs')");
}

/** Every bootstrap shape a released Hunch has written, oldest first. The matcher owns
 *  exactly these texts (only the pinned version varies), so a later shape still lets
 *  `hunch init` replace an older one. Never edit a shipped shape: add a new function,
 *  append it here, and point claudeHookLauncherCommand at it. */
const BOOTSTRAP_SHAPES: ReadonlyArray<(version: string) => string> = [hookBootstrapV1, hookBootstrap];

/** The command `hunch init` writes into .claude/settings.json for every event. */
export function claudeHookLauncherCommand(version: string = HUNCH_VERSION): string {
  return `node -e "${hookBootstrap(version)}" hook`;
}
export const CLAUDE_HOOK_LAUNCHER_COMMAND = claudeHookLauncherCommand();

const VERSION_SLOT = "0.0.0-hunch-version-slot";
const escapeRe = (s: string) => s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
const LAUNCHER_COMMAND_RES = BOOTSTRAP_SHAPES.map((shape) => new RegExp(
  `^\\s*${escapeRe(`node -e "${shape(VERSION_SLOT)}" hook`).split(escapeRe(VERSION_SLOT)).join("[0-9A-Za-z.+-]+")}\\s*$`,
));
/** Is this exactly a bootstrap command some `hunch init` wrote (any shape in
 *  BOOTSTRAP_SHAPES, any pinned version), as a whole command? Nothing chained,
 *  prefixed, appended or edited matches (con_8460b6770f). */
export function isLauncherHookCommand(command: string): boolean {
  return LAUNCHER_COMMAND_RES.some((re) => re.test(command));
}
/** Is this a bootstrap of an older shape (not the one `hunch init` writes now)? */
export function isLegacyLauncherHookCommand(command: string): boolean {
  return LAUNCHER_COMMAND_RES.slice(0, -1).some((re) => re.test(command));
}

/** The launcher source for one pinned version. */
export function renderHookLauncher(version: string = HUNCH_VERSION): string {
  return `#!/usr/bin/env node
// ${HOOK_LAUNCHER_MARKER} ${version} (generated by \`hunch init\`; commit this file; delete this line to take ownership)
// Runs the installed Hunch CLI whose version is exactly the pin; otherwise the pinned npx command.
"use strict";
const PIN = ${JSON.stringify(version)};
const NAME = ${JSON.stringify(HUNCH_PACKAGE_NAME)};
const e = process.env;
const P = require("path");
const F = require("fs");
const os = require("os");
const a = process.argv.slice(2);
const win = process.platform === "win32";
// Loaded by the node -e bootstrap, execArgv holds ["-e", <bootstrap>]; a CLI that re-spawns
// itself with [...process.execArgv, entry, ...] would run the bootstrap instead. Drop eval flags.
{
  const keep = [];
  for (let i = 0; i < process.execArgv.length; i++) {
    const v = process.execArgv[i];
    if (v === "-e" || v === "--eval" || v === "-p" || v === "--print" || v === "-pe") { i++; continue; }
    if (/^--(?:eval|print)=/.test(v)) continue;
    keep.push(v);
  }
  process.execArgv = keep;
}

// A real installed copy only: a symlinked or npm-linked package dir may hold unpublished code.
function entryIn(dir) {
  try {
    if (F.lstatSync(dir).isSymbolicLink()) return null;
    if (!F.realpathSync(dir).split(/[\\\\/]+/).includes("node_modules")) return null;
    const pkg = JSON.parse(F.readFileSync(P.join(dir, "package.json"), "utf8"));
    if (!pkg || pkg.name !== NAME || pkg.version !== PIN) return null;
    const bin = pkg.bin && typeof pkg.bin === "object" ? pkg.bin.hunch : pkg.bin;
    const entry = P.resolve(dir, typeof bin === "string" ? bin : "dist/cli/index.js");
    return F.statSync(entry).isFile() ? entry : null;
  } catch { return null; }
}

// npx's own cache first: it only ever holds published tarballs.
function candidates() {
  const dirs = [];
  const cache = e.npm_config_cache || (win
    ? P.join(e.LOCALAPPDATA || P.join(os.homedir(), "AppData", "Local"), "npm-cache")
    : P.join(os.homedir(), ".npm"));
  try {
    for (const h of F.readdirSync(P.join(cache, "_npx"))) {
      const nm = P.join(cache, "_npx", h, "node_modules");
      dirs.push(P.join(nm, "hunch-exact"), P.join(nm, "@davesheffer", "hunch"));
    }
  } catch { /* no npx cache */ }
  const roots = [P.join(__dirname, "..", "node_modules")];
  const globalModules = (prefix) => win ? P.join(prefix, "node_modules") : P.join(prefix, "lib", "node_modules");
  if (e.npm_config_prefix) roots.push(globalModules(e.npm_config_prefix));
  roots.push(globalModules(win ? P.dirname(process.execPath) : P.join(P.dirname(process.execPath), "..")));
  if (win && e.APPDATA) roots.push(P.join(e.APPDATA, "npm", "node_modules"));
  return dirs.concat(roots.map((r) => P.join(r, "@davesheffer", "hunch")));
}

function viaNpx() {
  try { ${npxFallbackJs(version)} } catch (x) {
    process.stderr.write("hunch hook launcher: could not run npx: " + (x && x.message ? x.message : String(x)) + "\\n");
    process.exitCode = 1;
  }
}

let entry = null;
try { for (const dir of candidates()) { entry = entryIn(dir); if (entry) break; } } catch { entry = null; }
if (!entry) viaNpx();
else {
  process.argv = [process.argv[0], entry].concat(a);
  import(require("url").pathToFileURL(entry).href).catch((x) => {
    // Once the CLI has read stdin a second run would see none: report instead.
    if (process.stdin.readableDidRead) {
      process.stderr.write("hunch hook launcher: " + (x && x.message ? x.message : String(x)) + "\\n");
      process.exitCode = 1;
      return;
    }
    viaNpx();
  });
}
`;
}

/** The pinned version a launcher file carries, or null when it is not ours. */
export function launcherPinOf(text: string): string | null {
  if (!text.includes(HOOK_LAUNCHER_MARKER)) return null;
  return /^const PIN = "([^"]+)";$/m.exec(text)?.[1] ?? null;
}

export interface HookLauncherInstall {
  path: string;
  action: "created" | "updated" | "unchanged" | "kept";
  /** Why an existing path was kept without being read as ours (e.g. it is a directory). */
  reason?: string;
}

/** Write (or refresh) the launcher for `version`. A file without the ownership
 *  marker, or a symlink, is the user's and is kept as is (con_8460b6770f). */
export function writeHookLauncher(root: string, version: string = HUNCH_VERSION): HookLauncherInstall {
  const file = join(root, HOOK_LAUNCHER_FILE);
  const next = renderHookLauncher(version);
  if (existsSync(file)) {
    if (lstatSync(file).isSymbolicLink()) return { path: file, action: "kept" };
    let before: string;
    try { before = readFileSync(file, "utf8"); } catch (e) {
      return { path: file, action: "kept", reason: (e as Error).message };
    }
    if (!before.includes(HOOK_LAUNCHER_MARKER)) return { path: file, action: "kept" };
    // A CRLF checkout (core.autocrlf) of the same text is unchanged.
    if (before.replace(/\r\n/g, "\n") === next) return { path: file, action: "unchanged" };
    writeFileAtomic(file, next);
    return { path: file, action: "updated" };
  }
  mkdirSync(dirname(file), { recursive: true });
  writeFileAtomic(file, next);
  return { path: file, action: "created" };
}

/** Whether a launcher's text is exactly the template for its own pin (line endings aside). */
export function launcherIsCurrent(text: string): boolean {
  const pin = launcherPinOf(text);
  return pin !== null && text.replace(/\r\n/g, "\n") === renderHookLauncher(pin);
}

/** The Claude Code hook command `hunch init` writes. A published install gets the
 *  bootstrap and a (re)written launcher; source/dev runs keep their per-machine command. */
export function claudeAgentHookCommand(root: string, inv: { installed: boolean; agentHookShell: string }, say: (line: string) => void): string {
  if (!inv.installed) return `${inv.agentHookShell} hook`;
  const l = writeHookLauncher(root);
  if (removeLegacyHookLauncher(root)) say(`  ✓ removed the old ${LEGACY_HOOK_LAUNCHER_FILE} (the launcher now lives in ${HOOK_LAUNCHER_FILE})`);
  if (l.action === "kept" && l.reason) say(`  ⚠ kept ${HOOK_LAUNCHER_FILE} as is: it could not be read (${l.reason}), so hooks run the slower pinned npx fallback; fix or remove it and re-run init to restore the fast path`);
  else if (l.action === "kept") say(`  ⚠ kept your existing ${HOOK_LAUNCHER_FILE} (no ${HOOK_LAUNCHER_MARKER} marker), so hooks run the slower pinned npx fallback; delete it and re-run init to restore the fast path`);
  else if (l.action !== "unchanged") say(`  ✓ ${l.action} ${HOOK_LAUNCHER_FILE}: commit it, or hooks in other clones and worktrees fall back to the slower npx path`);
  return CLAUDE_HOOK_LAUNCHER_COMMAND;
}

/** Delete a marker-owned regular launcher at the shape-1 location; true when one was removed. */
export function removeLegacyHookLauncher(root: string): boolean {
  const file = join(root, LEGACY_HOOK_LAUNCHER_FILE);
  try {
    if (!existsSync(file) || lstatSync(file).isSymbolicLink() || lstatSync(dirname(file)).isSymbolicLink()) return false;
    if (!readFileSync(file, "utf8").includes(HOOK_LAUNCHER_MARKER)) return false;
    rmSync(file, { force: true });
    return true;
  } catch { return false; }
}
