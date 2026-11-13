#!/usr/bin/env node
// Deterministic test sharding for CI, and the verdict that proves the shards
// together ran exactly the suite. Node builtins only (plus the release gate's
// receipt verifier): the verdict jobs run it on a bare checkout, no npm ci.
import { createHash } from "node:crypto";
import { readFileSync, readdirSync } from "node:fs";
import { basename, dirname, join, resolve } from "node:path";
import process from "node:process";
import { fileURLToPath, pathToFileURL } from "node:url";

import { RELEASE_GATES, verifyReleaseReceipt } from "./release-gate.mjs";

const repoRoot = resolve(dirname(fileURLToPath(import.meta.url)), "..");

export const SHARD_MANIFEST_SCHEMA = "hunch.test-shard.v1";
export const MAX_SHARDS = 64;

const PLATFORM_RUNNER_OS = Object.freeze({ "windows-latest": "Windows", "macos-latest": "macOS" });
// The `process.platform` a shard manifest records on each platform runner.
const PLATFORM_NODE_PLATFORM = Object.freeze({ "windows-latest": "win32", "macos-latest": "darwin" });
// The Node line each verdict judges; the shards' own setup-node pins it.
const NODE24_MAJOR = 24;
const PLATFORM_NODE_MAJOR = 22;

/** The major of a `process.version` string ("v24.1.0" -> 24), else null. */
function nodeMajor(version) {
  const match = typeof version === "string" ? /^v(\d+)\.\d+\.\d+/.exec(version) : null;
  return match ? Number(match[1]) : null;
}

/** "i/n" with 1 <= i <= n <= MAX_SHARDS. */
export function parseShardSpec(spec) {
  const match = /^(\d+)\/(\d+)$/.exec(String(spec));
  const index = match ? Number(match[1]) : NaN;
  const total = match ? Number(match[2]) : NaN;
  if (!match || index < 1 || index > total || total > MAX_SHARDS) {
    throw new Error(`invalid test shard ${JSON.stringify(spec)}: expected i/n with 1 <= i <= n <= ${MAX_SHARDS}`);
  }
  return { index, total };
}

// Code-unit order, never localeCompare: every runner must agree on the split.
function sortedUnique(files) {
  return [...new Set(files)].sort((a, b) => a < b ? -1 : a > b ? 1 : 0);
}

// Weighted split profiles: seconds a file took on the slowest runner of the
// suite it belongs to (any file not listed weighs `defaultWeight`). A profile
// only moves files between shards; coverage is proven the same way.
// `platform`: the platform-matrix-safety list, Windows runner timings from CI
// run 42975277613 (team-matrix-e2e alone outweighs a third of the list);
// specsync-cli from PR #639's Windows shard, which ran it alone (105 s).
export const SHARD_PROFILES = Object.freeze({
  platform: Object.freeze({
    defaultWeight: 1,
    weights: Object.freeze({
      "test/team-matrix-e2e.test.ts": 281,
      "test/specsync-cli.test.ts": 100,
      "test/workspaces.test.ts": 96,
      "test/task-selection.test.ts": 79,
      "test/ui.test.ts": 57,
      "test/hook-shared-worktree.test.ts": 47,
      "test/workspace-ledger.test.ts": 43,
      "test/workspace-prune.test.ts": 36,
      "test/specsync.test.ts": 15,
      "test/lock-parity.test.ts": 31,
      "test/memory-home-policy.test.ts": 20,
      "test/init-shared-autocommit.test.ts": 17,
      "test/strays.test.ts": 14,
      "test/test-selection.test.ts": 14,
      "test/updatecheck.test.ts": 11,
      "test/dependency-snapshot-isolation.test.ts": 8,
      "test/hook-daemon.test.ts": 7,
      "test/development-preparation.test.ts": 6,
      "test/git-merge-range.test.ts": 5,
      "test/task-verify-exit.test.ts": 5,
      "test/experiment.test.ts": 4,
      "test/bounded-spawn.test.ts": 3,
      "test/providers.test.ts": 3,
    }),
  }),
});

