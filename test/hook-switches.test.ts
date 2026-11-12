import { test } from "node:test";
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { readFileSync, utimesSync, writeFileSync, mkdirSync } from "node:fs";
import { join, resolve } from "node:path";
import { tempStore, tsxLoaderUrl } from "./helpers.js";
import { hookConfigProblems, hookSwitch, parseHookSwitch } from "../src/core/hookSwitches.js";
import { quietEmptyEnabled } from "../src/core/pipeline.js";
import { leanGroundingEnabled, resolveGroundingVariant, renderHunchSection, renderHunchSectionAs, updateClaudeMd } from "../src/integrations/claudemd.js";
import { hookDaemonEnabled } from "../src/cli/hookDaemon.js";
import { groundingVariant } from "../src/core/groundingLag.js";
import { MCP_INSTRUCTIONS, MCP_INSTRUCTIONS_LEAN, mcpInstructions } from "../src/mcp/server.js";

const NAMES = ["HUNCH_LEAN_GROUNDING", "HUNCH_QUIET_EMPTY", "HUNCH_HOOK_DAEMON"] as const;

/** Run with the three switch env vars cleared, then set from `env`; restored after. */
function withEnv<T>(env: Partial<Record<(typeof NAMES)[number], string>>, fn: () => T): T {
  const prior = Object.fromEntries(NAMES.map((n) => [n, process.env[n]]));
  for (const n of NAMES) delete process.env[n];
  Object.assign(process.env, env);
  try { return fn(); }
  finally {
    for (const n of NAMES) {
      if (prior[n] === undefined) delete process.env[n]; else process.env[n] = prior[n];
    }
  }
}

let tick = 0;
function writeHooks(root: string, hooks: unknown): void {
  mkdirSync(join(root, ".hunch"), { recursive: true });
  const file = join(root, ".hunch", "config.json");
  writeFileSync(file, JSON.stringify({ firmness: "advisory", hooks }));
  // Distinct mtimes so the resolver's mtime+size cache can never serve a stale read.
  const t = new Date(Date.now() + ++tick * 2000);
  utimesSync(file, t, t);
}

test("hook switches: every switch defaults on, with no env and no config", (t) => {
  const { root, cleanup } = tempStore();
  t.after(cleanup);
  withEnv({}, () => {
    for (const name of ["lean_grounding", "quiet_empty", "daemon"] as const) {
      assert.deepEqual(hookSwitch(name, root), { value: true, source: "default" }, name);
    }
    assert.equal(quietEmptyEnabled(root), true);
    assert.equal(leanGroundingEnabled(root), true);
    assert.equal(hookDaemonEnabled(process.env, root), true);
    assert.equal(mcpInstructions(root), MCP_INSTRUCTIONS_LEAN);
  });
});

test("hook switches: config turns each off for the team; env overrides config both ways", (t) => {
  const { root, cleanup } = tempStore();
  t.after(cleanup);
  writeHooks(root, { lean_grounding: false, quiet_empty: false, daemon: false });
  withEnv({}, () => {
    assert.deepEqual(hookSwitch("quiet_empty", root), { value: false, source: "config" });
    assert.equal(quietEmptyEnabled(root), false);
    assert.equal(leanGroundingEnabled(root), false);
    assert.equal(hookDaemonEnabled(process.env, root), false);
    assert.equal(mcpInstructions(root), MCP_INSTRUCTIONS);
  });
  withEnv({ HUNCH_QUIET_EMPTY: "1", HUNCH_LEAN_GROUNDING: "on", HUNCH_HOOK_DAEMON: "true" }, () => {
    assert.deepEqual(hookSwitch("quiet_empty", root), { value: true, source: "env" });
    assert.equal(leanGroundingEnabled(root), true);
    assert.equal(hookDaemonEnabled(process.env, root), true);
  });
  writeHooks(root, { quiet_empty: true });
  withEnv({ HUNCH_QUIET_EMPTY: "0" }, () => assert.equal(quietEmptyEnabled(root), false));
  withEnv({ HUNCH_QUIET_EMPTY: "off" }, () => assert.equal(quietEmptyEnabled(root), false));
});

