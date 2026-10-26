import { cleanupDir, writeLocalPointer } from "./fixtures.js";
import { test, after } from "node:test";
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { HunchStore } from "../src/store/hunchStore.js";
import { hunchPaths } from "../src/core/paths.js";
import { memoryPolicy, memoryPolicyProblem, readConfig, writeConfig } from "../src/core/config.js";
import { ensureRepoId, normalizeRemoteUrl, readRepoProfile, removeRepoProfile, repoIdClaimConflict, repoIdForgetConflict, repoIdOf, repoProfileFile, repoProfileKey, resolveRepoProfile, writeRepoProfile } from "../src/core/repoProfile.js";
import { repositoryScope, subscribeState } from "../src/store/stateBinding.js";
import { StateRefusal } from "../src/store/stateError.js";
import { taskRecordHome } from "../src/core/taskRecord.js";
import { recordWorkspaceSnapshot } from "../src/integrations/workspaceLedger.js";
import type { Constraint, Decision } from "../src/core/types.js";

// The machine profile lives beside machine.json in the user's config dir. Every test here
// points that dir at a throwaway location: the real user profile is never read or written.
const configHome = mkdtempSync(join(tmpdir(), "hunch-cfg-"));
const saved = { XDG_CONFIG_HOME: process.env.XDG_CONFIG_HOME, HUNCH_PRIVATE_DIR: process.env.HUNCH_PRIVATE_DIR };
process.env.XDG_CONFIG_HOME = configHome;
delete process.env.HUNCH_PRIVATE_DIR;
after(() => {
  for (const [key, value] of Object.entries(saved)) {
    if (value === undefined) delete process.env[key];
    else process.env[key] = value;
  }
  cleanupDir(configHome);
});

const DEC = (id: string): Decision => ({
  id, title: id, status: "accepted", context: "", decision: "",
  consequences: [], alternatives_rejected: [], rejected_tripwires: [],
  related_components: [], related_files: [], supersedes: null, superseded_by: null,
  caused_by_bug: null, commit: null, valid_from: "2026-01-01T00:00:00Z", valid_to: null,
  retired: { symbols: [], deps: [] },
  provenance: { source: "human_confirmed", confidence: 1, evidence: [] },
  date: "2026-01-01T00:00:00Z",
} as unknown as Decision);

const CON = (id: string): Constraint => ({
  id, type: "correctness", statement: id, scope: ["src/**"], severity: "warning", enforcement: "advisory_v1",
  rationale: "", source_decision: null, violations: [], status: "active",
  valid_from: "2026-01-01T00:00:00Z", valid_to: null,
  provenance: { source: "human_confirmed", confidence: 1, evidence: [] },
} as unknown as Constraint);

function git(cwd: string, ...args: string[]): string {
  return execFileSync("git", args, {
    cwd,
    encoding: "utf8",
    env: { ...process.env, GIT_CONFIG_NOSYSTEM: "1", GIT_TERMINAL_PROMPT: "0" },
    stdio: ["ignore", "pipe", "pipe"],
  }).trim();
}

function tmp(prefix: string): string {
  return mkdtempSync(join(tmpdir(), prefix));
}

function repo(origin?: string): string {
  const root = tmp("hunch-mhp-repo-");
  git(root, "init", "-q", "-b", "main");
  if (origin) git(root, "remote", "add", "origin", origin);
  return root;
}

function setPolicy(root: string, memory: unknown): void {
  mkdirSync(join(root, ".hunch"), { recursive: true });
  writeFileSync(join(root, ".hunch", "config.json"), JSON.stringify({ firmness: "advisory", memory }, null, 2) + "\n");
}

/** Open a store with HUNCH_PRIVATE_DIR set only for the constructor (it is read there). */
function open(root: string, envOverlay?: string): HunchStore {
  if (envOverlay) process.env.HUNCH_PRIVATE_DIR = envOverlay;
  try {
    return new HunchStore(hunchPaths(root));
  } finally {
    delete process.env.HUNCH_PRIVATE_DIR;
  }
}

const KINDS = ["decisions", "findings", "tasks", "bugs", "constraints", "components", "symbols", "edges", "resources"];
const STRUCTURAL = ["components", "symbols", "edges", "resources"];

test("no memory field, no profile: routing is today's in public, private and shared modes", () => {
  const pub = tmp("hunch-mhp-pub-");
  const priv = tmp("hunch-mhp-priv-");
  const sharedRoot = repo();
  const sharedOverlay = tmp("hunch-mhp-shared-");
  try {
    const publicStore = open(pub);
    assert.equal(publicStore.memoryPolicy.home, "repo");
    for (const kind of KINDS) assert.equal(publicStore.captureHome(false, kind), "public");
    assert.equal(publicStore.captureHome(), "public");
    assert.equal(publicStore.captureHome(true), "private");
    publicStore.close();

    const privateStore = open(pub, priv);
    assert.equal(privateStore.mode, "private");
    for (const kind of KINDS) assert.equal(privateStore.captureHome(false, kind), "public");
    assert.equal(privateStore.captureHome(true, "constraints"), "private");
    privateStore.close();

    writeLocalPointer(sharedRoot, { privateDir: sharedOverlay, mode: "shared" });
    const sharedStore = open(sharedRoot);
    assert.equal(sharedStore.mode, "shared");
    for (const kind of KINDS) assert.equal(sharedStore.captureHome(false, kind), "private");
    assert.equal(sharedStore.captureHome(), "private");
    sharedStore.close();
  } finally {
    for (const dir of [pub, priv, sharedRoot, sharedOverlay]) cleanupDir(dir);
  }
});

test("policy home overlay with an overlay: memory goes to the overlay, constraints/components/index stay public", () => {
  const pub = tmp("hunch-mhp-pub-");
  const priv = tmp("hunch-mhp-priv-");
  try {
    setPolicy(pub, { home: "overlay" });
    const store = open(pub, priv);
    try {
      assert.equal(store.memoryPolicy.home, "overlay");
      for (const kind of ["decisions", "findings", "tasks", "bugs", "runbooks", "receipts"]) assert.equal(store.captureHome(false, kind), "private", kind);
      for (const kind of ["constraints", "components", "symbols", "edges", "resources"]) assert.equal(store.captureHome(false, kind), "public", kind);
      assert.equal(store.captureHome(false), "private", "an unnamed kind fails toward the overlay");
      assert.equal(store.captureHome(true, "constraints"), "private", "private:true always wins");

      store.putCapture("decisions", DEC("dec_policy"));
      store.putCapture("constraints", CON("con_policy"));
      assert.equal(store.getPrivateRec("decisions", "dec_policy")?.id, "dec_policy");
      assert.equal(store.json.get("decisions", "dec_policy"), undefined);
      assert.equal(store.json.get("constraints", "con_policy")?.id, "con_policy");
      assert.equal(store.getPrivateRec("constraints", "con_policy"), undefined);
      store.putCapture("constraints", CON("con_secret"), true);
      assert.equal(store.getPrivateRec("constraints", "con_secret")?.id, "con_secret");
    } finally { store.close(); }
  } finally {
    cleanupDir(pub);
    cleanupDir(priv);
  }
});

