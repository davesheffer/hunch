import { cleanupDir } from "./fixtures.js";
import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { spawnSync } from "node:child_process";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";
import { mapAdrCorpus } from "../src/extractors/adrImport.js";
import {
  applyImportedAdrReview,
  carryImportedAdrReview,
  importedAdrReview,
  importedAdrReviewHash,
  importedAdrSourceHash,
  isPendingImportedAdrReview,
} from "../src/core/importReview.js";
import { pendingEscalations } from "../src/core/escalations.js";
import { buildServer } from "../src/mcp/server.js";
import { HunchStore } from "../src/store/hunchStore.js";
import { hunchPaths } from "../src/core/paths.js";
import type { Decision } from "../src/core/types.js";

const projectRoot = process.cwd();
const tsx = join(projectRoot, "node_modules/tsx/dist/cli.mjs");
const cli = join(projectRoot, "src/cli/index.ts");

function adr(title = "Use PostgreSQL", choice = "Use PostgreSQL for durable relational storage."): string {
  return `---\nstatus: accepted\ndate: 2026-08-01\n---\n\n# ${title}\n\n## Context\n\nOrders need durable storage.\n\n## Decision\n\n${choice}\n`;
}

function imported(text = adr(), relPath = "docs/adr/0001-use-postgresql.md"): Decision {
  return mapAdrCorpus([{ relPath, text }]).decisions[0]!;
}

test("imported ADR review is exact, reversible, and never turns decline into authority", () => {
  const original = imported();
  const sourceHash = importedAdrSourceHash(original)!;
  const reviewHash = importedAdrReviewHash(original);
  assert.equal(isPendingImportedAdrReview(original), true);

  const escalation = pendingEscalations([original]);
  assert.equal(escalation.length, 1);
  assert.equal(escalation[0]!.kind, "imported-adr-review");
  assert.match(escalation[0]!.question, /Approve it as human-confirmed project authority, or decline/);
  assert.match(escalation[0]!.detail, new RegExp(sourceHash));

  assert.throws(() => applyImportedAdrReview(original, {
    disposition: "approve",
    expectedSourceHash: `sha256:${"f".repeat(64)}`,
    expectedReviewHash: reviewHash,
    reviewer: "human:test",
  }), /source changed after the question was shown/);
  assert.throws(() => applyImportedAdrReview(original, {
    disposition: "approve",
    expectedSourceHash: sourceHash,
    expectedReviewHash: `sha256:${"d".repeat(64)}`,
    reviewer: "human:test",
  }), /meaning changed after the question was shown/);

  const approved = applyImportedAdrReview(original, {
    disposition: "approve",
    expectedSourceHash: sourceHash,
    expectedReviewHash: reviewHash,
    reviewer: "human:test",
    reviewedAt: "2026-08-27T10:00:00.000Z",
  });
  assert.match(approved.provenance.source, /(?:^|\+)human_confirmed(?:\+|$)/);
  assert.equal(importedAdrReview(approved)?.disposition, "approve");
  assert.equal(isPendingImportedAdrReview(approved), false);

  const declined = applyImportedAdrReview(approved, {
    disposition: "decline",
    expectedSourceHash: sourceHash,
    expectedReviewHash: importedAdrReviewHash(approved),
    reviewer: "human:test",
    reviewedAt: "2026-08-27T10:01:00.000Z",
  });
  assert.doesNotMatch(declined.provenance.source, /(?:^|\+)human_confirmed(?:\+|$)/);
  assert.equal(declined.status, "accepted", "decline keeps useful advisory memory instead of deleting project history");
  assert.equal(importedAdrReview(declined)?.disposition, "decline");
  assert.equal(isPendingImportedAdrReview(declined), false, "a deliberate decline is recorded, not nagged again");
});

test("idempotent re-import preserves an exact review while changed ADR bytes reopen it", () => {
  const original = imported();
  const sourceHash = importedAdrSourceHash(original)!;
  const reviewHash = importedAdrReviewHash(original);
  const approved = applyImportedAdrReview(original, {
    disposition: "approve",
    expectedSourceHash: sourceHash,
    expectedReviewHash: reviewHash,
    reviewer: "human:test",
    reviewedAt: "2026-08-27T10:00:00.000Z",
  });

  const unchanged = carryImportedAdrReview(approved, imported());
  assert.equal(importedAdrReview(unchanged)?.disposition, "approve");
  assert.match(unchanged.provenance.source, /human_confirmed/);

  const remapped = { ...imported(), decision: "A future importer interpreted the same bytes differently." };
  const parserChanged = carryImportedAdrReview(approved, remapped);
  assert.doesNotMatch(parserChanged.provenance.source, /human_confirmed/);
  assert.equal(isPendingImportedAdrReview(parserChanged), true, "changed mapped meaning reopens review even when source bytes match");

  const changedImport = imported(adr("Use PostgreSQL", "Use PostgreSQL with one writer and bounded retries."));
  const changed = carryImportedAdrReview(approved, changedImport);
  assert.notEqual(importedAdrSourceHash(changed), sourceHash);
  assert.doesNotMatch(changed.provenance.source, /human_confirmed/);
  assert.equal(importedAdrReview(changed), null);
  assert.equal(isPendingImportedAdrReview(changed), true, "changed bytes require a fresh human answer");
});

