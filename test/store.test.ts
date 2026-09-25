import { test } from "node:test";
import assert from "node:assert/strict";
import { createRequire, syncBuiltinESMExports } from "node:module";
import { existsSync, mkdirSync, readFileSync, utimesSync, writeFileSync } from "node:fs";
import { hostname } from "node:os";
import { join } from "node:path";
import { spawn, spawnSync } from "node:child_process";
import { tempStore, prov, mkSymbol } from "./helpers.js";
import { openMemoryDb, type DB } from "../src/store/db.js";
import { HunchStore } from "../src/store/hunchStore.js";
import { hunchPaths } from "../src/core/paths.js";

const require = createRequire(import.meta.url);
const fs = require("node:fs") as typeof import("node:fs");

function seed() {
  const ctx = tempStore();
  const { store } = ctx;
  store.json.replaceAll("symbols", [
    mkSymbol("sym_a", "src/auth/session.ts", "verifySession", { metrics: { loc: 40, churn_90d: 14, bug_count: 3, fan_in: 2, fan_out: 0 } }),
    mkSymbol("sym_b", "src/billing/charge.ts", "charge", { calls: ["sym_a"], metrics: { loc: 30, churn_90d: 1, bug_count: 0, fan_in: 0, fan_out: 1 } }),
    mkSymbol("sym_c", "src/api/mw.ts", "mw", { calls: ["sym_a"], metrics: { loc: 10, churn_90d: 0, bug_count: 0, fan_in: 0, fan_out: 1 } }),
  ]);
  store.json.replaceAll("edges", [
    { id: "e1", from: "sym_b", to: "sym_a", type: "calls", reason: "", strength: 1, provenance: prov() },
    { id: "e2", from: "sym_c", to: "sym_a", type: "calls", reason: "", strength: 1, provenance: prov() },
  ] as never);
  store.json.put("decisions", { id: "dec_1", title: "Sessions in Redis", status: "accepted", context: "Token leak forced logout impossible", decision: "Server-side sessions", consequences: [], alternatives_rejected: [], related_components: [], related_files: ["src/auth/session.ts"], supersedes: null, caused_by_bug: "bug_1", commit: null, provenance: prov(0.95), date: "2026-05-30T12:00:00Z" } as never);
  store.json.put("bugs", { id: "bug_1", title: "Leaked token usable after reset", symptom: "old token authenticated", root_cause: "stateless JWT not revocable", severity: "critical", status: "fixed", affected_files: ["src/auth/session.ts"], affected_symbols: ["sym_a"], lineage: { introduced_commit: "f00", detected: "t", fixed_commit: "a1b", recurrence_of: null, spawned_decision: "dec_1", spawned_constraint: "con_1" }, provenance: prov(0.88) } as never);
  store.json.put("constraints", { id: "con_1", type: "security", statement: "Revocation must be server-side", scope: ["src/auth/**"], severity: "blocking", enforcement: "advisory_v1", rationale: "from bug_1", source_decision: "dec_1", violations: [], provenance: prov(0.9) } as never);
  store.reindex();
  return ctx;
}

test("reindex counts every entity", () => {
  const { store, cleanup } = seed();
  const { counts } = store.reindex();
  assert.equal(counts.symbols, 3);
  assert.equal(counts.decisions, 1);
  assert.equal(counts.constraints, 1);
  cleanup();
});

test("FTS search finds decision + constraint by topic", () => {
  const { store, cleanup } = seed();
  const refs = store.search("revocation redis").map((h) => h.ref);
  assert.ok(refs.includes("dec_1"));
  cleanup();
});

test("why() returns decisions/bugs/constraints for a file", () => {
  const { store, cleanup } = seed();
  const w = store.why("src/auth/session.ts");
  assert.deepEqual(w.decisions.map((d) => d.id), ["dec_1"]);
  assert.deepEqual(w.bugs.map((b) => b.id), ["bug_1"]);
  assert.deepEqual(w.constraints.map((c) => c.id), ["con_1"]);
  cleanup();
});

test("a 0-byte per-record file (merge-driver tombstone) loads as absent — no corrupt warning, no record (issue #37)", () => {
  const { store, root, cleanup } = seed();
  writeFileSync(join(root, ".hunch", "decisions", "dec_tombstone.json"), "");
  const warns: string[] = [];
  const orig = console.warn;
  console.warn = (msg: string) => { warns.push(String(msg)); };
  try {
    const ids = store.json.loadAll("decisions").map((d) => d.id);
    assert.ok(ids.includes("dec_1"), "real records still load");
    assert.ok(!ids.includes("dec_tombstone"), "the tombstone contributes no record");
    assert.deepEqual(warns.filter((w) => w.includes("tombstone")), [], "sanity");
    assert.deepEqual(warns.filter((w) => w.includes("corrupt")), [], "no corrupt-warning treadmill for a tombstone");
  } finally {
    console.warn = orig;
    cleanup();
  }
});

/** A decision fixture written straight to disk under an arbitrary file name. */
function writeDecisionFile(root: string, name: string, id: string, title: string): void {
  writeFileSync(join(root, ".hunch", "decisions", name), JSON.stringify({
    id, title, status: "accepted", context: "", decision: "x", consequences: [], alternatives_rejected: [],
    related_components: [], related_files: [], supersedes: null, caused_by_bug: null, commit: null,
    provenance: prov(0.9), date: "2026-06-01T00:00:00Z",
  }));
}

