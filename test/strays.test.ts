import { cleanupDir } from "./fixtures.js";
import { test, after } from "node:test";
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { existsSync, linkSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { HunchStore } from "../src/store/hunchStore.js";
import { JsonStore } from "../src/store/jsonStore.js";
import { hunchPaths, hunchPathsForDir } from "../src/core/paths.js";
import { ENTITY_KINDS, type Constraint, type Decision } from "../src/core/types.js";
import { findStrays, importStrays } from "../src/store/strays.js";
import { liveForTopic } from "../src/core/topics.js";

// The machine profile lives beside machine.json in the user's config dir. Every test here
// points that dir at a throwaway location: the real user profile is never read or written.
const configHome = mkdtempSync(join(tmpdir(), "hunch-cfg-"));
const saved = { XDG_CONFIG_HOME: process.env.XDG_CONFIG_HOME, HUNCH_PRIVATE_DIR: process.env.HUNCH_PRIVATE_DIR };
process.env.XDG_CONFIG_HOME = configHome;
delete process.env.HUNCH_PRIVATE_DIR;
const cleanup: string[] = [configHome];
after(() => {
  for (const [key, value] of Object.entries(saved)) {
    if (value === undefined) delete process.env[key];
    else process.env[key] = value;
  }
  for (const dir of cleanup) cleanupDir(dir);
});

const DEC = (id: string, title = id): Decision => ({
  id, title, status: "accepted", context: "", decision: "",
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
  return execFileSync("git", ["-c", "user.name=t", "-c", "user.email=t@example.invalid", ...args], {
    cwd,
    encoding: "utf8",
    env: { ...process.env, GIT_CONFIG_NOSYSTEM: "1", GIT_TERMINAL_PROMPT: "0" },
    stdio: ["ignore", "pipe", "pipe"],
  }).trim();
}

function tmp(prefix: string): string {
  const dir = mkdtempSync(join(tmpdir(), prefix));
  cleanup.push(dir);
  return dir;
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

/** A repo homing memory in the overlay, its overlay dir, and one linked worktree. */
function fixture(): { root: string; priv: string; wt: string; wtJson: JsonStore } {
  const root = tmp("hunch-strays-repo-");
  git(root, "init", "-q", "-b", "main");
  git(root, "commit", "-q", "--allow-empty", "-m", "init");
  setPolicy(root, { home: "overlay" });
  const priv = tmp("hunch-strays-priv-");
  const wt = join(tmp("hunch-strays-wt-"), "feature");
  git(root, "worktree", "add", "-q", "-b", "feature", wt);
  const wtJson = new JsonStore(hunchPaths(wt));
  wtJson.ensureDirs();
  return { root, priv, wt, wtJson };
}

function filesUnder(dir: string): string[] {
  if (!existsSync(dir)) return [];
  const out: string[] = [];
  const walk = (d: string): void => {
    for (const entry of readdirSync(d, { withFileTypes: true })) {
      const p = join(d, entry.name);
      if (entry.isDirectory()) walk(p);
      else out.push(p);
    }
  };
  walk(dir);
  return out.sort();
}

test("a decision only in a worktree is found as missing, imported into the overlay, and the source is untouched", () => {
  const { root, priv, wt, wtJson } = fixture();
  // A second worktree with no .hunch at all: scanning must not create one.
  const bare = join(tmp("hunch-strays-wt2-"), "bare");
  git(root, "worktree", "add", "-q", "-b", "bare", bare);
  wtJson.put("decisions", DEC("dec_a"));
  const store = open(root, priv);
  try {
    const scan = findStrays(store, root);
    assert.equal(scan.home, store.privateDir);
    assert.equal(scan.refused, undefined);
    assert.equal(scan.strays.length, 1);
    const [stray] = scan.strays;
    assert.equal(stray.kind, "decisions");
    assert.equal(stray.id, "dec_a");
    assert.equal(stray.status, "missing");
    assert.equal(stray.source, join(wt, ".hunch", "decisions", "dec_a.json"));
    assert.ok(stray.record);
    assert.equal(existsSync(join(bare, ".hunch")), false, "the scan created a .hunch dir in a checkout");
    const before = readFileSync(stray.source);

    const result = importStrays(store, scan);
    assert.equal(result.imported.length, 1);
    assert.deepEqual(result.quarantined, []);
    assert.deepEqual(result.failed, []);
    assert.equal(store.getPrivateRec("decisions", "dec_a")?.id, "dec_a");
    assert.deepEqual(readFileSync(stray.source), before);

    assert.equal(findStrays(store, root).strays.length, 0);
  } finally {
    store.close();
  }
});

test("a committed record is not a stray (git keeps it; migrate moves it); an untracked one beside it is", () => {
  const root = tmp("hunch-strays-tracked-");
  git(root, "init", "-q", "-b", "main");
  setPolicy(root, { home: "overlay" });
  const rootJson = new JsonStore(hunchPaths(root));
  rootJson.ensureDirs();
  rootJson.put("decisions", DEC("dec_pub"));
  git(root, "add", "-f", ".hunch");
  git(root, "commit", "-q", "-m", "legacy public decision");
  const wt = join(tmp("hunch-strays-tracked-wt-"), "feature");
  git(root, "worktree", "add", "-q", "-b", "feature", wt);
  rootJson.put("decisions", DEC("dec_loose"));
  const priv = tmp("hunch-strays-tracked-priv-");
  const store = open(root, priv);
  try {
    const scan = findStrays(store, root);
    assert.deepEqual(scan.strays.map((s) => `${s.checkout === root ? "root" : "wt"}:${s.id}:${s.status}`), ["root:dec_loose:missing"]);
    assert.equal(scan.tracked, 1, "the committed decision is counted once (the root's; migrate moves it), not reported as a stray");
    // A committed file edited in place: git refuses to remove that worktree, so it is not a stray either.
    writeFileSync(join(wt, ".hunch", "decisions", "dec_pub.json"), JSON.stringify(DEC("dec_pub", "edited")));
    assert.deepEqual(findStrays(store, root).strays.map((s) => s.id), ["dec_loose"]);
  } finally {
    store.close();
  }
});

test("the same record already in the overlay is not a stray, nor is a misnamed identical copy", () => {
  const { root, priv, wt, wtJson } = fixture();
  const store = open(root, priv);
  try {
    store.putPrivate("decisions", DEC("dec_b"));
    wtJson.put("decisions", DEC("dec_b"));
    const dir = join(wt, ".hunch", "decisions");
    writeFileSync(join(dir, "dec_b.orig.json"), readFileSync(join(dir, "dec_b.json")));
    assert.deepEqual(findStrays(store, root).strays, []);
  } finally {
    store.close();
  }
});

test("a record that differs from its overlay copy is quarantined byte-for-byte and the overlay copy is kept", () => {
  const { root, priv, wt, wtJson } = fixture();
  const store = open(root, priv);
  try {
    store.putPrivate("decisions", DEC("dec_c", "overlay"));
    wtJson.put("decisions", DEC("dec_c", "worktree"));
    const scan = findStrays(store, root);
    assert.equal(scan.strays.length, 1);
    assert.equal(scan.strays[0].status, "differs");
    assert.equal(scan.strays[0].id, "dec_c");

    const result = importStrays(store, scan);
    assert.deepEqual(result.imported, []);
    assert.deepEqual(result.failed, []);
    assert.equal(result.quarantined.length, 1);
    const { file } = result.quarantined[0];
    assert.ok(file.startsWith(join(priv, "strays", "differs", "decisions")), file);
    assert.match(file, /feature-[0-9a-f]{12}-dec_c\.json$/);
    assert.deepEqual(readFileSync(file), readFileSync(join(wt, ".hunch", "decisions", "dec_c.json")));
    assert.equal(store.getPrivateRec("decisions", "dec_c")?.title, "overlay");
  } finally {
    store.close();
  }
});

test("corrupt, schema-invalid and non-UTF-8 files are invalid strays, quarantined, sources untouched", () => {
  const { root, priv, wt } = fixture();
  const dir = join(wt, ".hunch", "decisions");
  writeFileSync(join(dir, "broken.json"), "{not json");
  writeFileSync(join(dir, "dec_bad.json"), JSON.stringify({ id: "dec_bad", title: 1 }));
  const binary = Buffer.from([0x7b, 0xff, 0xfe, 0x00, 0x80, 0x7d]);
  writeFileSync(join(dir, "binary.json"), binary);
  writeFileSync(join(dir, "empty.json"), ""); // a merge tombstone is not a stray
  const before = new Map(readdirSync(dir).map((n) => [n, readFileSync(join(dir, n))]));
  const store = open(root, priv);
  try {
    const scan = findStrays(store, root);
    assert.deepEqual(
      scan.strays.map((s) => [s.status, s.id, s.source]),
      [
        ["invalid", null, join(dir, "binary.json")],
        ["invalid", null, join(dir, "broken.json")],
        ["invalid", "dec_bad", join(dir, "dec_bad.json")],
      ],
    );
    const result = importStrays(store, scan);
    assert.deepEqual(result.failed, []);
    assert.equal(result.quarantined.length, 3);
    for (const { stray, file } of result.quarantined) {
      assert.ok(file.startsWith(join(priv, "strays", "invalid", "decisions")), file);
      assert.deepEqual(readFileSync(file), readFileSync(stray.source));
    }
    for (const [name, bytes] of before) assert.deepEqual(readFileSync(join(dir, name)), bytes, name);
    assert.equal(store.getPrivateRec("decisions", "dec_bad"), undefined);
  } finally {
    store.close();
  }
});

test("a single-file kind whose index holds entries the loader skipped is one invalid stray", () => {
  const { root, priv, wt } = fixture();
  const file = join(wt, ".hunch", "entities", "index.json");
  writeFileSync(file, JSON.stringify([{ id: "customer:bad" }]));
  const store = open(root, priv);
  try {
    assert.equal(store.captureHome(false, "entities"), "private");
    const scan = findStrays(store, root);
    assert.deepEqual(scan.strays.map((s) => [s.kind, s.status, s.id, s.source]), [["entities", "invalid", null, file]]);
  } finally {
    store.close();
  }
});

test("a kind the policy homes publicly is never a stray", () => {
  const { root, priv, wtJson } = fixture();
  wtJson.put("constraints", CON("con_x"));
  const store = open(root, priv);
  try {
    assert.equal(store.captureHome(false, "constraints"), "public");
    assert.deepEqual(findStrays(store, root).strays, []);
  } finally {
    store.close();
  }
});

test("no overlay configured: no home, nothing to scan", () => {
  const { root, wtJson } = fixture();
  wtJson.put("decisions", DEC("dec_d"));
  const store = open(root);
  try {
    assert.deepEqual(findStrays(store, root), { home: null, strays: [] });
  } finally {
    store.close();
  }
});

test("an unreadable memory policy refuses the scan", () => {
  const { root, priv, wtJson } = fixture();
  wtJson.put("decisions", DEC("dec_e"));
  writeFileSync(join(root, ".hunch", "config.json"), "{corrupt");
  const store = open(root, priv);
  try {
    assert.ok(store.memoryPolicyProblem);
    const scan = findStrays(store, root);
    assert.equal(scan.home, null);
    assert.equal(scan.refused, store.memoryPolicyProblem);
    assert.deepEqual(scan.strays, []);
  } finally {
    store.close();
  }
});

test("importing twice writes no duplicate quarantine files and reports no error", () => {
  const { root, priv, wt, wtJson } = fixture();
  const store = open(root, priv);
  try {
    store.putPrivate("decisions", DEC("dec_f", "overlay"));
    wtJson.put("decisions", DEC("dec_f", "worktree"));
    writeFileSync(join(wt, ".hunch", "decisions", "junk.json"), "nope");
    const first = importStrays(store, findStrays(store, root));
    assert.deepEqual(first.failed, []);
    assert.equal(first.quarantined.length, 2);
    const files = filesUnder(join(priv, "strays"));
    assert.equal(files.length, 2);
    const second = importStrays(store, findStrays(store, root));
    assert.deepEqual(second.failed, []);
    assert.deepEqual(second.quarantined.map((q) => q.file).sort(), first.quarantined.map((q) => q.file).sort());
    assert.deepEqual(filesUnder(join(priv, "strays")), files);
  } finally {
    store.close();
  }
});

test("a strays/ dir in the overlay does not change what the overlay loads", () => {
  const { root, priv, wt, wtJson } = fixture();
  const store = open(root, priv);
  try {
    store.putPrivate("decisions", DEC("dec_g", "overlay"));
    const overlay = new JsonStore(hunchPathsForDir(priv));
    const load = () => Object.fromEntries(ENTITY_KINDS.map((k) => [k, overlay.loadAll(k).map((r) => (r as { id: string }).id)]));
    const before = load();
    wtJson.put("decisions", DEC("dec_g", "worktree"));
    writeFileSync(join(wt, ".hunch", "decisions", "junk.json"), "nope");
    const result = importStrays(store, findStrays(store, root));
    assert.equal(result.quarantined.length, 2);
    assert.ok(existsSync(join(priv, "strays")));
    overlay.clearCache();
    assert.deepEqual(load(), before);
    // A freshly opened store reads the overlay (strays/ included) without complaint.
    const again = open(root, priv);
    try {
      assert.equal(again.getPrivateRec("decisions", "dec_g")?.title, "overlay");
    } finally {
      again.close();
    }
  } finally {
    store.close();
  }
});

test("a missing decision whose topic already has a live decision is quarantined as a collision, never written", () => {
  const { root, priv, wtJson } = fixture();
  const topical = (id: string): Decision => ({ ...DEC(id), topic: "auth.session" } as Decision);
  wtJson.put("decisions", topical("dec_new"));
  const store = open(root, priv);
  try {
    store.putPrivate("decisions", topical("dec_cur") as never);
    const scan = findStrays(store, root);
    assert.deepEqual(scan.strays.map((s) => [s.status, s.id]), [["missing", "dec_new"]]);
    const result = importStrays(store, scan);
    assert.deepEqual(result.imported, []);
    assert.deepEqual(result.failed, []);
    assert.equal(result.quarantined.length, 1);
    assert.match(result.quarantined[0]!.file, /[\\/]strays[\\/]collision[\\/]decisions[\\/]/);
    assert.equal(store.getPrivateRec("decisions", "dec_new"), undefined, "the second live decision was written");
    assert.deepEqual(liveForTopic(store.recs("decisions"), "auth.session").map((d) => d.id), ["dec_cur"]);
  } finally {
    store.close();
  }
});

test("a record held only under a misnamed file names that file as its source, so it can be rescued", () => {
  const { root, priv, wt } = fixture();
  const misnamed = join(wt, ".hunch", "decisions", "dec_x.orig.json");
  writeFileSync(misnamed, `${JSON.stringify(DEC("dec_x", "worktree copy"), null, 2)}\n`);
  const store = open(root, priv);
  try {
    store.putPrivate("decisions", DEC("dec_x", "overlay copy") as never);
    const scan = findStrays(store, root);
    assert.deepEqual(scan.strays.map((s) => [s.status, s.id, s.source]), [["differs", "dec_x", misnamed]]);
    const result = importStrays(store, scan);
    assert.deepEqual(result.failed, []);
    assert.equal(result.quarantined.length, 1);
    assert.deepEqual(readFileSync(result.quarantined[0]!.file), readFileSync(misnamed));
  } finally {
    store.close();
  }
});

test("a file the containment check refuses is its own invalid stray; its siblings are still found and imported", () => {
  const { root, priv, wt, wtJson } = fixture();
  wtJson.put("decisions", DEC("dec_1"));
  const original = join(tmp("hunch-strays-link-"), "dec_old.json");
  writeFileSync(original, `${JSON.stringify(DEC("dec_old"), null, 2)}\n`);
  linkSync(original, join(wt, ".hunch", "decisions", "dec_old.json"));
  const store = open(root, priv);
  try {
    const scan = findStrays(store, root);
    assert.deepEqual(scan.strays.map((s) => [s.status, s.id]).sort(), [["invalid", null], ["missing", "dec_1"]]);
    const invalid = scan.strays.find((s) => s.status === "invalid")!;
    assert.equal(invalid.source, join(wt, ".hunch", "decisions", "dec_old.json"));
    const result = importStrays(store, scan);
    assert.equal(store.getPrivateRec("decisions", "dec_1")?.id, "dec_1", "the sibling was rescued");
    assert.equal(result.quarantined.length, 0, "a hard link's bytes are never copied into the overlay");
    assert.equal(result.failed.length, 1);
    assert.match(result.failed[0]!.error, /inspect it by hand/);
  } finally {
    store.close();
  }
});

test("a single-file index the containment check refuses is reported once", () => {
  const { root, priv, wt } = fixture();
  const original = join(tmp("hunch-strays-index-link-"), "index.json");
  writeFileSync(original, "[]\n");
  mkdirSync(join(wt, ".hunch", "entities"), { recursive: true });
  linkSync(original, join(wt, ".hunch", "entities", "index.json"));
  const store = open(root, priv);
  try {
    const scan = findStrays(store, root);
    const index = scan.strays.filter((s) => s.kind === "entities");
    assert.equal(index.length, 1);
    assert.equal(index[0]!.status, "invalid");
    assert.match(index[0]!.note ?? "", /could not read/);
  } finally {
    store.close();
  }
});

test("a worktree record that differs from the repo's public copy of the id is a differing stray, never written over it", () => {
  const { root, priv, wtJson } = fixture();
  new JsonStore(hunchPaths(root)).put("decisions", DEC("dec_pub", "public copy"));
  wtJson.put("decisions", DEC("dec_pub", "worktree copy"));
  const store = open(root, priv);
  try {
    const scan = findStrays(store, root);
    const wtStray = scan.strays.find((s) => s.checkout !== root && s.id === "dec_pub");
    assert.equal(wtStray?.status, "differs");
    importStrays(store, scan);
    assert.equal(store.recs("decisions").find((d) => d.id === "dec_pub")?.title === "worktree copy", false, "the worktree copy shadows the public one");
  } finally {
    store.close();
  }
});
