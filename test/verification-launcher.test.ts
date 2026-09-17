import { test } from "node:test";
import assert from "node:assert/strict";
import { verificationLauncherFor } from "../src/mcp/taskReportTools.js";

test("the verification launcher never resolves tsx on the published path, where it is not installed (#261)", () => {
  const missing = (specifier: string): string => { throw Object.assign(new Error(`Cannot find package '${specifier}'`), { code: "ERR_MODULE_NOT_FOUND" }); };
  // A published install: dist/mcp/taskReportTools.js, no devDependencies.
  const dist = verificationLauncherFor(new URL("../dist/mcp/taskReportTools.js", import.meta.url).href, missing);
  assert.equal(dist.argv[0], process.execPath);
  assert.ok(!dist.argv.includes("--import"), "a dist launch passes no loader");
  assert.match(dist.argv.at(-1)!, /dist[\\/]cli[\\/]index\.js$/);
  assert.equal(dist.argv.length, 2);
  // A source checkout: the loader is resolved and passed as a file URL.
  const src = verificationLauncherFor(new URL("../src/mcp/taskReportTools.ts", import.meta.url).href, () => "file:///tools/tsx/dist/loader.mjs");
  assert.deepEqual(src.argv.slice(1, 3), ["--import", "file:///tools/tsx/dist/loader.mjs"]);
  assert.match(src.argv.at(-1)!, /src[\\/]cli[\\/]index\.ts$/);
  // A source checkout whose resolver returns a path still gets a URL.
  const fromPath = verificationLauncherFor(new URL("../src/mcp/taskReportTools.ts", import.meta.url).href, () => process.platform === "win32" ? "C:\\tools\\tsx\\loader.mjs" : "/tools/tsx/loader.mjs");
  assert.match(fromPath.argv[2]!, /^file:\/\/\//);
});
