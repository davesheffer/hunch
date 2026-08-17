/** Publication safety — what a record would EXPOSE if it lands in the committed store.
 *
 *  Context (2026-08-09, 2026-08-11): a capture defaults to the PUBLIC store, and for a
 *  default `hunch init` user `.hunch/*.json` is git-tracked, so an unflagged
 *  `hunch_record_*` publishes on the next push. Two leaks reached the public tree that
 *  way. Nothing inspected what the records SAID.
 *
 *  Two tiers, deliberately unequal:
 *
 *  - STRUCTURAL hits (machine paths, overlay paths, secret material) are
 *    domain-independent — a Windows home directory is a leak in any repository, in any
 *    industry. These are safe to enforce in a package other people install.
 *  - VOCABULARY hits are corpus-tuned and ship EMPTY. A term list built from one
 *    project's strategy prose fires on another project's ordinary engineering writing
 *    ("revenue" is a domain noun in a billing system). A repo opts in through
 *    `.hunch/publication.json`; the package never presumes.
 *
 *  Nothing here throws or blocks. `con_03a0b94b2e` holds the lifecycle hook to
 *  fail-open, and a privacy heuristic is a smoke detector, not a proof — it earns a
 *  visible line, not a veto. */

import { readFileSync } from "node:fs";
import { join } from "node:path";

export type SensitivityKind =
  | "machine-path"
  | "private-overlay-path"
  | "secret-material"
  | "market-vocabulary";

export interface SensitivityHit {
  kind: SensitivityKind;
  /** Which field carried it — "$" for a whole-record structural match. */
  field: string;
  /** Short, quotable proof. Truncated: a hit is a pointer, not a payload. */
  excerpt: string;
}

/** Structural kinds are the only ones a package may enforce for a stranger's repo. */
const STRUCTURAL: ReadonlySet<SensitivityKind> = new Set<SensitivityKind>([
  "machine-path",
  "private-overlay-path",
  "secret-material",
]);

export function isStructural(hit: SensitivityHit): boolean {
  return STRUCTURAL.has(hit.kind);
}

/** Placeholder home directories that documentation and tests use on purpose.
 *  `/Users/me/repo` appears in src/integrations/claudeConfig.ts and its test as an
 *  illustration; flagging those would train everyone to ignore the scanner. */
const PLACEHOLDER_USER = /^(me|you|user|username|<[^>]+>|\$\{[^}]+\}|example|test|foo|bar)$/i;

