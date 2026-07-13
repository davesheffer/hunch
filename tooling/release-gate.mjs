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

const projectRoot = resolve(dirname(fileURLToPath(import.meta.url)), "..");

export const RELEASE_GATES = Object.freeze([
  { id: "typecheck", command: ["npm", "run", "typecheck"] },
  { id: "test", command: ["npm", "test"] },
  { id: "core-build", command: ["npm", "run", "build"] },
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
  private_leak_suite: ["test/private-overlay.test.ts", "test/constitution.test.ts", "test/wiki.test.ts"],
  replay_isolation: ["test/constitution.test.ts", "tooling/constitution-clean-rehearsal.mjs"],
  proof_version_invalidation: ["test/constitution.test.ts"],
  g2_readiness: ["test/g2.test.ts", "test/constitution.test.ts"],
  g3_readiness: ["test/g3.test.ts", "test/behavior-workspace.test.ts"],
});

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
  if (!clean && !allowDirty) throw new Error("tracked source is dirty; commit or restore it before running the release gate");
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

export function buildReleaseReceipt(input) {
  const allPassed = input.gates.length === RELEASE_GATES.length
    && input.gates.every((gate, index) => gate.id === RELEASE_GATES[index].id && gate.status === "passed" && gate.exit_code === 0)
    && (input.context_errors?.length ?? 0) === 0;
  const result = allPassed ? "passed" : "failed";
  const candidateReady = result === "passed" && input.source.clean;
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
  if (!receipt || typeof receipt !== "object") return false;
  const { id, content_hash: contentHash, ...body } = receipt;
  const expected = receiptHash(body);
  return contentHash === expected && id === `release_${expected.slice("sha256:".length, "sha256:".length + 12)}`;
}

/** Quote one arg for cmd.exe (same contract as the extension's winQuote). */
function winQuote(a) {
  return /[\s"&|<>^()%!,;]/.test(a) ? `"${a.replace(/"/g, '\\"')}"` : a;
}

function run(command, args, options = {}) {
  const executable = command === "node" ? process.execPath : command;
  // Windows: npm is a .cmd shim; Node >=18.20 refuses to spawn it shell-less
  // (CVE-2024-27980 hardening) and fails ENOENT. Route through cmd.exe with each
  // arg quoted ourselves (dec_812d887be0) — shell:true would concatenate them
  // unescaped (DEP0190). `node` keeps the shell-free argv form everywhere.
  const child = process.platform === "win32" && command !== "node"
    ? spawnSync("cmd.exe", ["/d", "/s", "/c", [command, ...args].map(winQuote).join(" ")], { cwd: projectRoot, stdio: "inherit", windowsVerbatimArguments: true, ...options })
    : spawnSync(executable, args, { cwd: projectRoot, stdio: "inherit", ...options });
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

function testManifest() {
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
  const match = value.match(/^(\d+)\.(\d+)\.(\d+)(?:-([0-9A-Za-z.-]+))?$/);
  return match ? { value, major: Number(match[1]), minor: Number(match[2]), patch: Number(match[3]), prerelease: match[4] ?? null } : null;
}

function compareVersions(left, right) {
  for (const key of ["major", "minor", "patch"]) {
    if (left[key] !== right[key]) return left[key] - right[key];
  }
  if (left.prerelease === right.prerelease) return 0;
  if (left.prerelease === null) return 1;
  if (right.prerelease === null) return -1;
  return left.prerelease.localeCompare(right.prerelease);
}

export function selectPreviousVersion(currentVersion, tags) {
  const current = parseVersion(currentVersion);
  if (!current) throw new Error(`package version ${currentVersion} is not valid semver`);
  return tags
    .map((tag) => tag.match(/^v(.+)$/)?.[1])
    .map((version) => version ? parseVersion(version) : null)
    .filter((version) => version && compareVersions(version, current) < 0)
    .sort((left, right) => compareVersions(right, left))[0]?.value ?? null;
}

function previousVersion(currentVersion) {
  return selectPreviousVersion(currentVersion, git(["tag", "--sort=-v:refname"]).split("\n").filter(Boolean));
}

function compactRehearsal(report) {
  if (!report) return null;
  const { package: packageResult, corpus, proofs, isolation, privacy, public_receipts: publicReceipts } = report;
  return { package: packageResult, corpus, proofs, isolation, privacy, public_receipts: publicReceipts };
}

async function main() {
  const options = parseArgs(process.argv.slice(2));
  const packageJson = JSON.parse(readFileSync(join(projectRoot, "package.json"), "utf8"));
  const commit = git(["rev-parse", "HEAD"]);
  const clean = git(["status", "--porcelain", "--untracked-files=no"]) === "";
  const tagCommitMatches = options.tag && options.tag === `v${packageJson.version}`
    ? git(["rev-list", "-n", "1", options.tag]) === commit
    : options.tag ? false : null;
  const prior = previousVersion(packageJson.version);
  const rollback = {
    previous_version: prior,
    command: prior ? `npm install -g ${packageJson.name}@${prior}` : `npm uninstall -g ${packageJson.name}`,
    emergency_demotion: "hunch policy demote <id> --actor <human> --reason <reason>",
  };
  let context;
  try {
    context = validateReleaseContext({ packageVersion: packageJson.version, tag: options.tag, tagCommitMatches, clean, allowDirty: options.allowDirty });
  } catch (error) {
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
      test_manifest: testManifest(),
      rehearsal: null,
      rollback,
    });
    const output = atomicWrite(options.output, receipt);
    process.stderr.write(`Release gate refused before execution: ${error.message}\nReceipt: ${output}\n`);
    process.exitCode = 1;
    return;
  }
  const temporary = mkdtempSync(join(tmpdir(), "hunch-release-gate-"));
  const rehearsalOutput = join(temporary, "constitution-rehearsal.json");
  const emptyPrivateHome = join(temporary, "empty-private-overlay");
  mkdirSync(emptyPrivateHome, { recursive: true });
  let receipt;
  try {
    const gates = executeReleasePlan(RELEASE_GATES, (gate) => {
      process.stdout.write(`\n== release gate: ${gate.id} ==\n`);
      const [command, ...args] = gate.command.map((part) => part === "$REHEARSAL_OUTPUT" ? rehearsalOutput : part);
      return run(command, args, { env: gateEnvironment(gate.id, process.env, emptyPrivateHome) });
    });
    const rehearsal = existsSync(rehearsalOutput)
      ? compactRehearsal(JSON.parse(readFileSync(rehearsalOutput, "utf8")))
      : null;
    const cleanAfter = git(["status", "--porcelain", "--untracked-files=no"]) === "";
    const contextErrors = clean && !cleanAfter ? ["release gate commands modified tracked source"] : [];
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
      test_manifest: testManifest(),
      rehearsal,
      rollback,
    });
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