test("policy home overlay with NO overlay: reads work, a decision is refused, a constraint still lands public", () => {
  const pub = tmp("hunch-mhp-pub-");
  try {
    setPolicy(pub, { home: "overlay", public_kinds: ["constraints", "components"] });
    const store = open(pub);
    try {
      store.json.ensureDirs();
      assert.deepEqual(store.recs("decisions"), []);
      assert.throws(() => store.putCapture("decisions", DEC("dec_refused")), (error: Error) => {
        assert.match(error.message, /^Refused:/);
        assert.match(error.message, /no overlay is configured/);
        assert.match(error.message, /hunch private <dir>/);
        assert.match(error.message, /HUNCH_PRIVATE_DIR/);
        return true;
      });
      const decisionsDir = join(pub, ".hunch", "decisions");
      assert.deepEqual(existsSync(decisionsDir) ? readdirSync(decisionsDir).filter((name) => name.endsWith(".json")) : [], []);
      store.putCapture("constraints", CON("con_public"));
      assert.equal(store.json.get("constraints", "con_public")?.id, "con_public");
    } finally { store.close(); }
  } finally { cleanupDir(pub); }
});

test("public JsonStore guard: a direct public write of an overlay-homed kind is refused; delete is allowed", () => {
  const pub = tmp("hunch-mhp-pub-");
  const priv = tmp("hunch-mhp-priv-");
  try {
    const before = open(pub);
    before.json.ensureDirs();
    before.json.put("decisions", DEC("dec_legacy"));
    before.close();

    setPolicy(pub, { home: "overlay" });
    const store = open(pub, priv);
    try {
      assert.throws(() => store.json.put("findings", { id: "fnd_direct" } as never), { message: /^Refused:.*findings/ });
      assert.throws(() => store.json.replaceAll("decisions", []), { message: /^Refused:.*decisions/ });
      assert.equal(store.json.get("decisions", "dec_legacy")?.id, "dec_legacy", "a refused replaceAll wrote nothing");
      store.json.put("constraints", CON("con_direct"));
      assert.equal(store.json.delete("decisions", "dec_legacy"), true);
      assert.equal(store.json.get("decisions", "dec_legacy"), undefined);
    } finally { store.close(); }
  } finally {
    cleanupDir(pub);
    cleanupDir(priv);
  }
});

test("legacy public-only record under the policy: a clear Refused … migrate error, never an auto-move", () => {
  const pub = tmp("hunch-mhp-pub-");
  const priv = tmp("hunch-mhp-priv-");
  try {
    const before = open(pub);
    before.json.ensureDirs();
    before.json.put("decisions", DEC("dec_old"));
    before.close();

    setPolicy(pub, { home: "overlay" });
    const store = open(pub, priv);
    try {
      assert.throws(
        () => store.putCapture("decisions", DEC("dec_old")),
        { message: /^Refused: decisions dec_old lives in the public store but the memory policy homes decisions in the overlay; move it first \(hunch memory-policy migrate\)/ },
      );
      assert.equal(store.json.get("decisions", "dec_old")?.id, "dec_old");
      assert.equal(store.getPrivateRec("decisions", "dec_old"), undefined);
    } finally { store.close(); }
  } finally {
    cleanupDir(pub);
    cleanupDir(priv);
  }
});

test("writeConfig preserves unknown keys and the memory field; refuses to clobber an unparseable file", () => {
  const pub = tmp("hunch-mhp-pub-");
  try {
    const paths = hunchPaths(pub);
    mkdirSync(paths.hunch, { recursive: true });
    writeFileSync(paths.config, JSON.stringify({ firmness: "advisory", future_knob: { a: 1 }, memory: { home: "overlay", min_version: "1.48.0" } }));
    writeConfig(paths, { firmness: "strict" });
    const written = JSON.parse(readFileSync(paths.config, "utf8"));
    assert.equal(written.firmness, "strict");
    assert.deepEqual(written.future_knob, { a: 1 });
    assert.deepEqual(written.memory, { home: "overlay", min_version: "1.48.0" });

    writeFileSync(paths.config, "{ not json");
    assert.throws(() => writeConfig(paths, { firmness: "firm" }), /refusing to overwrite/);
    assert.equal(readFileSync(paths.config, "utf8"), "{ not json");
    assert.equal(readConfig(paths).firmness, "advisory", "readConfig stays total");
  } finally { cleanupDir(pub); }
});

test("readConfig ignores a junk memory field: the policy stays home repo", () => {
  const pub = tmp("hunch-mhp-pub-");
  try {
    const paths = hunchPaths(pub);
    for (const junk of ["overlay", ["overlay"], 7, null]) {
      setPolicy(pub, junk);
      assert.equal(readConfig(paths).memory, undefined, JSON.stringify(junk));
      assert.equal(memoryPolicy(readConfig(paths)).home, "repo");
    }
    setPolicy(pub, { home: "elsewhere" });
    assert.equal(memoryPolicy(readConfig(paths)).home, "repo");
    setPolicy(pub, { home: "overlay", public_kinds: ["constraints", "not-a-kind", 3] });
    const policy = memoryPolicy(readConfig(paths));
    assert.deepEqual([...policy.publicKinds].sort(), ["components", "constraints", "edges", "resources", "symbols"]);
  } finally { cleanupDir(pub); }
});

