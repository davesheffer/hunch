import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { pathToFileURL } from "node:url";
import { spawnSync } from "node:child_process";
import { hunchCliArgs } from "./cli-invocation.js";

test("ordinary CLI and hook startup do not load MCP runtime dependencies", t => {
  const root = mkdtempSync(join(tmpdir(), "hunch-cli-startup-"));
  t.after(() => rmSync(root, { recursive: true, force: true }));
  const loader = join(root, "deny-mcp.mjs");
  writeFileSync(loader, `export async function resolve(specifier, context, nextResolve) {
    if (specifier.startsWith("@modelcontextprotocol/sdk/") || specifier.endsWith("/mcp/server.js")) {
      throw new Error("UNEXPECTED_EAGER_MCP_IMPORT: " + specifier);
    }
    return nextResolve(specifier, context);
  }`);
  for (const args of [["--version"], ["--help"], ["serve", "--help"], ["integrations", "check", "--help"], ["footprint", "--help"], ["hook"]]) {
    const result = spawnSync(process.execPath, ["--experimental-loader", pathToFileURL(loader).href, ...hunchCliArgs(...args)], {
      cwd: root, input: "{}", encoding: "utf8", timeout: 30_000,
    });
    assert.equal(result.status, 0, `${args.join(" ")}: ${result.error?.message ?? result.stderr}`);
    assert.doesNotMatch(result.stderr, /UNEXPECTED_EAGER_MCP_IMPORT/);
    if (args[0] === "hook") assert.equal(result.stdout, "");
    else assert.ok(result.stdout.trim(), `${args.join(" ")} produced no output`);
  }
});
