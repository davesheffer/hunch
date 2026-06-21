import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, writeFileSync, readFileSync, rmSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { healClaudeConfigCaseSplit } from "../src/integrations/claudeConfig.js";

const HUNCH = { type: "stdio", command: "hunch", args: ["mcp"], env: {} };

function fixture(extra?: Record<string, unknown>) {
  const dir = mkdtempSync(join(tmpdir(), "hunch-claudecfg-"));
  const file = join(dir, ".claude.json");
  const cfg = {
    projects: {
      // lower-case drive: the empty block a session resolves to → no hunch
      "c:/Users/me/repo": { mcpServers: {}, history: ["h1"] },
      // upper-case drive: where `claude mcp add` actually wrote hunch
      "C:/Users/me/repo": { mcpServers: { hunch: { ...HUNCH } }, allowedTools: ["Bash"] },
      ...extra,
    },
  };
  writeFileSync(file, JSON.stringify(cfg, null, 2));
  return { dir, file };
}

test("doctor heals a c:/C: drive-letter split so BOTH casings resolve hunch", () => {
  const { dir, file } = fixture();
  try {
    const res = healClaudeConfigCaseSplit({ file, platform: "win32" });
    assert.equal(res.changed, true, "reports a change");
    assert.ok(res.backup, "made a timestamped backup before writing");

    const out = JSON.parse(readFileSync(file, "utf8")).projects;
    // The whole point: whichever casing a session resolves to, hunch is present.
    assert.deepEqual(out["c:/Users/me/repo"].mcpServers.hunch, HUNCH, "lower-case drive now has hunch");
    assert.deepEqual(out["C:/Users/me/repo"].mcpServers.hunch, HUNCH, "upper-case drive still has hunch");
    // MERGE only — never clobber other keys in either block.
    assert.deepEqual(out["c:/Users/me/repo"].history, ["h1"], "preserved other keys (lower)");
    assert.deepEqual(out["C:/Users/me/repo"].allowedTools, ["Bash"], "preserved other keys (upper)");
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("heal is idempotent — a second run makes no change", () => {
  const { dir, file } = fixture();
  try {
    healClaudeConfigCaseSplit({ file, platform: "win32" });
    const res2 = healClaudeConfigCaseSplit({ file, platform: "win32" });
    assert.equal(res2.changed, false, "no further change on re-run");
    assert.equal(res2.backup, undefined, "no backup when nothing is written");
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("heal unions ALL servers across casings, not just hunch", () => {
  const { dir, file } = fixture({
    "C:/Users/me/repo2": { mcpServers: { other: { command: "x" } } },
    "c:/Users/me/repo2": { mcpServers: { hunch: { ...HUNCH } } },
  });
  try {
    healClaudeConfigCaseSplit({ file, platform: "win32" });
    const out = JSON.parse(readFileSync(file, "utf8")).projects;
    for (const k of ["C:/Users/me/repo2", "c:/Users/me/repo2"]) {
      assert.ok(out[k].mcpServers.hunch, `${k} has hunch`);
      assert.ok(out[k].mcpServers.other, `${k} has other`);
    }
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("heal is a no-op on non-Windows", () => {
  const { dir, file } = fixture();
  try {
    const before = readFileSync(file, "utf8");
    const res = healClaudeConfigCaseSplit({ file, platform: "linux" });
    assert.equal(res.applicable, false);
    assert.equal(res.changed, false);
    assert.equal(readFileSync(file, "utf8"), before, "file untouched on non-Windows");
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("heal refuses to clobber an unparseable ~/.claude.json", () => {
  const dir = mkdtempSync(join(tmpdir(), "hunch-claudecfg-"));
  const file = join(dir, ".claude.json");
  writeFileSync(file, "{ this is not json ");
  try {
    assert.throws(() => healClaudeConfigCaseSplit({ file, platform: "win32" }), /refus/i);
    assert.equal(readFileSync(file, "utf8"), "{ this is not json ", "left the unparseable file untouched");
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("heal no-ops cleanly when there is no split", () => {
  const dir = mkdtempSync(join(tmpdir(), "hunch-claudecfg-"));
  const file = join(dir, ".claude.json");
  writeFileSync(file, JSON.stringify({ projects: { "c:/only/one": { mcpServers: { hunch: { ...HUNCH } } } } }));
  try {
    const res = healClaudeConfigCaseSplit({ file, platform: "win32" });
    assert.equal(res.changed, false);
    assert.equal(res.applicable, true);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});
