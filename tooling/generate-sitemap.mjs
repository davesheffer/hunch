import { execFileSync } from "node:child_process";
import { readFileSync, statSync } from "node:fs";
import { readdir, stat, writeFile } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";
import vm from "node:vm";

// Emits site/sitemap.xml from the static pages under site/.
// Routes follow vercel.json (cleanUrls: true, trailingSlash: false):
//   site/index.html            -> /
//   site/docs.html             -> /docs
//   site/he/blog/index.html    -> /he/blog
// Run: node tooling/generate-sitemap.mjs

const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const siteDir = path.join(repoRoot, "site");
const siteOrigin = "https://www.hunchmemory.com";
const excludedFiles = new Set(["og.html"]);

async function walk(dir) {
  const out = [];
  for (const entry of await readdir(dir, { withFileTypes: true })) {
    const full = path.join(dir, entry.name);
    if (entry.isDirectory()) out.push(...(await walk(full)));
    else if (entry.isFile() && entry.name.endsWith(".html")) out.push(full);
  }
  return out;
}

function routeFor(file) {
  const rel = path.relative(siteDir, file).split(path.sep).join("/");
  if (excludedFiles.has(rel)) return null;
  if (rel === "index.html") return "/";
  if (rel.endsWith("/index.html")) return `/${rel.slice(0, -"/index.html".length)}`;
  return `/${rel.slice(0, -".html".length)}`;
}

function lastModified(file) {
  try {
    const dirty = execFileSync("git", ["status", "--porcelain=v1", "--", file], { cwd: repoRoot, encoding: "utf8" }).trim();
    if (dirty) return statSync(file).mtime.toISOString().slice(0, 10);
    const iso = execFileSync("git", ["log", "-1", "--format=%cI", "--", file], { cwd: repoRoot, encoding: "utf8" }).trim();
    if (iso) return iso.slice(0, 10);
  } catch {
    // fall through to filesystem mtime
  }
  return null;
}

// Blog posts are client-rendered from /blog/posts.js and addressed by ?slug=.
// A bare /blog/post renders "Not found", so it is dropped in favour of one URL per post per locale.
function blogSlugs() {
  const postsFile = path.join(siteDir, "blog", "posts.js");
  const sandbox = { window: {} };
  vm.runInNewContext(readFileSync(postsFile, "utf8"), sandbox);
  return (sandbox.window.POSTS || []).map((post) => post.slug).filter(Boolean);
}

const files = await walk(siteDir);
const routes = new Map();
const postsFile = path.join(siteDir, "blog", "posts.js");
for (const file of files) {
  const route = routeFor(file);
  if (!route) continue;
  if (route.endsWith("/blog/post")) {
    const blogBase = route.slice(0, -"/post".length);
    for (const slug of blogSlugs()) routes.set(`${blogBase}/post?slug=${encodeURIComponent(slug)}`, postsFile);
    continue;
  }
  const existing = routes.get(route);
  // Prefer the directory form (foo/index.html) when both foo.html and foo/index.html exist.
  if (existing && !file.endsWith(`${path.sep}index.html`)) continue;
  routes.set(route, file);
}

const entries = [];
for (const [route, file] of [...routes.entries()].sort(([a], [b]) => a.localeCompare(b))) {
  const lastmod = lastModified(file) ?? (await stat(file)).mtime.toISOString().slice(0, 10);
  const depth = route === "/" ? 0 : route.split("?")[0].split("/").length - 1;
  const priority = route === "/" ? "1.0" : depth === 1 ? "0.8" : "0.6";
  entries.push(`  <url>\n    <loc>${siteOrigin}${route}</loc>\n    <lastmod>${lastmod}</lastmod>\n    <priority>${priority}</priority>\n  </url>`);
}

const xml = `<?xml version="1.0" encoding="UTF-8"?>\n<urlset xmlns="http://www.sitemaps.org/schemas/sitemap/0.9">\n${entries.join("\n")}\n</urlset>\n`;
await writeFile(path.join(siteDir, "sitemap.xml"), xml, "utf8");
console.log(`wrote site/sitemap.xml with ${entries.length} URLs`);
