/**
 * Part 2 of the memory home policy (dec_66636a2b1b): the CLI wiring. `hunch private`/
 * `hunch shared`/team auto-wiring persist this machine's repo profile; `hunch init` in a
 * fresh clone restores the overlay from it; `hunch doctor` reports the policy; the new
 * `hunch memory-policy status|check|migrate` command; the CI gate step; and
 * tooling/ship-memory.mjs standing down under the policy.
 *
 * The machine profile lives in the user config dir. Every CLI child here runs with
 * XDG_CONFIG_HOME pointed at a throwaway dir created under the runner's own throwaway
 * dir (tooling/run-tests.mjs), so the developer's real profile is never read or written.
 */
import { after, test } from "node:test";
import assert from "node:assert/strict";
import { execFileSync, spawn, spawnSync } from "node:child_process";
import { chmodSync, existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, isAbsolute, join, resolve } from "node:path";
import { cleanupDir, isolatedCliEnv, tempDir, writeLocalPointer } from "./fixtures.js";
import { hunchCliArgs } from "./cli-invocation.js";
import { HunchStore } from "../src/store/hunchStore.js";
import { hunchPaths } from "../src/core/paths.js";
import { readRepoProfile, repoProfileFile, repoProfileKey, writeRepoProfile } from "../src/core/repoProfile.js";
import { ensureTeamOverlay, readTeamConfig, trustTeamStore, writeTeamConfig } from "../src/integrations/team.js";

const runnerConfig = process.env.XDG_CONFIG_HOME;
const configHome = mkdtempSync(join(runnerConfig && existsSync(runnerConfig) ? runnerConfig : tmpdir(), "hunch-mpc-cfg-"));
const saved = {
  XDG_CONFIG_HOME: process.env.XDG_CONFIG_HOME,
  HUNCH_PRIVATE_DIR: process.env.HUNCH_PRIVATE_DIR,
  HUNCH_TEAM_CLONE_TIMEOUT_MS: process.env.HUNCH_TEAM_CLONE_TIMEOUT_MS,
};
process.env.XDG_CONFIG_HOME = configHome;
delete process.env.HUNCH_PRIVATE_DIR;
after(() => {
  for (const [key, value] of Object.entries(saved)) {
    if (value === undefined) delete process.env[key];
    else process.env[key] = value;
  }
  cleanupDir(configHome);
});

const PKG_VERSION = JSON.parse(readFileSync(join(process.cwd(), "package.json"), "utf8")).version as string;
const NO_OVERLAY_LINE = "memory policy: ⛔ requires an overlay but none is configured — captures are REFUSED (nothing is written public). Fix: hunch private <dir> | hunch shared --repo <url> | HUNCH_PRIVATE_DIR";

/** Same path, whatever the separators or (on Windows) the case. */
function samePath(actual: unknown, expected: string, message?: string): void {
  assert.equal(typeof actual, "string", message ?? `expected a path, got ${JSON.stringify(actual)}`);
  const norm = (p: string) => {
    const r = resolve(p).replace(/[\\/]+$/, "");
    return process.platform === "win32" ? r.toLowerCase() : r;
  };
  assert.equal(norm(actual as string), norm(expected), message);
}

function git(cwd: string, env: NodeJS.ProcessEnv, ...args: string[]): string {
  return execFileSync("git", args, { cwd, encoding: "utf8", env, stdio: ["ignore", "pipe", "pipe"] }).trim();
}

interface Fx { base: string; root: string; env: NodeJS.ProcessEnv }
interface Run { status: number | null; stdout: string; stderr: string; out: string }

let originSeq = 0;
/** A unique network-style origin: the profile key needs a remote that names a repository. */
function origin(label: string): string {
  return `https://example.invalid/acme/mpc-${label}-${process.pid}-${++originSeq}.git`;
}

function fixture(label: string, remote: string | null): Fx {
  const base = tempDir(`hunch-mpc-${label}-`);
  const root = join(base, "repo");
  const home = join(base, "home");
  mkdirSync(root, { recursive: true });
  mkdirSync(home, { recursive: true });
  const env = isolatedCliEnv({
    HOME: home, USERPROFILE: home, APPDATA: join(home, "AppData"), LOCALAPPDATA: join(home, "AppData", "Local"),
    // The file-level throwaway config dir: one machine profile shared by setup and clone.
    XDG_CONFIG_HOME: configHome,
    GIT_CONFIG_NOSYSTEM: "1", GIT_TERMINAL_PROMPT: "0", HUNCH_PRIVATE_DIR: "", HUNCH_SYNC: "1",
    HUNCH_EMBEDDINGS: "off", HUNCH_EMBEDDER: "none", HUNCH_NO_UPDATE_CHECK: "1", NO_COLOR: "1", CI: "1",
    HUNCH_TEAM_CLONE_TIMEOUT_MS: "120000",
  });
  delete env.NODE_TEST_CONTEXT;
  git(root, env, "init", "-q", "-b", "main");
  git(root, env, "config", "user.email", "mpc@example.com");
  git(root, env, "config", "user.name", "Mpc");
  git(root, env, "config", "commit.gpgsign", "false");
  writeFileSync(join(root, "README.md"), "# fixture\n");
  git(root, env, "add", "-A");
  git(root, env, "commit", "-qm", "fixture");
  if (remote) git(root, env, "remote", "add", "origin", remote);
  return { base, root, env };
}

function cli(f: Fx, args: string[], extraEnv: NodeJS.ProcessEnv = {}, cwd = f.root): Run {
  const r = spawnSync(process.execPath, hunchCliArgs(...args), { cwd, encoding: "utf8", env: { ...f.env, ...extraEnv }, timeout: 120_000 });
  if (r.error) throw r.error;
  return { status: r.status, stdout: r.stdout ?? "", stderr: r.stderr ?? "", out: `${r.stdout ?? ""}${r.stderr ?? ""}` };
}

function setPolicy(root: string, memory: unknown): void {
  mkdirSync(join(root, ".hunch"), { recursive: true });
  writeFileSync(join(root, ".hunch", "config.json"), JSON.stringify({ firmness: "advisory", memory }, null, 2) + "\n");
}

function commonDir(root: string, env: NodeJS.ProcessEnv): string {
  const raw = git(root, env, "rev-parse", "--git-common-dir");
  return isAbsolute(raw) ? raw : resolve(root, raw);
}

/** A bare memory remote holding one valid overlay branch. */
function memoryRemote(f: Fx, name = "memory"): string {
  const seed = join(f.base, `${name}-seed`);
  mkdirSync(join(seed, ".hunch", "decisions"), { recursive: true });
  git(seed, f.env, "init", "-q", "-b", "main");
  git(seed, f.env, "config", "user.email", "seed@example.com");
  git(seed, f.env, "config", "user.name", "Seed");
  git(seed, f.env, "config", "commit.gpgsign", "false");
  writeFileSync(join(seed, ".hunch", "manifest.json"), "{\n  \"schema_version\": 2\n}\n");
  writeFileSync(join(seed, ".hunch", "decisions", "dec_mpcseed01.json"), `${JSON.stringify({ id: "dec_mpcseed01", title: "seed" }, null, 2)}\n`);
  git(seed, f.env, "add", "-A");
  git(seed, f.env, "commit", "-qm", "seed memory");
  const remote = join(f.base, `${name}.git`);
  git(f.base, f.env, "clone", "-q", "--bare", seed, remote);
  return remote;
}

const FINDING = (id: string) => ({
  id, title: `finding ${id}`, observation: "observed", evidence: ["probe"], method: null,
  severity: "medium", triage: "open", affected_files: [], affected_symbols: [],
  violates_constraint: null, spawned_decision: null, observed_at: "2026-01-01T00:00:00Z",
  resolved_commit: null, provenance: { source: "human_confirmed", confidence: 1, evidence: [] },
});

const CON = (id: string) => ({
  id, type: "correctness", statement: id, scope: ["src/**"], severity: "warning", enforcement: "advisory_v1",
  rationale: "", source_decision: null, violations: [], status: "active",
  valid_from: "2026-01-01T00:00:00Z", valid_to: null,
  provenance: { source: "human_confirmed", confidence: 1, evidence: [] },
});