test("machine profile: a fresh clone of the same origin restores the overlay; env and local pointers still win", () => {
  const first = repo("git@github.com:Acme/Widgets.git");
  const clone = repo("https://github.com/Acme/Widgets");
  const overlay = tmp("hunch-mhp-profile-");
  const other = tmp("hunch-mhp-other-");
  const dead = tmp("hunch-mhp-dead-");
  try {
    assert.equal(writeRepoProfile(first, { privateDir: overlay, mode: "shared", autoCommit: false }), true);
    assert.ok(repoProfileFile().startsWith(configHome), "the profile lives in the isolated config dir");
    assert.equal(readRepoProfile(clone)?.privateDir, overlay);

    let store = open(clone);
    assert.equal(store.overlaySource, "machine-profile");
    assert.equal(store.privateDir, resolve(overlay));
    assert.equal(store.mode, "shared");
    assert.equal(store.autoCommit, false);
    assert.equal(store.captureHome(false, "decisions"), "private");
    store.close();

    store = open(clone, other);
    assert.equal(store.overlaySource, "environment");
    assert.equal(store.privateDir, resolve(other));
    store.close();

    writeLocalPointer(clone, { privateDir: other, mode: "private" });
    store = open(clone);
    assert.equal(store.overlaySource, "local-config");
    assert.equal(store.privateDir, resolve(other));
    assert.equal(store.mode, "private");
    store.close();
    rmSync(join(clone, ".hunch", "local.json"));
    rmSync(join(clone, ".git", "hunch", "local.json"));

    writeRepoProfile(first, { privateDir: dead, mode: "private", autoCommit: true });
    cleanupDir(dead);
    assert.equal(readRepoProfile(clone), null);
    store = open(clone);
    assert.equal(store.overlaySource, null);
    assert.equal(store.mode, "public");
    store.close();

    writeFileSync(repoProfileFile(), "{ broken");
    assert.equal(readRepoProfile(clone), null);
    store = open(clone);
    assert.equal(store.overlaySource, null);
    store.close();
    assert.throws(() => writeRepoProfile(first, { privateDir: overlay, mode: "shared", autoCommit: true }), /refusing to overwrite/);
    assert.equal(readFileSync(repoProfileFile(), "utf8"), "{ broken");
    rmSync(repoProfileFile());

    const noOrigin = repo();
    try {
      assert.equal(repoProfileKey(noOrigin), "");
      assert.equal(writeRepoProfile(noOrigin, { privateDir: overlay, mode: "shared", autoCommit: true }), false);
      assert.equal(existsSync(repoProfileFile()), false);
    } finally { cleanupDir(noOrigin); }
  } finally {
    for (const dir of [first, clone, overlay, other, dead]) cleanupDir(dir);
  }
});

test("normalizeRemoteUrl: scp, ssh, https, credentials, .git and host case all name one repository", () => {
  const expected = "github.com/Acme/Widgets";
  for (const url of [
    "git@github.com:Acme/Widgets.git",
    "github.com:Acme/Widgets",
    "ssh://git@github.com/Acme/Widgets.git",
    "ssh://git@github.com:22/Acme/Widgets",
    "https://github.com/Acme/Widgets",
    "https://github.com/Acme/Widgets.git/",
    "https://user:s3cret@GitHub.COM/Acme/Widgets.git",
    "  http://GITHUB.com/Acme/Widgets/  ",
  ]) assert.equal(normalizeRemoteUrl(url), expected, url);
  assert.equal(normalizeRemoteUrl("https://token@github.com/Acme/Widgets").includes("token"), false);
  for (const local of ["", "/srv/git/widgets.git", "C:/repos/widgets", "C:\\repos\\widgets", "file:///srv/git/widgets", "../widgets"]) {
    assert.equal(normalizeRemoteUrl(local), "", local);
  }
});

test("state verbs under the policy with no overlay refuse with a contract code, not a bare error", () => {
  const root = repo();
  try {
    setPolicy(root, { home: "overlay" });
    const store = open(root);
    try {
      const scope = repositoryScope(store);
      const principal = { id: "agent@test", kind: "agent" as const, grants: [scope] };
      assert.throws(
        () => subscribeState(store, { schema: "nuryel.state.subscribe/1", principal, scope, after_seq: 0 }),
        (error: unknown) => error instanceof StateRefusal && error.code === "no-partition-home" && /hunch private/.test(error.message),
      );
    } finally { store.close(); }
  } finally { cleanupDir(root); }
});

test("a kind listed in public_kinds stays public on the task-record and workspace paths", () => {
  const root = repo();
  const priv = tmp("hunch-mhp-priv-");
  try {
    git(root, "config", "user.email", "t@example.com");
    git(root, "config", "user.name", "t");
    const policy = { home: "overlay", public_kinds: ["constraints", "components", "tasks", "workspaces"] };
    setPolicy(root, policy);
    const withOverlay = open(root, priv);
    try {
      assert.equal(taskRecordHome(withOverlay, { saved: [], lessons: [] } as never), "public");
    } finally { withOverlay.close(); }

    writeFileSync(join(root, ".hunch", "config.json"), JSON.stringify({ memory: policy, workspaces: { publish_public: true } }));
    const noOverlay = open(root);
    try {
      const outcome = recordWorkspaceSnapshot(noOverlay, root);
      assert.equal(outcome.status, "written");
      assert.equal(outcome.status === "written" && outcome.home, "public");
    } finally { noOverlay.close(); }
  } finally {
    cleanupDir(root);
    cleanupDir(priv);
  }
});

test("a workspace snapshot under the policy with no overlay reports no home instead of throwing", () => {
  const root = repo();
  try {
    mkdirSync(join(root, ".hunch"), { recursive: true });
    writeFileSync(join(root, ".hunch", "config.json"), JSON.stringify({ memory: { home: "overlay" }, workspaces: { publish_public: true } }));
    const store = open(root);
    try {
      assert.equal(recordWorkspaceSnapshot(store, root).status, "no-home");
      assert.equal(existsSync(join(root, ".hunch", "workspaces")) && readdirSync(join(root, ".hunch", "workspaces")).some((n) => n.endsWith(".json")), false);
    } finally { store.close(); }
  } finally { cleanupDir(root); }
});

test("components are index output: public under every overlay policy, even when public_kinds omits them", () => {
  const pub = tmp("hunch-mhp-comp-");
  try {
    setPolicy(pub, { home: "overlay", public_kinds: ["constraints"] });
    const policy = memoryPolicy(readConfig(hunchPaths(pub)));
    assert.ok(policy.publicKinds.has("components"), "components stay public");
    const store = open(pub);
    try {
      assert.equal(store.captureHome(false, "components"), "public");
      store.json.replaceAll("components", []);
    } finally { store.close(); }
  } finally { cleanupDir(pub); }
});

test("readConfig tolerates a UTF-8 BOM: the policy and firmness survive, and a write keeps them", () => {
  const pub = tmp("hunch-mhp-bom-");
  try {
    mkdirSync(join(pub, ".hunch"), { recursive: true });
    const paths = hunchPaths(pub);
    writeFileSync(paths.config, `\uFEFF${JSON.stringify({ firmness: "strict", memory: { home: "overlay" } })}`);
    assert.equal(readConfig(paths).firmness, "strict");
    assert.equal(memoryPolicy(readConfig(paths)).home, "overlay");
    writeConfig(paths, { mcp_tools: "lean" });
    const written = JSON.parse(readFileSync(paths.config, "utf8"));
    assert.equal(written.firmness, "strict");
    assert.deepEqual(written.memory, { home: "overlay" });
  } finally { cleanupDir(pub); }
});

test("memoryPolicy names public_kinds entries it does not know, so status and doctor can warn", () => {
  assert.deepEqual(memoryPolicy({ memory: { home: "overlay", public_kinds: ["constraint", "policies", "decisions"] } }).unknownKinds, ["constraint", "policies"]);
  assert.deepEqual(memoryPolicy({ memory: { home: "overlay" } }).unknownKinds, []);
  assert.deepEqual(memoryPolicy({}).unknownKinds, []);
});

