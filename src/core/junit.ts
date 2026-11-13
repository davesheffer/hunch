/**
 * Dependency-free JUnit XML reader for spec-sync (design §4.2, SS-4.6 – SS-4.9). Reads
 * `<testcase>` elements (`name`, `classname`) and whether each has a `<failure>`,
 * `<error>` or `<skipped>` child — enough for the variants pytest `--junitxml`,
 * jest-junit, vitest and mocha-junit-reporter emit. Never runs a test.
 */
import { readFileSync, statSync } from "node:fs";
import type { JunitCase } from "./specsync.js";

/** Reports larger than this are skipped with a `junit-skipped` finding (SS-7.4). */
export const JUNIT_MAX_BYTES = 20 * 1024 * 1024;

const ENTITIES: Record<string, string> = { amp: "&", lt: "<", gt: ">", quot: '"', apos: "'" };

function decode(s: string): string {
  return s.replace(/&(#x[0-9a-f]+|#\d+|[a-z]+);/gi, (whole, e: string) => {
    if (e[0] === "#") {
      const code = e[1] === "x" || e[1] === "X" ? parseInt(e.slice(2), 16) : parseInt(e.slice(1), 10);
      return Number.isFinite(code) ? String.fromCodePoint(code) : whole;
    }
    return ENTITIES[e.toLowerCase()] ?? whole;
  });
}

function attrs(tag: string): Record<string, string> {
  const out: Record<string, string> = {};
  for (const m of tag.matchAll(/([\w:.-]+)\s*=\s*("([^"]*)"|'([^']*)')/g)) out[m[1]!] = decode(m[3] ?? m[4] ?? "");
  return out;
}

const SECTIONS: readonly [string, string][] = [["<!--", "-->"], ["<![CDATA[", "]]>"], ["<?", "?>"]];

/** Drop comments, CDATA and processing instructions in one linear pass. An unterminated
 *  section ends the document there (bail out), never a rescan per opener. */
function stripSections(xml: string): string {
  let out = "";
  let i = 0;
  for (;;) {
    const lt = xml.indexOf("<", i);
    if (lt === -1) return out + xml.slice(i);
    const sec = SECTIONS.find(([open]) => xml.startsWith(open, lt));
    if (!sec) { out += xml.slice(i, lt + 1); i = lt + 1; continue; }
    out += xml.slice(i, lt);
    const end = xml.indexOf(sec[1], lt + sec[0].length);
    if (end === -1) return out;
    i = end + sec[1].length;
  }
}

/** Parse JUnit XML text into testcases. Comments, CDATA and processing instructions are
 *  dropped first so their content (stack traces, captured output) can never look like markup. */
export function parseJunit(xml: string): JunitCase[] {
  const clean = stripSections(xml);
  const cases: JunitCase[] = [];
  const re = /<testcase\b([^>]*?)(\/)?>/g;
  let m: RegExpExecArray | null;
  // Once no `</testcase>` remains, stop searching for one (linear on truncated reports).
  let closesLeft = true;
  while ((m = re.exec(clean))) {
    const a = attrs(m[1]!);
    let body = "";
    if (!m[2]) {
      const end = closesLeft ? clean.indexOf("</testcase>", re.lastIndex) : -1;
      if (end === -1) {
        closesLeft = false;
        const next = clean.indexOf("<testcase", re.lastIndex);
        body = clean.slice(re.lastIndex, next === -1 ? undefined : next);
      } else {
        body = clean.slice(re.lastIndex, end);
        re.lastIndex = end + "</testcase>".length;
      }
    }

    const status = /<(?:failure|error)\b/.test(body) ? "failed" : /<skipped\b/.test(body) ? "skipped" : "passed";
    cases.push({ name: a.name ?? "", classname: a.classname ?? "", status });
  }
  return cases;
}

export type JunitRead =
  | { ok: true; cases: JunitCase[]; mtimeMs: number }
  | { ok: false; reason: "missing" | "too-large" | "unreadable"; detail: string };

/** Read one report from disk, refusing anything over the size cap. */
export function readJunitFile(file: string, maxBytes = JUNIT_MAX_BYTES): JunitRead {
  let size: number;
  let mtimeMs: number;
  try {
    const st = statSync(file);
    size = st.size;
    mtimeMs = st.mtimeMs;
  } catch {
    return { ok: false, reason: "missing", detail: "not found" };
  }
  if (size > maxBytes) return { ok: false, reason: "too-large", detail: `${(size / 1024 / 1024).toFixed(1)} MB exceeds the ${Math.round(maxBytes / 1024 / 1024)} MB cap` };
  try {
    const text = readFileSync(file, "utf8");
    if (!/<testsuites?\b|<testcase\b/.test(text)) return { ok: false, reason: "unreadable", detail: "no <testsuite> or <testcase> element" };
    return { ok: true, cases: parseJunit(text), mtimeMs };
  } catch (e) {
    return { ok: false, reason: "unreadable", detail: (e as Error).message };
  }
}

/** A report is fresh for a spec only when it is newer than every file that spec's
 *  tests AND code globs match (SS-4.7): a report older than a code fix is stale. */
export function junitIsFresh(reportMtimeMs: number, newestInputMtimeMs: number): boolean {
  return reportMtimeMs > newestInputMtimeMs;
}
