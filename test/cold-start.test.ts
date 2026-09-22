/**
 * Cold start: importing the parsing module graph must not load the native
 * tree-sitter addons. Loading them copies six `.node` files into a per-process
 * temp dir and dlopens them, which cost every CLI process and every editor hook
 * 1.5-5 s of startup even when nothing ever parsed (fnd_4b091dd16c).
 *
 * The assertions are deliberately OS-neutral and never time anything: they check
 * that no tree-sitter addon is in the require cache and that no per-process temp
 * copy dir was created, which holds identically on Windows (where the temp-copy
 * file-lock isolation matters most) as on POSIX.
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import { execFileSync, spawnSync } from "node:child_process";
import { mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { pathToFileURL } from "node:url";
import { cleanupDir } from "./helpers.js";

const COPY_PREFIX = "hunch-tree-sitter-";
const ADDON = /tree-sitter.*\.node$/;

function moduleUrl(relative: string): string {
  return JSON.stringify(pathToFileURL(join(process.cwd(), relative)).href);
}

/** Run `script` in a fresh child (tsx loader) and return its stdout report. */
function inChild(script: string): { status: number | null; stdout: string; stderr: string } {
  const child = spawnSync(process.execPath, ["--import", "tsx", "--input-type=module", "--eval", script], {
    cwd: process.cwd(),
    encoding: "utf8",
    stdio: ["ignore", "pipe", "pipe"],
  });
  return { status: child.status, stdout: child.stdout, stderr: child.stderr };
}

test("importing the parse/indexer/constitution modules loads no native tree-sitter addon", () => {
  const script = `
    import { createRequire } from "node:module";
    import { readdirSync } from "node:fs";
    import { tmpdir } from "node:os";
    await import(${moduleUrl("src/extractors/parse.ts")});
    await import(${moduleUrl("src/extractors/indexer.ts")});
    await import(${moduleUrl("src/constitution/g2BehaviorCandidates.ts")});
    const require = createRequire(import.meta.url);
    const loaded = Object.keys(require.cache).filter((p) => ${ADDON}.test(p));
    let copies = [];
    try {
      copies = readdirSync(tmpdir()).filter((n) => n.startsWith(${JSON.stringify(COPY_PREFIX)} + process.pid + "-"));
    } catch { /* unreadable tmpdir: the require-cache assertion still holds */ }
    console.log(JSON.stringify({ loaded, copies }));
  `;
  const child = inChild(script);
  assert.equal(child.status, 0, child.stderr || child.stdout);
  const report = JSON.parse(child.stdout.trim().split("\n").at(-1)!) as { loaded: string[]; copies: string[] };
  assert.deepEqual(report.loaded, [], `native addon loaded merely by importing: ${report.loaded.join(", ")}`);
  assert.deepEqual(report.copies, [], `per-process temp copy dir created without parsing: ${report.copies.join(", ")}`);
});

test("a real parse still works and loads the addons on first use", () => {
  const script = `
    import { createRequire } from "node:module";
    const { parseSource } = await import(${moduleUrl("src/extractors/parse.ts")});
    const parsed = parseSource("fixture.ts", "export function answer(): number { return 42; }");
    const require = createRequire(import.meta.url);
    const loaded = Object.keys(require.cache).filter((p) => /tree-sitter.*\\.node$/.test(p));
    console.log(JSON.stringify({
      parseable: parsed.parseable,
      symbols: parsed.symbols.map((s) => s.name),
      addonCount: loaded.length,
    }));
  `;
  const child = inChild(script);
  assert.equal(child.status, 0, child.stderr || child.stdout);
  const report = JSON.parse(child.stdout.trim().split("\n").at(-1)!) as {
    parseable: boolean; symbols: string[]; addonCount: number;
  };
  assert.equal(report.parseable, true);
  assert.deepEqual(report.symbols, ["answer"]);
  assert.ok(report.addonCount > 0, "first parse must actually load the native addons");
});