test("a stray copy of a record file loads once, from its canonical <id>.json (issue #291)", () => {
  const { store, root, cleanup } = seed();
  writeDecisionFile(root, "dec_stray.json", "dec_stray", "canonical");
  writeDecisionFile(root, "dec_stray_BASE_1234.json", "dec_stray", "aborted mergetool copy");
  const warns: string[] = [];
  const orig = console.warn;
  console.warn = (msg: string) => { warns.push(String(msg)); };
  try {
    const hits = store.json.loadAll("decisions").filter((d) => d.id === "dec_stray");
    assert.equal(hits.length, 1, "the stray copy contributes no second record");
    assert.equal(hits[0]?.title, "canonical", "the canonical file wins");
    assert.ok(warns.some((w) => w.includes("stray copy") && w.includes("dec_stray_BASE_1234.json")));
  } finally {
    console.warn = orig;
    cleanup();
  }
});

test("reindex survives a stray copy instead of failing on a duplicate primary key (issue #291)", () => {
  const { store, root, cleanup } = seed();
  writeDecisionFile(root, "dec_stray.json", "dec_stray", "canonical");
  writeDecisionFile(root, "dec_stray (1).json", "dec_stray", "cloud-sync conflict copy");
  const orig = console.warn;
  console.warn = () => {};
  try {
    const { counts } = store.reindex();
    assert.equal(counts.decisions, 2, "dec_1 + dec_stray, counted once each");
  } finally {
    console.warn = orig;
    cleanup();
  }
});

test("a misnamed record with NO canonical file is kept, exactly once (con_947c578b2c, issue #291)", () => {
  const { store, root, cleanup } = seed();
  writeDecisionFile(root, "dec_orphan.orig.json", "dec_orphan", "only home");
  writeDecisionFile(root, "dec_orphan_BASE_9.json", "dec_orphan", "second misnamed copy");
  const warns: string[] = [];
  const orig = console.warn;
  console.warn = (msg: string) => { warns.push(String(msg)); };
  try {
    const hits = store.json.loadAll("decisions").filter((d) => d.id === "dec_orphan");
    assert.equal(hits.length, 1, "never two records with the same id");
    assert.equal(hits[0]?.title, "only home", "deterministic: the first sorted name wins");
    assert.ok(warns.some((w) => w.includes("expected file name dec_orphan.json")));
  } finally {
    console.warn = orig;
    cleanup();
  }
});

test("why() matches on path segments, never a bare suffix — 'io.ts' must not pull 'scenario.ts' records (issue #32)", () => {
  const { store, cleanup } = seed();
  store.json.put("symbols", mkSymbol("sym_scen", "src/x/scenario.ts", "scen", { metrics: { loc: 5, churn_90d: 0, bug_count: 0, fan_in: 0, fan_out: 0 } }) as never);
  store.json.put("decisions", { id: "dec_scen", title: "Scenario decision", status: "accepted", context: "", decision: "x", consequences: [], alternatives_rejected: [], related_components: [], related_files: ["src/x/scenario.ts"], supersedes: null, caused_by_bug: null, commit: null, provenance: prov(0.9), date: "2026-06-01T00:00:00Z" } as never);
  store.reindex();
  const w = store.why("io.ts"); // "scenario.ts".endsWith("io.ts") is true — must NOT match
  assert.deepEqual(w.symbols.map((s) => s.id), [], "no symbol matches a bare suffix");
  assert.deepEqual(w.decisions.map((d) => d.id), [], "no decision matches a bare suffix");
  // Segment-anchored suffix still works: the intended convenience is intact.
  const anchored = store.why("x/scenario.ts");
  assert.deepEqual(anchored.decisions.map((d) => d.id), ["dec_scen"]);
  cleanup();
});

test("why() matches an existing full path exactly, never a same-basename suffix — root index.ts must not pull nested/index.ts's records (issue #299)", () => {
  const { store, cleanup } = seed();
  // Deliberately no real files on disk: "is this a real indexed path" must be
  // answerable from already-loaded graph data alone, never the filesystem — a
  // deleted-but-still-indexed path must answer the same either way (issue #299).
  store.json.put("symbols", mkSymbol("sym_root_idx", "index.ts", "root", { kind: "variable" }) as never);
  store.json.put("symbols", mkSymbol("sym_nested_idx", "vscode-extension/index.ts", "nested", { kind: "variable" }) as never);
  store.json.put("constraints", { id: "con_nested", type: "correctness", statement: "nested rule", scope: ["vscode-extension/index.ts"], severity: "blocking", enforcement: "advisory_v1", rationale: "x", source_decision: null, violations: [], provenance: prov(0.9) } as never);
  store.reindex();
  const wRoot = store.why("index.ts");
  assert.deepEqual(wRoot.symbols.map((s) => s.id), ["sym_root_idx"], "root index.ts must not resolve the nested symbol");
  assert.deepEqual(wRoot.constraints.map((c) => c.id), [], "root index.ts must not inherit the nested-scoped constraint");
  const wNested = store.why("vscode-extension/index.ts");
  assert.deepEqual(wNested.symbols.map((s) => s.id), ["sym_nested_idx"]);
  assert.deepEqual(wNested.constraints.map((c) => c.id), ["con_nested"]);
  cleanup();
});

