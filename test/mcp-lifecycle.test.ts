import { cleanupDir } from "./fixtures.js";
import { test } from "node:test";
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { mkdtempSync, mkdirSync, readFileSync, writeFileSync, existsSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";
import { HunchStore } from "../src/store/hunchStore.js";
import { hunchPaths } from "../src/core/paths.js";
import { buildServer } from "../src/mcp/server.js";

type ToolText = { content: Array<{ type: string; text?: string }>; isError?: boolean };
const text = (r: ToolText) => r.content.map((c) => c.text ?? "").join("\n");

function git(root: string, ...args: string[]): void {
  execFileSync("git", args, { cwd: root, encoding: "utf8" });
}

async function setup(t: { after: (f: () => Promise<void>) => void }) {
  const root = mkdtempSync(join(tmpdir(), "hunch-mcp-lifecycle-"));
  git(root, "init", "-q");
  git(root, "config", "user.name", "t");
  git(root, "config", "user.email", "t@example.invalid");
  writeFileSync(join(root, "app.ts"), "export const v = 1;\n");
  git(root, "add", ".");
  git(root, "commit", "-qm", "fixture");
  mkdirSync(join(root, ".hunch"), { recursive: true });
  writeFileSync(join(root, ".hunch", "local.json"), '{"autoCommit":false}\n');
  const server = buildServer(root);
  const [ct, st] = InMemoryTransport.createLinkedPair();
  const client = new Client({ name: "mcp-lifecycle-test", version: "0.0.0" });
  await Promise.all([server.connect(st), client.connect(ct)]);
  t.after(async () => {
    await client.close().catch(() => {});
    await server.close().catch(() => {});
    cleanupDir(root);
  });
  return { root, client };
}

test("correction and decision land as drafts with run provenance; challenge keeps the rule enforced", async (t) => {
  process.env.HUNCH_RUN_ID = "run-test-1";
  t.after(async () => { delete process.env.HUNCH_RUN_ID; });
  const { root, client } = await setup(t);

  const rec = await client.callTool({ name: "hunch_record_correction", arguments: { rule: "never edit app.ts directly", scope_hint_file: "app.ts" } }) as ToolText;
  assert.ok(!rec.isError, text(rec));
  assert.match(text(rec), /DRAFT/);
  const id = /con_[0-9a-f]+/.exec(text(rec))![0];
  const file = join(root, ".hunch", "constraints", `${id}.json`);
  const stored = JSON.parse(readFileSync(file, "utf8"));
  assert.equal(stored.status, "draft");
  assert.equal(stored.source_run, "run-test-1");

  const dec = await client.callTool({ name: "hunch_record_decision", arguments: { decision: { title: "use sqlite", decision: "sqlite", context: "c" } } }) as ToolText;
  assert.ok(!dec.isError, text(dec));
  const dfile = join(root, ".hunch", "decisions");
  const dstored = JSON.parse(readFileSync(join(dfile, execFileSync("node", ["-e", `console.log(require("fs").readdirSync(${JSON.stringify(dfile)})[0])`], { encoding: "utf8" }).trim()), "utf8"));
  assert.equal(dstored.source_run, "run-test-1");

  const ch = await client.callTool({ name: "hunch_challenge", arguments: { rule_id: id, reason: "blocks the legit refactor" } }) as ToolText;
  assert.ok(!ch.isError, text(ch));
  const after = JSON.parse(readFileSync(file, "utf8"));
  assert.equal(after.challenge.reason, "blocks the legit refactor");
  assert.equal(after.challenge.by_run, "run-test-1");
  assert.equal(after.status, "draft");
  assert.ok(existsSync(join(root, ".hunch", "local", "rule-checks.jsonl")));
  // A challenged rule is still returned as enforced.
  const store = new HunchStore(hunchPaths(root));
  try {
    const hit = store.checkConstraints("app.ts").find((c) => c.id === id);
    assert.ok(hit, "challenged rule must still be returned by checkConstraints");
    assert.notEqual(hit!.status, "retired");
    assert.ok(hit!.challenge);
  } finally { store.close(); }

  const bad = await client.callTool({ name: "hunch_challenge", arguments: { rule_id: "con_missing", reason: "x" } }) as ToolText;
  assert.ok(bad.isError);
  assert.match(text(bad), /^Refused:/);
});

test("agents have no MCP tool to clear a challenge or activate a draft", async (t) => {
  const { client } = await setup(t);
  const names = (await client.listTools()).tools.map((x) => x.name);
  assert.ok(names.includes("hunch_challenge"));
  for (const n of names) assert.doesNotMatch(n, /clear|activate|confirm|approve/);
});

test("re-recording an active or challenged rule is refused and changes nothing; a draft may be re-recorded", async (t) => {
  const { root, client } = await setup(t);
  const args = { rule: "never edit app.ts directly", scope_hint_file: "app.ts" };
  const rec = await client.callTool({ name: "hunch_record_correction", arguments: args }) as ToolText;
  assert.ok(!rec.isError, text(rec));
  const id = /con_[0-9a-f]+/.exec(text(rec))![0];
  const file = join(root, ".hunch", "constraints", `${id}.json`);
  // A draft re-record is still allowed and stays a draft.
  const draftAgain = await client.callTool({ name: "hunch_record_correction", arguments: { ...args, rationale: "second reason" } }) as ToolText;
  assert.ok(!draftAgain.isError, text(draftAgain));
  assert.equal(JSON.parse(readFileSync(file, "utf8")).status, "draft");
  const legacy = JSON.parse(readFileSync(file, "utf8"));
  legacy.status = "active";
  writeFileSync(file, JSON.stringify(legacy, null, 2));
  const before = readFileSync(file, "utf8");
  const refusedActive = await client.callTool({ name: "hunch_record_correction", arguments: { ...args, scope_hint_file: "other.ts", severity: "blocking", rationale: "widen it" } }) as ToolText;
  assert.ok(refusedActive.isError, text(refusedActive));
  assert.match(text(refusedActive), /hunch_challenge/);
  assert.equal(readFileSync(file, "utf8"), before);
  const ch = await client.callTool({ name: "hunch_challenge", arguments: { rule_id: id, reason: "wrong" } }) as ToolText;
  assert.ok(!ch.isError, text(ch));
  const challenged = readFileSync(file, "utf8");
  const refusedChallenged = await client.callTool({ name: "hunch_record_correction", arguments: { ...args, rationale: "again" } }) as ToolText;
  assert.ok(refusedChallenged.isError, text(refusedChallenged));
  assert.equal(readFileSync(file, "utf8"), challenged);
});

test("re-recording a retired rule through MCP yields a draft, not live authority", async (t) => {
  const { root, client } = await setup(t);
  const args = { rule: "never edit app.ts directly", scope_hint_file: "app.ts" };
  const first = await client.callTool({ name: "hunch_record_correction", arguments: args }) as ToolText;
  const id = /con_[0-9a-f]+/.exec(text(first))![0];
  const file = join(root, ".hunch", "constraints", `${id}.json`);
  const rec = JSON.parse(readFileSync(file, "utf8"));
  writeFileSync(file, JSON.stringify({ ...rec, status: "retired", valid_to: "2026-01-01T00:00:00.000Z", retired_from: "active" }));
  const again = await client.callTool({ name: "hunch_record_correction", arguments: args }) as ToolText;
  assert.ok(!again.isError, text(again));
  assert.match(text(again), new RegExp(`Recorded ${id} as a draft; a person approves it with .hunch review --confirm ${id}.`));
  assert.doesNotMatch(text(again), /now flags/);
  const back = JSON.parse(readFileSync(file, "utf8"));
  assert.equal(back.status, "draft");
  assert.equal(back.valid_to, null);
  assert.equal(back.retired_from, undefined);
  assert.equal(back.challenge, null);
  assert.ok(!back.provenance.source.split("+").includes("human_confirmed"));
});

test("a human-confirmed retired rule is still refused on re-record", async (t) => {
  const { root, client } = await setup(t);
  const args = { rule: "never edit app.ts directly", scope_hint_file: "app.ts" };
  const first = await client.callTool({ name: "hunch_record_correction", arguments: args }) as ToolText;
  const id = /con_[0-9a-f]+/.exec(text(first))![0];
  const file = join(root, ".hunch", "constraints", `${id}.json`);
  const rec = JSON.parse(readFileSync(file, "utf8"));
  writeFileSync(file, JSON.stringify({ ...rec, status: "retired", valid_to: "2026-01-01T00:00:00.000Z", provenance: { ...rec.provenance, source: "human_confirmed" } }));
  const again = await client.callTool({ name: "hunch_record_correction", arguments: args }) as ToolText;
  assert.match(text(again), /already human-confirmed/);
  assert.equal(JSON.parse(readFileSync(file, "utf8")).status, "retired");
});
