import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { HUNCH_VERSION } from "../src/core/version.js";

test("HUNCH_VERSION reflects package.json — never the old hardcoded 0.1.0", () => {
  const pkg = JSON.parse(readFileSync(new URL("../package.json", import.meta.url), "utf8")) as { version: string };
  assert.equal(HUNCH_VERSION, pkg.version, "shared version must equal package.json");
  assert.notEqual(HUNCH_VERSION, "0.1.0", "must not be the stale literal the MCP server reported");
  assert.match(HUNCH_VERSION, /^\d+\.\d+\.\d+/, "looks like a real semver");
});
