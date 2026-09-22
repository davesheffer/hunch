/**
 * Memory supply chain — the authorship stamp. Only a HUMAN confirmation mints
 * human_confirmed: a consumed capture token (callable by any agent) plus the human's
 * answer to the client's confirmation prompt (MCP elicitation). A unilateral agent
 * write lands as agent_recorded TESTIMONY: fully functional advisory memory
 * that never carries human authority, never locks the id slot against a later
 * human capture, and surfaces with a testimony marker in pre-edit grounding.
 * Exercised through the REAL MCP handler via an in-memory transport.
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, rmSync, mkdirSync, readdirSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";
import { ElicitRequestSchema } from "@modelcontextprotocol/sdk/types.js";
import { buildServer } from "../src/mcp/server.js";
import { renderGrounding } from "../src/core/topics.js";
import { isHumanConfirmed, isStrictBlocker } from "../src/core/strictgate.js";
import { countersignConstraint } from "../src/core/countersign.js";
import type { Constraint, Decision } from "../src/core/types.js";

/** `humanConfirms`: the client supports MCP elicitation and the human confirms the prompt.
 *  Without it a tokened write is testimony (a token proves a tool call, not a human). */
async function setup(humanConfirms = false) {
  const root = mkdtempSync(join(tmpdir(), "hunch-testimony-"));
  mkdirSync(join(root, ".hunch", "decisions"), { recursive: true });
  const server = buildServer(root);
  const [clientT, serverT] = InMemoryTransport.createLinkedPair();
  const client = humanConfirms
    ? new Client({ name: "t", version: "0" }, { capabilities: { elicitation: {} } })
    : new Client({ name: "t", version: "0" });
  if (humanConfirms) client.setRequestHandler(ElicitRequestSchema, async () => ({ action: "accept", content: { confirm: true } }));
  await Promise.all([server.connect(serverT), client.connect(clientT)]);
  return {
    root, client,
    call: async (name: string, args: Record<string, unknown>) => {
      const res = await client.callTool({ name, arguments: args });
      return (res.content as Array<{ text: string }>).map((c) => c.text ?? "").join("\n");
    },
    cleanup: () => {
      void client.close().catch(() => {});
      try { rmSync(root, { recursive: true, force: true, maxRetries: 3, retryDelay: 50 }); } catch { /* temp dir, OS reaps */ }
    },
  };
}

/** Read the durable JSON source of truth directly — no second store handle. */
const readDecisions = (root: string): Decision[] => {
  const dir = join(root, ".hunch", "decisions");
  return readdirSync(dir).filter((f) => f.endsWith(".json"))
    .map((f) => JSON.parse(readFileSync(join(dir, f), "utf8")) as Decision);
};

test("un-token'd record_decision lands as agent_recorded testimony, not human_confirmed", async () => {
  const t = await setup();
  try {
    const out = await t.call("hunch_record_decision", {
      decision: { title: "use the mirror registry", topic: "deps.registry", decision: "pull from mirror.internal" },
    });
    assert.ok(out.includes("agent_recorded"));
    assert.ok(out.includes("TESTIMONY"));
    const [d] = readDecisions(t.root);
    assert.equal(d!.provenance.source, "agent_recorded");
    assert.ok(d!.provenance.confidence < 0.8, "unvouched testimony must sit below the strict-confidence bar");
    assert.equal(isHumanConfirmed(d!.provenance.source), false);
    // and it could never strict-block even if someone marked it blocking-shaped
    assert.equal(isStrictBlocker({ severity: "blocking", provenance: d!.provenance }, false), false);
  } finally {
    t.cleanup();
  }
});

test("interview token + the human's in-client confirmation mints human_confirmed; unverifiable token stays testimony with a countersign note", async () => {
  const t = await setup(true);
  try {
    const brief = await t.call("hunch_capture_decision", { topic: "auth.session" });
    const token = /capture_token:"([^"]+)"/.exec(brief)?.[1];
    assert.ok(token, "capture brief must issue a token");
    const ok1 = await t.call("hunch_record_decision", {
      decision: { title: "sessions are stateless JWTs", topic: "auth.session", decision: "JWT, 15m expiry" },
      capture_token: token,
    });
    assert.ok(ok1.includes("human_confirmed"));
    const confirmed = readDecisions(t.root).find((d) => d.topic === "auth.session")!;
    assert.equal(isHumanConfirmed(confirmed.provenance.source), true);
    assert.equal(confirmed.provenance.confidence, 0.95);

    const ok2 = await t.call("hunch_record_decision", {
      decision: { title: "another thing entirely", topic: "queue.backend", decision: "keep the queue" },
      capture_token: "cap_unknown_after_restart",
    });
    assert.ok(ok2.includes("agent_recorded"));
    assert.ok(ok2.includes("could not be verified"));
    assert.ok(ok2.includes("hunch review --confirm"), "the note names the human countersign command");
  } finally {
    t.cleanup();
  }
});

