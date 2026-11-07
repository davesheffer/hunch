import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, relative, resolve } from "node:path";
import { test } from "node:test";
import { fileURLToPath } from "node:url";
import { fastHookArgs } from "../src/cli/hookMain.js";
import { OPT_OUT_FILE } from "../src/integrations/uninstall.js";

/**
 * tooling/bundle-cli.mjs turns the tsc output into one bundle behind a tiny
 * entry, so every hook process loads one module instead of ~540. These checks
 * run against the built dist/ (npm run build) and pin what the published entry
 * must keep doing. Like every compiled-CLI test (test/cli-invocation.ts) they
 * need HUNCH_TEST_COMPILED_CLI=1 and a fresh build; a plain `npm test` on a
 * clean clone has no dist/ yet.
 */
const dist = (p: string) => fileURLToPath(new URL(`../dist/${p}`, import.meta.url));
const pkg = JSON.parse(readFileSync(new URL("../package.json", import.meta.url), "utf8")) as { version: string; bin: Record<string, string> };
const compiled = process.env.HUNCH_TEST_COMPILED_CLI === "1"
  ? {}
  : { skip: "set HUNCH_TEST_COMPILED_CLI=1 after npm run build" };

test("bundle-cli.mjs: dist/cli/index.js is the generated entry that gates Node then loads the bundle", compiled, () => {
  const entry = readFileSync(dist("cli/index.js"), "utf8");
  assert.match(entry, /^#!\/usr\/bin\/env node\n/, "bin entry keeps its shebang");
  assert.match(entry, /hunch:bundle-entry/);
  // The version gate must be evaluated before the bundle (which imports node:sqlite) is linked.
  assert.ok(entry.indexOf('import "./preflight.js"') < entry.indexOf('import(fastHook ?'));
  assert.ok(existsSync(dist("cli/index.bundle.js")));
  assert.ok(Object.values(pkg.bin).includes("dist/cli/index.js"), "bin still points at the entry hooks are installed with");
});

test("bundle-cli.mjs: the bundle only imports Node builtins and the declared externals", compiled, () => {
  const bundle = readFileSync(dist("cli/index.bundle.js"), "utf8");
  const specifiers = new Set([...bundle.matchAll(/^import\s[^;]*?from\s*"([^"]+)"/gm)].map((m) => m[1]!));
  const stray = [...specifiers].filter((s) => !s.startsWith("node:") && !/^(tree-sitter|@tree-sitter-grammars\/|@huggingface\/transformers)/.test(s));
  assert.deepEqual(stray, [], "a relative or npm import left in the bundle would load the module graph the bundle exists to avoid");
});

test("hook startup: the CLI's static import closure stays free of the MCP SDK", () => {
  // Every agent hook is a fresh process that evaluates this closure, so a static
  // import of the SDK (or the MCP server, which owns it) costs every tool call.
  const src = fileURLToPath(new URL("../src/", import.meta.url));
  const seen = new Set<string>();
  const offenders: string[] = [];
  const pending = [join(src, "cli/index.ts")];
  while (pending.length) {
    const file = pending.pop()!;
    if (seen.has(file)) continue;
    seen.add(file);
    const text = readFileSync(file, "utf8");
    for (const m of text.matchAll(/^import\s+(?!type\b)(?:[^;"']*?\sfrom\s+)?"([^"]+)"/gm)) {
      const spec = m[1]!;
      if (spec.startsWith("@modelcontextprotocol/") || spec === "node:http") offenders.push(`${relative(src, file)} -> ${spec}`);
      else if (spec.startsWith(".")) pending.push(resolve(dirname(file), spec).replace(/\.js$/, ".ts"));
    }
  }
  assert.ok(seen.size > 100, `walked only ${seen.size} modules; the import pattern no longer matches`);
  assert.deepEqual(offenders, [], "load these with a dynamic import inside the command that needs them");
});

test("bundle-cli.mjs: the bundled CLI runs through the published entry", compiled, () => {
  const r = spawnSync(process.execPath, [dist("cli/index.js"), "--version"], { encoding: "utf8" });
  assert.equal(r.status, 0, r.stderr);
  assert.equal(r.stdout.trim(), pkg.version);
});

test("hook startup: the hook-only entry's static import closure never reaches the CLI program or commander, and reaches the constitution only through the grounding-block writer", () => {
  const src = fileURLToPath(new URL("../src/", import.meta.url));
  const seen = new Set<string>();
  const offenders: string[] = [];
  const pending = [join(src, "cli/hookMain.ts")];
  while (pending.length) {
    const file = pending.pop()!;
    if (seen.has(file)) continue;
    seen.add(file);
    const text = readFileSync(file, "utf8");
    for (const m of text.matchAll(/^(?:import|export)\s+(?!type)(?:[^;"']*?\sfrom\s+)?"([^"]+)"/gm)) {
      const spec = m[1]!;
      const target = spec.startsWith(".") ? resolve(dirname(file), spec).replace(/\.js$/, ".ts") : spec;
      if (target.startsWith(join(src, "constitution"))) {
        // The one known edge: the grounding-block writer (claudemd.ts, reached through
        // flushCapture) counts public policies. Do not descend or add any other.
        if (`${relative(src, file)} -> ${spec}`.replaceAll("\\", "/") !== "integrations/claudemd.ts -> ../constitution/repository.js") offenders.push(`${relative(src, file)} -> ${spec}`);
      } else if (spec === "commander" || spec.startsWith("@modelcontextprotocol/") || target === join(src, "cli/index.ts")) {
        offenders.push(`${relative(src, file)} -> ${spec}`);
      } else if (spec.startsWith(".")) pending.push(target);
    }
  }
  assert.ok(seen.size > 20, `walked only ${seen.size} modules; the import pattern no longer matches`);
  assert.deepEqual(offenders, []);
});

test("hook startup: fastHookArgs accepts only the plain hook forms", () => {
  assert.deepEqual(fastHookArgs(["hook"]), { provider: "claude" });
  assert.deepEqual(fastHookArgs(["hook", "--provider", "cursor"]), { provider: "cursor" });
  assert.deepEqual(fastHookArgs(["hook", "--provider=vscode"]), { provider: "vscode" });
  for (const bad of [
    [], ["hook", "--help"], ["--initiator", "x", "hook"], ["hook", "--provider"], ["hook", "--provider="],
    ["hook", "--provider", ""], ["hook", "extra"], ["hook", "--provider", "cursor", "extra"],
    ["hook", "--initiator", "x"], ["hook", "--cli-config", "f"], ["hooks"], ["doctor"],
  ]) assert.equal(fastHookArgs(bad), null, JSON.stringify(bad));
});

test("bundle-cli.mjs: the entry routes plain hook argv to the hook-only bundle", compiled, () => {
  const entry = readFileSync(dist("cli/index.js"), "utf8");
  assert.match(entry, /fastHook \? "\.\/hook\.bundle\.js" : "\.\/index\.bundle\.js"/);
  assert.ok(existsSync(dist("cli/hook.bundle.js")));
  const hookBundle = readFileSync(dist("cli/hook.bundle.js"), "utf8");
  assert.ok(!/from\s*"commander"/.test(hookBundle) && !hookBundle.includes("// node_modules/commander/"), "hook bundle must not contain Commander");
});

test("bundle-cli.mjs: the hook-only bundle stays silent and exits 0 in an opted-out repository", compiled, () => {
  const dir = mkdtempSync(join(tmpdir(), "hunch-hook-optout-"));
  try {
    writeFileSync(join(dir, OPT_OUT_FILE), "opted out\n");
    const r = spawnSync(process.execPath, [dist("cli/index.js"), "hook"], {
      cwd: dir, encoding: "utf8", input: JSON.stringify({ hook_event_name: "PreToolUse", session_id: "s1", tool_name: "Bash", tool_input: { command: "ls" }, cwd: dir }),
    });
    assert.equal(r.status, 0, r.stderr);
    assert.equal(r.stdout, "");
  } finally { rmSync(dir, { recursive: true, force: true }); }
});
