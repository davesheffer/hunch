import { cleanupDir, writeLocalPointer } from "./fixtures.js";
/**
 * Never Twice, corrected (private #31): when a human corrects a correction, the
 * reversed rule must not stay active beside its replacement. hunch_record_correction
 * (1) discloses the other ACTIVE constraints on the exact same scope, and (2) accepts
 * `supersedes: con_*[]`, retiring each target (status retired + valid_to) in the same
 * home. An agent write may retire only agent testimony; a human-confirmed rule is
 * retired by the human (`hunch retire-constraint`). Every refusal writes nothing.
 * Exercised through the REAL MCP handler via an in-memory transport.
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { mkdtempSync, mkdirSync, readdirSync, readFileSync, writeFileSync, existsSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";
import { buildServer } from "../src/mcp/server.js";
import { constraintId } from "../src/core/ids.js";

type Con = { id: string; statement: string; scope: string[]; status: string; valid_to: string | null; provenance: { source: string } };

async function setup(overlay?: string) {
  const root = mkdtempSync(join(tmpdir(), "hunch-supersedes-"));
  mkdirSync(join(root, ".hunch", "constraints"), { recursive: true });
  const prevEnv = process.env.HUNCH_PRIVATE_DIR;
  if (overlay) {
    delete process.env.HUNCH_PRIVATE_DIR;
    mkdirSync(join(overlay, "constraints"), { recursive: true });
    execFileSync("git", ["init", "-q", root]);
    writeLocalPointer(root, { privateDir: overlay, mode: "private", autoCommit: false });
  }
  const server = buildServer(root);
  const [clientT, serverT] = InMemoryTransport.createLinkedPair();
  const client = new Client({ name: "t", version: "0" });
  await Promise.all([server.connect(serverT), client.connect(clientT)]);
  const callTool = async (name: string, args: Record<string, unknown>) => {
    const res = await client.callTool({ name, arguments: args });
    return (res.content as Array<{ text: string }>).map((c) => c.text ?? "").join("\n");
  };
  return {
    root,
    call: (args: Record<string, unknown>) => callTool("hunch_record_correction", args),
    token: async () => /capture_token:"([^"]+)"/.exec(await callTool("hunch_capture_decision", { topic: "t.topic" }))![1]!,
    cleanup: () => {
      void client.close().catch(() => {});
      if (prevEnv === undefined) delete process.env.HUNCH_PRIVATE_DIR;
      else process.env.HUNCH_PRIVATE_DIR = prevEnv;
      for (const d of [root, overlay]) {
        if (!d) continue;
        try { cleanupDir(d); } catch { /* temp dir, OS reaps */ }
      }
    },
  };
}

const readConstraints = (dir: string): Con[] =>
  readdirSync(dir).filter((f) => f.endsWith(".json"))
    .map((f) => JSON.parse(readFileSync(join(dir, f), "utf8")) as Con);
const byId = (dir: string, id: string) => readConstraints(dir).find((c) => c.id === id);

/** A constraint written straight to disk, so a test controls its provenance tier. */
function seedConstraint(dir: string, rule: string, scope: string, source: string): string {
  const id = constraintId(rule);
  const now = "2026-09-01T00:00:00.000Z";
  writeFileSync(join(dir, `${id}.json`), JSON.stringify({
    id, type: "correctness", statement: rule, scope: [scope], severity: "warning",
    enforcement: "advisory_v1", match: null, forbids: null, rationale: "seeded",
    source_decision: null, violations: [], status: "active", valid_from: now, valid_to: null,
    provenance: { source, confidence: 1, evidence: [], last_verified: now },
  }, null, 2));
  return id;
}

const PALETTE_OLD = "use bands of cobalt, ultraviolet, cyan, and restrained magenta";
const PALETTE_NEW = "replace the blue-violet palette with the prior green Hunch palette";