/** A profile name from the environment: "" means none (the count split). */
export function parseShardProfile(name) {
  if (name === undefined || name === null || name === "") return null;
  if (typeof name !== "string" || !Object.hasOwn(SHARD_PROFILES, name)) {
    throw new Error(`unknown test shard profile ${JSON.stringify(name)}: expected one of ${Object.keys(SHARD_PROFILES).join(", ")}`);
  }
  return name;
}

/** Without a profile, sorted file k belongs to shard (k mod total) + 1. With
 *  one, heaviest first (ties in code-unit order), each file goes to the shard
 *  carrying the least weight so far (ties to the lowest index). Either way the
 *  shard's files come back sorted, and input order never changes the split. */
export function selectShard(files, { index, total }, profile = null) {
  if (!Number.isInteger(index) || !Number.isInteger(total) || index < 1 || index > total) {
    throw new Error(`invalid test shard ${index}/${total}`);
  }
  const sorted = sortedUnique(files);
  const name = parseShardProfile(profile);
  if (name === null) return sorted.filter((_, k) => k % total === index - 1);
  const { defaultWeight, weights } = SHARD_PROFILES[name];
  const weightOf = (file) => Object.hasOwn(weights, file) ? weights[file] : defaultWeight;
  const order = [...sorted].sort((a, b) => weightOf(b) - weightOf(a) || (a < b ? -1 : a > b ? 1 : 0));
  const load = new Array(total).fill(0);
  const mine = [];
  for (const file of order) {
    let target = 0;
    for (let shard = 1; shard < total; shard += 1) if (load[shard] < load[target]) target = shard;
    load[target] += weightOf(file);
    if (target === index - 1) mine.push(file);
  }
  return sortedUnique(mine);
}

function isStringList(value) {
  return Array.isArray(value) && value.every((entry) => typeof entry === "string");
}

function sameList(left, right) {
  return left.length === right.length && left.every((entry, index) => entry === right[index]);
}

function sortedCopy(list) {
  return [...list].sort((a, b) => a < b ? -1 : a > b ? 1 : 0);
}

/** Every reason the manifests fail to prove `total` green shards covered one
 *  input exactly once on `commit` (on Node `node` and `process.platform`
 *  `platform`, when given) under split `profile`; empty means proven. */
