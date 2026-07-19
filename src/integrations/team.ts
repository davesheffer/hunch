/**
 * Team discovery for the shared memory store — the COMMITTED half of the resolution chain.
 * `.hunch/local.json` (gitignored, per-machine) says where THIS machine's overlay lives;
 * `.hunch/team.json` (committed, public) says where the TEAM's shared store lives, so a
 * fresh clone / a new teammate / a headless agent can auto-wire without being told.
 * Written ONLY by `hunch shared --repo <url>` — `hunch private` never publishes its URL.
 */
import { existsSync, lstatSync, mkdirSync, mkdtempSync, readFileSync, realpathSync, renameSync, rmSync } from "node:fs";
import { devNull } from "node:os";
import { basename, dirname, join, resolve } from "node:path";
import { spawnSync } from "node:child_process";
import { writeFileAtomic } from "../core/io.js";
import { hunchTreeAttributesAreSafe, safeOverlayGitTreeListing, safeOverlayTree } from "../core/overlaySafety.js";
import { hunchPaths, hunchPathsForDir } from "../core/paths.js";
import { canonicalRemoteUrl, mainWorktreeRoot, sameRemoteUrl, type HunchRemoteContract } from "../extractors/git.js";
import { HunchStore } from "../store/hunchStore.js";
import { JsonStore } from "../store/jsonStore.js";
import { ensureSharedOverlayPointer } from "./worktree.js";
import { installMergeDriver } from "./mergeDriver.js";
import { ensureGitignore } from "./gitignore.js";
import { resolveInvocation } from "../cli/invocation.js";

export interface TeamConfig {
  shared_repo: string;
  /** Canonical remote branch for the one shared graph. Legacy files omit it;
   * route proof then derives the sole existing/upstream branch from the clone. */
  shared_ref?: string;
}

export const DEFAULT_TEAM_REF = "refs/heads/main";

export function safeTeamRef(value: string): string | null {
  const ref = value.trim();
  if (!ref.startsWith("refs/heads/") || ref === "refs/heads/") return null;
  const checked = spawnSync("git", ["check-ref-format", ref], {
    stdio: "ignore",
    env: { ...process.env, GIT_CONFIG_NOSYSTEM: "1" },
  });
  return checked.status === 0 ? ref : null;
}

export function teamSharedRef(team: TeamConfig): string {
  return team.shared_ref ?? DEFAULT_TEAM_REF;
}

/** SECURITY GATE for team.json's URL. team.json is COMMITTED — in a freshly cloned
 *  (possibly untrusted) repo it is attacker-controlled, and ensureTeamOverlay auto-clones
 *  it on MCP server start. Without this gate a value like `--upload-pack=…` (argument
 *  smuggling) or `ext::sh -c …` (git's ext transport) is remote code execution from
 *  merely opening a repo. Allow only credential-free https://, ssh://, git://,
 *  scp-style git@host:path, and never anything that could parse as a Git flag. */
