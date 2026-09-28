import { test } from "node:test";
import assert from "node:assert/strict";
import { writeFileSync, mkdirSync, rmSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { consumeInjectionBudget, injectionMode, peekInjectionMode, resetSessionInjections } from "../src/core/hookcache.js";

const SID = () => `hunch-test-${process.pid}-${Math.floor(performance.now() * 1000)}`;

test("hookcache: first injection is full, identical repeat is delta, changed content is full again", () => {
  const sid = SID();
  assert.equal(injectionMode(sid, "pre:src/a.ts", "GROUNDING v1"), "full");
  assert.equal(injectionMode(sid, "pre:src/a.ts", "GROUNDING v1"), "delta");
  assert.equal(injectionMode(sid, "pre:src/a.ts", "GROUNDING v2"), "full", "record change re-sends the full block");
  assert.equal(injectionMode(sid, "pre:src/b.ts", "GROUNDING v1"), "full", "keys are independent");
});

test("hookcache: sessions are isolated; missing session id and kill switch always mean full", () => {
  const a = SID(), b = SID();
  assert.equal(injectionMode(a, "k", "X"), "full");
  assert.equal(injectionMode(b, "k", "X"), "full", "another session gets its own first-time full");
  assert.equal(injectionMode(undefined, "k", "X"), "full");
  assert.equal(injectionMode(undefined, "k", "X"), "full", "no session id → never dedups");
  const prev = process.env.HUNCH_HOOK_DEDUP;
  process.env.HUNCH_HOOK_DEDUP = "0";
  try {
    const c = SID();
    assert.equal(injectionMode(c, "k", "X"), "full");
    assert.equal(injectionMode(c, "k", "X"), "full", "kill switch disables dedup");
  } finally {
    if (prev === undefined) delete process.env.HUNCH_HOOK_DEDUP;
    else process.env.HUNCH_HOOK_DEDUP = prev;
  }
});

test("hookcache: resetSessionInjections forgets a session — compaction must re-deliver in full", () => {
  const sid = SID();
  assert.equal(injectionMode(sid, "pre:src/a.ts", "GROUNDING"), "full");
  assert.equal(injectionMode(sid, "pre:src/a.ts", "GROUNDING"), "delta");
  resetSessionInjections(sid);
  assert.equal(injectionMode(sid, "pre:src/a.ts", "GROUNDING"), "full", "post-compact identical grounding is full again");
  const other = SID();
  assert.equal(injectionMode(other, "k", "X"), "full");
  resetSessionInjections(undefined); // no session id — must be a safe no-op
  assert.equal(injectionMode(other, "k", "X"), "delta", "resetting nothing leaves other sessions intact");
});

test("hookcache: an explicit hashInput dedups on record identity, not on presentation", () => {
  const sid = SID();
  // Self-invalidating content: serving it moves the wording ("today" →
  // "delivered today") with no record change. The identity is what must decide.
  assert.equal(injectionMode(sid, "pre:src/a.ts", "task htask_1 · today", "htask_1@rev1"), "full");
  assert.equal(
    injectionMode(sid, "pre:src/a.ts", "task htask_1 · delivered today", "htask_1@rev1"),
    "delta",
    "different content, same record identity → delta; a delivery receipt cannot re-send the full block",
  );
  assert.equal(
    injectionMode(sid, "pre:src/a.ts", "task htask_1 · today", "htask_1@rev2"),
    "full",
    "the record's own content changed → full, even though this text was shown before",
  );
});

test("hookcache: omitting hashInput keeps the documented content-hash contract", () => {
  const sid = SID();
  assert.equal(injectionMode(sid, "k", "GROUNDING v1"), "full");
  assert.equal(injectionMode(sid, "k", "GROUNDING v1"), "delta");
  // A caller that passes content as its own hash input is identical to omitting it.
  assert.equal(injectionMode(sid, "k", "GROUNDING v1", "GROUNDING v1"), "delta");
  assert.equal(injectionMode(sid, "k", "GROUNDING v2"), "full", "no hashInput → any content change is still a change");
  // The two modes share one map per key, so a stable identity keyed the same way
  // still dedups against what a content-hashed call recorded.
  const other = SID();
  assert.equal(injectionMode(other, "k", "X", "id-1"), "full");
  assert.equal(injectionMode(other, "k", "Y", "id-1"), "delta");
});

test("hookcache: a corrupt cache file degrades to full (grounded beats deduped), then recovers", () => {
  const sid = SID();
  assert.equal(injectionMode(sid, "k", "X"), "full");
  const dir = join(tmpdir(), "hunch-hookcache");
  mkdirSync(dir, { recursive: true });
  writeFileSync(join(dir, `${sid}.json`), "{not json");
  assert.equal(injectionMode(sid, "k", "X"), "full", "corrupt file must not fake a delta");
  assert.equal(injectionMode(sid, "k", "X"), "delta", "cache rebuilt after the corrupt read");
});

test("hookcache: peekInjectionMode answers like injectionMode but never records", () => {
  const sid = SID();
  assert.equal(peekInjectionMode(sid, "pre:src/a.ts", "G", "id-1"), "full");
  assert.equal(peekInjectionMode(sid, "pre:src/a.ts", "G", "id-1"), "full", "a peek is not a delivery");
  assert.equal(injectionMode(sid, "pre:src/a.ts", "G", "id-1"), "full", "so the first real injection is still full");
  assert.equal(peekInjectionMode(sid, "pre:src/a.ts", "G", "id-1"), "delta");
  assert.equal(peekInjectionMode(sid, "pre:src/a.ts", "G", "id-2"), "full", "a record change reads as full");
  assert.equal(peekInjectionMode(undefined, "pre:src/a.ts", "G", "id-1"), "full");
});

test("hookcache: consumeInjectionBudget charges until the limit, refuses the crossing charge, keys are independent", () => {
  const sid = SID();
  assert.equal(consumeInjectionBudget(sid, "grounding", 5000, 8000), true);
  assert.equal(consumeInjectionBudget(sid, "grounding", 3000, 8000), true, "exactly at the limit still fits");
  assert.equal(consumeInjectionBudget(sid, "grounding", 1, 8000), false, "past the limit is refused");
  assert.equal(consumeInjectionBudget(sid, "grounding:agent", 8000, 8000), true, "another agent identity has its own budget");
  const fresh = SID();
  assert.equal(consumeInjectionBudget(fresh, "grounding", 9000, 8000), false, "a single charge over the limit is refused");
  assert.equal(consumeInjectionBudget(fresh, "grounding", 8000, 8000), true, "and a refused charge used nothing");
});

test("hookcache: the budget resets with the session and survives the dedup map's trim", () => {
  const sid = SID();
  assert.equal(consumeInjectionBudget(sid, "grounding", 7000, 8000), true);
  for (let i = 0; i < 350; i++) injectionMode(sid, `pre:src/f${i}.ts`, "G");
  assert.equal(consumeInjectionBudget(sid, "grounding", 2000, 8000), false, "trimming dedup keys must not hand out a fresh budget");
  resetSessionInjections(sid);
  assert.equal(consumeInjectionBudget(sid, "grounding", 2000, 8000), true, "compaction resets the budget");
});

test("hookcache: the budget fails toward grounding — no session, kill switch, corrupt or unreadable cache", t => {
  assert.equal(consumeInjectionBudget(undefined, "grounding", 9000, 8000), true);
  const prev = process.env.HUNCH_HOOK_DEDUP;
  process.env.HUNCH_HOOK_DEDUP = "0";
  try {
    assert.equal(consumeInjectionBudget(SID(), "grounding", 9000, 8000), true, "the dedup kill switch disables the budget");
  } finally {
    if (prev === undefined) delete process.env.HUNCH_HOOK_DEDUP;
    else process.env.HUNCH_HOOK_DEDUP = prev;
  }
  const dir = join(tmpdir(), "hunch-hookcache");
  mkdirSync(dir, { recursive: true });
  const corrupt = SID();
  writeFileSync(join(dir, `${corrupt}.json`), "{not json");
  assert.equal(consumeInjectionBudget(corrupt, "grounding", 9000, 8000), true, "a corrupt cache is a cache error, not an empty budget");
  const unreadable = SID();
  mkdirSync(join(dir, `${unreadable}.json`));
  t.after(() => rmSync(join(dir, `${unreadable}.json`), { recursive: true, force: true }));
  assert.equal(consumeInjectionBudget(unreadable, "grounding", 9000, 8000), true);
  assert.equal(peekInjectionMode(unreadable, "k", "X"), "full");
});
