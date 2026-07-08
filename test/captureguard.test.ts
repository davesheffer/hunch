/**
 * Shared-mode capture guard (regression for the willClose keying bug): the
 * uniqueness guard must key its incumbent lookup on the store the write
 * actually LANDS in (captureHome), not on the private flag — in unified
 * ("shared") mode those disagree (home is the overlay even for private:false).
 * Keying on the flag let a shared-mode supersede of a public incumbent pass
 * the guard and then no-op the close: two live decisions on one topic.
 * Exercised through the REAL MCP handler via an in-memory transport.
 * Also covers the `deciding` verdict-loop mode of hunch_capture_decision.
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, rmSync, mkdirSync, writeFileSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";
import { buildServer } from "../src/mcp/server.js";
import { HunchStore } from "../src/store/hunchStore.js";
import { hunchPaths } from "../src/core/paths.js";
import { liveForTopic } from "../src/core/topics.js";

const DEC = (id: string, topic: string, title: string) => ({
  id, title, topic, status: "accepted", context: "", decision: `body of ${title}`,
  consequences: [], alternatives_rejected: [], rejected_tripwires: [],
  related_components: [], related_files: [], supersedes: null, superseded_by: null,
  caused_by_bug: null, commit: null, valid_from: "2026-01-01T00:00:00.000Z", valid_to: null,
  retired: { symbols: [], deps: [] },
  provenance: { source: "human_confirmed", confidence: 0.95, evidence: [] },
  date: "2026-01-01T00:00:00.000Z",
});

/** A repo in unified ("shared") mode: overlay configured via local.json, every
 *  capture routes to the overlay regardless of the private flag. */
async function sharedSetup() {
  const root = mkdtempSync(join(tmpdir(), "hunch-shared-"));
  const overlay = mkdtempSync(join(tmpdir(), "hunch-shared-ovl-"));
  const prevEnv = process.env.HUNCH_PRIVATE_DIR;
  delete process.env.HUNCH_PRIVATE_DIR; // local.json must be the source of the overlay config
  mkdirSync(join(root, ".hunch", "decisions"), { recursive: true });
  mkdirSync(join(overlay, "decisions"), { recursive: true });
  writeFileSync(join(root, ".hunch", "local.json"), JSON.stringify({ privateDir: overlay, mode: "shared", autoCommit: false }));
  return {
    root, overlay,
    connect: async () => {
      const server = buildServer(root);
      const [ct, st] = InMemoryTransport.createLinkedPair();
      const client = new Client({ name: "test", version: "0.0.0" });
      await Promise.all([server.connect(st), client.connect(ct)]);
      return client;
    },
    cleanup: (client?: Client) => {
      void client?.close().catch(() => {});
      if (prevEnv === undefined) delete process.env.HUNCH_PRIVATE_DIR;
      else process.env.HUNCH_PRIVATE_DIR = prevEnv;
      // Windows: the server's sqlite handle may still hold the dir; best-effort.
      for (const d of [root, overlay]) {
        try { rmSync(d, { recursive: true, force: true, maxRetries: 3, retryDelay: 50 }); } catch { /* temp dir, OS reaps */ }
      }
    },
  };
}

type ToolText = { content: Array<{ type: string; text?: string }>; isError?: boolean };
const record = async (client: Client, decision: Record<string, unknown>) => {
  const res = (await client.callTool({ name: "hunch_record_decision", arguments: { decision } })) as ToolText;
  return { isError: !!res.isError, text: res.content.map((c) => c.text ?? "").join("\n") };
};

test("shared mode: supersede of a PUBLIC incumbent is REFUSED (never a silent two-live no-op)", async (t) => {
  const s = await sharedSetup();
  let client: Client | undefined;
  t.after(() => s.cleanup(client));
  writeFileSync(join(s.root, ".hunch", "decisions", "dec_pubaaaaaa.json"), JSON.stringify(DEC("dec_pubaaaaaa", "guard.pub", "public incumbent")));
  client = await s.connect();

  const r = await record(client, { title: "successor", topic: "guard.pub", status: "accepted", decision: "new", supersedes: "dec_pubaaaaaa" });
  assert.equal(r.isError, true, `guard must refuse, got: ${r.text}`);
  assert.match(r.text, /already has a live decision/);
  assert.match(r.text, /private store this write lands in/);

  const store = new HunchStore(hunchPaths(s.root));
  t.after(() => store.close());
  const live = liveForTopic(store.recs("decisions"), "guard.pub");
  assert.deepEqual(live.map((d) => d.id), ["dec_pubaaaaaa"], "exactly the incumbent stays live");
  const onDisk = JSON.parse(readFileSync(join(s.root, ".hunch", "decisions", "dec_pubaaaaaa.json"), "utf8"));
  assert.equal(onDisk.status, "accepted", "public incumbent untouched");
});