function writeRecord(root: string, kind: string, record: { id: string }): string {
  const file = join(root, ".hunch", kind, `${record.id}.json`);
  mkdirSync(join(root, ".hunch", kind), { recursive: true });
  writeFileSync(file, `${JSON.stringify(record, null, 2)}\n`);
  return file;
}

function profileEntryRaw(root: string): unknown {
  if (!existsSync(repoProfileFile())) return undefined;
  const parsed = JSON.parse(readFileSync(repoProfileFile(), "utf8")) as { repos?: Record<string, unknown> };
  return parsed.repos?.[repoProfileKey(root)];
}

/** Open a store with HUNCH_PRIVATE_DIR set only for the constructor. */
function open(root: string, overlay?: string): HunchStore {
  if (overlay) process.env.HUNCH_PRIVATE_DIR = overlay;
  try { return new HunchStore(hunchPaths(root)); } finally { delete process.env.HUNCH_PRIVATE_DIR; }
}

// ---------------------------------------------------------------- §6 persist the profile

test("§6 hunch private <dir> records this machine's repo profile beside machine.json, keyed by origin", () => {
  assert.ok(repoProfileFile().startsWith(configHome), "the profile resolves inside this file's throwaway config dir");
  if (runnerConfig) assert.ok(configHome.startsWith(runnerConfig), "…which itself lives under the runner's throwaway XDG_CONFIG_HOME");
  const f = fixture("prof-private", origin("prof-private"));
  try {
    assert.equal(f.env.XDG_CONFIG_HOME, configHome, "the CLI child inherits the isolated config dir");
    const overlay = join(f.base, "overlay", ".hunch");
    mkdirSync(join(f.base, "overlay"), { recursive: true });
    const r = cli(f, ["private", overlay, "--no-hook", "--no-auto-commit"]);
    assert.equal(r.status, 0, r.out);
    assert.ok(profileEntryRaw(f.root), `hunch private wrote no repo-profiles.json entry for ${repoProfileKey(f.root)}:\n${r.out}`);
    const entry = readRepoProfile(f.root);
    assert.ok(entry);
    samePath(entry.privateDir, overlay, "the profile records the absolute overlay .hunch dir");
    assert.equal(entry.mode, "private");
    assert.equal(entry.autoCommit, false);
  } finally { cleanupDir(f.base); }
});

test("§6 hunch shared <dir> records the profile with mode shared and the auto-commit setting", () => {
  const f = fixture("prof-shared", origin("prof-shared"));
  try {
    const overlay = join(f.base, "shared", ".hunch");
    mkdirSync(join(f.base, "shared"), { recursive: true });
    const r = cli(f, ["shared", overlay, "--no-hook"]);
    assert.equal(r.status, 0, r.out);
    assert.ok(profileEntryRaw(f.root), `hunch shared wrote no repo-profiles.json entry:\n${r.out}`);
    const entry = readRepoProfile(f.root)!;
    samePath(entry.privateDir, overlay);
    assert.equal(entry.mode, "shared");
    assert.equal(entry.autoCommit, true, "auto-commit defaults ON");
  } finally { cleanupDir(f.base); }
});

test("§6 team auto-wiring (ensureTeamOverlay) records the profile with mode shared", () => {
  const f = fixture("prof-team", origin("prof-team"));
  const prevTimeout = process.env.HUNCH_TEAM_CLONE_TIMEOUT_MS;
  try {
    const remote = memoryRemote(f);
    mkdirSync(join(f.root, ".hunch"), { recursive: true });
    writeTeamConfig(f.root, { shared_repo: remote, shared_ref: "refs/heads/main" });
    git(f.root, f.env, "add", "-A");
    git(f.root, f.env, "commit", "-qm", "advertise shared memory");
    trustTeamStore(f.root, readTeamConfig(f.root)!);
    process.env.HUNCH_TEAM_CLONE_TIMEOUT_MS = "120000";
    const wired = ensureTeamOverlay(f.root);
    assert.ok(wired, "the trusted team store wires");
    assert.ok(profileEntryRaw(f.root), "ensureTeamOverlay wired the store but wrote no repo-profiles.json entry");
    const entry = readRepoProfile(f.root)!;
    samePath(entry.privateDir, wired);
    assert.equal(entry.mode, "shared");
  } finally {
    if (prevTimeout === undefined) delete process.env.HUNCH_TEAM_CLONE_TIMEOUT_MS;
    else process.env.HUNCH_TEAM_CLONE_TIMEOUT_MS = prevTimeout;
    cleanupDir(f.base);
  }
});

test("§6 a fresh --repo setup that fails after the pointer write leaves no profile; the same setup succeeding writes one", () => {
  const failing = fixture("prof-rollback", origin("prof-rollback"));
  const control = fixture("prof-control", origin("prof-control"));
  try {
    const remote = memoryRemote(failing);
    // Injected failure AFTER the shared pointer write (configureOverlay step 5), inside
    // the beginFreshOverlaySetup transaction whose rollback must also drop the profile.
    const failed = cli(failing, ["private", "--repo", remote, "--migrate", "--no-hook"], { HUNCH_TEST_FAIL_OVERLAY_MIGRATION_AFTER_PUBLIC_DROP: "1" });
    assert.notEqual(failed.status, 0, failed.out);
    assert.match(failed.out, /injected late overlay migration failure/);
    assert.equal(profileEntryRaw(failing.root), undefined, "a failed setup leaves no repo profile entry behind");
    assert.equal(readRepoProfile(failing.root), null);

    // Positive control: without the injected failure the same command persists the profile,
    // so the assertion above is about rollback, not about a profile that is never written.
    const controlRemote = memoryRemote(control);
    const ok = cli(control, ["private", "--repo", controlRemote, "--no-hook"]);
    assert.equal(ok.status, 0, ok.out);
    assert.ok(profileEntryRaw(control.root), `a successful --repo setup wrote no repo-profiles.json entry:\n${ok.out}`);
    samePath(readRepoProfile(control.root)!.privateDir, join(control.root, ".hunch-private", ".hunch"));
    assert.equal(readRepoProfile(control.root)!.mode, "private");
  } finally {
    cleanupDir(failing.base);
    cleanupDir(control.base);
  }
});

// ---------------------------------------------------------------- §7 restore on init

test("§7 a fresh clone + hunch init restores local.json, the common-dir registration and the private hooks; a second init changes nothing", () => {
  const url = origin("restore");
  const first = fixture("restore-a", url);
  const clone = fixture("restore-b", url);
  try {
    const overlay = join(first.base, "overlay", ".hunch");
    mkdirSync(overlay, { recursive: true });
    assert.equal(writeRepoProfile(first.root, { privateDir: overlay, mode: "private", autoCommit: true }), true);
    samePath(readRepoProfile(clone.root)?.privateDir, overlay, "precondition: the clone resolves the profile (part 1)");
    assert.equal(existsSync(join(clone.root, ".hunch", "local.json")), false);

    const initArgs = ["init", "--no-index", "--no-providers", "--no-agent-hooks", "--no-enforce"];
    const r = cli(clone, initArgs);
    assert.equal(r.status, 0, r.out);
    const restored = /memory: restored overlay (.+) \(private\) from this machine's profile/.exec(r.out);
    assert.ok(restored, `init printed no "memory: restored overlay … from this machine's profile" line:\n${r.out}`);
    samePath(restored[1], overlay);

    const localFile = join(clone.root, ".hunch", "local.json");
    assert.ok(existsSync(localFile), "init wrote no .hunch/local.json");
    const local = JSON.parse(readFileSync(localFile, "utf8"));
    samePath(local.privateDir, overlay);
    assert.equal(local.autoCommit, true);
    assert.equal(local.mode, "private");

    const registration = join(commonDir(clone.root, clone.env), "hunch", "local.json");
    assert.ok(existsSync(registration), "init registered nothing in the git common dir");
    samePath(JSON.parse(readFileSync(registration, "utf8")).privateDir, overlay);

    const hooks = join(clone.root, ".git", "hooks");
    const postCommit = readFileSync(join(hooks, "post-commit"), "utf8");
    const block = /# >>> hunch post-commit >>>[\s\S]*?# <<< hunch post-commit <<</.exec(postCommit)?.[0] ?? "";
    assert.match(block, /sync --from-hook --quiet --private/, `the post-commit hook does not route to the overlay:\n${block}`);
    assert.ok(block.includes("export HUNCH_SYNTH_PROVIDER=deterministic"), "a private-mode overlay hook is local-only");
    assert.ok(existsSync(join(hooks, "post-merge")), "post-merge hook installed");
    assert.ok(existsSync(join(hooks, "post-checkout")), "post-checkout hook installed");

    const files = [localFile, registration, join(hooks, "post-commit"), join(hooks, "post-merge"), join(hooks, "post-checkout")];
    const before = files.map((file) => readFileSync(file, "utf8"));
    const again = cli(clone, initArgs);
    assert.equal(again.status, 0, again.out);
    assert.deepEqual(files.map((file) => readFileSync(file, "utf8")), before, "a second init rewrites nothing");
    assert.doesNotMatch(again.out, /restored overlay/, "the second init resolves the persisted local config, not the profile");
  } finally {
    cleanupDir(first.base);
    cleanupDir(clone.base);
  }
});

