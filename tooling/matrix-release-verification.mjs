#!/usr/bin/env node
import { spawn, spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import {
  accessSync,
  chmodSync,
  constants as fsConstants,
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  readdirSync,
  realpathSync,
  renameSync,
  rmSync,
  symlinkSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { delimiter, dirname, join, resolve } from "node:path";
import { performance } from "node:perf_hooks";
import process from "node:process";
import { fileURLToPath, pathToFileURL } from "node:url";

export const MATRIX_RELEASE_SCHEMA = "hunch.matrix.release.v1";
export const LEGACY_MATRIX_TAG = "v1.8.3";
export const LEGACY_MATRIX_COMMIT = "abf2b40f1d67076e2526000f9336b792add06983";
// Exact public npm bytes observed at the official registry for 1.8.3. The
// verifier rebuilds the pinned tag offline and refuses it unless npm pack
// reproduces the package consumers actually installed.
export const LEGACY_MATRIX_TARBALL = Object.freeze({
  sha256: "sha256:c781eaa71db40d4f4ea03de4272f794d62e470917bfe29f687e7fea557ddebb9",
  shasum: "7d01e409aa1a6533a9d1bae0c63ecd2377def410",
  integrity: "sha512-ZNC6n84g+DFmTx/3YBz7ZzeLETvqB7gr0z9PJtQXMdOv3lbXaiWZ2Od+K3j5WdjQqPF6UF/rGWfaKddLH8d+Lw==",
});
export const MATRIX_PERFORMANCE_LIMITS = Object.freeze({
  compatibility_ms: 240_000,
  crash_recovery_ms: 240_000,
  soak_ms: 900_000,
  total_ms: 1_200_000,
});

const projectRoot = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const devNull = process.platform === "win32" ? "NUL" : "/dev/null";
const DEFAULTS = Object.freeze({
  actors: 8,
  rounds: 4,
  output: ".hunch-cache/release/matrix-release.json",
});
const SENTINEL_PREFIX = "MATRIX_RELEASE_";
const COMPAT_CANDIDATE = `${SENTINEL_PREFIX}COMPAT_CANDIDATE: candidate memory must survive a legacy client write`;
const COMPAT_LEGACY = `${SENTINEL_PREFIX}COMPAT_LEGACY: legacy memory must remain readable after upgrading again`;
const COMPAT_UPGRADE = `${SENTINEL_PREFIX}COMPAT_UPGRADE: the upgraded client must keep both earlier records`;
const COMPAT_POLICY = `${SENTINEL_PREFIX}POLICY: never import axios in src/service.ts`;
const CRASH_INTERRUPTED = `${SENTINEL_PREFIX}CRASH_INTERRUPTED: a process death before commit must not lose this durable record`;
const CRASH_RECOVERY = `${SENTINEL_PREFIX}CRASH_RECOVERY: the next process must reclaim and publish the interrupted record`;
const COLLISION_RULE = `${SENTINEL_PREFIX}COLLISION: concurrent writers of one record must converge to one record`;
const OVERLAY_ATTRIBUTES = [
  ".hunch/**/*.json merge=hunch",
  ".hunch/manifest.json merge=text",
  "",
].join("\n");
const OVERLAY_IGNORE = [
  "# >>> hunch (derived runtime index — regenerable from .hunch/*.json) >>>",
  ".hunch/*.sqlite",
  ".hunch/*.sqlite-shm",
  ".hunch/*.sqlite-wal",
  ".hunch/*.sqlite-journal",
  ".hunch/**/*.tmp*",
  ".hunch-cache/",
  ".hunch/local.json",
  ".hunch-private/",
  "# <<< hunch <<<",
  "",
].join("\n");

let matrixDeadlineEpochMs = Number.POSITIVE_INFINITY;
let matrixPhase = "not-started";

function enterMatrixPhase(phase) {
  matrixPhase = phase;
  process.stderr.write(`Matrix phase: ${phase}\n`);
}

function remainingMatrixMilliseconds() {
  return Number.isFinite(matrixDeadlineEpochMs)
    ? Math.max(0, Math.floor(matrixDeadlineEpochMs - Date.now()))
    : Number.MAX_SAFE_INTEGER;
}

function measuredMilliseconds(started) {
  return Math.max(1, Math.ceil(performance.now() - started));
}

function stable(value) {
  if (Array.isArray(value)) return value.map(stable);
  if (value && typeof value === "object") {
    return Object.fromEntries(Object.keys(value).sort().map((key) => [key, stable(value[key])]));
  }
  return value;
}

function sha256(value) {
  return `sha256:${createHash("sha256").update(value).digest("hex")}`;
}

function jsonEqual(left, right) {
  return JSON.stringify(stable(left)) === JSON.stringify(stable(right));
}

function stableProjectionHash(value) {
  return sha256(JSON.stringify(stable(value)));
}

export function assertLegacyMatrixTarball(pack, expected = LEGACY_MATRIX_TARBALL) {
  if (!expected) throw new Error("no externally trusted legacy npm tarball identity was supplied");
  for (const field of ["sha256", "shasum", "integrity"]) {
    if (pack?.[field] !== expected[field]) {
      throw new Error(
        `legacy npm tarball ${field} mismatch: rebuilt ${String(pack?.[field])}, expected ${String(expected[field])}`,
      );
    }
  }
  return true;
}

export function assertDependencyLockProjection(legacyProjection, candidateProjection) {
  const legacyHash = stableProjectionHash(legacyProjection);
  const candidateHash = stableProjectionHash(candidateProjection);
  if (!jsonEqual(legacyProjection, candidateProjection)) {
    throw new Error(
      `dependency lock projection drift: legacy ${legacyHash}, candidate ${candidateHash}`,
    );
  }
  return { equivalent: true, hash: legacyHash };
}

function parseSemver(value) {
  const match = String(value).match(/^(\d+)\.(\d+)\.(\d+)(?:-([0-9A-Za-z.-]+))?$/);
  if (!match) return null;
  return {
    major: Number(match[1]),
    minor: Number(match[2]),
    patch: Number(match[3]),
    prerelease: match[4] ?? null,
  };
}

function compareSemver(leftValue, rightValue) {
  const left = parseSemver(leftValue);
  const right = parseSemver(rightValue);
  if (!left || !right) return null;
  for (const field of ["major", "minor", "patch"]) {
    if (left[field] !== right[field]) return left[field] - right[field];
  }
  if (left.prerelease === right.prerelease) return 0;
  if (left.prerelease === null) return 1;
  if (right.prerelease === null) return -1;
  return left.prerelease < right.prerelease ? -1 : left.prerelease > right.prerelease ? 1 : 0;
}

function expectedBaseline(options = {}) {
  const tag = options.legacyTag ?? LEGACY_MATRIX_TAG;
  const commit = options.legacyCommit ?? LEGACY_MATRIX_COMMIT;
  const defaultPublishedBaseline = tag === LEGACY_MATRIX_TAG && commit === LEGACY_MATRIX_COMMIT;
  const suppliedTarball = options.legacySha256 && options.legacyShasum && options.legacyIntegrity
    ? {
        sha256: options.legacySha256,
        shasum: options.legacyShasum,
        integrity: options.legacyIntegrity,
      }
    : null;
  return {
    tag,
    commit,
    tarball: defaultPublishedBaseline ? LEGACY_MATRIX_TARBALL : suppliedTarball,
  };
}

function finiteNonnegativeInteger(value) {
  return Number.isSafeInteger(value) && value >= 0;
}

function evidencePasses(evidence, options = {}) {
  const baseline = expectedBaseline(options);
  const newer = compareSemver(evidence.packages?.candidate?.version, evidence.packages?.legacy?.version);
  const expectedWrites = evidence.soak?.actors * evidence.soak?.rounds;
  const timedWriteOps = expectedWrites + evidence.soak?.collision_writers;
  const expectedThroughput = finiteNonnegativeInteger(evidence.performance?.soak_ms)
    && evidence.performance.soak_ms > 0
    ? Number((timedWriteOps / (evidence.performance.soak_ms / 1_000)).toFixed(3))
    : null;
  return evidence.source?.legacy_tag === baseline.tag
    && evidence.source?.legacy_commit === baseline.commit
    && /^[0-9a-f]{40,64}$/i.test(evidence.source?.candidate_commit ?? "")
    && evidence.packages?.legacy?.version === baseline.tag.slice(1)
    && newer !== null && newer > 0
    && evidence.packages?.legacy?.install_mode === "isolated_tarball"
    && evidence.packages?.candidate?.install_mode === "isolated_tarball"
    && /^sha256:[0-9a-f]{64}$/.test(evidence.packages?.legacy?.sha256 ?? "")
    && /^sha256:[0-9a-f]{64}$/.test(evidence.packages?.candidate?.sha256 ?? "")
    && /^[0-9a-f]{40}$/.test(evidence.packages?.legacy?.shasum ?? "")
    && /^sha512-[A-Za-z0-9+/]+={0,2}$/.test(evidence.packages?.legacy?.integrity ?? "")
    && baseline.tarball !== null
    && evidence.packages.legacy.sha256 === baseline.tarball.sha256
    && evidence.packages.legacy.shasum === baseline.tarball.shasum
    && evidence.packages.legacy.integrity === baseline.tarball.integrity
    && jsonEqual(evidence.compatibility?.sequence, ["candidate", "legacy", "candidate"])
    && evidence.compatibility?.candidate_record_read_by_legacy === true
    && evidence.compatibility?.candidate_record_bytes_preserved_by_legacy_write === true
    && evidence.compatibility?.legacy_record_read_after_upgrade === true
    && evidence.compatibility?.upgrade_record_published === true
    && evidence.compatibility?.candidate_policy_bytes_preserved_by_legacy_write === true
    && evidence.compatibility?.candidate_policy_origin_preserved_by_legacy_write === true
    && evidence.compatibility?.candidate_policy_activation_gate_preserved_by_legacy_write === true
    && evidence.compatibility?.candidate_policy_state_preserved_by_legacy_attack === true
    && evidence.compatibility?.candidate_policy_authority_preserved_by_legacy_attack === true
    && evidence.compatibility?.attack_clone_policy_bytes_preserved === true
    && evidence.compatibility?.attack_clone_policy_state_preserved === true
    && evidence.compatibility?.attack_clone_policy_authority_preserved === true
    && evidence.compatibility?.legacy_current_proof_approval_refused === true
    && evidence.compatibility?.legacy_reproof_activation_refused === true
    && evidence.crash_recovery?.injected === true
    && evidence.crash_recovery?.commit_seam_reached === true
    && evidence.crash_recovery?.process_killed === true
    && evidence.crash_recovery?.dead_owner_lock_reclaimed === true
    && evidence.crash_recovery?.interrupted_record_recovered === true
    && evidence.crash_recovery?.recovery_record_published === true
    && evidence.crash_recovery?.overlay_operationally_clean === true
    && evidence.crash_recovery?.overlay_memory_tree_clean === true
    && evidence.crash_recovery?.only_expected_clone_local_capabilities_untracked === true
    && Number.isInteger(evidence.soak?.actors) && evidence.soak.actors >= 3 && evidence.soak.actors <= 20
    && Number.isInteger(evidence.soak?.rounds) && evidence.soak.rounds >= 1 && evidence.soak.rounds <= 10
    && evidence.soak?.unique_writes_expected === expectedWrites
    && evidence.soak?.unique_writes_observed === expectedWrites
    && evidence.soak?.collision_writers === evidence.soak?.actors
    && evidence.soak?.collision_records_observed === 1
    && evidence.soak?.all_commands_succeeded === true
    && evidence.soak?.all_clones_converged === true
    && evidence.soak?.all_overlays_clean === true
    && evidence.soak?.all_overlay_memory_trees_clean === true
    && evidence.soak?.only_expected_clone_local_capabilities_untracked === true
    && evidence.soak?.one_canonical_remote_branch === true
    && evidence.privacy?.sentinel_in_code_history === false
    && evidence.privacy?.private_runtime_artifacts_in_code_remote === false
    && evidence.privacy?.private_runtime_artifacts_in_code_remote_history === false
    && evidence.privacy?.private_runtime_artifacts_in_memory_remote === false
    && evidence.privacy?.private_runtime_artifacts_in_memory_remote_history === false
    && evidence.isolation?.external_network_disabled === undefined
    && evidence.isolation?.guarded_network_surfaces_disabled === true
    && jsonEqual(evidence.isolation?.guarded_network_surfaces, ["git", "node", "npm"])
    && evidence.isolation?.node_network_guard_verified === true
    && evidence.isolation?.git_protocols_limited_to_file === true
    && evidence.isolation?.npm_offline === true
    && evidence.isolation?.credentials_inherited === false
    && evidence.isolation?.dependency_lock_equivalent === true
    && /^sha256:[0-9a-f]{64}$/.test(evidence.isolation?.dependency_lock_hash ?? "")
    && evidence.isolation?.dependency_tree_source === "candidate-npm-ci-with-identical-lock"
    && evidence.isolation?.legacy_source === "pinned_local_tag"
    && evidence.isolation?.candidate_source === "packed_exact_commit"
    && finiteNonnegativeInteger(evidence.performance?.compatibility_ms)
    && evidence.performance.compatibility_ms <= MATRIX_PERFORMANCE_LIMITS.compatibility_ms
    && finiteNonnegativeInteger(evidence.performance?.crash_recovery_ms)
    && evidence.performance.crash_recovery_ms <= MATRIX_PERFORMANCE_LIMITS.crash_recovery_ms
    && finiteNonnegativeInteger(evidence.performance?.soak_ms)
    && evidence.performance.soak_ms > 0
    && evidence.performance.soak_ms <= MATRIX_PERFORMANCE_LIMITS.soak_ms
    && finiteNonnegativeInteger(evidence.performance?.total_ms)
    && evidence.performance.total_ms >= evidence.performance.compatibility_ms
      + evidence.performance.crash_recovery_ms + evidence.performance.soak_ms
    && evidence.performance.total_ms <= MATRIX_PERFORMANCE_LIMITS.total_ms
    && evidence.performance?.soak_write_ops === timedWriteOps
    && evidence.performance?.soak_write_ops_per_second === expectedThroughput
    && jsonEqual(evidence.performance?.limits, MATRIX_PERFORMANCE_LIMITS);
}

export function buildMatrixReceipt(evidence, options = {}) {
  const normalizedEvidence = stable(evidence);
  const passed = evidencePasses(normalizedEvidence, options);
  const body = {
    schema: MATRIX_RELEASE_SCHEMA,
    ...normalizedEvidence,
    result: passed ? "passed" : "failed",
    release_ready: passed && normalizedEvidence.source?.candidate_clean === true,
  };
  return { ...body, content_hash: sha256(JSON.stringify(stable(body))) };
}

export function verifyMatrixReceipt(receipt, options = {}) {
  if (!receipt || typeof receipt !== "object" || receipt.schema !== MATRIX_RELEASE_SCHEMA) return false;
  const {
    schema: _schema,
    result: _result,
    release_ready: _releaseReady,
    content_hash: _contentHash,
    ...evidence
  } = receipt;
  const rebuilt = buildMatrixReceipt(evidence, options);
  return jsonEqual(receipt, rebuilt);
}

function boundedInteger(value, flag, minimum, maximum) {
  if (!/^\d+$/.test(value ?? "")) throw new Error(`${flag} requires an integer`);
  const parsed = Number(value);
  if (!Number.isSafeInteger(parsed) || parsed < minimum || parsed > maximum) {
    throw new Error(`${flag} must be between ${minimum} and ${maximum}`);
  }
  return parsed;
}

export function parseMatrixReleaseArgs(argv) {
  const options = { ...DEFAULTS, allowDirty: false, keepTemp: false, help: false };
  for (let index = 0; index < argv.length; index += 1) {
    const arg = argv[index];
    if (arg === "--allow-dirty") options.allowDirty = true;
    else if (arg === "--keep-temp") options.keepTemp = true;
    else if (arg === "--help" || arg === "-h") options.help = true;
    else if ([
      "--actors",
      "--rounds",
      "--output",
      "--legacy-tag",
      "--legacy-commit",
      "--legacy-sha256",
      "--legacy-shasum",
      "--legacy-integrity",
    ].includes(arg)) {
      const value = argv[index + 1];
      if (!value) throw new Error(`${arg} requires a value`);
      if (arg === "--actors") options.actors = boundedInteger(value, arg, 3, 20);
      else if (arg === "--rounds") options.rounds = boundedInteger(value, arg, 1, 10);
      else if (arg === "--output") options.output = value;
      else if (arg === "--legacy-tag") options.legacyTag = value;
      else if (arg === "--legacy-commit") options.legacyCommit = value.toLowerCase();
      else if (arg === "--legacy-sha256") options.legacySha256 = value.toLowerCase();
      else if (arg === "--legacy-shasum") options.legacyShasum = value.toLowerCase();
      else options.legacyIntegrity = value;
      index += 1;
    } else {
      throw new Error(`unknown Matrix verifier argument: ${arg}`);
    }
  }
  if (!!options.legacyTag !== !!options.legacyCommit) {
    throw new Error("--legacy-tag and --legacy-commit must be supplied together");
  }
  if (options.legacyTag && !/^v\d+\.\d+\.\d+(?:-[0-9A-Za-z.-]+)?$/.test(options.legacyTag)) {
    throw new Error("--legacy-tag must be an exact v-prefixed semantic version tag");
  }
  if (options.legacyCommit && !/^[0-9a-f]{40,64}$/.test(options.legacyCommit)) {
    throw new Error("--legacy-commit must be a full hexadecimal object id");
  }
  const suppliedTarballFields = [
    options.legacySha256,
    options.legacyShasum,
    options.legacyIntegrity,
  ].filter(Boolean).length;
  if (suppliedTarballFields > 0 && (!options.legacyTag || !options.legacyCommit)) {
    throw new Error("legacy package digest flags require --legacy-tag and --legacy-commit");
  }
  if (suppliedTarballFields > 0 && suppliedTarballFields < 3) {
    throw new Error("legacy package identity requires --legacy-sha256, --legacy-shasum, and --legacy-integrity");
  }
  if (options.legacySha256 && !/^sha256:[0-9a-f]{64}$/.test(options.legacySha256)) {
    throw new Error("--legacy-sha256 must be a sha256-prefixed 64-character hexadecimal digest");
  }
  if (options.legacyShasum && !/^[0-9a-f]{40}$/.test(options.legacyShasum)) {
    throw new Error("--legacy-shasum must be a 40-character hexadecimal npm shasum");
  }
  if (options.legacyIntegrity && !/^sha512-[A-Za-z0-9+/]{86}==$/.test(options.legacyIntegrity)) {
    throw new Error("--legacy-integrity must be a base64 sha512 npm integrity value");
  }
  if (options.legacyTag === LEGACY_MATRIX_TAG && options.legacyCommit !== LEGACY_MATRIX_COMMIT) {
    throw new Error(`${LEGACY_MATRIX_TAG} is permanently pinned to ${LEGACY_MATRIX_COMMIT}`);
  }
  const alternateBaseline = options.legacyTag
    && (options.legacyTag !== LEGACY_MATRIX_TAG || options.legacyCommit !== LEGACY_MATRIX_COMMIT);
  if (alternateBaseline && suppliedTarballFields !== 3) {
    throw new Error(
      "an alternate legacy baseline requires --legacy-sha256, --legacy-shasum, and --legacy-integrity",
    );
  }
  if (!alternateBaseline && suppliedTarballFields === 3
    && (options.legacySha256 !== LEGACY_MATRIX_TARBALL.sha256
      || options.legacyShasum !== LEGACY_MATRIX_TARBALL.shasum
      || options.legacyIntegrity !== LEGACY_MATRIX_TARBALL.integrity)) {
    throw new Error(`${LEGACY_MATRIX_TAG} package identity must match its pinned official npm bytes`);
  }
  return options;
}

function help() {
  return [
    "Deterministic release blocker for Hunch team-memory Matrix compatibility and resilience.",
    "",
    "Usage: node tooling/matrix-release-verification.mjs [options]",
    "",
    `  --actors <n>     isolated current-version soak clones (${DEFAULTS.actors}; 3..20)`,
    `  --rounds <n>     concurrent unique-write rounds (${DEFAULTS.rounds}; 1..10)`,
    `  --output <file>   atomic JSON receipt (${DEFAULTS.output})`,
    `  --legacy-tag <v>  exact local compatibility tag (default ${LEGACY_MATRIX_TAG})`,
    "  --legacy-commit   full expected commit paired with --legacy-tag",
    "  --legacy-sha256   externally verified npm tarball sha256 for an alternate baseline",
    "  --legacy-shasum   externally verified npm shasum for an alternate baseline",
    "  --legacy-integrity externally verified npm integrity for an alternate baseline",
    "  --allow-dirty     development-only run; receipt remains release_ready=false",
    "  --keep-temp       retain the disposable repositories and package installs",
    "  --help            show this help",
    "",
    `The default legacy client is built from exact local tag ${LEGACY_MATRIX_TAG} (${LEGACY_MATRIX_COMMIT})`,
    "and must reproduce the exact package bytes published on npm.",
    "An alternate rollback baseline must provide its immutable tag, expected commit, and all",
    "three externally verified npm package digests; the verifier never trusts self-declared bytes.",
    "Both clients execute from isolated unpacked npm tarballs. All Git remotes are local,",
    "npm is offline, Node/Git/npm network paths are guarded, synthesis is deterministic,",
    "and no API credentials are inherited.",
  ].join("\n");
}

function executableOnPath(name) {
  const extensions = process.platform === "win32"
    ? (process.env.PATHEXT ?? ".EXE;.CMD;.BAT").split(";")
    : [""];
  for (const directory of (process.env.PATH ?? "").split(delimiter)) {
    if (!directory) continue;
    for (const extension of extensions) {
      const target = join(directory, process.platform === "win32" ? `${name}${extension}` : name);
      try {
        accessSync(target, fsConstants.X_OK);
        return realpathSync(target);
      } catch { /* try the next PATH entry */ }
    }
  }
  throw new Error(`required executable not found on PATH: ${name}`);
}

const actualGit = executableOnPath("git");
const npmExecutable = executableOnPath("npm");
const tarExecutable = executableOnPath("tar");

function cleanEnvironment(home, extra = {}) {
  mkdirSync(home, { recursive: true });
  const env = {};
  for (const key of [
    "PATH", "PATHEXT", "SystemRoot", "SYSTEMROOT", "WINDIR", "windir", "COMSPEC", "ComSpec",
    "TMPDIR", "TMP", "TEMP", "SHELL", "APPDATA", "LOCALAPPDATA",
  ]) {
    if (process.env[key]) env[key] = process.env[key];
  }
  return {
    ...env,
    HOME: home,
    USERPROFILE: home,
    XDG_CONFIG_HOME: join(home, ".config"),
    GIT_CONFIG_NOSYSTEM: "1",
    GIT_CONFIG_GLOBAL: devNull,
    GIT_NO_REPLACE_OBJECTS: "1",
    GIT_TERMINAL_PROMPT: "0",
    GIT_ALLOW_PROTOCOL: "file",
    GIT_PROTOCOL_FROM_USER: "0",
    HUNCH_PRIVATE_DIR: "",
    HUNCH_SYNTH_PROVIDER: "deterministic",
    HUNCH_EMBEDDINGS: "off",
    NO_COLOR: "1",
    CI: "1",
    HTTP_PROXY: "http://127.0.0.1:9",
    HTTPS_PROXY: "http://127.0.0.1:9",
    ALL_PROXY: "http://127.0.0.1:9",
    NO_PROXY: "",
    http_proxy: "http://127.0.0.1:9",
    https_proxy: "http://127.0.0.1:9",
    all_proxy: "http://127.0.0.1:9",
    no_proxy: "",
    NPM_CONFIG_OFFLINE: "true",
    NPM_CONFIG_AUDIT: "false",
    NPM_CONFIG_FUND: "false",
    NPM_CONFIG_REGISTRY: "http://127.0.0.1:9",
    NPM_CONFIG_USERCONFIG: devNull,
    LANG: "C",
    LC_ALL: "C",
    TZ: "UTC",
    ...extra,
  };
}

function installNetworkGuard(temp) {
  const guard = join(temp, "network-disabled.mjs");
  writeFileSync(guard, [
    'import { createRequire } from "node:module";',
    'const require = createRequire(import.meta.url);',
    'const marker = "MATRIX_EXTERNAL_NETWORK_DISABLED";',
    'const deny = () => { throw new Error(marker); };',
    'const denyAsync = () => Promise.reject(new Error(marker));',
    'const net = require("node:net");',
    'net.Socket.prototype.connect = deny;',
    'net.connect = deny;',
    'net.createConnection = deny;',
    'const tls = require("node:tls");',
    'tls.connect = deny;',
    'const http = require("node:http");',
    'http.request = deny;',
    'http.get = deny;',
    'const https = require("node:https");',
    'https.request = deny;',
    'https.get = deny;',
    'const dns = require("node:dns");',
    'dns.lookup = deny;',
    'dns.resolve = deny;',
    'const dgram = require("node:dgram");',
    'dgram.createSocket = deny;',
    'globalThis.fetch = denyAsync;',
    'globalThis.WebSocket = class { constructor() { deny(); } };',
    "",
  ].join("\n"));
  return guard;
}

function verifyGuardedNetworkSurfacesDisabled(env) {
  const nodeProbe = run(process.execPath, [
    "-e",
    'try { require("node:net").connect(443, "example.com"); process.exit(2); } catch (error) { if (!String(error.message).includes("MATRIX_EXTERNAL_NETWORK_DISABLED")) throw error; }',
  ], { env, allowFailure: true, timeout: 10_000 });
  const gitProbe = run(actualGit, ["ls-remote", "https://example.com/disabled.git"], {
    env,
    allowFailure: true,
    timeout: 10_000,
  });
  const npmProbe = runNpm(["view", "matrix-network-probe-never-cached", "version"], {
    env,
    allowFailure: true,
    timeout: 10_000,
  });
  return nodeProbe.status === 0
    && gitProbe.status !== 0
    && /transport ['\"]?https['\"]? not allowed/i.test(`${gitProbe.stdout}${gitProbe.stderr}`)
    && npmProbe.status !== 0
    && /(?:offline|ENOTCACHED|cache)/i.test(`${npmProbe.stdout}${npmProbe.stderr}`);
}

function formatCommand(command, args) {
  return [command, ...args].map((part) => /\s/.test(part) ? JSON.stringify(part) : part).join(" ");
}

function windowsCommandQuote(value) {
  return /^[A-Za-z0-9_./:=@-]+$/.test(value) ? value : `"${value.replace(/"/g, '\\"')}"`;
}

function run(command, args, options = {}) {
  const requestedTimeout = options.timeout ?? 300_000;
  const remaining = remainingMatrixMilliseconds();
  if (remaining <= 0) {
    throw new Error(`Matrix hard deadline exceeded before ${matrixPhase}: ${formatCommand(command, args)}`);
  }
  const timeout = Math.max(1, Math.min(requestedTimeout, remaining));
  const deadlineBound = timeout < requestedTimeout;
  const child = spawnSync(command, args, {
    cwd: options.cwd,
    env: options.env,
    encoding: "utf8",
    stdio: ["ignore", "pipe", "pipe"],
    timeout,
    maxBuffer: options.maxBuffer ?? 32 * 1024 * 1024,
    windowsVerbatimArguments: options.windowsVerbatimArguments,
    detached: options.detached ?? true,
  });
  if (child.error) {
    if (child.error.code === "ETIMEDOUT") {
      killProcessTree(child);
      const kind = deadlineBound ? "hard deadline" : "command timeout";
      throw new Error(`Matrix ${kind} exceeded during ${matrixPhase} after ${timeout}ms: ${formatCommand(command, args)}`);
    }
    throw child.error;
  }
  const outcome = {
    status: child.status,
    signal: child.signal,
    stdout: child.stdout ?? "",
    stderr: child.stderr ?? "",
  };
  if (!options.allowFailure && child.status !== 0) {
    const detail = `${outcome.stdout}${outcome.stderr}`.trim();
    throw new Error(`${formatCommand(command, args)} failed with exit ${child.status}${detail ? `:\n${detail}` : ""}`);
  }
  if (remainingMatrixMilliseconds() <= 0) {
    throw new Error(`Matrix hard deadline exceeded after ${matrixPhase}: ${formatCommand(command, args)}`);
  }
  return outcome;
}

function runNpm(args, options = {}) {
  if (process.platform !== "win32") return run(npmExecutable, args, options);
  // Node's Windows process hardening refuses direct shell-less .cmd spawning.
  // Route only npm through cmd.exe and quote every fixed argv element ourselves.
  const commandLine = [npmExecutable, ...args].map(windowsCommandQuote).join(" ");
  return run("cmd.exe", ["/d", "/s", "/c", commandLine], {
    ...options,
    windowsVerbatimArguments: true,
  });
}

function waitMilliseconds(milliseconds) {
  const sleeper = new Int32Array(new SharedArrayBuffer(4));
  Atomics.wait(sleeper, 0, 0, milliseconds);
}

function git(cwd, args, env) {
  return run(actualGit, args, { cwd, env, timeout: 60_000 }).stdout.trim();
}

function gitBare(repo, args, env) {
  return run(actualGit, ["--git-dir", repo, ...args], { env, timeout: 60_000 }).stdout.trim();
}

function configureRepo(root, actor, env, hooksRoot) {
  mkdirSync(hooksRoot, { recursive: true });
  git(root, ["config", "user.name", actor], env);
  git(root, ["config", "user.email", `${actor.toLowerCase()}@matrix-release.test`], env);
  git(root, ["config", "commit.gpgsign", "false"], env);
  git(root, ["config", "core.hooksPath", hooksRoot], env);
}

function cloneExactSource(temp, name, ref, expectedCommit, env) {
  const target = join(temp, name);
  run(actualGit, ["clone", "-q", "--shared", "--no-checkout", projectRoot, target], { env, timeout: 120_000 });
  git(target, ["checkout", "-q", "--detach", expectedCommit], env);
  const actual = git(target, ["rev-parse", "HEAD^{commit}"], env);
  if (actual !== expectedCommit) throw new Error(`${ref} resolved to ${actual}, expected ${expectedCommit}`);
  const modules = join(projectRoot, "node_modules");
  if (!existsSync(modules)) throw new Error("node_modules is missing; run npm ci before the Matrix release verifier");
  symlinkSync(modules, join(target, "node_modules"), process.platform === "win32" ? "junction" : "dir");
  return target;
}

function dependencyLockProjection(sourceRoot) {
  const lock = JSON.parse(readFileSync(join(sourceRoot, "package-lock.json"), "utf8"));
  delete lock.version;
  if (lock.packages?.[""]) delete lock.packages[""].version;
  return stable(lock);
}

function withoutPeerPlacementMarkers(value) {
  if (Array.isArray(value)) return value.map(withoutPeerPlacementMarkers);
  if (value && typeof value === "object") {
    return Object.fromEntries(Object.entries(value)
      .filter(([key]) => key !== "peer")
      .map(([key, entry]) => [key, withoutPeerPlacementMarkers(entry)]));
  }
  return value;
}

function platformSelectorAllows(value, current) {
  const selectors = Array.isArray(value) ? value : (typeof value === "string" ? [value] : []);
  if (!selectors.length) return true;
  if (selectors.includes(`!${current}`)) return false;
  const positive = selectors.filter((selector) => typeof selector === "string" && !selector.startsWith("!"));
  return positive.length === 0 || positive.includes(current);
}

/** npm keeps every platform variant in package-lock.json, but its installed
 * lock contains only the optional packages compatible with this OS/CPU. Drop
 * exactly those explicitly incompatible optional entries; a missing required
 * or compatible optional package must still fail the release gate. */
export function expectedInstalledDependencyPackages(
  packages,
  platform = process.platform,
  arch = process.arch,
) {
  return Object.fromEntries(Object.entries(packages ?? {}).filter(([path, entry]) => {
    if (path === "") return false;
    if (!entry || typeof entry !== "object" || entry.optional !== true) return true;
    return platformSelectorAllows(entry.os, platform) && platformSelectorAllows(entry.cpu, arch);
  }));
}

export function installedDependencyProjection(sourceRoot) {
  const rootLock = JSON.parse(readFileSync(join(sourceRoot, "package-lock.json"), "utf8"));
  const installedLock = JSON.parse(readFileSync(join(projectRoot, "node_modules", ".package-lock.json"), "utf8"));
  const expected = expectedInstalledDependencyPackages(rootLock.packages);
  return {
    expected: stable(withoutPeerPlacementMarkers(expected)),
    installed: stable(withoutPeerPlacementMarkers(installedLock.packages ?? {})),
  };
}

function packageSource(sourceRoot, packagesDir, cacheDir, env) {
  const buildEnv = { ...env, NPM_CONFIG_CACHE: cacheDir };
  runNpm(["run", "build"], { cwd: sourceRoot, env: buildEnv, timeout: 300_000 });
  const packed = runNpm([
    "pack", "--json", "--ignore-scripts", "--pack-destination", packagesDir, ".",
  ], { cwd: sourceRoot, env: buildEnv, timeout: 120_000 });
  let manifest;
  try {
    manifest = JSON.parse(packed.stdout)[0];
  } catch {
    throw new Error(`npm pack did not return its JSON manifest:\n${packed.stdout}${packed.stderr}`);
  }
  if (!manifest?.filename || !manifest?.version) throw new Error("npm pack returned an incomplete package manifest");
  if (manifest.name !== "@davesheffer/hunch") {
    throw new Error(`npm pack produced ${String(manifest.name)}, expected @davesheffer/hunch`);
  }
  const tarball = join(packagesDir, manifest.filename);
  if (!existsSync(tarball)) throw new Error(`npm pack did not create ${tarball}`);
  return {
    version: String(manifest.version),
    tarball,
    sha256: sha256(readFileSync(tarball)),
    shasum: String(manifest.shasum ?? ""),
    integrity: String(manifest.integrity ?? ""),
  };
}

function installTarball(pack, installRoot) {
  const modules = join(installRoot, "node_modules");
  mkdirSync(modules, { recursive: true });
  for (const entry of readdirSync(join(projectRoot, "node_modules"), { withFileTypes: true })) {
    if (entry.name === ".bin" || entry.name === ".package-lock.json" || entry.name === "@davesheffer") continue;
    if (!entry.isDirectory() && !entry.isSymbolicLink()) continue;
    const source = join(projectRoot, "node_modules", entry.name);
    const target = join(modules, entry.name);
    symlinkSync(source, target, process.platform === "win32" ? "junction" : "dir");
  }
  const packageRoot = join(modules, "@davesheffer", "hunch");
  mkdirSync(packageRoot, { recursive: true });
  run(tarExecutable, ["-xzf", pack.tarball, "--strip-components=1", "-C", packageRoot], { timeout: 120_000 });
  const installed = JSON.parse(readFileSync(join(packageRoot, "package.json"), "utf8"));
  if (installed.version !== pack.version) {
    throw new Error(`installed tarball reports ${installed.version}, expected ${pack.version}`);
  }
  const cli = join(packageRoot, "dist", "cli", "index.js");
  if (!existsSync(cli)) throw new Error(`packed install is missing ${cli}`);
  return { cli, version: installed.version };
}

function actorEnvironment(home, name, isolationEnv, extra = {}) {
  if (!isolationEnv?.NODE_OPTIONS) {
    throw new Error("Matrix actor environment requires the installed Node network guard");
  }
  return cleanEnvironment(home, {
    NODE_OPTIONS: isolationEnv.NODE_OPTIONS,
    GIT_AUTHOR_NAME: name,
    GIT_AUTHOR_EMAIL: `${name.toLowerCase()}@matrix-release.test`,
    GIT_COMMITTER_NAME: name,
    GIT_COMMITTER_EMAIL: `${name.toLowerCase()}@matrix-release.test`,
    GIT_AUTHOR_DATE: "2026-07-19T12:00:00Z",
    GIT_COMMITTER_DATE: "2026-07-19T12:00:00Z",
    ...extra,
  });
}

function cliOutcome(actor, installation, args, options = {}) {
  return run(process.execPath, [installation.cli, ...args], {
    cwd: actor.root,
    env: options.env ?? actor.env,
    timeout: options.timeout ?? 180_000,
    allowFailure: options.allowFailure,
    maxBuffer: 16 * 1024 * 1024,
  });
}

function cliText(actor, installation, args, options = {}) {
  const result = cliOutcome(actor, installation, args, options);
  return `${result.stdout}${result.stderr}`;
}

function constraintIdFromOutput(text) {
  const id = text.match(/constraint (con_[A-Za-z0-9._-]+)/)?.[1];
  if (!id) throw new Error(`could not find the recorded constraint id in CLI output:\n${text}`);
  return id;
}

function seedRemotes(temp, candidate, env) {
  const memorySeed = join(temp, "memory-seed");
  const memoryRemote = join(temp, "memory.git");
  const codeSeed = join(temp, "code-seed");
  const codeRemote = join(temp, "code.git");
  mkdirSync(memorySeed, { recursive: true });
  git(memorySeed, ["init", "-q", "-b", "main"], env);
  configureRepo(memorySeed, "MatrixMemorySeed", env, join(temp, "memory-seed-hooks"));
  writeFileSync(join(memorySeed, "README.md"), "# Matrix release verification memory\n");
  git(memorySeed, ["add", "README.md"], env);
  git(memorySeed, ["commit", "-qm", "seed: Matrix memory"], env);
  run(actualGit, ["clone", "-q", "--bare", memorySeed, memoryRemote], { env });

  mkdirSync(join(codeSeed, "src"), { recursive: true });
  git(codeSeed, ["init", "-q", "-b", "main"], env);
  configureRepo(codeSeed, "MatrixCodeSeed", env, join(temp, "code-seed-hooks"));
  writeFileSync(join(codeSeed, ".gitignore"), "node_modules/\n");
  writeFileSync(join(codeSeed, "package.json"), `${JSON.stringify({
    name: "matrix-release-fixture",
    private: true,
    type: "module",
    dependencies: { axios: "1.0.0" },
  }, null, 2)}\n`);
  writeFileSync(join(codeSeed, "src", "service.ts"), [
    "export function matrixReleaseFixture(): boolean {",
    "  return true;",
    "}",
    "",
  ].join("\n"));
  git(codeSeed, ["add", ".gitignore", "package.json", "src/service.ts"], env);
  git(codeSeed, ["commit", "-qm", "feat: tiny Matrix release fixture"], env);
  const seedActor = {
    name: "MatrixCodeSeed",
    root: codeSeed,
    env: actorEnvironment(join(temp, "code-seed-home"), "MatrixCodeSeed", env),
  };
  const actorNetworkGuardVerified = verifyGuardedNetworkSurfacesDisabled(seedActor.env);
  if (!actorNetworkGuardVerified) {
    throw new Error("an actual Matrix CLI actor did not inherit the Node, Git, and npm network guards");
  }
  cliText(seedActor, candidate, ["init", "--no-index", "--no-enforce", "--no-providers", "--no-agent-hooks"]);
  const shared = cliText(seedActor, candidate, ["shared", "--repo", memoryRemote, "--no-hook"]);
  if (!/shared overlay enabled/.test(shared)) throw new Error(`candidate did not enable shared memory:\n${shared}`);
  git(codeSeed, ["add", "-A"], seedActor.env);
  git(codeSeed, ["commit", "-qm", "chore: connect the Matrix team memory"], seedActor.env);
  run(actualGit, ["clone", "-q", "--bare", codeSeed, codeRemote], { env });
  return { codeRemote, memoryRemote, actorNetworkGuardVerified };
}

function cloneActor(temp, codeRemote, name, env) {
  const root = join(temp, name.toLowerCase());
  const home = join(temp, `${name.toLowerCase()}-home`);
  run(actualGit, ["clone", "-q", codeRemote, root], { env, timeout: 120_000 });
  const actorEnv = actorEnvironment(home, name, env);
  configureRepo(root, name, actorEnv, join(temp, `${name.toLowerCase()}-hooks`));
  return { name, root, env: actorEnv };
}

function remoteTree(remote, env) {
  const output = gitBare(remote, ["ls-tree", "-r", "--name-only", "main"], env);
  return output ? output.split("\n").filter(Boolean).sort() : [];
}

function remoteFile(remote, path, env) {
  return run(actualGit, ["--git-dir", remote, "show", `main:${path}`], { env, timeout: 60_000 }).stdout;
}

function remoteConstraintRecords(remote, env) {
  const records = [];
  for (const path of remoteTree(remote, env)) {
    if (!/^\.hunch\/constraints\/[^/]+\.json$/.test(path)) continue;
    try {
      records.push({ path, value: JSON.parse(remoteFile(remote, path, env)) });
    } catch (error) {
      throw new Error(`remote constraint ${path} is not valid JSON: ${error.message}`);
    }
  }
  return records;
}

function remoteStatementCount(remote, statement, env) {
  return remoteConstraintRecords(remote, env).filter(({ value }) => value.statement === statement).length;
}

function localConstraintByStatement(actor, statement) {
  const local = JSON.parse(readFileSync(join(actor.root, ".hunch", "local.json"), "utf8"));
  const hunchDir = resolve(actor.root, local.privateDir);
  const directory = join(hunchDir, "constraints");
  for (const name of existsSync(directory) ? readdirSync(directory) : []) {
    if (!name.endsWith(".json")) continue;
    const value = JSON.parse(readFileSync(join(directory, name), "utf8"));
    if (value.statement === statement) return { hunchDir };
  }
  return null;
}

function overlayOperationalState(overlayRoot, env) {
  const conflictsClean = git(overlayRoot, ["ls-files", "-u"], env) === "";
  const memoryTreeClean = git(
    overlayRoot, ["status", "--porcelain", "--untracked-files=all", "--", ".hunch"], env,
  ) === "";
  const status = git(overlayRoot, ["status", "--porcelain", "--untracked-files=all"], env);
  const residue = status.split("\n").filter(Boolean);
  const onlyCapabilityPaths = residue.every((line) =>
    line === "?? .gitattributes" || line === "?? .gitignore");
  let capabilitiesCanonical = false;
  try {
    capabilitiesCanonical = readFileSync(join(overlayRoot, ".gitattributes"), "utf8") === OVERLAY_ATTRIBUTES
      && readFileSync(join(overlayRoot, ".gitignore"), "utf8") === OVERLAY_IGNORE;
  } catch { /* missing or unreadable clone-local capability */ }
  const onlyExpectedCloneLocalCapabilities = onlyCapabilityPaths && capabilitiesCanonical;
  return {
    operationallyClean: conflictsClean && memoryTreeClean && onlyExpectedCloneLocalCapabilities,
    memoryTreeClean: conflictsClean && memoryTreeClean,
    onlyExpectedCloneLocalCapabilities,
  };
}

function parseCliJson(outcome, label) {
  try {
    return JSON.parse(outcome.stdout);
  } catch {
    throw new Error(`${label} did not return JSON:\n${outcome.stdout}${outcome.stderr}`);
  }
}

function isUnsupportedPolicyIr(outcome) {
  const output = `${outcome.stdout}${outcome.stderr}`;
  return outcome.status !== 0
    && /ir_version/i.test(output)
    && /(invalid|expected|unrecognized|unsupported)/i.test(output);
}

function isExpectedLegacyApprovalRefusal(outcome) {
  const output = `${outcome.stdout}${outcome.stderr}`;
  return outcome.status !== 0 && (
    /proof\s+\S+\s+does not match the current policy semantics/i.test(output)
    || isUnsupportedPolicyIr(outcome)
    || /cannot activate:.*(?:source-currentness|activation gate)/is.test(output)
  );
}

function runLegacyReproofAttack(temp, codeRemote, memoryRemote, legacy, policyId, env) {
  const actor = cloneActor(temp, codeRemote, "LegacyPolicyAttack", env);
  const overlayRoot = join(temp, "legacy-policy-attack-overlay");
  run(actualGit, ["clone", "-q", memoryRemote, overlayRoot], { env, timeout: 120_000 });
  configureRepo(overlayRoot, "LegacyPolicyAttackMemory", actor.env, join(temp, "legacy-policy-attack-hooks"));
  mkdirSync(join(actor.root, ".hunch"), { recursive: true });
  writeFileSync(join(actor.root, ".hunch", "local.json"), `${JSON.stringify({
    privateDir: join(overlayRoot, ".hunch"),
    autoCommit: false,
    mode: "private",
  }, null, 2)}\n`);

  const policyPath = join(overlayRoot, ".hunch", "policies", `${policyId}.json`);
  const policyBytesBefore = readFileSync(policyPath, "utf8");
  const policyBefore = JSON.parse(policyBytesBefore);
  const result = (refused) => {
    try {
      const policyBytesAfter = readFileSync(policyPath, "utf8");
      const policyAfter = JSON.parse(policyBytesAfter);
      return {
        refused,
        localPolicyBytesPreserved: policyBytesAfter === policyBytesBefore,
        localPolicyStatePreserved:
          policyBefore.state === "proposed" && policyAfter.state === policyBefore.state,
        localPolicyAuthorityPreserved:
          policyBefore.authority === null && policyAfter.authority === policyBefore.authority,
      };
    } catch {
      return {
        refused,
        localPolicyBytesPreserved: false,
        localPolicyStatePreserved: false,
        localPolicyAuthorityPreserved: false,
      };
    }
  };

  const prove = cliOutcome(actor, legacy, ["policy", "prove", policyId], {
    allowFailure: true,
    timeout: 180_000,
  });
  if (isUnsupportedPolicyIr(prove)) return result(true);
  if (prove.status !== 0) return result(false);
  const accept = cliOutcome(actor, legacy, [
    "policy", "accept", policyId, "--advisory", "--actor", "human:matrix-legacy-attack",
  ], { allowFailure: true, timeout: 180_000 });
  return result(isExpectedLegacyApprovalRefusal(accept)
    && /(?:source-currentness|activation gate)/i.test(`${accept.stdout}${accept.stderr}`));
}

function runCompatibilityLane(temp, codeRemote, memoryRemote, candidate, legacy, env) {
  const actor = cloneActor(temp, codeRemote, "CompatibilityLane", env);
  const candidateVersion = cliText(actor, candidate, ["--version"]).trim();
  const legacyVersion = cliText(actor, legacy, ["--version"]).trim();
  if (candidateVersion !== candidate.version || legacyVersion !== legacy.version) {
    throw new Error(`installed CLI versions disagree with their packages: candidate=${candidateVersion}, legacy=${legacyVersion}`);
  }

  const candidateWrite = cliText(actor, candidate, [
    "record-constraint", COMPAT_CANDIDATE,
    "--scope", "src/service.ts", "--severity", "warning", "--type", "correctness",
  ]);
  const candidateId = constraintIdFromOutput(candidateWrite);
  if (!/committed \+ pushed/.test(candidateWrite)) throw new Error(`candidate compatibility write was not published:\n${candidateWrite}`);
  const candidatePath = `.hunch/constraints/${candidateId}.json`;
  const candidateBytesBefore = remoteFile(memoryRemote, candidatePath, env);

  const correctionWrite = cliText(actor, candidate, [
    "record-constraint", COMPAT_POLICY,
    "--scope", "src/service.ts", "--severity", "blocking", "--type", "correctness",
    "--forbid-dep", "axios",
  ]);
  const correctionId = constraintIdFromOutput(correctionWrite);
  const upgradeOutcome = cliOutcome(actor, candidate, [
    "policy", "upgrade-correction", correctionId, "--private", "--json",
  ], { timeout: 180_000 });
  const upgrade = parseCliJson(upgradeOutcome, "candidate correction upgrade");
  if (!["proved", "already_proved"].includes(upgrade.status) || !upgrade.policy || !upgrade.proof) {
    throw new Error(`candidate did not create a proved correction policy:\n${upgradeOutcome.stdout}${upgradeOutcome.stderr}`);
  }
  if (upgrade.policy.authority !== null || upgrade.policy.state !== "proposed") {
    throw new Error("candidate correction upgrade unexpectedly granted authority or skipped proposed state");
  }
  const policyPath = `.hunch/policies/${upgrade.policy.id}.json`;
  const policyBytesBefore = remoteFile(memoryRemote, policyPath, env);
  const policyBefore = JSON.parse(policyBytesBefore);

  const legacyApproval = cliOutcome(actor, legacy, [
    "policy", "accept", upgrade.policy.id, "--advisory", "--actor", "human:matrix-legacy",
  ], { allowFailure: true, timeout: 180_000 });
  const legacyCurrentProofApprovalRefused = isExpectedLegacyApprovalRefusal(legacyApproval);

  const legacyRead = cliText(actor, legacy, ["query", COMPAT_CANDIDATE]);
  const candidateRecordReadByLegacy = legacyRead.includes(candidateId) && legacyRead.includes(SENTINEL_PREFIX);
  const legacyWrite = cliText(actor, legacy, [
    "record-constraint", COMPAT_LEGACY,
    "--scope", "src/service.ts", "--severity", "warning", "--type", "correctness",
  ]);
  const legacyId = constraintIdFromOutput(legacyWrite);
  if (!/committed \+ pushed/.test(legacyWrite)) throw new Error(`legacy compatibility write was not published:\n${legacyWrite}`);
  const candidateBytesAfter = remoteFile(memoryRemote, candidatePath, env);
  const upgradedRead = cliText(actor, candidate, ["query", COMPAT_LEGACY]);
  const legacyRecordReadAfterUpgrade = upgradedRead.includes(legacyId) && upgradedRead.includes(SENTINEL_PREFIX);
  const upgradeWrite = cliText(actor, candidate, [
    "record-constraint", COMPAT_UPGRADE,
    "--scope", "src/service.ts", "--severity", "warning", "--type", "correctness",
  ]);
  const upgradeId = constraintIdFromOutput(upgradeWrite);
  const upgradeRecordPublished = remoteStatementCount(memoryRemote, COMPAT_UPGRADE, env) === 1
    && remoteTree(memoryRemote, env).includes(`.hunch/constraints/${upgradeId}.json`);
  const legacyReproofAttack = runLegacyReproofAttack(
    temp, codeRemote, memoryRemote, legacy, upgrade.policy.id, env,
  );
  const policyBytesAfter = remoteFile(memoryRemote, policyPath, env);
  const policyAfter = JSON.parse(policyBytesAfter);

  return {
    sequence: ["candidate", "legacy", "candidate"],
    candidate_record_read_by_legacy: candidateRecordReadByLegacy,
    candidate_record_bytes_preserved_by_legacy_write: candidateBytesBefore === candidateBytesAfter,
    legacy_record_read_after_upgrade: legacyRecordReadAfterUpgrade,
    upgrade_record_published: upgradeRecordPublished,
    candidate_policy_bytes_preserved_by_legacy_write: policyBytesBefore === policyBytesAfter,
    candidate_policy_origin_preserved_by_legacy_write: policyBefore.origin === "correction_md1a"
      && policyAfter.origin === policyBefore.origin,
    candidate_policy_activation_gate_preserved_by_legacy_write:
      policyBefore.activation_gate?.kind === "source_currentness"
      && policyBefore.activation_gate?.status === "blocked"
      && jsonEqual(policyAfter.activation_gate, policyBefore.activation_gate),
    candidate_policy_state_preserved_by_legacy_attack:
      policyBefore.state === "proposed" && policyAfter.state === policyBefore.state,
    candidate_policy_authority_preserved_by_legacy_attack:
      policyBefore.authority === null && policyAfter.authority === null,
    attack_clone_policy_bytes_preserved: legacyReproofAttack.localPolicyBytesPreserved,
    attack_clone_policy_state_preserved: legacyReproofAttack.localPolicyStatePreserved,
    attack_clone_policy_authority_preserved: legacyReproofAttack.localPolicyAuthorityPreserved,
    legacy_current_proof_approval_refused: legacyCurrentProofApprovalRefused,
    legacy_reproof_activation_refused: legacyReproofAttack.refused,
  };
}

function writeCrashGitWrapper(wrapperRoot) {
  mkdirSync(wrapperRoot, { recursive: true });
  const module = join(wrapperRoot, "git-wrapper.mjs");
  writeFileSync(module, [
    'import { spawnSync } from "node:child_process";',
    'import { writeFileSync } from "node:fs";',
    'const args = process.argv.slice(2);',
    'if (process.env.HUNCH_MATRIX_CRASH_ON_COMMIT === "1" && args.includes("commit")) {',
    '  writeFileSync(process.env.HUNCH_MATRIX_CRASH_MARKER, JSON.stringify({ pid: process.pid, args }) + "\\n");',
    '  const sleeper = new Int32Array(new SharedArrayBuffer(4));',
    '  for (;;) Atomics.wait(sleeper, 0, 0, 60_000);',
    '}',
    'const env = { ...process.env };',
    'delete env.HUNCH_MATRIX_CRASH_ON_COMMIT;',
    'delete env.HUNCH_MATRIX_CRASH_MARKER;',
    'const child = spawnSync(process.env.HUNCH_MATRIX_REAL_GIT, args, { stdio: "inherit", env });',
    'if (child.error) { console.error(child.error.message); process.exit(127); }',
    'process.exit(child.status ?? 1);',
    "",
  ].join("\n"));
  if (process.platform === "win32") {
    writeFileSync(join(wrapperRoot, "git.cmd"), `@\"${process.execPath}\" \"${module}\" %*\r\n`);
  } else {
    const executable = join(wrapperRoot, "git");
    writeFileSync(executable, `#!/bin/sh\nexec \"${process.execPath}\" \"${module}\" \"$@\"\n`);
    chmodSync(executable, 0o755);
  }
}

function spawnCli(actor, installation, args, env, detached = false) {
  const child = spawn(process.execPath, [installation.cli, ...args], {
    cwd: actor.root,
    env,
    detached,
    stdio: ["ignore", "pipe", "pipe"],
  });
  let stdout = "";
  let stderr = "";
  child.stdout.setEncoding("utf8");
  child.stderr.setEncoding("utf8");
  child.stdout.on("data", (chunk) => { if (stdout.length < 16 * 1024 * 1024) stdout += chunk; });
  child.stderr.on("data", (chunk) => { if (stderr.length < 16 * 1024 * 1024) stderr += chunk; });
  const completed = new Promise((resolveCompleted) => {
    child.on("error", (error) => resolveCompleted({ status: null, signal: null, stdout, stderr, error }));
    child.on("close", (status, signal) => resolveCompleted({ status, signal, stdout, stderr, error: null }));
  });
  return { child, completed };
}

async function runCliAsync(actor, installation, args, timeout = 180_000) {
  const remaining = remainingMatrixMilliseconds();
  if (remaining <= 0) throw new Error(`Matrix hard deadline exceeded before ${matrixPhase} for ${actor.name}`);
  const effectiveTimeout = Math.max(1, Math.min(timeout, remaining));
  const deadlineBound = effectiveTimeout < timeout;
  const { child, completed } = spawnCli(actor, installation, args, actor.env, true);
  let timedOut = false;
  const timer = setTimeout(() => {
    timedOut = true;
    killProcessTree(child);
  }, effectiveTimeout);
  const result = await completed;
  clearTimeout(timer);
  return timedOut
    ? { ...result, status: null, signal: deadlineBound ? "HARD_DEADLINE" : "TIMEOUT" }
    : result;
}

function killProcessTree(child) {
  if (!child.pid) return false;
  try {
    if (process.platform === "win32") {
      const killed = spawnSync("taskkill", ["/pid", String(child.pid), "/t", "/f"], { stdio: "ignore" });
      return killed.status === 0;
    }
    process.kill(-child.pid, "SIGKILL");
    return true;
  } catch {
    try { return child.kill("SIGKILL"); } catch { return false; }
  }
}

async function runCrashLane(temp, codeRemote, memoryRemote, candidate, env) {
  const actor = cloneActor(temp, codeRemote, "CrashLane", env);
  cliText(actor, candidate, ["query", SENTINEL_PREFIX]);
  const wrapperRoot = join(temp, "crash-git-wrapper");
  const marker = join(temp, "crash-commit-seam.json");
  writeCrashGitWrapper(wrapperRoot);
  const crashEnv = {
    ...actor.env,
    PATH: `${wrapperRoot}${delimiter}${actor.env.PATH ?? ""}`,
    HUNCH_MATRIX_REAL_GIT: actualGit,
    HUNCH_MATRIX_CRASH_ON_COMMIT: "1",
    HUNCH_MATRIX_CRASH_MARKER: marker,
  };
  const spawned = spawnCli(actor, candidate, [
    "record-constraint", CRASH_INTERRUPTED,
    "--scope", "src/service.ts", "--severity", "warning", "--type", "correctness",
  ], crashEnv, true);
  try {
    const deadline = Math.min(Date.now() + 30_000, matrixDeadlineEpochMs);
    while (!existsSync(marker) && Date.now() < deadline && spawned.child.exitCode === null) waitMilliseconds(10);
    const commitSeamReached = existsSync(marker);
    if (!commitSeamReached) {
      if (remainingMatrixMilliseconds() <= 0) {
        throw new Error(`Matrix hard deadline exceeded during ${matrixPhase}: crash injection did not reach git commit`);
      }
      const result = await Promise.race([
        spawned.completed,
        new Promise((resolveResult) => setTimeout(() => resolveResult({ stdout: "", stderr: "" }), 100)),
      ]);
      throw new Error(`crash injection never reached git commit:\n${result.stdout}${result.stderr}`);
    }
    const localInterrupted = localConstraintByStatement(actor, CRASH_INTERRUPTED);
    if (!localInterrupted) throw new Error("crash injection reached commit without a durable interrupted JSON record");
    const lock = join(localInterrupted.hunchDir, ".hunch-commit.lock");
    if (!existsSync(lock)) throw new Error("crash injection reached commit without the owned publication lock");
    const killRequested = killProcessTree(spawned.child);
    const killed = await spawned.completed;
    const processKilled = killRequested && (killed.signal !== null || killed.status !== 0);

    const recovery = cliText(actor, candidate, [
      "record-constraint", CRASH_RECOVERY,
      "--scope", "src/service.ts", "--severity", "warning", "--type", "correctness",
    ], { timeout: 180_000 });
    if (!/committed \+ pushed/.test(recovery)) throw new Error(`crash recovery did not publish:\n${recovery}`);
    const deadOwnerLockReclaimed = !existsSync(lock);
    const overlayRoot = dirname(localInterrupted.hunchDir);
    const overlayState = overlayOperationalState(overlayRoot, actor.env);
    return {
      injected: true,
      commit_seam_reached: commitSeamReached,
      process_killed: processKilled,
      dead_owner_lock_reclaimed: deadOwnerLockReclaimed,
      interrupted_record_recovered: remoteStatementCount(memoryRemote, CRASH_INTERRUPTED, env) === 1,
      recovery_record_published: remoteStatementCount(memoryRemote, CRASH_RECOVERY, env) === 1,
      overlay_operationally_clean: overlayState.operationallyClean,
      overlay_memory_tree_clean: overlayState.memoryTreeClean,
      only_expected_clone_local_capabilities_untracked: overlayState.onlyExpectedCloneLocalCapabilities,
    };
  } finally {
    if (spawned.child.exitCode === null && spawned.child.signalCode === null) {
      killProcessTree(spawned.child);
      await spawned.completed;
    }
  }
}

function uniqueSoakStatement(round, actor) {
  return `${SENTINEL_PREFIX}SOAK_R${String(round).padStart(2, "0")}_A${String(actor).padStart(2, "0")}: concurrent memory must converge without loss`;
}

async function requireAsyncSuccess(result, label) {
  if (result.error) throw result.error;
  if (result.status !== 0) {
    throw new Error(`${label} failed with ${result.signal ?? result.status}:\n${result.stdout}${result.stderr}`);
  }
  return `${result.stdout}${result.stderr}`;
}

async function runSoak(temp, codeRemote, memoryRemote, candidate, env, actorCount, rounds) {
  const actors = Array.from({ length: actorCount }, (_, index) =>
    cloneActor(temp, codeRemote, `Soak${String(index).padStart(2, "0")}`, env));
  const prewire = await Promise.all(actors.map((actor) => runCliAsync(actor, candidate, ["query", SENTINEL_PREFIX])));
  for (let index = 0; index < prewire.length; index += 1) {
    await requireAsyncSuccess(prewire[index], `soak actor ${index} prewire`);
  }

  const expected = [];
  let allCommandsSucceeded = true;
  for (let round = 0; round < rounds; round += 1) {
    const operations = actors.map((actor, index) => {
      const statement = uniqueSoakStatement(round, index);
      expected.push(statement);
      return runCliAsync(actor, candidate, [
        "record-constraint", statement,
        "--scope", "src/service.ts", "--severity", "warning", "--type", "correctness",
      ]);
    });
    const results = await Promise.all(operations);
    for (let index = 0; index < results.length; index += 1) {
      try { await requireAsyncSuccess(results[index], `soak round ${round} actor ${index}`); }
      catch (error) { allCommandsSucceeded = false; throw error; }
    }
  }

  const collision = await Promise.all(actors.map((actor) => runCliAsync(actor, candidate, [
    "record-constraint", COLLISION_RULE,
    "--scope", "src/service.ts", "--severity", "warning", "--type", "correctness",
  ])));
  for (let index = 0; index < collision.length; index += 1) {
    try { await requireAsyncSuccess(collision[index], `collision actor ${index}`); }
    catch (error) { allCommandsSucceeded = false; throw error; }
  }

  // First pass publishes every locally stranded commit. The second pass pulls the
  // final accumulated remote into actors that synchronized earlier in the first pass.
  for (let pass = 0; pass < 2; pass += 1) {
    for (const actor of actors) {
      const sync = await runCliAsync(actor, candidate, ["shared", "--sync", "--no-hook"]);
      try { await requireAsyncSuccess(sync, `soak reconciliation pass ${pass} for ${actor.name}`); }
      catch (error) { allCommandsSucceeded = false; throw error; }
    }
  }

  const records = remoteConstraintRecords(memoryRemote, env);
  const statements = records.map(({ value }) => value.statement);
  const observed = expected.filter((statement) => statements.filter((value) => value === statement).length === 1).length;
  const collisionObserved = statements.filter((statement) => statement === COLLISION_RULE).length;
  const remoteHunchTree = gitBare(memoryRemote, ["rev-parse", "main:.hunch"], env);
  let allClonesConverged = true;
  let allOverlaysClean = true;
  let allOverlayMemoryTreesClean = true;
  let onlyExpectedCloneLocalCapabilities = true;
  for (const actor of actors) {
    const local = JSON.parse(readFileSync(join(actor.root, ".hunch", "local.json"), "utf8"));
    const overlayRoot = dirname(resolve(actor.root, local.privateDir));
    allClonesConverged = allClonesConverged
      && git(overlayRoot, ["rev-parse", "HEAD:.hunch"], actor.env) === remoteHunchTree;
    const state = overlayOperationalState(overlayRoot, actor.env);
    allOverlaysClean = allOverlaysClean && state.operationallyClean;
    allOverlayMemoryTreesClean = allOverlayMemoryTreesClean && state.memoryTreeClean;
    onlyExpectedCloneLocalCapabilities = onlyExpectedCloneLocalCapabilities
      && state.onlyExpectedCloneLocalCapabilities;
  }
  const branches = gitBare(memoryRemote, ["for-each-ref", "--format=%(refname)", "refs/heads"], env)
    .split("\n").filter(Boolean);

  return {
    actors: actorCount,
    rounds,
    unique_writes_expected: expected.length,
    unique_writes_observed: observed,
    collision_writers: actorCount,
    collision_records_observed: collisionObserved,
    all_commands_succeeded: allCommandsSucceeded,
    all_clones_converged: allClonesConverged,
    all_overlays_clean: allOverlaysClean,
    all_overlay_memory_trees_clean: allOverlayMemoryTreesClean,
    only_expected_clone_local_capabilities_untracked: onlyExpectedCloneLocalCapabilities,
    one_canonical_remote_branch: branches.length === 1 && branches[0] === "refs/heads/main",
  };
}

function privacyEvidence(codeRemote, memoryRemote, env) {
  const codeHistory = gitBare(codeRemote, ["log", "-p", "--all"], env);
  const publicTree = remoteTree(codeRemote, env);
  const memoryTree = remoteTree(memoryRemote, env);
  const codeHistoryPaths = gitBare(codeRemote, ["log", "--all", "--format=", "--name-only"], env)
    .split("\n").map((path) => path.trim()).filter(Boolean);
  const memoryHistoryPaths = gitBare(memoryRemote, ["log", "--all", "--format=", "--name-only"], env)
    .split("\n").map((path) => path.trim()).filter(Boolean);
  const isPrivateRuntimeArtifact = (path) => path === ".hunch/local.json"
    || /(?:^|\/)\.hunch-cache(?:\/|$)/.test(path)
    || /(?:^|\/)\.hunch-private(?:\/|$)/.test(path)
    || /(?:^|\/)\.hunch-commit\.lock(?:\/|$)/.test(path)
    || /\.sqlite(?:-|$)/.test(path)
    || /(?:^|\/)events\.log$/.test(path)
    || /\.tmp(?:-|$)/.test(path);
  return {
    sentinel_in_code_history: codeHistory.includes(SENTINEL_PREFIX)
      || publicTree.some((path) => /^\.hunch\/(constraints|decisions|bugs|policies|proofs)\//.test(path)),
    private_runtime_artifacts_in_code_remote: publicTree.some(isPrivateRuntimeArtifact),
    private_runtime_artifacts_in_code_remote_history: codeHistoryPaths.some(isPrivateRuntimeArtifact),
    private_runtime_artifacts_in_memory_remote: memoryTree.some(isPrivateRuntimeArtifact),
    private_runtime_artifacts_in_memory_remote_history: memoryHistoryPaths.some(isPrivateRuntimeArtifact),
  };
}

function atomicWrite(file, value) {
  const target = resolve(projectRoot, file);
  mkdirSync(dirname(target), { recursive: true });
  const temporary = `${target}.tmp-${process.pid}`;
  writeFileSync(temporary, `${JSON.stringify(value, null, 2)}\n`);
  renameSync(temporary, target);
  return target;
}

async function executeMatrixVerification(options) {
  const verificationStarted = performance.now();
  const verificationStartedAt = Date.now();
  matrixDeadlineEpochMs = verificationStartedAt + MATRIX_PERFORMANCE_LIMITS.total_ms;
  enterMatrixPhase("release-context preflight");
  process.stderr.write(
    `Matrix hard deadline: ${new Date(matrixDeadlineEpochMs).toISOString()} `
      + `(${MATRIX_PERFORMANCE_LIMITS.total_ms}ms after ${new Date(verificationStartedAt).toISOString()})\n`,
  );
  const baseline = expectedBaseline(options);
  const preflightHome = mkdtempSync(join(tmpdir(), "hunch-matrix-preflight-"));
  const preflightEnv = cleanEnvironment(preflightHome);
  let candidateCommit;
  let legacyResolved;
  let candidateClean;
  try {
    candidateCommit = git(projectRoot, ["rev-parse", "HEAD^{commit}"], preflightEnv);
    legacyResolved = git(projectRoot, ["rev-parse", `${baseline.tag}^{commit}`], preflightEnv);
    candidateClean = git(projectRoot, ["status", "--porcelain", "--untracked-files=all"], preflightEnv) === "";
  } finally {
    rmSync(preflightHome, { recursive: true, force: true });
  }
  if (legacyResolved !== baseline.commit) {
    throw new Error(`${baseline.tag} resolves to ${legacyResolved}; expected pinned ${baseline.commit}`);
  }
  if (!candidateClean && !options.allowDirty) {
    throw new Error("working tree is dirty; commit the candidate before running the release-blocking Matrix verifier");
  }

  const temp = mkdtempSync(join(tmpdir(), "hunch-matrix-release-"));
  const runHome = join(temp, "run-home");
  const networkGuard = installNetworkGuard(temp);
  const env = cleanEnvironment(runHome, {
    NODE_OPTIONS: `--import=${pathToFileURL(networkGuard).href}`,
  });
  try {
    enterMatrixPhase("offline isolation and package construction");
    if (!verifyGuardedNetworkSurfacesDisabled(env)) {
      throw new Error("guarded Node, Git, and npm network surfaces did not fail closed");
    }
    const packagesDir = join(temp, "packages");
    mkdirSync(packagesDir, { recursive: true });
    const legacySource = cloneExactSource(temp, "legacy-source", baseline.tag, baseline.commit, env);
    const candidateSource = cloneExactSource(temp, "candidate-source", candidateCommit, candidateCommit, env);
    const legacyDependencyLock = dependencyLockProjection(legacySource);
    const candidateDependencyLock = dependencyLockProjection(candidateSource);
    const dependencyLock = assertDependencyLockProjection(legacyDependencyLock, candidateDependencyLock);
    const installedDependencies = installedDependencyProjection(candidateSource);
    if (!jsonEqual(installedDependencies.expected, installedDependencies.installed)) {
      throw new Error("node_modules does not match the candidate package-lock; run npm ci before Matrix verification");
    }
    const legacyPack = packageSource(legacySource, packagesDir, join(temp, "legacy-npm-cache"), env);
    const candidatePack = packageSource(candidateSource, packagesDir, join(temp, "candidate-npm-cache"), env);
    if (legacyPack.version !== baseline.tag.slice(1)) {
      throw new Error(`${baseline.tag} package version is ${legacyPack.version}, expected ${baseline.tag.slice(1)}`);
    }
    assertLegacyMatrixTarball(legacyPack, baseline.tarball);
    if ((compareSemver(candidatePack.version, legacyPack.version) ?? -1) <= 0) {
      throw new Error(`candidate package ${candidatePack.version} is not newer than compatibility baseline ${legacyPack.version}`);
    }
    const legacy = installTarball(legacyPack, join(temp, "legacy-install"));
    const candidate = installTarball(candidatePack, join(temp, "candidate-install"));
    const { codeRemote, memoryRemote, actorNetworkGuardVerified } = seedRemotes(temp, candidate, env);

    enterMatrixPhase("candidate-legacy-candidate compatibility");
    let laneStarted = performance.now();
    const compatibility = runCompatibilityLane(temp, codeRemote, memoryRemote, candidate, legacy, env);
    const compatibilityMs = measuredMilliseconds(laneStarted);
    enterMatrixPhase("crash recovery");
    laneStarted = performance.now();
    const crashRecovery = await runCrashLane(temp, codeRemote, memoryRemote, candidate, env);
    const crashRecoveryMs = measuredMilliseconds(laneStarted);
    enterMatrixPhase("bounded concurrent soak");
    laneStarted = performance.now();
    const soak = await runSoak(temp, codeRemote, memoryRemote, candidate, env, options.actors, options.rounds);
    const soakMs = measuredMilliseconds(laneStarted);
    enterMatrixPhase("privacy and convergence receipt");
    const privacy = privacyEvidence(codeRemote, memoryRemote, env);
    const soakWriteOps = soak.unique_writes_expected + soak.collision_writers;
    const measuredTotal = Math.ceil(performance.now() - verificationStarted);
    const performanceEvidence = {
      compatibility_ms: compatibilityMs,
      crash_recovery_ms: crashRecoveryMs,
      soak_ms: soakMs,
      total_ms: Math.max(measuredTotal, compatibilityMs + crashRecoveryMs + soakMs),
      soak_write_ops: soakWriteOps,
      soak_write_ops_per_second: Number((soakWriteOps / (soakMs / 1_000)).toFixed(3)),
      limits: { ...MATRIX_PERFORMANCE_LIMITS },
    };
    const evidence = {
      source: {
        candidate_commit: candidateCommit,
        candidate_clean: candidateClean,
        legacy_tag: baseline.tag,
        legacy_commit: legacyResolved,
      },
      packages: {
        legacy: {
          version: legacyPack.version,
          sha256: legacyPack.sha256,
          shasum: legacyPack.shasum,
          integrity: legacyPack.integrity,
          install_mode: "isolated_tarball",
        },
        candidate: {
          version: candidatePack.version,
          sha256: candidatePack.sha256,
          install_mode: "isolated_tarball",
        },
      },
      compatibility,
      crash_recovery: crashRecovery,
      soak,
      performance: performanceEvidence,
      privacy,
      isolation: {
        guarded_network_surfaces_disabled: actorNetworkGuardVerified,
        guarded_network_surfaces: ["git", "node", "npm"],
        node_network_guard_verified: actorNetworkGuardVerified,
        git_protocols_limited_to_file: true,
        npm_offline: true,
        credentials_inherited: false,
        dependency_lock_equivalent: dependencyLock.equivalent,
        dependency_lock_hash: dependencyLock.hash,
        dependency_tree_source: "candidate-npm-ci-with-identical-lock",
        legacy_source: "pinned_local_tag",
        candidate_source: "packed_exact_commit",
      },
    };
    const receiptOptions = {
      legacyTag: baseline.tag,
      legacyCommit: baseline.commit,
      legacySha256: baseline.tarball.sha256,
      legacyShasum: baseline.tarball.shasum,
      legacyIntegrity: baseline.tarball.integrity,
    };
    const receipt = buildMatrixReceipt(evidence, receiptOptions);
    if (!verifyMatrixReceipt(receipt, receiptOptions)) {
      throw new Error("Matrix receipt failed its own content-address verification");
    }
    return { receipt, temp };
  } catch (error) {
    if (options.keepTemp) process.stderr.write(`Matrix verifier retained failed fixture: ${temp}\n`);
    else rmSync(temp, { recursive: true, force: true });
    throw error;
  }
}

async function main() {
  const options = parseMatrixReleaseArgs(process.argv.slice(2));
  if (options.help) {
    process.stdout.write(`${help()}\n`);
    return;
  }
  const { receipt, temp } = await executeMatrixVerification(options);
  try {
    const output = atomicWrite(options.output, receipt);
    process.stdout.write(`${JSON.stringify(receipt, null, 2)}\n`);
    process.stdout.write(`Matrix release verification ${receipt.result}: ${receipt.content_hash}\n`);
    process.stdout.write(`Release ready: ${receipt.release_ready ? "yes" : "no"}; receipt: ${output}\n`);
    if (receipt.result !== "passed" || (!options.allowDirty && !receipt.release_ready)) process.exitCode = 1;
  } finally {
    if (options.keepTemp) process.stderr.write(`Matrix verifier retained fixture: ${temp}\n`);
    else rmSync(temp, { recursive: true, force: true });
  }
}

if (process.argv[1] && import.meta.url === pathToFileURL(resolve(process.argv[1])).href) {
  main().catch((error) => {
    process.stderr.write(`Matrix release verification failed: ${error.message}\n`);
    process.exitCode = 1;
  });
}