test("hook switches: unrecognized values fall through to the next level; a broken config never throws", (t) => {
  const { root, cleanup } = tempStore();
  t.after(cleanup);
  writeHooks(root, { quiet_empty: "sometimes", daemon: 0, lean_grounding: "preserve" });
  withEnv({ HUNCH_QUIET_EMPTY: "maybe" }, () => {
    assert.deepEqual(hookSwitch("quiet_empty", root), { value: true, source: "default" });
    assert.deepEqual(hookSwitch("daemon", root), { value: true, source: "default" }, "a number is not a switch value");
    assert.deepEqual(hookSwitch("lean_grounding", root), { value: "preserve", source: "config" });
  });
  assert.equal(parseHookSwitch("quiet_empty", "preserve"), undefined, "preserve belongs to lean_grounding only");
  writeFileSync(join(root, ".hunch", "config.json"), "{ not json");
  withEnv({}, () => assert.deepEqual(hookSwitch("daemon", root), { value: true, source: "default" }));
});

test("hook switches: a config edit is seen by a long-lived process on its next read", (t) => {
  const { root, cleanup } = tempStore();
  t.after(cleanup);
  withEnv({}, () => {
    writeHooks(root, { quiet_empty: false });
    assert.equal(quietEmptyEnabled(root), false);
    writeHooks(root, { quiet_empty: true });
    assert.equal(quietEmptyEnabled(root), true);
  });
});

test("hook switches: a same-size rewrite within one mtime tick is not served from cache", (t) => {
  // Coarse-mtime filesystems (FAT 2 s, some network shares) keep mtime and size for a
  // same-length edit; a read taken that close to the change must not be cached.
  const { root, cleanup } = tempStore();
  t.after(cleanup);
  mkdirSync(join(root, ".hunch"), { recursive: true });
  const file = join(root, ".hunch", "config.json");
  const tm = new Date(Math.floor(Date.now() / 2000) * 2000);
  withEnv({}, () => {
    writeFileSync(file, '{"hooks":{"daemon":true }}');
    utimesSync(file, tm, tm);
    assert.equal(hookSwitch("daemon", root).value, true);
    writeFileSync(file, '{"hooks":{"daemon":false}}');
    utimesSync(file, tm, tm);
    assert.deepEqual(hookSwitch("daemon", root), { value: false, source: "config" });
  });
});

test("hook switches: lean_grounding preserve keeps a committed block's variant; true migrates it; false pins full", (t) => {
  const { store, root, cleanup } = tempStore();
  t.after(cleanup);
  withEnv({ HUNCH_LEAN_GROUNDING: "0" }, () => updateClaudeMd(root, store));
  const full = readFileSync(join(root, "CLAUDE.md"), "utf8");
  assert.equal(groundingVariant(full), "full");
  writeHooks(root, { lean_grounding: "preserve" });
  withEnv({}, () => updateClaudeMd(root, store));
  assert.equal(readFileSync(join(root, "CLAUDE.md"), "utf8"), full, "preserve: a full block stays full, byte-stable");
  withEnv({ HUNCH_LEAN_GROUNDING: "1" }, () => updateClaudeMd(root, store));
  const lean = readFileSync(join(root, "CLAUDE.md"), "utf8");
  assert.equal(groundingVariant(lean), "lean");
  withEnv({}, () => updateClaudeMd(root, store));
  assert.equal(readFileSync(join(root, "CLAUDE.md"), "utf8"), lean, "preserve: a lean block stays lean");
  withEnv({}, () => {
    assert.equal(renderHunchSection(store, root), renderHunchSectionAs(store, root, "full"), "preserve with no block renders full");
    assert.equal(leanGroundingEnabled(root), true, "preserve concerns committed blocks only; MCP instructions stay lean");
  });
  writeHooks(root, { lean_grounding: false });
  withEnv({}, () => updateClaudeMd(root, store));
  assert.equal(groundingVariant(readFileSync(join(root, "CLAUDE.md"), "utf8")), "full");
});

