import { test } from "node:test";
import assert from "node:assert/strict";
import { execFileSync, spawn, spawnSync } from "node:child_process";
import { existsSync, mkdirSync, readFileSync, readdirSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import { isAbsolute, join } from "node:path";
import { cleanupDir, isolatedCliEnv, tempDir } from "./fixtures.js";
import { hunchCliArgs } from "./cli-invocation.js";
import { applyUninstall, formatUninstallPlan, OPT_OUT_FILE, planUninstall, type UninstallPlan } from "../src/integrations/uninstall.js";
import { HUNCH_END, HUNCH_START } from "../src/integrations/claudemd.js";
import { planHookRemoval } from "../src/integrations/hooks.js";

/** #449: `hunch uninstall` removes exactly what `hunch init` installed, and the
 *  opt-out marker keeps every setup path from bringing it back. */

const USER_FILES: Record<string, string> = {
  "README.md": "fixture\n",
  "CLAUDE.md": "# My project\n\nMy own rules for agents.\n",
  ".mcp.json": JSON.stringify({ mcpServers: { other: { command: "other-server", args: [] } } }, null, 2) + "\n",
  ".claude/settings.json": JSON.stringify({ permissions: { allow: ["Bash(ls)"] }, hooks: { Stop: [{ hooks: [{ type: "command", command: "echo mine" }] }] } }, null, 2) + "\n",
  ".gitattributes": "*.png binary\n",
  ".gitignore": "node_modules/\n",
};
const USER_PRE_COMMIT = "#!/bin/sh\necho user-pre-commit\n";

function fixture(): { base: string; root: string; home: string; env: NodeJS.ProcessEnv; git: (...args: string[]) => string; hunch: (...args: string[]) => ReturnType<typeof spawnSync> } {
  const base = tempDir("hunch-uninstall-");
  const root = join(base, "repo");
  const home = join(base, "home");
  mkdirSync(root); mkdirSync(home);
  const env = isolatedCliEnv({
    HUNCH_PRIVATE_DIR: "", HUNCH_EMBEDDINGS: "off", HOME: home, USERPROFILE: home, APPDATA: join(home, "AppData"),
    XDG_CONFIG_HOME: join(home, ".config"), GIT_CONFIG_NOSYSTEM: "1", HUNCH_SYNC: "1", NO_COLOR: "1", CI: "1",
  });
  const git = (...args: string[]) => execFileSync("git", args, { cwd: root, env, encoding: "utf8", stdio: "pipe" });
  const hunch = (...args: string[]) => spawnSync(process.execPath, hunchCliArgs(...args), { cwd: root, env, encoding: "utf8", timeout: 120_000 });
  git("init", "-q", "-b", "main");
  git("config", "user.name", "Fixture"); git("config", "user.email", "fixture@test.invalid"); git("config", "commit.gpgsign", "false");
  for (const [rel, text] of Object.entries(USER_FILES)) {
    mkdirSync(join(root, rel, ".."), { recursive: true });
    writeFileSync(join(root, rel), text);
  }
  writeFileSync(join(root, ".git", "hooks", "pre-commit"), USER_PRE_COMMIT);
  git("add", "-A"); git("commit", "-qm", "user files");
  return { base, root, home, env, git, hunch };
}

const out = (r: ReturnType<typeof spawnSync>) => `${r.stdout}${r.stderr}`;

/** Every non-ignored file in the work tree (tracked or not), repo-relative. */
function workTreeFiles(git: (...args: string[]) => string): string[] {
  return git("ls-files", "--cached", "--others", "--exclude-standard").split("\n").filter(Boolean);
}

test("init then uninstall --purge leaves only the user's files, and nothing re-installs Hunch", { timeout: 300_000 }, () => {
  const { base, root, home, git, hunch } = fixture();
  try {
    mkdirSync(join(home, ".codeium", "windsurf"), { recursive: true }); // Windsurf installed: init registers globally
    const init = hunch("init", "--no-index");
    assert.equal(init.status, 0, out(init));
    assert.equal(hunch("ci").status, 0);
    assert.match(readFileSync(join(root, "CLAUDE.md"), "utf8"), /HUNCH:START/, "init really installed");
    assert.ok(existsSync(join(root, ".git", "hooks", "post-commit")));

    const removed = hunch("uninstall", "--purge");
    assert.equal(removed.status, 0, out(removed));
    assert.match(out(removed), /kept .*mcp_config\.json — Windsurf's global hunch MCP entry/, "a global registration it leaves alone is reported, not silently kept");

    assert.equal(git("status", "--porcelain", "--untracked-files=all").trim(), `?? .hunch-removed`, "only the opt-out marker is new");
    for (const [rel, text] of Object.entries(USER_FILES)) assert.equal(readFileSync(join(root, rel), "utf8"), text, `${rel} is back to the user's bytes`);
    assert.equal(readFileSync(join(root, ".git", "hooks", "pre-commit"), "utf8"), USER_PRE_COMMIT, "the user's own pre-commit lines survive");
    for (const name of ["post-commit", "post-merge", "post-checkout"]) assert.ok(!existsSync(join(root, ".git", "hooks", name)), `${name} hook removed`);
    assert.equal(spawnSync("git", ["config", "--local", "--get-regexp", "^merge\\.hunch"], { cwd: root, encoding: "utf8" }).stdout, "", "merge drivers unregistered");
    assert.ok(!existsSync(join(root, ".git", "hunch")), "no Hunch pointer left in the git dir");
    for (const rel of workTreeFiles(git).filter((f) => f !== ".hunch-removed")) {
      assert.doesNotMatch(readFileSync(join(root, rel), "utf8"), /hunch/i, `${rel} carries no Hunch leftover`);
    }
    const hooks = readFileSync(join(root, ".git", "hooks", "pre-commit"), "utf8");
    assert.doesNotMatch(hooks, /hunch/i);

    // Idempotent.
    const again = hunch("uninstall", "--purge");
    assert.equal(again.status, 0, out(again));
    assert.match(out(again), /nothing to remove/);
    assert.equal(git("status", "--porcelain", "--untracked-files=all").trim(), `?? .hunch-removed`);

    // Opted out: doctor says so, setup refuses, hook entry points stay quiet and succeed.
    const doctor = hunch("doctor");
    assert.equal(doctor.status, 0, out(doctor));
    assert.match(out(doctor), /not installed \(opted out/);
    for (const args of [["init"], ["update"], ["index"], ["mcp"]]) {
      const r = hunch(...args);
      assert.equal(r.status, 1, `${args.join(" ")} refuses: ${out(r)}`);
      assert.match(String(r.stderr), /removed from this repository on purpose/);
    }
    const hook = spawnSync(process.execPath, hunchCliArgs("hook"), { cwd: root, encoding: "utf8", input: "{}", timeout: 120_000 });
    assert.equal(hook.status, 0);
    assert.equal(hook.stdout, "", "an agent hook left behind injects nothing");
    assert.equal(hunch("check", "--staged", "--strict").status, 0, "a leftover pre-commit guard never blocks the user's commit");
    assert.equal(git("status", "--porcelain", "--untracked-files=all").trim(), `?? .hunch-removed`, "no refused command wrote anything");
  } finally { cleanupDir(base); }
});

test("uninstall without --purge keeps .hunch/ and its ignore block; --dry-run writes nothing", { timeout: 300_000 }, () => {
  const { base, root, git, hunch } = fixture();
  try {
    assert.equal(hunch("init", "--no-index", "--no-providers").status, 0);
    const before = git("status", "--porcelain", "--untracked-files=all");
    const dry = hunch("uninstall", "--dry-run");
    assert.equal(dry.status, 0, out(dry));
    assert.match(out(dry), /would delete .*post-commit/);
    assert.equal(git("status", "--porcelain", "--untracked-files=all"), before, "dry run writes nothing");
    assert.ok(!existsSync(join(root, ".hunch-removed")));

    const removed = hunch("uninstall");
    assert.equal(removed.status, 0, out(removed));
    assert.ok(existsSync(join(root, ".hunch")), ".hunch/ (the memory) is kept");
    assert.match(readFileSync(join(root, ".gitignore"), "utf8"), /# >>> hunch/, "the ignore block still covers the kept .hunch/ runtime files");
    assert.equal(readFileSync(join(root, "CLAUDE.md"), "utf8"), USER_FILES["CLAUDE.md"]);
    assert.match(out(removed), /kept \.hunch\/ — your engineering memory/);
  } finally { cleanupDir(base); }
});

test("an unparseable config is refused and the whole uninstall changes nothing", { timeout: 300_000 }, () => {
  const { base, root, git, hunch } = fixture();
  try {
    assert.equal(hunch("init", "--no-index").status, 0);
    writeFileSync(join(root, ".cursor", "mcp.json"), "{ \"mcpServers\": { \"hunch\": { not json");
    const snapshot = (): Record<string, string> => Object.fromEntries(
      [...workTreeFiles(git), ...readdirSync(join(root, ".git", "hooks")).map((h) => `.git/hooks/${h}`)]
        .filter((rel) => existsSync(join(root, rel)))
        .map((rel) => [rel, readFileSync(join(root, rel), "utf8")]),
    );
    const before = snapshot();
    const r = hunch("uninstall", "--purge");
    assert.equal(r.status, 1, out(r));
    assert.match(String(r.stderr), /\.cursor\/mcp\.json: .*could not parse/);
    assert.match(String(r.stderr), /nothing was changed/);
    assert.deepEqual(snapshot(), before, "no file was touched");
    assert.ok(!existsSync(join(root, ".hunch-removed")));
  } finally { cleanupDir(base); }
});

test("the opt-out gate judges the --root a command acts on, not the cwd's repository (#458)", { timeout: 300_000 }, () => {
  const { base, root, env, hunch } = fixture();
  try {
    assert.equal(hunch("init", "--no-index", "--no-providers").status, 0);
    assert.equal(hunch("uninstall", "--purge").status, 0);
    const optedOut = /removed from this repository on purpose/;
    // An opted-out cwd must not block a command pinned to a store that never opted out.
    const other = join(base, "other");
    mkdirSync(join(other, ".hunch"), { recursive: true });
    const fromOptedOut = spawnSync(process.execPath, hunchCliArgs("mcp", "--root", other), { cwd: root, env, encoding: "utf8", input: "", timeout: 60_000 });
    assert.doesNotMatch(out(fromOptedOut), optedOut, "a store that never opted out is served from an opted-out cwd");
    assert.equal(fromOptedOut.status, 0, out(fromOptedOut));
    // A command pinned to an opted-out repository is refused from anywhere.
    mkdirSync(join(root, ".hunch"), { recursive: true });
    const elsewhere = join(base, "elsewhere");
    mkdirSync(elsewhere);
    const intoOptedOut = spawnSync(process.execPath, hunchCliArgs("mcp", "--root", root), { cwd: elsewhere, env, encoding: "utf8", input: "", timeout: 60_000 });
    assert.equal(intoOptedOut.status, 1, out(intoOptedOut));
    assert.match(out(intoOptedOut), optedOut, "an opted-out --root is gated even when the cwd is elsewhere");
    // A --root inside an opted-out repository is gated like the repository itself.
    const partition = join(root, "partitions", "x");
    for (const cwd of [root, elsewhere]) {
      const init = spawnSync(process.execPath, hunchCliArgs("serve", "init", "--partition", "user:x", "--root", partition), { cwd, env, encoding: "utf8", timeout: 60_000 });
      assert.equal(init.status, 1, out(init));
      assert.match(out(init), optedOut, `serve init into an opted-out repository is refused (cwd ${cwd})`);
      assert.ok(!existsSync(join(partition, ".hunch")), "no partition store was created");
      assert.ok(!existsSync(join(cwd, "hunch-serve.json")), "no serve config was written");
    }
    // A partition store nested in an opted-out repository stays gated (fail closed).
    mkdirSync(join(partition, ".hunch"), { recursive: true });
    const nested = spawnSync(process.execPath, hunchCliArgs("mcp", "--root", partition), { cwd: elsewhere, env, encoding: "utf8", input: "", timeout: 60_000 });
    assert.equal(nested.status, 1, out(nested));
    assert.match(out(nested), optedOut, "a store nested in an opted-out repository is gated");
    cleanupDir(join(root, "partitions"));
    // serve init writes its config file relative to the cwd: an opted-out cwd refuses it
    // even when the partition --root lies elsewhere, with or without --config.
    const away = join(elsewhere, "x");
    for (const config of [[], ["--config", "hunch-serve.json"]]) {
      const init = spawnSync(process.execPath, hunchCliArgs("serve", "init", "--partition", "user:x", "--root", away, ...config), { cwd: root, env, encoding: "utf8", timeout: 60_000 });
      assert.equal(init.status, 1, out(init));
      assert.match(out(init), optedOut, `serve init ${config.join(" ")} from an opted-out cwd is refused`);
      assert.ok(!existsSync(join(root, "hunch-serve.json")), "no serve config was written into the opted-out repository");
      assert.ok(!existsSync(join(away, ".hunch")), "no partition store was created");
    }
  } finally { cleanupDir(base); }
});

test("the opt-out gate judges the repository each location option acts on, and names its marker (#488)", { timeout: 300_000 }, () => {
  const { base, root, env, hunch } = fixture();
  try {
    assert.equal(hunch("init", "--no-index", "--no-providers").status, 0);
    assert.equal(hunch("uninstall", "--purge").status, 0);
    const marker = join(realpathSync(root), OPT_OUT_FILE);
    const clean = join(base, "clean");
    mkdirSync(clean);
    execFileSync("git", ["init", "-q", "-b", "main"], { cwd: clean, env, stdio: "pipe" });
    const at = (cwd: string, ...args: string[]) => spawnSync(process.execPath, hunchCliArgs(...args), { cwd, env, encoding: "utf8", input: "", timeout: 60_000 });
    const refused = (r: ReturnType<typeof spawnSync>) => out(r).includes("removed from this repository on purpose");

    // Output locations: into the opted-out repository from a clean cwd is refused and
    // names THAT repository's marker; the same option into a clean place is not gated.
    for (const [args, into, given] of [
      [["private"], join(root, "store")], [["shared"], join(root, "sub", "store")], [["worktree"], join(root, "wt")],
      // export-adr joins its dir onto the cwd's repository: a relative `..` escape reaches the opted-out one.
      [["export-adr"], join(root, "adr"), "../repo/adr"], [["verify", "--list", "--map"], join(root, "map.json")],
      [["review-memory", "auto", "--repository", "o/r", "--dry-run", "--output"], join(root, "report.json")],
    ] as Array<[string[], string, string?]>) {
      const r = at(clean, ...args, given ?? into);
      assert.ok(refused(r), `${args.join(" ")} into the opted-out repository is refused:\n${out(r)}`);
      assert.notEqual(r.status, 0);
      assert.ok(out(r).includes(marker), `the refusal names the checked marker ${marker}:\n${out(r)}`);
      assert.ok(!existsSync(into), `${args.join(" ")} wrote nothing into the opted-out repository`);
      const ok = at(clean, ...args, join(clean, "elsewhere-out"));
      assert.ok(!refused(ok), `${args.join(" ")} into a clean location is not gated:\n${out(ok)}`);
    }

    // `serve --config` names the repository it serves: the config's directory and every
    // partition root it lists decide the gate, not the cwd.
    const init = at(clean, "serve", "init", "--partition", "user:x", "--root", join(clean, "part"), "--config", join(clean, "hunch-serve.json"));
    assert.equal(init.status, 0, out(init));
    const configFile = join(clean, "hunch-serve.json");
    const fromOptedOut = at(root, "serve", "revoke", "--principal", "nobody", "--config", configFile);
    assert.ok(!refused(fromOptedOut), `a clean serve config is not gated by an opted-out cwd:\n${out(fromOptedOut)}`);
    const config = JSON.parse(readFileSync(configFile, "utf8")) as { partitions: Array<{ root: string }> };
    config.partitions[0]!.root = join(root, "partitions", "x");
    writeFileSync(configFile, JSON.stringify(config, null, 2));
    const intoOptedOut = at(clean, "serve", "revoke", "--principal", "nobody", "--config", configFile);
    assert.ok(refused(intoOptedOut), `a config serving a partition inside an opted-out repository is refused:\n${out(intoOptedOut)}`);
    assert.ok(out(intoOptedOut).includes(marker));

    // A cwd inside a store nested in an opted-out repository is gated (no --root needed).
    const nested = join(root, "nested");
    mkdirSync(join(nested, ".hunch"), { recursive: true });
    const inNested = at(nested, "index");
    assert.equal(inNested.status, 1, out(inNested));
    assert.ok(refused(inNested) && out(inNested).includes(marker), out(inNested));
    assert.ok(!existsSync(join(nested, ".hunch", "index.db")), "nothing was indexed into the nested store");

    // A linked worktree whose branch lacks the marker still writes the default overlay
    // store and the shared-overlay pointer into the MAIN checkout: gated by its marker.
    const linked = join(base, "linked");
    execFileSync("git", ["worktree", "add", "-q", "-b", "linked", linked], { cwd: root, env, stdio: "pipe" });
    assert.ok(!existsSync(join(linked, OPT_OUT_FILE)));
    // `init` too: git hooks live in the common dir the worktrees share (#488).
    for (const args of [["init", "--no-index", "--no-providers"], ["private"], ["shared"], ["worktree", join(base, "wt2")]]) {
      const r = at(linked, ...args);
      assert.ok(refused(r) && out(r).includes(marker), `${args.join(" ")} from a linked worktree of an opted-out checkout is refused:\n${out(r)}`);
      assert.notEqual(r.status, 0);
    }
    assert.ok(!existsSync(join(root, ".hunch-private")), "no overlay store was created in the opted-out main checkout");
    assert.ok(!existsSync(join(root, ".git", "hunch")), "no shared-overlay pointer was written");
    assert.ok(!existsSync(join(base, "wt2")));
    const hooks = join(root, ".git", "hooks");
    for (const f of existsSync(hooks) ? readdirSync(hooks).filter((n) => !n.endsWith(".sample")) : []) {
      assert.ok(!/hunch/i.test(readFileSync(join(hooks, f), "utf8")), `the opted-out main checkout's shared ${f} hook carries no Hunch`);
    }

    // A submodule of the opted-out superproject is its own repository: its common dir
    // (super/.git/modules/x) is not a main checkout, so `init` there is not refused.
    const subSrc = join(base, "subsrc");
    const submodule = join(root, "vendored");
    mkdirSync(subSrc);
    const sg = (cwd: string, ...a: string[]) => execFileSync("git", ["-c", "protocol.file.allow=always", ...a], { cwd, env, stdio: "pipe" });
    sg(subSrc, "init", "-q", "-b", "main");
    sg(subSrc, "config", "user.name", "Fixture"); sg(subSrc, "config", "user.email", "fixture@test.invalid"); sg(subSrc, "config", "commit.gpgsign", "false");
    writeFileSync(join(subSrc, "f.txt"), "x\n");
    sg(subSrc, "add", "-A"); sg(subSrc, "commit", "-qm", "init");
    sg(root, "submodule", "add", "-q", subSrc, "vendored");
    const inSub = at(submodule, "init", "--no-index", "--no-providers");
    assert.ok(!refused(inSub), `init inside a submodule of an opted-out superproject is not refused:\n${out(inSub)}`);

    // Outside any repository a stray marker in an ancestor gates nothing.
    const loose = join(base, "loose");
    mkdirSync(join(loose, "child"), { recursive: true });
    writeFileSync(join(loose, OPT_OUT_FILE), "stray\n");
    const outside = at(join(loose, "child"), "query", "anything");
    assert.ok(!refused(outside), `an ancestor marker outside a repository does not gate:\n${out(outside)}`);

    // A git-less Hunch store that opted out is still gated as an output target.
    const store = join(base, "gitless-store");
    mkdirSync(join(store, ".hunch"), { recursive: true });
    writeFileSync(join(store, OPT_OUT_FILE), "opted out\n");
    const storeMarker = join(realpathSync(store), OPT_OUT_FILE);
    for (const [args, into] of [
      [["private", "--no-hook"], join(store, "sub")],
      [["review-memory", "auto", "--repository", "o/r", "--dry-run", "--output"], join(store, "r.json")],
    ] as Array<[string[], string]>) {
      const r = at(clean, ...args, into);
      assert.ok(refused(r) && out(r).includes(storeMarker), `${args.join(" ")} into a git-less opted-out store is refused:\n${out(r)}`);
      assert.notEqual(r.status, 0);
      assert.ok(!existsSync(into), "nothing was written into the opted-out store");
    }
    assert.ok(!existsSync(join(store, ".git")), "no git init inside the opted-out store");

    // Bare-clone and --separate-git-dir layouts: the git common dir has no `.git` entry,
    // so a stray marker in a non-repository ancestor must not gate the overlay commands.
    const layouts = join(loose, "layouts");
    mkdirSync(layouts);
    const g = (cwd: string, ...args: string[]) => execFileSync("git", args, { cwd, env, stdio: "pipe" });
    g(layouts, "clone", "-q", "--bare", root, "proj.git");
    g(join(layouts, "proj.git"), "worktree", "add", "-q", "-b", "bare-wt", join(layouts, "wt"));
    mkdirSync(join(layouts, "sep"));
    g(join(layouts, "sep"), "init", "-q", "-b", "main", "--separate-git-dir", join(layouts, "sep.gitdir"));
    for (const cwd of [join(layouts, "wt"), join(layouts, "sep")]) {
      for (const args of [["private", "--no-hook"], ["shared", "--no-hook"], ["worktree", join(layouts, `wt-${cwd.endsWith("sep") ? "s" : "b"}`)]]) {
        const r = at(cwd, ...args);
        assert.ok(!refused(r), `${args.join(" ")} in ${cwd} is not gated by a stray ancestor marker:\n${out(r)}`);
      }
    }
  } finally { cleanupDir(base); }
});

test("every command but uninstall/doctor/help refuses in an opted-out repo, and none writes (deny by default)", { timeout: 600_000 }, async () => {
  const { base, root, env, git, hunch } = fixture();
  try {
    assert.equal(hunch("init", "--no-index", "--no-providers").status, 0);
    assert.equal(hunch("uninstall", "--purge").status, 0);
    const help = hunch("--help");
    assert.equal(help.status, 0, out(help));
    const names = [...String(help.stdout).matchAll(/^ {2}([a-z][a-z0-9-]*)\b/gm)].map((m) => m[1]!).filter((n) => n !== "help");
    assert.ok(names.length > 30 && names.includes("ci") && names.includes("init"), `parsed the command list: ${names.join(" ")}`);
    const quiet = new Set(["hook", "sync", "check", "grounding", "repair-provenance", "workspaces"]);
    const allowed = new Set(["uninstall", "doctor", "merge-driver", "merge-driver-grounding"]);
    const run = (name: string) => new Promise<{ name: string; status: number | null }>((resolve) => {
      const child = spawn(process.execPath, hunchCliArgs(name), { cwd: root, env, stdio: ["ignore", "ignore", "ignore"] });
      const timer = setTimeout(() => child.kill(), 120_000);
      child.on("close", (status) => { clearTimeout(timer); resolve({ name, status }); });
    });
    const results: Array<{ name: string; status: number | null }> = [];
    const queue = names.filter((n) => !allowed.has(n));
    await Promise.all(Array.from({ length: 6 }, async () => { for (let n = queue.shift(); n; n = queue.shift()) results.push(await run(n)); }));
    for (const r of results) {
      if (quiet.has(r.name)) assert.equal(r.status, 0, `${r.name} exits 0 so a leftover hook never breaks a commit or agent turn`);
      else assert.notEqual(r.status, 0, `${r.name} refuses in an opted-out repo`);
    }
    assert.equal(git("status", "--porcelain", "--untracked-files=all").trim(), `?? .hunch-removed`, "no command wrote anything (hunch ci included)");
  } finally { cleanupDir(base); }
});

test("applyUninstall keeps going past a failed step and reports it; a failed opt-out marker stops everything", () => {
  const ran: string[] = [];
  const step = (path: string, fail = false): UninstallPlan["steps"][number] => ({ path, kind: "delete", note: "", run: () => { ran.push(path); if (fail) throw new Error(`EBUSY: ${path}`); } });
  const plan = (steps: UninstallPlan["steps"]): UninstallPlan => ({ root: tempDir("hunch-uninstall-apply-"), purge: false, steps, refused: [] });
  const p1 = plan([step(OPT_OUT_FILE), step(".hunch/", true), step(".hunch-cache/")]);
  try {
    const r1 = applyUninstall(p1);
    assert.deepEqual(r1.failed, [{ path: ".hunch/", error: "EBUSY: .hunch/" }]);
    assert.deepEqual(r1.applied.map((s) => s.path), [OPT_OUT_FILE, ".hunch-cache/"], "only the steps that ran are reported as done");
    assert.deepEqual(ran, [OPT_OUT_FILE, ".hunch/", ".hunch-cache/"], "the remaining steps still ran");
  } finally { cleanupDir(p1.root); }
  ran.length = 0;
  const p2 = plan([step(OPT_OUT_FILE, true), step("CLAUDE.md")]);
  try {
    const r2 = applyUninstall(p2);
    assert.equal(r2.failed.length, 1);
    assert.deepEqual(r2.applied, [], "nothing is reported as done");
    assert.deepEqual(ran, [OPT_OUT_FILE], "nothing is removed without the marker that keeps Hunch out");
  } finally { cleanupDir(p2.root); }
});

test("uninstall whose opt-out marker can't be written says nothing was changed, not 'uninstalled'", { timeout: 300_000 }, () => {
  const { base, root, hunch } = fixture();
  try {
    assert.equal(hunch("init", "--no-index").status, 0);
    // A directory where the marker file goes: the atomic write's rename fails.
    mkdirSync(join(root, OPT_OUT_FILE, "blocker"), { recursive: true });
    const r = hunch("uninstall");
    assert.equal(r.status, 1, out(r));
    assert.doesNotMatch(String(r.stdout), /Hunch uninstalled|✓ (edited|deleted|created)/, "no step is claimed as done");
    assert.match(String(r.stdout), /Hunch uninstall: nothing was changed/);
    assert.match(out(r), new RegExp(`✗ ${OPT_OUT_FILE.replace(".", "\\.")}:`));
    assert.match(readFileSync(join(root, "CLAUDE.md"), "utf8"), /HUNCH:START/, "really nothing was removed");
  } finally { cleanupDir(base); }
});

test("a JSONC config without a Hunch entry never blocks uninstall; one with Hunch in it still refuses", () => {
  const { base, root } = fixture();
  try {
    mkdirSync(join(root, ".vscode"), { recursive: true });
    writeFileSync(join(root, ".vscode", "mcp.json"), "{\n  // mine\n  \"servers\": { \"other\": { \"command\": \"x\" } }\n}\n");
    assert.deepEqual(planUninstall(root).refused, [], "a file Hunch never wrote into is not Hunch's to fix");
    writeFileSync(join(root, ".vscode", "mcp.json"), "{\n  // mine\n  \"servers\": { \"hunch\": { \"command\": \"hunch\" } }\n}\n");
    assert.deepEqual(planUninstall(root).refused.map((r) => r.path), [".vscode/mcp.json"]);
    // A source install's hook names only its CLI entry path, never "hunch".
    rmSync(join(root, ".vscode", "mcp.json"));
    mkdirSync(join(root, ".cursor"), { recursive: true });
    writeFileSync(join(root, ".cursor", "hooks.json"), "{\n  // mine\n  \"hooks\": { \"stop\": [{ \"command\": \"node D:\\\\dev\\\\memtool\\\\dist\\\\cli\\\\index.js hook --provider cursor\" }] }\n}\n");
    assert.deepEqual(planUninstall(root).refused.map((r) => r.path), [".cursor/hooks.json"]);
  } finally { cleanupDir(base); }
});

test("removing the instruction block keeps the indentation of the user's next line", () => {
  const { base, root } = fixture();
  try {
    writeFileSync(join(root, "CLAUDE.md"), `# Mine\n\n${HUNCH_START}\nhunch text\n${HUNCH_END}\n\n    npm test\n`);
    const step = planUninstall(root).steps.find((s) => s.path === "CLAUDE.md");
    step?.run();
    assert.equal(readFileSync(join(root, "CLAUDE.md"), "utf8"), "# Mine\n\n    npm test\n");
    writeFileSync(join(root, "CLAUDE.md"), `# Mine\n\n${HUNCH_START}\nhunch text\n${HUNCH_END}\n   `);
    planUninstall(root).steps.find((s) => s.path === "CLAUDE.md")?.run();
    assert.equal(readFileSync(join(root, "CLAUDE.md"), "utf8"), "# Mine\n", "a whitespace-only tail goes with the block");
  } finally { cleanupDir(base); }
});

test("the merge drivers still merge in an opted-out repository, so git never drops `theirs`", { timeout: 120_000 }, () => {
  const { base, root, hunch } = fixture();
  try {
    writeFileSync(join(root, OPT_OUT_FILE), "opted out\n");
    const [o, a, b] = ["base.txt", "ours.txt", "theirs.txt"].map((f) => join(base, f));
    writeFileSync(o!, "a\n"); writeFileSync(a!, "a\nb\n"); writeFileSync(b!, "c\na\n");
    const r = hunch("merge-driver", o!, a!, b!, "x.json");
    assert.equal(r.status, 0, out(r));
    assert.equal(readFileSync(a!, "utf8"), "c\na\nb\n", "%A holds the merge, not just ours");
  } finally { cleanupDir(base); }
});

test("hook removal keeps a CRLF hook's own bytes and line endings", () => {
  const { base, root } = fixture();
  try {
    const block = "# >>> hunch post-commit >>>\r\nhunch sync\r\n# <<< hunch post-commit <<<\r\n";
    writeFileSync(join(root, ".git", "hooks", "post-commit"), `#!/bin/sh\r\necho mine\r\n${block}echo after\r\n`);
    const plan = planHookRemoval(root).find((r) => r.hookName === "post-commit");
    assert.equal(plan?.next, "#!/bin/sh\r\necho mine\r\necho after\r\n", "only the block and its own line break go");
  } finally { cleanupDir(base); }
});

/** #459: the git hooks and merge drivers live in the clone's common git dir, so
 *  every worktree and branch shares them, while the marker lands on one branch. */
const norm = (p: string): string => (process.platform === "win32" ? p.replace(/\\/g, "/").toLowerCase() : p);

function installSharedHunch(root: string, git: (...args: string[]) => string): void {
  writeFileSync(join(root, ".git", "hooks", "post-commit"), "#!/bin/sh\n# >>> hunch post-commit >>>\nhunch sync\n# <<< hunch post-commit <<<\n");
  git("config", "merge.hunch.driver", "hunch merge-driver %O %A %B %P");
  git("config", "merge.hunch-grounding.driver", "hunch merge-driver %O %A %B %P");
}

test("uninstall in a linked worktree leaves the clone's shared git hooks and merge drivers to the main checkout (#459)", { timeout: 120_000 }, () => {
  const { base, root, git } = fixture();
  try {
    installSharedHunch(root, git);
    const wt = join(base, "wt");
    git("worktree", "add", "-q", "-b", "feature", wt);
    writeFileSync(join(wt, "CLAUDE.md"), `# My project\n\nMy own rules for agents.\n\n${HUNCH_START}\nhunch text\n${HUNCH_END}\n`);
    const plan = planUninstall(wt);
    const hook = plan.steps.find((s) => norm(s.path).endsWith(".git/hooks/post-commit"));
    const config = plan.steps.find((s) => norm(s.path).endsWith(".git/config"));
    for (const step of [hook, config]) {
      assert.equal(step?.kind, "keep", JSON.stringify(plan.steps));
      assert.ok(norm(step!.note).includes(`run \`hunch uninstall\` from the main checkout (${norm(root)})`), step!.note);
    }
    assert.ok(plan.steps.filter((s) => s.kind === "edit" || s.kind === "delete").every((s) => !isAbsolute(s.path)), "nothing outside the worktree is edited");
    assert.ok(formatUninstallPlan(plan, true).some((l) => l.startsWith("  · kept ") && l.includes("shared by every worktree")));
    assert.deepEqual(applyUninstall(plan).failed, []);
    assert.match(readFileSync(join(root, ".git", "hooks", "post-commit"), "utf8"), /# >>> hunch post-commit >>>/);
    assert.equal(git("config", "--get", "merge.hunch.driver").trim(), "hunch merge-driver %O %A %B %P");
    assert.ok(existsSync(join(wt, OPT_OUT_FILE)) && !existsSync(join(root, OPT_OUT_FILE)));
    assert.equal(readFileSync(join(wt, "CLAUDE.md"), "utf8"), "# My project\n\nMy own rules for agents.\n");
  } finally { cleanupDir(base); }
});

test("uninstall in the main checkout warns that its linked worktrees lose the shared hooks and drivers too (#459)", { timeout: 120_000 }, () => {
  const { base, root, git } = fixture();
  try {
    installSharedHunch(root, git);
    const wt = join(base, "wt");
    git("worktree", "add", "-q", "-b", "feature", wt);
    const plan = planUninstall(root);
    assert.ok(plan.warnings?.some((w) => norm(w).includes(norm(wt)) && w.includes("removed there too")), JSON.stringify(plan.warnings));
    assert.ok(formatUninstallPlan(plan, true).some((l) => l.startsWith("  ⚠ ") && norm(l).includes(norm(wt))));
    assert.equal(plan.steps.find((s) => s.path === ".git/hooks/post-commit")?.kind, "delete");
    assert.deepEqual(applyUninstall(plan).failed, []);
    assert.ok(!existsSync(join(root, ".git", "hooks", "post-commit")));
    assert.equal(spawnSync("git", ["config", "--get", "merge.hunch.driver"], { cwd: root }).status, 1);
  } finally { cleanupDir(base); }
});

test("uninstall off the default branch warns that the marker is only on that branch (#459)", { timeout: 120_000 }, () => {
  const { base, root, git } = fixture();
  try {
    git("update-ref", "refs/remotes/origin/main", "HEAD");
    git("symbolic-ref", "refs/remotes/origin/HEAD", "refs/remotes/origin/main");
    const branchWarnings = () => (planUninstall(root).warnings ?? []).filter((w) => w.includes(OPT_OUT_FILE) && w.includes("only on branch"));
    assert.deepEqual(branchWarnings(), [], "no warning on the default branch");
    git("checkout", "-q", "-b", "feature");
    assert.equal(branchWarnings().length, 1);
    assert.match(branchWarnings()[0]!, /only on branch feature; other branches of this clone still have Hunch/);
    git("symbolic-ref", "refs/remotes/origin/HEAD", "refs/remotes/origin/feature");
    assert.deepEqual(branchWarnings(), [], "origin's HEAD names the default, not a local main");
    git("checkout", "-q", "--detach");
    assert.deepEqual(branchWarnings(), [], "detached HEAD: no branch to name");
  } finally { cleanupDir(base); }
});

test("uninstall in a bare clone's worktree removes the shared hooks and drivers and warns about the other worktrees (#459)", { timeout: 120_000 }, () => {
  const { base, root, env } = fixture();
  const g = (cwd: string, ...args: string[]) => execFileSync("git", args, { cwd, env, encoding: "utf8", stdio: "pipe" });
  try {
    const bare = join(base, "repo.git");
    g(base, "clone", "-q", "--bare", root, bare);
    const wt1 = join(base, "wt1"), wt2 = join(base, "wt2");
    g(bare, "worktree", "add", "-q", wt1, "main");
    g(bare, "worktree", "add", "-q", "-b", "feature", wt2);
    const hook = join(bare, "hooks", "post-commit");
    writeFileSync(hook, "#!/bin/sh\n# >>> hunch post-commit >>>\nhunch sync\n# <<< hunch post-commit <<<\n");
    g(bare, "config", "merge.hunch.driver", "hunch merge-driver %O %A %B %P");
    const plan = planUninstall(wt1);
    assert.ok(plan.steps.every((s) => !s.note.includes("main checkout")), JSON.stringify(plan.steps));
    assert.equal(plan.steps.find((s) => norm(s.path).endsWith("repo.git/hooks/post-commit"))?.kind, "delete", JSON.stringify(plan.steps));
    assert.ok(plan.warnings?.some((w) => norm(w).includes(norm(wt2)) && w.includes("removed there too") && !norm(w).includes(norm(wt1))), JSON.stringify(plan.warnings));
    assert.deepEqual(applyUninstall(plan).failed, []);
    assert.ok(!existsSync(hook));
    assert.equal(spawnSync("git", ["config", "--get", "merge.hunch.driver"], { cwd: bare, env }).status, 1);
  } finally { cleanupDir(base); }
});

test("uninstall in a --separate-git-dir checkout removes its hooks rather than deferring to a main checkout (#459)", { timeout: 120_000 }, () => {
  const { base, env } = fixture();
  const g = (cwd: string, ...args: string[]) => execFileSync("git", args, { cwd, env, encoding: "utf8", stdio: "pipe" });
  try {
    const work = join(base, "sd"), gitDir = join(base, "sep.git");
    g(base, "init", "-q", "-b", "main", "--separate-git-dir", gitDir, work);
    const hook = join(gitDir, "hooks", "post-commit");
    mkdirSync(join(gitDir, "hooks"), { recursive: true });
    writeFileSync(hook, "#!/bin/sh\n# >>> hunch post-commit >>>\nhunch sync\n# <<< hunch post-commit <<<\n");
    g(work, "config", "merge.hunch.driver", "hunch merge-driver %O %A %B %P");
    const plan = planUninstall(work);
    assert.ok(plan.steps.every((s) => !s.note.includes("main checkout")), JSON.stringify(plan.steps));
    assert.equal(plan.steps.find((s) => norm(s.path).endsWith("sep.git/hooks/post-commit"))?.kind, "delete", JSON.stringify(plan.steps));
    assert.deepEqual(applyUninstall(plan).failed, []);
    assert.ok(!existsSync(hook));
    assert.equal(spawnSync("git", ["config", "--get", "merge.hunch.driver"], { cwd: work, env }).status, 1);
  } finally { cleanupDir(base); }
});
