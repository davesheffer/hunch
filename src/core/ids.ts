/** Stable id helpers. Symbol/component/edge ids are DETERMINISTIC (derived from
 *  their natural key) so re-indexing the same repo yields the same ids and the
 *  git diff of `.brain/` stays minimal. Decisions/bugs use a content hash too,
 *  so the learning loop is idempotent for the same commit. */
import { createHash } from "node:crypto";

function shortHash(input: string, len = 10): string {
  return createHash("sha1").update(input).digest("hex").slice(0, len);
}

/** Full sha1 (used for signature_hash etc.). */
export function sha1(input: string): string {
  return "sha1:" + createHash("sha1").update(input).digest("hex");
}

/** Symbol id from file + name + kind — deterministic across re-indexes. */
export function symbolId(file: string, name: string, kind: string): string {
  return "sym_" + shortHash(`${file}::${name}::${kind}`);
}

/** Component id from a stable name. */
export function componentId(name: string): string {
  return "cmp_" + shortHash(name.toLowerCase());
}

/** Edge id from its endpoints + type — deterministic, dedupes naturally. */
export function edgeId(from: string, to: string, type: string): string {
  return "edge_" + shortHash(`${from}->${to}:${type}`);
}

/** Decision id. Seed with the CANONICAL full commit sha (the auto-sync and MCP
 *  commit paths both do this, so a recorded decision upgrades the auto-draft for
 *  the same commit), or with "manual:<title>" for an ad-hoc MCP decision. */
export function decisionId(seed: string): string {
  return "dec_" + shortHash(seed);
}

/** Bug id seeded by symptom/test so the same failure doesn't spawn duplicates. */
export function bugId(seed: string): string {
  return "bug_" + shortHash(seed);
}

/** Constraint id seeded by its statement. */
export function constraintId(statement: string): string {
  return "con_" + shortHash(statement.toLowerCase());
}
