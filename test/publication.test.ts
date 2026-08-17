import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, writeFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { scanRecord, isStructural, publicationWarning, loadVocabulary, type SensitivityHit } from "../src/core/publication.js";

const kinds = (hits: readonly SensitivityHit[]) => hits.map((h) => h.kind).sort();
const has = (hits: readonly SensitivityHit[], kind: string) => hits.some((h) => h.kind === kind);

test("machine paths are caught on both platforms", () => {
  // String.raw is the idiomatic way to write a Windows path, and it doubles as the
  // in-repo regression for fnd_62239a8621: the tree-sitter scan used to reject this
  // file outright and take the whole `hunch conform` gate down with it.
  const win = scanRecord({ title: "t", context: String.raw`ran C:\Users\davids\github\hunch\dist\cli\index.js` });
  assert.ok(has(win, "machine-path"), "Windows home directory should be flagged");

  const mac = scanRecord({ title: "t", context: "node at /Users/nofarkulishevski/.hermes/node/bin/node" });
  assert.ok(has(mac, "machine-path"), "macOS home directory should be flagged");

  const linux = scanRecord({ title: "t", context: "binary at /home/buildbot/.local/bin/hunch" });
  assert.ok(has(linux, "machine-path"), "Linux home directory should be flagged");
});

test("placeholder home directories in docs and tests are NOT flagged", () => {
  // src/integrations/claudeConfig.ts and test/claudeconfig.test.ts use these as
  // illustrations; flagging them would train everyone to ignore the scanner.
  const doc = scanRecord({ title: "t", context: `"c:/Users/me/repo" -> mcpServers: {} and /Users/example/x` });
  assert.equal(has(doc, "machine-path"), false, `placeholders should be exempt, got ${JSON.stringify(doc)}`);
});

test("a path INTO the private overlay is flagged; naming the feature is not", () => {
  const leak = scanRecord({
    title: "handoff",
    context: "EXP-03 bank draft waits in .hunch-private/exp03-bank/cases-hunch-draft.json if evidence is wanted",
  });
  assert.ok(has(leak, "private-overlay-path"), "a concrete overlay path should be flagged");

  const mention = scanRecord({
    title: "t",
    context: "the full graph lives in a private overlay; .hunch-private/ stays gitignored",
  });
  assert.equal(has(mention, "private-overlay-path"), false, "a bare feature mention must not fire");
});

test("credential shapes are flagged and never echoed back in full", () => {
  const tok = "ghp_" + "A".repeat(30);
  const hits = scanRecord({ title: "t", context: `token ${tok} pasted by mistake` });
  assert.ok(has(hits, "secret-material"));
  const hit = hits.find((h) => h.kind === "secret-material")!;
  assert.equal(hit.excerpt.includes(tok), false, "the scanner must not reproduce the credential");
  assert.match(hit.excerpt, /redacted/);
});

test("a secret VARIABLE NAME is not a secret", () => {
  // Tuning false positive: dec_cd37bf2d9a mentions AUTH_TOKEN, dec_bb49b17601 VSCE_PAT.
  const hits = scanRecord({ title: "t", context: "the VSCE_PAT secret currently holds an Open VSX token; AUTH_TOKEN is unset" });
  assert.equal(has(hits, "secret-material"), false, `identifiers are not credentials, got ${JSON.stringify(hits)}`);
});

test("vocabulary scanning is OFF unless a repo opts in", () => {
  const record = { title: "t", context: "the moat is the accumulated graph and our go-to-market depends on it" };
  assert.deepEqual(kinds(scanRecord(record)), [], "the package must ship no built-in term list");

  const withVocab = scanRecord(record, { vocabulary: [/\bmoats?\b/i, /\bgo[- ]to[- ]market\b/i] });
  assert.equal(withVocab.filter((h) => h.kind === "market-vocabulary").length, 2);
  assert.ok(withVocab.every((h) => h.field === "context"), "vocabulary hits name the prose field");
});

