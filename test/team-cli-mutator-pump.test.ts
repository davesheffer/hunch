import assert from "node:assert/strict";
import { execFileSync, spawnSync } from "node:child_process";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, isAbsolute, join, resolve } from "node:path";
import { test } from "node:test";
import type { Bug, Decision } from "../src/core/types.js";
import { decisionId } from "../src/core/ids.js";

const PROJECT_ROOT = process.cwd();
const TSX = join(PROJECT_ROOT, "node_modules/tsx/dist/cli.mjs");
const CLI = join(PROJECT_ROOT, "src/cli/index.ts");

type Actor = { root: string; home: string; env: NodeJS.ProcessEnv };

function git(cwd: string, ...args: string[]): string {
  return execFileSync("git", args, {
    cwd,
    encoding: "utf8",
    env: { ...process.env, GIT_CONFIG_NOSYSTEM: "1" },
    stdio: ["ignore", "pipe", "pipe"],
  }).trim();
}

function configureRepo(root: string, actor: string, sandbox: string): void {
  const hooks = join(sandbox, `${actor.toLowerCase()}-hooks`);
  mkdirSync(hooks, { recursive: true });
  git(root, "config", "user.name", actor);
  git(root, "config", "user.email", `${actor.toLowerCase()}@pump.test`);
  git(root, "config", "commit.gpgsign", "false");
  git(root, "config", "core.hooksPath", hooks);
}

function actorEnv(home: string, name: string): NodeJS.ProcessEnv {
  return {
    ...process.env,
    HOME: home,
    USERPROFILE: home,
    XDG_CONFIG_HOME: join(home, ".config"),
    GIT_CONFIG_NOSYSTEM: "1",
    GIT_AUTHOR_NAME: name,
    GIT_AUTHOR_EMAIL: `${name.toLowerCase()}@pump.test`,
    GIT_COMMITTER_NAME: name,
    GIT_COMMITTER_EMAIL: `${name.toLowerCase()}@pump.test`,
    HUNCH_PRIVATE_DIR: "",
    HUNCH_SYNTH_PROVIDER: "deterministic",
    HUNCH_EMBEDDINGS: "off",
    GIT_TERMINAL_PROMPT: "0",
    NO_COLOR: "1",
    CI: "1",
  };
}

function cloneActor(sandbox: string, codeRemote: string, name: string): Actor {
  const root = join(sandbox, name.toLowerCase());
  const home = join(sandbox, `${name.toLowerCase()}-home`);
  mkdirSync(home, { recursive: true });
  git(sandbox, "clone", "-q", codeRemote, root);
  configureRepo(root, name, sandbox);
  return { root, home, env: actorEnv(home, name) };
}

function runCli(actor: Actor, ...args: string[]) {
  return spawnSync(process.execPath, [TSX, CLI, ...args], {
    cwd: actor.root,
    env: actor.env,
    encoding: "utf8",
    timeout: 45_000,
    maxBuffer: 16 * 1024 * 1024,
  });
}

function expectCli(actor: Actor, ...args: string[]): string {
  const run = runCli(actor, ...args);
  const output = `${run.stdout ?? ""}${run.stderr ?? ""}`;
  assert.equal(run.error, undefined, run.error?.message);
  assert.equal(run.signal, null, output);
  assert.equal(run.status, 0, output);
  return output;
}

function overlayRoot(actor: Actor): string {
  const local = JSON.parse(readFileSync(join(actor.root, ".hunch/local.json"), "utf8")) as { privateDir: string };
  const privateHunch = isAbsolute(local.privateDir) ? local.privateDir : resolve(actor.root, local.privateDir);
  return dirname(privateHunch);
}

function remoteJson<T>(remote: string, path: string): T {
  return JSON.parse(execFileSync("git", ["--git-dir", remote, "show", `main:${path}`], { encoding: "utf8" })) as T;
}

function remoteTree(remote: string): string[] {
  const text = execFileSync("git", ["--git-dir", remote, "ls-tree", "-r", "--name-only", "main"], { encoding: "utf8" }).trim();
  return text ? text.split("\n") : [];
}

function draft(id: string, title: string): Decision {
  return {
    id,
    title,
    topic: null,
    status: "proposed",
    context: "A team member proposed this and another teammate must see its review outcome immediately.",
    decision: "Keep the shared memory pump live after every lifecycle transition.",
    consequences: [],
    alternatives_rejected: [],
    rejected_tripwires: [],
    related_components: [],
    related_files: ["src/app.ts"],
    supersedes: null,
    superseded_by: null,
    caused_by_bug: null,
    commit: null,
    valid_to: null,
    retired: { symbols: [], deps: [] },
    provenance: { source: "llm_draft", confidence: 0.5, evidence: [] },
    date: "2026-07-19T00:00:00.000Z",
  };
}

