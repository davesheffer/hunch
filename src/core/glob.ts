/** Minimal, segment-aware glob matching for constraint `scope` / component
 *  `paths` (e.g. "src/auth/**"). Supports **, *, and ? with correct path-segment
 *  semantics (`**` spans separators; `*`/`?` stay within one segment). No dep. */

/** Normalize a path/glob: backslashes -> '/', strip a leading './'. */
function norm(p: string): string {
  return p.replace(/\\/g, "/").replace(/^\.\//, "");
}

/** Translate one path segment (no '/') to a regex fragment. */
function segToRe(seg: string): string {
  return seg
    .replace(/[.+^${}()|[\]]/g, "\\$&")
    .replace(/\*/g, "[^/]*")
    .replace(/\?/g, "[^/]");
}

function globToRegExp(glob: string): RegExp {
  // Collapse runs of consecutive "**" segments so "**/**", "a/**/**/b" etc.
  // behave like a single globstar (avoids a spurious leading slash / no-match).
  const segs = glob.split("/").filter((s, i, a) => !(s === "**" && a[i - 1] === "**"));
  if (segs.length === 1 && segs[0] === "**") return /^.*$/;

  let re = "";
  for (let i = 0; i < segs.length; i++) {
    const seg = segs[i]!;
    const isFirst = i === 0;
    const isLast = i === segs.length - 1;
    if (seg === "**") {
      if (isLast) {
        // trailing "/**": the directory itself OR anything beneath it
        re += "(?:/.*)?";
      }
      // a leading/middle "**" contributes nothing here; the next concrete
      // segment emits the "zero or more directories" group (see below).
    } else {
      const prevGlobstar = i > 0 && segs[i - 1] === "**";
      if (prevGlobstar) {
        // "**/" before this segment → optional run of directories
        re += isFirst /* unreachable */ ? "" : i - 1 === 0 ? "(?:.*/)?" : "/(?:.*/)?";
      } else if (!isFirst) {
        re += "/";
      }
      re += segToRe(seg);
    }
  }
  return new RegExp("^" + re + "$");
}

/** Does a concrete path match a glob? Also returns true when the glob is a bare
 *  directory prefix of the path (so "src/auth" matches "src/auth/x.ts"). */
export function pathMatchesGlob(path: string, glob: string): boolean {
  const p = norm(path);
  const g = norm(glob);
  if (g === p) return true;
  if (globToRegExp(g).test(p)) return true;
  // bare-prefix convenience: "src/auth" ~ "src/auth/**"
  if (!/[*?]/.test(g) && p.startsWith(g.endsWith("/") ? g : g + "/")) return true;
  return false;
}

/** Do two concrete repo paths identify the same path at different prefix depth?
 * Segment-anchored: `x/scenario.ts` relates to `scenario.ts`, never `io.ts`. */
export function pathsRelated(left: string, right: string): boolean {
  const a = norm(left);
  const b = norm(right);
  return a === b || a.endsWith(`/${b}`) || b.endsWith(`/${a}`);
}

/** True when `target` is a path Hunch's index already knows about: an indexed
 *  symbol's exact file, or a path an indexed component's `paths` glob(s) cover.
 *  The latter catches a symbol-less-but-indexed file (README.md, package.json,
 *  Dockerfile, ...) that has zero tree-sitter symbols but is still a real,
 *  known file. Derived entirely from already-loaded graph data — never the
 *  filesystem — so the answer doesn't depend on untracked working-tree state
 *  (a deleted-but-still-indexed path stays "real"; issue #299). It is therefore
 *  only HALF the "is this a real path" question: a real file with no symbols and
 *  no covering component is invisible here, so callers OR in `isRepoFile` as a
 *  last resort (issue #334) — `HunchStore.isKnownPath` is that composition. */
export function isIndexedPath(
  target: string,
  symbolFiles: Iterable<string>,
  componentPaths: Iterable<readonly string[]>,
): boolean {
  for (const f of symbolFiles) if (f === target) return true;
  for (const globs of componentPaths) for (const g of globs) if (pathMatchesGlob(target, g)) return true;
  return false;
}

/** Resolve symbols matching `target`, tiered: exact id > exact name > exact file >
 *  (only when `target` is NOT a path already known to be real) segment-anchored
 *  suffix. A real file with zero symbols must return [] rather than fall through
 *  to the suffix tier, which would leak an unrelated same-basename file's records
 *  (issues #299/#334). Callers decide what counts as "real": one that ATTRIBUTES
 *  records silently (why(), the pre-edit hook) passes `HunchStore.isKnownPath`, the
 *  wider graph-or-working-tree answer that also covers a file about to be created;
 *  one that NAMES the file it resolved to (resolveNodeIds, structure()) passes the
 *  narrower `isRepoFile`, since glob coverage alone is not existence. */
export function matchSymbolsTiered<S extends { id: string; file: string; name: string }>(
  target: string,
  symbols: readonly S[],
  indexed: boolean,
): S[] {
  const byId = symbols.find((s) => s.id === target);
  if (byId) return [byId];
  const byName = symbols.filter((s) => s.name === target);
  if (byName.length) return byName;
  const exact = symbols.filter((s) => s.file === target);
  if (exact.length) return exact;
  if (indexed) return [];
  return symbols.filter((s) => pathsRelated(s.file, target));
}
