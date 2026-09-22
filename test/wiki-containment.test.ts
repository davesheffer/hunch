import { cleanupDir } from "./fixtures.js";
/**
 * Wiki path containment (round-2 audit). `.hunch/wiki-manifest.json` is COMMITTED
 * so CI can gate on it, which makes every page KEY inside it PR- and
 * merge-influenceable — and wikiStatus classifies any key no current artifact
 * claims as an orphan to DELETE. With no containment check at either the write or
 * the delete site, a manifest key like "../../secret" turned a plain `hunch wiki`
 * into arbitrary file deletion, and `--dir ..` / `--dir .` wrote the rendered graph
 * outside the pages root (clobbering tracked files such as README.md).
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import { existsSync, mkdtempSync, mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { generateWiki, publicHome, wikiStatus } from "../src/wiki/wiki.js";
import { HunchStore } from "../src/store/hunchStore.js";
import { hunchPaths } from "../src/core/paths.js";

function repo(): { root: string; store: HunchStore; cleanup: () => void } {
  const root = mkdtempSync(join(tmpdir(), "hunch-wiki-contain-"));
  const store = new HunchStore(hunchPaths(root));
  store.json.ensureDirs();
  return { root, store, cleanup: () => { store.close(); cleanupDir(root); } };
}

/** Seed an adopted wiki manifest carrying hostile page keys alongside a benign one. */
function seedManifest(root: string, pages: Record<string, unknown>): void {
  writeFileSync(join(hunchPaths(root).hunch, "wiki-manifest.json"), JSON.stringify({ version: 1, dir: "wiki", pages }, null, 2));
}

test("a traversing manifest key is never classified as an orphan (#1)", () => {
  const { root, store, cleanup } = repo();
  try {
    seedManifest(root, {
      "../../escape.txt": { component: "cmp_gone", hash: "0", generated: "2026-08-05T00:00:00Z" },
      "wiki/legit.md": { component: "cmp_also_gone", hash: "0", generated: "2026-08-05T00:00:00Z" },
      "src/cli/index.ts": { component: "cmp_gone_too", hash: "0", generated: "2026-08-05T00:00:00Z" },
    });
    const status = wikiStatus(store, publicHome(root), root);
    assert.ok(status.orphans.includes("wiki/legit.md"), "a real in-tree orphan is still collected");
    assert.ok(!status.orphans.some((p) => p.includes("..")), "a traversing key must never reach the delete list");
    assert.ok(!status.orphans.includes("src/cli/index.ts"), "an in-repo key OUTSIDE the wiki dir is not a wiki orphan either");
  } finally {
    cleanup();
  }
});

test("orphan removal deletes nothing outside the wiki directory, end to end (#1)", async () => {
  const { root, store, cleanup } = repo();
  const outside = mkdtempSync(join(tmpdir(), "hunch-wiki-victim-"));
  try {
    const victimOutside = join(outside, "id_rsa");
    writeFileSync(victimOutside, "PRIVATE KEY");
    const victimInRepo = join(root, "src", "cli", "index.ts");
    mkdirSync(join(root, "src", "cli"), { recursive: true });
    writeFileSync(victimInRepo, "export const real = 1;\n");
    // A page key that traverses out of the repo entirely, plus one that stays in the
    // repo but outside wiki/ — both indistinguishable from ordinary manifest churn.
    // Enough ".." segments to climb out of the temp repo, then back down to the victim.
    const escapeKey = "../".repeat(24) + join(outside, "id_rsa").replace(/\\/g, "/").replace(/^[a-zA-Z]:\//, "");
    seedManifest(root, {
      [escapeKey]: { component: "cmp_x", hash: "0", generated: "2026-08-05T00:00:00Z" },
      "src/cli/index.ts": { component: "cmp_y", hash: "0", generated: "2026-08-05T00:00:00Z" },
    });

    await generateWiki(store, root, publicHome(root), { now: "2026-08-05T00:00:00Z", only: "all" });

    assert.equal(readFileSync(victimOutside, "utf8"), "PRIVATE KEY", "a file outside the repo must survive");
    assert.equal(existsSync(victimInRepo), true, "a repo file outside wiki/ must survive");
  } finally {
    cleanupDir(outside);
    cleanup();
  }
});

test("--dir refuses traversal and self-aliasing instead of writing outside wiki/ (#1)", () => {
  const { root, cleanup } = repo();
  try {
    writeFileSync(join(root, "README.md"), "# the real readme\n");
    for (const bad of ["..", ".", "../elsewhere", "wiki/../..", "/etc"]) {
      assert.throws(() => publicHome(root, bad), /refusing --dir/, `--dir ${bad} must be refused`);
    }
    // A normal nested dir still works.
    assert.equal(publicHome(root, "docs/wiki/").dir, "docs/wiki");
    assert.equal(readFileSync(join(root, "README.md"), "utf8"), "# the real readme\n", "README untouched");
  } finally {
    cleanup();
  }
});

test("a hostile dir committed in the manifest is ignored, not honoured (#1)", () => {
  const { root, cleanup } = repo();
  try {
    writeFileSync(join(hunchPaths(root).hunch, "wiki-manifest.json"), JSON.stringify({ version: 1, dir: "..", pages: {} }));
    assert.equal(publicHome(root).dir, "wiki", "an escaping manifest dir falls back to the default instead of replaying every run");
  } finally {
    cleanup();
  }
});
