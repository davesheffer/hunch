/** Render an AssembledContext as a compact, agent-ready brief: invariants first
 *  (what must not break), then the why, blast radius, and bug history — each with
 *  provenance so the agent can weight it. Shared by the CLI and the MCP tool. */
import type { AssembledContext } from "../store/hunchStore.js";

function prov(p?: { source?: string; confidence?: number; last_verified?: string }): string {
  if (!p) return "";
  const v = p.last_verified ? `, verified ${p.last_verified.slice(0, 10)}` : "";
  return ` ⟨${p.source ?? "?"} ${p.confidence ?? "?"}${v}⟩`;
}

export function formatContext(ctx: AssembledContext): string {
  const out: string[] = [`# Hunch context for "${ctx.target}"`];

  if (ctx.constraints.length) {
    out.push(`\n## ⛔ Invariants (must not break)`);
    for (const c of ctx.constraints) out.push(`- [${c.severity}] ${c.statement}${prov(c.provenance)}\n  (${c.id}; scope ${c.scope.join(", ") || "repo"})`);
  }
  if (ctx.decisions.length) {
    out.push(`\n## 🧭 Decisions (why it's shaped this way)`);
    for (const d of ctx.decisions) out.push(`- [${d.status}] ${d.title}${prov(d.provenance)}\n  ${d.decision}`);
  }
  if (ctx.bugs.length) {
    out.push(`\n## 🐞 Bug history (don't reintroduce)`);
    for (const b of ctx.bugs) out.push(`- [${b.status}/${b.severity}] ${b.title} — root cause: ${b.root_cause}${prov(b.provenance)}`);
  }
  if (ctx.blast_radius.length) {
    out.push(`\n## 💥 Blast radius (transitive dependents)`);
    out.push(ctx.blast_radius.map((d) => `- [d${d.depth}] ${d.via}`).join("\n"));
  }
  if (ctx.components.length) out.push(`\n## 📦 Components: ${ctx.components.map((c) => c.name).join(", ")}`);

  if (out.length === 1) out.push(`\n(No recorded constraints/decisions/bugs for this target yet — Hunch is still learning it.)`);

  // crude budget trim: ~4 chars/token. Slice on code points (not UTF-16 units)
  // and back off to the last line boundary so we never split a surrogate pair or
  // a record mid-line.
  const text = out.join("\n");
  const cap = ctx.budget_tokens * 4;
  const chars = [...text];
  if (chars.length <= cap) return text + "\n";
  let trimmed = chars.slice(0, cap).join("");
  const lastNl = trimmed.lastIndexOf("\n");
  if (lastNl > cap * 0.5) trimmed = trimmed.slice(0, lastNl);
  return trimmed + "\n… (trimmed to budget)\n";
}