function seedRemotes(sandbox: string): { codeRemote: string; memoryRemote: string } {
  const memorySeed = join(sandbox, "memory-seed");
  const memoryRemote = join(sandbox, "memory.git");
  mkdirSync(memorySeed, { recursive: true });
  git(memorySeed, "init", "-q", "-b", "main");
  configureRepo(memorySeed, "MemorySeed", sandbox);
  writeFileSync(join(memorySeed, "README.md"), "# Shared team memory\n");
  git(memorySeed, "add", "README.md");
  git(memorySeed, "commit", "-qm", "seed memory");
  git(sandbox, "clone", "-q", "--bare", memorySeed, memoryRemote);

  const codeSeed = join(sandbox, "code-seed");
  const codeRemote = join(sandbox, "code.git");
  mkdirSync(join(codeSeed, "src"), { recursive: true });
  git(codeSeed, "init", "-q", "-b", "main");
  configureRepo(codeSeed, "CodeSeed", sandbox);
  writeFileSync(join(codeSeed, ".gitignore"), "node_modules/\n");
  writeFileSync(join(codeSeed, "src/app.ts"), "export const value = 1;\n");
  git(codeSeed, "add", ".gitignore", "src/app.ts");
  git(codeSeed, "commit", "-qm", "feat: add tiny app");
  writeFileSync(join(codeSeed, "src/app.ts"), "export const value = 2;\n");
  git(codeSeed, "add", "src/app.ts");
  git(codeSeed, "commit", "-qm", "fix: revise tiny app");
  git(sandbox, "clone", "-q", "--bare", codeSeed, codeRemote);
  return { codeRemote, memoryRemote };
}