test("why() does not suffix-leak onto a REAL working-tree file the index cannot see — zero symbols, no covering component (issue #334)", () => {
  const { store, root, cleanup } = seed();
  // The gap left by #299: "is this a real path" was answered from graph data
  // alone, so a real comment-only root file (no tree-sitter symbols, no
  // component glob covering it) looked unreal and fell to the suffix tier,
  // serving a/empty.ts's records. The working tree is the last-resort answer.
  mkdirSync(join(root, "a"), { recursive: true });
  writeFileSync(join(root, "empty.ts"), "// only a comment — no symbols at all\n");
  writeFileSync(join(root, "a", "empty.ts"), "export function nestedEmpty(){ return 1; }\n");
  store.json.put("symbols", mkSymbol("sym_nested_empty", "a/empty.ts", "nestedEmpty") as never);
  store.json.put("constraints", { id: "con_nested_empty", type: "correctness", statement: "nested rule", scope: ["a/empty.ts"], severity: "blocking", enforcement: "advisory_v1", rationale: "x", source_decision: null, violations: [], provenance: prov(0.9) } as never);
  store.reindex();

  const wRoot = store.why("empty.ts");
  assert.deepEqual(wRoot.symbols.map((s) => s.id), [], "a real root file with no symbols must return none, not a/empty.ts's");
  assert.deepEqual(wRoot.constraints.map((c) => c.id), [], "and must not inherit the nested-scoped constraint");
  // The nested file still answers for itself.
  assert.deepEqual(store.why("a/empty.ts").symbols.map((s) => s.id), ["sym_nested_empty"]);
  // A DIRECTORY target keeps behaving exactly as it does on origin/main: it is
  // not a file, so the suffix tier is still available to it.
  assert.deepEqual(store.why("a").symbols.map((s) => s.id), [], "a bare directory name matches no symbol file, as before");
  cleanup();
});

test("replaceAll writes new records BEFORE deleting stale ones — a mid-operation failure never empties the kind (issue #30)", () => {
  const { store, root, cleanup } = seed();
  store.json.put("decisions", { id: "dec_keeper", title: "keeper", status: "accepted", context: "", decision: "", consequences: [], alternatives_rejected: [], related_components: [], related_files: [], supersedes: null, caused_by_bug: null, commit: null, provenance: prov(0.9), date: "2026-06-01T00:00:00Z" } as never);
  // Second record is oversized: with write-first ordering the operation throws
  // DURING the write phase, before any delete ran — every pre-existing record
  // must still be on disk (the old delete-all-first ordering left the kind empty).
  const huge = "x".repeat(9 * 1024 * 1024);
  assert.throws(() => store.json.replaceAll("decisions", [
    { id: "dec_new_ok", title: "ok", status: "accepted", context: "", decision: "", consequences: [], alternatives_rejected: [], related_components: [], related_files: [], supersedes: null, caused_by_bug: null, commit: null, provenance: prov(0.9), date: "2026-06-01T00:00:00Z" },
    { id: "dec_new_huge", title: "huge", status: "accepted", context: huge, decision: "", consequences: [], alternatives_rejected: [], related_components: [], related_files: [], supersedes: null, caused_by_bug: null, commit: null, provenance: prov(0.9), date: "2026-06-01T00:00:00Z" },
  ] as never));
  const ids = store.json.loadAll("decisions").map((d) => d.id);
  assert.ok(ids.includes("dec_1"), "pre-existing record survives the failed replace");
  assert.ok(ids.includes("dec_keeper"), "pre-existing record survives the failed replace");
  // And a SUCCESSFUL replace still removes stale records and lands the new set.
  store.json.replaceAll("decisions", [
    { id: "dec_only", title: "only", status: "accepted", context: "", decision: "", consequences: [], alternatives_rejected: [], related_components: [], related_files: [], supersedes: null, caused_by_bug: null, commit: null, provenance: prov(0.9), date: "2026-06-01T00:00:00Z" },
  ] as never);
  assert.deepEqual(store.json.loadAll("decisions").map((d) => d.id), ["dec_only"]);
  void root;
  cleanup();
});

test("single-file RMW lock: a stale .rmw-lock is taken over and the write lands; the lock is released after (issue #35)", () => {
  const { store, root, cleanup } = seed();
  const lock = join(root, ".hunch", "edges", ".rmw-lock");
  mkdirSync(lock, { recursive: true });
  const old = new Date(Date.now() - 60_000);
  utimesSync(lock, old, old); // provably ownerless — every RMW holds it for milliseconds
  store.json.put("edges", { id: "e_lock", from: "sym_a", to: "sym_b", type: "calls", reason: "", strength: 1, provenance: prov() } as never);
  assert.ok(store.json.loadAll("edges").some((e) => e.id === "e_lock"), "the write proceeded through the stale lock");
  assert.equal(existsSync(lock), false, "the lock is released after the write");
  cleanup();
});

test("single-file RMW lock: a live lock is a refusal after timeout, never an unlocked write", () => {
  const { store, root, cleanup } = seed();
  const lock = join(root, ".hunch", "edges", ".rmw-lock");
  mkdirSync(lock, { recursive: true });
  // A legacy record: our own live pid, no nonce and no token. Nothing disproves
  // it, so it is authoritative however old the directory looks (issue #293).
  writeFileSync(join(lock, "owner.tmp.json"), JSON.stringify({ pid: process.pid, host: hostname() }));
  const old = new Date(Date.now() - 60_000);
  utimesSync(lock, old, old);
  try {
    assert.throws(() => store.json.put("edges", { id: "e_live_lock", from: "sym_a", to: "sym_b", type: "calls", reason: "", strength: 1, provenance: prov() } as never), /timed out acquiring the edges index lock/);
    assert.equal(existsSync(lock), true, "the contending lock remains owned by its holder");
    assert.equal(store.json.loadAll("edges").some((e) => e.id === "e_live_lock"), false, "the refused write does not publish an unlocked index update");
  } finally { cleanup(); }
});