// ---------------------------------------------------------------- §8 doctor

test("§8 doctor: policy home=overlay with no overlay prints the policy and the ⛔ refusal line and exits 1", () => {
  const f = fixture("doctor-noov", null);
  try {
    const control = cli(f, ["doctor"]);
    assert.equal(control.status, 0, `control: doctor must pass on this fixture without a policy:\n${control.out}`);
    assert.doesNotMatch(control.out, /memory policy:/, "no policy → no policy line");

    setPolicy(f.root, { home: "overlay" });
    const r = cli(f, ["doctor"]);
    const line = /memory policy: home=overlay; public kinds: ([^\n]+)/.exec(r.out);
    assert.ok(line, `doctor printed no "memory policy: home=overlay; public kinds: …" line:\n${r.out}`);
    for (const kind of ["constraints", "components"]) assert.ok(line[1].includes(kind), `public kinds list names ${kind}: ${line[1]}`);
    assert.ok(r.out.includes(NO_OVERLAY_LINE), `doctor printed no ⛔ no-overlay line:\n${r.out}`);
    assert.equal(r.status, 1, "a policy that refuses every capture fails doctor");
  } finally { cleanupDir(f.base); }
});

test("§8 doctor: policy with an overlay prints the policy line and passes; home=repo prints home=repo", () => {
  const f = fixture("doctor-ov", null);
  try {
    const overlay = join(f.base, "overlay", ".hunch");
    mkdirSync(overlay, { recursive: true });
    setPolicy(f.root, { home: "overlay", public_kinds: ["constraints", "components", "tasks"] });
    const r = cli(f, ["doctor"], { HUNCH_PRIVATE_DIR: overlay });
    const line = /memory policy: home=overlay; public kinds: ([^\n]+)/.exec(r.out);
    assert.ok(line, `doctor printed no policy line:\n${r.out}`);
    assert.ok(line[1].includes("tasks"), `a listed kind is reported: ${line[1]}`);
    assert.ok(!r.out.includes("requires an overlay but none is configured"), r.out);
    assert.equal(r.status, 0, r.out);

    setPolicy(f.root, { home: "repo" });
    const repoHome = cli(f, ["doctor"]);
    assert.match(repoHome.out, /memory policy: home=repo/, `doctor printed no home=repo policy line:\n${repoHome.out}`);
    assert.equal(repoHome.status, 0, repoHome.out);
  } finally { cleanupDir(f.base); }
});

test("§8 doctor: an overlay resolved from the machine profile says so; a checkout pointer that disagrees is drift", () => {
  const url = origin("doctor-profile");
  const f = fixture("doctor-profile", url);
  try {
    const overlay = join(f.base, "overlay", ".hunch");
    const other = join(f.base, "other", ".hunch");
    mkdirSync(overlay, { recursive: true });
    mkdirSync(other, { recursive: true });
    assert.equal(writeRepoProfile(f.root, { privateDir: overlay, mode: "private", autoCommit: true }), true);

    const r = cli(f, ["doctor"]);
    const source = /overlay: from this machine's profile → (.+?); run hunch init to persist it in this checkout/.exec(r.out);
    assert.ok(source, `doctor printed no machine-profile source line:\n${r.out}`);
    samePath(source[1], overlay);

    writeLocalPointer(f.root, { privateDir: other, mode: "private" });
    const drifted = cli(f, ["doctor"]);
    const drift = /memory profile drift: checkout uses (.+?), machine profile says (.+?); re-run hunch private\/shared to update/.exec(drifted.out);
    assert.ok(drift, `doctor printed no profile drift warning:\n${drifted.out}`);
    samePath(drift[1], other);
    samePath(drift[2], overlay);
  } finally { cleanupDir(f.base); }
});

test("§8 doctor: a policy min_version newer than this Hunch is a ⛔ line and exit 1", () => {
  const f = fixture("doctor-minver", null);
  try {
    const overlay = join(f.base, "overlay", ".hunch");
    mkdirSync(overlay, { recursive: true });
    setPolicy(f.root, { home: "overlay", min_version: "99.0.0" });
    const r = cli(f, ["doctor"], { HUNCH_PRIVATE_DIR: overlay });
    assert.match(r.out, /⛔[^\n]*99\.0\.0/, `doctor printed no ⛔ line naming min_version 99.0.0:\n${r.out}`);
    assert.equal(r.status, 1);

    // Control: the same fixture with min_version equal to the running version passes.
    setPolicy(f.root, { home: "overlay", min_version: PKG_VERSION });
    const current = cli(f, ["doctor"], { HUNCH_PRIVATE_DIR: overlay });
    assert.match(current.out, /memory policy: home=overlay/, `control: the policy line is printed:\n${current.out}`);
    assert.doesNotMatch(current.out, /⛔/, current.out);
    assert.equal(current.status, 0, `control: min_version equal to the running version passes:\n${current.out}`);
  } finally { cleanupDir(f.base); }
});

// ---------------------------------------------------------------- §9 memory-policy

test("§9 memory-policy status prints the policy, the overlay dir and its source, and the profile entry", () => {
  const f = fixture("mp-status", origin("mp-status"));
  try {
    const overlay = join(f.base, "overlay", ".hunch");
    mkdirSync(overlay, { recursive: true });
    setPolicy(f.root, { home: "overlay" });
    writeRepoProfile(f.root, { privateDir: overlay, mode: "shared", autoCommit: false });
    const r = cli(f, ["memory-policy", "status"]);
    assert.equal(r.status, 0, r.out);
    assert.match(r.out, /home=overlay/, r.out);
    assert.match(r.out, /machine-profile/, "the overlay source is named");
    assert.ok(r.out.includes(resolve(overlay)) || r.out.toLowerCase().includes(resolve(overlay).toLowerCase()), `the overlay dir is printed:\n${r.out}`);
  } finally { cleanupDir(f.base); }
});

test("§9 memory-policy check: no policy or home=repo is a pass with 'no overlay memory policy'", () => {
  const f = fixture("mp-check-none", null);
  try {
    git(f.root, f.env, "checkout", "-q", "-b", "feature");
    writeRecord(f.root, "findings", FINDING("fnd_mpcnone01"));
    git(f.root, f.env, "add", "-A");
    git(f.root, f.env, "commit", "-qm", "add a finding");
    const none = cli(f, ["memory-policy", "check", "--base", "main"]);
    assert.match(none.out, /no overlay memory policy/, none.out);
    assert.equal(none.status, 0, none.out);

    setPolicy(f.root, { home: "repo" });
    const repoHome = cli(f, ["memory-policy", "check", "--base", "main"]);
    assert.match(repoHome.out, /no overlay memory policy/, repoHome.out);
    assert.equal(repoHome.status, 0, repoHome.out);
  } finally { cleanupDir(f.base); }
});