test("machine profile: a checkout's explicit local autoCommit and mode win over the profile's", () => {
  const first = repo("git@github.com:Acme/Gadgets.git");
  const clone = repo("https://github.com/Acme/Gadgets");
  const overlay = tmp("hunch-mhp-explicit-");
  try {
    writeRepoProfile(first, { privateDir: overlay, mode: "shared", autoCommit: true });
    mkdirSync(join(clone, ".hunch"), { recursive: true });
    writeFileSync(join(clone, ".hunch", "local.json"), JSON.stringify({ autoCommit: false, mode: "private" }) + "\n");
    const store = open(clone);
    try {
      assert.equal(store.overlaySource, "machine-profile");
      assert.equal(store.autoCommit, false, "the checkout's explicit autoCommit:false wins");
      assert.equal(store.mode, "private", "the checkout's explicit mode wins");
    } finally { store.close(); }
  } finally {
    for (const dir of [first, clone, overlay]) cleanupDir(dir);
  }
});

test("machine profile: a checkout's local autoCommit can force auto-commit off, never on", () => {
  const first = repo("git@github.com:Acme/Widgets.git");
  const clone = repo("https://github.com/Acme/Widgets");
  const overlay = tmp("hunch-mhp-forceon-");
  try {
    writeRepoProfile(first, { privateDir: overlay, mode: "shared", autoCommit: false });
    mkdirSync(join(clone, ".hunch"), { recursive: true });
    writeFileSync(join(clone, ".hunch", "local.json"), JSON.stringify({ autoCommit: true }) + "\n");
    const store = open(clone);
    try {
      assert.equal(store.overlaySource, "machine-profile");
      assert.equal(store.autoCommit, false, "the profile's opt-out holds against a checkout's autoCommit:true");
    } finally { store.close(); }
  } finally {
    for (const dir of [first, clone, overlay]) cleanupDir(dir);
  }
});

test("removeRepoProfile drops this origin's entry and leaves the others", () => {
  const first = repo("git@github.com:Acme/One.git");
  const second = repo("git@github.com:Acme/Two.git");
  const overlay = tmp("hunch-mhp-forget-");
  try {
    writeRepoProfile(first, { privateDir: overlay, mode: "private", autoCommit: true });
    writeRepoProfile(second, { privateDir: overlay, mode: "private", autoCommit: true });
    assert.equal(removeRepoProfile(first), true);
    assert.equal(readRepoProfile(first), null);
    assert.equal(readRepoProfile(second)?.privateDir, overlay);
    assert.equal(removeRepoProfile(first), false, "nothing left to remove");
  } finally {
    for (const dir of [first, second, overlay]) cleanupDir(dir);
  }
});

// A config.json that exists but cannot be read as a policy must not read as "no policy":
// that would route every capture public, the one outcome the policy exists to prevent.
const BROKEN_CONFIGS: Record<string, string> = {
  "trailing comma": "{\"memory\":{\"home\":\"overlay\",}}",
  "array root": "[]",
  "null root": "null",
  "memory not an object": "{\"memory\":\"overlay\"}",
  "typo'd home key": "{\"memory\":{\"Home\":\"overlay\"}}",
  "home value case": "{\"memory\":{\"home\":\"Overlay\"}}",
  "public_kinds not an array": "{\"memory\":{\"home\":\"overlay\",\"public_kinds\":\"constraints\"}}",
};

test("an unreadable memory policy fails closed: memory captures are refused naming config.json, nothing is written public", () => {
  for (const [label, text] of Object.entries(BROKEN_CONFIGS)) {
    const pub = tmp("hunch-mhp-pub-");
    try {
      mkdirSync(join(pub, ".hunch"), { recursive: true });
      writeFileSync(join(pub, ".hunch", "config.json"), text);
      assert.match(memoryPolicyProblem(hunchPaths(pub)) ?? "", /config\.json/, `${label}: a problem is reported`);
      const store = open(pub);
      try {
        store.json.ensureDirs();
        assert.throws(() => store.putCapture("findings", { id: "fnd_refused" } as never), (error: Error) => {
          assert.match(error.message, /^Refused:/, label);
          assert.match(error.message, /config\.json/, label);
          return true;
        }, label);
        assert.throws(() => store.json.put("decisions", DEC("dec_direct")), /Refused:/, `${label}: the public write guard is armed`);
        for (const kind of ["findings", "decisions"]) {
          const dir = join(pub, ".hunch", kind);
          assert.deepEqual(existsSync(dir) ? readdirSync(dir).filter((name) => name.endsWith(".json")) : [], [], `${label}: no public ${kind}`);
        }
        // Only memory is refused: index output still writes, so `hunch index` keeps working.
        for (const kind of STRUCTURAL) assert.equal(store.captureHome(false, kind), "public", `${label}: ${kind} stays writable`);
        store.json.replaceAll("components", []);
      } finally { store.close(); }
    } finally { cleanupDir(pub); }
  }
});

test("an unreadable memory policy still takes private captures, and shared mode keeps index output in the overlay", () => {
  for (const [label, text] of Object.entries(BROKEN_CONFIGS)) {
    const pub = tmp("hunch-mhp-pub-");
    const priv = tmp("hunch-mhp-priv-");
    const sharedRoot = repo();
    const sharedOverlay = tmp("hunch-mhp-shared-");
    try {
      mkdirSync(join(pub, ".hunch"), { recursive: true });
      writeFileSync(join(pub, ".hunch", "config.json"), text);
      const store = open(pub, priv);
      try {
        store.putCapture("decisions", DEC("dec_private_ok"), true);
        assert.ok(existsSync(join(priv, "decisions", "dec_private_ok.json")), `${label}: private:true lands in the overlay`);
      } finally { store.close(); }

      writeLocalPointer(sharedRoot, { privateDir: sharedOverlay, mode: "shared" });
      writeFileSync(join(sharedRoot, ".hunch", "config.json"), text);
      const shared = open(sharedRoot);
      try {
        assert.equal(shared.mode, "shared", label);
        // A broken policy must not move what shared mode homes in the overlay into the repo.
        for (const kind of STRUCTURAL) assert.equal(shared.captureHome(false, kind), "private", `${label}: shared ${kind}`);
      } finally { shared.close(); }
    } finally {
      for (const dir of [pub, priv, sharedRoot, sharedOverlay]) cleanupDir(dir);
    }
  }
});

test("memoryPolicyProblem is null for an absent file, a config without memory, and a valid policy", () => {
  const pub = tmp("hunch-mhp-pub-");
  try {
    const paths = hunchPaths(pub);
    assert.equal(memoryPolicyProblem(paths), null, "absent");
    mkdirSync(join(pub, ".hunch"), { recursive: true });
    writeFileSync(paths.config, "{\"firmness\":\"firm\"}");
    assert.equal(memoryPolicyProblem(paths), null, "no memory field");
    for (const memory of [{ home: "repo" }, { home: "overlay" }, { home: "overlay", public_kinds: ["constraints"], min_version: "1.0.0" }]) {
      setPolicy(pub, memory);
      assert.equal(memoryPolicyProblem(paths), null, JSON.stringify(memory));
    }
    writeFileSync(paths.config, "﻿{\"memory\":{\"home\":\"overlay\"}}");
    assert.equal(memoryPolicyProblem(paths), null, "BOM");
  } finally { cleanupDir(pub); }
});

