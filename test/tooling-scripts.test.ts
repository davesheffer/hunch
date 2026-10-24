/**
 * Release/site tooling scripts that no other test exercised. Every script runs from
 * a COPY inside a temp project layout (the scripts resolve their project root from
 * import.meta.url), so the real repo is never written. Scripts that need a built
 * dist/ plus Playwright/Chromium or an older published package only run for real in
 * CI; here their static dist imports are satisfied by throwing stubs and we assert
 * their argument validation.
 *
 * The final gate fails when a tooling/*.mjs is referenced by no test and is not
 * listed in UNTESTED_WITH_REASON.
 */
import assert from "node:assert/strict";
import { execFileSync, spawnSync } from "node:child_process";
import { copyFileSync, existsSync, mkdirSync, readFileSync, readdirSync, symlinkSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { test } from "node:test";
import { cleanupDir, tempDir } from "./fixtures.js";

const PROJECT_ROOT = process.cwd();

/** Scripts deliberately left without a test, with the reason. Keep this empty if possible. */
const UNTESTED_WITH_REASON: Record<string, string> = {};

type Ctx = { after(fn: () => void): void };

/** A temp project with tooling/<script> copied in, plus optional extra files. */
function stage(t: Ctx, script: string, files: Record<string, string> = {}): string {
  const root = tempDir("hunch-tooling-");
  t.after(() => cleanupDir(root));
  mkdirSync(join(root, "tooling"), { recursive: true });
  copyFileSync(join(PROJECT_ROOT, "tooling", script), join(root, "tooling", script));
  for (const [rel, body] of Object.entries(files)) {
    mkdirSync(dirname(join(root, rel)), { recursive: true });
    writeFileSync(join(root, rel), body);
  }
  return root;
}

/** Write throwing stubs for every `import { a, b } from '../dist/x.js'` in the script. */
function stubDist(root: string, script: string): void {
  const source = readFileSync(join(PROJECT_ROOT, "tooling", script), "utf8");
  const re = /import\s*\{([^}]*)\}\s*from\s*['"]\.\.\/(dist\/[^'"]+)['"]/g;
  for (const match of source.matchAll(re)) {
    const names = match[1]!.split(",").map((n) => n.trim().split(/\s+as\s+/)[0]!.trim()).filter(Boolean);
    const target = join(root, match[2]!);
    mkdirSync(dirname(target), { recursive: true });
    writeFileSync(target, names.map((n) => `export const ${n} = () => { throw new Error("stub dist: ${n}"); };\n`).join(""));
  }
}

function run(root: string, script: string, args: string[] = [], env: NodeJS.ProcessEnv = {}) {
  const r = spawnSync(process.execPath, [join(root, "tooling", script), ...args], {
    cwd: root, encoding: "utf8", env: { ...process.env, ...env }, timeout: 120_000,
  });
  return { status: r.status, out: `${r.stdout}${r.stderr}` };
}

/** Point every temp-dir env var at a fresh dir so a script's leaked mkdtemp is observable. */
function isolatedTmp(t: Ctx): { dir: string; env: NodeJS.ProcessEnv } {
  const dir = tempDir("hunch-tooling-tmp-");
  t.after(() => cleanupDir(dir));
  return { dir, env: { TMP: dir, TEMP: dir, TMPDIR: dir } };
}

// ---------------------------------------------------------------- blog-locales.mjs
test("blog-locales.mjs: every locale carries the same UI keys and well-formed, unique posts", async () => {
  const { blogLocales } = await import("../tooling/blog-locales.mjs") as { blogLocales: Record<string, { dir: string; ui: Record<string, string>; posts: Array<{ slug: string; title: string; points: unknown[] }> }> };
  const locales = Object.entries(blogLocales);
  assert.ok(locales.length >= 2, "at least two locales");
  const [, first] = locales[0]!;
  const uiKeys = Object.keys(first.ui).sort();
  for (const [code, locale] of locales) {
    assert.ok(["ltr", "rtl"].includes(locale.dir), `${code} dir`);
    assert.deepEqual(Object.keys(locale.ui).sort(), uiKeys, `${code} UI keys match ${locales[0]![0]}`);
    for (const [key, value] of Object.entries(locale.ui)) assert.ok(typeof value === "string" && value.trim(), `${code}.ui.${key} empty`);
    const slugs = locale.posts.map((p) => p.slug);
    assert.equal(new Set(slugs).size, slugs.length, `${code} duplicate slugs`);
    for (const post of locale.posts) {
      assert.match(post.slug, /^[a-z0-9-]+$/, `${code} slug ${post.slug}`);
      assert.ok(post.title.trim() && Array.isArray(post.points), `${code}/${post.slug} fields`);
    }
  }
});