export function verifyShardManifests(manifests, { total, commit, expectedInput, node, platform, profile = null }) {
  if (!Array.isArray(manifests)) return ["shard manifests must be a list"];
  const errors = [];
  if (manifests.length !== total) errors.push(`expected ${total} shard manifests, found ${manifests.length}`);
  const counts = new Map();
  const usable = [];
  manifests.forEach((manifest, position) => {
    const label = typeof manifest?.shard === "string" ? `shard ${manifest.shard}` : `manifest #${position + 1}`;
    if (!manifest || typeof manifest !== "object") {
      errors.push(`${label}: not a manifest object`);
      return;
    }
    if (manifest.schema !== SHARD_MANIFEST_SCHEMA) errors.push(`${label}: schema is ${JSON.stringify(manifest.schema)}, expected ${SHARD_MANIFEST_SCHEMA}`);
    if (manifest.total !== total) errors.push(`${label}: total is ${JSON.stringify(manifest.total)}, expected ${total}`);
    const indexOk = Number.isInteger(manifest.index) && manifest.index >= 1 && manifest.index <= total;
    if (!indexOk) errors.push(`${label}: index ${JSON.stringify(manifest.index)} is outside 1..${total}`);
    else counts.set(manifest.index, (counts.get(manifest.index) ?? 0) + 1);
    if (manifest.shard !== `${manifest.index}/${manifest.total}`) errors.push(`${label}: shard label does not match index/total`);
    if (manifest.commit !== commit) errors.push(`${label}: ran on commit ${JSON.stringify(manifest.commit)}, expected ${commit}`);
    if (manifest.exit_code !== 0) errors.push(`${label}: tests exited ${JSON.stringify(manifest.exit_code)}`);
    if (manifest.source_unchanged !== true) errors.push(`${label}: the source tree changed while its tests ran`);
    if (node !== undefined && nodeMajor(manifest.node) !== node) errors.push(`${label}: ran on Node ${JSON.stringify(manifest.node)}, expected Node ${node}`);
    if (platform !== undefined && manifest.platform !== platform) errors.push(`${label}: ran on platform ${JSON.stringify(manifest.platform)}, expected ${platform}`);
    if ((manifest.profile ?? null) !== profile) errors.push(`${label}: split by profile ${JSON.stringify(manifest.profile ?? null)}, expected ${JSON.stringify(profile)}`);
    const listsOk = isStringList(manifest.input) && isStringList(manifest.selected);
    if (!listsOk) errors.push(`${label}: input and selected must be lists of file paths`);
    if (indexOk && listsOk && manifest.total === total) usable.push({ label, manifest });
  });
  for (let index = 1; index <= total; index += 1) {
    const count = counts.get(index) ?? 0;
    if (count === 0) errors.push(`shard ${index}/${total} is missing`);
    else if (count > 1) errors.push(`shard ${index}/${total} appears ${count} times`);
  }
  if (usable.length === 0) {
    if (manifests.length > 0) errors.push("no shard manifest is usable");
    return errors;
  }
  const input = usable[0].manifest.input;
  for (const { label, manifest } of usable.slice(1)) {
    if (!sameList(manifest.input, input)) errors.push(`${label}: was given a different input list than ${usable[0].label}`);
  }
  if (expectedInput !== undefined) {
    const expected = sortedCopy(expectedInput);
    const actual = sortedCopy(input);
    if (!sameList(actual, expected)) {
      const expectedSet = new Set(expected);
      const actualSet = new Set(actual);
      const missing = expected.filter((file) => !actualSet.has(file));
      const extra = actual.filter((file) => !expectedSet.has(file));
      errors.push(`shard input differs from the expected suite${missing.length ? `; missing: ${missing.join(", ")}` : ""}${extra.length ? `; unexpected: ${extra.join(", ")}` : ""}${!missing.length && !extra.length ? "; duplicate entries" : ""}`);
    }
  }
  const owner = new Map();
  for (const { label, manifest } of usable) {
    if (!sameList(manifest.selected, selectShard(manifest.input, { index: manifest.index, total }, profile))) {
      errors.push(`${label}: ran a different file set than its deterministic selection`);
    }
    for (const file of manifest.selected) {
      if (owner.has(file)) errors.push(`${file} ran in both ${owner.get(file)} and ${label}`);
      else owner.set(file, label);
    }
  }
  const inputSet = new Set(input);
  for (const file of inputSet) if (!owner.has(file)) errors.push(`${file} ran in no shard`);
  for (const file of owner.keys()) if (!inputSet.has(file)) errors.push(`${file} ran but is not in the shard input`);
  return errors;
}

/** The Node 24 gate ran every stage except `test`, which the shards ran. */
export function verifyDelegatedGateReceipt(receipt, commit, { node } = {}) {
  const errors = [];
  if (!verifyReleaseReceipt(receipt)) errors.push("release-gate receipt does not self-verify");
  if (node !== undefined && nodeMajor(receipt?.environment?.node) !== node) errors.push(`release gate ran on Node ${JSON.stringify(receipt?.environment?.node)}, expected Node ${node}`);
  if (receipt?.result !== "partial") errors.push(`release-gate result is ${JSON.stringify(receipt?.result)}, expected "partial" (test stage delegated)`);
  if (receipt?.source?.commit !== commit) errors.push(`release gate ran on commit ${JSON.stringify(receipt?.source?.commit)}, expected ${commit}`);
  const gates = Array.isArray(receipt?.gates) ? receipt.gates : [];
  const ids = gates.map((gate) => gate?.id);
  if (!sameList(ids, RELEASE_GATES.map((gate) => gate.id))) errors.push(`release-gate stages are [${ids.join(", ")}], expected [${RELEASE_GATES.map((gate) => gate.id).join(", ")}]`);
  for (const gate of gates) {
    if (gate?.id === "test") {
      if (gate.status !== "delegated" || gate.exit_code !== null) errors.push(`release-gate test stage is ${JSON.stringify(gate.status)}, expected "delegated" with no exit code`);
    } else if (gate?.status !== "passed" || gate?.exit_code !== 0) {
      errors.push(`release-gate stage ${gate?.id} is ${JSON.stringify(gate?.status)} (exit ${JSON.stringify(gate?.exit_code)}), expected passed`);
    }
  }
  return errors;
}

