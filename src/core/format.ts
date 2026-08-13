/** Render an AssembledContext as a compact, agent-ready brief: invariants first
 *  (what must not break), then the why, blast radius, and bug history — each with
 *  provenance so the agent can weight it. Shared by the CLI and the MCP tool. */
import type { AssembledContext, StructureView } from "../store/hunchStore.js";
import { buildDeliveryEnvelope, type DeliveryOptions } from "./delivery.js";

export function formatContext(ctx: AssembledContext, options: DeliveryOptions = {}): string {
  return buildDeliveryEnvelope(ctx, options).text;
}

/** Render a StructureView as a compact orientation brief (hunch_structure). */
export function formatStructure(v: StructureView): string {
  const NL = "\n";
  if (v.kind === "none") return `Nothing indexed matches "${v.target}" — not a known file, directory, or symbol. Run hunch index if the repo changed, or hunch_query for fuzzy search.`;
  if (v.kind === "repo") {
    const out = [`# Repo structure (from the graph — no grep needed)`];
    if (v.components.length) {
      out.push(`${NL}## Components`);
      for (const c of v.components) out.push(`- ${c.name}: ${c.responsibility} (${c.paths.join(", ")})`);
    }
    out.push(`${NL}## Directories (by symbol count)`);
    for (const d of v.dirs.slice(0, 20)) out.push(`- ${d.dir} — ${d.files} file(s), ${d.symbols} symbol(s)`);
    if (v.dirs.length > 20) out.push(`  …(+${v.dirs.length - 20} more)`);
    return out.join(NL);
  }
  if (v.kind === "dir") {
    const out = [`# ${v.dir}/ — ${v.files.length} indexed file(s)`];
    for (const f of v.files) {
      const syms = f.symbols.slice(0, 8).map((s) => `${s.name}${s.fan_in ? ` (fan-in ${s.fan_in})` : ""}`).join(", ");
      out.push(`- ${f.file}: ${syms}${f.symbols.length > 8 ? ` …(+${f.symbols.length - 8})` : ""}`);
    }
    return out.join(NL);
  }
  if (v.kind === "file") {
    const out = [`# ${v.file} — outline (${v.symbols.length} symbol(s))`];
    for (const sy of v.symbols) {
      out.push(`- ${sy.name} [${sy.kind}] loc ${sy.loc}, fan-in ${sy.fan_in}, fan-out ${sy.fan_out}`);
      if (sy.callers.length) out.push(`    called by: ${sy.callers.join("; ")}`);
    }
    return out.join(NL);
  }
  const out = [`# "${v.matches[0]?.name}" — ${v.matches.length} definition site(s)`];
  for (const m of v.matches) {
    out.push(`- ${m.name} [${m.kind}] @ ${m.file} (fan-in ${m.fan_in}, fan-out ${m.fan_out})`);
    if (m.callers.length) out.push(`    called by: ${m.callers.join("; ")}`);
    if (m.callees.length) out.push(`    reaches:   ${m.callees.join("; ")}`);
  }
  return out.join(NL);
}