// ---------------------------------------------------------------- constitution-clean-rehearsal.mjs
test("constitution-clean-rehearsal.mjs refuses --output without a path before packing anything", (t) => {
  // A full run packs + installs the package and drives a fresh repo: CI-scale work.
  // The argument contract is checked here; nothing is written before the refusal.
  const root = stage(t, "constitution-clean-rehearsal.mjs");
  const r = run(root, "constitution-clean-rehearsal.mjs", ["--output"]);
  assert.notEqual(r.status, 0, r.out);
  assert.match(r.out, /--output requires a file path/);
  assert.deepEqual(readdirSync(root).sort(), ["tooling"], "no artifacts created");
});

// ---------------------------------------------------------------- generate-public-proof.mjs
const STATS = {
  schema: "hunch.stats/1", generated_at: "2026-10-01T00:00:00.000Z",
  stock: { decisions: 3 }, return: { delivered: 5 }, compounding: { rate: 0.5 }, overlay_secret: "must-not-leak",
};
const STUB_CLI = `if (process.argv.slice(2).join(" ") !== "stats --json") { process.stderr.write("unexpected args"); process.exit(2); }
process.stdout.write(${JSON.stringify(JSON.stringify(STATS))});\n`;

test("generate-public-proof.mjs derives site/proof-curve.json from stats + dated decisions only", (t) => {
  const root = stage(t, "generate-public-proof.mjs", {
    "dist/cli/index.js": STUB_CLI,
    ".hunch/decisions/dec_b.json": JSON.stringify({ valid_from: "2026-02-01T00:00:00Z" }),
    ".hunch/decisions/dec_a.json": JSON.stringify({ date: "2026-01-01T00:00:00Z" }),
    ".hunch/decisions/dec_c.json": JSON.stringify({ date: "not a date" }),
    ".hunch/decisions/dec_d.json": JSON.stringify({ valid_from: "2026-03-01T00:00:00Z" }),
    ".hunch/decisions/notes.txt": "ignored",
  });
  const r = run(root, "generate-public-proof.mjs");
  assert.equal(r.status, 0, r.out);
  const proof = JSON.parse(readFileSync(join(root, "site/proof-curve.json"), "utf8"));
  assert.deepEqual(proof, {
    schema: "hunch.public-proof/1", source: "hunch.stats/1", generated_at: STATS.generated_at,
    stock_series: [
      { at: "2026-01-01T00:00:00Z", memories: 1 },
      { at: "2026-02-01T00:00:00Z", memories: 2 },
      { at: "2026-03-01T00:00:00Z", memories: 3 },
    ],
    stock: STATS.stock, return: STATS.return, compounding: STATS.compounding,
  });
  assert.ok(!readdirSync(join(root, "site")).some((f) => f.includes(".tmp-")), "atomic temp file renamed away");
});

test("generate-public-proof.mjs fails without writing when the decisions dir is missing", (t) => {
  const root = stage(t, "generate-public-proof.mjs", { "dist/cli/index.js": STUB_CLI });
  const r = run(root, "generate-public-proof.mjs");
  assert.notEqual(r.status, 0, r.out);
  assert.match(r.out, /ENOENT/);
  assert.equal(existsSync(join(root, "site/proof-curve.json")), false);
});

