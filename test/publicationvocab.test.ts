import { cleanupDir } from "./fixtures.js";
import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, mkdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { publicationVocabulary } from "../src/mcp/server.js";

/**
 * P1 regression guard: the publication vocabulary must be keyed by store.
 *
 * The previous cache was a process-global scalar memoized on first call — its
 * hunchDir argument was ignored from then on, so a multi-store process scanned
 * project B's records against project A's leak terms. Verified real in every
 * published dist from 1.12.2 through 1.17.0 (GATE-P1-UPSTREAM.md).
 */
test("two stores in one process get their own publication vocabularies", (t) => {
  const root = mkdtempSync(join(tmpdir(), "pubvocab-"));
  t.after(() => cleanupDir(root));

  const a = join(root, "a", ".hunch");
  const b = join(root, "b", ".hunch");
  mkdirSync(a, { recursive: true });
  mkdirSync(b, { recursive: true });
  writeFileSync(join(a, "publication.json"), JSON.stringify({ vocabulary: ["alpha-secret"] }));
  writeFileSync(join(b, "publication.json"), JSON.stringify({ vocabulary: ["bravo-secret"] }));

  const vocabA = publicationVocabulary(a);
  const vocabB = publicationVocabulary(b);

  assert.ok(vocabA.some((r) => r.test("alpha-secret")), "store A sees its own terms");
  assert.ok(vocabB.some((r) => r.test("bravo-secret")), "store B sees its own terms — the scalar cache served it A's");
  assert.ok(!vocabB.some((r) => r.test("alpha-secret")), "store B does not inherit store A's terms");

  // And the cache is still a cache: a second call returns the same arrays.
  assert.equal(publicationVocabulary(a), vocabA);
  assert.equal(publicationVocabulary(b), vocabB);
});