test("§9 memory-policy check: an added or modified overlay-homed record fails; added constraints and deletions pass", () => {
  const f = fixture("mp-check", null);
  try {
    setPolicy(f.root, { home: "overlay" });
    writeRecord(f.root, "findings", FINDING("fnd_mpcold01"));
    git(f.root, f.env, "add", "-A");
    git(f.root, f.env, "commit", "-qm", "policy + a legacy public finding");
    const check = () => cli(f, ["memory-policy", "check", "--base", "main"]);

    git(f.root, f.env, "checkout", "-q", "-b", "add-finding", "main");
    mkdirSync(join(f.root, ".hunch", "findings"), { recursive: true });
    writeFileSync(join(f.root, ".hunch", "findings", "x.json"), `${JSON.stringify(FINDING("x"), null, 2)}\n`);
    writeRecord(f.root, "constraints", CON("con_mpcadd01"));
    git(f.root, f.env, "add", "-A");
    git(f.root, f.env, "commit", "-qm", "add a public finding and a constraint");
    const added = check();
    assert.ok(added.out.includes(".hunch/findings/x.json"), `check did not list the added finding:\n${added.out}`);
    assert.ok(!added.out.includes(".hunch/constraints/con_mpcadd01.json"), "a public kind is not listed");
    assert.equal(added.status, 1, added.out);

    git(f.root, f.env, "checkout", "-q", "-b", "modify-finding", "main");
    writeRecord(f.root, "findings", { ...FINDING("fnd_mpcold01"), title: "edited" });
    git(f.root, f.env, "commit", "-qam", "modify the legacy finding");
    const modified = check();
    assert.ok(modified.out.includes(".hunch/findings/fnd_mpcold01.json"), `check did not list the modified finding:\n${modified.out}`);
    assert.equal(modified.status, 1, modified.out);

    git(f.root, f.env, "checkout", "-q", "-b", "add-constraint", "main");
    writeRecord(f.root, "constraints", CON("con_mpcadd02"));
    git(f.root, f.env, "add", "-A");
    git(f.root, f.env, "commit", "-qm", "add a constraint");
    const constraint = check();
    assert.equal(constraint.status, 0, `an added constraint is allowed:\n${constraint.out}`);
    assert.doesNotMatch(constraint.out, /Unknown command|unknown command|error:/i, constraint.out);

    git(f.root, f.env, "checkout", "-q", "-b", "delete-finding", "main");
    git(f.root, f.env, "rm", "-q", join(".hunch", "findings", "fnd_mpcold01.json"));
    git(f.root, f.env, "commit", "-qm", "delete the legacy finding");
    const deleted = check();
    assert.equal(deleted.status, 0, `a deletion is allowed:\n${deleted.out}`);
    assert.doesNotMatch(deleted.out, /Unknown command|unknown command|error:/i, deleted.out);
  } finally { cleanupDir(f.base); }
});

test("§9 memory-policy check: a branch that drops the base's overlay policy is still judged by it", () => {
  const f = fixture("mp-check-drop", null);
  try {
    setPolicy(f.root, { home: "overlay" });
    git(f.root, f.env, "add", "-A");
    git(f.root, f.env, "commit", "-qm", "overlay policy");
    git(f.root, f.env, "checkout", "-q", "-b", "drop-policy", "main");
    setPolicy(f.root, { home: "repo" });
    writeRecord(f.root, "findings", FINDING("fnd_mpcdrop01"));
    git(f.root, f.env, "add", "-A");
    git(f.root, f.env, "commit", "-qm", "drop the policy and add a public finding");
    const r = cli(f, ["memory-policy", "check", "--base", "main"]);
    assert.ok(r.out.includes(".hunch/findings/fnd_mpcdrop01.json"), `check did not list the finding:\n${r.out}`);
    assert.equal(r.status, 1, r.out);
  } finally { cleanupDir(f.base); }
});

test("§9 memory-policy check: a base with no merge base fails closed instead of passing an empty diff", () => {
  const f = fixture("mp-check-orphan", null);
  try {
    setPolicy(f.root, { home: "overlay" });
    git(f.root, f.env, "add", "-A");
    git(f.root, f.env, "commit", "-qm", "overlay policy");
    git(f.root, f.env, "checkout", "-q", "--orphan", "unrelated");
    git(f.root, f.env, "rm", "-rqf", ".");
    setPolicy(f.root, { home: "overlay" });
    writeRecord(f.root, "findings", FINDING("fnd_mpcorph01"));
    git(f.root, f.env, "add", "-A");
    git(f.root, f.env, "commit", "-qm", "unrelated history");
    const r = cli(f, ["memory-policy", "check", "--base", "main"]);
    assert.notEqual(r.status, 0, `an undiffable range must not pass:\n${r.out}`);
    assert.doesNotMatch(r.out, /✓ memory policy/, r.out);
  } finally { cleanupDir(f.base); }
});

test("§9 memory-policy check: a missing base ref fails closed even when the head has no policy", () => {
  const f = fixture("mp-check-nobase", null);
  try {
    git(f.root, f.env, "checkout", "-q", "-b", "feature");
    setPolicy(f.root, { home: "repo" });
    writeRecord(f.root, "findings", FINDING("fnd_mpcnobase1"));
    git(f.root, f.env, "add", "-A");
    git(f.root, f.env, "commit", "-qm", "home=repo and a public finding");
    const r = cli(f, ["memory-policy", "check", "--base", "origin/main"]);
    assert.match(r.out, /not found/, `an unfetched base must be named:\n${r.out}`);
    assert.doesNotMatch(r.out, /no overlay memory policy/, r.out);
    assert.equal(r.status, 1, r.out);
  } finally { cleanupDir(f.base); }
});

test("§9 memory-policy check: a base config with a BOM still carries its policy", () => {
  const f = fixture("mp-check-bom", null);
  try {
    mkdirSync(join(f.root, ".hunch"), { recursive: true });
    writeFileSync(join(f.root, ".hunch", "config.json"), `\uFEFF${JSON.stringify({ firmness: "advisory", memory: { home: "overlay" } }, null, 2)}\n`);
    git(f.root, f.env, "add", "-A");
    git(f.root, f.env, "commit", "-qm", "BOM'd overlay policy");
    git(f.root, f.env, "checkout", "-q", "-b", "drop-policy", "main");
    setPolicy(f.root, { home: "repo" });
    writeRecord(f.root, "findings", FINDING("fnd_mpcbom01"));
    git(f.root, f.env, "add", "-A");
    git(f.root, f.env, "commit", "-qm", "drop the policy and add a public finding");
    const r = cli(f, ["memory-policy", "check", "--base", "main"]);
    assert.ok(r.out.includes(".hunch/findings/fnd_mpcbom01.json"), `the base's BOM'd policy was ignored:\n${r.out}`);
    assert.equal(r.status, 1, r.out);
  } finally { cleanupDir(f.base); }
});

test("§9 memory-policy check: the public state ledger under .hunch/changes is overlay-homed", () => {
  const f = fixture("mp-check-ledger", null);
  try {
    setPolicy(f.root, { home: "overlay" });
    git(f.root, f.env, "add", "-A");
    git(f.root, f.env, "commit", "-qm", "overlay policy");
    git(f.root, f.env, "checkout", "-q", "-b", "ledger", "main");
    mkdirSync(join(f.root, ".hunch", "changes"), { recursive: true });
    writeFileSync(join(f.root, ".hunch", "changes", "repository.json"), "{\n  \"events\": []\n}\n");
    git(f.root, f.env, "add", "-A");
    git(f.root, f.env, "commit", "-qm", "a public state ledger");
    const r = cli(f, ["memory-policy", "check", "--base", "main"]);
    assert.ok(r.out.includes(".hunch/changes/repository.json"), `the ledger was not listed:\n${r.out}`);
    assert.equal(r.status, 1, r.out);
  } finally { cleanupDir(f.base); }
});

function migrateFixture(label: string): { f: Fx; overlay: string; finding: string; constraint: string } {
  const f = fixture(label, null);
  const overlay = join(f.base, "overlay", ".hunch");
  mkdirSync(overlay, { recursive: true });
  const finding = writeRecord(f.root, "findings", FINDING("fnd_mpcmove01"));
  const constraint = writeRecord(f.root, "constraints", CON("con_mpckeep01"));
  setPolicy(f.root, { home: "overlay" });
  git(f.root, f.env, "add", "-A");
  git(f.root, f.env, "commit", "-qm", "legacy public memory under a new policy");
  return { f, overlay, finding, constraint };
}

