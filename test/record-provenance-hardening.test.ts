import { cleanupDir } from "./fixtures.js";
/**
 * Record provenance hardening: an agent write over MCP can never replace, rewrite, or
 * grant a human signature.
 *   (a) hunch_record_correction refuses to overwrite a human_confirmed constraint.
 *   (b) hunch_record_decision refuses to keep an inherited signature on changed text.
 *   (c) hunch_review_imported_adr "approve" needs the human's in-client confirmation.
 *   (d) buildCorrectionConstraint fails closed: an omitted `vouched` is testimony.
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, mkdirSync, readdirSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";
import { ElicitRequestSchema, type ElicitResult } from "@modelcontextprotocol/sdk/types.js";
// Namespace import: a missing export is a failing assertion, not a load error.
import * as mcpServer from "../src/mcp/server.js";
import { buildCorrectionConstraint } from "../src/core/correction.js";
import { mapAdrCorpus } from "../src/extractors/adrImport.js";
import { importedAdrReview, importedAdrReviewHash, importedAdrSourceHash, isPendingImportedAdrReview } from "../src/core/importReview.js";
import { HunchStore } from "../src/store/hunchStore.js";
import { hunchPaths } from "../src/core/paths.js";
import type { Constraint, Decision } from "../src/core/types.js";

const NOW = "2026-10-11T00:00:00.000Z";

type Answer = ElicitResult | "no-capability";
type Seed = Constraint | Decision;

async function setup(answer: Answer, seed: { constraints?: Constraint[]; decisions?: Decision[] } = {}) {
  const root = mkdtempSync(join(tmpdir(), "hunch-provenance-hardening-"));
  mkdirSync(join(root, ".hunch", "decisions"), { recursive: true });
  mkdirSync(join(root, ".hunch", "constraints"), { recursive: true });
  writeFileSync(join(root, ".hunch", "local.json"), JSON.stringify({ autoCommit: false }));
  if (seed.constraints?.length || seed.decisions?.length) {
    const store = new HunchStore(hunchPaths(root));
    store.json.ensureDirs();
    for (const c of seed.constraints ?? []) store.json.put("constraints", c);
    for (const d of seed.decisions ?? []) store.json.put("decisions", d);
    store.close();
  }
  const server = mcpServer.buildServer(root);
  const [clientT, serverT] = InMemoryTransport.createLinkedPair();
  const elicited: string[] = [];
  const client = answer === "no-capability"
    ? new Client({ name: "t", version: "0" })
    : new Client({ name: "t", version: "0" }, { capabilities: { elicitation: {} } });
  if (answer !== "no-capability") {
    client.setRequestHandler(ElicitRequestSchema, async (req) => {
      elicited.push(req.params.message);
      return answer;
    });
  }
  await Promise.all([server.connect(serverT), client.connect(clientT)]);
  const call = async (name: string, args: Record<string, unknown>) => {
    const res = await client.callTool({ name, arguments: args });
    return {
      isError: res.isError === true,
      text: (res.content as Array<{ text?: string }>).map((c) => c.text ?? "").join("\n"),
    };
  };
  return {
    root, call, elicited,
    token: async () => /capture_token:"([^"]+)"/.exec((await call("hunch_capture_decision", { topic: "t.topic" })).text)![1]!,
    read: <T extends Seed>(kind: "constraints" | "decisions", id: string): T =>
      JSON.parse(readFileSync(join(root, ".hunch", kind, `${id}.json`), "utf8")) as T,
    cleanup: () => {
      void client.close().catch(() => {});
      try { cleanupDir(root); } catch { /* temp dir */ }
    },
  };
}

const CONFIRM: ElicitResult = { action: "accept", content: { confirm: true } };
const UNCONFIRMED: ElicitResult[] = [{ action: "decline" }, { action: "cancel" }, { action: "accept", content: { confirm: false } }];

// ---- (a) hunch_record_correction never overwrites a human signature ----

