/**
 * Git post-commit hook installer (DESIGN.md §4 / §6). The hook fires the
 * learning loop after every commit. Loop-guarded via the HUNCH_SYNC env var, and
 * backgrounded so it never slows a commit down. Existing hooks are preserved —
 * we append a guarded block rather than clobbering.
 *
 * Hook managers (issue #311): an appended block is only worth writing when git
 * will actually reach it and the file is this machine's own. The pre-commit
 * framework's generated hook ends in `exec`, husky v9 routes every hook through
 * `.husky/_/h` (which ends in `exit $c` and is regenerated on `npm install`), and
 * husky ≤8 / any committed `core.hooksPath` would put this machine's absolute
 * CLI path into tracked files. In those cases nothing is written: the installer
 * returns a portable snippet for the manager's own configuration instead, and
 * `hookReport` tells a present-but-dead block apart from a working one.
 */
import { readFileSync, writeFileSync, existsSync, chmodSync, mkdirSync, realpathSync } from "node:fs";
import { spawnSync } from "node:child_process";
import { join, isAbsolute, dirname, basename, relative, resolve } from "node:path";
import { homedir } from "node:os";
import { hooksDir, gitCommonDir, isLinkedWorktree } from "../extractors/git.js";
import { initiatorChildEnv } from "../synthesis/initiator.js";
import { HUNCH_NPX_PACKAGE_SPEC } from "../core/version.js";

const MARK = "# >>> hunch post-commit >>>";
const ENDMARK = "# <<< hunch post-commit <<<";

/** Per-runner shell details a block may depend on. git passes post-checkout's
 *  checkout type as `$3`; the pre-commit framework runs hooks without git's
 *  positional arguments and exposes the same value as an environment variable. */
interface BlockContext { checkoutType: string }
const GIT_CONTEXT: BlockContext = { checkoutType: "$3" };
const PRE_COMMIT_CONTEXT: BlockContext = { checkoutType: "$PRE_COMMIT_CHECKOUT_TYPE" };

type BlockBuilder = (invocation: string, ctx: BlockContext) => string;

function block(invocation: string, opts: { private?: boolean; commit?: boolean; localOnly?: boolean } = {}): string {
  // --private routes the auto-synthesized decision into the HUNCH_PRIVATE_DIR overlay
  // instead of the public repo. --commit (opt-in) also commits & pushes the repo the
  // decision landed in (the private store under --private, else this repo). The hook
  // script is local (.git/hooks/), never committed.
  const priv = opts.private ? " --private" : "";
  const commit = opts.commit ? " --commit" : "";
  return [
    MARK,
    'if [ -z "$HUNCH_SYNC" ]; then',
    "  export HUNCH_SYNC=1",
    // A split-private capture must not make a storage-private promise and then
    // ship the commit diff to a subscription CLI. Shared overlays are a separate
    // team policy, so only the explicit local-only mode forces deterministic.
    ...(opts.localOnly ? ["  export HUNCH_SYNTH_PROVIDER=deterministic"] : []),
    `  ( ${invocation} sync --from-hook --quiet${priv}${commit} >/dev/null 2>&1 || true ) &`,
    // Deliberately NO workspace-ledger snapshot here (docs/workspace-ledger.md): a commit
    // changes HEAD, not which branches and worktrees exist — post-checkout covers that, and
    // a ledger read publishes a fresh observation when someone actually asks. Snapshotting
    // per commit would add git work (up to a patch-id walk) to the most frequent operation
    // there is, and its backgrounded child outliving `git commit` is what held a Windows
    // clone directory open and broke team-matrix-e2e's teardown with EBUSY.
    "fi",
    ENDMARK,
  ].join("\n");
}

/** Which hook manager (if any) owns the hook file git would run.
 *  - `none`: a plain local hooks dir Hunch may write into.
 *  - `pre-commit`: the pre-commit framework's generated hook (ends in `exec`).
 *  - `husky`: husky v9 (`core.hooksPath=.husky/_`, stubs source `h`, which exits).
 *  - `husky-legacy`: husky ≤8 (`core.hooksPath=.husky`, a tracked directory).
 *  - `tracked-hooks-path`: any other `core.hooksPath` inside the work tree that git tracks.
 *  - `exec-exit`: no known manager, but the existing hook ends in exec/exit before our block. */
export type HookManagerKind = "none" | "pre-commit" | "husky" | "husky-legacy" | "tracked-hooks-path" | "exec-exit";

export interface HookInstall {
  /** The hook file written; for a non-writing result, the file the user should edit. */
  path: string;
  /** created/appended/updated/unchanged: the block is (now) in a file git reaches.
   *  kept-shared: the shared hook already runs a Hunch that is not inside a
   *  linked worktree, so it was deliberately left as it is rather than
   *  re-pointed at one (issue #316); a success, not a failure.
   *  managed-elsewhere: a hook manager owns the hook — nothing was written.
   *  unreachable: the existing hook ends in exec/exit before our block — nothing was written. */
  action: "created" | "appended" | "updated" | "unchanged" | "kept-shared" | "managed-elsewhere" | "unreachable";
  manager?: HookManagerKind;
  /** Why nothing was written (non-writing actions only). */
  reason?: string;
  /** What to add to `path` by hand (non-writing actions only). */
  snippet?: string;
  /** The file already carries a Hunch block, but a dead one: the snippet
   *  REPLACES it rather than being added (non-writing actions only). */
  stale?: boolean;
  /** The block in the file deliberately runs the repo's EXISTING shared
   *  invocation instead of the caller's worktree-bound one (issue #316). Set on
   *  kept-shared, and on created/appended/updated when that substitution happened. */
  sharedInvocation?: string;
  /** kept-shared only: the existing block's own option flags (BLOCK_FLAGS) that
   *  the requested rebuild would have dropped — e.g. a strict pre-commit guard
   *  that a worktree's advisory re-run must not silently downgrade. */
  keptFlags?: string[];
  /** Set when a DEAD block was rebuilt from the repo's shared launcher and the
   *  previous block's own option flags were not requested again. Reported, not
   *  restored: the flags come from the caller's options, so re-adding one would
   *  invent a request nobody made — but losing a strict guard in silence is
   *  exactly the issue-#316 failure mode. */
  droppedFlags?: string[];
}

function escapeRe(s: string): string {
  return s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

/** Portable invocation for text that lands in a TRACKED file (a husky script, a
 *  committed hooks dir, .pre-commit-config.yaml): the same exact-version npx
 *  package reference the committed MCP/provider configs use — never this
 *  machine's absolute node/CLI path. */
export const PORTABLE_HOOK_INVOCATION = `npx -y --package=${HUNCH_NPX_PACKAGE_SPEC} hunch`;

const EXIT_LINE = /^(?:exec|exit)(?:\s|;|$)/;
const INDENTED_EXIT_LINE = /^\s*(?:exec|exit)(?:\s|;|$)/;
const BLOCK_OPEN = /^(?:if|case|for|while|until|select)\b|\{\s*$/;
const BLOCK_CLOSE = /^(?:fi|esac|done)\b|^\}|[;\s](?:fi|esac|done|\})\s*;?\s*$/;

