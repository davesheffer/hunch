import { test } from "node:test";
import assert from "node:assert/strict";
import { existsSync, mkdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { loadHunch } from "../vscode-extension/src/hunchData.js";

function record(id: string): string {
  return JSON.stringify({ id, title: id, status: "accepted", related_files: [], provenance: { source: "human", confidence: 1 } }) + "\n";
}

test("VS Code read layer unions private overlay records and reports an unavailable pointer", () => {
  const root = join(tmpdir(), `hunch-vscode-overlay-${Date.now()}-${Math.random()}`);
  const previous = process.env.HUNCH_PRIVATE_DIR;
  try {
    delete process.env.HUNCH_PRIVATE_DIR;
    const publicDir = join(root, ".hunch");
    const privateDir = join(root, "private-memory", ".hunch");
    mkdirSync(join(publicDir, "decisions"), { recursive: true });
    mkdirSync(join(privateDir, "decisions"), { recursive: true });
    writeFileSync(join(publicDir, "decisions", "dec_public.json"), record("dec_public"));
    writeFileSync(join(privateDir, "decisions", "dec_private.json"), record("dec_private"));
    writeFileSync(join(publicDir, "local.json"), JSON.stringify({ privateDir: "private-memory/.hunch", mode: "private" }) + "\n");

    const active = loadHunch(root)!;
    assert.equal(active.overlay?.state, "active");
    assert.equal(active.overlay?.mode, "private");
    assert.deepEqual(active.decisions.map((d) => d.id).sort(), ["dec_private", "dec_public"]);

    rmSync(privateDir, { recursive: true, force: true });
    assert.ok(!existsSync(privateDir));
    const missing = loadHunch(root)!;
    assert.equal(missing.overlay?.state, "missing");
    assert.deepEqual(missing.decisions.map((d) => d.id), ["dec_public"]);
  } finally {
    if (previous === undefined) delete process.env.HUNCH_PRIVATE_DIR;
    else process.env.HUNCH_PRIVATE_DIR = previous;
    rmSync(root, { recursive: true, force: true });
  }
});