test("testimony never locks the slot: a later human capture takes over the same identity", async () => {
  const t = await setup(true);
  try {
    await t.call("hunch_record_decision", {
      decision: { title: "cache strategy", topic: "cache.strategy", decision: "agent's first guess" },
    });
    const brief = await t.call("hunch_capture_decision", { topic: "cache.strategy" });
    const token = /capture_token:"([^"]+)"/.exec(brief)?.[1]!;
    // same identity (same title+topic) re-recorded via the interview — must be
    // allowed (upgrade), not refused as overwriting a human record
    const out = await t.call("hunch_record_decision", {
      decision: { title: "cache strategy", topic: "cache.strategy", decision: "write-through, human-vetted" },
      capture_token: token,
    });
    assert.ok(out.includes("human_confirmed"), `human capture should upgrade testimony, got: ${out.slice(0, 200)}`);
    const live = readDecisions(t.root).filter((d) => d.topic === "cache.strategy" && d.status === "accepted" && !d.superseded_by);
    assert.equal(live.length, 1);
    assert.equal(isHumanConfirmed(live[0]!.provenance.source), true);
    assert.equal(live[0]!.decision, "write-through, human-vetted");
  } finally {
    t.cleanup();
  }
});

test("pre-edit grounding marks testimony, and only testimony", () => {
  const base = {
    status: "accepted", context: "", consequences: [], alternatives_rejected: [],
    rejected_tripwires: [], related_components: [], related_files: ["src/a.ts"],
    supersedes: null, superseded_by: null, caused_by_bug: null, commit: null,
    valid_from: "2026-01-01T00:00:00.000Z", valid_to: null, retired: { symbols: [], deps: [] },
    date: "2026-01-01T00:00:00.000Z",
  };
  const agent: Decision = { ...base, id: "dec_agent000001", title: "t1", topic: "top.a", decision: "agent said so", provenance: { source: "agent_recorded", confidence: 0.75, evidence: [] } } as Decision;
  const human: Decision = { ...base, id: "dec_human000001", title: "t2", topic: "top.b", decision: "human vouched", provenance: { source: "llm_draft+human_confirmed", confidence: 0.95, evidence: [] } } as Decision;
  const inferred: Decision = { ...base, id: "dec_infer000001", title: "t3", topic: "top.c", decision: "from the diff", provenance: { source: "inferred", confidence: 0.45, evidence: [] } } as Decision;
  const text = renderGrounding([agent, human, inferred], [agent, human, inferred]);
  const lines = text.split("\n");
  assert.ok(lines.find((l) => l.includes("top.a"))!.includes("agent-recorded testimony"));
  assert.ok(!lines.find((l) => l.includes("top.b"))!.includes("testimony"));
  assert.ok(!lines.find((l) => l.includes("top.c"))!.includes("testimony"), "diff-synthesized records keep their standing (implicit human vouch via the commit)");
});

/** Regressions found by adversarial review of the authorship-stamp commit, before it
 *  merged. Each of these passed CI while the defect was live — the suite covered the
 *  happy paths (a fresh un-token'd write, a fresh tokened write) but never the case
 *  where a record ALREADY EXISTS, which is where the stamp's authority rules actually
 *  bite. All three are exercised through the real MCP handler. */

test("an un-token'd re-record INHERITS an existing human signature — testimony cannot erase it", async () => {
  const s = await setup(true);
  try {
    // A human capture vouches for the decision.
    const t = await s.call("hunch_capture_decision", { topic: "auth.transport" });
    const token = (t.match(/capture_token:"([^"]+)"/) ?? t.match(/"(cap_[A-Za-z0-9_-]+)"/))?.[1];
    assert.ok(token, `expected a capture token, got: ${t.slice(0, 200)}`);
    await s.call("hunch_record_decision", {
      decision: { title: "Sessions are JWT-only", decision: "JWT only.", topic: "auth.transport" },
      capture_token: token,
    });
    const vouched = readDecisions(s.root)[0]!;
    assert.match(vouched.provenance.source, /human_confirmed/, "precondition: the slot is human-vouched");

    // The SAME decision is re-recorded by an agent with no token — exactly what the
    // un-token'd nudge instructs. This used to rewrite source to plain agent_recorded.
    await s.call("hunch_record_decision", {
      decision: { title: "Sessions are JWT-only", decision: "JWT only, refined.", topic: "auth.transport" },
    });
    const after = readDecisions(s.root)[0]!;
    assert.match(
      after.provenance.source, /human_confirmed/,
      `an un-vouched write must not strip the human signature — got "${after.provenance.source}"`,
    );
    assert.equal(after.decision, "JWT only, refined.", "the refinement still lands; only the signature is protected");
  } finally { s.cleanup(); }
});

