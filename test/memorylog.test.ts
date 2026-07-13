import { test } from "node:test";
import assert from "node:assert/strict";
import { parseMemoryLog, MEMLOG_HEADER } from "../src/core/memorylog.js";

// A canned `git log --format=@@@%H\t%h\t%cI\t%s --name-status -- .hunch/` body.
// Record ids are hex hashes (dec_/bug_ + [0-9a-f]) — mirror the real id shape.
const H = MEMLOG_HEADER;
const RAW = [
  `${H}aaaa1111\taaaa111\t2026-07-13T10:00:00Z\thunch: capture dec_abc123`,
  "A\t.hunch/decisions/dec_abc123.json",
  "",
  `${H}bbbb2222\tbbbb222\t2026-07-12T09:00:00Z\tchore(hunch): adopt the legacy draft backlog`,
  "M\t.hunch/decisions/dec_01d111.json",
  "M\t.hunch/decisions/dec_02d222.json",
  "",
  `${H}cccc3333\tcccc333\t2026-07-11T08:00:00Z\tprune duplicate drafts`,
  "D\t.hunch/decisions/dec_0d0999.json",
  "",
  `${H}dddd4444\tdddd444\t2026-07-10T07:00:00Z\tfeat: something that also touched a bug`,
  "M\t.hunch/bugs/bug_777aaa.json",
  "A\t.hunch/decisions/dec_5e5555.json",
].join("\n");

test("parseMemoryLog: classifies capture / adopt / prune and extracts ids, newest first", () => {
  const moves = parseMemoryLog(RAW);
  assert.equal(moves.length, 4);

  assert.equal(moves[0]!.kind, "capture");       // subject "capture" + a lone add
  assert.deepEqual(moves[0]!.decisionIds, ["dec_abc123"]);
  assert.equal(moves[0]!.added, 1);
  assert.equal(moves[0]!.shortSha, "aaaa111");

  assert.equal(moves[1]!.kind, "adopt");          // subject "adopt"
  assert.deepEqual(moves[1]!.decisionIds, ["dec_01d111", "dec_02d222"]);
  assert.equal(moves[1]!.modified, 2);

  assert.equal(moves[2]!.kind, "prune");          // only a delete
  assert.deepEqual(moves[2]!.decisionIds, ["dec_0d0999"]);
  assert.equal(moves[2]!.deleted, 1);

  assert.equal(moves[3]!.kind, "edit");           // mixed add+modify, no keyword
  assert.deepEqual(moves[3]!.otherIds, ["bug_777aaa"]);
  assert.deepEqual(moves[3]!.decisionIds, ["dec_5e5555"]);
});

test("parseMemoryLog: empty input → no moves", () => {
  assert.deepEqual(parseMemoryLog(""), []);
});

test("parseMemoryLog: ignores non-.hunch paths in a mixed commit", () => {
  const raw = [
    `${H}eeee5555\teeee555\t2026-07-13T10:00:00Z\tfeat: code + memory`,
    "M\tsrc/cli/index.ts",
    "A\t.hunch/decisions/dec_abcdef.json",
  ].join("\n");
  const moves = parseMemoryLog(raw);
  assert.equal(moves.length, 1);
  assert.deepEqual(moves[0]!.files, [".hunch/decisions/dec_abcdef.json"]);
  assert.deepEqual(moves[0]!.decisionIds, ["dec_abcdef"]);
  assert.equal(moves[0]!.kind, "capture");
});
