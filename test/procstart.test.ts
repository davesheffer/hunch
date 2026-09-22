/**
 * Process-instance identity (issues #287, #293). A same-host live PID is
 * authoritative for both cross-process locks, so the ONE thing that may override
 * it — "this pid is held by a DIFFERENT process instance than the one that took
 * the lock" — is decided by comparing kernel-issued identity tokens with string
 * equality. No clock is read: the earlier draft compared the lock's mtime
 * (filesystem clock) against start-time arithmetic (host clock) and a forward
 * clock step made it steal a LIVE owner's lock.
 */
import test from "node:test";
import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { fileURLToPath, pathToFileURL } from "node:url";
import { dirname, join } from "node:path";
import {
  judgeSameHostOwner,
  linuxStartToken,
  ownerInstance,
  selfStartToken,
  startTokenOf,
  starttimeTicks,
  type SameHostEnv,
  type SameHostOwner,
} from "../src/core/procstart.js";

const BOOT = "1b4e28ba-2fa1-11d2-883f-0016d3cca427";

/** A `/proc/<pid>/stat` line whose starttime (overall field 22) is `ticks`.
 *  `comm` deliberately carries spaces and a `)` — the numeric fields are only
 *  unambiguous after the LAST `)`. */
function statLine(pid: number, comm: string, ticks: string): string {
  return `${pid} (${comm}) S ${Array.from({ length: 18 }, () => "0").join(" ")} ${ticks} 0 0\n`;
}

/** A fake /proc: the files and links the token is built from. `selfLink` is what
 *  `readlink /proc/self` reports — the proof that this /proc is OUR namespace's
 *  view and not an ancestor's. */
function fakeProc(opts: { boot?: string; ns?: string; timens?: string | null; selfTicks?: string; targetTicks?: string; comm?: string; selfLink?: string } = {}): { read: (p: string) => string; readlink: (p: string) => string } {
  const files: Record<string, string> = {
    "/proc/sys/kernel/random/boot_id": `${opts.boot ?? BOOT}\n`,
    "/proc/self/stat": statLine(777, opts.comm ?? "node", opts.selfTicks ?? "555"),
    "/proc/4242/stat": statLine(4242, opts.comm ?? "node", opts.targetTicks ?? "9001"),
  };
  const links: Record<string, string> = {
    "/proc/self": opts.selfLink ?? "777",
    "/proc/self/ns/pid": `pid:[${opts.ns ?? "4026531836"}]`,
    ...(opts.timens === null ? {} : { "/proc/self/ns/time": `time:[${opts.timens ?? "4026531834"}]` }),
  };
  return {
    read: (path) => {
      const text = files[path];
      if (text === undefined) throw new Error(`ENOENT ${path}`);
      return text;
    },
    readlink: (path) => {
      const target = links[path];
      if (target === undefined) throw new Error(`ENOENT ${path}`);
      return target;
    },
  };
}

/** Our own pid as the fake /proc numbers it (fakeProc's `/proc/self` -> 777). */
const FAKE_SELF_PID = 777;

test("starttimeTicks reads field 22 after the LAST `)` of comm, as an exact string", () => {
  assert.equal(starttimeTicks(statLine(4242, "(a) b", "9001")), "9001");
  assert.equal(starttimeTicks(statLine(4242, "a b) (c", "12345678901234567890")), "12345678901234567890", "never narrowed to a Number");
  assert.equal(starttimeTicks("4242 node S 0 0 0"), null, "no `)` at all");
  assert.equal(starttimeTicks(statLine(4242, "node", "not-a-number")), null);
  assert.equal(starttimeTicks("4242 (node) S 1 2 3"), null, "too few fields after comm");
});

test("linuxStartToken builds <boot>:<pidns>:<timens>:<ticks> from an injected /proc", () => {
  const io = fakeProc({ comm: "(a) b" });
  assert.equal(linuxStartToken("self", io, FAKE_SELF_PID), `${BOOT}:4026531836:4026531834:555`);
  assert.equal(linuxStartToken(4242, io, FAKE_SELF_PID), `${BOOT}:4026531836:4026531834:9001`);
  // The namespaces are always OUR OWN, even when tokenizing another pid: a pid we
  // can see in our /proc is by definition addressed in our namespace.
  assert.ok(linuxStartToken(4242, io, FAKE_SELF_PID)!.includes(":4026531836:4026531834:"));
});

