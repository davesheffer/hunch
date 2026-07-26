import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { publishedMcpInvocation } from "../src/cli/invocation.js";
import { HUNCH_NPX_PACKAGE_SPEC, HUNCH_PACKAGE_SPEC, HUNCH_VERSION } from "../src/core/version.js";

test("HUNCH_VERSION reflects package.json — never the old hardcoded 0.1.0", () => {
  const pkg = JSON.parse(readFileSync(new URL("../package.json", import.meta.url), "utf8")) as { version: string };
  assert.equal(HUNCH_VERSION, pkg.version, "shared version must equal package.json");
  assert.notEqual(HUNCH_VERSION, "0.1.0", "must not be the stale literal the MCP server reported");
  assert.match(HUNCH_VERSION, /^\d+\.\d+\.\d+/, "looks like a real semver");
});

test("distributed MCP launchers pin the exact npm package version", () => {
  const pkg = JSON.parse(readFileSync(new URL("../package.json", import.meta.url), "utf8")) as {
    name: string;
    version: string;
  };
  const expected = `${pkg.name}@${pkg.version}`;
  const expectedNpxPackage = `hunch-exact@npm:${expected}`;
  const plugin = JSON.parse(readFileSync(new URL("../plugin/.mcp.json", import.meta.url), "utf8")) as {
    mcpServers: { hunch: { command: string; args: string[] } };
  };

  assert.equal(HUNCH_PACKAGE_SPEC, expected);
  assert.equal(HUNCH_NPX_PACKAGE_SPEC, expectedNpxPackage);
  assert.deepEqual(publishedMcpInvocation(), {
    command: "npx",
    args: ["-y", `--package=${expectedNpxPackage}`, "hunch"],
  });
  assert.deepEqual(plugin.mcpServers.hunch, {
    command: "npx",
    args: ["-y", `--package=${expectedNpxPackage}`, "hunch", "mcp"],
  });
});