test("single-file rebuild: replaceAll honors the RMW lock instead of publishing over a live update", () => {
  const { store, root, cleanup } = seed();
  const lock = join(root, ".hunch", "edges", ".rmw-lock");
  mkdirSync(lock, { recursive: true });
  try {
    assert.throws(() => store.json.replaceAll("edges", [
      { id: "e_rebuild", from: "sym_a", to: "sym_b", type: "calls", reason: "", strength: 1, provenance: prov() },
    ] as never), /timed out acquiring the edges index lock/);
    assert.deepEqual(store.json.loadAll("edges").map((e) => e.id).sort(), ["e1", "e2"], "a refused rebuild leaves the index unchanged");
    assert.equal(existsSync(lock), true, "the contending lock remains owned by its holder");
  } finally { cleanup(); }
});

for (const kind of ["hardlink", "oversized"] as const) test(`single-file RMW lock refuses ${kind} ownership metadata`, () => {
  const { store, root, cleanup } = seed();
  const lock = join(root, ".hunch", "edges", ".rmw-lock");
  mkdirSync(lock);
  const owner = join(lock, "owner.tmp.json");
  if (kind === "hardlink") {
    const outside = join(root, "foreign-owner.json");
    writeFileSync(outside, "{}");
    fs.linkSync(outside, owner);
  } else writeFileSync(owner, " ".repeat(8192));
  const old = new Date(Date.now() - 60_000);
  utimesSync(lock, old, old);
  try {
    assert.throws(() => store.json.replaceAll("edges", []), /unsafe|unreadable/);
    assert.deepEqual(store.json.loadAll("edges").map((e) => e.id).sort(), ["e1", "e2"]);
    assert.equal(existsSync(owner), true, "unsafe ownership never licenses removal of another lock");
  } finally { cleanup(); }
});

// Windows needs Developer Mode or SeCreateSymbolicLinkPrivilege for symlinkSync.
test("single-file RMW lock: a SYMLINKED .rmw-lock is refused, never age-removed", { skip: process.platform === "win32" }, () => {
  const { store, root, cleanup } = seed();
  const lock = join(root, ".hunch", "edges", ".rmw-lock");
  const elsewhere = join(root, "elsewhere-lock");
  mkdirSync(elsewhere);
  fs.symlinkSync(elsewhere, lock);
  // No owner file inside the link's target, so readRmwOwner's reader throws the
  // containment refusal ("unsafe store artifact path … symlink"). The ENOENT
  // excuse is for a lock that was RELEASED mid-read, so it may not cover this:
  // excusing it would make an aged symlink removable, which main never allowed.
  const old = new Date(Date.now() - 30_000);
  utimesSync(elsewhere, old, old);
  fs.lutimesSync(lock, old, old); // age the LINK itself too: lstat reports the link's mtime, and that is what the age rule reads
  try {
    assert.throws(
      () => store.json.put("edges", { id: "e_symlinked", from: "sym_a", to: "sym_b", type: "calls", reason: "", strength: 1, provenance: prov() } as never),
      /unsafe/,
    );
    assert.equal(fs.lstatSync(lock).isSymbolicLink(), true, "the symlink is still there — refusal, not removal");
    assert.equal(store.json.loadAll("edges").some((e) => e.id === "e_symlinked"), false);
  } finally { cleanup(); }
});

test("single-file RMW lock: a lock whose pid was RECYCLED is reclaimed by AGE, not trusted forever (issue #293)", () => {
  const { store, root, cleanup } = seed();
  const lock = join(root, ".hunch", "edges", ".rmw-lock");
  mkdirSync(lock, { recursive: true });
  // The container-restart shape: the record names OUR pid on OUR host, so
  // `kill(pid, 0)` succeeds forever and main never took the lock over at all
  // (issue #287's deadlock). The NONCE is not one this process holds, so the
  // lock is not OURS — but that alone does not prove its writer dead: "our pid"
  // may be a live neighbour's in another pid space sharing our hostname and
  // volume (two containers on linux; a WSL2 / Docker Desktop linux guest off
  // linux). So the AGE rule decides it, identically on every platform: a FRESH
  // lock is still refused, and only one older than the 10 s `.rmw-lock` window
  // (60 s for `write.lock`) is taken over.
  const ownerFile = join(lock, "owner.tmp.json");
  const edge = (id: string) => ({ id, from: "sym_a", to: "sym_b", type: "calls", reason: "", strength: 1, provenance: prov() }) as never;
  writeFileSync(ownerFile, JSON.stringify({ pid: process.pid, host: hostname(), nonce: "predecessor" }));
  try {
    assert.throws(
      () => store.json.put("edges", edge("e_fresh_reuse")),
      /timed out acquiring the edges index lock/,
      "a FRESH own-pid record may be a live neighbour's lock",
    );
    assert.equal(existsSync(lock), true, "nothing is removed while only the pid says 'alive'");
    assert.deepEqual(JSON.parse(readFileSync(ownerFile, "utf8")).nonce, "predecessor", "the predecessor's ownership record is untouched");
    assert.equal(store.json.loadAll("edges").some((e) => e.id === "e_fresh_reuse"), false);
    // Back-date the lock DIRECTORY past the 10 s window: the age rule takes it.
    const old = new Date(Date.now() - 30_000);
    utimesSync(lock, old, old);
    store.json.put("edges", edge("e_reuse"));
    assert.ok(store.json.loadAll("edges").some((e) => e.id === "e_reuse"), "the aged recycled-pid lock is taken over and the write lands");
    assert.equal(existsSync(lock), false, "the reclaimed lock is released after the write");
  } finally { cleanup(); }
});

