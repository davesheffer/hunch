import { cleanupDir } from "./fixtures.js";
import { test } from "node:test";
import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { execFileSync } from "node:child_process";
import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { hunchPaths } from "../src/core/paths.js";
import { mapAdrCorpus, parseAdrMarkdown, type AdrSource } from "../src/extractors/adrImport.js";
import { HunchStore } from "../src/store/hunchStore.js";

interface AcceptanceRecord {
  path: string;
  sha256: string;
  source_revision: string;
  source_date: string;
  decision_id: string;
  title: string;
  source_status: string;
  mapped_status: "accepted" | "proposed" | "rejected" | "superseded";
  successor_path: string | null;
  retrieval_query: string;
  expected_source: string;
  review: "passed";
}

interface AcceptanceReceipt {
  schema: "hunch.infection-adr-acceptance/1";
  repository: string;
  revision: string;
  records: AcceptanceRecord[];
  excluded: Array<{ path: string; sha256: string; reason: "corpus_template" }>;
  human_signoff: { status: "required" | "signed"; reviewer: string | null; signed_at: string | null };
}

const here = fileURLToPath(new URL(".", import.meta.url));
const receipt = JSON.parse(readFileSync(resolve(here, "../bench/infection/adr-acceptance-v1.json"), "utf8")) as AcceptanceReceipt;

test("the Infection ADR acceptance receipt is complete, unique, and explicitly signed", () => {
  assert.equal(receipt.schema, "hunch.infection-adr-acceptance/1");
  assert.equal(receipt.repository, "https://github.com/infection/infection");
  assert.match(receipt.revision, /^[0-9a-f]{40}$/);
  assert.equal(receipt.records.length, 13);
  assert.equal(new Set(receipt.records.map((record) => record.path)).size, 13);
  assert.equal(new Set(receipt.records.map((record) => record.decision_id)).size, 13);
  assert.equal(new Set(receipt.records.map((record) => record.retrieval_query)).size, 13);
  for (const record of receipt.records) {
    assert.match(record.sha256, /^[0-9a-f]{64}$/);
    assert.match(record.source_revision, /^[0-9a-f]{40}$/);
    assert.ok(Number.isFinite(Date.parse(record.source_date)));
    assert.equal(record.expected_source, record.path);
    assert.equal(record.review, "passed");
    assert.ok(record.retrieval_query.length >= 20);
  }
  assert.deepEqual(receipt.excluded.map((entry) => entry.path), ["adr/0000-template.md"]);
  assert.equal(receipt.human_signoff.status, "signed");
  assert.equal(receipt.human_signoff.reviewer, "human:David-Sheffer");
  assert.ok(Number.isFinite(Date.parse(receipt.human_signoff.signed_at!)));
});

const infectionRoot = process.env.HUNCH_INFECTION_REPO;
test("the pinned Infection corpus matches every hash and imported field in the acceptance receipt", {
  skip: infectionRoot ? false : "set HUNCH_INFECTION_REPO to a pinned infection/infection checkout",
}, () => {
  const root = resolve(infectionRoot!);
  const git = (...args: string[]): string => execFileSync("git", ["-C", root, ...args], { encoding: "utf8" }).trim();
  assert.equal(git("rev-parse", "HEAD"), receipt.revision);

  const allEntries = [...receipt.records, ...receipt.excluded];
  for (const entry of allEntries) {
    const bytes = readFileSync(resolve(root, entry.path));
    assert.equal(createHash("sha256").update(bytes).digest("hex"), entry.sha256, entry.path);
  }

  const sources: AdrSource[] = receipt.records.map((record) => ({
    relPath: record.path,
    text: readFileSync(resolve(root, record.path), "utf8"),
    sourceDate: record.source_date,
    sourceRevision: record.source_revision,
  }));
  const imported = mapAdrCorpus(sources);
  assert.equal(imported.decisions.length, 13);
  assert.equal(imported.warnings.length, 0, imported.warnings.join("; "));
  const pathById = new Map(imported.decisions.map((decision) => [decision.id, decision.related_files[0]!] as const));

  for (const record of receipt.records) {
    const parsed = parseAdrMarkdown(readFileSync(resolve(root, record.path), "utf8"), record.path)!;
    const decision = imported.decisions.find((candidate) => candidate.id === record.decision_id)!;
    assert.ok(parsed, record.path);
    assert.ok(parsed.context.length > 0, `${record.path}: context`);
    assert.ok(parsed.decision.length > 0, `${record.path}: decision`);
    assert.equal(parsed.title, record.title, `${record.path}: title`);
    assert.equal(parsed.statusRaw, record.source_status, `${record.path}: source status`);
    assert.equal(decision.status, record.mapped_status, `${record.path}: mapped status`);
    assert.equal(decision.commit, record.source_revision, `${record.path}: source revision`);
    assert.ok(decision.provenance.evidence.includes(`sha256:${record.sha256}`));
    assert.equal(decision.superseded_by ? pathById.get(decision.superseded_by) : null, record.successor_path);
    if (decision.valid_from && decision.valid_to) {
      assert.ok(Date.parse(decision.valid_from) <= Date.parse(decision.valid_to), `${record.path}: valid-time window`);
    }
  }

  for (const excluded of receipt.excluded) {
    assert.equal(parseAdrMarkdown(readFileSync(resolve(root, excluded.path), "utf8"), excluded.path), null);
  }
});

test("the pinned current PHP policy ranks above its superseded history", {
  skip: infectionRoot ? false : "set HUNCH_INFECTION_REPO to run the pinned retrieval acceptance check",
}, async () => {
  const sources: AdrSource[] = receipt.records.map((record) => ({
    relPath: record.path,
    text: readFileSync(resolve(infectionRoot!, record.path), "utf8"),
    sourceDate: record.source_date,
    sourceRevision: record.source_revision,
  }));
  const decisions = mapAdrCorpus(sources).decisions;
  const root = mkdtempSync(join(tmpdir(), "hunch-infection-adr-retrieval-"));
  const store = new HunchStore(hunchPaths(root));
  try {
    store.json.ensureDirs();
    store.json.replaceAll("decisions", decisions);
    store.reindex();
    const query = receipt.records.find((record) => record.path.startsWith("adr/0008-"))!.retrieval_query;
    const hits = await store.searchScoped(query, "decisions", 13, { embedder: null });
    const current = hits.findIndex((hit) => hit.ref === receipt.records.find((record) => record.path.startsWith("adr/0008-"))!.decision_id);
    const superseded = hits.findIndex((hit) => hit.ref === receipt.records.find((record) => record.path.startsWith("adr/0005-"))!.decision_id);
    assert.ok(current >= 0, "current ADR 0008 must be retrievable");
    assert.ok(superseded < 0 || current < superseded, "current ADR 0008 must rank ahead of superseded ADR 0005");
  } finally {
    store.close();
    cleanupDir(root);
  }
});