test("linuxStartToken normalizes a missing time namespace (kernel < 5.6) to 0", () => {
  // `/proc/self/ns/time` arrived in 5.6. Before it, every process shares the one
  // and only time namespace, so field 22 is comparable across all of them.
  const io = fakeProc({ timens: null });
  assert.equal(linuxStartToken("self", io, FAKE_SELF_PID), `${BOOT}:4026531836:0:555`);
  assert.equal(linuxStartToken(4242, io, FAKE_SELF_PID), `${BOOT}:4026531836:0:9001`);
  // A link that EXISTS but is not the shape we know is a refusal, not a "0".
  const weird = { ...io, readlink: (p: string) => (p === "/proc/self/ns/time" ? "time-for-namespaces" : io.readlink(p)) };
  assert.equal(linuxStartToken("self", weird, FAKE_SELF_PID), null);
});

test("linuxStartToken refuses a /proc mounted from an ANCESTOR pid namespace", () => {
  // Inside a container whose /proc was bind-mounted rather than remounted,
  // `/proc/<pid>` numbers processes in the HOST's namespace while `kill(pid, 0)`
  // uses ours — two pid spaces silently mixed. `readlink /proc/self` reports our
  // pid AS /proc numbers it, so a mismatch means this /proc is not our view.
  const io = fakeProc({ selfLink: "31337" });
  assert.equal(linuxStartToken("self", io, FAKE_SELF_PID), null, "our own token is just as invalid under a foreign /proc");
  assert.equal(linuxStartToken(4242, io, FAKE_SELF_PID), null, "and so is any other pid's");
  // With the view validated, the very same reads succeed.
  assert.notEqual(linuxStartToken(4242, fakeProc(), FAKE_SELF_PID), null);
});

test("linuxStartToken is null for every malformed or missing piece", () => {
  const bad = (io: { read: (p: string) => string; readlink: (p: string) => string }): string | null => linuxStartToken(4242, io, FAKE_SELF_PID);
  const base = fakeProc();
  assert.equal(bad({ ...base, read: (p) => (p === "/proc/sys/kernel/random/boot_id" ? "\n" : base.read(p)) }), null, "empty boot id");
  assert.equal(bad({ ...base, read: (p) => (p === "/proc/sys/kernel/random/boot_id" ? "not a uuid!\n" : base.read(p)) }), null, "boot id with illegal characters");
  assert.equal(bad({ ...base, read: (p) => { if (p === "/proc/sys/kernel/random/boot_id") throw new Error("ENOENT"); return base.read(p); } }), null, "no boot_id file");
  assert.equal(bad({ ...base, readlink: (p) => (p === "/proc/self/ns/pid" ? "pid:4026531836" : base.readlink(p)) }), null, "readlink without the bracket form");
  assert.equal(bad({ ...base, readlink: (p) => { if (p === "/proc/self/ns/pid") throw new Error("EPERM"); return base.readlink(p); } }), null, "readlink refused");
  assert.equal(bad({ ...base, readlink: (p) => { if (p === "/proc/self") throw new Error("EPERM"); return base.readlink(p); } }), null, "our /proc view cannot be verified");
  assert.equal(bad(fakeProc({ targetTicks: "x" })), null, "malformed stat");
  assert.equal(linuxStartToken(5555, base, FAKE_SELF_PID), null, "no stat file for that pid");
  for (const invalid of [0, -1, 1.5]) assert.equal(linuxStartToken(invalid, base, FAKE_SELF_PID), null, `invalid pid ${invalid}`);
});

test("ownerInstance: identical tokens are the SAME instance, differing ticks a recycled pid", () => {
  const self = `${BOOT}:1:9:200`;
  assert.equal(ownerInstance(`${BOOT}:1:9:100`, 42, self, () => `${BOOT}:1:9:100`), "same");
  assert.equal(ownerInstance(`${BOOT}:1:9:100`, 42, self, () => `${BOOT}:1:9:999`), "recycled", "a different instance holds that pid now");
});