function contentHashMatches(receipt) {
  if (!receipt || typeof receipt !== "object") return false;
  const { content_hash: contentHash, ...body } = receipt;
  return contentHash === `sha256:${createHash("sha256").update(JSON.stringify(body)).digest("hex")}`;
}

/** Every file under `dir` (recursively) named one of `names`, by name. */
function collectEvidence(dir, names) {
  const found = Object.fromEntries(names.map((name) => [name, []]));
  const walk = (current) => {
    for (const entry of readdirSync(current, { withFileTypes: true })) {
      const path = join(current, entry.name);
      if (entry.isDirectory()) walk(path);
      else if (entry.isFile() && names.includes(entry.name)) found[entry.name].push(path);
    }
  };
  walk(dir);
  for (const name of names) found[name].sort();
  return found;
}

function readJsonEvidence(paths, errors) {
  const values = [];
  for (const path of paths) {
    try {
      values.push(JSON.parse(readFileSync(path, "utf8")));
    } catch (error) {
      errors.push(`${path}: unreadable JSON evidence: ${error.message}`);
    }
  }
  return values;
}

function suiteTestFiles() {
  return readdirSync(join(repoRoot, "test"))
    .filter((name) => name.endsWith(".test.ts"))
    .map((name) => `test/${name}`);
}

export function verifyNode24Evidence({ dir, commit, total }) {
  const errors = [];
  const found = collectEvidence(dir, ["test-shard-manifest.json", "release-gate.json", "npm-package-candidate-receipt.json"]);
  const manifests = readJsonEvidence(found["test-shard-manifest.json"], errors);
  errors.push(...verifyShardManifests(manifests, { total, commit, expectedInput: suiteTestFiles(), node: NODE24_MAJOR }));
  if (found["release-gate.json"].length !== 1) {
    errors.push(`expected exactly one release-gate.json, found ${found["release-gate.json"].length}`);
  } else {
    const [gate] = readJsonEvidence(found["release-gate.json"], errors);
    if (gate !== undefined) errors.push(...verifyDelegatedGateReceipt(gate, commit, { node: NODE24_MAJOR }));
  }
  if (found["npm-package-candidate-receipt.json"].length !== 1) {
    errors.push(`expected exactly one npm-package-candidate-receipt.json, found ${found["npm-package-candidate-receipt.json"].length}`);
  } else {
    const [candidate] = readJsonEvidence(found["npm-package-candidate-receipt.json"], errors);
    if (candidate !== undefined) {
      if (candidate?.outcome !== "success") errors.push(`npm package candidate outcome is ${JSON.stringify(candidate?.outcome)}, expected "success"`);
      if (candidate?.commit !== commit) errors.push(`npm package candidate was built from ${JSON.stringify(candidate?.commit)}, expected ${commit}`);
      if (!contentHashMatches(candidate)) errors.push("npm package candidate receipt content_hash does not match its body");
    }
  }
  return { errors, shards: manifests.length, files: manifests[0]?.input?.length ?? 0 };
}