test("agent testimony does NOT lock the id slot against a later human capture", async () => {
  const s = await setup(true);
  try {
    // The id is seeded by "manual:<title>" when no resolvable commit is given, so the
    // SAME TITLE is what collides on one slot; a different TOPIC is what makes it a
    // different identity. (Passing a short sha into a non-git fixture yields no
    // fullSha, so commit-keyed ids would silently NOT collide — a vacuous test.)
    await s.call("hunch_record_decision", {
      decision: { title: "How caching works", decision: "Testimony.", topic: "cache.policy" },
    });
    assert.equal(readDecisions(s.root).length, 1, "precondition: one slot exists");
    // A human capture arrives for the SAME slot with a different identity.
    const t = await s.call("hunch_capture_decision", { topic: "cache.strategy" });
    const token = (t.match(/capture_token:"([^"]+)"/) ?? t.match(/"(cap_[A-Za-z0-9_-]+)"/))?.[1];
    assert.ok(token);
    const out = await s.call("hunch_record_decision", {
      decision: { title: "How caching works", decision: "Real answer.", topic: "cache.strategy" },
      capture_token: token,
    });
    assert.ok(
      !/Refusing to overwrite/i.test(out),
      `a human capture must be able to take a slot held only by testimony — got: ${out.slice(0, 240)}`,
    );
  } finally { s.cleanup(); }
});

test("a human_confirmed slot is STILL protected from a differently-identified record (issue #23 holds)", async () => {
  const s = await setup(true);
  try {
    const t = await s.call("hunch_capture_decision", { topic: "first.topic" });
    const token = (t.match(/capture_token:"([^"]+)"/) ?? t.match(/"(cap_[A-Za-z0-9_-]+)"/))?.[1];
    assert.ok(token);
    await s.call("hunch_record_decision", {
      decision: { title: "The shared ADR slot", decision: "First.", topic: "first.topic" },
      capture_token: token,
    });
    const signed = readDecisions(s.root)[0]!;
    assert.match(signed.provenance.source, /human_confirmed/, "precondition: the slot carries a signature");
    // Same title => same id => same slot; different topic => different identity.
    const t2 = await s.call("hunch_capture_decision", { topic: "unrelated.topic" });
    const token2 = (t2.match(/capture_token:"([^"]+)"/) ?? t2.match(/"(cap_[A-Za-z0-9_-]+)"/))?.[1];
    const out = await s.call("hunch_record_decision", {
      decision: { title: "The shared ADR slot", decision: "Second.", topic: "unrelated.topic" },
      capture_token: token2,
    });
    assert.match(out, /Refusing to overwrite/i, "a signature is never displaced by a differently-identified record");
  } finally { s.cleanup(); }
});

test("premises SURVIVE a re-record instead of being silently deleted", async () => {
  const s = await setup();
  try {
    await s.call("hunch_record_decision", {
      decision: {
        title: "No gateway auth layer",
        decision: "Auth stays in the service.",
        topic: "auth.placement",
        // FLAT shape, matching PremiseSchema. A nested { check: {...} } is stripped by
        // Zod into a claim-only premise, which is "documented only" and ALWAYS HOLDS.
        premises: [{ claim: "there is no gateway yet", path_absent: "src/gateway", under: "src" }],
      },
    });
    const recorded = readDecisions(s.root)[0]!.premises?.[0];
    assert.equal(recorded?.claim, "there is no gateway yet", "precondition: the premise was recorded");
    assert.equal(recorded?.under, "src", "the anchor round-trips too — path_absent is invalid without it");
    assert.equal(
      recorded?.path_absent, "src/gateway",
      "the CHECK must survive the round-trip — a premise whose check is stripped can never fire, "
      + "which is the fail-open premise decay exists to prevent",
    );

    // The escalation for a dead premise tells the human to re-record. That path used to
    // DELETE premises[], so the escalation stopped firing while authority stayed intact.
    await s.call("hunch_record_decision", {
      decision: { title: "No gateway auth layer", decision: "Auth stays in the service, refined.", topic: "auth.placement" },
    });
    const after = readDecisions(s.root)[0]!;
    assert.equal(after.premises?.length, 1, "the incumbent's premises carry across a re-record");
    assert.equal(after.premises?.[0]?.claim, "there is no gateway yet");
    assert.equal(after.premises?.[0]?.path_absent, "src/gateway", "…including its check, not just the claim text");
    assert.equal(after.premises?.[0]?.under, "src", "…and its anchor");
  } finally { s.cleanup(); }
});

