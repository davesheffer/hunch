/** Rule lifecycle: draft -> active -> (challenged) -> retired. Helpers over the store. */
import { appendFileSync, closeSync, constants, fstatSync, lstatSync, mkdirSync, openSync, renameSync, unlinkSync, writeFileSync, type Stats } from "node:fs";
import { join } from "node:path";
import { storeArtifactPath } from "./storeArtifact.js";
import type { Constraint } from "./types.js";
import type { HunchStore } from "../store/hunchStore.js";

/** The one way a rule is retired: closes the window and remembers the pre-retire status so a restore returns to it. */
export function retireRecord<T extends Constraint>(con: T, now: string, extra: Partial<Constraint> = {}): T {
  return { ...con, ...extra, status: "retired", valid_to: now, ...(con.status === "draft" || con.status === "active" ? { retired_from: con.status } : {}) };
}

export type RuleState = "draft" | "active" | "challenged" | "retired";

function find(store: HunchStore, id: string): Constraint {
  const c = store.recs("constraints").find((r) => r.id === id);
  if (!c) throw new Error(`no such rule: ${id}`);
  return c;
}

export function displayState(c: Constraint): RuleState {
  if (c.status === "retired") return "retired";
  if (c.status === "draft") return "draft";
  return c.challenge ? "challenged" : "active";
}

/** Open a challenge; the rule stays enforced (status unchanged). */
export function challengeRule(store: HunchStore, id: string, o: { reason: string; by_session?: string | null; by_run?: string | null }): Constraint {
  const c = find(store, id);
  if (c.status === "retired") throw new Error(`${id} is retired; nothing to challenge`);
  // An existing challenge is a record of who disputed the rule and why; only a person's `challenge clear` removes it.
  if (c.challenge) throw new Error(`${id} is already challenged (${c.challenge.reason}); the existing challenge is kept. A person can clear it with: hunch challenge clear ${id} --reason "<why>"`);
  const reason = (o.reason ?? "").trim();
  if (!reason) throw new Error("a challenge needs a non-empty reason");
  return store.putWhereItLives("constraints", {
    ...c, challenge: { reason, by_session: o.by_session ?? null, by_run: o.by_run ?? null, at: new Date().toISOString() },
  });
}

/** Clear a challenge. The reason is kept in the rule's rationale trail (the store has no separate audit log; git history holds the rest). */
export function clearChallenge(store: HunchStore, id: string, o: { reason: string }): Constraint {
  const c = find(store, id);
  if (!c.challenge) throw new Error(`${id} has no open challenge`);
  const reason = (o.reason ?? "").trim();
  const note = `Challenge cleared ${new Date().toISOString()}${reason ? `: ${reason}` : ""}`;
  return store.putWhereItLives("constraints", { ...c, challenge: null, rationale: c.rationale ? `${c.rationale}\n${note}` : note });
}

export function activateRule(store: HunchStore, id: string): Constraint {
  const c = find(store, id);
  if (c.status !== "draft") throw new Error(`${id} is ${c.status}, not draft`);
  return store.putWhereItLives("constraints", { ...c, status: "active" });
}

/** Retire `oldId` in favour of `newId` (a draft successor becomes active). ConstraintSchema has no
 *  superseded_by field, so the link is recorded in the old rule's rationale ("Superseded by con_x"). */
export function replaceRule(store: HunchStore, oldId: string, newId: string, o: { reason?: string } = {}): { old: Constraint; next: Constraint } {
  if (oldId === newId) throw new Error("a rule cannot replace itself");
  const old = find(store, oldId), next = find(store, newId);
  if (old.status === "retired") throw new Error(`${oldId} is already retired`);
  if (next.status === "retired") throw new Error(`${newId} is retired and cannot replace ${oldId}`);
  const now = new Date().toISOString();
  const reason = o.reason?.trim();
  const note = `Superseded by ${newId} ${now}${reason ? `: ${reason}` : ""}`;
  const nextSaved = next.status === "draft" ? store.putWhereItLives("constraints", { ...next, status: "active" }) : next;
  const oldSaved = store.putWhereItLives("constraints", {
    ...retireRecord(old, now, { rationale: old.rationale ? `${old.rationale}\n${note}` : note }),
  });
  return { old: oldSaved, next: nextSaved };
}

