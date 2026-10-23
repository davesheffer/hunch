/**
 * Integration-gap tests: one test per previously uncovered edge of the
 * integration matrix. No model or network is ever called: synthesis is pinned
 * to the deterministic fallback and npm is forced offline for the git-invoked
 * merge driver.
 */
import { cleanupDir, isolatedCliEnv, tempDir } from "./fixtures.js";
import { test } from "node:test";
import assert from "node:assert/strict";
import { execFileSync, spawnSync } from "node:child_process";
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { pathToFileURL } from "node:url";
import { hunchCliArgs } from "./cli-invocation.js";
import { gitRun } from "../src/integrations/hooks.js";
import { withInitiator } from "../src/synthesis/initiator.js";
import { foreignRepoEnv } from "../src/extractors/git.js";
import { createTaskReporter } from "../src/taskReports.js";
import { HunchStore } from "../src/store/hunchStore.js";
import { hunchPaths } from "../src/core/paths.js";

const PROJECT_ROOT = process.cwd();

function fixtureEnv(home: string): NodeJS.ProcessEnv {
  return isolatedCliEnv({
    HUNCH_PRIVATE_DIR: "", HUNCH_EMBEDDINGS: "off", HOME: home, USERPROFILE: home, APPDATA: join(home, "AppData"),
    XDG_CONFIG_HOME: join(home, ".config"), GIT_CONFIG_NOSYSTEM: "1", NO_COLOR: "1", CI: "1",
    GIT_TERMINAL_PROMPT: "0",
    // Defensive: never let any npx a launcher spawns reach the registry.
    npm_config_offline: "true", npm_config_yes: "false",
  });
}

function gitInit(dir: string, env: NodeJS.ProcessEnv): (...args: string[]) => string {
  mkdirSync(dir, { recursive: true });
  const git = (...args: string[]) => execFileSync("git", args, { cwd: dir, env, encoding: "utf8", stdio: ["ignore", "pipe", "pipe"] });
  git("init", "-q", "-b", "main");
  git("config", "user.name", "Fixture"); git("config", "user.email", "fixture@test.invalid"); git("config", "commit.gpgsign", "false");
  writeFileSync(join(dir, "README.md"), "fixture\n");
  git("add", "README.md");
  git("commit", "-q", "-m", "init");
  return git;
}