function overlayFiles(overlay: string): string[] {
  return existsSync(overlay) ? readdirSync(overlay, { recursive: true }).map(String).filter((p) => p.endsWith(".json")) : [];
}

test("§9 memory-policy migrate moves a public finding into the overlay, deletes the public file, keeps constraints, commits nothing", () => {
  const { f, overlay, finding, constraint } = migrateFixture("mp-migrate");
  try {
    const head = git(f.root, f.env, "rev-parse", "HEAD");
    const r = cli(f, ["memory-policy", "migrate"], { HUNCH_PRIVATE_DIR: overlay });
    assert.equal(r.status, 0, r.out);
    assert.match(r.out, /fnd_mpcmove01/, "each moved id is printed");
    assert.equal(existsSync(finding), false, "the public finding file is deleted");
    assert.equal(existsSync(constraint), true, "a public-kind record stays public");
    const store = open(f.root, overlay);
    try {
      assert.equal(store.getPrivateRec("findings", "fnd_mpcmove01")?.id, "fnd_mpcmove01", "the finding now lives in the overlay");
      assert.equal(store.getPrivateRec("constraints", "con_mpckeep01"), undefined, "the constraint was not moved");
    } finally { store.close(); }
    assert.equal(git(f.root, f.env, "rev-parse", "HEAD"), head, "migrate never commits");
  } finally { cleanupDir(f.base); }
});

test("§9 memory-policy migrate --dry-run lists the move and writes nothing", () => {
  const { f, overlay, finding, constraint } = migrateFixture("mp-dry");
  try {
    const before = readFileSync(finding, "utf8");
    const r = cli(f, ["memory-policy", "migrate", "--dry-run"], { HUNCH_PRIVATE_DIR: overlay });
    assert.equal(r.status, 0, r.out);
    assert.match(r.out, /fnd_mpcmove01/, "the dry run lists what would move");
    assert.equal(readFileSync(finding, "utf8"), before, "the public finding is untouched");
    assert.equal(existsSync(constraint), true);
    assert.deepEqual(overlayFiles(overlay).filter((p) => p.includes("fnd_mpcmove01")), [], "nothing is written to the overlay");
    assert.equal(git(f.root, f.env, "status", "--porcelain"), "", "the working tree is unchanged");
  } finally { cleanupDir(f.base); }
});

test("§9 memory-policy migrate without an overlay is Refused, exit 1, and moves nothing", () => {
  const { f, finding } = migrateFixture("mp-noov");
  try {
    const r = cli(f, ["memory-policy", "migrate"]);
    assert.match(r.out, /Refused/, `migrate without an overlay did not refuse:\n${r.out}`);
    assert.doesNotMatch(r.out, /unknown command/i, r.out);
    assert.equal(r.status, 1, r.out);
    assert.equal(existsSync(finding), true, "the public finding is kept");
  } finally { cleanupDir(f.base); }
});

test("§9 memory-policy migrate keeps both copies and fails when the overlay holds a different version of the id", () => {
  const { f, overlay, finding } = migrateFixture("mp-conflict");
  try {
    mkdirSync(join(overlay, "findings"), { recursive: true });
    const overlayCopy = join(overlay, "findings", "fnd_mpcmove01.json");
    writeFileSync(overlayCopy, `${JSON.stringify({ ...FINDING("fnd_mpcmove01"), title: "older overlay copy" }, null, 2)}\n`);
    const overlayBefore = readFileSync(overlayCopy, "utf8");
    const r = cli(f, ["memory-policy", "migrate"], { HUNCH_PRIVATE_DIR: overlay });
    assert.match(r.out, /conflict.*fnd_mpcmove01|fnd_mpcmove01.*conflict/i, `the conflict is named:\n${r.out}`);
    assert.equal(r.status, 1, r.out);
    assert.equal(existsSync(finding), true, "the public copy is kept");
    assert.equal(readFileSync(overlayCopy, "utf8"), overlayBefore, "the overlay copy is untouched");
  } finally { cleanupDir(f.base); }
});

test("§9 memory-policy migrate treats an overlay file the loader skipped as a conflict, never overwriting it", () => {
  for (const [label, body] of [
    ["mp-invalid", `${JSON.stringify({ ...FINDING("fnd_mpcmove01"), severity: "not-a-valid-severity" }, null, 2)}\n`],
    ["mp-corrupt", "{ not json"],
    ["mp-tombstone", ""],
  ] as const) {
    const { f, overlay, finding } = migrateFixture(label);
    try {
      mkdirSync(join(overlay, "findings"), { recursive: true });
      const overlayCopy = join(overlay, "findings", "fnd_mpcmove01.json");
      writeFileSync(overlayCopy, body);
      const r = cli(f, ["memory-policy", "migrate"], { HUNCH_PRIVATE_DIR: overlay });
      assert.match(r.out, /conflict.*fnd_mpcmove01|fnd_mpcmove01.*conflict/i, `${label}: the conflict is named:\n${r.out}`);
      assert.equal(r.status, 1, `${label}: ${r.out}`);
      assert.equal(existsSync(finding), true, `${label}: the public copy is kept`);
      assert.equal(readFileSync(overlayCopy, "utf8"), body, `${label}: the overlay file is untouched`);
    } finally { cleanupDir(f.base); }
  }
});

test("§9 memory-policy migrate fails when a misnamed public copy of a moved record remains", () => {
  for (const [label, strayOnly] of [["mp-stray-only", true], ["mp-stray-beside", false]] as const) {
    const { f, overlay, finding } = migrateFixture(label);
    try {
      const stray = join(f.root, ".hunch", "findings", strayOnly ? "fnd_mpcmove01.orig.json" : "fnd_mpcmove01_BASE_1.json");
      writeFileSync(stray, readFileSync(finding, "utf8"));
      if (strayOnly) git(f.root, f.env, "rm", "-q", join(".hunch", "findings", "fnd_mpcmove01.json"));
      for (const pass of [1, 2]) {
        const r = cli(f, ["memory-policy", "migrate"], { HUNCH_PRIVATE_DIR: overlay });
        assert.match(r.out, /leftover.*fnd_mpcmove01|fnd_mpcmove01.*leftover/i, `${label} pass ${pass}: the remaining public copy is named:\n${r.out}`);
        assert.equal(r.status, 1, `${label} pass ${pass}: ${r.out}`);
      }
      assert.equal(existsSync(stray), true, `${label}: a misnamed copy is never deleted unseen`);
    } finally { cleanupDir(f.base); }
  }
});

test("§9 memory-policy migrate --dry-run reports a record held only by a misnamed public file as a leftover", () => {
  const { f, overlay, finding } = migrateFixture("mp-dry-stray");
  try {
    const stray = join(f.root, ".hunch", "findings", "fnd_mpcmove01.orig.json");
    writeFileSync(stray, readFileSync(finding, "utf8"));
    git(f.root, f.env, "rm", "-q", join(".hunch", "findings", "fnd_mpcmove01.json"));
    const r = cli(f, ["memory-policy", "migrate", "--dry-run"], { HUNCH_PRIVATE_DIR: overlay });
    assert.match(r.out, /leftover.*fnd_mpcmove01|fnd_mpcmove01.*leftover/i, `the dry run predicts the leftover:\n${r.out}`);
    assert.doesNotMatch(r.out, /would move findings fnd_mpcmove01/, r.out);
    assert.equal(r.status, 1, r.out);
    assert.deepEqual(overlayFiles(overlay).filter((p) => p.includes("fnd_mpcmove01")), [], "nothing is written to the overlay");
    assert.equal(existsSync(stray), true);
  } finally { cleanupDir(f.base); }
});