test("vocabulary reads prose fields only, never ids or file paths", () => {
  const record = {
    title: "t",
    context: "ordinary engineering rationale",
    related_files: ["src/moat/index.ts"],
    id: "dec_moat123",
  };
  const hits = scanRecord(record, { vocabulary: [/\bmoat\b/i] });
  assert.equal(hits.length, 0, `paths and ids must not trip vocabulary, got ${JSON.stringify(hits)}`);
});

test("array prose fields are scanned element-wise", () => {
  const hits = scanRecord(
    { title: "t", alternatives_rejected: ["kept it simple", "chased the pricing strategy instead"] },
    { vocabulary: [/pricing strategy/i] },
  );
  assert.equal(hits.length, 1);
  assert.equal(hits[0].field, "alternatives_rejected[1]");
});

test("structural hits are separable from advisory ones", () => {
  const hits = scanRecord(
    { title: "t", context: "C:\\Users\\davids\\x and our moat" },
    { vocabulary: [/\bmoat\b/i] },
  );
  const structural = hits.filter(isStructural);
  assert.equal(structural.length, 1);
  assert.equal(structural[0].kind, "machine-path");
  assert.equal(hits.filter((h) => !isStructural(h)).length, 1);
});

test("scanRecord never throws on junk input", () => {
  for (const junk of [null, undefined, 42, "a string", [], { circular: undefined }]) {
    assert.doesNotThrow(() => scanRecord(junk));
  }
  const cyclic: Record<string, unknown> = { title: "t" };
  cyclic.self = cyclic;
  assert.doesNotThrow(() => scanRecord(cyclic));
  assert.deepEqual(scanRecord(cyclic), [], "an unserialisable record yields nothing, not an exception");
});

test("the warning quotes what matched and states the remedy", () => {
  assert.equal(publicationWarning([]), "", "no hits means no noise");
  const msg = publicationWarning(scanRecord({ title: "t", context: "/Users/someone/.config/x" }));
  assert.match(msg, /PUBLICATION RISK/);
  assert.match(msg, /machine-path/);
  assert.match(msg, /private:true/, "the remedy must be named, not implied");
});

test("the opt-in list degrades to silence, never to an exception", () => {
  const dir = mkdtempSync(join(tmpdir(), "hunch-pub-"));
  try {
    assert.deepEqual(loadVocabulary(dir), [], "an absent file means vocabulary is simply off");

    writeFileSync(join(dir, "publication.json"), "{ not json");
    assert.deepEqual(loadVocabulary(dir), [], "malformed JSON must not crash a capture");

    writeFileSync(join(dir, "publication.json"), JSON.stringify({ vocabulary: "not-an-array" }));
    assert.deepEqual(loadVocabulary(dir), []);

    // One unparseable pattern must not disable a user's whole list.
    writeFileSync(join(dir, "publication.json"), JSON.stringify({ vocabulary: ["\\bmoats?\\b", "([unclosed", 42] }));
    const loaded = loadVocabulary(dir);
    assert.equal(loaded.length, 1, "the good pattern survives its broken neighbour");
    assert.ok(scanRecord({ title: "t", context: "our moat" }, { vocabulary: loaded }).length === 1);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("recall: the record whose overlay path leaked is caught by a structural rule alone", () => {
  // dec_bb49b17601, pulled from the public store on 2026-08-11. Vocabulary would have
  // missed it entirely — it is an operational handoff, not strategy prose.
  const hits = scanRecord({
    id: "dec_bb49b17601",
    title: "Handoff (office → home, 2026-07-13)",
    context: "HOME SETUP: git pull both repos, npm i -g @davesheffer/hunch@1.8.1",
    consequences: ["EXP-03 bank draft waits in .hunch-private/exp03-bank/cases-hunch-draft.json if evidence is ever wanted"],
  });
  assert.ok(hits.some(isStructural), "must be caught without any vocabulary configured");
  assert.ok(has(hits, "private-overlay-path"));
});