test("single-file RMW lock: a LEGACY own-pid lock with no nonce is NOT reclaimed — nothing disproves it (issue #293)", () => {
  const { store, root, cleanup } = seed();
  const lock = join(root, ".hunch", "edges", ".rmw-lock");
  mkdirSync(lock, { recursive: true });
  // Written by a pre-fix hunch: our own live pid, but no nonce and no token to
  // compare. A live pid is never stolen on a guess, so the write refuses.
  writeFileSync(join(lock, "owner.tmp.json"), JSON.stringify({ pid: process.pid, host: hostname() }));
  const old = new Date(Date.now() - 10 * 60_000);
  utimesSync(lock, old, old);
  try {
    assert.throws(
      () => store.json.put("edges", { id: "e_legacy", from: "sym_a", to: "sym_b", type: "calls", reason: "", strength: 1, provenance: prov() } as never),
      /timed out acquiring the edges index lock/,
    );
    assert.equal(existsSync(lock), true, "the unproven lock is left alone");
    assert.equal(store.json.loadAll("edges").some((e) => e.id === "e_legacy"), false);
  } finally { cleanup(); }
});

test("single-file RMW lock: a LIVE owner's lock back-dated by clock skew is never stolen (issue #293)", async () => {
  const { store, root, cleanup } = seed();
  const lock = join(root, ".hunch", "edges", ".rmw-lock");
  const holder = spawn(process.execPath, ["-e", "setTimeout(()=>{},30000)"], { stdio: "ignore" });
  try {
    mkdirSync(lock, { recursive: true });
    // A live, unrelated same-host pid and no token: authoritative. The reviewer's
    // repro — a filesystem/host clock disagreement, an NTP step or a suspend —
    // back-dates BOTH the lock directory and the ownership file ten minutes.
    // Nothing in the decision may read a clock, so the holder keeps its lock.
    const owner = join(lock, "owner.tmp.json");
    writeFileSync(owner, JSON.stringify({ pid: holder.pid!, host: hostname(), nonce: "held-elsewhere" }));
    const back = new Date(Date.now() - 10 * 60_000);
    utimesSync(owner, back, back);
    utimesSync(lock, back, back);
    assert.throws(
      () => store.json.put("edges", { id: "e_skew", from: "sym_a", to: "sym_b", type: "calls", reason: "", strength: 1, provenance: prov() } as never),
      /timed out acquiring the edges index lock/,
      "a back-dated lock file is not evidence that its live owner is gone",
    );
    assert.equal(existsSync(lock), true, "the live owner's lock survives");
    assert.equal(store.json.loadAll("edges").some((e) => e.id === "e_skew"), false);
  } finally {
    try { holder.kill("SIGKILL"); } catch { /* already gone */ }
    cleanup();
  }
});

test("single-file RMW lock: an owner file that vanishes mid-read is a retry, not a hard failure (issue #293)", () => {
  const { store, root, cleanup } = seed();
  const lock = join(root, ".hunch", "edges", ".rmw-lock");
  mkdirSync(lock, { recursive: true });
  const owner = join(lock, "owner.tmp.json");
  writeFileSync(owner, JSON.stringify({ pid: process.pid, host: hostname(), nonce: "vanishing" }));
  const old = new Date(Date.now() - 60_000);
  utimesSync(lock, old, old);
  // A NORMAL release lands between readStoreArtifact's own lstat and the bounded
  // reader's: the reader returns null and readStoreArtifact reports "unsafe or
  // unreadable" for a file that simply went away. A healthy waiter must retry,
  // not throw — the flake behind the multi-process test. Simulated by deleting
  // the lock the moment the safe reader canonicalizes the owner file.
  const originalRealpathSync = fs.realpathSync;
  let hits = 0;
  const patched = ((path: Parameters<typeof originalRealpathSync>[0], options?: never) => {
    // Hit 1 is readStoreArtifact's own containment check (its lstat has already
    // passed); hit 2 is the bounded reader's, i.e. exactly the window a release
    // slips through.
    if (String(path).replace(/\\/g, "/").endsWith(".rmw-lock/owner.tmp.json") && ++hits === 2) {
      fs.realpathSync = originalRealpathSync;
      syncBuiltinESMExports();
      fs.rmSync(lock, { recursive: true, force: true });
    }
    return originalRealpathSync(path, options);
  }) as typeof fs.realpathSync;
  patched.native = originalRealpathSync.native;
  fs.realpathSync = patched;
  syncBuiltinESMExports();
  try {
    store.json.put("edges", { id: "e_vanished", from: "sym_a", to: "sym_b", type: "calls", reason: "", strength: 1, provenance: prov() } as never);
    // Without this the test would still pass if the patch never fired at all
    // (a rename of the owner file, a changed read path) and the write simply
    // took the ordinary stale-by-age route — proving nothing about the window.
    assert.ok(hits >= 2, `the simulated mid-read release must actually have fired (hits=${hits})`);
    assert.ok(store.json.loadAll("edges").some((e) => e.id === "e_vanished"), "the waiter retried and acquired the freed lock");
  } finally {
    fs.realpathSync = originalRealpathSync;
    syncBuiltinESMExports();
    cleanup();
  }
});