test("§9 memory-policy migrate reads each kind once after moving, not once per moved record", () => {
  const { f, overlay, finding } = migrateFixture("mp-reload");
  try {
    writeFileSync(join(f.root, ".hunch", "findings", "fnd_mpcmove01_BASE_1.json"), readFileSync(finding, "utf8"));
    for (const id of ["fnd_mpcmove02", "fnd_mpcmove03", "fnd_mpcmove04"]) writeRecord(f.root, "findings", FINDING(id));
    const r = cli(f, ["memory-policy", "migrate"], { HUNCH_PRIVATE_DIR: overlay });
    assert.equal(r.status, 1, r.out);
    const warnings = r.out.split("\n").filter((line) => line.includes("fnd_mpcmove01_BASE_1.json"));
    assert.ok(warnings.length <= 2, `the stray copy is warned about once per read of the kind, not per moved record (${warnings.length}):\n${r.out}`);
    for (const id of ["fnd_mpcmove02", "fnd_mpcmove03", "fnd_mpcmove04"]) assert.match(r.out, new RegExp(`moved findings ${id}`), r.out);
    assert.match(r.out, /leftover.*fnd_mpcmove01/, r.out);
  } finally { cleanupDir(f.base); }
});

test("§9 memory-policy migrate reports an id no file name can hold as an unsafe-id conflict and never throws", () => {
  for (const [label, overlayCopy] of [["mp-unsafe", false], ["mp-unsafe-dup", true]] as const) {
    const { f, overlay } = migrateFixture(label);
    try {
      const body = `${JSON.stringify(FINDING("fnd bad id"), null, 2)}\n`;
      const publicFile = join(f.root, ".hunch", "findings", "odd.json");
      writeFileSync(publicFile, body);
      if (overlayCopy) {
        mkdirSync(join(overlay, "findings"), { recursive: true });
        writeFileSync(join(overlay, "findings", "odd.json"), body);
      }
      const r = cli(f, ["memory-policy", "migrate"], { HUNCH_PRIVATE_DIR: overlay });
      assert.match(r.out, /conflict: findings fnd bad id .*unsafe/i, `${label}: the unsafe id is named as such:\n${r.out}`);
      assert.doesNotMatch(r.out, /loader could not read|refusing unsafe JSON record id|\n\s+at /, `${label}: no misleading message or stack trace:\n${r.out}`);
      assert.equal(r.status, 1, `${label}: ${r.out}`);
      assert.equal(existsSync(publicFile), true, `${label}: the public copy is kept`);
      assert.match(r.out, /moved findings fnd_mpcmove01/, `${label}: other records still move:\n${r.out}`);
    } finally { cleanupDir(f.base); }
  }
});

test("§9 memory-policy migrate reports a record it could not delete as a conflict and still reports every move and the summary", (t) => {
  if (process.getuid?.() === 0) return t.skip("root ignores file permissions");
  const { f, overlay } = migrateFixture("mp-undeletable");
  const dir = join(f.root, ".hunch", "findings");
  const locked = writeRecord(f.root, "findings", FINDING("fnd_mpcmove02"));
  writeRecord(f.root, "findings", FINDING("fnd_mpcmove03"));
  const win = process.platform === "win32";
  let holder: ReturnType<typeof spawn> | undefined;
  try {
    if (win) {
      // Node opens files with delete sharing, so hold this one from PowerShell: readable, not deletable.
      const ready = join(f.base, "lock-ready");
      holder = spawn("powershell.exe", ["-NoProfile", "-Command",
        `$s=[IO.File]::Open('${locked}','Open','Read','Read'); New-Item -ItemType File '${ready}' | Out-Null; Start-Sleep 120`], { stdio: "ignore" });
      const deadline = Date.now() + 30_000;
      while (!existsSync(ready)) {
        if (Date.now() > deadline) throw new Error("the lock holder never became ready");
        Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, 50);
      }
    } else {
      chmodSync(dir, 0o555);
    }
    const r = cli(f, ["memory-policy", "migrate"], { HUNCH_PRIVATE_DIR: overlay });
    if (win) {
      assert.match(r.out, /conflict: findings fnd_mpcmove02 could not be moved/, `the failed record is named:\n${r.out}`);
      for (const id of ["fnd_mpcmove01", "fnd_mpcmove03"]) assert.match(r.out, new RegExp(`moved findings ${id}`), `moves before and after the failure are reported:\n${r.out}`);
    } else {
      // Every delete in the read-only directory fails: each record is a conflict, none moved.
      for (const id of ["fnd_mpcmove01", "fnd_mpcmove02", "fnd_mpcmove03"]) assert.match(r.out, new RegExp(`conflict: findings ${id} could not be moved`), r.out);
    }
    assert.match(r.out, /record\(s\) moved to/, `the summary still prints:\n${r.out}`);
    assert.equal(r.status, 1, r.out);
    assert.equal(existsSync(locked), true, "the record that could not be deleted is kept");
  } finally {
    holder?.kill();
    if (!win) chmodSync(dir, 0o755);
    cleanupDir(f.base);
  }
});

test("§9 memory-policy migrate fails while a public file the loader skipped remains, in the dry run too", () => {
  for (const [label, dryRun, setup] of [
    ["mp-skip-corrupt", false, (dir: string) => writeFileSync(join(dir, "fnd_mpcbad01.json"), "{ not json")],
    ["mp-skip-corrupt-dry", true, (dir: string) => writeFileSync(join(dir, "fnd_mpcbad01.json"), "{ not json")],
    ["mp-skip-stray-dry", true, (dir: string) => writeFileSync(join(dir, "fnd_mpcmove01_BASE_1.json"), readFileSync(join(dir, "fnd_mpcmove01.json"), "utf8"))],
  ] as const) {
    const { f, overlay } = migrateFixture(label);
    try {
      const dir = join(f.root, ".hunch", "findings");
      setup(dir);
      const before = readdirSync(dir).filter((n) => n !== "fnd_mpcmove01.json");
      const r = cli(f, ["memory-policy", "migrate", ...(dryRun ? ["--dry-run"] : [])], { HUNCH_PRIVATE_DIR: overlay });
      assert.match(r.out, /findings: 1 public file\(s\) the loader skipped/, `${label}: the skipped file is reported:\n${r.out}`);
      assert.equal(r.status, 1, `${label}: ${r.out}`);
      for (const name of before) assert.equal(existsSync(join(dir, name)), true, `${label}: ${name} is never deleted unseen`);
    } finally { cleanupDir(f.base); }
  }
});

test("§9 memory-policy migrate moves single-file kinds whose ids never name a file (entities)", () => {
  const { f, overlay } = migrateFixture("mp-entities");
  try {
    const entity = { schema: "nuryel.entity/1", id: "customer:clinic-7", kind: "customer", name: "Clinic 7", scope: { kind: "organization", id: "acme" },
      refs: [{ system: "crm", object_type: "event", object_key: "10042", version: "2", observed_at: "2026-09-07T12:00:00Z" }],
      attributes: { tier: "key" }, lifecycle: "active", provenance: { source: "imported:crm", confidence: 0.9, evidence: ["crm row a1"] },
      created_at: "2026-09-07T12:00:00Z", updated_at: "2026-09-07T12:00:00Z" };
    mkdirSync(join(f.root, ".hunch", "entities"), { recursive: true });
    writeFileSync(join(f.root, ".hunch", "entities", "index.json"), `${JSON.stringify([entity], null, 2)}\n`);
    const dry = cli(f, ["memory-policy", "migrate", "--dry-run"], { HUNCH_PRIVATE_DIR: overlay });
    assert.equal(dry.status, 0, dry.out);
    assert.match(dry.out, /would move entities customer:clinic-7/, dry.out);
    const r = cli(f, ["memory-policy", "migrate"], { HUNCH_PRIVATE_DIR: overlay });
    assert.equal(r.status, 0, r.out);
    assert.match(r.out, /moved entities customer:clinic-7/, r.out);
    const store = open(f.root, overlay);
    try {
      assert.equal(store.getPrivateRec("entities", "customer:clinic-7")?.id, "customer:clinic-7", "the entity now lives in the overlay");
    } finally { store.close(); }
  } finally { cleanupDir(f.base); }
});

function entityRecord(name = "Clinic 7"): Record<string, unknown> {
  return { schema: "nuryel.entity/1", id: "customer:clinic-7", kind: "customer", name, scope: { kind: "organization", id: "acme" },
    refs: [{ system: "crm", object_type: "event", object_key: "10042", version: "2", observed_at: "2026-09-07T12:00:00Z" }],
    attributes: { tier: "key" }, lifecycle: "active", provenance: { source: "imported:crm", confidence: 0.9, evidence: ["crm row a1"] },
    created_at: "2026-09-07T12:00:00Z", updated_at: "2026-09-07T12:00:00Z" };
}