const SUPERSEDED_RE = /Superseded by (con_[A-Za-z0-9_]+)/;

function sourceDecision(store: HunchStore, c: Constraint) {
  return c.source_decision ? store.recs("decisions").find((d) => d.id === c.source_decision) : undefined;
}

export function ruleView(store: HunchStore, c: Constraint) {
  const dec = sourceDecision(store, c);
  return {
    id: c.id, statement: c.statement, severity: c.severity, scope: c.scope, status: displayState(c),
    challenge: c.challenge ?? null, source_decision: c.source_decision ?? null,
    source_session: c.source_session ?? null, source_run: c.source_run ?? null,
    why: dec ? { id: dec.id, title: dec.title } : null,
    superseded_by: c.status === "retired" ? (SUPERSEDED_RE.exec(c.rationale ?? "")?.[1] ?? null) : null,
    valid_from: c.valid_from ?? null, valid_to: c.valid_to ?? null,
  };
}

export function ruleDetail(store: HunchStore, id: string) {
  const c = find(store, id);
  const dec = sourceDecision(store, c);
  return {
    ...ruleView(store, c),
    why_detail: dec
      ? {
          id: dec.id, title: dec.title, rationale: dec.decision && dec.context ? `${dec.decision}\n${dec.context}` : (dec.decision || dec.context || ""),
          rejected: (dec.alternatives_rejected ?? []).map((option) => ({ option, reason: "" })),
        }
      : null,
  };
}

/** Size at which the rule-check log is rotated to rule-checks.jsonl.1 (mutable so tests can lower it). */
export const ruleLogLimits = { maxBytes: 4 * 1024 * 1024 };

function lstatOrNull(path: string): Stats | null {
  try { return lstatSync(path); } catch (e) { if ((e as NodeJS.ErrnoException).code === "ENOENT") return null; throw e; }
}

/** Append JSON lines to <root>/.hunch/local/rule-checks.jsonl. Same safe open as
 *  events.log: symlinked/junctioned .hunch or .hunch/local, a symlinked or hard-linked
 *  log, and a swapped file are all refused. Rotates to .1 at the size cap. Never throws. */
export function appendRuleLog(root: string, entry: Record<string, unknown> | Array<Record<string, unknown>>): void {
  let fd: number | undefined;
  try {
    const hunchDir = join(root, ".hunch");
    storeArtifactPath(hunchDir); // refuses a symlinked .hunch
    const dir = storeArtifactPath(hunchDir, "local");
    if (!lstatOrNull(dir)) mkdirSync(dir, { recursive: true });
    const ign = storeArtifactPath(hunchDir, "local", ".gitignore");
    if (!lstatOrNull(ign)) writeFileSync(ign, "*\n", { flag: "wx" });
    const file = storeArtifactPath(hunchDir, "local", "rule-checks.jsonl");
    const st = lstatOrNull(file);
    if (st && st.isFile() && st.size >= ruleLogLimits.maxBytes) {
      // Best effort: a non-regular .1 (directory, symlink) must not stop logging for good.
      const old = storeArtifactPath(hunchDir, "local", "rule-checks.jsonl.1");
      const oldSt = lstatOrNull(old);
      if (!oldSt || oldSt.isFile()) {
        if (oldSt) unlinkSync(old);
        renameSync(file, old);
      }
    }
    fd = openSync(file, constants.O_WRONLY | constants.O_APPEND | constants.O_CREAT | constants.O_NOFOLLOW);
    const opened = fstatSync(fd);
    const current = lstatSync(storeArtifactPath(hunchDir, "local", "rule-checks.jsonl"));
    if (!opened.isFile() || opened.nlink !== 1 || opened.dev !== current.dev || opened.ino !== current.ino) return;
    appendFileSync(fd, (Array.isArray(entry) ? entry : [entry]).map((e) => JSON.stringify(e) + "\n").join(""));
  } catch { /* logging must never break the caller */ }
  finally { if (fd !== undefined) { try { closeSync(fd); } catch { /* best effort */ } } }
}

export function currentRunContext(evtSessionId?: string | null): { session_id: string | null; run_id: string | null } {
  return {
    session_id: evtSessionId || process.env.CLAUDE_SESSION_ID || null,
    run_id: process.env.HUNCH_RUN_ID || null,
  };
}