test("integrations->cli: the installed merge driver command launches hunch", () => {
  const base = tempDir("hunch-gap-merge-");
  try {
    const home = join(base, "home"); mkdirSync(home, { recursive: true });
    const env = fixtureEnv(home);
    const repo = join(base, "repo");
    const git = gitInit(repo, env);

    const init = spawnSync(process.execPath, hunchCliArgs("init", "--no-index"), { cwd: repo, env, encoding: "utf8", timeout: 180_000 });
    assert.equal(init.status, 0, `${init.stdout}${init.stderr}`);

    const driver = git("config", "--get", "merge.hunch.driver").trim();
    assert.match(driver, /merge-driver "%O" "%A" "%B" "%P"$/, "init registered the structured JSON driver");
    const grounding = git("config", "--get", "merge.hunch-grounding.driver").trim();
    assert.match(grounding, /merge-driver-grounding "%O" "%A" "%B" "%P"$/, "init registered the grounding driver");
    if (process.env.HUNCH_TEST_COMPILED_CLI !== "1") {
      // #492: a source-checkout driver must not resolve tsx from the merged repo.
      assert.doesNotMatch(driver, /\bnpx\b/, "dev-mode driver never runs npx inside the merged repo");
      const loader = `"${pathToFileURL(join(PROJECT_ROOT, "node_modules", "tsx")).href}/`;
      for (const d of [driver, grounding]) {
        assert.ok(d.startsWith(`${JSON.stringify(process.execPath)} "--import" ${loader}`), `driver uses Hunch's own tsx loader: ${d}`);
      }
      const again = spawnSync(process.execPath, hunchCliArgs("init", "--no-index"), { cwd: repo, env, encoding: "utf8", timeout: 180_000 });
      assert.equal(again.status, 0, `${again.stdout}${again.stderr}`);
      assert.equal(git("config", "--get", "merge.hunch.driver").trim(), driver, "re-running init leaves a correct driver unchanged");
      assert.equal(git("config", "--get", "merge.hunch-grounding.driver").trim(), grounding, "re-running init leaves a correct grounding driver unchanged");
    }
    assert.match(readFileSync(join(repo, ".gitattributes"), "utf8"), /\.hunch\/\*\*\/\*\.json merge=hunch/);

    // Isolate the merge from hunch's own hooks: only the driver is under test.
    const noHooks = join(base, "no-hooks"); mkdirSync(noHooks);
    git("config", "core.hooksPath", noHooks);

    const probe = join(repo, ".hunch", "merge-probe.json");
    const write = (ids: string[]) => writeFileSync(probe, JSON.stringify(ids.map((id) => ({ id, title: id })), null, 2) + "\n");
    write(["rec_a"]);
    git("add", "-f", ".gitattributes", ".hunch/merge-probe.json");
    git("commit", "-q", "-m", "base");
    git("checkout", "-q", "-b", "side");
    write(["rec_a", "rec_c"]);
    git("commit", "-q", "-am", "theirs adds rec_c");
    git("checkout", "-q", "main");
    write(["rec_a", "rec_b"]);
    git("commit", "-q", "-am", "ours adds rec_b");

    // A plain text merge of these two appends conflicts on the same hunk; only the
    // structured driver (git -> configured shell -> hunch merge-driver) resolves it.
    const merge = spawnSync("git", ["merge", "--no-edit", "side"], { cwd: repo, env, encoding: "utf8", timeout: 180_000 });
    const text = readFileSync(probe, "utf8");
    assert.equal(merge.status, 0, `git merge failed (driver: ${driver})\n${merge.stdout}${merge.stderr}\n${text}`);
    assert.doesNotMatch(text, /^(<{7}|={7}|>{7})/m, "no conflict markers");
    const merged = JSON.parse(text) as Array<{ id: string }>;
    assert.deepEqual(merged.map((r) => r.id), ["rec_a", "rec_b", "rec_c"], "records merged by id by the hunch driver");
  } finally {
    cleanupDir(base);
  }
});

test("integrations->synthesis: git hooks carry HUNCH_INITIATOR", () => {
  const base = tempDir("hunch-gap-initiator-");
  try {
    execFileSync("git", ["init", "-q", base]);
    // A shell alias echoes the env git itself received from gitRun.
    const probe = ["-c", "alias.probe=!printf %s \"$HUNCH_INITIATOR\"", "probe"];
    const codex = withInitiator({ provider: "codex-cli", source: "client" }, () => gitRun(probe, base));
    assert.equal(codex.status, 0);
    assert.equal(codex.stdout, "codex-cli", "the bound initiator reaches the git child");
    const unknown = withInitiator({ provider: null, source: "unknown" }, () => gitRun(probe, base));
    assert.equal(unknown.stdout, "unknown", "an unknown origin is frozen explicitly, never inherited from the parent shell");
  } finally {
    cleanupDir(base);
  }
});

test("extractors->synthesis: foreignRepoEnv carries the initiator", () => {
  const env = withInitiator({ provider: "codex-cli", source: "client" },
    () => foreignRepoEnv({ CLAUDECODE: "1", GIT_DIR: "/elsewhere/.git", GIT_CONFIG_KEY_0: "x", PATH: "p" }));
  assert.equal(env.HUNCH_INITIATOR, "codex-cli", "the bound client wins over the inherited CLAUDECODE");
  assert.equal(env.GIT_DIR, undefined, "repository identity is still stripped");
  assert.equal(env.GIT_CONFIG_KEY_0, undefined);
  assert.equal(env.PATH, "p");
  // Without a bound context the environment decides.
  assert.equal(foreignRepoEnv({ CLAUDECODE: "1" }).HUNCH_INITIATOR, "claude-cli");
});

