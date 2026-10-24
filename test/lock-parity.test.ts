// Parity between the two cross-process locks that share core/procstart.ts:
// the serve write lock (src/serve/writelock.ts) and the store's `.rmw-lock`
// (src/store/jsonStore.ts). Bug class: a fix applied to one copy but not its
// sibling — the pid-reuse takeover landed for the write lock (#287) and was
// missing from `.rmw-lock` until #457. One scenario table runs against BOTH
// locks through their internal test seams and asserts the same outcome
// ("taken" = the waiter took the lock over and ran; "refused" = it waited and
// timed out).
//
// Deterministic on every platform: liveness uses real child processes, the
// creation-time probe is injected (JsonStore lockOpts.startedAt; writelock
// opts.startToken.startedAt), and no record carries a `start` token, so the
// token path is "unknown" on linux, macOS and Windows alike — no PowerShell.
//
// INTENTIONAL DIFFERENCES (parametrized, never asserted equal):
//  - stale age: `.rmw-lock` 10 s (a handful of syscalls) vs write lock
//    STALE_AFTER_MS = 60 s (a put plus a git commit and push). Each scenario's
//    age is expressed relative to the lock's own threshold.
//  - wait budget: `.rmw-lock` waits a fixed 2 s; the write lock takes timeoutMs.
//  - shape: `.rmw-lock` is a directory holding owner.tmp.json; write.lock is the
//    owner file itself. Age is the mtime of the directory / the file.
//  - record validity: `.rmw-lock` requires `host`; write.lock reads a missing
//    `host` as "not this host". Every row below carries a host, so the rows
//    exercise the decision, not each parser's notion of "malformed". A missing
//    `nonce` does not change acquisition: both locks judge a nonce-less record
//    by its pid (issue #491), so the `nonceless` rows assert one outcome. Both
//    also treat a pid that is not a positive integer as unreadable metadata.
//  - release of a nonce-less record (not exercised here): write.lock leaves it in
//    place, `.rmw-lock` removes it.
import { after, before, test } from "node:test";
import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, existsSync, utimesSync, writeFileSync } from "node:fs";
import { hostname, tmpdir } from "node:os";
import { join } from "node:path";
import { spawn } from "node:child_process";
import { cleanupDir } from "./helpers.js";
import { prov } from "./helpers.js";
import { hunchPaths } from "../src/core/paths.js";
import { JsonStore } from "../src/store/jsonStore.js";
import { STALE_AFTER_MS, withWriteLock, writeLockPath } from "../src/serve/writelock.js";
import { CREATED_AFTER_SLACK_MS, heldLockNonces } from "../src/core/procstart.js";

type Outcome = "taken" | "refused";
type Age = "aged" | "fresh";
type Pid = "alive" | "dead" | "self";

interface Scenario {
  name: string;
  /** Whose pid the owner record names. */
  pid: Pid;
  /** "aged" = past the lock's own stale threshold; "fresh" = well inside it. */
  age: Age;
  /** Owner record shape. `raw` replaces the JSON entirely (garbage metadata). */
  host?: "self" | "foreign";
  legacy?: boolean; // no `at`
  nonceless?: boolean; // no `nonce` (a legacy or foreign writer; issue #491)
  rawPid?: number; // the recorded pid verbatim, overriding `pid` (invalid pids)
  held?: boolean; // the nonce is one THIS process currently holds
  raw?: string;
  /** Injected creation time of the process now holding the pid, relative to the
   *  record's `at`; null = the OS could not say. Unset = probe answers null. */
  startedRelToAt?: number | null;
  expect: Outcome;
  todo?: string;
}