test("a workspace snapshot under an unreadable policy reports no home instead of writing public", () => {
  const root = repo();
  try {
    mkdirSync(join(root, ".hunch"), { recursive: true });
    writeFileSync(join(root, ".hunch", "config.json"), JSON.stringify({ memory: { Home: "overlay" }, workspaces: { publish_public: true } }));
    const store = open(root);
    try {
      assert.equal(recordWorkspaceSnapshot(store, root).status, "no-home");
      assert.equal(existsSync(join(root, ".hunch", "workspaces")) && readdirSync(join(root, ".hunch", "workspaces")).some((n) => n.endsWith(".json")), false);
    } finally { store.close(); }
  } finally { cleanupDir(root); }
});

test("state verbs under an unreadable policy refuse with a contract code naming config.json, not a bare error", () => {
  const root = repo();
  try {
    mkdirSync(join(root, ".hunch"), { recursive: true });
    writeFileSync(join(root, ".hunch", "config.json"), "{\"memory\":{\"home\":\"Overlay\"}}");
    const store = open(root);
    try {
      const scope = repositoryScope(store);
      const principal = { id: "agent@test", kind: "agent" as const, grants: [scope] };
      assert.throws(
        () => subscribeState(store, { schema: "nuryel.state.subscribe/1", principal, scope, after_seq: 0 }),
        (error: unknown) => error instanceof StateRefusal && error.code === "no-partition-home" && /config\.json/.test(error.message),
      );
    } finally { store.close(); }
  } finally { cleanupDir(root); }
});

test("a memory field without home is today's routing unless it holds a key the policy does not know", () => {
  const pub = tmp("hunch-mhp-pub-");
  try {
    const paths = hunchPaths(pub);
    setPolicy(pub, { min_version: "1.0.0" });
    assert.equal(memoryPolicyProblem(paths), null, "min_version alone");
    setPolicy(pub, { home: "repo", public_kinds: "constraints" });
    assert.equal(memoryPolicyProblem(paths), null, "public_kinds is irrelevant under home=repo");
    setPolicy(pub, { Home: "overlay", min_version: "1.0.0" });
    assert.match(memoryPolicyProblem(paths) ?? "", /Home/, "an unknown key is named");
  } finally { cleanupDir(pub); }
});

test("a key a newer Hunch adds beside a valid home does not lock older Hunch out of the policy", () => {
  const pub = tmp("hunch-mhp-pub-");
  try {
    const paths = hunchPaths(pub);
    for (const memory of [{ home: "overlay", future_option: true }, { home: "repo", note: "x" }]) {
      setPolicy(pub, memory);
      assert.equal(memoryPolicyProblem(paths), null, JSON.stringify(memory));
    }
    // A misspelled known key is a typo, not a newer option: ignoring it would widen what is public.
    for (const memory of [{ home: "overlay", public_kind: [] }, { home: "overlay", publicKinds: [] }, { home: "overlay", "Public-Kinds": [] }]) {
      setPolicy(pub, memory);
      assert.match(memoryPolicyProblem(paths) ?? "", /public_kinds/, JSON.stringify(memory));
    }
    writeFileSync(paths.config, JSON.stringify({ Memory: { home: "overlay" } }));
    assert.match(memoryPolicyProblem(paths) ?? "", /Memory/, "a misspelled top-level memory key");
    writeFileSync(paths.config, JSON.stringify({ memorys: { home: "overlay" } }));
    assert.match(memoryPolicyProblem(paths) ?? "", /memorys/, "a top-level memory key with a stray s");
    writeFileSync(paths.config, JSON.stringify({ memories: { home: "overlay" } }));
    assert.match(memoryPolicyProblem(paths) ?? "", /memories/, "the plural of memory");
  } finally { cleanupDir(pub); }
});

test("a policy that names public kinds but no home is refused, since it can only have meant overlay", () => {
  const pub = tmp("hunch-mhp-pub-");
  try {
    const paths = hunchPaths(pub);
    setPolicy(pub, { public_kinds: ["constraints"] });
    assert.match(memoryPolicyProblem(paths) ?? "", /home/, "public_kinds without home");
  } finally { cleanupDir(pub); }
});

test("a misspelled home without a valid home is answered with the key it meant", () => {
  const pub = tmp("hunch-mhp-pub-");
  try {
    const paths = hunchPaths(pub);
    setPolicy(pub, { Home: "overlay" });
    assert.match(memoryPolicyProblem(paths) ?? "", /did you mean `home`/);
  } finally { cleanupDir(pub); }
});

// ---------------------------------------------------------------- repo identity (Step 2b)

function profileFileJson(): { version: 1; repos: Record<string, Record<string, unknown>> } {
  return JSON.parse(readFileSync(repoProfileFile(), "utf8"));
}

function withRepoId(root: string, id: string): void {
  mkdirSync(join(root, ".hunch"), { recursive: true });
  writeFileSync(join(root, ".hunch", "config.json"), JSON.stringify({ firmness: "advisory", repo_id: id }, null, 2) + "\n");
}

test("repo id: ensureRepoId mints once, keeps every other key, and refuses to clobber an unparseable config", () => {
  const root = repo();
  try {
    setPolicy(root, { home: "overlay" });
    const first = ensureRepoId(root);
    assert.equal(first.minted, true);
    assert.match(first.id, /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/);
    assert.deepEqual(ensureRepoId(root), { id: first.id, minted: false }, "idempotent");
    const config = JSON.parse(readFileSync(join(root, ".hunch", "config.json"), "utf8"));
    assert.deepEqual(config.memory, { home: "overlay" }, "the policy survives");
    assert.equal(config.repo_id, first.id);
    assert.equal(memoryPolicyProblem(hunchPaths(root)), null, "repo_id is not a policy problem");
    assert.equal(repoIdOf(root), first.id);
    writeFileSync(join(root, ".hunch", "config.json"), "{ broken");
    assert.throws(() => ensureRepoId(root), /refusing to overwrite/);
    assert.equal(readFileSync(join(root, ".hunch", "config.json"), "utf8"), "{ broken");
    withRepoId(root, "not-a-uuid");
    assert.equal(repoIdOf(root), "", "a malformed id names no repository");
    assert.throws(() => ensureRepoId(root), /repo_id/, "a malformed id is refused, never replaced");
  } finally { cleanupDir(root); }
});