test("a correction discloses the other active rules on the exact same scope", async () => {
  const s = await setup();
  try {
    await s.call({ rule: PALETTE_OLD, scope_hint_file: "site/dna-hero.js" });
    await s.call({ rule: "keep the hero under 60 kB", scope_hint_file: "site/other.js" });
    const out = await s.call({ rule: PALETTE_NEW, scope_hint_file: "site/dna-hero.js" });
    const oldId = constraintId(PALETTE_OLD);
    assert.match(out, new RegExp(oldId), "the same-scope rule is listed");
    assert.match(out, /supersedes/, "the caller is told how to retire a reversed rule");
    assert.doesNotMatch(out, new RegExp(constraintId("keep the hero under 60 kB")), "a different scope is not listed");
  } finally { s.cleanup(); }
});

test("no disclosure when no other active rule shares the scope", async () => {
  const s = await setup();
  try {
    const out = await s.call({ rule: PALETTE_NEW, scope_hint_file: "site/dna-hero.js" });
    assert.doesNotMatch(out, /same scope/i);
  } finally { s.cleanup(); }
});

test("supersedes retires the reversed agent-recorded rule; the new one stays active", async () => {
  const s = await setup();
  const dir = join(s.root, ".hunch", "constraints");
  try {
    await s.call({ rule: PALETTE_OLD, scope_hint_file: "site/dna-hero.js" });
    const oldId = constraintId(PALETTE_OLD);
    const out = await s.call({ rule: PALETTE_NEW, scope_hint_file: "site/dna-hero.js", supersedes: [oldId] });
    const old = byId(dir, oldId)!;
    assert.equal(old.status, "retired", "the reversed rule is no longer enforced");
    assert.ok(old.valid_to, "its valid-time window is closed, not deleted");
    assert.equal(byId(dir, constraintId(PALETTE_NEW))!.status, "active");
    assert.match(out, new RegExp(`Retired ${oldId}`));
    assert.doesNotMatch(out, /same scope/i, "a retired rule is not disclosed as active");
  } finally { s.cleanup(); }
});

test("supersedes naming a missing constraint is refused and writes nothing", async () => {
  const s = await setup();
  const dir = join(s.root, ".hunch", "constraints");
  try {
    const out = await s.call({ rule: PALETTE_NEW, scope_hint_file: "site/dna-hero.js", supersedes: ["con_0000000000"] });
    assert.match(out, /^Refused:/);
    assert.equal(readConstraints(dir).length, 0, "the new rule was not written either");
  } finally { s.cleanup(); }
});

test("supersedes naming the rule being recorded is refused", async () => {
  const s = await setup();
  try {
    await s.call({ rule: PALETTE_NEW, scope_hint_file: "site/dna-hero.js" });
    const out = await s.call({ rule: PALETTE_NEW, scope_hint_file: "site/dna-hero.js", supersedes: [constraintId(PALETTE_NEW)] });
    assert.match(out, /^Refused:/);
    assert.equal(byId(join(s.root, ".hunch", "constraints"), constraintId(PALETTE_NEW))!.status, "active");
  } finally { s.cleanup(); }
});

test("an agent write cannot retire a human-confirmed rule; it names the human's command", async () => {
  const s = await setup();
  const dir = join(s.root, ".hunch", "constraints");
  try {
    const oldId = seedConstraint(dir, PALETTE_OLD, "site/dna-hero.js", "human_confirmed");
    const out = await s.call({ rule: PALETTE_NEW, scope_hint_file: "site/dna-hero.js", supersedes: [oldId] });
    assert.match(out, /^Refused:/);
    assert.match(out, new RegExp(`hunch retire-constraint ${oldId}`));
    assert.equal(byId(dir, oldId)!.status, "active", "the human's rule is untouched");
    assert.equal(byId(dir, constraintId(PALETTE_NEW)), undefined, "nothing was written");
  } finally { s.cleanup(); }
});