const SCENARIOS: Scenario[] = [
  { name: "owner pid dead, aged", pid: "dead", age: "aged", expect: "taken" },
  { name: "owner pid dead, fresh (death is proof, age irrelevant)", pid: "dead", age: "fresh", expect: "taken" },
  { name: "owner alive and genuine (started before `at`), aged", pid: "alive", age: "aged", startedRelToAt: -60_000, expect: "refused" },
  { name: "owner alive, creation time unreadable, aged", pid: "alive", age: "aged", startedRelToAt: null, expect: "refused" },
  { name: "owner alive, created after `at` within the slack, aged", pid: "alive", age: "aged", startedRelToAt: CREATED_AFTER_SLACK_MS - 1_000, expect: "refused" },
  { name: "owner pid reused by a process created after `at` + slack, aged", pid: "alive", age: "aged", startedRelToAt: CREATED_AFTER_SLACK_MS + 1_000, expect: "taken" },
  { name: "owner pid reused after `at` + slack, but lock young", pid: "alive", age: "fresh", startedRelToAt: CREATED_AFTER_SLACK_MS + 1_000, expect: "refused" },
  { name: "legacy record without `at`, live pid, aged, probe says newer", pid: "alive", age: "aged", legacy: true, startedRelToAt: 10 * 60_000, expect: "refused" },
  { name: "foreign host owner, aged", pid: "alive", host: "foreign", age: "aged", expect: "taken" },
  { name: "foreign host owner, fresh", pid: "alive", host: "foreign", age: "fresh", expect: "refused" },
  { name: "foreign host owner with a dead-here pid, fresh (pid means nothing there)", pid: "dead", host: "foreign", age: "fresh", expect: "refused" },
  { name: "garbage owner metadata, aged", pid: "alive", age: "aged", raw: "{not json", expect: "taken" },
  { name: "garbage owner metadata, fresh", pid: "alive", age: "fresh", raw: "{not json", expect: "refused" },
  { name: "own process holding it (held nonce), aged — not re-entrant, never stolen", pid: "self", age: "aged", held: true, expect: "refused" },
  { name: "own pid, nonce NOT held (predecessor with our pid), aged", pid: "self", age: "aged", expect: "taken" },
  { name: "own pid, nonce NOT held (predecessor with our pid), fresh", pid: "self", age: "fresh", expect: "refused" },
  // Issue #491: a nonce-less record is judged by its pid, never by age alone.
  { name: "nonce-less owner alive, creation time unreadable, aged", pid: "alive", age: "aged", nonceless: true, startedRelToAt: null, expect: "refused" },
  { name: "nonce-less owner alive and genuine (started before `at`), aged", pid: "alive", age: "aged", nonceless: true, startedRelToAt: -60_000, expect: "refused" },
  { name: "nonce-less owner pid dead, fresh", pid: "dead", age: "fresh", nonceless: true, expect: "taken" },
  { name: "nonce-less record naming our own pid, aged", pid: "self", age: "aged", nonceless: true, expect: "refused" },
  // Regression guard, not a #491 detector (it passed before the fix too): the
  // recycled-pid takeover (#287) still reaches a nonce-less record.
  { name: "nonce-less owner pid reused after `at` + slack, aged", pid: "alive", age: "aged", nonceless: true, startedRelToAt: CREATED_AFTER_SLACK_MS + 1_000, expect: "taken" },
  // A pid that is not a positive integer is unreadable metadata: age decides.
  { name: "owner pid 0, aged", pid: "alive", rawPid: 0, age: "aged", expect: "taken" },
  { name: "owner pid -1, aged", pid: "alive", rawPid: -1, age: "aged", expect: "taken" },
  { name: "owner pid 1.5, fresh", pid: "alive", rawPid: 1.5, age: "fresh", expect: "refused" },
];

interface LockImpl {
  name: string;
  staleMs: number;
  run(s: Scenario, ownerPid: number): Promise<Outcome>;
}

let alive: ReturnType<typeof spawn> | undefined;
let alivePid = 0;
let deadPid = 0;

before(async () => {
  alive = spawn(process.execPath, ["-e", "setTimeout(()=>{},120000)"], { stdio: "ignore" });
  if (typeof alive.pid !== "number") throw new Error("sleeper did not start");
  alivePid = alive.pid;
  const child = spawn(process.execPath, ["-e", ""], { stdio: "ignore" });
  deadPid = child.pid!;
  await new Promise<void>((resolve) => child.on("exit", () => resolve()));
  await new Promise<void>((resolve) => setTimeout(resolve, 100)); // let the kernel reap it
});

after(() => {
  try { alive?.kill("SIGKILL"); } catch { /* already gone */ }
});

function pidOf(s: Scenario): number {
  if (s.rawPid !== undefined) return s.rawPid;
  return s.pid === "alive" ? alivePid : s.pid === "dead" ? deadPid : process.pid;
}

/** Age of the lock (and of its recorded `at`) relative to the lock's own threshold. */
function ageMs(s: Scenario, staleMs: number): number {
  return s.age === "aged" ? staleMs + 30_000 : 1_000;
}