test("repo id: a no-origin repo and a clone from a local path find the overlay through the committed repo_id", () => {
  const first = repo("git@github.com:Acme/Widgets.git");
  const localClone = repo("C:/repos/widgets");
  const noOrigin = repo();
  const overlay = tmp("hunch-mhp-id-");
  try {
    const { id } = ensureRepoId(first);
    assert.equal(writeRepoProfile(first, { privateDir: overlay, mode: "private", autoCommit: true }), true);
    assert.equal(readRepoProfile(localClone), null, "precondition: without the id a local-path clone has no identity");
    withRepoId(localClone, id);
    withRepoId(noOrigin, id);
    assert.equal(readRepoProfile(localClone)?.privateDir, overlay);
    assert.equal(readRepoProfile(noOrigin)?.privateDir, overlay);
    const store = open(noOrigin);
    assert.equal(store.overlaySource, "machine-profile");
    assert.equal(store.privateDir, resolve(overlay));
    store.close();

    // A repository that was never on a network remote records and restores by id alone.
    const lone = repo();
    const loneClone = repo("file:///srv/git/lone");
    const loneOverlay = tmp("hunch-mhp-lone-");
    try {
      const lid = ensureRepoId(lone).id;
      assert.equal(writeRepoProfile(lone, { privateDir: loneOverlay, mode: "private", autoCommit: true }), true);
      withRepoId(loneClone, lid);
      assert.equal(readRepoProfile(loneClone)?.privateDir, loneOverlay);
    } finally { for (const dir of [lone, loneClone, loneOverlay]) cleanupDir(dir); }
  } finally {
    for (const dir of [first, localClone, noOrigin, overlay]) cleanupDir(dir);
    rmSync(repoProfileFile(), { force: true });
  }
});

test("repo id: a fork that carries the id but has another network origin never inherits the overlay", () => {
  const first = repo("git@github.com:Acme/Widgets.git");
  const fork = repo("git@github.com:Someone/Widgets.git");
  const overlay = tmp("hunch-mhp-fork-");
  try {
    const { id } = ensureRepoId(first);
    writeRepoProfile(first, { privateDir: overlay, mode: "private", autoCommit: true });
    withRepoId(fork, id);
    assert.equal(readRepoProfile(fork), null);
    const resolved = resolveRepoProfile(fork);
    assert.equal(resolved.entry, null);
    assert.match(resolved.conflict ?? "", /github\.com\/Acme\/Widgets/, "the refusal names the origin the id was recorded for");
  } finally {
    for (const dir of [first, fork, overlay]) cleanupDir(dir);
    rmSync(repoProfileFile(), { force: true });
  }
});

test("repo id: a fork's setup and forget never take or drop the upstream's id entry", () => {
  const first = repo("git@github.com:Acme/Widgets.git");
  const fork = repo("git@github.com:Someone/Widgets.git");
  const localClone = repo("C:/repos/widgets");
  const overlay = tmp("hunch-mhp-own-");
  const forkOverlay = tmp("hunch-mhp-own-fork-");
  try {
    const { id } = ensureRepoId(first);
    writeRepoProfile(first, { privateDir: overlay, mode: "private", autoCommit: true });
    withRepoId(fork, id);
    withRepoId(localClone, id);
    assert.equal(writeRepoProfile(fork, { privateDir: forkOverlay, mode: "private", autoCommit: true }), true);
    const idEntry = profileFileJson().repos[`repo-id:${id}`]!;
    assert.equal(idEntry.privateDir, overlay, "the fork did not take the upstream's id entry");
    assert.equal(idEntry.origin, "github.com/Acme/Widgets");
    assert.match(repoIdClaimConflict(fork), /github\.com\/Acme\/Widgets/, "the fork is told why its id was not recorded");
    assert.equal(repoIdClaimConflict(first), "");
    assert.equal(readRepoProfile(localClone)?.privateDir, overlay, "the upstream's local clone still finds the upstream overlay");
    assert.equal(readRepoProfile(fork)?.privateDir, forkOverlay, "the fork resolves its own overlay by origin");

    assert.equal(removeRepoProfile(fork), true);
    assert.deepEqual(Object.keys(profileFileJson().repos).sort(), [`repo-id:${id}`, "github.com/Acme/Widgets"].sort(), "forget in the fork dropped only the fork's entry");

    // A clone with no network origin re-running setup keeps the network origin the id was bound to.
    const recorded = profileFileJson().repos[`repo-id:${id}`]!;
    writeRepoProfile(localClone, { privateDir: overlay, mode: recorded.mode === "shared" ? "private" : "shared", autoCommit: !recorded.autoCommit });
    const rebound = profileFileJson().repos[`repo-id:${id}`]!;
    assert.equal(rebound.origin, "github.com/Acme/Widgets");
    assert.deepEqual([rebound.mode, rebound.autoCommit], [recorded.mode, recorded.autoCommit], "a rebind across the origin gap never changes the owner's mode or auto-commit");
    withRepoId(fork, id);
    assert.equal(readRepoProfile(fork), null, "the fork still never inherits");
  } finally {
    for (const dir of [first, fork, localClone, overlay, forkOverlay]) cleanupDir(dir);
    rmSync(repoProfileFile(), { force: true });
  }
});

test("repo id: an id recorded without a network origin is not inherited by a checkout that has one until setup binds it", () => {
  const lone = repo();
  const loneFork = repo("git@github.com:Other/Lone.git");
  const overlay = tmp("hunch-mhp-lone-bind-");
  try {
    const { id } = ensureRepoId(lone);
    writeRepoProfile(lone, { privateDir: overlay, mode: "private", autoCommit: true });
    withRepoId(loneFork, id);
    const resolved = resolveRepoProfile(loneFork);
    assert.equal(resolved.entry, null);
    assert.match(resolved.conflict ?? "", /without a network origin/);
    // The owner adding a remote re-runs setup, which binds the id to that origin.
    git(lone, "remote", "add", "origin", "git@github.com:Me/Lone.git");
    writeRepoProfile(lone, { privateDir: overlay, mode: "shared", autoCommit: false });
    const bound = profileFileJson().repos[`repo-id:${id}`]!;
    assert.equal(bound.origin, "github.com/Me/Lone");
    // Binding moves ownership to that origin, so the id entry takes the settings it asked
    // for, the same ones its origin entry records: no split policy for one repository.
    assert.deepEqual([bound.mode, bound.autoCommit], ["shared", false]);
    const originEntry = profileFileJson().repos["github.com/Me/Lone"]!;
    assert.deepEqual([originEntry.mode, originEntry.autoCommit], ["shared", false]);
    assert.equal(readRepoProfile(lone)?.privateDir, overlay);
    assert.equal(readRepoProfile(lone)?.mode, "shared");
    assert.equal(readRepoProfile(loneFork), null);
  } finally {
    for (const dir of [lone, loneFork, overlay]) cleanupDir(dir);
    rmSync(repoProfileFile(), { force: true });
  }
});