test("root->store: a finished task report lands in the store", async () => {
  const ok = tempDir("hunch-gap-task-");
  const broken = tempDir("hunch-gap-task-broken-");
  try {
    for (const root of [ok, broken]) {
      execFileSync("git", ["init", "-q", root]);
      execFileSync("git", ["config", "user.name", "Fixture"], { cwd: root });
      execFileSync("git", ["config", "user.email", "fixture@test.invalid"], { cwd: root });
      execFileSync("git", ["config", "commit.gpgsign", "false"], { cwd: root });
      writeFileSync(join(root, ".gitignore"), ".hunch-cache/\n");
    }

    const host = createTaskReporter(ok);
    const task = host.start("Persist a finished task");
    await host.verify(task.task_id, [process.execPath, "-e", "process.exit(0)"], "Passing check");
    const finished = host.finish(task.task_id);
    assert.equal(finished.report.task.state, "completed");
    const store = new HunchStore(hunchPaths(ok));
    try {
      const tasks = store.recs("tasks");
      assert.equal(tasks.length, 1, "the finished task was persisted as a graph record");
      assert.equal(store.json.get("tasks", tasks[0]!.id)?.id, tasks[0]!.id, "readable back from the JSON source of truth");
    } finally {
      store.close();
    }

    // Current contract: the graph write is best-effort. A store that cannot be
    // written (here `.hunch` is a plain file) is swallowed; the report still finishes.
    writeFileSync(join(broken, ".hunch"), "not a directory\n");
    const brokenHost = createTaskReporter(broken);
    const t2 = brokenHost.start("Store write fails");
    await brokenHost.verify(t2.task_id, [process.execPath, "-e", "process.exit(0)"], "Passing check");
    const res = brokenHost.finish(t2.task_id);
    assert.equal(res.report.task.state, "completed", "finish does not throw when the store write fails");
    assert.ok(!existsSync(join(broken, ".hunch", "tasks")));
  } finally {
    cleanupDir(ok);
    cleanupDir(broken);
  }
});

test("external:packaging: every package.json bin/exports target resolves and imports", async () => {
  const pkg = JSON.parse(readFileSync(join(PROJECT_ROOT, "package.json"), "utf8")) as {
    bin: Record<string, string>; exports: Record<string, string | { types?: string; default: string }>;
  };
  const tsconfig = readFileSync(join(PROJECT_ROOT, "tsconfig.json"), "utf8");
  assert.match(tsconfig, /"rootDir":\s*"src"/); assert.match(tsconfig, /"outDir":\s*"dist"/);
  // dist/x.js (and dist/x.d.ts) are emitted from src/x.ts.
  const sourceOf = (target: string) => join(PROJECT_ROOT, target.replace(/^\.\//, "").replace(/^dist\//, "src/").replace(/(\.d\.ts|\.js)$/, ".ts"));

  for (const [name, target] of Object.entries(pkg.bin)) {
    assert.ok(existsSync(sourceOf(target)), `bin ${name} -> ${target} has a source`);
  }
  assert.ok(existsSync(sourceOf(pkg.bin.hunch!)) && sourceOf(pkg.bin.hunch!).endsWith(join("src", "cli", "index.ts")));

  const documented: Record<string, string[]> = {
    "./change-proof": ["CHANGE_PROOF_SCHEMA_VERSION", "ChangeProofSchema", "assertChangeProof", "changeProofHash", "canonicalChangeProofJson"],
    "./project-dna": ["PROJECT_DNA_SCHEMA_VERSION", "discoverProjectDna", "evaluateProjectDnaMatch", "assertProjectDnaProfile"],
    "./state": ["createStateClient", "StateClientError"],
    "./state-proof": ["createStateProofSigner"],
    "./reports": ["createTaskReporter", "renderTaskReport", "TASK_REPORT_SCHEMA"],
  };
  const subpaths = Object.keys(pkg.exports).filter((k) => !k.includes("*") && k !== "./package.json");
  assert.deepEqual(subpaths.sort(), Object.keys(documented).sort(), "every exports subpath is covered here");
  for (const sub of subpaths) {
    const entry = pkg.exports[sub]!;
    const targets = typeof entry === "string" ? [entry] : [entry.default, ...(entry.types ? [entry.types] : [])];
    for (const target of targets) assert.ok(existsSync(sourceOf(target)), `${sub} -> ${target} has a source`);
    const mod = await import(pathToFileURL(sourceOf(targets[0]!)).href) as Record<string, unknown>;
    for (const name of documented[sub]!) assert.ok(mod[name] !== undefined, `${sub} exports ${name}`);
  }
  assert.equal(pkg.exports["./dist/*"], "./dist/*");
});