// ---------------------------------------------------------------- generate-sitemap.mjs
test("generate-sitemap.mjs maps clean URLs, expands blog slugs, excludes og.html, dates from git", (t) => {
  const root = stage(t, "generate-sitemap.mjs", {
    "site/index.html": "<!doctype html>",
    "site/docs.html": "<!doctype html>",
    "site/og.html": "<!doctype html>",
    "site/he/blog/index.html": "<!doctype html>",
    "site/blog/post.html": "<!doctype html>",
    "site/blog/posts.js": "window.POSTS = [{ slug: 'a b' }, { slug: 'second' }, { title: 'no slug' }];",
  });
  const git = (...args: string[]) => execFileSync("git", args, {
    cwd: root, stdio: "pipe",
    env: { ...process.env, GIT_COMMITTER_DATE: "2026-05-04T12:00:00Z", GIT_AUTHOR_DATE: "2026-05-04T12:00:00Z" },
  });
  git("init", "-q");
  git("-c", "user.name=F", "-c", "user.email=f@example.invalid", "add", "-A");
  git("-c", "user.name=F", "-c", "user.email=f@example.invalid", "-c", "core.hooksPath=", "commit", "-qm", "site");
  const r = run(root, "generate-sitemap.mjs");
  assert.equal(r.status, 0, r.out);
  assert.match(r.out, /wrote site\/sitemap\.xml with 5 URLs/);
  const xml = readFileSync(join(root, "site/sitemap.xml"), "utf8");
  const locs = [...xml.matchAll(/<loc>([^<]+)<\/loc>/g)].map((m) => m[1]);
  const origin = "https://www.hunchmemory.com";
  assert.deepEqual(locs, [
    `${origin}/`, `${origin}/blog/post?slug=a%20b`, `${origin}/blog/post?slug=second`, `${origin}/docs`, `${origin}/he/blog`,
  ]);
  assert.equal([...xml.matchAll(/<lastmod>2026-05-04<\/lastmod>/g)].length, 5, "committed files use git commit date");
  assert.match(xml, /<loc>https:\/\/www\.hunchmemory\.com\/<\/loc>\n {4}<lastmod>[^<]+<\/lastmod>\n {4}<priority>1\.0<\/priority>/);
  assert.match(xml, /\/docs<\/loc>\n.*\n {4}<priority>0\.8<\/priority>/);
});

test("generate-sitemap.mjs fails when a blog post page exists without posts.js", (t) => {
  const root = stage(t, "generate-sitemap.mjs", { "site/blog/post.html": "<!doctype html>" });
  const r = run(root, "generate-sitemap.mjs");
  assert.notEqual(r.status, 0, r.out);
  assert.equal(existsSync(join(root, "site/sitemap.xml")), false);
});

// ---------------------------------------------------------------- sync-version-pins.mjs
function stagePins(t: Ctx, files: Record<string, string>): string {
  const root = stage(t, "sync-version-pins.mjs", {
    "package.json": JSON.stringify({ name: "@davesheffer/hunch", version: "9.9.9" }),
    ...files,
  });
  // The script loads src/ through tsx from its project root; link the real (read-only) trees.
  for (const dir of ["src", "node_modules"]) symlinkSync(join(PROJECT_ROOT, dir), join(root, dir), "junction");
  return root;
}
const OFFLINE = { npm_config_offline: "true" };

test("sync-version-pins.mjs rewrites plugin/.mcp.json and server.json pins to package.json's version", (t) => {
  const root = stagePins(t, {
    "plugin/.mcp.json": JSON.stringify({ mcpServers: { hunch: { command: "npx", args: ["-y", "@davesheffer/hunch@1.2.3", "mcp"] } } }, null, 2),
    "server.json": JSON.stringify({ name: "hunch", version: "1.2.3", packages: [{ identifier: "@davesheffer/hunch", version: "1.2.3" }] }, null, 2),
  });
  const r = run(root, "sync-version-pins.mjs", [], OFFLINE);
  assert.equal(r.status, 0, r.out);
  assert.match(r.out, /sync-version-pins: plugin\/\.mcp\.json, server\.json -> 9\.9\.9/);
  assert.match(readFileSync(join(root, "plugin/.mcp.json"), "utf8"), /@davesheffer\/hunch@9\.9\.9/);
  const server = JSON.parse(readFileSync(join(root, "server.json"), "utf8"));
  assert.equal(server.version, "9.9.9");
  assert.equal(server.packages[0].version, "9.9.9");
  const again = run(root, "sync-version-pins.mjs", [], OFFLINE);
  assert.equal(again.status, 0, again.out);
  assert.match(again.out, /pins already at 9\.9\.9/);
});