test("§9 memory-policy migrate never overwrites an overlay index entry the loader skipped, nor a non-array overlay index", () => {
  for (const [label, overlayText] of [
    ["mp-ent-newer", `${JSON.stringify([{ ...entityRecord("Clinic 7 v2"), schema: "nuryel.entity/2" }], null, 2)}\n`],
    ["mp-ent-object", "{}\n"],
  ] as const) {
    const { f, overlay } = migrateFixture(label);
    try {
      const publicIndex = join(f.root, ".hunch", "entities", "index.json");
      mkdirSync(dirname(publicIndex), { recursive: true });
      writeFileSync(publicIndex, `${JSON.stringify([entityRecord()], null, 2)}\n`);
      const overlayIndex = join(overlay, "entities", "index.json");
      mkdirSync(dirname(overlayIndex), { recursive: true });
      writeFileSync(overlayIndex, overlayText);
      const publicBefore = readFileSync(publicIndex, "utf8");
      const r = cli(f, ["memory-policy", "migrate"], { HUNCH_PRIVATE_DIR: overlay });
      assert.match(r.out, /conflict: entities customer:clinic-7 has an overlay file the loader could not read/, `${label}:\n${r.out}`);
      assert.equal(r.status, 1, `${label}: ${r.out}`);
      assert.equal(readFileSync(overlayIndex, "utf8"), overlayText, `${label}: the overlay index is untouched`);
      assert.equal(readFileSync(publicIndex, "utf8"), publicBefore, `${label}: the public copy is kept`);
    } finally { cleanupDir(f.base); }
  }
});

test("§9 memory-policy migrate reports an id two public index entries share as a conflict and writes nothing for it", () => {
  for (const [label, second] of [
    ["mp-ent-dup-valid", entityRecord("Clinic 7 renamed")],
    ["mp-ent-dup-invalid", { id: "customer:clinic-7", schema: "nuryel.entity/2" }],
  ] as const) {
    const { f, overlay } = migrateFixture(label);
    try {
      const publicIndex = join(f.root, ".hunch", "entities", "index.json");
      mkdirSync(dirname(publicIndex), { recursive: true });
      writeFileSync(publicIndex, `${JSON.stringify([entityRecord(), second], null, 2)}\n`);
      const publicBefore = readFileSync(publicIndex, "utf8");
      for (const dryRun of [true, false]) {
        const r = cli(f, ["memory-policy", "migrate", ...(dryRun ? ["--dry-run"] : [])], { HUNCH_PRIVATE_DIR: overlay });
        assert.match(r.out, /conflict: entities customer:clinic-7 is held by 2 public index entries/, `${label}:\n${r.out}`);
        assert.doesNotMatch(r.out, /move(d)? entities customer:clinic-7/, `${label}: never reported moved:\n${r.out}`);
        assert.equal(r.status, 1, `${label}: ${r.out}`);
        assert.equal(readFileSync(publicIndex, "utf8"), publicBefore, `${label}: both public entries are kept`);
        assert.equal(existsSync(join(overlay, "entities", "index.json")), false, `${label}: nothing is written to the overlay`);
      }
    } finally { cleanupDir(f.base); }
  }
});

test("§9 memory-policy migrate deletes the public copy when the overlay already holds the same record", () => {
  const { f, overlay, finding } = migrateFixture("mp-same");
  try {
    mkdirSync(join(overlay, "findings"), { recursive: true });
    writeFileSync(join(overlay, "findings", "fnd_mpcmove01.json"), readFileSync(finding, "utf8"));
    const r = cli(f, ["memory-policy", "migrate"], { HUNCH_PRIVATE_DIR: overlay });
    assert.equal(r.status, 0, r.out);
    assert.equal(existsSync(finding), false, "the duplicate public copy is deleted");
  } finally { cleanupDir(f.base); }
});

test("§9 memory-policy forget drops this machine's profile entry for the origin", () => {
  const f = fixture("mp-forget", origin("mp-forget"));
  try {
    const overlay = join(f.base, "overlay", ".hunch");
    mkdirSync(overlay, { recursive: true });
    writeRepoProfile(f.root, { privateDir: overlay, mode: "private", autoCommit: true });
    const r = cli(f, ["memory-policy", "forget"]);
    assert.equal(r.status, 0, r.out);
    assert.match(r.out, /removed/i, r.out);
    assert.equal(readRepoProfile(f.root), null, "the entry is gone");
    const again = cli(f, ["memory-policy", "forget"]);
    assert.equal(again.status, 0, again.out);
    assert.match(again.out, /no profile entry/i, again.out);
  } finally { cleanupDir(f.base); }
});

test("§9 memory-policy status and doctor warn about public_kinds names that are not kinds", () => {
  const f = fixture("mp-unknown", null);
  try {
    setPolicy(f.root, { home: "overlay", public_kinds: ["constraint", "policies"] });
    for (const args of [["memory-policy", "status"], ["doctor"]]) {
      const r = cli(f, args);
      assert.match(r.out, /unknown kind\(s\) in public_kinds: constraint, policies/, `${args.join(" ")}:\n${r.out}`);
    }
  } finally { cleanupDir(f.base); }
});

// ---------------------------------------------------------------- §10 CI

function jobBlock(workflow: string, name: string): string {
  const lines = workflow.split("\n");
  const start = lines.findIndex((line) => line === `  ${name}:`);
  assert.notEqual(start, -1, `workflow is missing the ${name} job`);
  let end = lines.length;
  for (let index = start + 1; index < lines.length; index += 1) {
    if (/^  [A-Za-z0-9_-]+:\s*$/.test(lines[index])) { end = index; break; }
  }
  return lines.slice(start, end).join("\n");
}

/** Each `      - ` step of a job, with its whole body. */
function steps(job: string): string[] {
  const out: string[] = [];
  for (const line of job.split("\n")) {
    if (/^      - /.test(line)) out.push(line);
    else if (out.length) out[out.length - 1] += `\n${line}`;
  }
  return out;
}

test("§10 CI runs memory-policy check against the PR base on every PR leg, fast path included", () => {
  const ci = readFileSync(".github/workflows/ci.yml", "utf8").replace(/\r\n/g, "\n");
  const gate = steps(jobBlock(ci, "ci")).filter((step) => /memory-policy\s+check/.test(step));
  assert.equal(gate.length, 1, "the ci job has exactly one memory-policy check step");
  const step = gate[0];
  assert.match(step, /--base\s+"?origin\/\$\{\{\s*github\.base_ref\s*\}\}"?|--base\s+"?origin\/\$\{?BASE_REF\}?"?/, `the check runs against the PR base:\n${step}`);
  const condition = /^\s+if:\s*(.+)$/m.exec(step)?.[1] ?? "";
  assert.match(condition, /github\.event_name\s*==\s*'pull_request'/, `the step is PR-only:\n${step}`);
  assert.doesNotMatch(condition, /MEMORY_ONLY|memory_only/, "the gate is not skipped on the memory-only fast path");
  assert.doesNotMatch(step, /src\/cli\/index\.ts\s+index\b|\bhunch\s+index\b/, "the gate stays cheap: no index");
});

// ---------------------------------------------------------------- §11 ship-memory

function shipFixture(): { base: string; work: string; other: string; git: (cwd: string, ...args: string[]) => string } {
  const base = tempDir("hunch-mpc-ship-");
  const env = { ...process.env, GIT_CONFIG_NOSYSTEM: "1", GIT_TERMINAL_PROMPT: "0" };
  const g = (cwd: string, ...args: string[]) => git(cwd, env, ...args);
  const originDir = join(base, "origin.git");
  const work = join(base, "work");
  const other = join(base, "other");
  g(base, "init", "-q", "--bare", "-b", "main", originDir);
  g(base, "init", "-q", "-b", "main", work);
  for (const dir of [work]) {
    g(dir, "config", "user.email", "test@example.com");
    g(dir, "config", "user.name", "Test");
    g(dir, "config", "commit.gpgsign", "false");
  }
  mkdirSync(join(work, ".hunch", "decisions"), { recursive: true });
  writeFileSync(join(work, ".hunch", "decisions", "dec_1.json"), `${JSON.stringify({ id: "dec_1", title: "seed" })}\n`);
  g(work, "add", ".");
  g(work, "commit", "-q", "-m", "seed");
  g(work, "remote", "add", "origin", originDir);
  g(work, "push", "-q", "origin", "main");
  g(work, "fetch", "-q", "origin");
  g(base, "clone", "-q", originDir, other);
  g(other, "config", "user.email", "other@example.com");
  g(other, "config", "user.name", "Other");
  g(other, "config", "commit.gpgsign", "false");
  return { base, work, other, git: g };
}