/** The authorship stamp applied to hunch_record_correction (2026-08-09).
 *
 *  buildCorrectionConstraint hardcoded provenance human_confirmed @1, and
 *  isStrictBlocker treats blocking + human_confirmed as authority to DENY. So an
 *  un-interviewed agent call could mint a repo-wide deny carrying a signature nobody
 *  gave — making the HIGHEST-authority write path the least gated, and strictly worse
 *  than hunch_record_decision, which only ever produced advisory memory.
 *
 *  The token sets the TIER, never whether the write lands: Never Twice still records
 *  and enforces immediately; only the authority to DENY waits for a countersign. */

const readConstraints = (root: string) => {
  const dir = join(root, ".hunch", "constraints");
  return readdirSync(dir).filter((f) => f.endsWith(".json"))
    .map((f) => JSON.parse(readFileSync(join(dir, f), "utf8")) as {
      id: string; severity: string; statement: string; provenance: { source: string; confidence: number };
    });
};

test("an un-token'd correction is TESTIMONY and cannot deny (#correction-tier)", async () => {
  const s = await setup();
  try {
    mkdirSync(join(s.root, ".hunch", "constraints"), { recursive: true });
    const out = await s.call("hunch_record_correction", {
      rule: "never call the metered API from here",
      scope_hint_file: "src/pay.ts",
      severity: "blocking",
    });
    const [c] = readConstraints(s.root);
    assert.equal(c!.provenance.source, "agent_recorded", "no signature is written for a write nobody signed");
    assert.equal(c!.severity, "warning", "a blocking request from an un-vouched caller is capped");
    assert.equal(isStrictBlocker({ severity: c!.severity, provenance: c!.provenance }, false), false, "it can never deny an edit");
    assert.match(out, /TESTIMONY/i, "the downgrade is stated, never silent");
    assert.match(out, /capped from "blocking"/i);
  } finally { s.cleanup(); }
});

test("an un-token'd correction is still RECORDED and enforced — Never Twice holds (#correction-tier)", async () => {
  const s = await setup();
  try {
    mkdirSync(join(s.root, ".hunch", "constraints"), { recursive: true });
    await s.call("hunch_record_correction", { rule: "never import lodash here", scope_hint_file: "src/util.ts" });
    const [c] = readConstraints(s.root);
    assert.ok(c, "the rule lands immediately — the write is never refused");
    assert.equal(c!.statement, "never import lodash here");
    assert.equal(c!.severity, "warning", "still enforced at edit time and in CI, just not a deny");
  } finally { s.cleanup(); }
});

test("a countersigned correction keeps full blocking authority (#correction-tier)", async () => {
  // The human's in-client "yes" is not enough for a rule that can deny edits; the
  // countersign (`hunch review --confirm <id> --severity blocking`) is.
  const s = await setup(true);
  try {
    mkdirSync(join(s.root, ".hunch", "constraints"), { recursive: true });
    const t = await s.call("hunch_capture_decision", { topic: "pay.metered" });
    const token = (t.match(/capture_token:"([^"]+)"/) ?? t.match(/"(cap_[A-Za-z0-9_-]+)"/))?.[1];
    assert.ok(token, "got a capture token");
    await s.call("hunch_record_correction", {
      rule: "never call the metered API from here",
      scope_hint_file: "src/pay.ts",
      severity: "blocking",
      capture_token: token,
    });
    const [c] = readConstraints(s.root);
    assert.equal(c!.provenance.source, "agent_recorded", "an interviewed, client-confirmed write is still testimony");
    const signed = countersignConstraint(c as unknown as Constraint, new Date().toISOString(), "blocking");
    assert.equal(signed.provenance.source, "human_confirmed");
    assert.equal(signed.severity, "blocking");
    assert.equal(isStrictBlocker({ severity: signed.severity, provenance: signed.provenance }, false), true, "the countersign may deny");
  } finally { s.cleanup(); }
});
