/**
 * When is a live PID NOT the process that took a lock?
 *
 * Every cross-process lock here trusts a same-host owner while `kill(pid, 0)`
 * succeeds — age alone cannot tell a slow writer from a dead one, so a live PID
 * is authoritative (src/serve/writelock.ts, jsonStore's `.rmw-lock`). That trust
 * has one hole: PIDs are recycled. A container restart routinely hands the new
 * `hunch serve` the SAME pid on the SAME hostname, so a lock left by the dead
 * process names its successor's own pid — provably alive, never taken over, and
 * every write after it refuses forever (issues #287, #293).
 *
 * The disambiguator is IDENTITY, compared by STRING EQUALITY: a lock records the
 * process-instance token of whoever took it, and the current holder of that pid
 * is the same process only if its token is byte-identical. No arithmetic, no
 * ordering, no tolerance — a token either matches or it does not.
 *
 * WHY NOT CLOCKS. The previous draft compared the lock file's mtime against
 * start-time arithmetic. Those are two different clocks: mtime comes from the
 * FILESYSTEM (which on a network or virtualized volume is another machine's),
 * start times from the HOST's boot-relative accounting. Filesystem/host skew, an
 * NTP step forward, or a suspend/resume makes a genuinely live owner look as if
 * it started after its own lock — a false "reused" that STEALS a live lock and
 * puts two writers inside the mutex. Reproduced by simply `utimes`-ing a held
 * lock 30 s into the past. Nothing in this file may read a clock.
 *
 * REMAINING GAP. Only linux exposes a spawn-free, stable process-instance id
 * (`/proc/<pid>/stat` field 22 plus the boot id and the pid/time namespaces). On
 * macOS and Windows a DIFFERENT live process that recycled the owner's pid
 * therefore stays "not proven" and keeps the lock until the age rule applies —
 * today's behaviour, and the safe direction. `ps -o lstart` and PowerShell's
 * `Get-Process ... StartTime` were rejected: both cost a spawn per probe on the
 * contended path, and both return locale/TZ-dependent strings we would have to
 * parse back into a comparable identity. Gating such a probe on age does not
 * rescue them either: the CONTENDER can read the current holder's start time,
 * but a verdict needs something to compare it WITH — either a start time the
 * OWNER recorded when it took the lock (which puts that spawn on every writing
 * process, not just the contended path) or a start-time-vs-mtime comparison,
 * i.e. exactly the cross-clock arithmetic rejected above.
 *
 * UNSUPPORTED TOPOLOGIES. A linux-written token carries its boot id and its pid
 * and time namespaces, so a lock written under another boot or another namespace
 * is now reported as "unprobeable" — the recorded pid number means nothing here,
 * and the age rule governs, exactly as it does for a foreign host. That covers a
 * reboot, two machines sharing a hostname over a network volume, two containers
 * sharing hostname + volume, and a restarted container with a fresh namespace.
 * That "reported as unprobeable" holds only while OUR OWN token is readable: a
 * null self token on linux means our own /proc proved nothing, and those records
 * then get main's pid rule instead of the age rule (no regression from main, but
 * not the age rule either). CRIU checkpoint/restore is NOT supported: a restored
 * process keeps its pid but gets a new boot id / namespace and a new starttime,
 * while our own token is memoized from before the checkpoint — so a restored
 * holder may judge itself against a token that no longer describes it. Tokenless
 * records (a legacy pre-token hunch, any non-linux writer, an unreadable /proc)
 * get main's unchanged pid rule — a live same-host pid keeps its lock, a dead one
 * is stealable — with exactly one exception, the own-pid + foreign-nonce row
 * described in `judgeSameHostOwner`, which gets the AGE rule instead of main's
 * "live forever".
 */
import { readFileSync, readlinkSync } from "node:fs";

/** `starttime` in clock ticks since boot, as the exact decimal STRING the kernel
 *  printed — it is an identity component, never a quantity, so it is never
 *  converted to a Number (which would lose precision above 2^53 and invite
 *  arithmetic). `comm` (field 2) may contain spaces and parentheses, so the
 *  numeric fields are only unambiguous AFTER the last `)`. starttime is overall
 *  field 22, i.e. index 19 of that remainder (whose [0] is the state field). */
export function starttimeTicks(stat: string): string | null {
  const close = stat.lastIndexOf(")");
  if (close < 0) return null;
  const ticks = stat.slice(close + 1).trim().split(/\s+/)[19];
  return ticks !== undefined && /^\d+$/.test(ticks) ? ticks : null;
}

/** Reader seam so the pure token logic is testable off linux. */
interface ProcReader { read: (path: string) => string; readlink: (path: string) => string }

const realProc: ProcReader = {
  read: (path) => readFileSync(path, "utf8"),
  readlink: (path) => readlinkSync(path),
};