test("hunch switches: shows sources, sets and resets a switch in .hunch/config.json without touching other keys", (t) => {
  const { root, cleanup } = tempStore();
  t.after(cleanup);
  writeFileSync(join(root, ".hunch", "config.json"), JSON.stringify({ firmness: "firm", custom_newer_key: 7 }));
  const env: NodeJS.ProcessEnv = { ...process.env };
  for (const n of NAMES) delete env[n];
  const run = (...args: string[]) => execFileSync(process.execPath, ["--import", tsxLoaderUrl(), resolve("src/cli/index.ts"), "switches", ...args], { cwd: root, env, encoding: "utf8" });
  const shown = JSON.parse(run("--json")) as { switches: { name: string; value: unknown; source: string }[] };
  assert.deepEqual(shown.switches.map((s) => [s.name, s.value, s.source]), [["lean_grounding", true, "default"], ["quiet_empty", true, "default"], ["daemon", true, "default"]]);
  run("daemon", "off");
  run("lean_grounding", "preserve");
  let cfg = JSON.parse(readFileSync(join(root, ".hunch", "config.json"), "utf8"));
  assert.deepEqual(cfg.hooks, { daemon: false, lean_grounding: "preserve" });
  assert.equal(cfg.firmness, "firm");
  assert.equal(cfg.custom_newer_key, 7, "unknown keys survive");
  assert.match(run(), /daemon\s+off\s+\(\.hunch\/config\.json\)/);
  run("daemon", "default");
  cfg = JSON.parse(readFileSync(join(root, ".hunch", "config.json"), "utf8"));
  assert.deepEqual(cfg.hooks, { lean_grounding: "preserve" });
  assert.throws(() => run("quiet_empty", "preserve"), "preserve is lean_grounding only");
  assert.throws(() => run("nosuch", "on"));
  assert.match(execFileSync(process.execPath, ["--import", tsxLoaderUrl(), resolve("src/cli/index.ts"), "switches", "quiet_empty", "off"], { cwd: root, env: { ...env, HUNCH_QUIET_EMPTY: "1" }, encoding: "utf8" }), /HUNCH_QUIET_EMPTY is set in this environment and overrides/);
});

// Critic repro (1.54 review): an automatic full→lean rewrite on one branch hard-conflicts
// with a counts bump on another, and older Hunch rewrites lean back to full. So the
// default writes lean only for a new block and keeps an existing block's variant.
test("hook switches: the lean_grounding default writes lean for a new block and never migrates an existing one", (t) => {
  const { store, root, cleanup } = tempStore();
  t.after(cleanup);
  withEnv({}, () => updateClaudeMd(root, store));
  assert.equal(groundingVariant(readFileSync(join(root, "CLAUDE.md"), "utf8")), "lean", "a new block is lean by default");
  withEnv({ HUNCH_LEAN_GROUNDING: "0" }, () => updateClaudeMd(root, store));
  const full = readFileSync(join(root, "CLAUDE.md"), "utf8");
  assert.equal(groundingVariant(full), "full");
  withEnv({}, () => updateClaudeMd(root, store));
  assert.equal(readFileSync(join(root, "CLAUDE.md"), "utf8"), full, "default: an existing full block stays full, byte-stable");
  writeHooks(root, { lean_grounding: true });
  withEnv({}, () => updateClaudeMd(root, store));
  assert.equal(groundingVariant(readFileSync(join(root, "CLAUDE.md"), "utf8")), "lean", "an explicit on migrates it");
  withEnv({}, () => assert.equal(leanGroundingEnabled(root), true));
});

