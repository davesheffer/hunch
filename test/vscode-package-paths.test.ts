import { cleanupDir } from "./fixtures.js";
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";

const workflow = readFileSync(new URL("../.github/workflows/vscode-open-vsx.yml", import.meta.url), "utf8")
  .replace(/\r\n/g, "\n").replace(/^          /gm, "");
const inspectors = [...workflow.matchAll(/const inspectVsixEntries = ([\s\S]*?\n});/g)]
  .map((match) => new Function("spawnSync", `return (${match[1]});`)(spawnSync) as (path: string) => Array<{ path: string }>);
assert.equal(inspectors.length, 2, "exercise the validation and publication copies of the real ZIP inspector");

function fixture(extra: string[], check: (path: string) => void) {
  const dir = mkdtempSync(join(tmpdir(), "hunch-vsix-paths-"));
  try {
    const path = join(dir, "fixture.vsix");
    const entries = ["[Content_Types].xml", "extension.vsixmanifest", "extension/package.json", "extension/dist/extension.js", "extension/readme.md", ...extra];
    const created = spawnSync("python3", ["-c", "import json,sys,zipfile\nwith zipfile.ZipFile(sys.argv[1], 'w') as z:\n for name in json.loads(sys.argv[2]): z.writestr(name, 'fixture')", path, JSON.stringify(entries)], { encoding: "utf8" });
    assert.equal(created.status, 0, created.stderr);
    check(path);
  } finally {
    cleanupDir(dir);
  }
}

test("both VSIX gates accept and require the shipped third-party license notice", () => {
  const notice = readFileSync(new URL("../vscode-extension/THIRD_PARTY_NOTICES.md", import.meta.url), "utf8");
  assert.match(notice, /cross-spawn 7\.0\.6/);
  assert.match(notice, /The MIT License/);
  fixture(["extension/THIRD_PARTY_NOTICES.md"], (path) => {
    for (const inspect of inspectors) assert.ok(inspect(path).some((entry) => entry.path === "extension/THIRD_PARTY_NOTICES.md"));
  });
  fixture([], (path) => {
    for (const inspect of inspectors) assert.throws(() => inspect(path), /missing required entry extension\/THIRD_PARTY_NOTICES\.md/);
  });
});

test("allowing the license notice does not admit arbitrary documents or private files", () => {
  for (const unwanted of ["extension/notes.md", "extension/.hunch/private.json", "extension/THIRD_PARTY_NOTICES.md.map"]) {
    fixture(["extension/THIRD_PARTY_NOTICES.md", unwanted], (path) => {
      for (const inspect of inspectors) assert.throws(() => inspect(path), (error: unknown) => error instanceof Error && error.message.includes(unwanted));
    });
  }
});