test("repo id: a checkout across the origin gap rebinds the id only to the overlay already recorded", () => {
  const lone = repo();
  const copy = repo("git@github.com:Other/Lone.git");
  const upstream = repo("git@github.com:Acme/Widgets.git");
  const localClone = repo("C:/repos/widgets");
  const overlay = tmp("hunch-mhp-gap-");
  const copyOverlay = tmp("hunch-mhp-gap-copy-");
  try {
    const { id } = ensureRepoId(lone);
    writeRepoProfile(lone, { privateDir: overlay, mode: "private", autoCommit: true });
    withRepoId(copy, id);
    writeRepoProfile(copy, { privateDir: copyOverlay, mode: "private", autoCommit: true });
    assert.equal(readRepoProfile(lone)?.privateDir, overlay, "a copy pushed elsewhere never re-points the original");
    assert.match(repoIdClaimConflict(copy, copyOverlay), /without a network origin/);
    assert.equal(readRepoProfile(copy)?.privateDir, copyOverlay, "the copy resolves its own overlay by origin");
    assert.equal(removeRepoProfile(copy), true);
    assert.equal(readRepoProfile(lone)?.privateDir, overlay, "forget in the copy left the original's id entry");

    const uid = ensureRepoId(upstream).id;
    writeRepoProfile(upstream, { privateDir: overlay, mode: "private", autoCommit: true });
    withRepoId(localClone, uid);
    writeRepoProfile(localClone, { privateDir: copyOverlay, mode: "private", autoCommit: true });
    assert.equal(readRepoProfile(upstream)?.privateDir, overlay, "a local clone choosing another overlay never splits the upstream");
    assert.match(repoIdClaimConflict(localClone, copyOverlay), /github\.com\/Acme\/Widgets/);
  } finally {
    for (const dir of [lone, copy, upstream, localClone, overlay, copyOverlay]) cleanupDir(dir);
    rmSync(repoProfileFile(), { force: true });
  }
});

test("repo id: forget follows the setup rule, so no clone or de-remoted fork can seize the id; junk and dead entries are absent", () => {
  const upstream = repo("git@github.com:Acme/Widgets.git");
  const localClone = repo("C:/repos/widgets");
  const fork = repo("git@github.com:Fork/Widgets.git");
  const overlay = tmp("hunch-mhp-seize-");
  const other = tmp("hunch-mhp-seize-other-");
  try {
    const { id } = ensureRepoId(upstream);
    writeRepoProfile(upstream, { privateDir: overlay, mode: "private", autoCommit: true });
    withRepoId(localClone, id);
    withRepoId(fork, id);
    assert.equal(removeRepoProfile(localClone), false, "a no-origin clone cannot forget an id bound to a network origin");
    assert.equal(writeRepoProfile(localClone, { privateDir: other, mode: "private", autoCommit: true }), false, "nothing is recorded");
    assert.match(repoIdClaimConflict(localClone, other), /bound to github\.com\/Acme\/Widgets/);
    git(fork, "remote", "remove", "origin");
    assert.equal(removeRepoProfile(fork), false, "a de-remoted fork cannot forget it either");
    assert.equal(profileFileJson().repos[`repo-id:${id}`]!.privateDir, overlay);
    assert.equal(repoIdClaimConflict(upstream, overlay), "", "the owner is never called a fork");
    assert.equal(removeRepoProfile(upstream), true);
    assert.deepEqual(Object.keys(profileFileJson().repos), [], "the owner's forget drops both keys");

    // A hand-edited non-entry, or an entry whose overlay is gone, is absent: the owner re-binds.
    writeFileSync(repoProfileFile(), JSON.stringify({ version: 1, repos: { [`repo-id:${id}`]: "junk" } }));
    writeRepoProfile(upstream, { privateDir: overlay, mode: "private", autoCommit: true });
    assert.equal(profileFileJson().repos[`repo-id:${id}`]!.privateDir, overlay);
    const lone = repo();
    const dead = tmp("hunch-mhp-seize-dead-");
    try {
      const lid = ensureRepoId(lone).id;
      writeRepoProfile(lone, { privateDir: dead, mode: "private", autoCommit: true });
      cleanupDir(dead);
      git(lone, "remote", "add", "origin", "git@github.com:Me/Lone.git");
      writeRepoProfile(lone, { privateDir: other, mode: "private", autoCommit: true });
      assert.equal(profileFileJson().repos[`repo-id:${lid}`]!.privateDir, dead, "a dead overlay still holds the id: a copy pushed elsewhere must not seize it");
      assert.match(repoIdClaimConflict(lone, other), /recorded for a checkout without a network origin/);
      assert.equal(removeRepoProfile(lone), true, "its own origin entry goes");
      assert.ok(profileFileJson().repos[`repo-id:${lid}`], "the id entry is never forgotten across the origin gap");
    } finally { cleanupDir(lone); }
  } finally {
    for (const dir of [upstream, localClone, fork, overlay, other]) cleanupDir(dir);
    rmSync(repoProfileFile(), { force: true });
  }
});

test("repo id: an upstream overlay that is merely unavailable still holds the id against a fork; only the origin gap treats it as gone", () => {
  const upstream = repo("git@github.com:Acme/Widgets.git");
  const fork = repo("git@github.com:Fork/Widgets.git");
  const localClone = repo("C:/repos/widgets");
  const overlay = tmp("hunch-mhp-unavail-");
  const other = tmp("hunch-mhp-unavail-other-");
  try {
    const { id } = ensureRepoId(upstream);
    writeRepoProfile(upstream, { privateDir: overlay, mode: "private", autoCommit: true });
    withRepoId(fork, id);
    withRepoId(localClone, id);
    cleanupDir(overlay); // an unmounted drive or a moved dir: the upstream still owns the id
    writeRepoProfile(fork, { privateDir: other, mode: "private", autoCommit: true });
    const entry = profileFileJson().repos[`repo-id:${id}`]!;
    assert.equal(entry.privateDir, overlay, "the fork did not seize the id");
    assert.equal(entry.origin, "github.com/Acme/Widgets");
    assert.match(repoIdClaimConflict(fork, other), /recorded for github\.com\/Acme\/Widgets/);
    assert.equal(removeRepoProfile(fork), true, "the fork forgets its own origin entry");
    assert.ok(profileFileJson().repos[`repo-id:${id}`], "but never the upstream's id entry");
    assert.match(repoIdForgetConflict(fork), /bound to github\.com\/Acme\/Widgets; forget it from a checkout of github\.com\/Acme\/Widgets/);
    assert.match(repoIdForgetConflict(localClone), /bound to github\.com\/Acme\/Widgets/, "a no-origin clone is refused too");
    assert.equal(repoIdForgetConflict(upstream), "", "the owner may forget it");
  } finally {
    for (const dir of [upstream, fork, localClone, overlay, other]) cleanupDir(dir);
    rmSync(repoProfileFile(), { force: true });
  }
});