test("hunch_record_correction refuses to overwrite a human_confirmed constraint and leaves it unchanged", async () => {
  const rule = "never call the metered API from the payment path";
  const human = buildCorrectionConstraint({ rule, scope_hint_file: "src/pay.ts", severity: "blocking", vouched: true }, NOW);
  assert.equal(human.provenance.source, "human_confirmed", "precondition");
  assert.equal(human.severity, "blocking", "precondition");
  const before = JSON.stringify(human);

  for (const args of [
    { rule, scope_hint_file: "src/pay.ts" },
    { rule, scope_hint_file: "src/pay.ts", severity: "blocking" },
    { rule, scope_hint_file: "src/other.ts", severity: "warning" },
  ]) {
    const s = await setup("no-capability", { constraints: [human] });
    try {
      const out = await s.call("hunch_record_correction", args);
      assert.equal(out.isError, true, `${JSON.stringify(args)} must be refused: ${out.text}`);
      assert.match(out.text, /^Refused: .*already human-confirmed.*nothing was written/);
      assert.match(out.text, new RegExp(`hunch review --confirm ${human.id}`), "names the human's path");
      const after = s.read<Constraint>("constraints", human.id);
      assert.equal(after.provenance.source, "human_confirmed");
      assert.equal(after.severity, "blocking", "the human's severity is not capped");
      assert.deepEqual(after.scope, ["src/pay.ts"]);
      assert.equal(JSON.stringify(after), before, "the on-disk record is byte-for-byte the human's");
    } finally { s.cleanup(); }
  }
});

// ---- (b) hunch_record_decision keeps a signature only on the text it covers ----

test("decisionSubstanceChanged: content fields count, bookkeeping does not", () => {
  const changed = (mcpServer as Record<string, unknown>).decisionSubstanceChanged as
    ((a: Decision, b: Decision) => boolean) | undefined;
  assert.equal(typeof changed, "function", "decisionSubstanceChanged is exported");
  const base = {
    id: "dec_substance01", title: "Sessions are JWT-only", topic: "auth.session", status: "accepted",
    context: "ctx", decision: "JWT only.", consequences: ["stateless"], alternatives_rejected: ["server sessions"],
    rejected_tripwires: [], premises: [], related_components: [], related_files: ["src/auth.ts"],
    supersedes: null, superseded_by: null, caused_by_bug: null, commit: null,
    valid_from: NOW, valid_to: null, retired: { symbols: [], deps: [] },
    provenance: { source: "human_confirmed", confidence: 0.95, evidence: [] }, date: NOW,
  } as unknown as Decision;

  assert.equal(changed!(base, { ...base }), false, "identical");
  assert.equal(changed!(base, {
    ...base, provenance: { source: "agent_recorded", confidence: 0.75, evidence: ["x"] },
    date: "2027-01-01T00:00:00.000Z", valid_from: "2027-01-01T00:00:00.000Z",
  } as Decision), false, "provenance, date and validity window are bookkeeping");
  for (const [field, value] of [
    ["title", "Sessions are cookies"], ["topic", "auth.other"], ["status", "proposed"], ["context", "other"],
    ["decision", "JWT only, refined."], ["consequences", []], ["alternatives_rejected", []],
    ["related_files", ["src/other.ts"]], ["supersedes", "dec_older000001"], ["commit", "abc1234"],
  ] as const) {
    assert.equal(changed!(base, { ...base, [field]: value } as Decision), true, `${field} is substance`);
  }
});

