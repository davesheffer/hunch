#!/usr/bin/env node
import { spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  renameSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import process from "node:process";
import { fileURLToPath, pathToFileURL } from "node:url";

import { verifyMatrixReceipt } from "./matrix-release-verification.mjs";

const projectRoot = resolve(dirname(fileURLToPath(import.meta.url)), "..");

export const RELEASE_GATES = Object.freeze([
  { id: "typecheck", command: ["npm", "run", "typecheck"] },
  { id: "test", command: ["npm", "test"] },
  { id: "core-build", command: ["npm", "run", "build"] },
  { id: "matrix-release-verification", command: ["node", "tooling/matrix-release-verification.mjs", "--output", "$MATRIX_OUTPUT"] },
  { id: "vscode-install", command: ["npm", "ci", "--prefix", "vscode-extension"] },
  { id: "vscode-build", command: ["npm", "run", "build", "--prefix", "vscode-extension"] },
  { id: "repository-index", command: ["node", "dist/cli/index.js", "index"] },
  { id: "architectural-conformance", command: ["node", "dist/cli/index.js", "conform", "--strict"] },
  { id: "clean-install-rehearsal", command: ["node", "tooling/constitution-clean-rehearsal.mjs", "--output", "$REHEARSAL_OUTPUT"] },
  { id: "production-dependency-audit", command: ["npm", "audit", "--omit=dev", "--audit-level=high"] },
]);

export const RELEASE_TEST_COVERAGE = Object.freeze({
  legacy_receipt_compatibility: ["test/migrate.test.ts", "test/constitution.test.ts"],
  compiler_golden_set: ["test/constitution.test.ts"],
  evaluator_fixture_matrix: ["test/constitution.test.ts"],
  adapter_certification: ["test/constitution.test.ts", "test/agenthook.test.ts"],
  private_leak_suite: ["test/private-overlay.test.ts", "test/private-correction-interfaces.test.ts", "test/md1-e2e.test.ts", "test/team-matrix-e2e.test.ts", "test/constitution.test.ts", "test/wiki.test.ts"],
  replay_isolation: ["test/constitution.test.ts", "test/dependency-snapshot-isolation.test.ts", "tooling/constitution-clean-rehearsal.mjs"],
  proof_version_invalidation: ["test/constitution.test.ts"],
  g2_readiness: ["test/g2.test.ts", "test/constitution.test.ts"],
  g3_readiness: ["test/g3.test.ts", "test/behavior-workspace.test.ts"],
  md1_correction_bridge: [
    "test/constitution.test.ts",
    "test/private-correction-interfaces.test.ts",
    "test/record-constraint-cli.test.ts",
    "test/md1-e2e.test.ts",
    "test/md1-benchmark.test.ts",
    "tooling/md1-benchmark.mjs",
  ],
  correction_retry_durability: ["test/sync-repair-commit.test.ts", "test/sync.test.ts"],
  overlay_publication_safety: ["test/overlay-commit-guard.test.ts", "test/singlesource.test.ts", "test/worktree.test.ts", "test/team-matrix-e2e.test.ts"],
  safe_recursive_scanning: [
    "test/indexer.test.ts",
    "test/comments.test.ts",
    "test/workingdiff.test.ts",
    "test/safe-repo-file.test.ts",
    "test/check-nonmutating.test.ts",
    "test/index-source-publication.test.ts",
  ],
  destructive_action_safety: ["test/compact.test.ts", "test/revert-move-safety.test.ts"],
  cross_locale_determinism: ["test/canonical-locale.test.ts"],
  atomic_json_persistence: ["src/core/io.ts", "test/io.test.ts", "test/migrate.test.ts"],
  release_pipeline_contract: [
    ".github/workflows/ci.yml",
    ".github/workflows/release.yml",
    ".github/workflows/vscode-marketplace.yml",
    "test/release-gate.test.ts",
    "test/vscode-marketplace-workflow.test.ts",
    "test/workflow-release-contract.test.ts",
    "tooling/release-gate.mjs",
    "tooling/vscode-publish-tools/package.json",
    "tooling/vscode-publish-tools/package-lock.json",
  ],
  matrix_release_resilience: [
    "test/matrix-release-verification.test.ts",
    "test/team-matrix-e2e.test.ts",
    "tooling/matrix-release-verification.mjs",
  ],
});

export const RELEASE_CLEAN_STATUS_ARGS = Object.freeze(["status", "--porcelain", "--untracked-files=all"]);

function stable(value) {
  if (Array.isArray(value)) return value.map(stable);
  if (value && typeof value === "object") {
    return Object.fromEntries(Object.keys(value).sort().map((key) => [key, stable(value[key])]));
  }
  return value;
}

function sha256(value) {
  return createHash("sha256").update(value).digest("hex");
}

function receiptHash(body) {
  return `sha256:${sha256(JSON.stringify(stable(body)))}`;
}

export function validateReleaseContext({ packageVersion, tag, tagCommitMatches, clean, allowDirty }) {
  if (tag && tag !== `v${packageVersion}`) {
    throw new Error(`release tag ${tag} does not match package version ${packageVersion}`);
  }
  if (tag && tagCommitMatches === false) throw new Error(`release tag ${tag} does not point to HEAD`);
  if (!clean && !allowDirty) throw new Error("working tree is dirty (including untracked files); commit or restore it before running the release gate");
  return { tag_matches_version: tag ? true : null };
}

export function executeReleasePlan(plan, runner) {
  const results = [];
  for (const gate of plan) {
    const outcome = runner(gate);
    const exitCode = Number.isInteger(outcome?.exitCode) ? outcome.exitCode : 1;
    const result = {
      id: gate.id,
      command: [...gate.command],
      status: exitCode === 0 ? "passed" : "failed",
      exit_code: exitCode,
    };
    results.push(result);
    if (exitCode !== 0) break;
  }
  return results;
}

export function gateEnvironment(gateId, baseEnvironment, emptyPrivateHome) {
  if (gateId !== "repository-index" && gateId !== "architectural-conformance") return { ...baseEnvironment };
  return {
    ...baseEnvironment,
    HUNCH_PRIVATE_DIR: emptyPrivateHome,
    HUNCH_SYNTH_PROVIDER: "deterministic",
  };
}

function sameJson(left, right) {
  return JSON.stringify(stable(left)) === JSON.stringify(stable(right));
}

function releaseSourcePasses(packageResult, source) {
  if (packageResult?.name !== "@davesheffer/hunch" || !parseVersion(packageResult?.version ?? "")) return false;
  if (!/^[0-9a-f]{40}(?:[0-9a-f]{24})?$/.test(source?.commit ?? "") || typeof source?.clean !== "boolean") return false;
  if (source.tag === null) {
    return source.tag_matches_version === null && source.tag_commit_matches === null;
  }
  return source.tag === `v${packageResult.version}`
    && source.tag_matches_version === true
    && source.tag_commit_matches === true;
}

function rollbackPasses(packageResult, rollback) {
  if (rollback?.verified !== true
    || rollback.source !== "npm-registry"
    || rollback.registry !== "https://registry.npmjs.org/"
    || !/^sha256:[0-9a-f]{64}$/.test(rollback.published_versions_hash ?? "")) return false;
  const prior = parseVersion(rollback.previous_version ?? "");
  const current = parseVersion(packageResult?.version ?? "");
  return prior !== null
    && current !== null
    && prior.prerelease === null
    && compareVersions(prior, current) < 0
    && rollback.command === `npm install -g ${packageResult.name}@${prior.value}`;
}

function rehearsalPasses(packageResult, rehearsal) {
  return rehearsal?.package?.name === packageResult?.name
    && rehearsal.package.version === packageResult.version
    && /^[0-9a-f]{40}$/.test(rehearsal.package.shasum ?? "")
    && /^sha512-[A-Za-z0-9+/]+={0,2}$/.test(rehearsal.package.integrity ?? "")
    && rehearsal.package.clean_install === true
    && Number.isInteger(rehearsal.proofs?.p3) && rehearsal.proofs.p3 > 0
    && rehearsal.proofs?.authority_grants === 0
    && rehearsal.isolation?.clean_home === true
    && rehearsal.isolation?.network_proxies_unreachable_during_proof === true
    && rehearsal.isolation?.repository_hooks_executed === false
    && rehearsal.isolation?.active_worktrees_after_run === 1
    && rehearsal.isolation?.transient_sessions_after_run === 0
    && rehearsal.isolation?.clean_installed_cli_corpus_roundtrip === true
    && rehearsal.privacy?.private_sentinel_in_public_home === false
    && rehearsal.privacy?.private_sentinel_preserved_in_private_home === true
    && Array.isArray(rehearsal.public_receipts);
}

export function buildReleaseReceipt(input) {
  const matrixVerified = verifyMatrixReceipt(input.matrix)
    && input.matrix.result === "passed"
    && input.matrix.source?.candidate_commit === input.source.commit
    && input.matrix.source?.candidate_clean === input.source.clean
    && input.matrix.packages?.candidate?.version === input.package.version;
  const allPassed = releaseSourcePasses(input.package, input.source)
    && input.gates.length === RELEASE_GATES.length
    && input.gates.every((gate, index) => gate.id === RELEASE_GATES[index].id
      && sameJson(gate.command, RELEASE_GATES[index].command)
      && gate.status === "passed" && gate.exit_code === 0)
    && (input.context_errors?.length ?? 0) === 0
    && sameJson(input.test_manifest, releaseTestManifest())
    && rehearsalPasses(input.package, input.rehearsal)
    && rollbackPasses(input.package, input.rollback)
    && matrixVerified;
  const result = allPassed ? "passed" : "failed";
  const candidateReady = result === "passed" && input.source.clean && input.matrix.release_ready === true;
  const publishReady = candidateReady && input.source.tag !== null && input.source.tag_matches_version === true;
  const body = {
    schema: "hunch.constitution.release-gate.v1",
    package: input.package,
    source: input.source,
    environment: input.environment,
    gates: input.gates,
    context_errors: input.context_errors ?? [],
    test_manifest: input.test_manifest,
    rehearsal: input.rehearsal,
    matrix: input.matrix ?? null,
    rollback: input.rollback,
    result,
    candidate_ready: candidateReady,
    publish_ready: publishReady,
  };
  const contentHash = receiptHash(body);
  return {
    id: `release_${contentHash.slice("sha256:".length, "sha256:".length + 12)}`,
    content_hash: contentHash,
    ...body,
  };
}

export function verifyReleaseReceipt(receipt) {
  if (!receipt || typeof receipt !== "object" || receipt.schema !== "hunch.constitution.release-gate.v1") return false;
  try {
    const rebuilt = buildReleaseReceipt({
      package: receipt.package,
      source: receipt.source,
      environment: receipt.environment,
      gates: receipt.gates,
      context_errors: receipt.context_errors,
      test_manifest: receipt.test_manifest,
      rehearsal: receipt.rehearsal,
      matrix: receipt.matrix,
      rollback: receipt.rollback,
    });
    return sameJson(receipt, rebuilt);
  } catch {
    return false;
  }
}

/** Quote one arg for cmd.exe (same contract as the extension's winQuote). */
function winQuote(a) {
  return /[\s"&|<>^()%!,;]/.test(a) ? `"${a.replace(/"/g, '\\"')}"` : a;
}

function spawnPortable(command, args, options = {}) {
  const executable = command === "node" ? process.execPath : command;
  // Windows: npm is a .cmd shim; Node >=18.20 refuses to spawn it shell-less
  // (CVE-2024-27980 hardening) and fails ENOENT. Route through cmd.exe with each
  // arg quoted ourselves (dec_812d887be0) — shell:true would concatenate them
  // unescaped (DEP0190). `node` keeps the shell-free argv form everywhere.
  return process.platform === "win32" && command !== "node"
    ? spawnSync("cmd.exe", ["/d", "/s", "/c", [command, ...args].map(winQuote).join(" ")], { cwd: projectRoot, stdio: "inherit", windowsVerbatimArguments: true, ...options })
    : spawnSync(executable, args, { cwd: projectRoot, stdio: "inherit", ...options });
}

function run(command, args, options = {}) {
  const child = spawnPortable(command, args, options);
  if (child.error) {
    process.stderr.write(`${child.error.message}\n`);
    return { exitCode: 1 };
  }
  return { exitCode: child.status ?? 1 };
}

function git(args) {
  const child = spawnSync("git", args, { cwd: projectRoot, encoding: "utf8", stdio: ["ignore", "pipe", "pipe"] });
  if (child.status !== 0) throw new Error(child.stderr.trim() || `git ${args.join(" ")} failed`);
  return child.stdout.trim();
}

function parseArgs(argv) {
  const parsed = { output: ".hunch-cache/release/release-gate.json", tag: null, allowDirty: false };
  for (let index = 0; index < argv.length; index += 1) {
    const arg = argv[index];
    if (arg === "--allow-dirty") parsed.allowDirty = true;
    else if (arg === "--output" || arg === "--tag") {
      const value = argv[index + 1];
      if (!value) throw new Error(`${arg} requires a value`);
      parsed[arg.slice(2)] = value;
      index += 1;
    } else throw new Error(`unknown release-gate argument: ${arg}`);
  }
  return parsed;
}

function atomicWrite(file, value) {
  const target = resolve(projectRoot, file);
  mkdirSync(dirname(target), { recursive: true });
  const temporary = `${target}.tmp-${process.pid}`;
  writeFileSync(temporary, JSON.stringify(value, null, 2) + "\n");
  renameSync(temporary, target);
  return target;
}

export function releaseTestManifest() {
  return Object.fromEntries(Object.entries(RELEASE_TEST_COVERAGE).map(([area, files]) => [
    area,
    files.map((file) => {
      const target = join(projectRoot, file);
      if (!existsSync(target)) throw new Error(`release test manifest is missing ${file}`);
      return { path: file, sha256: sha256(readFileSync(target)) };
    }),
  ]));
}

function parseVersion(value) {
  const numeric = "(?:0|[1-9]\\d*)";
  const prereleaseIdentifier = "(?:0|[1-9]\\d*|[0-9A-Za-z-]*[A-Za-z-][0-9A-Za-z-]*)";
  const match = String(value).match(new RegExp(`^(${numeric})\\.(${numeric})\\.(${numeric})(?:-(${prereleaseIdentifier}(?:\\.${prereleaseIdentifier})*))?(?:\\+[0-9A-Za-z-]+(?:\\.[0-9A-Za-z-]+)*)?$`));
  if (!match) return null;
  const [major, minor, patch] = match.slice(1, 4).map(Number);
  if (![major, minor, patch].every(Number.isSafeInteger)) return null;
  return { value, major, minor, patch, prerelease: match[4] ?? null };
}

function compareVersions(left, right) {
  for (const key of ["major", "minor", "patch"]) {
    if (left[key] !== right[key]) return left[key] - right[key];
  }
  if (left.prerelease === right.prerelease) return 0;
  if (left.prerelease === null) return 1;
  if (right.prerelease === null) return -1;
  const leftParts = left.prerelease.split(".");
  const rightParts = right.prerelease.split(".");
  for (let index = 0; index < Math.max(leftParts.length, rightParts.length); index++) {
    if (leftParts[index] === undefined) return -1;
    if (rightParts[index] === undefined) return 1;
    if (leftParts[index] === rightParts[index]) continue;
    const leftNumeric = /^\d+$/.test(leftParts[index]);
    const rightNumeric = /^\d+$/.test(rightParts[index]);
    if (leftNumeric && rightNumeric) {
      if (leftParts[index].length !== rightParts[index].length) return leftParts[index].length - rightParts[index].length;
      return leftParts[index] < rightParts[index] ? -1 : 1;
    }
    if (leftNumeric !== rightNumeric) return leftNumeric ? -1 : 1;
    return leftParts[index] < rightParts[index] ? -1 : 1;
  }
  return 0;
}

export function npmDistTagForVersion(value) {
  const version = parseVersion(value);
  if (!version) throw new Error(`package version ${value} is not valid semver`);
  return version.prerelease === null ? "latest" : "next";
}

export function selectPreviousVersion(currentVersion, versions) {
  const current = parseVersion(currentVersion);
  if (!current) throw new Error(`package version ${currentVersion} is not valid semver`);
  return versions
    .map((version) => version ? parseVersion(version) : null)
    .filter((version) => version && version.prerelease === null && compareVersions(version, current) < 0)
    .sort((left, right) => compareVersions(right, left))[0]?.value ?? null;
}

function publishedVersions(packageName) {
  const child = spawnPortable(
    "npm",
    ["view", packageName, "versions", "--json", "--registry=https://registry.npmjs.org/"],
    {
      encoding: "utf8",
      stdio: ["ignore", "pipe", "pipe"],
      timeout: 30_000,
      maxBuffer: 4 * 1024 * 1024,
    },
  );
  if (child.error) throw child.error;
  if (child.status !== 0) {
    throw new Error(child.stderr.trim() || `npm view ${packageName} versions failed`);
  }
  let parsed;
  try {
    parsed = JSON.parse(child.stdout);
  } catch {
    throw new Error(`npm returned an invalid published-version list for ${packageName}`);
  }
  const versions = Array.isArray(parsed) ? parsed : typeof parsed === "string" ? [parsed] : [];
  if (versions.length === 0 || !versions.every((version) => typeof version === "string")) {
    throw new Error(`npm returned a malformed published-version list for ${packageName}`);
  }
  return versions;
}

export function buildVerifiedRollback(packageName, currentVersion, versions) {
  const prior = selectPreviousVersion(currentVersion, versions);
  if (!prior) throw new Error(`no published stable rollback exists before ${packageName}@${currentVersion}`);
  return {
    previous_version: prior,
    command: `npm install -g ${packageName}@${prior}`,
    emergency_demotion: "hunch policy demote <id> --actor <human> --reason <reason>",
    verified: true,
    source: "npm-registry",
    registry: "https://registry.npmjs.org/",
    published_versions_hash: `sha256:${sha256(JSON.stringify([...versions].sort()))}`,
  };
}

function verifiedRollback(packageName, currentVersion) {
  return buildVerifiedRollback(packageName, currentVersion, publishedVersions(packageName));
}

function compactRehearsal(report) {
  if (!report) return null;
  const { package: packageResult, corpus, proofs, isolation, privacy, public_receipts: publicReceipts } = report;
  return { package: packageResult, corpus, proofs, isolation, privacy, public_receipts: publicReceipts };
}

function readGateEvidence(file, label, gateResults, contextErrors) {
  const gate = gateResults.find((result) => result.id === label);
  if (!existsSync(file)) {
    if (gate?.status === "passed") contextErrors.push(`${label} passed without writing its evidence receipt`);
    return null;
  }
  try {
    return JSON.parse(readFileSync(file, "utf8"));
  } catch (error) {
    contextErrors.push(`${label} wrote malformed JSON evidence: ${error.message}`);
    return null;
  }
}

async function main() {
  const options = parseArgs(process.argv.slice(2));
  const packageJson = JSON.parse(readFileSync(join(projectRoot, "package.json"), "utf8"));
  const commit = git(["rev-parse", "HEAD"]);
  const clean = git(RELEASE_CLEAN_STATUS_ARGS) === "";
  const tagCommitMatches = options.tag && options.tag === `v${packageJson.version}`
    ? git(["rev-list", "-n", "1", options.tag]) === commit
    : options.tag ? false : null;
  let context;
  try {
    context = validateReleaseContext({ packageVersion: packageJson.version, tag: options.tag, tagCommitMatches, clean, allowDirty: options.allowDirty });
  } catch (error) {
    const rollback = {
      previous_version: null,
      command: null,
      emergency_demotion: "hunch policy demote <id> --actor <human> --reason <reason>",
      verified: false,
      source: "npm-registry",
      registry: "https://registry.npmjs.org/",
      error: "rollback was not resolved because release context validation failed",
    };
    const receipt = buildReleaseReceipt({
      package: { name: packageJson.name, version: packageJson.version },
      source: {
        commit,
        clean,
        tag: options.tag,
        tag_matches_version: options.tag ? options.tag === `v${packageJson.version}` : null,
        tag_commit_matches: tagCommitMatches,
      },
      environment: { node: process.version, platform: process.platform, arch: process.arch },
      gates: [],
      context_errors: [error.message],
      test_manifest: releaseTestManifest(),
      rehearsal: null,
      matrix: null,
      rollback,
    });
    if (!verifyReleaseReceipt(receipt)) throw new Error("failed-context release receipt did not self-verify");
    const output = atomicWrite(options.output, receipt);
    process.stderr.write(`Release gate refused before execution: ${error.message}\nReceipt: ${output}\n`);
    process.exitCode = 1;
    return;
  }
  let rollback;
  try {
    rollback = verifiedRollback(packageJson.name, packageJson.version);
  } catch (error) {
    rollback = {
      previous_version: null,
      command: null,
      emergency_demotion: "hunch policy demote <id> --actor <human> --reason <reason>",
      verified: false,
      source: "npm-registry",
      registry: "https://registry.npmjs.org/",
      error: error.message,
    };
    const receipt = buildReleaseReceipt({
      package: { name: packageJson.name, version: packageJson.version },
      source: {
        commit,
        clean,
        tag: options.tag,
        tag_matches_version: context.tag_matches_version,
        tag_commit_matches: tagCommitMatches,
      },
      environment: { node: process.version, platform: process.platform, arch: process.arch },
      gates: [],
      context_errors: [`could not verify a published rollback version: ${error.message}`],
      test_manifest: releaseTestManifest(),
      rehearsal: null,
      matrix: null,
      rollback,
    });
    if (!verifyReleaseReceipt(receipt)) throw new Error("failed-rollback release receipt did not self-verify");
    const output = atomicWrite(options.output, receipt);
    process.stderr.write(`Release gate refused before execution: ${receipt.context_errors[0]}\nReceipt: ${output}\n`);
    process.exitCode = 1;
    return;
  }
  const temporary = mkdtempSync(join(tmpdir(), "hunch-release-gate-"));
  const rehearsalOutput = join(temporary, "constitution-rehearsal.json");
  const matrixOutput = join(temporary, "matrix-release.json");
  const emptyPrivateHome = join(temporary, "empty-private-overlay");
  mkdirSync(emptyPrivateHome, { recursive: true });
  let receipt;
  try {
    const gates = executeReleasePlan(RELEASE_GATES, (gate) => {
      process.stdout.write(`\n== release gate: ${gate.id} ==\n`);
      const [command, ...baseArgs] = gate.command.map((part) => {
        if (part === "$REHEARSAL_OUTPUT") return rehearsalOutput;
        if (part === "$MATRIX_OUTPUT") return matrixOutput;
        return part;
      });
      const args = gate.id === "matrix-release-verification" && options.allowDirty
        ? [...baseArgs, "--allow-dirty"]
        : baseArgs;
      return run(command, args, { env: gateEnvironment(gate.id, process.env, emptyPrivateHome) });
    });
    const cleanAfter = git(RELEASE_CLEAN_STATUS_ARGS) === "";
    const contextErrors = clean && !cleanAfter ? ["release gate commands modified the working tree"] : [];
    const rawRehearsal = readGateEvidence(rehearsalOutput, "clean-install-rehearsal", gates, contextErrors);
    const rehearsal = compactRehearsal(rawRehearsal);
    const matrix = readGateEvidence(matrixOutput, "matrix-release-verification", gates, contextErrors);
    receipt = buildReleaseReceipt({
      package: { name: packageJson.name, version: packageJson.version },
      source: {
        commit,
        clean: clean && cleanAfter,
        clean_before: clean,
        clean_after: cleanAfter,
        tag: options.tag,
        tag_matches_version: context.tag_matches_version,
        tag_commit_matches: tagCommitMatches,
      },
      environment: { node: process.version, platform: process.platform, arch: process.arch },
      gates,
      context_errors: contextErrors,
      test_manifest: releaseTestManifest(),
      rehearsal,
      matrix,
      rollback,
    });
    if (!verifyReleaseReceipt(receipt)) throw new Error("release receipt failed semantic self-verification");
    const output = atomicWrite(options.output, receipt);
    process.stdout.write(`\nRelease gate ${receipt.result}: ${receipt.id}\nReceipt: ${output}\n`);
    process.stdout.write(`Candidate ready: ${receipt.candidate_ready ? "yes" : "no"}; publish ready: ${receipt.publish_ready ? "yes" : "no"}\n`);
    if (receipt.result !== "passed" || (options.tag && !receipt.publish_ready)) process.exitCode = 1;
  } finally {
    rmSync(temporary, { recursive: true, force: true });
  }
}

if (process.argv[1] && import.meta.url === pathToFileURL(resolve(process.argv[1])).href) {
  main().catch((error) => {
    process.stderr.write(`Release gate failed: ${error.message}\n`);
    process.exitCode = 1;
  });
}
