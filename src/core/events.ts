/** The catch-log: an append-only, git-tracked JSONL trail of enforcement events
 *  (`.hunch/events.log`). Every time the deterministic gate actually BLOCKS an
 *  edit — a blocking invariant hit, or the Veto Guard reversing a rejected
 *  approach — one line is appended here. Without this trail "the graph caught 37
 *  violations" is an assertion; with it, it is a measurement (dec_6253f7e6d6).
 *
 *  WHY append-only (not temp-file+rename like the JSON index, con_902759b3dc):
 *  the atomicity invariant exists so an interrupted write can never TRUNCATE the
 *  index. A single-line append can never truncate what is already on disk — it
 *  only ever extends it — so it honors that invariant's spirit without the O(n)
 *  read-modify-write a rewrite would cost per event. The log is a derived audit
 *  trail, never a source of truth: a lost or malformed line loses one catch's
 *  provenance, never a decision.
 *
 *  HONESTY (dec_6253f7e6d6): a constraint/veto block carries NO subject/object/
 *  assert — those are conformance-only predicates checked by a different gate
 *  (`hunch conform`), not the edit hook. This schema records only what each gate
 *  actually knows; it never fabricates the conformance shape for a plain block. */
import { appendFileSync, readFileSync } from "node:fs";
import { join } from "node:path";
import type { HunchPaths } from "./paths.js";

/** One enforcement event. `kind` is open-ended so the conformance/drift gates can
 *  append their own shapes later; `subject`/`object`/`assert` stay OPTIONAL and
 *  are populated ONLY by a gate that genuinely has them (never a plain block). */
export interface HunchEvent {
  /** ISO instant the gate fired. */
  at: string;
  kind: "constraint" | "veto" | "conformance" | "drift";
  /** Repo-relative file the blocked edit targeted. */
  file: string;
  /** Decision the block enforces (veto/conformance carry this; a bare constraint may not). */
  decision?: string;
  /** Constraint id, when the block came from a blocking invariant. */
  constraint?: string;
  /** Human-readable rule text, for receipts. */
  statement?: string;
  /** Conformance-only predicate shape — never set by a constraint/veto block. */
  subject?: string;
  object?: string;
  assert?: string;
}

export function eventsLogPath(paths: HunchPaths): string {
  return join(paths.hunch, "events.log");
}

/** Append one event as a JSONL line. Best-effort and never throws: the primary
 *  call site is the edit hook, which MUST NEVER break an agent on failure
 *  (con_03a0b94b2e). A dropped catch-log line is an acceptable loss. */
export function appendEvent(paths: HunchPaths, event: HunchEvent): void {
  try {
    appendFileSync(eventsLogPath(paths), `${JSON.stringify(event)}\n`);
  } catch {
    /* best effort — a lost audit line must never surface to the agent */
  }
}

/** Read + parse the catch-log. Malformed lines are skipped, not fatal (the log is
 *  derived; one bad line never poisons the aggregation). Missing log → []. */
export function readEvents(paths: HunchPaths): HunchEvent[] {
  let raw: string;
  try {
    raw = readFileSync(eventsLogPath(paths), "utf8");
  } catch {
    return []; // no catches recorded yet
  }
  const out: HunchEvent[] = [];
  for (const line of raw.split("\n")) {
    const s = line.trim();
    if (!s) continue;
    try {
      const e = JSON.parse(s) as HunchEvent;
      if (e && typeof e.at === "string" && typeof e.kind === "string") out.push(e);
    } catch {
      /* skip a corrupt line */
    }
  }
  return out;
}
