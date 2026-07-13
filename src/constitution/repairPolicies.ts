/**
 * Policy binding self-repair (Phase 5 slice 2). Same zero-guessing contract as
 * core/repair.ts: git-confirmed renames only, EXACT matches only.
 *
 * Repairable bindings:
 *   - scope.paths entries that are exact paths (globs are scope-intent, untouched);
 *   - `symbol:<file>:<name>` selector file parts (mirrors evaluator.ts's
 *     lastIndexOf(":") parse exactly); bare `symbol:<name>`, `symbol-id:`,
 *     `external:` and component selectors carry no file identity and are untouched.
 *
 * Deliberately NOT repairable: executable-behavior test pins. Their file path is
 * hash-pinned to a source_commit where the OLD path exists — rewriting the path
 * would silently break the pin. A renamed pinned test needs re-attestation, which
 * is a human/evidence act, not a repair.
 *
 * A repaired policy gets revision+1 and a system-actor "repaired" audit event.
 * Its authority is NOT touched: the existing proof-hash revalidation already
 * fails blocking safe when semantics moved under a stale proof, and the repaired
 * policy surfaces as an inline escalation asking for a re-prove.
 */
import type { PolicySpec } from "./schema.js";
import type { RenamePair } from "../core/repair.js";

export interface PolicyBindingRewrite {
  id: string;
  field: "scope.paths" | "assertion.selector";
  from: string;
  to: string;
}

/** Rewrite the file part of a `symbol:<file>:<name>` selector when it EXACTLY
 *  matches a renamed path; every other selector form passes through unchanged. */
function repairSelector(raw: string, map: Map<string, string>): string {
  if (!raw.startsWith("symbol:")) return raw;
  const target = raw.slice("symbol:".length);
  const split = target.lastIndexOf(":");
  if (split <= 0) return raw; // bare symbol name — no file identity to heal
  const file = target.slice(0, split);
  const to = map.get(file);
  return to ? `symbol:${to}:${target.slice(split + 1)}` : raw;
}

function isExactPath(entry: string): boolean {
  return !/[*?[\]{}]/.test(entry);
}

/** Live policies only — a superseded/retired/rejected policy's history stays as
 *  written. Returns the rewrites; empty when the renames touch nothing exactly. */
export function planPolicyRepair(renames: readonly RenamePair[], policies: readonly PolicySpec[]): PolicyBindingRewrite[] {
  const map = new Map(renames.map((r) => [r.before, r.after]));
  const rewrites: PolicyBindingRewrite[] = [];
  if (!map.size) return rewrites;
  for (const p of policies) {
    if (p.state === "superseded" || p.state === "retired" || p.state === "rejected") continue;
    for (const path of p.scope.paths) {
      const to = isExactPath(path) ? map.get(path) : undefined;
      if (to) rewrites.push({ id: p.id, field: "scope.paths", from: path, to });
    }
    if (p.assertion.kind !== "executable-behavior") {
      const selectors = p.assertion.kind === "exists"
        ? [p.assertion.subject.selector]
        : [p.assertion.subject.selector, p.assertion.object.selector];
      for (const raw of selectors) {
        const healed = repairSelector(raw, map);
        if (healed !== raw) rewrites.push({ id: p.id, field: "assertion.selector", from: raw, to: healed });
      }
    }
  }
  return rewrites;
}

/** Apply a policy's rewrites (pure): revision+1, system-actor audit, updated_at.
 *  Returns the original reference when nothing in the plan touches this policy. */
export function repairPolicySpec(policy: PolicySpec, rewrites: readonly PolicyBindingRewrite[], at: string): PolicySpec {
  const mine = rewrites.filter((r) => r.id === policy.id);
  if (!mine.length) return policy;
  const subPath = (value: string): string => mine.find((r) => r.field === "scope.paths" && r.from === value)?.to ?? value;
  const subSelector = (value: string): string => mine.find((r) => r.field === "assertion.selector" && r.from === value)?.to ?? value;
  const assertion = policy.assertion.kind === "executable-behavior"
    ? policy.assertion
    : policy.assertion.kind === "exists"
      ? { ...policy.assertion, subject: { selector: subSelector(policy.assertion.subject.selector) } }
      : {
          ...policy.assertion,
          subject: { selector: subSelector(policy.assertion.subject.selector) },
          object: { selector: subSelector(policy.assertion.object.selector) },
        };
  return {
    ...policy,
    revision: policy.revision + 1,
    scope: { ...policy.scope, paths: policy.scope.paths.map(subPath) },
    assertion,
    updated_at: at,
    audit: [...policy.audit, {
      action: "repaired" as const,
      actor_kind: "system" as const,
      actor: "system:repair",
      at,
      reason: mine.map((r) => `${r.field}: ${r.from} -> ${r.to}`).join("; "),
      proof: policy.proof,
    }],
  };
}