/** The process-instance token `<bootId>:<pidNsInum>:<timeNsInum>:<starttimeTicks>`
 *  for `pid` ("self" for us), or `null` when any piece is missing or malformed.
 *  Linux only, and no spawn: every piece is a file read.
 *
 *  The pid namespace is ALWAYS the caller's own (`/proc/self/ns/pid`), including
 *  when tokenizing another pid: a pid we can see in our `/proc` is by definition
 *  addressed in our namespace, so that is the namespace the token belongs to.
 *
 *  The TIME namespace matters because field 22 is rendered relative to the
 *  READER's time namespace: the same live process yields different ticks to
 *  readers in different time namespaces, so a token compared across them would
 *  read "recycled" for a perfectly healthy owner. Kernels before 5.6 have no
 *  `/proc/self/ns/time` at all — that one missing link is normalized to "0"
 *  (every process on such a kernel shares the same, only, time namespace).
 *
 *  `/proc` itself can be a view from an ANCESTOR pid namespace (a bind-mounted
 *  or not-remounted /proc inside a container), in which case `/proc/<pid>` names
 *  a process by the ancestor's numbering while `kill(pid, 0)` uses ours — two
 *  different pid spaces silently mixed. `readlink /proc/self` returns our pid AS
 *  /proc numbers it, so requiring it to equal our own `process.pid` is the cheap
 *  proof that the mount we are reading is our own namespace's. */
export function linuxStartToken(pid: number | "self", io: ProcReader = realProc, selfPid: number = process.pid): string | null {
  if (pid !== "self" && (!Number.isInteger(pid) || pid <= 0)) return null;
  try {
    // Validate our /proc VIEW first — it governs every path below, including the
    // "self" one (a foreign view makes even our own token describe someone else).
    if (io.readlink("/proc/self").trim() !== String(selfPid)) return null;
    const bootId = io.read("/proc/sys/kernel/random/boot_id").trim();
    if (!bootId || !/^[0-9a-fA-F-]+$/.test(bootId)) return null;
    // `readlink /proc/self/ns/pid` reads `pid:[4026531836]`.
    const pidns = /^pid:\[(\d+)\]$/.exec(io.readlink("/proc/self/ns/pid").trim())?.[1];
    if (pidns === undefined) return null;
    let timens: string;
    try {
      timens = /^time:\[(\d+)\]$/.exec(io.readlink("/proc/self/ns/time").trim())?.[1] ?? "";
    } catch {
      timens = "0"; // kernel < 5.6: no time namespaces exist, so there is only one
    }
    if (timens === "") return null; // the link exists but is not the shape we know
    const ticks = starttimeTicks(io.read(`/proc/${pid === "self" ? "self" : String(pid)}/stat`));
    if (ticks === null) return null;
    return `${bootId}:${pidns}:${timens}:${ticks}`;
  } catch {
    return null; // no /proc, hidepid, a pid that died mid-read — all unknown
  }
}

let selfToken: string | null | undefined;

/** OUR process-instance token, or `null` off linux / when /proc proves nothing.
 *  Only a NON-NULL token is memoized: a process's own identity never changes,
 *  but a transient failure to READ it (a momentarily unreadable /proc) must not
 *  be frozen into a permanent "we have no identity" for the life of the process. */
export function selfStartToken(): string | null {
  if (selfToken === undefined || selfToken === null) {
    const token = process.platform === "linux" ? linuxStartToken("self") : null;
    if (token !== null) selfToken = token;
    return token;
  }
  return selfToken;
}

/** The process-instance token of whoever currently holds `pid`, or `null` when
 *  that cannot be established (not linux, pid gone, /proc hidden). */
export function startTokenOf(pid: number): string | null {
  if (process.platform !== "linux") return null;
  if (pid === process.pid) return selfStartToken();
  return linuxStartToken(pid);
}

/** What the recorded owner is, relative to whoever holds its pid NOW.
 *  - `same`        — byte-identical token: the genuine owner, still running.
 *  - `recycled`    — the pid is held by a DIFFERENT process instance.
 *  - `unprobeable` — the pid number carries no meaning here (another boot, another
 *                    namespace, or a token read on a platform that has none), so
 *                    neither "alive" nor "dead" is evidence.
 *  - `unknown`     — no token recorded, or none readable now: not proven either way. */
export type InstanceVerdict = "same" | "recycled" | "unprobeable" | "unknown";

/** The whole verdict, pure and injectable. String comparison only — no clocks. */
export function ownerInstance(
  ownerStart: string | undefined,
  pid: number,
  self: string | null = selfStartToken(),
  tokenOf: (pid: number) => string | null = startTokenOf,
  platform: NodeJS.Platform = process.platform,
): InstanceVerdict {
  // A legacy or non-linux owner recorded no token: today's behaviour, unchanged.
  if (ownerStart === undefined || !/^[0-9a-fA-F-]+:\d+:\d+:\d+$/.test(ownerStart)) return "unknown";
  if (self === null) {
    // We cannot speak the owner's language. ON linux that only means our own
    // /proc proved nothing (hidepid, no mount, a foreign view): the pre-token pid
    // rule applies unchanged ("unknown"), because handing a live same-host owner
    // to the AGE rule would steal a slow writer's lock that was never stealable
    // before. OFF linux a token-bearing record was written by a DIFFERENT OS
    // instance that merely shares our hostname and volume (a linux container on
    // this machine), so its pid number means nothing here: age governs.
    return platform === "linux" ? "unknown" : "unprobeable";
  }
  // Written under another kernel boot or another pid/time namespace: the recorded
  // pid NUMBER means nothing in ours — a live pid here is a stranger, a dead one
  // is no evidence of the owner's death. Age governs instead.
  const prefix = (token: string): string => token.slice(0, token.lastIndexOf(":"));
  if (prefix(ownerStart) !== prefix(self)) return "unprobeable";
  const now = tokenOf(pid);
  if (now === null) return "unknown"; // died between probes, or /proc hidden for it
  return now === ownerStart ? "same" : "recycled";
}