test("single-file RMW lock: a release AND re-acquire mid-read is a retry, not a hard failure (issue #293)", () => {
  const { store, root, cleanup } = seed();
  const lock = join(root, ".hunch", "edges", ".rmw-lock");
  mkdirSync(lock, { recursive: true });
  const owner = join(lock, "owner.tmp.json");
  writeFileSync(owner, JSON.stringify({ pid: process.pid, host: hostname(), nonce: "releasing" }));
  const old = new Date(Date.now() - 60_000);
  utimesSync(lock, old, old);
  // CI run 35843843780: the holder releases inside the waiter's read window and
  // a NEXT holder re-acquires before the waiter re-checks, so the owner file is
  // present again and the race-induced refusal used to surface as
  // "unsafe store artifact path … owner.tmp.json". The successor here is a
  // same-host process that has already exited, so once the waiter re-reads it
  // judges the successor dead and the write lands.
  const successor = spawnSync(process.execPath, ["-e", ""]).pid;
  const originalRealpathSync = fs.realpathSync;
  let hits = 0;
  const patched = ((path: Parameters<typeof originalRealpathSync>[0], options?: never) => {
    if (String(path).replace(/\\/g, "/").endsWith(".rmw-lock/owner.tmp.json") && ++hits === 2) {
      fs.realpathSync = originalRealpathSync;
      syncBuiltinESMExports();
      fs.rmSync(lock, { recursive: true, force: true });
      mkdirSync(lock);
      writeFileSync(owner, JSON.stringify({ pid: successor, host: hostname(), nonce: "successor" }));
    }
    return originalRealpathSync(path, options);
  }) as typeof fs.realpathSync;
  patched.native = originalRealpathSync.native;
  fs.realpathSync = patched;
  syncBuiltinESMExports();
  try {
    store.json.put("edges", { id: "e_reacquired", from: "sym_a", to: "sym_b", type: "calls", reason: "", strength: 1, provenance: prov() } as never);
    assert.ok(hits >= 2, `the simulated release + re-acquire must actually have fired (hits=${hits})`);
    assert.ok(store.json.loadAll("edges").some((e) => e.id === "e_reacquired"), "the waiter re-read the successor's owner and acquired the lock");
  } finally {
    fs.realpathSync = originalRealpathSync;
    syncBuiltinESMExports();
    cleanup();
  }
});

test("single-file RMW lock: a live .reclaim claim blocks takeover; a stranded one is cleared (issue #293)", () => {
  const { store, root, cleanup } = seed();
  const lock = join(root, ".hunch", "edges", ".rmw-lock");
  const claim = `${lock}.reclaim`;
  mkdirSync(lock, { recursive: true });
  const old = new Date(Date.now() - 60_000);
  utimesSync(lock, old, old); // provably ownerless: stale by age
  mkdirSync(claim);
  const edge = (id: string) => ({ id, from: "sym_a", to: "sym_b", type: "calls", reason: "", strength: 1, provenance: prov() }) as never;
  try {
    assert.throws(
      () => store.json.put("edges", edge("e_claimed")),
      /timed out acquiring the edges index lock/,
      "another contender holds the claim: this one must not remove the lock",
    );
    assert.equal(existsSync(lock), true, "only the claim holder removes the stale lock");
    assert.equal(store.json.loadAll("edges").some((e) => e.id === "e_claimed"), false);
    // A claimer that crashed inside the (microsecond) claimed section leaves the
    // claim behind; age is what makes it reclaimable.
    const stranded = new Date(Date.now() - 60_000);
    utimesSync(claim, stranded, stranded);
    store.json.put("edges", edge("e_stranded"));
    assert.ok(store.json.loadAll("edges").some((e) => e.id === "e_stranded"), "a stranded claim is cleared and the takeover proceeds");
    assert.equal(existsSync(claim), false, "no claim directory is left behind");
    assert.equal(existsSync(lock), false, "the lock is released after the write");
  } finally { cleanup(); }
});

/** A child that stays alive until we kill it. */
function spawnSleeper(): { pid: number; kill: () => void } {
  const child = spawn(process.execPath, ["-e", "setTimeout(()=>{},30000)"], { stdio: "ignore" });
  if (typeof child.pid !== "number") throw new Error("child did not start");
  return { pid: child.pid, kill: () => { try { child.kill("SIGKILL"); } catch { /* already gone */ } } };
}

/** A pid that is certainly dead: spawned, exited, and reaped. */
async function deadPid(): Promise<number> {
  const child = spawn(process.execPath, ["-e", ""], { stdio: "ignore" });
  const pid = child.pid!;
  await new Promise<void>((resolve) => child.on("exit", () => resolve()));
  await new Promise<void>((resolve) => setTimeout(resolve, 100)); // let the kernel reap the zombie
  return pid;
}