test("ownerInstance: another boot, namespace or TIME namespace is UNPROBEABLE", () => {
  const self = `${BOOT}:1:9:200`;
  const otherBoot = "0000ffff-0000-0000-0000-000000000000";
  assert.equal(ownerInstance(`${otherBoot}:1:9:100`, 42, self, () => `${BOOT}:1:9:100`), "unprobeable", "written under another kernel boot");
  assert.equal(ownerInstance(`${BOOT}:7:9:100`, 42, self, () => `${BOOT}:1:9:100`), "unprobeable", "written in another pid namespace");
  // Field 22 is rendered relative to the READER's time namespace, so ticks from
  // another one are not comparable at all.
  assert.equal(ownerInstance(`${BOOT}:1:5:100`, 42, self, () => `${BOOT}:1:9:100`), "unprobeable", "written in another time namespace");
});

test("ownerInstance: no identity of our own is UNKNOWN on linux, UNPROBEABLE elsewhere", () => {
  // On linux a null self only means our own /proc proved nothing: the pre-token
  // pid rule must apply unchanged, because "unprobeable" would hand a LIVE
  // same-host owner to the age rule and steal a slow writer main never stole.
  assert.equal(ownerInstance(`${BOOT}:1:9:100`, 42, null, () => `${BOOT}:1:9:100`, "linux"), "unknown");
  // Off linux a token-bearing record came from a different OS instance sharing
  // our hostname + volume (a linux container on this machine): its pid number
  // means nothing here, so age governs.
  for (const platform of ["darwin", "win32"] as const) {
    assert.equal(ownerInstance(`${BOOT}:1:9:100`, 42, null, () => null, platform), "unprobeable", platform);
  }
});

test("ownerInstance: no token, a malformed token, or an unreadable pid is UNKNOWN", () => {
  const self = `${BOOT}:1:9:200`;
  assert.equal(ownerInstance(undefined, 42, self, () => `${BOOT}:1:9:100`), "unknown", "a legacy or non-linux lock");
  for (const malformed of ["", "nonsense", `${BOOT}:1`, `${BOOT}:1:100`, `${BOOT}:x:9:100`, `${BOOT}:1:9:100:extra`, "!!!:1:9:100"]) {
    assert.equal(ownerInstance(malformed, 42, self, () => `${BOOT}:1:9:100`), "unknown", `malformed token ${JSON.stringify(malformed)}`);
  }
  assert.equal(ownerInstance(`${BOOT}:1:9:100`, 42, self, () => null), "unknown", "pid died between probes, or /proc is hidden for it");
});

test("ownerInstance never consults the pid probe once the prefix disqualifies it", () => {
  let probes = 0;
  const verdict = ownerInstance(`${BOOT}:9:9:100`, 42, `${BOOT}:1:9:200`, () => { probes++; return null; });
  assert.equal(verdict, "unprobeable");
  assert.equal(probes, 0, "an unprobeable pid number is never looked up");
});

/* ── judgeSameHostOwner: the one table both locks consult ─────────────────── */

const SELF = `${BOOT}:1:9:200`;

/** An env with everything defaulted to the boring case; each row overrides only
 *  the field it is about. */
function env(overrides: Partial<SameHostEnv> = {}): SameHostEnv {
  return {
    alive: () => true,
    self: SELF,
    tokenOf: () => SELF,
    platform: "darwin",
    selfPid: 777,
    heldNonces: new Set<string>(),
    ...overrides,
  };
}

const owner = (o: Partial<SameHostOwner> = {}): SameHostOwner => ({ pid: 4242, ...o });

test("judge row 1: a nonce WE hold is live — never stolen by age, a dead pid or a recycled token", () => {
  const held = new Set(["ours"]);
  // Every other signal says "take it": the pid is dead, the token is a
  // predecessor's, and it is our own pid. Our own held nonce outranks them all.
  assert.equal(judgeSameHostOwner(owner({ nonce: "ours", start: `${BOOT}:1:9:100` }), env({ heldNonces: held, alive: () => false })), "live");
  assert.equal(judgeSameHostOwner(owner({ pid: 777, nonce: "ours" }), env({ heldNonces: held })), "live", "our own pid, our own nonce");
  assert.equal(judgeSameHostOwner(owner({ nonce: "ours", start: `${BOOT}:1:9:100` }), env({ heldNonces: held, tokenOf: () => `${BOOT}:1:9:999` })), "live", "not even a recycled verdict");
});