test("hunch_record_decision: an un-tokened write that changes a human_confirmed decision is refused; an identical re-record keeps the signature", async () => {
  const s = await setup(CONFIRM);
  try {
    const decision = { title: "Sessions are JWT-only", topic: "auth.session", decision: "JWT only." };
    await s.call("hunch_record_decision", { decision, capture_token: await s.token() });
    const [file, ...rest] = readdirSync(join(s.root, ".hunch", "decisions")).filter((f) => f.endsWith(".json"));
    assert.equal(rest.length, 0, "precondition: one decision");
    const id = file!.replace(/\.json$/, "");
    const signed = s.read<Decision>("decisions", id);
    assert.equal(signed.provenance.source, "human_confirmed", "precondition: the human confirmed it in the client");
    const elicitedBefore = s.elicited.length;

    const changed = await s.call("hunch_record_decision", { decision: { ...decision, decision: "JWT only, with server-side revocation." } });
    assert.equal(changed.isError, true, changed.text);
    assert.match(changed.text, /^Refused: .*human-confirmed and this write changes its content.*nothing was written/);
    assert.equal(s.elicited.length, elicitedBefore, "an un-tokened write never prompts the human");
    const afterChange = s.read<Decision>("decisions", id);
    assert.equal(afterChange.decision, "JWT only.");
    assert.equal(JSON.stringify(afterChange), JSON.stringify(signed), "nothing was written");

    const same = await s.call("hunch_record_decision", { decision });
    assert.equal(same.isError, false, same.text);
    const afterSame = s.read<Decision>("decisions", id);
    assert.equal(JSON.stringify(afterSame), JSON.stringify(signed), "an identical re-record is a no-op: the human's record, byte for byte");

    // The human path still works: a tokened write the human confirms may change it.
    const confirmed = await s.call("hunch_record_decision", {
      decision: { ...decision, decision: "JWT only, with server-side revocation." },
      capture_token: await s.token(),
    });
    assert.equal(confirmed.isError, false, confirmed.text);
    const afterConfirmed = s.read<Decision>("decisions", id);
    assert.equal(afterConfirmed.decision, "JWT only, with server-side revocation.");
    assert.equal(afterConfirmed.provenance.source, "human_confirmed");
  } finally { s.cleanup(); }
});

test("hunch_record_decision: an unconfirmed write cannot supersede a human_confirmed decision", async () => {
  const s = await setup(CONFIRM);
  try {
    await s.call("hunch_record_decision", { decision: { title: "Sessions are JWT-only", topic: "auth.session", decision: "JWT only." }, capture_token: await s.token() });
    const id = readdirSync(join(s.root, ".hunch", "decisions")).find((f) => f.endsWith(".json"))!.replace(/\.json$/, "");
    const signed = s.read<Decision>("decisions", id);
    assert.equal(signed.provenance.source, "human_confirmed", "precondition");

    const out = await s.call("hunch_record_decision", {
      decision: { title: "Sessions are server-side", topic: "auth.session", decision: "Server sessions.", supersedes: id },
    });
    assert.equal(out.isError, true, out.text);
    assert.match(out.text, /^Refused: .*human-confirmed; an unconfirmed write cannot supersede it.*nothing was written/);
    assert.equal(JSON.stringify(s.read<Decision>("decisions", id)), JSON.stringify(signed), "the human's decision stays live and unchanged");
    assert.equal(readdirSync(join(s.root, ".hunch", "decisions")).filter((f) => f.endsWith(".json")).length, 1, "no replacement written");
  } finally { s.cleanup(); }
});

test("hunch_record_decision: an identical un-tokened re-record keeps a human decision's conformance predicates", async () => {
  const s = await setup(CONFIRM);
  try {
    const decision = { title: "Billing never imports auth", topic: "billing.boundary", decision: "Billing stays independent of auth." };
    await s.call("hunch_record_decision", { decision, capture_token: await s.token() });
    const id = readdirSync(join(s.root, ".hunch", "decisions")).find((f) => f.endsWith(".json"))!.replace(/\.json$/, "");
    const path = join(s.root, ".hunch", "decisions", `${id}.json`);
    const conformance = [{ assert: "not-imports", subject: "src/billing/charge.ts", object: "src/auth/session.ts", transitive: false }];
    writeFileSync(path, JSON.stringify({ ...s.read<Decision>("decisions", id), conformance }, null, 2));
    const before = readFileSync(path, "utf8");
    assert.equal(s.read<Decision>("decisions", id).provenance.source, "human_confirmed", "precondition");

    const out = await s.call("hunch_record_decision", { decision });
    assert.equal(out.isError, false, out.text);
    assert.deepEqual(s.read<Decision>("decisions", id).conformance, conformance, "conformance survives");
    assert.equal(readFileSync(path, "utf8"), before, "nothing was written");
  } finally { s.cleanup(); }
});

// ---- (c) hunch_review_imported_adr approve needs the human in the client ----