test("DETERMINISTIC: a contender under the claim re-judges and never removes the winner's LIVE .rmw-lock (issue #293)", async () => {
  // The takeover race for `.rmw-lock`, made repeatable — the same injection as
  // the write.lock test in test/serve.test.ts. On origin/main "judge stale → rm
  // → mkdir" is not atomic: contender B judges the corpse stale, contender A
  // wins the whole sequence in between, and B's `rm` then deletes A's FRESH live
  // lock, putting two writers inside the mutex that exists to stop exactly that.
  //
  // A is injected one-shot at whichever of B's calls comes first: its
  // `mkdirSync(<lock>.reclaim)` (this branch) or its `rmSync(<lock>)` (main,
  // which takes no claim at all).
  const { store, root, cleanup } = seed();
  const lock = join(root, ".hunch", "edges", ".rmw-lock");
  const claim = `${lock}.reclaim`;
  const ownerFile = join(lock, "owner.tmp.json");
  const child = spawnSleeper();
  const originalMkdirSync = fs.mkdirSync;
  const originalRmSync = fs.rmSync;
  const originalWriteFileSync = fs.writeFileSync;
  try {
    const corpse = await deadPid();
    // A plain corpse: a provably dead same-host pid, so B judges it stale.
    originalMkdirSync(lock, { recursive: true });
    originalWriteFileSync(ownerFile, JSON.stringify({ pid: corpse, host: hostname(), nonce: "corpse" }));

    let fired = 0;
    // Contender A's whole protocol, over the ORIGINAL syscalls so it cannot
    // re-enter the patch: claim, remove the corpse, publish a LIVE lock (the
    // directory plus its owner file) owned by a real running child, release.
    // Strictly one-shot: B may reach several patched calls, but A runs once.
    const simulateA = (): void => {
      if (fired > 0) return;
      fired++;
      try { originalMkdirSync(claim); } catch { return; } // A loses the claim: nothing further
      try {
        originalRmSync(lock, { recursive: true, force: true });
        originalMkdirSync(lock);
        originalWriteFileSync(ownerFile, JSON.stringify({ pid: child.pid, host: hostname(), nonce: "winner-A" }));
      } finally {
        try { originalRmSync(claim, { recursive: true, force: true }); } catch { /* best effort */ }
      }
    };
    const normalize = (p: unknown): string => String(p).replace(/\\/g, "/");
    fs.mkdirSync = ((target: Parameters<typeof originalMkdirSync>[0], options?: never) => {
      if (normalize(target) === normalize(claim)) simulateA();
      return originalMkdirSync(target, options);
    }) as typeof fs.mkdirSync;
    fs.rmSync = ((target: Parameters<typeof originalRmSync>[0], options?: Parameters<typeof originalRmSync>[1]) => {
      if (normalize(target) === normalize(lock)) simulateA(); // origin/main's path: no claim is ever taken
      return originalRmSync(target, options);
    }) as typeof fs.rmSync;
    syncBuiltinESMExports();

    let threw: unknown;
    try {
      store.json.put("edges", { id: "e_deterministic", from: "sym_a", to: "sym_b", type: "calls", reason: "", strength: 1, provenance: prov() } as never);
    } catch (error) { threw = error; }
    fs.mkdirSync = originalMkdirSync;
    fs.rmSync = originalRmSync;
    syncBuiltinESMExports();

    assert.equal(fired, 1, "contender A was injected exactly once");
    assert.ok(threw instanceof Error, "B must refuse rather than write behind A");
    assert.match((threw as Error).message, /timed out acquiring the edges index lock/);
    assert.equal(existsSync(lock), true, "A's live lock still exists — B removed nothing");
    const survivor = JSON.parse(readFileSync(ownerFile, "utf8")) as { pid: number; nonce: string };
    assert.equal(survivor.pid, child.pid, "the surviving lock is A's, owned by the live child");
    assert.equal(survivor.nonce, "winner-A");
    assert.equal(existsSync(claim), false, "no claim directory is left behind");
    assert.equal(store.json.loadAll("edges").some((e) => e.id === "e_deterministic"), false, "B's record never landed");
  } finally {
    fs.mkdirSync = originalMkdirSync;
    fs.rmSync = originalRmSync;
    syncBuiltinESMExports();
    child.kill();
    cleanup();
  }
});

test("stress SMOKE: concurrent PROCESSES racing one stale .rmw-lock all land their records (issue #293)", async () => {
  // NOT a reliable reproducer — origin/main fails only ~1–25% of runs, because a
  // loser has to land its `rm` inside the winner's few-syscall window. The
  // deterministic takeover-race test above is the regression proof; this one
  // stays as a stress smoke test over the real, unpatched syscalls.
  const { store, root, cleanup } = seed();
  const lock = join(root, ".hunch", "edges", ".rmw-lock");
  mkdirSync(lock, { recursive: true });
  const old = new Date(Date.now() - 60_000);
  utimesSync(lock, old, old); // ownerless corpse: every child judges it stale at once
  store.close();
  const tags = ["a", "b", "c", "d", "e", "f"];
  const rounds = 5;
  const script = [
    'import { hunchPaths } from "./src/core/paths.ts";',
    'import { HunchStore } from "./src/store/hunchStore.ts";',
    'const root = process.env.RACE_ROOT;',
    'const tag = process.env.RACE_TAG;',
    // A common start instant, so the children genuinely contend instead of
    // arriving one tsx startup apart.
    'const startAt = Number(process.env.RACE_START_AT);',
    'while (Date.now() < startAt) { /* spin to the barrier */ }',
    'const store = new HunchStore(hunchPaths(root));',
    'try {',
    `  for (let i = 0; i < ${rounds}; i++) {`,
    '    store.json.put("edges", { id: `e_${tag}_${i}`, from: "sym_a", to: "sym_b", type: "calls", reason: "", strength: 1, provenance: { source: "extracted", confidence: 0.9, evidence: [] } });',
    '  }',
    '} finally { store.close(); }',
  ].join("\n");
  const startAt = String(Date.now() + 1500);
  const children = tags.map((tag) => spawn(process.execPath, ["--import", "tsx", "--input-type=module", "--eval", script], {
    cwd: process.cwd(),
    env: { ...process.env, RACE_ROOT: root, RACE_TAG: tag, RACE_START_AT: startAt },
    stdio: ["ignore", "ignore", "pipe"],
  }));
  try {
    const exits = await Promise.all(children.map((child) => new Promise<{ code: number | null; stderr: string }>((resolve) => {
      let stderr = "";
      child.stderr!.on("data", (chunk: Buffer) => { stderr += chunk.toString(); });
      child.on("exit", (code) => resolve({ code, stderr }));
    })));
    for (const exit of exits) assert.equal(exit.code, 0, `a racing writer failed: ${exit.stderr}`);
    const fresh = new HunchStore(hunchPaths(root));
    try {
      const ids = new Set(fresh.json.loadAll("edges").map((e) => e.id));
      const expected = tags.flatMap((tag) => Array.from({ length: rounds }, (_, i) => `e_${tag}_${i}`));
      const missing = expected.filter((id) => !ids.has(id));
      assert.deepEqual(missing, [], "every concurrent writer's records survive the stale-lock takeover");
    } finally { fresh.close(); }
  } finally {
    for (const child of children) { try { child.kill("SIGKILL"); } catch { /* already gone */ } }
    cleanup();
  }
});