/** Nonces of the locks THIS process currently holds.
 *
 *  The own-pid fallback for platforms without tokens: when the token path says
 *  "unknown" and the lock names OUR OWN pid, a nonce we do not hold means the
 *  lock is not one WE took — most likely a PREDECESSOR that happened to have this
 *  pid (the container-restart shape) — so the record falls to the age rule
 *  instead of our own liveness vouching for a corpse forever.
 *
 *  This is module state, i.e. per THREAD. `src/` has no `worker_threads` users
 *  (verified by grep), so every holder in a process shares this set; if a worker
 *  ever takes these locks, this fallback must be revisited. It is also per MODULE
 *  INSTANCE: were this module ever loaded twice in one process (a cache-busting
 *  import, a duplicated dependency), one copy would not recognise the other's
 *  held nonce and could age-steal its live lock. */
export const heldLockNonces = new Set<string>();

/** What a contender should do about a SAME-HOST lock owner.
 *  - `stale` — provably not the owner's process any more: take it over.
 *  - `live`  — authoritative, however old the file looks: never steal it.
 *  - `age`   — nothing is proven; fall back to the caller's own age rule. */
export type SameHostVerdict = "stale" | "live" | "age";

/** The parts of a lock record this decision reads. Both lock formats supply it. */
export interface SameHostOwner { pid: number; start?: string; nonce?: string }

/** Everything the decision consults, injected so every row is unit-testable. */
export interface SameHostEnv {
  alive: (pid: number) => boolean;
  self: string | null;
  tokenOf: (pid: number) => string | null;
  platform: NodeJS.Platform;
  selfPid: number;
  heldNonces: ReadonlySet<string>;
}

/**
 * THE decision table, shared by `src/serve/writelock.ts` and jsonStore's
 * `.rmw-lock` so the two locks can never drift apart. Pure: no clock, no fs, no
 * process state beyond what `env` hands it.
 */
export function judgeSameHostOwner(owner: SameHostOwner, env: SameHostEnv): SameHostVerdict {
  // 1. A lock THIS process holds is never stolen — not by a recycled-pid guess,
  //    not by age. Our own held nonce outranks every other signal.
  if (owner.nonce !== undefined && env.heldNonces.has(owner.nonce)) return "live";
  const verdict = ownerInstance(owner.start, owner.pid, env.self, env.tokenOf, env.platform);
  // 2. The pid number means nothing under this boot/namespace: neither its life
  //    nor its death is evidence. The caller's age rule governs, as for a
  //    foreign host.
  if (verdict === "unprobeable") return "age";
  // 3. A dead pid whose number IS meaningful here: the owner is gone.
  if (!env.alive(owner.pid)) return "stale";
  // 4. Alive, but a different process instance holds that pid (the recycled-pid
  //    hole, proven by string equality).
  if (verdict === "recycled") return "stale";
  // 5. Alive and byte-identical: the genuine owner, however old the file looks.
  if (verdict === "same") return "live";
  // 6. "unknown": no token on one side or the other. A live pid is never stolen
  //    on a guess, with one exception — a record naming OUR OWN pid whose nonce
  //    we do NOT hold (row 1 already returned for one we do). That is the
  //    container-restart shape: a predecessor with this pid left the lock, we
  //    are alive, and nobody would ever take it over.
  //
  //    WHY "age" AND NOT AN IMMEDIATE STEAL, ON EVERY PLATFORM. A nonce we do
  //    not hold proves only that the record is not THIS process's lock — NOT
  //    that whoever wrote it is dead. "Our pid" can be a LIVE NEIGHBOUR's in
  //    another pid space that happens to share our hostname and our volume: on
  //    linux, two containers sharing hostname + volume but not the pid namespace
  //    (k8s sidecars, `--net=host`); off linux, a linux GUEST of this machine
  //    (WSL2 shares the Windows hostname and /mnt/c by default; Docker Desktop
  //    bind mounts do the same). main never stole this shape at all — that is
  //    issue #287's forever-deadlock — so the age rule is what ends the deadlock,
  //    within the caller's own stale window, without ever stealing a FRESH lock
  //    that a live writer may still hold.
  if (owner.pid === env.selfPid && owner.nonce !== undefined) return "age";
  // A nonce-less own-pid record stays live: there is nothing to compare, and a
  // live pid is never stolen on a guess.
  return "live";
}
