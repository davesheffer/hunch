import assert from "node:assert/strict";
import { execFileSync, spawnSync } from "node:child_process";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";

import { compareCodeUnits } from "../src/core/canonicalOrder.js";

interface LocaleReceipt {
  locale: string;
  canonical_json: string;
  canonical_hash: string;
  source_hash: string;
  source_paths: string[];
  wiki_pack_hash: string;
  wiki_slugs: Record<string, string>;
}

function receiptUnderLocale(root: string, locale: string): LocaleReceipt {
  const script = [
    'import { canonicalHash, canonicalJson } from "./src/constitution/canonical.ts";',
    'import { scanRepo } from "./src/extractors/indexer.ts";',
    'import { repoSourceInventory } from "./src/extractors/repoSource.ts";',
    'import { hunchPaths } from "./src/core/paths.ts";',
    'import { HunchStore } from "./src/store/hunchStore.ts";',
    'import { compareWikiComponents, packHash, slugFor } from "./src/wiki/wiki.ts";',
    'const root = process.env.HUNCH_LOCALE_FIXTURE;',
    'if (!root) throw new Error("missing locale fixture");',
    'const store = new HunchStore(hunchPaths(root));',
    'try {',
    '  const scan = scanRepo(store, root, { churn: false, source: { kind: "commit", ref: "HEAD" } });',
    '  const taken = new Set();',
    '  const wikiComponents = [{ id: "cmp_111111aaaa", name: "z" }, { id: "cmp_222222bbbb", name: "äz" }].sort(compareWikiComponents);',
    '  const wikiSlugs = Object.fromEntries(wikiComponents.map((component) => [component.id, slugFor(component.name, component.id, taken)]));',
    '  console.log(JSON.stringify({',
    '    locale: new Intl.Collator().resolvedOptions().locale,',
    '    canonical_json: canonicalJson({ z: 1, "ä": 2 }),',
    '    canonical_hash: canonicalHash({ z: 1, "ä": 2 }),',
    '    source_hash: scan.source.content_hash,',
    '    source_paths: repoSourceInventory(root, { kind: "commit", ref: "HEAD" }).entries.map((entry) => entry.path),',
    '    wiki_pack_hash: packHash({ z: 1, "ä": 2 }),',
    '    wiki_slugs: wikiSlugs,',
    '  }));',
    '} finally { store.close(); }',
  ].join("\n");
  const run = spawnSync(process.execPath, ["--import", "tsx", "--input-type=module", "--eval", script], {
    cwd: process.cwd(),
    env: { ...process.env, LC_ALL: locale, LANG: locale, HUNCH_LOCALE_FIXTURE: root },
    encoding: "utf8",
  });
  assert.equal(run.status, 0, run.stderr);
  return JSON.parse(run.stdout) as LocaleReceipt;
}

test("canonical artifacts and exact source receipts are locale-independent", () => {
  const root = mkdtempSync(join(tmpdir(), "hunch-canonical-locale-"));
  try {
    const git = (...args: string[]): void => { execFileSync("git", args, { cwd: root, stdio: "ignore" }); };
    git("init", "-q");
    git("config", "user.email", "locale@test.invalid");
    git("config", "user.name", "Locale Test");
    mkdirSync(join(root, "src"), { recursive: true });
    writeFileSync(join(root, "src/z.ts"), "export const z = 1;\n");
    writeFileSync(join(root, "src/ä.ts"), "export const umlaut = 2;\n");
    git("add", "-A");
    git("commit", "-qm", "fixture: unicode source paths");

    assert.deepEqual(["ä", "z"].sort(compareCodeUnits), ["z", "ä"]);
    const english = receiptUnderLocale(root, "en_US.UTF-8");
    const swedish = receiptUnderLocale(root, "sv_SE.UTF-8");
    assert.notEqual(english.locale, swedish.locale, "the subprocesses must exercise distinct default collations");
    assert.equal(english.canonical_json, '{"z":1,"ä":2}');
    assert.deepEqual(english, { ...swedish, locale: english.locale }, "locale cannot alter canonical bytes, source order, or receipt hashes");
    assert.deepEqual(english.source_paths, ["src/z.ts", "src/ä.ts"]);
    assert.deepEqual(english.wiki_slugs, {
      cmp_111111aaaa: "z",
      cmp_222222bbbb: "z-222222",
    });
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});