/** The line that ends the script unconditionally before anything appended after
 *  it could run, or null. Deliberately conservative (a heuristic, not a shell
 *  parser): an `exec`/`exit` statement outside any if/case/loop/function block,
 *  or a trailing top-level `if … else … fi` whose every branch ends in
 *  `exec`/`exit` — the shape of the pre-commit framework's generated hook. */
export function terminalExitLine(content: string): string | null {
  const lines = content.replace(/\r/g, "").split("\n");
  let depth = 0;
  for (const raw of lines) {
    const line = raw.trim();
    if (line === "" || line.startsWith("#")) continue;
    if (depth === 0 && EXIT_LINE.test(line)) return line;
    depth = Math.max(0, depth + (BLOCK_OPEN.test(line) ? 1 : 0) - (BLOCK_CLOSE.test(line) ? 1 : 0));
  }
  const meaningful = lines.filter((l) => l.trim() !== "" && !/^\s*#/.test(l));
  const last = meaningful.at(-1);
  if (last === undefined || !/^fi\s*(?:;|$)/.test(last)) return null;
  const start = meaningful.slice(0, -1).findLastIndex((l) => /^if\s/.test(l));
  if (start < 0) return null;
  const branches: string[][] = [];
  let current: string[] = [];
  let hasElse = false;
  for (const line of meaningful.slice(start + 1, -1)) {
    if (/^elif\s/.test(line) || /^else\s*(?:;|$)/.test(line)) {
      if (/^else/.test(line)) hasElse = true;
      branches.push(current);
      current = [];
      continue;
    }
    current.push(line);
  }
  branches.push(current);
  if (!hasElse) return null;
  const allExit = branches.every((b) => {
    const tail = b.filter((l) => !/^\s*then\s*$/.test(l)).at(-1);
    return tail !== undefined && INDENTED_EXIT_LINE.test(tail);
  });
  return allExit ? last.trim() : null;
}

function readText(path: string): string | null {
  try { return readFileSync(path, "utf8"); } catch { return null; }
}

/** Whether `mark` is present in `file`, and if so whether git would reach it. */
function markerState(file: string, mark: string): "reachable" | "unreachable" | "absent" {
  const text = readText(file);
  if (text === null) return "absent";
  const at = text.indexOf(mark);
  if (at < 0) return "absent";
  return terminalExitLine(text.slice(0, at)) ? "unreachable" : "reachable";
}

function realish(p: string): string {
  try { return realpathSync.native(p); } catch { return resolve(p); }
}

function isInside(parent: string, child: string): boolean {
  const norm = (p: string) => (process.platform === "win32" ? realish(p).toLowerCase() : realish(p));
  const rel = relative(norm(parent), norm(child));
  return rel === "" || (!rel.startsWith("..") && !isAbsolute(rel));
}

function gitRun(args: string[], cwd: string): { status: number | null; stdout: string } {
  const p = spawnSync("git", args, { cwd, encoding: "utf8", env: initiatorChildEnv(), stdio: ["ignore", "pipe", "ignore"] });
  return { status: p.status, stdout: (p.stdout ?? "").trim() };
}

function isPreCommitFrameworkHook(text: string): boolean {
  return /File generated by pre-commit/i.test(text) || /-m\s*pre_commit\b/.test(text) || /^\s*exec\s+pre-commit\b/m.test(text);
}

interface HookTarget {
  hookName: string;
  /** The file git runs for this hook. */
  hookPath: string;
  manager: HookManagerKind;
  reason?: string;
  /** The file the user edits instead (manager script/config, or the hook itself). */
  ownerFile: string;
}

/** Work out who owns `hookName` in `root` and whether an appended block would run.
 *  `mark` is our block's marker: when an existing block sits BEFORE a trailing
 *  exec/exit it is reachable, so only the text above it is inspected. Read-only. */
function resolveHookTarget(root: string, hookName: string, mark: string): HookTarget {
  const dir = hooksDir(root);
  // `git rev-parse --git-path hooks` returns a path relative to the repo in a
  // normal checkout, but an ABSOLUTE one inside a linked worktree (the shared
  // hooks dir). isAbsolute() handles both POSIX (/…) and Windows (C:\… / C:/…);
  // a bare startsWith("/") misfired on Windows worktrees → a doubled junk path.
  const abs = isAbsolute(dir) ? dir : join(root, dir);
  const hookPath = join(abs, hookName);
  const slashed = abs.replace(/\\/g, "/").replace(/\/+$/, "");

  const huskyH = readText(join(abs, "h"));
  if (slashed.endsWith(".husky/_") || (huskyH !== null && /husky/.test(huskyH))) {
    return {
      hookName, hookPath, manager: "husky", ownerFile: join(dirname(abs), hookName),
      reason: "husky v9 runs every hook through .husky/_/h, which exits before any appended line (and regenerates .husky/_ on install)",
    };
  }

  const common = gitCommonDir(root);
  const insideGitDir = common !== "" && isInside(common, abs);
  if (!insideGitDir) {
    const top = gitRun(["rev-parse", "--show-toplevel"], root).stdout;
    if (top && isInside(top, abs)) {
      const rel = relative(realish(top), realish(abs)).replace(/\\/g, "/") || ".";
      const tracked = gitRun(["ls-files", "--", rel], top).stdout !== "";
      // Not yet committed but not ignored either: the next `git add -A` would commit it.
      const committable = tracked || gitRun(["check-ignore", "-q", "--", `${rel}/${hookName}`], top).status === 1;
      if (committable) {
        const legacy = basename(abs) === ".husky";
        return {
          hookName, hookPath, ownerFile: hookPath,
          manager: legacy ? "husky-legacy" : "tracked-hooks-path",
          reason: `${rel}/ is ${tracked ? "tracked by git" : "inside the work tree and not ignored"}${legacy ? " (husky ≤8)" : ""} — Hunch will not write this machine's CLI path into a committed hook`,
        };
      }
    }
  }

  const text = readText(hookPath);
  if (text !== null && isPreCommitFrameworkHook(text)) {
    const config = /--config=(\S+?)["')\s]/.exec(text)?.[1] ?? ".pre-commit-config.yaml";
    const top = gitRun(["rev-parse", "--show-toplevel"], root).stdout || root;
    return {
      hookName, hookPath, manager: "pre-commit", ownerFile: isAbsolute(config) ? config : join(top, config),
      reason: `the pre-commit framework generated ${hookName}; it ends in exec, so an appended block never runs (and \`pre-commit install\` rewrites the file)`,
    };
  }
  if (text !== null) {
    const at = text.indexOf(mark);
    const terminal = terminalExitLine(at >= 0 ? text.slice(0, at) : text);
    if (terminal) {
      return {
        hookName, hookPath, manager: "exec-exit", ownerFile: hookPath,
        reason: `${hookName} ends in \`${terminal}\`, so a block after it never runs`,
      };
    }
  }
  return { hookName, hookPath, manager: "none", ownerFile: hookPath };
}

/** Stable pre-commit framework hook id per managed block (detection + snippet). */
function preCommitId(mark: string): string {
  return ({
    [MARK]: "hunch-post-commit",
    [PRE_MARK]: "hunch-pre-commit",
    [GROUNDING_MERGE_MARK]: "hunch-post-merge-grounding",
    [REPAIR_MERGE_MARK]: "hunch-post-merge-repair-provenance",
    [CHECKOUT_MARK]: "hunch-post-checkout",
  } as Record<string, string>)[mark] ?? "hunch";
}

type BlockState = "installed" | "unreachable" | "stale" | "missing";

/** The result of inspecting the command a managed block actually runs (issue #315). */
export type HookInvocationHealth =
  | { ok: true; invocation: string }
  | { ok: false; invocation: string; reason: string };

const ENV_ASSIGN = /^[A-Za-z_][A-Za-z0-9_]*=\S*$/;
const UNQUOTED_META = /[;|&$`<>()]/;
const LAUNCHER_EXT = /\.(?:exe|cmd|bat|ps1)$/;
const HUNCH_ENTRY = /\/cli\/index\.(?:js|ts)$/;

/** Split an invocation into simple shell words. Hunch writes its own paths with
 *  JSON.stringify, so a double-quoted token decodes with JSON.parse. Anything a
 *  shell would treat as more than a plain command (metacharacters, expansions,
 *  an unterminated quote) yields null — we refuse to guess. */
function shellWords(s: string): string[] | null {
  const out: string[] = [];
  let i = 0;
  while (i < s.length) {
    const c = s[i]!;
    if (/\s/.test(c)) { i++; continue; }
    if (c === '"' || c === "'") {
      const end = s.indexOf(c, i + 1);
      if (end < 0) return null;
      const raw = s.slice(i, end + 1);
      if (c === '"') {
        if (/[$`]/.test(raw)) return null;
        try { out.push(JSON.parse(raw) as string); } catch { return null; }
      } else out.push(raw.slice(1, -1));
      i = end + 1;
      continue;
    }
    let j = i;
    while (j < s.length && !/\s/.test(s[j]!)) j++;
    const word = s.slice(i, j);
    if (UNQUOTED_META.test(word)) return null;
    out.push(word);
    i = j;
  }
  return out;
}

