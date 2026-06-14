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
