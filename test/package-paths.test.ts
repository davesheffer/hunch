import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { readFileSync } from "node:fs";
import { test } from "node:test";

/**
 * release.yml refuses to publish a tarball containing any path outside its inline allowlist.
 * The v1.23.0 tag failed that gate after package.json "files" gained contracts and .d.ts entries
 * the allowlist did not know. Execute the workflow's own predicates here so a files/allowlist
 * mismatch fails at `npm test`, not after a tag is pushed.
 */
const workflow = readFileSync(new URL("../.github/workflows/release.yml", import.meta.url), "utf8")
  .replace(/\r\n/g, "\n");

function predicate(name: string): (path: string) => boolean {
  const pattern = new RegExp(`const ${name} = (\\(path\\) => [\\s\\S]*?);\\n`);
  const match = workflow.match(pattern);
  assert.ok(match, `release.yml defines ${name}`);
  return new Function(`return ${match[1]}`)() as (path: string) => boolean;
}

test("every path npm would pack is accepted by both release.yml package allowlists", () => {
  const pack = spawnSync("npm", ["pack", "--dry-run", "--json", "--ignore-scripts"], {
    cwd: new URL("..", import.meta.url),
    encoding: "utf8",
    shell: process.platform === "win32",
  });
  assert.equal(pack.status, 0, pack.stderr);
  const [packed] = JSON.parse(pack.stdout) as Array<{ files: Array<{ path: string }> }>;
  const paths = packed.files.map((file) => file.path);
  assert.ok(paths.includes("dist/cli/index.js"), "dist is built before this test runs");
  for (const [allowed, sensitive] of [
    [predicate("allowedPath"), predicate("sensitivePath")],
    [predicate("allowedPackagePath"), predicate("sensitivePackagePath")],
  ] as const) {
    const forbidden = paths.filter((path) => !allowed(path) || sensitive(path));
    assert.deepEqual(forbidden, [], "release.yml would refuse these packed paths");
  }
});
