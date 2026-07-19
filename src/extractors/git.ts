/** Deterministic git introspection for the extractor + learning loop.
 *  No LLM here — just parsing what git already knows. */
import { execFileSync } from "node:child_process";
import { createHash } from "node:crypto";
import { devNull } from "node:os";
import { isAbsolute, resolve, join, basename, dirname } from "node:path";
import { mkdirSync, rmSync, statSync, lstatSync, realpathSync, readFileSync, renameSync, readdirSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { MEMLOG_FORMAT } from "../core/memorylog.js";
import { hunchAttributesAreSafe, hunchTreeAttributesAreSafe, safeOverlayGitTreeListing, safeOverlayTree } from "../core/overlaySafety.js";
import { createRepoFileReader } from "../core/safeRepoFile.js";

export interface CommitMeta {
  sha: string;
  shortSha: string;
  subject: string;
  body: string;
  author: string;
  date: string;
  files: string[];
}

// `git` exports these repository-local variables to hooks. They outrank cwd/-C,
// so carrying them from the code repository into a command for the memory
// overlay can target the wrong index/object store. This is the documented set
// from `git rev-parse --local-env-vars`; keep explicit global credentials and
// transport settings, but always clear repository identity before selecting cwd.
const LOCAL_GIT_ENV_VARS = [
  "GIT_ALTERNATE_OBJECT_DIRECTORIES", "GIT_CONFIG", "GIT_CONFIG_PARAMETERS", "GIT_CONFIG_COUNT",
  "GIT_OBJECT_DIRECTORY", "GIT_DIR", "GIT_WORK_TREE", "GIT_IMPLICIT_WORK_TREE", "GIT_GRAFT_FILE",
  "GIT_INDEX_FILE", "GIT_NO_REPLACE_OBJECTS", "GIT_REPLACE_REF_BASE", "GIT_PREFIX",
  "GIT_INTERNAL_SUPER_PREFIX", "GIT_SHALLOW_FILE", "GIT_COMMON_DIR",
] as const;

export function foreignRepoEnv(source: NodeJS.ProcessEnv): NodeJS.ProcessEnv {
  const env = { ...source };
  for (const key of LOCAL_GIT_ENV_VARS) delete env[key];
  for (const key of Object.keys(env)) {
    if (/^GIT_CONFIG_(?:KEY|VALUE)_\d+$/.test(key)) delete env[key];
  }
  return env;
}

function machineCommitEnv(repoRoot: string, source: NodeJS.ProcessEnv): NodeJS.ProcessEnv {
  const env = foreignRepoEnv(source);
  const configured = (key: "user.name" | "user.email"): string => {
    try {
      return execFileSync("git", ["-C", repoRoot, "config", "--get", key], {
        encoding: "utf8", stdio: ["ignore", "pipe", "ignore"], env, timeout: 2_000,
      }).trim();
    } catch { return ""; }
  };
  const name = configured("user.name");
  const email = configured("user.email");
  if (!env.GIT_AUTHOR_NAME && !name) env.GIT_AUTHOR_NAME = "Hunch Memory";
  if (!env.GIT_COMMITTER_NAME && !name) env.GIT_COMMITTER_NAME = "Hunch Memory";
  if (!env.GIT_AUTHOR_EMAIL && !email) env.GIT_AUTHOR_EMAIL = "hunch-memory@localhost";
  if (!env.GIT_COMMITTER_EMAIL && !email) env.GIT_COMMITTER_EMAIL = "hunch-memory@localhost";
  return env;
}

function git(args: string[], cwd: string, maxBuffer = 64 * 1024 * 1024): string {
  // stdio: capture stdout, silence stderr (so "no commits yet" etc. don't leak).
  return execFileSync("git", args, {
    cwd, encoding: "utf8", maxBuffer,
    stdio: ["ignore", "pipe", "ignore"],
  }).trim();
}

function gitSafe(args: string[], cwd: string, maxBuffer?: number): string {
  try {
    return git(args, cwd, maxBuffer);
  } catch {
    return "";
  }
}

/** Object-identity reads must not inherit clone-local replacement refs/grafts.
 * Most Git helpers intentionally preserve ordinary repository behavior; use
 * this narrower path only where a cross-clone canonical identity is minted. */
function gitSafeWithoutReplacements(args: string[], cwd: string, maxBuffer = 64 * 1024 * 1024): string {
  try {
    return execFileSync("git", args, {
      cwd,
      encoding: "utf8",
      env: { ...process.env, GIT_NO_REPLACE_OBJECTS: "1" },
      maxBuffer,
      stdio: ["ignore", "pipe", "ignore"],
    }).trim();
  } catch {
    return "";
  }
}

function gitRawSafe(args: string[], cwd: string, maxBuffer = 64 * 1024 * 1024): string | null {
  try {
    return execFileSync("git", args, {
      cwd, encoding: "utf8", maxBuffer,
      stdio: ["ignore", "pipe", "ignore"],
    });
  } catch {
    return null;
  }
}

function gitSafeIsolated(args: string[], cwd: string, maxBuffer = 64 * 1024 * 1024): string {
  try {
    return execFileSync("git", args, {
      cwd, encoding: "utf8", maxBuffer,
      stdio: ["ignore", "pipe", "ignore"],
      env: foreignRepoEnv(process.env),
    }).trim();
  } catch { return ""; }
}

function gitRawSafeIsolated(args: string[], cwd: string, maxBuffer = 64 * 1024 * 1024): string | null {
  try {
    return execFileSync("git", args, {
      cwd, encoding: "utf8", maxBuffer,
      stdio: ["ignore", "pipe", "ignore"],
      env: foreignRepoEnv(process.env),
    });
  } catch { return null; }
}

function headShaWithEnv(cwd: string, env: NodeJS.ProcessEnv): string {
  return gitSafeWithEnv(["rev-parse", "HEAD"], cwd, env);
}

/** Git query for a repository other than the invocation repository. The
 * caller supplies an environment with code-repo GIT_DIR/GIT_INDEX_FILE state
 * removed, so hooks cannot redirect an overlay query back into the code repo. */
function gitSafeWithEnv(args: string[], cwd: string, env: NodeJS.ProcessEnv): string {
  try {
    return execFileSync("git", ["-C", cwd, ...args], {
      encoding: "utf8", stdio: ["ignore", "pipe", "ignore"], env, timeout: 2_000,
    }).trim();
  } catch { return ""; }
}

export function isGitRepo(cwd: string): boolean {
  return gitSafe(["rev-parse", "--is-inside-work-tree"], cwd) === "true";
}

/** Canonical worktree root, or null when Git cannot positively identify one.
 * Callers enforcing a privacy boundary must distinguish "different repo" from
 * "malformed/unknown Git state" instead of treating both as safe. */
export function gitWorktreeRoot(cwd: string): string | null {
  const top = gitSafeIsolated(["rev-parse", "--show-toplevel"], cwd);
  return top ? canonicalPath(top) : null;
}

/** True only when `cwd` is the repository's actual worktree root. Unlike
 * `isGitRepo`, this does not accept an ancestor repository discovered by Git's
 * upward walk. Private overlays use this stronger boundary so a nested
 * `.hunch-private/.hunch` can never stage or commit into the code repository. */
export function isGitRepoRoot(cwd: string): boolean {
  const raw = gitSafeIsolated(["rev-parse", "--show-toplevel"], cwd);
  return !!raw && sameFilesystemEntry(raw, cwd);
}

function canonicalPath(path: string): string {
  try { return realpathSync(path); } catch { return resolve(path); }
}

export function gitNullDevice(): string {
  return process.platform === "win32" ? "NUL" : devNull;
}

/** Compare physical directory identity before path text. Git for Windows can
 * return an 8.3/short or differently-cased spelling for the same top-level
 * directory that Node reached through its long path. A nonzero file ID keeps
 * this exact even on case-sensitive Windows directories; canonical text is a
 * conservative fallback for filesystems that do not expose stable IDs. */
function sameFilesystemEntry(left: string, right: string): boolean {
  try {
    const leftStat = statSync(left, { bigint: true });
    const rightStat = statSync(right, { bigint: true });
    if (leftStat.ino !== 0n && rightStat.ino !== 0n) {
      return leftStat.dev === rightStat.dev && leftStat.ino === rightStat.ino;
    }
  } catch { /* fall back to canonical path text */ }
  return canonicalPath(left) === canonicalPath(right);
}

/** Whether two paths resolve to the same repository identity. Comparing only
 * worktree roots is insufficient: linked worktrees have different roots but
 * share one Git common directory and therefore one publishable history. */
export function sameGitRepository(left: string, right: string): boolean {
  if (sameFilesystemEntry(left, right)) return true;
  const common = (cwd: string): string => {
    const value = gitSafeIsolated(["rev-parse", "--git-common-dir"], cwd);
    return value ? (isAbsolute(value) ? value : resolve(cwd, value)) : "";
  };
  const leftCommon = common(left);
  const rightCommon = common(right);
  return !!leftCommon && !!rightCommon && sameFilesystemEntry(leftCommon, rightCommon);
}

function remoteIdentity(raw: string, cwd: string, purpose: "route" | "publication" = "route"): string {
  const value = raw.trim();
  if (!value) return "";
  const trimRepoSuffix = (path: string): string => path.replace(/[\\/]+$/, "").replace(/\.git$/i, "");
  // Local repositories are filesystem identities, not provider aliases. Both
  // `/srv/memory` and `/srv/memory.git` may exist and publish unrelated graphs;
  // collapsing the conventional suffix is safe only for known network hosts.
  const normalizeLocalPath = (path: string): string => canonicalPath(path).replace(/[\\/]+$/, "");
  const normalizeNetworkPath = (host: string, path: string): string => {
    const normalized = trimRepoSuffix(path).replace(/^\/+/, "");
    return host === "github.com" || host === "www.github.com" ? normalized.toLowerCase() : normalized;
  };
  const azureDevOpsIdentity = (host: string, path: string): string | null => {
    const segments = trimRepoSuffix(path).replace(/^\/+/, "").split("/");
    let coordinates: [string, string, string] | null = null;
    if (host === "dev.azure.com" && segments.length === 4 && segments[2]!.toLowerCase() === "_git") {
      coordinates = [segments[0]!, segments[1]!, segments[3]!];
    } else if ((host === "ssh.dev.azure.com" || host === "vs-ssh.visualstudio.com")
      && segments.length === 4 && segments[0]!.toLowerCase() === "v3") {
      coordinates = [segments[1]!, segments[2]!, segments[3]!];
    } else {
      const legacyHost = host.match(/^([^.]+)\.visualstudio\.com$/);
      if (legacyHost && segments.length === 3 && segments[1]!.toLowerCase() === "_git") {
        coordinates = [legacyHost[1]!, segments[0]!, segments[2]!];
      }
    }
    if (!coordinates?.every(Boolean)) return null;
    return `provider:azure-devops:${coordinates.map((part) => part.toLowerCase()).join("/")}`;
  };
  const networkIdentity = (
    host: string,
    path: string,
    pathCaseHost = host,
    username = "",
    transport = "ssh",
  ): string => {
    const provider = azureDevOpsIdentity(host, path);
    if (provider) return provider;
    if (host === "github.com" || host === "www.github.com") {
      return `provider:github:${normalizeNetworkPath("github.com", path)}`;
    }
    // Route proof is deliberately exact for an unknown host: transport and SSH
    // account can select different namespaces. Preserve username bytes/case.
    // Publication proof is deliberately conservative in the other direction:
    // https://host/org/repo and ssh://user@host/org/repo may publish the same
    // history, so an overlay must not evade the code-remote boundary by changing
    // transport spelling.
    const account = purpose === "route" && username ? `${username}@` : "";
    const route = ["ssh", "git+ssh", "ssh+git"].includes(transport) ? "ssh" : transport;
    const normalizedPath = normalizeNetworkPath(pathCaseHost, path);
    return `net:${purpose === "route" ? route : "any"}://${account}${host}/${purpose === "publication" ? normalizedPath.toLowerCase() : normalizedPath}`;
  };
  try {
    if (value.startsWith("file://")) return `file:${normalizeLocalPath(fileURLToPath(value))}`;
  } catch { /* fall through to the literal URL form */ }
  if (isAbsolute(value) || value.startsWith("./") || value.startsWith("../")) {
    return `file:${normalizeLocalPath(resolve(cwd, value))}`;
  }
  const scp = value.match(/^(?:([^@/]+)@)?([^:/]+):(.+)$/);
  if (scp && !value.includes("://")) {
    const rawHost = scp[2]!.toLowerCase().replace(/\.$/, "");
    const host = rawHost === "www.github.com" ? "github.com" : rawHost;
    return networkIdentity(host, scp[3]!, host, scp[1] ?? "", "ssh");
  }
  if (!value.includes("://")) return `file:${normalizeLocalPath(resolve(cwd, value))}`;
  try {
    const url = new URL(value);
    const rawHostname = url.hostname.toLowerCase().replace(/\.$/, "");
    const protocol = url.protocol.toLowerCase();
    const githubSsh443 = rawHostname === "ssh.github.com" && ["ssh:", "git+ssh:", "ssh+git:"].includes(protocol) && url.port === "443";
    const hostname = rawHostname === "www.github.com" || githubSsh443 ? "github.com" : rawHostname;
    const defaults: Record<string, string> = { "ssh:": "22", "git+ssh:": "22", "ssh+git:": "22", "https:": "443", "http:": "80", "git:": "9418" };
    const port = !githubSsh443 && url.port && url.port !== defaults[protocol] ? `:${url.port}` : "";
    const host = `${hostname}${port}`;
    return networkIdentity(
      host,
      decodeURIComponent(url.pathname),
      hostname,
      decodeURIComponent(url.username),
      protocol.replace(/:$/, ""),
    );
  } catch {
    return `literal:${trimRepoSuffix(value)}`;
  }
}

function localRemotePath(raw: string, cwd: string): string | null {
  const value = raw.trim();
  if (!value) return null;
  try {
    if (value.startsWith("file://")) return canonicalPath(fileURLToPath(value));
  } catch { return null; }
  if (isAbsolute(value) || value.startsWith("./") || value.startsWith("../")) {
    return canonicalPath(resolve(cwd, value));
  }
  const scp = value.match(/^(?:[^@/]+@)?[^:/]+:.+$/);
  if (!value.includes("://") && !scp) return canonicalPath(resolve(cwd, value));
  return null;
}

function repositoriesShareCommitObjects(left: string, right: string): boolean {
  const leftHead = gitSafeIsolated(["rev-parse", "--verify", "HEAD^{commit}"], left);
  const rightHead = gitSafeIsolated(["rev-parse", "--verify", "HEAD^{commit}"], right);
  if (!leftHead || !rightHead) return false;
  if (gitRawSafeIsolated(["cat-file", "-e", `${leftHead}^{commit}`], right) !== null
    || gitRawSafeIsolated(["cat-file", "-e", `${rightHead}^{commit}`], left) !== null) return true;

  // Comparing only the tips misses a forked contamination: the code repo and
  // an overlay can each add a unique commit after sharing an older code
  // history. Pushing the overlay tip would still publish every reachable code
  // ancestor. Full repositories that share ancestry share at least one root;
  // for shallow repositories, also ask whether either visible boundary/root is
  // present in the other object database.
  const roots = (cwd: string): string[] => gitSafeIsolated(["rev-list", "--max-parents=0", "HEAD"], cwd)
    .split(/\r?\n/)
    .filter((oid) => /^[0-9a-f]{40,64}$/i.test(oid));
  const leftRoots = roots(left);
  const rightRoots = roots(right);
  if (!leftRoots.length || !rightRoots.length) return false;
  const rightRootSet = new Set(rightRoots);
  if (leftRoots.some((oid) => rightRootSet.has(oid))) return true;
  return leftRoots.some((oid) => gitRawSafeIsolated(["cat-file", "-e", `${oid}^{commit}`], right) !== null)
    || rightRoots.some((oid) => gitRawSafeIsolated(["cat-file", "-e", `${oid}^{commit}`], left) !== null);
}

function localRemoteTargets(cwd: string): string[] {
  const out = gitRawSafeIsolated(["remote", "-v"], cwd) ?? "";
  const targets = new Set<string>();
  for (const line of out.split("\n")) {
    const match = line.match(/^[^\t]+\t(.+) \((?:fetch|push)\)$/);
    if (!match) continue;
    const target = localRemotePath(match[1]!, cwd);
    if (target) targets.add(target);
  }
  return [...targets];
}

function repositoryTargetMatches(target: string, repoRoot: string): boolean {
  return sameGitRepository(target, repoRoot) || repositoriesShareCommitObjects(target, repoRoot);
}

/** Resolve a user-supplied Git remote once, before handing it to commands that
 * run from different working directories. Git otherwise gives a relative local
 * URL a different meaning under `git clone` and `git -C <overlay> remote add`,
 * which can turn a successful preflight into a later privacy-boundary escape. */
export function canonicalRemoteUrl(raw: string, cwd: string): string {
  const value = raw.trim();
  if (!value) return "";
  try {
    if (value.startsWith("file://")) return canonicalPath(fileURLToPath(value));
  } catch { /* let Git report an invalid URL without weakening the boundary */ }
  if (isAbsolute(value)) return canonicalPath(value);
  const scp = value.match(/^(?:[^@/]+@)?[^:/]+:.+$/);
  if (!value.includes("://") && !scp) return canonicalPath(resolve(cwd, value));
  return value;
}

/** Compare two remote spellings in the contexts where Git would interpret
 * them. This is identity comparison, not brittle string equality. */
export function sameRemoteUrl(left: string, leftCwd: string, right: string, rightCwd: string): boolean {
  const leftIdentity = remoteIdentity(left, leftCwd, "route");
  return !!leftIdentity && leftIdentity === remoteIdentity(right, rightCwd, "route");
}

function gitRemoteIdentities(cwd: string, direction: "fetch" | "push" | "any" = "any"): Set<string> {
  const out = gitRawSafeIsolated(["remote", "-v"], cwd) ?? "";
  const identities = new Set<string>();
  for (const line of out.split("\n")) {
    const match = line.match(/^[^\t]+\t(.+) \((fetch|push)\)$/);
    if (!match) continue;
    if (direction !== "any" && match[2] !== direction) continue;
    const identity = remoteIdentity(match[1]!, cwd, "publication");
    if (identity) identities.add(identity);
  }
  return identities;
}

/** True when two worktrees can publish to the same local Git history OR name
 * the same configured remote repository. Separate clones of one remote are a
 * single publication boundary even though their local common dirs differ. */
export function sameGitPublication(left: string, right: string): boolean {
  if (sameGitRepository(left, right)) return true;
  // A clone of the code repository with its origin removed still carries the
  // same commit objects. Treat shared history as one publication boundary; a
  // memory overlay must start from an independent graph history.
  if (repositoriesShareCommitObjects(left, right)) return true;
  for (const target of localRemoteTargets(left)) if (repositoryTargetMatches(target, right)) return true;
  for (const target of localRemoteTargets(right)) if (repositoryTargetMatches(target, left)) return true;
  const leftRemotes = gitRemoteIdentities(left);
  if (!leftRemotes.size) return false;
  for (const remote of gitRemoteIdentities(right)) if (leftRemotes.has(remote)) return true;
  return false;
}

/** Preflight a requested overlay URL before clone/attach can mutate a remote. */
export function repositoryUsesRemote(repoRoot: string, remoteUrl: string, remoteCwd = repoRoot): boolean {
  const localTarget = localRemotePath(remoteUrl, remoteCwd);
  if (localTarget && repositoryTargetMatches(localTarget, repoRoot)) return true;
  const requested = remoteIdentity(remoteUrl, remoteCwd, "publication");
  return !!requested && gitRemoteIdentities(repoRoot).has(requested);
}

/** The MAIN worktree's root — the stable anchor for an overlay store. A linked worktree
 *  can be `git worktree remove`d, so anything anchored inside it (an overlay clone, an
 *  absolute pointer target) silently dies for every OTHER worktree; the main checkout
 *  can't be removed. Falls back to `root` when the layout isn't the standard `.git` dir
 *  (or not a git repo), preserving today's behavior. */
export function mainWorktreeRoot(root: string): string {
  const common = gitCommonDir(root);
  if (!common) return root;
  const abs = resolve(root, common);
  return basename(abs) === ".git" ? dirname(abs) : root;
}

/** Stable, privacy-safe repository label for artifacts that must be reusable
 * across linked worktrees and ordinary clones. Prefer the canonical fetch
 * remote identity: its SHA-256 digest exposes neither a private URL nor a local
 * path, ignores mutable remote aliases, and does not depend on clone depth. If
 * several fetch remotes exist, canonical identity ordering makes the choice
 * deterministic without privileging a name such as `origin`.
 *
 * Remote-less full clones fall back to intrinsic root commits. A remote-less
 * shallow clone cannot prove a clone-independent repository identity without
 * fetching missing history or persisting a shared ID, so it retains the local
 * main-worktree label (which is still stable across linked worktrees). */
export function stableRepositoryName(root: string): string {
  const fetchRemote = [...gitRemoteIdentities(root, "fetch")].sort()[0];
  if (fetchRemote) {
    const digest = createHash("sha256").update(fetchRemote, "utf8").digest("hex");
    return `git-remote:sha256:${digest}`;
  }
  const shallow = gitSafe(["rev-parse", "--is-shallow-repository"], root) === "true";
  if (shallow) return basename(mainWorktreeRoot(root));
  const roots = gitSafeWithoutReplacements(["rev-list", "--max-parents=0", "HEAD"], root)
    .split(/\s+/)
    .filter(Boolean)
    .sort();
  if (roots.length) return `git:${roots.join("+")}`;
  return basename(mainWorktreeRoot(root));
}

/** Best-effort: stage ONLY the hunch dir, commit, and push the repo it lives in. Shared by
 *  the post-commit auto-commit (CLI sync --commit), MCP private writes, and `hunch private
 *  --sync`. HUNCH_SYNC=1 stops the created commit from re-triggering the post-commit hook
 *  (no recursion). Stages with a pathspec scoped to `hunchDir`, so it never sweeps unrelated
 *  working-tree changes. Never throws — a non-repo dir / offline push just no-ops.
 *  `push: false` commits WITHOUT merging or pushing — required when hunchDir is the PUBLIC
 *  .hunch/ inside the user's code repo: an automatic pull/push there would merge the remote
 *  into their working branch and publish their unpushed code commits. The memory commit
 *  simply rides the user's next push.
 *  Returns what ACTUALLY happened, so callers never report a commit that was skipped:
 *  "pushed" (commit created and pushed), "committed" (commit created; push not requested,
 *  or the merge/push failed — retry rides the next flush), null (nothing committed: lock
 *  held, backstop refusal, nothing staged, or not a repo). */
export type HunchCommitOptions =
  | { push: false; alsoStage?: string[] }
  | { push?: true; protectedRepoRoot: string; alsoStage?: string[]; remote?: HunchRemoteContract };

/** A team sync never delegates destination or ref selection to ambient Git
 * configuration. The committed team pointer supplies one fetch URL, one push
 * URL, and one canonical branch ref; `verify` re-proves that contract at each
 * network seam while the Hunch lock is held. */
export interface HunchRemoteContract {
  fetchUrl: string;
  pushUrl: string;
  urlCwd: string;
  ref: string;
  verify: () => boolean;
}

const CAPTURE_REMOTE_TIMEOUT_MS = 15_000;
const READ_REMOTE_TIMEOUT_MS = 5_000;
// A capture can spend roughly 90s in commit + bounded merge/push/retry seams.
// A contending writer waits beyond that proven ceiling, then takes the lock and
// drains every already-durable JSON write itself. This removes the old "maybe a
// third capture sweeps it later" liveness hole.
const CAPTURE_LOCK_HANDOFF_MS = 120_000;

function unsafeOverlayPublication(hunchDir: string, protectedRepoRoot: string): boolean {
  let currentOverlayRoot = dirname(resolve(hunchDir));
  try { currentOverlayRoot = dirname(realpathSync(hunchDir)); } catch { return true; }
  const standalone = isGitRepoRoot(currentOverlayRoot);
  const overlapsCode = standalone ? sameGitPublication(currentOverlayRoot, protectedRepoRoot) : null;
  const unsafe = !standalone || overlapsCode === true;
  if (unsafe && process.env.HUNCH_TEAM_CLONE_DEBUG === "1") {
    process.stderr.write(
      `[hunch-team-boundary] standalone=${standalone} overlaps_code=${overlapsCode ?? "unchecked"}\n`,
    );
  }
  return unsafe;
}

export function commitAndPushHunch(hunchDir: string, message: string, opts: HunchCommitOptions): "pushed" | "committed" | null {
  // Runtime callers may be older compiled JS even though TypeScript requires the
  // protected-repository contract. Preserve this helper's never-throw promise and
  // fail closed instead of dereferencing a missing options object.
  if (!opts) {
    console.error(`hunch: refusing to auto-commit memory at "${hunchDir}" — the protected repository identity was not provided. Nothing was staged, committed, or pushed.`);
    return null;
  }
  // A push-capable target is a PRIVATE/SHARED overlay and must live directly
  // inside its OWN repository. `git -C` otherwise walks upward and may resolve
  // a nested overlay to the user's code repo. JSON-only private artifacts would
  // pass the staged-file backstop below, so enforce the repository boundary
  // before staging even one byte. Public `.hunch/` commits intentionally use
  // push:false and are allowed to resolve to the enclosing project repository.
  if (opts.push !== false) {
    if (unsafeOverlayPublication(hunchDir, opts.protectedRepoRoot)) {
      console.error(`hunch: refusing to auto-commit private memory at "${hunchDir}" — it is not a standalone Git repository distinct from the protected code repository. Nothing was staged, committed, or pushed. (Run \`hunch private\` or \`hunch shared --repo <url>\` to create a dedicated overlay repository.)`);
      return null;
    }
  }
  // Serialize across worktrees: several worktrees auto-committing the SAME overlay repo
  // at once would race git's index.lock. A contender whose record is already
  // durable waits for the live owner to finish, then acquires the lock and
  // drains anything the owner's exact path snapshot did not include.
  const lock = join(hunchDir, ".hunch-commit.lock");
  const firstLockAttempt = acquireCommitLock(lock);
  if (firstLockAttempt.state !== "acquired"
    && !waitForCommitLockHandoff(lock, firstLockAttempt, CAPTURE_LOCK_HANDOFF_MS)) return null;
  try {
    const env = machineCommitEnv(hunchDir, {
      ...process.env,
      HUNCH_SYNC: "1",
      GIT_TERMINAL_PROMPT: "0",
      GIT_MERGE_AUTOEDIT: "no",
      GIT_ATTR_NOSYSTEM: "1",
    });
    const run = (args: string[]): boolean => {
      try {
        execFileSync("git", ["-C", hunchDir, ...args], { stdio: "ignore", env });
        return true;
      } catch {
        return false; // best-effort: nothing staged / not a repo / offline
      }
    };
    if (opts.push !== false) {
      if (!overlayAttributeSourcesAreSafe(hunchDir, env)) {
        console.error(`hunch: refusing to auto-commit private memory at "${hunchDir}" — an unsafe Git attributes source could transform memory bytes. Nothing was staged, committed, or pushed.`);
        return null;
      }
      const paths = committableOverlayJsonPaths(hunchDir);
      if (!paths) return null;
      // Force-add only the exact contained JSON source-of-truth allowlist. A
      // remote .gitignore, local info/exclude, or ambient excludesFile must not
      // be able to silently stop the shared graph's heartbeat.
      for (let index = 0; index < paths.length; index += 128) {
        if (!run(["-c", `core.attributesFile=${gitNullDevice()}`, "add", "-f", "--", ...paths.slice(index, index + 128)])) {
          run(["reset", "-q", "--", "."]);
          return null;
        }
      }
    } else {
      run(["add", "--", "."]);
    }
    // SAFETY BACKSTOP (critical — bug_overlay_clobber): a memory sync is PURELY ADDITIVE small
    // JSON. If the staged set contains a DELETION, rename, or any non-.json file, hunchDir is NOT
    // a clean overlay store — most dangerously, the overlay was never its own git repo so `git -C`
    // walked UP to the PROJECT repo. Committing/pushing there would overwrite/delete the user's
    // code (we shipped exactly this). Refuse hard: unstage and bail without committing or pushing.
    const memoryPaths = stagedMemoryPaths(hunchDir, env);
    if (memoryPaths === null) {
      try { execFileSync("git", ["-C", hunchDir, "reset", "-q", "--", "."], { stdio: "ignore", env }); } catch { /* best-effort unstage */ }
      // Public-store commits (push:false) skip QUIETLY: a non-memory staged set there is
      // usually just the user's own staged work, not a misconfigured overlay — the record
      // stays on disk and the next flush's `git add .` sweeps it up. The overlay path
      // stays loud: there it signals the escaped-to-project-repo misconfiguration.
      if (opts.push !== false) {
        console.error(`hunch: refusing to auto-commit memory at "${hunchDir}" — the staged change includes deletions or non-memory files, so this is not a clean overlay repo. Nothing was committed or pushed. (Use \`hunch shared --repo <url>\` so the overlay is its OWN git repo.)`);
      }
      return null;
    }
    if (memoryPaths.length === 0) return null;
    // Grounding docs refreshed by this capture ride the same memory commit, so committed record
    // counts can never go stale (the refresh-counts treadmill: every capture commit bumped the
    // count and re-staled the docs for the next release-gate clean-tree check). Staged AFTER the
    // memory-only backstop on purpose: alsoStage is a code-controlled list of generated grounding
    // docs the caller verified git-clean BEFORE rewriting, so it can neither weaken the
    // bug_overlay_clobber detection above nor sweep user edits.
    for (const file of opts.alsoStage ?? []) {
      run(opts.push === false
        ? ["add", "--", file]
        : ["-c", `core.attributesFile=${gitNullDevice()}`, "add", "--", file]);
    }
    // Only sync+push when a memory commit was actually created — never run pull/push against the
    // enclosing repo on an empty stage. Two-way sync: MERGE the remote BEFORE pushing so a push
    // can't be rejected non-fast-forward; the .hunch merge driver resolves same-record conflicts
    // by id. On conflict/offline, mergeRemote aborts to a clean tree and we skip the push.
    let committed = false;
    // `git commit` without pathspecs commits the ENTIRE index. Even after the
    // staged-set check, another process (or a pre-staged JSON file) could enter
    // the index before commit. `--only` makes the mutation boundary mechanical:
    // commit this Hunch tree plus the caller-vetted grounding files, and leave
    // every unrelated staged byte untouched.
    // Commit an exact path allowlist. A hook or concurrent index writer cannot
    // smuggle local.json (or any other path) into a broad `--only -- .` commit.
    // Hooks are disabled for this machine-generated commit; user hooks are an
    // untrusted mutation seam and are unnecessary for JSON memory artifacts.
    const hooksDir = disabledHooksDir(hunchDir);
    if (!hooksDir) return null;
    const commitPaths = [...memoryPaths, ...(opts.alsoStage ?? [])];
    try {
      execFileSync("git", [
        "-C", hunchDir,
        "-c", `core.hooksPath=${hooksDir}`,
        ...(opts.push === false ? [] : ["-c", `core.attributesFile=${gitNullDevice()}`]),
        "-c", "commit.gpgsign=false",
        "commit", "--no-gpg-sign", "--only", "-m", message, "--", ...commitPaths,
      ], { stdio: "ignore", env, timeout: 15_000 });
      committed = true;
    } catch { /* nothing staged / not a repo */ }
    if (!committed) return null;
    if (opts.push !== false) {
      // The overlay remote is mutable process state. Re-prove the publication
      // boundary after the local commit and BEFORE pull: hooks or another
      // process may have re-pointed it since the pre-staging check.
      if (unsafeOverlayPublication(hunchDir, opts.protectedRepoRoot)) {
        console.error(`hunch: private memory was committed locally, but the overlay publication boundary changed before sync. Nothing was pulled or pushed.`);
        return "committed";
      }
      if (!contractReady(opts.remote)
        || mergeRemote(hunchDir, env, CAPTURE_REMOTE_TIMEOUT_MS, opts.remote) === "failed") return "committed";
      // Hooks are disabled in the merge seam, but another process can still
      // rewrite Git configuration. Check once after merge and once at the
      // actual push seam; either refusal leaves the private commit local.
      if (unsafeOverlayPublication(hunchDir, opts.protectedRepoRoot) || !contractReady(opts.remote)) {
        console.error(`hunch: private memory was committed locally, but the overlay publication boundary changed during sync. Nothing was pushed.`);
        return "committed";
      }
      // Push tracked (not via run): a no-upstream/offline/rejected push must report
      // "committed", not overclaim "pushed" — the next flush's merge+push retries.
      if (unsafeOverlayPublication(hunchDir, opts.protectedRepoRoot) || !contractReady(opts.remote)) return "committed";
      if (pushWithOneRemoteAdvanceRetry(hunchDir, env, opts.protectedRepoRoot, CAPTURE_REMOTE_TIMEOUT_MS, opts.remote)) return "pushed";
    }
    return "committed";
  } finally {
    try { rmSync(lock, { recursive: true, force: true }); } catch { /* released best-effort */ }
  }
}

/** True when `rel` is tracked with no staged or unstaged changes (untracked counts as
 *  dirty, so a doc the user never committed is never swept into a memory commit). */
export function isGitCleanPath(root: string, rel: string): boolean {
  try {
    return execFileSync("git", ["-C", root, "status", "--porcelain", "--", rel], {
      encoding: "utf8",
      env: foreignRepoEnv(process.env),
    }).trim() === "";
  } catch {
    return false;
  }
}

/** Is the staged set a clean, MEMORY-ONLY change — only JSON record adds/updates, nothing else?
 *  The overlay store is entirely JSON (decisions/, bugs/, …, manifest.json). A real memory sync
 *  is purely additive; a DELETION, rename, or any non-.json staged path means hunchDir is NOT a
 *  clean overlay repo (e.g. it resolved to the project repo), so committing there would clobber
 *  code. Empty stage ⇒ [] (nothing to commit); invalid stage ⇒ null. The transient mkdir lock is ignored. */
function stagedMemoryPaths(hunchDir: string, env: NodeJS.ProcessEnv): string[] | null {
  let out = "";
  let prefix = "";
  try { prefix = execFileSync("git", ["-C", hunchDir, "rev-parse", "--show-prefix"], { encoding: "utf8", env }).trim().replace(/\\/g, "/"); }
  catch { return null; }
  if (!prefix) return null; // a Hunch layout is a scoped subdirectory, never the whole repository
  try { out = execFileSync("git", ["-C", hunchDir, "diff", "--cached", "--no-ext-diff", "--no-textconv", "--name-status"], { encoding: "utf8", env }); }
  catch { return null; }
  const lines = out.split("\n").map((l) => l.trim()).filter(Boolean);
  if (!lines.length) return [];
  const memoryPaths: string[] = [];
  for (const line of lines) {
    const parts = line.split("\t");
    const status = (parts[0] ?? "").trim();
    const path = (parts[parts.length - 1] ?? "").trim();
    if (path.includes(".hunch-commit.lock")) continue; // transient lock dir, never a record
    if (!/^[AM]$/.test(status)) return null; // only Add / Modify — any D/R/C/T → not a memory sync
    const normalizedPath = path.replace(/\\/g, "/");
    if (!normalizedPath.startsWith(prefix)) return null; // never bless another staged JSON file
    const memoryRelativePath = normalizedPath.slice(prefix.length);
    if (!memoryRelativePath || memoryRelativePath === "local.json") return null; // machine-local overlay pointer; never publish it
    if (!normalizedPath.endsWith(".json")) return null; // the store is entirely JSON records
    memoryPaths.push(memoryRelativePath);
  }
  return [...new Set(memoryPaths)];
}

/** Enumerate ordinary JSON files already contained under an overlay. Push-capable
 * stores force-add this exact allowlist so remote .gitignore, info/exclude, or an
 * ambient excludesFile cannot silently stop the memory pump. Public push:false
 * stores intentionally keep ordinary Git ignore semantics after migration. */
function committableOverlayJsonPaths(hunchDir: string): string[] | null {
  try {
    const root = realpathSync(hunchDir);
    const paths: string[] = [];
    const walk = (dir: string, prefix = ""): boolean => {
      for (const entry of readdirSync(dir, { withFileTypes: true })) {
        if (!prefix && entry.name === ".hunch-commit.lock") continue;
        const absolute = join(dir, entry.name);
        const relative = prefix ? `${prefix}/${entry.name}` : entry.name;
        const stat = lstatSync(absolute);
        if (stat.isSymbolicLink()) return false;
        if (stat.isDirectory()) {
          if (!walk(absolute, relative)) return false;
        } else if (!stat.isFile()) {
          return false;
        } else if (relative.endsWith(".json") && relative !== "local.json") {
          if (!realpathSync(absolute).startsWith(`${root}/`)) return false;
          paths.push(relative);
        } else if (relative === "local.json") {
          return false;
        } else if (/^[^/]+\.sqlite[^/]*$/i.test(relative)
          || relative.split("/").some((segment) => segment.includes(".tmp"))
          || relative === "events.log") {
          // Known clone-local/derived artifacts are never staged. Everything
          // else is a topology violation: a shared graph repository cannot
          // quietly carry arbitrary source alongside its JSON memory.
          continue;
        } else {
          return false;
        }
      }
      return true;
    };
    return walk(root) ? paths.sort() : null;
  } catch {
    return null;
  }
}

/** True only when the checked-out Hunch tree has no staged, unstaged, untracked,
 *  or conflicted memory bytes. Remote sync must never use autostash: applying a
 *  stash can feed a user's uncommitted record through the structured merge driver
 *  and replace it with a higher-confidence remote record. */
function hunchWorktreeClean(hunchDir: string, env: NodeJS.ProcessEnv): boolean {
  try {
    return execFileSync("git", ["-C", hunchDir, "status", "--porcelain=v1", "--untracked-files=all", "--", "."], {
      encoding: "utf8",
      stdio: ["ignore", "pipe", "ignore"],
      env,
      timeout: 2_000,
    }).trim() === "";
  } catch {
    return false;
  }
}

function overlayGitTreeIsSafe(hunchDir: string, revision: string, env: NodeJS.ProcessEnv): boolean {
  if (!/^[0-9a-f]+$/i.test(revision)) return false;
  try {
    const listing = execFileSync("git", ["-C", hunchDir, "ls-tree", "--full-tree", "-r", "-t", "-z", revision], {
      encoding: "utf8",
      stdio: ["ignore", "pipe", "ignore"],
      env,
      timeout: 2_000,
      maxBuffer: 64 * 1024 * 1024,
    });
    return hunchTreeAttributesAreSafe(listing, (oid) => {
      try {
        return execFileSync("git", ["-C", hunchDir, "cat-file", "blob", oid], {
          encoding: "utf8",
          stdio: ["ignore", "pipe", "ignore"],
          env,
          timeout: 2_000,
          maxBuffer: 4 * 1024 * 1024,
        });
      } catch {
        return null;
      }
    });
  } catch {
    return false;
  }
}

const MAX_ATTRIBUTES_BYTES = 4 * 1024 * 1024;

function boundedAttributesFileIsSafe(file: string, expectedCanonicalPath: string): boolean {
  try {
    const stat = lstatSync(file);
    if (stat.isSymbolicLink() || !stat.isFile() || stat.nlink !== 1 || stat.size > MAX_ATTRIBUTES_BYTES) return false;
    if (!sameFilesystemEntry(file, expectedCanonicalPath)) return false;
    return hunchAttributesAreSafe(readFileSync(file, "utf8"));
  } catch (error) {
    return (error as NodeJS.ErrnoException).code === "ENOENT";
  }
}

function absoluteGitMetadataDir(cwd: string, env: NodeJS.ProcessEnv): string | null {
  try {
    const raw = execFileSync("git", ["-C", cwd, "rev-parse", "--absolute-git-dir"], {
      encoding: "utf8",
      stdio: ["ignore", "pipe", "ignore"],
      env,
      timeout: 2_000,
    }).trim();
    if (!raw) return null;
    const canonical = realpathSync(raw);
    const stat = lstatSync(canonical);
    return !stat.isSymbolicLink() && stat.isDirectory() ? canonical : null;
  } catch {
    return null;
  }
}

function overlayGitMetadataDir(hunchDir: string, env: NodeJS.ProcessEnv): string | null {
  try {
    const overlayRoot = dirname(realpathSync(hunchDir));
    const expected = realpathSync(join(overlayRoot, ".git"));
    const actual = absoluteGitMetadataDir(hunchDir, env);
    return actual && sameFilesystemEntry(actual, expected) ? expected : null;
  } catch {
    return null;
  }
}

/** Attribute sources not stored in the fetched tree can still influence Git's
 * clean/smudge pipeline. Validate the live root and nested Hunch attributes and
 * the otherwise-unavoidable $GIT_DIR/info/attributes before any add/merge/reset.
 * Global and system sources are separately disabled on the command itself. */
function overlayAttributeSourcesAreSafe(hunchDir: string, env: NodeJS.ProcessEnv): boolean {
  try {
    const canonicalHunch = realpathSync(hunchDir);
    const overlayRoot = dirname(canonicalHunch);
    if (canonicalHunch !== join(overlayRoot, ".hunch") || !safeOverlayTree(overlayRoot)) return false;
    const gitDir = overlayGitMetadataDir(hunchDir, env);
    if (!gitDir) return false;
    if (!boundedAttributesFileIsSafe(join(overlayRoot, ".gitattributes"), join(overlayRoot, ".gitattributes"))
      || !boundedAttributesFileIsSafe(join(gitDir, "info", "attributes"), join(gitDir, "info", "attributes"))) {
      return false;
    }
    const walk = (dir: string): boolean => {
      for (const entry of readdirSync(dir, { withFileTypes: true })) {
        if (dir === canonicalHunch && entry.name === ".hunch-commit.lock") continue;
        const path = join(dir, entry.name);
        const stat = lstatSync(path);
        if (stat.isSymbolicLink()) return false;
        if (stat.isDirectory()) {
          if (!walk(path)) return false;
        } else if (!stat.isFile()) {
          return false;
        } else if (entry.name === ".gitattributes"
          && !boundedAttributesFileIsSafe(path, path)) {
          return false;
        }
      }
      return true;
    };
    return walk(canonicalHunch);
  } catch {
    return false;
  }
}

const TEAM_FETCH_REF = "refs/hunch/team-sync";

function contractReady(contract?: HunchRemoteContract): boolean {
  if (!contract) return true;
  if (!contract.fetchUrl || !contract.pushUrl || !/^refs\/heads\/[A-Za-z0-9][A-Za-z0-9._/-]*$/.test(contract.ref)) {
    return false;
  }
  try { return contract.verify(); } catch { return false; }
}

/** Team network operations deliberately ignore process-level Git command/config
 * injection. Repository-local route overrides are rejected by the contract
 * verifier; these variables are the remaining ambient way to replace SSH or add
 * arbitrary `-c` entries between validation and use. */
function boundedTeamEnv(env: NodeJS.ProcessEnv): NodeJS.ProcessEnv {
  const bounded = foreignRepoEnv(env);
  for (const key of Object.keys(bounded)) {
    if (key === "GIT_SSH" || key === "GIT_SSH_COMMAND" || key === "GIT_CONFIG_PARAMETERS"
      || key === "GIT_CONFIG_COUNT" || /^GIT_CONFIG_(?:KEY|VALUE)_\d+$/.test(key)) {
      delete bounded[key];
    }
  }
  bounded.GIT_CONFIG_NOSYSTEM = "1";
  bounded.GIT_ATTR_NOSYSTEM = "1";
  bounded.GIT_ALLOW_PROTOCOL = "https:ssh:git:file";
  bounded.GIT_TERMINAL_PROMPT = "0";
  return bounded;
}

function disabledHooksDir(hunchDir: string): string | null {
  try {
    const gitDir = absoluteGitMetadataDir(hunchDir, foreignRepoEnv(process.env));
    if (!gitDir) return null;
    const hooksDir = join(gitDir, "hunch-disabled-hooks");
    mkdirSync(hooksDir, { recursive: true });
    const stat = lstatSync(hooksDir);
    if (stat.isSymbolicLink() || !stat.isDirectory() || realpathSync(hooksDir) !== hooksDir
      || readdirSync(hooksDir).length !== 0) return null;
    return hooksDir;
  } catch {
    return null;
  }
}

/** List every branch on the exact contract URL. A team graph has either zero
 * branches while bootstrapping or exactly its one canonical branch. */
function contractRemoteHeads(
  hunchDir: string,
  contract: HunchRemoteContract,
  direction: "fetch" | "push",
  env: NodeJS.ProcessEnv,
  timeoutMs: number,
): Array<{ oid: string; ref: string }> | null {
  if (!contractReady(contract)) return null;
  const url = direction === "fetch" ? contract.fetchUrl : contract.pushUrl;
  const hooksDir = disabledHooksDir(hunchDir);
  if (!hooksDir) return null;
  try {
    const out = execFileSync("git", [
      "-C", hunchDir,
      "-c", `core.hooksPath=${hooksDir}`,
      "ls-remote", "--refs", "--heads", "--upload-pack=git-upload-pack", url,
    ], {
      encoding: "utf8",
      stdio: ["ignore", "pipe", "ignore"],
      env: boundedTeamEnv(env),
      timeout: timeoutMs,
    });
    if (!contractReady(contract)) return null;
    const heads: Array<{ oid: string; ref: string }> = [];
    for (const line of out.split(/\r?\n/).filter(Boolean)) {
      const match = line.match(/^([0-9a-f]{40,64})\t(refs\/heads\/.+)$/i);
      if (!match) return null;
      heads.push({ oid: match[1]!, ref: match[2]! });
    }
    return heads;
  } catch {
    return null;
  }
}

function fetchContractRef(
  hunchDir: string,
  contract: HunchRemoteContract,
  env: NodeJS.ProcessEnv,
  timeoutMs: number,
): string {
  if (!contractReady(contract)) return "";
  const hooksDir = disabledHooksDir(hunchDir);
  if (!hooksDir) return "";
  try {
    execFileSync("git", [
      "-C", hunchDir,
      "-c", `core.hooksPath=${hooksDir}`,
      "fetch", "--no-tags", "--no-write-fetch-head", "--upload-pack=git-upload-pack",
      contract.fetchUrl, `+${contract.ref}:${TEAM_FETCH_REF}`,
    ], { stdio: "ignore", env: boundedTeamEnv(env), timeout: timeoutMs });
    if (!contractReady(contract)) return "";
    const oid = execFileSync("git", ["-C", hunchDir, "rev-parse", "--verify", TEAM_FETCH_REF], {
      encoding: "utf8", stdio: ["ignore", "pipe", "ignore"], env, timeout: 2_000,
    }).trim();
    return /^[0-9a-f]{40,64}$/i.test(oid) ? oid : "";
  } catch {
    return "";
  }
}

function setContractUpstream(hunchDir: string, contract: HunchRemoteContract, env: NodeJS.ProcessEnv): boolean {
  try {
    const branch = execFileSync("git", ["-C", hunchDir, "symbolic-ref", "--quiet", "--short", "HEAD"], {
      encoding: "utf8", stdio: ["ignore", "pipe", "ignore"], env, timeout: 2_000,
    }).trim();
    if (!branch) return false;
    const remoteBranch = contract.ref.slice("refs/heads/".length);
    let oid = gitSafeWithEnv(["rev-parse", "--verify", TEAM_FETCH_REF], hunchDir, env);
    if (!oid) oid = headShaWithEnv(hunchDir, env);
    if (!oid || !remoteBranch) return false;
    execFileSync("git", ["-C", hunchDir, "update-ref", `refs/remotes/origin/${remoteBranch}`, oid], {
      stdio: "ignore", env, timeout: 2_000,
    });
    execFileSync("git", ["-C", hunchDir, "config", `branch.${branch}.remote`, "origin"], { stdio: "ignore", env, timeout: 2_000 });
    execFileSync("git", ["-C", hunchDir, "config", `branch.${branch}.merge`, contract.ref], { stdio: "ignore", env, timeout: 2_000 });
    return contractReady(contract);
  } catch {
    return false;
  }
}

/** A fresh clone of an empty remote has no HEAD, but auto-wiring creates the
 * default manifest before another teammate may publish first. That one generated
 * file is safe to replace with the now-canonical remote tree; any actual record or
 * other dirty path makes bootstrap fail closed. */
function unbornBootstrapFingerprint(hunchDir: string, env: NodeJS.ProcessEnv): string | null {
  try {
    const status = execFileSync("git", ["-C", hunchDir, "status", "--porcelain=v1", "--untracked-files=all", "--", "."], {
      encoding: "utf8", stdio: ["ignore", "pipe", "ignore"], env, timeout: 2_000,
    }).trim();
    const lines = status ? status.split(/\r?\n/) : [];
    if (lines.some((line) => !/^\?\? (?:\.hunch\/)?manifest\.json$/.test(line.trim()))) return null;
    let manifest = "";
    try {
      manifest = readFileSync(join(hunchDir, "manifest.json"), "utf8");
      const value = JSON.parse(manifest) as unknown;
      if (!value || Array.isArray(value) || typeof value !== "object"
        || Object.keys(value as Record<string, unknown>).some((key) => key !== "schema_version")
        || typeof (value as { schema_version?: unknown }).schema_version !== "number") return null;
    } catch {
      if (lines.length) return null;
    }
    return createHash("sha256").update(status).update("\0").update(manifest).digest("hex");
  } catch {
    return null;
  }
}

function adoptContractHead(
  hunchDir: string,
  fetchedHead: string,
  contract: HunchRemoteContract,
  env: NodeJS.ProcessEnv,
  fingerprint: string,
): boolean {
  if (unbornBootstrapFingerprint(hunchDir, env) !== fingerprint || !contractReady(contract)) return false;
  const hooksDir = disabledHooksDir(hunchDir);
  if (!hooksDir) return false;
  const manifest = join(hunchDir, "manifest.json");
  const backup = join(hunchDir, ".hunch-commit.lock", "bootstrap-manifest.json");
  let moved = false;
  try {
    try { renameSync(manifest, backup); moved = true; } catch { /* absent default manifest */ }
    execFileSync("git", [
      "-C", hunchDir,
      "-c", `core.hooksPath=${hooksDir}`,
      "-c", `core.attributesFile=${gitNullDevice()}`,
      "reset", "--hard", fetchedHead,
    ], {
      stdio: "ignore", env, timeout: 5_000,
    });
    return overlayGitTreeIsSafe(hunchDir, headShaWithEnv(hunchDir, env), env)
      && overlayAttributeSourcesAreSafe(hunchDir, env);
  } catch {
    if (moved) {
      try { renameSync(backup, manifest); } catch { /* leave the durable backup under the lock */ }
    }
    return false;
  } finally {
    if (moved) try { rmSync(backup, { force: true }); } catch { /* lock cleanup is the final backstop */ }
  }
}

/** Fetch and merge the overlay's remote while preserving the live checkout boundary.
 *  Fetch changes only unserved refs/objects. Before an exact fetched OID can reach the
 *  worktree, its complete Git tree is validated as ordinary contained entries with the
 *  canonical Hunch topology. The current checkout is also clean + safe before fetch and
 *  rechecked immediately before mutation. Hooks are disabled for the machine sync. */
type RemoteMergeStatus = "merged" | "unconfigured" | "failed";

function mergeRemote(
  hunchDir: string,
  env: NodeJS.ProcessEnv,
  timeoutMs: number,
  contract?: HunchRemoteContract,
  allowUnrelatedHistories = false,
): RemoteMergeStatus {
  env = machineCommitEnv(hunchDir, env);
  env.GIT_ATTR_NOSYSTEM = "1";
  let overlayRoot = "";
  try { overlayRoot = dirname(realpathSync(hunchDir)); } catch { return "failed"; }
  if (!isGitRepoRoot(overlayRoot) || !safeOverlayTree(overlayRoot)
    || !overlayAttributeSourcesAreSafe(hunchDir, env) || !contractReady(contract)) {
    return "failed";
  }
  const localHead = headShaWithEnv(hunchDir, env);
  const unbornFingerprint = localHead ? null : unbornBootstrapFingerprint(hunchDir, env);
  if (localHead ? !hunchWorktreeClean(hunchDir, env) : !unbornFingerprint) return "failed";
  const hooksDir = disabledHooksDir(hunchDir);
  if (!hooksDir) return "failed";
  const tryGit = (args: string[], timeout = timeoutMs): boolean => {
    try {
      execFileSync("git", [
        "-C", hunchDir,
        "-c", `core.hooksPath=${hooksDir}`,
        "-c", `core.attributesFile=${gitNullDevice()}`,
        "-c", "commit.gpgsign=false",
        ...args,
      ], {
        stdio: "ignore", env, timeout,
      });
      return true;
    }
    catch { return false; }
  };
  let fetchedHead = "";
  if (contract) {
    const heads = contractRemoteHeads(hunchDir, contract, "fetch", env, timeoutMs);
    if (!heads) return "failed";
    if (heads.length === 0) return "unconfigured";
    if (heads.length !== 1 || heads[0]!.ref !== contract.ref) return "failed";
    fetchedHead = fetchContractRef(hunchDir, contract, env, timeoutMs);
  } else {
    if (!tryGit(["rev-parse", "--abbrev-ref", "@{upstream}"], 2_000)) return "unconfigured";
    if (!tryGit(["fetch", "--no-tags"])) return "failed";
    fetchedHead = upstreamSha(hunchDir, env);
  }
  if (!fetchedHead || !overlayGitTreeIsSafe(hunchDir, fetchedHead, env)) return "failed";
  // Another process need not honor Hunch's lock. Re-prove both the exact local
  // revision and the filesystem boundary after the network operation, before
  // Git is permitted to materialize the already-validated fetched tree.
  if (headShaWithEnv(hunchDir, env) !== localHead
    || !safeOverlayTree(overlayRoot)
    || !overlayAttributeSourcesAreSafe(hunchDir, env)
    || (localHead ? !hunchWorktreeClean(hunchDir, env) : unbornBootstrapFingerprint(hunchDir, env) !== unbornFingerprint)
    || (localHead && !overlayGitTreeIsSafe(hunchDir, localHead, env))
    || !contractReady(contract)) return "failed";
  // Canonicalize local branch/upstream metadata before the worktree mutation.
  // If this fails, the exact fetched tree has not been materialized yet.
  if (contract && !setContractUpstream(hunchDir, contract, env)) return "failed";
  if (!localHead && contract && unbornFingerprint) {
    return adoptContractHead(hunchDir, fetchedHead, contract, env, unbornFingerprint) ? "merged" : "failed";
  }
  if (tryGit(["merge", "--no-edit", ...(allowUnrelatedHistories ? ["--allow-unrelated-histories"] : []), fetchedHead])) {
    return safeOverlayTree(overlayRoot)
      && overlayAttributeSourcesAreSafe(hunchDir, env)
      && contractReady(contract)
      && overlayGitTreeIsSafe(hunchDir, headShaWithEnv(hunchDir, env), env)
      ? "merged"
      : "failed";
  }
  tryGit(["merge", "--abort"], 2_000); // conflict/timeout → restore a clean tree
  return "failed";
}

function upstreamSha(hunchDir: string, env: NodeJS.ProcessEnv): string {
  try {
    return execFileSync("git", ["-C", hunchDir, "rev-parse", "@{upstream}"], {
      encoding: "utf8",
      stdio: ["ignore", "pipe", "ignore"],
      env,
      timeout: 2_000,
    }).trim();
  } catch {
    return "";
  }
}

function tryPush(hunchDir: string, env: NodeJS.ProcessEnv, timeoutMs: number, contract?: HunchRemoteContract): boolean {
  if (!contractReady(contract)) return false;
  const hooksDir = disabledHooksDir(hunchDir);
  if (!hooksDir) return false;
  try {
    if (contract && !setContractUpstream(hunchDir, contract, env)) return false;
    const args = contract
      ? ["-C", hunchDir, "-c", `core.hooksPath=${hooksDir}`, "push", "--receive-pack=git-receive-pack", contract.pushUrl, `HEAD:${contract.ref}`]
      : ["-C", hunchDir, "-c", `core.hooksPath=${hooksDir}`, "push"];
    execFileSync("git", args, { stdio: "ignore", env: contract ? boundedTeamEnv(env) : env, timeout: timeoutMs });
    return contractReady(contract);
  } catch {
    return false;
  }
}

/** Publish an unborn/untracked local branch to a genuinely empty shared remote
 *  and establish its upstream. This path is deliberately narrower than a generic
 *  `push -u`: it selects only an explicit configured push remote (or the sole
 *  remote), proves that remote has no refs, snapshots its identity across the
 *  network check, and uses a non-force push so a concurrent first writer wins
 *  safely instead of being overwritten. */
function establishEmptyRemoteUpstream(
  hunchDir: string,
  env: NodeJS.ProcessEnv,
  protectedRepoRoot: string,
  timeoutMs: number,
  contract?: HunchRemoteContract,
): boolean {
  if (unsafeOverlayPublication(hunchDir, protectedRepoRoot)
    || !hunchWorktreeClean(hunchDir, env)
    || !contractReady(contract)) return false;
  if (contract) {
    const heads = contractRemoteHeads(hunchDir, contract, "push", env, timeoutMs);
    if (!heads || heads.length !== 0 || !contractReady(contract)) return false;
    // Exact URL + exact canonical ref + non-force push. If another teammate wins
    // the first-writer race after the empty proof, Git rejects this safely and the
    // bounded retry path fetches/merges that winner.
    return tryPush(hunchDir, env, timeoutMs, contract);
  }
  let branch = "";
  let remotes: string[] = [];
  let preferred = "";
  try {
    branch = execFileSync("git", ["-C", hunchDir, "symbolic-ref", "--quiet", "--short", "HEAD"], {
      encoding: "utf8", stdio: ["ignore", "pipe", "ignore"], env, timeout: 2_000,
    }).trim();
    remotes = execFileSync("git", ["-C", hunchDir, "remote"], {
      encoding: "utf8", stdio: ["ignore", "pipe", "ignore"], env, timeout: 2_000,
    }).split("\n").map((remote) => remote.trim()).filter(Boolean);
    preferred = execFileSync("git", ["-C", hunchDir, "config", "--get", "remote.pushDefault"], {
      encoding: "utf8", stdio: ["ignore", "pipe", "ignore"], env, timeout: 2_000,
    }).trim();
  } catch {
    // A missing remote.pushDefault is normal; choose the sole remote below.
  }
  const remote = preferred && remotes.includes(preferred)
    ? preferred
    : remotes.length === 1 ? remotes[0]! : "";
  if (!branch || !remote) return false;

  const pushIdentity = (): string => {
    try {
      const url = execFileSync("git", ["-C", hunchDir, "remote", "get-url", "--push", remote], {
        encoding: "utf8", stdio: ["ignore", "pipe", "ignore"], env, timeout: 2_000,
      }).trim();
      return remoteIdentity(url, hunchDir);
    } catch {
      return "";
    }
  };
  const before = pushIdentity();
  if (!before) return false;
  try {
    const refs = execFileSync("git", ["-C", hunchDir, "ls-remote", "--refs", remote], {
      encoding: "utf8",
      stdio: ["ignore", "pipe", "ignore"],
      env,
      timeout: timeoutMs,
    }).trim();
    if (refs) return false;
  } catch {
    return false;
  }
  if (unsafeOverlayPublication(hunchDir, protectedRepoRoot)
    || !hunchWorktreeClean(hunchDir, env)
    || pushIdentity() !== before) return false;
  try {
    const hooksDir = disabledHooksDir(hunchDir);
    if (!hooksDir) return false;
    execFileSync("git", ["-C", hunchDir, "-c", `core.hooksPath=${hooksDir}`, "push", "--set-upstream", remote, `HEAD:refs/heads/${branch}`], {
      stdio: "ignore",
      env,
      timeout: timeoutMs,
    });
    return true;
  } catch {
    return false;
  }
}

/** Push once, then retry exactly once only when a bounded pull proves the upstream
 *  advanced during the first push seam. Offline/auth/hook failures with an unchanged
 *  upstream never loop, and every remote mutation re-proves the publication boundary. */
function pushWithOneRemoteAdvanceRetry(
  hunchDir: string,
  env: NodeJS.ProcessEnv,
  protectedRepoRoot: string,
  timeoutMs: number,
  contract?: HunchRemoteContract,
): boolean {
  if (unsafeOverlayPublication(hunchDir, protectedRepoRoot) || !contractReady(contract)) return false;
  const before = contract
    ? gitSafeWithEnv(["rev-parse", "--verify", TEAM_FETCH_REF], hunchDir, env)
    : upstreamSha(hunchDir, env);
  if (!before) return establishEmptyRemoteUpstream(hunchDir, env, protectedRepoRoot, timeoutMs, contract);
  if (tryPush(hunchDir, env, timeoutMs, contract)) return true;
  if (unsafeOverlayPublication(hunchDir, protectedRepoRoot) || !contractReady(contract)) return false;
  const merged = mergeRemote(hunchDir, env, timeoutMs, contract);
  const after = contract
    ? gitSafeWithEnv(["rev-parse", "--verify", TEAM_FETCH_REF], hunchDir, env)
    : upstreamSha(hunchDir, env);
  if (merged !== "merged" || !before || !after || before === after) return false;
  if (unsafeOverlayPublication(hunchDir, protectedRepoRoot) || !contractReady(contract)) return false;
  return tryPush(hunchDir, env, timeoutMs, contract);
}

/** Best-effort READ-side sync: merge the overlay's remote into the local branch (e.g. on MCP
 *  server start or at a long-lived MCP request boundary) so this machine/session sees other
 *  machines' memory. Never throws; leaves a clean tree. Serialized with the commit lock so it
 *  can't race a concurrent flush. Returns true only when the checked-out memory HEAD moved,
 *  allowing callers to avoid rebuilding the derived SQLite index after a no-op pull. */
export type HunchPullStatus = "updated" | "current" | "busy" | "failed" | "unconfigured";

export interface PullHunchOptions {
  timeoutMs?: number;
  env?: NodeJS.ProcessEnv;
  remote?: HunchRemoteContract;
  /** Setup-only convergence for an existing standalone memory repository. */
  allowUnrelatedHistories?: boolean;
}

export function pullHunchStatus(hunchDir: string, opts: PullHunchOptions = {}): HunchPullStatus {
  const env = foreignRepoEnv({
    ...process.env,
    ...opts.env,
    HUNCH_SYNC: "1",
    GIT_TERMINAL_PROMPT: "0",
    GIT_MERGE_AUTOEDIT: "no",
  });
  const before = headShaWithEnv(hunchDir, env);
  const lock = join(hunchDir, ".hunch-commit.lock");
  if (acquireCommitLock(lock).state !== "acquired") return "busy";
  try {
    const merged = mergeRemote(hunchDir, env, opts.timeoutMs ?? READ_REMOTE_TIMEOUT_MS, opts.remote, opts.allowUnrelatedHistories ?? false);
    if (merged === "failed" || merged === "unconfigured" || !contractReady(opts.remote)) {
      return merged === "unconfigured" ? merged : "failed";
    }
    return headShaWithEnv(hunchDir, env) !== before ? "updated" : "current";
  } finally {
    try { rmSync(lock, { recursive: true, force: true }); } catch { /* released best-effort */ }
  }
}

export function pullHunch(hunchDir: string): boolean {
  return pullHunchStatus(hunchDir) === "updated";
}

/** Explicit retry path for a clean overlay that already has a local memory commit
 *  stranded by an earlier offline/rejected push. Unlike commitAndPushHunch this
 *  creates no commit: it only converges and publishes existing overlay history. */
export function syncExistingHunch(
  hunchDir: string,
  protectedRepoRoot: string,
  timeoutMs = CAPTURE_REMOTE_TIMEOUT_MS,
  remote?: HunchRemoteContract,
): "pushed" | "current" | "failed" {
  if (unsafeOverlayPublication(hunchDir, protectedRepoRoot) || !contractReady(remote)) return "failed";
  const lock = join(hunchDir, ".hunch-commit.lock");
  if (acquireCommitLock(lock).state !== "acquired") return "failed";
  try {
    const env = foreignRepoEnv({
      ...process.env,
      HUNCH_SYNC: "1",
      GIT_TERMINAL_PROMPT: "0",
      GIT_MERGE_AUTOEDIT: "no",
    });
    const merged = mergeRemote(hunchDir, env, timeoutMs, remote);
    if (merged === "failed" || unsafeOverlayPublication(hunchDir, protectedRepoRoot) || !contractReady(remote)) return "failed";
    if (merged === "unconfigured") {
      return pushWithOneRemoteAdvanceRetry(hunchDir, env, protectedRepoRoot, timeoutMs, remote) ? "pushed" : "failed";
    }
    const upstream = remote
      ? gitSafeWithEnv(["rev-parse", "--verify", TEAM_FETCH_REF], hunchDir, env)
      : upstreamSha(hunchDir, env);
    if (!upstream) return "failed";
    let ahead = false;
    try {
      ahead = execFileSync("git", ["-C", hunchDir, "rev-list", "--count", `${upstream}..HEAD`], {
        encoding: "utf8",
        stdio: ["ignore", "pipe", "ignore"],
        env,
        timeout: 2_000,
      }).trim() !== "0";
    } catch {
      return "failed";
    }
    if (!ahead) return "current";
    return pushWithOneRemoteAdvanceRetry(hunchDir, env, protectedRepoRoot, timeoutMs, remote) ? "pushed" : "failed";
  } finally {
    try { rmSync(lock, { recursive: true, force: true }); } catch { /* released best-effort */ }
  }
}

type CommitLockAttempt =
  | { state: "acquired" }
  | { state: "held-live"; ownerPid: number }
  | { state: "held-unknown" };

const UNKNOWN_LOCK_STALE_MS = 10 * 60_000;

function createOwnedCommitLock(lock: string): boolean {
  let created = false;
  try {
    // mkdir is the exclusive atomic operation here. Renaming a staged directory
    // is NOT exclusive on POSIX: it may replace an already-existing empty lock
    // directory, which would steal a fresh legacy/ownerless lock. There is a
    // harmless ownerless window between these two mkdir calls; contenders treat
    // it as held until the conservative legacy TTL expires.
    mkdirSync(lock);
    created = true;
    // Empty directories are not Git worktree entries, so owner metadata cannot
    // be staged by the memory-only `git add .` seam.
    mkdirSync(join(lock, `owner-${process.pid}`));
    return true;
  } catch {
    // If the exclusive mkdir succeeded but owner creation somehow failed, only
    // this process can have created the still-ownerless directory. Remove it so
    // a transient local failure does not strand every writer for the full TTL.
    if (created && !commitLockOwner(lock)) {
      try { rmSync(lock, { recursive: true, force: true }); } catch { /* best effort */ }
    }
    return false;
  }
}

function commitLockOwner(lock: string): { name: string; pid: number } | null {
  try {
    for (const name of readdirSync(lock)) {
      const match = name.match(/^owner-([1-9][0-9]*)$/);
      if (match) return { name, pid: Number(match[1]) };
    }
  } catch { /* vanished or unreadable */ }
  return null;
}

function processIsAlive(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch (error) {
    return (error as NodeJS.ErrnoException).code === "EPERM";
  }
}

/** Atomic directory lock with PID ownership. A dead owner is recoverable
 * immediately; a legacy owner-less lock is reclaimed only after a TTL safely
 * above the longest bounded sync. The fixed reclaim directory serializes
 * competing crash recovery attempts and the owner is re-read after claiming. */
function acquireCommitLock(lock: string): CommitLockAttempt {
  if (createOwnedCommitLock(lock)) return { state: "acquired" };
  const observed = commitLockOwner(lock);
  if (observed && processIsAlive(observed.pid)) return { state: "held-live", ownerPid: observed.pid };

  let reclaimable = !!observed;
  if (!observed) {
    try { reclaimable = Date.now() - statSync(lock).mtimeMs > UNKNOWN_LOCK_STALE_MS; }
    catch {
      return createOwnedCommitLock(lock) ? { state: "acquired" } : { state: "held-unknown" };
    }
  }
  if (!reclaimable) return { state: "held-unknown" };

  const claim = join(lock, "reclaim");
  try { mkdirSync(claim); } catch { return { state: "held-unknown" }; }
  const current = commitLockOwner(lock);
  if ((observed && (!current || current.name !== observed.name || processIsAlive(current.pid)))
    || (!observed && current)) {
    try { rmSync(claim, { recursive: true, force: true }); } catch { /* best effort */ }
    return current && processIsAlive(current.pid)
      ? { state: "held-live", ownerPid: current.pid }
      : { state: "held-unknown" };
  }
  try { rmSync(lock, { recursive: true, force: true }); } catch { return { state: "held-unknown" }; }
  return createOwnedCommitLock(lock) ? { state: "acquired" } : { state: "held-unknown" };
}

function waitForCommitLockHandoff(
  lock: string,
  first: CommitLockAttempt,
  timeoutMs: number,
): boolean {
  if (first.state !== "held-live" || first.ownerPid === process.pid) return false;
  const deadline = Date.now() + timeoutMs;
  const sleeper = new Int32Array(new SharedArrayBuffer(4));
  let attempt: CommitLockAttempt = first;
  while (Date.now() < deadline) {
    if (attempt.state === "acquired") return true;
    if (attempt.state !== "held-live" || attempt.ownerPid === process.pid) return false;
    Atomics.wait(sleeper, 0, 0, Math.min(25, deadline - Date.now()));
    attempt = acquireCommitLock(lock);
  }
  return false;
}

export function headSha(cwd: string): string {
  return gitSafe(["rev-parse", "HEAD"], cwd);
}

/** HEAD for a repository that is not the invocation repository. Unlike
 * headSha, this deliberately ignores code-repo GIT_DIR/GIT_INDEX_FILE state
 * inherited from hooks. */
export function isolatedHeadSha(cwd: string): string {
  return gitSafeIsolated(["rev-parse", "HEAD"], cwd);
}

/** Stop tracking `paths` in git (remove from the INDEX only — keep the working-tree
 *  files). Used by `hunch private --migrate` to un-publish the .hunch memory tree
 *  without deleting it locally. `--ignore-unmatch` makes an already-untracked path a
 *  no-op rather than an error; best-effort (a non-repo dir just no-ops). */
export function gitUntrackCached(cwd: string, paths: string[]): void {
  if (paths.length === 0) return;
  try {
    execFileSync("git", ["-C", cwd, "rm", "-r", "--cached", "--quiet", "--ignore-unmatch", "--", ...paths], { stdio: "ignore" });
  } catch { /* best-effort: not a repo / nothing tracked */ }
}

/** Resolve any commit-ish (short sha / HEAD / branch) to a canonical full sha.
 *  Returns the input unchanged if it can't be resolved (e.g. not a git repo). */
export function revParse(ref: string, cwd: string): string {
  const r = ref.trim();
  return gitSafe(["rev-parse", "--verify", "--quiet", r], cwd) || r;
}

/** Path to the hooks dir (honors core.hooksPath / worktrees). */
export function hooksDir(cwd: string): string {
  const p = gitSafe(["rev-parse", "--git-path", "hooks"], cwd);
  return p || ".git/hooks";
}

export function gitDir(cwd: string): string {
  return gitSafe(["rev-parse", "--git-dir"], cwd) || ".git";
}

/** The SHARED git dir for the repo — identical across ALL linked worktrees (unlike
 *  `gitDir`, which is per-worktree). Absolute, so callers can anchor worktree-shared
 *  state (the private-overlay pointer) at one stable place. "" when not a git repo. */
export function gitCommonDir(cwd: string): string {
  const p = gitSafe(["rev-parse", "--git-common-dir"], cwd);
  if (!p) return "";
  return isAbsolute(p) ? p : resolve(cwd, p);
}

/** True when `cwd` is inside a LINKED worktree (not the main checkout): its own git
 *  dir differs from the shared common dir. Used by `hunch doctor` and setup messaging. */
export function isLinkedWorktree(cwd: string): boolean {
  const common = gitCommonDir(cwd);
  const own = gitSafe(["rev-parse", "--absolute-git-dir"], cwd);
  if (!common || !own) return false;
  // realpath BOTH before comparing: `--absolute-git-dir` is symlink-resolved while
  // gitCommonDir is not, so on macOS the main checkout would otherwise mismatch on
  // /var vs /private/var and falsely read as "linked".
  const norm = (p: string): string => { try { return realpathSync(p); } catch { return resolve(p); } };
  return norm(own) !== norm(common);
}

/** Current branch name (e.g. "main", "feat/x"), or "" in detached HEAD / non-repo.
 *  Stamped onto auto-captured decisions so branch-scoped work stays filterable. */
export function currentBranch(cwd: string): string {
  const b = gitSafe(["rev-parse", "--abbrev-ref", "HEAD"], cwd);
  return b === "HEAD" ? "" : b; // detached HEAD reports "HEAD" — treat as no branch
}

/** Files changed in a single commit. `--root` makes the initial commit (which
 *  has no parent) report its files as additions instead of returning nothing. */
export function commitFiles(sha: string, cwd: string): string[] {
  const out = gitSafe(["diff-tree", "--no-commit-id", "--name-only", "-r", "--root", sha], cwd);
  return out ? out.split("\n").filter(Boolean) : [];
}

/** Raw `git log` over `.hunch/`, paired with parseMemoryLog — the memory-move
 *  timeline (each commit that changed the graph). Newest first; empty on any error
 *  (no repo / no history), so the caller degrades to an empty timeline. */
export function gitMemoryLog(root: string, limit = 200): string {
  return gitSafe(
    ["log", `--max-count=${limit}`, "--no-color", `--format=${MEMLOG_FORMAT}`, "--name-status", "--", ".hunch/"],
    root,
  );
}

/** The diff of a single commit restricted to `.hunch/` — what one memory move
 *  actually changed, for the click-through popup. Empty on error. */
export function memoryMoveDiff(sha: string, root: string): string {
  return gitSafe(["show", "--no-color", "--format=%H%n%an%n%cI%n%s%n", sha, "--", ".hunch/"], root);
}

/** Push the current branch to its remote (the "approve-to-push" step — public
 *  memory rides the repo, so this is a plain branch push). Returns true on success;
 *  false when there is no upstream / offline / not a repo. */
export function pushCurrentBranch(root: string): boolean {
  try {
    execFileSync("git", ["-C", root, "push"], { stdio: "ignore" });
    return true;
  } catch {
    return false;
  }
}

const REVERTABLE_RECORD_DIRS = new Set([
  "components",
  "edges",
  "symbols",
  "decisions",
  "bugs",
  "constraints",
  "runbooks",
  "evidence",
  "corpora",
  "policies",
  "proofs",
  "plans",
  "dispositions",
  "shadow",
]);

const REVERTABLE_AUXILIARY_PATHS = new Set([
  ".hunch/manifest.json",
  ".hunch/config.json",
]);

const PARTIALLY_MANAGED_GROUNDING_PATHS = new Set([
  "AGENTS.md",
  "CLAUDE.md",
  ".github/copilot-instructions.md",
]);

const FULLY_MANAGED_GROUNDING_PATHS = new Set([
  ".cursor/rules/hunch.mdc",
  ".windsurf/rules/hunch.md",
]);

const HUNCH_GROUNDING_START = Buffer.from("<!-- HUNCH:START — auto-generated, do not edit by hand -->", "utf8");
const HUNCH_GROUNDING_END = Buffer.from("<!-- HUNCH:END -->", "utf8");
const HUNCH_GROUNDING_SENTINEL = Buffer.from("\0HUNCH-MANAGED-REGION\0", "utf8");
const MAX_REVERT_GROUNDING_BYTES = 8 * 1024 * 1024;
const REVERT_TRANSFORM_ATTRIBUTES = ["filter", "working-tree-encoding", "ident", "eol", "text", "crlf", "merge"];

type RegularBlob = { mode: "100644" | "100755"; oid: string };

function revertGitEnv(): NodeJS.ProcessEnv {
  const env = foreignRepoEnv(process.env);
  // A local refs/replace entry can make a safe-looking SHA behave like an
  // entirely different commit. Every inspection and the revert itself must see
  // the literal object graph the user named.
  env.GIT_NO_REPLACE_OBJECTS = "1";
  env.GIT_TERMINAL_PROMPT = "0";
  env.GIT_ATTR_NOSYSTEM = "1";
  return env;
}

function revertGitRaw(args: string[], root: string, env: NodeJS.ProcessEnv): string | null {
  try {
    return execFileSync("git", ["-C", root, ...args], {
      encoding: "utf8",
      maxBuffer: 64 * 1024 * 1024,
      stdio: ["ignore", "pipe", "ignore"],
      env,
      timeout: 5_000,
    });
  } catch {
    return null;
  }
}

function revertGit(args: string[], root: string, env: NodeJS.ProcessEnv): string {
  return revertGitRaw(args, root, env)?.trim() ?? "";
}

function regularBlobAt(ref: string, path: string, root: string, env: NodeJS.ProcessEnv): RegularBlob | null {
  const raw = revertGitRaw(["ls-tree", "-z", ref, "--", path], root, env);
  if (raw == null) return null;
  const tab = raw.indexOf("\t");
  if (tab < 0 || raw.slice(tab + 1) !== `${path}\0`) return null;
  const header = raw.slice(0, tab).match(/^(100644|100755) blob ([a-f0-9]{40,64})$/i);
  return header ? { mode: header[1] as RegularBlob["mode"], oid: header[2]! } : null;
}

function blobBytes(oid: string, root: string, env: NodeJS.ProcessEnv): Buffer | null {
  try {
    return execFileSync("git", ["-C", root, "cat-file", "blob", oid], {
      maxBuffer: MAX_REVERT_GROUNDING_BYTES,
      stdio: ["ignore", "pipe", "ignore"],
      env,
      timeout: 5_000,
    });
  } catch {
    return null;
  }
}

/** Preserve every byte outside Hunch's one well-formed managed region. These
 * documents contain user/team instructions too; reverting a capture must never
 * roll those bytes back merely because the same commit refreshed Hunch counts. */
function groundingEnvelope(blob: Buffer): Buffer | null {
  const start = blob.indexOf(HUNCH_GROUNDING_START);
  if (start < 0 || blob.indexOf(HUNCH_GROUNDING_START, start + HUNCH_GROUNDING_START.length) >= 0) return null;
  const end = blob.indexOf(HUNCH_GROUNDING_END, start + HUNCH_GROUNDING_START.length);
  if (end < 0 || blob.indexOf(HUNCH_GROUNDING_END, end + HUNCH_GROUNDING_END.length) >= 0) return null;
  return Buffer.concat([
    blob.subarray(0, start),
    HUNCH_GROUNDING_SENTINEL,
    blob.subarray(end + HUNCH_GROUNDING_END.length),
  ]);
}

function onlyManagedGroundingChanged(
  before: RegularBlob,
  after: RegularBlob,
  root: string,
  env: NodeJS.ProcessEnv,
): boolean {
  if (before.mode !== after.mode) return false;
  const beforeBytes = blobBytes(before.oid, root, env);
  const afterBytes = blobBytes(after.oid, root, env);
  if (!beforeBytes || !afterBytes) return false;
  const beforeEnvelope = groundingEnvelope(beforeBytes);
  const afterEnvelope = groundingEnvelope(afterBytes);
  return !!beforeEnvelope && !!afterEnvelope && beforeEnvelope.equals(afterEnvelope);
}

function hunchJsonKind(path: string): "record" | "auxiliary" | null {
  if (REVERTABLE_AUXILIARY_PATHS.has(path)) return "auxiliary";
  const match = path.match(/^\.hunch\/([^/]+)\/([A-Za-z0-9][A-Za-z0-9._-]*\.json)$/);
  if (!match || !REVERTABLE_RECORD_DIRS.has(match[1]!)) return null;
  if ((match[1] === "symbols" || match[1] === "edges") && match[2] !== "index.json") return null;
  return "record";
}

function pathsHaveTransformAttributes(paths: string[], root: string, env: NodeJS.ProcessEnv): boolean {
  if (!paths.length) return false;
  const raw = revertGitRaw(["check-attr", "-z", ...REVERT_TRANSFORM_ATTRIBUTES, "--", ...paths], root, env);
  if (raw == null) return true;
  const fields = raw.split("\0");
  if (fields.at(-1) === "") fields.pop();
  if (fields.length !== paths.length * REVERT_TRANSFORM_ATTRIBUTES.length * 3) return true;
  for (let index = 0; index < fields.length; index += 3) {
    const attribute = fields[index + 1];
    const value = fields[index + 2];
    if (!attribute || value == null || !REVERT_TRANSFORM_ATTRIBUTES.includes(attribute)) return true;
    if (value !== "unspecified" && value !== "unset") return true;
  }
  return false;
}

/** Is `sha` one exact, append-only public Hunch move that can be safely
 * reverted? The timeline is selected with a `.hunch/` pathspec, so a mixed
 * code+memory commit also appears there; validate the complete commit before
 * allowing `git revert` to touch the checkout. */
function revertableMemoryMove(sha: string, root: string): { commit: string; paths: string[] } | null {
  const env = revertGitEnv();
  // Accept an exact hexadecimal object id/unique abbreviation only. Resolving
  // HEAD, a branch, a rev expression, or an option-like string is outside the
  // CLI's `<sha>` contract and would make the selected target mutable/ambiguous.
  if (!/^[a-f0-9]{7,64}$/i.test(sha)) return null;
  const commit = revertGit(["rev-parse", "--verify", "--quiet", `${sha}^{commit}`], root, env);
  if (!/^[a-f0-9]{40,64}$/i.test(commit)) return null;

  // Revert is allowed only from a pristine checkout/index. Include untracked
  // paths: a successful revert followed by a later broad user commit must not
  // accidentally publish pre-existing local bytes as part of the undo.
  if (revertGitRaw(["status", "--porcelain=v1", "-z", "--untracked-files=all"], root, env) !== "") return null;

  const row = revertGit(["rev-list", "--parents", "-n", "1", commit], root, env)
    .split(/\s+/)
    .filter(Boolean);
  if (row[0] !== commit || row.length > 2) return null; // unknown or merge commit
  const parent = row[1] ?? null;
  try {
    execFileSync("git", ["-C", root, "merge-base", "--is-ancestor", commit, "HEAD"], { stdio: "ignore", env, timeout: 5_000 });
  } catch {
    return null; // never apply an unrelated/unpublished history fragment
  }

  const raw = revertGitRaw(["diff-tree", "--root", "--no-commit-id", "--name-status", "-r", "-z", commit], root, env);
  if (raw == null) return null;
  const fields = raw.split("\0").filter((field) => field !== "");
  let sawMemoryRecord = false;
  const paths: string[] = [];
  for (let index = 0; index < fields.length;) {
    const status = fields[index++]!;
    // A legitimate automatic memory move has exactly add/modify entries.
    // Deletions, renames, copies, type changes, and unknown status codes need a
    // future tombstone-aware protocol rather than an unrestricted Git revert.
    if (status !== "A" && status !== "M") return null;
    const path = fields[index++];
    if (!path) return null;
    paths.push(path);
    const parts = path.split("/");
    if (parts.some((part) => !part || part === "." || part === "..")) return null;
    const after = regularBlobAt(commit, path, root, env);
    if (!after) return null;
    const before = status === "M" && parent ? regularBlobAt(parent, path, root, env) : null;
    if (status === "M" && !before) return null;

    const memoryKind = hunchJsonKind(path);
    if (memoryKind) {
      sawMemoryRecord ||= memoryKind === "record";
      continue;
    }
    if (FULLY_MANAGED_GROUNDING_PATHS.has(path)) continue;
    if (PARTIALLY_MANAGED_GROUNDING_PATHS.has(path)) {
      // Newly-created partially managed docs can contain arbitrary user prose
      // outside the Hunch block. Only a proven managed-region refresh is safe.
      if (status !== "M" || !before || !onlyManagedGroundingChanged(before, after, root, env)) return null;
      continue;
    }
    return null;
  }
  // Manifest/config and grounding are auxiliary to a real graph mutation; they
  // can never make a routing-only or generated-doc-only commit revertable.
  if (!sawMemoryRecord || pathsHaveTransformAttributes(paths, root, env)) return null;
  return { commit, paths };
}

/** Revert one validated memory-only move locally (no push). Returns true on
 * success. Unsafe targets are refused before mutation; a conflicting revert is
 * aborted so the working tree is never left half-reverted. */
export function revertMemoryMove(sha: string, root: string): boolean {
  const target = revertableMemoryMove(sha, root);
  if (!target) return false;
  const env = revertGitEnv();
  try {
    // Recheck the clean boundary after target inspection to narrow the race
    // between validation and Git taking its own index lock.
    if (revertGitRaw(["status", "--porcelain=v1", "-z", "--untracked-files=all"], root, env) !== "") return false;
    if (pathsHaveTransformAttributes(target.paths, root, env)) return false;
    const hooksDir = disabledHooksDir(root);
    if (!hooksDir) return false;
    execFileSync("git", [
      "-C", root,
      "-c", `core.hooksPath=${hooksDir}`,
      "-c", "commit.gpgsign=false",
      "-c", "core.autocrlf=false",
      "-c", "core.eol=lf",
      "-c", "core.safecrlf=false",
      "revert", "--no-edit", "--no-gpg-sign", target.commit,
    ], { stdio: "ignore", env, timeout: 15_000 });
    return true;
  } catch {
    try {
      execFileSync("git", [
        "-C", root,
        "-c", "commit.gpgsign=false",
        "-c", "core.autocrlf=false",
        "-c", "core.eol=lf",
        "-c", "core.safecrlf=false",
        "revert", "--abort",
      ], { stdio: "ignore", env, timeout: 5_000 });
    } catch { /* nothing to abort */ }
    return false;
  }
}

/** Full metadata + changed files for a commit. */
export function commitMeta(sha: string, cwd: string): CommitMeta | null {
  const raw = gitSafe(["show", "-s", "--format=%H%x1f%h%x1f%s%x1f%b%x1f%an%x1f%aI", sha], cwd);
  if (!raw) return null;
  const [full = "", short = "", subject = "", body = "", author = "", date = ""] = raw.split("\x1f");
  return { sha: full, shortSha: short, subject, body, author, date, files: commitFiles(sha, cwd) };
}

export interface CommitFileChange {
  status: "added" | "modified" | "deleted" | "renamed" | "copied";
  before: string | null;
  after: string | null;
}

/** First-parent and exact blob seams for deterministic before/after analysis.
 * They never check out a ref or mutate the active worktree. */
export function firstParent(sha: string, cwd: string): string | null {
  const row = gitSafe(["rev-list", "--parents", "-n", "1", sha], cwd);
  const parts = row.split(/\s+/).filter(Boolean);
  return parts.length > 1 ? parts[1]! : null;
}

export function fileAtRef(ref: string, file: string, cwd: string): string | null {
  return gitRawSafe(["show", `${ref}:${file}`], cwd);
}

/** Name-status records for one commit, rename-aware and NUL-delimited so paths
 * with whitespace cannot corrupt the parser. */
export function commitChanges(sha: string, cwd: string): CommitFileChange[] {
  const raw = gitRawSafe(["diff-tree", "--root", "--no-commit-id", "--name-status", "-r", "-M", "-z", sha], cwd);
  if (raw == null) return [];
  const fields = raw.split("\0").filter((v) => v !== "");
  const out: CommitFileChange[] = [];
  for (let i = 0; i < fields.length;) {
    const code = fields[i++]!;
    const kind = code[0];
    if (kind === "R" || kind === "C") {
      const before = fields[i++] ?? null;
      const after = fields[i++] ?? null;
      if (before && after) out.push({ status: kind === "R" ? "renamed" : "copied", before, after });
      continue;
    }
    const file = fields[i++] ?? null;
    if (!file) continue;
    if (kind === "A") out.push({ status: "added", before: null, after: file });
    else if (kind === "D") out.push({ status: "deleted", before: file, after: null });
    else out.push({ status: "modified", before: file, after: file });
  }
  return out;
}

/** Machine-generated paths that carry no design "why" — lockfiles, build output,
 *  vendored deps, snapshots, source maps. Excluded from synthesis diffs via git
 *  pathspec BEFORE git assembles/orders the patch: a huge lockfile sorts ahead of
 *  src/ alphabetically and would otherwise eat the byte budget and truncate the
 *  real code change away. Exclude-only pathspecs are valid; `**` (glob magic)
 *  matches across directories AND at the repo root. (`*.lock` covers yarn / cargo
 *  / poetry / composer / Gemfile lockfiles.) */
const DIFF_NOISE = [
  ":(exclude,glob)**/package-lock.json",
  ":(exclude,glob)**/npm-shrinkwrap.json",
  ":(exclude,glob)**/pnpm-lock.yaml",
  ":(exclude,glob)**/go.sum",
  ":(exclude,glob)**/*.lock",
  ":(exclude,glob)**/dist/**",
  ":(exclude,glob)**/build/**",
  ":(exclude,glob)**/out/**",
  ":(exclude,glob)**/coverage/**",
  ":(exclude,glob)**/.next/**",
  ":(exclude,glob)**/node_modules/**",
  ":(exclude,glob)**/vendor/**",
  // the Hunch's OWN machine-generated records — re-synthesizing a commit that
  // wrote them would be circular noise, and they're large (JSON per record).
  ":(exclude,glob)**/.hunch/**",
  ":(exclude,glob)**/*.min.js",
  ":(exclude,glob)**/*.map",
  ":(exclude,glob)**/*.snap",
  ":(exclude,glob)**/__snapshots__/**",
  ":(exclude,glob)**/*.generated.*",
];

/** The unified diff for a commit, truncated to keep synthesis prompts bounded.
 *  Machine-generated noise (see DIFF_NOISE) is excluded so the model spends its
 *  budget on code that encodes intent, not on regenerated lockfiles/build output. */
export function commitDiff(sha: string, cwd: string, maxBytes = 60_000): string {
  const out = gitSafe(["show", sha, "--no-color", "--format=", "--unified=2", "--", ...DIFF_NOISE], cwd);
  return out.length > maxBytes ? out.slice(0, maxBytes) + "\n…(diff truncated)…" : out;
}

/** Number of commits touching a file in the last `days` (churn). */
export function fileChurn(file: string, cwd: string, days = 90): number {
  const out = gitSafe(["log", `--since=${days}.days.ago`, "--oneline", "--", file], cwd);
  return out ? out.split("\n").filter(Boolean).length : 0;
}

/** The most recent commit short-sha that touched a file. */
export function lastCommitForFile(file: string, cwd: string): string {
  const sha = gitSafe(["log", "-1", "--format=%h", "--", file], cwd);
  return sha ? `commit:${sha}` : "";
}

/** Full SHA of the commit that introduced a path. Unlike lastCommitForFile this
 * remains stable when lifecycle/proof updates later touch the same policy file. */
export function firstCommitForFile(file: string, cwd: string): string {
  // Deliberately do NOT use --follow: content-similar, immutable-ID JSON policy
  // files can be misclassified as renames of one another, moving valid_from to a
  // different policy's introduction commit.
  const added = gitSafe(["log", "--diff-filter=A", "--format=%H", "--", file], cwd)
    .split("\n").find(Boolean);
  if (added) return added;
  return gitSafe(["log", "--reverse", "--format=%H", "--", file], cwd).split("\n").find(Boolean) ?? "";
}

/** ISO author-date of the most recent commit touching a file ("" if none). */
export function lastChangeDate(file: string, cwd: string): string {
  return gitSafe(["log", "-1", "--format=%aI", "--", file], cwd);
}

/** Batched per-file git metrics for indexing: churn (commits touching the file in
 *  the last `days`; pass 0 to skip) and the most-recent commit (`commit:<sha>`).
 *
 *  Replaces the indexer's O(files) × 2 `git log` spawns — which dominate
 *  `hunch index` wall-time on a large repo, especially on Windows where process
 *  creation is costly — with ONE `git log` pass each. Only paths present in `want`
 *  are returned (every requested path gets an entry, defaulting to 0 / ""). */
export function fileGitMetrics(
  cwd: string,
  want: Iterable<string>,
  days = 90,
): Map<string, { churn: number; lastCommit: string }> {
  const out = new Map<string, { churn: number; lastCommit: string }>();
  for (const f of want) out.set(f, { churn: 0, lastCommit: "" });
  if (out.size === 0) return out;

  // churn — one windowed log; tally each wanted path's appearances (= commits).
  if (days > 0) {
    const raw = gitSafe(["log", `--since=${days}.days.ago`, "--name-only", "--format="], cwd);
    if (raw) {
      for (const line of raw.split("\n")) {
        const e = line && out.get(line);
        if (e) e.churn++;
      }
    }
  }

  // last commit — one newest-first log; the FIRST time a path appears is its most
  // recent commit. NUL-prefixed lines mark commit boundaries; the rest are paths.
  // 256MB buffer for the all-history name-only stream on large repos.
  const raw = gitSafe(["log", "--name-only", "--format=%x00%h"], cwd, 256 * 1024 * 1024);
  if (raw) {
    let remaining = out.size;
    let sha = "";
    for (const line of raw.split("\n")) {
      if (line.charCodeAt(0) === 0) { sha = line.slice(1); continue; }
      if (!line) continue;
      const e = out.get(line);
      if (e && !e.lastCommit && sha) {
        e.lastCommit = `commit:${sha}`;
        if (--remaining === 0) break; // every wanted path resolved — stop scanning
      }
    }
  }
  return out;
}

/** Files staged for commit (for `hunch check` pre-commit enforcement). */
export function stagedFiles(cwd: string): string[] {
  const out = gitSafe(["diff", "--cached", "--no-ext-diff", "--no-textconv", "--name-only", "--diff-filter=ACMR"], cwd);
  return out ? out.split("\n").filter(Boolean) : [];
}

/** Files changed anywhere in the working tree compared with HEAD: both staged
 * and unstaged tracked files, plus untracked files. This powers the local,
 * pre-commit Change Gate; it never mutates the index or asks an agent/model. */
export function workingFiles(cwd: string): string[] {
  const changed = gitSafe(["diff", "HEAD", "--no-ext-diff", "--no-textconv", "--name-only", "--diff-filter=ACMR"], cwd).split("\n").filter(Boolean);
  const untracked = gitSafe(["ls-files", "--others", "--exclude-standard"], cwd).split("\n").filter(Boolean);
  return [...new Set([...changed, ...untracked])].sort();
}

/** Does a ref resolve to a commit in this repo? Lets `--base` fail LOUDLY on an
 *  unfetched/typo'd ref instead of silently diffing against nothing (a vacuous
 *  CI pass), since the diff helpers below swallow git errors to "". */
export function revExists(ref: string, cwd: string): boolean {
  return gitSafe(["rev-parse", "--verify", "--quiet", `${ref}^{commit}`], cwd) !== "";
}

/** Files a PR/branch changes vs `base` (3-dot: changes on HEAD since the merge-base,
 *  i.e. exactly the PR's own commits — the CI Constraint Guard's surface). */
export function rangeFiles(base: string, cwd: string, head = "HEAD"): string[] {
  const out = gitSafe(["diff", "--no-ext-diff", "--no-textconv", "--name-only", "--diff-filter=ACMR", `${base}...${head}`], cwd);
  return out ? out.split("\n").filter(Boolean) : [];
}

/** Commit subjects on `head` since `base` (2-dot: commits added by the task),
 *  oldest-first, for distilling a runbook's ordered steps (roadmap #5). */
export function rangeSubjects(base: string, cwd: string, head = "HEAD", max = 50): string[] {
  const out = gitSafe(["log", "--reverse", `-n${max}`, "--format=%s", `${base}..${head}`], cwd);
  return out ? out.split("\n").filter(Boolean) : [];
}

/** The PR's unified diff vs `base` (3-dot), for the Regression Guard's structural
 *  analysis. Same noise-exclusion + truncation budget as commit/staged diffs. */
export function rangeDiff(base: string, cwd: string, head = "HEAD", maxBytes = 60_000): string {
  const out = gitSafe(["diff", "--no-ext-diff", "--no-textconv", "--no-color", "--unified=2", `${base}...${head}`, "--", ...DIFF_NOISE], cwd);
  return out.length > maxBytes ? out.slice(0, maxBytes) + "\n…(diff truncated)…" : out;
}

/** Unified diff of the staged changes (for the Regression Guard's structural
 *  analysis). Excludes machine-generated noise and truncates at the SAME budget as
 *  commitDiff, so the staged and `--commit` guard paths can't diverge on big diffs. */
export function stagedDiff(cwd: string, maxBytes = 60_000): string {
  const out = gitSafe(["diff", "--cached", "--no-ext-diff", "--no-textconv", "--no-color", "--unified=2", "--", ...DIFF_NOISE], cwd);
  return out.length > maxBytes ? out.slice(0, maxBytes) + "\n…(diff truncated)…" : out;
}

/** Unified diff of the complete local working tree vs HEAD. Git's normal diff
 * includes both staged and unstaged tracked edits; untracked text files are
 * appended as synthetic additions so guards can also see their added symbols.
 * Binary/unreadable files remain in workingFiles (scope checks still apply) but
 * intentionally contribute no synthetic content to regression analysis. */
export function workingDiff(cwd: string, maxBytes = 60_000): string {
  let out = gitSafe(["diff", "HEAD", "--no-ext-diff", "--no-textconv", "--no-color", "--unified=2", "--", ...DIFF_NOISE], cwd);
  const tracked = new Set(gitSafe(["diff", "HEAD", "--no-ext-diff", "--no-textconv", "--name-only", "--diff-filter=ACMR"], cwd).split("\n").filter(Boolean));
  const untracked = gitSafe(["ls-files", "--others", "--exclude-standard"], cwd).split("\n").filter((f) => f && !tracked.has(f));
  const readWorkingFile = createRepoFileReader(cwd);
  for (const file of untracked) {
    try {
      const text = readWorkingFile(file);
      if (text === null) continue;
      if (text.includes("\0")) continue;
      const lines = text.split("\n");
      const add = lines.map((line) => `+${line}`).join("\n");
      out += `${out ? "\n" : ""}diff --git a/${file} b/${file}\nnew file mode 100644\n--- /dev/null\n+++ b/${file}\n@@ -0,0 +1,${lines.length} @@\n${add}\n`;
    } catch { /* unreadable / directory / binary: scope-only is still safe */ }
  }
  return out.length > maxBytes ? out.slice(0, maxBytes) + "\n…(diff truncated)…" : out;
}

/** Resolve a time-travel ref (commit / tag / branch / HEAD~n) to the ISO author-
 *  date of that commit — the instant valid-time windows are filtered against.
 *  Undefined if it can't be resolved (not a git repo, or an unknown ref). Single
 *  source for the CLI and MCP as-of paths so they can't drift. */
export function asOfDate(ref: string, cwd: string): string | undefined {
  if (!isGitRepo(cwd)) return undefined;
  return commitMeta(revParse(ref, cwd), cwd)?.date || undefined;
}

/** Translate a backfill window spec into git-log window args.
 *   "90d" / bare "90" -> last 90 days   |   "40c" -> last 40 commits
 *   anything else      -> passed to --since as an approxidate/date string. */
function windowArgs(spec: string, max: number): string[] {
  if (/^\d+c$/i.test(spec)) return ["-n", spec.replace(/c$/i, "")];
  if (/^\d+d$/i.test(spec)) return [`--since=${spec.replace(/d$/i, "")} days ago`, "-n", String(max)];
  if (/^\d+$/.test(spec)) return [`--since=${spec} days ago`, "-n", String(max)];
  return [`--since=${spec}`, "-n", String(max)];
}

/** Recent commits (newest-first) for backfill. */
export function logSince(spec: string, cwd: string, max = 200): string[] {
  const out = gitSafe(["log", ...windowArgs(spec, max), "--format=%H"], cwd);
  return out ? out.split("\n").filter(Boolean) : [];
}

/** Commits that look like bug fixes (for backfill bug seeding). */
export function fixCommits(spec: string, cwd: string, max = 200): string[] {
  const out = gitSafe(
    ["log", ...windowArgs(spec, max), "--format=%H", "--grep=fix", "--grep=bug", "--grep=hotfix", "-i"],
    cwd,
  );
  return out ? out.split("\n").filter(Boolean) : [];
}

/** All tracked files matching the given extensions. */
export function trackedFiles(cwd: string, exts: string[]): string[] {
  const out = gitSafe(["ls-files"], cwd);
  const all = out ? out.split("\n").filter(Boolean) : [];
  return all.filter((f) => exts.some((e) => f.endsWith(e)));
}