test("shared CLI mutators pump their actual home and rejection leaves the next capture live", { timeout: 180_000 }, () => {
  const sandbox = mkdtempSync(join(tmpdir(), "hunch-cli-pump-"));
  try {
    const { codeRemote, memoryRemote } = seedRemotes(sandbox);
    const architect = cloneActor(sandbox, codeRemote, "Architect");
    expectCli(architect, "init", "--no-index", "--no-enforce", "--no-providers", "--no-agent-hooks");
    expectCli(architect, "shared", "--repo", memoryRemote, "--no-hook");
    git(architect.root, "add", "-A");
    git(architect.root, "commit", "-qm", "chore: connect shared memory");
    git(architect.root, "push", "-q", "origin", "main");

    // A legacy public record can coexist with unified shared routing. Resync must
    // update that exact public home, not let captureHome(false) create a private twin.
    const appCommit = git(architect.root, "log", "-1", "--format=%H", "--", "src/app.ts");
    const staleId = decisionId(appCommit);
    const stalePublic: Decision = {
      ...draft(staleId, "STALE_PUBLIC: preserve the legacy public home"),
      status: "accepted",
      commit: appCommit,
      provenance: { source: "llm_draft", confidence: 0.5, evidence: [`commit:${appCommit.slice(0, 8)}`], last_verified: "2000-01-01T00:00:00.000Z" },
    };
    mkdirSync(join(architect.root, ".hunch/decisions"), { recursive: true });
    writeFileSync(join(architect.root, `.hunch/decisions/${staleId}.json`), `${JSON.stringify(stalePublic, null, 2)}\n`);
    git(architect.root, "add", `.hunch/decisions/${staleId}.json`);
    git(architect.root, "commit", "-qm", "seed: legacy public stale decision");
    expectCli(architect, "stale", "--resync");
    assert.equal(existsSync(join(overlayRoot(architect), `.hunch/decisions/${staleId}.json`)), false,
      "shared resync cannot duplicate a public input into the overlay");
    assert.notEqual((JSON.parse(readFileSync(join(architect.root, `.hunch/decisions/${staleId}.json`), "utf8")) as Decision).provenance.last_verified,
      "2000-01-01T00:00:00.000Z");
    git(architect.root, "push", "-q", "origin", "main");
    const teammate = cloneActor(sandbox, codeRemote, "Teammate");

    const backfillOutput = expectCli(architect, "backfill", "--since", "3650d", "--max", "4", "--concurrency", "1");
    assert.match(backfillOutput, /decision\(s\) seeded/);
    const backfilled = remoteTree(memoryRemote).filter((path) => path.startsWith(".hunch/decisions/"));
    assert.ok(backfilled.length > 0, "backfill pumps shared captures to the team remote");
    assert.match(expectCli(teammate, "query", "tiny app"), /tiny app/i, "a teammate sees backfilled history on the next command");

    const failureOutput = expectCli(architect, "record-bug", "--test", "MATRIX_FAILURE_PUMP", "--message", "shared failure memory must reach every teammate");
    const bugId = failureOutput.match(/recorded bug (bug_[A-Za-z0-9_-]+)/)?.[1];
    assert.ok(bugId, failureOutput);
    assert.equal(remoteJson<{ lineage: { detected: string } }>(memoryRemote, `.hunch/bugs/${bugId}.json`).lineage.detected, "MATRIX_FAILURE_PUMP");
    assert.equal(existsSync(join(architect.root, `.hunch/bugs/${bugId}.json`)), false, "shared failure learning never forks a public bug copy");
    expectCli(teammate, "status");
    assert.equal((JSON.parse(readFileSync(join(overlayRoot(teammate), `.hunch/bugs/${bugId}.json`), "utf8")) as Bug).lineage.detected,
      "MATRIX_FAILURE_PUMP", "a teammate receives the captured failure on its next command");

    const runbookTask = "PUMP_RUNBOOK: revise the tiny app safely";
    const runbookOutput = expectCli(architect, "runbook", "HEAD~1..HEAD", "--task", runbookTask);
    const runbookId = runbookOutput.match(/runbook (rb_[A-Za-z0-9_-]+)/)?.[1];
    assert.ok(runbookId, runbookOutput);
    assert.equal(remoteJson<{ task: string }>(memoryRemote, `.hunch/runbooks/${runbookId}.json`).task, runbookTask);
    assert.match(expectCli(teammate, "runbook", "--find", "PUMP_RUNBOOK"), /PUMP_RUNBOOK/);
    assert.equal(git(overlayRoot(architect), "status", "--porcelain", "--", ".hunch"), "", "runbook capture must leave no unpumped memory mutation");

    const invariantTitle = "PUMP_CONFORM: the tiny app symbol remains present";
    const conformOutput = expectCli(architect, "conform", "--add", invariantTitle, "--assert", "exists", "--subject", "value");
    const invariantId = conformOutput.match(/invariant (dec_[A-Za-z0-9_-]+)/)?.[1];
    assert.ok(invariantId, conformOutput);
    assert.equal(remoteJson<{ title: string }>(memoryRemote, `.hunch/decisions/${invariantId}.json`).title, invariantTitle);
    assert.match(expectCli(teammate, "query", "PUMP_CONFORM"), /PUMP_CONFORM/);
    assert.equal(git(overlayRoot(architect), "status", "--porcelain", "--", ".hunch"), "", "conform --add must leave no unpumped memory mutation");

    const rejectId = "dec_pump_reject";
    const overlay = overlayRoot(architect);
    mkdirSync(join(overlay, ".hunch/decisions"), { recursive: true });
    writeFileSync(join(overlay, `.hunch/decisions/${rejectId}.json`), `${JSON.stringify(draft(rejectId, "PUMP_REJECT: retire this proposal"), null, 2)}\n`);
    git(overlay, "add", `.hunch/decisions/${rejectId}.json`);
    git(overlay, "-c", "user.name=Architect", "-c", "user.email=architect@pump.test", "commit", "-qm", "seed: review proposal");
    git(overlay, "push", "-q", "origin", "main");

    assert.match(expectCli(architect, "review", "--reject", rejectId, "--private"), /rejected dec_pump_reject/);
    const rejected = remoteJson<Decision>(memoryRemote, `.hunch/decisions/${rejectId}.json`);
    assert.equal(rejected.status, "rejected", "rejection is a durable lifecycle record, not an unpublished Git deletion");
    assert.ok(rejected.valid_to, "the tombstone closes the proposal's validity window");
    assert.equal(git(overlay, "status", "--porcelain", "--", ".hunch"), "", "rejection must be pushed so it cannot block the next capture");

    expectCli(teammate, "review", "--private");
    const teammateRejected = JSON.parse(readFileSync(join(overlayRoot(teammate), `.hunch/decisions/${rejectId}.json`), "utf8")) as Decision;
    assert.equal(teammateRejected.status, "rejected", "a second clone observes the rejection on its next command");

    const afterTask = "PUMP_AFTER_REJECT: prove the graph is still alive";
    const afterOutput = expectCli(architect, "runbook", "HEAD~1..HEAD", "--task", afterTask);
    const afterId = afterOutput.match(/runbook (rb_[A-Za-z0-9_-]+)/)?.[1];
    assert.ok(afterId, afterOutput);
    assert.equal(remoteJson<{ task: string }>(memoryRemote, `.hunch/runbooks/${afterId}.json`).task, afterTask,
      "the first capture after rejection must commit and push normally");
    assert.match(expectCli(teammate, "runbook", "--find", "PUMP_AFTER_REJECT"), /PUMP_AFTER_REJECT/);
  } finally {
    rmSync(sandbox, { recursive: true, force: true });
  }
});