function importedAdr(): Decision {
  const text = "---\nstatus: accepted\ndate: 2026-08-01\n---\n\n# Use PostgreSQL\n\n## Context\n\nOrders need durable storage.\n\n## Decision\n\nUse PostgreSQL for durable relational storage.\n";
  return mapAdrCorpus([{ relPath: "docs/adr/0001-use-postgresql.md", text }]).decisions[0]!;
}

function reviewArgs(d: Decision, disposition: "approve" | "decline") {
  return {
    decision_id: d.id,
    expected_source_hash: importedAdrSourceHash(d)!,
    expected_review_hash: importedAdrReviewHash(d),
    disposition,
  };
}

const isHuman = (d: Decision) => d.provenance.source.split("+").includes("human_confirmed");

test("hunch_review_imported_adr approve is refused without an in-client human confirmation", async () => {
  const adr = importedAdr();
  assert.equal(isPendingImportedAdrReview(adr), true, "precondition");
  for (const answer of ["no-capability", ...UNCONFIRMED] as Answer[]) {
    const s = await setup(answer, { decisions: [adr] });
    try {
      const out = await s.call("hunch_review_imported_adr", reviewArgs(adr, "approve"));
      assert.equal(out.isError, true, `${JSON.stringify(answer)} must not approve: ${out.text}`);
      assert.match(out.text, /^Refused: Not approved: .*stays advisory and nothing was written/);
      assert.match(out.text, new RegExp(`hunch review --approve-import ${adr.id}`), "names the human's CLI path");
      if (answer !== "no-capability") assert.equal(s.elicited.length, 1, "the human was asked");
      const after = s.read<Decision>("decisions", adr.id);
      assert.equal(isHuman(after), false, "no human authority without the human");
      assert.equal(isPendingImportedAdrReview(after), true, "still pending review");
      assert.equal(JSON.stringify(after), JSON.stringify(adr), "nothing was written");
    } finally { s.cleanup(); }
  }
});

test("hunch_review_imported_adr approve lands when the human confirms in the client", async () => {
  const adr = importedAdr();
  const s = await setup(CONFIRM, { decisions: [adr] });
  try {
    const out = await s.call("hunch_review_imported_adr", reviewArgs(adr, "approve"));
    assert.equal(out.isError, false, out.text);
    assert.equal(s.elicited.length, 1);
    assert.match(s.elicited[0]!, /Use PostgreSQL/, "the human sees what they approve");
    const after = s.read<Decision>("decisions", adr.id);
    assert.equal(isHuman(after), true);
    assert.equal(importedAdrReview(after)?.disposition, "approve");
  } finally { s.cleanup(); }
});

test("hunch_review_imported_adr decline still works without elicitation and grants nothing", async () => {
  const adr = importedAdr();
  const s = await setup("no-capability", { decisions: [adr] });
  try {
    const out = await s.call("hunch_review_imported_adr", reviewArgs(adr, "decline"));
    assert.equal(out.isError, false, out.text);
    const after = s.read<Decision>("decisions", adr.id);
    assert.equal(isHuman(after), false);
    assert.equal(importedAdrReview(after)?.disposition, "decline");
    assert.equal(isPendingImportedAdrReview(after), false);
  } finally { s.cleanup(); }
});

// ---- (d) buildCorrectionConstraint fails closed ----

test("buildCorrectionConstraint: omitted vouched is agent testimony with blocking capped; vouched:true is the human's", () => {
  const input = { rule: "never import lodash in the cart", severity: "blocking" as const, scope_hint_file: "src/cart.ts" };
  const omitted = buildCorrectionConstraint(input, NOW);
  assert.equal(omitted.provenance.source, "agent_recorded");
  assert.equal(omitted.severity, "warning");
  const unvouched = buildCorrectionConstraint({ ...input, vouched: false }, NOW);
  assert.equal(unvouched.provenance.source, "agent_recorded");
  assert.equal(unvouched.severity, "warning");
  const vouched = buildCorrectionConstraint({ ...input, vouched: true }, NOW);
  assert.equal(vouched.provenance.source, "human_confirmed");
  assert.equal(vouched.severity, "blocking");
});
