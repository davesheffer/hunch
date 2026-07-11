import { execFileSync, spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import {
  existsSync,
  lstatSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  readdirSync,
  renameSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { basename, join } from "node:path";
import { shortHash } from "../core/ids.js";
import { canonicalHash, canonicalJson } from "./canonical.js";
import { replaySafeEnvironment } from "./replay.js";
import type { G2BehaviorCandidate, G2BehaviorCandidateReview } from "./g2BehaviorCandidates.js";

const FULL_SHA = /^[a-f0-9]{40}$/;
const PACKAGE_NAME = /^(?:@[a-z0-9][a-z0-9._-]*\/)?[a-z0-9][a-z0-9._-]*$/i;
const SNAPSHOT_VERSION = 1;

export interface G2BehaviorDependencySnapshot {
  id: string;
  content_hash: string;
  input_hash: string;
  package_json_hash: string;
  sanitized_package_json_hash: string;
  package_lock_hash: string;
  dependency_projection_hash: string;
  runtime: {
    node: string;
    npm: string;
    platform: NodeJS.Platform;
    arch: string;
  };
  allow_install_scripts: string[];
  installed_lock_hash: string;
  native_binaries: Array<{ file: string; sha256: string }>;
  format_version: 1;
  data_class: "private";
  authority: "none";
  effects: "cache_only";
  writes: "cache_only";
}

export interface G2BehaviorDependencySnapshotReceipt {
  id: string;
  content_hash: string;
  candidate_id: string;
  candidate_hash: string;
  review_hash: string;
  snapshots: G2BehaviorDependencySnapshot[];
  legs: {
    known_bad: { commit: string; dependency_snapshot_id: string };
    known_good: { commit: string; dependency_snapshot_id: string };
  };
  allow_install_scripts: string[];
  data_class: "private";
  authority: "none";
  effects: "cache_only";
  writes: "cache_only";
}

interface SnapshotInput {
  packageJson: string;
  packageLock: string;
  sanitizedPackage: Record<string, unknown>;
  inputHash: string;
  packageJsonHash: string;
  sanitizedPackageJsonHash: string;
  packageLockHash: string;
  dependencyProjectionHash: string;
  runtime: G2BehaviorDependencySnapshot["runtime"];
  allowInstallScripts: string[];
}

function sha256(value: string | Buffer): string {
  return `sha256:${createHash("sha256").update(value).digest("hex")}`;
}

function gitFile(root: string, commit: string, file: "package.json" | "package-lock.json"): string {
  if (!FULL_SHA.test(commit)) throw new Error(`dependency snapshot commit ${commit} is not a full SHA`);
  try {
    return execFileSync("git", ["-C", root, "show", `${commit}:${file}`], {
      encoding: "utf8",
      maxBuffer: 20 * 1024 * 1024,
      stdio: ["ignore", "pipe", "ignore"],
    });
  } catch {
    throw new Error(`dependency snapshot requires ${file} at ${commit}`);
  }
}

function parseObject(raw: string, label: string): Record<string, unknown> {
  let value: unknown;
  try { value = JSON.parse(raw); } catch { throw new Error(`dependency snapshot ${label} is not valid JSON`); }
  if (!value || typeof value !== "object" || Array.isArray(value)) throw new Error(`dependency snapshot ${label} must be a JSON object`);
  return value as Record<string, unknown>;
}

function dependencyProjection(pkg: Record<string, unknown>): Record<string, unknown> {
  return {
    dependencies: pkg.dependencies ?? {},
    devDependencies: pkg.devDependencies ?? {},
    optionalDependencies: pkg.optionalDependencies ?? {},
    peerDependencies: pkg.peerDependencies ?? {},
    peerDependenciesMeta: pkg.peerDependenciesMeta ?? {},
    engines: pkg.engines ?? {},
  };
}

function lockedPackageNames(lock: Record<string, unknown>): Set<string> {
  const names = new Set<string>();
  const packages = lock.packages;
  if (!packages || typeof packages !== "object" || Array.isArray(packages)) return names;
  for (const key of Object.keys(packages as Record<string, unknown>)) {
    if (!key.startsWith("node_modules/")) continue;
    const name = key.slice("node_modules/".length);
    if (name && !name.includes("/node_modules/")) names.add(name);
  }
  return names;
}

function normalizeAllowlist(values: string[], lock: Record<string, unknown>): string[] {
  const result = [...new Set(values.map((value) => value.trim()).filter(Boolean))].sort();
  const locked = lockedPackageNames(lock);
  for (const name of result) {
    if (!PACKAGE_NAME.test(name)) throw new Error(`invalid dependency install-script package ${JSON.stringify(name)}`);
    if (!locked.has(name)) throw new Error(`dependency install-script package ${name} is absent from the exact lockfile`);
  }
  return result;
}

function npmExecutable(): string {
  return process.platform === "win32" ? "npm.cmd" : "npm";
}

function buildEnvironment(home: string): NodeJS.ProcessEnv {
  const env = replaySafeEnvironment(home, join(home, "global.gitconfig"));
  for (const key of ["HTTP_PROXY", "HTTPS_PROXY", "NO_PROXY", "http_proxy", "https_proxy", "no_proxy", "npm_config_registry"]) {
    if (process.env[key]) env[key] = process.env[key];
  }
  return env;
}

function runtimeIdentity(env: NodeJS.ProcessEnv): G2BehaviorDependencySnapshot["runtime"] {
  const result = spawnSync(npmExecutable(), ["--version"], {
    env,
    encoding: "utf8",
    timeout: 10_000,
    stdio: ["ignore", "pipe", "ignore"],
    shell: false,
  });
  if (result.status !== 0 || !result.stdout.trim()) throw new Error("dependency snapshot could not identify npm");
  return { node: process.version, npm: result.stdout.trim(), platform: process.platform, arch: process.arch };
}

function snapshotInput(root: string, commit: string, allowInstallScripts: string[], env: NodeJS.ProcessEnv): SnapshotInput {
  const packageJson = gitFile(root, commit, "package.json");
  const packageLock = gitFile(root, commit, "package-lock.json");
  const pkg = parseObject(packageJson, "package.json");
  const lock = parseObject(packageLock, "package-lock.json");
  if (lock.lockfileVersion !== 2 && lock.lockfileVersion !== 3) {
    throw new Error(`dependency snapshot requires npm lockfileVersion 2 or 3 at ${commit}`);
  }
  const normalizedAllowlist = normalizeAllowlist(allowInstallScripts, lock);
  const sanitizedPackage = { ...pkg, scripts: {} };
  const runtime = runtimeIdentity(env);
  const body = {
    package_json_hash: sha256(packageJson),
    sanitized_package_json_hash: sha256(canonicalJson(sanitizedPackage)),
    package_lock_hash: sha256(packageLock),
    dependency_projection_hash: canonicalHash(dependencyProjection(pkg)),
    runtime,
    allow_install_scripts: normalizedAllowlist,
    format_version: SNAPSHOT_VERSION,
  };
  return {
    packageJson,
    packageLock,
    sanitizedPackage,
    inputHash: canonicalHash(body),
    packageJsonHash: body.package_json_hash,
    sanitizedPackageJsonHash: body.sanitized_package_json_hash,
    packageLockHash: body.package_lock_hash,
    dependencyProjectionHash: body.dependency_projection_hash,
    runtime,
    allowInstallScripts: normalizedAllowlist,
  };
}

function nativeInventory(nodeModules: string): G2BehaviorDependencySnapshot["native_binaries"] {
  const files: Array<{ file: string; sha256: string }> = [];
  const walk = (dir: string, relative: string): void => {
    for (const entry of readdirSync(dir, { withFileTypes: true }).sort((a, b) => a.name.localeCompare(b.name))) {
      const absolute = join(dir, entry.name);
      const next = relative ? `${relative}/${entry.name}` : entry.name;
      if (entry.isSymbolicLink()) continue;
      if (entry.isDirectory()) walk(absolute, next);
      else if (entry.isFile() && entry.name.endsWith(".node")) files.push({ file: next, sha256: sha256(readFileSync(absolute)) });
    }
  };
  walk(nodeModules, "");
  return files;
}

function manifestHash(snapshot: G2BehaviorDependencySnapshot): string {
  const { id: _id, content_hash: _contentHash, ...body } = snapshot;
  return canonicalHash(body);
}

function readSnapshot(dir: string): G2BehaviorDependencySnapshot | null {
  const file = join(dir, "manifest.json");
  if (!existsSync(file)) return null;
  try {
    const value = JSON.parse(readFileSync(file, "utf8")) as G2BehaviorDependencySnapshot;
    if (value.format_version !== SNAPSHOT_VERSION || value.content_hash !== manifestHash(value)) return null;
    if (value.id !== `g2deps_${shortHash(value.content_hash)}` || basename(dir) !== value.id) return null;
    const nodeModules = join(dir, "node_modules");
    const installedLock = join(nodeModules, ".package-lock.json");
    if (!existsSync(nodeModules) || !lstatSync(nodeModules).isDirectory()) return null;
    const installedLockHash = existsSync(installedLock) ? sha256(readFileSync(installedLock)) : sha256("");
    if (installedLockHash !== value.installed_lock_hash) return null;
    if (canonicalJson(nativeInventory(nodeModules)) !== canonicalJson(value.native_binaries)) return null;
    return value;
  } catch {
    return null;
  }
}

function snapshotDirs(base: string): string[] {
  if (!existsSync(base)) return [];
  return readdirSync(base, { withFileTypes: true })
    .filter((entry) => entry.isDirectory() && entry.name.startsWith("g2deps_"))
    .map((entry) => join(base, entry.name))
    .sort();
}

function findSnapshot(base: string, inputHash: string): { snapshot: G2BehaviorDependencySnapshot; dir: string } | null {
  for (const dir of snapshotDirs(base)) {
    const snapshot = readSnapshot(dir);
    if (snapshot?.input_hash === inputHash) return { snapshot, dir };
  }
  return null;
}

function runNpm(args: string[], cwd: string, env: NodeJS.ProcessEnv, timeoutMs: number): void {
  const result = spawnSync(npmExecutable(), args, {
    cwd,
    env,
    encoding: "utf8",
    timeout: timeoutMs,
    maxBuffer: 10 * 1024 * 1024,
    stdio: ["ignore", "pipe", "pipe"],
    shell: false,
  });
  if (result.error) {
    const code = (result.error as NodeJS.ErrnoException).code === "ETIMEDOUT" ? "timed out" : "failed to start";
    throw new Error(`dependency snapshot npm ${code}`);
  }
  if (result.status !== 0) {
    const detail = `${result.stderr ?? ""}\n${result.stdout ?? ""}`.trim().split("\n").slice(-8).join("\n")
      .replace(/(_authToken=)[^\s]+/gi, "$1[redacted]")
      .replace(/(https?:\/\/)[^/@\s]+@/gi, "$1[redacted]@");
    throw new Error(`dependency snapshot npm exited ${result.status}${detail ? `:\n${detail}` : ""}`);
  }
}

function buildSnapshot(base: string, input: SnapshotInput, env: NodeJS.ProcessEnv, timeoutMs: number): G2BehaviorDependencySnapshot {
  const existing = findSnapshot(base, input.inputHash);
  if (existing) return existing.snapshot;
  const work = mkdtempSync(join(base, ".build-"));
  try {
    writeFileSync(join(work, "package.json"), canonicalJson(input.sanitizedPackage));
    writeFileSync(join(work, "package-lock.json"), input.packageLock);
    runNpm(["ci", "--ignore-scripts", "--no-audit", "--no-fund"], work, env, timeoutMs);
    if (input.allowInstallScripts.length) {
      runNpm(["rebuild", ...input.allowInstallScripts, "--foreground-scripts", "--no-audit", "--no-fund"], work, env, timeoutMs);
    }
    const nodeModules = join(work, "node_modules");
    const installedLock = join(nodeModules, ".package-lock.json");
    mkdirSync(nodeModules, { recursive: true });
    const body = {
      input_hash: input.inputHash,
      package_json_hash: input.packageJsonHash,
      sanitized_package_json_hash: input.sanitizedPackageJsonHash,
      package_lock_hash: input.packageLockHash,
      dependency_projection_hash: input.dependencyProjectionHash,
      runtime: input.runtime,
      allow_install_scripts: input.allowInstallScripts,
      installed_lock_hash: existsSync(installedLock) ? sha256(readFileSync(installedLock)) : sha256(""),
      native_binaries: nativeInventory(nodeModules),
      format_version: SNAPSHOT_VERSION as 1,
      data_class: "private" as const,
      authority: "none" as const,
      effects: "cache_only" as const,
      writes: "cache_only" as const,
    };
    const contentHash = canonicalHash(body);
    const snapshot: G2BehaviorDependencySnapshot = {
      id: `g2deps_${shortHash(contentHash)}`,
      content_hash: contentHash,
      ...body,
    };
    writeFileSync(join(work, "manifest.json"), canonicalJson(snapshot));
    const finalDir = join(base, snapshot.id);
    if (existsSync(finalDir)) {
      const collision = readSnapshot(finalDir);
      if (!collision || collision.content_hash !== snapshot.content_hash) throw new Error(`dependency snapshot collision at ${snapshot.id}`);
      return collision;
    }
    try {
      renameSync(work, finalDir);
    } catch (error) {
      if (!existsSync(finalDir)) throw error;
      const concurrent = readSnapshot(finalDir);
      if (!concurrent || concurrent.content_hash !== snapshot.content_hash) {
        throw new Error(`dependency snapshot collision at ${snapshot.id}`);
      }
      return concurrent;
    }
    const validated = readSnapshot(finalDir);
    if (!validated) throw new Error(`dependency snapshot ${snapshot.id} failed post-build validation`);
    return validated;
  } finally {
    rmSync(work, { recursive: true, force: true });
  }
}

export function dependencySnapshotForCommit(root: string, commit: string): { snapshot: G2BehaviorDependencySnapshot; nodeModules: string } | null {
  const base = join(root, ".hunch-cache", "behavior-deps");
  if (!existsSync(base)) return null;
  const env = buildEnvironment(base);
  let packageJson: string;
  let packageLock: string;
  try {
    packageJson = gitFile(root, commit, "package.json");
    packageLock = gitFile(root, commit, "package-lock.json");
  } catch { return null; }
  const runtime = runtimeIdentity(env);
  const packageJsonHash = sha256(packageJson);
  const packageLockHash = sha256(packageLock);
  const matches: Array<{ snapshot: G2BehaviorDependencySnapshot; nodeModules: string }> = [];
  for (const dir of snapshotDirs(base)) {
    const snapshot = readSnapshot(dir);
    if (snapshot
      && snapshot.package_json_hash === packageJsonHash
      && snapshot.package_lock_hash === packageLockHash
      && canonicalJson(snapshot.runtime) === canonicalJson(runtime)) {
      matches.push({ snapshot, nodeModules: join(dir, "node_modules") });
    }
  }
  return matches.length === 1 ? matches[0]! : null;
}

export function provisionG2BehaviorDependencySnapshots(
  root: string,
  report: G2BehaviorCandidateReview,
  candidate: G2BehaviorCandidate,
  allowInstallScripts: string[] = [],
  timeoutMs = 300_000,
): G2BehaviorDependencySnapshotReceipt {
  if (!Number.isInteger(timeoutMs) || timeoutMs < 1 || timeoutMs > 900_000) {
    throw new Error("dependency snapshot timeoutMs must be a positive integer no greater than 900000");
  }
  const base = join(root, ".hunch-cache", "behavior-deps");
  mkdirSync(base, { recursive: true });
  const home = mkdtempSync(join(base, ".npm-home-"));
  writeFileSync(join(home, "global.gitconfig"), "");
  const env = buildEnvironment(home);
  try {
    const badInput = snapshotInput(root, candidate.proposed_corpus.known_bad.ref, allowInstallScripts, env);
    const goodInput = snapshotInput(root, candidate.proposed_corpus.known_good.ref, allowInstallScripts, env);
    const bad = buildSnapshot(base, badInput, env, timeoutMs);
    const good = badInput.inputHash === goodInput.inputHash ? bad : buildSnapshot(base, goodInput, env, timeoutMs);
    const snapshots = [...new Map([bad, good].map((snapshot) => [snapshot.id, snapshot])).values()]
      .sort((left, right) => left.id.localeCompare(right.id));
    const body = {
      candidate_id: candidate.id,
      candidate_hash: canonicalHash(candidate),
      review_hash: report.content_hash,
      snapshots,
      legs: {
        known_bad: { commit: candidate.proposed_corpus.known_bad.ref, dependency_snapshot_id: bad.id },
        known_good: { commit: candidate.proposed_corpus.known_good.ref, dependency_snapshot_id: good.id },
      },
      allow_install_scripts: badInput.allowInstallScripts,
      data_class: "private" as const,
      authority: "none" as const,
      effects: "cache_only" as const,
      writes: "cache_only" as const,
    };
    const contentHash = canonicalHash(body);
    return { id: `g2depsreceipt_${shortHash(contentHash)}`, content_hash: contentHash, ...body };
  } finally {
    rmSync(home, { recursive: true, force: true });
  }
}