test("repo id: an invalid id entry holds nothing, not even its origin", () => {
  const upstream = repo("git@github.com:Acme/Widgets.git");
  const localClone = repo("C:/repos/widgets");
  const overlay = tmp("hunch-mhp-junk-origin-");
  try {
    const { id } = ensureRepoId(upstream);
    withRepoId(localClone, id);
    mkdirSync(resolve(repoProfileFile(), ".."), { recursive: true });
    // Non-absolute dir: invalid, as a hand edit or a newer Hunch's entry can be.
    writeFileSync(repoProfileFile(), JSON.stringify({ version: 1, repos: { [`repo-id:${id}`]: { privateDir: "relative/junk", mode: "private", autoCommit: false, origin: "github.com/Acme/Widgets" } } }));
    assert.equal(writeRepoProfile(localClone, { privateDir: overlay, mode: "shared", autoCommit: true }), true);
    assert.equal(profileFileJson().repos[`repo-id:${id}`]!.origin, "", "a no-origin checkout never mints an entry bound to an origin it lacks");
    assert.equal(readRepoProfile(upstream), null, "so the origin's clones do not inherit its overlay");
  } finally {
    for (const dir of [upstream, localClone, overlay]) cleanupDir(dir);
    rmSync(repoProfileFile(), { force: true });
  }
});

test("repo id: a no-origin clone refused setup is told its local pointer serves it, not the id", () => {
  const upstream = repo("git@github.com:Acme/Widgets.git");
  const localClone = repo("C:/repos/widgets");
  const overlay = tmp("hunch-mhp-ptr-");
  const other = tmp("hunch-mhp-ptr-other-");
  try {
    const { id } = ensureRepoId(upstream);
    writeRepoProfile(upstream, { privateDir: overlay, mode: "private", autoCommit: true });
    withRepoId(localClone, id);
    const msg = repoIdClaimConflict(localClone, other);
    assert.match(msg, /nothing was recorded in the machine profile/);
    assert.match(msg, /uses .* through its local pointer, but a fresh clone without a network origin resolves .* through the id/);
    assert.doesNotMatch(msg, /keeps resolving/);

    // The reverse gap: an id recorded with no origin, read from a checkout that has one.
    const lone = repo();
    const remoted = repo("git@github.com:Me/Lone.git");
    try {
      const lid = ensureRepoId(lone).id;
      writeRepoProfile(lone, { privateDir: other, mode: "private", autoCommit: true });
      withRepoId(remoted, lid);
      assert.match(resolveRepoProfile(remoted).conflict ?? "", /re-run hunch private\/shared here with the recorded overlay to bind it/);
    } finally { for (const dir of [lone, remoted]) cleanupDir(dir); }
  } finally {
    for (const dir of [upstream, localClone, overlay, other]) cleanupDir(dir);
    rmSync(repoProfileFile(), { force: true });
  }
});

test("origin case: path case folds only on hosts known to be case-insensitive", () => {
  const upper = repo("git@git.corp.example:team/Deploy.git");
  const lower = repo("git@git.corp.example:team/deploy.git");
  const overlay = tmp("hunch-mhp-cs-");
  const other = tmp("hunch-mhp-cs-other-");
  try {
    writeRepoProfile(upper, { privateDir: overlay, mode: "private", autoCommit: true });
    assert.equal(readRepoProfile(lower), null, "a case-sensitive host: Deploy and deploy are two repositories");
    writeRepoProfile(lower, { privateDir: other, mode: "private", autoCommit: true });
    assert.equal(readRepoProfile(upper)?.privateDir, overlay, "setting up deploy kept Deploy's entry");
    assert.equal(removeRepoProfile(lower), true);
    assert.equal(readRepoProfile(upper)?.privateDir, overlay, "forgetting deploy kept Deploy's entry");
  } finally {
    for (const dir of [upper, lower, overlay, other]) cleanupDir(dir);
    rmSync(repoProfileFile(), { force: true });
  }
});

test("origin case: one identity; a legacy exact-case entry is found; a rewrite drops case variants; disagreeing variants refuse", () => {
  const upper = repo("git@github.com:Acme/Widgets.git");
  const lower = repo("https://github.com/acme/widgets");
  const overlay = tmp("hunch-mhp-case-");
  const other = tmp("hunch-mhp-case-other-");
  try {
    writeRepoProfile(upper, { privateDir: overlay, mode: "private", autoCommit: true });
    assert.equal(readRepoProfile(lower)?.privateDir, overlay, "path case does not split one repository");
    writeRepoProfile(lower, { privateDir: overlay, mode: "shared", autoCommit: false });
    assert.deepEqual(Object.keys(profileFileJson().repos), ["github.com/acme/widgets"], "the rewrite replaced the case variant");
    assert.equal(readRepoProfile(upper)?.mode, "shared");

    writeFileSync(repoProfileFile(), JSON.stringify({ version: 1, repos: {
      "github.com/Acme/Widgets": { privateDir: overlay, mode: "private", autoCommit: true, updated_at: "" },
      "github.com/ACME/widgets": { privateDir: other, mode: "private", autoCommit: true, updated_at: "" },
    } }));
    assert.equal(readRepoProfile(upper)?.privateDir, overlay, "an exact-case entry wins");
    const ambiguous = resolveRepoProfile(lower);
    assert.equal(ambiguous.entry, null, "two case variants naming different overlays: unresolved");
    assert.match(ambiguous.conflict ?? "", /github\.com\/Acme\/Widgets/);
  } finally {
    for (const dir of [upper, lower, overlay, other]) cleanupDir(dir);
    rmSync(repoProfileFile(), { force: true });
  }
});

test("repo id and origin entries that name different overlays leave the home unresolved, never a guess", () => {
  const root = repo("git@github.com:Acme/Widgets.git");
  const overlay = tmp("hunch-mhp-split-");
  const other = tmp("hunch-mhp-split-other-");
  try {
    const { id } = ensureRepoId(root);
    writeRepoProfile(root, { privateDir: overlay, mode: "private", autoCommit: true });
    const file = profileFileJson();
    file.repos["github.com/Acme/Widgets"]!.privateDir = other; // an older Hunch rewrote the origin entry
    writeFileSync(repoProfileFile(), JSON.stringify(file));
    const resolved = resolveRepoProfile(root);
    assert.equal(resolved.entry, null);
    assert.match(resolved.conflict ?? "", new RegExp(id));
    const store = open(root);
    assert.equal(store.overlaySource, null);
    store.close();
    assert.equal(removeRepoProfile(root), true);
    assert.deepEqual(Object.keys(profileFileJson().repos), [], "forget drops the id and the origin entry");
  } finally {
    for (const dir of [root, overlay, other]) cleanupDir(dir);
    rmSync(repoProfileFile(), { force: true });
  }
});
