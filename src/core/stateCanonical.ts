/** Shared canonical form for state identity, revisions and citation validation. */
import { createHash } from "node:crypto";
import { compareCodeUnits } from "./canonicalOrder.js";

/** Keep this encoding stable: existing record identities and dependency hashes use it. */
export function canonicalize(value: unknown): unknown {
  if (value === null || typeof value === "string" || typeof value === "boolean") return value;
  if (typeof value === "number") {
    if (!Number.isFinite(value)) throw new Error("canonical form rejects non-finite numbers");
    return value;
  }
  if (Array.isArray(value)) return value.map(canonicalize);
  if (typeof value === "object") {
    const out: Record<string, unknown> = {};
    for (const key of Object.keys(value as Record<string, unknown>).sort(compareCodeUnits)) {
      // The historical encoding assigns into an ordinary object. This key would
      // invoke its prototype setter and disappear from JSON. Refuse ambiguous
      // input rather than silently collide or change existing valid identities.
      if (key === "__proto__") throw new Error("canonical form rejects reserved key __proto__");
      const v = (value as Record<string, unknown>)[key];
      if (v !== undefined) out[key] = canonicalize(v);
    }
    return out;
  }
  throw new Error(`canonical form rejects ${typeof value}`);
}

export function stateHash(value: unknown): string {
  return `sha256:${createHash("sha256").update(JSON.stringify(canonicalize(value))).digest("hex")}`;
}

/** Whether two values are the same once canonicalized; one that cannot be canonicalized
 *  counts as different, so a caller deduplicating copies keeps both. */
export function sameCanonical(a: unknown, b: unknown): boolean {
  try {
    return JSON.stringify(canonicalize(a)) === JSON.stringify(canonicalize(b));
  } catch {
    return false;
  }
}
