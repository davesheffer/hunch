import { test } from "node:test";
import assert from "node:assert/strict";
import { execFileSync, spawn, spawnSync } from "node:child_process";
import { existsSync, mkdirSync, readFileSync, readdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { cleanupDir, isolatedCliEnv, tempDir } from "./fixtures.js";
import { hunchCliArgs } from "./cli-invocation.js";
import { applyUninstall, OPT_OUT_FILE, type UninstallPlan } from "../src/integrations/uninstall.js";

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
    writeFileSync(join(root, ".cursor", "mcp.json"), "{ not json");
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
    const allowed = new Set(["uninstall", "doctor"]);
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
    assert.deepEqual(applyUninstall(p1), [{ path: ".hunch/", error: "EBUSY: .hunch/" }]);
    assert.deepEqual(ran, [OPT_OUT_FILE, ".hunch/", ".hunch-cache/"], "the remaining steps still ran");
  } finally { cleanupDir(p1.root); }
  ran.length = 0;
  const p2 = plan([step(OPT_OUT_FILE, true), step("CLAUDE.md")]);
  try {
    assert.equal(applyUninstall(p2).length, 1);
    assert.deepEqual(ran, [OPT_OUT_FILE], "nothing is removed without the marker that keeps Hunch out");
  } finally { cleanupDir(p2.root); }
});
