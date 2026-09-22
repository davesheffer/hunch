import { cleanupDir } from "./fixtures.js";
import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { workspaceRootForFile } from "../vscode-extension/src/workspace.js";
import { runHunchWith, spawnHunchWith, winQuote } from "../vscode-extension/src/spawnCore.js";

test("VS Code multi-root routing selects the active document's folder", () => {
  const folders = ["/workspace/folder1", "/workspace/folder2"];
  assert.equal(workspaceRootForFile(folders, "/workspace/folder2/src/app.ts"), folders[1]);
  assert.equal(workspaceRootForFile(folders, "/workspace/folder1/src/app.ts"), folders[0]);
  assert.equal(workspaceRootForFile(folders, "/outside/app.ts"), folders[0], "outside documents use the documented first-folder fallback");
});

test("VS Code multi-root routing prefers the most specific nested folder", () => {
  assert.equal(
    workspaceRootForFile(["/workspace", "/workspace/packages/app"], "/workspace/packages/app/src/main.ts"),
    "/workspace/packages/app",
  );
});

test("Windows CLI quoting preserves literal percent expressions inside quoted arguments", () => {
  assert.equal(winQuote("%HUNCH_PRIVATE_DIR%"), '^^^"^^^%HUNCH_PRIVATE_DIR^^^%^^^"');
  assert.equal(winQuote("100% complete"), '^^^"100^^^%^^^ complete^^^"');
});

test("Windows CLI quoting survives a real .cmd shim and cmd.exe expansion pass", { skip: process.platform !== "win32" ? "cmd.exe regression runs on Windows CI" : false }, async () => {
  const root = mkdtempSync(join(tmpdir(), "hunch winquote "));
  const script = join(root, "print-arg.cjs");
  const shim = join(root, "hunch-proxy.cmd");
  const previous = process.env.HUNCH_WINQUOTE_SENTINEL;
  process.env.HUNCH_WINQUOTE_SENTINEL = "EXPANDED";
  try {
    writeFileSync(script, "process.stdout.write(JSON.stringify(process.argv.slice(2)))\n");
    // This mirrors npm's generated shim: cmd.exe receives the command and
    // forwards the original argument tail through %* to a native Node process.
    writeFileSync(shim, `@echo off\r\nnode "%~dp0print-arg.cjs" %*\r\n`);
    const args = [
      "%HUNCH_WINQUOTE_SENTINEL% complete",
      'quoted " value & pipe',
      "C:\\trailing\\",
      "",
      "literal !bang! | < > ^ & שלום",
    ];
    const result = await runHunchWith(shim, root, args, 5_000);
    assert.equal(result.ok, true, result.stderr || result.stdout);
    assert.deepEqual(JSON.parse(result.stdout), args, "the .cmd proxy must receive every argument unchanged");
    const native = await runHunchWith(process.execPath, root, [script, ...args], 5_000);
    assert.equal(native.ok, true, native.stderr);
    assert.deepEqual(JSON.parse(native.stdout), args, "native executable argv must remain shell-free");
    const child = spawnHunchWith(shim, root, args);
    const timer = setTimeout(() => child.kill(), 5_000);
    try {
      let stdout = "", stderr = "";
      child.stdout.setEncoding("utf8").on("data", (chunk: string) => { stdout += chunk; });
      child.stderr.setEncoding("utf8").on("data", (chunk: string) => { stderr += chunk; });
      const code = await new Promise<number | null>((resolve, reject) => { child.on("error", reject); child.on("close", resolve); });
      assert.equal(code, 0, stderr);
      assert.deepEqual(JSON.parse(stdout), args, "the streaming/MCP launcher must preserve the same argv");
    } finally { clearTimeout(timer); child.kill(); }
  } finally {
    if (previous === undefined) delete process.env.HUNCH_WINQUOTE_SENTINEL;
    else process.env.HUNCH_WINQUOTE_SENTINEL = previous;
    cleanupDir(root);
  }
});