test("shared mode: supersede of an OVERLAY incumbent with private:false SUCCEEDS and closes it (no false refusal)", async (t) => {
  const s = await sharedSetup();
  let client: Client | undefined;
  t.after(() => s.cleanup(client));
  writeFileSync(join(s.overlay, "decisions", "dec_privbbbbbb.json"), JSON.stringify(DEC("dec_privbbbbbb", "guard.ovl", "overlay incumbent")));
  client = await s.connect();

  const r = await record(client, { title: "successor", topic: "guard.ovl", status: "accepted", decision: "new", supersedes: "dec_privbbbbbb" });
  assert.equal(r.isError, false, `write must be accepted, got: ${r.text}`);
  assert.match(r.text, /Superseded dec_privbbbbbb/);

  const store = new HunchStore(hunchPaths(s.root));
  t.after(() => store.close());
  const live = liveForTopic(store.recs("decisions"), "guard.ovl");
  assert.equal(live.length, 1, "exactly one live decision after the supersede");
  assert.notEqual(live[0]!.id, "dec_privbbbbbb", "the live one is the successor");
  const closed = store.recs("decisions").find((d) => d.id === "dec_privbbbbbb");
  assert.equal(closed?.status, "superseded");
  assert.equal(closed?.superseded_by, live[0]!.id);
});

test("hunch_capture_decision: deciding=true prepends the verdict loop; default stays the plain grilling", async (t) => {
  const s = await sharedSetup();
  let client: Client | undefined;
  t.after(() => s.cleanup(client));
  client = await s.connect();

  const call = async (args: Record<string, unknown>) =>
    ((await client!.callTool({ name: "hunch_capture_decision", arguments: args })) as ToolText).content.map((c) => c.text ?? "").join("\n");

  const deciding = await call({ topic: "some.topic", deciding: true });
  assert.match(deciding, /VERDICT LOOP/);
  assert.match(deciding, /CANDIDATES/);
  assert.match(deciding, /TRIPWIRES/);
  assert.match(deciding, /GRILLING LOOP/, "verdict mode still ends in the grilling commit rules");

  const plain = await call({ topic: "some.topic" });
  assert.ok(!plain.includes("VERDICT LOOP"), "default capture is unchanged");
  assert.match(plain, /GRILLING LOOP/);
});

test("record quality nudge: unattacked / no-flip-condition records get ONE advisory line; a full record gets none", async (t) => {
  const s = await sharedSetup();
  let client: Client | undefined;
  t.after(() => s.cleanup(client));
  client = await s.connect();

  const token = async () => {
    const text = ((await client!.callTool({ name: "hunch_capture_decision", arguments: {} })) as ToolText)
      .content.map((c) => c.text ?? "").join("\n");
    return /capture_token:"([^"]+)"/.exec(text)![1]!;
  };

  const rec = async (decision: Record<string, unknown>) => {
    const res = (await client!.callTool({ name: "hunch_record_decision", arguments: { decision, capture_token: await token() } })) as ToolText;
    return res.content.map((c) => c.text ?? "").join("\n");
  };

  const unattacked = await rec({ title: "no alternatives", topic: "q.unattacked", status: "accepted", decision: "d" });
  assert.match(unattacked, /Unattacked record/);

  const noFlip = await rec({ title: "has alternatives", topic: "q.noflip", status: "accepted", decision: "d", alternatives_rejected: ["did not do X because Y"] });
  assert.match(noFlip, /revisit if/);
  assert.ok(!noFlip.includes("Unattacked"), "only one nudge fires");

  const full = await rec({ title: "full record", topic: "q.full", status: "accepted", decision: "d", alternatives_rejected: ["rejected X — revisit if Z happens"] });
  assert.ok(!full.includes("△"), "a full record gets no nudge");

  const proposed = await rec({ title: "roadmap intent", topic: "q.proposed", status: "proposed", decision: "d" });
  assert.ok(!proposed.includes("△"), "proposed roadmap records are exempt");
});