/** Writes the owner record; returns its `at` (ms) and the nonce. */
function ownerRecord(s: Scenario, pid: number, at: number, nonce: string): string {
  if (s.raw !== undefined) return s.raw;
  return JSON.stringify({
    pid,
    host: s.host === "foreign" ? `parity-foreign-${hostname()}` : hostname(),
    ...(s.nonceless ? {} : { nonce }),
    ...(s.legacy ? {} : { at: new Date(at).toISOString() }),
  });
}

function probeFor(s: Scenario, pid: number, at: number): (p: number) => number | null {
  return (p) => {
    if (p !== pid || s.startedRelToAt === undefined || s.startedRelToAt === null) return null;
    return at + s.startedRelToAt;
  };
}

/** Holds `nonce` in this process's held set for the duration of `fn` when the
 *  scenario says the lock is ours. */
async function withHeld<T>(s: Scenario, nonce: string, fn: () => Promise<T>): Promise<T> {
  if (s.held) heldLockNonces.add(nonce);
  try { return await fn(); } finally { if (s.held) heldLockNonces.delete(nonce); }
}

const rmwLock: LockImpl = {
  name: ".rmw-lock",
  staleMs: 10_000,
  async run(s, pid) {
    const root = mkdtempSync(join(tmpdir(), "hunch-parity-rmw-"));
    try {
      const at = Date.now() - ageMs(s, this.staleMs);
      const nonce = `parity-${Math.random().toString(16).slice(2)}`;
      const json = new JsonStore(hunchPaths(root), { startedAt: probeFor(s, pid, at) });
      json.ensureDirs();
      const lock = join(root, ".hunch", "edges", ".rmw-lock");
      mkdirSync(lock, { recursive: true });
      writeFileSync(join(lock, "owner.tmp.json"), ownerRecord(s, pid, at, nonce));
      const mtime = new Date(at);
      utimesSync(lock, mtime, mtime);
      return await withHeld(s, nonce, async () => {
        try {
          json.put("edges", { id: "e_parity", from: "sym_a", to: "sym_b", type: "calls", reason: "", strength: 1, provenance: prov() } as never);
        } catch (error) {
          assert.match((error as Error).message, /timed out acquiring the edges index lock/);
          assert.ok(existsSync(lock), "a refused waiter leaves the holder's lock in place");
          return "refused" as const;
        }
        assert.ok(json.loadAll("edges").some((e) => e.id === "e_parity"), "the write landed");
        return "taken" as const;
      });
    } finally {
      cleanupDir(root);
    }
  },
};

const writeLock: LockImpl = {
  name: "write.lock",
  staleMs: STALE_AFTER_MS,
  async run(s, pid) {
    const dir = mkdtempSync(join(tmpdir(), "hunch-parity-wl-"));
    try {
      const at = Date.now() - ageMs(s, this.staleMs);
      const nonce = `parity-${Math.random().toString(16).slice(2)}`;
      const path = writeLockPath(dir);
      writeFileSync(path, ownerRecord(s, pid, at, nonce));
      const mtime = new Date(at);
      utimesSync(path, mtime, mtime);
      // self: null + a record without `start` = token verdict "unknown" on every
      // platform, the same verdict `.rmw-lock` reaches with its real probes.
      const startToken = { self: null, of: () => null, platform: process.platform, startedAt: probeFor(s, pid, at) };
      return await withHeld(s, nonce, async () => {
        let entered = false;
        try {
          await withWriteLock(dir, () => { entered = true; }, { timeoutMs: 100, startToken });
        } catch (error) {
          assert.equal((error as Error).name, "WriteLockTimeout");
          assert.ok(existsSync(path), "a refused waiter leaves the holder's lock in place");
          return "refused" as const;
        }
        assert.ok(entered, "the critical section ran");
        return "taken" as const;
      });
    } finally {
      cleanupDir(dir);
    }
  },
};

const LOCKS: LockImpl[] = [rmwLock, writeLock];

for (const s of SCENARIOS) {
  test(`lock parity: ${s.name} -> ${s.expect}`, s.todo ? { todo: s.todo } : {}, async () => {
    const outcomes: Record<string, Outcome> = {};
    for (const lock of LOCKS) outcomes[lock.name] = await lock.run(s, pidOf(s));
    assert.deepEqual(
      outcomes,
      Object.fromEntries(LOCKS.map((l) => [l.name, s.expect])),
      `both locks must reach "${s.expect}"`,
    );
  });
}