test("supersedes across memory homes is refused and writes nothing", async () => {
  const overlay = mkdtempSync(join(tmpdir(), "hunch-supersedes-ovl-"));
  const s = await setup(overlay);
  try {
    const privId = seedConstraint(join(overlay, "constraints"), PALETTE_OLD, "site/dna-hero.js", "agent_recorded");
    const out = await s.call({ rule: PALETTE_NEW, scope_hint_file: "site/dna-hero.js", supersedes: [privId] });
    assert.match(out, /^Refused:/);
    assert.match(out, /other memory home|private/i);
    assert.equal(byId(join(overlay, "constraints"), privId)!.status, "active");
    assert.ok(!existsSync(join(s.root, ".hunch", "constraints", `${constraintId(PALETTE_NEW)}.json`)), "nothing was written");
  } finally { s.cleanup(); }
});

test("a legacy twin (same id in both homes) is refused: retiring one copy leaves the other served", async () => {
  const overlay = mkdtempSync(join(tmpdir(), "hunch-supersedes-ovl-"));
  const s = await setup(overlay);
  try {
    const twinId = seedConstraint(join(s.root, ".hunch", "constraints"), PALETTE_OLD, "site/dna-hero.js", "agent_recorded");
    seedConstraint(join(overlay, "constraints"), PALETTE_OLD, "site/dna-hero.js", "agent_recorded");
    const out = await s.call({ rule: PALETTE_NEW, scope_hint_file: "site/dna-hero.js", supersedes: [twinId] });
    assert.match(out, /^Refused:/);
    assert.match(out, /both memory homes/);
    assert.equal(byId(join(s.root, ".hunch", "constraints"), twinId)!.status, "active");
    assert.equal(byId(join(s.root, ".hunch", "constraints"), constraintId(PALETTE_NEW)), undefined, "nothing was written");
  } finally { s.cleanup(); }
});

test("the same-scope disclosure lists only rules this write's home could retire", async () => {
  const overlay = mkdtempSync(join(tmpdir(), "hunch-supersedes-ovl-"));
  const s = await setup(overlay);
  try {
    const privId = seedConstraint(join(overlay, "constraints"), PALETTE_OLD, "site/dna-hero.js", "agent_recorded");
    const out = await s.call({ rule: PALETTE_NEW, scope_hint_file: "site/dna-hero.js" });
    assert.doesNotMatch(out, new RegExp(privId), "an overlay rule is neither disclosed nor offered for a public supersede");
  } finally { s.cleanup(); }
});

test("a refused supersede does not burn the capture token", async () => {
  const s = await setup();
  try {
    const token = await s.token();
    const refusedOut = await s.call({ rule: PALETTE_NEW, scope_hint_file: "site/dna-hero.js", supersedes: ["con_0000000000"], capture_token: token });
    assert.match(refusedOut, /^Refused:/);
    const out = await s.call({ rule: PALETTE_NEW, scope_hint_file: "site/dna-hero.js", capture_token: token });
    assert.match(out, /Recorded after a capture interview/, "the token survives the refusal and still vouches the retry");
  } finally { s.cleanup(); }
});

test("a supersede target that is already retired is named, not silently dropped", async () => {
  const s = await setup();
  try {
    await s.call({ rule: PALETTE_OLD, scope_hint_file: "site/dna-hero.js" });
    const oldId = constraintId(PALETTE_OLD);
    await s.call({ rule: PALETTE_NEW, scope_hint_file: "site/dna-hero.js", supersedes: [oldId] });
    const out = await s.call({ rule: "keep the hero palette green", scope_hint_file: "site/dna-hero.js", supersedes: [oldId] });
    assert.match(out, new RegExp(`Already retired, left as is: ${oldId}`));
  } finally { s.cleanup(); }
});

test("private supersedes with no overlay configured says so", async () => {
  const s = await setup();
  try {
    seedConstraint(join(s.root, ".hunch", "constraints"), PALETTE_OLD, "site/dna-hero.js", "agent_recorded");
    const out = await s.call({ rule: PALETTE_NEW, scope_hint_file: "site/dna-hero.js", private: true, supersedes: [constraintId(PALETTE_OLD)] });
    assert.match(out, /No private store configured/);
    assert.doesNotMatch(out, /other memory home/);
  } finally { s.cleanup(); }
});