test("hunch switches: flags a mistyped value that was ignored, and shows the lean default as auto", (t) => {
  const { root, cleanup } = tempStore();
  t.after(cleanup);
  writeFileSync(join(root, ".hunch", "config.json"), JSON.stringify({ hooks: { daemon: "no" } }));
  const env: NodeJS.ProcessEnv = { ...process.env };
  for (const n of NAMES) delete env[n];
  env.HUNCH_QUIET_EMPTY = "nope";
  const out = execFileSync(process.execPath, ["--import", tsxLoaderUrl(), resolve("src/cli/index.ts"), "switches"], { cwd: root, env, encoding: "utf8" });
  assert.match(out, /lean_grounding\s+auto\s+\(default; lean for new blocks/);
  assert.match(out, /ignored unrecognized value HUNCH_QUIET_EMPTY="nope"/);
  assert.match(out, /ignored unrecognized value \.hunch\/config\.json hooks\.daemon="no"/);
});

// Critic findings (1.54 re-review): `hunch switches` must patch only `hooks` (no
// normalization of other keys), a malformed block keeps its variant under the default,
// and a config that yields no switches says why instead of silently showing defaults.
test("hunch switches: setting a switch leaves every other key byte-for-byte and drops an empty hooks", (t) => {
  const { root, cleanup } = tempStore();
  t.after(cleanup);
  const file = join(root, ".hunch", "config.json");
  writeFileSync(file, JSON.stringify({ firmness: "Strict", mcp_tools: " all " }));
  const env: NodeJS.ProcessEnv = { ...process.env };
  for (const n of NAMES) delete env[n];
  const run = (...args: string[]) => execFileSync(process.execPath, ["--import", tsxLoaderUrl(), resolve("src/cli/index.ts"), "switches", ...args], { cwd: root, env, encoding: "utf8" });
  run("daemon", "off");
  assert.deepEqual(JSON.parse(readFileSync(file, "utf8")), { firmness: "Strict", mcp_tools: " all ", hooks: { daemon: false } });
  run("daemon", "default");
  assert.deepEqual(JSON.parse(readFileSync(file, "utf8")), { firmness: "Strict", mcp_tools: " all " });
  writeFileSync(file, JSON.stringify({ hooks: [] }));
  assert.throws(() => run("daemon", "off"), "a non-object hooks is refused, not clobbered");
  assert.equal(readFileSync(file, "utf8"), JSON.stringify({ hooks: [] }));
});

test("hook switches: the default keeps the variant of a block with a lost or hand-edited marker", () => {
  const doc = (...lines: string[]) => lines.join(String.fromCharCode(10));
  withEnv({}, () => {
    assert.equal(resolveGroundingVariant(doc("# Doc", "", "body", "<!-- HUNCH:END -->", "")), "full", "lost START marker: still an existing full block");
    assert.equal(resolveGroundingVariant(doc("<!-- hunch:start -->", "body", "<!-- HUNCH:END -->")), "full", "lowercased marker: existing block");
    assert.equal(resolveGroundingVariant(doc("<!-- HUNCH:START x -->", "<!-- hunch:variant lean -->", "body")), "lean", "missing END: stamp decides");
    assert.equal(resolveGroundingVariant(doc("# Doc", "")), "lean", "no block: lean");
    assert.equal(resolveGroundingVariant(undefined), "lean", "no file: lean");
  });
});

test("hook switches: a config that yields no switches says why", (t) => {
  const { root, cleanup } = tempStore();
  t.after(cleanup);
  const file = join(root, ".hunch", "config.json");
  const at = (text: string) => { writeFileSync(file, text); const tm = new Date(Date.now() + ++tick * 2000); utimesSync(file, tm, tm); return hookConfigProblems(root); };
  assert.match(at('{"hooks":{"daemon":false},}').join(), /not valid JSON/);
  assert.match(at('{"hooks":[]}').join(), /"hooks" is not an object/);
  assert.match(at('{"hook":{"daemon":false}}').join(), /did you mean "hooks"/);
  assert.match(at('{"hooks":{"quietEmpty":false}}').join(), /hooks\.quietEmpty is not a switch; did you mean hooks\.quiet_empty/);
  assert.deepEqual(at('{"hooks":{"daemon":false}}'), []);
  const env: NodeJS.ProcessEnv = { ...process.env };
  for (const n of NAMES) delete env[n];
  at('{"hooks":{"Daemon":false}}');
  const out = execFileSync(process.execPath, ["--import", tsxLoaderUrl(), resolve("src/cli/index.ts"), "switches"], { cwd: root, env, encoding: "utf8" });
  assert.match(out, /hooks\.Daemon is not a switch; did you mean hooks\.daemon/);
});