test("CLI asks plainly, refuses the unbound accept path, and applies an exact approval", () => {
  const root = mkdtempSync(join(tmpdir(), "hunch-import-review-cli-"));
  mkdirSync(join(root, ".hunch"), { recursive: true });
  writeFileSync(join(root, ".hunch/local.json"), JSON.stringify({ autoCommit: false }));
  const decision = imported();
  const sourceHash = importedAdrSourceHash(decision)!;
  const reviewHash = importedAdrReviewHash(decision);
  const store = new HunchStore(hunchPaths(root));
  store.json.ensureDirs();
  store.json.put("decisions", decision);
  store.close();
  const run = (...args: string[]) => spawnSync(process.execPath, [tsx, cli, ...args], {
    cwd: root,
    encoding: "utf8",
    env: { ...process.env, HUNCH_PRIVATE_DIR: "", HUNCH_SYNTH_PROVIDER: "deterministic" },
  });

  try {
    const listing = run("review");
    assert.equal(listing.status, 0, `${listing.stdout}${listing.stderr}`);
    assert.match(listing.stdout, /Approve as human-confirmed authority, or decline and keep advisory/);

    const unsafe = run("review", "--accept", decision.id);
    assert.notEqual(unsafe.status, 0);
    assert.match(`${unsafe.stdout}${unsafe.stderr}`, /requires the hash-bound --approve-import flow/);

    const approved = run("review", "--approve-import", decision.id, "--expected-source-hash", sourceHash, "--expected-review-hash", reviewHash, "--reviewed-by", "human:cli-test");
    assert.equal(approved.status, 0, `${approved.stdout}${approved.stderr}`);
    const stored = JSON.parse(readFileSync(join(root, `.hunch/decisions/${decision.id}.json`), "utf8")) as Decision;
    assert.match(stored.provenance.source, /human_confirmed/);
    assert.equal(importedAdrReview(stored)?.disposition, "approve");
  } finally {
    cleanupDir(root);
  }
});

type ToolText = { content: Array<{ type: string; text?: string }>; isError?: boolean };

test("MCP surfaces the question in chat and only the explicit hash-bound answer resolves it", async (t) => {
  const root = mkdtempSync(join(tmpdir(), "hunch-import-review-mcp-"));
  mkdirSync(join(root, ".hunch"), { recursive: true });
  writeFileSync(join(root, ".hunch/local.json"), JSON.stringify({ autoCommit: false }));
  const decision = imported();
  const sourceHash = importedAdrSourceHash(decision)!;
  const reviewHash = importedAdrReviewHash(decision);
  const store = new HunchStore(hunchPaths(root));
  store.json.ensureDirs();
  store.json.put("decisions", decision);
  store.close();

  const server = buildServer(root);
  const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
  const client = new Client({ name: "import-review-test", version: "1.0.0" });
  await Promise.all([server.connect(serverTransport), client.connect(clientTransport)]);
  t.after(async () => {
    await client.close();
    cleanupDir(root);
  });

  const text = (result: ToolText): string => result.content.map((part) => part.text ?? "").join("\n");
  const question = await client.callTool({ name: "hunch_escalations", arguments: {} }) as ToolText;
  assert.match(text(question), /Approve it as human-confirmed project authority, or decline/);
  assert.match(text(question), /hunch_review_imported_adr/);

  const stale = await client.callTool({
    name: "hunch_review_imported_adr",
    arguments: { decision_id: decision.id, expected_source_hash: `sha256:${"e".repeat(64)}`, expected_review_hash: reviewHash, disposition: "approve" },
  }) as ToolText;
  assert.equal(stale.isError, true);
  assert.match(text(stale), /source changed after the question was shown/);

  const approved = await client.callTool({
    name: "hunch_review_imported_adr",
    arguments: { decision_id: decision.id, expected_source_hash: sourceHash, expected_review_hash: reviewHash, disposition: "approve" },
  }) as ToolText;
  assert.equal(approved.isError, undefined);
  assert.match(text(approved), /now human-confirmed authority/);

  const cleared = await client.callTool({ name: "hunch_escalations", arguments: {} }) as ToolText;
  assert.match(text(cleared), /Nothing needs a human decision/);
});