/** The launcher's own name: last path segment, lower-cased, without a Windows
 *  executable extension — so `/usr/local/bin/hunch`, `hunch.cmd` and `hunch` all match. */
function base(tok: string): string {
  return (tok.split(/[\\/]/).at(-1) ?? "").toLowerCase().replace(LAUNCHER_EXT, "");
}

function isAbs(tok: string): boolean {
  return isAbsolute(tok) || /^[A-Za-z]:[\\/]/.test(tok);
}

function isPathish(tok: string): boolean {
  return tok.includes("/") || tok.includes("\\") || isAbs(tok);
}

function pathExists(tok: string, root: string): boolean {
  // A hand-written hook may spell this machine's install as `~/…`; the shell
  // expands it, so we must too before asking the filesystem.
  const path = tok === "~" ? homedir() : tok.startsWith("~/") ? join(homedir(), tok.slice(2)) : tok;
  return existsSync(isAbs(path) ? path : resolve(root, path));
}

const NOT_OURS = "not a command Hunch writes";

/** Whether the command in front of a managed block's subcommand is a Hunch
 *  launcher that could actually run (issue #315): a block whose command was
 *  hand-edited into something else, or whose absolute node/CLI path no longer
 *  exists after a reinstall, is present but dead. `command` is the text BEFORE
 *  the subcommand; env assignments and a leading `(` belong to the block's own
 *  shape and are stripped. Never spawns anything, never touches the network. */