// The three explicit imports above cover the modules the lazy-load change
// touched. The two below cover the CLI's WHOLE static import graph — the thing
// a user actually pays for — by running the real entry point, whether or not
// this file knows which module to import.
//
// Watching a private TMPDIR for a leftover copy dir does NOT work: the loader
// registers `process.once("exit", … rmSync(copyRoot))`, so an eager load
// deletes its own evidence before the parent can look — a top-level
// loadNativeTreeSitter() added to parse.ts left that check passing. So OBSERVE
// THE LOAD ITSELF, with a CJS preload that runs before any application module
// and wraps fs.copyFileSync: copying a `.node` file into the per-process dir is
// the loader's first irreversible act, it happens on EVERY load (there is no
// other route to the addons), and it is recorded the moment it happens rather
// than being read back afterwards, so exit-time cleanup cannot erase it.
//
// Two details the probe depends on, both learned the hard way:
//   · the preload must be passed in NODE_OPTIONS, not as a bare --require:
//     `tsx` re-executes the application in a CHILD PROCESS, and only
//     NODE_OPTIONS is inherited by it. A --require flag arms the launcher only,
//     which never parses — exactly the false pass this gate is replacing.
//   · every process appends to ONE file. require.cache / Module._cache are
//     per-process and the launcher's are empty, so the union across processes
//     is the only honest answer to "did this command load an addon".
const PROBE = `
  const fs = require("fs");
  const out = process.env.HUNCH_ADDON_PROBE_OUT;
  const original = fs.copyFileSync;
  fs.copyFileSync = function (source, destination, ...rest) {
    if (String(destination).endsWith(".node")) {
      try { fs.appendFileSync(out, String(source) + "\\n"); } catch { /* the assertion below reads what did land */ }
    }
    return original.call(this, source, destination, ...rest);
  };
`;

/** Run the real CLI entry with the addon probe attached to every process it
 *  spawns, and return every native addon any of them loaded. */
function probeCli(args: string[], cwd: string = process.cwd()): { status: number | null; out: string; loaded: string[] } {
  const scratch = mkdtempSync(join(tmpdir(), "hunch-addon-probe-"));
  try {
    const preload = join(scratch, "addon-probe.cjs");
    const report = join(scratch, "loaded.txt");
    writeFileSync(preload, PROBE);
    writeFileSync(report, "");
    const child = spawnSync(process.execPath, [join(process.cwd(), "node_modules/tsx/dist/cli.mjs"), join(process.cwd(), "src/cli/index.ts"), ...args], {
      cwd,
      encoding: "utf8",
      env: { ...process.env, HUNCH_PRIVATE_DIR: "", HUNCH_ADDON_PROBE_OUT: report, NODE_OPTIONS: `--require ${JSON.stringify(preload)}` },
      stdio: ["ignore", "pipe", "pipe"],
    });
    const loaded = readFileSync(report, "utf8").split("\n").filter((line) => line.trim().length > 0);
    return { status: child.status, out: `${child.stdout}${child.stderr}`, loaded };
  } finally {
    cleanupDir(scratch);
  }
}

test("the real CLI entry loads no native addon for a command that parses nothing", () => {
  const probe = probeCli(["--version"]);
  assert.equal(probe.status, 0, probe.out);
  assert.deepEqual(probe.loaded, [], `\`hunch --version\` loaded the native addons: ${probe.loaded.join(", ")}`);
});

// The positive control. Without it the gate above proves nothing: a probe that
// can never see an addon would pass whatever the CLI does. `hunch index` in a
// one-file repo parses for real, so this asserts the probe DOES observe a load
// — through the same createRequire + *_PREBUILD temp-copy path production uses.
test("the addon probe observes the addons when a command really parses", () => {
  const repo = mkdtempSync(join(tmpdir(), "hunch-cold-start-repo-"));
  try {
    writeFileSync(join(repo, "alpha.ts"), "export function alpha(): number { return 1; }\n");
    const git = (...args: string[]): void => { execFileSync("git", args, { cwd: repo, stdio: "ignore" }); };
    git("init", "-q", ".");
    git("config", "user.email", "t@example.com");
    git("config", "user.name", "Fixture");
    git("add", "alpha.ts");
    git("commit", "-qm", "init");
    const probe = probeCli(["index", "--no-auto-commit"], repo);
    assert.equal(probe.status, 0, probe.out);
    assert.ok(probe.loaded.length > 0, `the probe saw no addon for a command that parsed — it cannot prove anything:\n${probe.out}`);
  } finally {
    cleanupDir(repo);
  }
});
