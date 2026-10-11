import { test } from "node:test";
import assert from "node:assert/strict";
import { readdirSync, readFileSync } from "node:fs";
import { dirname, join, relative } from "node:path";
import { fileURLToPath } from "node:url";

/** An un-retried recursive rmSync in teardown turns a green test red when a
 *  straggling child (or Git's detached maintenance) still holds the tree:
 *  ENOTEMPTY/EPERM after every assertion passed (#384). Teardown goes through
 *  cleanupDir; a deliberate mid-test removal says why with `// rmSync-ok: …`. */
const TEST_DIR = dirname(fileURLToPath(import.meta.url));
const EXCLUDED = new Set(["fixtures.ts", "teardown-hygiene.test.ts"]); // cleanupDir's own definition; this scanner
const CALL = /(?<![\w$])rmSync\s*\(/g;
const EXEMPT = "// rmSync-ok:";
const MAX_CALL_LENGTH = 2000;

/** 1-based lines of recursive rmSync calls with no exemption on any line the call spans. */
function recursiveRmSyncOffenders(text: string): number[] {
  const lines = text.split("\n");
  const lineOf = (index: number): number => text.slice(0, index).split("\n").length;
  const offenders: number[] = [];
  for (const match of text.matchAll(CALL)) {
    const open = match.index + match[0].length - 1;
    let depth = 0;
    let close = Math.min(text.length, open + MAX_CALL_LENGTH) - 1;
    for (let i = open; i < Math.min(text.length, open + MAX_CALL_LENGTH); i++) {
      if (text[i] === "(") depth++;
      else if (text[i] === ")" && --depth === 0) { close = i; break; }
    }
    if (!/recursive\s*:\s*true/.test(text.slice(open, close + 1))) continue;
    const first = lineOf(match.index);
    const last = lineOf(close);
    if (!lines.slice(first - 1, last).some((line) => line.includes(EXEMPT))) offenders.push(first);
  }
  return offenders;
}

test("the scanner flags single- and multi-line recursive rmSync calls and honours the exemption", () => {
  const sample = [
    'rmSync(root, { recursive: true, force: true });',
    'rmSync(file, { force: true });',
    'cleanupDir(root);',
    'fs.rmSync(dir, {',
    '  force: true,',
    '  recursive: true,',
    '});',
    'rmSync(join(a, ".git"), { recursive: true }); // rmSync-ok: simulates an archive',
    'rmSync(',
    '  other,',
    '  { recursive: true }, // rmSync-ok: deliberate',
    ');',
    'originalRmSync(lock, { recursive: true });',
  ].join("\n");
  assert.deepEqual(recursiveRmSyncOffenders(sample), [1, 4]);
});

test("test teardown removes temp trees through cleanupDir, never an un-retried recursive rmSync", () => {
  const files = readdirSync(TEST_DIR, { recursive: true, encoding: "utf8" })
    .filter((name) => name.endsWith(".ts") && !name.split(/[\\/]/).includes("node_modules"))
    .filter((name) => !EXCLUDED.has(name));
  assert.ok(files.length > 100, `expected to scan the test suite, found ${files.length} files`);
  const offenders = files.flatMap((name) => {
    const path = join(TEST_DIR, name);
    return recursiveRmSyncOffenders(readFileSync(path, "utf8")).map((line) => `${relative(process.cwd(), path)}:${line}`);
  });
  assert.deepEqual(offenders, [], `use cleanupDir (test/fixtures.ts) in teardown, or mark a deliberate removal with "${EXEMPT} <reason>":\n${offenders.join("\n")}`);
});