export function hookInvocationHealth(command: string, root: string): HookInvocationHealth {
  let rest = command.trim().replace(/^\(\s*/, "");
  for (;;) {
    const m = /^(\S+)\s+/.exec(rest);
    if (!m || !ENV_ASSIGN.test(m[1]!)) break;
    rest = rest.slice(m[0].length);
  }
  const invocation = rest.trim();
  const bad = (reason: string): HookInvocationHealth => ({ ok: false, invocation, reason });
  const toks = shellWords(invocation);
  if (toks === null || toks.length === 0) return bad(NOT_OURS);

  const [head, ...rest2] = toks as [string, ...string[]];
  const missing = (tok: string) => `${tok} does not exist`;
  // `<runtime> <script…>`: every non-flag token after the runtime is a script
  // path (`<node> <cli>`, or tsx's `<node> <tsx> <cli>`) — a runtime flag like
  // `--no-warnings` is not a path, but a runtime with no script at all is not ours.
  const runtime = (): HookInvocationHealth => {
    if (isPathish(head) && !pathExists(head, root)) return bad(missing(head));
    const scripts = rest2.filter((t) => !t.startsWith("-"));
    if (scripts.length === 0) return bad(NOT_OURS);
    const gone = scripts.find((t) => !pathExists(t, root));
    return gone === undefined ? { ok: true, invocation } : bad(missing(gone));
  };
  switch (base(head)) {
    case "hunch":
      if (rest2.length > 0) return bad(NOT_OURS);
      if (isPathish(head) && !pathExists(head, root)) return bad(missing(head));
      return { ok: true, invocation };
    case "node":
      return rest2.length === 0 ? bad(NOT_OURS) : runtime();
    case "npx":
    case "pnpm":
    case "yarn":
    case "bunx":
    case "npm":
    case "env": {
      // A package runner in front of the launcher: `npx -y --package=…@x.y.z hunch`
      // (PORTABLE_HOOK_INVOCATION), `npx hunch`, and the shapes users adapt the
      // snippet into by hand (`pnpm exec hunch`, `yarn run hunch`, `npm exec --
      // hunch`, `env X=1 hunch`). What the runner would resolve is never verified —
      // doing so would mean a network install — so only the launcher it ends in is read.
      const args = rest2.filter((t) => !t.startsWith("-"));
      const last = args.at(-1);
      if (last !== undefined && (base(last) === "hunch" || /^@davesheffer\/hunch(?:@\S+)?$/.test(last))) return { ok: true, invocation };
      const tsx = args.indexOf("tsx");
      if (tsx >= 0 && args.length === tsx + 2) {
        return pathExists(args[tsx + 1]!, root) ? { ok: true, invocation } : bad(missing(args[tsx + 1]!));
      }
      return bad(NOT_OURS);
    }
    default:
      // `resolveInvocation` writes process.execPath, which is not always named
      // `node` (Debian's `nodejs`, a version-suffixed binary). Any other runtime
      // is ours only as an absolute path running Hunch's own CLI entry — else
      // `hunch init` would rewrite the same block and doctor would call it stale forever.
      return isAbs(head) && rest2.length > 0 && HUNCH_ENTRY.test(rest2.at(-1)!.replace(/\\/g, "/")) ? runtime() : bad(NOT_OURS);
  }
}

/** The command each managed block runs, keyed by mark. Resolved inside a
 *  function (like `preCommitId`) because the marks are declared further down. */
function blockSubcommand(mark: string): { re: RegExp; words: string } {
  return ({
    [MARK]: { re: /(?:^|\s)sync\s+--from-hook\b/, words: "sync --from-hook" },
    [PRE_MARK]: { re: /(?:^|\s)check\s+--staged\b/, words: "check --staged" },
    [GROUNDING_MERGE_MARK]: { re: /(?:^|\s)grounding\s+--refresh\b/, words: "grounding --refresh" },
    [REPAIR_MERGE_MARK]: { re: /(?:^|\s)repair-provenance\b/, words: "repair-provenance" },
    [CHECKOUT_MARK]: { re: /(?:^|\s)workspaces\s+snapshot\b/, words: "workspaces snapshot" },
  } as Record<string, { re: RegExp; words: string }>)[mark] ?? { re: /(?:^|\s)hunch\b/, words: "hunch" };
}

/** Hunch's OWN option flags a block's command line may carry after the
 *  subcommand — the ones `hunch init` decides from its options, so a regenerated
 *  block silently drops any the re-run does not ask for again. Fixed set, in a
 *  stable order; anything else on the line is not ours to report. */
const BLOCK_FLAGS = ["--private", "--commit", "--strict"] as const;

function blockFlags(line: string): string[] {
  return BLOCK_FLAGS.filter((f) => new RegExp(`(?:^|\\s)${escapeRe(f)}(?=\\s|$)`).test(line));
}

/** The flags a freshly BUILT block carries, read the way `inspectBlock` reads an
 *  installed one: per command line, only from the text after the subcommand. A
 *  whole-block scan would count a flag that is merely part of the launcher path
 *  (a Hunch installed under `…/opt --strict x/…`), and so miss a real downgrade. */
function builtFlags(blk: string, mark: string): string[] {
  const { re } = blockSubcommand(mark);
  const found = new Set<string>();
  for (const line of blk.replace(/\r/g, "").split("\n")) {
    if (line.trim().startsWith("#")) continue;
    const m = re.exec(line);
    if (m) for (const f of blockFlags(line.slice(m.index))) found.add(f);
  }
  return BLOCK_FLAGS.filter((f) => found.has(f));
}

/** A block's health plus Hunch's own option flags the reported line carried
 *  after the subcommand (an intersection: the health stays a discriminated union). */
type BlockInspection = HookInvocationHealth & { flags: string[] };

/** Inspect the command inside `mark`'s block in `file`: the block body is the
 *  lines between the mark and the closing marker. A block may legitimately carry
 *  several command lines (or a hand-added one); any working line makes it live. */
function inspectBlock(file: string, mark: string, root: string): BlockInspection {
  const { re, words } = blockSubcommand(mark);
  const text = readText(file) ?? "";
  const at = text.indexOf(mark);
  const body = at < 0 ? [] : text.slice(at).replace(/\r/g, "").split("\n").slice(1);
  let first: BlockInspection | null = null;
  for (const line of body) {
    if (/^# <<< hunch /.test(line)) break;
    if (line.trim().startsWith("#")) continue;
    const m = re.exec(line);
    if (!m) continue;
    // Flags belong to the SUBCOMMAND, so they are read from the text after it.
    const health = { ...hookInvocationHealth(line.slice(0, m.index), root), flags: blockFlags(line.slice(m.index)) };
    if (health.ok) return health;
    first ??= health;
  }
  return first ?? { ok: false, invocation: "", reason: `the block has no \`hunch ${words}\` command`, flags: [] };
}

interface BlockInfo {
  state: BlockState;
  /** Where the block's command points (empty when there is no command to read). */
  invocation?: string;
  /** Why a `stale` block's command could never do its job. */
  staleReason?: string;
  /** Hunch's own option flags the block's command carried (see BLOCK_FLAGS). */
  flags?: string[];
  /** The file the block was read from. */
  file: string;
}

/** Whether our block for `mark` is present where git will actually run it AND
 *  its command is a Hunch launcher that exists (issue #315 — a marker alone
 *  proves nothing about what the block does). */
function blockInfo(t: HookTarget, mark: string, root: string): BlockInfo {
  const inHook = markerState(t.hookPath, mark);
  // A reachable marker only earns "installed" once its command checks out.
  const live = (file: string): BlockInfo => {
    const health = inspectBlock(file, mark, root);
    return health.ok
      ? { state: "installed", invocation: health.invocation, flags: health.flags, file }
      : { state: "stale", invocation: health.invocation, staleReason: health.reason, flags: health.flags, file };
  };
  switch (t.manager) {
    case "none":
      return inHook === "reachable" ? live(t.hookPath) : { state: inHook === "unreachable" ? "unreachable" : "missing", file: t.hookPath };
    case "husky":
      if (markerState(t.ownerFile, mark) === "reachable") return live(t.ownerFile);
      if (markerState(t.ownerFile, mark) === "unreachable" || inHook !== "absent") return { state: "unreachable", file: t.hookPath };
      return { state: "missing", file: t.ownerFile };
    case "pre-commit": {
      const config = readText(t.ownerFile);
      // The framework's own config carries the command in its own format; the
      // `id:` is the contract, so it is taken at face value.
      if (config !== null && new RegExp(`\\bid:\\s*["']?${escapeRe(preCommitId(mark))}["']?\\s*$`, "m").test(config)) return { state: "installed", file: t.ownerFile };
      // Migration mode: `pre-commit install` moved the previous hook to <hook>.legacy and runs it first.
      const legacy = `${t.hookPath}.legacy`;
      if (markerState(legacy, mark) === "reachable") return live(legacy);
      return inHook !== "absent" ? { state: "unreachable", file: t.hookPath } : { state: "missing", file: t.ownerFile };
    }
    default: // husky-legacy, tracked-hooks-path, exec-exit: the hook file itself
      return inHook === "reachable" ? live(t.hookPath) : { state: inHook === "unreachable" ? "unreachable" : "missing", file: t.hookPath };
  }
}

function stripMarkers(blk: string): string {
  return blk.split("\n").filter((l) => !/^# (?:>>>|<<<) hunch /.test(l)).join("\n");
}

/** The hand-applied equivalent of our block, in the manager's own format. */
function snippetFor(t: HookTarget, mark: string, build: BlockBuilder, localInvocation: string): string {
  if (t.manager === "pre-commit") {
    const script = stripMarkers(build(PORTABLE_HOOK_INVOCATION, PRE_COMMIT_CONTEXT));
    return [
      `# under \`repos:\` in ${basename(t.ownerFile)} (and run \`pre-commit install --hook-type ${t.hookName}\`)`,
      "- repo: local",
      "  hooks:",
      `    - id: ${preCommitId(mark)}`,
      `      name: hunch ${t.hookName}`,
      "      entry: sh",
      `      args: ["-c", ${JSON.stringify(script)}]`,
      "      language: system",
      `      stages: [${t.hookName}]`,
      "      always_run: true",
      "      pass_filenames: false",
    ].join("\n");
  }
  if (t.manager === "exec-exit") {
    // Untracked local hook: this machine's invocation is fine; placement is the fix.
    return `# insert ABOVE the final exec/exit in ${t.hookName}\n${build(localInvocation, GIT_CONTEXT)}`;
  }
  return build(PORTABLE_HOOK_INVOCATION, GIT_CONTEXT);
}

/** The repo's worktree tops as `git worktree list --porcelain` reports them:
 *  `linked` is every entry AFTER the first (the first is always the main
 *  worktree, or the bare repo) that is not the bare entry, and `count` is how
 *  many non-bare worktrees the repo has — the number the shared-hooks note
 *  quotes, which must not include a bare repo's phantom entry. Entries are
 *  separated by blank lines and each starts with a `worktree <path>` line.
 *  Read straight from git rather than the workspace ledger: this runs during
 *  `hunch init`, before any ledger exists. */
function worktreeTops(root: string): { linked: string[]; count: number } {
  const out = gitRun(["worktree", "list", "--porcelain"], root).stdout;
  if (!out) return { linked: [], count: 0 };
  const entries = out.replace(/\r/g, "").split(/\n\s*\n/).map((e) => e.split("\n"));
  const parsed = entries
    .map((lines) => ({
      path: lines.find((l) => l.startsWith("worktree "))?.slice("worktree ".length) ?? "",
      bare: lines.some((l) => l.trim() === "bare"),
    }))
    .filter((e) => e.path !== "");
  return { linked: parsed.slice(1).filter((e) => !e.bare).map((e) => e.path), count: parsed.filter((e) => !e.bare).length };
}

/** The LINKED worktree an invocation is bound to — one it can only work from
 *  inside, because some token is an absolute path under it (that worktree's own
 *  node_modules install, its own source checkout) — or null.
 *
 *  "Inside" counts textually OR physically: a node_modules symlinked out of a
 *  worktree still dies with `git worktree remove`, and a path spelled through
 *  the main checkout that realpaths into a worktree is just as bound. A
 *  RELATIVE path token is bound to nothing: the shell resolves it against the
 *  hook's own cwd at run time, which is whichever worktree git is running in,
 *  so it stays correct for all of them. */
function worktreeBound(invocation: string, tops: string[]): string | null {
  const toks = shellWords(invocation);
  if (toks === null) return null;
  const norm = (p: string) => (process.platform === "win32" ? resolve(p).toLowerCase() : resolve(p));
  const textuallyInside = (top: string, tok: string): boolean => {
    const rel = relative(norm(top), norm(tok));
    return rel === "" || (!rel.startsWith("..") && !isAbsolute(rel));
  };
  for (const top of tops) {
    if (toks.some((t) => isAbs(t) && (textuallyInside(top, t) || isInside(top, t)))) return top;
  }
  return null;
}

/** The (hookName, mark) pairs of every managed block Hunch writes — the sibling
 *  blocks that share one hooks dir, scanned for a working shared launcher.
 *  Resolved inside a function (like `preCommitId`) because the marks are
 *  declared further down. */
function managedBlocks(): [string, string][] {
  return [
    ["post-commit", MARK],
    ["pre-commit", PRE_MARK],
    ["post-merge", GROUNDING_MERGE_MARK],
    ["post-merge", REPAIR_MERGE_MARK],
    ["post-checkout", CHECKOUT_MARK],
  ];
}

/** The repo's existing SHARED invocation to install instead of `invocation`, or
 *  null to go on as normal (issue #316).
 *
 *  Linked worktrees share ONE `<git-common-dir>/hooks` directory. Rebuilding a
 *  block from a path inside a linked worktree therefore re-points the main
 *  checkout's and every sibling worktree's hooks at code that disappears with
 *  `git worktree remove` — leaving all of them dead. So when the repo already
 *  runs a Hunch bound to NO linked worktree, that invocation wins. The gate is
 *  the caller's invocation, not `root`: an install run from the MAIN checkout
 *  with a worktree-bound launcher poisons the shared hooks exactly the same way.
 *
 *  `own: true` means the block for THIS mark already carries it (the caller must
 *  also preserve the flags it carries). Otherwise the answer came from a sibling
 *  block: `hunch index` self-heals a missing post-merge/post-checkout hook and
 *  agents run it from worktrees constantly — a missing block must not become the
 *  way a worktree path gets into the shared hooks while the repo already has a
 *  working shared launcher. */
function sharedInvocationFor(root: string, mark: string, invocation: string, own: BlockInfo): { invocation: string; own: boolean; flags: string[] } | null {
  const tops = worktreeTops(root).linked;
  if (tops.length === 0 || !worktreeBound(invocation, tops)) return null;

  if (own.state === "installed") {
    // A bound invocation always differs from an unbound one, so no separate
    // "did it change?" test is needed to avoid a pointless rewrite.
    return own.invocation && !worktreeBound(own.invocation, tops)
      ? { invocation: own.invocation, own: true, flags: own.flags ?? [] }
      : null;
  }

  for (const [hookName, m] of managedBlocks()) {
    if (m === mark) continue;
    const info = blockInfo(resolveHookTarget(root, hookName, m), m, root);
    if (info.state === "installed" && info.invocation && !worktreeBound(info.invocation, tops)) {
      // A rebuilt block gets its options from the CALLER, so `own.flags` are
      // the ones the old block carried that this run may be dropping — reported
      // (droppedFlags), never restored: restoring one would fabricate a request
      // nobody made.
      return { invocation: info.invocation, own: false, flags: own.flags ?? [] };
    }
  }
  return null;
}

/** Shared idempotent create/append/update-in-place logic for every hunch git
 *  hook: write a fresh hook file, replace our own managed block in place if the
 *  invocation changed, or append after any pre-existing (non-hunch) hook body
 *  without clobbering it. Used by all hook installers below — the copies had
 *  already drifted (installPreCommitHook was missing the chmodSync on its
 *  "updated" path) before this was unified. When a hook manager owns the file,
 *  or the block would sit after an exec/exit, nothing is written and the result
 *  carries the snippet to add by hand (issue #311). */
function installManagedBlock(root: string, hookName: string, mark: string, end: string, build: BlockBuilder, invocation: string): HookInstall {
  const t = resolveHookTarget(root, hookName, mark);
  if (t.manager !== "none") {
    const info = blockInfo(t, mark, root);
    if (info.state === "installed") return { path: t.ownerFile, action: "unchanged", manager: t.manager };
    return {
      path: t.ownerFile,
      action: t.manager === "exec-exit" ? "unreachable" : "managed-elsewhere",
      manager: t.manager,
      // A stale block IS reachable — the manager's file already carries one, it
      // just cannot run. Saying "a hook manager owns this hook" would send the
      // user looking for a block that is right there (issue #315).
      reason: info.state === "stale"
        ? `the Hunch block in ${basename(info.file)} is stale (${info.staleReason ?? "its command is not a Hunch launcher"}) — replace it with the snippet below`
        : t.reason,
      snippet: snippetFor(t, mark, build, invocation),
      ...(info.state === "stale" ? { stale: true } : {}),
    };
  }

  // Issue #316: the hooks dir is shared with every linked worktree, so prefer
  // the repo's existing unbound command over a caller path that dies with a
  // worktree. The invocation text comes from blockInfo, i.e. straight out of the block's
  // command line with its quoting intact, and inspectBlock only calls a block
  // healthy when shellWords parsed it into plain words with no shell
  // metacharacters — so re-embedding that exact text in build() is safe.
  const info = blockInfo(t, mark, root);
  const shared = sharedInvocationFor(root, mark, invocation, info);
  const blk = build(shared?.invocation ?? invocation, GIT_CONTEXT);
  // A dead own block rebuilt from a SIBLING's launcher keeps neither its command
  // nor its options; say which options went, so a downgraded strict guard is not
  // the user's to discover later.
  const lost = shared && !shared.own ? shared.flags.filter((f) => !builtFlags(blk, mark).includes(f)) : [];
  const sharedNote = shared ? { sharedInvocation: shared.invocation, ...(lost.length > 0 ? { droppedFlags: lost } : {}) } : {};
  const hookPath = t.hookPath;
  mkdirSync(dirname(hookPath), { recursive: true });

  if (!existsSync(hookPath)) {
    writeFileSync(hookPath, `#!/bin/sh\n${blk}\n`);
    chmodSync(hookPath, 0o755);
    return { path: hookPath, action: "created", ...sharedNote };
  }

  const cur = readFileSync(hookPath, "utf8");
  if (cur.includes(mark)) {
    if (shared?.own) {
      // A worktree-local re-run may ADD options to the shared block, never
      // remove them or re-point it: an advisory `hunch init` from a worktree
      // must not silently downgrade the repo's strict pre-commit guard.
      const dropped = shared.flags.filter((f) => !builtFlags(blk, mark).includes(f));
      if (dropped.length > 0) return { path: hookPath, action: "kept-shared", ...sharedNote, keptFlags: dropped };
    }
    const updated = cur.replace(new RegExp(`${escapeRe(mark)}[\\s\\S]*?${escapeRe(end)}`), blk);
    if (updated === cur) return { path: hookPath, action: shared?.own ? "kept-shared" : "unchanged", ...sharedNote };
    writeFileSync(hookPath, updated);
    chmodSync(hookPath, 0o755);
    return { path: hookPath, action: "updated", ...sharedNote };
  }

  const appended = cur.endsWith("\n") ? `${cur}${blk}\n` : `${cur}\n${blk}\n`;
  writeFileSync(hookPath, appended);
  chmodSync(hookPath, 0o755);
  return { path: hookPath, action: "appended", ...sharedNote };
}

export function installPostCommitHook(root: string, invocation: string, opts: { private?: boolean; commit?: boolean; localOnly?: boolean } = {}): HookInstall {
  return installManagedBlock(root, "post-commit", MARK, ENDMARK, (inv) => block(inv, opts), invocation);
}

const PRE_MARK = "# >>> hunch pre-commit (constraint guard) >>>";
const PRE_END = "# <<< hunch pre-commit <<<";

/** Install a pre-commit constraint guard (DESIGN §4 enforcement). Advisory by
 *  default (prints invariants in scope, never blocks); pass strict to fail the
 *  commit — but even strict only fails on a DIRECT, high-confidence, non-stale
 *  blocking invariant (see strictgate.ts), so it's safe on a shared repo.
 *  Preserves any existing pre-commit hook. */
export function installPreCommitHook(root: string, invocation: string, strict = false): HookInstall {
  const build: BlockBuilder = (inv) => {
    const cmd = `${inv} check --staged${strict ? " --strict" : ""}`;
    return [PRE_MARK, strict ? cmd : `${cmd} || true`, PRE_END].join("\n");
  };
  return installManagedBlock(root, "pre-commit", PRE_MARK, PRE_END, build, invocation);
}

// Original marker, kept byte-for-byte for backward compat: an existing install's
// grounding-refresh block must still be found and updated in place by its own
// exact marker text (fnd_c402046ac7).
const GROUNDING_MERGE_MARK = "# >>> hunch post-merge >>>";
const GROUNDING_MERGE_END = "# <<< hunch post-merge <<<";
// Distinct marker for the (newer) repair-provenance half, so the two blocks
// never collide inside the same post-merge hook file and each can be
// independently created/updated/removed without touching the other.
const REPAIR_MERGE_MARK = "# >>> hunch post-merge (repair-provenance) >>>";
const REPAIR_MERGE_END = "# <<< hunch post-merge (repair-provenance) <<<";

function groundingMergeBlock(invocation: string): string {
  return [
    GROUNDING_MERGE_MARK,
    'if [ -z "$HUNCH_SYNC" ]; then',
    "  if ! git diff --quiet ORIG_HEAD HEAD -- .hunch 2>/dev/null; then",
    `    ( HUNCH_SYNC=1 ${invocation} grounding --refresh 2>/dev/null || true )`,
    "  fi",
    "fi",
    GROUNDING_MERGE_END,
  ].join("\n");
}

function repairProvenanceMergeBlock(invocation: string): string {
  return [
    REPAIR_MERGE_MARK,
    'if [ -z "$HUNCH_MERGE_SYNC" ]; then',
    "  export HUNCH_MERGE_SYNC=1",
    // No --apply: this only detects a squash-merge orphaning a decision's commit
    // and queues the match (.hunch/pending-commit-repairs.json, local-only) for a
    // human to confirm via `hunch repair-provenance --apply` — the match signal
    // (file-set overlap, not git's own rename detection) isn't strong enough to
    // trust an unattended, backgrounded write into shared team memory.
    `  ( ${invocation} repair-provenance --from-hook --quiet >/dev/null 2>&1 || true ) &`,
    "fi",
    REPAIR_MERGE_END,
  ].join("\n");
}

/** How significant a combined install result is, for picking one HookInstall
 *  action out of two independent sub-installs into the same file — "created"
 *  (the file itself is new) outranks "appended"/"updated" (an existing file
 *  changed), which outrank "unchanged". Non-writing results are handled before
 *  ranking (they must never be masked by a sibling's success). */
const ACTION_RANK: Record<HookInstall["action"], number> = { created: 3, appended: 2, updated: 2, unchanged: 1, "kept-shared": 1, "managed-elsewhere": 0, unreachable: 0 };

const writes = (h: HookInstall): boolean => h.action !== "managed-elsewhere" && h.action !== "unreachable";

/** Install a post-merge hook carrying TWO independently-managed blocks:
 *  re-sync the committed grounding docs when a merge brought memory in behind
 *  them (fnd_c402046ac7, HUNCH_SYNC-guarded, foreground — it rewrites five
 *  files and can never fail the merge), and opportunistically DETECT a
 *  decision's commit provenance going orphaned right after a squash-merged
 *  branch lands locally (including a fast-forward from `git pull`) — while
 *  the original commits are still fully intact and matchable — queuing the
 *  match for a human to confirm via `hunch repair-provenance --apply`
 *  (HUNCH_MERGE_SYNC-guarded, backgrounded; own env var since this hook makes
 *  no commit of its own and so can't reuse HUNCH_SYNC's re-trigger guard).
 *  Each block is keyed by its own marker pair (installManagedBlock), so
 *  re-running updates only its own block, preserves the other untouched, and
 *  a repo carrying only one half (an older install, or a hand-edited hook)
 *  gets the other appended rather than clobbered. */
export function installPostMergeHook(root: string, invocation: string): HookInstall {
  const grounding = installManagedBlock(root, "post-merge", GROUNDING_MERGE_MARK, GROUNDING_MERGE_END, groundingMergeBlock, invocation);
  const repair = installManagedBlock(root, "post-merge", REPAIR_MERGE_MARK, REPAIR_MERGE_END, repairProvenanceMergeBlock, invocation);
  if (!writes(grounding) && !writes(repair)) {
    return { ...grounding, snippet: `${grounding.snippet}\n${stripComment(repair.snippet ?? "", grounding.manager)}` };
  }
  if (!writes(grounding)) return grounding;
  if (!writes(repair)) return repair;
  const picked = ACTION_RANK[repair.action] >= ACTION_RANK[grounding.action] ? repair : grounding;
  const other = picked === repair ? grounding : repair;
  // Either half may be the one that kept the repo's shared invocation (issue
  // #316); the ranking above can pick the other one. Carry the shared-hook facts
  // over so the CLI line stays true about what the file now runs.
  return {
    ...picked,
    ...(picked.sharedInvocation ?? other.sharedInvocation ? { sharedInvocation: picked.sharedInvocation ?? other.sharedInvocation } : {}),
    ...(picked.keptFlags ?? other.keptFlags ? { keptFlags: picked.keptFlags ?? other.keptFlags } : {}),
    ...(picked.droppedFlags ?? other.droppedFlags ? { droppedFlags: picked.droppedFlags ?? other.droppedFlags } : {}),
  };
}

/** When two snippets for the same file are joined, drop the second's leading
 *  instruction comment (the first already says where it goes). */
function stripComment(snippet: string, manager: HookManagerKind | undefined): string {
  if (manager !== "pre-commit" && manager !== "exec-exit") return snippet;
  return snippet.split("\n").filter((l, i) => !(i === 0 && l.startsWith("# "))).join("\n");
}

const CHECKOUT_MARK = "# >>> hunch post-checkout (workspace ledger) >>>";
const CHECKOUT_END = "# <<< hunch post-checkout (workspace ledger) <<<";

/** post-checkout is where branches and worktrees actually change (`git checkout`,
 *  `git switch`, `git worktree add`). git passes `$3 = 1` for a branch checkout and `0`
 *  for a file checkout; only the former can change the ledger. Constant argv (nothing
 *  from repository content), HUNCH_SYNC-guarded, backgrounded, offline. */
function checkoutBlock(invocation: string, ctx: BlockContext = GIT_CONTEXT): string {
  return [
    CHECKOUT_MARK,
    `if [ -z "$HUNCH_SYNC" ] && [ "${ctx.checkoutType}" = "1" ]; then`,
    `  ( HUNCH_SYNC=1 ${invocation} workspaces snapshot --quiet >/dev/null 2>&1 || true ) &`,
    "fi",
    CHECKOUT_END,
  ].join("\n");
}

export function installPostCheckoutHook(root: string, invocation: string): HookInstall {
  return installManagedBlock(root, "post-checkout", CHECKOUT_MARK, CHECKOUT_END, checkoutBlock, invocation);
}

export type HookState = BlockState;
export interface HookReportEntry {
  state: HookState;
  manager: HookManagerKind;
  /** The file where the block lives (or should live). */
  path: string;
  /** Why an `unreachable` block never runs, or why a `stale` one could not work. */
  reason?: string;
  /** Where the hook points: the distinct invocations of its marks' blocks. */
  invocation?: string;
  /** Hunch's own option flags the hook's blocks carry (`--private`, `--commit`,
   *  `--strict`) — what a plain `hunch init` re-run would drop. Omitted when none. */
  flags?: string[];
}
export interface HookReport {
  postCommit: HookReportEntry;
  preCommit: HookReportEntry;
  postMerge: HookReportEntry;
  postCheckout: HookReportEntry;
}

function reportEntry(root: string, hookName: string, marks: string[]): HookReportEntry {
  const states = marks.map((mark) => {
    const t = resolveHookTarget(root, hookName, mark);
    return { t, ...blockInfo(t, mark, root) };
  });
  const unreachable = states.find((s) => s.state === "unreachable");
  const stale = states.find((s) => s.state === "stale");
  // A dead block outranks a stale one, which outranks a missing one: each is a
  // stronger statement about why this hook is not doing its job.
  const pick = unreachable ?? stale ?? states.find((s) => s.state === "missing") ?? states[0];
  if (!pick) throw new Error("reportEntry needs at least one marker");
  const state: HookState = unreachable ? "unreachable" : stale ? "stale" : states.every((s) => s.state === "installed") ? "installed" : "missing";
  const invocation = [...new Set(states.map((s) => s.invocation).filter((i): i is string => !!i))].join(" · ");
  // Union across the hook's marks, in BLOCK_FLAGS order — a hook is re-installed
  // as a whole, so a flag on any of its blocks is one a bare re-run would drop.
  const flags = BLOCK_FLAGS.filter((f) => states.some((s) => s.flags?.includes(f)));
  return {
    state,
    manager: pick.t.manager,
    path: state === "unreachable" && pick.t.manager !== "husky" ? pick.t.hookPath : state === "stale" ? pick.file : pick.t.ownerFile,
    ...(state === "unreachable" ? { reason: pick.t.reason } : state === "stale" ? { reason: pick.staleReason } : {}),
    ...(invocation ? { invocation } : {}),
    ...(flags.length ? { flags } : {}),
  };
}

/** Read-only diagnostic (used by `hunch doctor`): each managed hook's state —
 *  `installed` (present where git will run it, running a Hunch launcher that
 *  exists), `unreachable` (present, but after an exec/exit or in a
 *  manager-owned file git never reaches), `stale` (present where git runs it,
 *  but its command is not a working Hunch launcher — issue #315), or
 *  `missing`. postMerge requires BOTH halves (grounding-refresh and
 *  repair-provenance) — a repo carrying only one is a partial install, same as
 *  `installPostMergeHook` self-healing it. Never writes anything. */
export function hookReport(root: string): HookReport {
  return {
    postCommit: reportEntry(root, "post-commit", [MARK]),
    preCommit: reportEntry(root, "pre-commit", [PRE_MARK]),
    postMerge: reportEntry(root, "post-merge", [GROUNDING_MERGE_MARK, REPAIR_MERGE_MARK]),
    postCheckout: reportEntry(root, "post-checkout", [CHECKOUT_MARK]),
  };
}

/** Boolean view of `hookReport`: a hook counts as installed only when its
 *  managed block is present where git will actually run it AND the command
 *  inside it is a Hunch launcher that exists. An unreachable block (issue #311)
 *  and a stale one (issue #315) are both NOT installed. */
export function hookStatus(root: string): { postCommit: boolean; preCommit: boolean; postMerge: boolean; postCheckout: boolean } {
  const r = hookReport(root);
  return {
    postCommit: r.postCommit.state === "installed",
    preCommit: r.preCommit.state === "installed",
    postMerge: r.postMerge.state === "installed",
    postCheckout: r.postCheckout.state === "installed",
  };
}

/** Doctor lines for where each installed/stale hook points (issue #315): hooks
 *  sharing one invocation share one line, and a line whose invocation is not the
 *  Hunch currently running says so. Informational — a hook may legitimately
 *  point at a different install. Pure; the caller adds indentation and dim(). */
export function hookInvocationLines(report: HookReport, running: string): string[] {
  const named = ([["post-commit", report.postCommit], ["post-merge", report.postMerge], ["pre-commit", report.preCommit], ["post-checkout", report.postCheckout]] as const)
    .filter(([, e]) => e.invocation && (e.state === "installed" || e.state === "stale"));
  const grouped = new Map<string, string[]>();
  for (const [name, e] of named) grouped.set(e.invocation!, [...(grouped.get(e.invocation!) ?? []), name]);
  return [...grouped].map(([inv, names]) =>
    `${names.join(", ")} → ${inv}${running && inv !== running ? ` (differs from the running Hunch: ${running})` : ""}`);
}

/** CLI lines for one install result: the usual ✓ line when the block is in a
 *  file git runs, otherwise a warning with the reason and the snippet to add to
 *  the manager's own file. */
export function formatHookInstall(root: string, label: string, h: HookInstall, detail = ""): string[] {
  // kept-shared deliberately drops `detail`: it describes the options this run
  // ASKED for, and those are exactly what was not applied (issue #316).
  if (h.action === "kept-shared") {
    const flags = h.keptFlags?.length ? ` with ${h.keptFlags.join(" ")}` : "";
    // The options this run asked for were not applied, so the way to change them
    // is the one thing worth saying next.
    const how = h.keptFlags?.length ? " — to change its options, re-run `hunch init` with a Hunch that is not inside a linked worktree (a global install, or the main checkout's)" : "";
    return [`  ✓ ${label} kept — the shared hook keeps running ${h.sharedInvocation}${flags} (not re-pointed at this worktree)${how}`];
  }
  if (writes(h)) {
    const lost = h.droppedFlags?.length ? ` — the previous block's ${h.droppedFlags.join(" ")} was not carried over; re-run with the option to restore it` : "";
    if (h.sharedInvocation) return [`  ✓ ${label} ${h.action}${detail} — runs the repo's shared Hunch (${h.sharedInvocation}), not this worktree's${lost}`];
    return [`  ✓ ${label} ${h.action}${detail}${lost}`];
  }
  const shown = isInside(root, h.path) ? relative(realish(root), realish(h.path)).replace(/\\/g, "/") : h.path;
  return [
    `  ⚠ ${label} NOT installed — ${h.reason ?? "a hook manager owns this hook"}`,
    // A stale block is already there and the reason said to replace it; anything
    // else is missing and has to be added.
    `    ${h.stale ? "replace the Hunch block in" : "add this to"} ${shown} yourself:`,
    ...(h.snippet ?? "").split("\n").map((l) => `      ${l}`),
  ];
}

/** The closing line `hunch init` prints about the SHARED hooks dir (issue #316).
 *  Setup used to claim "sharing the repo's hooks + memory" unconditionally —
 *  true of memory, but the hooks dir is genuinely shared, so a block pointing
 *  inside a linked worktree dies for every checkout when that worktree goes.
 *
 *  The verdict is read from what the shared blocks ACTUALLY run, not from this
 *  run's actions: a second `hunch init` writes nothing yet the hooks are just as
 *  broken, and the main checkout — which never used to get a note at all — is
 *  where the user can most easily fix it. `installs` only decides between the
 *  healthy variants. `[]` when the repo has no linked worktree. Read-only. */
export function sharedHooksNote(root: string, installs: HookInstall[]): string[] {
  const { linked, count } = worktreeTops(root);
  if (linked.length === 0) return [];
  const d = hooksDir(root);
  const dir = isAbsolute(d) ? d : join(root, d);

  // A hooks dir is shared when git resolves it inside the COMMON dir, or points
  // outside this checkout entirely. A relative `core.hooksPath` (husky's
  // `.husky/_`) resolves per checkout, so it is this worktree's alone.
  const common = gitCommonDir(root);
  const top = gitRun(["rev-parse", "--show-toplevel"], root).stdout;
  const dirShared = (common !== "" && isInside(common, dir)) || (top !== "" && !isInside(top, dir));

  if (dirShared) {
    const bound: string[] = [];
    const tops = new Set<string>();
    for (const [hookName, m] of managedBlocks()) {
      const info = blockInfo(resolveHookTarget(root, hookName, m), m, root);
      const at = info.invocation ? worktreeBound(info.invocation, linked) : null;
      if (!at) continue;
      tops.add(at);
      if (!bound.includes(hookName)) bound.push(hookName);
    }
    if (bound.length > 0) {
      const one = bound.length === 1;
      // Several blocks may be bound to different worktrees; naming the first one
      // is enough to find the problem, and the plural says there are more.
      const where = tops.size > 1 ? `linked worktrees (${[...tops][0]})` : `a linked worktree (${[...tops][0]})`;
      return [`  ⚠ shared hooks dir (${dir}) — ${bound.join(", ")} run${one ? "s" : ""} Hunch from inside ${where}; removing that worktree breaks ${one ? "it" : "them"} for every checkout of this repo — install Hunch globally or in the main checkout, then re-run \`hunch init\` with it to re-point ${one ? "it" : "them"}`];
    }
  }

  if (!isLinkedWorktree(root)) return [];
  const wrote = installs.some((h) => writes(h));
  if (!dirShared || !wrote) return ["  ✓ linked worktree — sharing the repo's memory"];
  if (installs.some((h) => h.sharedInvocation)) {
    return [`  ✓ linked worktree — sharing the repo's memory; the hooks dir is shared by ${count} worktrees (${dir}) and keeps running the repo's Hunch, not this worktree's`];
  }
  return [`  ✓ linked worktree — sharing the repo's hooks + memory (hooks dir is shared by ${count} worktrees: ${dir})`];
}