test("single-file RMW lock: owner metadata failure refuses and cleans up its owned lock", () => {
  const { store, root, cleanup } = seed();
  const originalRenameSync = fs.renameSync;
  fs.renameSync = ((from, to) => {
    if (String(to).replace(/\\/g, "/").endsWith(".rmw-lock/owner.tmp.json")) throw new Error("simulated metadata publication failure");
    return originalRenameSync(from, to);
  }) as typeof fs.renameSync;
  syncBuiltinESMExports();
  try {
    assert.throws(() => store.json.put("edges", { id: "e_owner_failure", from: "sym_a", to: "sym_b", type: "calls", reason: "", strength: 1, provenance: prov() } as never), /could not record ownership/);
    assert.equal(existsSync(join(root, ".hunch", "edges", ".rmw-lock")), false, "a lock without ownership metadata is never left behind");
  } finally {
    fs.renameSync = originalRenameSync;
    syncBuiltinESMExports();
    cleanup();
  }
});

test("getDependents walks the graph backward (blast radius)", () => {
  const { store, cleanup } = seed();
  const deps = store.getDependents("sym_a").map((d) => d.id).sort();
  assert.deepEqual(deps, ["sym_b", "sym_c"]);
  assert.deepEqual(store.getDependencies("sym_a"), []);
  cleanup();
});

test("checkConstraints matches by glob scope, severity-sorted", () => {
  const { store, cleanup } = seed();
  const cons = store.checkConstraints("src/auth/session.ts");
  assert.equal(cons[0]?.id, "con_1");
  assert.equal(store.checkConstraints("src/other/x.ts").length, 0);
  cleanup();
});

test("bugLineage finds by symbol and exposes lineage", () => {
  const { store, cleanup } = seed();
  const bugs = store.bugLineage("sym_a");
  assert.equal(bugs[0]?.id, "bug_1");
  assert.equal(bugs[0]?.lineage.fixed_commit, "a1b");
  cleanup();
});

test("fragility ranks the buggy, churned, central symbol first", () => {
  const { store, cleanup } = seed();
  const top = store.fragility(3);
  assert.equal(top[0]?.name, "verifySession");
  assert.ok(top[0]!.score >= top[1]!.score);
  cleanup();
});

test("non-ASCII (CJK) query returns results, never silently [] (regression #2)", () => {
  const { store, cleanup } = tempStore();
  store.json.put("decisions", { id: "dec_jp", title: "セッションをRedisに保存", status: "accepted", context: "", decision: "サーバ側セッション", consequences: [], alternatives_rejected: [], related_components: [], related_files: [], supersedes: null, caused_by_bug: null, commit: null, provenance: prov(0.9), date: "2026-01-01T00:00:00Z" } as never);
  store.reindex();
  const refs = store.search("セッション").map((h) => h.ref);
  assert.ok(refs.includes("dec_jp"), "CJK query matched (FTS or LIKE), not empty");
  cleanup();
});

test("punctuation-only query (no FTS tokens) uses the LIKE fallback (regression #2/#11)", () => {
  const { store, cleanup } = tempStore();
  // statement contains "::" — a token that toFtsQuery() maps to null (no word chars)
  store.json.put("constraints", { id: "con_ns", type: "architecture", statement: "Namespace symbols with :: separators", scope: ["src/**"], severity: "advisory", enforcement: "advisory_v1", rationale: "", source_decision: null, violations: [], provenance: prov(0.8) } as never);
  store.reindex();
  const refs = store.search("::").map((h) => h.ref);
  assert.ok(refs.includes("con_ns"), "punctuation-only query matched via LIKE, not empty");
  cleanup();
});

test("plain search fallback keeps reindex and scoped retrieval working without FTS5", async () => {
  const { store, cleanup } = tempStore();
  // Inject the same schema openDb selects when sqlite_compileoption_used reports
  // no ENABLE_FTS5 (the official Linux Node build exercised this path in CI).
  (store as unknown as { _db: DB | null })._db = openMemoryDb({ forcePlainSearch: true });
  store.json.put("decisions", {
    id: "dec_plain", title: "Redis session memory", status: "accepted", context: "", decision: "Keep sessions server-side",
    consequences: [], alternatives_rejected: [], related_components: [], related_files: [], supersedes: null,
    caused_by_bug: null, commit: null, provenance: prov(0.9), date: "2026-07-17T00:00:00Z",
  } as never);
  store.json.put("runbooks", {
    id: "rb_plain", task: "release version", trigger: ["publish package"], steps: ["run tests"], gotchas: [],
    outcome: "published", files: ["package.json"], source_range: null,
    valid_from: "2026-07-17T00:00:00Z", valid_to: null,
    provenance: prov(0.9), date: "2026-07-17T00:00:00Z",
  } as never);
  store.reindex();

  assert.ok(store.search("redis sessions").some((hit) => hit.ref === "dec_plain"));
  assert.ok((await store.searchRunbooks("release package")).some((hit) => hit.ref === "rb_plain"));
  const schema = store.db.prepare(`SELECT sql FROM sqlite_master WHERE name = 'search'`).get() as { sql: string };
  assert.doesNotMatch(schema.sql, /VIRTUAL\s+TABLE/i);
  cleanup();
});
