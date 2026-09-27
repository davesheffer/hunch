// PILOT5 benchmark validator for issue #372 ("No measurement or regression gate
// for Hunch's context footprint"). Built outside the agent workspace from the
// fix's own regression surface, adapted to the CLI command the fix shipped
// (`hunch footprint --json`) instead of importing the internal
// `measureFootprint` symbol directly, so the check exercises the product
// surface rather than one implementation's private function name.
//
// At the starting commit `hunch footprint` does not exist: the CLI exits
// non-zero with an "unknown command" error — the issue's own complaint (no
// measurement tool exists). At the fix commit the command exists, emits
// `hunch.footprint/1` JSON, and every listed surface is non-empty.
import { test } from "node:test";
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

function runCli(args: string[], cwd: string): { status: number | null; out: string; err: string } {
  const child = spawnSync(
    process.execPath,
    [join(process.cwd(), "node_modules/tsx/dist/cli.mjs"), join(process.cwd(), "src/cli/index.ts"), ...args],
    { cwd, encoding: "utf8", env: { ...process.env, HUNCH_PRIVATE_DIR: "" } },
  );
  return { status: child.status, out: child.stdout ?? "", err: child.stderr ?? "" };
}

test("hunch footprint (#372) measures the context-footprint surfaces as non-zero JSON", () => {
  const repo = mkdtempSync(join(tmpdir(), "hunch-footprint-bench-"));
  try {
    const result = runCli(["footprint", "--json"], repo);
    // At the starting commit this command does not exist and `status` is
    // non-zero (commander's "unknown command" error) — the assertion below
    // fails for the issue's own reason, not an import error.
    assert.equal(result.status, 0, `hunch footprint --json failed: ${result.out}${result.err}`);
    const report = JSON.parse(result.out);
    assert.equal(report.schema, "hunch.footprint/1");
    assert.equal(report.estimate, "chars/4");
    assert.ok(Array.isArray(report.surfaces) && report.surfaces.length > 0, "no surfaces reported");
    const ids = report.surfaces.map((s: { id: string }) => s.id);
    for (const expected of ["mcp.tools_list", "mcp.hunch_context", "grounding.block"]) {
      assert.ok(ids.includes(expected), `missing surface ${expected}; got ${ids.join(", ")}`);
    }
    for (const s of report.surfaces as { id: string; chars: number; est_tokens: number }[]) {
      assert.ok(s.chars > 0, `${s.id} measured 0 chars`);
      assert.equal(s.est_tokens, Math.ceil(s.chars / 4), `${s.id} est_tokens does not match chars/4`);
    }
    assert.ok(Array.isArray(report.unmeasured) && report.unmeasured.length > 0, "expected at least one documented unmeasured surface");
  } finally {
    rmSync(repo, { recursive: true, force: true });
  }
});