export function safeGitUrl(url: string): string | null {
  const u = url.trim();
  if (!u || u.startsWith("-")) return null; // flag smuggling
  // Query strings and fragments are neither needed to locate a Git repository nor
  // safe to publish. Reject them for every accepted form rather than trying to keep
  // an inevitably incomplete list of token/password parameter names.
  if (/[?#]/.test(u)) return null;
  // A plain absolute path (POSIX / Windows drive / UNC) — a network-mount team store or a
  // local test remote. Safe: a local clone never executes hooks or remote helpers. The
  // file:// URL FORM stays rejected (no legitimate team.json uses it; keeps the gate tight).
  if (u.startsWith("/") || /^[A-Za-z]:[\\/]/.test(u) || u.startsWith("\\\\")) return u;
  // SCP syntax carries an SSH account name, not an embedded authentication secret.
  // Its deliberately narrow account/host grammar cannot encode a password delimiter.
  if (/^[A-Za-z0-9_.-]+@[A-Za-z0-9_.:-]+:[^\s]+$/.test(u) && !u.includes("::")) return u; // scp-like, excludes ext::

  // WHATWG URL parsing intentionally repairs forms such as `https:host/path` and
  // backslash-separated HTTPS URLs. Require the exact Git URL shape first so parsing
  // validates an allowlisted form instead of silently broadening the allowlist.
  if (!/^(?:https|ssh|git):\/\/[^\s]+$/i.test(u)) return null;
  const authority = u.slice(u.indexOf("://") + 3).split("/", 1)[0] ?? "";
  if (!authority || authority.includes("\\")) return null;
  let parsed: URL;
  try {
    parsed = new URL(u);
  } catch {
    return null;
  }
  if (!new Set(["https:", "ssh:", "git:"]).has(parsed.protocol) || !parsed.hostname) return null;

  const at = authority.lastIndexOf("@");
  if (parsed.protocol === "ssh:") {
    // A normal SSH username (`ssh://git@host/repo`) is routing, and remains valid.
    // A colon in its userinfo is a password separator. Check both the raw and decoded
    // spellings so percent-encoding cannot hide the delimiter from this committed gate.
    if (at >= 0) {
      const userinfo = authority.slice(0, at);
      let decodedUserinfo: string;
      try { decodedUserinfo = decodeURIComponent(userinfo); }
      catch { return null; }
      if (!userinfo || userinfo.includes(":") || decodedUserinfo.includes(":") || decodedUserinfo.includes("@")) return null;
    }
    if (parsed.password) return null;
  } else if (at >= 0 || parsed.username || parsed.password) {
    // HTTPS and unauthenticated git:// have no legitimate committed userinfo.
    return null;
  }
  return u;
}

/** The committed team pointer, or null. Tolerant — an invalid file reads as absent, and
 *  a URL that fails the safety gate reads as absent too (never propagated to a consumer). */
export function readTeamConfig(root: string): TeamConfig | null {
  try {
    const lexicalRoot = resolve(root);
    const rootStat = lstatSync(lexicalRoot);
    if (rootStat.isSymbolicLink() || !rootStat.isDirectory()) return null;
    const canonicalRoot = realpathSync(lexicalRoot);
    const hunchDir = join(lexicalRoot, ".hunch");
    const hunchStat = lstatSync(hunchDir);
    if (hunchStat.isSymbolicLink() || !hunchStat.isDirectory()
      || realpathSync(hunchDir) !== join(canonicalRoot, ".hunch")) return null;
    const file = join(hunchDir, "team.json");
    const stat = lstatSync(file);
    // team.json is committed attacker input read automatically at startup.
    // Never follow a link/device/FIFO or ingest an unbounded blob merely by
    // opening a repository.
    if (stat.isSymbolicLink() || !stat.isFile() || stat.nlink !== 1 || stat.size > 64 * 1024
      || realpathSync(file) !== join(canonicalRoot, ".hunch", "team.json")) return null;
    const v = JSON.parse(readFileSync(file, "utf8")) as { shared_repo?: unknown; shared_ref?: unknown };
    const url = typeof v.shared_repo === "string" ? safeGitUrl(v.shared_repo) : null;
    if (!url) return null;
    if (v.shared_ref === undefined) return { shared_repo: url };
    const ref = typeof v.shared_ref === "string" ? safeTeamRef(v.shared_ref) : null;
    return ref ? { shared_repo: url, shared_ref: ref } : null;
  } catch {
    return null;
  }
}

/** Publish the team's shared-store URL (atomic; committed with the repo). */
export function writeTeamConfig(root: string, cfg: TeamConfig): void {
  const sharedRepo = safeGitUrl(cfg.shared_repo);
  if (!sharedRepo) throw new Error("refusing to write unsafe team repository URL; committed team URLs must be credential-free and cannot contain query or fragment data");
  const sharedRef = cfg.shared_ref === undefined ? undefined : safeTeamRef(cfg.shared_ref);
  if (cfg.shared_ref !== undefined && !sharedRef) {
    throw new Error("refusing to write an unsafe team memory ref; it must be a valid refs/heads/* branch");
  }
  writeFileAtomic(
    join(hunchPaths(root).hunch, "team.json"),
    JSON.stringify({ shared_repo: sharedRepo, ...(sharedRef ? { shared_ref: sharedRef } : {}) }, null, 2) + "\n",
  );
}

function localGitConfig(root: string): Map<string, string[]> | null {
  const result = spawnSync("git", ["-C", root, "config", "--local", "--includes", "--null", "--list"], {
    encoding: "utf8",
    stdio: ["ignore", "pipe", "ignore"],
    env: boundedTeamGitEnv(),
  });
  if (result.status !== 0) return null;
  const config = new Map<string, string[]>();
  for (const entry of result.stdout.split("\0").filter(Boolean)) {
    const newline = entry.indexOf("\n");
    if (newline < 1) return null;
    const key = entry.slice(0, newline).toLowerCase();
    const values = config.get(key) ?? [];
    values.push(entry.slice(newline + 1));
    config.set(key, values);
  }
  return config;
}

/** Git environment for every shared-route setup operation. Preserve ordinary
 * credential configuration, but discard inherited repository/object selectors
 * and executable transport/prompt/template overrides from the caller. */
export function boundedTeamGitEnv(): NodeJS.ProcessEnv {
  const env = { ...process.env };
  const localGitEnv = new Set([
    "GIT_ALTERNATE_OBJECT_DIRECTORIES", "GIT_CONFIG", "GIT_CONFIG_PARAMETERS", "GIT_CONFIG_COUNT",
    "GIT_OBJECT_DIRECTORY", "GIT_DIR", "GIT_WORK_TREE", "GIT_IMPLICIT_WORK_TREE", "GIT_GRAFT_FILE",
    "GIT_INDEX_FILE", "GIT_NO_REPLACE_OBJECTS", "GIT_REPLACE_REF_BASE", "GIT_PREFIX",
    "GIT_INTERNAL_SUPER_PREFIX", "GIT_SHALLOW_FILE", "GIT_COMMON_DIR", "GIT_NAMESPACE",
    "GIT_QUARANTINE_PATH", "GIT_PROTOCOL", "GIT_EXEC_PATH", "GIT_TEMPLATE_DIR",
  ]);
  for (const key of Object.keys(env)) {
    if (["GIT_SSH", "GIT_SSH_COMMAND", "GIT_PROXY_COMMAND", "GIT_ASKPASS", "SSH_ASKPASS", "SSH_ASKPASS_REQUIRE"].includes(key)
      || localGitEnv.has(key)
      || /^GIT_CONFIG_(?:KEY|VALUE)_\d+$/.test(key)) delete env[key];
  }
  env.GIT_CONFIG_NOSYSTEM = "1";
  env.GIT_ALLOW_PROTOCOL = "https:ssh:git:file";
  env.GIT_TERMINAL_PROMPT = "0";
  return env;
}

/** Return false unless the effective non-system config can be inspected and
 * contains no rewrite whose prefix applies to the exact contract URL.
 * Credential helpers and other harmless global settings remain available; only
 * destination-moving url.*.insteadOf/pushInsteadOf entries are excluded. */
function effectiveRouteUnrewritten(overlayRoot: string, fetchUrl: string, pushUrl: string): boolean {
  const result = spawnSync("git", ["-C", overlayRoot, "config", "--includes", "--show-scope", "--null", "--list"], {
    encoding: "utf8",
    stdio: ["ignore", "pipe", "ignore"],
    env: boundedTeamGitEnv(),
  });
  if (result.status !== 0) return false;
  const fetchPrefixes: string[] = [];
  const pushPrefixes: string[] = [];
  const fields = result.stdout.split("\0").filter(Boolean);
  if (fields.length % 2 !== 0) return false;
  for (let i = 1; i < fields.length; i += 2) {
    const entry = fields[i]!;
    const newline = entry.indexOf("\n");
    if (newline < 1) return false;
    const key = entry.slice(0, newline).toLowerCase();
    const value = entry.slice(newline + 1);
    if (/^url\..*\.insteadof$/.test(key)) fetchPrefixes.push(value);
    if (/^url\..*\.pushinsteadof$/.test(key)) pushPrefixes.push(value);
  }
  return !fetchPrefixes.some((prefix) => prefix && (fetchUrl.startsWith(prefix) || pushUrl.startsWith(prefix)))
    && !pushPrefixes.some((prefix) => prefix && pushUrl.startsWith(prefix));
}

function overlayBranch(overlayRoot: string): string | null {
  try {
    const head = readFileSync(join(overlayRoot, ".git", "HEAD"), "utf8").trim();
    const match = head.match(/^ref: refs\/heads\/(.+)$/);
    return match?.[1] ?? null;
  } catch {
    return null;
  }
}

function provenRouteAgainst(
  team: TeamConfig,
  teamUrlCwd: string,
  overlayRoot: string,
): { fetchUrl: string; pushUrl: string; sharedRef: string } | null {
  const config = localGitConfig(overlayRoot);
  const branch = overlayBranch(overlayRoot);
  if (!config || !branch) return null;
  const values = (key: string): string[] | undefined => config.get(key.toLowerCase());
  const fetchUrls = values("remote.origin.url");
  const explicitPushUrls = values("remote.origin.pushurl");
  const pushUrls = explicitPushUrls ?? fetchUrls;
  if (fetchUrls?.length !== 1 || pushUrls?.length !== 1) return null;
  // The committed URL gate also governs the physical origin values. Identity
  // equivalence alone would accept a credentialed/query-bearing GitHub URL or
  // file:// spelling that normalizes to the advertised repository.
  if (!safeGitUrl(fetchUrls[0]!) || !safeGitUrl(pushUrls[0]!)
    || !sameRemoteUrl(fetchUrls[0]!, overlayRoot, team.shared_repo, teamUrlCwd)
    || !sameRemoteUrl(pushUrls[0]!, overlayRoot, team.shared_repo, teamUrlCwd)
    || !effectiveRouteUnrewritten(overlayRoot, fetchUrls[0]!, pushUrls[0]!)) return null;

  const forbiddenKeys = [
    "remote.origin.push",
    "remote.origin.uploadpack",
    "remote.origin.receivepack",
    "remote.origin.mirror",
    "remote.origin.proxy",
    "core.sshCommand",
    "core.gitProxy",
    "push.default",
  ];
  if (forbiddenKeys.some((key) => values(key)?.length)) return null;
  if ([...config.keys()].some((key) => /^url\..*\.(insteadof|pushinsteadof)$/.test(key))) return null;
  const fetchRefspecs = values("remote.origin.fetch");
  if (fetchRefspecs?.length !== 1 || fetchRefspecs[0] !== "+refs/heads/*:refs/remotes/origin/*") return null;

  const branchRemote = values(`branch.${branch}.remote`);
  const branchMerge = values(`branch.${branch}.merge`);
  let sharedRef = team.shared_ref ? safeTeamRef(team.shared_ref) : null;
  if (branchRemote || branchMerge) {
    if (branchRemote?.length !== 1 || branchRemote[0] !== "origin"
      || branchMerge?.length !== 1) return null;
    const configuredRef = safeTeamRef(branchMerge[0]!);
    if (!configuredRef || (sharedRef && configuredRef !== sharedRef)) return null;
    sharedRef = configuredRef;
  }
  const refs = spawnSync("git", ["-C", overlayRoot, "for-each-ref", "--format=%(refname)", "refs/remotes/origin"], {
    encoding: "utf8",
    stdio: ["ignore", "pipe", "ignore"],
    env: boundedTeamGitEnv(),
  });
  if (refs.status !== 0) return null;
  const branches = refs.stdout.split(/\r?\n/)
    .map((line) => line.trim())
    .filter((line) => line && line !== "refs/remotes/origin/HEAD");
  if (branches.length > 1) return null;
  const trackedRef = branches.length === 1
    ? safeTeamRef(branches[0]!.replace(/^refs\/remotes\/origin\//, "refs/heads/"))
    : null;
  if (branches.length === 1 && (!trackedRef || (sharedRef && trackedRef !== sharedRef))) return null;
  if (!sharedRef) {
    // A pre-shared_ref team file followed the overlay's real canonical branch.
    // Preserve that behavior only when it is unambiguous: one tracked origin
    // branch, or the unborn/current branch for a genuinely empty remote.
    sharedRef = trackedRef ?? safeTeamRef(`refs/heads/${branch}`);
  }
  if (!sharedRef) return null;
  for (const key of [`branch.${branch}.pushRemote`, "remote.pushDefault"]) {
    const selected = values(key);
    if (selected && (selected.length !== 1 || selected[0] !== "origin")) return null;
  }
  return { fetchUrl: fetchUrls[0]!, pushUrl: pushUrls[0]!, sharedRef };
}

function provenRoute(root: string, overlayRoot: string): { team: TeamConfig; fetchUrl: string; pushUrl: string; sharedRef: string } | null {
  const team = readTeamConfig(root);
  if (!team) return null;
  const route = provenRouteAgainst(team, root, overlayRoot);
  return route ? { team, ...route } : null;
}

type TeamRouteBinding = {
  version: 1;
  shared_repo: string;
  shared_ref: string;
};

/** Persist the graph epoch in clone-local Git metadata. If team.json and origin
 * are coherently repointed after a write was admitted, the old checkout must not
 * be reusable as the new graph on reconnect: it may contain a refused local
 * record/commit. A missing binding is a one-time legacy migration after full
 * route proof; an invalid or different binding is never overwritten. */
function routeBoundToClone(
  root: string,
  overlayRoot: string,
  route: { team: TeamConfig; sharedRef: string },
): boolean {
  const file = join(overlayRoot, ".git", "hunch-team-route.json");
  const expectedRepo = canonicalRemoteUrl(route.team.shared_repo, root);
  if (!safeGitUrl(expectedRepo)) return false;
  if (!existsSync(file)) {
    try {
      writeFileAtomic(file, `${JSON.stringify({
        version: 1,
        shared_repo: expectedRepo,
        shared_ref: route.sharedRef,
      } satisfies TeamRouteBinding, null, 2)}\n`);
    } catch { return false; }
  }
  try {
    const value = JSON.parse(readFileSync(file, "utf8")) as Partial<TeamRouteBinding>;
    return value.version === 1
      && typeof value.shared_repo === "string"
      && !!safeGitUrl(value.shared_repo)
      && sameRemoteUrl(value.shared_repo, overlayRoot, expectedRepo, overlayRoot)
      && value.shared_ref === route.sharedRef;
  } catch { return false; }
}

function boundProvenRoute(root: string, overlayRoot: string): ReturnType<typeof provenRoute> {
  const route = provenRoute(root, overlayRoot);
  return route && routeBoundToClone(root, overlayRoot, route) ? route : null;
}

/** Prove that the physical overlay reads from and writes to the repository
 * advertised by the committed team config. Path/mode checks alone are not
 * enough: an old healthy clone can otherwise report "current" against a stale
 * origin after team.json changes, silently splitting the team graph.
 *
 * Require one exact fetch URL and one exact push URL for origin, plus an origin
 * upstream/push selector when those branch-level overrides exist. Git's
 * Applicable local or global URL rewrite rules are rejected, so the exact URLs
 * captured from local config remain the URLs handed to Git at the network seam. */
export function overlayMatchesTeamRemote(root: string, overlayRoot: string): boolean {
  return safeOverlayTree(overlayRoot) && !!boundProvenRoute(root, overlayRoot);
}

/** Snapshot the effective URLs after proving the committed pointer, local
 * transport configuration, and canonical ref all agree. Sync commands receive
 * this object and re-run `verify` immediately around every network operation. */
export function teamRemoteContract(root: string, overlayRoot: string): HunchRemoteContract | null {
  if (!safeOverlayTree(overlayRoot)) return null;
  const route = boundProvenRoute(root, overlayRoot);
  if (!route) return null;
  const fetchUrl = canonicalRemoteUrl(route.fetchUrl, overlayRoot);
  const pushUrl = canonicalRemoteUrl(route.pushUrl, overlayRoot);
  const ref = route.sharedRef;
  return {
    // Resolve local relative spellings in the overlay-root context once. The
    // network commands run with `.hunch` as cwd, where handing Git the raw
    // relative value would otherwise name a different repository.
    fetchUrl,
    pushUrl,
    urlCwd: overlayRoot,
    ref,
    // Filesystem/tree safety is proved independently immediately before any
    // materialization. The route check stays deliberately lightweight because
    // it runs around each network seam in long-lived MCP traffic.
    verify: () => {
      const current = boundProvenRoute(root, overlayRoot);
      return !!current && current.sharedRef === ref
        && sameRemoteUrl(canonicalRemoteUrl(current.fetchUrl, overlayRoot), overlayRoot, fetchUrl, overlayRoot)
        && sameRemoteUrl(canonicalRemoteUrl(current.pushUrl, overlayRoot), overlayRoot, pushUrl, overlayRoot);
    },
  };
}

/** Setup-time form of the same contract, used before team.json is published.
 * It proves the existing overlay's physical origin/config against the explicit
 * command arguments so attach/refresh cannot traverse an ambient refspec or
 * transport override during the setup command itself. */
export function explicitTeamRemoteContract(
  overlayRoot: string,
  sharedRepo: string,
  sharedRepoCwd: string,
  sharedRef: string,
): HunchRemoteContract | null {
  const repo = safeGitUrl(sharedRepo);
  const ref = safeTeamRef(sharedRef);
  if (!repo || !ref || !safeOverlayTree(overlayRoot)) return null;
  const team: TeamConfig = { shared_repo: repo, shared_ref: ref };
  const route = provenRouteAgainst(team, sharedRepoCwd, overlayRoot);
  if (!route) return null;
  return {
    fetchUrl: canonicalRemoteUrl(route.fetchUrl, overlayRoot),
    pushUrl: canonicalRemoteUrl(route.pushUrl, overlayRoot),
    urlCwd: overlayRoot,
    ref,
    verify: () => !!provenRouteAgainst(team, sharedRepoCwd, overlayRoot),
  };
}

/** Undefined means this checkout does not advertise team routing. Once the
 * committed file exists, failure to prove it returns an always-refusing
 * contract so a late config change can strand a local commit but can never fall
 * through to ambient `git push`. */
export function advertisedTeamRemoteContract(root: string, overlayRoot: string): HunchRemoteContract | undefined {
  // An explicit per-process overlay outranks committed team discovery. Returning
  // no advertised contract lets that selected overlay use its own configured
  // route instead of being locally committed and then permanently stranded by
  // an unrelated team.json destination.
  if (process.env.HUNCH_PRIVATE_DIR?.trim()) return undefined;
  if (!existsSync(join(hunchPaths(root).hunch, "team.json"))) return undefined;
  return teamRemoteContract(root, overlayRoot) ?? {
    fetchUrl: "",
    pushUrl: "",
    urlCwd: root,
    ref: "",
    verify: () => false,
  };
}

function checkoutIsolatedEnv(): NodeJS.ProcessEnv {
  return {
    ...boundedTeamGitEnv(),
    // The fetch has already completed. Materialization needs no credentials or
    // user customizations, so suppress every ambient filter/attributes source.
    GIT_CONFIG_GLOBAL: devNull,
    GIT_ATTR_NOSYSTEM: "1",
  };
}

function exactCommit(
  root: string,
  revision: string,
  env: NodeJS.ProcessEnv,
): { oid: string | null; process: TeamCloneProcessResult } {
  const result = spawnSync("git", ["-C", root, "rev-parse", "--verify", `${revision}^{commit}`], {
    encoding: "utf8",
    stdio: ["ignore", "pipe", "ignore"],
    env,
    timeout: 2_000,
  });
  const oid = result.status === 0 ? result.stdout.trim() : "";
  return {
    oid: /^[0-9a-f]{40,64}$/i.test(oid) ? oid : null,
    process: result,
  };
}

function exactTreeListing(root: string, oid: string, env: NodeJS.ProcessEnv): string | null {
  const result = spawnSync("git", ["-C", root, "ls-tree", "--full-tree", "-r", "-t", "-z", oid], {
    encoding: "utf8",
    stdio: ["ignore", "pipe", "ignore"],
    env,
    timeout: 2_000,
    maxBuffer: 64 * 1024 * 1024,
  });
  return result.status === 0 && safeOverlayGitTreeListing(result.stdout) ? result.stdout : null;
}

function repositoryHasNoRefs(root: string, env: NodeJS.ProcessEnv): boolean {
  const result = spawnSync("git", ["-C", root, "for-each-ref", "--format=%(refname)"], {
    encoding: "utf8",
    stdio: ["ignore", "pipe", "ignore"],
    env,
    timeout: 2_000,
  });
  return result.status === 0 && result.stdout.trim() === "";
}

function treeAttributesAreSafe(root: string, listing: string, env: NodeJS.ProcessEnv): boolean {
  return hunchTreeAttributesAreSafe(listing, (oid) => {
    const blob = spawnSync("git", ["-C", root, "cat-file", "blob", oid], {
      encoding: "utf8",
      stdio: ["ignore", "pipe", "ignore"],
      env,
      timeout: 2_000,
      maxBuffer: 4 * 1024 * 1024,
    });
    return blob.status === 0 ? blob.stdout : null;
  });
}

type TeamCloneFailureStage =
  | "preflight"
  | "quarantine"
  | "route-rewrite"
  | "clone"
  | "materialize-route"
  | "materialize-branch"
  | "materialize-origin-object"
  | "materialize-head-object"
  | "materialize-empty-proof"
  | "materialize-object-mismatch"
  | "materialize-tree"
  | "materialize-reset"
  | "materialize-post-reset-head"
  | "materialize-post-reset"
  | "pre-publish-contract"
  | "pre-publish-race"
  | "publish-rename"
  | "post-publish-contract"
  | "unexpected";

type TeamCloneProcessResult = {
  status?: number | null;
  error?: Error;
};

/** Opt-in, secret-free diagnostics for a transaction that otherwise fails
 * closed as `null`. Never print the remote, path, stderr, or exception text: a
 * committed team URL may still identify private infrastructure. */
function reportTeamCloneFailure(
  stage: TeamCloneFailureStage,
  result?: TeamCloneProcessResult,
  thrown?: unknown,
): void {
  if (process.env.HUNCH_TEAM_CLONE_DEBUG !== "1") return;
  const rawCode = (result?.error as NodeJS.ErrnoException | undefined)?.code
    ?? (thrown as NodeJS.ErrnoException | undefined)?.code;
  const code = typeof rawCode === "string" && /^[A-Z0-9_]+$/.test(rawCode)
    ? ` code=${rawCode}`
    : "";
  const status = typeof result?.status === "number" ? ` status=${result.status}` : "";
  process.stderr.write(`[hunch-team-clone] stage=${stage}${status}${code}\n`);
}

/** Materialize only one already-fetched, immutable commit. The clone has no
 * worktree yet, so unsafe tree modes or attributes are rejected before any
 * remote-controlled path can invoke a hook/filter or reach disk. */
function materializeValidatedClone(
  team: TeamConfig,
  teamRoot: string,
  overlayRoot: string,
  emptyHooks: string,
): ValidatedTeamClone | null {
  const route = provenRouteAgainst(team, teamRoot, overlayRoot);
  if (!route) {
    reportTeamCloneFailure("materialize-route");
    return null;
  }
  const sharedRef = route.sharedRef;
  const branch = sharedRef.slice("refs/heads/".length);
  if (!branch || overlayBranch(overlayRoot) !== branch) {
    reportTeamCloneFailure("materialize-branch");
    return null;
  }
  const env = checkoutIsolatedEnv();
  const originProbe = exactCommit(overlayRoot, `refs/remotes/origin/${branch}`, env);
  const headProbe = exactCommit(overlayRoot, "HEAD", env);
  const oid = originProbe.oid;
  const head = headProbe.oid;
  // A genuinely empty remote has no object to validate or materialize. Retain
  // its metadata-only clone so a later sole canonical branch can be joined;
  // no remote-controlled working-tree path exists at this point.
  if (!oid || !head) {
    const empty = !oid && !head && repositoryHasNoRefs(overlayRoot, env) && safeOverlayTree(overlayRoot);
    if (!empty) {
      if (!oid) reportTeamCloneFailure("materialize-origin-object", originProbe.process);
      if (!head) reportTeamCloneFailure("materialize-head-object", headProbe.process);
      if (!oid && !head) reportTeamCloneFailure("materialize-empty-proof");
    }
    return empty ? { sharedRef, empty: true } : null;
  }
  if (head !== oid) {
    reportTeamCloneFailure("materialize-object-mismatch");
    return null;
  }
  const listing = exactTreeListing(overlayRoot, oid, env);
  if (!listing || !treeAttributesAreSafe(overlayRoot, listing, env)) {
    reportTeamCloneFailure("materialize-tree");
    return null;
  }

  const reset = spawnSync("git", [
    "-C", overlayRoot,
    "-c", `core.hooksPath=${emptyHooks}`,
    "-c", `core.attributesFile=${devNull}`,
    "reset", "--hard", oid,
  ], {
    stdio: "ignore",
    env,
    timeout: 5_000,
  });
  if (reset.status !== 0) {
    reportTeamCloneFailure("materialize-reset", reset);
    return null;
  }

  // Re-prove the immutable object identity and the materialized filesystem.
  // No binding/pointer is written until all three views agree.
  const afterHeadProbe = exactCommit(overlayRoot, "HEAD", env);
  const afterHead = afterHeadProbe.oid;
  const afterListing = afterHead === oid ? exactTreeListing(overlayRoot, oid, env) : null;
  const safe = afterHead === oid
    && !!afterListing
    && treeAttributesAreSafe(overlayRoot, afterListing, env)
    && safeOverlayTree(overlayRoot);
  if (!safe) {
    if (!afterHead) reportTeamCloneFailure("materialize-post-reset-head", afterHeadProbe.process);
    reportTeamCloneFailure("materialize-post-reset");
  }
  return safe ? { sharedRef, empty: false } : null;
}

export type ValidatedTeamClone = {
  sharedRef: string;
  empty: boolean;
};

/** Clone a shared memory repository without checking out attacker-controlled
 * paths, validate its exact route/OID/tree/attributes, and only then publish the
 * fully materialized clone at `destination`. Failure removes both quarantine and
 * destination so callers cannot accidentally wire a partially validated graph. */
export function cloneValidatedTeamOverlay(
  sharedRepo: string,
  sharedRepoCwd: string,
  destination: string,
  opts: { sharedRef?: string; timeoutMs?: number } = {},
): ValidatedTeamClone | null {
  const repo = safeGitUrl(sharedRepo);
  const sharedRef = opts.sharedRef === undefined ? undefined : safeTeamRef(opts.sharedRef);
  if (!repo || (opts.sharedRef !== undefined && !sharedRef) || existsSync(destination)) {
    reportTeamCloneFailure("preflight");
    return null;
  }
  const requestedTimeout = opts.timeoutMs ?? 5_000;
  const timeoutMs = Number.isFinite(requestedTimeout)
    ? Math.min(30_000, Math.max(1, Math.trunc(requestedTimeout)))
    : 5_000;
  const parent = dirname(destination);
  const prefix = basename(destination);
  let stagedDest = "";
  let guardRoot = "";
  let installed = false;
  let accepted = false;
  let stage: TeamCloneFailureStage = "quarantine";
  try {
    stagedDest = mkdtempSync(join(parent, `${prefix}.tmp-`));
    guardRoot = mkdtempSync(join(parent, `${prefix}.guard-`));
    const emptyHooks = join(guardRoot, "hooks");
    const emptyTemplate = join(guardRoot, "template");
    mkdirSync(emptyHooks);
    mkdirSync(emptyTemplate);
    stage = "route-rewrite";
    if (!effectiveRouteUnrewritten(stagedDest, repo, repo)) {
      reportTeamCloneFailure(stage);
      return null;
    }

    const cloneEnv = boundedTeamGitEnv();
    stage = "clone";
    const cloned = spawnSync("git", [
      "-c", "protocol.ext.allow=never",
      "-c", `core.hooksPath=${emptyHooks}`,
      "clone", "--no-checkout", `--template=${emptyTemplate}`,
      "--", repo, stagedDest,
    ], {
      stdio: "ignore",
      env: cloneEnv,
      timeout: timeoutMs,
    });
    if (cloned.status !== 0) {
      reportTeamCloneFailure(stage, cloned);
      return null;
    }
    const validated = materializeValidatedClone(
      { shared_repo: repo, ...(sharedRef ? { shared_ref: sharedRef } : {}) },
      sharedRepoCwd,
      stagedDest,
      emptyHooks,
    );
    if (!validated) return null;
    stage = "pre-publish-contract";
    if (!explicitTeamRemoteContract(stagedDest, repo, sharedRepoCwd, validated.sharedRef)) {
      reportTeamCloneFailure(stage);
      return null;
    }
    stage = "pre-publish-race";
    if (existsSync(destination)) {
      reportTeamCloneFailure(stage);
      return null;
    }

    stage = "publish-rename";
    renameSync(stagedDest, destination);
    stagedDest = "";
    installed = true;
    stage = "post-publish-contract";
    if (!explicitTeamRemoteContract(destination, repo, sharedRepoCwd, validated.sharedRef)) {
      reportTeamCloneFailure(stage);
      return null;
    }
    accepted = true;
    return validated;
  } catch (error) {
    reportTeamCloneFailure(stage ?? "unexpected", undefined, error);
    return null;
  } finally {
    if (guardRoot) rmSync(guardRoot, { recursive: true, force: true });
    if (stagedDest) rmSync(stagedDest, { recursive: true, force: true });
    if (installed && !accepted) rmSync(destination, { recursive: true, force: true });
  }
}

/** Auto-wire this checkout to the team's shared store advertised in `.hunch/team.json`:
 *  clone it to the worktree-stable anchor, and register the gitignored local pointer +
 *  the git-common-dir pointer (mode "shared", auto-commit on) so every consumer — CLI,
 *  MCP server, hooks, all worktrees — resolves the same single source of truth.
 *  No-op (null) when an overlay is already configured, there's no team.json, or the
 *  clone fails (best-effort: never throws, never blocks startup). Returns the overlay
 *  hunch dir when wired. */
export function ensureTeamOverlay(root: string): string | null {
  try {
    if (process.env.HUNCH_PRIVATE_DIR?.trim()) return null; // explicit env wins
    const team = readTeamConfig(root);
    if (!team) return null;
    const probe = new HunchStore(hunchPaths(root));
    const configured = probe.privateDir;
    probe.close();
    if (configured && existsSync(configured)) {
      // Upgrade/repair clone-local capabilities on every startup. Older shared
      // overlays predate the merge-driver/runtime-ignore installation; treating
      // an existing pointer as a total no-op would leave those teams permanently
      // vulnerable until they deleted and recloned their memory.
      const configuredRoot = join(configured, "..");
      if (!overlayMatchesTeamRemote(root, configuredRoot)) return null;
      installMergeDriver(configuredRoot, resolveInvocation().shell);
      ensureGitignore(configuredRoot);
      return null; // already wired and alive
    }

    const anchor = mainWorktreeRoot(root);
    const dest = join(anchor, ".hunch-private");
    if (!existsSync(dest)) {
      const cloned = cloneValidatedTeamOverlay(team.shared_repo, root, dest, {
        sharedRef: team.shared_ref,
        timeoutMs: 5_000,
      });
      if (!cloned || !overlayMatchesTeamRemote(root, dest)) {
        if (cloned) rmSync(dest, { recursive: true, force: true });
        return null; // offline / invalid / no access — stay unwired, never crash
      }
    }
    // This MUST precede ensureDirs: `.hunch` itself, any Hunch kind directory/file,
    // `.gitignore`, or `.gitattributes` can be a tracked symlink in the remote.
    // Following even one would let merely opening a project create or overwrite
    // files outside the auto-cloned overlay.
    if (!overlayMatchesTeamRemote(root, dest)) return null;
    const hunchDir = join(dest, ".hunch");
    new JsonStore(hunchPathsForDir(hunchDir)).ensureDirs();
    // `.gitattributes` and the merge driver command are clone-local capabilities:
    // overlay auto-commits deliberately stage only `.hunch/**/*.json`, so the creator's
    // driver configuration never rides the memory remote. Install it for every freshly
    // discovered teammate/agent clone (idempotently) or same-record conflicts would keep
    // aborting forever on machines that did not run `hunch shared` themselves.
    installMergeDriver(dest, resolveInvocation().shell);
    // A real Git conflict runs the Hunch CLI with this overlay as cwd, which can
    // create a derived local SQLite index alongside the shared JSON. Ignore that
    // rebuildable state so it can never poison the JSON-only publication guard.
    ensureGitignore(dest);
    // Merge into any existing local.json (con_8460b6770f): a per-machine autoCommit
    // opt-out must survive the auto-wiring; an unparseable file is left alone.
    const localFile = join(hunchPaths(root).hunch, "local.json");
    let existing: Record<string, unknown> = {};
    if (existsSync(localFile)) {
      try { existing = JSON.parse(readFileSync(localFile, "utf8")) as Record<string, unknown>; }
      catch { return null; } // refuse to clobber an unparseable config
    }
    const autoCommit = existing.autoCommit !== false;
    writeFileAtomic(localFile, JSON.stringify({ ...existing, privateDir: hunchDir, autoCommit, mode: "shared" }, null, 2) + "\n");
    ensureSharedOverlayPointer(root, hunchDir, autoCommit, "shared");
    return hunchDir;
  } catch {
    return null;
  }
}