test("sync-version-pins.mjs exits non-zero when a manifest carries no version to rewrite", (t) => {
  const root = stagePins(t, {
    "plugin/.mcp.json": JSON.stringify({ args: ["@davesheffer/hunch@1.2.3"] }),
    "server.json": JSON.stringify({ name: "hunch" }),
  });
  const r = run(root, "sync-version-pins.mjs", [], OFFLINE);
  assert.equal(r.status, 1, r.out);
  assert.match(r.out, /server\.json does not carry 9\.9\.9 after rewrite/);
});

// ---------------------------------------------------------------- browser / upgrade qualifiers (CI-only)
for (const script of ["verify-operator-view.mjs", "verify-state-proof-browser.mjs"]) {
  test(`${script} fails fast on a missing Playwright module and leaves no temp dir`, (t) => {
    // Real run needs a fresh `npm run build` plus Playwright + Chromium (CI qualification only).
    const root = stage(t, script);
    stubDist(root, script);
    const tmp = isolatedTmp(t);
    const r = run(root, script, [join(root, "no-such-playwright.mjs")], tmp.env);
    assert.notEqual(r.status, 0, r.out);
    assert.match(r.out, /ERR_MODULE_NOT_FOUND|Cannot find module/);
    assert.match(r.out, /no-such-playwright/);
    assert.deepEqual(readdirSync(tmp.dir), [], "no fixture dir created before the browser loads");
  });
}

test("verify-state-upgrade.mjs refuses to run without an older package path", (t) => {
  // Real run needs an older published @davesheffer/hunch install and a built dist/ (release CI).
  const root = stage(t, "verify-state-upgrade.mjs");
  stubDist(root, "verify-state-upgrade.mjs");
  const tmp = isolatedTmp(t);
  const r = run(root, "verify-state-upgrade.mjs", [], tmp.env);
  assert.notEqual(r.status, 0, r.out);
  assert.match(r.out, /pass an existing older package installation/);
});

test("verify-state-upgrade.mjs leaves no temp dir behind when it refuses", (t) => {
  const root = stage(t, "verify-state-upgrade.mjs");
  stubDist(root, "verify-state-upgrade.mjs");
  const tmp = isolatedTmp(t);
  run(root, "verify-state-upgrade.mjs", [], tmp.env);
  assert.deepEqual(readdirSync(tmp.dir), []);
});

// ---------------------------------------------------------------- coverage gate
test("gate: every tooling/*.mjs is referenced by a test or listed with a reason", () => {
  const scripts = readdirSync(join(PROJECT_ROOT, "tooling")).filter((f) => f.endsWith(".mjs")).sort();
  const corpus = readdirSync(join(PROJECT_ROOT, "test"))
    .filter((f) => /\.(ts|mjs|js)$/.test(f))
    .map((f) => readFileSync(join(PROJECT_ROOT, "test", f), "utf8"))
    .join("\n");
  const unreferenced = scripts.filter((script) => {
    const stem = script.slice(0, -".mjs".length);
    return !corpus.includes(script) && !corpus.includes(`${stem}\\.mjs`) && !(script in UNTESTED_WITH_REASON);
  });
  assert.deepEqual(unreferenced, [], "add a test for each new tooling script (or list it in UNTESTED_WITH_REASON with why)");
  for (const [script, reason] of Object.entries(UNTESTED_WITH_REASON)) {
    assert.ok(scripts.includes(script), `stale exemption ${script}`);
    assert.ok(reason.trim().length > 10, `exemption for ${script} needs a reason`);
  }
});