test("judge row 2: an UNPROBEABLE owner falls through to the caller's age rule", () => {
  const otherBoot = "0000ffff-0000-0000-0000-000000000000";
  assert.equal(judgeSameHostOwner(owner({ start: `${otherBoot}:1:9:100` }), env()), "age", "another boot");
  assert.equal(judgeSameHostOwner(owner({ start: `${BOOT}:7:9:100` }), env()), "age", "another pid namespace");
  // A dead pid from another namespace is still no evidence: age, not "stale".
  assert.equal(judgeSameHostOwner(owner({ start: `${otherBoot}:1:9:100` }), env({ alive: () => false })), "age");
  // Off linux a token-bearing record is another OS instance's: unprobeable too.
  assert.equal(judgeSameHostOwner(owner({ start: `${BOOT}:1:9:100` }), env({ self: null, platform: "darwin" })), "age");
  // ON linux a null self is NOT unprobeable: main's pid rule — a live pid stays
  // live (never age-stolen), a dead one is stale.
  assert.equal(judgeSameHostOwner(owner({ start: `${BOOT}:1:9:100` }), env({ self: null, platform: "linux" })), "live");
  assert.equal(judgeSameHostOwner(owner({ start: `${BOOT}:1:9:100` }), env({ self: null, platform: "linux", alive: () => false })), "stale");
});

test("judge row 3: a dead pid whose number IS meaningful here is stale", () => {
  const dead = env({ alive: () => false });
  assert.equal(judgeSameHostOwner(owner({ start: `${BOOT}:1:9:100` }), dead), "stale", "with a token");
  assert.equal(judgeSameHostOwner(owner({ nonce: "other" }), dead), "stale", "and without one — main's rule, unchanged");
  assert.equal(judgeSameHostOwner(owner(), dead), "stale", "no nonce either");
});

test("judge row 4: a live pid held by a DIFFERENT instance (recycled) is stale", () => {
  assert.equal(judgeSameHostOwner(owner({ start: `${BOOT}:1:9:100`, nonce: "other" }), env({ tokenOf: () => `${BOOT}:1:9:999` })), "stale");
  // The container-restart shape with tokens on both sides: our own pid, a
  // predecessor's instance. Proven, so it is stolen on every platform.
  for (const platform of ["linux", "darwin", "win32"] as const) {
    assert.equal(judgeSameHostOwner(owner({ pid: 777, start: `${BOOT}:1:9:100`, nonce: "other" }), env({ platform, tokenOf: () => SELF })), "stale", platform);
  }
});

test("judge row 5: a byte-identical token is the genuine owner — live, however old", () => {
  assert.equal(judgeSameHostOwner(owner({ start: SELF, nonce: "theirs" }), env({ tokenOf: () => SELF })), "live");
  assert.equal(judgeSameHostOwner(owner({ pid: 777, start: SELF, nonce: "theirs" }), env({ tokenOf: () => SELF })), "live", "even for our own pid");
});

test("judge row 6: an UNKNOWN own-pid record with a FOREIGN nonce falls to the age rule on EVERY platform", () => {
  // No token to compare (a legacy lock, a non-linux writer, an unreadable /proc)
  // and the record names OUR pid with a nonce we do not hold. That proves only
  // that the lock is not OURS — not that its writer is dead: "our pid" can be a
  // live neighbour's in another pid space sharing our hostname and volume (two
  // containers on linux; a linux GUEST off linux — WSL2 shares the Windows
  // hostname and /mnt/c, Docker Desktop bind mounts). main never stole this shape
  // at all (issue #287's deadlock); the age rule ends the deadlock without ever
  // stealing a FRESH live lock, on every platform.
  const record = owner({ pid: 777, nonce: "predecessor" });
  for (const platform of ["linux", "darwin", "win32"] as const) {
    assert.equal(judgeSameHostOwner(record, env({ platform, self: null })), "age", platform);
    // And with a self token of our own, over a record that carries no `start`.
    assert.equal(judgeSameHostOwner(record, env({ platform })), "age", `${platform}, non-null self`);
  }
});

