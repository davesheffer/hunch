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
import { normalizeRemoteUrl, readRepoProfile, removeRepoProfile, repoProfileFile, repoProfileKey, writeRepoProfile } from "../src/core/repoProfile.js";
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
  } finally { cleanupDir(pub); }
});
