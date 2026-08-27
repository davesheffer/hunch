import assert from "node:assert/strict";
import { readFileSync, readdirSync, statSync } from "node:fs";
import { dirname, join, relative, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import test from "node:test";

const PROJECT_ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const SITE_ROOT = join(PROJECT_ROOT, "site");
const LOCAL_ORIGIN = "https://hunch.local";

function filesBelow(root: string): string[] {
  const files: string[] = [];
  for (const entry of readdirSync(root, { withFileTypes: true })) {
    const path = join(root, entry.name);
    if (entry.isDirectory()) files.push(...filesBelow(path));
    else if (entry.isFile()) files.push(path);
  }
  return files;
}

function localTargetExists(pathname: string): boolean {
  const route = decodeURIComponent(pathname).replace(/^\/+/, "").replace(/\/+$/, "");
  const candidates = route
    ? [join(SITE_ROOT, route), join(SITE_ROOT, `${route}.html`), join(SITE_ROOT, route, "index.html")]
    : [join(SITE_ROOT, "index.html")];
  return candidates.some((candidate) => {
    try { return statSync(candidate).isFile(); } catch { return false; }
  });
}

test("every static-site local route and asset reference resolves", () => {
  const pages = filesBelow(SITE_ROOT).filter((file) => file.endsWith(".html"));
  const missing: string[] = [];
  let localReferences = 0;
  for (const page of pages) {
    const source = readFileSync(page, "utf8")
      .replace(/(<script\b[^>]*>)[\s\S]*?(<\/script>)/gi, "$1$2")
      .replace(/(<style\b[^>]*>)[\s\S]*?(<\/style>)/gi, "$1$2");
    const pagePath = `/${relative(SITE_ROOT, page).replaceAll("\\", "/")}`;
    const base = new URL(pagePath, LOCAL_ORIGIN);
    for (const match of source.matchAll(/\b(?:href|src)\s*=\s*(["'])(.*?)\1/gi)) {
      let target: URL;
      try { target = new URL(match[2]!, base); } catch { continue; }
      if (target.origin !== LOCAL_ORIGIN || target.pathname.startsWith("/_vercel/")) continue;
      localReferences += 1;
      if (!localTargetExists(target.pathname)) {
        missing.push(`${relative(PROJECT_ROOT, page)} -> ${match[2]}`);
      }
    }
  }
  assert.equal(pages.length, 30, "new or missing generated pages should be reviewed explicitly");
  assert.ok(localReferences >= 428, "the validator must keep exercising the complete current site surface");
  assert.deepEqual(missing, []);
});

test("blog download resources are public, root-absolute, and present", () => {
  const source = readFileSync(join(SITE_ROOT, "blog", "posts.js"), "utf8");
  const downloads = [...source.matchAll(/\bdownload:\s*\{[\s\S]*?\bhref:\s*"([^"]+)"/g)]
    .map((match) => match[1]!);

  assert.ok(downloads.length >= 1, "the blog should expose at least one downloadable evidence resource");
  for (const href of downloads) {
    assert.ok(href.startsWith("/"), `download link must be root-absolute: ${href}`);
    assert.ok(localTargetExists(new URL(href, LOCAL_ORIGIN).pathname), `download target is missing: ${href}`);
  }
});