test("judge row 6: an UNKNOWN own-pid record with NO nonce stays live — nothing to compare", () => {
  for (const platform of ["linux", "darwin", "win32"] as const) {
    assert.equal(judgeSameHostOwner(owner({ pid: 777 }), env({ platform, self: null })), "live", platform);
  }
});

test("judge row 6: an UNKNOWN record naming ANOTHER live pid stays live on every platform", () => {
  // The remaining macOS/Windows gap, documented and deliberate: a live pid we
  // cannot disprove is never stolen on a guess.
  for (const platform of ["linux", "darwin", "win32"] as const) {
    assert.equal(judgeSameHostOwner(owner({ nonce: "theirs" }), env({ platform, self: null })), "live", platform);
    assert.equal(judgeSameHostOwner(owner(), env({ platform, self: null })), "live", `${platform}, no nonce`);
  }
  // Same when the probe simply could not read that pid's token.
  assert.equal(judgeSameHostOwner(owner({ start: `${BOOT}:1:9:100`, nonce: "theirs" }), env({ tokenOf: () => null })), "live");
});

/* ── the real kernel ──────────────────────────────────────────────────────── */

test("selfStartToken agrees with a direct /proc read of our own pid", () => {
  const self = selfStartToken();
  if (process.platform !== "linux") {
    assert.equal(self, null, "no spawn-free process-instance id off linux");
    assert.equal(startTokenOf(process.pid), null);
    return;
  }
  assert.notEqual(self, null, "linux always has /proc");
  assert.match(self!, /^[0-9a-fA-F-]+:\d+:\d+:\d+$/);
  // `startTokenOf(process.pid)` short-circuits to selfStartToken(), so comparing
  // the two proves nothing. The real read does.
  assert.equal(linuxStartToken(process.pid), self, "our own pid reads back as our own token");
});

test("a real child's token is read from /proc, matches ITS OWN report, and dies with it", { skip: process.platform !== "linux" }, async () => {
  const procstart = pathToFileURL(join(dirname(fileURLToPath(import.meta.url)), "..", "src", "core", "procstart.ts")).href;
  // The soundness test the fakes cannot give: a token this process reads out of
  // /proc for ANOTHER pid must be byte-identical to the one that process
  // computes for itself, or "same" would be a coincidence of our own reads.
  const source = [
    `import { selfStartToken } from ${JSON.stringify(procstart)};`,
    "console.log(selfStartToken());",
    "setTimeout(() => {}, 30000);",
  ].join("\n");
  const child = spawn(process.execPath, ["--import", "tsx", "--input-type=module", "--eval", source], { stdio: ["ignore", "pipe", "pipe"] });
  const pid = child.pid!;
  // ONE exit promise, created before anything can await: the early-exit rejection
  // and the cleanup below must share it, or a child that already exited leaves the
  // `finally` awaiting a second "exit" event that will never arrive.
  let exitCode: number | null = null;
  const exited = new Promise<void>((resolve) => { child.once("exit", (code) => { exitCode = code; resolve(); }); });
  let printed = "";
  try {
    printed = await new Promise<string>((resolve, reject) => {
      let out = "";
      child.stdout!.on("data", (chunk: Buffer) => {
        out += chunk.toString();
        const line = out.split("\n")[0];
        if (out.includes("\n") && line !== undefined) resolve(line.trim());
      });
      void exited.then(() => reject(new Error(`child exited early (${exitCode})`)));
      setTimeout(() => reject(new Error("child printed no token")), 20_000).unref();
    });
    assert.notEqual(printed, "null", "a linux child always has an identity");
    assert.equal(linuxStartToken(pid), printed, "our /proc read of its pid equals its own self-report");
    assert.equal(ownerInstance(printed, pid), "same", "the live child IS the instance that wrote that token");
  } finally {
    child.kill("SIGKILL");
    await exited;
  }
  // The pid is gone, so there is nothing to read: not proven either way, which
  // is precisely what makes the caller consult `kill(pid, 0)` and judge it dead.
  const printedAfter = linuxStartToken(pid);
  assert.equal(printedAfter, null, "a dead pid has no /proc entry");
  // Through the REAL probe, not a fake: same boot and namespaces, no /proc entry.
  assert.equal(ownerInstance(printed, pid), "unknown");
});