function ship(work: string, ...args: string[]) {
  return spawnSync(process.execPath, ["--import", "tsx", join(process.cwd(), "tooling", "ship-memory.mjs"), "--cwd", work, ...args], { encoding: "utf8", timeout: 120_000 });
}

test("§11 ship-memory under a home=overlay policy stands down: exit 0, the message, no fetch, no push", () => {
  const s = shipFixture();
  try {
    // A memory commit this machine would otherwise ship, and a new origin/main it would fetch.
    mkdirSync(join(s.work, ".hunch", "tasks"), { recursive: true });
    writeFileSync(join(s.work, ".hunch", "tasks", "htask_1.json"), `${JSON.stringify({ id: "htask_1", title: "a task" })}\n`);
    s.git(s.work, "add", "--", ".hunch/tasks/htask_1.json");
    s.git(s.work, "commit", "-q", "-m", "a task");
    writeFileSync(join(s.other, "OTHER.md"), "moved on\n");
    s.git(s.other, "add", "OTHER.md");
    s.git(s.other, "commit", "-q", "-m", "origin moves");
    s.git(s.other, "push", "-q", "origin", "main");
    const trackedBefore = s.git(s.work, "rev-parse", "refs/remotes/origin/main");
    setPolicy(s.work, { home: "overlay" }); // uncommitted working-tree config

    const run = ship(s.work);
    assert.match(run.stdout, /memory policy routes memory to the overlay; the shipper is not needed here/, `${run.stdout}${run.stderr}`);
    assert.equal(run.status, 0, run.stderr);
    assert.equal(s.git(s.work, "rev-parse", "refs/remotes/origin/main"), trackedBefore, "the shipper fetched nothing");
    assert.equal(s.git(s.work, "ls-remote", "origin", "refs/heads/memory/*"), "", "the shipper pushed nothing");
  } finally { cleanupDir(s.base); }
});

test("§11 ship-memory without a policy is unchanged but prints the deprecation line to stderr", () => {
  const s = shipFixture();
  try {
    mkdirSync(join(s.work, ".hunch", "tasks"), { recursive: true });
    writeFileSync(join(s.work, ".hunch", "tasks", "htask_1.json"), `${JSON.stringify({ id: "htask_1", title: "a task" })}\n`);
    s.git(s.work, "add", "--", ".hunch/tasks/htask_1.json");
    s.git(s.work, "commit", "-q", "-m", "a task");
    const run = ship(s.work, "--dry-run");
    assert.equal(run.status, 0, run.stderr);
    assert.match(run.stdout, /would push 1 commit\(s\) \(1 path\(s\)\) to memory\//, "the shipper still plans as before");
    assert.ok(run.stderr.includes("ship-memory is deprecated: set a memory policy (hunch memory-policy) instead"), `stderr lacks the deprecation line:\n${run.stderr}`);
  } finally { cleanupDir(s.base); }
});

// ---------------------------------------------------------------- §12 unreadable policy

const BROKEN_POLICY = "{\"memory\":{\"home\":\"overlay\",}}";

test("§12 doctor and memory-policy status report an unreadable config.json as blocking; doctor exits 1", () => {
  const f = fixture("unreadable-doctor", null);
  try {
    mkdirSync(join(f.root, ".hunch"), { recursive: true });
    writeFileSync(join(f.root, ".hunch", "config.json"), BROKEN_POLICY);
    const d = cli(f, ["doctor"]);
    assert.match(d.out, /memory policy: ⛔ \.hunch\/config\.json cannot be parsed[^\n]*captures are REFUSED/, d.out);
    assert.equal(d.status, 1, d.out);
    const s = cli(f, ["memory-policy", "status"]);
    assert.match(s.out, /memory policy: ⛔ \.hunch\/config\.json cannot be parsed/, s.out);
    assert.equal(s.status, 1, s.out);

    // A min_version beside an unreadable policy is still reported.
    writeFileSync(join(f.root, ".hunch", "config.json"), "{\"memory\":{\"Home\":\"overlay\",\"min_version\":\"99.0.0\"}}");
    const both = cli(f, ["doctor"]);
    assert.match(both.out, /memory policy: ⛔ [^\n]*Home/, both.out);
    assert.match(both.out, /requires Hunch 99\.0\.0 or newer/, both.out);
  } finally { cleanupDir(f.base); }
});

test("§12 memory-policy check fails on an unreadable head config; an unreadable base config is warned about and the head policy judges", () => {
  const f = fixture("unreadable-check", null);
  try {
    git(f.root, f.env, "checkout", "-q", "-b", "feature");
    mkdirSync(join(f.root, ".hunch"), { recursive: true });
    writeFileSync(join(f.root, ".hunch", "config.json"), BROKEN_POLICY);
    git(f.root, f.env, "add", "-A");
    git(f.root, f.env, "commit", "-qm", "broken policy");
    const head = cli(f, ["memory-policy", "check", "--base", "main"]);
    assert.match(head.out, /config\.json cannot be parsed/, head.out);
    assert.equal(head.status, 1, head.out);

    // The broken config lands on main; a branch that fixes it is judged by its own policy.
    git(f.root, f.env, "checkout", "-q", "main");
    git(f.root, f.env, "merge", "-q", "--ff-only", "feature");
    git(f.root, f.env, "checkout", "-q", "-b", "fix");
    setPolicy(f.root, { home: "overlay" });
    writeRecord(f.root, "findings", FINDING("fnd_mpcbroken1"));
    git(f.root, f.env, "add", "-A");
    git(f.root, f.env, "commit", "-qm", "fix policy, add a finding");
    const fixed = cli(f, ["memory-policy", "check", "--base", "main"]);
    assert.match(fixed.out, /base .*config\.json.*cannot be parsed/, fixed.out);
    assert.match(fixed.out, /fnd_mpcbroken1/, "the head policy still judges the finding");
    assert.equal(fixed.status, 1, fixed.out);

    // Dropping the policy instead of repairing it does not lift the gate: an unreadable
    // base is judged as the strictest policy.
    writeFileSync(join(f.root, ".hunch", "config.json"), "{\"firmness\":\"advisory\"}\n");
    git(f.root, f.env, "add", "-A");
    git(f.root, f.env, "commit", "-qm", "drop the policy");
    const dropped = cli(f, ["memory-policy", "check", "--base", "main"]);
    assert.match(dropped.out, /fnd_mpcbroken1/, dropped.out);
    assert.equal(dropped.status, 1, dropped.out);
  } finally { cleanupDir(f.base); }
});

test("§12 ship-memory refuses to ship under an unreadable config.json: exit 1, no push", () => {
  const s = shipFixture();
  try {
    mkdirSync(join(s.work, ".hunch", "tasks"), { recursive: true });
    writeFileSync(join(s.work, ".hunch", "tasks", "htask_1.json"), `${JSON.stringify({ id: "htask_1", title: "a task" })}\n`);
    s.git(s.work, "add", "--", ".hunch/tasks/htask_1.json");
    s.git(s.work, "commit", "-q", "-m", "a task");
    writeFileSync(join(s.work, ".hunch", "config.json"), BROKEN_POLICY);
    const run = ship(s.work);
    assert.match(`${run.stdout}${run.stderr}`, /config\.json cannot be parsed/, `${run.stdout}${run.stderr}`);
    assert.equal(run.status, 1, `${run.stdout}${run.stderr}`);
    assert.equal(s.git(s.work, "ls-remote", "origin", "refs/heads/memory/*"), "", "the shipper pushed nothing");
  } finally { cleanupDir(s.base); }
});