const MACHINE_PATH = [
  /[A-Za-z]:[\\/]Users[\\/]([^\\/"'\s,)\]]+)/g,
  /(?:^|[\s"'(])\/(?:Users|home)\/([^/"'\s,)\]]+)/g,
];

/** A path INTO the overlay (dir + file), not a bare mention of the feature. The
 *  gitignore entry and the CLAUDE.md description name `.hunch-private` legitimately;
 *  `.hunch-private/exp03-bank/cases-hunch-draft.json` names private CONTENT. */
const OVERLAY_PATH = /\.hunch-private[\\/][A-Za-z0-9._-]+[\\/][A-Za-z0-9._-]+/g;

/** Live credential shapes only. A bare `VSCE_PAT` / `AUTH_TOKEN` identifier is a
 *  variable name, not a secret, and flagging it produced a false positive on
 *  dec_cd37bf2d9a during tuning. */
const SECRET_MATERIAL =
  /\b(?:gh[pousr]_[A-Za-z0-9]{16,}|sk-[A-Za-z0-9_-]{20,}|xox[baprs]-[A-Za-z0-9-]{10,}|AKIA[0-9A-Z]{16}|eyJ[A-Za-z0-9_-]{10,}\.[A-Za-z0-9_-]{10,}\.[A-Za-z0-9_-]{10,})\b/g;

const clip = (s: string, max = 120): string => {
  const flat = s.replace(/\s+/g, " ").trim();
  return flat.length > max ? flat.slice(0, max) + "…" : flat;
};

/** Fields that hold human prose. Vocabulary is scanned here only — scanning raw JSON
 *  would match ids, file paths and evidence lines and drown the signal. */
const PROSE_KEYS = new Set([
  "title", "context", "decision", "rationale", "statement", "rule", "observation",
  "summary", "description", "symptom", "root_cause", "resolution", "notes",
  "consequences", "alternatives_rejected", "steps", "why",
]);

function proseOf(record: unknown): Array<{ field: string; text: string }> {
  const out: Array<{ field: string; text: string }> = [];
  if (!record || typeof record !== "object") return out;
  for (const [k, v] of Object.entries(record as Record<string, unknown>)) {
    if (!PROSE_KEYS.has(k)) continue;
    if (typeof v === "string") out.push({ field: k, text: v });
    else if (Array.isArray(v)) {
      v.forEach((item, i) => {
        if (typeof item === "string") out.push({ field: `${k}[${i}]`, text: item });
      });
    }
  }
  return out;
}

export interface ScanOptions {
  /** Opt-in, repo-local vocabulary. Empty means vocabulary scanning is off. */
  vocabulary?: readonly RegExp[];
}

function readPatterns(file: string): RegExp[] {
  let parsed: unknown;
  try {
    parsed = JSON.parse(readFileSync(file, "utf8"));
  } catch {
    return [];
  }
  const raw = (parsed as { vocabulary?: unknown })?.vocabulary;
  if (!Array.isArray(raw)) return [];
  const out: RegExp[] = [];
  for (const pattern of raw) {
    if (typeof pattern !== "string") continue;
    try {
      out.push(new RegExp(pattern, "gi"));
    } catch {
      // One bad pattern must not disable the rest of a user's list.
    }
  }
  return out;
}

/** Read a repo's opt-in term list, merged from two layers:
 *      .hunch/publication.json        committed, shareable patterns
 *      .hunch/publication.local.json  gitignored, per-machine patterns
 *
 *  The local layer exists because the list itself can be sensitive. A rule that
 *  catches a competitor teardown has to NAME competitors, and committing that
 *  publishes a watchlist — the exact class of content the scanner is meant to keep
 *  out of a public repo. Patterns that would embarrass you if read belong in the
 *  local layer; generic ones can ship.
 *
 *  Absent file, malformed JSON, or an invalid pattern all degrade to "no vocabulary".
 *  A privacy heuristic that crashes a capture is worse than one that stays quiet, and
 *  the structural tier — the part that works for everyone — never depends on this. */
export function loadVocabulary(hunchDir: string): RegExp[] {
  return [
    ...readPatterns(join(hunchDir, "publication.json")),
    ...readPatterns(join(hunchDir, "publication.local.json")),
  ];
}

/** Every string VALUE in the record, with the field path that carried it.
 *  Deliberately not `JSON.stringify` + one regex pass: the JSON encoding doubles
 *  backslashes, so `C:\Users\x` becomes `C:\\Users\\x` and a path rule written for
 *  real text silently stops matching on Windows — which is exactly how the first
 *  version of this scanner passed its macOS cases and failed its Windows ones. */
function stringValues(node: unknown, path: string, seen: WeakSet<object>, out: Array<{ field: string; text: string }>): void {
  if (typeof node === "string") {
    out.push({ field: path, text: node });
    return;
  }
  if (!node || typeof node !== "object") return;
  if (seen.has(node)) return; // cycles are input we tolerate, never throw on
  seen.add(node);
  if (Array.isArray(node)) {
    node.forEach((v, i) => stringValues(v, `${path}[${i}]`, seen, out));
    return;
  }
  for (const [k, v] of Object.entries(node as Record<string, unknown>)) {
    stringValues(v, path === "$" ? k : `${path}.${k}`, seen, out);
  }
}

/** Pure. No IO, no throw. Returns every sensitivity signal in one record. */
export function scanRecord(record: unknown, opts: ScanOptions = {}): SensitivityHit[] {
  const hits: SensitivityHit[] = [];
  if (!record || typeof record !== "object") return hits;

  const values: Array<{ field: string; text: string }> = [];
  stringValues(record, "$", new WeakSet(), values);

  for (const { field, text } of values) {
    for (const re of MACHINE_PATH) {
      for (const m of text.matchAll(re)) {
        const who = m[1] ?? "";
        if (PLACEHOLDER_USER.test(who)) continue;
        hits.push({ kind: "machine-path", field, excerpt: clip(m[0]) });
      }
    }
    for (const m of text.matchAll(OVERLAY_PATH)) {
      hits.push({ kind: "private-overlay-path", field, excerpt: clip(m[0]) });
    }
    for (const m of text.matchAll(SECRET_MATERIAL)) {
      // Never echo a live credential back into a log or a tool result.
      hits.push({ kind: "secret-material", field, excerpt: `${m[0].slice(0, 6)}… (redacted)` });
    }
  }

  const vocab = opts.vocabulary ?? [];
  if (vocab.length) {
    for (const { field, text } of proseOf(record)) {
      for (const re of vocab) {
        const probe = new RegExp(re.source, re.flags.includes("g") ? re.flags : re.flags + "g");
        for (const m of text.matchAll(probe)) {
          const at = m.index ?? 0;
          hits.push({
            kind: "market-vocabulary",
            field,
            excerpt: clip(text.slice(Math.max(0, at - 40), at + m[0].length + 40)),
          });
        }
      }
    }
  }
  return hits;
}

/** One line naming what was matched and the exact remedy. The predecessor of this
 *  message was a generic "for sensitive content use private:true" nudge, which was
 *  present and ignored during both leaks — a warning that does not quote the offending
 *  text reads as boilerplate. */
export function publicationWarning(hits: readonly SensitivityHit[]): string {
  if (!hits.length) return "";
  const shown = hits.slice(0, 3).map((h) => `${h.kind}${h.field === "$" ? "" : ` in ${h.field}`}: "${h.excerpt}"`);
  const more = hits.length > shown.length ? ` (+${hits.length - shown.length} more)` : "";
  return `\n⚠ PUBLICATION RISK — this record would publish with the repo:\n  ${shown.join("\n  ")}${more}\n  Re-record with private:true to route it to the overlay instead.`;
}