export function verifyPlatformEvidence({ dir, commit, total, os }) {
  const errors = [];
  const runnerOs = PLATFORM_RUNNER_OS[os];
  if (!runnerOs) return { errors: [`unknown platform ${JSON.stringify(os)}; expected one of ${Object.keys(PLATFORM_RUNNER_OS).join(", ")}`], shards: 0, files: 0 };
  const found = collectEvidence(dir, ["test-shard-manifest.json", "platform-matrix-safety.json"]);
  const manifests = readJsonEvidence(found["test-shard-manifest.json"], errors);
  const receipts = readJsonEvidence(found["platform-matrix-safety.json"], errors);
  errors.push(...verifyShardManifests(manifests, { total, commit, node: PLATFORM_NODE_MAJOR, platform: PLATFORM_NODE_PLATFORM[os], profile: "platform" }));
  if (receipts.length !== total) errors.push(`expected ${total} platform receipts, found ${receipts.length}`);
  const input = isStringList(manifests[0]?.input) ? sortedCopy(manifests[0].input) : null;
  const shardCounts = new Map();
  receipts.forEach((receipt, position) => {
    const label = typeof receipt?.shard === "string" ? `platform receipt ${receipt.shard}` : `platform receipt #${position + 1}`;
    if (!contentHashMatches(receipt)) errors.push(`${label}: content_hash does not match its body`);
    if (receipt?.outcome !== "success") errors.push(`${label}: outcome is ${JSON.stringify(receipt?.outcome)}, expected "success"`);
    if (receipt?.commit !== commit) errors.push(`${label}: ran on commit ${JSON.stringify(receipt?.commit)}, expected ${commit}`);
    if (receipt?.runner_os !== runnerOs) errors.push(`${label}: runner_os is ${JSON.stringify(receipt?.runner_os)}, expected ${runnerOs}`);
    if (nodeMajor(receipt?.node) !== PLATFORM_NODE_MAJOR) errors.push(`${label}: ran on Node ${JSON.stringify(receipt?.node)}, expected Node ${PLATFORM_NODE_MAJOR}`);
    shardCounts.set(receipt?.shard, (shardCounts.get(receipt?.shard) ?? 0) + 1);
    if (!isStringList(receipt?.tests)) errors.push(`${label}: tests must be a list of file paths`);
    else if (input && !sameList(sortedCopy(receipt.tests), input)) errors.push(`${label}: its test list differs from the shard manifests' input`);
  });
  for (let index = 1; index <= total; index += 1) {
    const count = shardCounts.get(`${index}/${total}`) ?? 0;
    if (count !== 1) errors.push(`platform receipt for shard ${index}/${total} appears ${count} times, expected once`);
  }
  for (const shard of shardCounts.keys()) {
    if (!/^\d+\/\d+$/.test(String(shard)) || Number(String(shard).split("/")[1]) !== total) errors.push(`platform receipt has an unexpected shard ${JSON.stringify(shard)}`);
  }
  return { errors, shards: manifests.length, files: manifests[0]?.input?.length ?? 0 };
}

const USAGE = `usage:
  node tooling/test-shard.mjs verify-node24 --dir <evidence-dir> --commit <sha> --total <n>
  node tooling/test-shard.mjs verify-platform --dir <evidence-dir> --commit <sha> --total <n> --os <windows-latest|macos-latest>`;

function parseCli(argv) {
  const [command, ...rest] = argv;
  const allowed = command === "verify-node24" ? ["--dir", "--commit", "--total"]
    : command === "verify-platform" ? ["--dir", "--commit", "--total", "--os"]
      : null;
  if (!allowed) throw new Error(`unknown subcommand: ${command ?? "(none)"}`);
  const options = {};
  for (let index = 0; index < rest.length; index += 2) {
    const flag = rest[index];
    const value = rest[index + 1];
    if (!allowed.includes(flag)) throw new Error(`unknown argument: ${flag}`);
    if (value === undefined || value === "") throw new Error(`${flag} requires a value`);
    options[flag.slice(2)] = value;
  }
  for (const flag of allowed) if (options[flag.slice(2)] === undefined) throw new Error(`${flag} is required`);
  if (!/^\d+$/.test(options.total) || Number(options.total) < 1 || Number(options.total) > MAX_SHARDS) {
    throw new Error(`--total must be an integer in 1..${MAX_SHARDS}, got ${options.total}`);
  }
  return { command, dir: resolve(options.dir), commit: options.commit, total: Number(options.total), os: options.os };
}

if (process.argv[1] && import.meta.url === pathToFileURL(resolve(process.argv[1])).href) {
  let cli;
  try {
    cli = parseCli(process.argv.slice(2));
  } catch (error) {
    process.stderr.write(`${basename(process.argv[1])}: ${error.message}\n${USAGE}\n`);
    process.exit(2);
  }
  let verdict;
  try {
    verdict = cli.command === "verify-node24" ? verifyNode24Evidence(cli) : verifyPlatformEvidence(cli);
  } catch (error) {
    verdict = { errors: [error.message], shards: 0, files: 0 };
  }
  if (verdict.errors.length) {
    for (const error of verdict.errors) process.stderr.write(`test-shard ${cli.command}: ${error}\n`);
    process.exit(1);
  }
  process.stdout.write(`test-shard ${cli.command}: ${verdict.shards} shards covered ${verdict.files} test files exactly once on ${cli.commit}${cli.os ? ` (${cli.os})` : ""}\n`);
}
